"""capacity-reconciler(design contract)—— 据期望配置对账 GPU 实例数,回写运行时实况。

部署:作为 backend 镜像的 container Lambda(handler = app.capacity_reconciler.on_schedule),
EventBridge ~1min 触发,reservedConcurrentExecutions=1(串行)。复用 backend app.* 逻辑(单一事实源)。

控制面归属(design contract,单一链):reconciler **只调 ecs:UpdateService(desiredCount)**,
ASG 由 ECS managed scaling 管,reconciler 绝不直接调 ASG。AWS 调用经 CapacityPlatform 接口注入,
核心编排(采集输入 → 算 desired → 回写实况)纯逻辑、可用 fake 单测。

需求三类(§3.3 缩水版):A=DDB in_progress(权威在途)、P=未来预热窗口 meeting_start 的 scheduled、
Q=已到点待连入(scheduled 且 meeting_start ≤ now < meeting_end)。走 StatusIndex GSI 查,避免全表 scan。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from . import capacity_service as cap
from . import state_machine as sm
from .config import load_settings
from .db import ConfigVersionConflict, Db

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(UTC)


class CapacityPlatform(Protocol):
    """reconciler 对 AWS 控制面的最小依赖(注入便于单测)。实现见 _AwsPlatform。"""

    def get_current_desired(self) -> int: ...
    def set_desired(self, n: int) -> None: ...  # 只调 ecs:UpdateService(desiredCount)
    def healthy_instance_count(self) -> int: ...  # 可接客(/readyz 通过)实例数,§3.4
    def running_instance_count(self) -> int: ...  # 运行中实例数(含未 ready 的,看板 running/draining 用)
    def sum_active_from_metrics(self) -> int: ...  # 健康实例 /metrics 的 active 求和(展示用,v1)
    def emit_heartbeat(self) -> None: ...  # 发 CloudWatch AIM/Capacity ReconcilerHeartbeat(供 Alarm 监控失活)


@dataclass
class ReconcileResult:
    desired: int
    healthy: int
    serviceable: int
    active: int
    prewarm: int
    backlog: int
    action: str  # scale_out / scale_in / noop / scale_in_cooldown
    intent_zero: bool


def _count_demand(db: Db, now: datetime, prewarm_window_min: int) -> tuple[int, int, int]:
    """算 (A, P, Q)。走 StatusIndex GSI query(非全表 scan)。

    即时开始转向(deployment validation):Session 单场无预约窗,创建即可连——所有未过期的即时 scheduled 会话
    都是「随时可能连入」→ 计入 backlog(Q)。
    P(预热窗)仅对**候选人 slot 预约**(有 meeting_start,先约后到)有意义:meeting_start ∈ (now, now+window]。

    A = in_progress(权威在途)。
    P = 有 meeting_start 且落在未来预热窗内的候选人 slot 会话(需提前预扩)。
    Q = 即时会话(无 meeting_start,创建即待连)+ 候选人 slot 已到点(meeting_start ≤ now < meeting_end)。
    A 与 P/Q 状态互斥;P/Q 按是否在未来预热窗互斥。
    """
    now_iso = now.isoformat()
    horizon_iso = (now + timedelta(minutes=prewarm_window_min)).isoformat()

    active = len(db.query_sessions_by_status(sm.IN_PROGRESS))

    scheduled = db.query_sessions_by_status(sm.SCHEDULED)

    def _window_open(s: dict) -> bool:
        me = s.get("meeting_end")
        return (not me) or now_iso < me  # 窗口未结束才算需求(超窗/过期的由调度器判 failed)

    def _in_prewarm_window(s: dict) -> bool:
        # 仅候选人 slot 预约有未来 meeting_start;即时会话无此字段,永远不进预热窗(直接算 backlog)。
        ms = s.get("meeting_start")
        return bool(ms) and now_iso < ms <= horizon_iso

    prewarm = sum(1 for s in scheduled if _in_prewarm_window(s) and _window_open(s))

    def _connectable_now(s: dict) -> bool:
        # 即时会话(无 meeting_start)创建即可连;候选人 slot 仅在已到点(meeting_start ≤ now)才算即时需求。
        # 未来的候选人 slot(meeting_start > now)是 prewarm 或更远,不计入即时 backlog(review:
        # 否则 2 小时后的预约会虚增 backlog → 过早扩容)。
        ms = s.get("meeting_start")
        return (not ms) or ms <= now_iso

    # backlog(Q):窗口未结束、不在未来预热窗、且已可连入的 scheduled(随时可能连入,须留容量)。
    backlog = sum(1 for s in scheduled
                  if _window_open(s) and not _in_prewarm_window(s) and _connectable_now(s))
    return active, prewarm, backlog


def reconcile(
    db: Db,
    platform: CapacityPlatform,
    *,
    now: datetime | None = None,
    g: int = cap.GPU_SESSIONS_PER_INSTANCE,
    # 窗口/冷却默认读 env(CDK 据 constants.ts 注入,单一事实源;缺省回退,本地/测试可用)
    prewarm_window_min: int = cap._env_int("AIM_GPU_PREWARM_WINDOW_MIN", 10),
    scale_in_cooldown_min: int = cap._env_int("AIM_GPU_SCALE_IN_COOLDOWN_MIN", 5),
    max_scale_out_step: int = cap.GPU_MAX_SCALE_OUT_STEP,
) -> ReconcileResult:
    """跑一轮对账。读期望 config → 算需求 → compute_desired → set_desired → 回写 live。

    scale-in 冷却态持久化在 DDB gpu_capacity_live.scale_in_candidate_since(§3.3 C2,非内存)。
    单轮异常由 on_schedule 兜底隔离;本函数尽量幂等(set_desired 前比对当前值)。
    """
    now = now or _now()
    config = db.get_gpu_capacity_config()
    if config is None:
        # bootstrap 兜底:配置缺失 → seed 默认 fixed=GPU_MIN(1)(CDK 自定义资源通常已 seed,这里双保险)
        config = {"mode": "fixed", "fixed_count": 1, "intent_zero": False}
        try:
            db.put_gpu_capacity_config(dict(config), expected_version=None)
        except ConfigVersionConflict:
            # 并发已被他者 seed(条件写 attribute_not_exists 失败)→ 用对方刚写的;其它异常照常抛
            logger.info("gpu_capacity_config 已被并发 seed,改用现存配置")
            config = db.get_gpu_capacity_config() or config

    mode = config.get("mode", "fixed")
    current_desired = platform.get_current_desired()
    active, prewarm, backlog = _count_demand(db, now, prewarm_window_min)

    inp = cap.DesiredInputs(
        mode=mode, current_desired=current_desired, active=active, prewarm=prewarm, backlog=backlog,
        fixed_count=int(config.get("fixed_count", 0)),
        auto_min=int(config.get("auto_min", 0)), auto_max=int(config.get("auto_max", 5)),
        target_util=float(config.get("target_util", cap.GPU_TARGET_UTIL)),
        g=g, max_scale_out_step=max_scale_out_step,
    )
    target = cap.compute_desired(inp)

    # scale-in 冷却(§3.3):**仅 auto 模式**防抖 —— fixed 是 admin 显式意图(尤其 fixed=0 停机),立即生效。
    live_prev = db.get_gpu_capacity_live() or {}
    # ★ 归一化 "" → None(review):回写时空值存为 "",读回 "" 是 truthy 但非 None,
    #   会让下方 `elif candidate_since is None` 走 else → parse_iso("") 抛 ValueError → 每轮 reconcile_failed,
    #   auto 缩容永久卡死。这里把空串当"无候选"。
    candidate_since = live_prev.get("scale_in_candidate_since") or None
    action = "noop"
    final_desired = current_desired
    if target > current_desired:
        final_desired = target
        action = "scale_out"
        candidate_since = None  # 取消任何缩容候选
    elif target < current_desired:
        if mode == "fixed":
            final_desired = target  # 显式配置,立即缩(含 fixed=0 停机)
            action = "scale_in"
            candidate_since = None
        elif candidate_since is None:
            candidate_since = now.isoformat()  # auto 首次判定要缩,起冷却计时
            action = "scale_in_cooldown"
        else:
            elapsed_ok = (now - sm.parse_iso(candidate_since)) >= timedelta(minutes=scale_in_cooldown_min)
            if elapsed_ok:
                final_desired = target
                action = "scale_in"
                candidate_since = None
            else:
                action = "scale_in_cooldown"
    else:
        candidate_since = None  # target == current:无缩容意图

    # 幂等:仅当与当前不同才真下发(§3.2)
    if final_desired != current_desired:
        platform.set_desired(final_desired)

    healthy = platform.healthy_instance_count()
    serviceable = min(healthy, final_desired) * g  # §3.4 H5:钳到 desired,缩容不给待淘汰实例派新
    try:
        running = platform.running_instance_count()
    except Exception:  # noqa: BLE001 — 展示用,失败不阻断
        running = healthy
    # 在途会话总数(看板):用权威的 DDB in_progress 计数(= A),非 /metrics stub(后者 v1 才接)
    intent_zero = bool(config.get("intent_zero", False))
    # running 但未 healthy 的实例 = running - healthy。这批可能是**冷启动中(warming)**或**缩容 drain 中**,
    # 看板须区分(review:冷启动被错标"缩容中"会误导 admin)。判据:目标 < 当前在跑 → 在缩(多出的是 draining);
    # 否则(目标 ≥ 在跑,即扩容/持平)→ 多出的未 healthy 是 warming(刚拉起还没 ready)。
    not_ready = max(0, running - healthy)
    if final_desired < running:
        draining = not_ready  # 缩容:未 ready 的视作 drain 中
        warming = 0
    else:
        warming = not_ready   # 扩容/持平:未 ready 的视作冷启动 warming
        draining = 0

    db.update_gpu_capacity_live({
        "observed_at": now.isoformat(),
        "desired_instances": final_desired,
        "running_instances": running,
        "healthy_instances": healthy,
        "draining_instances": draining,
        "warming_instances": warming,  # 冷启动中(running 未 healthy);与 draining 区分(review)
        "serviceable_concurrency": serviceable,
        "active_sessions_total": active,  # 权威在途(in_progress),看板真数据(非 0 stub)
        "intent_zero": intent_zero,
        # None → update_gpu_capacity_live 会 REMOVE 该属性(不落 "",避免数据卫生 + 读侧 parse_iso 回归隐患)
        "scale_in_candidate_since": candidate_since,
        "last_action": action,
        "reconciler_heartbeat_at": now.isoformat(),
    })
    # 心跳指标(design contract):成功一轮发 CloudWatch ReconcilerHeartbeat=1,CDK Alarm 监控其
    # "超新鲜度窗口无数据"→ SNS 告警运维(收敛者失活的主动闭环,非只靠 admin 开页面看 stale)。
    try:
        platform.emit_heartbeat()
    except Exception:  # noqa: BLE001 — 心跳 best-effort,失败不影响对账
        logger.warning("emit reconciler heartbeat 失败(忽略)")
    logger.info(
        "reconcile mode=%s A=%d P=%d Q=%d current=%d target=%d final=%d healthy=%d serviceable=%d action=%s",
        mode, active, prewarm, backlog, current_desired, target, final_desired, healthy, serviceable, action,
    )
    return ReconcileResult(
        desired=final_desired, healthy=healthy, serviceable=serviceable, active=active,
        prewarm=prewarm, backlog=backlog, action=action, intent_zero=intent_zero,
    )


def on_schedule(_event=None, _context=None) -> dict:
    """Lambda 入口(EventBridge 定时)。单轮异常隔离,不让 EventBridge 反复重投打挂。"""
    settings = load_settings()
    db = Db(settings)
    try:
        from .capacity_platform import AwsPlatform  # 真实 AWS 实现(部署期接线)

        platform = AwsPlatform(settings)
    except RuntimeError:
        # 仅 env 缺失(本地/未接线)→ AwsPlatform 构造抛 RuntimeError → 跳过(不动 ECS)。
        # 其它异常(boto3 缺失/凭证错等)不静默吞,落到下方 except 记 ERROR + 返 error(可被告警捕获,review)。
        logger.warning("AwsPlatform 未配置(AIM_GPU_CLUSTER/SERVICE 缺失),reconcile 跳过(本地/未接线)")
        return {"skipped": "no_platform"}
    except Exception:  # noqa: BLE001
        logger.exception("AwsPlatform 初始化异常(非 env 缺失)—— 需排查")
        return {"error": "platform_init_failed"}
    try:
        res = reconcile(db, platform)
        return {"desired": res.desired, "serviceable": res.serviceable, "action": res.action}
    except Exception:  # noqa: BLE001
        logger.exception("reconcile 单轮失败(已隔离,下轮重试)")
        return {"error": "reconcile_failed"}
