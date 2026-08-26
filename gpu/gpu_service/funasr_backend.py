"""真实 ASR/TTS 后端(不 mock)—— 仅在 AIM_GPU_BACKEND=funasr 时加载,需 GPU + 模型权重。

模型加载遵循离线、可复现的部署方式:
ASR = FunASR:
  - paraformer-zh-streaming 流式实时转写(chunk_size=[0,10,5],跨 chunk 维护 cache)
  - SenseVoiceSmall 作 finalize 高精度复核(多语言 + 标点)
  权重**预下载到本地目录**(镜像 build 期从 S3 拉,见 Dockerfile),加载用本地路径不触网
  —— ModelScope 跨境限流、HF 的 repo id 又与 ModelScope 不一致(iic/SenseVoiceSmall 在 HF 404),
  本地路径最稳(funasr_engine.py:_local_or_id 同款)。
TTS = 真 OmniVoice(k2-fsa/OmniVoice,24kHz):源码在 vendor/omnivoice(纳入镜像),
  权重 HF snapshot 预下载到本地;`OmniVoice.from_pretrained` 加载,`generate(text=)` 出 PCM。

import 本模块即触发模型加载(数 GB,数秒~数十秒),故只在 funasr 后端按需 import。
"""
from __future__ import annotations

import io
import os
import wave
from functools import lru_cache
from pathlib import Path

import numpy as np

from .protocol import ASR_SAMPLE_RATE, TTS_SAMPLE_RATE
from .voice_lang import lang_key, normalize_lang, resolve_lang_for_text

# FunASR 流式 chunk 配置(asr-service-design.md):[0,10,5] = 600ms 主块 + 左右上下文
_CHUNK_SIZE = [0, 10, 5]
_ENCODER_LOOKBACK = 4
_DECODER_LOOKBACK = 1

# SenseVoice finalize 复核语言:**随会话 engine.language 走**(由调用方传入 finalize),不全局写死 ——
# 全局 zh 会误伤 English profile(review)。zh-CN→zh / en→en / 其它/未知→auto。env 仅作兜底默认。
#: FunASR/OmniVoice 内建默认(design contract:**单一事实源**;runtime_config 与 /config MUST import,
#: MUST NOT 另抄 —— bridge 侧实测手抄默认值 46% 出错)。
#: ⚠ force_cpu 口径 = 唯 "1" 才 CPU("true" **不**生效);AIM 期统一布尔口径曾致 GPU 静默切 CPU(Critical)。
FUNASR_DEFAULTS = {
    "asr_final_language": "auto",
    "asr_min_final_chars": 2,
    "asr_short_allowlist": "",       # env 是**追加项**(与内建集合并),非替换
    "asr_short_allowlist_en": "",
    "model_root": "/opt/aim-models",
    "tts_voice": "male_std",
    "tts_position_temperature": 3.0,
    "tts_guidance_scale": 2.5,
    "force_cpu": False,
}

_ASR_DEFAULT_LANG = os.getenv("AIM_ASR_FINAL_LANGUAGE", FUNASR_DEFAULTS["asr_final_language"])
# 短句过滤门:去标点后 < _ASR_MIN_FINAL_CHARS 视为低信息(噪声/截断/IVR 残片)→ 返回空不触发 LLM。
# 但中文口语很多合法一字答(对/嗯/好…),纯字符数会误杀(review)→ 一字答在 allowlist 内则放行。
# env:AIM_ASR_MIN_FINAL_CHARS(默认 2,0=关过滤)、AIM_ASR_SHORT_ALLOWLIST(逗号分隔,追加到内置表)。
_ASR_MIN_FINAL_CHARS = int(os.getenv("AIM_ASR_MIN_FINAL_CHARS", str(FUNASR_DEFAULTS["asr_min_final_chars"])))
# 常见中文一字答 allowlist(短句门放行):肯定/否定/应答/选择类口语单字。
_SHORT_ALLOWLIST = {
    "对", "嗯", "好", "是", "不", "行", "有", "没", "要", "会", "能", "在", "中",
    "对的", "好的", "是的",  # 顺带收双字常见答(本就 ≥2 字,放这里只为语义清晰)
} | {w.strip() for w in os.getenv("AIM_ASR_SHORT_ALLOWLIST", "").split(",") if w.strip()}
# 英文短答 allowlist(review:此前只有中文 → 英文 Profile 的合法单字符答复被短句门误杀)。
# 大小写不敏感(下行统一 .lower() 比对)。覆盖:① 选择题单字母答(A/B/C/D —— 题库内核的多选题答案);
# ② yes/no 类(y/n + 多字 ok/yes/no…,多字本已过 ≥2 门,列此只为语义对称、并经 env 追加)。
# env AIM_ASR_SHORT_ALLOWLIST_EN(逗号分隔,自动小写)追加到内置表。
_SHORT_ALLOWLIST_EN = {
    "a", "b", "c", "d", "y", "n",  # 选择题/yes-no 单字母
    "ok", "no", "yes", "yep", "nope", "sure", "right", "yeah", "nah",
} | {w.strip().lower() for w in os.getenv("AIM_ASR_SHORT_ALLOWLIST_EN", "").split(",") if w.strip()}

