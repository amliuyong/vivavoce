"""生成 voice clone 参考音资产(离线一次性工具,不进运行时链路)。

背景(修「英文口音重」根因):三段式本地 TTS(OmniVoice)用 voice clone 锁声纹,参考音是
「谁的嗓子 + 什么发音习惯」。此前只有中文母语参考音(<key>.wav 念中文),合成英文时音素/重音/
连读全带中式口音 → 不地道。修法 = 给每个 voice key **补一段英文母语参考音**(<key>.en.wav),
运行时按会话 language(en / auto 逐句检测)选中/英参考音(funasr_backend._voice_ref)。

本脚本用 **MiniMax T2A**(项目已集成的云端 TTS)合成英文母语音色 → 落盘 <key>.en.{wav,txt}:
  - MiniMax T2A 是忠实朗读式合成(准确读出输入文本,不像 voice-design 会跑飞),故 ref_text
    直接用输入英文文本即可,**无需 Whisper 转写**(区别于 OmniVoice voice-design 生成路径);
    因此本脚本可在**无 GPU** 的机器上跑。
  - 输出格式与现有中文参考音逐字节对齐:24kHz mono s16le WAV(TTS_SAMPLE_RATE)。
  - 选定的英文 system voice 与对应中文音色的性别/气质对齐(见 EN_VOICE_BY_KEY),保证同一 key
    切中/英时听感是「同一个角色换了语言」而非两个陌生人。

用法(key 从 Secret 读,不落盘、不打印明文):
    python gpu/scripts/gen_reference_voice.py \
        --secret-id <secret name> --profile <profile> --region <region>
或由 `scripts/viva voices` 从本地 `.env` 载入 `VIVA_MINIMAX_API_KEY`。

生成后:试听 assets/voices/*.en.wav → 满意则连同 .en.txt 一起 checkin(Dockerfile COPY 自动
烘进镜像,runtime 不触网)。KNOWN_VOICE_KEYS 无需改(语言是正交维度,不是新 key)。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import wave
from pathlib import Path

# 与 gpu_service.protocol.TTS_SAMPLE_RATE 对齐(不 import gpu_service,免装其重依赖)。
TTS_SAMPLE_RATE = 24000
DEFAULT_BASE_URL = "https://api.minimaxi.com/v1/t2a_v2"
DEFAULT_MODEL = "speech-2.8-turbo"

# 参考音资产目录(与 funasr_backend._VOICES_DIR 一致)。
VOICES_DIR = Path(__file__).resolve().parent.parent / "gpu_service" / "assets" / "voices"

# 英文参考音朗读文本:自然的自我介绍(~8s),与现有中文参考音语义对齐(「我是这场对话的助手」)。
# 内容本身无所谓(只取声纹),但要地道、有足够音素覆盖、语气平稳(参考音的语气会带进 clone)。
EN_REF_TEXT = (
    "Hi, I'm the AI assistant for this session. "
    "I'm really glad to talk with you today. "
    "Let's take our time and go through the conversation together, step by step."
)

# 语义 voice key → MiniMax 英文母语 system voice_id(与中文音色性别/气质对齐,已程序验证可合成)。
#   male_std   ← Chinese (Mandarin)_Gentleman   ↔ English_Trustworth_Man(可信沉稳男声)
#   female_std ← Chinese (Mandarin)_..._Antie    ↔ English_Graceful_Lady(优雅女声)
EN_VOICE_BY_KEY: dict[str, str] = {
    "male_std": "English_Trustworth_Man",
    "female_std": "English_Graceful_Lady",
}


def _load_api_key(args: argparse.Namespace) -> tuple[str, str, str]:
    """取 (api_key, base_url, model):优先 env(本地/离线),否则从 Secret 读(admin)。"""
    env_key = (
        os.getenv("VIVA_MINIMAX_API_KEY")
        or os.getenv("AIM_MINIMAX_API_KEY")
        or ""
    ).strip()
    if env_key:
        base_url = (
            os.getenv("VIVA_MINIMAX_BASE_URL")
            or os.getenv("AIM_MINIMAX_BASE_URL")
            or DEFAULT_BASE_URL
        )
        model = (
            os.getenv("VIVA_MINIMAX_MODEL")
            or os.getenv("AIM_MINIMAX_MODEL")
            or DEFAULT_MODEL
        )
        return env_key, base_url, model
    if not args.secret_id:
        sys.exit("需 VIVA_MINIMAX_API_KEY 或 --secret-id")
    cmd = ["aws", "secretsmanager", "get-secret-value",
           "--secret-id", args.secret_id, "--query", "SecretString", "--output", "text"]
    if args.profile:
        cmd += ["--profile", args.profile]
    if args.region:
        cmd += ["--region", args.region]
    cfg = json.loads(subprocess.check_output(cmd, text=True))
    key = (cfg.get("api_key") or "").strip()
    if not key:
        sys.exit("Secret 中无 api_key")
    return key, cfg.get("base_url") or DEFAULT_BASE_URL, cfg.get("model") or DEFAULT_MODEL


def _synth_pcm(text: str, voice_id: str, *, api_key: str, base_url: str, model: str) -> bytes:
    """MiniMax T2A 合成一段英文 → 裸 PCM(24k mono s16le)。失败即 exit(生成期不容错)。"""
    body = {
        "model": model,
        "text": text,
        "stream": False,
        "output_format": "hex",
        "voice_setting": {"voice_id": voice_id},
        "audio_setting": {"format": "pcm", "sample_rate": TTS_SAMPLE_RATE, "channel": 1},
        "language_boost": "English",  # 英文母语音色 + 英文 boost = 地道英文
    }
    req = urllib.request.Request(
        base_url, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            obj = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        sys.exit(f"MiniMax HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:200]}")
    base = obj.get("base_resp") or {}
    if int(base.get("status_code", -1)) != 0:
        sys.exit(f"MiniMax 合成失败 status={base.get('status_code')} {base.get('status_msg')}")
    audio_hex = (obj.get("data") or {}).get("audio")
    if not audio_hex:
        sys.exit("MiniMax 成功码但无 data.audio")
    return bytes.fromhex(audio_hex)


def _write_wav(pcm: bytes, path: Path) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # s16le
        w.setframerate(TTS_SAMPLE_RATE)
        w.writeframes(pcm)


def main() -> None:
    ap = argparse.ArgumentParser(description="生成英文母语 voice clone 参考音(MiniMax T2A)")
    ap.add_argument("--secret-id", help="Secrets Manager secret name")
    ap.add_argument("--profile", help="AWS profile used to read the secret")
    ap.add_argument(
        "--region",
        default=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
        help="AWS region used to read the secret",
    )
    ap.add_argument("--keys", nargs="*", default=list(EN_VOICE_BY_KEY),
                    help="要生成的 voice key(默认全部)")
    args = ap.parse_args()

    api_key, base_url, model = _load_api_key(args)
    VOICES_DIR.mkdir(parents=True, exist_ok=True)

    for key in args.keys:
        voice_id = EN_VOICE_BY_KEY.get(key)
        if not voice_id:
            sys.exit(f"未知 voice key: {key}(EN_VOICE_BY_KEY 无映射,请先补)")
        pcm = _synth_pcm(EN_REF_TEXT, voice_id, api_key=api_key, base_url=base_url, model=model)
        wav_path = VOICES_DIR / f"{key}.en.wav"
        txt_path = VOICES_DIR / f"{key}.en.txt"
        _write_wav(pcm, wav_path)
        # ref_text = 输入文本(MiniMax 忠实朗读,逐字匹配音频),供 create_voice_clone_prompt。
        txt_path.write_text(EN_REF_TEXT + "\n", encoding="utf-8")
        dur = len(pcm) / 2 / TTS_SAMPLE_RATE
        print(f"[gen] {key}.en  voice={voice_id}  {dur:.2f}s  -> {wav_path.name} + {txt_path.name}")


if __name__ == "__main__":
    main()
