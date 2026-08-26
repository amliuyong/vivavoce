"""MCP OAuth facade 端点(design contract,full facade)—— 让 client 零配置连接(不填 client_id)。

补齐 Cognito 缺的两块,Cognito 退居后端签 token:
  - **假 DCR**(`POST /register`):回预建共享 public client_id(不真建 Cognito client、无库);
  - **HMAC state 桥接**(`GET /oauth/authorize` + `GET /oauth/callback` + `POST /oauth/token`):
    把 client 真实 loopback redirect_uri(随机端口)藏进 HMAC 签名 state,facade 用固定回调对 Cognito,
    破解 Cognito 的 redirect_uri 白名单硬约束(loopback 随机端口无法预登记)。

**app 层公开路由**(D9 已登记豁免,design contract「不破 D9」):这些端点只搬 OAuth 握手字节 / 回预建公开
client_id,**facade 从不自签 token**(token 由 Cognito 签),不返回任何受保护数据。真正认证在 Cognito。

硬边界(design contract §硬安全边界):PKCE 透传(facade 不碰 code_challenge/verifier,Cognito 校验);
HMAC state 防篡改+限时**不防重放**(重放一次性靠下游 Cognito code+PKCE);验签失败不重定向(防 open-redirect)。
"""
from __future__ import annotations

import time
import uuid
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from .. import mcp_oauth
from ..config import Settings
from ..mcp_oauth import OAuthConfigError

# include_in_schema=False:facade 端点不进前端 client 的 OpenAPI 契约(与发现文档同,design contract)。
router = APIRouter(tags=["mcp-facade"], include_in_schema=False)


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _now() -> int:
    return int(time.time())


# ── 假 DCR(RFC 7591 端点形态)──
@router.post("/register")
async def register(request: Request) -> Response:
    """假 DCR:回预建共享 public client_id + 回显 redirect_uris,不真建 Cognito client、无副作用。

    client 遵循标准发现流程时不填 client_id 即可 POST 此端点自动拿到 client_id(破解 Cognito 无 DCR)。
    """
    s = _settings(request)
    if not s.mcp_client_id:
        raise HTTPException(status_code=503, detail="MCP client 未配置(AIM_MCP_CLIENT_ID 缺失)")
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — 空/非 JSON body 容忍(有的 client 空注册)
        body = {}
    redirect_uris = body.get("redirect_uris") if isinstance(body, dict) else None
    resp = {
        "client_id": s.mcp_client_id,
        "token_endpoint_auth_method": "none",  # 无 secret public client
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }
    # 回显 client 传的 redirect_uris(RFC 7591 形态;facade 不校验此处,真正校验在 authorize/callback 的白名单)。
    if isinstance(redirect_uris, list):
        resp["redirect_uris"] = redirect_uris
    if isinstance(body, dict) and isinstance(body.get("client_name"), str):
        resp["client_name"] = body["client_name"]
    return JSONResponse(resp, status_code=201)


# ── 授权码中转:HMAC state 破解 loopback 白名单 ──
@router.get("/oauth/authorize")
def authorize(request: Request) -> Response:
    """把 client 真实 redirect_uri 藏进 HMAC 签名 state,302 到 Cognito Hosted UI(固定回调 + PKCE 透传)。"""
    s = _settings(request)
    hosted = s.hosted_ui_base
    if not hosted or not s.mcp_client_id:
        raise HTTPException(status_code=503, detail="facade 未就绪(Hosted UI 域 / MCP client 缺失)")
    q = request.query_params
    redirect_uri = q.get("redirect_uri") or ""
    # redirect_uri 白名单:只放行 loopback(防 open-redirect;非 loopback 待真机确认 Claude Code 格式)。
    if not mcp_oauth.is_loopback_redirect(redirect_uri):
        raise HTTPException(status_code=400, detail="redirect_uri 不在白名单(仅 loopback)")
    try:
        signed = mcp_oauth.sign_state(
            redirect_uri=redirect_uri,
            client_state=q.get("state") or "",
            nonce=uuid.uuid4().hex,
            ts=_now(),
            secret=s.mcp_facade_state_secret or "",
        )
    except OAuthConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    # 转 Cognito authorize:redirect_uri 换 facade 固定回调;PKCE(code_challenge/method)原样透传;
    # client_id 用预建 MCP client_id(即便 client 传了别的也以本站预建为准)。scope 透传(client 决定)。
    params = {
        "client_id": s.mcp_client_id,
        "response_type": q.get("response_type", "code"),
        "redirect_uri": mcp_oauth.facade_callback_url(s),
        "state": signed,
    }
    for k in ("scope", "code_challenge", "code_challenge_method"):
        v = q.get(k)
        if v:
            params[k] = v
    return RedirectResponse(url=f"{hosted}/oauth2/authorize?{urlencode(params)}", status_code=302)


