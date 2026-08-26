"""VAD 端点检测 + 会话编排 UT(纯逻辑,不依赖 GPU/网络)。"""
from __future__ import annotations

import math
import struct

import pytest

from gpu_service.protocol import ASR_SAMPLE_RATE, ProtocolError
from gpu_service.session import SessionOrchestrator
from gpu_service.vad import EndpointDetector


def _silence(ms: int, rate: int = ASR_SAMPLE_RATE) -> bytes:
    return b"\x00\x00" * (rate * ms // 1000)


def _speech(ms: int, rate: int = ASR_SAMPLE_RATE, amp: int = 12000, freq: int = 220) -> bytes:
    n = rate * ms // 1000
    return b"".join(
        struct.pack("<h", int(amp * math.sin(2 * math.pi * freq * i / rate))) for i in range(n)
    )


# ── VAD ──
def test_vad_detects_speech():
    d = EndpointDetector()
    assert d.is_speech(_speech(20))
    assert not d.is_speech(_silence(20))


def test_endpoint_fires_after_speech_then_silence():
    d = EndpointDetector(hangover_ms=300, min_speech_ms=100)
    fired = False
    # 说 500ms
    for _ in range(25):
        if d.push(_speech(20)):
            fired = True
    assert not fired  # 说话期间不触发
    # 再静音 ~400ms(> hangover)
    for _ in range(20):
        if d.push(_silence(20)):
            fired = True
    assert fired


def test_endpoint_not_fire_on_too_short_speech():
    d = EndpointDetector(hangover_ms=200, min_speech_ms=500)
    fired = False
    for _ in range(5):  # 仅 100ms 语音 < min_speech 500ms
        d.push(_speech(20))
    for _ in range(20):
        if d.push(_silence(20)):
            fired = True
    assert not fired


# ── 会话编排 ──
@pytest.mark.asyncio
async def test_orchestrator_audio_produces_partial_then_final_on_endpoint():
    orch = SessionOrchestrator("s1", endpoint=EndpointDetector(hangover_ms=200, min_speech_ms=100))
    types: list[str] = []
    for _ in range(35):  # 700ms 语音:跨过一个 600ms 主块,应先有 partial
        for out in await orch.on_audio(_speech(20)):
            types.append(out.control.type)
    for _ in range(15):  # 300ms 静音 → 端点
        for out in await orch.on_audio(_silence(20)):
            types.append(out.control.type)
    assert "asr_partial" in types
    assert "asr_final" in types
    assert "turn_end" in types
    # final 在 turn_end 之前
    assert types.index("asr_final") < types.index("turn_end")


def test_orchestrator_tts_text_streams_audio_then_done():
    orch = SessionOrchestrator("s1")
    metas = pcms = done = 0
    for out in orch.on_tts_text("你好世界", ai_turn_id=9, segment_id=3):
        if out.control.type == "tts_audio_meta":
            metas += 1
            assert out.pcm is not None and len(out.pcm) > 0
            assert out.control.data["bytes"] == len(out.pcm)  # meta.bytes == 紧跟 PCM 长度
            assert out.control.data["ai_turn_id"] == 9
            assert out.control.data["segment_id"] == 3
            pcms += 1
        elif out.control.type == "tts_done":
            assert out.control.data["ai_turn_id"] == 9
            assert out.control.data["segment_id"] == 3
            done += 1
    assert metas > 0 and pcms == metas and done == 1


@pytest.mark.asyncio
async def test_orchestrator_cancel_stops_tts_midstream():
    """barge-in:cancel 后不再产出剩余 TTS,且回 cancel_ack。"""
    orch = SessionOrchestrator("s1")
    gen = orch.on_tts_text("一段很长的文本用于验证可被中途打断停止合成")
    first = next(gen)
    assert first.control.type == "tts_audio_meta"
    # 模拟 Bridge 检测到 barge-in → cancel
    acks = await orch.on_cancel("barge_in")
    assert acks[0].control.type == "cancel_ack"
    assert acks[0].control.data["reason"] == "barge_in"
    # 继续消费原 TTS 生成器:cancel 后应尽快停止(不再 tts_done)
    rest = [o.control.type for o in gen]
    assert "tts_done" not in rest


@pytest.mark.asyncio
async def test_input_reset_advances_only_input_identity_and_acks_before_new_audio():
    orch = SessionOrchestrator(
        "s1", endpoint=EndpointDetector(hangover_ms=200, min_speech_ms=100)
    )
    await orch.on_audio(_speech(20))
    tts_cancel_epoch = orch.cancel_epoch

    ack = await orch.reset_input(from_input_epoch=0, next_input_epoch=1)

    assert ack.control.type == "input_reset_ack"
    assert ack.control.data["input_epoch"] == 1
    assert orch.cancel_epoch == tts_cancel_epoch
    output = []
    for _ in range(30):
        output.extend(await orch.on_audio(_speech(20)))
    partial = output[0].control
    assert partial.data["input_epoch"] == 1
    assert partial.data["input_turn_id"] == 0


def test_seq_monotonic():
    orch = SessionOrchestrator("s1")
    seqs = [o.control.seq for o in orch.on_tts_text("abc")]
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)


