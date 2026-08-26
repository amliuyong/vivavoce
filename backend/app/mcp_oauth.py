"""MCP OAuth 发现文档 + Bearer challenge(design contract,路线 A-lite)。

服务端**不自建** OAuth 授权/回调/令牌门面(authorize/callback/token/register 全无);只提供:
  (a) 未认证 `/api/mcp` 的 `WWW-Authenticate: Bearer resource_metadata=...`(RFC 9728)challenge;
  (b) RFC 9728 protected-resource metadata(裸 + `/api/mcp` 后缀双路径);
  (c) RFC 8414 authorization-server metadata(裸 + 后缀双路径,手填 Cognito Hosted UI 端点,
      **不赌** client OIDC fallback);
真正的授权码 + PKCE 由 client(`mcp-remote`)**直连 Cognito Hosted UI** 完成。

host 归属(design contract Req 2b「三处 host 勿混」):
  - `issuer` / `authorization_servers[0]` = **本站 CloudFront 域**(主路线;8414 §3.3 自洽:issuer 变换出的
    well-known URL == 取到 metadata 的 URL);
  - authorize / token / revoke = **Cognito Hosted UI 域**(`<prefix>.auth.<region>.amazoncognito.com`);
  - jwks = **cognito-idp 域**(`cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json`)。
"""
from __future__ import annotations

from .config import MCP_INVOKE_SCOPE, Settings

# `/api/mcp` 的资源后缀(protected-resource 后缀路径 / AS 后缀变体 / resource 值都用它)。
MCP_RESOURCE_PATH = "/api/mcp"
# 发现文档 well-known 路径(裸 + 后缀)。CloudFront 的 `.well-known/*` 行为回源 ALB 命中这些路由。
PR_METADATA_PATH = "/.well-known/oauth-protected-resource"
AS_METADATA_PATH = "/.well-known/oauth-authorization-server"


class OAuthConfigError(Exception):
    """发现文档所需配置缺失(public_api_base / hosted UI 域)—— 端点 fail-closed 503,不吐畸形文档。"""


def _base(settings: Settings) -> str:
    """本站公网 base(CloudFront 域,无尾斜杠)。缺失即畸形 metadata → fail-closed。"""
    base = (settings.public_api_base or "").rstrip("/")
    if not base:
        raise OAuthConfigError("AIM_PUBLIC_API_BASE 未配置,无法生成 MCP OAuth 发现文档")
    return base


def protected_resource_metadata(settings: Settings, *, resource_suffix: str = "") -> dict:
    """RFC 9728 protected-resource metadata。

    `resource` MUST 与**自身对应的资源 URL** 匹配(裸路径 = host 根;后缀路径 = `…/api/mcp`)——
    严格 client(如 VS Code)会校验 `resource` 与其连接的 server URL 一致,两份不可都返回同一 resource。
    `authorization_servers[0]` = **issuer identifier**(= 本站 CloudFront 域,与 AS metadata `issuer` 一致),
    **不是** metadata 文档 URL 本身(client 由它推导 AS 的 8414 well-known URL)。
    """
    base = _base(settings)
    return {
        "resource": base + resource_suffix,
        "authorization_servers": [base],  # issuer identifier(= 本站域;client 据此推导 AS metadata URL)
        "bearer_methods_supported": ["header"],
        "scopes_supported": [MCP_INVOKE_SCOPE, "openid", "email", "profile"],
    }


def authorization_server_metadata(settings: Settings, *, issuer_suffix: str = "") -> dict:
    """RFC 8414 authorization-server metadata(**full facade 版**:authorize/token/register 指 facade)。

    `issuer` = 本站 ALB 域(+ issuer_suffix,供后缀变体自洽):8414 §3.3 要求「issuer 变换出的
    well-known URL == 取到 metadata 的 URL」—— 裸路径 issuer=host 根(→ 裸 well-known),后缀变体
    issuer=host 根 + `/api/mcp`(→ 路径插入 well-known 后缀),各自自洽(见 well_known 路由的自校断言)。

    **full facade(design contract)**:authorize/token/registration 指 **facade 本站端点**(`{base}/oauth/authorize`
    ·`/oauth/token`·`/register`),facade 内部桥接 Cognito(HMAC state + PKCE 透传 + 假 DCR)——使 client 零配置
    (不填 client_id、随机 loopback 端口)。jwks/revoke 仍指 Cognito 域(token 签发/吊销不经 facade)。host 勿混:
    authorize/token/register 在 **facade/ALB 域**、jwks/revoke 在 **Cognito 域**、issuer = **ALB 域**。
    """
    base = _base(settings)
    hosted = settings.hosted_ui_base
    if not hosted:
        raise OAuthConfigError("AIM_COGNITO_HOSTED_UI_DOMAIN 未配置,无法生成 AS metadata")
    return {
        "issuer": base + issuer_suffix,
        # full facade:authorize/token/registration 指 facade(本站),facade 桥接 Cognito(见 mcp_facade.py)。
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/register",  # 假 DCR:client 据此不填 client_id 自动注册
        "revocation_endpoint": f"{hosted}/oauth2/revoke",  # 吊销直连 Cognito(不经 facade);client enableTokenRevocation
        "jwks_uri": settings.jwks_url,  # cognito-idp 域(token 仍 Cognito 签)
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        # public client 必须 PKCE:严格 client 靠这个字段决定发 PKCE
        "code_challenge_methods_supported": ["S256"],
        # ★ MUST 显式带 "none":8414 缺省语义是 client_secret_basic,本方案是无 secret 的 public client,
        #   漏填则严格 client 可能据缺省判「不支持 none」而拒走。
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["openid", "email", "profile", MCP_INVOKE_SCOPE],
    }


