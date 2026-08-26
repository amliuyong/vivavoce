"""GPU 服务 e2e —— 经真实 WS 协议打通一通会话(start→audio→端点→tts_text→cancel→end)。

用 starlette TestClient 的 websocket_connect,走真实帧编解码与 server 状态机。
"""
from __future__ import annotations

import json
import math
import struct
import threading
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from gpu_service.protocol import ASR_SAMPLE_RATE
from gpu_service.server import create_app

# design contract:静音帧数从 VAD 默认值派生(勿硬编码 —— 改默认会让测试卡死而非报错)
from gpu_service.vad import VAD_DEFAULTS


@pytest.fixture
def client():
    app = create_app()
    with TestClient(app) as c:  # 触发 startup(加载模型/self-probe)
        yield c


def _speech(ms: int, amp: int = 12000, freq: int = 220) -> bytes:
    n = ASR_SAMPLE_RATE * ms // 1000
    return b"".join(
        struct.pack("<h", int(amp * math.sin(2 * math.pi * freq * i / ASR_SAMPLE_RATE)))
        for i in range(n)
    )


def _silence(ms: int) -> bytes:
    return b"\x00\x00" * (ASR_SAMPLE_RATE * ms // 1000)


def test_healthz_alive(client):
    assert client.get("/healthz").json()["status"] == "alive"


def test_readyz_ready_after_startup(client):
    r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"


def test_ws_start_returns_ready(client):
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        msg = json.loads(ws.receive_text())
        assert msg["type"] == "ready"


def test_slow_asr_does_not_block_health_endpoint(monkeypatch):
    import time

    started = threading.Event()
    release = threading.Event()
    result: dict[str, object] = {}

    class SlowAsr:
        def transcribe_chunk(self, pcm: bytes) -> str:  # noqa: ARG002
            started.set()
            assert release.wait(timeout=2)
            return "partial"

        def finalize(self, language=None):  # noqa: ARG002
            return "final"

        def reset(self):
            pass

    monkeypatch.setattr("gpu_service.session.make_asr", SlowAsr)
    app = create_app()

    with TestClient(app) as c:
        def run_ws() -> None:
            with c.websocket_connect("/v1/stream") as ws:
                ws.send_text(json.dumps({"type": "start", "session_id": "slow"}))
                assert json.loads(ws.receive_text())["type"] == "ready"
                for seq in range(1, 31):
                    _send_audio(ws, seq, _speech(20))
                result.update(json.loads(ws.receive_text()))

        worker = threading.Thread(target=run_ws)
        worker.start()
        assert started.wait(timeout=1)

        before = time.monotonic()
        assert c.get("/healthz").json() == {"status": "alive"}
        assert time.monotonic() - before < 0.2

        release.set()
        worker.join(timeout=2)
        assert not worker.is_alive()
        assert result["type"] == "asr_partial"


def test_asr_exception_returns_internal_and_closes_session(monkeypatch):
    class BrokenAsr:
        def transcribe_chunk(self, pcm: bytes) -> str:  # noqa: ARG002
            raise RuntimeError("inference exploded")

        def finalize(self, language=None):  # noqa: ARG002
            return "final"

        def reset(self):
            pass

    monkeypatch.setattr("gpu_service.session.make_asr", BrokenAsr)
    app = create_app()

    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "broken"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            for seq in range(1, 31):
                _send_audio(ws, seq, _speech(20))
            error = json.loads(ws.receive_text())
            assert error["type"] == "error"
            assert error["code"] == "INTERNAL"

        metrics = c.get("/metrics").json()["asr"]
        assert metrics["asr_operation_errors"] == 1
        assert metrics["asr_audio_backlog_ms"]["current"] == 0


def test_asr_timeout_marks_instance_not_ready(monkeypatch):
    import time

    from gpu_service.asr_execution import DedicatedAsrExecution

    class HungAsr:
        def transcribe_chunk(self, pcm: bytes) -> str:  # noqa: ARG002
            time.sleep(0.05)
            return "late"

        def finalize(self, language=None):  # noqa: ARG002
            return "final"

        def reset(self):
            pass

    monkeypatch.setattr("gpu_service.session.make_asr", HungAsr)
    app = create_app()
    app.state.asr_execution = DedicatedAsrExecution(operation_timeout_s=0.01)

    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "timeout"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            for seq in range(1, 31):
                _send_audio(ws, seq, _speech(20))
            error = json.loads(ws.receive_text())
            assert error["type"] == "error"
            assert error["code"] == "INTERNAL"

        assert c.get("/readyz").status_code == 503
        assert c.get("/metrics").json()["asr"]["asr_operation_timeouts"] == 1


def test_admission_gate_capacity_full(monkeypatch):
    """design contract:活跃会话达上限 → 新 start 回 CAPACITY_FULL 并关连接(不打爆 GPU)。
    上限设 1:第一通占名额,第二通被拒;第一通结束释放名额后,第三通又能进。"""
    monkeypatch.setenv("AIM_GPU_MAX_SESSIONS", "1")
    app = create_app()
    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws1:
            ws1.send_text(json.dumps({"type": "start", "session_id": "a"}))
            assert json.loads(ws1.receive_text())["type"] == "ready"
            assert app.state.active_sessions == 1
            # 第二通:满了 → CAPACITY_FULL
            with c.websocket_connect("/v1/stream") as ws2:
                ws2.send_text(json.dumps({"type": "start", "session_id": "b"}))
                m = json.loads(ws2.receive_text())
                assert m["type"] == "error"
                assert m["code"] == "CAPACITY_FULL"
            assert app.state.active_sessions == 1  # 被拒连接不占名额
        # ws1 关闭后名额释放
        assert app.state.active_sessions == 0
        with c.websocket_connect("/v1/stream") as ws3:
            ws3.send_text(json.dumps({"type": "start", "session_id": "c"}))
            assert json.loads(ws3.receive_text())["type"] == "ready"


# ── design contract:容量可观测 /metrics + drain ──
def test_metrics_reports_usage(monkeypatch):
    """/metrics 暴露 active/max/utilization/ready/draining(供 reconciler 求和、前端展示)。"""
    monkeypatch.setenv("AIM_GPU_MAX_SESSIONS", "3")
    app = create_app()
    with TestClient(app) as c:
        m = c.get("/metrics").json()
        assert m["active_sessions"] == 0
        assert m["max_sessions"] == 3
        assert m["utilization"] == 0.0
        assert m["ready"] is True
        assert m["draining"] is False
        assert m["asr_run_kind"] == "600ms-dedicated-thread"
        assert m["asr_chunk_ms"] == 600
        assert set(m["asr"]) >= {
            "asr_wrapper_calls_per_audio_second",
            "asr_stream_forward_chunks_per_audio_second",
            "asr_queue_wait_ms",
            "asr_inference_ms",
            "asr_audio_backlog_ms",
            "asr_finalize_ms",
            "asr_partial_age_ms",
            "input_reset_ack_ms",
            "gpu_event_loop_lag_ms",
            "executor",
        }
        assert m["asr"]["executor"]["in_flight"] == 0
        assert set(m["runtime"]) == {
            "python",
            "funasr",
            "numpy",
            "pytorch",
            "cuda",
            "image_tag",
            "image_digest",
            "model_manifest_id",
        }
        # 占一个名额后利用率上升
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            m2 = c.get("/metrics").json()
            assert m2["active_sessions"] == 1
            assert abs(m2["utilization"] - 1 / 3) < 1e-6


@pytest.mark.parametrize(
    ("run_kind", "chunk_ms"),
    [
        ("20ms-sync", 20),
        ("600ms-sync", 600),
        ("600ms-dedicated-thread", 600),
    ],
)
def test_benchmark_server_mode_is_reported(run_kind, chunk_ms):
    app = create_app(asr_run_kind=run_kind)
    with TestClient(app) as c:
        metrics = c.get("/metrics").json()
        assert metrics["asr_run_kind"] == run_kind
        assert metrics["asr_chunk_ms"] == chunk_ms


def test_unknown_benchmark_server_mode_is_rejected():
    with pytest.raises(ValueError, match="未知 ASR run kind"):
        create_app(asr_run_kind="typo")


def test_drain_endpoint_rejects_new_but_keeps_inflight(monkeypatch):
    """POST /drain(带密钥)置位 → 新 start 回 CAPACITY_FULL;在途会话不受影响(design contract)。"""
    monkeypatch.setenv("AIM_GPU_MAX_SESSIONS", "3")
    monkeypatch.setenv("AIM_DRAIN_SECRET", "s3cr3t")
    hdr = {"X-Drain-Secret": "s3cr3t"}
    app = create_app()
    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws1:
            ws1.send_text(json.dumps({"type": "start", "session_id": "live"}))
            assert json.loads(ws1.receive_text())["type"] == "ready"
            assert app.state.active_sessions == 1
            # 经 /drain 端点(reconciler/lifecycle 缩容前置 drain 的真实路径,非测试直接改 state)
            assert c.post("/drain", headers=hdr).json()["draining"] is True
            assert c.get("/metrics").json()["draining"] is True
            with c.websocket_connect("/v1/stream") as ws2:
                ws2.send_text(json.dumps({"type": "start", "session_id": "new"}))
                m = json.loads(ws2.receive_text())
                assert m["type"] == "error" and m["code"] == "CAPACITY_FULL"
            assert app.state.active_sessions == 1  # 在途未被腰斩
        assert c.post("/drain?on=false", headers=hdr).json()["draining"] is False  # 撤销恢复接客


def test_drain_auth_fail_closed(monkeypatch):
    """/drain 改状态须鉴权(D9 + review):未配密钥→503;配了但头不匹配→401。"""
    monkeypatch.setenv("AIM_GPU_MAX_SESSIONS", "3")
    monkeypatch.delenv("AIM_DRAIN_SECRET", raising=False)
    app = create_app()
    with TestClient(app) as c:
        assert c.post("/drain").status_code == 503  # 未配密钥 → 禁用
    monkeypatch.setenv("AIM_DRAIN_SECRET", "s3cr3t")
    app2 = create_app()
    with TestClient(app2) as c2:
        assert c2.post("/drain").status_code == 401  # 缺头
        assert c2.post("/drain", headers={"X-Drain-Secret": "wrong"}).status_code == 401  # 头错
        assert app2.state.draining is False  # 未被改


def test_reload_tts_config_auth_fail_closed(monkeypatch):
    """/reload-tts-config 改状态/真调云端,须鉴权(design contract 复用 /drain 共享密钥):
    未配密钥→503;配了但头不匹配→401。"""
    monkeypatch.delenv("AIM_DRAIN_SECRET", raising=False)
    app = create_app()
    with TestClient(app) as c:
        assert c.post("/reload-tts-config").status_code == 503  # 未配密钥 → 禁用
    monkeypatch.setenv("AIM_DRAIN_SECRET", "s3cr3t")
    app2 = create_app()
    with TestClient(app2) as c2:
        assert c2.post("/reload-tts-config").status_code == 401  # 缺头
        assert c2.post("/reload-tts-config", headers={"X-Drain-Secret": "wrong"}).status_code == 401


def test_reload_tts_config_returns_probe_receipt(monkeypatch):
    """带密钥的 reload → 重读 Secret + 重跑 MiniMax probe,返回校验回执(design contract)。
    未配置/未启用 MiniMax → 回执 ok=false enabled=false;GPU 整体仍 ready(下个测验证)。"""
    monkeypatch.setenv("AIM_DRAIN_SECRET", "s3cr3t")
    monkeypatch.setenv("AIM_MINIMAX_SECRET_ID", "")  # 走 env 回退
    monkeypatch.delenv("AIM_MINIMAX_ENABLED", raising=False)
    app = create_app()
    with TestClient(app) as c:
        r = c.post("/reload-tts-config", headers={"X-Drain-Secret": "s3cr3t"})
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is False and body["enabled"] is False


def test_readyz_independent_of_minimax(monkeypatch):
    """design contract:MiniMax 未配/无效不拖垮整体 /readyz(默认 OmniVoice/ASR 决定 readiness)。"""
    monkeypatch.setenv("AIM_DRAIN_SECRET", "s3cr3t")
    monkeypatch.delenv("AIM_MINIMAX_ENABLED", raising=False)
    app = create_app()
    with TestClient(app) as c:  # startup self-probe 只焐 OmniVoice/ASR,不真调 MiniMax
        assert c.get("/readyz").status_code == 200  # 未配 MiniMax 仍 ready
        # 热加载 probe 失败(未启用)也不改变 /readyz
        c.post("/reload-tts-config", headers={"X-Drain-Secret": "s3cr3t"})
        assert c.get("/readyz").status_code == 200


def _send_audio(ws, seq: int, chunk: bytes) -> None:
    ws.send_text(json.dumps({"type": "audio_meta", "session_id": "s1", "seq": seq, "bytes": len(chunk)}))
    ws.send_bytes(chunk)


def test_ws_full_turn_then_tts(client):
    """600ms speech→partial;普通静音帧→0;端点帧→final+turn_end。"""
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"

        seq = 0
        # 满 600ms 主块后才产出一个 partial。
        for _ in range(30):
            seq += 1
            _send_audio(ws, seq, _speech(20))
        assert json.loads(ws.receive_text())["type"] == "asr_partial"

        # 静音帧:普通静音帧 0 下行,端点帧产出 final + turn_end。
        # 用短轮询(receive_text 在端点帧才有数据)→ 这里改为:每帧发后尝试 step。
        # 为避免阻塞,逐帧发送但只在"足够静音"后集中读 final/turn_end。
        # ★ design contract:帧数**从 VAD 默认值派生**,不再硬编码。
        #   原为固定 60 帧(=1200ms),在 hangover=800 时够;design contract 把 hangover 默认回落成真机值
        #   **1400** 后 1200ms 不足 → 永远等不到 turn_end,`ws.receive_text()` 无限阻塞、整个
        #   pytest 会话挂死(实测:原 5s 跑完变成 >7min 无输出)。
        #   派生 + 余量后,将来再调默认值不会重现这种「测试卡死而非报错」的失败形状。
        silence_frames = math.ceil(VAD_DEFAULTS["hangover_ms"] / 20) + 10  # 帧长 20ms,+10 帧余量
        for _ in range(silence_frames):
            seq += 1
            _send_audio(ws, seq, _silence(20))
        # 端点必在上面某帧触发,产出恰好 2 条下行(final, turn_end)
        m1 = json.loads(ws.receive_text())
        m2 = json.loads(ws.receive_text())
        assert m1["type"] == "asr_final"
        assert m2["type"] == "turn_end"

        # Bridge 把 LLM 分句结果下发做 TTS
        ws.send_text(json.dumps({"type": "tts_text", "session_id": "s1", "text": "你好"}))
        metas = 0
        done = False
        for _ in range(500):
            m = json.loads(ws.receive_text())
            if m["type"] == "tts_audio_meta":
                metas += 1
                pcm = ws.receive_bytes()  # 紧跟的 binary
                assert len(pcm) == m["bytes"]
            elif m["type"] == "tts_done":
                done = True
                break
        assert metas > 0 and done

        ws.send_text(json.dumps({"type": "end", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "bye"


def test_admission_no_overadmit_on_cold_start_race(monkeypatch):
    """冷启动(active=0)多通并发 start 不得超派(真机压测暴露的 TOCTOU 竞态回归)。

    首会话 0→1 时 protect-before-admit 有 executor await(run_in_executor)会让出事件循环。若
    `active_sessions += 1` 放在 await 之后,两通并发会各自闯过 `>= max` 检查、再在 await 后依次自增
    → 超派(真机 3~4 通并发实测接纳 3 通)。修复:先占名额(check-and-increment 中间无 await)再做 protection。

    这里把 task_protection.set 换成「慢」实现(sleep,在 run_in_executor 线程里被调用 → 主事件循环 await
    时让出),用两个线程并发跑两条同步 WS 打这个让出窗口。上限设 1:修复后只 1 通 ready、另一通 CAPACITY_FULL;
    修复前(自增在 await 后)两通会都 ready、active_sessions 冲到 2。"""
    import threading
    import time as _t

    monkeypatch.setenv("AIM_GPU_MAX_SESSIONS", "1")
    app = create_app()

    # 慢 protection.set:server 经 run_in_executor 调它 → 主循环在此 await 让出,给第二通并发 start 机会。
    orig_set = app.state.task_protection.set

    def _slow_set(on: bool):
        _t.sleep(0.2)  # 放大让出窗口,确保两条 WS 的 start 都进到 admission 决策
        return orig_set(on)

    app.state.task_protection.set = _slow_set  # type: ignore[assignment]

    results: dict[str, dict] = {}
    barrier = threading.Barrier(2)  # 两线程同时发 start,最大化并发撞窗口

    with TestClient(app) as c:
        def _one(sid: str):
            with c.websocket_connect("/v1/stream") as ws:
                barrier.wait()
                ws.send_text(json.dumps({"type": "start", "session_id": sid}))
                results[sid] = json.loads(ws.receive_text())

        t1 = threading.Thread(target=_one, args=("race-a",))
        t2 = threading.Thread(target=_one, args=("race-b",))
        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

    readies = [r for r in results.values() if r.get("type") == "ready"]
    caps = [r for r in results.values()
            if r.get("type") == "error" and r.get("code") == "CAPACITY_FULL"]
    assert len(readies) == 1, f"超派!ready={len(readies)} 应为 1;results={results}"
    assert len(caps) == 1, f"应有 1 通被 CAPACITY_FULL 拒;results={results}"
    # 两条 WS 均已关闭(with 块退出)→ 名额全部归还,计数不残留(被拒连接本就没占,ready 那通 close 时 -=1)。
    assert app.state.active_sessions == 0, f"名额未干净归还:active={app.state.active_sessions}"


def test_ws_binary_without_meta_is_protocol_error(client):
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_bytes(b"\x00\x00" * 160)  # 没有前置 audio_meta
        m = json.loads(ws.receive_text())
        assert m["type"] == "error"
        assert m["code"] == "PROTOCOL_ERROR"


def test_ws_bad_pcm_alignment_error(client):
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "audio_meta", "session_id": "s1", "seq": 1, "bytes": 3}))
        ws.send_bytes(b"\x00\x01\x02")  # 奇数字节
        m = json.loads(ws.receive_text())
        assert m["type"] == "error"
        assert m["code"] == "BAD_AUDIO_FORMAT"


def test_ws_audio_meta_bytes_non_integer_rejected(client):
    """audio_meta.bytes 非整数(字符串)→ PROTOCOL_ERROR,不让 int() 抛崩会话(#9)。"""
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "audio_meta", "session_id": "s1", "seq": 1, "bytes": "abc"}))
        ws.send_bytes(b"\x00\x00" * 80)
        m = json.loads(ws.receive_text())
        assert m["type"] == "error"
        assert m["code"] == "PROTOCOL_ERROR"


