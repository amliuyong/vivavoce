"""state_machine 单测 —— design contract 缩水版时间策略与状态机的权威逻辑。

覆盖:转移合法性、过期判定(created_at+N)、强制收尾(started_at+max_duration)、并发 admission。
(电话版的重试窗/Attempt/reaper 用例已删,VISION §1;meeting 时间窗/提醒钳制/staff 锁用例随即时开始转向删。)
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app import state_machine as sm


def _iso(dt: datetime) -> str:
    return dt.isoformat()


# ── 强制挂断(即时开始:唯一收尾预算 = started_at + max_duration_s)──
def test_hangup_at_is_max_duration_only():
    """meeting_end 已删,收尾时刻 = started_at + max_duration_s,end_trigger 恒 max_duration。"""
    started = datetime.fromisoformat("2026-06-20T10:00:00+00:00")
    hangup_at, trig = sm.compute_hangup_at(started_at=_iso(started), max_duration_s=1800)
    assert hangup_at == started + timedelta(seconds=1800) and trig == sm.END_MAX_DURATION


def test_hangup_at_default_max_duration():
    """默认 max_duration_s=1800(30min,即时开始转向后的新默认)。"""
    started = datetime.fromisoformat("2026-06-20T10:00:00+00:00")
    hangup_at, trig = sm.compute_hangup_at(started_at=_iso(started))
    assert hangup_at == started + timedelta(minutes=30) and trig == sm.END_MAX_DURATION


# ── 并发 admission ──
def test_admission_full_queues_without_failing():
    """满载 → 不允许但非失败(reason None,排队让位)。"""
    allowed, reason = sm.admission_check(active_count=8, max_concurrency=8)
    assert not allowed and reason is None


def test_admission_allows_under_capacity():
    allowed, reason = sm.admission_check(active_count=3, max_concurrency=8)
    assert allowed and reason is None


# ── 过期判定(即时开始:created_at + N 分钟未连入)──
def test_is_expired_when_scheduled_past_created_plus_n():
    """scheduled 且 now ≥ created_at + N(创建后 N 分钟始终未连入)→ 过期。"""
    created = "2026-06-20T11:00:00+00:00"
    assert sm.is_expired(now="2026-06-20T11:30:00+00:00", created_at=created,
                         expire_after_min=30, status=sm.SCHEDULED) is True
    assert sm.is_expired(now="2026-06-20T12:00:00+00:00", created_at=created,
                         expire_after_min=30, status=sm.SCHEDULED) is True


def test_is_expired_false_within_window():
    """创建后未满 N 分钟 → 还不算过期(用户随时可能连入)。"""
    created = "2026-06-20T11:00:00+00:00"
    assert sm.is_expired(now="2026-06-20T11:29:59+00:00", created_at=created,
                         expire_after_min=30, status=sm.SCHEDULED) is False


def test_is_expired_false_for_non_scheduled_status():
    """非 scheduled(已连入/终态)不判过期(in_progress 的超时走 compute_hangup_at 收尾)。"""
    created = "2026-06-20T11:00:00+00:00"
    now = "2026-06-20T13:00:00+00:00"
    assert sm.is_expired(now=now, created_at=created, expire_after_min=30, status=sm.IN_PROGRESS) is False
    assert sm.is_expired(now=now, created_at=created, expire_after_min=30, status=sm.COMPLETED) is False
    assert sm.is_expired(now=now, created_at=created, expire_after_min=30, status=sm.FAILED) is False


# ── 状态转移合法性(单层状态机)──
def test_legal_transitions():
    assert sm.can_transition(sm.SCHEDULED, sm.IN_PROGRESS)  # 客户端连入
    assert sm.can_transition(sm.SCHEDULED, sm.FAILED)  # no_show / 取消
    assert sm.can_transition(sm.IN_PROGRESS, sm.COMPLETED)
    assert sm.can_transition(sm.IN_PROGRESS, sm.FAILED)


def test_illegal_transitions_rejected():
    assert not sm.can_transition(sm.COMPLETED, sm.IN_PROGRESS)
    assert not sm.can_transition(sm.FAILED, sm.IN_PROGRESS)
    assert not sm.can_transition(sm.SCHEDULED, sm.COMPLETED)  # 必须经 in_progress
    assert not sm.can_transition(sm.IN_PROGRESS, sm.SCHEDULED)  # 不可回退
    with pytest.raises(sm.StateError):
        sm.assert_transition(sm.COMPLETED, sm.IN_PROGRESS)


def test_is_terminal():
    assert sm.is_terminal(sm.COMPLETED) and sm.is_terminal(sm.FAILED)
    assert not sm.is_terminal(sm.IN_PROGRESS)
    assert not sm.is_terminal(sm.SCHEDULED)


def test_active_states():
    """活动态 = 非终态(并发闸门/引用挡删的单一来源)。"""
    assert sm.ACTIVE_STATES == frozenset({sm.SCHEDULED, sm.IN_PROGRESS})


# ── parse_iso ──
def test_parse_iso_z_suffix_and_naive():
    from datetime import UTC

    dt = sm.parse_iso("2026-06-20T10:00:00Z")
    assert dt.tzinfo is not None
    naive = sm.parse_iso("2026-06-20T10:00:00")
    assert naive.tzinfo is UTC  # naive 视作 UTC
