"""能量阈值 VAD + 端点检测(turn-taking 的"对方说完一轮")。

真实实现:对 16k s16le PCM 计算每帧 RMS 能量,连续静音超过 hangover 时长 → 判定一轮结束。
这是 design contract「端点检测由 ASR 段负责」的可运行实现(不依赖 GPU,可本地测)。
真实部署可换 fsmn-vad,但本类的端点状态机语义不变。
"""
from __future__ import annotations

import os

import numpy as np

from .protocol import ASR_SAMPLE_RATE

# VAD 默认值可经 env 调(真机标定:电话底噪/媒体泵静音流的 RMS 与录音棚不同,固定 500 可能让 VAD
# 永远判「有语音」→ 永不出 turn_end → AI 不说话,真机根因 deployment validation)。
#: VAD 内建默认(design contract:**单一事实源**;runtime_config 与 /config 端点 MUST import 本常量,
#: MUST NOT 另抄字面量 —— bridge 侧实测手抄默认值 46% 出错,最严重差 75 倍)。
#: energy_threshold 500 == bridge turn-handling 的 endpoint 默认(守跨面不变式 endpoint ≥ vad)。
VAD_DEFAULTS = {
    "energy_threshold": 500.0,
    # hangover_ms = **1400**(design contract 铁律「默认值即最佳值」,deployment validation 由 800 改)。
    #
    # 为什么改:1400 是部署验证得到的抗抢话标定值,但它此前只存在于环境覆盖中,
    # 代码默认仍是 800。
    # 危险在于**不变式不会破、行为却会静默变**:
    #   - 带环境覆盖部署 → GPU 1400,bridge silenceGap 1500,不变式 1500 ≥ 1400 ✓
    #   - 换一条未携带覆盖的部署路径 → GPU 退回 800,不变式**仍成立**(1500 ≥ 800)
    #     但 VAD 判轮结束从 1.4s 缩到 0.8s → **更容易抢话**,且守门不会报警。
    # 这正是 design contract 要治的那类问题(最佳值寄存在部署 shell,丢了不报错)。
    # 改默认后不再需要部署脚本覆盖 —— 值只有代码这一份。
    #
    # ⚠ 跨面不变式:bridge `turn-handling.ts::endpointing.silenceGapMs`(默认 1500)MUST ≥ 此值。
    #   synth 期 `constants.ts::assertSilenceGapAboveHangover()` 守门;调此值须同向核对 bridge 侧。
    "hangover_ms": 1400,
    "min_speech_ms": 200,
}

_DEF_ENERGY = float(os.getenv("AIM_VAD_ENERGY_THRESHOLD", str(VAD_DEFAULTS["energy_threshold"])))
_DEF_HANGOVER = int(os.getenv("AIM_VAD_HANGOVER_MS", str(VAD_DEFAULTS["hangover_ms"])))
_DEF_MIN_SPEECH = int(os.getenv("AIM_VAD_MIN_SPEECH_MS", str(VAD_DEFAULTS["min_speech_ms"])))


class EndpointDetector:
    def __init__(
        self,
        *,
        sample_rate: int = ASR_SAMPLE_RATE,
        energy_threshold: float = _DEF_ENERGY,  # RMS over int16
        hangover_ms: int = _DEF_HANGOVER,  # 连续静音多久判一轮结束
        min_speech_ms: int = _DEF_MIN_SPEECH,  # 至少说这么久才算有效一轮
    ):
        self.sample_rate = sample_rate
        self.energy_threshold = energy_threshold
        self.hangover_samples = int(sample_rate * hangover_ms / 1000)
        self.min_speech_samples = int(sample_rate * min_speech_ms / 1000)
        self.reset()

    def reset(self) -> None:
        self._speech_samples = 0
        self._trailing_silence = 0
        self._in_speech = False

    @staticmethod
    def rms(pcm: bytes) -> float:
        if not pcm:
            return 0.0
        arr = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        if arr.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(arr * arr)))

    def is_speech(self, pcm: bytes) -> bool:
        return self.rms(pcm) >= self.energy_threshold

    def push(self, pcm: bytes) -> bool:
        """喂一帧。返回 True 表示"一轮结束"(端点命中)。"""
        n = len(pcm) // 2
        if self.is_speech(pcm):
            self._in_speech = True
            self._speech_samples += n
            self._trailing_silence = 0
            return False

        # 静音帧
        if self._in_speech:
            self._trailing_silence += n
            if (
                self._trailing_silence >= self.hangover_samples
                and self._speech_samples >= self.min_speech_samples
            ):
                # 一轮结束
                self.reset()
                return True
        return False