def test_ws_binary_length_mismatch_rejected(client):
    """meta.bytes 与实际 binary 长度不一致 → BAD_AUDIO_FORMAT(防协议注入/缓冲膨胀)。"""
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        # 声明 1000 字节但只发 4 字节
        ws.send_text(json.dumps({"type": "audio_meta", "session_id": "s1", "seq": 1, "bytes": 1000}))
        ws.send_bytes(b"\x00\x01\x02\x03")
        m = json.loads(ws.receive_text())
        assert m["type"] == "error"
        assert m["code"] == "BAD_AUDIO_FORMAT"


def test_ws_stray_binary_then_valid_pair_recovers(client):
    """无 meta 的 binary 报错后,pending 状态被清,后续正常 meta+binary 仍可工作。"""
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_bytes(b"\x00\x00" * 160)  # 无前置 meta
        assert json.loads(ws.receive_text())["code"] == "PROTOCOL_ERROR"
        # 恢复:累计满 600ms 后应得到 asr_partial
        import math
        import struct
        pcm = b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 220 * i / 16000)))
                       for i in range(320))
        for seq in range(1, 31):
            ws.send_text(json.dumps({
                "type": "audio_meta", "session_id": "s1", "seq": seq, "bytes": len(pcm),
            }))
            ws.send_bytes(pcm)
        m = json.loads(ws.receive_text())
        assert m["type"] == "asr_partial"