# 本地模型权重根目录(镜像 build 期从 S3 拉到这;funasr 加载用本地路径不触网)。
# 与 Dockerfile 的 AIM_MODEL_ROOT 一致;默认 /opt/aim-models。
_MODEL_ROOT = Path(os.getenv("AIM_MODEL_ROOT", FUNASR_DEFAULTS["model_root"]))
_FUNASR_MODELS = _MODEL_ROOT / "funasr" / "models"

# ── 参考音(voice clone)注册表 ──────────────────────────────────────────────
# voice clone 模式锁声纹:每句 generate(voice_clone_prompt=同一段参考音)→ 跨句/跨轮音色完全一致,
# 修「voice design(instruct)仍句间漂移」根因(instruct 只锁风格类别,同类内声纹仍逐句随机采样)。
# 参考音 wav + 同名 .txt(该音频的真实转写,作 voice clone 的 ref_text)由部署者在本地提供。
# 目录被 Git 忽略；本地构建时进入镜像，runtime 不触网。
#   ★ ref_text 用 sidecar(生成期 Whisper 转写)而非写死:voice-design 生成的音频未必逐字朗读输入文本
#     (实测男声曾把中文念成英文),写死文本会与音频不符 → clone 时 OmniVoice「读错词/跑飞」。生成期
#     转写一次存 sidecar,既保证 ref_text 与音频精确匹配(= 生产 ref_text=None+Whisper 的语义),又免去
#     runtime 烘 Whisper / 触网 / 多占显存 / 首句变慢。新增音色 = 加一段 wav + 同名 txt,不改逻辑。
_VOICES_DIR = Path(__file__).resolve().parent / "assets" / "voices"
# 默认 voice key:未指定 / 未知 key 时回退(向后兼容 + fail-safe,不抛错中断整通)。
# male_std 与控制面固化默认 + 前端下拉框默认一致(全链路同一默认,避免"设男音却出女音")。
# 正常路径 voice 由控制面固化下发,这里只是"连 voice 都没传"的最底层兜底;可被 env AIM_TTS_VOICE 覆盖。
_VOICE_DEFAULT = os.getenv("AIM_TTS_VOICE", FUNASR_DEFAULTS["tts_voice"]).strip() or FUNASR_DEFAULTS["tts_voice"]
# 已知 voice key(给 server/session 校验用;真正可用性以 wav 文件存在为准)。
KNOWN_VOICE_KEYS = ("female_std", "male_std")


def _voice_key(voice: str | None) -> str:
    """归一 voice key:无对应 wav 文件时回退默认 key(fail-safe,不中断整通)。"""
    key = (voice or _VOICE_DEFAULT).strip() or _VOICE_DEFAULT
    if not (_VOICES_DIR / f"{key}.wav").is_file():
        key = _VOICE_DEFAULT
    return key


