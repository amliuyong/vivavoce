"""join token 单测(M1-B)—— 签发/验签对拍/过期/坏签名,钉死跨栈契约(bridge 侧对称实现)。"""
from __future__ import annotations

import base64
import hashlib
import hmac

import pytest

from app.join_token import sign_join_token, verify_join_token

SECRET = "test-bridge-callback-secret-0123456789"
NOW = 1_800_000_000  # 任意基准秒级时间戳


def test_sign_format_matches_contract():
    """契约钉死:v1.<session_id>.<exp_unix>.<sig>,sig = base64url 无 padding 的 HMAC-SHA256。"""
    token = sign_join_token("sess_abc123", NOW + 600, SECRET)
    parts = token.split(".")
    assert len(parts) == 4
    assert parts[0] == "v1"
    assert parts[1] == "sess_abc123"
    assert parts[2] == str(NOW + 600)
    # sig 独立重算对拍(与 bridge 侧算法逐字节等价)
    msg = f"v1.sess_abc123.{NOW + 600}"
    expected = base64.urlsafe_b64encode(
        hmac.new(SECRET.encode(), msg.encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    assert parts[3] == expected
    assert "=" not in parts[3]  # 无 padding


def test_sign_verify_roundtrip():
    token = sign_join_token("sess_xyz", NOW + 3600, SECRET)
    assert verify_join_token(token, SECRET, NOW) == "sess_xyz"
    # 恰好 now == exp 仍有效(与 candidate_token 同口径:now > exp 才失效)
    assert verify_join_token(token, SECRET, NOW + 3600) == "sess_xyz"


def test_verify_expired_returns_none():
    token = sign_join_token("sess_xyz", NOW - 1, SECRET)
    assert verify_join_token(token, SECRET, NOW) is None


def test_verify_bad_signature_returns_none():
    token = sign_join_token("sess_xyz", NOW + 600, SECRET)
    tampered = token[:-4] + ("AAAA" if not token.endswith("AAAA") else "BBBB")
    assert verify_join_token(tampered, SECRET, NOW) is None
    # 换密钥验签也不过
    assert verify_join_token(token, "another-secret", NOW) is None


def test_verify_tampered_fields_return_none():
    token = sign_join_token("sess_xyz", NOW + 600, SECRET)
    _, sid, exp, sig = token.split(".")
    # 篡改 session_id / exp(签名不再匹配)
    assert verify_join_token(f"v1.sess_evil.{exp}.{sig}", SECRET, NOW) is None
    assert verify_join_token(f"v1.{sid}.{int(exp) + 9999}.{sig}", SECRET, NOW) is None


def test_verify_malformed_returns_none():
    assert verify_join_token("", SECRET, NOW) is None
    assert verify_join_token("garbage", SECRET, NOW) is None
    assert verify_join_token("v1.only.three", SECRET, NOW) is None
    assert verify_join_token("v2.sess_x.123.sig", SECRET, NOW) is None  # 版本不符
    assert verify_join_token("v1..123.sig", SECRET, NOW) is None  # 空 session_id
    token = sign_join_token("sess_xyz", NOW + 600, SECRET)
    assert verify_join_token(token, "", NOW) is None  # 空密钥 fail-closed


def test_sign_empty_secret_raises():
    with pytest.raises(ValueError):
        sign_join_token("sess_xyz", NOW + 600, "")
