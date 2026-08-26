"""协议编解码 + PCM 校验 UT。"""
from __future__ import annotations

import pytest

from gpu_service import protocol as P


def test_control_roundtrip():
    msg = P.ControlMessage(type="start", session_id="s1", seq=3, ts=123, data={"engine": "three_stage"})
    raw = msg.to_json()
    back = P.ControlMessage.from_json(raw)
    assert back.type == "start"
    assert back.session_id == "s1"
    assert back.seq == 3
    assert back.data["engine"] == "three_stage"


def test_from_json_rejects_non_object():
    with pytest.raises(P.ProtocolError):
        P.ControlMessage.from_json("[]")


def test_from_json_rejects_garbage():
    with pytest.raises(P.ProtocolError):
        P.ControlMessage.from_json("not json")


def test_from_json_requires_type():
    with pytest.raises(P.ProtocolError):
        P.ControlMessage.from_json('{"session_id":"s1"}')


def test_validate_pcm_ok():
    P.validate_pcm(b"\x00\x01" * 160)  # 偶数字节


def test_validate_pcm_odd_bytes_rejected():
    with pytest.raises(P.ProtocolError):
        P.validate_pcm(b"\x00\x01\x02")  # 奇数字节,非 s16le 对齐


def test_validate_pcm_empty_rejected():
    with pytest.raises(P.ProtocolError):
        P.validate_pcm(b"")


def test_validate_pcm_too_large_rejected():
    with pytest.raises(P.ProtocolError):
        P.validate_pcm(b"\x00\x00" * (P.MAX_PCM_FRAME_BYTES // 2 + 100))


def test_from_json_non_integer_seq_rejected():
    with pytest.raises(P.ProtocolError):
        P.ControlMessage.from_json('{"type":"audio_meta","seq":"abc"}')


def test_from_json_bool_seq_rejected():
    # bool 是 int 子类,但语义上不是合法 seq
    with pytest.raises(P.ProtocolError):
        P.ControlMessage.from_json('{"type":"audio_meta","seq":true}')


def test_from_json_non_string_session_id_rejected():
    with pytest.raises(P.ProtocolError):
        P.ControlMessage.from_json('{"type":"start","session_id":123}')


def test_downstream_builders_carry_session_and_seq():
    assert P.asr_final("s", 5, "你好").data["is_final"] is True
    assert P.tts_audio_meta("s", 7, 640).data["sample_rate"] == P.TTS_SAMPLE_RATE
    assert P.error("s", P.ErrorCode.BAD_AUDIO_FORMAT, "x").data["code"] == "BAD_AUDIO_FORMAT"


def test_tts_builders_carry_turn_identity_and_local_telemetry():
    meta = P.tts_audio_meta(
        "s",
        7,
        640,
        ai_turn_id=4,
        segment_id=2,
    )
    assert meta.data["ai_turn_id"] == 4
    assert meta.data["segment_id"] == 2

    metric = P.tts_metrics(
        "s",
        ai_turn_id=4,
        segment_id=2,
        tts_provider="gpu_omnivoice",
        provider_start_to_first_send_ms=125.5,
        generation_wall_time_ms=260.25,
        generated_audio_duration_ms=400,
        rtf=0.650625,
        cache_state="warm",
        concurrency=3,
        model_first_chunk_unavailable_reason="provider_does_not_expose_model_first_chunk",
    )
    assert metric.type == "tts_metrics"
    assert metric.data == {
        "ai_turn_id": 4,
        "segment_id": 2,
        "tts_provider": "gpu_omnivoice",
        "provider_start_to_first_send_ms": 125.5,
        "generation_wall_time_ms": 260.25,
        "generated_audio_duration_ms": 400,
        "rtf": 0.650625,
        "cache_state": "warm",
        "concurrency": 3,
        "model_first_chunk_unavailable_reason": "provider_does_not_expose_model_first_chunk",
    }


def test_cancel_reason_enum():
    assert P.CancelReason.BARGE_IN.value == "barge_in"
    assert {r.value for r in P.CancelReason} == {
        "barge_in", "session_end", "manual_hangup", "error",
    }
