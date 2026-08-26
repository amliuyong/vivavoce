"""会话发起时的题库固化 e2e(design contract)—— 端到端验证控制面合成:

  建题库 → 建 Agent(策略) → 发起会话 → session.resolved_questions 已固化 + meta.questions 一致;
  + per_question_check 无题 fail-fast;+ staff 走 Agent 默认题库;+ 重拨复用固化题目。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

_DIM_RUBRIC = {"mode": "dimension_score", "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}
_CHECK_RUBRIC = {"mode": "per_question_check", "pass_threshold": 0.8}


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _admin(make_token) -> dict:
    return _auth(make_token(groups=["admin"]))


def _future_window() -> tuple[str, str]:
    """已开始的会议窗(HR 即时发起会直拨;meeting_start 在过去几分钟,仍在窗内)。"""
    now = datetime.now(UTC)
    return (now - timedelta(minutes=1)).isoformat(), (now + timedelta(hours=1)).isoformat()


def _launch_body(agent_id: str, **extra) -> dict:
    start, end = _future_window()
    body = {
        "agent_id": agent_id,
        "meeting_start": start, "meeting_end": end,
    }
    body.update(extra)
    return body


def test_launch_resolves_and_freezes_questions(client, make_token, app_and_db):
    """admin 发起选题库 → meta.questions = 解析后的题目(sequential 全量保序)。"""
    _, db = app_and_db
    qb = client.post("/api/question-banks", json={
        "name": "题库", "questions": [{"text": "Q0"}, {"text": "Q1"}, {"text": "Q2"}],
    }, headers=_admin(make_token)).json()
    aid = client.post("/api/agents", json={
        "name": "检查官", "rubric": _CHECK_RUBRIC, "question_strategy": "sequential",
    }, headers=_admin(make_token)).json()["agent_id"]

    r = client.post("/api/sessions",
                    json=_launch_body(aid, question_bank_id=qb["question_bank_id"]),
                    headers=_admin(make_token))
    assert r.status_code == 201
    sid = r.json()["session_id"]
    assert r.json()["question_bank_id"] == qb["question_bank_id"]

    # session 固化了 resolved_questions
    session = db.get_session(sid)
    assert [q["text"] for q in session["resolved_questions"]] == ["Q0", "Q1", "Q2"]
    # meta.questions 与之一致(evaluator 据此打分)
    meta = db.get_session_meta(sid)
    assert [q["text"] for q in meta["questions"]] == ["Q0", "Q1", "Q2"]
    assert meta["agent_id"] == aid


def test_per_question_check_no_bank_rejected(client, make_token):
    """per_question_check Agent 不挂题库发起 → 422 fail-fast(design contract)。"""
    aid = client.post("/api/agents", json={
        "name": "逐题检查", "rubric": _CHECK_RUBRIC,
    }, headers=_admin(make_token)).json()["agent_id"]
    r = client.post("/api/sessions", json=_launch_body(aid), headers=_admin(make_token))
    assert r.status_code == 422


def test_dimension_score_no_bank_ok(client, make_token, app_and_db):
    """dimension_score Agent 不挂题库 → 纯人设对话,正常发起(resolved_questions 为空)。"""
    _, db = app_and_db
    aid = client.post("/api/agents", json={
        "name": "开放面试", "rubric": _DIM_RUBRIC,
    }, headers=_admin(make_token)).json()["agent_id"]
    r = client.post("/api/sessions", json=_launch_body(aid), headers=_admin(make_token))
    assert r.status_code == 201
    session = db.get_session(r.json()["session_id"])
    assert session.get("resolved_questions") == []


def test_staff_uses_agent_default_bank(client, make_token, app_and_db):
    """staff 自助不传题库 → 用 Agent.default_question_bank_id(design contract)。"""
    _, db = app_and_db
    qb = client.post("/api/question-banks", json={
        "name": "员工题库", "questions": [{"text": "S0"}, {"text": "S1"}],
    }, headers=_admin(make_token)).json()
    aid = client.post("/api/agents", json={
        "name": "自助检查", "rubric": _CHECK_RUBRIC, "self_bookable": True,
        "question_strategy": "sequential", "default_question_bank_id": qb["question_bank_id"],
    }, headers=_admin(make_token)).json()["agent_id"]

    # staff 发起(未来时段,落 scheduled);body 不带 question_bank_id
    start = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    end = (datetime.now(UTC) + timedelta(hours=3)).isoformat()
    r = client.post("/api/sessions", json={
        "agent_id": aid, "meeting_start": start, "meeting_end": end,
    }, headers=_auth(make_token(groups=["staff"])))
    assert r.status_code == 201
    session = db.get_session(r.json()["session_id"])
    assert session["question_bank_id"] == qb["question_bank_id"]
    assert [q["text"] for q in session["resolved_questions"]] == ["S0", "S1"]


def test_staff_question_bank_override_ignored(client, make_token, app_and_db):
    """staff 传 question_bank_id 被忽略(只用 Agent 预设,design contract)。"""
    _, db = app_and_db
    default_qb = client.post("/api/question-banks", json={
        "name": "预设", "questions": [{"text": "DEF"}],
    }, headers=_admin(make_token)).json()
    other_qb = client.post("/api/question-banks", json={
        "name": "别的", "questions": [{"text": "OTHER"}],
    }, headers=_admin(make_token)).json()
    aid = client.post("/api/agents", json={
        "name": "自助", "rubric": _CHECK_RUBRIC, "self_bookable": True,
        "default_question_bank_id": default_qb["question_bank_id"],
    }, headers=_admin(make_token)).json()["agent_id"]

    start = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    end = (datetime.now(UTC) + timedelta(hours=3)).isoformat()
    r = client.post("/api/sessions", json={
        "agent_id": aid, "meeting_start": start, "meeting_end": end,
        "question_bank_id": other_qb["question_bank_id"],  # 试图覆盖 → 被忽略
    }, headers=_auth(make_token(groups=["staff"])))
    assert r.status_code == 201
    session = db.get_session(r.json()["session_id"])
    assert session["question_bank_id"] == default_qb["question_bank_id"]  # 仍用 Agent 预设
    assert [q["text"] for q in session["resolved_questions"]] == ["DEF"]


def test_agent_default_bank_must_exist(client, make_token):
    """default_question_bank_id 指向不存在题库 → 422(review,不让悬挂默认入库)。"""
    r = client.post("/api/agents", json={
        "name": "悬挂默认", "rubric": _DIM_RUBRIC, "default_question_bank_id": "qb_nonexistent",
    }, headers=_admin(make_token))
    assert r.status_code == 422


def test_admin_explicit_none_clears_agent_default(client, make_token, app_and_db):
    """admin 显式选「无题库」→ 清掉 Agent 默认题库,纯人设对话(review)。"""
    _, db = app_and_db
    qb = client.post("/api/question-banks", json={
        "name": "默认库", "questions": [{"text": "D0"}],
    }, headers=_admin(make_token)).json()
    aid = client.post("/api/agents", json={
        "name": "维度面试", "rubric": _DIM_RUBRIC,
        "default_question_bank_id": qb["question_bank_id"],
    }, headers=_admin(make_token)).json()["agent_id"]

    # 显式传空串 question_bank_id → 清掉默认(纯人设)
    r = client.post("/api/sessions", json=_launch_body(aid, question_bank_id=""),
                    headers=_admin(make_token))
    assert r.status_code == 201
    session = db.get_session(r.json()["session_id"])
    assert session.get("resolved_questions") == []  # 无题
    assert session.get("question_bank_id") is None

    # 省略 question_bank_id → 回退 Agent 默认
    r2 = client.post("/api/sessions", json=_launch_body(aid), headers=_admin(make_token))
    session2 = db.get_session(r2.json()["session_id"])
    assert session2["question_bank_id"] == qb["question_bank_id"]
    assert [q["text"] for q in session2["resolved_questions"]] == ["D0"]


def test_scheduled_dispatch_uses_frozen_agent_snapshot(client, make_token, app_and_db):
    """staff 预约后 admin 改 Agent 的 system_prompt/engine → 到点拨叫仍用创建时快照(review)。"""
    _, db = app_and_db
    aid = client.post("/api/agents", json={
        "name": "自助", "rubric": _DIM_RUBRIC, "self_bookable": True,
        "system_prompt": "原始人设", "engine": {"engine_type": "three_stage", "voice": "male_std"},
    }, headers=_admin(make_token)).json()["agent_id"]
    # staff 预约(未来时段,落 scheduled)
    start = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    end = (datetime.now(UTC) + timedelta(hours=3)).isoformat()
    sid = client.post("/api/sessions", json={
        "agent_id": aid, "meeting_start": start, "meeting_end": end,
    }, headers=_auth(make_token(groups=["staff"]))).json()["session_id"]

    # admin 改 Agent(prompt + voice)
    client.put(f"/api/agents/{aid}", json={
        "name": "自助", "rubric": _DIM_RUBRIC, "self_bookable": True,
        "system_prompt": "改后人设", "engine": {"engine_type": "three_stage", "voice": "female_std"},
    }, headers=_admin(make_token))

    # 会话快照仍是原始(发起拨叫会用它,而非 live v2)
    session = db.get_session(sid)
    assert session["agent_snapshot"]["system_prompt"] == "原始人设"
    assert session["agent_snapshot"]["engine"]["voice"] == "male_std"
    assert session["agent_version"] == "v1"


def test_difficulty_coercion_accepts_bad_values(client, make_token, app_and_db):
    """题库题目 difficulty 越界/非整数在 API 入口宽容归一,不 422(design contract review)。"""
    _, db = app_and_db
    r = client.post("/api/question-banks", json={
        "name": "脏难度", "questions": [
            {"text": "越界高", "difficulty": 99},
            {"text": "越界低", "difficulty": 0},
            {"text": "缺省"},
        ],
    }, headers=_admin(make_token))
    assert r.status_code == 201
    qs = r.json()["questions"]
    assert qs[0]["difficulty"] == 5  # 99 → 钳到 5
    assert qs[1]["difficulty"] == 1  # 0 → 钳到 1
    assert qs[2]["difficulty"] == 3  # 缺省 → 3
