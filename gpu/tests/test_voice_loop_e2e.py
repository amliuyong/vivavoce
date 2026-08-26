"""语音闭环 e2e —— 真实 ASR/TTS,不 mock(design contract 语音链路)。

闭环:真实 TTS 合成中文语音 → 重采样到 16k PCM → 喂真实 FunASR 流式识别 → 断言识别文本
含关键词 → 再经 GPU WS 服务跑完整协议回路(audio→asr→turn_end→tts_text→tts 音频)。

需 GPU + 模型(AIM_GPU_BACKEND=funasr);本地无 GPU 自动 skip,在 G6E 上真实运行。
通过环境变量 RUN_VOICE_E2E=1 显式开启(避免普通 CI 误触发重模型加载)。
"""
from __future__ import annotations

import json
import math
import os

import numpy as np
import pytest

RUN = os.getenv("RUN_VOICE_E2E") == "1" and os.getenv("AIM_GPU_BACKEND") == "funasr"
pytestmark = pytest.mark.skipif(
    not RUN, reason="语音 e2e 需真实模型:设 RUN_VOICE_E2E=1 + AIM_GPU_BACKEND=funasr(GPU 机器)"
)

PHRASE = "今天天气怎么样"


def _synth_16k_pcm(text: str) -> bytes:
    """真实 TTS 合成 → 24k float32 → 16k s16le PCM(喂 FunASR)。"""
    from gpu_service.funasr_backend import OmniVoiceTts, _resample
    from gpu_service.protocol import ASR_SAMPLE_RATE, TTS_SAMPLE_RATE

    tts = OmniVoiceTts()
    chunks = list(tts.synthesize(text))
    pcm24 = b"".join(chunks)
    wav = np.frombuffer(pcm24, dtype="<i2").astype(np.float32) / 32768.0
    wav16 = _resample(wav, TTS_SAMPLE_RATE, ASR_SAMPLE_RATE)
    return (np.clip(wav16, -1, 1) * 32767).astype("<i2").tobytes()


def test_real_tts_then_real_asr_roundtrip():
    """真实语音闭环:TTS 合成「今天天气怎么样」→ FunASR 识别 → 文本含关键字。"""
    from gpu_service.funasr_backend import FunAsr

    pcm16 = _synth_16k_pcm(PHRASE)
    assert len(pcm16) > 16000  # 至少 ~0.5s 真实语音

    asr = FunAsr()
    # 流式喂(每 600ms 一块,对齐 chunk_size)
    block = 16000 * 600 // 1000 * 2  # 600ms/块,对齐 chunk_size
    for i in range(0, len(pcm16), block):
        asr.transcribe_chunk(pcm16[i : i + block])
    text = asr.finalize()
    # 真实识别:断言识别出的中文含关键词(允许标点/少量误差)
    assert any(k in text for k in ["天气", "今天", "怎么样"]), f"ASR 识别='{text}',未含关键词"


@pytest.mark.asyncio
async def test_ws_full_voice_loop_real_models():
    """经 GPU WS 服务跑完整协议回路(真实模型):start→audio→asr→turn_end→tts_text→tts 音频→done。"""
    import websockets

    from gpu_service.protocol import ASR_SAMPLE_RATE

    pcm16 = _synth_16k_pcm(PHRASE)
    url = os.getenv("GPU_WS_URL", "ws://127.0.0.1:8080/v1/stream")
    got = {"asr_final": "", "turn_end": False, "tts_bytes": 0, "tts_done": False}

    async with websockets.connect(url, max_size=None) as ws:
        await ws.send(json.dumps({"type": "start", "session_id": "voice-e2e"}))
        assert json.loads(await ws.recv())["type"] == "ready"

        seq = 0
        frame = ASR_SAMPLE_RATE * 20 // 1000 * 2  # 20ms
        for i in range(0, len(pcm16), frame):
            seq += 1
            chunk = pcm16[i : i + frame]
            await ws.send(json.dumps({"type": "audio_meta", "seq": seq, "bytes": len(chunk)}))
            await ws.send(chunk)
        # 追加超过当前 VAD hangover 的静音触发自然端点，并留 400ms 余量。
        from gpu_service.vad import EndpointDetector

        sil = b"\x00\x00" * (ASR_SAMPLE_RATE * 20 // 1000)
        endpoint = EndpointDetector(sample_rate=ASR_SAMPLE_RATE)
        hangover_ms = math.ceil(
            endpoint.hangover_samples * 1000 / endpoint.sample_rate
        )
        silence_frames = math.ceil((hangover_ms + 400) / 20)
        for _ in range(silence_frames):
            seq += 1
            await ws.send(json.dumps({"type": "audio_meta", "seq": seq, "bytes": len(sil)}))
            await ws.send(sil)

        # 收 final/turn_end + 发 tts_text 收音频
        sent_tts = False
        for _ in range(2000):
            m = json.loads(await ws.recv())
            t = m.get("type")
            if t == "asr_final":
                got["asr_final"] = m.get("text", "")
            elif t == "turn_end":
                got["turn_end"] = True
                if not sent_tts:
                    await ws.send(json.dumps({"type": "tts_text", "text": "好的，收到。"}))
                    sent_tts = True
            elif t == "tts_audio_meta":
                pcm = await ws.recv()
                got["tts_bytes"] += len(pcm)
            elif t == "tts_done":
                got["tts_done"] = True
                break
        await ws.send(json.dumps({"type": "end"}))
        assert json.loads(await ws.recv())["type"] == "bye"

    assert got["turn_end"], got
    assert got["tts_bytes"] > 0 and got["tts_done"], got
