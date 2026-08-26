"""016 候选人对外自助 e2e —— HR 时段池/签链接(Cognito)+ 候选人 token 流程(无账号)。

覆盖 design contract:时段池、一次性 token、选时段落 Session(origin=candidate)、防双占、
改/取消窗口锁、候选人侧结果隔离(不见评分)、知情同意、对外鉴权 fail-closed。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _future(minutes: int) -> str:
    return (datetime.now(UTC) + timedelta(minutes=minutes)).isoformat()


# 面试官 Agent 用 dimension_score(开放式面试,无预设题库即纯人设对话;design contract:per_question_check 才要求有题)
_DIM_RUBRIC = {"mode": "dimension_score", "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}


def _seed_agent(client, admin: dict) -> str:
    return client.post("/api/agents", json={"name": "面试官", "rubric": _DIM_RUBRIC},
                       headers=admin).json()["agent_id"]


def _add_slot(client, admin, aid, eng="eng-2026", start_min=120, dur=45) -> str:
    body = {
        "engagement_id": eng, "agent_id": aid,
        "meeting_start": _future(start_min), "meeting_end": _future(start_min + dur),
    }
    r = client.post("/api/engagements/slots", json=body, headers=admin)
    assert r.status_code == 201, r.text
    return r.json()["slot_id"]


def _issue_link(client, admin, cid="cand@x.com", eng="eng-2026") -> str:
    r = client.post("/api/engagements/links",
                    json={"candidate_id": cid, "engagement_id": eng}, headers=admin)
    assert r.status_code == 201, r.text
    return r.json()["token"]


# ── HR 侧 admin-only ──
def test_slot_and_link_admin_only(client, make_token):
    staff = _auth(make_token(groups=["staff"], username="s@corp.com"))
    assert client.post("/api/engagements/slots", json={}, headers=staff).status_code == 403
    assert client.post("/api/engagements/links", json={}, headers=staff).status_code == 403


def test_issue_link_requires_slot(client, make_token):
    """修:无时段的环节不得签发链接(否则候选人打开后无可选时段)。有时段后才放行。"""
    admin = _auth(make_token(groups=["admin"]))
    # 无时段环节 → 400
    r = client.post("/api/engagements/links",
                    json={"candidate_id": "c@x.com", "engagement_id": "eng-empty"}, headers=admin)
    assert r.status_code == 400, r.text
    assert "时段" in r.json()["detail"]
    # 加一个时段后 → 放行
    aid = client.post("/api/agents", json={"name": "面试官", "rubric": _DIM_RUBRIC},
                      headers=admin).json()["agent_id"]
    _add_slot(client, admin, aid, eng="eng-empty")
    r = client.post("/api/engagements/links",
                    json={"candidate_id": "c@x.com", "engagement_id": "eng-empty"}, headers=admin)
    assert r.status_code == 201, r.text


# ── 候选人端点 fail-closed(无 token / 坏 token) ──
def test_candidate_endpoints_require_token(client):
    assert client.get("/api/candidate/slots").status_code == 401
    assert client.get("/api/candidate/slots?token=garbage").status_code == 401
    assert client.post("/api/candidate/book", json={"slot_id": "x", "consent": True}).status_code == 401


# ── 候选人完整流程:看时段 → 选 → 状态 ──
def test_candidate_full_flow(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot_id = _add_slot(client, admin, aid)
    token = _issue_link(client, admin)

    # 候选人看可选时段(脱敏:只 slot_id + 起止)
    slots = client.get(f"/api/candidate/slots?token={token}").json()
    assert len(slots) == 1 and slots[0]["slot_id"] == slot_id
    assert set(slots[0].keys()) <= {"slot_id", "meeting_start", "meeting_end"}

    # 选时段(带同意)
    r = client.post(f"/api/candidate/book?token={token}",
                    json={"slot_id": slot_id, "consent": True})
    assert r.status_code == 200, r.text
    sid = r.json()["session_id"]
    sess = db.get_session(sid)
    assert sess["origin"] == "candidate" and sess["status"] == "scheduled"
    assert sess["trigger"] == "manual"
    # 知情同意落库(合规举证:时间戳 + 文案版本 + 跨境条款标记)
    consent = sess.get("consent")
    assert consent and consent["granted"] is True
    assert consent["version"] and consent["at"]  # 文案版本 + 时间戳齐备
    assert consent["includes_cross_border"] is True

    # 该时段已被认领,不再出现在可选列表
    assert client.get(f"/api/candidate/slots?token={token}").json() == []

    # 候选人状态:只见流程态(booked),不含评分/转写
    st = client.get(f"/api/candidate/status?token={token}").json()
    assert st["booked"] is True and st["stage"] == "booked"
    assert "score" not in st and "summary" not in st


def test_candidate_book_requires_consent(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot_id = _add_slot(client, admin, aid)
    token = _issue_link(client, admin)
    # 未同意 → 409
    r = client.post(f"/api/candidate/book?token={token}",
                    json={"slot_id": slot_id, "consent": False})
    assert r.status_code == 409 and "同意" in r.json()["detail"]


# ── 防双占:两候选人抢同一时段 ──
def test_slot_double_claim_prevented(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot_id = _add_slot(client, admin, aid)
    t1 = _issue_link(client, admin, cid="a@x.com")
    t2 = _issue_link(client, admin, cid="b@x.com")
    r1 = client.post(f"/api/candidate/book?token={t1}", json={"slot_id": slot_id, "consent": True})
    assert r1.status_code == 200
    # 第二人抢同一时段 → 409
    r2 = client.post(f"/api/candidate/book?token={t2}", json={"slot_id": slot_id, "consent": True})
    assert r2.status_code == 409


# ── 取消释放时段回池 ──
def test_candidate_cancel_releases_slot(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot_id = _add_slot(client, admin, aid, start_min=120)  # 距开始 120min > 30min 锁,可取消
    token = _issue_link(client, admin)
    client.post(f"/api/candidate/book?token={token}", json={"slot_id": slot_id, "consent": True})
    # 取消
    r = client.post(f"/api/candidate/cancel?token={token}")
    assert r.status_code == 200 and r.json()["cancelled"] is True
    # 时段回池,可再选
    slots = client.get(f"/api/candidate/slots?token={token}").json()
    assert any(s["slot_id"] == slot_id for s in slots)


def test_candidate_cancel_locked_within_30min(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot_id = _add_slot(client, admin, aid, start_min=12)  # 距开始 12min < 30min 锁
    token = _issue_link(client, admin)
    client.post(f"/api/candidate/book?token={token}", json={"slot_id": slot_id, "consent": True})
    r = client.post(f"/api/candidate/cancel?token={token}")
    assert r.status_code == 409 and "30" in r.json()["detail"]


# ── review:改约到另一时段(原子换:先认领新再释放旧)──
def test_candidate_reschedule(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot1 = _add_slot(client, admin, aid, start_min=120)
    slot2 = _add_slot(client, admin, aid, start_min=240)
    token = _issue_link(client, admin)
    client.post(f"/api/candidate/book?token={token}", json={"slot_id": slot1, "consent": True})
    # 改约到 slot2
    r = client.post(f"/api/candidate/reschedule?token={token}", json={"new_slot_id": slot2})
    assert r.status_code == 200 and r.json()["new_slot_id"] == slot2
    # slot1 回池(open),slot2 被认领
    assert db.get_slot(slot1)["status"] == "open"
    assert db.get_slot(slot2)["status"] == "claimed"


def test_candidate_reschedule_to_claimed_slot_rejected(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot1 = _add_slot(client, admin, aid, start_min=120)
    slot2 = _add_slot(client, admin, aid, start_min=240)
    ta = _issue_link(client, admin, cid="a@x.com")
    tb = _issue_link(client, admin, cid="b@x.com")
    client.post(f"/api/candidate/book?token={ta}", json={"slot_id": slot1, "consent": True})
    client.post(f"/api/candidate/book?token={tb}", json={"slot_id": slot2, "consent": True})
    # a 想改约到 slot2(已被 b 占)→ 409,a 的 slot1 不动
    r = client.post(f"/api/candidate/reschedule?token={ta}", json={"new_slot_id": slot2})
    assert r.status_code == 409


def test_candidate_reschedule_locked_within_30min(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot1 = _add_slot(client, admin, aid, start_min=12)  # 锁内
    slot2 = _add_slot(client, admin, aid, start_min=240)
    token = _issue_link(client, admin)
    client.post(f"/api/candidate/book?token={token}", json={"slot_id": slot1, "consent": True})
    r = client.post(f"/api/candidate/reschedule?token={token}", json={"new_slot_id": slot2})
    assert r.status_code == 409 and "30" in r.json()["detail"]


# ── review 后候选人只见 finished,不见评分/转写/录音 ──
def test_candidate_no_results_after_completed(client, make_token, app_and_db):
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot_id = _add_slot(client, admin, aid)
    token = _issue_link(client, admin)
    sid = client.post(f"/api/candidate/book?token={token}",
                      json={"slot_id": slot_id, "consent": True}).json()["session_id"]
    sess = db.get_session(sid)
    sess["status"] = "completed"
    db.put_session(sess)
    db.put_result({"session_id": sid, "overall_score": 85, "summary": "表现优秀",
                   "dimension_scores": [{"name": "技术", "score": 9, "max_score": 10}]})
    st = client.get(f"/api/candidate/status?token={token}").json()
    assert st["stage"] == "finished"
    # 绝不泄露评分/总结/转写
    for leak in ("overall_score", "summary", "dimension_scores", "transcript", "score"):
        assert leak not in st


# ── review:候选人会话不混入 admin 单场列表 ──
def test_candidate_session_excluded_from_single_list(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot_id = _add_slot(client, admin, aid)
    token = _issue_link(client, admin)
    client.post(f"/api/candidate/book?token={token}", json={"slot_id": slot_id, "consent": True})
    single = client.get("/api/sessions", headers=admin).json()
    assert [s for s in single if s.get("origin") == "candidate"] == []


# ── 时段不属于本环节 / 不可用 ──
def test_book_slot_wrong_engagement(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    slot_id = _add_slot(client, admin, aid, eng="eng-A")
    _add_slot(client, admin, aid, eng="eng-B")  # eng-B 也需有时段才能签链接(签链接前置校验)
    token = _issue_link(client, admin, eng="eng-B")  # 不同环节的 token
    # 用 eng-B 的 token 去订 eng-A 的时段 → 跨环节,拒绝(409)
    r = client.post(f"/api/candidate/book?token={token}", json={"slot_id": slot_id, "consent": True})
    assert r.status_code == 409


def test_candidate_link_ttl_capped():
    """一次性链接 ttl 封顶(合规:防 HR 误发数年有效链接)。上界 336h(14 天)。"""
    import pytest
    from pydantic import ValidationError

    from app.models import CandidateLinkIn
    # 合法
    CandidateLinkIn(candidate_id="c1", engagement_id="e1", ttl_hours=336)
    # 超上界 → 拒
    with pytest.raises(ValidationError):
        CandidateLinkIn(candidate_id="c1", engagement_id="e1", ttl_hours=337)
    with pytest.raises(ValidationError):
        CandidateLinkIn(candidate_id="c1", engagement_id="e1", ttl_hours=0)


def test_candidate_join_after_booking(client, make_token, app_and_db):
    """候选人连入(design contract-C):预约后凭 token 拿 join_token(定位自己的会话,不传 session_id)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    aid = _seed_agent(client, admin)
    # 时段窗设在"现在附近"(可连入:join 下界 = meeting_start-15min)
    body = {"engagement_id": "eng-J", "agent_id": aid,
            "meeting_start": _future(2), "meeting_end": _future(62)}
    slot_id = client.post("/api/engagements/slots", json=body, headers=admin).json()["slot_id"]
    token = client.post("/api/engagements/links",
                        json={"candidate_id": "cj@x.com", "engagement_id": "eng-J"},
                        headers=admin).json()["token"]
    # 未预约先 join → 409
    r0 = client.get(f"/api/candidate/join?token={token}")
    assert r0.status_code == 409 and "预约" in r0.json()["detail"]
    # 预约后 join → 拿 join_token
    client.post(f"/api/candidate/book?token={token}", json={"slot_id": slot_id, "consent": True})
    r = client.get(f"/api/candidate/join?token={token}")
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["join_token"].startswith("v1.") and out["ws_path"] == "/rt/ws"
    assert out["expires_at"]


def test_candidate_join_requires_token(client):
    """候选人 join fail-closed:无/坏 token → 401。"""
    assert client.get("/api/candidate/join").status_code == 401
    assert client.get("/api/candidate/join?token=garbage").status_code == 401
