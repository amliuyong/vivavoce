#!/usr/bin/env python3
"""语音链路 e2e —— 在 GPU 实例本机连 GPU WS 服务,跑完整真实语音回路(ASR + TTS)。

经 SSM 投到 GPU 实例运行(GPU 在私网,容器内 localhost:8080 直连服务,不需网络穿透)。
验证 design contract 的真实语音回路,分两段:
  ① 真 TTS:下发中文文本 → OmniVoice 合成 → 收 tts_audio_meta + 紧跟 binary PCM → tts_done。
     把合成的 PCM 拼起来(24k)重采样到 16k,作为下一段 ASR 的**真实语音输入**(真声闭环)。
  ② 真 ASR:把①合成的真人声 PCM 当上行语音喂回 → 收 asr_partial/asr_final(应识别出中文)
     → 静音触发 turn_end。

不假设"每帧一回复":发送与接收解耦(后台 drain 任务收所有下行消息),避免旧脚本
"每发一帧就阻塞 recv"的死锁。LLM(Bedrock)段由 Bridge 编排,本脚本聚焦 GPU 的 ASR/TTS。
依赖:websockets(GPU 镜像内置);重采样用纯 Python 线性插值(不引 scipy)。
"""
import asyncio
import json
import math
import struct
import sys
from contextlib import suppress

WS_URL = "ws://127.0.0.1:8080/v1/stream"
ASR_RATE = 16000
TTS_RATE = 24000
ASR_FRAME_MS = 20
TAIL_SILENCE_MARGIN_MS = 400
SID = "e2e-voice"


def resample_24k_to_16k(pcm: bytes) -> bytes:
    """24k mono s16le → 16k mono s16le,线性插值(2:3 抽取的通用实现)。"""
    n = len(pcm) // 2
    if n == 0:
        return b""
    src = struct.unpack(f"<{n}h", pcm)
    out_n = int(n * ASR_RATE / TTS_RATE)
    out = []
    for i in range(out_n):
        pos = i * TTS_RATE / ASR_RATE
        i0 = int(pos)
        frac = pos - i0
        s0 = src[i0]
        s1 = src[i0 + 1] if i0 + 1 < n else src[i0]
        out.append(int(s0 + (s1 - s0) * frac))
    return struct.pack(f"<{out_n}h", *out)


def frame_20ms(pcm: bytes, rate: int) -> list:
    step = rate * 20 // 1000 * 2  # bytes per 20ms
    return [pcm[i:i + step] for i in range(0, len(pcm), step) if pcm[i:i + step]]


