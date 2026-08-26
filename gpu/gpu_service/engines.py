"""ASR / TTS 引擎接口 + 可本地运行的 stub 实现 + 真实实现的接入点。

设计:协议/编排层只依赖这两个接口;模型实现可插拔。
  - StubAsr / StubTts:不依赖 GPU,可本地跑(CI/单测/冒烟);行为上满足"流式、有输出"。
  - FunAsr / 真实 TTS:在带 GPU 的镜像里(extras=models)注入,接口不变。
环境变量 AIM_GPU_BACKEND=stub|funasr 选择;默认 stub(本地/无 GPU 安全)。
"""
from __future__ import annotations

import logging
import math
import os
import struct
import threading
import time
from collections.abc import Iterator
from typing import Protocol

from .protocol import SPEAKER_EMBEDDING_DIM, TTS_SAMPLE_RATE

_logger = logging.getLogger(__name__)


class SpeakerEmbedder(Protocol):
    def embed(self, pcm: bytes) -> list[float]:
        """一段 16k mono s16le PCM → SPEAKER_EMBEDDING_DIM 维 speaker embedding(design contract)。

        **无状态**:只算向量,不持有/比对参考声纹(注册/门控/cosine 全在 bridge)。
        """
        ...


class AsrEngine(Protocol):
    def transcribe_chunk(self, pcm: bytes) -> str | None:
        """喂一段 PCM,返回当前累积的 partial 文本(无更新可返回 None)。"""
        ...

    def finalize(self, language: str | None = None) -> str:
        """一轮结束:返回 final 文本并复位内部状态。language 随会话语言偏置复核(None=默认)。"""
        ...

    def reset(self) -> None: ...


class TtsEngine(Protocol):
    def synthesize(self, text: str) -> Iterator[bytes]:
        """把一段文本流式合成为 24k s16le PCM 块(逐块 yield)。"""
        ...


class StubAsr:
    """本地可跑的占位 ASR:按累积音频长度产出确定性的 partial/final 文本。

    不做真实识别,但保证:有语音→有 partial;finalize→非空 final;可流式。
    足以驱动协议/编排/端点检测的真实测试。
    """

    def __init__(self) -> None:
        self._samples = 0

    def transcribe_chunk(self, pcm: bytes) -> str | None:
        self._samples += len(pcm) // 2
        if self._samples == 0:
            return None
        # partial:用累积时长(100ms 粒度)生成稳定文本
        tenths = self._samples * 10 // 16000
        return f"[识别中 {tenths/10:.1f}s]"

    def finalize(self, language: str | None = None) -> str:  # noqa: ARG002 - stub 不按语言变,签名对齐
        secs = self._samples / 16000
        self.reset()
        return f"[一轮语音 {secs:.1f}s]"

    def reset(self) -> None:
        self._samples = 0


class StubTts:
    """本地可跑的占位 TTS:把文本合成为确定性的 24k s16le 正弦 PCM(每字一段)。

    真实做了 PCM 生成(可回灌、可计长),只是音色非真实嗓音。
    voice 参数仅为与真实 OmniVoiceTts 签名对齐(stub 不真用音色),保证选音色不改链路也能本地跑。
    """

    FRAME_MS = 20
    telemetry_provider = "gpu_omnivoice"

    def __init__(self, voice: str | None = None, language: str | None = None) -> None:  # noqa: ARG002 - stub 不按音色/语言变,签名对齐
        pass

    def synthesize(self, text: str) -> Iterator[bytes]:
        frame_samples = TTS_SAMPLE_RATE * self.FRAME_MS // 1000
        # 每个字符约 60ms 语音(3 帧),频率随字符变化
        for ch in text:
            freq = 180 + (ord(ch) % 12) * 20
            for f in range(3):
                buf = bytearray()
                for i in range(frame_samples):
                    t = (f * frame_samples + i) / TTS_SAMPLE_RATE
                    val = int(8000 * math.sin(2 * math.pi * freq * t))
                    buf += struct.pack("<h", val)
                yield bytes(buf)

    def telemetry_cache_state(self, text: str) -> str:  # noqa: ARG002
        return "not_applicable"


