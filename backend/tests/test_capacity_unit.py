"""GPU 容量服务单测(design contract):配置校验 / desired 计算 / 闸门容量决策树。纯逻辑,不碰 AWS。"""
from __future__ import annotations

import pytest

from app.capacity_service import (
    CapacityConfigError,
    DesiredInputs,
    LiveCapacity,
    compute_desired,
    effective_capacity,
    validate_config,
)


# ── validate_config ──
def test_validate_fixed_ok():
    c = validate_config({"mode": "fixed", "fixed_count": 3})
    assert c == {"mode": "fixed", "fixed_count": 3, "intent_zero": False}


def test_validate_fixed_zero_sets_intent_zero():
    c = validate_config({"mode": "fixed", "fixed_count": 0})
    assert c["fixed_count"] == 0 and c["intent_zero"] is True  # 主动停机意图


def test_validate_fixed_over_hardmax_rejected():
    with pytest.raises(CapacityConfigError, match="fixed_count"):
        validate_config({"mode": "fixed", "fixed_count": 99}, hard_max=8)


def test_validate_fixed_negative_rejected():
    with pytest.raises(CapacityConfigError):
        validate_config({"mode": "fixed", "fixed_count": -1})


def test_validate_auto_ok_allows_min_zero():
    c = validate_config({"mode": "auto", "auto_min": 0, "auto_max": 5, "target_util": 0.7})
    assert c["auto_min"] == 0 and c["auto_max"] == 5 and c["intent_zero"] is False


def test_validate_auto_min_defaults_to_zero():
    """auto_min 省略 → 默认 0(与 spec『允许空闲自动缩 0』一致,review)。"""
    c = validate_config({"mode": "auto", "auto_max": 5})
    assert c["auto_min"] == 0


def test_validate_auto_min_gt_max_rejected():
    with pytest.raises(CapacityConfigError, match="auto_min"):
        validate_config({"mode": "auto", "auto_min": 5, "auto_max": 2})


def test_validate_auto_util_out_of_range_rejected():
    with pytest.raises(CapacityConfigError, match="target_util"):
        validate_config({"mode": "auto", "auto_min": 1, "auto_max": 3, "target_util": 1.5})


def test_validate_bad_mode_rejected():
    with pytest.raises(CapacityConfigError, match="mode"):
        validate_config({"mode": "turbo"})


def test_validate_bool_not_int():
    # bool 是 int 子类,须显式拒(否则 True 被当 1)
    with pytest.raises(CapacityConfigError):
        validate_config({"mode": "fixed", "fixed_count": True})


# ── compute_desired ──
def _auto(active, prewarm, backlog, current=1, amin=0, amax=8, step=3, g=3, util=0.7):
    return DesiredInputs(mode="auto", current_desired=current, active=active, prewarm=prewarm,
                         backlog=backlog, auto_min=amin, auto_max=amax, max_scale_out_step=step,
                         g=g, target_util=util)


def test_desired_fixed_directly():
    inp = DesiredInputs(mode="fixed", current_desired=2, active=0, prewarm=0, backlog=0, fixed_count=4)
    assert compute_desired(inp) == 4


def test_desired_fixed_zero():
    inp = DesiredInputs(mode="fixed", current_desired=3, active=5, prewarm=0, backlog=0, fixed_count=0)
    assert compute_desired(inp) == 0  # 停机即使有在途(在途由 protection 保护,不影响 desired=0)


def test_desired_total_demand_reaches_full_over_rounds():
    """第7轮#1:总需求非 max(reactive,predict)。A=6,P+Q=6,G=3,U=0.7 → full=ceil(12/2.1)=6。
    从 current=1 起,reactive 部分受 step 限速:第1轮 min(6,1+3)=4;若 current 提到 4,下轮 min(6,4+3)=6 到位。
    关键:最终能爬到总需求 6(旧 max() 实现只会卡在 3)。"""
    assert compute_desired(_auto(active=6, prewarm=6, backlog=0, current=1, step=3)) == 4  # 第1轮
    assert compute_desired(_auto(active=6, prewarm=6, backlog=0, current=4, step=3)) == 6  # 续爬到位


