"""实时会话 join token(M1-B)—— HMAC 签名,stdlib 实现,无第三方依赖。

跨栈契约(已冻结,实时会话服务/bridge 侧对称实现,勿改格式):
  token = "v1.<session_id>.<exp_unix>.<sig>"
  sig   = base64url 无 padding( HMAC-SHA256(key=AIM_BRIDGE_CALLBACK_SECRET, msg="v1.<session_id>.<exp_unix>") )
  exp_unix = 秒级 Unix 时间戳。

客户端流程:GET /api/sessions/{id}/join → {join_token, ws_path, expires_at}
→ 连 wss://<站点>/rt/ws?session_id=<id> → 首帧 {"type":"auth","token":<join_token>}。

签发在控制面(routers/sessions.py);生产验签在实时会话服务(bridge)。
本模块的 verify_join_token 供单测对拍 + 契约钉死,与 bridge 侧逐字节等价。
"""
from __future__ import annotations

import base64
import hashlib
import hmac


def _b64url_nopad(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _sig(msg: str, secret: str) -> str:
    mac = hmac.new(secret.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256)
    return _b64url_nopad(mac.digest())


def sign_join_token(session_id: str, exp_unix: int, secret: str) -> str:
    """签发 join token(契约见模块 docstring)。secret 空 = 配置缺失,调用方应先 fail-closed(503)。"""
    if not secret:
        raise ValueError("join token 密钥未配置(AIM_BRIDGE_CALLBACK_SECRET)")
    msg = f"v1.{session_id}.{int(exp_unix)}"
    return f"{msg}.{_sig(msg, secret)}"


def verify_join_token(token: str, secret: str, now_unix: int) -> str | None:
    """验签 + 校验有效期(fail-closed)。成功返回 session_id,否则 None(格式/签名/过期一律 None)。

    - 签名对拍用 token 里的**字面** exp 串重算(不经 int 归一,防 "07" 之类规范化歧义)。
    - hmac.compare_digest 常量时间比较防时序侧信道。
    - 过期判定与 candidate_token 同口径:now_unix > exp 即失效(恰好等于 exp 仍有效)。
    """
    if not token or not secret:
        return None
    parts = token.split(".")
    if len(parts) != 4 or parts[0] != "v1":
        return None
    _, session_id, exp_str, sig = parts
    if not session_id:
        return None
    if not hmac.compare_digest(sig, _sig(f"v1.{session_id}.{exp_str}", secret)):
        return None
    try:
        exp = int(exp_str)
    except ValueError:
        return None  # 签名虽对但 exp 非契约形态(秒级整数)→ 拒
    if int(now_unix) > exp:
        return None  # 过期
    return session_id