class StubSpeakerEmbedder:
    """本地可跑的占位声纹 embedder(design contract):从 PCM 内容确定性地派生一个 DIM 维向量。

    不做真实声纹,但保证:① 维度 = SPEAKER_EMBEDDING_DIM;② **确定性**(同一段音频 → 同一向量);
    ③ 内容不同 → 向量不同(粗特征:按 DIM 桶取样本能量,L2 归一)。足以驱动 bridge 侧注册/门控逻辑的
    本地测试(bridge UT 另用注入式 stub 精确控制 cosine)。纯 Python、不依赖 numpy/GPU。
    """

    def embed(self, pcm: bytes) -> list[float]:
        n = len(pcm) // 2
        if n == 0:
            # 空音频:返回零向量(bridge 侧据 refEmb/维度做 UNCERTAIN fail-open,不会崩)
            return [0.0] * SPEAKER_EMBEDDING_DIM
        samples = struct.unpack(f"<{n}h", pcm[: n * 2])
        # 按 DIM 桶聚合 |sample| 均值 → 内容相关的确定性特征向量
        vec = [0.0] * SPEAKER_EMBEDDING_DIM
        cnt = [0] * SPEAKER_EMBEDDING_DIM
        for i, s in enumerate(samples):
            b = (i * SPEAKER_EMBEDDING_DIM) // n
            vec[b] += abs(s)
            cnt[b] += 1
        vec = [(v / c if c else 0.0) for v, c in zip(vec, cnt, strict=True)]  # 两侧同为 DIM 长,不等即应报错
        norm = math.sqrt(sum(v * v for v in vec))
        if norm == 0.0:
            return [0.0] * SPEAKER_EMBEDDING_DIM
        return [v / norm for v in vec]


def make_asr() -> AsrEngine:
    backend = os.getenv("AIM_GPU_BACKEND", ENGINES_DEFAULTS["backend"])
    if backend == "funasr":
        from .funasr_backend import FunAsr  # type: ignore  # noqa: PLC0415

        return FunAsr()
    return StubAsr()


def make_speaker_embedder() -> SpeakerEmbedder:
    """构造声纹 embedder(design contract)。funasr 后端 → 真 CAM++(进程级单例);否则 StubSpeakerEmbedder。

    与 make_asr/make_tts 同款 backend 选择;真实实现内部走 @lru_cache(maxsize=1) 单例
    (funasr_backend._campplus_model),不可每请求重载。
    """
    backend = os.getenv("AIM_GPU_BACKEND", ENGINES_DEFAULTS["backend"])
    if backend == "funasr":
        from .funasr_backend import CampplusEmbedder  # type: ignore  # noqa: PLC0415

        return CampplusEmbedder()
    return StubSpeakerEmbedder()


def _make_local_tts(voice: str | None = None, language: str | None = None) -> TtsEngine:
    """本地 TTS(默认后端):funasr→真 OmniVoice voice clone;否则 StubTts(本地/CI)。
    language → 参考音语言(修英文口音):OmniVoice 据此选中/英母语参考音(auto 逐句检测);Stub 忽略。"""
    backend = os.getenv("AIM_GPU_BACKEND", ENGINES_DEFAULTS["backend"])
    if backend == "funasr":
        from .funasr_backend import OmniVoiceTts  # type: ignore  # noqa: PLC0415

        return OmniVoiceTts(voice, language)
    return StubTts(voice, language)


