"""新增路由 e2e —— 经 TestClient 打全栈(真实 Cognito JWT 校验路径 + moto DDB)。

覆盖 design contract(版本/rubric)、005/006/009/011 缩水版(发起/重约/挂断/30min 锁)、010(结果复核)。
(004 targets CRUD 端点随 design contract 删除,对应用例已移除;发起路径仍写对象记录。)
每个 API 一条以上 e2e;不 mock 鉴权/DB。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

# 纯人设(无题)rubric:dimension_score 不需要题库即可发起(design contract:per_question_check 无题 422)。
# 这些 e2e 多数只需一个「可发起」的 Agent、与 rubric/题目无关,统一用维度打分免挂题库。
_DIM_RUBRIC = {"mode": "dimension_score", "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _future(minutes: int) -> str:
    return (datetime.now(UTC) + timedelta(minutes=minutes)).isoformat()


def _mk_launch(agent_id: str, *, start_min: int = -1, dur_min: int = 60) -> dict:
    # 即时开始模型:发起体只剩 agent_id(无时间窗);一律落 scheduled,客户端连入才 in_progress。
    # start_min/dur_min 保留为兼容旧调用点的空参(不再生成时间窗)。
    return {"agent_id": agent_id}


def _mk_agent(client, admin, **kw) -> dict:
    """建一个「可发起」Agent(默认维度打分 rubric,免挂题库即可拨入)。kw 覆盖默认字段。"""
    body = {"name": "面试", "rubric": _DIM_RUBRIC}
    body.update(kw)
    return client.post("/api/agents", json=body, headers=admin).json()


# ════════ 003/020 Agent:rubric / update / versions ════════
def test_agent_rubric_dimension_score_roundtrip(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    body = {
        "name": "面试官",
        "rubric": {
            "mode": "dimension_score",
            "dimensions": [
                {"name": "沟通", "max_score": 5, "weight": 1},
                {"name": "专业", "max_score": 5, "weight": 2},
            ],
        },
    }
    r = client.post("/api/agents", json=body, headers=admin)
    assert r.status_code == 201
    assert r.json()["rubric"]["mode"] == "dimension_score"


def test_agent_rubric_invalid_rejected(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    # dimension_score 无维度 → 422
    bad = {"name": "x", "rubric": {"mode": "dimension_score", "dimensions": []}}
    assert client.post("/api/agents", json=bad, headers=admin).status_code == 422
    # pass_threshold 越界 → 422
    bad2 = {"name": "y", "rubric": {"mode": "per_question_check", "pass_threshold": 1.5}}
    assert client.post("/api/agents", json=bad2, headers=admin).status_code == 422


def test_agent_update_bumps_version_and_keeps_history(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    prof = client.post("/api/agents", json={"name": "v1名", "system_prompt": "old"}, headers=admin).json()
    pid = prof["agent_id"]
    assert prof["version"] == "v1"

    upd = client.put(f"/api/agents/{pid}", json={"name": "v2名", "system_prompt": "new"}, headers=admin)
    assert upd.status_code == 200
    assert upd.json()["version"] == "v2"
    assert upd.json()["system_prompt"] == "new"

    versions = client.get(f"/api/agents/{pid}/versions", headers=admin).json()
    assert versions["current_version"] == "v2"
    # 历史含 v1 快照(改版不污染历史)
    assert any(v["version"] == "v1" and v["system_prompt"] == "old" for v in versions["versions"])


def test_agent_update_staff_forbidden(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    prof = client.post("/api/agents", json={"name": "p", "self_bookable": True}, headers=admin).json()
    staff = _auth(make_token(groups=["staff"]))
    r = client.put(f"/api/agents/{prof['agent_id']}", json={"name": "hack"}, headers=staff)
    assert r.status_code == 403  # self_bookable 仅 admin 可改


# ════════ 005/006 发起(预创建)════════
def test_launch_stays_scheduled_and_dispatches_ready(client, make_token, app_and_db):
    """新语义:发起 = 落 scheduled + 预创建下发(没有拨号);状态等 connected 事件推进。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin)
    r = client.post("/api/sessions", json=_mk_launch(prof["agent_id"], start_min=-1), headers=admin)
    assert r.status_code == 201
    sess = r.json()
    assert sess["origin"] == "hr"
    assert sess["status"] == "scheduled"  # 预创建成功不改状态(等考生连入)
    assert sess["agent_version"] == "v1"  # 版本快照
    # SessionEvents meta:scheduled + last_dispatch(会话就绪指令落库)
    meta = db.get_session_meta(sess["session_id"])
    assert meta["status"] == "scheduled"
    assert meta["last_dispatch"]["session_id"] == sess["session_id"]
    # 就绪指令不含电话字段
    for gone in ("platform", "dial_in_number", "conference_id", "caller_id_name"):
        assert gone not in meta["last_dispatch"]
    # rubric/questions 快照进了 meta(供 Evaluator 自包含打分)
    assert "rubric" in meta


