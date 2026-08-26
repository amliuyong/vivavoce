"""会话状态机与时间策略 —— design contract 缩水版的权威实现(纯逻辑,无 IO,易单测)。

单层状态(电话版的 Attempt 层/拨号态/重试窗已随电话链路删除,VISION §3;
预约时间窗 meeting_start/end 随「即时开始」产品转向删除,deployment validation):
  Session: scheduled → in_progress → completed | failed(no_show / unrecoverable / cancelled)

核心职责:
  - 强制收尾:started_at + max_duration_s 达上限即收尾(不再有 meeting_end 一轨)
  - 结束 end_trigger 取先到者
  - 状态转移合法性
  - max_concurrency admission 闸门
  - 过期判定:创建后 N 分钟仍未连入 → failed(未连入,fail_reason 沿用 no_show 值)

时间一律用带时区的 aware datetime(ISO8601);解析见 parse_iso。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

# ── Session 状态 ──
SCHEDULED = "scheduled"
IN_PROGRESS = "in_progress"
COMPLETED = "completed"
FAILED = "failed"

TERMINAL_STATES = frozenset({COMPLETED, FAILED})
# 活动态(占用并发闸门 / 阻止删除引用的 Agent):非终态。单一来源,勿在各处硬编码。
ACTIVE_STATES = frozenset({SCHEDULED, IN_PROGRESS})

# 合法转移图。键 = 当前态,值 = 允许的下一态集合。
_TRANSITIONS: dict[str, frozenset[str]] = {
    SCHEDULED: frozenset({IN_PROGRESS, FAILED}),  # 客户端连入;创建后 N 分钟未连入 failed(no_show)/取消
    IN_PROGRESS: frozenset({COMPLETED, FAILED}),
    COMPLETED: frozenset(),
    FAILED: frozenset(),
}

# ── end_trigger 取值(「收尾触发取先到者」) ──
# END_MEETING_END 已删(meeting_end 时间窗随即时开始转向删除,deployment validation)——收尾主驱动改 max_duration。
END_SESSION_END = "session_end"  # 正常收尾:AI 语义收尾(问完题/两步确认后 [[END_CALL]])或考生主动 end 帧
END_PEER_HANGUP = "peer_hangup"  # 对端**异常**断开(裸断连,非正常结束)
END_MAX_DURATION = "max_duration"  # 强制收尾主驱动:started_at + max_duration_s 达上限
END_MAX_TURNS = "max_turns"  # 安全网:轮次上限
END_ADMIN_HANGUP = "admin_hangup"  # admin 提前结束(design contract)

# ── fail_reason 取值 ──
# 未连入过期:值沿用 "no_show"(design contract session.failed webhook 消费方已知该值,不改值省兼容面),
# 语义从「爽约」变「创建后 N 分钟仍未连入而过期」(见 is_expired)。
FAIL_NO_SHOW = "no_show"
FAIL_UNRECOVERABLE = "unrecoverable"  # 不可恢复错误
FAIL_CANCELLED = "cancelled"  # 主动取消
# design contract:违规/物理断连强制结束的 fail_reason。
FAIL_SILENCE_TIMEOUT = "silence_timeout"  # 沉默防作弊第 4 次强制结束
FAIL_SEVERE_VIOLATION = "severe_violation"  # 严重违规(色情/暴力/威胁)再犯强制结束
FAIL_PEER_HANGUP = "peer_hangup"  # 对端物理断连(WS close);走 failed 而非 completed(design contract)

# violation_end 事件的 bridge reason → fail_reason 映射(design contract)。
# **仅违规**(silence/severe);物理断连 peer_hangup 走独立 peer_hangup 事件(非 violation_end,非违规)。
# 未知值兜底 unrecoverable(不静默吞)。
VIOLATION_FAIL_REASONS = {
    "silence_violation": FAIL_SILENCE_TIMEOUT,
    "severe_violation": FAIL_SEVERE_VIOLATION,
}


class StateError(Exception):
    """非法状态转移。"""


def parse_iso(value: str | datetime) -> datetime:
    """解析 ISO8601 为 aware datetime;naive 视作 UTC。"""
    if isinstance(value, datetime):
        dt = value
    else:
        # 兼容 'Z' 后缀(fromisoformat 在 3.11 已支持,稳妥起见仍替换)
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


def can_transition(current: str, nxt: str) -> bool:
    return nxt in _TRANSITIONS.get(current, frozenset())


def assert_transition(current: str, nxt: str) -> None:
    if not can_transition(current, nxt):
        raise StateError(f"非法状态转移: {current} → {nxt}")


def is_terminal(status: str) -> bool:
    return status in TERMINAL_STATES


def admission_check(
    *,
    active_count: int,
    max_concurrency: int,
) -> tuple[bool, str | None]:
    """全局并发 admission 闸门。

    返回 (allowed, reason):
      - 满载 → (False, None):需排队(调用方稍后重试)。
      - 否则 → (True, None)。
    (电话版的 retry_deadline/missed_window 分支已随重试窗删除。)
    """
    if active_count >= max_concurrency:
        return False, None  # 满载排队,非失败
    return True, None


def is_expired(
    *,
    now: str | datetime,
    created_at: str | datetime,
    expire_after_min: int,
    status: str,
) -> bool:
    """过期判定:scheduled 会话创建后超过 expire_after_min 分钟仍未连入(始终停在 scheduled)。

    即时开始模型下无「预约窗」,故过期锚点从 meeting_end 换成 created_at + N(N=join expire 分钟)。
    由调度器周期驱动:scheduled + 已过期 → failed(fail_reason 沿用 no_show 值)。
    in_progress 的超时强制收尾走 compute_hangup_at(不同语义:已连入,正常 completed)。
    """
    if status != SCHEDULED:
        return False
    return parse_iso(now) >= parse_iso(created_at) + timedelta(minutes=int(expire_after_min))


def compute_hangup_at(
    *,
    started_at: str | datetime,
    max_duration_s: int = 1800,
) -> tuple[datetime, str]:
    """强制收尾时刻 + 触发原因 = started_at + max_duration_s(即时开始模型下的唯一收尾预算)。

    返回 (hangup_at, end_trigger)。meeting_end 时间窗已删,收尾主驱动改为 max_duration 上限。
    对端断开 / max_turns 是运行时事件,不在此预算。
    """
    hangup_at = parse_iso(started_at) + timedelta(seconds=max_duration_s)
    return hangup_at, END_MAX_DURATION


def staff_can_edit(
    *,
    now: str | datetime,
    meeting_start: str | datetime,
    lock_minutes: int = 30,
) -> bool:
    """候选人 slot 预约的改约/取消门控:距时段开始 **严格 >** lock_minutes 才可改(design contract)。
    恰好剩 30min = 锁定。**仅候选人 slot 时段池仍用**(Q7 保留预约层);Session 单场即时开始已无此锁。"""
    return parse_iso(now) < parse_iso(meeting_start) - timedelta(minutes=lock_minutes)
