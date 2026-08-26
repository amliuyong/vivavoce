"""017 纯逻辑单元测试:API Key 生成/解析/校验、Webhook HMAC 签名/投递重试。"""
from __future__ import annotations

from app import api_key as ak
from app import webhook as wh


# ── API Key ──
def test_generate_and_verify():
    full, secret_hash = ak.generate_key("client123")
    assert full.startswith("aimk_client123_")
    parsed = ak.parse_key(full)
    assert parsed is not None
    cid, raw = parsed
    assert cid == "client123"
    assert ak.verify_secret(raw, secret_hash) is True


def test_verify_wrong_secret():
    _full, secret_hash = ak.generate_key("c1")
    assert ak.verify_secret("wrong-secret", secret_hash) is False


def test_parse_malformed():
    for bad in ["", "nope", "aimk_", "aimk_only", "xxx_c_s"]:
        assert ak.parse_key(bad) is None


def test_parse_secret_with_underscores():
    # token_urlsafe 可能含 '_';partition 只切第一个 '_' 后全归 secret
    full, secret_hash = ak.generate_key("abc")
    cid, raw = ak.parse_key(full)
    assert cid == "abc"
    assert ak.verify_secret(raw, secret_hash)


# ── Webhook 签名 ──
def test_sign_deterministic():
    body = b'{"a":1}'
    s1 = wh.sign_payload(body, "secret")
    s2 = wh.sign_payload(body, "secret")
    assert s1 == s2 and s1.startswith("sha256=")


def test_sign_differs_by_secret():
    body = b'{"a":1}'
    assert wh.sign_payload(body, "s1") != wh.sign_payload(body, "s2")


def test_canonical_body_stable():
    # 键序无关
    b1 = wh.canonical_body({"b": 2, "a": 1})
    b2 = wh.canonical_body({"a": 1, "b": 2})
    assert b1 == b2


def test_build_event_shape():
    ev = wh.build_event(event_id="e1", event_type="session.completed", ts="2026-01-01T00:00:00Z",
                        data={"session_id": "s1"})
    assert ev["event_id"] == "e1" and ev["type"] == "session.completed"
    assert ev["data"]["session_id"] == "s1"


# ── Webhook 投递重试(注入 httpx + sleep) ──
def test_deliver_success(monkeypatch):
    calls = {"n": 0}

    class _Resp:
        status_code = 200

    def fake_post(url, content=None, headers=None, timeout=None):
        calls["n"] += 1
        return _Resp()

    import httpx
    monkeypatch.setattr(httpx, "post", fake_post)
    ev = wh.build_event(event_id="e1", event_type="result.ready", ts="t", data={})
    ok, attempts, _ = wh.deliver("https://x.test/hook", ev, "sec", sleep=lambda s: None)
    assert ok is True and attempts == 1 and calls["n"] == 1


def test_deliver_blocks_dns_rebinding(monkeypatch):
    """design contract review:投递时若域名解析到内网/元数据 IP(DNS rebinding)→ 拦截,不发 HTTP。"""
    calls = {"n": 0}

    def boom(url, content=None, headers=None, timeout=None):  # 不应被调用
        calls["n"] += 1
        raise AssertionError("不该投递到 rebinding 地址")

    import httpx
    monkeypatch.setattr(httpx, "post", boom)
    # 解析到内网 169.254.169.254(元数据)
    monkeypatch.setattr(wh, "_resolved_ips_are_safe", lambda host: (False, "解析到 169.254.169.254"))
    ev = wh.build_event(event_id="e1", event_type="result.ready", ts="t", data={})
    ok, attempts, detail = wh.deliver("https://evil.test/hook", ev, "sec", sleep=lambda s: None)
    assert ok is False and calls["n"] == 0 and "SSRF" in detail


def test_deliver_retries_then_fails(monkeypatch):
    calls = {"n": 0}

    def boom(url, content=None, headers=None, timeout=None):
        calls["n"] += 1
        raise RuntimeError("unreachable")

    import httpx
    monkeypatch.setattr(httpx, "post", boom)
    ev = wh.build_event(event_id="e1", event_type="result.ready", ts="t", data={})
    ok, attempts, detail = wh.deliver("https://x.test/hook", ev, "sec", max_attempts=3, sleep=lambda s: None)
    assert ok is False and attempts == 3 and calls["n"] == 3


def test_deliver_recovers_on_retry(monkeypatch):
    calls = {"n": 0}

    class _Resp:
        def __init__(self, code):
            self.status_code = code

    def flaky(url, content=None, headers=None, timeout=None):
        calls["n"] += 1
        return _Resp(500 if calls["n"] < 2 else 200)

    import httpx
    monkeypatch.setattr(httpx, "post", flaky)
    ev = wh.build_event(event_id="e1", event_type="session.failed", ts="t", data={})
    ok, attempts, _ = wh.deliver("https://x.test/hook", ev, "sec", sleep=lambda s: None)
    assert ok is True and attempts == 2