@lru_cache(maxsize=16)
def _voice_ref(voice: str | None, lang: str | None = None) -> tuple[str, str | None]:
    """(voice key, 语言) → (参考音 wav 路径, ref_text)。ref_text 取同名 sidecar .txt;缺失则 None
    (OmniVoice 回退自带 Whisper 转写——需镜像含 ASR 权重,否则会触网,故正常路径应有 sidecar)。

    ★ 语言维度(修「英文用中文声纹 → 口音重」根因):voice key 决定**性别/角色**,lang 决定**母语发音**。
      按 `<key>.<lang>.{wav,txt}` 优先选语言特化参考音(如 male_std.en.wav = 英文母语声纹),
      不存在则回退裸 `<key>.{wav,txt}`(裸文件名 = 默认 = 中文母语,现状语义不变、零破坏)。
      回退链:<key>.<lang>  →  <key>(裸=中文默认)  →(_voice_key 已保证 key 的裸 wav 存在)。
      lang 取会话语言的 2 字母前缀(en/ja/…);None 或找不到特化参考音 → 裸文件名。
    结果按 (voice, lang) 进程级缓存(txt 是小文件,免每句重读)。"""
    key = _voice_key(voice)
    # 语言特化参考音:<key>.<lang>.wav 存在则用(en 母语参考音修口音);否则回退裸 <key>.wav(默认=中文)。
    if lang:
        stem = lang_key(key, lang)  # "<key>.<lang>"(共享约定,与 MiniMax voice_map 键一致)
        cand_wav = _VOICES_DIR / f"{stem}.wav"
        if cand_wav.is_file():
            cand_txt = _VOICES_DIR / f"{stem}.txt"
            ref = cand_txt.read_text(encoding="utf-8").strip() if cand_txt.is_file() else None
            return str(cand_wav), (ref or None)
    wav = _VOICES_DIR / f"{key}.wav"
    txt = _VOICES_DIR / f"{key}.txt"
    ref_text = txt.read_text(encoding="utf-8").strip() if txt.is_file() else None
    return str(wav), (ref_text or None)


# 语言归一 / 逐句语种检测抽到共享 voice_lang(OmniVoice 与 MiniMax 共用,避免两处实现漂移)。
# 保留同名薄别名(_detect_text_lang re-export),便于既有测试/调用点按 funasr_backend 命名引用。
_tts_ref_lang = normalize_lang
from .voice_lang import detect_text_lang as _detect_text_lang  # noqa: E402,F401


def _device() -> str:
    return "cuda" if os.getenv("AIM_FORCE_CPU") != "1" else "cpu"


def _local_or_id(local_name: str, fallback_id: str) -> str:
    """优先用本地预下载目录(_FUNASR_MODELS/<name>),不存在则退回模型 id(在线解析)。
    照搬 deployment environment funasr_engine.py 同名逻辑 —— 避开 ModelScope 限流 + HF repo id 不一致。"""
    p = _FUNASR_MODELS / local_name
    return str(p) if p.is_dir() else fallback_id


# ── 模型权重 = 进程级单例(关键:review/用户 review)。──
# 数 GB 权重只加载一次、常驻显存;每通会话(每个 FunAsr 实例)只持有对这些共享模型的引用,
# 不重复加载。否则:① 每个 WS 连接重载数 GB → 首句延迟几十秒;② 并发 N 路 = 显存里 N 份模型 → OOM
# (GPU_SESSIONS_PER_INSTANCE 目标做不到)。lru_cache 线程安全;首次由 readiness self-probe 触发加载并焐热,
# 之后 WS 连接只在 ready 后进来(readyz 加载期 503),命中缓存即时返回。
# 共享模型的可重入性:generate() 只读权重(不改),会话状态全在外部传入的 cache 里,故多会话共享安全。
@lru_cache(maxsize=1)
def _stream_model():
    from funasr import AutoModel  # 重依赖,按需 import

    return AutoModel(
        model=_local_or_id("paraformer-zh-streaming", "paraformer-zh-streaming"),
        device=_device(), disable_update=True,
    )


@lru_cache(maxsize=1)
def _final_model():
    from funasr import AutoModel

    # fsmn-vad 也用本地预下载目录(ModelScope cache 结构);本地无则退回 id
    vad = _local_or_id_ms("speech_fsmn_vad_zh-cn-16k-common-pytorch", "fsmn-vad")
    return AutoModel(
        model=_local_or_id("SenseVoiceSmall", "iic/SenseVoiceSmall"),
        vad_model=vad, device=_device(), disable_update=True,
    )


def _local_or_id_ms(ms_dir_name: str, fallback_id: str) -> str:
    """fsmn-vad 等走 ModelScope 缓存结构(funasr/modelscope/iic/<name>)的本地路径解析。"""
    p = _MODEL_ROOT / "funasr" / "modelscope" / "iic" / ms_dir_name
    return str(p) if p.is_dir() else fallback_id


