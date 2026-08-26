from __future__ import annotations

import asyncio
import subprocess
import sys
import textwrap
import threading
from pathlib import Path

import pytest

from gpu_service.asr_execution import (
    AsrExecutionTimeout,
    DedicatedAsrExecution,
    InlineAsrExecution,
)


@pytest.mark.asyncio
async def test_dedicated_executor_serializes_calls_without_blocking_event_loop():
    execution = DedicatedAsrExecution()
    first_started = threading.Event()
    release_first = threading.Event()
    second_started = threading.Event()
    thread_names: list[str] = []

    def first() -> str:
        thread_names.append(threading.current_thread().name)
        first_started.set()
        assert release_first.wait(timeout=2)
        return "first"

    def second() -> str:
        thread_names.append(threading.current_thread().name)
        second_started.set()
        return "second"

    first_task = asyncio.create_task(execution.run(
        session_id="a",
        concurrency=2,
        input_epoch=0,
        input_turn_id=0,
        kind="stream",
        input_audio_ms=600,
        func=first,
    ))
    while not first_started.is_set():
        await asyncio.sleep(0.001)

    second_task = asyncio.create_task(execution.run(
        session_id="b",
        concurrency=2,
        input_epoch=0,
        input_turn_id=0,
        kind="stream",
        input_audio_ms=600,
        func=second,
    ))
    await asyncio.sleep(0.02)

    assert not second_started.is_set()
    assert not first_task.done()
    queued = execution.metrics.snapshot()["executor"]
    assert queued["running"] == 1
    assert queued["queued"] == 1
    assert queued["in_flight"] == 2
    assert queued["oldest_wait_ms"] > 0

    release_first.set()
    assert await asyncio.gather(first_task, second_task) == ["first", "second"]
    assert all(name.startswith("asr-inference") for name in thread_names)
    assert all(
        thread.daemon
        for thread in threading.enumerate()
        if thread.name.startswith("asr-inference")
    )
    metrics = execution.metrics.snapshot()
    assert metrics["executor"]["in_flight"] == 0
    assert metrics["asr_queue_wait_ms"]["count"] == 2
    assert metrics["asr_queue_wait_ms_by_concurrency"]["2"]["count"] == 2
    assert metrics["asr_queue_wait_ms_by_kind"]["stream"]["count"] == 2
    assert set(metrics["asr_queue_wait_ms_by_session"]) == {"a", "b"}
    assert metrics["asr_inference_ms_by_kind"]["stream"]["count"] == 2
    assert metrics["asr_wrapper_calls_per_audio_second"] == pytest.approx(2 / 1.2)
    assert metrics["asr_stream_forward_chunks_per_audio_second"] == pytest.approx(2 / 1.2)

    await execution.shutdown()


@pytest.mark.asyncio
async def test_inline_baseline_runner_uses_same_metrics_contract():
    execution = InlineAsrExecution()
    started = asyncio.get_running_loop().time()

    result = await execution.run(
        session_id="baseline",
        concurrency=2,
        input_epoch=0,
        input_turn_id=0,
        kind="stream",
        input_audio_ms=20,
        func=lambda: "partial",
    )

    assert result == "partial"
    metrics = execution.metrics.snapshot()
    assert metrics["asr_queue_wait_ms"]["count"] == 1
    assert metrics["asr_inference_ms_by_kind"]["stream"]["count"] == 1
    assert metrics["asr_wrapper_calls_per_audio_second"] == 50
    await execution.wait_until_idle(grace_s=1)
    assert asyncio.get_running_loop().time() - started < 0.1
    await execution.shutdown()


@pytest.mark.asyncio
async def test_tts_handoff_rejects_negative_grace():
    for execution in (InlineAsrExecution(), DedicatedAsrExecution()):
        with pytest.raises(ValueError, match="grace_s"):
            await execution.wait_until_idle(grace_s=-0.001)
        await execution.shutdown()


@pytest.mark.asyncio
async def test_dedicated_tts_handoff_waits_for_asr_and_stable_grace():
    execution = DedicatedAsrExecution()
    asr_started = threading.Event()
    release_asr = threading.Event()

    def blocked_asr() -> None:
        asr_started.set()
        assert release_asr.wait(timeout=2)

    asr_task = asyncio.create_task(execution.run(
        session_id="asr",
        concurrency=2,
        input_epoch=0,
        input_turn_id=0,
        kind="finalize",
        input_audio_ms=0,
        func=blocked_asr,
    ))
    while not asr_started.is_set():
        await asyncio.sleep(0.001)

    handoff = asyncio.create_task(execution.wait_until_idle(grace_s=0.02))
    await asyncio.sleep(0.01)
    assert not handoff.done()

    released_at = asyncio.get_running_loop().time()
    release_asr.set()
    await asr_task
    await handoff
    assert asyncio.get_running_loop().time() - released_at >= 0.015
    await execution.shutdown()


