#!/usr/bin/env python3
"""全链路延迟探针 —— 在 GPU 容器内连本机 WS,分段计时(ASR / TTS 首包 / TTS 全句 / 端点)。

经 SSM 投到 GPU 实例容器内跑(localhost:8080)。测三类延迟:
  1. TTS 首包延迟(tts_text 发出 → 第一个 tts_audio_meta):用户感知"AI 多久开口"的核心。
  2. TTS 全句延迟(tts_text → tts_done)+ 合成音频总时长(判断是否够实时喂帧)。
  3. ASR:喂真人声 PCM(用①合成的音频回灌)→ 末帧发出 → asr_final 到达;及尾静音 → turn_end。

对比两条 TTS provider(GPU 本地 OmniVoice vs MiniMax 公网):靠 start.data.tts_provider 切。
只测 GPU 段(ASR+TTS);LLM 段不在此(由 bridge 编排,单独说明)。
"""
import asyncio
import json
import struct
import sys
import time

WS_URL = "ws://127.0.0.1:8080/v1/stream"
ASR_RATE = 16000
TTS_RATE = 24000


def now_ms() -> float:
    return time.monotonic() * 1000.0


def resample_24k_to_16k(pcm: bytes) -> bytes:
    n = len(pcm) // 2
    if n == 0:
        return b""
    src = struct.unpack("<%dh" % n, pcm)
    out_n = int(n * ASR_RATE / TTS_RATE)
    out = []
    for i in range(out_n):
        pos = i * TTS_RATE / ASR_RATE
        i0 = int(pos)
        frac = pos - i0
        s0 = src[i0]
        s1 = src[i0 + 1] if i0 + 1 < n else src[i0]
        out.append(int(s0 + (s1 - s0) * frac))
    return struct.pack("<%dh" % out_n, *out)


def frame_20ms(pcm: bytes, rate: int) -> list:
    step = rate * 20 // 1000 * 2
    return [pcm[i:i + step] for i in range(0, len(pcm), step) if pcm[i:i + step]]


async def run_once(provider: str, text: str) -> dict:
    import websockets

    sid = f"lat-{provider}"
    r = {"provider": provider, "text_len": len(text)}
    tts_pcm = bytearray()
    inbox = asyncio.Queue()
    marks = {}

    async with websockets.connect(WS_URL, max_size=None) as ws:
        stop = False

        async def drain():
            pending_bin = False
            while not stop:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    break
                if isinstance(msg, (bytes, bytearray)):
                    if pending_bin:
                        tts_pcm.extend(msg)
                        pending_bin = False
                    continue
                m = json.loads(msg)
                t = m.get("type")
                # 打首包/末包时间戳
                if t == "tts_audio_meta":
                    marks.setdefault("tts_first_meta", now_ms())
                    pending_bin = True
                await inbox.put((now_ms(), m))

        dt = asyncio.create_task(drain())

        async def wait_for(types, timeout):
            try:
                while True:
                    ts, m = await asyncio.wait_for(inbox.get(), timeout=timeout)
                    if m.get("type") in types:
                        return ts, m
            except asyncio.TimeoutError:
                return None, None

        # start(带 tts_provider)→ ready
        t0 = now_ms()
        await ws.send(json.dumps({"type": "start", "session_id": sid,
                                  "data": {"tts_provider": provider}}))
        ts, m = await wait_for({"ready"}, 60)
        if m is None:
            r["error"] = "no ready"
            stop = True; dt.cancel(); return r
        r["ready_ms"] = round(ts - t0, 1)

        # ── TTS 计时 ──
        t_tts = now_ms()
        await ws.send(json.dumps({"type": "tts_text", "session_id": sid, "text": text}))
        ts_done, _ = await wait_for({"tts_done"}, 90)
        t_done = ts_done if ts_done else now_ms()
        r["tts_first_pkt_ms"] = round(marks.get("tts_first_meta", t_done) - t_tts, 1)
        r["tts_full_ms"] = round(t_done - t_tts, 1)
        r["tts_pcm_bytes"] = len(tts_pcm)
        r["tts_audio_dur_ms"] = round(len(tts_pcm) / 2 / TTS_RATE * 1000, 1)  # 合成音频真实时长
        # 实时比 RTF:合成耗时 / 音频时长(<1 = 比实时快,能边合成边喂)
        if r["tts_audio_dur_ms"] > 0:
            r["tts_rtf"] = round(r["tts_full_ms"] / r["tts_audio_dur_ms"], 3)

        # ── ASR 计时:回灌①的真人声 ──
        asr_in = resample_24k_to_16k(bytes(tts_pcm))
        frames = frame_20ms(asr_in, ASR_RATE)
        seq = 0
        # 清 inbox 里 TTS 残留
        while not inbox.empty():
            inbox.get_nowait()
        t_asr_start = now_ms()
        for fr in frames:
            seq += 1
            await ws.send(json.dumps({"type": "audio_meta", "session_id": sid,
                                      "seq": seq, "bytes": len(fr)}))
            await ws.send(fr)
        t_last_audio = now_ms()
        # 尾静音触发端点
        for _ in range(60):
            seq += 1
            sil = b"\x00\x00" * (ASR_RATE * 20 // 1000)
            await ws.send(json.dumps({"type": "audio_meta", "session_id": sid,
                                      "seq": seq, "bytes": len(sil)}))
            await ws.send(sil)
        # 收 asr_final + turn_end
        got_final_ts = None
        for _ in range(400):
            ts, m = await wait_for({"asr_final", "turn_end"}, 20)
            if m is None:
                break
            if m.get("type") == "asr_final" and got_final_ts is None:
                got_final_ts = ts
                r["asr_text"] = m.get("text", "")
            elif m.get("type") == "turn_end":
                r["turn_end_after_last_audio_ms"] = round(ts - t_last_audio, 1)
                break
        if got_final_ts:
            # asr_final 相对"最后一帧真人声发出"的延迟(近似识别尾延迟)
            r["asr_final_after_last_audio_ms"] = round(got_final_ts - t_last_audio, 1)
            r["asr_stream_total_ms"] = round(got_final_ts - t_asr_start, 1)

        await ws.send(json.dumps({"type": "end", "session_id": sid}))
        stop = True; dt.cancel()
    return r


async def main() -> int:
    provider = sys.argv[1] if len(sys.argv) > 1 else "gpu_omnivoice"
    text = "你好,欢迎参加本次语音测试,请简单介绍一下你自己,谢谢。"
    # 跑 3 次取中位,避免冷启动/抖动
    runs = []
    for i in range(3):
        r = await run_once(provider, text)
        runs.append(r)
        print(f"RUN{i} " + json.dumps(r, ensure_ascii=False))
    # 汇总中位
    def med(key):
        vals = sorted(x[key] for x in runs if key in x)
        return vals[len(vals) // 2] if vals else None
    summary = {k: med(k) for k in ["ready_ms", "tts_first_pkt_ms", "tts_full_ms",
                                   "tts_audio_dur_ms", "tts_rtf",
                                   "asr_final_after_last_audio_ms", "turn_end_after_last_audio_ms"]}
    summary["provider"] = provider
    print("MEDIAN " + json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
