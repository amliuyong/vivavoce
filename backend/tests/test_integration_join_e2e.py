"""design contract —— API Key 为自己的会话签发实时凭据的 e2e。

GET /api/integration/sessions/{id}/join(require_scope sessions:write):
覆盖签票成功 + 可验签 + 4h TTL + 与登录路径同构 / 跨 client 404 / 缺 scope 403 /
终态 409 / 密钥缺失 503 / 无 key 401 / GET 天然幂等(同秒同 token)。

POST /api/integration/sessions/{id}/realtime-client-secret:
覆盖独立 key、600s 新票、可信 URL、资源隔离、状态门和 best-effort make_ready。
"""
from __future__ import annotations

import base64
import dataclasses
import json
import time
from datetime import UTC, datetime

from app.join_token import verify_join_token

SECRET = "test-bridge-callback-secret-0123456789"  # = conftest bridge_callback_secret
_DIMENSION_RUBRIC = {"mode": "dimension_score",
                     "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _seed_agent(client, admin) -> str:
    return client.post("/api/agents",
                       json={"name": "集成Agent", "self_bookable": True, "rubric": _DIMENSION_RUBRIC},
                       headers=admin).json()["agent_id"]


def _create_client(client, admin, scopes) -> dict:
    r = client.post("/api/integration/clients", json={"name": "ATS集成", "scopes": scopes}, headers=admin)
    assert r.status_code == 201, r.text
    return r.json()


def _api_launch(client, key: str, agent_id: str) -> str:
    r = client.post("/api/integration/sessions", headers={"X-Api-Key": key}, json={"agent_id": agent_id})
    assert r.status_code == 201, r.text
    return r.json()["session_id"]


def test_api_key_join_issues_valid_token(client, make_token):
    """持 sessions:write 的 key 为自己创建的会话签票:格式合法、可验签、ws_path、4h TTL。"""
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    sid = _api_launch(client, key, pid)

    r = client.get(f"/api/integration/sessions/{sid}/join", headers={"X-Api-Key": key})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ws_path"] == "/rt/ws"
    parts = body["join_token"].split(".")
    assert len(parts) == 4 and parts[0] == "v1" and parts[1] == sid
    assert verify_join_token(body["join_token"], SECRET, int(time.time())) == sid
    # 固定 4h TTL:expires_at 与 token 内 exp 一致,且约 now+4h(design contract)
    exp_unix = int(parts[2])
    assert abs(exp_unix - (int(time.time()) + 4 * 3600)) < 10


def test_api_key_join_matches_login_path_token(client, make_token, app_and_db):
    """同构性(design contract):机器签票端点与登录路径 GET /api/sessions/{id}/join 对同一会话
    同一秒签出的 token 逐字节相同(同密钥同算法),证明复用 issue_join_token 不另起一套。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    sid = _api_launch(client, key, pid)
    # 登录路径要求 admin/staff;此会话 origin=api、booked_by=None,admin 可签(归属 admin 任意)。
    login = client.get(f"/api/sessions/{sid}/join", headers=admin)
    machine = client.get(f"/api/integration/sessions/{sid}/join", headers={"X-Api-Key": key})
    assert login.status_code == 200 and machine.status_code == 200
    ml = login.json()["join_token"]
    mm = machine.json()["join_token"]
    now = int(time.time())
    # 加固(review):跨秒容忍不能只比 session_id(否则「另写一套但用不同密钥/算法」跨秒仍绿)。
    # ① 两 token 都能被**同一** SECRET 验回同一 session_id(证明同密钥同算法);
    assert verify_join_token(ml, SECRET, now) == sid
    assert verify_join_token(mm, SECRET, now) == sid
    # ② 前三段(版本/session_id/exp 结构)一致:v1 + 同 sid + exp 为秒级整数;
    assert ml.split(".")[0] == mm.split(".")[0] == "v1"
    assert ml.split(".")[1] == mm.split(".")[1] == sid
    assert ml.split(".")[2].isdigit() and mm.split(".")[2].isdigit()
    # ③ 同秒签发 → 必须逐字节相同(HMAC 对同一 msg 同签名,铁证复用同一 issue_join_token)。
    if ml.split(".")[2] == mm.split(".")[2]:
        assert ml == mm


def test_api_key_join_cross_client_404(client, make_token):
    """租户隔离(design contract):client B 为 client A 创建的会话签票 → 404(不泄露存在性)。"""
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    keyA = _create_client(client, admin, ["sessions:write"])["api_key"]
    keyB = _create_client(client, admin, ["sessions:write"])["api_key"]
    sid = _api_launch(client, keyA, pid)
    # A 自己 → 200
    assert client.get(f"/api/integration/sessions/{sid}/join", headers={"X-Api-Key": keyA}).status_code == 200
    # B 越权 → 404
    assert client.get(f"/api/integration/sessions/{sid}/join", headers={"X-Api-Key": keyB}).status_code == 404


def test_api_key_join_missing_scope_403(client, make_token):
    """缺 sessions:write(只有 sessions:read)→ 403;且 read key 连自己发起都做不到,用别处建的会话验。"""
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    writer = _create_client(client, admin, ["sessions:write"])["api_key"]
    reader = _create_client(client, admin, ["sessions:read"])["api_key"]
    sid = _api_launch(client, writer, pid)
    # reader 缺 sessions:write → 403(scope 门控先于资源隔离,即便会话非其所有也应是 403)
    r = client.get(f"/api/integration/sessions/{sid}/join", headers={"X-Api-Key": reader})
    assert r.status_code == 403, r.text


def test_api_key_join_no_key_401(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    sid = _api_launch(client, key, pid)
    assert client.get(f"/api/integration/sessions/{sid}/join").status_code == 401


def test_api_key_join_terminal_409(client, make_token, app_and_db):
    """终态会话签票 → 409;in_progress(考中重连)仍可签。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    sid = _api_launch(client, key, pid)
    for terminal in ("completed", "failed"):
        s = db.get_session(sid)
        s["status"] = terminal
        db.put_session(s)
        assert client.get(f"/api/integration/sessions/{sid}/join",
                          headers={"X-Api-Key": key}).status_code == 409
    s = db.get_session(sid)
    s["status"] = "in_progress"
    db.put_session(s)
    assert client.get(f"/api/integration/sessions/{sid}/join",
                      headers={"X-Api-Key": key}).status_code == 200


def test_api_key_join_secret_unconfigured_503(client, make_token, app_and_db):
    """密钥未配 → 503 fail-closed(与登录路径同口径,绝不签出不可验的 token)。"""
    app, _ = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    sid = _api_launch(client, key, pid)
    orig = app.state.settings
    app.state.settings = dataclasses.replace(orig, bridge_callback_secret=None)
    try:
        r = client.get(f"/api/integration/sessions/{sid}/join", headers={"X-Api-Key": key})
        assert r.status_code == 503
    finally:
        app.state.settings = orig


def test_api_key_join_idempotent(client, make_token):
    """GET 天然幂等:同一 session_id 连续两次签票,同秒内 token 逐字节相同(无 Idempotency-Key)。"""
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    sid = _api_launch(client, key, pid)
    t1 = client.get(f"/api/integration/sessions/{sid}/join", headers={"X-Api-Key": key}).json()["join_token"]
    t2 = client.get(f"/api/integration/sessions/{sid}/join", headers={"X-Api-Key": key}).json()["join_token"]
    # 同秒 → 完全相同;跨秒 → 仅 exp 段差 1(HMAC 幂等性仍成立,session_id 段恒同)
    if t1.split(".")[2] == t2.split(".")[2]:
        assert t1 == t2
    assert t1.split(".")[1] == t2.split(".")[1] == sid


def test_api_key_can_issue_realtime_client_secret_for_own_scheduled_session(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    session_id = _api_launch(client, key, agent_id)

    before = int(time.time())
    response = client.post(
        f"/api/integration/sessions/{session_id}/realtime-client-secret",
        headers={
            "X-Api-Key": key,
            "Host": "attacker.example",
            "X-Forwarded-Host": "also-attacker.example",
        },
    )
    after = int(time.time())

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"value", "expires_at", "url"}
    assert body["value"].startswith("ek_")
    assert before + 600 <= body["expires_at"] <= after + 600
    assert body["url"] == f"wss://test.cloudfront.net/v1/realtime?session_id={session_id}"

    payload_segment = body["value"][3:].split(".", 1)[0]
    payload = json.loads(base64.urlsafe_b64decode(payload_segment + "==="))
    assert payload == {
        "aud": "viva-realtime",
        "exp": body["expires_at"],
        "iat": body["expires_at"] - 600,
        "jti": payload["jti"],
        "sid": session_id,
        "tr": "websocket",
        "v": 1,
    }


def test_realtime_client_secret_rejects_in_progress_session_without_started_at(
    client,
    make_token,
    app_and_db,
):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    session_id = _api_launch(client, key, agent_id)
    session = db.get_session(session_id)
    session.update({"status": "in_progress", "started_at": None})
    db.put_session(session)

    response = client.post(
        f"/api/integration/sessions/{session_id}/realtime-client-secret",
        headers={"X-Api-Key": key},
    )

    assert response.status_code == 409


def test_realtime_client_secret_rejects_in_progress_session_past_max_duration(
    client,
    make_token,
    app_and_db,
):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    session_id = _api_launch(client, key, agent_id)
    session = db.get_session(session_id)
    session.update({"status": "in_progress", "started_at": "2020-01-01T00:00:00+00:00"})
    db.put_session(session)

    response = client.post(
        f"/api/integration/sessions/{session_id}/realtime-client-secret",
        headers={"X-Api-Key": key},
    )

    assert response.status_code == 409


def test_realtime_client_secret_rejects_short_independent_signing_key(
    client,
    make_token,
    app_and_db,
):
    app, _ = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    session_id = _api_launch(client, key, agent_id)
    original = app.state.settings
    app.state.settings = dataclasses.replace(original, realtime_client_secret="too-short")
    try:
        response = client.post(
            f"/api/integration/sessions/{session_id}/realtime-client-secret",
            headers={"X-Api-Key": key},
        )
    finally:
        app.state.settings = original

    assert response.status_code == 503


def test_realtime_client_secret_cross_client_is_hidden_as_404(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    key_a = _create_client(client, admin, ["sessions:write"])["api_key"]
    key_b = _create_client(client, admin, ["sessions:write"])["api_key"]
    session_id = _api_launch(client, key_a, agent_id)

    assert client.post(
        f"/api/integration/sessions/{session_id}/realtime-client-secret",
        headers={"X-Api-Key": key_a},
    ).status_code == 200
    assert client.post(
        f"/api/integration/sessions/{session_id}/realtime-client-secret",
        headers={"X-Api-Key": key_b},
    ).status_code == 404


def test_realtime_client_secret_requires_sessions_write_scope(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    writer = _create_client(client, admin, ["sessions:write"])["api_key"]
    reader = _create_client(client, admin, ["sessions:read"])["api_key"]
    session_id = _api_launch(client, writer, agent_id)

    response = client.post(
        f"/api/integration/sessions/{session_id}/realtime-client-secret",
        headers={"X-Api-Key": reader},
    )

    assert response.status_code == 403


def test_realtime_client_secret_allows_live_in_progress_but_rejects_terminal(
    client,
    make_token,
    app_and_db,
):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    session_id = _api_launch(client, key, agent_id)
    session = db.get_session(session_id)
    session.update({"status": "in_progress", "started_at": datetime.now(UTC).isoformat()})
    db.put_session(session)
    path = f"/api/integration/sessions/{session_id}/realtime-client-secret"

    assert client.post(path, headers={"X-Api-Key": key}).status_code == 200
    for terminal in ("completed", "failed"):
        session = db.get_session(session_id)
        session["status"] = terminal
        db.put_session(session)
        assert client.post(path, headers={"X-Api-Key": key}).status_code == 409


def test_realtime_client_secret_issues_a_fresh_jti_on_every_post(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    session_id = _api_launch(client, key, agent_id)
    path = f"/api/integration/sessions/{session_id}/realtime-client-secret"

    first = client.post(path, headers={"X-Api-Key": key}).json()["value"]
    second = client.post(path, headers={"X-Api-Key": key}).json()["value"]

    assert first != second


def test_realtime_client_secret_resends_full_ready_context(client, make_token, app_and_db):
    app, _ = app_and_db

    class CaptureDispatcher:
        command = None

        def dispatch(self, command):
            self.command = command

        def hangup(self, session_id):
            return True

    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    session_id = _api_launch(client, key, agent_id)
    dispatcher = CaptureDispatcher()
    app.state.dispatcher = dispatcher
    try:
        response = client.post(
            f"/api/integration/sessions/{session_id}/realtime-client-secret",
            headers={"X-Api-Key": key},
        )
    finally:
        del app.state.dispatcher

    assert response.status_code == 200
    assert dispatcher.command["session_id"] == session_id
    assert dispatcher.command["engine_type"] == "three_stage"
    assert "system_prompt" in dispatcher.command
    assert "questions" in dispatcher.command
    assert "connect_deadline" in dispatcher.command


def test_realtime_client_secret_make_ready_failure_is_best_effort_and_does_not_log_token(
    client,
    make_token,
    app_and_db,
    caplog,
):
    app, _ = app_and_db

    class FailingDispatcher:
        def dispatch(self, command):
            raise RuntimeError("bridge unavailable")

        def hangup(self, session_id):
            return False

    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    session_id = _api_launch(client, key, agent_id)
    app.state.dispatcher = FailingDispatcher()
    try:
        response = client.post(
            f"/api/integration/sessions/{session_id}/realtime-client-secret",
            headers={"X-Api-Key": key},
        )
    finally:
        del app.state.dispatcher

    assert response.status_code == 200
    assert response.json()["value"] not in caplog.text


def test_realtime_client_secret_missing_independent_key_is_503(client, make_token, app_and_db):
    app, _ = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    agent_id = _seed_agent(client, admin)
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    session_id = _api_launch(client, key, agent_id)
    original = app.state.settings
    app.state.settings = dataclasses.replace(original, realtime_client_secret=None)
    try:
        response = client.post(
            f"/api/integration/sessions/{session_id}/realtime-client-secret",
            headers={"X-Api-Key": key},
        )
    finally:
        app.state.settings = original

    assert response.status_code == 503
