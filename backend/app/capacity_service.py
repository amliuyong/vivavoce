"""GPU 容量管理服务(design contract)—— 配置校验、伸缩需求计算、全局闸门容量决策树。

设计单一事实源:docs/DESIGN-gpu-autoscaling.md。三块纯逻辑(便于单测,不碰 AWS 控制面):
  1. validate_config:admin PUT 配置的校验(fixed/auto、count/min/max 边界、硬上限)。
  2. compute_desired:reconciler 据 A(在途)+ P(预扩)+ Q(积压)算 ECS desiredCount
     —— 总需求 ceil((A+P+Q)/(G×U)),只对 A 突增的增量限速(第7轮#1:不是分项取 max)。
  3. effective_capacity:全局闸门读运行时实况的 fail-safe 决策树(缺失/新鲜/过期 三类、五叶子)。

控制面 backend 只用 validate_config + effective_capacity(闸门);compute_desired 供 reconciler。
backend 绝不调 AWS 控制面(由 reconciler Lambda 代劳),故本模块无 boto3 控制面调用。
"""
from __future__ import annotations

# 默认值/护栏:**优先读 env(CDK 据 constants.ts 单一事实源注入,避免漂移)**,缺省回退同值兜底
# (本地/测试无 env 时可用)。reconcile() 的 prewarm_window_min/scale_in_cooldown_min 同样可经 env 覆盖。
import os as _os
from dataclasses import dataclass
from math import ceil