def test_launch_future_meeting_stays_scheduled(client, make_token):
    """未来场次同样落 scheduled(考试窗未到,考生到点自行连入)。"""
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin)
    r = client.post("/api/sessions", json=_mk_launch(prof["agent_id"], start_min=30), headers=admin)
    assert r.status_code == 201
    sess = r.json()
    assert sess["origin"] == "hr"
    assert sess["status"] == "scheduled"


def test_staff_self_booking_stays_scheduled(client, make_token):
    """staff 自助预约落 scheduled(design contract)。"""
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin, name="check", self_bookable=True)
    staff = make_token(groups=["staff"], username="bob@corp.com")
    r = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=_auth(staff))
    assert r.status_code == 201
    sess = r.json()
    assert sess["origin"] == "staff" and sess["status"] == "scheduled"


# ════════ 005 重约 ════════
def test_reschedule_endpoint_removed(client, make_token, app_and_db):
    """会话级「重约」已删(即时开始、无预约):POST /api/sessions/{id}/reschedule 应 404/405(端点不存在)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin)
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=admin).json()
    sid = sess["session_id"]
    s = db.get_session(sid)
    s["status"] = "failed"
    db.put_session(s)
    # 端点已删:无匹配路由 → 404(或方法不允许 405),不再是 201/409。
    assert client.post(f"/api/sessions/{sid}/reschedule", headers=admin).status_code in (404, 405)


# ════════ 会话详情「对象」可读名(target_name 解析)════════
def test_session_detail_target_name_resolved(client, make_token, app_and_db):
    """详情 GET /api/sessions/{id} 把 target_id 解析成 target_name(Target.name),供前端展示可读名。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin)
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=admin).json()
    sid = sess["session_id"]
    # 造一个 Target 并绑到会话上(模拟 HR 代发起绑定对象)
    tgt = db.upsert_target_by_external_id("cand@corp.com", {"source": "admin", "name": "张三"})
    s = db.get_session(sid)
    s["target_id"] = tgt["target_id"]
    db.put_session(s)
    detail = client.get(f"/api/sessions/{sid}", headers=admin).json()
    assert detail["target_name"] == "张三"  # 解析出 Target.name(不是原始 target_id UUID)


def test_session_detail_target_name_falls_back_to_external_id(client, make_token, app_and_db):
    """Target 无 name(只有 external_id)→ target_name 回退 external_id(仍比 UUID 可读)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin)
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=admin).json()
    sid = sess["session_id"]
    # 直接造一个无 name 的 Target
    db.put_target({"target_id": "tgt_noname", "external_id": "noname@corp.com", "source": "admin"})
    s = db.get_session(sid)
    s["target_id"] = "tgt_noname"
    db.put_session(s)
    detail = client.get(f"/api/sessions/{sid}", headers=admin).json()
    assert detail["target_name"] == "noname@corp.com"


def test_session_detail_no_target_name_when_no_target(client, make_token, app_and_db):
    """无 target_id / 查不到 Target → 不补 target_name(前端回退 booked_by_email)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin)
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=admin).json()
    sid = sess["session_id"]
    # 该会话 target_id=None(admin 未绑对象)
    detail = client.get(f"/api/sessions/{sid}", headers=admin).json()
    assert detail.get("target_name") is None
    # target_id 指向不存在的 Target → 也不补(不崩)
    s = db.get_session(sid)
    s["target_id"] = "tgt_ghost"
    db.put_session(s)
    detail2 = client.get(f"/api/sessions/{sid}", headers=admin).json()
    assert detail2.get("target_name") is None