def test_ws_input_reset_fences_old_epoch_audio(client):
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"

        chunk = _speech(20)
        for seq in range(1, 31):
            ws.send_text(json.dumps({
                "type": "audio_meta", "session_id": "s1", "seq": seq,
                "bytes": len(chunk), "input_epoch": 0,
            }))
            ws.send_bytes(chunk)
        first = json.loads(ws.receive_text())
        assert first["type"] == "asr_partial"
        assert (first["input_epoch"], first["input_turn_id"]) == (0, 0)

        ws.send_text(json.dumps({
            "type": "input_reset", "session_id": "s1",
            "from_input_epoch": 0, "next_input_epoch": 1,
        }))
        ack = json.loads(ws.receive_text())
        assert ack["type"] == "input_reset_ack"
        assert ack["input_epoch"] == 1

        ws.send_text(json.dumps({
            "type": "audio_meta", "session_id": "s1", "seq": 2,
            "bytes": len(chunk), "input_epoch": 0,
        }))
        ws.send_bytes(chunk)
        stale = json.loads(ws.receive_text())
        assert stale["type"] == "error"
        assert stale["code"] == "PROTOCOL_ERROR"

        for seq in range(32, 62):
            ws.send_text(json.dumps({
                "type": "audio_meta", "session_id": "s1", "seq": seq,
                "bytes": len(chunk), "input_epoch": 1,
            }))
            ws.send_bytes(chunk)
        current = json.loads(ws.receive_text())
        assert current["type"] == "asr_partial"
        assert (current["input_epoch"], current["input_turn_id"]) == (1, 0)


