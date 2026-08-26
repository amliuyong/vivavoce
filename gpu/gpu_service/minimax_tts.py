"""MiniMax 云端 TTS 后端(design contract)—— three_stage 的一个可选 TTS provider。

实现 014 的 TtsEngine 接口(synthesize(text) -> Iterator[bytes],产 24kHz mono s16le PCM 块),
与 OmniVoiceTts / StubTts 平级。仅 TTS 段改变;ASR 永远是当前后端(FunASR),与本模块解耦。

国内版 MiniMax T2A v2 同步接口契约(deployment validation 官方文档核实):
  - POST https://api.minimaxi.com/v1/t2a_v2(base_url 全局可覆盖,整串替换切备用域名/灰度)
  - 鉴权:仅 Authorization: Bearer <api_key> + Content-Type: application/json(**无 GroupId** —— t2a_v2 无此字段)
  - body:model=speech-2.8-turbo / text=短句 / stream=false / output_format=hex /
          voice_setting.voice_id(语义 key 映射)/ audio_setting={format:pcm,sample_rate:24000,channel:1} /
          language_boost=Chinese
  - 响应:成功判据 = body 的 base_resp.status_code==0(**失败时 HTTP 仍可能 200**,故必须解析 body);
          音频在 data.audio(hex 字符串),bytes.fromhex 解码 → 按 20ms 帧切块 yield。
          data 可能为 null / 缺 audio / 空音频 → 一并抛错(不静默、不回灌静音冒充成功)。
          错误码:1001 超时 / 1002 限流 / 1004 鉴权失败 / 1039 TPM 限流 / 1042 非法字符占比>10% / 2013 参数异常。

可打断(与 OmniVoice 同构):HTTP 整句往返不可断(合成在途),hex 解码切帧后的**回灌阶段**帧间可断
(由 session.on_tts_text 的 _cancelled 检查实现,本类只产帧)。HTTP MUST 设**短超时**(timeout_s),
封顶不可断窗口/线程占用,超时即抛错走降级(server._run_tts 兜底补 tts_done + error 帧)。

零新 pip 依赖:仅标准库 urllib(不动 Dockerfile/requirements);boto3 仅 minimax_config 读 Secret 用。
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from collections.abc import Iterator

from .minimax_config import MiniMaxConfig, get_minimax_config
from .protocol import TTS_SAMPLE_RATE
from .voice_lang import normalize_lang, resolve_lang_for_text

logger = logging.getLogger(__name__)

FRAME_MS = 20  # 与 OmniVoice 输出形态一致:24k mono s16le,20ms/帧

# 已知错误码 → 可读说明(据 base_resp.status_code 识别,design contract)。
_ERROR_CODES = {
    1000: "未知错误",
    1001: "超时(timeout)",
    1002: "触发限流(rate limit)",
    1004: "鉴权失败(api key 无效)",
    1039: "TPM 限流",
    1042: "非法字符占比 >10%",
    2013: "输入参数异常",
}


class MiniMaxTtsError(RuntimeError):
    """MiniMax 合成失败(非成功码/空音频/网络/超时)。携带 status_code 供诊断。
    经 server._run_tts 上报 error 帧 + 补 tts_done(单句失败=漏句降级,本轮不卡;design contract)。"""

    def __init__(self, message: str, *, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class MiniMaxTts:
    """MiniMax T2A v2 同步合成(design contract)。每会话 new 一个,snapshot 当时配置(在途不受热加载影响)。

    voice = 语义音色 key(male_std/female_std…);经系统级全局映射(MiniMaxConfig.voice_id_for)翻成
    MiniMax voice_id;未知/缺省 fail-safe 回退默认 voice_id。

    ★ 语言维度(修「英文用中文音色 → 口音重」根因,与 OmniVoice 同一套 "<key>.<lang>" 约定):
      language=en → 整场用英文母语 system voice(voice_map 的 "<key>.en");language=auto → **逐句**
      按文本判中/英选对应音色 + language_boost;无对应语言音色则回退裸 key(中文)。voice_id 逐句解析
      (auto 混合场景中英各句各得其所);非 auto 场景每句解析同一结果(无额外成本)。
    """
    telemetry_provider = "minimax"

    def __init__(self, voice: str | None = None, language: str | None = None,
                 *, config: MiniMaxConfig | None = None) -> None:
        # snapshot 配置:会话起始即定,整场不变(在途会话不受 /reload-tts-config 影响,design contract 原子替换)。
        self._cfg = config or get_minimax_config()
        self._voice = voice
        # 参考音语言模式(en/zh/auto/None);逐句 resolve_lang_for_text 定本句实际语言。
        self._ref_lang = normalize_lang(language)

    def synthesize(self, text: str) -> Iterator[bytes]:
        if not text or not text.strip():
            return
        # enabled 与 has_key **都**要满足才合成(防御性:正常路径下 make_tts 已在配置不可用时直接返回本地
        # 引擎、根本不构造本类;此处再判一道,确保即便被直接实例化也不会"未启用却计费合成")。任一不满足 →
        # 抛错;在 FallbackTts 内会被捕获 → 回退本地 OmniVoice 合成该句(design contract:不可用时回退本地)。
        if not self._cfg.enabled:
            raise MiniMaxTtsError("MiniMax 未启用(admin 未勾选启用);本句不合成")
        if not self._cfg.has_key:
            raise MiniMaxTtsError("MiniMax 已启用但未配置 API key")
        stripped = text.strip()
        # 逐句定语言 → 选 voice_id(英文句用英文母语音色)+ language_boost(en→English)。
        # auto 混合场景:中文句用中文音色/Chinese boost,英文句用英文音色/English boost,各句各得其所。
        lang = resolve_lang_for_text(self._ref_lang, stripped)
        voice_id = self._cfg.voice_id_for(self._voice, lang)
        boost = self._cfg.boost_for(lang)
        audio = self._request_audio(stripped, voice_id=voice_id, language_boost=boost)
        # hex 解码后即为 24k mono s16le 裸 PCM;按 20ms 帧切块 yield(与 OmniVoice 输出形态一致)。
        frame = TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2  # bytes/frame
        for i in range(0, len(audio), frame):
            yield audio[i : i + frame]

    def telemetry_cache_state(self, text: str) -> str:  # noqa: ARG002
        return "not_applicable"

    def _request_audio(self, text: str, *, voice_id: str, language_boost: str) -> bytes:
        """同步 HTTP 往返(在线程池里跑,见 server._run_tts);返回解码后的裸 PCM 字节。
        voice_id / language_boost 由 synthesize 逐句解析后传入(语言维度:英文句 → 英文音色 + English boost)。

        失败(非成功码/空音频/超时/网络)抛 MiniMaxTtsError —— 不静默、不回灌静音冒充成功。
        """
        body = {
            "model": self._cfg.model,
            "text": text,
            "stream": False,
            "output_format": "hex",
            "voice_setting": {"voice_id": voice_id},
            # 直取裸 PCM、24000 Hz、单声道、s16le,与 GPU 下行契约对齐,免重采样、免剥容器头。
            "audio_setting": {"format": "pcm", "sample_rate": TTS_SAMPLE_RATE, "channel": 1},
            "language_boost": language_boost,
        }
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            self._cfg.base_url,
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._cfg.api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            # 短超时(connect+read 共用此值)封顶不可断窗口/线程占用;超时即抛错走降级。
            with urllib.request.urlopen(req, timeout=self._cfg.timeout_s) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:  # 4xx/5xx
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:200]
            except Exception:  # noqa: BLE001
                pass
            raise MiniMaxTtsError(f"MiniMax HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # 超时/连接失败:封顶在 timeout_s,抛错走降级(限流/跨境抖动均落此)。
            raise MiniMaxTtsError(f"MiniMax 请求失败/超时: {exc}") from exc

        return self._parse_response(raw)

    @staticmethod
    def _parse_response(raw: bytes) -> bytes:
        """解析 MiniMax 响应:**HTTP 200 ≠ 成功**,以 body 的 base_resp.status_code==0 判定。"""
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise MiniMaxTtsError(f"MiniMax 响应非合法 JSON: {exc}") from exc
        base = obj.get("base_resp") or {}
        raw_status = base.get("status_code")
        # 归一为 int 再比较(code-review:官方标 int,但若返字符串 "0",`"0" != 0` 会把成功误判失败 →
        # 漏句)。可转 int 则用之;不可转(None/非数字)→ 视作失败(status=None)。
        try:
            status: int | None = int(raw_status)
        except (TypeError, ValueError):
            status = None
        if status != 0:
            hint = _ERROR_CODES.get(status, "")
            msg = base.get("status_msg", "")
            raise MiniMaxTtsError(
                f"MiniMax 合成失败 status_code={raw_status}({hint}){(' ' + msg) if msg else ''}",
                status_code=status,
            )
        # 官方明确 data 可能为 null;data 为 null / 缺 audio / 空 → 抛错(不静默、不回灌静音)。
        data = obj.get("data")
        if not isinstance(data, dict):
            raise MiniMaxTtsError("MiniMax 成功码但 data 为空(无音频)")
        audio_hex = data.get("audio")
        if not audio_hex or not isinstance(audio_hex, str):
            raise MiniMaxTtsError("MiniMax 成功码但缺 data.audio")
        try:
            pcm = bytes.fromhex(audio_hex)
        except ValueError as exc:
            raise MiniMaxTtsError(f"MiniMax data.audio hex 解码失败: {exc}") from exc
        if len(pcm) == 0:
            raise MiniMaxTtsError("MiniMax 返回空音频(解码后 0 字节)")
        return pcm
