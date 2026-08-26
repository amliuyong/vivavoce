"""单通会话编排器 —— 串 ASR + VAD(端点)+ TTS,处理 cancel/barge-in。

纯逻辑、无 I/O:输入上行事件(audio/tts_text/cancel),产出下行消息序列。
WS 传输层(server.py)只负责收发帧并把字节喂进来 / 把产出发出去 —— 便于单测。

流式 turn(design contract):
  audio_meta+PCM → ASR partial(下行)→ VAD 端点命中 → asr_final + turn_end(下行)
  tts_text(Bridge 把 Bedrock LLM 分句后下发) → TTS 流式 → tts_audio_meta+PCM + tts_done(下行)
  cancel(barge_in/...) → 停当前 TTS 合成 → cancel_ack
"""
from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass

from . import protocol as P
from .asr_execution import AsrExecution, InlineAsrExecution
from .engines import AsrEngine, TtsEngine, make_asr, make_tts
from .vad import EndpointDetector

#: 会话层内建默认(design contract 单一事实源)。vad_debug 口径 = 唯 "1" 开。
SESSION_DEFAULTS = {
    "vad_debug": False,
    "asr_chunk_ms": 600,
}

_VAD_DEBUG = os.getenv("AIM_VAD_DEBUG", "") == "1"
logger = logging.getLogger(__name__)  # gpu_service.session(server._configure_logging 挂 stdout handler)

def _asr_lang_code(language: str | None) -> str | None:
    """会话 engine.language(如 zh-CN/zh/en-US/en/auto)→ SenseVoice finalize 语种码(zh/en/ja/ko/yue/auto),
    无法识别 → None(由 FunAsr.finalize 回退 _ASR_DEFAULT_LANG=auto)。避免全局写死 zh 误伤英文(review)。

    auto(跟随题目语言,Agent.engine.language):ASR 不偏置任何语种,交 SenseVoice 多语言自动判种 ——
    与 LLM「跟随题目语言」对齐(英文题库整场英文、SenseVoice 按 auto 识别英文)。注意:auto 在短句/噪声上
    语种误判风险高于显式偏置(注释见 funasr_backend),这是「跟随题目语言」灵活性的已知代价。"""
    if not language:
        return None
    lang = language.strip().lower()
    if lang.startswith("auto"):
        return "auto"  # 显式:SenseVoice 多语言自动判种(跟随题目语言场景)
    for prefix, code in (("zh", "zh"), ("en", "en"), ("ja", "ja"), ("ko", "ko"), ("yue", "yue")):
        if lang.startswith(prefix):
            return code
    return None  # 未知 → finalize 用默认(auto)


@dataclass
class OutFrame:
    """下行帧:control 必有;若带 pcm 则按"meta text 帧 + 紧跟 binary"发出。"""

    control: P.ControlMessage
    pcm: bytes | None = None


