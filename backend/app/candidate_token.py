"""对外候选人一次性链接 token(design contract)—— HMAC 签名,无第三方依赖。

候选人无公司账号,凭一个带签名 token 的链接访问选时段页。token 绑定单个候选人 + 单个招聘环节,
限时有效。后端用同一密钥验签 + 校验有效期(fail-closed)。

格式:base64url(payload_json) + "." + base64url(hmac_sha256(secret, payload_b64))
payload = {cid: 候选人标识, eid: 环节标识, exp: 过期 epoch 秒, jti: 唯一ID}

注:这是「持有即可用」的 bearer 凭据(限链接有效期内可重复打开以支持改/取消,design contract)。
真正的「用后失效」由业务层(认领时段后该环节不可再约)+ 短有效期共同保证,token 本身无状态。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any


class CandidateTokenError(Exception):
    """token 非法 / 过期 / 签名不符。"""


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(payload_b64: str, secret: str) -> str:
    mac = hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256)
    return _b64url_encode(mac.digest())


def issue_token(*, candidate_id: str, engagement_id: str, exp_epoch: int,
                jti: str, secret: str) -> str:
    """签发候选人 token。exp_epoch=过期 epoch 秒;jti=唯一ID(便于审计/吊销表,可选)。"""
    if not secret:
        raise CandidateTokenError("候选人 token 密钥未配置")
    payload = {"cid": candidate_id, "eid": engagement_id, "exp": int(exp_epoch), "jti": jti}
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    return f"{payload_b64}.{_sign(payload_b64, secret)}"


def verify_token(token: str, *, secret: str, now_epoch: int) -> dict[str, Any]:
    """验签 + 校验有效期(fail-closed)。成功返回 payload;否则抛 CandidateTokenError。

    用 hmac.compare_digest 常量时间比较防时序侧信道。now_epoch 由调用方传(便于测试/避免 Date.now)。
    """
    if not secret:
        raise CandidateTokenError("候选人 token 密钥未配置")
    if not token or token.count(".") != 1:
        raise CandidateTokenError("token 格式非法")
    payload_b64, sig = token.split(".", 1)
    expected = _sign(payload_b64, secret)
    if not hmac.compare_digest(sig, expected):
        raise CandidateTokenError("token 签名不符")
    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError) as exc:
        raise CandidateTokenError("token 负载无法解析") from exc
    if not isinstance(payload, dict) or "exp" not in payload:
        raise CandidateTokenError("token 负载缺字段")
    if int(now_epoch) > int(payload["exp"]):
        raise CandidateTokenError("链接已失效,请联系 HR")
    return payload