# ════════ 009 hangup ════════
def test_hangup_admin_only_and_completes(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin)
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=admin).json()
    sid = sess["session_id"]
    # 置 in_progress
    s = db.get_session(sid)
    s["status"] = "in_progress"
    db.put_session(s)

    # staff 不能 hangup
    staff = _auth(make_token(groups=["staff"], username="x@corp.com"))
    assert client.post(f"/api/sessions/{sid}/hangup", headers=staff).status_code == 403

    # admin hangup → completed + end_trigger;meta 置 completed(触发评估)
    r = client.post(f"/api/sessions/{sid}/hangup", headers=admin)
    assert r.status_code == 200
    assert r.json()["status"] == "completed"
    assert r.json()["end_trigger"] == "admin_hangup"
    assert db.get_session_meta(sid)["status"] == "completed"


def test_hangup_only_in_progress(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin)
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=admin).json()
    # scheduled 态 hangup → 409(仅 in_progress 可提前结束)
    assert client.post(f"/api/sessions/{sess['session_id']}/hangup", headers=admin).status_code == 409


# ════════ 011 staff 取消(即时开始转向后去 30min 锁:scheduled 即可取消)════════
def test_staff_cancel_scheduled_no_lock(client, make_token):
    """去 30min 锁:staff 的 scheduled 会话可直接取消(204),无时间窗锁定。"""
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin, name="check", self_bookable=True)
    staff = make_token(groups=["staff"], username="dan@corp.com")
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=_auth(staff)).json()
    sid = sess["session_id"]
    # 取消成功(204),无锁
    assert client.delete(f"/api/sessions/{sid}", headers=_auth(staff)).status_code == 204


# ════════ 010 结果复核双轨 ════════
def _seed_result(db, session_id: str, **kw):
    base = {
        "session_id": session_id, "agent_id": "agent_x", "rubric_mode": "per_question_check",
        "passed": False, "summary": "AI 判不通过", "review_status": "pending",
    }
    base.update(kw)
    db.put_result(base)


def test_result_get_authz(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin, name="c", self_bookable=True)
    bob = make_token(groups=["staff"], username="bob@corp.com")
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=_auth(bob)).json()
    sid = sess["session_id"]
    _seed_result(db, sid)

    # bob 看自己的
    assert client.get(f"/api/results/{sid}", headers=_auth(bob)).status_code == 200
    # carol 看不到(403)
    carol = make_token(groups=["staff"], username="carol@corp.com")
    assert client.get(f"/api/results/{sid}", headers=_auth(carol)).status_code == 403


def test_result_transcript_download_authz(client, make_token, app_and_db):
    """design contract 转写下载:整场转写,staff 只能取自己会话的(归属校验同结果)。"""
    app, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin, name="c", self_bookable=True)
    bob = make_token(groups=["staff"], username="bob@corp.com")
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=_auth(bob)).json()
    sid = sess["session_id"]
    db.put_transcript_event(sid, "2026-06-26T10:00:00.000Z", {"speaker": "ai", "text": "你好"})
    db.put_transcript_event(sid, "2026-06-26T10:00:05.000Z", {"speaker": "user", "text": "你好我在"})

    # bob 取自己会话的转写:200 + 有序两句
    r = client.get(f"/api/results/{sid}/transcript", headers=_auth(bob))
    assert r.status_code == 200
    body = r.json()
    assert body["session_id"] == sid
    assert [(ln["speaker"], ln["text"]) for ln in body["lines"]] == [("ai", "你好"), ("user", "你好我在")]
    # carol 取不到(403)
    carol = make_token(groups=["staff"], username="carol@corp.com")
    assert client.get(f"/api/results/{sid}/transcript", headers=_auth(carol)).status_code == 403


