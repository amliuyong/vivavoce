"""FastAPI 依赖 —— 鉴权门控。

`get_verifier` 从 app.state 取单例校验器(测试可覆盖 app.state.verifier 注入本地 JWKS)。
`require_user`:任何已认证用户;`require_admin` / `require_staff`:角色门控。
所有 /api/* 路由 MUST 依赖其中之一 —— 没有不带鉴权的业务端点(安全红线)。
"""
from __future__ import annotations

import time

from fastapi import Depends, Header, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import api_key as apikeylib
from .auth import AuthError, CognitoVerifier, Principal
from .candidate_token import CandidateTokenError, verify_token

# auto_error=False:自己控制 401 文案,而非 FastAPI 默认的 "Not authenticated"
_bearer = HTTPBearer(auto_error=False)


def get_verifier(request: Request) -> CognitoVerifier:
    verifier = getattr(request.app.state, "verifier", None)
    if verifier is None:
        # fail-closed:校验器未装配 = 拒绝,绝不放行
        raise HTTPException(status_code=503, detail="鉴权未初始化")
    return verifier


def require_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    verifier: CognitoVerifier = Depends(get_verifier),
) -> Principal:
    if creds is None or not creds.credentials:
        raise HTTPException(status_code=401, detail="缺少 Bearer 访问令牌")
    try:
        principal = verifier.verify(creds.credentials)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    request.state.principal = principal
    return principal


def require_admin(principal: Principal = Depends(require_user)) -> Principal:
    if not principal.is_admin:
        raise HTTPException(status_code=403, detail="需要 admin 角色")
    return principal


def require_staff(principal: Principal = Depends(require_user)) -> Principal:
    # staff 视图;admin 也可访问(admin 看所有)
    if not (principal.is_staff or principal.is_admin):
        raise HTTPException(status_code=403, detail="需要 staff 或 admin 角色")
    return principal


# ════════ design contract:机器/委托凭据鉴权 ════════
def _db(request: Request):
    return request.app.state.db


def authenticate_api_key(request: Request, api_key: str) -> Principal:
    """校验 API Key(design contract,admin 下发的系统集成凭据)→ 机器 Principal(带 scopes)。

    fail-closed:格式非法 / client 不存在 / secret 不符 → 401。client 标记 disabled 也拒。
    """
    parsed = apikeylib.parse_key(api_key)
    if parsed is None:
        raise HTTPException(status_code=401, detail="API Key 格式非法")
    client_id, raw_secret = parsed
    if not client_id:  # 空 client_id(脏数据/误录)→ 拒,绝不放行无主体的 key(review 数据完整性)
        raise HTTPException(status_code=401, detail="API Key 无效")
    client = _db(request).get_api_client(client_id)
    if client is None or client.get("disabled"):
        raise HTTPException(status_code=401, detail="API Key 无效")
    if not apikeylib.verify_secret(raw_secret, client.get("secret_hash", "")):
        raise HTTPException(status_code=401, detail="API Key 无效")
    return Principal(
        sub=client_id, username=client.get("name", client_id), claims={},
        scopes=list(client.get("scopes", [])), client_id=client_id,
        created_by=client.get("created_by"),  # 签发该 key 的 admin(审计追溯,免下游再查 DDB)
        is_machine=True,
    )


def authenticate_delegation(request: Request, token: str) -> Principal:
    """校验 staff 委托 token(design contract)→ 该 staff 的 Principal(继承 staff 边界,is_machine=True 标记代理)。

    委托 token 用 candidate_token 的 HMAC(payload.cid=被代理 staff identity,eid='delegation')。
    ★ 用**独立的** delegation_token_secret(与候选人链接密钥分离,隔离信任域;未单配时回退候选人密钥,
    见 config.from_env)。fail-closed。
    """
    settings = request.app.state.settings
    secret = settings.delegation_token_secret
    if not secret:
        raise HTTPException(status_code=503, detail="委托 token 密钥未配置")
    try:
        payload = verify_token(token, secret=secret, now_epoch=int(time.time()))
    except CandidateTokenError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    if payload.get("eid") != "delegation":
        raise HTTPException(status_code=401, detail="非委托 token")
    staff = payload["cid"]
    # 代理身份 = 该 staff 本人(groups=[staff]),复用现有 booked_by 归属过滤;is_machine 标明是代理。
    return Principal(
        sub=staff, username=staff, groups=["staff"], claims={},
        client_id=None, is_machine=True, scopes=["delegation"],
    )


def require_api_client(
    request: Request, x_api_key: str | None = Header(default=None)
) -> Principal:
    """要求 API Key(机器集成端点)。无 key → 401;超本 client 限流 → 429(design contract)。"""
    if not x_api_key:
        raise HTTPException(status_code=401, detail="缺少 X-Api-Key")
    principal = authenticate_api_key(request, x_api_key)
    # per-client 细粒度限流(令牌桶,进程内):鉴权通过后按 client_id 计;超限 429(防单方刷爆)。
    # 所有 API 端点共享本 client 的桶(读+写);多 task 下有效限速放大(见 rate_limit.py 注释)。
    # v1 可按读/写分桶 + 换 DDB/Redis 分布式计数。
    limiter = getattr(request.app.state, "api_rate_limiter", None)
    if limiter is not None:
        # fail-safe key(review):不让 falsy client_id 短路跳过限流;回退 sub,仍空才不限(理论不达)。
        key = principal.client_id or principal.sub
        if key and not limiter.allow(key):
            # Retry-After(review):告诉机器集成方退避秒数,免盲目风暴重试。
            raise HTTPException(status_code=429, detail="请求过于频繁,请稍后重试(per-client 限流)",
                                headers={"Retry-After": str(limiter.retry_after(key))})
    return principal


def require_scope(scope: str):
    """生成一个依赖:要求机器 Principal 持有指定 scope(无则 403)。"""

    def _dep(principal: Principal = Depends(require_api_client)) -> Principal:
        if not principal.has_scope(scope):
            raise HTTPException(status_code=403, detail=f"API Key 缺少 scope: {scope}")
        return principal

    return _dep


def require_user_or_delegation(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    verifier: CognitoVerifier = Depends(get_verifier),
    x_delegation_token: str | None = Header(default=None),
) -> Principal:
    """接受 [Cognito 用户 JWT] 或 [staff 委托 token]。

    委托 token 经 X-Delegation-Token 头(agent 代 staff);否则走常规 JWT。
    两者都得到一个 Principal,下游归属过滤(booked_by)一视同仁。
    """
    if x_delegation_token:
        return authenticate_delegation(request, x_delegation_token)
    if creds is None or not creds.credentials:
        raise HTTPException(status_code=401, detail="缺少 Bearer 访问令牌或委托 token")
    try:
        principal = verifier.verify(creds.credentials)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    request.state.principal = principal
    return principal


def require_staff_or_delegation(
    principal: Principal = Depends(require_user_or_delegation),
) -> Principal:
    """staff 视图 + 委托 agent(design contract)。委托 token 解析出的 principal groups=[staff],天然满足。

    admin 也可访问。委托 principal 受与 staff 同等约束(只能用 self_bookable Profile、只看自己的)。
    """
    if not (principal.is_staff or principal.is_admin):
        raise HTTPException(status_code=403, detail="需要 staff 或 admin 角色,或有效委托 token")
    return principal
