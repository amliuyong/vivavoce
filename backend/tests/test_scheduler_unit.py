"""session scheduler 单测 —— design contract 缩水版调度(过期判定 / max_duration 强制收尾)。

复用 conftest 的 moto DDB(真打表,不 mock)。Dispatcher 默认 RecordingDispatcher(落库),
验证调度决策正确、状态推进符合状态机。**scheduled 到点不发起任何东西**(没有拨号;
客户端自己连入,状态由事件回调推进)——调度器对 scheduled 只做过期判定(created_at + N 未连入)。
meeting 时间窗已随「即时开始」转向删除(deployment validation):过期锚 created_at、收尾锚 started_at + max_duration_s。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.db import Db
from app.scheduler import tick
from app.session_service import SessionService


@pytest.fixture
def db(app_and_db):
    _, d = app_and_db
    return d


def _now() -> datetime:
    return datetime.now(UTC)


def _put_agent(db: Db) -> str:
    pid = "prof_sched"
    db.put_agent({"agent_id": pid, "version": "v1", "name": "p", "system_prompt": "",
                  "rubric": {"mode": "per_question_check", "pass_threshold": 0.8},
                  "engine": {}, "self_bookable": True})
    return pid


def _put_session(db: Db, **kw) -> dict:
    base = {
        "session_id": kw.get("session_id", "sess_sched_1"),
        "agent_id": kw.get("agent_id", "prof_sched"),
        "status": "scheduled",
        "trigger": "manual",
        "origin": "staff",
        "booked_by": "u@corp.com",
        "created_at": _now().isoformat(),
    }
    base.update(kw)
    db.put_session(base)
    db.put_session_meta(base["session_id"], {"status": base["status"], "agent_id": base["agent_id"],
                                             "rubric": {}, "questions": []})
    return base


def test_scheduled_within_expire_window_skipped(db):
    """创建后未满 N 分钟的 scheduled → 不动(等客户端连入,没有拨号动作)。"""
    _put_agent(db)
    now = _now()
    _put_session(db, status="scheduled", created_at=(now - timedelta(minutes=5)).isoformat())
    service = SessionService(db, max_concurrency=8)
    counts = tick(db, service, now=now, expire_after_min=30)
    assert counts["no_show"] == 0 and counts["skipped"] == 1
    assert db.get_session("sess_sched_1")["status"] == "scheduled"  # 保持等待,未被推进


def test_scheduled_past_expire_window_failed(db):
    """过期判定:scheduled 且 now ≥ created_at + N(用户始终未连入)→ failed(fail_reason 沿用 no_show)。"""
    _put_agent(db)
    now = _now()
    _put_session(db, status="scheduled", created_at=(now - timedelta(minutes=31)).isoformat())
    service = SessionService(db, max_concurrency=8)
    counts = tick(db, service, now=now, expire_after_min=30)
    assert counts["no_show"] == 1 and counts["failed"] == 1
    s = db.get_session("sess_sched_1")
    assert s["status"] == "failed" and s["fail_reason"] == "no_show"
    assert s["ended_at"]
    # meta 也落终态(供 Evaluator/前端一致视图)
    assert db.get_session_meta("sess_sched_1")["status"] == "failed"


def test_scheduled_far_future_expire_min_skipped(db):
    """expire_after_min 很大时,即便创建已久也未过期 → 跳过(验证 N 参数生效)。"""
    _put_agent(db)
    now = _now()
    _put_session(db, status="scheduled", created_at=(now - timedelta(minutes=59)).isoformat())
    service = SessionService(db, max_concurrency=8)
    counts = tick(db, service, now=now, expire_after_min=120)  # 2h 窗,才过 59min
    assert counts["skipped"] == 1 and counts["failed"] == 0
    assert db.get_session("sess_sched_1")["status"] == "scheduled"


def test_expired_emits_webhook(db):
    """过期落终态时发 session.failed webhook(design contract,fail_reason 沿用 no_show)。"""
    _put_agent(db)
    now = _now()
    _put_session(db, status="scheduled", created_at=(now - timedelta(minutes=31)).isoformat())
    fired = []
    service = SessionService(db, max_concurrency=8,
                             webhook_emitter=lambda et, data: fired.append((et, data)))
    tick(db, service, now=now, expire_after_min=30)
    assert fired and fired[0][0] == "session.failed"
    assert fired[0][1]["fail_reason"] == "no_show"


def test_completed_sessions_skipped(db):
    _put_agent(db)
    now = _now()
    _put_session(db, status="completed", created_at=(now - timedelta(minutes=60)).isoformat())
    service = SessionService(db, max_concurrency=8)
    counts = tick(db, service, now=now, expire_after_min=30)
    assert counts == {"no_show": 0, "reaped": 0, "skipped": 1, "errored": 0, "failed": 0}


def test_in_progress_past_max_duration_force_hangup(db):
    """design contract backstop:in_progress 会话过了 started_at + max_duration_s → 控制面强制收尾(hangup + completed)。"""
    _put_agent(db)
    now = _now()
    _put_session(
        db, session_id="sess_overrun", status="in_progress",
        started_at=(now - timedelta(minutes=31)).isoformat(),  # 超过 30min 上限
        engine={"max_duration_s": 1800},
    )
    service = SessionService(db, max_concurrency=8)
    counts = tick(db, service, now=now)
    assert counts["reaped"] == 1
    s = db.get_session("sess_overrun")
    assert s["status"] == "completed"
    assert s["end_trigger"] == "max_duration"


def test_in_progress_before_max_duration_skipped(db):
    """in_progress 但未到 max_duration 上限 → 不收尾(skipped)。"""
    _put_agent(db)
    now = _now()
    _put_session(
        db, session_id="sess_live", status="in_progress",
        started_at=(now - timedelta(minutes=5)).isoformat(),
        engine={"max_duration_s": 1800},  # 30min 上限,才过 5min
    )
    service = SessionService(db, max_concurrency=8)
    counts = tick(db, service, now=now)
    assert counts["reaped"] == 0 and counts["skipped"] == 1
    assert db.get_session("sess_live")["status"] == "in_progress"


def test_in_progress_reads_max_duration_from_agent_snapshot(db):
    """max_duration_s 从 agent_snapshot.engine 读(build_session_record 不写顶层 engine key)。
    回归:此前 scheduler 读 session['engine'] 恒空 → 总回退 1800,配了 3600 的 Agent 会被提前 30min 腰斩。"""
    _put_agent(db)
    now = _now()
    # Agent 配 3600(60min);会话已跑 45min —— 若错读成默认 1800 会误收尾,正确应跳过。
    _put_session(
        db, session_id="sess_60min", status="in_progress",
        started_at=(now - timedelta(minutes=45)).isoformat(),
        agent_snapshot={"engine": {"max_duration_s": 3600}},
    )
    service = SessionService(db, max_concurrency=8)
    counts = tick(db, service, now=now)
    assert counts["reaped"] == 0 and counts["skipped"] == 1  # 45min < 60min 上限,不收尾
    assert db.get_session("sess_60min")["status"] == "in_progress"


def test_in_progress_no_started_at_skipped(db):
    """in_progress 但缺 started_at(异常)→ 跳过,不误收尾。"""
    _put_agent(db)
    now = _now()
    _put_session(db, session_id="sess_nostart", status="in_progress", engine={"max_duration_s": 1800})
    service = SessionService(db, max_concurrency=8)
    counts = tick(db, service, now=now)
    assert counts["skipped"] == 1 and counts["reaped"] == 0