@pytest.mark.asyncio
async def test_finalize_turn_emits_final_without_trailing_silence():
    """连续说话无尾随静音(VAD 不会自然出 turn_end)时,finalize_turn() 应主动出
    asr_final + turn_end —— 这是 voice-test「结束本轮」按钮的后端语义(修没声音根因)。"""
    orch = SessionOrchestrator("s1", endpoint=EndpointDetector(hangover_ms=200, min_speech_ms=100))
    types: list[str] = []
    for _ in range(15):  # 300ms 纯语音,无尾静音 → VAD 不会出 turn_end
        for out in await orch.on_audio(_speech(20)):
            types.append(out.control.type)
    assert "turn_end" not in types  # 证明:不点结束本轮就永远不出 turn_end
    # 主动 finalize 当前轮
    fin = [o.control.type for o in await orch.finalize_turn()]
    assert fin == ["asr_final", "turn_end"]


@pytest.mark.asyncio
async def test_finalize_turn_no_speech_emits_turn_end_only():
    """无语音(误点结束本轮 / 音频未到)时 finalize_turn 只出 turn_end(不带 asr_final):
    给前端一个明确「轮结束」信号(避免卡在 waiting_reply),后端见空文本回 no_speech、
    前端据此恢复麦克风;且不带 asr_final 文本 → 不触发空 LLM。"""
    orch = SessionOrchestrator("s1")
    out = [o.control.type for o in await orch.finalize_turn()]
    assert out == ["turn_end"]


@pytest.mark.asyncio
async def test_identity_flush_does_not_close_the_turn_after_an_already_ended_turn():
    """A late commit for T must not finalize or reset speech already buffered for T+1."""
    orch = SessionOrchestrator("s1")
    first = await orch.finalize_turn(
        expected_input_epoch=0,
        expected_input_turn_id=0,
    )
    assert [out.control.type for out in first] == ["turn_end"]
    assert orch.input_turn_id == 1

    await orch.on_audio(_speech(20))
    assert await orch.finalize_turn(
        expected_input_epoch=0,
        expected_input_turn_id=0,
    ) == []
    assert orch.input_turn_id == 1

    current = await orch.finalize_turn(
        expected_input_epoch=0,
        expected_input_turn_id=1,
    )
    assert [out.control.type for out in current] == ["asr_final", "turn_end"]
    assert all(out.control.data["input_turn_id"] == 1 for out in current)

    with pytest.raises(ProtocolError, match="超前"):
        await orch.finalize_turn(
            expected_input_epoch=0,
            expected_input_turn_id=3,
        )


# ── review:语言透传 + 空 final 不污染审计 ──

