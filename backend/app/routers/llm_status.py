"""登录用户可读的 LLM 凭据非密状态。"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from ..auth import Principal
from ..deps import require_user
from ..llm_config_service import LlmConfigStore, llm_credential_status
from ..models import LlmCredentialStatusOut

logger = logging.getLogger("aim.llm_status")

router = APIRouter(prefix="/api/llm-credential-status", tags=["llm-status"])


@router.get("", response_model=LlmCredentialStatusOut)
def get_llm_credential_status(
    request: Request,
    response: Response,
    _: Principal = Depends(require_user),
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    store = LlmConfigStore(request.app.state.settings)
    try:
        raw = store.read_raw()
    except Exception as exc:  # noqa: BLE001
        logger.warning("读 LLM 凭据状态失败: %s", exc)
        raise HTTPException(status_code=502, detail="读取 LLM 凭据状态失败") from exc
    return llm_credential_status(raw)
