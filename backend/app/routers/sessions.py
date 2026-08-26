"""会话发起/查询/控制路由(design contract 缩水版)。

角色门控:
  - admin:看所有会话、HR 代发起(origin=hr)、提前结束(hangup)
  - staff:只看/建自己的会话(origin=staff,booked_by=本人);列表自动按身份过滤;
           开始前可取消自己的会话(design contract)

新语义(VISION §1):没有电话/会议——发起 = 落 Session + 向实时会话服务预创建(ready),
客户端凭 session_id 连入开始考试;状态由实时服务事件回调推进(connected/completed/...)。
即时开始、无预约:失败会话不「重约」(会话级重约端点已删),重新发起 = 直接再起一场。

时间策略/状态机委托 state_machine;发起/挂断编排委托 SessionService。
"""
from __future__ import annotations

import hmac
import logging
import numbers
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel

from .. import state_machine as sm
from ..auth import Principal
from ..deps import (
    require_admin,
    require_staff_or_delegation,
    require_user_or_delegation,
)
from ..join_token import sign_join_token
from ..models import (
    SessionJoinOut,
    SessionLaunchIn,
    SessionOut,
    SessionStatsOut,
)
from ..session_service import (
    LaunchError,
    PerQuestionCheckRequiresQuestions,
    SessionService,
    assert_resolvable,
    build_session_record,
    make_dispatcher,
)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

logger = logging.getLogger("aim.sessions")

# join token 有效期策略:即时开始模型无时间窗,exp = now + JOIN_MAX_TTL(固定上限)。
_JOIN_MAX_TTL = timedelta(hours=4)


def _db(request: Request):
    return request.app.state.db


def _with_agent_name(session: dict) -> dict:
    """给 session 补 agent_name(取创建时冻结的 agent_snapshot.name)供会话历史「场景」列可读展示。
    无快照(老数据)→ 不补,前端回退显示 agent_id。返回浅拷贝,不改库里原 dict。"""
    name = (session.get("agent_snapshot") or {}).get("name")
    return {**session, "agent_name": name} if name else session


def _with_target_name(request: Request, session: dict) -> dict:
    """给 session 补 target_name(解析 target_id → Target.name/external_id)供详情「对象」列可读展示。
    避免前端展示原始 target_id/booked_by(Cognito sub UUID,不可读)。无 target_id / 查不到 → 不补
    (前端回退 booked_by_email 等)。返回浅拷贝,不改库里原 dict。仅单条详情用(list 不逐条查,避免 N+1)。"""
    tid = session.get("target_id")
    if not tid:
        return session
    target = _db(request).get_target(tid)
    if target is None:
        return session
    label = target.get("name") or target.get("external_id")
    return {**session, "target_name": label} if label else session


def _resolve_bank(db, agent: dict, question_bank_id: str | None, *, explicit: bool) -> dict | None:
    """题库选择(design contract),区分「显式」与「省略」(review 选「无/纯人设」须能清掉 Agent 默认):

    - explicit=True(请求**显式带了** question_bank_id 字段,哪怕值为 null/""):按字面 ——
      非空 → 用该题库;空(null/"")→ **无题库(纯人设)**,不回退 Agent 默认。
    - explicit=False(请求**省略**该字段,如 staff 自助 / API 未传):回退 Agent.default_question_bank_id。

    返回题库 dict(供 build_session_record 固化)或 None(纯人设对话)。指定的题库不存在 → 404。
    """
    if explicit:
        bank_id = (question_bank_id or "").strip() or None
    else:
        bank_id = agent.get("default_question_bank_id")
    if not bank_id:
        return None
    bank = db.get_question_bank(bank_id)
    if bank is None:
        raise HTTPException(status_code=404, detail=f"题库 {bank_id} 不存在")
    return bank


def _service(request: Request) -> SessionService:
    db = _db(request)
    settings = request.app.state.settings
    # 实时服务 dispatcher 可被 app.state 覆盖(测试注入);否则据 bridge_dial_url 选:
    # 配了 → HttpDispatcher(真 POST /sessions/{id}/ready);未配 → RecordingDispatcher(仅落库)。
    dispatcher = getattr(request.app.state, "dispatcher", None)
    if dispatcher is None:
        dispatcher = make_dispatcher(db, settings.bridge_dial_url,
                                     secret=settings.bridge_callback_secret)
    from ..events import make_webhook_emitter
    from ..session_service import make_llm_config_store
    return SessionService(db, dispatcher, max_concurrency=settings.max_concurrency,
                          webhook_emitter=make_webhook_emitter(db, settings),  # design contract 终态 webhook
                          llm_config_store=make_llm_config_store(settings),  # design contract 三段式 LLM 凭据/校验
                          session_join_expire_min=settings.session_join_expire_min)


