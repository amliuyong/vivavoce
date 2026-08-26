"""design contract —— GPU 只读 ``GET /config`` 端点 + 配置快照守门。

三层守门(与 bridge 侧同构,理由亦同):
  ① 鉴权 fail-closed:未配 503 / 缺头或错头 401 / 对头 200(沿用现网契约,**非** 403)
  ② 默认值零手抄:逐 key 断言 ``default`` === 源模块 ``*_DEFAULTS`` 导出
     (bridge 侧实测手抄 50 项里 23 项错 = 46%,故此处从一开始就机械守门)
  ③ task role 红线:``/config`` 不触发模型加载、不改 readiness、不新增 boto3 调用
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from gpu_service import runtime_config as rc
from gpu_service.engines import ENGINES_DEFAULTS
from gpu_service.funasr_backend import FUNASR_DEFAULTS
from gpu_service.server import create_app
from gpu_service.session import SESSION_DEFAULTS
from gpu_service.task_protection import TASK_PROTECTION_DEFAULTS
from gpu_service.vad import VAD_DEFAULTS

SECRET = "test-drain-secret"


@pytest.fixture
def with_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AIM_DRAIN_SECRET", SECRET)


@pytest.fixture
def client(with_secret: None) -> TestClient:
    return TestClient(create_app())


# ── ① 鉴权 fail-closed ──


def test_config_requires_secret_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """密钥未配置 → 503(端点禁用)。区分「没开功能」与「没权限」,便于运维定位。"""
    monkeypatch.delenv("AIM_DRAIN_SECRET", raising=False)
    c = TestClient(create_app())
    r = c.get("/config", headers={"X-Drain-Secret": "whatever"})
    assert r.status_code == 503
    # 拒绝路径不返回任何**配置数据**。
    # 注:503 文案**故意**点名 AIM_DRAIN_SECRET —— 那是给运维的「该配哪个 env」提示,
    #     只含 env **名**不含值,不构成泄漏(真正的泄漏面是 entries/值,见下)。
    assert "entries" not in r.text
    assert "schema_version" not in r.text
    for tunable in ("AIM_VAD_", "AIM_TTS_", "AIM_ASR_", "AIM_GPU_MAX"):
        assert tunable not in r.text


def test_config_rejects_missing_header(client: TestClient) -> None:
    r = client.get("/config")
    assert r.status_code == 401
    assert "AIM_" not in r.text


def test_config_rejects_wrong_header(client: TestClient) -> None:
    """错密钥 → 401(**非** 403,与现网 /drain·/reload-tts-config 一致)。"""
    r = client.get("/config", headers={"X-Drain-Secret": "wrong"})
    assert r.status_code == 401
    # 等长但不同,验证常量时间比对分支也拒
    r2 = client.get("/config", headers={"X-Drain-Secret": "x" * len(SECRET)})
    assert r2.status_code == 401


def test_config_accepts_correct_header(client: TestClient) -> None:
    r = client.get("/config", headers={"X-Drain-Secret": SECRET})
    assert r.status_code == 200
    body = r.json()
    assert body["schema_version"] == rc.CONFIG_SCHEMA_VERSION
    assert body["source"] == "gpu"
    assert isinstance(body["entries"], list) and body["entries"]


def test_shared_helper_unifies_three_endpoints(client: TestClient) -> None:
    """``/drain``、``/reload-tts-config``、``/config`` 三处鉴权姿态一致(共享 helper)。"""
    for method, path in [("post", "/drain?on=true"), ("post", "/reload-tts-config"), ("get", "/config")]:
        r = getattr(client, method)(path, headers={"X-Drain-Secret": "wrong"})
        assert r.status_code == 401, f"{path} 应 401"


# ── ② 默认值零手抄:逐 key 对源模块导出 ──

#: key → 该 key 的 default **应当等于**哪个源模块导出。
#: ⚠ 右值一律是**对导出的引用**,不是字面量 —— 若写字面量,本测试就退化成
#:   「registry 手抄 vs 测试手抄」的自我印证(bridge 侧 805 绿 + 23 项错的成因)。
EXPECTED_DEFAULTS: dict[str, object] = {
    "AIM_VAD_ENERGY_THRESHOLD": VAD_DEFAULTS["energy_threshold"],
    "AIM_VAD_HANGOVER_MS": VAD_DEFAULTS["hangover_ms"],
    "AIM_VAD_MIN_SPEECH_MS": VAD_DEFAULTS["min_speech_ms"],
    "AIM_VAD_DEBUG": SESSION_DEFAULTS["vad_debug"],
    "AIM_ASR_FINAL_LANGUAGE": FUNASR_DEFAULTS["asr_final_language"],
    "AIM_ASR_MIN_FINAL_CHARS": FUNASR_DEFAULTS["asr_min_final_chars"],
    "AIM_ASR_SHORT_ALLOWLIST": FUNASR_DEFAULTS["asr_short_allowlist"],
    "AIM_ASR_SHORT_ALLOWLIST_EN": FUNASR_DEFAULTS["asr_short_allowlist_en"],
    "AIM_TTS_VOICE": FUNASR_DEFAULTS["tts_voice"],
    "AIM_TTS_POSITION_TEMPERATURE": FUNASR_DEFAULTS["tts_position_temperature"],
    "AIM_TTS_GUIDANCE_SCALE": FUNASR_DEFAULTS["tts_guidance_scale"],
    "AIM_GPU_BACKEND": ENGINES_DEFAULTS["backend"],
    "AIM_MODEL_ROOT": FUNASR_DEFAULTS["model_root"],
    "AIM_FORCE_CPU": FUNASR_DEFAULTS["force_cpu"],
    "AIM_GPU_LOG_LEVEL": rc.GPU_SERVER_DEFAULTS["log_level"],
    "AIM_GPU_MAX_SESSIONS": rc.GPU_SERVER_DEFAULTS["max_sessions"],
    "AIM_GPU_MAX_DRAIN_MIN": TASK_PROTECTION_DEFAULTS["max_drain_min"],
    "AIM_GPU_PROTECT_RENEW_MIN": rc.GPU_SERVER_DEFAULTS["protect_renew_min"],
    "AIM_PROTECT_FAIL_CLOSED": rc.GPU_SERVER_DEFAULTS["protect_fail_closed"],
    "AIM_EMBEDDING_MAX_INFLIGHT": rc.GPU_SERVER_DEFAULTS["embedding_max_inflight"],
    "AIM_EMBEDDING_MIN_MS": rc.GPU_SERVER_DEFAULTS["embedding_min_ms"],
    "AIM_MINIMAX_FALLBACK_COOLDOWN_S": ENGINES_DEFAULTS["minimax_fallback_cooldown_s"],
    "AIM_MINIMAX_STARTUP_PROBE": rc.GPU_SERVER_DEFAULTS["minimax_startup_probe"],
}


def test_expected_table_covers_all_keys() -> None:
    """期望表覆盖全部登记 key(漏一个即红,防新增 key 不设守门)。"""
    assert set(EXPECTED_DEFAULTS) == set(rc.TUNABLE_KEYS)


@pytest.mark.parametrize("key", sorted(EXPECTED_DEFAULTS))
def test_default_comes_from_source_module(key: str) -> None:
    entry = next(e for e in rc.load_gpu_config() if e.key == key)
    assert entry.default == EXPECTED_DEFAULTS[key], f"{key} 的 default 未溯源到源模块导出"


def test_no_duplicate_or_missing_keys() -> None:
    keys = [e.key for e in rc.load_gpu_config()]
    assert len(keys) == len(set(keys)), "有重复 key"
    assert set(keys) == set(rc.TUNABLE_KEYS)


def test_enumeration_completeness() -> None:
    """源码里出现的 ``AIM_*`` 要么登记、要么排除(不许两头空)。

    防「新增开关漏登记」—— 这是 AIM 期 design contract 明确要求的守门。
    """
    import pathlib
    import re

    src = pathlib.Path(__file__).resolve().parent.parent / "gpu_service"
    found: set[str] = set()
    for f in src.glob("*.py"):
        if f.name == "runtime_config.py":
            continue
        text = f.read_text(encoding="utf-8")
        # 去整行注释与 docstring 里的示例(只看代码里真读的 env)
        code = "\n".join(
            ln for ln in text.split("\n") if not ln.strip().startswith("#")
        )
        found |= set(re.findall(r"\bAIM_[A-Z0-9_]+\b", code))
    registered = set(rc.TUNABLE_KEYS) | set(rc.EXCLUDED_KEYS)
    orphans = sorted(found - registered)
    assert orphans == [], f"这些 AIM_* 既未登记也未排除:{orphans}"


# ── ③ 安全:secret 不进载荷 ──


def test_secrets_never_in_payload(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """secret 类 key **完全不出现**在载荷里(不是脱敏,是根本不出现)。

    控制面的 allowlist/denylist 脱敏保护不了本端点自身的调用者 —— secret 若序列化进来即直接泄漏。
    """
    monkeypatch.setenv("AIM_EMBEDDING_SECRET", "super-secret-embedding-value")
    monkeypatch.setenv("AIM_MINIMAX_API_KEY", "sk-minimax-fake-key")
    r = client.get("/config", headers={"X-Drain-Secret": SECRET})
    assert r.status_code == 200
    text = r.text
    # 既不含 key 名,也不含值明文
    for forbidden in ("AIM_DRAIN_SECRET", "AIM_EMBEDDING_SECRET", "AIM_MINIMAX_API_KEY"):
        assert forbidden not in text
    for value in (SECRET, "super-secret-embedding-value", "sk-minimax-fake-key"):
        assert value not in text


# ── ④ env 覆盖 → value + override_state 三态 ──


def test_env_override_reflected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AIM_VAD_HANGOVER_MS", "1234")
    entry = next(e for e in rc.load_gpu_config() if e.key == "AIM_VAD_HANGOVER_MS")
    assert entry.value == 1234
    assert entry.default == VAD_DEFAULTS["hangover_ms"]
    assert entry.override_state == "valid"


def test_unset_is_absent_and_value_equals_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AIM_VAD_HANGOVER_MS", raising=False)
    entry = next(e for e in rc.load_gpu_config() if e.key == "AIM_VAD_HANGOVER_MS")
    assert entry.override_state == "absent"
    assert entry.value == entry.default


def test_blank_env_treated_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """空串 / 纯空白视作未设(与各解析口径一致)。"""
    for blank in ("", "   "):
        monkeypatch.setenv("AIM_VAD_HANGOVER_MS", blank)
        entry = next(e for e in rc.load_gpu_config() if e.key == "AIM_VAD_HANGOVER_MS")
        assert entry.value == VAD_DEFAULTS["hangover_ms"]
        assert entry.override_state == "absent"


def test_force_cpu_only_literal_one(monkeypatch: pytest.MonkeyPatch) -> None:
    """``AIM_FORCE_CPU`` 唯 ``"1"`` 生效 —— ``"true"`` **不**切 CPU。

    ⚠ 这是刻意保留的口径:AIM 期统一布尔口径致 ``AIM_FORCE_CPU=true`` 把 GPU 服务静默切 CPU,
    被评为 Critical。本测试钉死现状,防"顺手统一"。
    """
    monkeypatch.setenv("AIM_FORCE_CPU", "true")
    entry = next(e for e in rc.load_gpu_config() if e.key == "AIM_FORCE_CPU")
    assert entry.value is False, '"true" 不应生效(唯 "1" 才 CPU)'

    monkeypatch.setenv("AIM_FORCE_CPU", "1")
    entry = next(e for e in rc.load_gpu_config() if e.key == "AIM_FORCE_CPU")
    assert entry.value is True


def test_truthy_family_accepts_true_string(monkeypatch: pytest.MonkeyPatch) -> None:
    """``AIM_PROTECT_FAIL_CLOSED`` / ``AIM_MINIMAX_STARTUP_PROBE`` 是 ``in ("1","true","True")`` 口径。

    与 ``AIM_FORCE_CPU`` 的唯-"1" 口径**不同**,MUST NOT 混用(逐 key 对源,不统一)。
    """
    for key in ("AIM_PROTECT_FAIL_CLOSED", "AIM_MINIMAX_STARTUP_PROBE"):
        monkeypatch.setenv(key, "true")
        entry = next(e for e in rc.load_gpu_config() if e.key == key)
        assert entry.value is True, f"{key} 应接受 'true'"


# ── ⑤ task role 红线:只读、无副作用 ──


def test_config_does_not_load_models_or_touch_boto(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``/config`` MUST NOT 触发模型加载 / 改 readiness / 新增 boto3 调用(GPU task role 红线)。"""
    import gpu_service.engines as engines

    calls: list[str] = []
    monkeypatch.setattr(engines, "make_asr", lambda *a, **k: calls.append("asr"))
    monkeypatch.setattr(engines, "make_tts", lambda *a, **k: calls.append("tts"))

    # boto3 若被调用即失败(GPU task role 无 DDB/Bedrock)
    import builtins

    real_import = builtins.__import__

    def guard(name: str, *args: object, **kwargs: object) -> object:
        if name == "boto3":
            raise AssertionError("/config 不得引入 boto3(task role 红线)")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(builtins, "__import__", guard)
    r = client.get("/config", headers={"X-Drain-Secret": SECRET})
    monkeypatch.setattr(builtins, "__import__", real_import)

    assert r.status_code == 200
    assert calls == [], "不应触发模型加载"


