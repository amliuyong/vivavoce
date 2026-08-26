from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest


def _benchmark_module() -> ModuleType:
    path = Path(__file__).parents[2] / "scripts" / "asr_executor_benchmark.py"
    spec = importlib.util.spec_from_file_location("asr_executor_benchmark", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _report(*, loop_p99: float, final_p95: float, memory_max: float) -> dict:
    return {
        "config": {
            "sessions": 3,
            "mode": "asr-only",
            "rounds": 10,
            "requested_duration_seconds": 0,
            "pcm_sha256": "pcm",
            "pace_audio": True,
            "control_storm": False,
            "tts_text_sha256": "tts",
            "sample_local_gpu": True,
        },
        "runtime": {
            "python": "3.12.3",
            "funasr": "1.3.14",
            "numpy": "2.0",
            "pytorch": "2.6",
            "cuda": "12.4",
            "image_tag": "test",
            "image_digest": "sha256:image",
            "model_manifest_id": "manifest",
        },
        "correctness": {
            "errors": 0,
            "stale_callbacks_after_ack": 0,
            "duplicate_final_callbacks": 0,
            "duplicate_turn_end_callbacks": 0,
            "gpu_oom_errors": 0,
        },
        "metrics_before": {
            "asr_operation_errors": 0,
            "asr_operation_timeouts": 0,
        },
        "metrics_after": {
            "asr_operation_errors": 0,
            "asr_operation_timeouts": 0,
            "asr_stale_result_count": 0,
            "asr_audio_backlog_ms": {"current": 0},
            "asr_queue_wait_ms": {"count": 10, "p95": 50, "p99": 100},
            "gpu_event_loop_lag_ms": {"count": 10, "p99": loop_p99},
        },
        "sessions": [{"flush_to_final_ms": {"count": 10, "p95": final_p95}}],
        "local_gpu": {"memory_used_mib": {"count": 10, "max": memory_max}},
    }


def test_benchmark_percentiles_match_service_interpolation():
    benchmark = _benchmark_module()

    assert benchmark._summary([0.0, 10.0]) == {
        "count": 2,
        "p50": 5.0,
        "p95": 9.5,
        "p99": 9.9,
        "max": 10.0,
    }


def test_benchmark_evaluates_baseline_and_absolute_gates():
    benchmark = _benchmark_module()
    current = _report(loop_p99=10, final_p95=105, memory_max=104)
    baseline_20ms = _report(loop_p99=30, final_p95=90, memory_max=90)
    baseline_600ms = _report(loop_p99=12, final_p95=100, memory_max=100)

    result = benchmark._evaluate_gates(
        current,
        baseline_20ms=baseline_20ms,
        baseline_600ms=baseline_600ms,
    )

    assert result["failed"] == 0
    assert result["not_evaluated"] == 3
    assert result["automated_checks_passed"] is True
    assert result["acceptance_complete"] is False


def test_benchmark_rejects_mislabeled_baseline(tmp_path):
    benchmark = _benchmark_module()
    report = tmp_path / "baseline.json"
    report.write_text(
        json.dumps({"config": {"run_kind": "600ms-dedicated-thread"}}),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="预期 '20ms-sync'"):
        benchmark._load_report(report, expected_kind="20ms-sync")


def test_benchmark_rejects_incompatible_workload_for_relative_gates():
    benchmark = _benchmark_module()
    current = _report(loop_p99=10, final_p95=100, memory_max=100)
    baseline_20ms = _report(loop_p99=30, final_p95=100, memory_max=100)
    baseline_600ms = _report(loop_p99=10, final_p95=100, memory_max=100)
    baseline_20ms["config"]["sessions"] = 1

    result = benchmark._evaluate_gates(
        current,
        baseline_20ms=baseline_20ms,
        baseline_600ms=baseline_600ms,
    )
    checks = {check["name"]: check for check in result["checks"]}

    assert checks["baseline_20ms_compatible"]["status"] == "fail"
    assert checks["gpu_event_loop_lag_vs_20ms_sync"]["status"] == "not_evaluated"
    assert result["failed"] == 1


def test_benchmark_does_not_treat_empty_distributions_as_zero_latency():
    benchmark = _benchmark_module()
    current = _report(loop_p99=0, final_p95=0, memory_max=0)
    baseline_20ms = _report(loop_p99=0, final_p95=0, memory_max=0)
    baseline_600ms = _report(loop_p99=0, final_p95=0, memory_max=0)
    current["metrics_after"]["asr_queue_wait_ms"]["count"] = 0
    current["metrics_after"]["gpu_event_loop_lag_ms"]["count"] = 0
    current["sessions"][0]["flush_to_final_ms"]["count"] = 0
    current["local_gpu"]["memory_used_mib"]["count"] = 0

    result = benchmark._evaluate_gates(
        current,
        baseline_20ms=baseline_20ms,
        baseline_600ms=baseline_600ms,
    )
    checks = {check["name"]: check for check in result["checks"]}

    assert checks["asr_queue_wait_p95"]["status"] == "fail"
    assert checks["gpu_event_loop_lag_p99"]["status"] == "fail"
    assert checks["asr_final_tail_vs_600ms_sync"]["status"] == "fail"
    assert checks["peak_vram_vs_600ms_sync"]["status"] == "fail"


def test_session_timestamps_callbacks_after_websocket_receive(monkeypatch):
    benchmark = _benchmark_module()

    class FakeWebSocket:
        def __init__(self) -> None:
            self.pending: list[str | bytes] = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def send(self, message: str | bytes) -> None:
            if isinstance(message, bytes):
                return
            control = json.loads(message)
            if control["type"] == "start":
                self.pending.append(json.dumps({"type": "ready"}))
            elif control["type"] == "flush":
                self.pending.append(json.dumps({
                    "type": "turn_end",
                    "input_epoch": control["input_epoch"],
                    "input_turn_id": control["input_turn_id"],
                }))
            elif control["type"] == "tts_text":
                self.pending.extend([
                    json.dumps({"type": "tts_audio_meta", "bytes": 2}),
                    b"\x00\x00",
                    json.dumps({"type": "tts_done"}),
                ])

        async def recv(self) -> str | bytes:
            await asyncio.sleep(0.01)
            return self.pending.pop(0)

    monkeypatch.setitem(
        sys.modules,
        "websockets",
        SimpleNamespace(connect=lambda *_args, **_kwargs: FakeWebSocket()),
    )

    report = asyncio.run(benchmark._session(
        index=1,
        ws_url="ws://benchmark.test/v1/stream",
        pcm=b"\x00\x00" * 320,
        mode="local-tts",
        rounds=1,
        deadline=None,
        pace_audio=False,
        control_storm=False,
        tts_text="测试",
    ))

    assert report["tts_first_audio_ms"]["p50"] >= 5