@pytest.mark.asyncio
async def test_dedicated_tts_handoff_rechecks_asr_during_grace():
    execution = DedicatedAsrExecution()
    handoff = asyncio.create_task(execution.wait_until_idle(grace_s=0.03))
    await asyncio.sleep(0.01)

    await execution.run(
        session_id="late-asr",
        concurrency=2,
        input_epoch=0,
        input_turn_id=0,
        kind="residual",
        input_audio_ms=20,
        func=lambda: None,
    )
    await asyncio.sleep(0.02)
    assert not handoff.done()
    await asyncio.wait_for(handoff, timeout=0.06)
    await execution.shutdown()


@pytest.mark.asyncio
async def test_dedicated_executor_timeout_poisoning_and_shutdown_do_not_hang():
    execution = DedicatedAsrExecution(operation_timeout_s=0.02)
    release = threading.Event()

    def blocked() -> None:
        release.wait(timeout=2)

    with pytest.raises(AsrExecutionTimeout, match="超过"):
        await execution.run(
            session_id="timeout",
            concurrency=1,
            input_epoch=0,
            input_turn_id=0,
            kind="finalize",
            input_audio_ms=0,
            func=blocked,
        )

    assert execution.metrics.snapshot()["asr_operation_timeouts"] == 1
    with pytest.raises(RuntimeError, match="超时停止接收"):
        await execution.run(
            session_id="rejected",
            concurrency=1,
            input_epoch=0,
            input_turn_id=0,
            kind="reset",
            input_audio_ms=0,
            func=lambda: None,
        )

    started = asyncio.get_running_loop().time()
    await execution.shutdown()
    assert asyncio.get_running_loop().time() - started < 0.1
    release.set()


def test_permanently_blocked_executor_worker_does_not_hold_process_exit():
    script = textwrap.dedent(
        """
        import asyncio
        import threading

        from gpu_service.asr_execution import AsrExecutionTimeout, DedicatedAsrExecution

        async def main():
            execution = DedicatedAsrExecution(operation_timeout_s=0.01)
            try:
                await execution.run(
                    session_id="blocked",
                    concurrency=1,
                    input_epoch=0,
                    input_turn_id=0,
                    kind="finalize",
                    input_audio_ms=0,
                    func=lambda: threading.Event().wait(),
                )
            except AsrExecutionTimeout:
                pass
            await execution.shutdown()

        asyncio.run(main())
        print("shutdown-complete")
        """
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).parents[1],
        capture_output=True,
        text=True,
        timeout=2,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "shutdown-complete"


@pytest.mark.asyncio
async def test_backend_timeout_error_is_not_misclassified_as_executor_timeout():
    execution = DedicatedAsrExecution(operation_timeout_s=1)

    def fail() -> None:
        raise TimeoutError("backend timeout")

    with pytest.raises(TimeoutError, match="backend timeout") as raised:
        await execution.run(
            session_id="backend",
            concurrency=1,
            input_epoch=0,
            input_turn_id=0,
            kind="stream",
            input_audio_ms=600,
            func=fail,
        )
    assert not isinstance(raised.value, AsrExecutionTimeout)
    metrics = execution.metrics.snapshot()
    assert metrics["asr_operation_errors"] == 1
    assert metrics["asr_operation_timeouts"] == 0
    await execution.shutdown()


@pytest.mark.asyncio
async def test_three_sessions_share_one_asr_worker():
    execution = DedicatedAsrExecution()
    active = 0
    max_active = 0
    lock = threading.Lock()

    def operation() -> None:
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        threading.Event().wait(0.01)
        with lock:
            active -= 1

    tasks = [
        asyncio.create_task(execution.run(
            session_id=f"s{index}",
            concurrency=3,
            input_epoch=0,
            input_turn_id=0,
            kind="stream",
            input_audio_ms=600,
            func=operation,
        ))
        for index in range(3)
    ]
    await asyncio.sleep(0.005)
    assert execution.metrics.snapshot()["executor"]["in_flight"] == 3

    await asyncio.gather(*tasks)
    metrics = execution.metrics.snapshot()
    assert max_active == 1
    assert metrics["asr_queue_wait_ms_by_concurrency"]["3"]["count"] == 3
    assert metrics["executor"]["in_flight"] == 0
    await execution.shutdown()