def test_config_does_not_change_readiness(client: TestClient) -> None:
    before = client.get("/readyz").status_code
    client.get("/config", headers={"X-Drain-Secret": SECRET})
    after = client.get("/readyz").status_code
    assert before == after, "/config 不应改变 readiness"


def test_response_has_sampled_instance_identity(client: TestClient) -> None:
    """响应带实例标识 —— 聚合侧据此标 ``scope: sampled_instance``,不冒充集群一致值。"""
    body = client.get("/config", headers={"X-Drain-Secret": SECRET}).json()
    assert "instance" in body
    assert set(body["instance"]) >= {"task", "backend", "image_tag"}


# ── ⑥ 冻结快照:端点报的必须是业务实际在用的值(review 回归)──


def test_config_reports_frozen_snapshot_not_live_env(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``/config`` MUST 报**冻结快照**,不得随请求时的 env 变化。

    业务模块的 env 解析发生在**模块导入时**(``vad._DEF_HANGOVER`` 等),之后改 env 对业务无效。
    若端点重解析,就会报出业务**并未在用**的值 —— 页面在撒谎,恰好违背本页存在的唯一理由。

    实证过的缺陷形态::

        设 AIM_VAD_HANGOVER_MS=1234 → /config 报 1234
        业务实际在用(vad._DEF_HANGOVER)→ 800

    """
    from gpu_service import vad

    def endpoint_value() -> object:
        body = client.get("/config", headers={"X-Drain-Secret": SECRET}).json()
        return next(e for e in body["entries"] if e["key"] == "AIM_VAD_HANGOVER_MS")["value"]

    before = endpoint_value()
    # 端点报的值 MUST == 业务模块导入时冻结的值
    assert before == vad._DEF_HANGOVER, "端点值与业务实际在用值不一致"

    # 请求期改 env → 端点 MUST 不变(业务也不会变)
    monkeypatch.setenv("AIM_VAD_HANGOVER_MS", "1234")
    assert endpoint_value() == before, "端点随 env 漂移(重解析了)"
    assert vad._DEF_HANGOVER == before, "业务侧本就不随 env 变(前提校验)"


def test_frozen_snapshot_is_stable_across_calls() -> None:
    """``get_frozen_config()`` 多次调用返回同一份(同一对象身份,零重解析)。"""
    a = rc.get_frozen_config()
    b = rc.get_frozen_config()
    assert a is b, "应是同一份冻结快照(不是每次重建)"


def test_log_level_parse_matches_business_byte_for_byte(monkeypatch):
    """`AIM_GPU_LOG_LEVEL` 的 registry 口径 MUST 与 `server.py::_configure_logging` 一致。

    ★ review 实证:原用通用 `_str_env` **原样透传** → `AIM_GPU_LOG_LEVEL=bogus`
      时 `/config` 报 `'bogus'` 且标 `valid`,而业务 `getattr(logging, 'BOGUS', logging.INFO)`
      实际回退 `INFO` —— **页面在撒谎**,恰好摧毁本页存在的唯一理由。

    逐 key 实测过:布尔两处口径(`in ("1","true","True")`)与 int 类(裸 `int()` fail-fast 抛错)
    本就与业务一致,**只有** log_level 一个 key 需要专用口径 —— 故不做无谓的统一。
    """
    import importlib
    import logging

    import gpu_service.runtime_config as rc

    def business_level(raw: str | None) -> str:
        """server.py:38 的逐字节复刻。"""
        return logging.getLevelName(
            getattr(logging, (raw or "INFO").upper(), logging.INFO)
        )

    # 合法(含小写 / WARN 别名)· 非法 · 空 / 空白
    for raw, want_state in (
        ("DEBUG", "valid"), ("debug", "valid"),
        ("warn", "valid"), ("WARN", "valid"), ("WARNING", "valid"),
        ("NOTSET", "valid"), ("CRITICAL", "valid"),
        ("bogus", "ignored_invalid"), ("lowercase-junk", "ignored_invalid"),
        # `logging.warn` 是**函数**不是 int level → 不算合法级别
        ("", "absent"), ("   ", "absent"),
    ):
        monkeypatch.setenv("AIM_GPU_LOG_LEVEL", raw)
        importlib.reload(rc)
        entry = next(e for e in rc.load_gpu_config() if e.key == "AIM_GPU_LOG_LEVEL")
        expected = business_level(raw if raw.strip() else None)
        assert entry.value == expected, (
            f"env={raw!r}:registry 报 {entry.value!r} 但业务实际用 {expected!r} —— 页面会撒谎"
        )
        assert entry.override_state == want_state, (
            f"env={raw!r}:override_state 应为 {want_state!r},实为 {entry.override_state!r}"
        )

    monkeypatch.delenv("AIM_GPU_LOG_LEVEL", raising=False)
    importlib.reload(rc)


def test_log_level_normalizes_alias_to_canonical_name(monkeypatch):
    """`WARN` 与 `WARNING` 是同一 level(30)→ 报**归一后的规范名**,与 logger 自述一致。"""
    import importlib

    import gpu_service.runtime_config as rc

    monkeypatch.setenv("AIM_GPU_LOG_LEVEL", "warn")
    importlib.reload(rc)
    entry = next(e for e in rc.load_gpu_config() if e.key == "AIM_GPU_LOG_LEVEL")
    assert entry.value == "WARNING", "别名 warn 应归一成 WARNING(而非原样回 WARN)"
    monkeypatch.delenv("AIM_GPU_LOG_LEVEL", raising=False)
    importlib.reload(rc)
