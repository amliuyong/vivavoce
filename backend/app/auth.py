"""Cognito JWT 鉴权 —— 安全红线(HLD D9:不得有未鉴权端点)。

校验链(fail-closed,任一不过即拒):
  1. Authorization: Bearer <jwt> 存在且格式正确
  2. JWT 头部 kid 命中 Cognito JWKS(RS256 验签)
  3. iss == https://cognito-idp.<region>.amazonaws.com/<pool>
  4. token_use == "access"(用 access token 调 API)
  5. client_id == app client(access token 用 client_id 字段)
  6. exp 未过期
角色来自 `cognito:groups`(admin / staff,见 002)。

测试注入:auth_mode=local 时用本地内存 JWKS(测试自己用同一私钥签 token),
其余字段校验逻辑与生产**完全一致** —— 即测试覆盖的就是真实校验路径。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from threading import Condition

import httpx
from jose import jwt
from jose.exceptions import JWTError
from jose.utils import base64url_decode  # noqa: F401  (确保 cryptography 后端可用)

from .config import Settings


class AuthError(Exception):
    """鉴权失败 —— 由依赖层翻译为 401/403。"""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


class InsufficientScopeError(AuthError):
    """token 合法但缺所需 scope(design contract)—— 403 + `WWW-Authenticate: Bearer error="insufficient_scope"`。

    与「client_id 不匹配 / 验签失败」的 401 区分:token 本身有效、只是无权访问本资源,给 client 明确的
    再授权信号(RFC 6750 §3.1),而非裸 403 或误判成登录失效。
    """

    def __init__(self, scope: str):
        self.scope = scope
        super().__init__(403, f"缺少所需 scope: {scope}")


@dataclass
class Principal:
    """已认证主体。可以是用户(Cognito 用户 JWT,带 groups)或机器(design contract,带 scopes)。"""

    sub: str
    username: str
    groups: list[str] = field(default_factory=list)
    claims: dict = field(default_factory=dict)
    # 机器主体(design contract:API Key / client_credentials)专属:
    scopes: list[str] = field(default_factory=list)
    client_id: str | None = None  # 机器 client 标识(资源隔离基准)
    # 该 API key 由哪个 admin 签发(client 记录的 created_by:admin username)。审计用——
    # 把"此请求用的 key 是谁创建的"直接带进鉴权上下文,免下游再查 DDB。用户/委托主体为 None。
    created_by: str | None = None
    is_machine: bool = False

    @property
    def is_admin(self) -> bool:
        return "admin" in self.groups

    @property
    def is_staff(self) -> bool:
        return "staff" in self.groups

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes


class JwksCache:
    """JWKS 拉取 + 缓存。生产从 Cognito 拉;测试可直接 seed 一组本地 keys。"""

    def __init__(self, jwks_url: str, ttl_seconds: int = 3600, miss_refresh_min_interval: float = 60.0):
        self._url = jwks_url
        self._ttl = ttl_seconds
        # 未命中 kid 触发的强制刷新最小间隔(节流):防坏 token 刷爆 Cognito,又能在密钥轮转时补刷。
        self._miss_refresh_min_interval = miss_refresh_min_interval
        self._keys: dict[str, dict] = {}
        self._fetched_at: float = 0.0
        self._last_miss_refresh: float = 0.0
        # Condition:刷新线程刷完 notify_all,等待线程 wait 到刷新结束再复查
        # —— 既防 thundering herd(只一个线程刷),又不让其他线程在冷启动/轮转时误返回 None。
        self._cond = Condition()
        self._refreshing = False
        self._last_refresh_error: Exception | None = None

    def seed(self, keys: list[dict]) -> None:
        """测试用:直接注入 JWKS(避免网络)。"""
        with self._cond:
            self._keys = {k["kid"]: k for k in keys}
            self._fetched_at = time.time()

    def _refresh(self) -> None:
        resp = httpx.get(self._url, timeout=5.0)
        resp.raise_for_status()
        data = resp.json()
        self._keys = {k["kid"]: k for k in data.get("keys", [])}
        self._fetched_at = time.time()

    def get_key(self, kid: str) -> dict | None:
        now = time.time()
        with self._cond:
            if kid in self._keys:
                return self._keys[kid]
            fresh = (now - self._fetched_at) < self._ttl
            # 未命中 kid。即使缓存新鲜也可能是**密钥轮转**新签发的 kid(#4):此时应补刷一次,
            # 而非直接拒。但要节流:距上次"未命中刷新"不足 min_interval 就不刷(防坏 token 刷爆)。
            miss_throttled = (now - self._last_miss_refresh) < self._miss_refresh_min_interval
            if self._keys and fresh and miss_throttled:
                return None
            if self._refreshing:
                # 已有线程在刷:等它刷完,然后**复查谓词 + 感知刷新成败**(#5)。
                self._cond.wait(timeout=10.0)
                if self._last_refresh_error is not None:
                    raise AuthError(503, f"无法获取 JWKS: {self._last_refresh_error}")
                return self._keys.get(kid)
            # 由本线程负责刷新
            self._refreshing = True
            if not (self._keys and fresh):
                pass  # 缓存空/过期的常规刷新
            else:
                self._last_miss_refresh = now  # 记一次未命中触发的补刷(用于节流)
        err: Exception | None = None
        try:
            self._refresh()
        except Exception as exc:  # noqa: BLE001
            err = exc
        finally:
            with self._cond:
                self._refreshing = False
                self._last_refresh_error = err
                self._cond.notify_all()  # 唤醒所有等待刷新的线程(它们会感知 err)
        if err is not None:
            # 刷新线程与等待线程返回同一语义(503),不再出现"刷新者 503 / 等待者 401"的混乱(#5)。
            raise AuthError(503, f"无法获取 JWKS: {err}")
        with self._cond:
            return self._keys.get(kid)


class CognitoVerifier:
    """无状态的 JWT 校验器,持有 settings + JwksCache。"""

    def __init__(self, settings: Settings, jwks: JwksCache | None = None):
        self.settings = settings
        self.jwks = jwks or JwksCache(settings.jwks_url)

    def verify(
        self,
        token: str,
        *,
        allowed_client_ids: list[str] | None = None,
        required_scope: str | None = None,
    ) -> Principal:
        """校验 Cognito access token → Principal(fail-closed)。

        design contract:`allowed_client_ids` / `required_scope` **按调用方传入**(每路径不同),而非在
        构造器/settings 上全局放宽 —— 防「单 verifier 全局放松」的硬伤复发:
          - `allowed_client_ids=None`(默认)→ 只认 WebClient(`user_pool_client_id`),= Web 路径现状不变。
          - `/api/mcp` Bearer 分支传 `allowed_client_ids=[mcp_client_id]` + `required_scope="aim/invoke"`
            (**不含 WebClient**:SRP 登录 token 不带自定义 scope,必被 scope 校验挡,塞进去徒增面)。
        scope 缺失 → `InsufficientScopeError`(403 + insufficient_scope challenge),与 401 区分。
        """
        if not token:
            raise AuthError(401, "缺少访问令牌")
        try:
            header = jwt.get_unverified_header(token)
        except JWTError as exc:
            raise AuthError(401, f"令牌头部无法解析: {exc}") from exc

        kid = header.get("kid")
        if not kid:
            raise AuthError(401, "令牌缺少 kid")

        key = self.jwks.get_key(kid)
        if key is None:
            raise AuthError(401, "令牌 kid 未匹配任何签名公钥")

        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                issuer=self.settings.issuer,
                # access token 的受众在 client_id 字段,这里关掉 aud 内建校验、手动验 client_id
                options={"verify_aud": False},
            )
        except JWTError as exc:
            raise AuthError(401, f"令牌验签/校验失败: {exc}") from exc

        if claims.get("token_use") != "access":
            raise AuthError(401, "需要 access 令牌(token_use=access)")

        # client_id ∈ 本路径允许集。默认(None)= 只认 WebClient;显式传入(即使空 list)一律尊重,
        # **不能用 `or` 兜底** —— `[] or [web]` 会把「显式空集」误当默认放回 WebClient,违反 fail-closed
        # (MCP 路径在 mcp_client_id 缺失时传 []:此时应无任何 client 可过,而非退回接受 WebClient,review 高危)。
        allowed = [self.settings.user_pool_client_id] if allowed_client_ids is None else allowed_client_ids
        client_id = claims.get("client_id")
        if client_id not in allowed:
            raise AuthError(401, "令牌 client_id 不匹配")

        # scope claim(空格分隔;Cognito access token 的 scope 字段)。
        raw_scope = claims.get("scope", "") or ""
        scopes = raw_scope.split() if isinstance(raw_scope, str) else []
        if required_scope is not None and required_scope not in scopes:
            # token 有效但缺 scope → 403 insufficient_scope(而非放行、而非裸 403)。
            raise InsufficientScopeError(required_scope)

        groups = self._extract_roles(claims)

        return Principal(
            sub=claims.get("sub", ""),
            username=claims.get("username", claims.get("sub", "")),
            groups=groups,
            claims=claims,
            scopes=scopes,
            client_id=client_id,
        )

    def _extract_roles(self, claims: dict) -> list[str]:
        """从 JWT claims 取内部角色列表(design contract:claim 名可配 + 值映射可配)。

        单一来源:**只**读 `settings.role_claim` 配置的那一个 claim(默认 cognito:groups),忽略 token 中
        其它可能的角色 claim(不合并,防多来源意外提权)。归一化严格复刻现状 `claims.get(k, []) or []` +
        `isinstance(str)` 顺序(falsy 兜底**先于** str 分支,否则 "" 会误成 [""])。
        """
        # 归一化为 list[str]。`raw or []` 兜底所有 falsy(None/""/0/False/[]),与现状 `... or []` 逐字节等价;
        # **先 falsy 兜底,再 str 分支** —— 空串在此已归 [](不会走到 isinstance(str) 变成 [""])。
        raw = claims.get(self.settings.role_claim, []) or []
        if isinstance(raw, str):
            values: list[str] = [raw]
        elif isinstance(raw, list):
            # 过滤非 str 元素(异常 IdP 形态防炸);正常 OIDC 角色数组全 str。
            values = [x for x in raw if isinstance(x, str)]
        else:
            # dict / number 等异常类型 → 无角色(fail-safe,不误授)。
            values = []

        # 值映射(design contract):role_map is None = 恒等(现状);配了(含空 {})则翻译。
        role_map = self.settings.role_map
        if role_map is None:
            return values
        # 有键取映射值、无键丢弃(宁少授勿多授)、丢空映射值、去重(保序)。
        mapped: list[str] = []
        seen: set[str] = set()
        for v in values:
            internal = role_map.get(v)
            if internal and internal not in seen:
                seen.add(internal)
                mapped.append(internal)
        return mapped