class SessionOrchestrator:
    def __init__(
        self,
        session_id: str,
        *,
        language: str | None = None,
        voice: str | None = None,
        tts_provider: str | None = None,
        asr: AsrEngine | None = None,
        asr_execution: AsrExecution | None = None,
        asr_concurrency: Callable[[], int] | None = None,
        asr_chunk_ms: int = SESSION_DEFAULTS["asr_chunk_ms"],
        tts: TtsEngine | None = None,
        endpoint: EndpointDetector | None = None,
    ):
        if asr_chunk_ms <= 0:
            raise ValueError("asr_chunk_ms 必须 > 0")
        self.session_id = session_id
        # 会话语言(控制面经 start.data.language 下发 engine.language,如 zh-CN/en)→ ASR finalize 复核语言偏置,
        # 避免 SenseVoice auto 误判(中文短句幻听 / 又不误伤英文)。映射到 SenseVoice 语种码。
        self.asr_language = _asr_lang_code(language)
        self.asr = asr or make_asr()  # ASR 永远是当前后端(真实部署即 FunASR),与 tts_provider 解耦(design contract)
        self.asr_execution = asr_execution or InlineAsrExecution()
        self._asr_concurrency = asr_concurrency or (lambda: 1)
        self._asr_chunk_bytes = (
            P.ASR_SAMPLE_RATE * P.SAMPLE_WIDTH_BYTES * asr_chunk_ms // 1000
        )
        # voice = 参考音/音色 key(控制面经 start.data.voice 下发,male_std/female_std…)。
        # tts_provider = TTS 段 provider(gpu_omnivoice|minimax,design contract):缺省回退系统默认本地 OmniVoice;
        # minimax → MiniMaxTts(云端,据 voice 映射 voice_id);整场只有 TTS 段改变,ASR/VAD/turn/admission 全不变。
        # language 也传 TTS:本地 OmniVoice 据此选中/英母语参考音(修英文用中文声纹的口音,auto 逐句检测)。
        self.tts = tts or make_tts(voice, tts_provider, language)
        self.endpoint = endpoint or EndpointDetector()
        self._seq = 0
        self._cancelled = False
        self._tts_active = False
        self._had_speech = False  # 本轮是否检测到语音(finalize_turn 据此避免空轮触发空 LLM)
        self._asr_pending = bytearray()
        self._last_partial_text: str | None = None
        self._latest_asr_audio_at: float | None = None
        self.input_epoch = 0
        self.input_turn_id = 0
        self._dbg_n = 0  # VAD 诊断帧计数(AIM_VAD_DEBUG)
        # cancel 代际(修 cancel 队头阻塞,见 server 的 TTS 句队列):每次 cancel/stop_tts +1。
        # server 在 tts_text 入队时捕获当前代际,合成前(on_tts_text 内)核对——代际已变 = 该句属于
        # 已被打断的旧轮 → 整句丢弃,绝不合成(光清队列关不死「已出队、未开跑」的在途句)。
        self.cancel_epoch = 0
        self._cancelled_at_by_epoch: dict[int, float] = {}

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    # ── 上行处理 ──
    async def _run_asr(self, kind: str, input_audio_ms: float, func: Callable[[], str | None]) -> str | None:
        return await self.asr_execution.run(
            session_id=self.session_id,
            concurrency=max(1, self._asr_concurrency()),
            input_epoch=self.input_epoch,
            input_turn_id=self.input_turn_id,
            kind=kind,
            input_audio_ms=input_audio_ms,
            func=func,
        )

    def _partial_frame(self, partial: str | None) -> OutFrame | None:
        if not partial or partial == self._last_partial_text:
            return None
        self._last_partial_text = partial
        if self._latest_asr_audio_at is not None:
            self.asr_execution.observe_partial_age(
                (time.monotonic() - self._latest_asr_audio_at) * 1000
            )
        return OutFrame(P.asr_partial(
            self.session_id,
            self._next_seq(),
            partial,
            input_epoch=self.input_epoch,
            input_turn_id=self.input_turn_id,
        ))

    async def _transcribe(self, pcm: bytes, *, kind: str) -> OutFrame | None:
        partial = await self._run_asr(
            kind,
            len(pcm) / (P.ASR_SAMPLE_RATE * P.SAMPLE_WIDTH_BYTES) * 1000,
            lambda: self.asr.transcribe_chunk(pcm),
        )
        return self._partial_frame(partial)

    async def _flush_residual(self) -> None:
        if not self._asr_pending:
            return
        residual = bytes(self._asr_pending)
        self._asr_pending.clear()
        await self._transcribe(residual, kind="residual")

    async def _finalize_asr(self) -> str | None:
        finalize_started_at = time.monotonic()
        await self._flush_residual()
        final_text = await self._run_asr(
            "finalize",
            0,
            lambda: self.asr.finalize(self.asr_language),
        )
        self._last_partial_text = None
        self._latest_asr_audio_at = None
        self.asr_execution.observe_finalize(
            (time.monotonic() - finalize_started_at) * 1000
        )
        return final_text

    async def on_audio(self, pcm: bytes) -> list[OutFrame]:
        """喂一帧入向音频:有语音才出 asr_partial,端点命中再出 asr_final + turn_end。

        VAD 仍逐帧运行；speech PCM 在会话内累计到 FunASR 的 600ms 主块后才进入 ASR。
        """
        output: list[OutFrame] = []
        P.validate_pcm(pcm)
        is_speech = self.endpoint.is_speech(pcm)
        # 真机标定诊断:每 ~50 帧(~1s)打一次 RMS + 判定,定位「VAD 永远 speech → 不出 turn_end」
        # (AIM_VAD_DEBUG=1 开启)。电话底噪/媒体泵静音流的 RMS 决定阈值该设多少。
        if _VAD_DEBUG:
            self._dbg_n += 1
            if self._dbg_n % 50 == 0:
                print(f"[vad {self.session_id}] rms={self.endpoint.rms(pcm):.0f} "
                      f"thr={self.endpoint.energy_threshold:.0f} speech={is_speech} "
                      f"trail_sil={self.endpoint._trailing_silence} in_speech={self.endpoint._in_speech}",
                      flush=True)
        if is_speech:
            self._had_speech = True
            received_ms = len(pcm) / (P.ASR_SAMPLE_RATE * P.SAMPLE_WIDTH_BYTES) * 1000
            self.asr_execution.audio_received(self.session_id, received_ms)
            self._latest_asr_audio_at = time.monotonic()
            self._asr_pending.extend(pcm)
            while len(self._asr_pending) >= self._asr_chunk_bytes:
                chunk = bytes(self._asr_pending[:self._asr_chunk_bytes])
                del self._asr_pending[:self._asr_chunk_bytes]
                partial = await self._transcribe(chunk, kind="stream")
                if partial is not None:
                    output.append(partial)

        if self.endpoint.push(pcm):
            final_text = await self._finalize_asr()
            self._had_speech = False
            if _VAD_DEBUG:
                print(f"[vad {self.session_id}] TURN_END final={final_text!r}", flush=True)
            # 空 final(短句门过滤掉的噪声/IVR 残片 / 静音轮)→ **不发 asr_final**,避免 bridge 写空 transcript
            # 污染审计(review);仍发 turn_end 让上层有明确轮结束信号(空文本下游不触发 LLM)。
            if final_text and final_text.strip():
                output.append(OutFrame(P.asr_final(
                    self.session_id,
                    self._next_seq(),
                    final_text,
                    input_epoch=self.input_epoch,
                    input_turn_id=self.input_turn_id,
                )))
            # 可观测性:turn_end 是「一轮说完、该触发 LLM→TTS」的关键点;记 final 长度(不记原文,隐私)
            # → 真机「说一会就哑」可看出是 turn_end 不触发(无此行)还是触发后 TTS 卡(有 turn_end 无 tts)。
            logger.info("turn_end sid=%s final_chars=%d", self.session_id,
                        len(final_text.strip()) if final_text else 0)
            output.append(OutFrame(P.turn_end(
                self.session_id,
                self._next_seq(),
                input_epoch=self.input_epoch,
                input_turn_id=self.input_turn_id,
            )))
            self.input_turn_id += 1
        return output

    def on_tts_text(
        self,
        text: str,
        epoch: int | None = None,
        *,
        ai_turn_id: int | None = None,
        segment_id: int | None = None,
        on_provider_start: Callable[[float], None] | None = None,
        on_model_compute: Callable[[float], None] | None = None,
    ) -> Iterator[OutFrame]:
        """合成一段文本为流式 TTS 音频(可被 cancel 中断)。

        epoch:该句入队时捕获的 cancel 代际(server 的 TTS 句队列传入)。与当前代际不符 = 该句属于
        已被 cancel 的旧轮 → 整句丢弃不合成;合成中代际变化(cancel 到达)→ 下一块前停。
        None(直调,兼容旧路径/单测)= 不做代际核对,仅看 _cancelled 旗。"""
        if not text:
            return
        if epoch is not None and epoch != self.cancel_epoch:
            logger.info("tts_text 丢弃旧代际句 sid=%s(epoch %d != %d,cancel 已到)",
                        self.session_id, epoch, self.cancel_epoch)
            return
        self._cancelled = False
        self._tts_active = True
        n_chunks = 0
        # tts 段后端类名(OmniVoiceTts/MiniMaxTts/FallbackTts/StubTts)→ 一眼看出这句走哪个 provider。
        backend = type(self.tts).__name__
        logger.info("tts_text sid=%s backend=%s chars=%d", self.session_id, backend, len(text))
        try:
            if on_provider_start is not None:
                on_provider_start(time.monotonic())
            for chunk in self.tts.synthesize(text):
                # Record the provider boundary before cancellation suppresses
                # this old-generation chunk. The transport layer needs this
                # timestamp to measure real post-cancel compute tail.
                if on_model_compute is not None:
                    on_model_compute(time.monotonic())
                # _cancelled 旗之外再核对代际:on_tts_text 开头的 `_cancelled=False` 复位与并发 cancel
                # 之间有极窄竞态窗(生成器 body 在 executor 线程跑),代际比较不受复位影响,双保险。
                if self._cancelled or (epoch is not None and epoch != self.cancel_epoch):
                    break
                seq = self._next_seq()
                n_chunks += 1
                yield OutFrame(P.tts_audio_meta(
                    self.session_id,
                    seq,
                    len(chunk),
                    ai_turn_id=ai_turn_id,
                    segment_id=segment_id,
                ), pcm=chunk)
            if not self._cancelled:
                yield OutFrame(P.tts_done(
                    self.session_id,
                    self._next_seq(),
                    ai_turn_id=ai_turn_id,
                    segment_id=segment_id,
                ))
            # 0 帧 = 合成没出音(空文本已上面 return;到这 0 帧多半是后端异常被吞)——值得告警。
            (logger.info if n_chunks > 0 else logger.warning)(
                "tts_done sid=%s backend=%s chunks=%d cancelled=%s",
                self.session_id, backend, n_chunks, self._cancelled)
        finally:
            self._tts_active = False

    async def finalize_turn(
        self,
        *,
        expected_input_epoch: int | None = None,
        expected_input_turn_id: int | None = None,
    ) -> list[OutFrame]:
        """主动结束当前一轮(用户「结束本轮」/无尾随静音时):立即 finalize ASR 并出
        asr_final + turn_end,触发下游 LLM→TTS。不关闭会话(区别于 on_cancel/end)。

        VAD 端点只在「语音后接静音」才自然命中;连续说话/录音无尾静音时永远不出 turn_end
        (实测 voice-test 卡住的根因)。本方法给上层一个显式「话说完了,回我」的入口。
        重置端点检测,使下一轮干净开始。

        **始终发 turn_end**(让上层/前端必有一个明确「轮结束」信号,不会卡在等待):
          - 本轮有语音 → 先 asr_final(带文本)再 turn_end → 下游正常 LLM→TTS;
          - 本轮无语音(误点结束本轮 / 音频未到)→ 只 turn_end(无 asr_final)→ 后端 _run_llm_to_tts
            见空文本回 no_speech 状态 → 前端据此恢复麦克风(不空跑 LLM)。"""
        has_epoch = expected_input_epoch is not None
        has_turn = expected_input_turn_id is not None
        if has_epoch != has_turn:
            raise P.ProtocolError("flush 必须同时携带 input_epoch 和 input_turn_id")
        if has_epoch and has_turn:
            assert expected_input_epoch is not None
            assert expected_input_turn_id is not None
            if (
                isinstance(expected_input_epoch, bool)
                or not isinstance(expected_input_epoch, int)
                or expected_input_epoch < 0
                or isinstance(expected_input_turn_id, bool)
                or not isinstance(expected_input_turn_id, int)
                or expected_input_turn_id < 0
            ):
                raise P.ProtocolError("flush input identity 必须是非负整数")
            expected = (expected_input_epoch, expected_input_turn_id)
            current = (self.input_epoch, self.input_turn_id)
            if expected < current:
                return []
            if expected > current:
                raise P.ProtocolError(
                    f"flush input identity 超前:当前 {current[0]}:{current[1]},"
                    f"收到 {expected[0]}:{expected[1]}"
                )

        had_speech = self._had_speech
        self._had_speech = False
        self.endpoint.reset()
        output: list[OutFrame] = []
        if had_speech:
            final_text = await self._finalize_asr()
            if final_text and final_text.strip():
                output.append(OutFrame(P.asr_final(
                    self.session_id,
                    self._next_seq(),
                    final_text,
                    input_epoch=self.input_epoch,
                    input_turn_id=self.input_turn_id,
                )))
        output.append(OutFrame(P.turn_end(
            self.session_id,
            self._next_seq(),
            input_epoch=self.input_epoch,
            input_turn_id=self.input_turn_id,
        )))
        self.input_turn_id += 1
        return output

    async def _reset_uncommitted_input(self) -> None:
        self._had_speech = False
        self._discard_pending_asr()
        self._asr_pending.clear()
        self._last_partial_text = None
        self._latest_asr_audio_at = None
        self.endpoint.reset()
        await self._run_asr("reset", 0, self.asr.reset)

    async def reset_input(self, *, from_input_epoch: int, next_input_epoch: int) -> OutFrame:
        """Reset only the uncommitted ASR/VAD input and advance its destructive fence."""
        reset_started_at = time.monotonic()
        if from_input_epoch != self.input_epoch or next_input_epoch != self.input_epoch + 1:
            raise P.ProtocolError(
                f"input_reset epoch 非连续:当前 {self.input_epoch},请求 "
                f"{from_input_epoch}->{next_input_epoch}"
            )
        await self._reset_uncommitted_input()
        self.input_epoch = next_input_epoch
        self.input_turn_id = 0
        self.asr_execution.observe_reset_ack(
            (time.monotonic() - reset_started_at) * 1000
        )
        return OutFrame(P.input_reset_ack(self.session_id, self.input_epoch))

    async def on_cancel(self, reason: str) -> list[OutFrame]:
        """barge-in / 会话级中止:停当前 TTS,回 cancel_ack。"""
        self.stop_tts()
        await self._reset_uncommitted_input()
        return [OutFrame(P.cancel_ack(self.session_id, reason))]

    def _discard_pending_asr(self) -> None:
        pending_ms = len(self._asr_pending) / (
            P.ASR_SAMPLE_RATE * P.SAMPLE_WIDTH_BYTES
        ) * 1000
        if pending_ms > 0:
            self.asr_execution.audio_discarded(self.session_id, pending_ms)

    def close_input(self) -> None:
        """Discard unsubmitted audio when a WebSocket ends."""
        self._discard_pending_asr()
        self._asr_pending.clear()
        self._latest_asr_audio_at = None

    def stop_tts(self) -> None:
        """置 _cancelled(在飞 TTS 下一块前停)+ 代际 +1(队列里/在途的旧轮句整句丢弃),
        **不产 cancel_ack**(end/断连收尾路径直接用;on_cancel 在此之上加 ack 帧)。
        注意 on_cancel 是生成器函数——调用不迭代则 body 根本不执行;收尾路径不需要 ack 帧,
        用本方法显式置位(修 server end/finally 路径「调了 on_cancel 却没停 TTS」的 no-op)。"""
        cancelled_epoch = self.cancel_epoch
        self._cancelled = True
        self._cancelled_at_by_epoch[cancelled_epoch] = time.monotonic()
        self.cancel_epoch += 1

    def cancellation_at(self, epoch: int | None) -> float | None:
        if epoch is None:
            return None
        return self._cancelled_at_by_epoch.get(epoch)

    def tts_provider_name(self) -> str:
        provider = getattr(self.tts, "telemetry_provider", "gpu_omnivoice")
        if callable(provider):
            provider = provider()
        return provider if isinstance(provider, str) and provider else "gpu_omnivoice"

    def tts_cache_state(self, text: str) -> str:
        state = getattr(self.tts, "telemetry_cache_state", None)
        if callable(state):
            value = state(text)
            if value in {"cold", "warm", "not_applicable", "unknown"}:
                return value
        return "unknown"

    def ready(self) -> OutFrame:
        return OutFrame(P.ready(self.session_id))

    def bye(self) -> OutFrame:
        return OutFrame(P.bye(self.session_id))