def _get_owned_session(request: Request, session_id: str, principal: Principal) -> dict:
    session = _db(request).get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if not principal.is_admin and session.get("booked_by") != principal.username:
        raise HTTPException(status_code=403, detail="无权访问该会话")
    return session


def issue_join_token(request: Request, session: dict) -> dict:
    """签发实时会话 join token 的共享逻辑(admin/staff 与候选人两条鉴权路径复用,design contract-C)。

    调用方负责鉴权 + 归属校验(admin 经 _get_owned_session;候选人经 token payload 定位);本函数只做
    与鉴权无关的通用部分:状态校验 → best-effort 重新预创建(make_ready)→ 签 join_token。
    返回 {join_token, ws_path, expires_at}。终态不可连抛 HTTPException(409),密钥缺失 503。
    即时开始模型:无时间窗校验(创建即可连);超时未连入由调度器判过期(scheduled→failed),
    终态会话在此被 409 拦。
    """
    session_id = session["session_id"]
    secret = request.app.state.settings.bridge_callback_secret
    if not secret:
        raise HTTPException(status_code=503, detail="实时服务回调密钥未配置(AIM_BRIDGE_CALLBACK_SECRET)")

    if session.get("status") not in (sm.SCHEDULED, sm.IN_PROGRESS):
        raise HTTPException(status_code=409, detail="会话已结束,无法连入")
    now = datetime.now(UTC)

    best_effort_make_ready(request, session)

    exp_unix = int((now + _JOIN_MAX_TTL).timestamp())
    return {
        "join_token": sign_join_token(session_id, exp_unix, secret),
        "ws_path": "/rt/ws",
        "expires_at": datetime.fromtimestamp(exp_unix, tz=UTC).isoformat(),
    }


def best_effort_make_ready(request: Request, session: dict) -> None:
    """Rebuild the bridge context before issuing either realtime credential."""
    try:
        db = _db(request)
        agent = session.get("agent_snapshot") or db.get_agent(session["agent_id"])
        _service(request).make_ready(session, agent)
    except Exception as exc:  # noqa: BLE001 — best-effort,签发不受预创建失败影响
        logger.warning("实时凭据预创建(make_ready)失败 session=%s: %s —— 继续签发(客户端可 not_ready 重试)",
                       session["session_id"], exc)


@router.get("", response_model=list[SessionOut])
def list_sessions(
    request: Request, principal: Principal = Depends(require_user_or_delegation)
) -> list[dict]:
    # staff 只看自己(基于身份,不信前端入参);admin 看全部「单场」。
    # 归属隔离:本列表只 trigger=manual(读侧容忍历史 campaign 数据,不展示),
    # 且排除 origin=candidate(design contract:候选人会话走招聘环节管理,不混入常规单场列表)。
    owner = None if principal.is_admin else principal.username
    sessions = _db(request).list_sessions(owner=owner, trigger="manual", exclude_origin="candidate")
    return [_with_agent_name(s) for s in sessions]


# per_question_check 无 passed 时的兜底(理论上 evaluator 已折算);dimension_score 无 passed → 按分数阈值。
_DIM_PASS_THRESHOLD = 0.6  # 与前端 Report.tsx::DIM_PASS 同口径(dimension 模式整场通过线)


def _result_passed(result: dict) -> bool | None:
    """判定单个评测结果是否「通过」——与报告页 effectivePassed 同口径(人工复核优先,回退 AI):
      - 有 review_passed(人工改判 check 模式)→ 用它;
      - 否则有 passed(AI check 模式)→ 用它;
      - 否则按分数(dimension 模式无 passed):review_overall_score ?? overall_score >= 阈值;
      - 都缺 → None(无法判定,不计入通过率分母)。
    ⚠ DDB 读出的数字是 Decimal(get_result/list_results 未过 _from_ddb)。**Decimal 不是 numbers.Real**
      (Python 有意为之)但是 numbers.Number,故用 numbers.Number 覆盖 int/float/Decimal;bool 是 int 子类,
      故 passed/review_passed 单独用 isinstance(bool) 先判(不落分数分支),分数分支再显式排除 bool。
    """
    rp = result.get("review_passed")
    if isinstance(rp, bool):
        return rp
    p = result.get("passed")
    if isinstance(p, bool):
        return p
    score = result.get("review_overall_score")
    if not isinstance(score, numbers.Number) or isinstance(score, bool):
        score = result.get("overall_score")
    if isinstance(score, numbers.Number) and not isinstance(score, bool):
        return float(score) >= _DIM_PASS_THRESHOLD
    return None


