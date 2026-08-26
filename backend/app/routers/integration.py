"""API / Webhook 集成路由(design contract,v2)。

三组端点:
  - admin 管理 API client(/api/integration/clients):创建/列/吊销系统集成凭据(admin-only)。
  - client 程序化访问(/api/integration/*):持 API Key,按 scope 发起会话/管 webhook(机器身份)。
  - staff 自助委托(/api/me/delegations):staff 签发/撤销给第三方 agent 的委托 token。

机器发起复用 005 同一路径/状态机/全局闸门(不另起一套);幂等键防重复发起。
client 资源隔离:机器创建的资源带 created_by_client,只能查自己的。
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from urllib.parse import quote, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response

from .. import state_machine as sm
from ..auth import Principal
from ..deps import require_admin, require_scope, require_staff
from ..integration_service import IntegrationService
from ..models import (
    AgentIn,
    AgentOut,
    ApiClientIn,
    ApiClientOut,
    DelegationIn,
    DelegationOut,
    QuestionBankIn,
    QuestionBankOut,
    QuestionBankUploadResult,
    RealtimeClientSecretOut,
    ResultOut,
    SessionJoinOut,
    SessionLaunchIn,
    SessionOut,
    WebhookIn,
    WebhookOut,
)
from ..realtime_client_secret import sign_realtime_client_secret
from ..routers.agents import assert_agent_deletable, validate_default_bank
from ..routers.questionbanks import (
    _MAX_CSV_BYTES,
    assert_qb_deletable,
    parse_questions_csv,
)
from ..routers.sessions import best_effort_make_ready, issue_join_token
from ..session_service import (
    LaunchError,
    PerQuestionCheckRequiresQuestions,
    SessionService,
    assert_resolvable,
    build_session_record,
    connect_deadline_for_session,
    make_dispatcher,
)

# admin 管理 client
admin_router = APIRouter(prefix="/api/integration/clients", tags=["integration-admin"])
# 机器程序化访问(API Key)
api_router = APIRouter(prefix="/api/integration", tags=["integration-api"])
# staff 自助委托
deleg_router = APIRouter(prefix="/api/me/delegations", tags=["integration-delegation"])

logger = logging.getLogger("aim.integration")


def _db(request: Request):
    return request.app.state.db


def _svc(request: Request) -> IntegrationService:
    settings = request.app.state.settings
    return IntegrationService(_db(request),
                              # 独立委托密钥(与候选人链接密钥分离,隔离信任域;回退逻辑在 config.from_env)
                              delegation_secret=settings.delegation_token_secret,
                              public_api_base=settings.public_api_base)


# ════════ admin 管理 API client ════════
@admin_router.post("", response_model=ApiClientOut, status_code=201)
def create_client(body: ApiClientIn, request: Request, principal: Principal = Depends(require_admin)) -> dict:
    return _svc(request).create_client(body.name, body.scopes, created_by=principal.username)


@admin_router.get("", response_model=list[ApiClientOut])
def list_clients(request: Request, principal: Principal = Depends(require_admin)) -> list[dict]:
    # 每个 admin 只见自己创建的 key(归属隔离,created_by=本人 username)。
    return _svc(request).list_clients(owner=principal.username)


@admin_router.delete("/{client_id}", status_code=204)
def revoke_client(client_id: str, request: Request, principal: Principal = Depends(require_admin)) -> None:
    # 只能吊销自己创建的;他人的(或不存在)→ 404(不泄露存在性)。
    if not _svc(request).revoke_client(client_id, owner=principal.username):
        raise HTTPException(status_code=404, detail="client 不存在")


# ════════ 机器程序化发起(API Key + scope) ════════
@api_router.post("/sessions", response_model=SessionOut, status_code=201)
def api_launch_session(
    body: SessionLaunchIn, request: Request,
    principal: Principal = Depends(require_scope("sessions:write")),
    idempotency_key: str | None = Header(default=None),
) -> dict:
    """第三方经 API Key 程序化发起会话(design contract):复用 005 同一路径/状态机/全局闸门 + 幂等。

    资源隔离:打 created_by_client 标记,机器只能查自己创建的(api_get_session 据此)。
    """
    db = _db(request)
    agent = db.get_agent(body.agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent 不存在")
    # 题库(design contract):显式带 question_bank_id(含显式 null=无题库)按字面;省略则回退 Agent 默认。
    if "question_bank_id" in body.model_fields_set:
        bank_id = (body.question_bank_id or "").strip() or None
    else:
        bank_id = agent.get("default_question_bank_id")
    bank = None
    if bank_id:
        bank = db.get_question_bank(bank_id)
        if bank is None:
            raise HTTPException(status_code=404, detail=f"题库 {bank_id} 不存在")

    def _do_launch() -> dict:
        session = build_session_record(
            agent=agent,
            bank=bank,
            booked_by=None, origin="api", target_id=None,
            status=sm.SCHEDULED,  # 即时开始:预创建即就绪,等考生连入(connected 事件推进)
        )
        # per_question_check 无题 fail-fast(design contract)
        try:
            assert_resolvable(agent, session.get("resolved_questions", []))
        except PerQuestionCheckRequiresQuestions as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        session["created_by_client"] = principal.client_id
        db.put_session(session)
        settings = request.app.state.settings
        dispatcher = getattr(request.app.state, "dispatcher", None) or make_dispatcher(
            db, settings.bridge_dial_url, secret=settings.bridge_callback_secret)
        # design contract review:必须注入 webhook_emitter,否则 API 发起的会话完成/失败时不触发 webhook
        # (此前只有 sessions.py/scheduler.py 接了,API/MCP 漏接 → 集成方收不到终态回调)。
        from ..events import make_webhook_emitter
        from ..session_service import make_llm_config_store
        svc = SessionService(db, dispatcher, max_concurrency=settings.max_concurrency,
                             webhook_emitter=make_webhook_emitter(db, settings),
                             llm_config_store=make_llm_config_store(settings),  # design contract
                             session_join_expire_min=settings.session_join_expire_min)
        try:
            return svc.launch(session, agent)
        except LaunchError as exc:  # design contract:LLM 凭据/模型 fail-fast → 400
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    if idempotency_key:
        result, _first = _svc(request).idempotent(principal.client_id, idempotency_key, _do_launch)
        return result
    return _do_launch()


@api_router.get("/sessions/{session_id}", response_model=SessionOut)
def api_get_session(
    session_id: str, request: Request,
    principal: Principal = Depends(require_scope("sessions:read")),
) -> dict:
    """机器查会话:资源隔离 —— 只能查本 client 创建的(否则 404,不泄露存在性)。"""
    session = _db(request).get_session(session_id)
    if session is None or session.get("created_by_client") != principal.client_id:
        raise HTTPException(status_code=404, detail="会话不存在")
    return session


@api_router.get("/sessions/{session_id}/join", response_model=SessionJoinOut)
def api_join_session(
    session_id: str, request: Request,
    principal: Principal = Depends(require_scope("sessions:write")),
) -> dict:
    """机器为**自己创建**的会话签发实时会话 join token(design contract):补齐「对外语音后端」
    唯一缺环——持 API Key 的第一方后端据此把会话驱动进实时语音(客户端凭 join_token 连
    wss://<入口>/rt/ws?session_id=<id>,首帧 {"type":"auth","token":<join_token>})。

    **scope 复用 `sessions:write`(design contract 评审裁决,勿拆 `sessions:join`)**:「能程序化发起
    会话」在业务语义上已蕴含「能驱动它连入实时对话」;只读监控类集成拿 `sessions:read` 天然
    签不了票,最小授权仍成立。

    **GET + 天然幂等**:与登录路径 `GET /api/sessions/{id}/join` HTTP 动词对齐;同一 session_id
    同一秒签出的 token(HMAC over `v1.<sid>.<exp>`)逐字节相同,故不设 Idempotency-Key。

    资源隔离(fail-closed,复用 api_get_session 口径):会话不存在 / created_by_client 不符 →
    404(不泄露存在性),不为他 client 或前端用户创建的会话签票。签发本身(状态校验 409 /
    密钥缺失 503 / best-effort 重新预创建 / HMAC 签名 / 固定 4h TTL)**复用** sessions.py 的
    issue_join_token,不另写一套(与登录/候选人路径同一实现)。
    """
    session = _db(request).get_session(session_id)
    if session is None or session.get("created_by_client") != principal.client_id:
        raise HTTPException(status_code=404, detail="会话不存在")
    return issue_join_token(request, session)


@api_router.post(
    "/sessions/{session_id}/realtime-client-secret",
    response_model=RealtimeClientSecretOut,
)
def api_realtime_client_secret(
    session_id: str,
    request: Request,
    response: Response,
    principal: Principal = Depends(require_scope("sessions:write")),
) -> dict:
    session = _db(request).get_session(session_id)
    if session is None or session.get("created_by_client") != principal.client_id:
        raise HTTPException(status_code=404, detail="会话不存在")
    if session.get("status") not in (sm.SCHEDULED, sm.IN_PROGRESS):
        raise HTTPException(status_code=409, detail="会话已结束,无法连入")
    try:
        connect_deadline = connect_deadline_for_session(
            session,
            request.app.state.settings.session_join_expire_min,
        )
        connect_deadline_at = sm.parse_iso(connect_deadline) if connect_deadline else None
    except (LaunchError, TypeError, ValueError) as exc:
        logger.error("会话 connect deadline 无效,拒绝签发 realtime client secret session=%s: %s",
                     session_id, exc)
        raise HTTPException(status_code=409, detail="会话状态异常,无法连入") from exc
    if connect_deadline_at and connect_deadline_at <= datetime.now(UTC):
        logger.warning("会话 connect deadline 已过,拒绝签发 realtime client secret session=%s", session_id)
        raise HTTPException(status_code=409, detail="会话已超过可连入时限")

    settings = request.app.state.settings
    signing_key = settings.realtime_client_secret
    if not signing_key:
        raise HTTPException(status_code=503, detail="Realtime client-secret 密钥未配置")
    if len(signing_key.encode("utf-8")) < 32:
        logger.error("Realtime client-secret 密钥长度不足,拒绝签发")
        raise HTTPException(status_code=503, detail="Realtime client-secret 密钥配置无效")
    public_base = settings.public_api_base
    parsed = urlsplit(public_base or "")
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=503, detail="可信公网 API base 未配置")

    best_effort_make_ready(request, session)

    issued_at = int(datetime.now(UTC).timestamp())
    value = sign_realtime_client_secret(session_id, issued_at, signing_key)
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    path = f"{parsed.path.rstrip('/')}/v1/realtime"
    url = urlunsplit((ws_scheme, parsed.netloc, path, f"session_id={quote(session_id, safe='')}", ""))
    response.headers["Cache-Control"] = "no-store"
    return {"value": value, "expires_at": issued_at + 600, "url": url}


# ════════ Agent / 题库 程序化管理(admin 级,design contract)════════
# 单租户模型:API Key = admin 机器分身,管理类资源全局无隔离(可 CRUD 全部),复用 admin 路由同一业务逻辑。
# 审计留痕:写入时记 created_by_client(哪把 key)+ created_by_admin(签发该 key 的 admin);只记录、不门控。
def _now() -> str:
    return datetime.now(UTC).isoformat()


def _audit_create(principal: Principal) -> dict:
    """POST 新建时的审计字段(design contract):记哪把 key + 签发人 + 时间。纯留痕。"""
    return {
        "created_by_client": principal.client_id,
        "created_by_admin": principal.created_by,
        "created_at": _now(),
    }


def _audit_update(principal: Principal) -> dict:
    """PUT/CSV 改版时的审计字段:记改动者 key + 签发人 + 时间。纯留痕。"""
    return {
        "updated_by_client": principal.client_id,
        "updated_by_admin": principal.created_by,
        "updated_at": _now(),
    }


# ── Agent CRUD ──
@api_router.get("/agents", response_model=list[AgentOut])
def api_list_agents(
    request: Request, principal: Principal = Depends(require_scope("agents:read")),
) -> list[dict]:
    """机器列出全部 Agent(admin 级,非 self_bookable_only —— 与 admin Web 后台一致)。"""
    return _db(request).list_agents()


@api_router.post("/agents", response_model=AgentOut, status_code=201)
def api_create_agent(
    body: AgentIn, request: Request, principal: Principal = Depends(require_scope("agents:write")),
) -> dict:
    """机器建 Agent(复用 admin 路由逻辑:default_question_bank_id 存在性校验 + 打审计字段)。"""
    db = _db(request)
    validate_default_bank(db, body)
    agent = body.model_dump()
    agent.update({"agent_id": f"agent_{uuid.uuid4().hex[:12]}", "version": "v1", "status": "active"})
    agent.update(_audit_create(principal))
    return db.put_agent(agent)


@api_router.get("/agents/{agent_id}", response_model=AgentOut)
def api_get_agent(
    agent_id: str, request: Request, principal: Principal = Depends(require_scope("agents:read")),
) -> dict:
    agent = _db(request).get_agent(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent 不存在")
    return agent


@api_router.put("/agents/{agent_id}", response_model=AgentOut)
def api_update_agent(
    agent_id: str, body: AgentIn, request: Request,
    principal: Principal = Depends(require_scope("agents:write")),
) -> dict:
    """机器改 Agent(复用 db.update_agent 的版本快照:当前版入 history、bump version)。"""
    db = _db(request)
    validate_default_bank(db, body)
    fields = {**body.model_dump(), **_audit_update(principal)}
    updated = db.update_agent(agent_id, fields)
    if updated is None:
        raise HTTPException(status_code=404, detail="Agent 不存在")
    return updated


@api_router.delete("/agents/{agent_id}", status_code=204)
def api_delete_agent(
    agent_id: str, request: Request, principal: Principal = Depends(require_scope("agents:write")),
) -> Response:
    """机器删 Agent(复用 assert_agent_deletable:活动会话 / 时段 Slot 引用 → 409)。"""
    db = _db(request)
    if db.get_agent(agent_id) is None:
        raise HTTPException(status_code=404, detail="Agent 不存在")
    assert_agent_deletable(db, agent_id)
    db.delete_agent(agent_id)
    return Response(status_code=204)


# ── 题库 CRUD ──
@api_router.get("/question-banks", response_model=list[QuestionBankOut])
def api_list_question_banks(
    request: Request, principal: Principal = Depends(require_scope("question-banks:read")),
) -> list[dict]:
    return _db(request).list_question_banks()


@api_router.post("/question-banks", response_model=QuestionBankOut, status_code=201)
def api_create_question_bank(
    body: QuestionBankIn, request: Request,
    principal: Principal = Depends(require_scope("question-banks:write")),
) -> dict:
    bank = body.model_dump()
    bank.update({
        "question_bank_id": f"qb_{uuid.uuid4().hex[:12]}", "version": "v1", "status": "active",
    })
    bank.update(_audit_create(principal))
    return _db(request).put_question_bank(bank)


@api_router.get("/question-banks/{question_bank_id}", response_model=QuestionBankOut)
def api_get_question_bank(
    question_bank_id: str, request: Request,
    principal: Principal = Depends(require_scope("question-banks:read")),
) -> dict:
    bank = _db(request).get_question_bank(question_bank_id)
    if bank is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    return bank


@api_router.put("/question-banks/{question_bank_id}", response_model=QuestionBankOut)
def api_update_question_bank(
    question_bank_id: str, body: QuestionBankIn, request: Request,
    principal: Principal = Depends(require_scope("question-banks:write")),
) -> dict:
    """机器改题库(复用 db.update_question_bank 版本快照)。"""
    fields = {**body.model_dump(), **_audit_update(principal)}
    updated = _db(request).update_question_bank(question_bank_id, fields)
    if updated is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    return updated


@api_router.delete("/question-banks/{question_bank_id}", status_code=204)
def api_delete_question_bank(
    question_bank_id: str, request: Request,
    principal: Principal = Depends(require_scope("question-banks:write")),
) -> Response:
    """机器删题库(复用 assert_qb_deletable:活动会话 / Agent 默认 / 时段 Slot 引用 → 409)。"""
    db = _db(request)
    if db.get_question_bank(question_bank_id) is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    assert_qb_deletable(db, question_bank_id)
    db.delete_question_bank(question_bank_id)
    return Response(status_code=204)


@api_router.post("/question-banks/{question_bank_id}/upload-csv", response_model=QuestionBankUploadResult)
async def api_upload_csv(
    question_bank_id: str, request: Request,
    mode: str = Query("append", pattern="^(append|replace)$"),
    principal: Principal = Depends(require_scope("question-banks:write")),
) -> dict:
    """机器批量上传题库 CSV(复用 parse_questions_csv + replace 0 题保护;body = 原始 CSV 文本 UTF-8)。"""
    db = _db(request)
    bank = db.get_question_bank(question_bank_id)
    if bank is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    raw = await request.body()
    if len(raw) > _MAX_CSV_BYTES:
        raise HTTPException(status_code=413, detail="CSV 过大(上限 5MB)")
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=422, detail="CSV 必须是 UTF-8 编码") from exc

    parsed, errors = parse_questions_csv(content)
    total_rows = len(parsed) + len(errors)
    new_questions = [q.model_dump() for q in parsed]
    existing = list(bank.get("questions", []))
    # replace 0 题保护(与 admin 路由一致):整份坏 CSV/空文件 replace 会清空题库 → 拒绝。
    if mode == "replace" and not new_questions:
        first = f"首个错误:第 {errors[0].line} 行 {errors[0].reason}" if errors else "CSV 无任何有效题目"
        raise HTTPException(status_code=422, detail=f"replace 模式未导入任何题目(会清空题库)→ 已拒绝。{first}")
    merged = (existing + new_questions) if mode == "append" else new_questions

    body = {k: v for k, v in bank.items() if k in QuestionBankIn.model_fields}
    body["questions"] = merged
    body.update(_audit_update(principal))
    updated = db.update_question_bank(question_bank_id, body)
    if updated is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    return {
        "question_bank_id": question_bank_id, "mode": mode, "total_rows": total_rows,
        "imported": len(new_questions), "rejected": len(errors),
        "total_questions": len(merged), "errors": [e.model_dump() for e in errors],
    }


# ── 结果读取(全局读,admin 级复核语义;单租户模型无 client 隔离)──
@api_router.get("/results/{session_id}", response_model=ResultOut)
def api_get_result(
    session_id: str, request: Request,
    principal: Principal = Depends(require_scope("results:read")),
) -> dict:
    """机器读评分报告(全局读:API Key = admin 级,报告复核本是 admin 能力)。"""
    result = _db(request).get_result(session_id)
    if result is None:
        raise HTTPException(status_code=404, detail="结果不存在(会话可能未完成或未评分)")
    return result


# ── Webhook(client 用 webhooks:manage scope 管自己的) ──
@api_router.post("/webhooks", response_model=WebhookOut, status_code=201)
def register_webhook(
    body: WebhookIn, request: Request,
    principal: Principal = Depends(require_scope("webhooks:manage")),
) -> dict:
    return _svc(request).register_webhook(principal.client_id, body.url, body.events)


@api_router.get("/webhooks", response_model=list[WebhookOut])
def list_webhooks(
    request: Request, principal: Principal = Depends(require_scope("webhooks:manage")),
) -> list[dict]:
    return _svc(request).list_webhooks(principal.client_id)


@api_router.delete("/webhooks/{webhook_id}", status_code=204)
def delete_webhook(
    webhook_id: str, request: Request,
    principal: Principal = Depends(require_scope("webhooks:manage")),
) -> None:
    # 隔离:只能删自己的 webhook(list 已按 client_id 限定;直接删指定 id 也限定 client_id)
    own = {w["webhook_id"] for w in _db(request).list_webhooks(principal.client_id)}
    if webhook_id not in own:
        raise HTTPException(status_code=404, detail="webhook 不存在")
    _svc(request).delete_webhook(principal.client_id, webhook_id)


# ════════ staff 自助委托(给第三方 agent) ════════
@deleg_router.post("", response_model=DelegationOut, status_code=201)
def issue_delegation(
    body: DelegationIn, request: Request, principal: Principal = Depends(require_staff)
) -> dict:
    """staff 自助签发委托 token,授权第三方 agent 代自己预约/查询(design contract)。

    admin 也可调(代任意身份意义不大,这里按调用者 username 绑定)。
    """
    try:
        return _svc(request).issue_delegation(principal.username, body.label, body.ttl_hours)
    except PermissionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
