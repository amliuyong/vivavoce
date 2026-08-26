"""017 e2e —— API Key(admin 下发系统集成)+ 委托 token(staff 授权 agent)全栈。

覆盖 design contract:admin 管 client、API Key + scope 授权、程序化发起复用 005、幂等、
资源隔离(只见自己创建)、webhook 注册、staff 自助委托 agent 代预约/查询。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _future(minutes: int) -> str:
    return (datetime.now(UTC) + timedelta(minutes=minutes)).isoformat()


# dimension_score rubric:纯人设(无题)Agent 也可发起/预约(per_question_check 无题会 422,design contract)
_DIMENSION_RUBRIC = {"mode": "dimension_score",
                     "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}


def _seed_agent(client, admin, self_bookable=True) -> str:
    return client.post("/api/agents",
                       json={"name": "集成Agent", "self_bookable": self_bookable,
                             "rubric": _DIMENSION_RUBRIC},
                       headers=admin).json()["agent_id"]


def _create_client(client, admin, scopes) -> dict:
    r = client.post("/api/integration/clients", json={"name": "ATS集成", "scopes": scopes}, headers=admin)
    assert r.status_code == 201, r.text
    return r.json()


# ── admin 管理 API client ──
def test_admin_creates_client_returns_key_once(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    c = _create_client(client, admin, ["sessions:write"])
    assert c["api_key"].startswith("aimk_")
    assert c["scopes"] == ["sessions:write"]
    # 列表不回显 secret/key
    lst = client.get("/api/integration/clients", headers=admin).json()
    assert all("secret_hash" not in x and not x.get("api_key") for x in lst)


def test_api_key_principal_carries_created_by(client, make_token, app_and_db):
    """API key 鉴权出的 Principal 带 created_by = 签发该 key 的 admin(审计追溯)。"""
    from types import SimpleNamespace

    from app.deps import authenticate_api_key

    app, _ = app_and_db
    admin = _auth(make_token(groups=["admin"], username="admin@corp.com"))
    key = _create_client(client, admin, ["sessions:read"])["api_key"]
    # 直接走鉴权(造最小 request 替身,只需 .app.state)
    req = SimpleNamespace(app=app)
    principal = authenticate_api_key(req, key)
    assert principal.is_machine is True
    assert principal.created_by == "admin@corp.com"  # = 创建该 client 的 admin username


def test_client_mgmt_admin_only(client, make_token):
    staff = _auth(make_token(groups=["staff"], username="s@corp.com"))
    assert client.post("/api/integration/clients", json={"name": "x", "scopes": []}, headers=staff).status_code == 403
    assert client.get("/api/integration/clients", headers=staff).status_code == 403


def test_client_visibility_per_admin(client, make_token):
    """每个 admin 只看/管自己创建的 API key(归属隔离 created_by)。"""
    adminA = _auth(make_token(groups=["admin"], username="a@corp.com"))
    adminB = _auth(make_token(groups=["admin"], username="b@corp.com"))
    cidA = _create_client(client, adminA, ["sessions:read"])["client_id"]
    cidB = _create_client(client, adminB, ["sessions:read"])["client_id"]
    # A 的列表只含 A 创建的(看不到 B 的)
    listA = client.get("/api/integration/clients", headers=adminA).json()
    idsA = {c["client_id"] for c in listA}
    assert cidA in idsA and cidB not in idsA
    # B 的列表只含 B 的
    idsB = {c["client_id"] for c in client.get("/api/integration/clients", headers=adminB).json()}
    assert cidB in idsB and cidA not in idsB
    # B 吊销 A 的 key → 404(不泄露存在性);且 A 的 key 仍在
    assert client.delete(f"/api/integration/clients/{cidA}", headers=adminB).status_code == 404
    assert cidA in {c["client_id"] for c in client.get("/api/integration/clients", headers=adminA).json()}
    # A 吊销自己的 → 204
    assert client.delete(f"/api/integration/clients/{cidA}", headers=adminA).status_code == 204


def test_invalid_scope_rejected(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    assert client.post("/api/integration/clients",
                       json={"name": "x", "scopes": ["bogus:scope"]}, headers=admin).status_code == 422


# ── API Key 鉴权 + scope ──
def test_api_key_launch_session(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write", "sessions:read"])["api_key"]
    # 新语义:API 发起 = 预创建即就绪,落 scheduled(考生连入后 connected 事件推进)
    r = client.post("/api/integration/sessions",
                    headers={"X-Api-Key": key},
                    json={"agent_id": pid,
                          "meeting_start": _future(-1), "meeting_end": _future(60)})
    assert r.status_code == 201, r.text
    assert r.json()["origin"] == "api" and r.json()["status"] == "scheduled"


def test_api_per_client_rate_limit_429(client, make_token, app_and_db):
    """design contract:同一 client 超 per-client 限流 → 429(防单方刷爆)。把桶调小便于触发。"""
    from app.rate_limit import TokenBucketLimiter

    app, _ = app_and_db
    # 收紧到 burst=3、不回填(rate=0):前 3 个鉴权请求放行,第 4 个 429
    app.state.api_rate_limiter = TokenBucketLimiter(rate=0.0, burst=3, now=lambda: 0.0)
    admin = _auth(make_token(groups=["admin"]))
    key = _create_client(client, admin, ["sessions:read"])["api_key"]
    # 限流在 require_api_client 依赖层(handler 之前)生效;用 /sessions/{id}(资源隔离下返 404,
    # 但鉴权+限流先于 handler 跑)即可触发。前 3 个过限流(404),第 4+ 个 429。
    resps = [client.get("/api/integration/sessions/nope", headers={"X-Api-Key": key})
             for _ in range(5)]
    codes = [r.status_code for r in resps]
    # burst=3 精确语义(review):前 3 个恰好全过限流(到 handler 返 404),不是"≤3 个不被限"的宽松断言
    assert codes[:3] == [404, 404, 404]  # 前 3 个用尽 burst,过限流到 handler(资源隔离 → 404)
    assert codes[3:] == [429, 429]  # 桶空(rate=0 不回填)后续全限
    # Retry-After 头(review):429 必须带退避秒数(机器集成方据此退避,免风暴重试)
    assert resps[3].headers.get("Retry-After") is not None
    # 复位,避免污染后续测试
    app.state.api_rate_limiter = TokenBucketLimiter()


def test_api_no_key_401(client):
    assert client.post("/api/integration/sessions", json={}).status_code == 401


def test_api_bad_key_401(client):
    assert client.post("/api/integration/sessions", headers={"X-Api-Key": "aimk_x_y"},
                       json={}).status_code == 401


def test_scope_enforced(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    # 只有 results:read,没有 sessions:write
    key = _create_client(client, admin, ["results:read"])["api_key"]
    r = client.post("/api/integration/sessions", headers={"X-Api-Key": key},
                    json={"agent_id": pid,
                          "meeting_start": _future(120), "meeting_end": _future(180)})
    assert r.status_code == 403 and "scope" in r.json()["detail"]


# ── 幂等 ──
def test_idempotency_returns_same_session(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    body = {"agent_id": pid,
            "meeting_start": _future(120), "meeting_end": _future(180)}
    h = {"X-Api-Key": key, "Idempotency-Key": "idem-001"}
    r1 = client.post("/api/integration/sessions", headers=h, json=body)
    r2 = client.post("/api/integration/sessions", headers=h, json=body)
    assert r1.status_code == 201 and r2.status_code == 201
    assert r1.json()["session_id"] == r2.json()["session_id"]  # 同键返回首次结果


# ── 资源隔离 ──
def test_client_isolation(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    keyA = _create_client(client, admin, ["sessions:write", "sessions:read"])["api_key"]
    keyB = _create_client(client, admin, ["sessions:write", "sessions:read"])["api_key"]
    body = {"agent_id": pid,
            "meeting_start": _future(120), "meeting_end": _future(180)}
    sid = client.post("/api/integration/sessions", headers={"X-Api-Key": keyA}, json=body).json()["session_id"]
    # A 能查自己的
    assert client.get(f"/api/integration/sessions/{sid}", headers={"X-Api-Key": keyA}).status_code == 200
    # B 查 A 的 → 404(不泄露存在性)
    assert client.get(f"/api/integration/sessions/{sid}", headers={"X-Api-Key": keyB}).status_code == 404


# ── Webhook ──
def test_webhook_register_and_isolation(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    keyA = _create_client(client, admin, ["webhooks:manage"])["api_key"]
    keyB = _create_client(client, admin, ["webhooks:manage"])["api_key"]
    r = client.post("/api/integration/webhooks", headers={"X-Api-Key": keyA},
                    json={"url": "https://hook.test/aim", "events": ["result.ready"]})
    assert r.status_code == 201 and r.json()["secret"].startswith("whsec_")
    wid = r.json()["webhook_id"]
    # A 列出自己的
    assert any(w["webhook_id"] == wid for w in client.get("/api/integration/webhooks", headers={"X-Api-Key": keyA}).json())
    # B 删 A 的 → 404
    assert client.delete(f"/api/integration/webhooks/{wid}", headers={"X-Api-Key": keyB}).status_code == 404


def test_webhook_invalid_url_or_event(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    key = _create_client(client, admin, ["webhooks:manage"])["api_key"]
    h = {"X-Api-Key": key}
    assert client.post("/api/integration/webhooks", headers=h,
                       json={"url": "http://insecure", "events": ["result.ready"]}).status_code == 422
    assert client.post("/api/integration/webhooks", headers=h,
                       json={"url": "https://x.test", "events": ["bogus"]}).status_code == 422


def test_webhook_ssrf_blocked(client, make_token):
    """review 高危:webhook url 不得指向云元数据/内网(防 SSRF 偷 IAM 凭证)。"""
    admin = _auth(make_token(groups=["admin"]))
    key = _create_client(client, admin, ["webhooks:manage"])["api_key"]
    h = {"X-Api-Key": key}
    for bad in ["https://169.254.169.254/latest/meta-data/",
                "https://10.0.0.5/hook", "https://127.0.0.1/hook",
                "https://192.168.1.1/hook", "https://localhost/hook",
                "https://metadata.google.internal/x"]:
        r = client.post("/api/integration/webhooks", headers=h,
                        json={"url": bad, "events": ["result.ready"]})
        assert r.status_code == 422, f"应拒绝 SSRF 目标: {bad} (got {r.status_code})"
    # 正常公网 https 域名仍可注册
    ok = client.post("/api/integration/webhooks", headers=h,
                     json={"url": "https://hooks.example.com/aim", "events": ["result.ready"]})
    assert ok.status_code == 201


def test_webhook_needs_scope(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    key = _create_client(client, admin, ["sessions:write"])["api_key"]  # 无 webhooks:manage
    assert client.post("/api/integration/webhooks", headers={"X-Api-Key": key},
                       json={"url": "https://x.test", "events": ["result.ready"]}).status_code == 403


# ── staff 自助委托 agent ──
def test_staff_issues_delegation_and_agent_books(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin, self_bookable=True)
    staff = _auth(make_token(groups=["staff"], username="zhang@corp.com"))
    # staff 签发委托 token
    d = client.post("/api/me/delegations", json={"label": "我的日程助理"}, headers=staff)
    assert d.status_code == 201, d.text
    dtok = d.json()["token"]
    assert d.json()["staff"] == "zhang@corp.com"
    # 宣告的 mcp_config.tools 必须与真实 MCP server 工具集一致(防再次宣告已删的 reschedule_meeting)。
    from app.mcp_server import TOOLS  # noqa: PLC0415
    assert set(d.json()["mcp_config"]["tools"]) == {t["name"] for t in TOOLS}
    assert "reschedule_meeting" not in d.json()["mcp_config"]["tools"]
    # agent 持委托 token 代 staff 预约(X-Delegation-Token)
    r = client.post("/api/sessions", headers={"X-Delegation-Token": dtok},
                    json={"agent_id": pid,
                          "meeting_start": _future(120), "meeting_end": _future(180)})
    assert r.status_code == 201, r.text
    sess = r.json()
    assert sess["origin"] == "staff" and sess["booked_by"] == "zhang@corp.com"
    # agent 查会话列表(只见该 staff 自己的)
    mine = client.get("/api/sessions", headers={"X-Delegation-Token": dtok}).json()
    assert all(s["booked_by"] == "zhang@corp.com" for s in mine)
    assert any(s["session_id"] == sess["session_id"] for s in mine)


def test_webhook_fired_on_session_completed(app_and_db):
    """review:会话终态真触发 webhook 投递(不只是 mock)。SessionService.hangup → session.completed。"""
    from app import state_machine as sm
    from app.session_service import RecordingDispatcher, SessionService

    _, db = app_and_db
    fired = []
    svc = SessionService(db, RecordingDispatcher(db), webhook_emitter=lambda et, data: fired.append((et, data)))
    db.put_session_meta("sx", {"status": "in_progress"})
    session = {"session_id": "sx", "status": sm.IN_PROGRESS}
    svc.hangup(session, end_trigger=sm.END_ADMIN_HANGUP)
    assert ("session.completed", {"session_id": "sx", "status": "completed", "trigger": None,
                                  "fail_reason": None, "ended_at": session["ended_at"]}) in fired


def test_webhook_fired_on_session_failed_violation(app_and_db):
    """design contract(review):违规/物理断连 fail_from_media → 恰好 1 条 session.failed webhook(带 fail_reason)。
    与 session.completed 对称;此前 violation_end 路径直写 DDB 漏发 webhook。"""
    from app import state_machine as sm
    from app.session_service import RecordingDispatcher, SessionService

    _, db = app_and_db
    fired = []
    svc = SessionService(db, RecordingDispatcher(db), webhook_emitter=lambda et, data: fired.append((et, data)))
    db.put_session_meta("sf", {"status": "in_progress"})
    session = {"session_id": "sf", "status": sm.IN_PROGRESS}
    svc.fail_from_media(session, fail_reason=sm.FAIL_SILENCE_TIMEOUT, end_trigger="silence_violation")
    failed = [f for f in fired if f[0] == "session.failed"]
    assert len(failed) == 1, fired  # 恰好一条
    assert failed[0][1]["status"] == "failed" and failed[0][1]["fail_reason"] == sm.FAIL_SILENCE_TIMEOUT
    # 幂等:已终态再调不重复发
    svc.fail_from_media(session, fail_reason=sm.FAIL_SILENCE_TIMEOUT)
    assert len([f for f in fired if f[0] == "session.failed"]) == 1


def test_dispatch_event_delivers_to_subscribed_webhook(app_and_db, monkeypatch):
    """integration_service.dispatch_event 真投递到订阅了该事件的 webhook(签名 + 落库)。"""
    from app.integration_service import IntegrationService

    _, db = app_and_db
    posted = {}

    class _Resp:
        status_code = 200

    def fake_post(url, content=None, headers=None, timeout=None):
        posted["url"] = url
        posted["sig"] = headers.get("X-AIM-Signature")
        return _Resp()

    import httpx
    monkeypatch.setattr(httpx, "post", fake_post)
    svc = IntegrationService(db)
    svc.register_webhook("clientX", "https://hooks.example.com/aim", ["session.completed"])
    results = svc.dispatch_event("session.completed", {"session_id": "s1"}, sleep=lambda s: None)
    assert len(results) == 1 and results[0]["ok"] is True
    assert posted["url"] == "https://hooks.example.com/aim"
    assert posted["sig"].startswith("sha256=")
    # 未订阅的事件不投递
    assert svc.dispatch_event("result.ready", {"session_id": "s1"}, sleep=lambda s: None) == []


def test_idempotency_compute_failure_no_deadlock(app_and_db):
    """review 抛异常应删占位,同 key 重试不被 None 占位永久 409 死锁。"""
    from app.integration_service import IntegrationService

    _, db = app_and_db
    svc = IntegrationService(db)
    calls = {"n": 0}

    def boom():
        calls["n"] += 1
        raise RuntimeError("compute failed")

    import pytest
    with pytest.raises(RuntimeError):
        svc.idempotent("clientX", "k1", boom)
    # 占位已删 → 同 key 再来一次能重新 compute(而非卡在 None 占位)
    result, first = svc.idempotent("clientX", "k1", lambda: {"ok": True})
    assert first is True and result == {"ok": True} and calls["n"] == 1


def test_delegation_returns_mcp_config(client, make_token):
    """签发委托顺带返回即用 MCP 配置(内嵌 token + endpoint),前端据此生成「下载我的 MCP 助手」。"""
    staff = _auth(make_token(groups=["staff"], username="zhao@corp.com"))
    d = client.post("/api/me/delegations", json={"label": "助理"}, headers=staff).json()
    mc = d["mcp_config"]
    assert mc["transport"] == "stdio"
    assert mc["auth_header"] == "X-Delegation-Token"
    assert mc["token"] == d["token"]  # token 内嵌进配置
    assert "book_meeting" in mc["tools"] and "list_my_meetings" in mc["tools"]
    # design contract:工具名与 MCP server 实际暴露一致(list_self_bookable_agents,不是旧 _profiles,review)
    assert "list_self_bookable_agents" in mc["tools"]
    assert "list_self_bookable_profiles" not in mc["tools"]


def test_delegation_bad_token_401(client):
    assert client.get("/api/sessions", headers={"X-Delegation-Token": "garbage"}).status_code == 401


def test_delegation_ttl_capped_at_30_days(client, make_token):
    """委托 token 无状态不可单条吊销 → 有效期硬上限 30 天(720h)。"""
    staff = _auth(make_token(groups=["staff"], username="wang@corp.com"))
    # 超 720h → 422
    assert client.post("/api/me/delegations", json={"ttl_hours": 9999}, headers=staff).status_code == 422
    assert client.post("/api/me/delegations", json={"ttl_hours": 0}, headers=staff).status_code == 422
    # 边界 720h 接受
    assert client.post("/api/me/delegations", json={"ttl_hours": 720}, headers=staff).status_code == 201
    # 默认(不传)= 7 天
    d = client.post("/api/me/delegations", json={}, headers=staff)
    assert d.status_code == 201


def test_delegation_cannot_use_non_bookable_profile(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin, self_bookable=False)  # 面试类不可自助
    staff = _auth(make_token(groups=["staff"], username="li@corp.com"))
    dtok = client.post("/api/me/delegations", json={}, headers=staff).json()["token"]
    # agent 代 staff 用不可自助 Profile → 403(继承 staff 边界)
    r = client.post("/api/sessions", headers={"X-Delegation-Token": dtok},
                    json={"agent_id": pid,
                          "meeting_start": _future(120), "meeting_end": _future(180)})
    assert r.status_code == 403
