"""候选人对外自助路由(design contract,v2)。

两组端点:
  - HR 侧(/api/engagements/*):Cognito admin 鉴权 —— 管时段池、签发候选人链接。
  - 候选人侧(/api/candidate/*):**一次性签名 token 鉴权**(无 Cognito 账号),选时段/看状态/取消。

候选人端点不挂 require_user,而是用 token 校验(fail-closed,守 D9:仍经统一入口,token 验签)。
候选人侧只见流程状态,不见任何评分/转写/录音(结果隔离)。时段 = 纯时间窗(无电话/会议字段)。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from ..auth import Principal
from ..candidate_service import CandidateService
from ..candidate_token import CandidateTokenError
from ..deps import require_admin
from ..models import (
    CandidateBookIn,
    CandidateLinkIn,
    CandidateLinkOut,
    CandidateRescheduleIn,
    CandidateSlotPublic,
    CandidateStatusOut,
    SessionJoinOut,
    SlotIn,
    SlotOut,
)
from .sessions import issue_join_token

# HR 侧(招聘环节 / 时段池):admin-only
hr_router = APIRouter(prefix="/api/engagements", tags=["candidate-hr"])
# 候选人侧:token 鉴权(无 Cognito)
cand_router = APIRouter(prefix="/api/candidate", tags=["candidate"])


def _db(request: Request):
    return request.app.state.db


def _service(request: Request) -> CandidateService:
    settings = request.app.state.settings
    return CandidateService(
        _db(request),
        token_secret=settings.candidate_token_secret,
        edit_lock_min=settings.staff_edit_lock_min,
    )


# ════════ HR 侧(admin) ════════
@hr_router.post("/slots", response_model=SlotOut, status_code=201)
def add_slot(body: SlotIn, request: Request, _: Principal = Depends(require_admin)) -> dict:
    """HR 录入一个面试时段(纯时间窗)到时段池。"""
    db = _db(request)
    if db.get_agent(body.agent_id) is None:
        raise HTTPException(status_code=404, detail="Agent 不存在")
    # 可选题库(design contract):指定了则须存在
    if body.question_bank_id and db.get_question_bank(body.question_bank_id) is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    # explicit(design contract review):HR 显式带 question_bank_id 字段(含显式 null/""=无题库,不回退 Agent 默认);
    # 省略则 book 时回退 Agent 默认。与 sessions 的 explicit-vs-omitted 语义一致。
    explicit = "question_bank_id" in body.model_fields_set
    return _service(request).add_slot(body.model_dump(), bank_explicit=explicit)


@hr_router.get("/{engagement_id}/slots", response_model=list[SlotOut])
def list_slots(engagement_id: str, request: Request, _: Principal = Depends(require_admin)) -> list[dict]:
    """HR 看某环节全部时段(含已认领,带候选人/会话)。"""
    return _db(request).list_slots_by_engagement(engagement_id)


@hr_router.post("/links", response_model=CandidateLinkOut, status_code=201)
def issue_link(body: CandidateLinkIn, request: Request, _: Principal = Depends(require_admin)) -> dict:
    """为候选人 + 环节签发一次性自助链接(token)。

    校验:该环节必须**至少有一个时段**(防 fix:无时段就签 → 候选人点开链接无可选时段、死路)。
    候选人只能从已有时段里选,故签链接前 HR 须先建好时段池(design contract 流程:先录时段→签链接)。
    """
    try:
        slots = _db(request).list_slots_by_engagement(body.engagement_id)
        if not slots:
            raise HTTPException(
                status_code=400,
                detail="该环节还没有可选时段,请先添加至少一个时段再签发链接(否则候选人打开链接无时段可选)。",
            )
        return _service(request).issue_link(body.model_dump())
    except PermissionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# ════════ 候选人侧(token 鉴权) ════════
def _verify_token(request: Request, token: str | None) -> dict:
    """从 token 解析候选人身份(fail-closed)。

    token 经 **X-Candidate-Token 头**(前端生产路径:URL 把 token 放 hash 路径段 `#/candidate/<token>`,
    经头传,不进 query/Referer/CloudFront access log)或 query `?token=`(仅供 curl/手工测试)传入。
    两者都接受、头优先(review:生产走头,query 留作调试便利)。
    """
    if not token:
        raise HTTPException(status_code=401, detail="缺少候选人链接 token")
    try:
        return _service(request).verify(token)
    except PermissionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except CandidateTokenError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@cand_router.get("/slots", response_model=list[CandidateSlotPublic])
def candidate_open_slots(
    request: Request, token: str | None = None, x_candidate_token: str | None = Header(default=None)
) -> list[dict]:
    """候选人看可选时段(脱敏:只 slot_id + 起止)。"""
    payload = _verify_token(request, token or x_candidate_token)
    return _service(request).list_open_slots(payload["eid"])


@cand_router.post("/book")
def candidate_book(
    body: CandidateBookIn, request: Request,
    token: str | None = None, x_candidate_token: str | None = Header(default=None),
) -> dict:
    """候选人选时段(认领时段 + 知情同意)。返回 slot/session/起止。"""
    payload = _verify_token(request, token or x_candidate_token)
    try:
        return _service(request).book(payload, body.slot_id, consent=body.consent)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@cand_router.get("/status", response_model=CandidateStatusOut)
def candidate_status(
    request: Request, token: str | None = None, x_candidate_token: str | None = Header(default=None)
) -> dict:
    """候选人侧状态(只见流程态,不见评分/转写/录音)。"""
    payload = _verify_token(request, token or x_candidate_token)
    return _service(request).my_status(payload)


@cand_router.get("/join", response_model=SessionJoinOut)
def candidate_join(
    request: Request, token: str | None = None, x_candidate_token: str | None = Header(default=None)
) -> dict:
    """候选人连入实时对话(design contract-C 收口):凭一次性 token 定位其预约的会话 → 签发 join_token。

    鉴权:候选人 token(cid/eid)权威定位 session,只能连自己预约的(不信任何入参 session_id)。
    窗口校验 + 预创建 + 签 token 复用 admin join 的 issue_join_token(同一 fail-closed / 窗口口径)。
    客户端拿 join_token 后连 wss://<站点>/rt/ws?session_id=<id>,与 admin/staff 路径同协议。
    """
    payload = _verify_token(request, token or x_candidate_token)
    try:
        session = _service(request).find_joinable_session(payload)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return issue_join_token(request, session)


@cand_router.post("/reschedule")
def candidate_reschedule(
    body: CandidateRescheduleIn, request: Request,
    token: str | None = None, x_candidate_token: str | None = Header(default=None),
) -> dict:
    """候选人改约到另一空闲时段(design contract);距开始 >30min;原子换时段(先认领新再释放旧)。"""
    payload = _verify_token(request, token or x_candidate_token)
    try:
        return _service(request).reschedule(payload, body.new_slot_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@cand_router.post("/cancel")
def candidate_cancel(
    request: Request, token: str | None = None, x_candidate_token: str | None = Header(default=None)
) -> dict:
    """候选人取消预约(距开始 >30min);释放时段回池。"""
    payload = _verify_token(request, token or x_candidate_token)
    try:
        return _service(request).cancel(payload)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
