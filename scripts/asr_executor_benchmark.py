#!/usr/bin/env python3
"""Concurrent GPU ASR benchmark for work item.

Examples:
  python scripts/asr_executor_benchmark.py --sessions 2 --mode asr-only --rounds 10
  python scripts/asr_executor_benchmark.py --sessions 3 --mode local-tts \
      --pcm-file fixtures/answer.wav --duration-seconds 1800 --sample-local-gpu
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import shutil
import struct
import sys
import time
import urllib.request
import wave
from pathlib import Path
from typing import Any

ASR_RATE = 16_000
FRAME_MS = 20
FRAME_BYTES = ASR_RATE * FRAME_MS // 1000 * 2
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gpu"))

from gpu_service.metric_summary import distribution as _summary  # noqa: E402


def _load_pcm(path: Path | None) -> bytes:
    if path is None:
        samples = ASR_RATE * 1200 // 1000
        return b"".join(
            struct.pack("<h", int(12_000 * math.sin(2 * math.pi * 220 * i / ASR_RATE)))
            for i in range(samples)
        )
    if path.suffix.lower() != ".wav":
        data = path.read_bytes()
        if not data or len(data) % 2:
            raise ValueError("raw PCM 必须是非空 16-bit little-endian 数据")
        return data
    with wave.open(str(path), "rb") as source:
        if (
            source.getnchannels() != 1
            or source.getsampwidth() != 2
            or source.getframerate() != ASR_RATE
        ):
            raise ValueError("WAV 必须是 16kHz mono s16le")
        return source.readframes(source.getnframes())


def _http_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read())


def _load_report(path: Path | None, *, expected_kind: str) -> dict[str, Any] | None:
    if path is None:
        return None
    report = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(report, dict):
        raise ValueError(f"{path} 不是 benchmark report object")
    actual_kind = (
        report.get("config", {}).get("run_kind")
        if isinstance(report.get("config"), dict)
        else None
    )
    if actual_kind != expected_kind:
        raise ValueError(
            f"{path} run_kind={actual_kind!r},预期 {expected_kind!r}"
        )
    return report


def _nested(report: dict[str, Any], *path: str) -> Any:
    current: Any = report
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


_COMPARABLE_CONFIG_KEYS = (
    "sessions",
    "mode",
    "rounds",
    "requested_duration_seconds",
    "pcm_sha256",
    "pace_audio",
    "control_storm",
    "tts_text_sha256",
    "sample_local_gpu",
)
_COMPARABLE_RUNTIME_KEYS = (
    "python",
    "funasr",
    "numpy",
    "pytorch",
    "cuda",
    "image_tag",
    "image_digest",
    "model_manifest_id",
)


def _comparison_issues(
    current: dict[str, Any],
    baseline: dict[str, Any],
) -> list[str]:
    issues = [
        f"config.{key}: current={_nested(current, 'config', key)!r}, "
        f"baseline={_nested(baseline, 'config', key)!r}"
        for key in _COMPARABLE_CONFIG_KEYS
        if _nested(current, "config", key) != _nested(baseline, "config", key)
    ]
    issues.extend(
        f"runtime.{key}: current={_nested(current, 'runtime', key)!r}, "
        f"baseline={_nested(baseline, 'runtime', key)!r}"
        for key in _COMPARABLE_RUNTIME_KEYS
        if _nested(current, "runtime", key) != _nested(baseline, "runtime", key)
    )
    return issues


def _distribution_value(
    report: dict[str, Any],
    *path: str,
    percentile: str,
) -> float | None:
    distribution = _nested(report, *path)
    if not isinstance(distribution, dict):
        return None
    count = distribution.get("count")
    value = distribution.get(percentile)
    if not isinstance(count, int) or count <= 0 or not isinstance(value, (int, float)):
        return None
    return float(value)


def _worst_session(report: dict[str, Any], metric: str, percentile: str) -> float | None:
    values = [
        value
        for session in report.get("sessions", [])
        if isinstance(session, dict)
        for value in [_distribution_value(session, metric, percentile=percentile)]
        if value is not None
    ]
    return max(values) if values else None


def _counter_delta(report: dict[str, Any], key: str) -> int:
    before = _nested(report, "metrics_before", key)
    after = _nested(report, "metrics_after", key)
    if not isinstance(after, (int, float)):
        return 0
    return max(0, int(after - before)) if isinstance(before, (int, float)) else int(after)


def _evaluate_gates(
    report: dict[str, Any],
    *,
    baseline_20ms: dict[str, Any] | None,
    baseline_600ms: dict[str, Any] | None,
) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def check(
        name: str,
        passed: bool | None,
        *,
        actual: Any = None,
        limit: Any = None,
        detail: str | None = None,
    ) -> None:
        checks.append({
            "name": name,
            "status": "not_evaluated" if passed is None else ("pass" if passed else "fail"),
            "actual": actual,
            "limit": limit,
            "detail": detail,
        })

    correctness = report.get("correctness", {})
    check("errors_zero", correctness.get("errors") == 0, actual=correctness.get("errors"), limit=0)
    check(
        "stale_callbacks_after_ack_zero",
        correctness.get("stale_callbacks_after_ack") == 0,
        actual=correctness.get("stale_callbacks_after_ack"),
        limit=0,
    )
    for key in ("duplicate_final_callbacks", "duplicate_turn_end_callbacks", "gpu_oom_errors"):
        check(f"{key}_zero", correctness.get(key) == 0, actual=correctness.get(key), limit=0)
    for key in ("asr_operation_errors", "asr_operation_timeouts"):
        delta = _counter_delta(report, key)
        check(f"{key}_zero", delta == 0, actual=delta, limit=0)
    stale_results = _nested(report, "metrics_after", "asr_stale_result_count")
    check(
        "asr_stale_result_count_zero",
        stale_results == 0 if isinstance(stale_results, (int, float)) else None,
        actual=stale_results,
        limit=0,
    )
    backlog = _nested(report, "metrics_after", "asr_audio_backlog_ms", "current")
    check(
        "asr_audio_backlog_drained",
        backlog == 0 if isinstance(backlog, (int, float)) else None,
        actual=backlog,
        limit=0,
    )

    queue_p95 = _distribution_value(
        report,
        "metrics_after",
        "asr_queue_wait_ms",
        percentile="p95",
    )
    queue_p99 = _distribution_value(
        report,
        "metrics_after",
        "asr_queue_wait_ms",
        percentile="p99",
    )
    check(
        "asr_queue_wait_p95",
        queue_p95 is not None and queue_p95 <= 100,
        actual=queue_p95,
        limit="<=100ms",
        detail="当前报告必须含非空 queue-wait 样本",
    )
    check(
        "asr_queue_wait_p99",
        queue_p99 is not None and queue_p99 <= 300,
        actual=queue_p99,
        limit="<=300ms",
        detail="当前报告必须含非空 queue-wait 样本",
    )

    loop_p99 = _distribution_value(
        report,
        "metrics_after",
        "gpu_event_loop_lag_ms",
        percentile="p99",
    )
    check(
        "gpu_event_loop_lag_p99",
        loop_p99 is not None and loop_p99 <= 20,
        actual=loop_p99,
        limit="<=20ms",
        detail="当前报告必须含非空 event-loop 样本",
    )
    baseline_20ms_issues = (
        _comparison_issues(report, baseline_20ms)
        if baseline_20ms else None
    )
    check(
        "baseline_20ms_compatible",
        not baseline_20ms_issues if baseline_20ms is not None else None,
        actual=baseline_20ms_issues,
        detail="workload、语料和 runtime 必须一致",
    )
    baseline_loop_p99 = (
        _distribution_value(
            baseline_20ms,
            "metrics_after",
            "gpu_event_loop_lag_ms",
            percentile="p99",
        )
        if baseline_20ms and not baseline_20ms_issues else None
    )
    if loop_p99 is not None and baseline_loop_p99 is not None:
        loop_limit = baseline_loop_p99 if baseline_loop_p99 <= 20 else baseline_loop_p99 * 0.5
        check(
            "gpu_event_loop_lag_vs_20ms_sync",
            loop_p99 <= loop_limit,
            actual=loop_p99,
            limit=f"<={loop_limit:.3f}ms",
        )
    elif baseline_20ms is None or baseline_20ms_issues:
        check(
            "gpu_event_loop_lag_vs_20ms_sync",
            None,
            actual=loop_p99,
            detail=(
                "基线不兼容"
                if baseline_20ms_issues
                else "需要含非空 event-loop 样本的 --baseline-20ms-report"
            ),
        )
    else:
        check(
            "gpu_event_loop_lag_vs_20ms_sync",
            False,
            actual=loop_p99,
            detail="当前报告和 20ms baseline 都必须含非空 event-loop 样本",
        )

    final_tail_p95 = _worst_session(report, "flush_to_final_ms", "p95")
    baseline_600ms_issues = (
        _comparison_issues(report, baseline_600ms)
        if baseline_600ms else None
    )
    check(
        "baseline_600ms_compatible",
        not baseline_600ms_issues if baseline_600ms is not None else None,
        actual=baseline_600ms_issues,
        detail="workload、语料和 runtime 必须一致",
    )
    baseline_final_p95 = (
        _worst_session(baseline_600ms, "flush_to_final_ms", "p95")
        if baseline_600ms and not baseline_600ms_issues else None
    )
    if final_tail_p95 is not None and baseline_final_p95 is not None:
        check(
            "asr_final_tail_vs_600ms_sync",
            final_tail_p95 <= baseline_final_p95 * 1.1,
            actual=final_tail_p95,
            limit=f"<={baseline_final_p95 * 1.1:.3f}ms",
        )
    elif baseline_600ms is None or baseline_600ms_issues:
        check(
            "asr_final_tail_vs_600ms_sync",
            None,
            actual=final_tail_p95,
            detail=(
                "基线不兼容"
                if baseline_600ms_issues
                else "需要含非空 ASR final 样本的 --baseline-600ms-report"
            ),
        )
    else:
        check(
            "asr_final_tail_vs_600ms_sync",
            False,
            actual=final_tail_p95,
            detail="当前报告和 600ms baseline 都必须含非空 ASR final 样本",
        )

    if _nested(report, "config", "mode") == "local-tts":
        for metric, name in (
            ("tts_first_audio_ms", "local_tts_ttfb"),
            ("tts_rtf", "local_tts_rtf"),
        ):
            current = _worst_session(report, metric, "p95")
            baseline = (
                _worst_session(baseline_600ms, metric, "p95")
                if baseline_600ms and not baseline_600ms_issues else None
            )
            if current is not None and baseline is not None:
                check(
                    f"{name}_vs_600ms_sync",
                    current <= baseline * 1.1,
                    actual=current,
                    limit=f"<={baseline * 1.1:.3f}",
                )
            elif baseline_600ms is None or baseline_600ms_issues:
                check(
                    f"{name}_vs_600ms_sync",
                    None,
                    actual=current,
                    detail=(
                        "基线不兼容"
                        if baseline_600ms_issues
                        else "需要含非空 TTS 样本的 local-tts --baseline-600ms-report"
                    ),
                )
            else:
                check(
                    f"{name}_vs_600ms_sync",
                    False,
                    actual=current,
                    detail="当前报告和 600ms baseline 都必须含非空 TTS 样本",
                )
        rtf_p95 = _worst_session(report, "tts_rtf", "p95")
        check(
            "local_tts_rtf_p95",
            rtf_p95 is not None and rtf_p95 < 0.8,
            actual=rtf_p95,
            limit="<0.8",
            detail="当前 local-tts 报告必须含非空 RTF 样本",
        )

    memory_max = _distribution_value(
        report,
        "local_gpu",
        "memory_used_mib",
        percentile="max",
    )
    baseline_memory_max = (
        _distribution_value(
            baseline_600ms,
            "local_gpu",
            "memory_used_mib",
            percentile="max",
        )
        if baseline_600ms and not baseline_600ms_issues else None
    )
    if memory_max is not None and baseline_memory_max is not None:
        check(
            "peak_vram_vs_600ms_sync",
            memory_max <= baseline_memory_max * 1.05,
            actual=memory_max,
            limit=f"<={baseline_memory_max * 1.05:.3f}MiB",
        )
    elif not _nested(report, "config", "sample_local_gpu") or baseline_600ms is None:
        check(
            "peak_vram_vs_600ms_sync",
            None,
            actual=memory_max,
            detail="需要 --sample-local-gpu 和 --baseline-600ms-report",
        )
    else:
        check(
            "peak_vram_vs_600ms_sync",
            False,
            actual=memory_max,
            detail="开启 GPU sampling 后当前报告和 600ms baseline 都必须含非空 VRAM 样本",
        )

    for name, detail in (
        ("queue_wait_no_monotonic_growth", "需 30 分钟时间序列证据"),
        ("transcript_quality", "需固定语料 CER、关键词、短答和语言偏置对比"),
        ("cross_session_cache_isolation", "需真模型固定语料并发对比"),
    ):
        check(name, None, detail=detail)

    statuses = [item["status"] for item in checks]
    return {
        "checks": checks,
        "failed": sum(status == "fail" for status in statuses),
        "not_evaluated": sum(status == "not_evaluated" for status in statuses),
        "automated_checks_passed": all(status != "fail" for status in statuses),
        "acceptance_complete": all(status == "pass" for status in statuses),
    }


async def _sample_gpu(stop: asyncio.Event, samples: list[dict[str, float]]) -> None:
    executable = shutil.which("nvidia-smi")
    if executable is None:
        return
    while not stop.is_set():
        process = await asyncio.create_subprocess_exec(
            executable,
            "--query-gpu=utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await process.communicate()
        if process.returncode == 0:
            for line in stdout.decode().splitlines():
                utilization, used, total = (float(value.strip()) for value in line.split(","))
                samples.append({
                    "at": time.time(),
                    "utilization_percent": utilization,
                    "memory_used_mib": used,
                    "memory_total_mib": total,
                })
        try:
            await asyncio.wait_for(stop.wait(), timeout=1)
        except TimeoutError:
            pass


async def _session(
    *,
    index: int,
    ws_url: str,
    pcm: bytes,
    mode: str,
    rounds: int,
    deadline: float | None,
    pace_audio: bool,
    control_storm: bool,
    tts_text: str,
) -> dict[str, Any]:
    import websockets

    session_id = f"asr-bench-{index}"
    epoch = 0
    turn_id = 0
    sequence = 0
    report: dict[str, Any] = {
        "session_id": session_id,
        "rounds": 0,
        "partials": 0,
        "finals": 0,
        "turn_ends": 0,
        "tts_done": 0,
        "errors": [],
        "stale_callbacks_after_ack": 0,
        "duplicate_final_callbacks": 0,
        "duplicate_turn_end_callbacks": 0,
        "gpu_oom_errors": 0,
        "first_partial_ms": [],
        "flush_to_final_ms": [],
        "flush_to_turn_end_ms": [],
        "tts_first_audio_ms": [],
        "tts_done_ms": [],
        "tts_provider_first_send_ms": [],
        "tts_rtf": [],
        "tts_generation_wall_time_ms": [],
    }
    seen_terminal_callbacks: set[tuple[str, int, int]] = set()
    provider = "minimax" if mode == "minimax" else "gpu_omnivoice"

    async with websockets.connect(ws_url, max_size=None, open_timeout=30) as websocket:
        start = {
            "type": "start",
            "session_id": session_id,
            "tts_provider": provider,
        }
        await websocket.send(json.dumps(start))
        ready = json.loads(await asyncio.wait_for(websocket.recv(), timeout=120))
        if ready.get("type") != "ready":
            raise RuntimeError(f"{session_id} 未 ready: {ready}")

        async def receive_control() -> dict[str, Any]:
            message = await asyncio.wait_for(websocket.recv(), timeout=120)
            if isinstance(message, bytes):
                raise RuntimeError(f"{session_id} 收到无 meta 的 binary")
            control = json.loads(message)
            callback_epoch = control.get("input_epoch")
            if (
                control.get("type") in {"asr_partial", "asr_final", "turn_end"}
                and isinstance(callback_epoch, int)
                and callback_epoch < epoch
            ):
                report["stale_callbacks_after_ack"] += 1
            if control.get("type") == "error":
                report["errors"].append(control)
                error_text = json.dumps(control, ensure_ascii=False).lower()
                if "out of memory" in error_text or "cuda oom" in error_text:
                    report["gpu_oom_errors"] += 1
            callback_turn = control.get("input_turn_id")
            callback_type = control.get("type")
            if (
                callback_type in {"asr_final", "turn_end"}
                and isinstance(callback_epoch, int)
                and isinstance(callback_turn, int)
            ):
                identity = (callback_type, callback_epoch, callback_turn)
                if identity in seen_terminal_callbacks:
                    duplicate_key = (
                        "duplicate_final_callbacks"
                        if callback_type == "asr_final"
                        else "duplicate_turn_end_callbacks"
                    )
                    report[duplicate_key] += 1
                else:
                    seen_terminal_callbacks.add(identity)
            if control.get("type") == "tts_metrics":
                for field, report_key in (
                    ("provider_start_to_first_send_ms", "tts_provider_first_send_ms"),
                    ("rtf", "tts_rtf"),
                    ("generation_wall_time_ms", "tts_generation_wall_time_ms"),
                ):
                    value = control.get(field)
                    if isinstance(value, (int, float)):
                        report[report_key].append(float(value))
            return control

        async def wait_for_type(expected: set[str]) -> tuple[dict[str, Any], float]:
            while True:
                control = await receive_control()
                received_at = time.monotonic()
                if control.get("type") == "tts_audio_meta":
                    binary = await asyncio.wait_for(websocket.recv(), timeout=120)
                    if not isinstance(binary, bytes) or len(binary) != control.get("bytes"):
                        raise RuntimeError(f"{session_id} TTS meta/binary 不匹配")
                if control.get("type") in expected:
                    return control, received_at

        current_round = 0
        while (
            (deadline is not None and time.monotonic() < deadline)
            or (deadline is None and current_round < rounds)
        ):
            current_round += 1
            audio_started_at = time.monotonic()
            first_partial_at: float | None = None
            for offset in range(0, len(pcm), FRAME_BYTES):
                frame = pcm[offset:offset + FRAME_BYTES]
                if not frame:
                    continue
                sequence += 1
                await websocket.send(json.dumps({
                    "type": "audio_meta",
                    "session_id": session_id,
                    "seq": sequence,
                    "bytes": len(frame),
                    "input_epoch": epoch,
                }))
                await websocket.send(frame)
                if pace_audio:
                    await asyncio.sleep(FRAME_MS / 1000)

            if control_storm and current_round % 4 in {2, 3}:
                if current_round % 4 == 2:
                    await websocket.send(json.dumps({
                        "type": "input_reset",
                        "session_id": session_id,
                        "from_input_epoch": epoch,
                        "next_input_epoch": epoch + 1,
                    }))
                    while True:
                        control, received_at = await wait_for_type({
                            "asr_partial", "input_reset_ack", "error",
                        })
                        if control.get("type") == "asr_partial" and first_partial_at is None:
                            first_partial_at = received_at
                        if control.get("type") in {"input_reset_ack", "error"}:
                            break
                    if control.get("type") != "input_reset_ack":
                        continue
                    epoch += 1
                    turn_id = 0
                else:
                    await websocket.send(json.dumps({
                        "type": "cancel",
                        "session_id": session_id,
                        "reason": "benchmark_storm",
                    }))
                    await wait_for_type({"cancel_ack", "error"})
                report["rounds"] += 1
                continue

            flush_started_at = time.monotonic()
            await websocket.send(json.dumps({
                "type": "flush",
                "session_id": session_id,
                "input_epoch": epoch,
                "input_turn_id": turn_id,
            }))
            while True:
                control, received_at = await wait_for_type({
                    "asr_partial", "asr_final", "turn_end", "error",
                })
                kind = control.get("type")
                if kind == "asr_partial":
                    report["partials"] += 1
                    if first_partial_at is None:
                        first_partial_at = received_at
                elif kind == "asr_final":
                    report["finals"] += 1
                    report["flush_to_final_ms"].append((received_at - flush_started_at) * 1000)
                elif kind == "turn_end":
                    report["turn_ends"] += 1
                    report["flush_to_turn_end_ms"].append((received_at - flush_started_at) * 1000)
                    turn_id += 1
                    break
                else:
                    break
            if first_partial_at is not None:
                report["first_partial_ms"].append((first_partial_at - audio_started_at) * 1000)

            if mode != "asr-only":
                tts_started_at = time.monotonic()
                first_audio_at: float | None = None
                await websocket.send(json.dumps({
                    "type": "tts_text",
                    "session_id": session_id,
                    "text": tts_text,
                    "ai_turn_id": max(0, turn_id - 1),
                    "segment_id": 0,
                }))
                while True:
                    control, received_at = await wait_for_type({
                        "tts_audio_meta", "tts_done", "error",
                    })
                    if control.get("type") == "tts_audio_meta" and first_audio_at is None:
                        first_audio_at = received_at
                    elif control.get("type") == "tts_done":
                        report["tts_done"] += 1
                        report["tts_done_ms"].append((received_at - tts_started_at) * 1000)
                        break
                    elif control.get("type") == "error":
                        break
                if first_audio_at is not None:
                    report["tts_first_audio_ms"].append((first_audio_at - tts_started_at) * 1000)
            report["rounds"] += 1

        await websocket.send(json.dumps({"type": "end", "session_id": session_id}))

    for key in (
        "first_partial_ms",
        "flush_to_final_ms",
        "flush_to_turn_end_ms",
        "tts_first_audio_ms",
        "tts_done_ms",
        "tts_provider_first_send_ms",
        "tts_rtf",
        "tts_generation_wall_time_ms",
    ):
        report[key] = _summary(report[key])
    return report


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    pcm = _load_pcm(args.pcm_file)
    before = await asyncio.to_thread(_http_json, args.metrics_url)
    if before.get("backend") == "funasr" and args.pcm_file is None:
        raise ValueError("真 FunASR benchmark 必须用 --pcm-file 提供固定 16kHz mono s16le 语料")
    deadline = time.monotonic() + args.duration_seconds if args.duration_seconds > 0 else None
    gpu_samples: list[dict[str, float]] = []
    stop_gpu = asyncio.Event()
    gpu_task = (
        asyncio.create_task(_sample_gpu(stop_gpu, gpu_samples))
        if args.sample_local_gpu
        else None
    )
    started_at = time.time()
    try:
        sessions = await asyncio.gather(*(
            _session(
                index=index,
                ws_url=args.ws_url,
                pcm=pcm,
                mode=args.mode,
                rounds=args.rounds,
                deadline=deadline,
                pace_audio=not args.no_pace,
                control_storm=args.control_storm,
                tts_text=args.tts_text,
            )
            for index in range(1, args.sessions + 1)
        ))
    finally:
        stop_gpu.set()
        if gpu_task is not None:
            await gpu_task
    after = await asyncio.to_thread(_http_json, args.metrics_url)
    if after.get("asr_run_kind") != args.run_kind:
        raise RuntimeError(
            "服务端 ASR 模式与 --run-kind 不一致:"
            f" server={after.get('asr_run_kind')!r}, requested={args.run_kind!r}"
        )
    return {
        "label": args.label or args.run_kind,
        "started_at": started_at,
        "duration_seconds": round(time.time() - started_at, 3),
        "config": {
            "run_kind": args.run_kind,
            "server_chunk_ms": after.get("asr_chunk_ms"),
            "sessions": args.sessions,
            "mode": args.mode,
            "rounds": args.rounds,
            "requested_duration_seconds": args.duration_seconds,
            "pcm_bytes": len(pcm),
            "pcm_sha256": hashlib.sha256(pcm).hexdigest(),
            "pace_audio": not args.no_pace,
            "control_storm": args.control_storm,
            "tts_text_sha256": hashlib.sha256(args.tts_text.encode()).hexdigest(),
            "sample_local_gpu": args.sample_local_gpu,
        },
        "runtime": after.get("runtime"),
        "metrics_before": before.get("asr"),
        "metrics_after": after.get("asr"),
        "sessions": sessions,
        "correctness": {
            "errors": sum(len(session["errors"]) for session in sessions),
            "stale_callbacks_after_ack": sum(
                session["stale_callbacks_after_ack"] for session in sessions
            ),
            "duplicate_final_callbacks": sum(
                session["duplicate_final_callbacks"] for session in sessions
            ),
            "duplicate_turn_end_callbacks": sum(
                session["duplicate_turn_end_callbacks"] for session in sessions
            ),
            "gpu_oom_errors": sum(session["gpu_oom_errors"] for session in sessions),
        },
        "local_gpu": {
            "samples": len(gpu_samples),
            "utilization_percent": _summary([
                sample["utilization_percent"] for sample in gpu_samples
            ]),
            "memory_used_mib": _summary([
                sample["memory_used_mib"] for sample in gpu_samples
            ]),
        } if gpu_samples else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ws-url", default="ws://127.0.0.1:8080/v1/stream")
    parser.add_argument("--metrics-url", default="http://127.0.0.1:8080/metrics")
    parser.add_argument("--sessions", type=int, choices=(1, 2, 3), default=1)
    parser.add_argument("--mode", choices=("asr-only", "local-tts", "minimax"), default="asr-only")
    parser.add_argument("--rounds", type=int, default=10)
    parser.add_argument("--duration-seconds", type=float, default=0)
    parser.add_argument("--pcm-file", type=Path)
    parser.add_argument("--tts-text", default="好的，收到。")
    parser.add_argument(
        "--run-kind",
        choices=("20ms-sync", "600ms-sync", "600ms-dedicated-thread"),
        default="600ms-dedicated-thread",
    )
    parser.add_argument("--label")
    parser.add_argument("--control-storm", action="store_true")
    parser.add_argument("--no-pace", action="store_true")
    parser.add_argument("--sample-local-gpu", action="store_true")
    parser.add_argument("--baseline-20ms-report", type=Path)
    parser.add_argument("--baseline-600ms-report", type=Path)
    parser.add_argument("--fail-on-gate-failure", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.rounds <= 0 or args.duration_seconds < 0:
        parser.error("rounds 必须 > 0，duration-seconds 必须 >= 0")

    report = asyncio.run(_run(args))
    baseline_20ms = _load_report(
        args.baseline_20ms_report,
        expected_kind="20ms-sync",
    )
    baseline_600ms = _load_report(
        args.baseline_600ms_report,
        expected_kind="600ms-sync",
    )
    report["baseline_reports"] = {
        "20ms_sync": str(args.baseline_20ms_report) if args.baseline_20ms_report else None,
        "600ms_sync": str(args.baseline_600ms_report) if args.baseline_600ms_report else None,
    }
    report["gates"] = _evaluate_gates(
        report,
        baseline_20ms=baseline_20ms,
        baseline_600ms=baseline_600ms,
    )
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    if args.fail_on_gate_failure and report["gates"]["failed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
