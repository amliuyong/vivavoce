"""GPU 运行时配置 registry(design contract)—— 把散落各模块的 ``AIM_*`` env 读取归拢为
**单一 typed effective-config 快照**,业务逻辑与只读 ``GET /config`` 端点**共读同一份**。

铁律(与 bridge 侧 ``runtime-config.ts`` 同款,理由亦同)
--------------------------------------------------------
每个条目的 ``default`` MUST 来自**该配置源模块的导出常量**,MUST NOT 在本文件以字面量重新声明。

为什么(实测,非洁癖):bridge 侧首轮用「registry 内手抄字面量」的做法,机械全量比对实测
**手抄的 50 项里 23 项与源码不符(46%)**,最严重差 75 倍;而同文件内 ``import`` 源模块默认值的
36 项**零错误**,且全套单测同时为绿(断言校验的是 registry 自己声明的默认值)。根因是**架构**
——默认值存在第二份可写副本。故让手抄在物理上不可能,并由 pytest 守门。

依赖方向(不成环)
------------------
``vad`` / ``funasr_backend`` / ``session`` / ``task_protection`` / ``engines`` 等各自持有
``*_DEFAULTS``;本模块 import 它们。**它们 MUST NOT import 本模块**(有测试守门)——否则
``server.py`` 的加载顺序会决定快照是否为空。

排除项(见 ``EXCLUDED_KEYS``)
-----------------------------
* **凭据**:``AIM_DRAIN_SECRET`` / ``AIM_EMBEDDING_SECRET`` —— **完全不进载荷**(不是脱敏,
  是根本不出现)。控制面的脱敏保护不了本端点自身的调用者。
* **MiniMax Secret-backed provider 字段**:生产走 Secret 热加载快照,env 仅无 Secret 时的本地
  fallback,展示 env 会**冒充生效值**;归 design contract ``TtsSettings.tsx``。
  ⚠ 但 ``AIM_MINIMAX_FALLBACK_COOLDOWN_S`` / ``AIM_MINIMAX_STARTUP_PROBE`` **无任何 GUI**,
  是真正的无 GUI 运营开关 → **纳入**(review 实证纠正)。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal

# ── 各源模块的默认值(单一事实源;本文件只 import,不重抄)──
from . import engines as _engines
from . import funasr_backend as _funasr
from . import session as _session
from . import task_protection as _task_protection
from . import vad as _vad

#: 响应 schema 版本。**破坏性改 entries 结构时 MUST +1**,控制面据此判兼容性。
CONFIG_SCHEMA_VERSION = 1

OverrideState = Literal["absent", "valid", "ignored_invalid"]


@dataclass(frozen=True)
class ConfigEntry:
    """单个开关的生效值 + 内建默认 + env 覆盖状态。"""

    key: str
    value: Any
    default: Any
    #: 三态(design contract):``absent`` 未设 / ``valid`` 设了且被接受 / ``ignored_invalid`` 设了但被丢弃。
    #: 二值 ``from_env`` 分不清「没设」与「设了但被丢弃」,而后者正是运维最需看见的错配信号。
    override_state: OverrideState

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "value": self.value,
            "default": self.default,
            "override_state": self.override_state,
        }


#: 明确**不**纳入只读总览的 ``AIM_*``(凭据 / Secret-backed provider 字段 / 寻址)。
#: 枚举完整性守门用它判「源码里出现但既未登记也未排除」= 漏登记。
EXCLUDED_KEYS: tuple[str, ...] = (
    # 凭据:MUST NOT 进载荷(不是脱敏,是不出现)
    "AIM_DRAIN_SECRET",
    "AIM_EMBEDDING_SECRET",
    # MiniMax Secret-backed provider 字段(归 design contract TtsSettings;env 仅本地 fallback)
    "AIM_MINIMAX_API_KEY",
    "AIM_MINIMAX_BASE_URL",
    "AIM_MINIMAX_MODEL",
    "AIM_MINIMAX_ENABLED",
    "AIM_MINIMAX_SECRET_ID",
    # 构建/部署元数据(非"可调开关"):只用于 /config 的实例标识,标明"这台跑的哪个镜像"
    "AIM_GPU_IMAGE_TAG",
)


def _is_set(key: str) -> bool:
    """env 是否被**显式设置**(空串 / 纯空白视作未设,与各解析口径一致)。"""
    raw = os.getenv(key)
    return raw is not None and raw.strip() != ""


def _override_state(key: str, value: Any, default: Any) -> OverrideState:
    """判三态。

    ``ignored_invalid`` 判据 = 设了 env 但生效值仍等于内建默认 → 说明被解析器丢弃。
    存在**假阴性**:显式设成恰好等于默认值时判 ``valid``(此时行为与默认一致,无需提示)。
    """
    if not _is_set(key):
        return "absent"
    return "ignored_invalid" if value == default else "valid"


# ── 各族解析器:逐字沿用源模块口径(勿"顺手统一") ──


def _int_env(key: str, default: int) -> int:
    """``int(os.getenv(k, "d"))`` 口径:非法值会抛 ValueError —— 与源模块一致(fail-fast)。"""
    raw = os.getenv(key)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def _log_level_env(key: str, default: str) -> str:
    """``AIM_GPU_LOG_LEVEL`` 专用口径 —— MUST 与 ``server.py::_configure_logging`` 逐字节一致。

    业务侧是 ``getattr(logging, raw.upper(), logging.INFO)``:**非法名静默回退 INFO**
    (不是原样透传、也不是抛错)。若此处用通用 ``_str_env`` 原样透传,``AIM_GPU_LOG_LEVEL=bogus``
    时端点会报 ``'bogus'`` 且标 ``valid``,而业务实际用 ``INFO`` —— 页面在撒谎
    (review 实证)。

    ⚠ 这是**唯一**需要专用口径的 GPU server key:布尔两处口径(``in ("1","true","True")``)与
    int 类(裸 ``int()`` fail-fast 抛错)经逐 key 实测**本就与业务一致**,不必也不应改动。
    """
    import logging as _logging

    raw = os.getenv(key)
    if raw is None or raw.strip() == "":
        return default
    resolved = getattr(_logging, raw.upper(), None)
    # 非 int 的 logging 属性(如 logging.warn 函数)不算合法级别
    if not isinstance(resolved, int):
        return default
    # ★ 回**归一后的规范名**而非 env 原值:`WARN` 与 `WARNING` 是同一 level(都是 30),
    #   业务 logger 上挂的是数值 30 → 规范名 `WARNING`。本页的意义是「报告业务实际在用的那一份」,
    #   故报归一名(否则 env 写 `warn` 时页面显示 `WARN`,与 logger 自述的级别名不一致)。
    return _logging.getLevelName(resolved)


def _float_env(key: str, default: float) -> float:
    raw = os.getenv(key)
    if raw is None or raw.strip() == "":
        return default
    return float(raw)


def _str_env(key: str, default: str) -> str:
    raw = os.getenv(key)
    return default if raw is None or raw.strip() == "" else raw


def _bool_truthy(key: str) -> bool:
    """``in ("1","true","True")`` 口径(GPU 侧 ``AIM_MINIMAX_STARTUP_PROBE`` / ``AIM_PROTECT_FAIL_CLOSED``)。

    ⚠ 与 ``== "1"`` 口径**不同**,MUST NOT 混用:AIM 期曾统一布尔口径,致
    ``AIM_FORCE_CPU=true`` 把 GPU 服务静默切 CPU(源码口径是 ``!= "1"``),评为 Critical。
    """
    return os.getenv(key, "") in ("1", "true", "True")


def _bool_eq_one(key: str) -> bool:
    """``== "1"`` 口径(``AIM_VAD_DEBUG``)。"""
    return os.getenv(key, "") == "1"


def _force_cpu() -> bool:
    """``AIM_FORCE_CPU != "1"`` → cuda(即唯 ``"1"`` 才 CPU)。

    ⚠ 这是**唯 "1" 生效**的口径:``AIM_FORCE_CPU=true`` **不**会切 CPU。如实呈现,勿"修正"。
    """
    return os.getenv("AIM_FORCE_CPU") == "1"


def load_gpu_config() -> list[ConfigEntry]:
    """产出全部**可调** ``AIM_*`` 的 ``ConfigEntry``(default 一律来自源模块导出)。

    MUST 只读、无副作用:**不触发模型加载**、**不改 readiness**、**不新增 boto3/DDB/Bedrock 调用**
    (GPU task role 红线:无 DDB、无 Bedrock)。
    """
    vd = _vad.VAD_DEFAULTS
    fd = _funasr.FUNASR_DEFAULTS
    sd = _session.SESSION_DEFAULTS
    td = _task_protection.TASK_PROTECTION_DEFAULTS
    ed = _engines.ENGINES_DEFAULTS
    gd = GPU_SERVER_DEFAULTS

    def e(key: str, value: Any, default: Any) -> ConfigEntry:
        return ConfigEntry(key, value, default, _override_state(key, value, default))

    return [
        # ── VAD(尾静音判轮;bridge 侧的 endpoint 阈值 MUST ≥ 此,跨面不变式)──
        e("AIM_VAD_ENERGY_THRESHOLD",
          _float_env("AIM_VAD_ENERGY_THRESHOLD", vd["energy_threshold"]), vd["energy_threshold"]),
        e("AIM_VAD_HANGOVER_MS",
          _int_env("AIM_VAD_HANGOVER_MS", vd["hangover_ms"]), vd["hangover_ms"]),
        e("AIM_VAD_MIN_SPEECH_MS",
          _int_env("AIM_VAD_MIN_SPEECH_MS", vd["min_speech_ms"]), vd["min_speech_ms"]),
        e("AIM_VAD_DEBUG", _bool_eq_one("AIM_VAD_DEBUG"), sd["vad_debug"]),
        # ── ASR ──
        e("AIM_ASR_FINAL_LANGUAGE",
          _str_env("AIM_ASR_FINAL_LANGUAGE", fd["asr_final_language"]), fd["asr_final_language"]),
        e("AIM_ASR_MIN_FINAL_CHARS",
          _int_env("AIM_ASR_MIN_FINAL_CHARS", fd["asr_min_final_chars"]), fd["asr_min_final_chars"]),
        # 短词白名单:env 是**追加项**(与内建集合并),默认空串
        e("AIM_ASR_SHORT_ALLOWLIST",
          _str_env("AIM_ASR_SHORT_ALLOWLIST", fd["asr_short_allowlist"]), fd["asr_short_allowlist"]),
        e("AIM_ASR_SHORT_ALLOWLIST_EN",
          _str_env("AIM_ASR_SHORT_ALLOWLIST_EN", fd["asr_short_allowlist_en"]),
          fd["asr_short_allowlist_en"]),
        # ── TTS 韵律 / 音色 ──
        e("AIM_TTS_VOICE", _str_env("AIM_TTS_VOICE", fd["tts_voice"]), fd["tts_voice"]),
        e("AIM_TTS_POSITION_TEMPERATURE",
          _float_env("AIM_TTS_POSITION_TEMPERATURE", fd["tts_position_temperature"]),
          fd["tts_position_temperature"]),
        e("AIM_TTS_GUIDANCE_SCALE",
          _float_env("AIM_TTS_GUIDANCE_SCALE", fd["tts_guidance_scale"]), fd["tts_guidance_scale"]),
        # ── 后端 / 模型 / 设备 ──
        e("AIM_GPU_BACKEND", _str_env("AIM_GPU_BACKEND", ed["backend"]), ed["backend"]),
        e("AIM_MODEL_ROOT", _str_env("AIM_MODEL_ROOT", fd["model_root"]), fd["model_root"]),
        # 唯 "1" 才 CPU("true" 不生效,如实呈现)
        e("AIM_FORCE_CPU", _force_cpu(), fd["force_cpu"]),
        e("AIM_GPU_LOG_LEVEL", _log_level_env("AIM_GPU_LOG_LEVEL", gd["log_level"]), gd["log_level"]),
        # ── 容量 / drain / task protection(design contract 管可写期望值,此处只读 env 护栏)──
        e("AIM_GPU_MAX_SESSIONS",
          _int_env("AIM_GPU_MAX_SESSIONS", gd["max_sessions"]), gd["max_sessions"]),
        e("AIM_GPU_MAX_DRAIN_MIN",
          _int_env("AIM_GPU_MAX_DRAIN_MIN", td["max_drain_min"]), td["max_drain_min"]),
        e("AIM_GPU_PROTECT_RENEW_MIN",
          max(1, _int_env("AIM_GPU_PROTECT_RENEW_MIN", gd["protect_renew_min"])),
          gd["protect_renew_min"]),
        e("AIM_PROTECT_FAIL_CLOSED",
          _bool_truthy("AIM_PROTECT_FAIL_CLOSED"), gd["protect_fail_closed"]),
        # ── 声纹 embedding(design contract;secret 本身在 EXCLUDED_KEYS)──
        e("AIM_EMBEDDING_MAX_INFLIGHT",
          _int_env("AIM_EMBEDDING_MAX_INFLIGHT", gd["embedding_max_inflight"]),
          gd["embedding_max_inflight"]),
        e("AIM_EMBEDDING_MIN_MS",
          _int_env("AIM_EMBEDDING_MIN_MS", gd["embedding_min_ms"]), gd["embedding_min_ms"]),
        # ── MiniMax **运营**开关(非 Secret-backed,无 GUI → 纳入;review)──
        e("AIM_MINIMAX_FALLBACK_COOLDOWN_S",
          _float_env("AIM_MINIMAX_FALLBACK_COOLDOWN_S", ed["minimax_fallback_cooldown_s"]),
          ed["minimax_fallback_cooldown_s"]),
        e("AIM_MINIMAX_STARTUP_PROBE",
          _bool_truthy("AIM_MINIMAX_STARTUP_PROBE"), gd["minimax_startup_probe"]),
    ]


#: ``server.py`` 自身直读的那几个 env 的默认值(单一事实源;server.py MUST 引用本常量)。
GPU_SERVER_DEFAULTS: dict[str, Any] = {
    "log_level": "INFO",
    "max_sessions": 3,
    "protect_renew_min": 10,
    "protect_fail_closed": False,
    "embedding_max_inflight": 2,
    "embedding_min_ms": 400,
    "minimax_startup_probe": False,
}

# ── 进程级冻结快照(design contract;review)────────────────────────────────────
#
# ⚠ **为什么必须冻结**:业务模块(``vad`` / ``funasr_backend`` / ``session`` / ``task_protection``)
# 的 env 解析发生在**模块导入时**(如 ``vad._DEF_HANGOVER``),之后再改 env 对业务**无效**。
# 若 ``/config`` 每次请求重解析,就会报出业务**并未在用**的值 —— 实证:
#
# ```
# 设 AIM_VAD_HANGOVER_MS=1234 后请求 → /config 报 1234
# 业务实际在用(vad._DEF_HANGOVER)  → 800      ← 页面在撒谎
# ```
#
# 这恰好违背本页存在的唯一理由(报告业务实际在用的那一份)。故在**首次导入本模块时**冻结一次,
# 端点只读该快照。测试需不同快照时用 ``importlib.reload`` 或直接调 ``load_gpu_config()``。
_FROZEN_SNAPSHOT: list[ConfigEntry] = load_gpu_config()


def get_frozen_config() -> list[ConfigEntry]:
    """返回**进程级冻结**的配置快照(``/config`` 端点 MUST 用这个,不用 ``load_gpu_config()``)。"""
    return _FROZEN_SNAPSHOT


#: 全部登记的可调 key(守门测试据此比对枚举完整性)。
TUNABLE_KEYS: tuple[str, ...] = tuple(e.key for e in _FROZEN_SNAPSHOT)
