"""声纹 embedding 原语 UT(design contract)—— stub embedder + /embedding 端点鉴权 + readiness 解耦。

不需 GPU/真实 CAM++ 权重(stub 后端);验证:
  - StubSpeakerEmbedder 维度 = SPEAKER_EMBEDDING_DIM、确定性、内容敏感、L2 归一
  - /embedding 鉴权 fail-closed(未配 secret→503;错 secret→401;对 secret→200)
  - 请求体校验(缺 pcm/坏 base64/非对齐/超大)
  - CAM++/embedder 不可用不拖垮 /readyz(readiness 解耦)
"""
from __future__ import annotations

import base64
import math
import struct

import pytest
from fastapi.testclient import TestClient

from gpu_service.engines import StubSpeakerEmbedder, make_speaker_embedder
from gpu_service.protocol import MAX_EMBED_PCM_BYTES, SPEAKER_EMBEDDING_DIM
from gpu_service.server import create_app


def _speech(ms: int, amp: int = 12000, freq: int = 220) -> bytes:
    n = 16000 * ms // 1000
    return b"".join(
        struct.pack("<h", int(amp * math.sin(2 * math.pi * freq * i / 16000)))
        for i in range(n)
    )


# ── StubSpeakerEmbedder 纯逻辑 ──

def test_stub_embedder_dim_and_deterministic():
    emb = StubSpeakerEmbedder()
    v1 = emb.embed(_speech(500))
    v2 = emb.embed(_speech(500))
    assert len(v1) == SPEAKER_EMBEDDING_DIM
    assert v1 == v2  # 确定性:同音频同向量


def test_stub_embedder_content_sensitive():
    emb = StubSpeakerEmbedder()
    a = emb.embed(_speech(500, freq=220))
    b = emb.embed(_speech(500, freq=660))
    assert a != b  # 内容不同 → 向量不同


def test_stub_embedder_l2_normalized():
    emb = StubSpeakerEmbedder()
    v = emb.embed(_speech(500))
    norm = math.sqrt(sum(x * x for x in v))
    assert abs(norm - 1.0) < 1e-6


def test_stub_embedder_empty_pcm_zero_vector():
    emb = StubSpeakerEmbedder()
    v = emb.embed(b"")
    assert len(v) == SPEAKER_EMBEDDING_DIM
    assert all(x == 0.0 for x in v)


def test_make_speaker_embedder_stub_backend(monkeypatch):
    monkeypatch.setenv("AIM_GPU_BACKEND", "stub")
    assert isinstance(make_speaker_embedder(), StubSpeakerEmbedder)


# ── /embedding 端点(鉴权 + 请求校验) ──

@pytest.fixture
def secret_client(monkeypatch):
    monkeypatch.setenv("AIM_GPU_BACKEND", "stub")
    monkeypatch.setenv("AIM_EMBEDDING_SECRET", "s3cr3t")
    app = create_app()
    with TestClient(app) as c:  # startup 触发 _load → 配了 secret 故加载 stub embedder
        yield c


def _b64_pcm(pcm: bytes) -> dict:
    return {"pcm_base64": base64.b64encode(pcm).decode(), "sample_rate": 16000}


def test_embedding_ok_with_secret(secret_client):
    r = secret_client.post("/embedding", headers={"X-Embedding-Secret": "s3cr3t"},
                           json=_b64_pcm(_speech(500)))
    assert r.status_code == 200
    body = r.json()
    assert body["dim"] == SPEAKER_EMBEDDING_DIM
    assert len(body["embedding"]) == SPEAKER_EMBEDDING_DIM
    assert body["frames"] == 16000 * 500 // 1000


def test_embedding_rejects_wrong_secret(secret_client):
    r = secret_client.post("/embedding", headers={"X-Embedding-Secret": "wrong"},
                           json=_b64_pcm(_speech(500)))
    assert r.status_code == 401


def test_embedding_rejects_missing_secret_header(secret_client):
    r = secret_client.post("/embedding", json=_b64_pcm(_speech(500)))
    assert r.status_code == 401


def test_embedding_disabled_without_env(monkeypatch):
    monkeypatch.setenv("AIM_GPU_BACKEND", "stub")
    monkeypatch.delenv("AIM_EMBEDDING_SECRET", raising=False)
    app = create_app()
    with TestClient(app) as c:
        # 未配 secret → 端点禁用(503),即便带任意头
        r = c.post("/embedding", headers={"X-Embedding-Secret": "x"}, json=_b64_pcm(_speech(500)))
        assert r.status_code == 503