@router.get("/stats", response_model=SessionStatsOut)
def session_stats(
    request: Request, principal: Principal = Depends(require_user_or_delegation)
) -> dict:
    """总览「按场景(Agent)分 + 通过率」聚合。staff 只统计自己的会话(归属隔离,不信前端)。

    通过率 = passed 会话 / 有评测结果的会话(evaluated 为分母);未出结果的会话计入 total 不计 evaluated。
    Session×Result 按 session_id join;结果归属由「可见 session 集合」保证(不单独信任 Results scan)。
    """
    db = _db(request)
    owner = None if principal.is_admin else principal.username
    sessions = db.list_sessions(owner=owner, trigger="manual", exclude_origin="candidate")
    # 可见会话 id → 结果 map(只取可见会话的结果,归属隔离在 session 层已做)。
    visible_ids = {s["session_id"] for s in sessions}
    results = {r["session_id"]: r for r in db.list_results() if r.get("session_id") in visible_ids}

    # 按 agent_id 聚合。agent_name 优先取会话快照(发起时冻结),回退 live Agent 名。
    agg: dict[str, dict] = {}
    for s in sessions:
        aid = s.get("agent_id") or "(unknown)"
        a = agg.setdefault(aid, {
            "agent_id": aid,
            "agent_name": (s.get("agent_snapshot") or {}).get("name"),
            "total": 0, "completed": 0, "evaluated": 0, "passed": 0,
        })
        if not a["agent_name"]:
            a["agent_name"] = (s.get("agent_snapshot") or {}).get("name")
        a["total"] += 1
        if s.get("status") == sm.COMPLETED:
            a["completed"] += 1
        result = results.get(s["session_id"])
        if result is not None:
            verdict = _result_passed(result)
            if verdict is not None:
                a["evaluated"] += 1
                if verdict:
                    a["passed"] += 1

    # 补 agent_name(快照缺失的老会话回退 live Agent 名)+ 算通过率。
    out = []
    for aid, a in agg.items():
        if not a["agent_name"]:
            live = db.get_agent(aid)
            if live:
                a["agent_name"] = live.get("name")
        a["pass_rate"] = (a["passed"] / a["evaluated"]) if a["evaluated"] > 0 else None
        out.append(a)
    # 按会话总数倒序(最活跃场景在前)。
    out.sort(key=lambda x: x["total"], reverse=True)
    return {"agents": out}


