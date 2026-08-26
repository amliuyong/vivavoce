"""Session 调度器(design contract 缩水版)—— EventBridge 周期触发,推进会话时间策略。

控制面无状态,但「创建后 N 分钟未连入判过期 / 超时强制收尾」需要一个周期性驱动:
EventBridge Scheduler(每分钟)→ 本 Lambda → 扫会话,按 state_machine 决策落终态。
复用 backend 的 state_machine + session_service(单一事实源,不另写一份逻辑)。

新语义(VISION §1 + 即时开始转向 deployment validation):meeting 时间窗已删。**scheduled 到点不再「发起」
任何东西**——没有拨号;客户端自己连入,状态由实时服务的事件回调推进(connected → in_progress)。
调度器对 scheduled 只做过期判定:now ≥ created_at + N 仍停在 scheduled(用户始终未连入)→ failed;
对 in_progress 做强制收尾:now ≥ started_at + max_duration_s → hangup(max_duration backstop)。

打包:作为 backend 镜像的 container Lambda 部署(handler = app.scheduler.on_schedule),
因此能直接 import app.* —— 避免 scheduler 与 API 状态机实现漂移(先前部署教训)。

幂等 & 并发:每次 tick 独立计算;单条异常隔离,不让 EventBridge 反复重投打挂。
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime

from . import state_machine as sm
from .config import load_settings
from .db import Db
from .session_service import SessionService, make_dispatcher

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(UTC)


def tick(db: Db, service: SessionService, *, now: datetime | None = None,
         expire_after_min: int = 30) -> dict:
    """跑一轮调度。返回各动作计数(便于观测/测试)。

    扫描全部会话(MVP 数据量小;v1 走 StatusIndex GSI):
      - scheduled:now ≥ created_at + expire_after_min 仍未连入 → failed(过期);否则跳过(等客户端连入)。
      - in_progress:now ≥ started_at + max_duration_s → 强制收尾(design contract backstop,即时开始后锚点改)。

    错误隔离(review):每个 session 独立 try/except —— 单条坏数据只把该会话标
    failed(unrecoverable)并跳过,**绝不**让异常冒泡终止整个 tick。
    """
    now = now or _now()
    now_iso = now.isoformat()
    counts = {"no_show": 0, "reaped": 0, "skipped": 0, "errored": 0, "failed": 0}

    for session in db.list_sessions():
        status = session.get("status")
        try:
            if status == sm.SCHEDULED:
                _judge_expired(db, service, session, now_iso, counts, expire_after_min)
            elif status == sm.IN_PROGRESS:
                _enforce_max_duration(db, service, session, now_iso, counts)
            else:
                counts["skipped"] += 1
        except Exception:  # noqa: BLE001
            # 坏数据/意外异常:隔离单条,标终态 failed(不可恢复)并继续下一条
            logger.exception("调度 session %s 失败,标记 failed(unrecoverable)", session.get("session_id"))
            counts["errored"] += 1
            try:
                _fail(db, session, sm.FAIL_UNRECOVERABLE, now_iso, service.webhook_emitter)
                counts["failed"] += 1
            except Exception:  # noqa: BLE001
                logger.exception("标记 session %s failed 也失败,跳过", session.get("session_id"))
    return counts


def _judge_expired(db, service, session, now_iso: str, counts: dict, expire_after_min: int) -> None:
    """过期判定 → scheduled 会话超时未连入 → failed(fail_reason 沿用 no_show 值,design contract webhook 兼容)。

    两种过期锚点:
      - 候选人 slot 预约(有 meeting_end,Q7 保留预约层):slot 时段窗结束(now ≥ meeting_end)仍未连入 → 过期。
        (先约后到:约的是未来时段,不能按 created_at+N 提前判死。)
      - 即时开始会话(无 meeting_end):创建后 N 分钟(now ≥ created_at + N)未连入 → 过期。
    """
    meeting_end = session.get("meeting_end")
    if meeting_end:
        # 候选人 slot 预约:按时段窗结束判定(复用 is_expired 语义,锚点换成 meeting_end)。
        expired = session.get("status") == sm.SCHEDULED and sm.parse_iso(now_iso) >= sm.parse_iso(meeting_end)
    else:
        created_at = session.get("created_at")
        if not created_at:
            counts["skipped"] += 1  # 缺 created_at 无法判定(理论不该发生,build_session_record 必写)
            return
        expired = sm.is_expired(now=now_iso, created_at=created_at,
                                expire_after_min=expire_after_min, status=session.get("status", ""))
    if not expired:
        counts["skipped"] += 1  # 未过期:等客户端连入(没有拨号动作)
        return
    _fail(db, session, sm.FAIL_NO_SHOW, now_iso, service.webhook_emitter)
    counts["no_show"] += 1
    counts["failed"] += 1
    logger.info("session %s 超时未连入 → failed(过期)", session.get("session_id"))


def _enforce_max_duration(db, service, session: dict, now_iso: str, counts: dict) -> None:
    """max_duration 强制收尾(design contract control-plane backstop;即时开始后锚点 = started_at + max_duration_s)。

    HLD「固定行为:达最大时长上限 → AI 一定强制收尾」。理想的到点收尾由实时会话服务 timer 精确执行;
    但控制面 MUST 兜底——若实时服务未按时收尾(timer 没接 / 服务挂掉),会话会永远卡 in_progress。
    调度器(每分钟)扫到 now >= started_at + max_duration_s 的 in_progress 会话即 service.hangup。"""
    started_at = session.get("started_at")
    if not started_at:
        counts["skipped"] += 1  # 尚无 started_at(connected 事件未到):不该发生于 in_progress,跳过
        return
    # max_duration_s 取 session 固化的 engine 参数(创建时快照)。engine 存于 agent_snapshot.engine
    # (build_session_record 不写顶层 engine key);缺省回退 1800(与 EngineParams 默认一致)。
    snap = session.get("agent_snapshot") or {}
    engine = snap.get("engine") or session.get("engine") or {}
    max_duration_s = engine.get("max_duration_s") or 1800
    hangup_at, trigger = sm.compute_hangup_at(started_at=started_at, max_duration_s=int(max_duration_s))
    if now_iso < hangup_at.isoformat():
        counts["skipped"] += 1
        return
    try:
        service.hangup(session, end_trigger=trigger)
        counts["reaped"] += 1
        logger.info("session %s 达 max_duration 仍 in_progress → 控制面强制收尾(backstop)", session.get("session_id"))
    except Exception:  # noqa: BLE001
        # 实时服务挂断未确认(暂时失联)→ 保持 in_progress,下一分钟 tick 再试,不误标 failed。
        counts["skipped"] += 1
        logger.warning("session %s max_duration backstop 挂断未确认,下轮重试", session.get("session_id"))


def _fail(db: Db, session: dict, reason: str, now_iso: str, emitter=None) -> None:
    session.update({"status": sm.FAILED, "fail_reason": reason, "ended_at": now_iso})
    db.put_session(session)
    db.set_session_meta_status(session["session_id"], sm.FAILED, {"fail_reason": reason})
    # design contract:终态失败发 webhook(best-effort)
    if emitter is not None:
        emitter("session.failed", {"session_id": session["session_id"], "status": sm.FAILED,
                                   "fail_reason": reason, "trigger": session.get("trigger"),
                                   "ended_at": now_iso})


def on_schedule(_event=None, _context=None) -> dict:
    """Lambda 入口(EventBridge 定时触发)。

    用 make_dispatcher 按 bridge_dial_url 选 dispatcher(配了实时服务地址 → HttpDispatcher,
    backstop 强制收尾要真 POST 挂断到实时服务)。
    """
    settings = load_settings()
    db = Db(settings)
    dispatcher = make_dispatcher(db, settings.bridge_dial_url, secret=settings.bridge_callback_secret)
    from .events import make_webhook_emitter
    from .session_service import make_llm_config_store
    service = SessionService(db, dispatcher, max_concurrency=settings.max_concurrency,
                             webhook_emitter=make_webhook_emitter(db, settings),  # design contract 终态 webhook
                             llm_config_store=make_llm_config_store(settings),  # design contract
                             session_join_expire_min=settings.session_join_expire_min)
    return tick(db, service, expire_after_min=settings.session_join_expire_min)