def test_result_recording_url_injected_when_present(client, make_token, app_and_db):
    """design contract 录音回放:录音存在时 GET 结果把 recording_url 填为限时预签名 URL;不存在则 None。"""
    app, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin, name="c", self_bookable=True)
    bob = make_token(groups=["staff"], username="bob@corp.com")
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=_auth(bob)).json()
    sid = sess["session_id"]
    _seed_result(db, sid)

    # 默认无录音(测试设置无桶)→ recording_url 为 None
    assert client.get(f"/api/results/{sid}", headers=_auth(bob)).json()["recording_url"] is None

    # 注入 fake recordings:有录音 → 返回预签名 URL
    class _FakeRec:
        def presigned_url(self, session_id):
            return f"https://signed.example/{session_id}.wav?token=abc"
    app.state.recordings = _FakeRec()
    got = client.get(f"/api/results/{sid}", headers=_auth(bob)).json()
    assert got["recording_url"] == f"https://signed.example/{sid}.wav?token=abc"


def test_result_get_tolerates_question_check_without_question(client, make_token, app_and_db):
    """真机根因 deployment validation:Evaluator 写的 question_checks 只含 index+passed(缺 question 题面)→
    ResultOut.question 原为必填 → GET /results 校验 500。现 question 可空,报告应 200 返回。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin, name="c", self_bookable=True)
    bob = make_token(groups=["staff"], username="bob@corp.com")
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=_auth(bob)).json()
    sid = sess["session_id"]
    # 复刻线上存的形态:question_checks 缺 question 字段
    _seed_result(db, sid, question_checks=[{"index": 1, "passed": False}], pass_ratio=0)
    r = client.get(f"/api/results/{sid}", headers=_auth(bob))
    assert r.status_code == 200  # 不再 500
    body = r.json()
    assert body["question_checks"][0]["passed"] is False
    assert body["question_checks"][0]["question"] is None  # 缺题面 → None,不报错


def test_result_review_override_keeps_ai_score(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin, name="c", self_bookable=True)
    bob = make_token(groups=["staff"], username="bob@corp.com")
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=_auth(bob)).json()
    sid = sess["session_id"]
    _seed_result(db, sid, passed=False)

    # staff 不能复核
    assert client.patch(f"/api/results/{sid}", json={"action": "approve"}, headers=_auth(bob)).status_code == 403

    # admin override 改判通过 → review_status=overridden,AI 原始 passed=False 仍保留
    r = client.patch(f"/api/results/{sid}", json={"action": "override", "passed": True, "note": "口头补充充分"}, headers=admin)
    assert r.status_code == 200
    body = r.json()
    assert body["review_status"] == "overridden"
    assert body["passed"] is False  # AI 原始分不被覆盖(双轨)
    stored = db.get_result(sid)
    assert stored["review_passed"] is True  # 人工改判写独立字段
    assert stored["reviewer"] == "alice@corp.com" or stored["reviewer"]  # admin 身份


def test_result_out_exposes_review_fields(client, make_token, app_and_db):
    """M2:override 后 GET 结果能看到 review_passed(人工改判可见,双轨)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    sid = "sess_m2_x"
    db.put_session({"session_id": sid, "booked_by": "z", "status": "completed",
                    "trigger": "manual", "agent_id": "p", "created_at": _future(0)})
    db.put_result({"session_id": sid, "passed": False, "pass_ratio": 0.3, "review_status": "pending"})
    client.patch(f"/api/results/{sid}", json={"action": "override", "passed": True}, headers=admin)
    got = client.get(f"/api/results/{sid}", headers=admin).json()
    assert got["passed"] is False  # AI 原始
    assert got["review_passed"] is True  # 人工改判(M2:模型暴露)
    assert got["pass_ratio"] == 0.3


# ════════ review 修复回归 ════════
def test_launch_rejects_user_without_role(client, make_token):
    """review:既非 admin 又非 staff 组的已认证用户不能发起(角色来自 Cognito 组)。"""
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin, name="c", self_bookable=True)
    # 无 groups 的 token(已认证但无角色)
    norole = _auth(make_token(groups=[]))
    r = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=norole)
    assert r.status_code == 403