# ── CAM++ 声纹 embedding 模型 = 进程级单例(design contract),经 FunASR AutoModel 加载。──
# ModelScope iic/speech_campplus_sv_zh-cn_16k-common(7.18M 参数,192 维,Apache-2.0,200k Mandarin 训练)。
# 与 ASR/TTS 单例同构:@lru_cache(maxsize=1) 只加载一次、常驻;每次 embed 只做前向(只读权重),多会话共享安全。
# **不可每请求重载**(致命阻塞)。加载失败**不拖垮 /readyz**(声纹门是可 fail-open 附加能力,非核心 ASR/TTS)——
# CampplusEmbedder.embed 抛错 → server /embedding 返错误码 → bridge 侧 UNCERTAIN fail-open。
_CAMPPLUS_MS_DIR = "speech_campplus_sv_zh-cn_16k-common"


@lru_cache(maxsize=1)
def _campplus_model():
    """加载 CAM++ 说话人 embedding 模型 —— **经 FunASR AutoModel**(与 _stream_model/_final_model 同栈,
    依赖已满足;不走 modelscope.pipelines,后者会引入 GPU 镜像未安装的额外依赖,
    `No module named 'addict'` 加载失败)。本地权重优先(镜像烘,不触网);本地无则退回模型 id(仅本机开发兜底)。
    兼容的返回形态为 generate(input=wav) → r[0]['spk_embedding'] = 192 维 torch.Tensor。"""
    from funasr import AutoModel  # 重依赖,按需 import  # noqa: PLC0415

    model = _local_or_id_ms(_CAMPPLUS_MS_DIR, f"iic/{_CAMPPLUS_MS_DIR}")
    return AutoModel(model=model, device=_device(), disable_update=True)


class CampplusEmbedder:
    """真 CAM++ 声纹 embedder(design contract)—— 无状态:一段 16k mono s16le PCM → 192 维 embedding。

    模型来自进程级单例(_campplus_model,FunASR AutoModel);本类无会话状态,可多会话共享。产出维度必须 ==
    protocol.SPEAKER_EMBEDDING_DIM(bridge cosine 比对的单一事实源),不符则视为模型异常(上层 fail-open)。
    """

    def embed(self, pcm: bytes) -> list[float]:
        from .protocol import SPEAKER_EMBEDDING_DIM  # noqa: PLC0415

        n = len(pcm) // 2
        if n == 0:
            raise ValueError("embed:空音频")
        wav = np.frombuffer(pcm[: n * 2], dtype="<i2").astype(np.float32) / 32768.0
        # FunASR AutoModel:generate(input=wav) → [{'spk_embedding': Tensor[1,DIM] 或 [DIM]}](真机实测键名)。
        result = _campplus_model().generate(input=wav)
        emb = None
        if isinstance(result, list) and result and isinstance(result[0], dict):
            for key in ("spk_embedding", "embedding", "embs"):
                v = result[0].get(key)
                if v is not None:
                    arr = v.detach().cpu().numpy() if hasattr(v, "detach") else np.asarray(v)
                    emb = arr.reshape(-1)
                    break
        if emb is None:
            raise ValueError(f"CAM++ 未返回 embedding: {type(result)} {result[0].keys() if isinstance(result, list) and result and isinstance(result[0], dict) else ''}")
        vec = emb.astype(np.float32).reshape(-1)
        if vec.shape[0] != SPEAKER_EMBEDDING_DIM:
            raise ValueError(f"CAM++ embedding 维度 {vec.shape[0]} != 期望 {SPEAKER_EMBEDDING_DIM}")
        return vec.tolist()


