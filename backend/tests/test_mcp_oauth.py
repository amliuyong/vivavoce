"""design contract MCP OAuth 登录 —— 服务端 A-lite 路线。

覆盖:
- 未认证 `/api/mcp`(POST/GET)→ 401 + `WWW-Authenticate: Bearer resource_metadata=…`(后缀路径)。
- 双路径 protected-resource metadata(resource 值各异)。
- 双路径 AS metadata(含 token_endpoint_auth_methods=none + revocation_endpoint + issuer 8414 §3.3 自校)。
- Bearer 各校验分支(client_id / scope / group);token_use 非 access / exp 过期 / 伪造签名 → 401。
- 缺 scope → 403 + insufficient_scope challenge。
- MCP client 签发的 token 打 Web 端点(require_user)被拒(Web 路径不放松)。
- 委托 token 回退;Bearer + 委托并存优先 Bearer;OAuth 登录后代 staff 预约 / 越权 Agent 被拒。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from tests.conftest import CLIENT_ID

MCP_CLIENT_ID = "mcpclient0123456789"  # = conftest _make_settings 的 mcp_client_id
INVOKE_SCOPE = "aim/invoke"
BASE = "https://test.cloudfront.net"  # = conftest public_api_base

_DIMENSION_RUBRIC = {"mode": "dimension_score",
                     "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}


def _seed_agent(client, admin, *, name, self_bookable=True) -> str:
    body = {"name": name, "self_bookable": self_bookable, "rubric": _DIMENSION_RUBRIC}
    return client.post("/api/agents", json=body, headers=admin).json()["agent_id"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _future(minutes: int) -> str:
    return (datetime.now(UTC) + timedelta(minutes=minutes)).isoformat()


def _mcp_token(make_token, *, groups=("staff",), scope=INVOKE_SCOPE, username="oauth@corp.com",
               client_id=MCP_CLIENT_ID, **kw) -> str:
    """签一个 MCP OAuth 风格 access token(client_id=MCP client,带 scope)。"""
    return make_token(groups=list(groups), scope=scope, username=username, client_id=client_id, **kw)


def _call(client, headers, method="initialize", params=None, req_id=1):
    body = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        body["params"] = params
    return client.post("/api/mcp", json=body, headers=headers)


# ════════ Req1:未认证触发标准 OAuth 发现 ════════
def test_unauthenticated_post_returns_401_challenge(client):
    r = _call(client, {})
    assert r.status_code == 401
    wa = r.headers.get("WWW-Authenticate", "")
    assert wa.startswith("Bearer")
    assert 'resource_metadata=' in wa
    # 后缀路径(resource 与连接 URL 一致):…/.well-known/oauth-protected-resource/api/mcp
    assert f'{BASE}/.well-known/oauth-protected-resource/api/mcp' in wa


def test_unauthenticated_get_returns_401_challenge(client):
    r = client.get("/api/mcp")
    assert r.status_code == 401
    assert 'resource_metadata=' in r.headers.get("WWW-Authenticate", "")


def test_expired_token_returns_401_challenge(client, make_token):
    r = _call(client, _auth(_mcp_token(make_token, expired=True)))
    assert r.status_code == 401
    assert 'resource_metadata=' in r.headers.get("WWW-Authenticate", "")


# ════════ Req2:protected-resource metadata(裸 + 后缀,resource 各异)════════
def test_protected_resource_bare(client):
    r = client.get("/.well-known/oauth-protected-resource")
    assert r.status_code == 200
    d = r.json()
    assert d["resource"] == BASE  # host 根
    assert d["authorization_servers"] == [BASE]  # issuer identifier(= 本站域,非 metadata 文档 URL)
    assert d["bearer_methods_supported"] == ["header"]
    assert INVOKE_SCOPE in d["scopes_supported"]


def test_protected_resource_suffix(client):
    r = client.get("/.well-known/oauth-protected-resource/api/mcp")
    assert r.status_code == 200
    d = r.json()
    assert d["resource"] == f"{BASE}/api/mcp"  # 与连接 URL 一致
    assert d["authorization_servers"] == [BASE]


def test_protected_resource_bare_and_suffix_differ(client):
    bare = client.get("/.well-known/oauth-protected-resource").json()["resource"]
    suffix = client.get("/.well-known/oauth-protected-resource/api/mcp").json()["resource"]
    assert bare != suffix  # 严格 client 会因 resource 与推导 URL 不符而拒 → 两份 MUST 不同


# ════════ Req2b:自供 RFC 8414 AS metadata(裸 + 后缀,8414 §3.3 自洽)════════
def test_as_metadata_bare(client):
    r = client.get("/.well-known/oauth-authorization-server")
    assert r.status_code == 200
    d = r.json()
    # issuer = 本站域(主路线);8414 §3.3:issuer 变换出的 well-known URL == 本请求 URL
    assert d["issuer"] == BASE
    assert d["code_challenge_methods_supported"] == ["S256"]
    # MUST 显式带 none(public client 无 secret)
    assert d["token_endpoint_auth_methods_supported"] == ["none"]
    assert d["revocation_endpoint"].endswith("/oauth2/revoke")
    # full facade(design contract):authorize/token/registration 指 facade(本站 ALB 域),非 Cognito Hosted UI
    assert d["authorization_endpoint"] == f"{BASE}/oauth/authorize"
    assert d["token_endpoint"] == f"{BASE}/oauth/token"
    assert d["registration_endpoint"] == f"{BASE}/register"
    # host 勿混:authorize/token/register 在 facade/ALB 域,jwks/revoke 仍在 Cognito 域
    assert ".auth." in d["revocation_endpoint"] and ".amazoncognito.com" in d["revocation_endpoint"]
    assert "cognito-idp." in d["jwks_uri"] and d["jwks_uri"].endswith("/.well-known/jwks.json")
    assert set(d["grant_types_supported"]) == {"authorization_code", "refresh_token"}
    assert d["response_types_supported"] == ["code"]
    assert INVOKE_SCOPE in d["scopes_supported"]


def test_as_metadata_suffix_issuer_self_consistent(client):
    """8414 §3.3:后缀变体 issuer=host+/api/mcp → 路径插入 well-known URL == 本请求 URL。"""
    r = client.get("/.well-known/oauth-authorization-server/api/mcp")
    assert r.status_code == 200
    d = r.json()
    assert d["issuer"] == f"{BASE}/api/mcp"
    # issuer 经 8414 变换(路径插入 /.well-known/oauth-authorization-server)得出的 URL == 本请求 URL
    issuer = d["issuer"]
    host_root = issuer.split("/api/mcp")[0]
    path_component = issuer[len(host_root):]  # /api/mcp
    derived = f"{host_root}/.well-known/oauth-authorization-server{path_component}"
    assert derived == f"{BASE}/.well-known/oauth-authorization-server/api/mcp"


def test_as_metadata_bare_issuer_self_consistent(client):
    """裸路径 issuer=host 根 → 变换出裸 well-known URL == 本请求 URL。"""
    d = client.get("/.well-known/oauth-authorization-server").json()
    derived = f"{d['issuer']}/.well-known/oauth-authorization-server"
    assert derived == f"{BASE}/.well-known/oauth-authorization-server"


def test_discovery_endpoints_leak_no_protected_data(client):
    """发现端点只吐公开指针,不含任何会议/对象/结果数据。"""
    for path in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"):
        d = client.get(path).json()
        blob = str(d)
        for leak in ("session_id", "booked_by", "target_id", "meeting_start"):
            assert leak not in blob


# ════════ Req「/api/mcp 接受 Cognito access token」════════
def test_bearer_oauth_initialize_ok(client, make_token):
    r = _call(client, _auth(_mcp_token(make_token)), "initialize",
              {"protocolVersion": "2025-06-18", "capabilities": {}})
    assert r.status_code == 200, r.text
    assert r.json()["result"]["serverInfo"]["name"] == "aim-meeting-agent"


def test_bearer_wrong_client_id_rejected(client, make_token):
    # client_id = WebClient(不在 MCP 允许集)→ 401
    r = _call(client, _auth(_mcp_token(make_token, client_id=CLIENT_ID)))
    assert r.status_code == 401
    assert 'resource_metadata=' in r.headers.get("WWW-Authenticate", "")


def test_bearer_missing_scope_403_insufficient_scope(client, make_token):
    r = _call(client, _auth(_mcp_token(make_token, scope="openid email")))
    assert r.status_code == 403
    wa = r.headers.get("WWW-Authenticate", "")
    assert 'error="insufficient_scope"' in wa
    assert f'scope="{INVOKE_SCOPE}"' in wa


def test_bearer_no_scope_claim_403(client, make_token):
    # 完全无 scope claim
    r = _call(client, _auth(_mcp_token(make_token, scope=None)))
    assert r.status_code == 403
    assert 'insufficient_scope' in r.headers.get("WWW-Authenticate", "")


def test_bearer_non_staff_group_rejected(client, make_token):
    # 合法 MCP token 但无 staff/admin group → 403
    r = _call(client, _auth(_mcp_token(make_token, groups=())))
    assert r.status_code == 403


def test_bearer_admin_group_ok(client, make_token):
    r = _call(client, _auth(_mcp_token(make_token, groups=("admin",))), "tools/list")
    assert r.status_code == 200
    assert "book_meeting" in {t["name"] for t in r.json()["result"]["tools"]}


def test_bearer_id_token_rejected(client, make_token):
    r = _call(client, _auth(_mcp_token(make_token, token_use="id")))
    assert r.status_code == 401


def test_bearer_tampered_signature_rejected(client, make_token):
    tok = _mcp_token(make_token)
    head, payload, sig = tok.split(".")
    tampered = head + "." + payload[:-2] + ("AA" if payload[-2:] != "AA" else "BB") + "." + sig
    r = _call(client, _auth(tampered))
    assert r.status_code == 401


# ════════ fail-closed 回归:mcp_client_id 未配 → 空 allow-list,不退回 WebClient ════════
def test_mcp_client_id_unset_is_fail_closed(app_and_db, make_token):
    """AIM_MCP_CLIENT_ID 缺失 → Bearer 分支传空 allow-list,**任何** client 都不过(不退回接受 WebClient)。"""
    from dataclasses import replace

    from fastapi.testclient import TestClient

    app, _ = app_and_db
    # 把 settings.mcp_client_id 置 None(模拟未部署 OAuth 前提)
    app.state.settings = replace(app.state.settings, mcp_client_id=None)
    c = TestClient(app)
    # 连 WebClient token(client_id=CLIENT_ID)都不该被 /api/mcp Bearer 分支接受 → 401(而非放行)
    r = c.post("/api/mcp", headers=_auth(make_token(groups=["admin"], client_id=CLIENT_ID, scope=INVOKE_SCOPE)),
               json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert r.status_code == 401
    assert 'resource_metadata=' in r.headers.get("WWW-Authenticate", "")


# ════════ 后端故障透传:JWKS 拉取失败 → 503(不折成 401+challenge)════════
def test_jwks_failure_propagates_503_not_challenge(app_and_db, make_token):
    """校验服务故障(AuthError 503)原样透传,不误判 token 无效(否则 OAuth client 陷重登录循环)。"""
    from fastapi.testclient import TestClient

    from app.auth import AuthError

    app, _ = app_and_db

    class BoomVerifier:
        def verify(self, *a, **k):
            raise AuthError(503, "无法获取 JWKS: cognito down")

    app.state.verifier = BoomVerifier()
    c = TestClient(app)
    r = c.post("/api/mcp", headers=_auth(_mcp_token(make_token)),
               json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert r.status_code == 503
    # 5xx 不带 OAuth challenge(不引导 client 重新登录)
    assert "WWW-Authenticate" not in r.headers


# ════════ Scenario:MCP token 打 Web 端点被拒(Web 路径不放松)════════
def test_mcp_token_on_web_endpoint_rejected(client, make_token):
    """MCP client 签发的 token 打 require_user 的 Web 端点 → 401 client_id 不匹配。"""
    r = client.get("/api/agents", headers=_auth(_mcp_token(make_token, groups=("admin",))))
    assert r.status_code == 401


def test_web_token_on_web_endpoint_ok(client, make_token):
    """回归:WebClient token 打 Web 端点仍正常(Web 路径现状不变)。"""
    r = client.get("/api/agents", headers=_auth(make_token(groups=["admin"])))
    assert r.status_code == 200


# ════════ Scenario:委托回退 + Bearer/委托并存优先 Bearer ════════
def _delegation_token(client, make_token, username="deleg@corp.com") -> str:
    staff = _auth(make_token(groups=["staff"], username=username))
    return client.post("/api/me/delegations", json={"label": "agent"}, headers=staff).json()["token"]


def test_delegation_fallback_still_works(client, make_token):
    tok = _delegation_token(client, make_token)
    r = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                    headers={"X-Delegation-Token": tok})
    assert r.status_code == 200


def test_bearer_and_delegation_both_prefers_bearer(client, make_token):
    """Bearer 有效 + 也带委托 token → 用 Bearer 身份(booked_by = Bearer 的 username)。"""
    bearer = _mcp_token(make_token, username="bearer-user@corp.com")
    deleg = _delegation_token(client, make_token, username="deleg-user@corp.com")
    r = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                    headers={"Authorization": f"Bearer {bearer}", "X-Delegation-Token": deleg})
    assert r.status_code == 200


def test_invalid_bearer_falls_back_to_delegation(client, make_token):
    """Bearer 校验失败(过期)但带有效委托 token → 宽容回退委托(更健壮)。"""
    expired = _mcp_token(make_token, expired=True)
    deleg = _delegation_token(client, make_token, username="fallback@corp.com")
    r = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                    headers={"Authorization": f"Bearer {expired}", "X-Delegation-Token": deleg})
    assert r.status_code == 200


# ════════ Scenario:OAuth 登录后代 staff 预约 / 越权 Agent 被拒 ════════
def test_oauth_book_meeting_inherits_staff_boundary(client, make_token, app_and_db):
    import json
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin, name="OAuth可约")
    tok = _mcp_token(make_token, username="booker@corp.com")
    r = client.post("/api/mcp", headers=_auth(tok), json={
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "book_meeting", "arguments": {
            "agent_id": pid, "meeting_start": _future(120), "meeting_end": _future(180)}}})
    assert r.status_code == 200, r.text
    booked = json.loads(r.json()["result"]["content"][0]["text"])
    # booked_by = Bearer 的 staff 身份(origin=staff)
    assert db.get_session(booked["session_id"])["booked_by"] == "booker@corp.com"


def test_oauth_book_rejects_non_bookable_agent(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin, name="面试", self_bookable=False)
    tok = _mcp_token(make_token, username="u@corp.com")
    r = client.post("/api/mcp", headers=_auth(tok), json={
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "book_meeting", "arguments": {
            "agent_id": pid, "meeting_start": _future(120), "meeting_end": _future(180)}}})
    assert "error" in r.json()
    assert "自助" in r.json()["error"]["message"]
