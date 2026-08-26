"""design contract review:发起指令里的明文 mantle token 绝不落 DDB / 回执文本。"""
from __future__ import annotations

from app.session_service import HttpDispatcher, RecordingDispatcher, _redact_command, _redact_token


def test_redact_command_removes_token():
    cmd = {
        "session_id": "s1",
        "llm_model_id": "zai.glm-4.7-flash",
        "llm_bearer_token": "ABSKsecret1234",
        "llm_bedrock_api_key": "ABSKbedrock5678",
        "llm_mantle_host": "https://h",
    }
    red = _redact_command(cmd)
    assert red["llm_bearer_token"] == "***redacted***"
    assert red["llm_bedrock_api_key"] == "***redacted***"
    assert "ABSKsecret1234" not in str(red)
    assert "ABSKbedrock5678" not in str(red)
    # 非密字段保留
    assert red["llm_model_id"] == "zai.glm-4.7-flash"
    assert red["llm_mantle_host"] == "https://h"
    # 原 dict 不被就地改(就绪指令仍带真 token 发实时服务)
    assert cmd["llm_bearer_token"] == "ABSKsecret1234"
    assert cmd["llm_bedrock_api_key"] == "ABSKbedrock5678"


def test_redact_command_noop_without_token():
    cmd = {"session_id": "s1", "llm_model_id": "x.y"}
    assert _redact_command(cmd) is cmd  # 无 token 原样返回


def test_redact_token_scrubs_secret_shapes():
    assert "ABSK" not in _redact_token("boom ABSKabcdefgh1234 tail")
    assert "sk-" not in _redact_token("err sk-abcdefgh1234")
    assert _redact_token("plain 502 error") == "plain 502 error"
    assert _redact_token("") == ""


class _FakeDb:
    def __init__(self):
        self.meta_calls = []

    def get_session_meta(self, session_id):
        return {"status": "scheduled"}

    def merge_session_meta(self, session_id, extra):
        # dispatch 留痕改走 merge(不改 status,review);status 槽位留 None 兼容断言解包
        self.meta_calls.append((session_id, None, extra))


def test_dispatch_never_persists_token_to_ddb(monkeypatch):
    """HttpDispatcher.dispatch 落 DDB 的 last_dispatch MUST 脱敏 token。"""
    db = _FakeDb()
    disp = HttpDispatcher(db, "http://bridge.local:3001")
    # 让 _post 不真发网络:返回 (True, "202")
    monkeypatch.setattr(disp, "_post", lambda path, body: (True, "202"))
    cmd = {
        "session_id": "s1",
        "llm_bearer_token": "ABSKtopsecret9999",
        "llm_bedrock_api_key": "ABSKbedrock9999",
    }
    disp.dispatch(cmd)
    assert db.meta_calls, "should have written meta"
    _, _, extra = db.meta_calls[0]
    persisted = str(extra)
    assert "ABSKtopsecret9999" not in persisted  # 明文 token 绝不落 DDB
    assert "ABSKbedrock9999" not in persisted
    assert extra["last_dispatch"]["llm_bearer_token"] == "***redacted***"
    assert extra["last_dispatch"]["llm_bedrock_api_key"] == "***redacted***"

def test_recording_dispatcher_redacts_token(monkeypatch):
    """RecordingDispatcher.dispatch 落 DDB 的 last_dispatch 也 MUST 脱敏(review:此前漏脱敏,
    配了 LLM 但缺 AIM_BRIDGE_DIAL_URL 退回本 dispatcher 时明文 token 入库)。"""
    db = _FakeDb()
    RecordingDispatcher(db).dispatch(
        {
            "session_id": "s1",
            "llm_bearer_token": "ABSKtopsecret9999",
            "llm_bedrock_api_key": "ABSKbedrock9999",
            "llm_model_id": "zai.glm-4.7-flash",
        })
    assert db.meta_calls
    _, _, extra = db.meta_calls[0]
    assert "ABSKtopsecret9999" not in str(extra)
    assert "ABSKbedrock9999" not in str(extra)
    assert extra["last_dispatch"]["llm_bearer_token"] == "***redacted***"
    assert extra["last_dispatch"]["llm_bedrock_api_key"] == "***redacted***"
    assert extra["last_dispatch"]["llm_model_id"] == "zai.glm-4.7-flash"  # 非密字段保留
