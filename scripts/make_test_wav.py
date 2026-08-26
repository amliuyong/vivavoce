#!/usr/bin/env python3
"""在 GPU 容器内连本机 WS 合成一段真中文语音,存成 WAV(供 Playwright 假麦克风灌入)。

Chrome `--use-file-for-fake-audio-capture` 要 WAV(PCM s16le)。fake device 会按文件采样率播,
浏览器侧 AudioWorklet 再重采样到 16k 上行——所以这里存 24k WAV 即可(OmniVoice 原生 24k)。
输出到 /tmp/test_speech.wav,再由外层 docker cp / scp 取出。
"""
import asyncio
import json
import struct
import sys
import wave

WS_URL = "ws://127.0.0.1:8080/v1/stream"
TTS_RATE = 24000
SID = "make-wav"
# 面试自我介绍(真人会说的话;够长,让 ASR 有足够内容识别)
TEXT = sys.argv[1] if len(sys.argv) > 1 else "你好,我叫张三,很高兴参加这次面试。我毕业于计算机专业,做过三年后端开发,熟悉分布式系统和数据库优化。"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/test_speech.wav"


async def main() -> int:
    import websockets

    pcm = bytearray()
    async with websockets.connect(WS_URL, max_size=None) as ws:
        await ws.send(json.dumps({"type": "start", "session_id": SID}))
        # 等 ready
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
            if m.get("type") == "ready":
                break
        await ws.send(json.dumps({"type": "tts_text", "session_id": SID, "text": TEXT}))
        pending_bin = False
        while True:
            msg = await asyncio.wait_for(ws.recv(), timeout=60)
            if isinstance(msg, (bytes, bytearray)):
                if pending_bin:
                    pcm.extend(msg)
                    pending_bin = False
                continue
            m = json.loads(msg)
            if m.get("type") == "tts_audio_meta":
                pending_bin = True
            elif m.get("type") == "tts_done":
                break
            elif m.get("type") == "error":
                print("ERR", m)
                return 1
        await ws.send(json.dumps({"type": "end", "session_id": SID}))

    # 写 WAV(24k mono s16le)
    with wave.open(OUT, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TTS_RATE)
        w.writeframes(bytes(pcm))
    dur = len(pcm) / 2 / TTS_RATE
    print(f"WAV_OK {OUT} bytes={len(pcm)} dur={dur:.2f}s text_len={len(TEXT)}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
