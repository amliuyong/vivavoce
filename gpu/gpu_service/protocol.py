"""GPU WS 应用层协议(design contract 的实现契约)。

framing(单一约定,不二义):
  - 控制消息 = WS **text 帧**(UTF-8 JSON)
  - 音频 = WS **binary 帧**(裸 PCM)
  - 每个 binary 音频帧**紧前**有一个对应的 meta text 帧(上行 audio_meta、下行 tts_audio_meta),
    meta.seq == 紧跟 binary 的 seq;成对、同 seq、严格有序。

音频格式:上行 16k mono s16le(供 ASR);下行 TTS 24k mono s16le。

上行(Bridge → GPU): start / audio_meta(+PCM) / input_reset / tts_text / cancel / flush / end
下行(GPU → Bridge): ready / asr_partial / asr_final / turn_end /
                    tts_audio_meta(+PCM) / tts_metrics / tts_done / cancel_ack /
                    input_reset_ack / error / bye
LLM token 不经此 WS(LLM 在 Bridge↔Bedrock)。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum

# ── 音频格式常量 ──
ASR_SAMPLE_RATE = 16000  # 上行
TTS_SAMPLE_RATE = 24000  # 下行
SAMPLE_WIDTH_BYTES = 2  # s16le
CHANNELS = 1
# 单帧 PCM 上限:16k mono s16le 下 1 秒 = 32000 字节;留 2 秒余量防超大帧打爆内存。
MAX_PCM_FRAME_BYTES = 64000

# ── 声纹 embedding(design contract)──
# CAM++ 输出维度(ModelScope iic/speech_campplus_sv_zh-cn_16k-common,一手:192 维)。
# 单一事实源:GPU embedder 产出、bridge cosine 比对都按此维;stub 也产此维。
SPEAKER_EMBEDDING_DIM = 192
# /embedding 请求体 PCM 上限:16k mono s16le 下 10 秒 = 320000 字节(注册段/打断候选窗都远短于此)。
# 超此拒绝(防超大体打爆内存/GPU;bridge 侧据 4xx 走 fail-open,不阻断打断)。
MAX_EMBED_PCM_BYTES = 320000


class CancelReason(str, Enum):
    BARGE_IN = "barge_in"
    SESSION_END = "session_end"
    MANUAL_HANGUP = "manual_hangup"
    ERROR = "error"


class ErrorCode(str, Enum):
    MODEL_NOT_READY = "MODEL_NOT_READY"
    CAPACITY_FULL = "CAPACITY_FULL"
    BAD_AUDIO_FORMAT = "BAD_AUDIO_FORMAT"
    PROTOCOL_ERROR = "PROTOCOL_ERROR"
    INTERNAL = "INTERNAL"


# 上行消息类型
UPSTREAM_TYPES = {"start", "audio_meta", "input_reset", "tts_text", "cancel", "flush", "end"}
# 下行消息类型
DOWNSTREAM_TYPES = {
    "ready",
    "asr_partial",
    "asr_final",
    "turn_end",
    "tts_audio_meta",
    "tts_metrics",
    "tts_done",
    "cancel_ack",
    "input_reset_ack",
    "error",
    "bye",
}


class ProtocolError(Exception):
    """协议违例 —— 服务回 error(PROTOCOL_ERROR)并按需关闭。"""


@dataclass
class ControlMessage:
    """一条 text 控制帧。"""

    type: str
    session_id: str = ""
    seq: int = 0
    ts: int = 0
    data: dict = field(default_factory=dict)

    def to_json(self) -> str:
        payload = {"type": self.type, "session_id": self.session_id, "seq": self.seq, "ts": self.ts}
        payload.update(self.data)
        return json.dumps(payload, ensure_ascii=False)

    @staticmethod
    def from_json(raw: str) -> ControlMessage:
        try:
            obj = json.loads(raw)
        except (json.JSONDecodeError, TypeError) as exc:
            raise ProtocolError(f"控制帧非合法 JSON: {exc}") from exc
        if not isinstance(obj, dict):
            raise ProtocolError("控制帧必须是 JSON 对象")
        mtype = obj.get("type")
        if not mtype or not isinstance(mtype, str):
            raise ProtocolError("控制帧缺少 type")
        sid = obj.get("session_id", "")
        if not isinstance(sid, str):
            raise ProtocolError("session_id 必须是字符串")

        def _as_int(key: str) -> int:
            v = obj.get(key, 0)
            if isinstance(v, bool) or not isinstance(v, int):
                # 拒绝非整数(含 bool / 字符串 / 浮点),避免 int() 抛非 ProtocolError 异常
                raise ProtocolError(f"{key} 必须是整数")
            return v

        reserved = {"type", "session_id", "seq", "ts"}
        return ControlMessage(
            type=mtype,
            session_id=sid,
            seq=_as_int("seq"),
            ts=_as_int("ts"),
            data={k: v for k, v in obj.items() if k not in reserved},
        )


def validate_pcm(pcm: bytes, *, sample_rate_hint: int | None = None) -> None:
    """校验 PCM 帧:必须是偶数字节(s16le,每样本 2 字节)。"""
    if not isinstance(pcm, (bytes, bytearray)):
        raise ProtocolError("音频帧必须是 binary")
    if len(pcm) == 0:
        raise ProtocolError("音频帧为空")
    if len(pcm) > MAX_PCM_FRAME_BYTES:
        raise ProtocolError(f"音频帧过大 {len(pcm)} > {MAX_PCM_FRAME_BYTES}")
    if len(pcm) % SAMPLE_WIDTH_BYTES != 0:
        raise ProtocolError(f"PCM 长度 {len(pcm)} 非 {SAMPLE_WIDTH_BYTES} 字节对齐(s16le)")


# ── 下行消息构造器(集中,确保字段一致) ──
def ready(session_id: str = "") -> ControlMessage:
    return ControlMessage(type="ready", session_id=session_id, data={"asr": True, "tts": True})


def _input_identity(input_epoch: int, input_turn_id: int) -> dict:
    return {"input_epoch": input_epoch, "input_turn_id": input_turn_id}


def asr_partial(
    session_id: str,
    seq: int,
    text: str,
    ts: int = 0,
    *,
    input_epoch: int = 0,
    input_turn_id: int = 0,
) -> ControlMessage:
    return ControlMessage(type="asr_partial", session_id=session_id, seq=seq, ts=ts,
                          data={"text": text, "is_final": False,
                                **_input_identity(input_epoch, input_turn_id)})


def asr_final(
    session_id: str,
    seq: int,
    text: str,
    ts: int = 0,
    *,
    input_epoch: int = 0,
    input_turn_id: int = 0,
) -> ControlMessage:
    return ControlMessage(type="asr_final", session_id=session_id, seq=seq, ts=ts,
                          data={"text": text, "is_final": True,
                                **_input_identity(input_epoch, input_turn_id)})


def turn_end(
    session_id: str,
    seq: int,
    ts: int = 0,
    *,
    input_epoch: int = 0,
    input_turn_id: int = 0,
) -> ControlMessage:
    return ControlMessage(type="turn_end", session_id=session_id, seq=seq, ts=ts,
                          data=_input_identity(input_epoch, input_turn_id))


def _tts_identity(ai_turn_id: int | None, segment_id: int | None) -> dict:
    if ai_turn_id is None or segment_id is None:
        return {}
    return {"ai_turn_id": ai_turn_id, "segment_id": segment_id}


def tts_audio_meta(
    session_id: str,
    seq: int,
    n_bytes: int,
    ts: int = 0,
    *,
    ai_turn_id: int | None = None,
    segment_id: int | None = None,
) -> ControlMessage:
    return ControlMessage(type="tts_audio_meta", session_id=session_id, seq=seq, ts=ts,
                          data={"bytes": n_bytes, "sample_rate": TTS_SAMPLE_RATE,
                                **_tts_identity(ai_turn_id, segment_id)})


def tts_metrics(
    session_id: str,
    *,
    ai_turn_id: int,
    segment_id: int,
    tts_provider: str,
    generation_wall_time_ms: float,
    generated_audio_duration_ms: float,
    rtf: float | None,
    cache_state: str,
    concurrency: int,
    model_first_chunk_unavailable_reason: str,
    provider_start_to_first_send_ms: float | None = None,
    cancel_to_last_model_compute_ms: float | None = None,
    cancel_to_last_gpu_send_ms: float | None = None,
) -> ControlMessage:
    data: dict = {
        **_tts_identity(ai_turn_id, segment_id),
        "tts_provider": tts_provider,
        "generation_wall_time_ms": generation_wall_time_ms,
        "generated_audio_duration_ms": generated_audio_duration_ms,
        "cache_state": cache_state,
        "concurrency": concurrency,
        "model_first_chunk_unavailable_reason": model_first_chunk_unavailable_reason,
    }
    if rtf is not None:
        data["rtf"] = rtf
    if provider_start_to_first_send_ms is not None:
        data["provider_start_to_first_send_ms"] = provider_start_to_first_send_ms
    if cancel_to_last_model_compute_ms is not None:
        data["cancel_to_last_model_compute_ms"] = cancel_to_last_model_compute_ms
    if cancel_to_last_gpu_send_ms is not None:
        data["cancel_to_last_gpu_send_ms"] = cancel_to_last_gpu_send_ms
    return ControlMessage(type="tts_metrics", session_id=session_id, data=data)


def tts_done(
    session_id: str,
    seq: int,
    *,
    ai_turn_id: int | None = None,
    segment_id: int | None = None,
) -> ControlMessage:
    return ControlMessage(
        type="tts_done",
        session_id=session_id,
        seq=seq,
        data=_tts_identity(ai_turn_id, segment_id),
    )


def cancel_ack(session_id: str, reason: str) -> ControlMessage:
    return ControlMessage(type="cancel_ack", session_id=session_id, data={"reason": reason})


def input_reset_ack(session_id: str, input_epoch: int) -> ControlMessage:
    return ControlMessage(
        type="input_reset_ack",
        session_id=session_id,
        data={"input_epoch": input_epoch},
    )


def error(session_id: str, code: ErrorCode, message: str) -> ControlMessage:
    return ControlMessage(type="error", session_id=session_id, data={"code": code.value, "message": message})


def bye(session_id: str) -> ControlMessage:
    return ControlMessage(type="bye", session_id=session_id)
