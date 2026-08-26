"""Execution boundary for blocking ASR operations."""

from __future__ import annotations

import asyncio
import threading
import time
import weakref
from collections import defaultdict, deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures.thread import _worker
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar

from .metric_summary import distribution as _distribution

T = TypeVar("T")
_METRIC_WINDOW = 10_000
_GROUP_METRIC_WINDOW = 5_000
_EVENT_LOOP_METRIC_WINDOW = 50_000
_MAX_METRIC_GROUPS = 128
_DEFAULT_OPERATION_TIMEOUT_S = 120.0


class AsrExecutionTimeout(TimeoutError):
    """An ASR operation exceeded its hard wall-time limit."""


class _ExitSafeThreadPoolExecutor(ThreadPoolExecutor):
    """Single-worker pool whose irrecoverably blocked worker cannot hold process exit.

    ``ThreadPoolExecutor`` registers every worker in a global interpreter-exit
    join table. A native inference call cannot be killed from Python, so a
    permanently blocked call would otherwise hang ECS task shutdown even after
    ``shutdown(wait=False)``. Explicit shutdown still sends the normal sentinel;
    the only difference is that this daemon worker is not globally joined.
    """

    def _adjust_thread_count(self) -> None:
        if self._idle_semaphore.acquire(timeout=0):
            return

        def weakref_callback(_: object, queue=self._work_queue) -> None:
            queue.put(None)

        thread_count = len(self._threads)
        if thread_count >= self._max_workers:
            return
        thread_name = f"{self._thread_name_prefix or self}_{thread_count}"
        worker = threading.Thread(
            name=thread_name,
            target=_worker,
            args=(
                weakref.ref(self, weakref_callback),
                self._work_queue,
                self._initializer,
                self._initargs,
            ),
            daemon=True,
        )
        worker.start()
        self._threads.add(worker)


@dataclass
class _Job:
    session_id: str
    concurrency: int
    kind: str
    input_audio_ms: float
    enqueued_at: float
    started_at: float | None = None


