"""MiniMax TTS 配置(design contract)—— 进程级单一来源 + 运行时原子热加载。

设计(design contract「配置变更运行时热加载,免重启 GPU」):
  - **单一来源**:全部 MiniMax 配置(API key + 非密参数)装在**一个 Secret 的 JSON** 里。GPU 启动读一次,
    运行时可经 /reload-tts-config 重读(见 server.py)。env `AIM_MINIMAX_SECRET_ID` 指向 Secret;
    缺省(本地/CI 无 AWS)回退 env 变量,便于无 Secrets Manager 自测。
  - **原子替换**:重载用 module-level holder + 锁原子替换配置引用 —— 新会话读到新配置,**在途会话不受影响**
    (会话起始 make_tts(minimax) 即 snapshot 当时配置,整场不变)。
  - GPU task role 只读该 Secret,**无 DDB、无 Bedrock**(014/002 红线不破)。

凭据/voice_id 映射 **不逐通下发**(不进 Bridge /dial body 或 GPU start 帧);GPU 直读 Secret。
"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# ── 默认值(与 backend admin_tts / design contract 契约对齐)──
# 完整 endpoint URL(切备用域名 api-bj.minimaxi.com / 灰度即整串替换 base_url,而非仅域名段)。
DEFAULT_BASE_URL = "https://api.minimaxi.com/v1/t2a_v2"
DEFAULT_MODEL = "speech-2.8-turbo"
DEFAULT_TIMEOUT_S = 5.0  # urllib connect+read 短超时:封顶不可断窗口/线程占用,超时即抛错走降级
DEFAULT_LANGUAGE_BOOST = "Chinese"
# 语义 voice key → MiniMax system voice_id(已实际程序验证可正常合成;Antie 是厂商官方拼写,勿"修正"为 Auntie)。
# 默认 male_std,与控制面固化默认 + OmniVoice fallback + 前端下拉框默认一致(全链路同一默认)。
#
# ★ 语言维度(修「英文用中文音色 → 口音重」根因,与 OmniVoice 参考音同一套 "<key>.<lang>" 约定):
#   裸 key(male_std/female_std)= 默认中文音色;"<key>.<lang>"(male_std.en…)= 该语言母语音色。
#   会话 language=en 或 auto 逐句判为英文时,voice_id_for 优先取 "<key>.en" 的英文 system voice
#   (英文母语音色本就地道,无需 clone);无对应语言键则回退裸 key(中文),现状语义不变。
#   英文默认音色与 OmniVoice 英文参考音选型对齐(gen_reference_voice.EN_VOICE_BY_KEY):
#     male_std.en → English_Trustworth_Man;female_std.en → English_Graceful_Lady。
DEFAULT_VOICE_KEY = "male_std"
DEFAULT_VOICE_MAP: dict[str, str] = {
    "male_std": "Chinese (Mandarin)_Gentleman",
    "female_std": "Chinese (Mandarin)_Kind-hearted_Antie",
    "male_std.en": "English_Trustworth_Man",
    "female_std.en": "English_Graceful_Lady",
}
# 语言 → MiniMax language_boost(据本句实际语言逐句设,提升该语种发音质量)。默认 Chinese。
LANGUAGE_BOOST_BY_LANG: dict[str, str] = {"en": "English", "zh": "Chinese"}


@dataclass(frozen=True)
class MiniMaxConfig:
    """一份 MiniMax 运行配置快照(不可变;热加载靠整体替换引用,保证在途会话不被半更新)。"""

    enabled: bool = False
    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    api_key: str = ""
    voice_map: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_VOICE_MAP))
    timeout_s: float = DEFAULT_TIMEOUT_S
    language_boost: str = DEFAULT_LANGUAGE_BOOST

    @property
    def has_key(self) -> bool:
        return bool(self.api_key)

    def voice_id_for(self, voice: str | None, lang: str | None = None) -> str:
        """(语义 voice key, 语言) → MiniMax voice_id(系统级全局映射)。
        lang 非空且配了 "<key>.<lang>" 键 → 用该语言母语音色(修英文口音);否则回退裸 key(中文默认);
        未知/缺省 key 再 fail-safe 回退默认 voice_id(默认 male_std),不中断整通(design contract)。"""
        from .voice_lang import lang_key  # noqa: PLC0415 — 避免模块级循环,轻量导入

        key = (voice or DEFAULT_VOICE_KEY).strip() or DEFAULT_VOICE_KEY
        # 先试语言特化键(male_std.en…),命中即用英文音色;否则回退裸 key(中文)。
        if lang:
            vid = self.voice_map.get(lang_key(key, lang))
            if vid:
                return vid
        vid = self.voice_map.get(key)
        if vid:
            return vid
        return (
            self.voice_map.get(DEFAULT_VOICE_KEY)
            or DEFAULT_VOICE_MAP.get(DEFAULT_VOICE_KEY, "")
        )

    def boost_for(self, lang: str | None) -> str:
        """语言 → language_boost(逐句)。lang 有明确映射用之(en→English);否则用配置的 language_boost 默认。"""
        return LANGUAGE_BOOST_BY_LANG.get(lang or "", self.language_boost)


def _coerce(raw: dict) -> MiniMaxConfig:
    """把 Secret/env 来的原始 dict 归一成 MiniMaxConfig(缺字段回退默认,坏类型容错)。"""
    vm = raw.get("voice_map")
    voice_map = dict(DEFAULT_VOICE_MAP)
    if isinstance(vm, dict):
        # 只接受字符串→字符串映射;空值忽略(回退默认)
        for k, v in vm.items():
            if isinstance(k, str) and isinstance(v, str) and v.strip():
                voice_map[k] = v
    try:
        timeout_s = float(raw.get("timeout_s", DEFAULT_TIMEOUT_S))
        if not (0 < timeout_s <= 60):
            timeout_s = DEFAULT_TIMEOUT_S
    except (TypeError, ValueError):
        timeout_s = DEFAULT_TIMEOUT_S
    base_url = raw.get("base_url") or DEFAULT_BASE_URL
    model = raw.get("model") or DEFAULT_MODEL
    language_boost = raw.get("language_boost") or DEFAULT_LANGUAGE_BOOST
    return MiniMaxConfig(
        enabled=bool(raw.get("enabled", False)),
        base_url=str(base_url),
        model=str(model),
        api_key=str(raw.get("api_key") or ""),
        voice_map=voice_map,
        timeout_s=timeout_s,
        language_boost=str(language_boost),
    )


def _load_raw_from_secret(secret_id: str) -> dict:
    """从 Secrets Manager 读单一 Secret 的 JSON。失败 → 空(fail-safe:enabled=false,不崩 GPU)。"""
    try:
        import boto3  # noqa: PLC0415

        client = boto3.client("secretsmanager", region_name=os.getenv("AWS_REGION") or None)
        resp = client.get_secret_value(SecretId=secret_id)
        body = resp.get("SecretString") or "{}"
        obj = json.loads(body)
        return obj if isinstance(obj, dict) else {}
    except Exception as exc:  # noqa: BLE001 — 读 Secret 失败不应崩 GPU(minimax 不可用,OmniVoice 仍服务)
        logger.warning("读 MiniMax Secret(%s)失败: %s —— MiniMax 暂不可用(OmniVoice 不受影响)", secret_id, exc)
        return {}


def _load_raw_from_env() -> dict:
    """本地/CI 无 Secret 时的回退:从 env 拼配置(便于无 Secrets Manager 自测)。"""
    return {
        "enabled": os.getenv("AIM_MINIMAX_ENABLED", "") in ("1", "true", "True"),
        "base_url": os.getenv("AIM_MINIMAX_BASE_URL") or DEFAULT_BASE_URL,
        "model": os.getenv("AIM_MINIMAX_MODEL") or DEFAULT_MODEL,
        "api_key": os.getenv("AIM_MINIMAX_API_KEY") or "",
    }


def _load_from_source() -> MiniMaxConfig:
    secret_id = os.getenv("AIM_MINIMAX_SECRET_ID", "").strip()
    raw = _load_raw_from_secret(secret_id) if secret_id else _load_raw_from_env()
    return _coerce(raw)


# ── 进程级 holder(原子替换)──
_lock = threading.Lock()
_current: MiniMaxConfig | None = None


def get_minimax_config() -> MiniMaxConfig:
    """取当前 MiniMax 配置。会话起始 snapshot 此值,整场不变(在途不受热加载影响)。

    ★ 不在 _lock 内做网络 I/O(review:此前首个 minimax 会话在事件循环上同步、持锁、无超时读
      Secret → SM 抖动时冻结整个 GPU 异步服务、阻塞所有并发会话)。正常路径靠 lifespan 的
      `preload_minimax_config()` 在启动时(后台线程)预热好 `_current`,这里直接命中、无 I/O。
      万一未预热(防御),才惰性加载,且**在锁外**读源(读 Secret 有 boto3 默认超时),仅赋值持锁。"""
    global _current
    with _lock:
        if _current is not None:
            return _current
    # 锁外读源(避免持锁做网络 I/O);并发首读最多各读一次,double-check 后只保留一份。
    cfg = _load_from_source()
    with _lock:
        if _current is None:
            _current = cfg
        return _current


def preload_minimax_config() -> MiniMaxConfig:
    """启动预热:在 lifespan 的后台加载线程里调用一次,把 `_current` 焐热。

    避免首个 minimax 会话在 WS 事件循环上触发同步 Secret 读。等价于一次 reload(读源 + 原子替换)。"""
    return reload_minimax_config()


def reload_minimax_config() -> MiniMaxConfig:
    """重读 Secret + 原子替换进程内配置引用(热加载,design contract)。返回新配置。
    替换是引用整体替换 → 已 snapshot 旧配置的在途会话不受影响(MUST NOT 半更新)。"""
    global _current
    cfg = _load_from_source()
    with _lock:
        _current = cfg
    logger.info("MiniMax 配置已热加载(enabled=%s has_key=%s base_url=%s)",
                cfg.enabled, cfg.has_key, cfg.base_url)
    return cfg


def _reset_for_test() -> None:
    """测试钩子:清进程级 holder(下次 get 重新加载)。"""
    global _current
    with _lock:
        _current = None
