"""capacity-reconciler 单测(design contract):对账编排(fixed/auto/0、P+Q 需求、冷却、幂等、实况回写)。

用 moto DDB(app_and_db 的 db)+ FakePlatform(注入 AWS 控制面),注入时钟避免真等冷却。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.capacity_reconciler import reconcile


class FakePlatform:
    """注入的 AWS 平台:记录 set_desired 调用,可设 healthy/metrics。"""

    def __init__(self, current=1, healthy=1, metric_active=0, running=None):
        self.current = current
        self.healthy = healthy
        self.running = running if running is not None else healthy
        self.metric_active = metric_active
        self.set_calls: list[int] = []

    def get_current_desired(self) -> int:
        return self.current

    def set_desired(self, n: int) -> None:
        self.set_calls.append(n)
        self.current = n

    def healthy_instance_count(self) -> int:
        return self.healthy

    def running_instance_count(self) -> int:
        return self.running

    def sum_active_from_metrics(self) -> int:
        return self.metric_active

    def emit_heartbeat(self) -> None:
        self.heartbeats = getattr(self, "heartbeats", 0) + 1


@pytest.fixture
def db(app_and_db):
    _, d = app_and_db
    return d


def _now():
    return datetime(2026, 7, 1, 10, 0, 0, tzinfo=UTC)


def _put_config(db, **kw):
    cfg = {"mode": "fixed", "fixed_count": 1, "intent_zero": False, **kw}
    db.put_gpu_capacity_config(cfg, expected_version=None)


def _mk_session(db, sid, status, *, meeting_start=None, meeting_end=None):
    s = {"session_id": sid, "status": status, "trigger": "manual",
         "created_at": _now().isoformat()}
    if meeting_start:
        s["meeting_start"] = meeting_start
    if meeting_end:
        s["meeting_end"] = meeting_end
    db.put_session(s)


# ── fixed ──
def test_reconcile_fixed_scales_to_count(db):
    _put_config(db, mode="fixed", fixed_count=3)
    p = FakePlatform(current=1, healthy=1)
    res = reconcile(db, p, now=_now())
    assert res.desired == 3 and p.set_calls == [3]


def test_reconcile_fixed_zero_stops(db):
    _put_config(db, mode="fixed", fixed_count=0, intent_zero=True)
    p = FakePlatform(current=2, healthy=2)
    res = reconcile(db, p, now=_now())
    assert res.desired == 0 and res.intent_zero is True
    # serviceable=min(healthy,desired)×G;desired=0 → 0
    assert res.serviceable == 0


def test_reconcile_idempotent_noop(db):
    _put_config(db, mode="fixed", fixed_count=2)
    p = FakePlatform(current=2, healthy=2)
    res = reconcile(db, p, now=_now())
    assert res.action == "noop" and p.set_calls == []  # 已等于目标,不下发


# ── auto:P + Q 需求 ──
def test_reconcile_auto_prewarm_drives_scaleout(db):
    """未来 5min 内 8 场 scheduled → 预扩。P=8,G=3,U=0.7 → ceil(8/2.1)=4。"""
    _put_config(db, mode="auto", fixed_count=0, auto_min=0, auto_max=8, target_util=0.7)
    soon = (_now() + timedelta(minutes=5)).isoformat()
    for i in range(8):
        _mk_session(db, f"p{i}", "scheduled", meeting_start=soon)
    p = FakePlatform(current=0, healthy=0)
    res = reconcile(db, p, now=_now(), prewarm_window_min=10)
    assert res.prewarm == 8 and res.desired == 4


def test_reconcile_auto_backlog_drives_from_zero(db):
    """auto_min=0、当前 0 台,但有已到点待连入(窗口开着的 scheduled)→ 拉起(不永卡 0)。"""
    _put_config(db, mode="auto", fixed_count=0, auto_min=0, auto_max=8, target_util=0.7)
    past = (_now() - timedelta(minutes=5)).isoformat()
    future_end = (_now() + timedelta(minutes=30)).isoformat()
    for i in range(3):
        _mk_session(db, f"b{i}", "scheduled", meeting_start=past, meeting_end=future_end)
    p = FakePlatform(current=0, healthy=0)
    res = reconcile(db, p, now=_now())
    assert res.backlog == 3 and res.desired >= 1  # Q 驱动拉起


def test_reconcile_auto_idle_scales_to_zero(db):
    _put_config(db, mode="auto", fixed_count=0, auto_min=0, auto_max=5, target_util=0.7)
    p = FakePlatform(current=2, healthy=2)
    # 无任何会话 → A=P=Q=0 → target=0;但 scale-in 冷却:首轮只记候选不缩
    res = reconcile(db, p, now=_now())
    assert res.action == "scale_in_cooldown" and p.set_calls == []


def test_reconcile_scale_in_after_cooldown(db):
    """缩容冷却:首轮记候选,过 cooldown 后才真缩。"""
    _put_config(db, mode="auto", fixed_count=0, auto_min=0, auto_max=5, target_util=0.7)
    p = FakePlatform(current=2, healthy=2)
    t0 = _now()
    reconcile(db, p, now=t0, scale_in_cooldown_min=5)  # 记候选
    assert p.set_calls == []
    # 6 分钟后:冷却到点 → 缩到 0
    res = reconcile(db, p, now=t0 + timedelta(minutes=6), scale_in_cooldown_min=5)
    assert res.action == "scale_in" and res.desired == 0 and p.set_calls == [0]


def test_reconcile_backlog_window_closed_excluded(db):
    """窗口已结束(meeting_end ≤ now)的 scheduled 不算需求(将由调度器判 no_show)。"""
    _put_config(db, mode="auto", fixed_count=0, auto_min=0, auto_max=5, target_util=0.7)
    past = (_now() - timedelta(minutes=30)).isoformat()
    expired_end = (_now() - timedelta(minutes=1)).isoformat()  # 窗口已结束
    _mk_session(db, "expired", "scheduled", meeting_start=past, meeting_end=expired_end)
    p = FakePlatform(current=0, healthy=0)
    res = reconcile(db, p, now=_now())
    assert res.backlog == 0  # 超窗不算


def test_reconcile_serviceable_clamped_to_desired(db):
    """缩容期 healthy(5)> desired(1):serviceable 钳到 min×G,不按 healthy 算(H5)。"""
    _put_config(db, mode="fixed", fixed_count=1)
    p = FakePlatform(current=1, healthy=5)  # 5 台还健康(待淘汰)
    res = reconcile(db, p, now=_now(), g=3)
    assert res.serviceable == 1 * 3  # min(5,1)×3,不是 5×3


def test_reconcile_writes_live_with_heartbeat(db):
    _put_config(db, mode="fixed", fixed_count=2)
    p = FakePlatform(current=1, healthy=1, metric_active=0)
    reconcile(db, p, now=_now())
    live = db.get_gpu_capacity_live()
    assert live["desired_instances"] == 2
    assert live["reconciler_heartbeat_at"] == _now().isoformat()
    assert live["last_action"] == "scale_out"


def test_reconcile_live_running_draining_active(db):
    """看板字段有真数据(review):running/draining/active_sessions_total 都写,非空/0 stub。"""
    _put_config(db, mode="fixed", fixed_count=2)
    # 2 通在途(in_progress)→ active_sessions_total 应 = 2(权威 DDB 计数)
    _mk_session(db, "c1", "in_progress")
    _mk_session(db, "c2", "in_progress")
    p = FakePlatform(current=2, healthy=1, running=2)  # 2 台 running,1 台 ready(1 台冷启动中)
    reconcile(db, p, now=_now(), g=3)
    live = db.get_gpu_capacity_live()
    assert live["running_instances"] == 2
    assert live["healthy_instances"] == 1
    # desired(2) 不 < running(2) → 非缩容 → 未 ready 的 1 台是 **warming**(冷启动),非 draining(review)
    assert live["warming_instances"] == 1
    assert live["draining_instances"] == 0
    assert live["active_sessions_total"] == 2  # 权威在途,非 0 stub
    assert live["serviceable_concurrency"] == 1 * 3  # min(healthy=1, desired=2) × 3


def test_reconcile_draining_when_scaling_in(db):
    """缩容(desired < running):未 ready 的算 draining,非 warming(review)。"""
    _put_config(db, mode="fixed", fixed_count=1)
    p = FakePlatform(current=2, healthy=1, running=2)  # 缩到 1,2 台还在跑,1 台 ready
    reconcile(db, p, now=_now(), g=3)
    live = db.get_gpu_capacity_live()
    assert live["draining_instances"] == 1  # desired(1) < running(2) → 多出的 1 台在 drain
    assert live["warming_instances"] == 0


def test_reconcile_scale_in_candidate_empty_string_roundtrip(db):
    """review:遗留 live 里 scale_in_candidate_since="" → reconcile 不崩(读侧归一化),且写回用 REMOVE 不再落 ""。"""
    _put_config(db, mode="auto", fixed_count=0, auto_min=0, auto_max=5, target_util=0.7)
    # 模拟遗留数据:live 有空串 candidate(旧版本写入)
    db.update_gpu_capacity_live({"serviceable_concurrency": 0, "observed_at": _now().isoformat(),
                                 "scale_in_candidate_since": ""})
    # 手动塞一条空串(update 的 None→REMOVE 不会写空串,这里直接 put 模拟历史脏数据)
    db._table(db.settings.system_config_table).put_item(Item={
        "config_key": "gpu_capacity_live", "serviceable_concurrency": 0,
        "observed_at": _now().isoformat(), "scale_in_candidate_since": ""})
    p = FakePlatform(current=2, healthy=2)  # target<current → 要缩,会读 candidate
    res = reconcile(db, p, now=_now())  # 不应抛 ValueError
    assert res.action in ("scale_in_cooldown", "noop", "scale_in")
    # 写回后 candidate 字段被 REMOVE(非空串):首次判定要缩会写真时戳,故这里断言不是 ""
    live = db.get_gpu_capacity_live()
    assert live.get("scale_in_candidate_since", None) != ""


def test_update_live_none_removes_field(db):
    """update_gpu_capacity_live:None 值 REMOVE 属性(非落 None/"")。"""
    db.update_gpu_capacity_live({"observed_at": _now().isoformat(), "scale_in_candidate_since": "2026-07-01T10:00:00+00:00"})
    assert db.get_gpu_capacity_live()["scale_in_candidate_since"] == "2026-07-01T10:00:00+00:00"
    db.update_gpu_capacity_live({"scale_in_candidate_since": None})  # 清除
    assert "scale_in_candidate_since" not in db.get_gpu_capacity_live()


def test_reconcile_bootstrap_seeds_missing_config(db):
    """配置缺失 → bootstrap seed 默认 fixed=1(不崩)。"""
    p = FakePlatform(current=0, healthy=0)
    res = reconcile(db, p, now=_now())
    assert res.desired == 1  # 默认 GPU_MIN
    assert db.get_gpu_capacity_config()["mode"] == "fixed"