def test_hangup_dispatches_rt_hangup_before_complete(client, make_token, app_and_db):
    """review 先下发实时服务挂断(meta.last_hangup)再置 completed。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    prof = _mk_agent(client, admin)
    sess = client.post("/api/sessions", json=_mk_launch(prof["agent_id"]), headers=admin).json()
    sid = sess["session_id"]
    s = db.get_session(sid)
    s["status"] = "in_progress"
    db.put_session(s)
    r = client.post(f"/api/sessions/{sid}/hangup", headers=admin)
    assert r.status_code == 200 and r.json()["status"] == "completed"
    meta = db.get_session_meta(sid)
    assert meta["status"] == "completed"
    assert meta["last_hangup"]["op"] == "hangup"  # 实时服务挂断指令已下发


# ════════ review 二轮残留修复回归 ════════
def test_staff_endpoints_reject_roleless_user(client, make_token, app_and_db):
    """review:无角色用户即便「拥有」会话也不能 delete(staff 自助类须 staff 角色)。
    即时开始转向后 PATCH 端点已删;会话级 reschedule 端点亦已删(无预约),只校验 delete。"""
    _, db = app_and_db
    # 直接造一条 booked_by=norole@corp.com 的会话(绕过 launch,模拟历史数据)
    sid = "sess_norole_x"
    db.put_session({"session_id": sid, "booked_by": "norole@corp.com", "status": "failed",
                    "trigger": "manual", "origin": "staff", "agent_id": "p", "created_at": _future(0)})
    norole = _auth(make_token(groups=[], username="norole@corp.com"))
    assert client.delete(f"/api/sessions/{sid}", headers=norole).status_code == 403


def test_result_review_approve(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    sid = "sess_approve_x"
    _seed_result(db, sid)
    # session 也要存在(authz 走 session 归属)—— admin 可访问任意,但 get_result 前先建 session
    db.put_session({"session_id": sid, "booked_by": "someone", "status": "completed",
                    "trigger": "manual", "agent_id": "agent_x", "created_at": _future(0)})
    r = client.patch(f"/api/results/{sid}", json={"action": "approve"}, headers=admin)
    assert r.status_code == 200 and r.json()["review_status"] == "approved"


# ════════ 总览统计聚合(按场景/Agent 分 + 通过率)════════
def _seed_session(db, sid, agent_id, *, status="completed", booked_by="admin@corp.com",
                  agent_name=None, origin="hr"):
    """直接造会话(绕 launch,精确控制 status/agent/归属),供 stats 聚合断言。"""
    s = {"session_id": sid, "agent_id": agent_id, "status": status, "trigger": "manual",
         "origin": origin, "booked_by": booked_by, "created_at": _future(0)}
    if agent_name:
        s["agent_snapshot"] = {"name": agent_name}
    db.put_session(s)


def test_session_stats_aggregates_by_agent_pass_rate(client, make_token, app_and_db):
    """按 Agent 聚合:total/completed/evaluated/passed + pass_rate=passed/evaluated。
    未出结果的会话计入 total 不计 evaluated(不拉低通过率)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    # Agent A:3 场完成,2 场有结果(1 pass 1 fail),1 场无结果(评测中)→ evaluated=2 passed=1 rate=0.5
    _seed_session(db, "s_a1", "agent_A", agent_name="口试官A")
    _seed_session(db, "s_a2", "agent_A", agent_name="口试官A")
    _seed_session(db, "s_a3", "agent_A", agent_name="口试官A")
    _seed_result(db, "s_a1", agent_id="agent_A", passed=True)
    _seed_result(db, "s_a2", agent_id="agent_A", passed=False)
    # s_a3 无结果(评测中)
    # Agent B:1 场完成 + 有结果(pass),1 场 failed(无结果)→ total=2 completed=1 evaluated=1 passed=1 rate=1.0
    _seed_session(db, "s_b1", "agent_B", agent_name="口试官B")
    _seed_session(db, "s_b2", "agent_B", agent_name="口试官B", status="failed")
    _seed_result(db, "s_b1", agent_id="agent_B", passed=True)

    r = client.get("/api/sessions/stats", headers=admin)
    assert r.status_code == 200
    agents = {a["agent_id"]: a for a in r.json()["agents"]}
    a = agents["agent_A"]
    assert a["agent_name"] == "口试官A"
    assert a["total"] == 3 and a["completed"] == 3
    assert a["evaluated"] == 2 and a["passed"] == 1
    assert abs(a["pass_rate"] - 0.5) < 1e-9
    b = agents["agent_B"]
    assert b["total"] == 2 and b["completed"] == 1
    assert b["evaluated"] == 1 and b["passed"] == 1
    assert abs(b["pass_rate"] - 1.0) < 1e-9
    # 按 total 倒序:A(3)在 B(2)前
    order = [a["agent_id"] for a in r.json()["agents"]]
    assert order.index("agent_A") < order.index("agent_B")


