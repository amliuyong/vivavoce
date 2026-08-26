"""第三方集成 API Key(design contract)—— 服务端机器凭据,client_credentials 的等价实现。

API Key 形如:`aimk_<client_id>_<secret>`(client_id 明文便于定位,secret 高熵随机)。
存储只留 secret 的 SHA-256(不存明文,泄库不可逆);校验时常量时间比对哈希。

与 Cognito 用户 JWT 区分但同一信任根下(都经 CloudFront、都 fail-closed)。每个 client 绑 scope
(sessions:write / results:read / webhooks:manage),按 scope 最小授权。
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

_PREFIX = "aimk"


def generate_key(client_id: str) -> tuple[str, str]:
    """生成一对 (明文完整 key, secret 的 sha256 hex)。明文只在创建时返回一次,之后不可取回。"""
    raw_secret = secrets.token_urlsafe(32)
    full = f"{_PREFIX}_{client_id}_{raw_secret}"
    return full, _hash_secret(raw_secret)


def _hash_secret(raw_secret: str) -> str:
    return hashlib.sha256(raw_secret.encode("utf-8")).hexdigest()


def parse_key(full_key: str) -> tuple[str, str] | None:
    """从完整 key 解析出 (client_id, raw_secret)。格式非法返回 None。

    client_id 由我们生成(hex,无下划线),secret 是 token_urlsafe(可能含 '-'/'_'),故按前两个 '_' 切分,
    其余全部归 secret(token_urlsafe 的 '_' 不会破坏切分)。
    """
    if not full_key or not full_key.startswith(_PREFIX + "_"):
        return None
    rest = full_key[len(_PREFIX) + 1:]
    cid, sep, secret = rest.partition("_")
    if not sep or not cid or not secret:
        return None
    return cid, secret


def verify_secret(raw_secret: str, secret_hash: str) -> bool:
    """常量时间比对 secret 哈希(防时序侧信道)。"""
    return hmac.compare_digest(_hash_secret(raw_secret), secret_hash)