class _ProviderHealth:
    """TTS 主 provider(MiniMax)健康状态 + 后台半开探测(design contract,借鉴 LiveKit FallbackAdapter
    `recovering_task` 软熔断)。**进程级共享**(跨并发会话):一次 MiniMax 故障不该让**每个**会话的**每句**
    都白付一次注定失败的跨境往返(design contract 旧 FallbackTts 是逐句盲试)。

    状态机(单门,时钟用 monotonic 免受墙钟回拨影响):
      - CLOSED(healthy):主 provider 可用,正常尝试 MiniMax;单句失败即 open(记失败时刻)。
      - OPEN(unhealthy):cooldown 窗内**跳过 MiniMax、直接本地**(不再每句盲试);窗满转 HALF_OPEN。
      - HALF_OPEN:放**一句**去试 MiniMax(探针);成功 → close(恢复主),失败 → 重新 open(重置 cooldown)。
    与 design contract「单句失败回退本地、不漏句」正交叠加:任何一句永远有本地兜底出声,健康态只决定「这句要不要
    先试 MiniMax」。GPU task role 红线不破:纯进程内状态,无 DDB/Bedrock。健康态变迁走结构化日志(CloudWatch)。
    """

    def __init__(self, cooldown_s: float) -> None:
        self._lock = threading.Lock()
        self._cooldown_s = cooldown_s
        self._open_until = 0.0  # monotonic 时刻:此前跳过主 provider;0=CLOSED(healthy)
        self._half_open_inflight = False  # HALF_OPEN 已放出探针(避免并发多句同时探测)

    def _now(self) -> float:
        return time.monotonic()

    def should_try_primary(self) -> bool:
        """本句是否应先试主 provider(MiniMax)。OPEN 且 cooldown 未满 → False(直接本地);
        cooldown 满 → 放**一句**探针(HALF_OPEN,置 inflight 防并发多探)→ True。"""
        now = self._now()
        with self._lock:
            if self._open_until == 0.0:
                return True  # CLOSED:正常试主
            if now < self._open_until:
                # OPEN:cooldown 内,但已放探针的窗口尾部并发句仍直连本地
                return False
            # cooldown 满 → HALF_OPEN:只放一句探针
            if self._half_open_inflight:
                return False
            self._half_open_inflight = True
            return True

    def record_success(self) -> None:
        """主 provider 成功(正常句或探针)→ 关熔断(恢复 healthy)。"""
        with self._lock:
            was_open = self._open_until != 0.0
            self._open_until = 0.0
            self._half_open_inflight = False
        if was_open:
            _logger.info("TTS 主 provider(MiniMax)后台探测恢复 → 切回主(软熔断 close)")

    def record_failure(self) -> None:
        """主 provider 失败(正常句或探针失败)→ 开熔断,cooldown 内跳过主、直连本地。"""
        with self._lock:
            was_healthy = self._open_until == 0.0
            self._open_until = self._now() + self._cooldown_s
            self._half_open_inflight = False
        if was_healthy:
            _logger.warning(
                "TTS 主 provider(MiniMax)失败 → 开熔断 %.0fs(期间直连本地 OmniVoice,不再每句盲试)",
                self._cooldown_s)

    def _reset_for_test(self) -> None:
        with self._lock:
            self._open_until = 0.0
            self._half_open_inflight = False


# 主 provider 熔断 cooldown(秒):OPEN 期内跳过 MiniMax 直连本地;满后放一句探针试恢复。env 可调。
#: 引擎层内建默认(design contract 单一事实源)。
#: minimax_fallback_cooldown_s 是**无 GUI 运营开关**(TtsSettings 不管它)→ 纳入只读总览。
ENGINES_DEFAULTS = {
    "backend": "stub",
    "minimax_fallback_cooldown_s": 30.0,
}

_MINIMAX_COOLDOWN_S = float(
    os.getenv("AIM_MINIMAX_FALLBACK_COOLDOWN_S", str(ENGINES_DEFAULTS["minimax_fallback_cooldown_s"]))
)
# 进程级共享健康状态(跨并发会话软熔断,design contract)。
_minimax_health = _ProviderHealth(_MINIMAX_COOLDOWN_S)


def _reset_health_for_test() -> None:
    """测试钩子:清进程级 TTS provider 健康状态(下次 synthesize 从 CLOSED 起)。"""
    _minimax_health._reset_for_test()


