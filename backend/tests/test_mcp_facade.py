"""design contract MCP OAuth full facade —— 假 DCR + HMAC state 桥接(client 零配置不填 client_id)。

覆盖:
- 假 DCR `POST /register` 回预建 client_id + token_endpoint_auth_method:none + 回显 redirect_uris,无副作用。
- `GET /oauth/authorize` 302 到 Cognito Hosted UI(固定回调 + client_id=预建 + PKCE 透传 + state 藏 client loopback)。
- `GET /oauth/callback` 验 HMAC state → 302 回 client loopback(带 code + 原 state)。
- 篡改 state → 400 不重定向;过期 state → 400;非 loopback redirect_uri → 400。
- AS metadata 的 authorize/token/registration 指 facade。
- HMAC state sign/verify 单向时限(拒未来时间戳)。
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from app import mcp_oauth


def _nofollow(client):
    """TestClient 默认跟随重定向;facade 302 需关跟随以断言 Location。"""
    client.follow_redirects = False
    return client


# ── 假 DCR ──
def test_register_returns_prebuilt_client_id(client):
    r = client.post("/register", json={"redirect_uris": ["http://127.0.0.1:49732/oauth/callback"],
                                        "client_name": "mcp-remote"})
    assert r.status_code == 201
    body = r.json()
    assert body["client_id"] == "mcpclient0123456789"  # = conftest 预建 MCP client_id
    assert body["token_endpoint_auth_method"] == "none"
    assert body["redirect_uris"] == ["http://127.0.0.1:49732/oauth/callback"]  # 回显
    assert body["client_name"] == "mcp-remote"


def test_register_empty_body_ok(client):
    """空/无 redirect_uris 的注册也回预建 client_id(不同 client 空注册习惯)。"""
    r = client.post("/register", json={})
    assert r.status_code == 201
    assert r.json()["client_id"] == "mcpclient0123456789"


def test_register_no_side_effect_same_client_id(client):
    """并发/多次注册拿同一 client_id(无状态无副作用)。"""
    a = client.post("/register", json={}).json()["client_id"]
    b = client.post("/register", json={}).json()["client_id"]
    assert a == b == "mcpclient0123456789"


# ── authorize:302 到 Cognito,固定回调 + PKCE 透传 + state 藏 loopback ──
def test_authorize_redirects_to_cognito_with_facade_callback(client):
    _nofollow(client)
    r = client.get("/oauth/authorize", params={
        "redirect_uri": "http://127.0.0.1:49732/oauth/callback",
        "state": "client-orig-state",
        "response_type": "code",
        "code_challenge": "abc123challenge",
        "code_challenge_method": "S256",
        "scope": "openid aim/invoke",
    })
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://aim-aimtest-12345678.auth.")  # Hosted UI 域
    assert "/oauth2/authorize?" in loc
    qs = parse_qs(urlparse(loc).query)
    # redirect_uri 换成 facade 固定回调(非 client loopback)
    assert qs["redirect_uri"][0] == "https://test.cloudfront.net/oauth/callback"
    assert qs["client_id"][0] == "mcpclient0123456789"  # 预建 client_id
    assert qs["code_challenge"][0] == "abc123challenge"  # PKCE 透传
    assert qs["code_challenge_method"][0] == "S256"
    assert qs["scope"][0] == "openid aim/invoke"  # scope 透传(client 决定)
    # state 是 facade HMAC 签名(非 client 原 state);验签能取回 client loopback + 原 state
    signed = qs["state"][0]
    assert signed != "client-orig-state"
    payload = mcp_oauth.verify_state(signed, secret="test-facade-state-secret-0123456789", now_epoch=mcp_oauth_now())
    assert payload["uri"] == "http://127.0.0.1:49732/oauth/callback"
    assert payload["state"] == "client-orig-state"


def test_authorize_rejects_non_loopback_redirect(client):
    _nofollow(client)
    r = client.get("/oauth/authorize", params={
        "redirect_uri": "https://evil.example.com/steal",
        "state": "x", "response_type": "code",
    })
    assert r.status_code == 400  # open-redirect 防护:非 loopback 拒


# ── callback:验 state → 302 回 client loopback ──
def test_callback_verifies_state_and_redirects_to_loopback(client):
    signed = mcp_oauth.sign_state(
        redirect_uri="http://127.0.0.1:49732/oauth/callback",
        client_state="client-orig-state", nonce="n1", ts=mcp_oauth_now(),
        secret="test-facade-state-secret-0123456789",
    )
    _nofollow(client)
    r = client.get("/oauth/callback", params={"code": "cognito-auth-code", "state": signed})
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("http://127.0.0.1:49732/oauth/callback")  # 回 client loopback
    qs = parse_qs(urlparse(loc).query)
    assert qs["code"][0] == "cognito-auth-code"  # Cognito code 回传
    assert qs["state"][0] == "client-orig-state"  # client 原 state 还原


def test_callback_tampered_state_400_no_redirect(client):
    _nofollow(client)
    r = client.get("/oauth/callback", params={"code": "c", "state": "tampered.badsig"})
    assert r.status_code == 400
    assert "location" not in {k.lower(): v for k, v in r.headers.items()}  # 不重定向


def test_callback_expired_state_400(client):
    # ts 距今超过 max_age(900s)
    old_ts = mcp_oauth_now() - (mcp_oauth.STATE_MAX_AGE_S + 60)
    signed = mcp_oauth.sign_state(
        redirect_uri="http://127.0.0.1:49732/oauth/callback",
        client_state="s", nonce="n", ts=old_ts,
        secret="test-facade-state-secret-0123456789",
    )
    _nofollow(client)
    r = client.get("/oauth/callback", params={"code": "c", "state": signed})
    assert r.status_code == 400


def test_callback_passes_cognito_error_back_to_loopback(client):
    """Cognito 登录失败(如 access_denied)→ facade 按 state 把 error 回传给 client loopback(client 需知晓)。"""
    signed = mcp_oauth.sign_state(
        redirect_uri="http://127.0.0.1:49732/oauth/callback",
        client_state="cs", nonce="n", ts=mcp_oauth_now(),
        secret="test-facade-state-secret-0123456789",
    )
    _nofollow(client)
    r = client.get("/oauth/callback", params={
        "error": "access_denied", "error_description": "用户拒绝授权", "state": signed,
    })
    assert r.status_code == 302
    qs = parse_qs(urlparse(r.headers["location"]).query)
    assert qs["error"][0] == "access_denied"
    assert qs["error_description"][0] == "用户拒绝授权"
    assert qs["state"][0] == "cs"


def test_callback_second_layer_whitelist_rejects_leaked_key_malicious_uri(client):
    """纵深防御:即便攻击者用泄露密钥签出 payload.uri=恶意站,callback 二次白名单仍拒(400 不重定向)。"""
    # 用与服务端相同密钥签一个 payload.uri = 非 loopback(模拟密钥泄露 + 篡改 uri)
    evil = mcp_oauth.sign_state(
        redirect_uri="https://evil.example.com/steal",
        client_state="s", nonce="n", ts=mcp_oauth_now(),
        secret="test-facade-state-secret-0123456789",
    )
    _nofollow(client)
    r = client.get("/oauth/callback", params={"code": "c", "state": evil})
    assert r.status_code == 400  # 验签过但二次白名单拒(纵深防御)
    assert "location" not in {k.lower(): v for k, v in r.headers.items()}


def test_callback_replay_same_state_twice_both_succeed(client):
    """行为坐实(design contract §硬边界):HMAC state 不防重放——900s 内同一 signed state 两次 callback 都成功。
    真正一次性由下游 Cognito code+PKCE 兜底,facade 不做 nonce 去重。"""
    signed = mcp_oauth.sign_state(
        redirect_uri="http://127.0.0.1:49732/oauth/callback",
        client_state="cs", nonce="n", ts=mcp_oauth_now(),
        secret="test-facade-state-secret-0123456789",
    )
    _nofollow(client)
    r1 = client.get("/oauth/callback", params={"code": "code-A", "state": signed})
    r2 = client.get("/oauth/callback", params={"code": "code-B", "state": signed})
    assert r1.status_code == 302 and r2.status_code == 302  # 两次都通过(不防重放)


# ── token 转发:redirect_uri 强改回 facade 固定回调 ──
def test_token_forwards_to_cognito_with_facade_redirect(client, monkeypatch):
    """authorization_code grant:facade 把 redirect_uri 强改回固定回调,转发 Cognito,透传响应。"""
    captured = {}

    class _FakeResp:
        status_code = 200
        content = b'{"access_token":"AT","refresh_token":"RT","token_type":"Bearer"}'
        headers = {"content-type": "application/json"}

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, url, data=None, headers=None):
            captured["url"] = url
            captured["data"] = data
            return _FakeResp()

    monkeypatch.setattr("app.routers.mcp_facade.httpx.AsyncClient", _FakeAsyncClient)
    r = client.post(
        "/oauth/token",
        content="grant_type=authorization_code&code=auth-code&code_verifier=pkce-verifier"
                "&redirect_uri=http%3A%2F%2F127.0.0.1%3A49732%2Foauth%2Fcallback",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert r.status_code == 200
    assert r.json()["access_token"] == "AT"
    # 转发到 Cognito token 端点
    assert captured["url"].endswith("/oauth2/token")
    # redirect_uri 被强改回 facade 固定回调(否则 Cognito 拒)
    assert captured["data"]["redirect_uri"] == "https://test.cloudfront.net/oauth/callback"
    assert captured["data"]["client_id"] == "mcpclient0123456789"
    assert captured["data"]["code_verifier"] == "pkce-verifier"  # PKCE 透传


def test_token_refresh_grant_forwarded(client, monkeypatch):
    """refresh_token grant 透传(不强改 redirect_uri;续期)。"""
    captured = {}

    class _FakeResp:
        status_code = 200
        content = b'{"access_token":"AT2"}'
        headers = {"content-type": "application/json"}

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, url, data=None, headers=None):
            captured["data"] = data
            return _FakeResp()

    monkeypatch.setattr("app.routers.mcp_facade.httpx.AsyncClient", _FakeAsyncClient)
    r = client.post(
        "/oauth/token",
        content="grant_type=refresh_token&refresh_token=RT",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert r.status_code == 200
    assert captured["data"]["grant_type"] == "refresh_token"
    assert "redirect_uri" not in captured["data"]  # refresh 不强改 redirect_uri


def test_token_passes_through_cognito_error(client, monkeypatch):
    """Cognito 拒(如错误 code_verifier → 400 invalid_grant):facade 透传状态码 + 体,不吞不改。"""
    class _FakeResp:
        status_code = 400
        content = b'{"error":"invalid_grant"}'
        headers = {"content-type": "application/json"}

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, url, data=None, headers=None):
            return _FakeResp()

    monkeypatch.setattr("app.routers.mcp_facade.httpx.AsyncClient", _FakeAsyncClient)
    r = client.post("/oauth/token", content="grant_type=authorization_code&code=x&code_verifier=wrong",
                    headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 400  # 透传 Cognito 的 400(PKCE 校验在 Cognito,facade 不碰)
    assert r.json()["error"] == "invalid_grant"


def test_token_cognito_network_failure_502(client, monkeypatch):
    """转发 Cognito 网络失败(超时/连接错)→ facade 502(异常捕获路径)。"""
    import httpx as _httpx

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, url, data=None, headers=None):
            raise _httpx.TimeoutException("cognito timeout")

    monkeypatch.setattr("app.routers.mcp_facade.httpx.AsyncClient", _FakeAsyncClient)
    r = client.post("/oauth/token", content="grant_type=refresh_token&refresh_token=RT",
                    headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 502  # 转发失败明确 502,不 500 / 不泄露栈


# ── AS metadata 指 facade ──
def test_as_metadata_points_to_facade(client):
    r = client.get("/.well-known/oauth-authorization-server")
    assert r.status_code == 200
    m = r.json()
    assert m["authorization_endpoint"] == "https://test.cloudfront.net/oauth/authorize"
    assert m["token_endpoint"] == "https://test.cloudfront.net/oauth/token"
    assert m["registration_endpoint"] == "https://test.cloudfront.net/register"
    # jwks/revoke 仍指 Cognito(token 签发/吊销不经 facade)
    assert "cognito-idp." in m["jwks_uri"]
    assert m["revocation_endpoint"].endswith("/oauth2/revoke")
    # issuer 仍 = ALB 域(8414 §3.3 自洽)
    assert m["issuer"] == "https://test.cloudfront.net"


# ── HMAC state sign/verify 单向时限 ──
def test_state_sign_verify_roundtrip():
    secret = "s3cret-key"
    signed = mcp_oauth.sign_state(redirect_uri="http://localhost:8080/cb", client_state="st",
                                  nonce="nn", ts=1000, secret=secret)
    p = mcp_oauth.verify_state(signed, secret=secret, now_epoch=1000)
    assert p["uri"] == "http://localhost:8080/cb"
    assert p["state"] == "st"


def test_state_verify_rejects_future_ts():
    secret = "s3cret-key"
    # ts 在未来(now-ts < 0)→ 单向校验拒(不用 abs)
    signed = mcp_oauth.sign_state(redirect_uri="http://localhost:8080/cb", client_state="",
                                  nonce="n", ts=2000, secret=secret)
    with pytest.raises(mcp_oauth.OAuthConfigError):
        mcp_oauth.verify_state(signed, secret=secret, now_epoch=1000)  # now 早于 ts


def test_state_verify_rejects_wrong_secret():
    signed = mcp_oauth.sign_state(redirect_uri="http://localhost:8080/cb", client_state="",
                                  nonce="n", ts=1000, secret="key-a")
    with pytest.raises(mcp_oauth.OAuthConfigError):
        mcp_oauth.verify_state(signed, secret="key-b", now_epoch=1000)


def test_is_loopback_redirect():
    assert mcp_oauth.is_loopback_redirect("http://127.0.0.1:49732/oauth/callback")
    assert mcp_oauth.is_loopback_redirect("http://localhost:3334/oauth/callback")
    assert mcp_oauth.is_loopback_redirect("http://LOCALHOST:8080/cb")  # 大小写(urlparse hostname 小写化)
    assert not mcp_oauth.is_loopback_redirect("https://evil.example.com/cb")
    assert not mcp_oauth.is_loopback_redirect("")
    assert not mcp_oauth.is_loopback_redirect("ftp://127.0.0.1/x")


def test_is_loopback_redirect_rejects_open_redirect_tricks():
    """对抗性:open-redirect 白名单绕过(userinfo/子域/后缀混淆/scheme/protocol-relative)全拒。"""
    for bad in [
        "http://127.0.0.1@evil.com/cb",     # userinfo 混淆(@ 前非真 host)
        "http://localhost@evil.com/cb",
        "http://localhost.evil.com/cb",      # 子域混淆
        "http://127.0.0.1.evil.com/cb",      # 后缀混淆
        "http://0.0.0.0:8080/cb",
        "javascript:alert(1)",               # 非 http scheme
        "//evil.com/cb",                     # protocol-relative
        "http://[::1]:8080/cb",              # IPv6 loopback 当前不认(只认字面 127.0.0.1/localhost,保守)
    ]:
        assert not mcp_oauth.is_loopback_redirect(bad), f"应拒: {bad}"


def test_facade_state_secret_missing_fail_closed():
    """密钥缺失 → sign/verify 抛 OAuthConfigError(fail-closed,不静默签空)。"""
    with pytest.raises(mcp_oauth.OAuthConfigError):
        mcp_oauth.sign_state(redirect_uri="http://localhost/cb", client_state="", nonce="n", ts=1, secret="")


# 测试用 now(避免真实时钟依赖;facade 端点用 time.time,单元测 sign/verify 传固定值)。
def mcp_oauth_now() -> int:
    import time
    return int(time.time())
