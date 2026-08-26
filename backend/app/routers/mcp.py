"""MCP 协议端点(design contract)—— 符合 MCP Streamable HTTP transport(2025-06-18)。

`POST /api/mcp`:JSON-RPC 2.0 over HTTP。第三方 agent 用标准 MCP client 直接接入 AIM。
鉴权两条路径并存(design contract,优先 Bearer):
  1. **Cognito OAuth Bearer**(主路径,design contract):`Authorization: Bearer <Cognito access token>`,
     校 client_id∈{MCP client} + scope `aim/invoke` + group staff/admin → 继承 staff 边界。
  2. **委托 token**(design contract,回退):`X-Delegation-Token`,staff 授权 agent 代理自己。
两者皆无 / Bearer 失败且无委托 → **401 + `WWW-Authenticate: Bearer resource_metadata=…`**(RFC 9728),
使 OAuth-aware client 自动进入发现流程。缺 scope → 403 + insufficient_scope challenge。

设计取舍:
- 只返回 application/json(单响应),不开 SSE 流 —— AIM 工具皆请求/响应式,无服务器推送需求。
- 无状态会话:不强制 Mcp-Session-Id(每个请求自带 token 鉴权即可;不做跨请求会话态)。
- `/api/mcp` 用自定义 body 鉴权(非 FastAPI 依赖链),故 group 门控**自行**做(不复用 require_staff)。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi.security.utils import get_authorization_scheme_param

from .. import mcp_oauth
from ..auth import AuthError, InsufficientScopeError, Principal
from ..config import MCP_INVOKE_SCOPE
from ..deps import authenticate_delegation, get_verifier
from ..mcp_server import INVALID_REQUEST, PARSE_ERROR, McpServer, _rpc_error

logger = logging.getLogger("aim.mcp")

router = APIRouter(prefix="/api/mcp", tags=["mcp"])

# 支持的 MCP 协议版本(client 经 MCP-Protocol-Version 头声明)
_SUPPORTED_PROTOCOL = {"2025-06-18", "2025-03-26"}


def _server(request: Request) -> McpServer:
    return McpServer(request.app.state.db, request.app.state.settings,
                     dispatcher=getattr(request.app.state, "dispatcher", None))


def _challenge_401(request: Request, detail: str) -> HTTPException:
    """带 RFC 9728 challenge 的 401(缺 token 与失效 token 同处理)。"""
    return HTTPException(status_code=401, detail=detail,
                         headers={"WWW-Authenticate": mcp_oauth.challenge_value(request.app.state.settings)})


def _authenticate(request: Request, authorization: str | None,
                  x_delegation_token: str | None) -> Principal:
    """MCP 鉴权:先 Bearer(design contract),再回退委托 token(design contract)。两者皆无 → 带 challenge 的 401。

    两者**同时存在**:优先 Bearer,Bearer 校验失败**才**回退委托 token(宽容回退,更健壮)。
    """
    settings = request.app.state.settings
    scheme, token = get_authorization_scheme_param(authorization or "")
    bearer = token if scheme.lower() == "bearer" and token else None
    # 诊断(design contract;debug 级,默认不刷屏,排障时 AIM_LOG_LEVEL=DEBUG 打开):记「是否带 Authorization /
    # scheme」,不记 token 内容(敏感)。真机曾据此定位「mcp-remote 换 token 被 VPN 挡 → 裸调无 Bearer」。
    logger.debug("mcp auth: has_authorization=%s scheme=%r has_bearer=%s has_delegation=%s mcp_client_id_set=%s",
                 bool(authorization), scheme or None, bool(bearer), bool(x_delegation_token),
                 bool(settings.mcp_client_id))

    if bearer:
        try:
            allowed = [settings.mcp_client_id] if settings.mcp_client_id else []
            principal = get_verifier(request).verify(
                bearer, allowed_client_ids=allowed, required_scope=MCP_INVOKE_SCOPE)
            # group 门控自行做(MCP router 非 FastAPI 依赖链):须 staff 或 admin。
            if not (principal.is_staff or principal.is_admin):
                logger.warning("mcp auth: bearer 通过但 group 不含 staff/admin(groups=%s)", principal.groups)
                raise HTTPException(status_code=403, detail="需要 staff 或 admin 角色")
            # OAuth Principal 形状(design contract):is_machine=True(与委托路径对齐:同为程序代 staff;仅审计标签)。
            principal.is_machine = True
            return principal
        except InsufficientScopeError as exc:
            # token 有效但缺 scope → 403 insufficient_scope(不回退委托:意图明确是 OAuth 路径)。
            logger.warning("mcp auth: bearer 缺 scope %s → 403 insufficient_scope", exc.scope)
            raise HTTPException(status_code=403, detail=exc.detail,
                                headers={"WWW-Authenticate": mcp_oauth.insufficient_scope_challenge(exc.scope)}) from exc
        except AuthError as exc:
            logger.warning("mcp auth: bearer verify 失败 status=%s detail=%r", exc.status_code, exc.detail)
            # 后端故障(如 JWKS 拉取失败 = 503)**原样透传**,不折成 401+challenge —— 否则 OAuth client 会误判
            # 「token 无效」进入重登录/刷新循环、掩盖后端验证服务故障(review 中)。也不因故障回退委托。
            if exc.status_code >= 500:
                raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
            # 真·校验失败(401):若还带了委托 token,宽容回退;否则带 challenge 的 401。
            if not x_delegation_token:
                raise _challenge_401(request, "Bearer 令牌无效") from None

    if x_delegation_token:
        try:
            return authenticate_delegation(request, x_delegation_token)  # 抛 401/503
        except HTTPException as exc:
            if exc.status_code == 401:
                raise _challenge_401(request, exc.detail) from exc
            raise

    raise _challenge_401(request, "缺少 Bearer 访问令牌或 X-Delegation-Token")


@router.post("")
async def mcp_endpoint(
    request: Request,
    authorization: str | None = Header(default=None),
    x_delegation_token: str | None = Header(default=None),
    mcp_protocol_version: str | None = Header(default=None),
) -> Response:
    """MCP JSON-RPC 端点。Bearer / 委托 token 鉴权 → 解析 staff → 处理 initialize/tools.list/tools.call。"""
    import json

    # 协议版本校验(MCP:无效版本 400;缺省按 2025-03-26 兼容)
    if mcp_protocol_version is not None and mcp_protocol_version not in _SUPPORTED_PROTOCOL:
        raise HTTPException(status_code=400, detail=f"不支持的 MCP 协议版本: {mcp_protocol_version}")

    principal = _authenticate(request, authorization, x_delegation_token)
    staff = principal.username

    raw = await request.body()
    try:
        msg = json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        return Response(content=json.dumps(_rpc_error(None, PARSE_ERROR, "JSON 解析失败")),
                        media_type="application/json", status_code=400)
    if not isinstance(msg, dict):
        # 批量(数组)本实现不支持;MCP 允许单消息
        return Response(content=json.dumps(_rpc_error(None, INVALID_REQUEST, "仅支持单个 JSON-RPC 消息")),
                        media_type="application/json", status_code=400)

    result = _server(request).handle(msg, staff=staff)
    # 通知(无 id)→ 202 无 body(MCP transport 约定)
    if result is None:
        return Response(status_code=202)
    return Response(content=json.dumps(result, ensure_ascii=False), media_type="application/json")


@router.get("")
def mcp_get(
    request: Request,
    authorization: str | None = Header(default=None),
    x_delegation_token: str | None = Header(default=None),
) -> Response:
    """MCP GET(可选 SSE 流):本实现不提供服务器推送。

    design contract:未认证 GET 返回 **401 + challenge**(而非裸 405)—— 若目标 client 先开 GET(SSE)探测再
    进发现流,405 可能使其不进 OAuth;返回带 `WWW-Authenticate` 的 401 让 OAuth-aware client 进发现。
    已认证但无 SSE 可推 → 405(transport 允许)。
    """
    # 未认证 → _authenticate 抛 401 + challenge(引导 client 进 OAuth 发现);已认证 → 无 SSE 可推,405。
    _authenticate(request, authorization, x_delegation_token)
    return Response(status_code=405)