class FunAsr:
    """FunASR 流式 ASR(paraformer-zh-streaming)+ SenseVoice finalize 复核。

    模型权重来自进程级单例(_stream_model/_final_model);本实例只持有引用 + **每会话独立**的
    流式 cache / 累积文本 / PCM 缓冲。故每通会话 new 一个 FunAsr 很轻(不重载模型)。
    """

    def __init__(self) -> None:
        self._stream = _stream_model()  # 共享单例(首次触发加载,之后命中缓存)
        self._final = _final_model()    # 共享单例
        self._cache: dict = {}          # ↓ 以下为每会话独立的可变状态
        self._stream_text = ""
        self._pcm_buf = bytearray()  # 累积本轮全部 PCM,供 finalize 高精度复核

    @staticmethod
    def _pcm_to_float(pcm: bytes) -> np.ndarray:
        return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0

    def transcribe_chunk(self, pcm: bytes) -> str | None:
        self._pcm_buf += pcm
        audio = self._pcm_to_float(pcm)
        if audio.size == 0:
            return None
        res = self._stream.generate(
            input=audio,
            cache=self._cache,
            is_final=False,
            chunk_size=_CHUNK_SIZE,
            encoder_chunk_look_back=_ENCODER_LOOKBACK,
            decoder_chunk_look_back=_DECODER_LOOKBACK,
        )
        if res and res[0].get("text"):
            self._stream_text += res[0]["text"]
        return self._stream_text or None

    def finalize(self, language: str | None = None) -> str:
        """一轮结束:用 SenseVoice 对整轮音频做高精度复核(带标点),回退到流式累积文本。

        language:**随会话 engine.language 走**(调用方传 zh/en/auto…);None 用 _ASR_DEFAULT_LANG。
        偏置正确语种避免 auto 在短句/噪声上误判(中文「闰年→软件/ど?」)、又不误伤英文(review)。
        复核后过低信息短文本(去标点 < _ASR_MIN_FINAL_CHARS 且不在一字答 allowlist)判为噪声/截断/IVR
        残片,返回空 → 上层不触发 LLM(不让 AI 对噪声/系统提示抢答),但合法一字答(对/嗯/好)放行(review)。"""
        lang = language or _ASR_DEFAULT_LANG
        text = self._stream_text
        if self._pcm_buf:
            try:
                audio = self._pcm_to_float(bytes(self._pcm_buf))
                res = self._final.generate(input=audio, language=lang, use_itn=True)
                if res and res[0].get("text"):
                    # SenseVoice 输出含 <|zh|> 等标签,取纯文本
                    text = _strip_sensevoice_tags(res[0]["text"])
            except Exception:  # noqa: BLE001
                pass  # 复核失败用流式文本兜底
        self.reset()
        # 短句门:去标点后太短 = 低信息(噪声/截断/单字幻听)→ 返回空;但常见一字答在 allowlist 内放行
        # (中文单字 + 英文单字母/yes-no,后者大小写不敏感 —— review:英文 Profile 单字符答复不再被误杀)。
        stripped = _strip_punct(text)
        if (
            _ASR_MIN_FINAL_CHARS > 0
            and len(stripped) < _ASR_MIN_FINAL_CHARS
            and stripped not in _SHORT_ALLOWLIST
            and stripped.lower() not in _SHORT_ALLOWLIST_EN
        ):
            return ""
        return text

    def reset(self) -> None:
        self._cache = {}
        self._stream_text = ""
        self._pcm_buf = bytearray()


def _strip_sensevoice_tags(text: str) -> str:
    import re

    return re.sub(r"<\|[^|]*\|>", "", text).strip()


def _strip_punct(text: str) -> str:
    """去标点/空白后的有效字符(短句门用):中英文标点 + 空白都不算信息量。
    保留中日韩/字母/数字等实义字符,据其长度判断是否低信息短片段。"""
    import re

    return re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE)


# OmniVoice HF 权重的本地预下载目录(镜像 build 期从 S3 拉到此;from_pretrained 用本地路径不触网)。
_OMNIVOICE_LOCAL = _MODEL_ROOT / "omnivoice" / "hf-snapshot"