class AsrMetrics:
    """Thread-safe rolling ASR and event-loop measurements."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._next_job_id = 0
        self._jobs: dict[int, _Job] = {}
        self._queue_wait_ms: deque[float] = deque(maxlen=_METRIC_WINDOW)
        self._queue_wait_by_session: dict[str, deque[float]] = {}
        self._queue_wait_by_concurrency: dict[int, deque[float]] = {}
        self._queue_wait_by_kind: dict[str, deque[float]] = {}
        self._inference_ms: deque[float] = deque(maxlen=_METRIC_WINDOW)
        self._inference_by_kind: dict[str, deque[float]] = defaultdict(
            lambda: deque(maxlen=_METRIC_WINDOW)
        )
        self._finalize_ms: deque[float] = deque(maxlen=_METRIC_WINDOW)
        self._partial_age_ms: deque[float] = deque(maxlen=_METRIC_WINDOW)
        self._reset_ack_ms: deque[float] = deque(maxlen=_METRIC_WINDOW)
        self._event_loop_lag_ms: deque[float] = deque(maxlen=_EVENT_LOOP_METRIC_WINDOW)
        self._audio_backlog_ms: dict[str, float] = defaultdict(float)
        self._max_audio_backlog_ms = 0.0
        self._wrapper_calls = 0
        self._stream_chunks = 0
        self._processed_audio_ms = 0.0
        self._operation_errors = 0
        self._operation_timeouts = 0
        self._cancelled_before_start = 0

    @staticmethod
    def _append_group(
        groups: dict[Any, deque[float]],
        key: Any,
        value: float,
    ) -> None:
        if key not in groups and len(groups) >= _MAX_METRIC_GROUPS:
            groups.pop(next(iter(groups)))
        groups.setdefault(key, deque(maxlen=_GROUP_METRIC_WINDOW)).append(value)

    def enqueued(
        self,
        *,
        session_id: str,
        concurrency: int,
        kind: str,
        input_audio_ms: float,
    ) -> tuple[int, float]:
        now = time.monotonic()
        with self._lock:
            self._next_job_id += 1
            job_id = self._next_job_id
            self._jobs[job_id] = _Job(
                session_id=session_id,
                concurrency=concurrency,
                kind=kind,
                input_audio_ms=input_audio_ms,
                enqueued_at=now,
            )
        return job_id, now

    def started(self, job_id: int, started_at: float) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.started_at = started_at
            wait_ms = max(0.0, (started_at - job.enqueued_at) * 1000)
            self._queue_wait_ms.append(wait_ms)
            self._append_group(self._queue_wait_by_session, job.session_id, wait_ms)
            self._append_group(self._queue_wait_by_concurrency, job.concurrency, wait_ms)
            self._append_group(self._queue_wait_by_kind, job.kind, wait_ms)

    def completed(self, job_id: int, completed_at: float, *, error: bool) -> None:
        with self._lock:
            job = self._jobs.pop(job_id)
            started_at = job.started_at or completed_at
            duration_ms = max(0.0, (completed_at - started_at) * 1000)
            self._inference_ms.append(duration_ms)
            self._inference_by_kind[job.kind].append(duration_ms)
            if job.kind in {"stream", "residual"}:
                self._wrapper_calls += 1
                self._processed_audio_ms += job.input_audio_ms
                if job.kind == "stream":
                    self._stream_chunks += 1
                remaining_ms = max(
                    0.0,
                    self._audio_backlog_ms[job.session_id] - job.input_audio_ms,
                )
                if remaining_ms > 0:
                    self._audio_backlog_ms[job.session_id] = remaining_ms
                else:
                    self._audio_backlog_ms.pop(job.session_id, None)
            if error:
                self._operation_errors += 1

    def cancelled_before_start(self, job_id: int) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.started_at is not None:
                return
            self._jobs.pop(job_id)
            self._cancelled_before_start += 1

    def audio_received(self, session_id: str, audio_ms: float) -> None:
        with self._lock:
            self._audio_backlog_ms[session_id] += audio_ms
            self._max_audio_backlog_ms = max(
                self._max_audio_backlog_ms,
                sum(self._audio_backlog_ms.values()),
            )

    def audio_discarded(self, session_id: str, audio_ms: float) -> None:
        with self._lock:
            remaining_ms = max(
                0.0,
                self._audio_backlog_ms[session_id] - audio_ms,
            )
            if remaining_ms > 0:
                self._audio_backlog_ms[session_id] = remaining_ms
            else:
                self._audio_backlog_ms.pop(session_id, None)

    def observe_finalize(self, duration_ms: float) -> None:
        with self._lock:
            self._finalize_ms.append(max(0.0, duration_ms))

    def observe_partial_age(self, duration_ms: float) -> None:
        with self._lock:
            self._partial_age_ms.append(max(0.0, duration_ms))

    def observe_reset_ack(self, duration_ms: float) -> None:
        with self._lock:
            self._reset_ack_ms.append(max(0.0, duration_ms))

    def observe_event_loop_lag(self, duration_ms: float) -> None:
        with self._lock:
            self._event_loop_lag_ms.append(max(0.0, duration_ms))

    def operation_timed_out(self) -> None:
        with self._lock:
            self._operation_timeouts += 1

    def idle_marker(self) -> int | None:
        """Return a marker only when idle; it changes after every new job."""
        with self._lock:
            return self._next_job_id if not self._jobs else None

    def snapshot(self) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            queued = [job for job in self._jobs.values() if job.started_at is None]
            running = [job for job in self._jobs.values() if job.started_at is not None]
            oldest_wait_ms = max(
                ((now - job.enqueued_at) * 1000 for job in queued),
                default=0.0,
            )
            audio_seconds = self._processed_audio_ms / 1000
            backlog_by_session = {
                session_id: round(duration_ms, 3)
                for session_id, duration_ms in self._audio_backlog_ms.items()
                if duration_ms > 0
            }
            return {
                "asr_wrapper_calls_per_audio_second": round(
                    self._wrapper_calls / audio_seconds, 6
                ) if audio_seconds > 0 else 0.0,
                "asr_stream_forward_chunks_per_audio_second": round(
                    self._stream_chunks / audio_seconds, 6
                ) if audio_seconds > 0 else 0.0,
                "asr_queue_wait_ms": _distribution(self._queue_wait_ms),
                "asr_queue_wait_ms_by_session": {
                    key: _distribution(values)
                    for key, values in self._queue_wait_by_session.items()
                },
                "asr_queue_wait_ms_by_concurrency": {
                    str(key): _distribution(values)
                    for key, values in sorted(self._queue_wait_by_concurrency.items())
                },
                "asr_queue_wait_ms_by_kind": {
                    key: _distribution(values)
                    for key, values in sorted(self._queue_wait_by_kind.items())
                },
                "asr_inference_ms": _distribution(self._inference_ms),
                "asr_inference_ms_by_kind": {
                    kind: _distribution(values)
                    for kind, values in sorted(self._inference_by_kind.items())
                },
                "asr_audio_backlog_ms": {
                    "current": round(sum(self._audio_backlog_ms.values()), 3),
                    "max": round(self._max_audio_backlog_ms, 3),
                    "by_session": backlog_by_session,
                },
                "asr_finalize_ms": _distribution(self._finalize_ms),
                "asr_partial_age_ms": _distribution(self._partial_age_ms),
                "input_reset_ack_ms": _distribution(self._reset_ack_ms),
                "gpu_event_loop_lag_ms": _distribution(self._event_loop_lag_ms),
                "asr_operation_errors": self._operation_errors,
                "asr_operation_timeouts": self._operation_timeouts,
                "asr_stale_result_count": 0,
                "asr_cancelled_before_start": self._cancelled_before_start,
                "executor": {
                    "queued": len(queued),
                    "running": len(running),
                    "in_flight": len(self._jobs),
                    "oldest_wait_ms": round(max(0.0, oldest_wait_ms), 3),
                    "queued_audio_bytes": round(
                        sum(job.input_audio_ms for job in queued) * 32
                    ),
                },
            }


def _execute_job[T](metrics: AsrMetrics, job_id: int, func: Callable[[], T]) -> T:
    metrics.started(job_id, time.monotonic())
    try:
        result = func()
    except BaseException:
        metrics.completed(job_id, time.monotonic(), error=True)
        raise
    metrics.completed(job_id, time.monotonic(), error=False)
    return result


class AsrExecution(Protocol):
    async def run(
        self,
        *,
        session_id: str,
        concurrency: int,
        input_epoch: int,
        input_turn_id: int,
        kind: str,
        input_audio_ms: float,
        func: Callable[[], T],
    ) -> T: ...

    def audio_received(self, session_id: str, audio_ms: float) -> None: ...

    def audio_discarded(self, session_id: str, audio_ms: float) -> None: ...

    def observe_finalize(self, duration_ms: float) -> None: ...

    def observe_partial_age(self, duration_ms: float) -> None: ...

    def observe_reset_ack(self, duration_ms: float) -> None: ...

    async def wait_until_idle(self, *, grace_s: float = 0) -> None: ...


class InlineAsrExecution:
    """Synchronous runner used by tests and instrumented benchmark baselines."""

    def __init__(self) -> None:
        self.metrics = AsrMetrics()

    async def run(
        self,
        *,
        session_id: str,
        concurrency: int,
        input_epoch: int,  # noqa: ARG002
        input_turn_id: int,  # noqa: ARG002
        kind: str,
        input_audio_ms: float,
        func: Callable[[], T],
    ) -> T:
        job_id, _ = self.metrics.enqueued(
            session_id=session_id,
            concurrency=concurrency,
            kind=kind,
            input_audio_ms=input_audio_ms,
        )
        return _execute_job(self.metrics, job_id, func)

    def audio_received(self, session_id: str, audio_ms: float) -> None:
        self.metrics.audio_received(session_id, audio_ms)

    def audio_discarded(self, session_id: str, audio_ms: float) -> None:
        self.metrics.audio_discarded(session_id, audio_ms)

    def observe_finalize(self, duration_ms: float) -> None:
        self.metrics.observe_finalize(duration_ms)

    def observe_partial_age(self, duration_ms: float) -> None:
        self.metrics.observe_partial_age(duration_ms)

    def observe_reset_ack(self, duration_ms: float) -> None:
        self.metrics.observe_reset_ack(duration_ms)

    async def wait_until_idle(self, *, grace_s: float = 0) -> None:
        if grace_s < 0:
            raise ValueError("grace_s 必须 >= 0")
        return None

    async def shutdown(self) -> None:
        return None


class DedicatedAsrExecution:
    """Process-wide single-flight executor for shared FunASR models."""

    def __init__(self, *, operation_timeout_s: float = _DEFAULT_OPERATION_TIMEOUT_S) -> None:
        if operation_timeout_s <= 0:
            raise ValueError("operation_timeout_s 必须 > 0")
        self._executor = _ExitSafeThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="asr-inference",
        )
        self._operation_timeout_s = operation_timeout_s
        self._closed = False
        self._unhealthy = False
        self.metrics = AsrMetrics()

    async def run(
        self,
        *,
        session_id: str,  # noqa: ARG002
        concurrency: int,
        input_epoch: int,  # noqa: ARG002
        input_turn_id: int,  # noqa: ARG002
        kind: str,  # noqa: ARG002
        input_audio_ms: float,  # noqa: ARG002
        func: Callable[[], T],
    ) -> T:
        if self._closed:
            raise RuntimeError("ASR executor 已关闭")
        if self._unhealthy:
            raise RuntimeError("ASR executor 已因操作超时停止接收新作业")
        job_id, _ = self.metrics.enqueued(
            session_id=session_id,
            concurrency=concurrency,
            kind=kind,
            input_audio_ms=input_audio_ms,
        )

        future = asyncio.get_running_loop().run_in_executor(
            self._executor,
            _execute_job,
            self.metrics,
            job_id,
            func,
        )

        def _remove_cancelled_job(done: asyncio.Future[T]) -> None:
            if done.cancelled():
                self.metrics.cancelled_before_start(job_id)

        future.add_done_callback(_remove_cancelled_job)
        try:
            return await asyncio.wait_for(
                asyncio.shield(future),
                timeout=self._operation_timeout_s,
            )
        except TimeoutError as exc:
            if future.done():
                raise
            self._unhealthy = True
            self.metrics.operation_timed_out()
            raise AsrExecutionTimeout(
                f"ASR {kind} 超过 {self._operation_timeout_s:g}s"
            ) from exc
        except asyncio.CancelledError:
            raise

    def audio_received(self, session_id: str, audio_ms: float) -> None:
        self.metrics.audio_received(session_id, audio_ms)

    def audio_discarded(self, session_id: str, audio_ms: float) -> None:
        self.metrics.audio_discarded(session_id, audio_ms)

    def observe_finalize(self, duration_ms: float) -> None:
        self.metrics.observe_finalize(duration_ms)

    def observe_partial_age(self, duration_ms: float) -> None:
        self.metrics.observe_partial_age(duration_ms)

    def observe_reset_ack(self, duration_ms: float) -> None:
        self.metrics.observe_reset_ack(duration_ms)

    async def wait_until_idle(self, *, grace_s: float = 0) -> None:
        """Let already-submitted ASR work win the ASR-to-TTS GPU handoff."""
        if grace_s < 0:
            raise ValueError("grace_s 必须 >= 0")
        poll_s = 0.001
        while True:
            idle_marker = self.metrics.idle_marker()
            if idle_marker is None:
                await asyncio.sleep(poll_s)
                continue
            if grace_s == 0:
                return
            await asyncio.sleep(grace_s)
            if self.metrics.idle_marker() == idle_marker:
                return

    async def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._executor.shutdown(wait=False, cancel_futures=True)
        await asyncio.sleep(0)
