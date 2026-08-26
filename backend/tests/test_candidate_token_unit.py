"""016 候选人 token 纯逻辑单元测试:HMAC 签发/验签/有效期/防篡改。"""
from __future__ import annotations

import pytest

from app.candidate_token import CandidateTokenError, issue_token, verify_token

SECRET = "unit-secret-abcdef0123456789"


def _issue(exp=2_000_000_000, cid="cand@x.com", eid="eng1") -> str:
    return issue_token(candidate_id=cid, engagement_id=eid, exp_epoch=exp, jti="j1", secret=SECRET)


def test_roundtrip_ok():
    tok = _issue()
    payload = verify_token(tok, secret=SECRET, now_epoch=1_000_000_000)
    assert payload["cid"] == "cand@x.com" and payload["eid"] == "eng1"


def test_expired_rejected():
    tok = _issue(exp=1_000)
    with pytest.raises(CandidateTokenError, match="失效"):
        verify_token(tok, secret=SECRET, now_epoch=2_000)


def test_tampered_payload_rejected():
    tok = _issue()
    payload_b64, sig = tok.split(".")
    # 篡改 payload(换成别的环节),签名不再匹配
    forged = payload_b64[:-2] + ("AA" if not payload_b64.endswith("AA") else "BB") + "." + sig
    with pytest.raises(CandidateTokenError):
        verify_token(forged, secret=SECRET, now_epoch=1_000_000_000)


def test_wrong_secret_rejected():
    tok = _issue()
    with pytest.raises(CandidateTokenError, match="签名"):
        verify_token(tok, secret="another-secret-000", now_epoch=1_000_000_000)


def test_malformed_rejected():
    for bad in ["", "noselector", "a.b.c", "...."]:
        with pytest.raises(CandidateTokenError):
            verify_token(bad, secret=SECRET, now_epoch=1_000_000_000)


def test_empty_secret_fails_closed():
    with pytest.raises(CandidateTokenError):
        issue_token(candidate_id="c", engagement_id="e", exp_epoch=1, jti="j", secret="")
    with pytest.raises(CandidateTokenError):
        verify_token("a.b", secret="", now_epoch=1)