def test_session_stats_no_evaluated_pass_rate_none(client, make_token, app_and_db):
    """全场无结果(都在评测中/失败)→ evaluated=0 → pass_rate=None(前端显「—」不显 0%)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    _seed_session(db, "s_c1", "agent_C", agent_name="C", status="in_progress")
    _seed_session(db, "s_c2", "agent_C", agent_name="C", status="failed")
    r = client.get("/api/sessions/stats", headers=admin)
    a = {x["agent_id"]: x for x in r.json()["agents"]}["agent_C"]
    assert a["total"] == 2 and a["evaluated"] == 0 and a["passed"] == 0
    assert a["pass_rate"] is None


def test_session_stats_dimension_mode_pass_by_score(client, make_token, app_and_db):
    """dimension_score 模式无 passed 字段 → 按 overall_score >= 0.6 折算通过(与报告页同口径)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    _seed_session(db, "s_d1", "agent_D", agent_name="D")
    _seed_session(db, "s_d2", "agent_D", agent_name="D")
    # 无 passed,只有 overall_score:0.8 过、0.4 不过
    db.put_result({"session_id": "s_d1", "agent_id": "agent_D", "rubric_mode": "dimension_score",
                   "overall_score": 0.8, "review_status": "pending"})
    db.put_result({"session_id": "s_d2", "agent_id": "agent_D", "rubric_mode": "dimension_score",
                   "overall_score": 0.4, "review_status": "pending"})
    r = client.get("/api/sessions/stats", headers=admin)
    a = {x["agent_id"]: x for x in r.json()["agents"]}["agent_D"]
    assert a["evaluated"] == 2 and a["passed"] == 1  # 0.8 过、0.4 不过


def test_session_stats_review_passed_overrides_ai(client, make_token, app_and_db):
    """人工复核 review_passed 优先于 AI passed(与报告页 effectivePassed 同口径)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    _seed_session(db, "s_e1", "agent_E", agent_name="E")
    # AI 判不过,但人工改判过 → 计 passed
    _seed_result(db, "s_e1", agent_id="agent_E", passed=False, review_passed=True)
    r = client.get("/api/sessions/stats", headers=admin)
    a = {x["agent_id"]: x for x in r.json()["agents"]}["agent_E"]
    assert a["evaluated"] == 1 and a["passed"] == 1


def test_session_stats_staff_scoped_to_own(client, make_token, app_and_db):
    """staff 只统计自己的会话(归属隔离,不信前端);看不到他人会话。"""
    _, db = app_and_db
    _seed_session(db, "s_f1", "agent_F", booked_by="alice@corp.com", origin="staff", agent_name="F")
    _seed_session(db, "s_f2", "agent_F", booked_by="bob@corp.com", origin="staff", agent_name="F")
    _seed_result(db, "s_f1", agent_id="agent_F", passed=True)
    _seed_result(db, "s_f2", agent_id="agent_F", passed=False)
    # alice 只看到自己那 1 场(passed)→ evaluated=1 passed=1
    alice = _auth(make_token(groups=["staff"], username="alice@corp.com"))
    r = client.get("/api/sessions/stats", headers=alice)
    agents = {x["agent_id"]: x for x in r.json()["agents"]}
    assert agents["agent_F"]["total"] == 1
    assert agents["agent_F"]["evaluated"] == 1 and agents["agent_F"]["passed"] == 1