class FallbackTts:
    """MiniMax 优先、失败回退本地 OmniVoice 的组合引擎(design contract + design contract provider 健康态显式化)。

    语义(design contract 保留):会话选了 minimax,但 MiniMax **运行时单句失败**(限流/超时/网络/空音频)→ 不漏句
    静默,改用本地 OmniVoice 把**同一句**合成出来,AI 照常说话。回退在**整句边界**:先尝试用 MiniMax 收集
    整句 PCM 帧(此时还没回灌),任一步抛错则丢弃半截、转交本地引擎合成整句。已成功产出帧才 yield 的句子不
    回退(不半句 MiniMax + 半句 OmniVoice 拼接,避免音色突变)——印证 LiveKit `retry_on_chunk_sent=False`。

    design contract 升级:引入**进程级 provider 健康状态 + 后台半开探测**(_minimax_health,借鉴 LiveKit
    FallbackAdapter 软熔断)。MiniMax 连续故障时**开熔断**、cooldown 窗内**直接本地**(不再每句盲试一次注定
    失败的跨境往返),窗满放一句探针试恢复。**声道一致契约**(design contract,同 LiveKit FallbackAdapter 声道必相同):
    主备候选 MUST 均输出 24k **mono** s16le(GPU protocol.py 契约);本类不做声道转换,采样率规整也不在此(两端
    均已是 24k mono)。GPU task role 红线不破:纯进程内状态,无 DDB/Bedrock。

    注:配置级不可用(enabled=false / 无 key)在 make_tts 层就直接返回本地引擎,不构造 MiniMaxTts(零浪费)。
    """

    def __init__(self, voice: str | None = None, language: str | None = None,
                 *, health: _ProviderHealth | None = None) -> None:
        from .minimax_tts import MiniMaxTts  # noqa: PLC0415

        self._voice = voice
        self._language = language  # 传给主/备:MiniMax 据此逐句选英文音色,本地 OmniVoice 据此选英文参考音
        self._primary = MiniMaxTts(voice, language)
        self._fallback: TtsEngine | None = None  # 惰性建本地引擎(仅真回退时才需要)
        self._health = health or _minimax_health  # 进程级共享(测试可注入独立实例)
        self._telemetry_provider = "minimax"
        self._telemetry_cache_state = "not_applicable"

    def telemetry_provider(self) -> str:
        return self._telemetry_provider

    def telemetry_cache_state(self, text: str) -> str:  # noqa: ARG002
        return self._telemetry_cache_state

    def _note_local_telemetry(self, text: str) -> None:
        self._telemetry_provider = "gpu_omnivoice"
        local = self._local()
        state = getattr(local, "telemetry_cache_state", None)
        self._telemetry_cache_state = state(text) if callable(state) else "unknown"

    def _local(self) -> TtsEngine:
        if self._fallback is None:
            self._fallback = _make_local_tts(self._voice, self._language)
        return self._fallback

    def synthesize(self, text: str):
        if not text or not text.strip():
            return
        # 软熔断(design contract):OPEN 且 cooldown 未满 → 跳过 MiniMax、直连本地(不白付跨境往返)。
        if not self._health.should_try_primary():
            self._note_local_telemetry(text)
            yield from self._local().synthesize(text)
            return
        self._telemetry_provider = "minimax"
        self._telemetry_cache_state = "not_applicable"
        try:
            # 先把整句的 MiniMax 帧收齐(整句往返,本就不可断)——失败在这里抛,尚未 yield 任何帧。
            chunks = list(self._primary.synthesize(text))
        except Exception as exc:  # noqa: BLE001 — MiniMax 单句失败 → 回退本地,不漏句
            self._health.record_failure()  # 记故障 → 开/续熔断(后续句直连本地直到探针恢复)
            _logger.warning("MiniMax 合成失败,回退本地 OmniVoice 合成该句: %s", exc)
            self._note_local_telemetry(text)
            yield from self._local().synthesize(text)
            return
        self._health.record_success()  # 成功(含探针)→ 关熔断,恢复主
        yield from chunks


def make_tts(voice: str | None = None, provider: str | None = None,
             language: str | None = None) -> TtsEngine:
    """构造 TTS 引擎(design contract:provider 段级分流;ASR 后端解耦,make_asr 不受影响)。

    voice = 参考音/音色 key(male_std/female_std…);真实 OmniVoice 据此 voice clone 锁声纹,
    MiniMax 据此映射 voice_id,stub 忽略(仅签名对齐)。
    language = 会话语言(zh-CN/en/auto…);本地 OmniVoice 据此选中/英母语参考音(修英文口音,auto 逐句检测),
    MiniMax 主路径靠英文母语 voice_id 本就地道、暂不据 language 改 voice_id,但其本地兜底句仍按 language 选参考音。

    provider 分流:
      - "minimax" 且**配置可用**(enabled + 有 key)→ FallbackTts(MiniMax 优先,单句失败回退本地);
      - "minimax" 但**配置不可用**(enabled=false / 无 key)→ 直接返回本地引擎(零浪费,不每句白试),
        与"MiniMax 不可用时回退本地"语义一致;
      - "gpu_omnivoice" / None / 其它 → 本地引擎(funasr→OmniVoice,否则 Stub),现状逐字节不变。
    """
    if provider == "minimax":
        from .minimax_config import get_minimax_config  # noqa: PLC0415

        cfg = get_minimax_config()
        if cfg.enabled and cfg.has_key:
            return FallbackTts(voice, language)
        # 配置级不可用:直接用本地,不构造 MiniMaxTts(避免每句一次注定失败的调用 + 漏句)
        import logging  # noqa: PLC0415
        logging.getLogger(__name__).info(
            "会话选 minimax 但配置不可用(enabled=%s has_key=%s),本会话回退本地 OmniVoice",
            cfg.enabled, cfg.has_key)
        return _make_local_tts(voice, language)
    return _make_local_tts(voice, language)
