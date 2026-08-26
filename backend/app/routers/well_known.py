"""MCP OAuth 发现端点(design contract,RFC 9728 + RFC 8414)。

**app 层公开发现路由**(与 `/health` 同类,D9 已显式登记豁免):只吐公开的 authorization server 指针 /
端点 JSON,**不返回任何受保护数据**、不自签发信任(真正认证在 Cognito)。路径在 `/.well-known/*`
(非 `/api/*`),CloudFront 的 `.well-known/*` 行为回源 ALB。

双路径设计(RFC 9728 §3.1 两种探测形态 + 严格 client 的 resource / 8414 issuer 一致校验):
  - 裸路径 `/.well-known/oauth-protected-resource` → resource = host 根(MCP 基址);
  - 资源后缀 `/.well-known/oauth-protected-resource/api/mcp` → resource = `…/api/mcp`(与连接 URL 一致);
  - AS metadata 同理裸 + 后缀,各自 `issuer` 变换出的 well-known URL == 本请求 URL(8414 §3.3 自洽)。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response

from .. import mcp_oauth
from ..config import Settings
from ..mcp_oauth import (
    AS_METADATA_PATH,
    MCP_RESOURCE_PATH,
    PR_METADATA_PATH,
    OAuthConfigError,
)

# include_in_schema=False:公开发现文档不进前端 client 的 OpenAPI 契约(design contract)。
router = APIRouter(tags=["mcp-oauth"], include_in_schema=False)


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _json(payload: dict) -> Response:
    import json

    # 发现文档公开、可缓存;显式 media_type application/json(RFC 要求)。
    return Response(content=json.dumps(payload, ensure_ascii=False), media_type="application/json")


# ── RFC 9728 protected-resource metadata(裸 + /api/mcp 后缀)──
@router.get(PR_METADATA_PATH)
def protected_resource_bare(request: Request) -> Response:
    """裸路径:resource = host 根(MCP 基址)。"""
    try:
        return _json(mcp_oauth.protected_resource_metadata(_settings(request)))
    except OAuthConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get(PR_METADATA_PATH + MCP_RESOURCE_PATH)
def protected_resource_suffix(request: Request) -> Response:
    """资源后缀路径:resource = `…/api/mcp`(与 client 连接 URL 一致,严格 client 友好)。"""
    try:
        return _json(
            mcp_oauth.protected_resource_metadata(_settings(request), resource_suffix=MCP_RESOURCE_PATH)
        )
    except OAuthConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# ── RFC 8414 authorization-server metadata(裸 + /api/mcp 后缀)──
@router.get(AS_METADATA_PATH)
def as_metadata_bare(request: Request) -> Response:
    """裸路径:issuer = host 根 → issuer 变换出的 well-known URL == 本请求 URL(8414 §3.3 自洽)。"""
    try:
        return _json(mcp_oauth.authorization_server_metadata(_settings(request)))
    except OAuthConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get(AS_METADATA_PATH + MCP_RESOURCE_PATH)
def as_metadata_suffix(request: Request) -> Response:
    """后缀变体:issuer = host 根 + `/api/mcp`(路径插入式 well-known 后缀,与本请求 URL 一致)。"""
    try:
        return _json(
            mcp_oauth.authorization_server_metadata(_settings(request), issuer_suffix=MCP_RESOURCE_PATH)
        )
    except OAuthConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