def test_ws_flush_finalizes_turn_without_closing(client):
    """flush:连续说话(无尾静音,VAD 不出 turn_end)→ flush 主动出 asr_final+turn_end,
    且会话不关闭(可继续下一轮)。这是 voice-test「结束本轮」的 GPU 语义,修没声音根因。"""
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        seq = 0
        for _ in range(15):  # 300ms 纯语音,无尾静音
            seq += 1
            _send_audio(ws, seq, _speech(20))
        # flush → 主动 finalize
        ws.send_text(json.dumps({"type": "flush", "session_id": "s1"}))
        m1 = json.loads(ws.receive_text())
        m2 = json.loads(ws.receive_text())
        assert m1["type"] == "asr_final"
        assert m2["type"] == "turn_end"
        # 会话仍开:下一轮累计满 600ms 后能拿 partial(证明 flush 没关会话)
        for _ in range(30):
            seq += 1
            _send_audio(ws, seq, _speech(20))
        assert json.loads(ws.receive_text())["type"] == "asr_partial"


def test_ws_flush_no_speech_emits_turn_end_only(client):
    """误点结束本轮 / 没说话时 flush 只回 turn_end(无 asr_final)→ 前端有明确轮结束信号,
    不卡 waiting_reply;后端据空文本回 no_speech。"""
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "flush", "session_id": "s1"}))
        m = json.loads(ws.receive_text())
        assert m["type"] == "turn_end"


