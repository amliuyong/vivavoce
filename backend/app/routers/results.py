"""结果评估与报告路由(design contract)。

- GET /api/results/{session_id}:admin 看全部;staff 仅看自己会话的结果(只读、无复核)。
  返回前按需把 recording_url 填为**限时预签名 URL**(录音存在才填,design contract 录音回放)。
- GET /api/results/{session_id}/transcript:整场转写(供报告页「转写下载」),同样的归属校验。
- PATCH /api/results/{session_id}:人工复核 approve/override —— **仅 admin**。
  双轨保留:AI 出分(ai_*)与人工判定不互相覆盖,override 写 review_* 而非改 AI 原始分。
"""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import Principal
from ..deps import require_admin, require_user
from ..models import ResultOut, ResultReviewIn, TranscriptOut

router = APIRouter(prefix="/api/results", tags=["results"])


def _db(request: Request):
    return request.app.state.db


def _recordings(request: Request):
    return request.app.state.recordings


def _authz_session_owner(db, session_id: str, principal: Principal) -> dict:
    """取 session 并做归属校验:staff 只能碰自己的会话结果。返回 session;不存在/越权抛异常。"""
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if not principal.is_admin and session.get("booked_by") != principal.username:
        raise HTTPException(status_code=403, detail="无权访问该结果")
    return session


@router.get("/{session_id}", response_model=ResultOut)
def get_result(
    session_id: str, request: Request, principal: Principal = Depends(require_user)
) -> dict:
    db = _db(request)
    _authz_session_owner(db, session_id, principal)
    result = db.get_result(session_id)
    if result is None:
        raise HTTPException(status_code=404, detail="结果尚未生成")
    # 按需生成限时预签名回放 URL(录音存在才填;不存在/未配桶 → None,报告页显示「无录音」)。
    # 不持久化进 Results:URL 限时会过期,每次 GET 现取最新(design contract 录音访问经预签名 URL)。
    url = _recordings(request).presigned_url(session_id)
    if url:
        result = {**result, "recording_url": url}
    return result


@router.get("/{session_id}/transcript", response_model=TranscriptOut)
def get_transcript(
    session_id: str, request: Request, principal: Principal = Depends(require_user)
) -> dict:
    """整场转写(design contract「转写下载」)。同 GET 结果的归属校验:staff 只能取自己会话的转写。

    转写在结束后于结果页一次性可看/下载(design contract 明确不做进行中实时转写流)。
    """
    db = _db(request)
    _authz_session_owner(db, session_id, principal)
    events = db.list_transcript(session_id)
    # SessionEvents 的转写行字段:speaker("user"|"ai")/text/ts(与 bridge transcript-store 对称)
    lines = [
        {"ts": e.get("ts"), "speaker": e.get("speaker"), "text": e.get("text")}
        for e in events
    ]
    return {"session_id": session_id, "lines": lines}


@router.patch("/{session_id}", response_model=ResultOut)
def review_result(
    session_id: str, body: ResultReviewIn, request: Request, principal: Principal = Depends(require_admin)
) -> dict:
    """admin 人工复核(design contract)。staff 无复核权限(本端点 require_admin)。

    - approve:review_status=approved,不动判定。
    - override:review_status=overridden,写人工改判(review_passed / review_overall_score),
      AI 原始分(passed / overall_score)保留不变(双轨)。
    """
    db = _db(request)
    result = db.get_result(session_id)
    if result is None:
        raise HTTPException(status_code=404, detail="结果尚未生成")

    now_iso = datetime.now(UTC).isoformat()
    patch: dict = {
        "reviewer": principal.username,
        "reviewed_at": now_iso,
        "review_note": body.note,
    }
    if body.action == "approve":
        patch["review_status"] = "approved"
    else:  # override
        patch["review_status"] = "overridden"
        # 人工改判写独立字段,AI 原始判定不被覆盖(双轨保留)
        if body.passed is not None:
            patch["review_passed"] = body.passed
        if body.overall_score is not None:
            patch["review_overall_score"] = body.overall_score

    updated = db.update_result(session_id, patch)
    return updated