def test_embedding_rejects_bad_base64(secret_client):
    r = secret_client.post("/embedding", headers={"X-Embedding-Secret": "s3cr3t"},
                           json={"pcm_base64": "!!!not base64!!!"})
    assert r.status_code == 400


def test_embedding_rejects_missing_pcm(secret_client):
    r = secret_client.post("/embedding", headers={"X-Embedding-Secret": "s3cr3t"}, json={})
    assert r.status_code == 400


def test_embedding_rejects_odd_length(secret_client):
    # 奇数字节 = 非 s16le 对齐
    r = secret_client.post("/embedding", headers={"X-Embedding-Secret": "s3cr3t"},
                           json={"pcm_base64": base64.b64encode(b"\x00\x00\x00").decode()})
    assert r.status_code == 400


def test_embedding_rejects_oversize(secret_client):
    big = b"\x00\x00" * (MAX_EMBED_PCM_BYTES // 2 + 100)
    r = secret_client.post("/embedding", headers={"X-Embedding-Secret": "s3cr3t"},
                           json={"pcm_base64": base64.b64encode(big).decode()})
    assert r.status_code == 413


def test_embedding_rejects_short_window(secret_client):
    # review:短音频(< 400ms 最小时长门)→ 400,bridge 据此 UNCERTAIN fail-open(不下 NONTARGET)。
    r = secret_client.post("/embedding", headers={"X-Embedding-Secret": "s3cr3t"},
                           json=_b64_pcm(_speech(200)))
    assert r.status_code == 400


def test_embedding_rejects_wrong_sample_rate(secret_client):
    # Minor 1:非 16000 采样率 → 400(防误当 16k 算错 embedding)。
    r = secret_client.post("/embedding", headers={"X-Embedding-Secret": "s3cr3t"},
                           json={"pcm_base64": base64.b64encode(_speech(500)).decode(), "sample_rate": 8000})
    assert r.status_code == 400


def test_embedding_response_has_duration_ms(secret_client):
    # Minor 1:成功响应含 duration_ms(供 bridge/真机观测 embedding 耗时)。
    r = secret_client.post("/embedding", headers={"X-Embedding-Secret": "s3cr3t"},
                           json=_b64_pcm(_speech(500)))
    assert r.status_code == 200
    assert "duration_ms" in r.json()


# ── readiness 解耦:embedder 不可用(未配 secret 不加载)时 /readyz 仍 ready ──

def test_readyz_ready_when_embedder_disabled(monkeypatch):
    monkeypatch.setenv("AIM_GPU_BACKEND", "stub")
    monkeypatch.delenv("AIM_EMBEDDING_SECRET", raising=False)
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/readyz")
        assert r.status_code == 200
        assert r.json()["status"] == "ready"
        # embedder 未加载(未配 secret),但核心 ASR/TTS readiness 不受影响
        assert app.state.speaker_embedder is None


def test_readyz_ready_and_embedder_loaded_when_secret_set(secret_client):
    # 配了 secret:embedder 加载成功 + readyz 仍 ready(两者都 OK,证明加载路径也不破坏 readiness)
    r = secret_client.get("/readyz")
    assert r.status_code == 200
    assert secret_client.app.state.speaker_embedder is not None


def test_readyz_ready_even_if_embedder_load_fails(monkeypatch):
    """embedder 加载抛错(模拟 CAM++ 权重缺失)→ /readyz 仍 ready(声纹门 fail-open,核心 ASR/TTS 不倒)。"""
    monkeypatch.setenv("AIM_GPU_BACKEND", "stub")
    monkeypatch.setenv("AIM_EMBEDDING_SECRET", "s3cr3t")

    import gpu_service.server as server_mod

    def _boom() -> None:
        raise RuntimeError("模拟 CAM++ 权重缺失")

    monkeypatch.setattr(server_mod, "make_speaker_embedder", _boom)
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/readyz")
        assert r.status_code == 200  # 核心 readiness 不受声纹模型加载失败影响
        assert app.state.speaker_embedder is None
        # 且此时 /embedding 因 embedder=None 返 503(bridge fail-open);用 ≥ 最小时长音频越过短窗门直达 embedder 判定
        r2 = c.post("/embedding", headers={"X-Embedding-Secret": "s3cr3t"},
                    json=_b64_pcm(_speech(500)))
        assert r2.status_code == 503