# ── full facade(design contract):HMAC 签名 state(防篡改 + 限时,**不防重放**)──
# 载荷 = {uri: client 真实 loopback redirect_uri, state: client 原 state, ts: epoch 秒, nonce}。
# 复用 candidate_token 同款格式:base64url(payload_json).base64url(hmac_sha256)。max_age 见 STATE_MAX_AGE_S。
STATE_MAX_AGE_S = 900  # 15min;/oauth/callback 校验用 now-ts 单向(拒未来时间戳),超此拒。


def facade_callback_url(settings: Settings) -> str:
    """facade 固定回调(Cognito 只需预登记此单一回调;client 随机 loopback 藏 HMAC state)。"""
    return f"{_base(settings)}/oauth/callback"


def sign_state(*, redirect_uri: str, client_state: str, nonce: str, ts: int, secret: str) -> str:
    """签 HMAC state(把 client 真实 redirect_uri + 原 state 藏进签名负载)。secret 缺失 → OAuthConfigError。"""
    import base64
    import hashlib
    import hmac
    import json

    if not secret:
        raise OAuthConfigError("AIM_MCP_FACADE_STATE_SECRET 未配置,无法签 facade state")
    payload = {"uri": redirect_uri, "state": client_state, "ts": int(ts), "nonce": nonce}
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    mac = hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256)
    sig = base64.urlsafe_b64encode(mac.digest()).rstrip(b"=").decode("ascii")
    return f"{payload_b64}.{sig}"


def verify_state(signed: str, *, secret: str, now_epoch: int) -> dict:
    """验 HMAC state:校签(常量时间)+ 限时(now-ts 单向,拒未来 + 超 max_age)。返回负载或抛 OAuthConfigError。

    ★ 只防篡改 + 限时,**不防重放**:nonce 不做无状态比对,900s 内同 signed state 可重放;真正一次性由
    下游 Cognito 授权码 + PKCE 兜底(design contract §硬边界)。
    """
    import base64
    import hashlib
    import hmac
    import json

    if not secret:
        raise OAuthConfigError("AIM_MCP_FACADE_STATE_SECRET 未配置,无法验 facade state")
    if not signed or signed.count(".") != 1:
        raise OAuthConfigError("facade state 格式非法")
    payload_b64, sig = signed.split(".", 1)
    mac = hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256)
    expected = base64.urlsafe_b64encode(mac.digest()).rstrip(b"=").decode("ascii")
    if not hmac.compare_digest(sig, expected):
        raise OAuthConfigError("facade state 签名不符(篡改)")
    try:
        pad = "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + pad))
    except (ValueError, json.JSONDecodeError) as exc:
        raise OAuthConfigError("facade state 负载无法解析") from exc
    if not isinstance(payload, dict) or "ts" not in payload or "uri" not in payload:
        raise OAuthConfigError("facade state 负载缺字段")
    ts = int(payload["ts"])
    age = int(now_epoch) - ts
    # 单向校验:拒未来时间戳(age<0)+ 拒超 max_age。不用 abs()(参照 design contract-oauth-facade)。
    if age < 0 or age > STATE_MAX_AGE_S:
        raise OAuthConfigError("facade state 已过期或时间戳非法")
    # ★ 注意:payload 含 nonce,但此处**不做无状态去重比对** —— HMAC state 只防篡改 + 限时,**不防重放**
    #   (design contract §硬边界)。900s 内同一 signed state 可重放;真正一次性由下游 Cognito 授权码 + PKCE 兜底。
    #   nonce 仅占位/审计用(每次 authorize 随机,便于日志关联),勿据其实现「防重放」的错觉。
    return payload


def is_loopback_redirect(uri: str) -> bool:
    """redirect_uri 白名单:只放行 loopback(127.0.0.1 / localhost,任意端口)。防 open-redirect。

    非 loopback(自定义 scheme / 远程)在真机确认 Claude Code 格式前一律拒(design contract state / P7)。
    """
    from urllib.parse import urlparse

    if not uri:
        return False
    try:
        p = urlparse(uri)
    except ValueError:
        return False
    return p.scheme in ("http", "https") and (p.hostname in ("127.0.0.1", "localhost"))


def challenge_value(settings: Settings) -> str:
    """未认证 `/api/mcp` 的 `WWW-Authenticate` 值(RFC 9728)。

    指向**后缀路径** protected-resource metadata(`…/oauth-protected-resource/api/mcp`)—— 其 `resource`
    恰为 `…/api/mcp`,与 client 连接的 server URL 一致,做 resource 匹配校验的严格 client 友好
    (裸路径 resource=host 根 ≠ `…/api/mcp` 会被拒;P1 若证 client 不校验匹配则退裸路径亦可)。
    base 缺失时退化为裸 `Bearer`(仍是合法 401 challenge,不畸形)。
    """
    try:
        base = _base(settings)
    except OAuthConfigError:
        return "Bearer"
    return f'Bearer resource_metadata="{base}{PR_METADATA_PATH}{MCP_RESOURCE_PATH}"'


def insufficient_scope_challenge(scope: str) -> str:
    """缺 scope 的 403 challenge(RFC 6750 §3.1):给 client 明确的再授权信号,而非裸 403。"""
    return f'Bearer error="insufficient_scope", scope="{scope}"'
