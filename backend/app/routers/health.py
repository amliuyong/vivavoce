"""健康检查 —— **唯一不需要鉴权的端点**(ALB target health check 用)。

只返回存活信号,不泄露任何业务数据 / 配置 / 身份信息,故无鉴权是安全的。
所有其它端点一律带鉴权(见 deps.require_*)。
"""
from __future__ import annotations

from fastapi import APIRouter

from .. import __version__

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "aim-orchestrator", "version": __version__}