def test_ws_late_identity_flush_does_not_finalize_the_next_turn(client):
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"

        ws.send_text(json.dumps({
            "type": "flush", "session_id": "s1",
            "input_epoch": 0, "input_turn_id": 0,
        }))
        ended = json.loads(ws.receive_text())
        assert (ended["type"], ended["input_turn_id"]) == ("turn_end", 0)

        chunk = _speech(20)
        for seq in range(1, 31):
            _send_audio(ws, seq, chunk)
        partial = json.loads(ws.receive_text())
        assert (partial["type"], partial["input_turn_id"]) == ("asr_partial", 1)

        ws.send_text(json.dumps({
            "type": "flush", "session_id": "s1",
            "input_epoch": 0, "input_turn_id": 0,
        }))
        ws.send_text(json.dumps({
            "type": "flush", "session_id": "s1",
            "input_epoch": 0, "input_turn_id": 1,
        }))
        final = json.loads(ws.receive_text())
        current_end = json.loads(ws.receive_text())
        assert (final["type"], final["input_turn_id"]) == ("asr_final", 1)
        assert (current_end["type"], current_end["input_turn_id"]) == ("turn_end", 1)

        ws.send_text(json.dumps({
            "type": "flush", "session_id": "s1",
            "input_epoch": 0, "input_turn_id": 4,
        }))
        future = json.loads(ws.receive_text())
        assert future["type"] == "error"
        assert future["code"] == "PROTOCOL_ERROR"


def test_ws_multiple_tts_text_each_emits_done(client):
    """同一轮多句 tts_text 串行合成:每句都出 tts_done(不取消上一句)。
    修 review:此前新 tts_text 取消上一句 → 丢音频 + 丢 tts_done → 后端计数泄漏、只播最后一句。"""
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        # 快速连发 3 句(模拟 LLM 出句比合成快)
        for s in ["第一句。", "第二句。", "第三句。"]:
            ws.send_text(json.dumps({"type": "tts_text", "session_id": "s1", "text": s}))
        # 应收到 3 个 tts_done(每句一个),不是被顶掉只剩 1 个
        done = 0
        for _ in range(2000):
            m = json.loads(ws.receive_text())
            if m["type"] == "tts_done":
                done += 1
                if done == 3:
                    break
            elif m["type"] == "tts_audio_meta":
                ws.receive_bytes()
        assert done == 3


def test_ws_tts_waits_for_asr_handoff_before_synthesis():
    app = create_app()
    wait_until_idle = AsyncMock(wraps=app.state.asr_execution.wait_until_idle)
    app.state.asr_execution.wait_until_idle = wait_until_idle

    with TestClient(app) as client:
        with client.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({
                "type": "tts_text",
                "session_id": "s1",
                "text": "你好",
            }))
            while True:
                message = json.loads(ws.receive_text())
                if message["type"] == "tts_audio_meta":
                    ws.receive_bytes()
                elif message["type"] == "tts_done":
                    break

    wait_until_idle.assert_awaited_once_with(grace_s=0.02)


def test_ws_tts_text_emits_identity_correlated_local_metrics_before_done(client):
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({
            "type": "tts_text",
            "session_id": "s1",
            "text": "你好",
            "ai_turn_id": 7,
            "segment_id": 2,
        }))

        metric = None
        done = None
        for _ in range(100):
            message = json.loads(ws.receive_text())
            if message["type"] == "tts_audio_meta":
                assert message["ai_turn_id"] == 7
                assert message["segment_id"] == 2
                ws.receive_bytes()
            elif message["type"] == "tts_metrics":
                metric = message
                assert done is None
            elif message["type"] == "tts_done":
                done = message
                break

        assert metric is not None
        assert done is not None
        assert done["ai_turn_id"] == 7
        assert done["segment_id"] == 2
        assert metric["ai_turn_id"] == 7
        assert metric["segment_id"] == 2
        assert metric["tts_provider"] == "gpu_omnivoice"
        assert metric["provider_start_to_first_send_ms"] >= 0
        assert metric["generation_wall_time_ms"] >= metric["provider_start_to_first_send_ms"]
        assert metric["generated_audio_duration_ms"] > 0
        assert metric["rtf"] >= 0
        assert metric["cache_state"] in {"cold", "warm", "not_applicable", "unknown"}
        assert metric["concurrency"] == 1
        assert metric["model_first_chunk_unavailable_reason"] == (
            "provider_does_not_expose_model_first_chunk"
        )


