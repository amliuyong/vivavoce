"""当前用户信息 —— 验证 token 已认证 + 暴露角色(前端落地页/导航用)。"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import Principal
from ..deps import require_user
from ..models import WhoAmI

router = APIRouter(prefix="/api", tags=["me"])


@router.get("/me", response_model=WhoAmI)
def whoami(principal: Principal = Depends(require_user)) -> WhoAmI:
    return WhoAmI(
        sub=principal.sub,
        username=principal.username,
        groups=principal.groups,
        is_admin=principal.is_admin,
        is_staff=principal.is_staff,
    )