def pcm_silence_20ms() -> bytes:
    return b"\x00\x00" * (ASR_RATE * ASR_FRAME_MS // 1000)


def tail_silence_frame_count() -> int:
    """按 GPU 当前有效 VAD hangover 追加静音，并留固定测试余量。"""
    from gpu_service.vad import EndpointDetector

    endpoint = EndpointDetector(sample_rate=ASR_RATE)
    hangover_ms = math.ceil(
        endpoint.hangover_samples * 1000 / endpoint.sample_rate
    )
    return math.ceil((hangover_ms + TAIL_SILENCE_MARGIN_MS) / ASR_FRAME_MS)


async def main() -> int:
    import websockets  # GPU 镜像内置

    seen = {"ready": False, "tts_audio": 0, "tts_bytes": 0, "tts_done": False,
            "asr_partial": 0, "asr_final": False, "asr_text": "", "turn_end": False,
            "bye": False, "errors": []}
    inbox = asyncio.Queue()
    tts_pcm = bytearray()

    async with websockets.connect(WS_URL, max_size=None) as ws:
        stop = False

        async def drain():
            # 后台收所有下行:JSON 控制帧入队;binary 紧跟 tts_audio_meta 的 PCM 直接拼接。
            pending_bin = False
            while not stop:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                except Exception:  # noqa: BLE001 - 服务端正常 close 也通过该路径结束 drain
                    break
                if isinstance(msg, (bytes, bytearray)):
                    if pending_bin:
                        tts_pcm.extend(msg)
                        pending_bin = False
                    continue
                m = json.loads(msg)
                t = m.get("type")
                await inbox.put(m)
                if t == "tts_audio_meta":
                    pending_bin = True

        drain_task = asyncio.create_task(drain())

        async def wait_for(types, timeout):
            try:
                while True:
                    m = await asyncio.wait_for(inbox.get(), timeout=timeout)
                    if m.get("type") in types:
                        return m
            except asyncio.TimeoutError:
                return None

        # start → ready
        await ws.send(json.dumps({"type": "start", "session_id": SID}))
        m = await wait_for({"ready"}, 60)
        seen["ready"] = m is not None
        if not seen["ready"]:
            print("FAIL: 未收到 ready")
            stop = True
            drain_task.cancel()
            return 1

        # ── ① 真 TTS 合成中文 ──
        text = "你好,欢迎参加本次语音测试,请简单介绍一下你自己。"
        await ws.send(json.dumps({"type": "tts_text", "session_id": SID, "text": text}))
        while True:
            m = await wait_for({"tts_audio_meta", "tts_done", "error"}, 60)
            if m is None:
                break
            t = m.get("type")
            if t == "tts_audio_meta":
                seen["tts_audio"] += 1
            elif t == "error":
                seen["errors"].append(m)
            elif t == "tts_done":
                seen["tts_done"] = True
                break
        seen["tts_bytes"] = len(tts_pcm)

        # ── ② 把①的真人声 PCM 重采样喂回 ASR ──
        asr_in = resample_24k_to_16k(bytes(tts_pcm)) if tts_pcm else b""
        seq = 0
        for fr in frame_20ms(asr_in, ASR_RATE):
            seq += 1
            await ws.send(json.dumps({"type": "audio_meta", "session_id": SID,
                                      "seq": seq, "bytes": len(fr)}))
            await ws.send(fr)
        # 追加超过当前有效 VAD hangover 的静音，触发端点。
        for _ in range(tail_silence_frame_count()):
            seq += 1
            sil = pcm_silence_20ms()
            await ws.send(json.dumps({"type": "audio_meta", "session_id": SID,
                                      "seq": seq, "bytes": len(sil)}))
            await ws.send(sil)

        # 收 partial / final / turn_end
        deadline_types = {"asr_partial", "asr_final", "turn_end"}
        for _ in range(200):
            m = await wait_for(deadline_types, 15)
            if m is None:
                break
            t = m.get("type")
            if t == "asr_partial":
                seen["asr_partial"] += 1
            elif t == "asr_final":
                seen["asr_final"] = True
                seen["asr_text"] = m.get("text", "")
            elif t == "turn_end":
                seen["turn_end"] = True
                break

        await ws.send(json.dumps({"type": "end", "session_id": SID}))
        seen["bye"] = await wait_for({"bye"}, 5) is not None
        try:
            await asyncio.wait_for(drain_task, timeout=5)
        except asyncio.TimeoutError:
            drain_task.cancel()
            with suppress(asyncio.CancelledError):
                await drain_task
        stop = True

    print("VOICE_E2E_RESULT", json.dumps(seen, ensure_ascii=False))
    # 真声验收判据:TTS 出真音频 + ASR 识别出非空中文文本 + VAD 端点触发(turn_end)。
    # turn_end 纳入判据:尾静音应触发 GPU VAD 端点,漏判 = VAD 坏,不能让 smoke test 蒙混通过。
    ok = (seen["ready"] and seen["tts_done"] and seen["tts_audio"] > 0
          and seen["tts_bytes"] > 0 and seen["asr_final"]
          and len(seen["asr_text"].strip()) > 0 and seen["turn_end"]
          and seen["bye"])
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