class _FakeAsr:
    """可控 finalize 返回值的 fake ASR:记录 finalize 收到的 language,验证透传 + 空 final 行为。"""

    def __init__(self, final_text: str):
        self._final_text = final_text
        self.finalize_lang: str | None = "UNSET"

    def transcribe_chunk(self, pcm: bytes):
        return "partial" if pcm else None

    def finalize(self, language=None):
        self.finalize_lang = language
        return self._final_text

    def reset(self):
        pass


class _RecordingAsr:
    """Records caller-visible ASR operations without exposing session internals."""

    def __init__(self, partial: str = "partial", final: str = "final"):
        self.partial = partial
        self.final = final
        self.chunks: list[bytes] = []
        self.reset_count = 0
        self.operations: list[str] = []

    def transcribe_chunk(self, pcm: bytes) -> str | None:
        self.operations.append("transcribe")
        self.chunks.append(pcm)
        return self.partial

    def finalize(self, language=None):  # noqa: ARG002
        self.operations.append("finalize")
        return self.final

    def reset(self):
        self.operations.append("reset")
        self.reset_count += 1


@pytest.mark.asyncio
async def test_orchestrator_submits_full_asr_chunks_and_deduplicates_partial():
    fake = _RecordingAsr(partial="unchanged")
    orch = SessionOrchestrator(
        "s1",
        asr=fake,
        endpoint=EndpointDetector(hangover_ms=200, min_speech_ms=100),
    )

    for _ in range(29):
        assert await orch.on_audio(_speech(20)) == []
    first = await orch.on_audio(_speech(20))

    assert [len(chunk) for chunk in fake.chunks] == [ASR_SAMPLE_RATE * 2 * 600 // 1000]
    assert [out.control.type for out in first] == ["asr_partial"]

    duplicate = []
    for _ in range(30):
        duplicate.extend(await orch.on_audio(_speech(20)))

    assert [len(chunk) for chunk in fake.chunks] == [
        ASR_SAMPLE_RATE * 2 * 600 // 1000,
        ASR_SAMPLE_RATE * 2 * 600 // 1000,
    ]
    assert duplicate == []


@pytest.mark.asyncio
async def test_orchestrator_supports_instrumented_20ms_sync_baseline():
    fake = _RecordingAsr()
    orch = SessionOrchestrator(
        "baseline",
        asr=fake,
        asr_chunk_ms=20,
        endpoint=EndpointDetector(hangover_ms=200, min_speech_ms=100),
    )

    output = await orch.on_audio(_speech(20))

    assert [len(chunk) for chunk in fake.chunks] == [ASR_SAMPLE_RATE * 2 * 20 // 1000]
    assert [out.control.type for out in output] == ["asr_partial"]


@pytest.mark.asyncio
async def test_finalize_turn_submits_residual_before_finalizing():
    fake = _RecordingAsr(partial="tail", final="complete")
    orch = SessionOrchestrator("s1", asr=fake)

    for _ in range(10):
        assert await orch.on_audio(_speech(20)) == []

    output = await orch.finalize_turn()

    assert [len(chunk) for chunk in fake.chunks] == [ASR_SAMPLE_RATE * 2 * 200 // 1000]
    assert fake.operations == ["transcribe", "finalize"]
    assert [out.control.type for out in output] == ["asr_final", "turn_end"]


@pytest.mark.asyncio
async def test_input_reset_discards_old_residual_before_acknowledging_new_epoch():
    fake = _RecordingAsr(partial="new")
    orch = SessionOrchestrator("s1", asr=fake)

    old_frame = _speech(20, amp=12000)
    for _ in range(10):
        await orch.on_audio(old_frame)

    ack = await orch.reset_input(from_input_epoch=0, next_input_epoch=1)

    assert ack.control.type == "input_reset_ack"
    assert ack.control.data["input_epoch"] == 1
    assert fake.operations == ["reset"]
    assert fake.chunks == []

    new_frame = _speech(20, amp=8000)
    output = []
    for _ in range(30):
        output.extend(await orch.on_audio(new_frame))

    assert fake.chunks == [new_frame * 30]
    assert [out.control.data["input_epoch"] for out in output] == [1]


@pytest.mark.asyncio
async def test_cancel_discards_residual_and_resets_asr_before_ack():
    fake = _RecordingAsr()
    orch = SessionOrchestrator("s1", asr=fake)
    for _ in range(10):
        await orch.on_audio(_speech(20))

    output = await orch.on_cancel("barge_in")

    assert fake.chunks == []
    assert fake.operations == ["reset"]
    assert [out.control.type for out in output] == ["cancel_ack"]
    assert output[0].control.data["reason"] == "barge_in"


@pytest.mark.asyncio
async def test_reset_cancel_storm_never_submits_old_residual():
    fake = _RecordingAsr()
    orch = SessionOrchestrator("storm", asr=fake)

    for next_epoch in range(1, 21):
        for _ in range(10):
            assert await orch.on_audio(_speech(20)) == []
        cancel = await orch.on_cancel("storm")
        assert [out.control.type for out in cancel] == ["cancel_ack"]
        reset = await orch.reset_input(
            from_input_epoch=next_epoch - 1,
            next_input_epoch=next_epoch,
        )
        assert reset.control.data["input_epoch"] == next_epoch

    assert fake.chunks == []
    assert fake.reset_count == 40
    assert orch.input_epoch == 20


def test_asr_lang_code_maps_engine_language():
    """engine.language → SenseVoice 语种码:zh-CN→zh、en-US→en、未知→None(默认 auto),不全局写死 zh(review)。"""
    from gpu_service.session import _asr_lang_code

    assert _asr_lang_code("zh-CN") == "zh"
    assert _asr_lang_code("en-US") == "en"
    assert _asr_lang_code("en") == "en"
    assert _asr_lang_code("ja-JP") == "ja"
    assert _asr_lang_code(None) is None
    assert _asr_lang_code("xx-YY") is None  # 未知 → 默认(finalize 用 auto)
    # auto(跟随题目语言,Agent.engine.language):ASR 不偏置,SenseVoice 多语言自动判种
    assert _asr_lang_code("auto") == "auto"


@pytest.mark.asyncio
async def test_session_passes_language_to_finalize():
    """会话 language 透传到 ASR.finalize(review:英文 profile 不被中文偏置误伤)。"""
    fake = _FakeAsr("hello there")
    orch = SessionOrchestrator(
        "s1", language="en-US", asr=fake,
        endpoint=EndpointDetector(hangover_ms=200, min_speech_ms=100),
    )
    for out in await orch.finalize_turn():  # finalize_turn 内若 had_speech 才 finalize;先制造 had_speech
        _ = out
    # had_speech 默认 False,finalize_turn 不会 finalize → 直接走自然端点路径制造 had_speech
    fake2 = _FakeAsr("hello")
    orch2 = SessionOrchestrator(
        "s2", language="en-US", asr=fake2,
        endpoint=EndpointDetector(hangover_ms=100, min_speech_ms=60),
    )
    for _ in range(10):
        await orch2.on_audio(_speech(20))
    await orch2.on_audio(_silence(300))  # 触发自然端点 → finalize
    assert fake2.finalize_lang == "en"  # en-US → en 透传到 finalize


@pytest.mark.asyncio
async def test_empty_final_skips_asr_final_emit():
    """空 final(短句门过滤/静音轮)→ 自然端点不发 asr_final,只发 turn_end(review:防审计脏数据)。"""
    fake = _FakeAsr("")  # finalize 返回空(模拟短句门过滤后)
    orch = SessionOrchestrator(
        "s1", asr=fake, endpoint=EndpointDetector(hangover_ms=100, min_speech_ms=60),
    )
    types: list[str] = []
    for _ in range(10):
        for out in await orch.on_audio(_speech(20)):
            types.append(out.control.type)
    for out in await orch.on_audio(_silence(300)):
        types.append(out.control.type)
    assert "turn_end" in types
    assert "asr_final" not in types  # 空 final 不发 → bridge 不写空 transcript