def test_ws_cancel_during_slow_tts_ack_immediate_and_queue_dropped(monkeypatch):
    """cancel 队头阻塞修复(barge-in 实时性):慢句合成期间 cancel 必须**即时**被主循环处理——
    cancel_ack 先回、在飞句停止、队列中未开跑的句整句丢弃(旧代际)。

    修复前:主循环收 tts_text 时 `await tts_task` 阻塞,cancel 帧在 WS 缓冲排队等当前句合成完
    (慢句 = 阻塞秒级)→ cancel_ack 秒级迟到(线上 cancel_ack_timeout 71% 根因)、打断迟到整句。
    用「每帧 sleep 的慢 TTS」放大窗口:修复后 cancel_ack 在慢句**首帧后**极快到达,且此后
    不再有该句后续帧、队列第二句也不合成(0 个 tts_done)。"""
    import time

    from gpu_service import engines

    class SlowTts:
        """每帧 sleep 50ms 的慢 TTS(在 executor 线程跑,模拟真实 OmniVoice 数百 ms/句)。"""
        def synthesize(self, text):  # noqa: ARG002
            for _ in range(40):  # 40 帧 × 50ms = 2s/句
                time.sleep(0.05)
                yield b"\x01\x00" * 480
    monkeypatch.setattr(engines, "make_tts", lambda *a, **k: SlowTts())
    # session 模块 from-import 了 make_tts,需一并 patch(否则仍用真 StubTts)
    monkeypatch.setattr("gpu_service.session.make_tts", lambda *a, **k: SlowTts())

    app = create_app()
    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            # 背靠背两句(模拟 LLM 分句连发):第一句慢合成在飞,第二句排队
            ws.send_text(json.dumps({"type": "tts_text", "session_id": "s1", "text": "第一句很长。"}))
            ws.send_text(json.dumps({"type": "tts_text", "session_id": "s1", "text": "第二句排队。"}))
            # 等到第一句首帧(确认在飞)再 cancel
            m = json.loads(ws.receive_text())
            assert m["type"] == "tts_audio_meta"
            ws.receive_bytes()
            t0 = time.monotonic()
            ws.send_text(json.dumps({"type": "cancel", "session_id": "s1", "reason": "barge_in"}))
            # cancel_ack 必须**先于**第一句合成完(2s)到达;容忍 ack 前混入 ≤2 个在途残帧
            # (cancel 处理与在飞句下一块检查有一帧竞态窗,残帧无害——Bridge 侧 interrupted 守卫丢弃)
            stray = 0
            while True:
                m = json.loads(ws.receive_text())
                if m["type"] == "cancel_ack":
                    break
                assert m["type"] == "tts_audio_meta" and stray < 2, f"ack 前收到意外帧 {m['type']}"
                ws.receive_bytes()
                stray += 1
            ack_delay = time.monotonic() - t0
            assert ack_delay < 1.0, f"cancel_ack 迟到 {ack_delay:.2f}s(队头阻塞未修)"
            # cancel 后:在飞句停(无 tts_done)、队列第二句整句丢弃(也无帧无 done)。
            # 新句(新代际)照常合成 → 收到它的 done 即证明中间无任何残留帧/残留 done。
            ws.send_text(json.dumps({"type": "tts_text", "session_id": "s1", "text": "新轮。"}))
            saw_done = 0
            for _ in range(200):
                m = json.loads(ws.receive_text())
                if m["type"] == "tts_audio_meta":
                    ws.receive_bytes()
                elif m["type"] == "tts_done":
                    saw_done += 1
                    break
            assert saw_done == 1  # 只有新句的 done;被 cancel 的两句零 done
            ws.send_text(json.dumps({"type": "end", "session_id": "s1"}))
            # end 收尾:新句已合成完,bye 是最后一帧
            assert json.loads(ws.receive_text())["type"] == "bye"


def test_ws_cancel_ack_fences_executor_frame_completed_before_cancel(monkeypatch):
    """线程池已产出的旧帧若在 cancel 后才恢复 await，不得越过 cancel_ack 污染新句。"""
    import asyncio

    from gpu_service import engines

    class TaggedTts:
        def synthesize(self, text):
            sample = b"\x01\x00" if text == "旧句" else b"\x02\x00"
            yield sample * 480

    monkeypatch.setattr(engines, "make_tts", lambda *a, **k: TaggedTts())
    monkeypatch.setattr("gpu_service.session.make_tts", lambda *a, **k: TaggedTts())

    original_run_in_executor = asyncio.BaseEventLoop.run_in_executor
    hold_next_result = threading.Event()
    executor_result_ready = threading.Event()
    release_executor_result = threading.Event()
    result_held = threading.Event()

    def delayed_run_in_executor(loop, executor, func, *args):
        future = original_run_in_executor(loop, executor, func, *args)
        if not hold_next_result.is_set() or result_held.is_set():
            return future
        result_held.set()

        async def hold_completed_result():
            result = await future
            executor_result_ready.set()
            while not release_executor_result.is_set():
                await asyncio.sleep(0.001)
            return result

        return asyncio.ensure_future(hold_completed_result(), loop=loop)

    monkeypatch.setattr(
        asyncio.BaseEventLoop,
        "run_in_executor",
        delayed_run_in_executor,
    )

    app = create_app()
    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
            assert json.loads(ws.receive_text())["type"] == "ready"

            hold_next_result.set()
            ws.send_text(json.dumps({
                "type": "tts_text",
                "session_id": "s1",
                "text": "旧句",
            }))
            assert executor_result_ready.wait(timeout=1)

            ws.send_text(json.dumps({
                "type": "cancel",
                "session_id": "s1",
                "reason": "barge_in",
            }))
            assert json.loads(ws.receive_text())["type"] == "cancel_ack"
            ws.send_text(json.dumps({
                "type": "tts_text",
                "session_id": "s1",
                "text": "新句",
            }))
            release_executor_result.set()

            meta = json.loads(ws.receive_text())
            assert meta["type"] == "tts_audio_meta"
            assert ws.receive_bytes() == b"\x02\x00" * 480
            assert json.loads(ws.receive_text())["type"] == "tts_done"