@lru_cache(maxsize=1)
def _tts_engine():
    """TTS 引擎 = 进程级单例(真 OmniVoice;同 ASR:数 GB 权重只加载一次,常驻;多会话共享)。
    照搬 deployment environment omnivoice_engine.ensure_model():OmniVoice.from_pretrained + float16。
    TTS 推理无会话状态(每次 generate(text) 独立),故引擎对象可完全共享,无需每会话重建。"""
    import torch  # DLC 已装
    from omnivoice import OmniVoice  # 源码纳入镜像(gpu/vendor/omnivoice → PYTHONPATH)

    # 本地预下载在就用本地路径,否则退回 HF model id(在线,慢/可能限流)
    model_ref = str(_OMNIVOICE_LOCAL) if _OMNIVOICE_LOCAL.is_dir() else os.getenv("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
    device_map = "cuda:0" if os.getenv("AIM_FORCE_CPU") != "1" else "cpu"
    return OmniVoice.from_pretrained(model_ref, device_map=device_map, dtype=torch.float16)


# ── TTS 韵律稳定性(语气平稳)──:OmniVoice 是 flow-matching/diffusion 类 TTS,语调/节奏由采样参数控制。
# voice clone 只锁**声纹**,锁不住**韵律温度** → 默认 position_temperature=5.0 偏高,每句语调起伏随机大,
# 听感「语气变化多/不平稳」(真机反馈 deployment validation)。这里下调韵律温度 + 提高 CFG 引导,让整场语气更平稳:
#   - position_temperature 5.0→3.0:韵律/位置采样温度,↓ = 语调起伏小、更平稳(主旋钮)。
#   - guidance_scale 2.0→2.5:CFG 引导强度,↑ = 更贴参考音稳定风格、少自由发挥。
# 其余字段(num_step/t_shift/class_temperature=0…)保 OmniVoice 默认不动(num_step 影响延迟,勿轻调)。
# env 可调真机标定;留空/非法 → 用此处默认(中度,真机首验值)。仅 three_stage 的 gpu_omnivoice 段生效。
_TTS_POSITION_TEMPERATURE = float(os.getenv("AIM_TTS_POSITION_TEMPERATURE", str(FUNASR_DEFAULTS["tts_position_temperature"])))
_TTS_GUIDANCE_SCALE = float(os.getenv("AIM_TTS_GUIDANCE_SCALE", str(FUNASR_DEFAULTS["tts_guidance_scale"])))


@lru_cache(maxsize=1)
def _tts_generation_config():
    """OmniVoice 韵律稳定性配置 = 进程级单例(只构一次)。下调 position_temperature + 提高 guidance_scale
    压住「语气逐句飘」。OmniVoiceGenerationConfig 仅 GPU 容器内可 import,故惰性构建。
    构建/字段不可用(包升级改名)时回退 None(用引擎默认),不因调参崩整场 TTS(降级而非失败)。"""
    try:
        from omnivoice.models.omnivoice import OmniVoiceGenerationConfig
        return OmniVoiceGenerationConfig(
            position_temperature=_TTS_POSITION_TEMPERATURE,
            guidance_scale=_TTS_GUIDANCE_SCALE,
        )
    except Exception as e:  # 包结构变更/字段改名 → 降级用引擎默认(不崩)
        print(f"[tts] generation_config 构建失败,回退引擎默认: {e}")
        return None


@lru_cache(maxsize=8)
def _voice_clone_prompt(voice_wav: str, ref_text: str | None):
    """(参考音 wav, ref_text)→ 可复用的 VoiceClonePrompt = 进程级单例(按二者缓存)。
    create_voice_clone_prompt 要跑音频 tokenizer 编码整段参考音(数百 ms),**只算一次**:
    之后每句 generate(voice_clone_prompt=) 复用 → 跨句/跨轮同一声纹,不重复编码。
    多会话共享安全(只读 prompt + 共享只读权重,会话态全在 generate 内部,无副作用)。"""
    prompt = _tts_engine().create_voice_clone_prompt(
        ref_audio=voice_wav, ref_text=ref_text,
    )
    _warm_voice_clone_prompts.add((voice_wav, ref_text))
    return prompt


_warm_voice_clone_prompts: set[tuple[str, str | None]] = set()


class OmniVoiceTts:
    """真 OmniVoice TTS(k2-fsa/OmniVoice,24kHz,float32→s16le)。

    ★ 音色 = voice clone 模式(始终用参考音,修「instruct/voice design 仍句间漂移」根因):
      - voice design(instruct="女,青年,中音调")只锁**风格类别**,同类内具体声纹仍逐句独立随机采样
        → 句间「同是青年女声但不是同一个人」的漂移,固定 seed 也压不住(每句文本/采样路径不同)。
      - voice clone(generate(voice_clone_prompt=同一段参考音))**锁声纹**:每句从同一参考音克隆 →
        跨句、跨轮、整场完全一致。参考音 wav 由部署者在本地提供(assets/voices/),按 voice key 选(male_std/
        female_std,见 _voice_ref)。VoiceClonePrompt 进程级缓存(_voice_clone_prompt),只编码一次。

    ★ 参考音语言维度(修「英文用中文声纹 → 口音重」根因):参考音是「谁的嗓子 + 什么发音习惯」,
      中文母语参考音念英文必带中式口音。按会话 language 选语言特化参考音(<key>.<lang>.wav):
      具体语言(en/zh…)整场固定;'auto'(跟随题目语言)则**逐句**按文本 CJK/拉丁占比检测选中/英
      参考音(_detect_text_lang)—— 两个语言的 clone prompt 都进程级缓存,逐句切换零编码成本。
      无对应语言参考音则回退裸 <key>.wav(=中文默认),现状语义不变。

    引擎来自进程级单例(_tts_engine);每会话 new 一个 OmniVoiceTts 只是薄包装,不重载权重/不重编码参考音。
    """

    FRAME_MS = 20
    telemetry_provider = "gpu_omnivoice"

    def __init__(self, voice: str | None = None, language: str | None = None) -> None:
        self._engine = _tts_engine()  # 共享单例(真 OmniVoice)
        self._voice = voice
        # 参考音语言模式(修英文口音根因):具体语言(en/zh…)→ 整场固定该语言参考音;
        # 'auto' → synthesize 时逐句按文本检测(_detect_text_lang);None → 裸文件名(默认中文)。
        self._ref_lang = _tts_ref_lang(language)

    def _clone_prompt_for(self, text: str):
        """据参考音语言模式解析本句的 voice clone prompt(进程级缓存,同一 (voice,lang) 只编码一次)。
        auto 逐句检测该句语言选中/英参考音;非 auto 用整场固定语言(共享 resolve_lang_for_text)。"""
        lang = resolve_lang_for_text(self._ref_lang, text)
        voice_wav, ref_text = _voice_ref(self._voice, lang)  # (voice,lang) 缓存
        return _voice_clone_prompt(voice_wav, ref_text)  # (wav,ref_text) 缓存

    def telemetry_cache_state(self, text: str) -> str:
        """readiness 会焐热常用 prompt；只读 key 集合，不能为观测提前执行昂贵编码。"""
        lang = resolve_lang_for_text(self._ref_lang, text)
        key = _voice_ref(self._voice, lang)
        return "warm" if key in _warm_voice_clone_prompts else "cold"

    def synthesize(self, text: str):
        if not text or not text.strip():
            return
        clone_prompt = self._clone_prompt_for(text.strip())  # 进程级缓存,只编码一次
        # 韵律稳定性配置(语气平稳,见 _tts_generation_config):None(构建失败)→ 不传,用引擎默认。
        gen_cfg = _tts_generation_config()
        gen_kwargs = {"generation_config": gen_cfg} if gen_cfg is not None else {}
        audios = self._engine.generate(text=text.strip(), voice_clone_prompt=clone_prompt, **gen_kwargs)
        if not audios or audios[0] is None or len(np.asarray(audios[0])) == 0:
            raise RuntimeError(f"OmniVoice 返回空结果: {text!r}")
        wav = np.asarray(audios[0], dtype=np.float32).reshape(-1)
        # OmniVoice 原生 24kHz(= TTS_SAMPLE_RATE);若引擎采样率不同则重采样兜底
        sr = int(getattr(self._engine, "sampling_rate", TTS_SAMPLE_RATE) or TTS_SAMPLE_RATE)
        if sr != TTS_SAMPLE_RATE:
            wav = _resample(wav, sr, TTS_SAMPLE_RATE)
        pcm = (np.clip(wav, -1, 1) * 32767).astype("<i2").tobytes()
        frame = TTS_SAMPLE_RATE * self.FRAME_MS // 1000 * 2  # bytes/frame
        for i in range(0, len(pcm), frame):
            yield pcm[i : i + frame]


def _resample(wav: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst:
        return wav
    n = int(len(wav) * dst / src)
    return np.interp(np.linspace(0, len(wav), n, endpoint=False), np.arange(len(wav)), wav).astype(np.float32)


def pcm_to_wav_bytes(pcm: bytes, sample_rate: int = ASR_SAMPLE_RATE) -> bytes:
    """工具:裸 PCM(s16le mono)→ WAV 字节,供 e2e 落盘/调试。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()
