from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.realtime_client_secret import sign_realtime_client_secret


def test_sign_realtime_client_secret_matches_cross_language_golden() -> None:
    fixture_path = Path(__file__).parents[2] / "contracts" / "realtime-client-secret-v1.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    token = sign_realtime_client_secret(
        fixture["session_id"],
        fixture["issued_at"],
        fixture["signing_key"],
        jti=bytes.fromhex(fixture["jti_hex"]),
    )

    assert token == fixture["token"]


def test_sign_realtime_client_secret_rejects_short_signing_key() -> None:
    with pytest.raises(ValueError, match="at least 32 bytes"):
        sign_realtime_client_secret("sess_abc123", 1785685860, "too-short")


def test_sign_realtime_client_secret_requires_128_bit_jti() -> None:
    with pytest.raises(ValueError, match="16 bytes"):
        sign_realtime_client_secret(
            "sess_abc123",
            1785685860,
            "0123456789abcdef0123456789abcdef",
            jti=b"short",
        )


def test_sign_realtime_client_secret_rejects_oversized_envelope() -> None:
    with pytest.raises(ValueError, match="432 bytes"):
        sign_realtime_client_secret(
            f"sess_{'x' * 400}",
            1785685860,
            "0123456789abcdef0123456789abcdef",
        )