def _env_int(name: str, default: int) -> int:
    try:
        return int(_os.getenv(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        v = float(_os.getenv(name, str(default)))
        return v if 0 < v <= 1 else default
    except ValueError:
        return default


GPU_HARD_MAX = _env_int("GPU_HARD_MAX", 8)
GPU_SESSIONS_PER_INSTANCE = _env_int("GPU_SESSIONS_PER_INSTANCE", 3)
GPU_TARGET_UTIL = _env_float("GPU_TARGET_UTIL", 0.7)
GPU_MAX_SCALE_OUT_STEP = _env_int("GPU_MAX_SCALE_OUT_STEP", 3)


class CapacityConfigError(ValueError):
    """配置校验失败(路由层转 400)。"""


def validate_config(body: dict, *, hard_max: int = GPU_HARD_MAX) -> dict:
    """校验并规范化 admin 提交的容量配置(design contract Requirement「admin 运行时配置」)。

    返回规范化后的配置字段(不含 config_version/审计,由调用方补);非法抛 CapacityConfigError。
    - mode ∈ {fixed, auto}
    - fixed:count 整数,0 ≤ count ≤ hard_max(0=停机)
    - auto:0 ≤ auto_min ≤ auto_max ≤ hard_max(auto_min 允许 0=空闲自动缩 0 省钱);target_util ∈ (0,1]
    """
    mode = body.get("mode")
    if mode not in ("fixed", "auto"):
        raise CapacityConfigError("mode 须为 fixed 或 auto")

    if mode == "fixed":
        count = body.get("fixed_count")
        if not isinstance(count, int) or isinstance(count, bool):
            raise CapacityConfigError("fixed_count 须为整数")
        if not (0 <= count <= hard_max):
            raise CapacityConfigError(f"fixed_count 须在 [0, {hard_max}](0=停机)")
        return {
            "mode": "fixed",
            "fixed_count": count,
            # fixed,count=0 = admin 主动停机意图;供闸门过期分支区分"合法 0 vs 异常"(design contract)
            "intent_zero": count == 0,
        }

    # auto(auto_min 默认 0 = 与 spec『允许空闲自动缩 0 省钱』一致,review;显式给值则尊重)
    auto_min = body.get("auto_min", 0)
    auto_max = body.get("auto_max", 5)
    util = body.get("target_util", GPU_TARGET_UTIL)
    for name, v in (("auto_min", auto_min), ("auto_max", auto_max)):
        if not isinstance(v, int) or isinstance(v, bool):
            raise CapacityConfigError(f"{name} 须为整数")
    if not (0 <= auto_min <= auto_max <= hard_max):
        raise CapacityConfigError(f"须满足 0 ≤ auto_min ≤ auto_max ≤ {hard_max}(auto_min=0 表示空闲自动缩 0)")
    if not isinstance(util, (int, float)) or isinstance(util, bool) or not (0 < util <= 1):
        raise CapacityConfigError("target_util 须在 (0, 1]")
    return {
        "mode": "auto",
        "auto_min": auto_min,
        "auto_max": auto_max,
        "target_util": float(util),
        "intent_zero": False,  # auto 自然缩到 0 不是"主动停机"(intent_zero=false,见 design contract)
    }


@dataclass
class DesiredInputs:
    """compute_desired 的输入快照(reconciler 每轮采集)。"""
    mode: str
    current_desired: int  # 当前 ECS desiredCount
    active: int  # A:DDB in_progress 计数(权威,非 /metrics)
    prewarm: int  # P:未来预热窗口内 meeting_start 的 scheduled 会话数
    backlog: int  # Q:已到点待连入的 scheduled(meeting_start ≤ now < meeting_end)
    fixed_count: int = 0
    auto_min: int = 0  # 与 spec/validate_config 一致(允许空闲自动缩 0;丢字段路径也走 0,review)
    auto_max: int = 5
    target_util: float = GPU_TARGET_UTIL
    g: int = GPU_SESSIONS_PER_INSTANCE
    max_scale_out_step: int = GPU_MAX_SCALE_OUT_STEP


def compute_desired(inp: DesiredInputs) -> int:
    """算目标 ECS desiredCount(design contract)。

    fixed:直取 fixed_count。
    auto:总需求 ceil((A+P+Q)/(G×U)),**只对 A 突增的增量**限 max_scale_out_step(预约 P+积压 Q 不限速),
          再 clamp 到 [auto_min, auto_max]。校验 G>0、0<util≤1(防除零/越界,第6轮 M1)。
    """
    if inp.mode == "fixed":
        return max(0, inp.fixed_count)

    g = inp.g if inp.g > 0 else 1
    util = inp.target_util if 0 < inp.target_util <= 1 else GPU_TARGET_UTIL
    denom = max(g * util, 1.0)

    full_target = ceil((inp.active + inp.prewarm + inp.backlog) / denom)  # 总需求
    pq_target = ceil((inp.prewarm + inp.backlog) / denom)                 # 确定性需求(预约 P + 积压 Q)
    step = max(0, inp.max_scale_out_step)

    # scale-out 才限速,且**限速相对 current_desired**(review 修正:原 predict+min(a_inc,step) 是相对 predict
    # 的绝对上限 → 反应式负载会卡在 predict+step 永远爬不到 full)。语义:
    #   - P+Q(确定性需求)一步到位,不限速 → target ≥ pq_target;
    #   - A(反应式突增)每轮最多在 current 上加 step → target ≤ current + step。
    # 持平/缩容(full_target ≤ current)直接到 full_target(缩容的保守性由 reconciler 冷却负责,非这里限步)。
    if full_target > inp.current_desired:
        target = max(pq_target, min(full_target, inp.current_desired + step))
    else:
        target = full_target
    return max(inp.auto_min, min(target, inp.auto_max))


@dataclass
class LiveCapacity:
    """全局闸门读到的运行时容量实况(来自 DDB gpu_capacity_live)。"""
    serviceable_concurrency: int
    intent_zero: bool
    fresh: bool  # observed_at 是否在新鲜窗口内


def effective_capacity(
    live: LiveCapacity | None,
    *,
    static_fallback: int,
) -> tuple[int, str]:
    """全局闸门取容量的 fail-safe 决策树(design contract,五叶子)。返回 (容量, 原因标签)。

    - live 缺失(首次部署/未初始化)→ 用部署期静态值兜底
    - live 新鲜 → 用 serviceable_concurrency(含合法的 0)
    - live 过期(reconciler 疑似失效):
        · intent_zero=true(admin 已停机)→ 0
        · 否则 serviceable>0 → 继续用最后已知值(实例冻结,值仍准)+ 告警
        · 否则(最后已知=0,如 auto 自然缩 0 后 reconciler 又挂)→ 0 + 告警(预扩拉不起,放行必败)
    static_fallback:部署期静态容量(env AIM_GPU_CAPACITY),仅缺失分支用。
    """
    if live is None:
        return max(0, static_fallback), "missing_use_static"
    if live.fresh:
        return max(0, live.serviceable_concurrency), "fresh"
    # 过期分支
    if live.intent_zero:
        return 0, "stale_intent_zero"
    if live.serviceable_concurrency > 0:
        return live.serviceable_concurrency, "stale_use_last_known_alert"
    return 0, "stale_zero_alert"