@router.get("/oauth/callback")
def callback(request: Request) -> Response:
    """Cognito 回调 facade 固定回调 → 验 HMAC state → 302 回 client 真实 loopback(带 code + client 原 state)。

    验签失败/过期 → 400 **不重定向**(防被当 open-redirect 跳板)。Cognito 侧错误(如 error=access_denied)
    也按 state 回传给 client loopback(client 需知晓登录失败)。
    """
    s = _settings(request)
    q = request.query_params
    signed = q.get("state") or ""
    try:
        payload = mcp_oauth.verify_state(signed, secret=s.mcp_facade_state_secret or "", now_epoch=_now())
    except OAuthConfigError as exc:
        # 验签/时限失败:400,不重定向(open-redirect 防护)。
        raise HTTPException(status_code=400, detail=f"state 校验失败: {exc}") from exc
    client_redirect = payload.get("uri") or ""
    if not mcp_oauth.is_loopback_redirect(client_redirect):
        raise HTTPException(status_code=400, detail="state 内 redirect_uri 非法")
    # 回传 client:原 state + Cognito 给的 code(或 error)。
    out = {}
    if payload.get("state"):
        out["state"] = payload["state"]
    for k in ("code", "error", "error_description"):
        v = q.get(k)
        if v:
            out[k] = v
    sep = "&" if "?" in client_redirect else "?"
    return RedirectResponse(url=f"{client_redirect}{sep}{urlencode(out)}", status_code=302)


# ── 换 token:redirect_uri 强改回 facade 固定回调,转发 Cognito ──
@router.post("/oauth/token")
async def token(request: Request) -> Response:
    """把 redirect_uri 强改回 facade 固定回调(与 authorize 一致,否则 Cognito 拒),转发 Cognito /oauth2/token,透传响应。

    支持 authorization_code(换 token)与 refresh_token(续期)两 grant。PKCE code_verifier 原样透传(Cognito 校验)。
    """
    s = _settings(request)
    hosted = s.hosted_ui_base
    if not hosted or not s.mcp_client_id:
        raise HTTPException(status_code=503, detail="facade 未就绪")
    # 手动解析 x-www-form-urlencoded(不依赖 python-multipart;token 端点恒 urlencoded)。
    from urllib.parse import parse_qsl

    raw = (await request.body()).decode("utf-8", errors="replace")
    form = dict(parse_qsl(raw, keep_blank_values=True))
    # authorization_code grant:redirect_uri MUST 与 authorize 时一致 = facade 固定回调。
    if form.get("grant_type") == "authorization_code":
        form["redirect_uri"] = mcp_oauth.facade_callback_url(s)
    # client_id 用预建 MCP client_id(public client 无 secret)。
    form["client_id"] = s.mcp_client_id
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            up = await client.post(
                f"{hosted}/oauth2/token",
                data=form,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"转发 Cognito token 端点失败: {exc}") from exc
    # 透传 Cognito 响应(含 access/refresh/id token 或 error);保留状态码与 JSON 体。
    media = up.headers.get("content-type", "application/json")
    return Response(content=up.content, status_code=up.status_code, media_type=media)
