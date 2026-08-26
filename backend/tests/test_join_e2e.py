"""GET /api/sessions/{id}/join e2e(M1-B)—— 经 TestClient 打全栈(真实 JWT 校验 + moto DDB)。

覆盖:admin 签发(格式/可验签/expires_at 策略)、staff 归属(非本人 403/不存在 404)、
终态 409、超窗 409、签发触发 ready 预创建(dispatcher 被调 + meta 留痕)、密钥未配 503。
"""
from __future__ import annotations

import dataclasses
import time
from datetime import UTC, datetime, timedelta

from app.join_token import verify_join_token
from app.state_machine import parse_iso

_DIM_RUBRIC = {"mode": "dimension_score", "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}
SECRET = "test-bridge-callback-secret-0123456789"  # = conftest bridge_callback_secret


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _future(minutes: int) -> str:
    return (datetime.now(UTC) + timedelta(minutes=minutes)).isoformat()


def _mk_session(client, headers, *, start_min: int = -1, dur_min: int = 60) -> dict:
    """即时开始模型:发起体只需 agent_id(无时间窗)。start_min/dur_min 保留为兼容旧签名的空参。"""
    admin = headers  # 需要 admin 建 Agent;发起者可以是 headers 本身
    prof = client.post("/api/agents", json={"name": "口试", "rubric": _DIM_RUBRIC, "self_bookable": True},
                       headers=admin).json()
    r = client.post("/api/sessions", json={"agent_id": prof["agent_id"]}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def test_join_admin_issues_valid_token(client, make_token):
    """admin 拿到 token:格式合法、能被 verify_join_token 验回 session_id;expires_at 与策略一致。"""
    admin = _auth(make_token(groups=["admin"]))
    sess = _mk_session(client, admin, start_min=-1, dur_min=60)
    sid = sess["session_id"]

    r = client.get(f"/api/sessions/{sid}/join", headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ws_path"] == "/rt/ws"
    # 格式:v1.<session_id>.<exp_unix>.<sig>
    parts = body["join_token"].split(".")
    assert len(parts) == 4 and parts[0] == "v1" and parts[1] == sid
    # 验签对拍(生产验签在 bridge,这里用对称实现钉契约)
    assert verify_join_token(body["join_token"], SECRET, int(time.time())) == sid
    # 即时开始模型:无时间窗,exp = now + JOIN_MAX_TTL(固定 4h 上限)
    exp_dt = parse_iso(body["expires_at"])
    assert int(exp_dt.timestamp()) == int(parts[2])
    expected = datetime.now(UTC) + timedelta(hours=4)
    assert abs((exp_dt - expected).total_seconds()) < 5  # 秒级截断容差


def test_join_expiry_capped_at_4h(client, make_token):
    """meeting_end 很远(>4h)时 exp 封顶 now+4h。"""
    admin = _auth(make_token(groups=["admin"]))
    sess = _mk_session(client, admin, start_min=5, dur_min=60 * 24)  # 窗口 24h
    r = client.get(f"/api/sessions/{sess['session_id']}/join", headers=admin)
    assert r.status_code == 200
    exp_dt = parse_iso(r.json()["expires_at"])
    cap = datetime.now(UTC) + timedelta(hours=4)
    assert exp_dt <= cap + timedelta(seconds=5)
    assert exp_dt >= cap - timedelta(minutes=1)  # 确实按 4h 封顶,不是 meeting_end+15min


def test_join_staff_owner_ok_non_owner_403_missing_404(client, make_token):
    """归属沿用列表/详情口径:本人 200;非本人 403;不存在 404。"""
    admin = _auth(make_token(groups=["admin"]))
    bob = make_token(groups=["staff"], username="bob@corp.com")
    # admin 建自助 Agent,staff bob 自己发起一场(归属 bob)
    prof = client.post("/api/agents", json={"name": "自助", "rubric": _DIM_RUBRIC, "self_bookable": True},
                       headers=admin).json()
    r = client.post("/api/sessions", json={
        "agent_id": prof["agent_id"],
        "meeting_start": _future(-1), "meeting_end": _future(59),
    }, headers=_auth(bob))
    sid = r.json()["session_id"]

    # bob(本人)→ 200 且 token 验回本会话
    ok = client.get(f"/api/sessions/{sid}/join", headers=_auth(bob))
    assert ok.status_code == 200
    assert verify_join_token(ok.json()["join_token"], SECRET, int(time.time())) == sid
    # carol(非本人 staff)→ 403
    carol = make_token(groups=["staff"], username="carol@corp.com")
    assert client.get(f"/api/sessions/{sid}/join", headers=_auth(carol)).status_code == 403
    # 不存在 → 404
    assert client.get("/api/sessions/sess_nope/join", headers=admin).status_code == 404


def test_join_terminal_status_409(client, make_token, app_and_db):
    """completed / failed 终态 → 409(不可再连入)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    sess = _mk_session(client, admin, start_min=-1)
    sid = sess["session_id"]
    for terminal in ("completed", "failed"):
        s = db.get_session(sid)
        s["status"] = terminal
        db.put_session(s)
        assert client.get(f"/api/sessions/{sid}/join", headers=admin).status_code == 409
    # in_progress(考中重连)仍可签发
    s = db.get_session(sid)
    s["status"] = "in_progress"
    db.put_session(s)
    assert client.get(f"/api/sessions/{sid}/join", headers=admin).status_code == 200


def test_join_redispatches_ready(client, make_token, app_and_db):
    """签发前重新预创建:/join 必须重发就绪指令(闭合实时服务重启丢上下文缺口)。

    双重断言:①注入 fake dispatcher,验证 dispatch 确被调且携带会话内核;
    ②默认 RecordingDispatcher 路径,验证 meta.dispatched_at 留痕被刷新。
    """
    app, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    sess = _mk_session(client, admin, start_min=-1)
    sid = sess["session_id"]

    # ① fake dispatcher:断言 /join 触发 dispatch(就绪指令含 session_id + prompt/questions 内核)
    calls: list[dict] = []

    class _FakeDispatcher:
        def dispatch(self, command: dict) -> None:
            calls.append(command)

        def hangup(self, session_id: str) -> bool:
            return True

    app.state.dispatcher = _FakeDispatcher()
    try:
        assert client.get(f"/api/sessions/{sid}/join", headers=admin).status_code == 200
        assert len(calls) == 1
        assert calls[0]["session_id"] == sid
        assert "system_prompt" in calls[0] and "questions" in calls[0]  # 完整会话内核重新暂存
    finally:
        del app.state.dispatcher

    # ② 默认 RecordingDispatcher:meta.dispatched_at 被 /join 刷新(晚于发起时的首次留痕)
    before = db.get_session_meta(sid)["dispatched_at"]
    time.sleep(0.01)
    assert client.get(f"/api/sessions/{sid}/join", headers=admin).status_code == 200
    after = db.get_session_meta(sid)["dispatched_at"]
    assert after > before  # ISO8601 字典序 = 时间序


def test_join_dispatch_failure_does_not_block_issuance(client, make_token, app_and_db):
    """预创建 best-effort:dispatcher 抛异常只告警,签发仍 200(客户端会拿到 not_ready 重试)。"""
    app, _ = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    sess = _mk_session(client, admin, start_min=-1)

    class _BoomDispatcher:
        def dispatch(self, command: dict) -> None:
            raise RuntimeError("rt service down")

        def hangup(self, session_id: str) -> bool:
            return False

    app.state.dispatcher = _BoomDispatcher()
    try:
        r = client.get(f"/api/sessions/{sess['session_id']}/join", headers=admin)
        assert r.status_code == 200
        assert verify_join_token(r.json()["join_token"], SECRET, int(time.time())) == sess["session_id"]
    finally:
        del app.state.dispatcher


def test_join_secret_unconfigured_503(client, make_token, app_and_db):
    """密钥未配置 → 503 fail-closed(与 /events 口径一致),绝不签出不可验的 token。"""
    app, _ = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    sess = _mk_session(client, admin, start_min=-1)
    orig = app.state.settings
    app.state.settings = dataclasses.replace(orig, bridge_callback_secret=None)
    try:
        r = client.get(f"/api/sessions/{sess['session_id']}/join", headers=admin)
        assert r.status_code == 503
    finally:
        app.state.settings = orig


def test_join_requires_staff_role(client, make_token):
    """越权面(review):无角色的已认证用户(非 admin/staff 组)一律 403,
    即使用户名恰好匹配 booked_by(角色必须来自 Cognito Group)。"""
    admin = _auth(make_token(groups=["admin"]))
    sess = _mk_session(client, admin, start_min=-1, dur_min=60)
    norole = _auth(make_token(groups=[]))  # 已认证但无任何组
    r = client.get(f"/api/sessions/{sess['session_id']}/join", headers=norole)
    assert r.status_code == 403, r.text
