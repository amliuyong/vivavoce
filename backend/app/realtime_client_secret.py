from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets

_AUDIENCE = "viva-realtime"
_TRANSPORT = "websocket"
_TTL_SECONDS = 600
_SIGNING_PREFIX = "viva-realtime-v1."


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_realtime_client_secret(
    session_id: str,
    issued_at: int,
    signing_key: str,
    *,
    jti: bytes | None = None,
) -> str:
    """Sign the canonical Viva Realtime v1 client-secret envelope."""
    if len(signing_key.encode("utf-8")) < 32:
        raise ValueError("realtime client-secret signing key must be at least 32 bytes")
    token_id = jti if jti is not None else secrets.token_bytes(16)
    if len(token_id) != 16:
        raise ValueError("realtime client-secret jti must be exactly 16 bytes")
    payload = {
        "aud": _AUDIENCE,
        "exp": issued_at + _TTL_SECONDS,
        "iat": issued_at,
        "jti": _base64url(token_id),
        "sid": session_id,
        "tr": _TRANSPORT,
        "v": 1,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("ascii")
    payload_b64 = _base64url(canonical)
    message = f"{_SIGNING_PREFIX}{payload_b64}".encode("ascii")
    tag = hmac.new(signing_key.encode("utf-8"), message, hashlib.sha256).digest()
    token = f"ek_{payload_b64}.{_base64url(tag)}"
    if len(token.encode("ascii")) > 432:
        raise ValueError("realtime client-secret envelope must not exceed 432 bytes")
    return token