@router.post("", response_model=SessionOut, status_code=201)
def launch_session(
    body: SessionLaunchIn, request: Request, principal: Principal = Depends(require_staff_or_delegation)
) -> dict:
    # require_staff:admin 或 staff 才能发起 —— 既无 admin 又无 staff 组的已认证用户被拒(review:
    # 角色必来自 Cognito Group,不能把「任意非 admin」当 staff)。下面 origin 判定因此安全。
    db = _db(request)
    agent = db.get_agent(body.agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent 不存在")

    # staff 只能用 self_bookable 的 Agent(防自评/刷分)
    if not principal.is_admin and not agent.get("self_bookable"):
        raise HTTPException(status_code=403, detail="该 Agent 不可自助预约")

    origin = "hr" if principal.is_admin else "staff"

    # 题库(design contract):admin/HR 可显式选 question_bank_id(含显式选「无」清掉 Agent 默认);
    # staff 不选 → 一律走 Agent.default_question_bank_id(staff 的 body.question_bank_id 被忽略)。
    if principal.is_admin:
        explicit = "question_bank_id" in body.model_fields_set
        bank = _resolve_bank(db, agent, body.question_bank_id, explicit=explicit)
    else:
        bank = _resolve_bank(db, agent, None, explicit=False)

    # staff 自助预约:按登录 email upsert Target(source=self),绑 target_id(design contract)。
    # HR 代发起:可选按 target_external_id 绑既有/新建对象(source=admin)。
    target_id: str | None = None
    if origin == "staff":
        target = db.upsert_target_by_external_id(
            principal.username, {"source": "self", "name": principal.username}
        )
        target_id = target["target_id"]
    elif body.target_external_id:
        target = db.upsert_target_by_external_id(
            body.target_external_id, {"source": "admin", "name": body.target_external_id}
        )
        target_id = target["target_id"]

    # 即时开始:一律落 scheduled(没有拨号/无预约窗);预创建推给实时服务,客户端连入后 connected 事件推进。
    session = build_session_record(
        agent=agent,
        bank=bank,
        booked_by=principal.username,  # = sub(access token username 即 sub);归属/过滤按此
        origin=origin,
        target_id=target_id,
        status=sm.SCHEDULED,
        booked_by_email=body.booked_by_email,  # 前端从 id token 带来的 email,仅展示
    )
    # per_question_check 无题 fail-fast(design contract):不进一场必然无法判定的会话。
    try:
        assert_resolvable(agent, session.get("resolved_questions", []))
    except PerQuestionCheckRequiresQuestions as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    db.put_session(session)
    try:
        session = _service(request).launch(session, agent)
    except LaunchError as exc:  # design contract:LLM 凭据未配置 / 模型不在清单 → 明确 400,不产生静默会话
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _with_agent_name(session)


@router.get("/{session_id}", response_model=SessionOut)
def get_session(
    session_id: str, request: Request, principal: Principal = Depends(require_user_or_delegation)
) -> dict:
    session = _get_owned_session(request, session_id, principal)
    # 详情页补可读名:agent_name(场景)+ target_name(对象);后者解析 target_id → Target.name(单条查,非 list)。
    return _with_target_name(request, _with_agent_name(session))


@router.get("/{session_id}/join", response_model=SessionJoinOut)
def join_session(
    session_id: str, request: Request, principal: Principal = Depends(require_staff_or_delegation)
) -> dict:
    """签发实时会话 join token(M1-B):客户端凭它连 wss://<站点>/rt/ws?session_id=<id>,
    首帧 {"type":"auth","token":<join_token>}。生产验签在实时会话服务(bridge)。

    鉴权(review):require_staff_or_delegation —— 角色必须来自 Cognito Group(admin/staff),
    不能把「任意已认证用户」当 staff(用户名巧合匹配 booked_by 即越权,与 launch 同口径)。
    归属:沿用列表/详情口径(admin 任意;staff 仅本人,不信前端入参)。
    candidate(免登录链接考生)场景:另立 candidate join 端点用 X-Candidate-Token 鉴权(M1-C 接
    CandidatePortal 时补),本端点不揽。
    前置:仅 scheduled/in_progress 可连入(终态 409)。即时开始模型无时间窗校验(创建即可连);
    超时未连入由调度器判过期(scheduled→failed,此后 409)。
    签发前**重新预创建**(best-effort 重发就绪指令):闭合「实时服务重启丢内存上下文」缺口 ——
    /join 总是先把会话内核重新暂存过去;失败只告警不阻断签发(实时服务缺上下文时
    客户端会拿到 not_ready 自行重试)。
    """
    session = _get_owned_session(request, session_id, principal)
    # 状态校验 + 预创建 + 签 token 走共享 helper(候选人 join 复用同一逻辑,design contract-C)。
    return issue_join_token(request, session)


#（会话级「重约/重新发起」已删:整套系统即时开始、无预约,失败会话不重跑,重新发起 = 直接再起一场。
#  候选人时段预约的改约(design contract /api/candidate/reschedule)是招聘环节独立功能,与此无关,保留。）


@router.delete("/{session_id}", status_code=204)
def cancel_session(
    session_id: str, request: Request, principal: Principal = Depends(require_staff_or_delegation)
) -> None:
    """取消待开始的会话(即时开始转向后去 30min 锁):仅 scheduled 可取消 → failed(cancelled)。"""
    session = _get_owned_session(request, session_id, principal)
    if session.get("status") != sm.SCHEDULED:
        raise HTTPException(status_code=409, detail="仅待开始(scheduled)的会话可取消")
    session.update({"status": sm.FAILED, "fail_reason": sm.FAIL_CANCELLED,
                    "ended_at": datetime.now(UTC).isoformat()})
    _db(request).put_session(session)


@router.post("/{session_id}/hangup", response_model=SessionOut)
def hangup_session(
    session_id: str, request: Request, _: Principal = Depends(require_admin)
) -> dict:
    """admin 提前结束进行中会话(design contract):下发 hangup → completed → 触发评估。"""
    db = _db(request)
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if session.get("status") != sm.IN_PROGRESS:
        raise HTTPException(status_code=409, detail="仅进行中(in_progress)会话可提前结束")
    try:
        return _service(request).hangup(session, end_trigger=sm.END_ADMIN_HANGUP)
    except RuntimeError as exc:
        # 实时服务挂断未确认:如实报 502(会话仍 in_progress 可重试),不假称已结束(review)
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class MediaEventIn(BaseModel):
    """实时会话服务状态回报(事件回调)。事件集:connected | completed | peer_hangup | no_show |
    violation_end(design contract:违规/物理断连强制结束 → failed)。"""

    event: str  # connected | completed | peer_hangup | no_show | violation_end
    end_trigger: str | None = None  # completed 时的结束原因;violation_end 时的 bridge reason
    duration_s: float | None = None  # 会话时长(诊断旁路)
    has_recording: bool | None = None
    fail_reason: str | None = None  # design contract:violation_end 的失败原因(bridge reason)
    early_exit: bool | None = None  # design contract:三次坚持逃生阀放行(向后兼容,backend 暂只透传/忽略)


@router.post("/{session_id}/events", response_model=SessionOut)
def media_event(
    session_id: str,
    body: MediaEventIn,
    request: Request,
    x_bridge_secret: str | None = Header(default=None),
) -> dict:
    """实时服务→控制面状态回报。**鉴权 = 共享密钥**(实时服务非 Cognito 用户)。

    这是 `scheduled → in_progress → completed` 的真实驱动来源(客户端连入/结束由实时服务回报)。
    fail-closed:密钥未配/不符 → 503/401。
    """
    secret = request.app.state.settings.bridge_callback_secret
    if not secret:
        raise HTTPException(status_code=503, detail="实时服务回调密钥未配置(AIM_BRIDGE_CALLBACK_SECRET)")
    if not x_bridge_secret or not hmac.compare_digest(x_bridge_secret, secret):
        raise HTTPException(status_code=401, detail="实时服务回调密钥不符")

    db = _db(request)
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    svc = _service(request)
    ev = body.event

    try:
        if ev == "connected":
            return svc.mark_connected(session)
        if ev == "completed":
            # 正常收尾(AI 语义收尾 / 考生 end 帧)→ completed。缺省 end_trigger 兜底 session_end。
            return svc.complete_from_media(
                session, end_trigger=body.end_trigger or sm.END_SESSION_END
            )
        if ev == "peer_hangup":
            # design contract(修既有 bug):对端物理断连 → **failed**(fail_reason=peer_hangup),对齐 design contract
            #   Scenario「物理断连走 failed 语义,evaluator 只在 completed 触发」。旧实现走 complete_from_media
            #   写 completed 与 design contract 矛盾(且会误触发评估)。物理断连**非违规**,故走 peer_hangup 事件而非
            #   violation_end,但同样落 failed(fail_from_media 放行 scheduled|in_progress → failed)。
            return svc.fail_from_media(session, fail_reason=sm.FAIL_PEER_HANGUP, end_trigger=sm.END_PEER_HANGUP)
        if ev == "violation_end":
            # design contract:**违规**强制结束(silence_violation/severe_violation)→ scheduled|in_progress → failed。
            #   fail_reason 由 bridge reason 映射;未知值兜底 unrecoverable。放行 scheduled→failed(review
            #   竞态:violation_end 与 fire-and-forget connected 无序,violation 先到时会话仍 scheduled)。
            #   已终态则幂等(fail_from_media 内守)。
            reason_key = body.fail_reason or body.end_trigger or ""
            fail_reason = sm.VIOLATION_FAIL_REASONS.get(reason_key, sm.FAIL_UNRECOVERABLE)
            return svc.fail_from_media(session, fail_reason=fail_reason, end_trigger=body.end_trigger)
        if ev == "no_show":
            # 超窗未连入(调度器为主判定源;实时服务侧保留枚举备用):**仅** scheduled → failed(no_show)。
            # 已推进(in_progress:考生实际连入过)的会话 no_show 语义不再适用——幂等返回,不误标失败
            # (review:裸 assert_transition 会放行 in_progress→failed(no_show),语义错)。
            if session.get("status") != sm.SCHEDULED:
                return session  # 幂等/不适用(failed 重复回报、已连入会话的错误回报)
            sm.assert_transition(session["status"], sm.FAILED)
            now_iso = datetime.now(UTC).isoformat()
            session.update({"status": sm.FAILED, "fail_reason": sm.FAIL_NO_SHOW, "ended_at": now_iso})
            db.put_session(session)
            db.set_session_meta_status(session_id, sm.FAILED, {"fail_reason": sm.FAIL_NO_SHOW})
            return session
        raise HTTPException(status_code=422, detail=f"未知 event: {ev}")
    except sm.StateError as exc:
        # 非法转移(如对已完成会话回报)→ 409,不崩
        raise HTTPException(status_code=409, detail=str(exc)) from exc
