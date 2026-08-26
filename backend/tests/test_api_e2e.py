"""API e2e —— 经真实 HTTP(TestClient)打全栈:鉴权中间件 + 路由 + DDB(moto)。

覆盖安全红线:
  - /health 开放
  - /api/* 无 token → 401;坏 token → 401;角色不足 → 403;合法 → 200
  - staff 越权(看他人会话 / 拿非自助 Agent)→ 403
  - staff 自助预约自动建 Target、origin=staff
"""
from __future__ import annotations

# 纯人设(无题)rubric:dimension_score 不需要题库即可发起(design contract:per_question_check 无题 422)。
# 这些 e2e 多数只需一个「可发起」的 Agent、与 rubric/题目无关,统一用维度打分免挂题库。
_DIM_RUBRIC = {"mode": "dimension_score", "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── /health 开放 ──
def test_health_open(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ── 未认证一律拒绝(安全红线) ──
def test_api_requires_token(client):
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/agents").status_code == 401
    assert client.get("/api/sessions").status_code == 401
    assert client.post("/api/agents", json={"name": "x"}).status_code == 401


def test_api_rejects_garbage_token(client):
    r = client.get("/api/me", headers=_auth("garbage.token.here"))
    assert r.status_code == 401


def test_whoami_admin(client, make_token):
    r = client.get("/api/me", headers=_auth(make_token(groups=["admin"])))
    assert r.status_code == 200
    body = r.json()
    assert body["is_admin"] and not body["is_staff"]


# ── 角色门控:建 Agent 仅 admin ──
def test_create_agent_admin_only(client, make_token):
    payload = {"name": "安全培训 check", "self_bookable": True}
    # staff 不可建
    r = client.post("/api/agents", json=payload, headers=_auth(make_token(groups=["staff"])))
    assert r.status_code == 403
    # admin 可建
    r = client.post("/api/agents", json=payload, headers=_auth(make_token(groups=["admin"])))
    assert r.status_code == 201
    assert r.json()["agent_id"].startswith("agent_")


def test_create_agent_tts_provider(client, make_token):
    """design contract:engine.tts_provider 合法枚举(gpu_omnivoice|minimax)接受,非法值 422(对齐 008 Literal 强校验)。"""
    admin = _auth(make_token(groups=["admin"]))
    # 合法:minimax
    r = client.post("/api/agents", json={
        "name": "minimax音色", "engine": {"engine_type": "three_stage", "tts_provider": "minimax"},
    }, headers=admin)
    assert r.status_code == 201
    assert r.json()["engine"]["tts_provider"] == "minimax"
    # 非法值 → 422(不静默回退)
    r = client.post("/api/agents", json={
        "name": "bad", "engine": {"engine_type": "three_stage", "tts_provider": "azure_tts"},
    }, headers=admin)
    assert r.status_code == 422
    # 缺省 → None(回退 gpu_omnivoice)
    r = client.post("/api/agents", json={
        "name": "缺省provider", "engine": {"engine_type": "three_stage"},
    }, headers=admin)
    assert r.status_code == 201
    assert r.json()["engine"]["tts_provider"] is None


# ── staff 只看 self_bookable Agent ──
def test_staff_sees_only_self_bookable(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    client.post("/api/agents", json={"name": "面试官", "self_bookable": False}, headers=admin)
    client.post("/api/agents", json={"name": "培训check", "self_bookable": True}, headers=admin)

    staff_list = client.get("/api/agents", headers=_auth(make_token(groups=["staff"]))).json()
    assert all(p["self_bookable"] for p in staff_list)
    assert any(p["name"] == "培训check" for p in staff_list)
    assert not any(p["name"] == "面试官" for p in staff_list)

    admin_list = client.get("/api/agents", headers=admin).json()
    assert len(admin_list) >= 2  # admin 看全部


# ── staff 自助预约:用 self_bookable Agent,origin=staff,自动建 Target ──
def test_staff_self_booking_flow(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = client.post(
        "/api/agents", json={"name": "培训check", "self_bookable": True, "rubric": _DIM_RUBRIC}, headers=admin
    ).json()

    staff_tok = make_token(groups=["staff"], username="bob@corp.com")
    launch = {
        "agent_id": prof["agent_id"],
        "meeting_start": "2026-06-20T10:00:00+08:00",
        "meeting_end": "2026-06-20T10:30:00+08:00",
    }
    r = client.post("/api/sessions", json=launch, headers=_auth(staff_tok))
    assert r.status_code == 201
    sess = r.json()
    assert sess["origin"] == "staff"
    assert sess["booked_by"] == "bob@corp.com"
    # 自动建了 Target:必须含 PK target_id(否则生产 DDB ValidationException)+ external_id
    targets = db._table(db.settings.targets_table).scan()["Items"]
    bob_targets = [t for t in targets if t.get("external_id") == "bob@corp.com"]
    assert len(bob_targets) == 1
    assert bob_targets[0]["target_id"]  # PK 存在
    assert bob_targets[0]["source"] == "self"
    # session 必须绑定该 target_id(design contract:自助会话可关联到 Target)
    assert sess["target_id"] == bob_targets[0]["target_id"]

    # 详情页「对象」可读名:GET /api/sessions/{id} 应把 target_id 解析成 target_name(Target.name,
    #   staff 自助建的 Target name=email),供前端展示可读名而非原始 UUID。
    detail = client.get(f"/api/sessions/{sess['session_id']}", headers=_auth(staff_tok)).json()
    assert detail["target_name"] == "bob@corp.com"  # = Target.name(self 建时 name=username)

    # 同一 staff 再预约一次:按 external_id 去重,Target 不应重复(复用同一 target_id)
    client.post("/api/sessions", json=launch, headers=_auth(staff_tok))
    targets2 = db._table(db.settings.targets_table).scan()["Items"]
    bob2 = [t for t in targets2 if t.get("external_id") == "bob@corp.com"]
    assert len(bob2) == 1
    assert bob2[0]["target_id"] == bob_targets[0]["target_id"]


def test_session_written_with_created_at_enters_gsi(client, make_token, app_and_db):
    """守住 review 必须写 created_at,否则不进稀疏 GSI、切 query 时静默丢数据。

    直接用 GSI(TriggerIndex / BookedByIndex)query 验证发起的 session 真进了索引。
    """
    from boto3.dynamodb.conditions import Key

    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = client.post(
        "/api/agents", json={"name": "培训", "self_bookable": True, "rubric": _DIM_RUBRIC}, headers=admin
    ).json()
    launch = {
        "agent_id": prof["agent_id"],
        "meeting_start": "2026-06-20T10:00:00+08:00",
        "meeting_end": "2026-06-20T10:30:00+08:00",
    }
    dave = make_token(groups=["staff"], username="dave@corp.com")
    sess = client.post("/api/sessions", json=launch, headers=_auth(dave)).json()

    table = db._table(db.settings.sessions_table)
    # TriggerIndex:manual 会话能被 query 到(证明 created_at 已写、item 进了稀疏索引)
    trig = table.query(IndexName="TriggerIndex", KeyConditionExpression=Key("trigger").eq("manual"))
    assert any(s["session_id"] == sess["session_id"] for s in trig["Items"])
    # BookedByIndex:staff「我的会议」能精确 query 到本人会话
    mine = table.query(IndexName="BookedByIndex", KeyConditionExpression=Key("booked_by").eq("dave@corp.com"))
    assert any(s["session_id"] == sess["session_id"] for s in mine["Items"])


# ── staff 不能用非自助 Agent 预约 ──
def test_staff_cannot_book_non_self_bookable(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    prof = client.post(
        "/api/agents", json={"name": "面试官", "self_bookable": False}, headers=admin
    ).json()
    launch = {
        "agent_id": prof["agent_id"],
        "meeting_start": "2026-06-20T10:00:00+08:00",
        "meeting_end": "2026-06-20T10:30:00+08:00",
    }
    r = client.post("/api/sessions", json=launch, headers=_auth(make_token(groups=["staff"])))
    assert r.status_code == 403


# ── staff 只看自己的会话 ──
def test_staff_sees_only_own_sessions(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    prof = client.post(
        "/api/agents", json={"name": "培训", "self_bookable": True, "rubric": _DIM_RUBRIC}, headers=admin
    ).json()
    base = {
        "agent_id": prof["agent_id"],
        "meeting_start": "2026-06-20T10:00:00+08:00",
        "meeting_end": "2026-06-20T10:30:00+08:00",
    }
    bob = make_token(groups=["staff"], username="bob@corp.com")
    carol = make_token(groups=["staff"], username="carol@corp.com")
    bob_sess = client.post("/api/sessions", json=base, headers=_auth(bob)).json()
    client.post("/api/sessions", json=base, headers=_auth(carol))

    # bob 只看到自己的
    bob_list = client.get("/api/sessions", headers=_auth(bob)).json()
    assert all(s["booked_by"] == "bob@corp.com" for s in bob_list)
    # carol 不能看 bob 的会话详情
    r = client.get(f"/api/sessions/{bob_sess['session_id']}", headers=_auth(carol))
    assert r.status_code == 403
    # admin 看得到
    r = client.get(f"/api/sessions/{bob_sess['session_id']}", headers=admin)
    assert r.status_code == 200


# ── Agent 删除(design contract)+ 进行中会话引用挡删(409)──
def test_delete_agent_and_in_use_guard(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    pid = client.post("/api/agents", json={"name": "可删Agent", "self_bookable": True}, headers=admin).json()["agent_id"]
    # staff 无权删
    assert client.delete(f"/api/agents/{pid}", headers=_auth(make_token(groups=["staff"]))).status_code == 403
    # 无引用 → 204
    assert client.delete(f"/api/agents/{pid}", headers=admin).status_code == 204
    assert client.get(f"/api/agents/{pid}", headers=admin).status_code == 404
    # 删不存在 → 404
    assert client.delete("/api/agents/agent_nope", headers=admin).status_code == 404

    # 有进行中会话引用 → 409(不能删)
    pid2 = client.post("/api/agents", json={"name": "被引用", "self_bookable": True}, headers=admin).json()["agent_id"]
    db.put_session({"session_id": "sess_ref", "agent_id": pid2, "status": "in_progress",
                    "trigger": "manual", "origin": "hr"})
    r = client.delete(f"/api/agents/{pid2}", headers=admin)
    assert r.status_code == 409


# ── admin 对未开始(scheduled)会话可编辑/取消;开始后不可(design contract 操作门控)──
def test_admin_cancel_scheduled_session(client, make_token, app_and_db):
    """即时开始转向后:PATCH 编辑端点已删,只保留取消(DELETE)。取消无 30min 锁,
    仅 scheduled 可取消 → failed(cancelled);in_progress 不可取消 → 409。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    # staff 建一个 scheduled 自助会话(admin 可代管)
    pid = client.post("/api/agents", json={"name": "可约", "self_bookable": True, "rubric": _DIM_RUBRIC}, headers=admin).json()["agent_id"]
    staff = _auth(make_token(groups=["staff"], username="emp@corp.com"))
    sid = client.post("/api/sessions", json={"agent_id": pid}, headers=staff).json()["session_id"]

    # 开始后(in_progress)不可取消(仅 scheduled 可取消)→ 409
    s = db.get_session(sid)
    s["status"] = "in_progress"
    db.put_session(s)
    assert client.delete(f"/api/sessions/{sid}", headers=admin).status_code == 409

    # 回到 scheduled → admin 可取消(无锁)→ 204
    s = db.get_session(sid)
    s["status"] = "scheduled"
    db.put_session(s)
    assert client.delete(f"/api/sessions/{sid}", headers=admin).status_code == 204
    assert db.get_session(sid)["status"] == "failed"  # 取消 = failed(cancelled)


# ── 实时服务状态回报 /events(事件回调:connected/completed/peer_hangup/no_show)──
def test_media_event_callback(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    from datetime import UTC, datetime, timedelta
    def fut(m): return (datetime.now(UTC) + timedelta(minutes=m)).isoformat()
    pid = client.post("/api/agents", json={"name": "p", "rubric": _DIM_RUBRIC}, headers=admin).json()["agent_id"]
    sid = client.post("/api/sessions", json={
        "agent_id": pid,
        "meeting_start": fut(1), "meeting_end": fut(61)}, headers=admin).json()["session_id"]
    assert db.get_session(sid)["status"] == "scheduled"  # 发起后留 scheduled(等考生连入)

    SEC = {"X-Bridge-Secret": "test-bridge-callback-secret-0123456789"}
    # 无密钥 → 401
    assert client.post(f"/api/sessions/{sid}/events", json={"event": "connected"}).status_code == 401
    # 错密钥 → 401
    assert client.post(f"/api/sessions/{sid}/events", json={"event": "connected"},
                       headers={"X-Bridge-Secret": "wrong"}).status_code == 401
    # connected:scheduled → in_progress(客户端连入)
    r = client.post(f"/api/sessions/{sid}/events", json={"event": "connected"}, headers=SEC)
    assert r.status_code == 200 and r.json()["status"] == "in_progress", r.text
    # 幂等:再 connected 仍 in_progress
    assert client.post(f"/api/sessions/{sid}/events", json={"event": "connected"}, headers=SEC).json()["status"] == "in_progress"
    # design contract(修既有 bug):peer_hangup(对端物理断连)→ **failed**(fail_reason=peer_hangup),对齐 design contract
    #   「物理断连走 failed 语义」。旧实现走 completed 与 design contract 矛盾且会误触发评估——已纠正。
    r2 = client.post(f"/api/sessions/{sid}/events", json={"event": "peer_hangup"}, headers=SEC)
    assert r2.status_code == 200 and r2.json()["status"] == "failed", r2.text
    assert db.get_session(sid)["fail_reason"] == "peer_hangup", db.get_session(sid).get("fail_reason")
    # 对已终态会话再 connected → 幂等忽略(200,状态不回退;终态守卫防迟到事件 500/竞态)
    r3 = client.post(f"/api/sessions/{sid}/events", json={"event": "connected"}, headers=SEC)
    assert r3.status_code == 200 and r3.json()["status"] == "failed", r3.text
    # 电话版事件枚举已删 → 422
    assert client.post(f"/api/sessions/{sid}/events", json={"event": "no_answer"}, headers=SEC).status_code == 422


def test_media_event_completed_defaults_to_session_end(client, make_token, app_and_db):
    """completed 事件缺省 end_trigger → session_end(正常收尾),不再误兜底 peer_hangup。

    bridge 语义收尾(AI 问完题/两步确认)上报 {event: completed} **不带** end_trigger;
    旧行为一律兜底 peer_hangup,把「AI 正常收尾」误标成「对端异常断开」。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    from datetime import UTC, datetime, timedelta
    def fut(m): return (datetime.now(UTC) + timedelta(minutes=m)).isoformat()
    pid = client.post("/api/agents", json={"name": "pc", "rubric": _DIM_RUBRIC}, headers=admin).json()["agent_id"]
    sid = client.post("/api/sessions", json={
        "agent_id": pid, "meeting_start": fut(1), "meeting_end": fut(61)}, headers=admin).json()["session_id"]
    SEC = {"X-Bridge-Secret": "test-bridge-callback-secret-0123456789"}
    client.post(f"/api/sessions/{sid}/events", json={"event": "connected"}, headers=SEC)
    # completed 无 end_trigger → session_end
    r = client.post(f"/api/sessions/{sid}/events", json={"event": "completed"}, headers=SEC)
    assert r.status_code == 200 and r.json()["status"] == "completed", r.text
    assert db.get_session(sid)["end_trigger"] == "session_end", db.get_session(sid).get("end_trigger")


def test_media_event_completed_explicit_trigger_wins(client, make_token, app_and_db):
    """实时服务显式上报 end_trigger(如 error/manual_hangup)时透传,不被缺省覆盖。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    from datetime import UTC, datetime, timedelta
    def fut(m): return (datetime.now(UTC) + timedelta(minutes=m)).isoformat()
    pid = client.post("/api/agents", json={"name": "pe", "rubric": _DIM_RUBRIC}, headers=admin).json()["agent_id"]
    sid = client.post("/api/sessions", json={
        "agent_id": pid, "meeting_start": fut(1), "meeting_end": fut(61)}, headers=admin).json()["session_id"]
    SEC = {"X-Bridge-Secret": "test-bridge-callback-secret-0123456789"}
    client.post(f"/api/sessions/{sid}/events", json={"event": "connected"}, headers=SEC)
    r = client.post(f"/api/sessions/{sid}/events",
                    json={"event": "completed", "end_trigger": "error"}, headers=SEC)
    assert r.status_code == 200 and r.json()["status"] == "completed", r.text
    assert db.get_session(sid)["end_trigger"] == "error", db.get_session(sid).get("end_trigger")


def test_media_event_violation_end(client, make_token, app_and_db):
    """design contract:violation_end 事件(**仅违规** silence/severe)→ failed + fail_reason 映射;未知兜底 unrecoverable。
    放行 scheduled→failed(review 竞态:violation 先于 connected 到达);终态幂等。
    (peer_hangup 走独立 peer_hangup 事件,见 test_media_event_callback,不在 violation_end 里。)"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    from datetime import UTC, datetime, timedelta
    def fut(m): return (datetime.now(UTC) + timedelta(minutes=m)).isoformat()
    SEC = {"X-Bridge-Secret": "test-bridge-callback-secret-0123456789"}
    pid = client.post("/api/agents", json={"name": "pv", "rubric": _DIM_RUBRIC}, headers=admin).json()["agent_id"]

    cases = [
        ("silence_violation", "silence_timeout"),
        ("severe_violation", "severe_violation"),
        ("weird_unknown", "unrecoverable"),  # 未知 reason 兜底
    ]
    for reason, expect_fail in cases:
        sid = client.post("/api/sessions", json={
            "agent_id": pid, "meeting_start": fut(1), "meeting_end": fut(61)}, headers=admin).json()["session_id"]
        client.post(f"/api/sessions/{sid}/events", json={"event": "connected"}, headers=SEC)  # → in_progress
        r = client.post(f"/api/sessions/{sid}/events",
                        json={"event": "violation_end", "fail_reason": reason}, headers=SEC)
        assert r.status_code == 200 and r.json()["status"] == "failed", r.text
        assert db.get_session(sid)["fail_reason"] == expect_fail, db.get_session(sid).get("fail_reason")
        # 幂等:对已 failed 会话再 violation_end → 原样返回(不误改)
        r2 = client.post(f"/api/sessions/{sid}/events", json={"event": "violation_end", "fail_reason": reason}, headers=SEC)
        assert r2.status_code == 200 and r2.json()["status"] == "failed"

    # ★ 竞态(review):violation_end 先于 connected 到达(会话仍 scheduled)→ MUST 放行 scheduled→failed
    #   (旧实现要求 in_progress 会拒绝 → 卡死);随后迟到的 connected → 幂等(终态不回退)。
    sid2 = client.post("/api/sessions", json={
        "agent_id": pid, "meeting_start": fut(1), "meeting_end": fut(61)}, headers=admin).json()["session_id"]
    assert db.get_session(sid2)["status"] == "scheduled"
    r3 = client.post(f"/api/sessions/{sid2}/events", json={"event": "violation_end", "fail_reason": "silence_violation"}, headers=SEC)
    assert r3.status_code == 200 and r3.json()["status"] == "failed", r3.text  # scheduled → failed(不卡死)
    # 迟到 connected → 幂等(不把 failed 拉回 in_progress)
    r4 = client.post(f"/api/sessions/{sid2}/events", json={"event": "connected"}, headers=SEC)
    assert r4.status_code == 200 and r4.json()["status"] == "failed", r4.text


def test_media_event_no_show(client, make_token, app_and_db):
    """no_show 事件:scheduled → failed(no_show);幂等;in_progress 上报 no_show → 409。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    from datetime import UTC, datetime, timedelta
    def fut(m): return (datetime.now(UTC) + timedelta(minutes=m)).isoformat()
    pid = client.post("/api/agents", json={"name": "p2", "rubric": _DIM_RUBRIC}, headers=admin).json()["agent_id"]
    sid = client.post("/api/sessions", json={
        "agent_id": pid,
        "meeting_start": fut(1), "meeting_end": fut(61)}, headers=admin).json()["session_id"]
    SEC = {"X-Bridge-Secret": "test-bridge-callback-secret-0123456789"}
    r = client.post(f"/api/sessions/{sid}/events", json={"event": "no_show"}, headers=SEC)
    assert r.status_code == 200 and r.json()["status"] == "failed"
    assert r.json()["fail_reason"] == "no_show"
    # 幂等:已 failed 再报 no_show 仍 200(不 409)
    assert client.post(f"/api/sessions/{sid}/events", json={"event": "no_show"}, headers=SEC).status_code == 200
    # 迟到的 connected(调度器已标 no_show 后考生才连入)→ 幂等忽略,状态留 failed 不回退、不 500
    # (review:终态守卫;实时服务侧不因 500 重试风暴)
    r_late = client.post(f"/api/sessions/{sid}/events", json={"event": "connected"}, headers=SEC)
    assert r_late.status_code == 200 and r_late.json()["status"] == "failed", r_late.text
    # in_progress 会话(考生实际连入过)误报 no_show → 幂等忽略,状态不被误标 failed
    # (review_show 仅适用 scheduled;裸 assert_transition 会放行 in_progress→failed 语义错)
    s = db.get_session(sid)
    s["status"] = "in_progress"
    s["fail_reason"] = None
    db.put_session(s)
    r2 = client.post(f"/api/sessions/{sid}/events", json={"event": "no_show"}, headers=SEC)
    assert r2.status_code == 200 and r2.json()["status"] == "in_progress", r2.text