def test_ws_cancel_reports_local_compute_and_send_tail_without_delaying_ack(monkeypatch):
    import time

    from gpu_service import engines

    class SlowTts:
        telemetry_provider = "gpu_omnivoice"

        def telemetry_cache_state(self, text):  # noqa: ARG002
            return "warm"

        def synthesize(self, text):  # noqa: ARG002
            for _ in range(10):
                time.sleep(0.03)
                yield b"\x04\x00" * 480

    monkeypatch.setattr(engines, "make_tts", lambda *a, **k: SlowTts())
    monkeypatch.setattr("gpu_service.session.make_tts", lambda *a, **k: SlowTts())

    app = create_app()
    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({
                "type": "tts_text",
                "session_id": "s1",
                "text": "旧句",
                "ai_turn_id": 12,
                "segment_id": 1,
            }))
            assert json.loads(ws.receive_text())["type"] == "tts_audio_meta"
            ws.receive_bytes()

            started = time.monotonic()
            ws.send_text(json.dumps({
                "type": "cancel",
                "session_id": "s1",
                "reason": "barge_in",
            }))
            while True:
                message = json.loads(ws.receive_text())
                if message["type"] == "cancel_ack":
                    break
                assert message["type"] == "tts_audio_meta"
                ws.receive_bytes()
            assert time.monotonic() - started < 0.2

            metric = json.loads(ws.receive_text())
            assert metric["type"] == "tts_metrics"
            assert metric["ai_turn_id"] == 12
            assert metric["segment_id"] == 1
            assert metric["cancel_to_last_model_compute_ms"] > 0
            assert metric["cancel_to_last_gpu_send_ms"] >= 0


def test_ws_cancel_ack_cannot_split_tts_meta_from_its_binary(monkeypatch):
    """A cancel ACK may precede or follow one complete old frame, never split its meta/PCM pair."""
    import asyncio

    from starlette.websockets import WebSocket

    from gpu_service import engines

    class OneFrameTts:
        def synthesize(self, text):  # noqa: ARG002
            yield b"\x03\x00" * 480

    monkeypatch.setattr(engines, "make_tts", lambda *a, **k: OneFrameTts())
    monkeypatch.setattr("gpu_service.session.make_tts", lambda *a, **k: OneFrameTts())

    original_send_bytes = WebSocket.send_bytes
    binary_send_entered = threading.Event()
    release_binary_send = threading.Event()
    held_once = threading.Event()

    async def held_send_bytes(self, data):
        if not held_once.is_set():
            held_once.set()
            binary_send_entered.set()
            while not release_binary_send.is_set():
                await asyncio.sleep(0.001)
        await original_send_bytes(self, data)

    monkeypatch.setattr(WebSocket, "send_bytes", held_send_bytes)

    app = create_app()
    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "s1"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({
                "type": "tts_text",
                "session_id": "s1",
                "text": "旧句",
            }))
            meta = json.loads(ws.receive_text())
            assert meta["type"] == "tts_audio_meta"
            assert binary_send_entered.wait(timeout=1)

            ws.send_text(json.dumps({
                "type": "cancel",
                "session_id": "s1",
                "reason": "barge_in",
            }))
            threading.Timer(0.05, release_binary_send.set).start()

            assert ws.receive_bytes() == b"\x03\x00" * 480
            assert json.loads(ws.receive_text())["type"] == "cancel_ack"


@pytest.mark.asyncio
async def test_orchestrator_stale_epoch_sentence_dropped():
    """代际核对(SessionOrchestrator.on_tts_text):入队时捕获的 epoch 与当前不符(cancel 已到)
    → 整句丢弃,零帧零 done;当前代际句照常合成。"""
    from gpu_service.session import SessionOrchestrator

    orch = SessionOrchestrator("s1")
    epoch_before = orch.cancel_epoch
    await orch.on_cancel("barge_in")  # cancel → 代际 +1
    # 旧代际句:整句丢弃
    provider_starts = []
    assert list(orch.on_tts_text(
        "旧轮残句",
        epoch_before,
        on_provider_start=provider_starts.append,
    )) == []
    assert provider_starts == []
    # 当前代际句:照常合成(有帧有 done)
    out = [o.control.type for o in orch.on_tts_text("新句", orch.cancel_epoch)]
    assert "tts_audio_meta" in out and out[-1] == "tts_done"


# ── design contract 验收(6.1/6.2/6.4 的可自动化核心)──
# 真机/网页验收(感知音质、真网络、真 key)需部署栈;但 tts_provider=minimax 经 start 帧 → make_tts →
# MiniMaxTts → WS 回灌帧的**完整代码路径**,以及单句失败降级,可在进程内用 mock MiniMax HTTP(无真 key)
# 跑通——把 6.x 中"可验证的接线/降级逻辑"与"只能真机验的感知/网络"切开,先把前者锁死。

def _minimax_cfg(monkeypatch, *, key="sk-e2e"):
    """让 MiniMaxTts 取到一份 enabled+有 key 的配置(走 env 回退,不触 boto3/Secret)。"""
    from gpu_service import minimax_config as mc
    monkeypatch.setenv("AIM_MINIMAX_SECRET_ID", "")
    monkeypatch.setenv("AIM_MINIMAX_ENABLED", "1")
    monkeypatch.setenv("AIM_MINIMAX_API_KEY", key)
    mc._reset_for_test()


def _patch_minimax_http(monkeypatch, *, raw=None, exc=None):
    """patch MiniMaxTts 底层 urlopen,返回构造的成功响应 raw,或抛 exc(模拟超时/限流)。"""
    class _Resp:
        def __init__(self, data):
            self._data = data
        def read(self):
            return self._data
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        if exc is not None:
            raise exc
        return _Resp(raw)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)


def _ok_minimax(pcm: bytes) -> bytes:
    return json.dumps({
        "data": {"audio": pcm.hex()},
        "base_resp": {"status_code": 0, "status_msg": "success"},
    }).encode("utf-8")