def test_desired_reactive_step_capped_relative_to_current():
    """纯 reactive 突增受 step 限速,且**相对 current**(review):A=12 → full=ceil(12/2.1)=6,
    current=1,step=3 → min(6, 1+3)=4(本轮加到 4,非旧实现卡死的 3)。"""
    assert compute_desired(_auto(active=12, prewarm=0, backlog=0, current=1, step=3)) == 4


def test_desired_predict_not_capped():
    """确定性需求(P+Q)不受 step 限速,一步到位。P+Q=12,G=3,U=0.7 → pq=ceil(12/2.1)=6,即使 current=1。"""
    assert compute_desired(_auto(active=0, prewarm=8, backlog=4, current=1, step=3)) == 6


def test_desired_backlog_drives_from_zero():
    """auto_min=0、A=0、P=0,但有积压 Q=2 → 拉起(不再永卡 0)。Q=2,G=3,U=0.7 → ceil(2/2.1)=1。"""
    assert compute_desired(_auto(active=0, prewarm=0, backlog=2, amin=0)) == 1


def test_desired_idle_scales_to_zero():
    """auto_min=0、全空 → desired=0(空闲自动缩 0 省钱)。"""
    assert compute_desired(_auto(active=0, prewarm=0, backlog=0, amin=0)) == 0


def test_desired_clamped_to_auto_max():
    assert compute_desired(_auto(active=0, prewarm=100, backlog=0, amax=5)) == 5


def test_desired_no_divide_by_zero():
    """G=0 / util 越界不崩(第6轮 M1 防呆)。"""
    assert compute_desired(_auto(active=3, prewarm=0, backlog=0, g=0)) >= 0
    assert compute_desired(_auto(active=3, prewarm=0, backlog=0, util=0)) >= 0


# ── effective_capacity 决策树(五叶子)──
def test_capacity_missing_uses_static():
    cap, label = effective_capacity(None, static_fallback=3)
    assert cap == 3 and label == "missing_use_static"


def test_capacity_fresh_uses_serviceable():
    live = LiveCapacity(serviceable_concurrency=9, intent_zero=False, fresh=True)
    cap, label = effective_capacity(live, static_fallback=3)
    assert cap == 9 and label == "fresh"


def test_capacity_fresh_zero_legal():
    """新鲜的 0(admin 停机)老实置 0。"""
    live = LiveCapacity(serviceable_concurrency=0, intent_zero=True, fresh=True)
    cap, label = effective_capacity(live, static_fallback=3)
    assert cap == 0 and label == "fresh"


def test_capacity_stale_intent_zero():
    """过期 + 停机意图 → 0。"""
    live = LiveCapacity(serviceable_concurrency=0, intent_zero=True, fresh=False)
    cap, label = effective_capacity(live, static_fallback=3)
    assert cap == 0 and label == "stale_intent_zero"


def test_capacity_stale_last_known_positive():
    """过期 + 非停机 + 最后已知>0 → 继续用最后已知值(实例冻结,值仍准),不砍。"""
    live = LiveCapacity(serviceable_concurrency=12, intent_zero=False, fresh=False)
    cap, label = effective_capacity(live, static_fallback=3)
    assert cap == 12 and label == "stale_use_last_known_alert"  # 不是砍到 3!


def test_capacity_stale_last_known_zero():
    """过期 + 非停机 + 最后已知=0(auto 缩 0 后 reconciler 挂)→ 0(放行必败,故拒+告警)。"""
    live = LiveCapacity(serviceable_concurrency=0, intent_zero=False, fresh=False)
    cap, label = effective_capacity(live, static_fallback=3)
    assert cap == 0 and label == "stale_zero_alert"