def test_ws_tts_provider_minimax_full_turn(monkeypatch):
    """6.1/6.2 自动化核心:start 带 tts_provider=minimax → tts_text 经 MiniMaxTts 合成回灌
    24k mono s16le 帧 + tts_done。验证 provider 分流 + 回灌帧形态对齐 OmniVoice。"""
    from gpu_service.protocol import TTS_SAMPLE_RATE

    _minimax_cfg(monkeypatch)
    # 4 帧 PCM(每帧 24000*0.02*2=960B)
    frame = TTS_SAMPLE_RATE * 20 // 1000 * 2
    pcm = b"\x11\x22" * (frame * 4 // 2)
    _patch_minimax_http(monkeypatch, raw=_ok_minimax(pcm))

    app = create_app()
    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "mm1",
                                     "voice": "female_std", "tts_provider": "minimax"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({"type": "tts_text", "session_id": "mm1", "text": "你好,这是 MiniMax 合成。"}))
            got = bytearray()
            done = False
            for _ in range(500):
                m = json.loads(ws.receive_text())
                if m["type"] == "tts_audio_meta":
                    assert m["sample_rate"] == TTS_SAMPLE_RATE  # 下行 24k(免重采样)
                    b = ws.receive_bytes()
                    assert len(b) == m["bytes"]
                    got += b
                elif m["type"] == "tts_done":
                    done = True
                    break
            assert done and bytes(got) == pcm  # MiniMax 回的 PCM 完整回灌


def test_ws_tts_provider_minimax_single_failure_falls_back_local(monkeypatch):
    """6.4 自动化核心(回退语义,用户决策):MiniMax 单句失败(限流 1039)→ **回退本地 OmniVoice
    合成该句**,产出音频帧 + tts_done,**不漏句、不 error、不静默**(本测后端=stub,本地引擎出音)。"""
    _minimax_cfg(monkeypatch)
    raw = json.dumps({"data": None, "base_resp": {"status_code": 1039, "status_msg": "TPM limit"}}).encode()
    _patch_minimax_http(monkeypatch, raw=raw)

    app = create_app()
    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "mm2", "tts_provider": "minimax"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({"type": "tts_text", "session_id": "mm2", "text": "这句会失败。"}))
            saw_error = False
            saw_done = False
            audio_bytes = 0
            for _ in range(500):
                m = json.loads(ws.receive_text())
                if m["type"] == "error":
                    saw_error = True
                elif m["type"] == "tts_audio_meta":
                    audio_bytes += len(ws.receive_bytes())
                elif m["type"] == "tts_done":
                    saw_done = True
                    break
            assert not saw_error, "回退本地后不应再上报 error 帧"
            assert saw_done, "本轮须正常结束(tts_done)"
            assert audio_bytes > 0, "回退本地 OmniVoice 必须真出音(不漏句、不静默)"


def test_ws_tts_provider_minimax_timeout_falls_back_local(monkeypatch):
    """6.4 超时同样回退本地:本地引擎合成该句出音 + tts_done,本轮不卡、不漏句。"""
    _minimax_cfg(monkeypatch)
    _patch_minimax_http(monkeypatch, exc=TimeoutError("timed out"))

    app = create_app()
    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "mm3", "tts_provider": "minimax"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({"type": "tts_text", "session_id": "mm3", "text": "超时句。"}))
            saw_done = False
            audio_bytes = 0
            for _ in range(500):
                m = json.loads(ws.receive_text())
                if m["type"] == "tts_done":
                    saw_done = True
                    break
                elif m["type"] == "tts_audio_meta":
                    audio_bytes += len(ws.receive_bytes())
            assert saw_done and audio_bytes > 0  # 回退本地出音,本轮正常结束


def test_ws_minimax_disabled_falls_back_local_no_call(monkeypatch):
    """enabled=false(留着 key)→ 选了 minimax 的会话**直接用本地 OmniVoice**(零 MiniMax 调用),
    正常出音 + tts_done。关闭开关 = 全局急停回退本地,不漏句、不计费。"""
    from gpu_service import minimax_config as mc
    monkeypatch.setenv("AIM_MINIMAX_SECRET_ID", "")
    monkeypatch.delenv("AIM_MINIMAX_ENABLED", raising=False)  # enabled=false
    monkeypatch.setenv("AIM_MINIMAX_API_KEY", "sk-but-disabled")
    mc._reset_for_test()
    called = {"n": 0}
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: called.__setitem__("n", called["n"] + 1))

    app = create_app()
    with TestClient(app) as c:
        with c.websocket_connect("/v1/stream") as ws:
            ws.send_text(json.dumps({"type": "start", "session_id": "mm4", "tts_provider": "minimax"}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({"type": "tts_text", "session_id": "mm4", "text": "关闭后这句。"}))
            saw_done = False
            audio_bytes = 0
            for _ in range(500):
                m = json.loads(ws.receive_text())
                if m["type"] == "tts_done":
                    saw_done = True
                    break
                elif m["type"] == "tts_audio_meta":
                    audio_bytes += len(ws.receive_bytes())
            assert saw_done and audio_bytes > 0  # 本地出音
    assert called["n"] == 0  # enabled=false → 根本不调 MiniMax(make_tts 直接返回本地)
    mc._reset_for_test()


def test_ws_default_provider_unaffected_by_minimax(client):
    """6.3 回归:不带 tts_provider(缺省)→ 走默认后端(本测 stub),与 MiniMax 无关、链路不变。"""
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "session_id": "def1"}))  # 无 tts_provider
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "tts_text", "session_id": "def1", "text": "默认后端。"}))
        metas = done = 0
        for _ in range(500):
            m = json.loads(ws.receive_text())
            if m["type"] == "tts_audio_meta":
                metas += 1
                ws.receive_bytes()
            elif m["type"] == "tts_done":
                done = 1
                break
        assert metas > 0 and done  # 默认后端正常出音,不受 MiniMax 接入影响
