"""design contract:发起前 LLM 凭据/模型权威校验 + 逐通注入(纯逻辑,fake store)。

覆盖 SessionService._resolve_llm_config 与 resolve_launch_command 的注入行为:
- 未配 token → LaunchError(不发起静默会话)
- 模型不在清单 → LaunchError(TOCTOU 权威闸门)
- 通过 → token/host 逐通注入 command;不落 Agent/顶层字段以外
- 非 three_stage(历史脏数据,如已删的 s2s)→ 不注入(引擎层 fail-fast)
- store 未接线 → None(交实时会话服务 fail-fast)
"""
from __future__ import annotations

import pytest

from app.session_service import LaunchError, SessionService, resolve_launch_command


class _FakeStore:
    def __init__(self, raw, secret_id="arn:fake"):
        self._raw = raw
        self.secret_id = secret_id

    def read_raw(self):
        return dict(self._raw)


def _svc(store):
    # db=None:_resolve_llm_config / resolve_launch_command 不碰 db;只测 LLM 解析逻辑。
    return SessionService(db=None, dispatcher=object(), llm_config_store=store)


def _agent(engine):
    return {"agent_id": "a1", "name": "Tester", "system_prompt": "hi", "engine": engine}


def _session():
    return {"session_id": "s1", "resolved_questions": []}


CATALOG = {
    "enabled": True,  # 启用自定义(design contract 开关):否则一律走 IAM 回退
    "host": "https://bedrock-mantle.us-east-1.api.aws",
    "models": [{"id": "anthropic.claude-haiku-4-5"}, {"id": "zai.glm-4.7-flash"}],
    "default_model": "anthropic.claude-haiku-4-5",
    "api_key": "sk-tok-1234",
}


def test_missing_token_graceful_fallback_to_iam():
    # 用户决策:未配 mantle token + 未指定模型(或指定 IAM inference profile)→ 优雅降级(返 None,
    # 媒体面走 IAM BedrockStreamer + Haiku),不 fail-fast。
    store = _FakeStore({**CATALOG, "api_key": ""})
    assert _svc(store)._resolve_llm_config(_agent({"engine_type": "three_stage"})) is None
    # 指定 IAM inference profile(us.anthropic.…)也放行回退
    assert _svc(store)._resolve_llm_config(
        _agent({"engine_type": "three_stage", "llm_model_id": "us.anthropic.claude-haiku-4-5-20251001-v1:0"})) is None


def test_mantle_model_but_no_token_failfast():
    # review 用 mantle-only 前缀模型(minimax./zai./…)但没配 token →
    # IAM 回退调不了该模型会 AI 静默,故 fail-fast(而非放行到注定失败的回退)。
    store = _FakeStore({**CATALOG, "api_key": ""})
    with pytest.raises(LaunchError, match="需经 mantle"):
        _svc(store)._resolve_llm_config(
            _agent({"engine_type": "three_stage", "llm_model_id": "minimax.minimax-m2.5"}))
    # store 未接线(None)时同样挡 mantle 前缀模型
    with pytest.raises(LaunchError, match="需经 mantle"):
        _svc(None)._resolve_llm_config(
            _agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}))


def test_model_not_in_catalog_failfast():
    store = _FakeStore(CATALOG)
    with pytest.raises(LaunchError, match="不在当前允许清单"):
        _svc(store)._resolve_llm_config(
            _agent({"engine_type": "three_stage", "llm_model_id": "xai.grok-4.3"}))


def test_model_in_catalog_ok():
    store = _FakeStore(CATALOG)
    cfg = _svc(store)._resolve_llm_config(
        _agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}))
    assert cfg["api_key"] == "sk-tok-1234"


def test_disabled_toggle_falls_back_to_iam_even_with_key():
    # 「启用自定义」关闭:即便存了 token 也走 IAM Haiku(返 None),不走 mantle。
    store = _FakeStore({**CATALOG, "enabled": False})
    assert _svc(store)._resolve_llm_config(_agent({"engine_type": "three_stage"})) is None
    # 关闭 + Agent 却指定 mantle 模型 → fail-fast(否则 IAM 调不了)
    with pytest.raises(LaunchError, match="未启用"):
        _svc(store)._resolve_llm_config(
            _agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}))


def test_empty_model_uses_default_ok():
    store = _FakeStore(CATALOG)
    cfg = _svc(store)._resolve_llm_config(_agent({"engine_type": "three_stage"}))
    assert cfg is not None  # 空 model → 不校验清单,放行(媒体面回退默认)


def test_non_three_stage_returns_none():
    # s2s 引擎已删(VISION §1);历史 DDB 脏数据仍可能带 s2s → 不注入凭据,引擎层 fail-fast
    store = _FakeStore(CATALOG)
    assert _svc(store)._resolve_llm_config(_agent({"engine_type": "s2s"})) is None


def test_store_not_wired_returns_none():
    assert _svc(None)._resolve_llm_config(_agent({"engine_type": "three_stage"})) is None


def test_resolve_launch_command_injects_token_for_three_stage():
    cmd = resolve_launch_command(_session(), _agent({"engine_type": "three_stage"}), CATALOG)
    assert cmd["llm_bearer_token"] == "sk-tok-1234"
    assert cmd["llm_mantle_host"] == "https://bedrock-mantle.us-east-1.api.aws"


def test_resolve_launch_command_no_token_for_non_three_stage():
    # 历史脏数据带已删的 s2s → 不注入凭据(引擎层 fail-fast,不静默换引擎)
    cmd = resolve_launch_command(_session(), _agent({"engine_type": "s2s"}), CATALOG)
    assert "llm_bearer_token" not in cmd


def test_resolve_launch_command_no_llm_config_no_token():
    cmd = resolve_launch_command(_session(), _agent({"engine_type": "three_stage"}), None)
    assert "llm_bearer_token" not in cmd  # 未接线:不注入(媒体面 fail-fast)


# ── 设计决策:中国区(aws-cn)禁 IAM 回退,必须 mantle API key ──

class _FakeSettings:
    def __init__(self, region):
        self.region = region


class _FakeDbWithRegion:
    def __init__(self, region):
        self.settings = _FakeSettings(region)


def _svc_cn(store, region="cn-north-1"):
    return SessionService(db=_FakeDbWithRegion(region), dispatcher=object(), llm_config_store=store)


def test_cn_region_no_token_failfast():
    # 中国区 + 未配 token(即便未指定 mantle 模型)→ fail-fast(不静默降级到必然失败的 IAM Claude)。
    store = _FakeStore({**CATALOG, "api_key": ""})
    with pytest.raises(LaunchError, match="中国区不支持 IAM 回退"):
        _svc_cn(store)._resolve_llm_config(_agent({"engine_type": "three_stage"}))


def test_cn_region_store_not_wired_failfast():
    # 中国区 + store 未接线 → fail-fast(Global 此路返 None 走 IAM,中国区禁止)。
    with pytest.raises(LaunchError, match="中国区不支持 IAM 回退"):
        _svc_cn(None)._resolve_llm_config(_agent({"engine_type": "three_stage"}))


def test_cn_region_disabled_toggle_failfast():
    # 中国区 + 启用自定义关闭 → fail-fast(不回退 IAM)。
    store = _FakeStore({**CATALOG, "enabled": False})
    with pytest.raises(LaunchError, match="中国区不支持 IAM 回退"):
        _svc_cn(store)._resolve_llm_config(_agent({"engine_type": "three_stage"}))


def test_cn_region_with_token_ok():
    # 中国区 + 配了 token + 启用 + 非 Anthropic 模型 → 正常走 mantle(返 config)。
    cfg = _svc_cn(_FakeStore(CATALOG))._resolve_llm_config(
        _agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}))
    assert cfg is not None and cfg["api_key"] == "sk-tok-1234"


def test_cn_region_anthropic_model_failfast():
    # BUG-2:中国区 + 显式选 Anthropic/Claude 模型(在清单内)→ fail-fast(Claude 经 mantle 从中国被地域封锁 400)。
    store = _FakeStore(CATALOG)  # 清单含 anthropic.claude-haiku-4-5
    with pytest.raises(LaunchError, match="不支持 Anthropic"):
        _svc_cn(store)._resolve_llm_config(
            _agent({"engine_type": "three_stage", "llm_model_id": "anthropic.claude-haiku-4-5"}))
    # us. 跨区前缀的 Claude:即便加入清单,剥前缀后仍被 anthropic 守卫拦。
    store2 = _FakeStore({**CATALOG, "models": [*CATALOG["models"], {"id": "us.anthropic.claude-haiku-4-5"}]})
    with pytest.raises(LaunchError, match="不支持 Anthropic"):
        _svc_cn(store2)._resolve_llm_config(
            _agent({"engine_type": "three_stage", "llm_model_id": "us.anthropic.claude-haiku-4-5"}))


def test_cn_region_anthropic_default_model_failfast():
    # BUG-2:中国区 + Agent 未指定模型但清单 default_model 是 Claude → 用 default 时也拦(不产生静默会话)。
    store = _FakeStore(CATALOG)  # default_model = anthropic.claude-haiku-4-5
    with pytest.raises(LaunchError, match="不支持 Anthropic"):
        _svc_cn(store)._resolve_llm_config(_agent({"engine_type": "three_stage"}))


def test_cn_region_anthropic_via_proxy_ok():
    # host 指向**自建跨区透传代理**(非 bedrock-mantle.*.api.aws 官方端点)→ 中国区放行 Claude
    # (代理东京出口绕过地域封锁)。守卫只拦「直连 mantle 官方端点 + Claude」,不拦经代理。
    proxy_cfg = {**CATALOG, "host": "https://proxy-mantle.example.com"}
    store = _FakeStore(proxy_cfg)
    cfg = _svc_cn(store)._resolve_llm_config(
        _agent({"engine_type": "three_stage", "llm_model_id": "anthropic.claude-haiku-4-5"}))
    assert cfg is not None and cfg["host"] == "https://proxy-mantle.example.com"
    # default_model 是 Claude 时(Agent 未指定)经代理同样放行
    cfg2 = _svc_cn(store)._resolve_llm_config(_agent({"engine_type": "three_stage"}))
    assert cfg2 is not None


# ── design contract:ASR 字幕修正模型(transcript_fixer_model)—— 逐通下发 + 旁路降级(非 fail-fast)──

def test_resolve_launch_command_injects_fixer_model():
    # 配了 transcript_fixer_model(非空)→ 逐通下发 llm_transcript_fixer_model_id(复用同通 token/host)。
    cmd = resolve_launch_command(
        _session(), _agent({"engine_type": "three_stage"}),
        {**CATALOG, "transcript_fixer_model": "zai.glm-4.7-flash"})
    assert cmd["llm_transcript_fixer_model_id"] == "zai.glm-4.7-flash"


def test_resolve_launch_command_no_fixer_when_empty():
    # 未配/空 fixer → 不下发字段(bridge 走原文,不修)。
    cmd = resolve_launch_command(_session(), _agent({"engine_type": "three_stage"}), CATALOG)
    assert "llm_transcript_fixer_model_id" not in cmd
    cmd2 = resolve_launch_command(
        _session(), _agent({"engine_type": "three_stage"}), {**CATALOG, "transcript_fixer_model": ""})
    assert "llm_transcript_fixer_model_id" not in cmd2


def test_fixer_not_in_catalog_degrades_not_failfast():
    # 旁路增强(design contract review):配了不在清单的 fixer → **降级剔除**(该通不修),**不 LaunchError**(不阻断会话)。
    store = _FakeStore({**CATALOG, "transcript_fixer_model": "xai.grok-4.3"})  # 不在清单
    cfg = _svc(store)._resolve_llm_config(_agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}))
    assert cfg is not None and cfg["transcript_fixer_model"] == ""  # 剔除为空(不修),会话照常


def test_cn_direct_mantle_anthropic_fixer_degrades_not_failfast():
    # 中国区直连官方 mantle + Anthropic fixer(地域封锁不可达)→ 降级剔除不修,**不 fail-fast**(区别 default_model 命脉)。
    # 主模型用非 anthropic(GLM),避免被 default_model 的 anthropic 守卫先拦(那是 fail-fast,与 fixer 降级正交)。
    store = _FakeStore({**CATALOG, "default_model": "zai.glm-4.7-flash",
                        "transcript_fixer_model": "anthropic.claude-haiku-4-5"})
    cfg = _svc_cn(store)._resolve_llm_config(
        _agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}))
    assert cfg is not None and cfg["transcript_fixer_model"] == ""  # 直连不可达 → 剔除,会话照常


def test_cn_proxy_anthropic_fixer_retained():
    # 中国区经代理 host + Anthropic fixer → 可达,保留下发(与对话 Claude 经代理放行同口径)。
    store = _FakeStore({**CATALOG, "host": "https://proxy-mantle.example.com",
                        "default_model": "zai.glm-4.7-flash",
                        "transcript_fixer_model": "anthropic.claude-haiku-4-5"})
    cfg = _svc_cn(store)._resolve_llm_config(
        _agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}))
    assert cfg is not None and cfg["transcript_fixer_model"] == "anthropic.claude-haiku-4-5"


def test_fixer_degrade_does_not_mutate_secret_dict():
    # 降级剔除用浅拷贝,不改 store 原 dict(避免污染缓存/后续读)。
    raw = {**CATALOG, "transcript_fixer_model": "xai.grok-4.3"}
    store = _FakeStore(raw)
    _svc(store)._resolve_llm_config(_agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}))
    assert store._raw["transcript_fixer_model"] == "xai.grok-4.3"  # 原 dict 未被改


# ── design contract:调用方式(全局单选)—— mantle / bedrock_converse 逐通下发 + 中国区 converse 守卫 ──

CONVERSE_CFG = {
    "enabled": True,
    "call_method": "bedrock_converse",
    "host": "https://proxy-mantle.example.com",  # 经代理
    "bedrock_region": "us-east-1",
    "models": [{"id": "global.anthropic.claude-sonnet-4-6"}],
    "default_model": "global.anthropic.claude-sonnet-4-6",
    "bedrock_api_key": "bedrock-key-9999",
    "api_key": "",  # converse 不看 mantle token
}


def test_dispatch_mantle_method_sends_bearer_token():
    # 默认/mantle 方式:下发 llm_bearer_token + llm_call_method=mantle,不下发 bedrock 字段。
    cmd = resolve_launch_command(_session(), _agent({"engine_type": "three_stage"}), CATALOG)
    assert cmd["llm_call_method"] == "mantle"
    assert cmd["llm_bearer_token"] == "sk-tok-1234"
    assert "llm_bedrock_api_key" not in cmd and "llm_bedrock_region" not in cmd


def test_dispatch_converse_method_sends_bedrock_key_and_region():
    # converse 方式:下发 llm_bedrock_api_key + llm_bedrock_region + host,不下发 mantle token。
    cmd = resolve_launch_command(_session(), _agent({"engine_type": "three_stage"}), CONVERSE_CFG)
    assert cmd["llm_call_method"] == "bedrock_converse"
    assert cmd["llm_bedrock_api_key"] == "bedrock-key-9999"
    assert cmd["llm_bedrock_region"] == "us-east-1"
    assert cmd["llm_mantle_host"] == "https://proxy-mantle.example.com"  # host 共用字段
    assert "llm_bearer_token" not in cmd  # 不下发 mantle token(方式隔离凭据)
    assert cmd["llm_model_id"] == "global.anthropic.claude-sonnet-4-6"  # default 下发


def test_cn_converse_via_proxy_ok():
    # 中国区 converse 经代理 host + 有 bedrock key → 正常返回 config。
    cfg = _svc_cn(_FakeStore(CONVERSE_CFG))._resolve_llm_config(_agent({"engine_type": "three_stage"}))
    assert cfg is not None and cfg["call_method"] == "bedrock_converse"


def test_cn_converse_direct_bedrock_failfast():
    # 中国区 converse 但 host 是官方 bedrock-runtime 直连端点 → fail-fast(会被地域封锁)。
    store = _FakeStore({**CONVERSE_CFG, "host": "https://bedrock-runtime.us-east-1.amazonaws.com"})
    with pytest.raises(LaunchError, match="必须经跨区透传代理"):
        _svc_cn(store)._resolve_llm_config(_agent({"engine_type": "three_stage"}))


def test_cn_converse_no_bedrock_key_failfast():
    # 中国区 converse 经代理但没配 Bedrock API Key → fail-fast(不静默拨注定失败的会话)。
    # 缺凭据 → is_enabled=False → 命中「中国区禁 IAM 回退」分支,但消息按 call_method 指引配 Bedrock API Key。
    store = _FakeStore({**CONVERSE_CFG, "bedrock_api_key": ""})
    with pytest.raises(LaunchError, match="Bedrock API Key"):
        _svc_cn(store)._resolve_llm_config(_agent({"engine_type": "three_stage"}))


def test_cn_converse_no_host_failfast():
    # 中国区 converse 但 host 缺失 → fail-fast(必须经代理)。
    store = _FakeStore({**CONVERSE_CFG, "host": ""})
    with pytest.raises(LaunchError, match="必须经跨区透传代理"):
        _svc_cn(store)._resolve_llm_config(_agent({"engine_type": "three_stage"}))


def test_cn_converse_official_mantle_host_failfast():
    # review 阻断:中国区 converse + host 指向 mantle 官方端点 bedrock-mantle.*.api.aws → fail-fast。
    # converse 上游是传统 Bedrock,经 mantle 官方端点同样被地域封锁(它不是 converse 代理),必须经自建代理。
    store = _FakeStore({**CONVERSE_CFG, "host": "https://bedrock-mantle.us-east-1.api.aws"})
    with pytest.raises(LaunchError, match="必须经跨区透传代理"):
        _svc_cn(store)._resolve_llm_config(_agent({"engine_type": "three_stage"}))
    # 东京 mantle 官方端点同样拒(任何 bedrock-mantle.<region>.api.aws)
    store2 = _FakeStore({**CONVERSE_CFG, "host": "https://bedrock-mantle.ap-northeast-1.api.aws"})
    with pytest.raises(LaunchError, match="必须经跨区透传代理"):
        _svc_cn(store2)._resolve_llm_config(_agent({"engine_type": "three_stage"}))


def test_global_converse_direct_bedrock_ok():
    # Global(非中国区)converse 允许直连官方 bedrock-runtime(有 Bedrock,不强制代理)。
    store = _FakeStore({**CONVERSE_CFG, "host": "https://bedrock-runtime.us-east-1.amazonaws.com"})
    cfg = _svc(store)._resolve_llm_config(_agent({"engine_type": "three_stage"}))
    assert cfg is not None  # 不 fail-fast


def test_cn_region_anthropic_direct_mantle_still_failfast():
    # 反向确认:host 仍是直连 mantle 官方端点(任意 region)→ Claude 仍 fail-fast(原保护不丢)。
    for host in [
        "https://bedrock-mantle.us-east-1.api.aws",
        "https://bedrock-mantle.ap-northeast-1.api.aws",
    ]:
        store = _FakeStore({**CATALOG, "host": host})
        with pytest.raises(LaunchError, match="Anthropic"):
            _svc_cn(store)._resolve_llm_config(
                _agent({"engine_type": "three_stage", "llm_model_id": "anthropic.claude-haiku-4-5"}))


def test_global_region_no_token_still_iam_fallback():
    # Global(us-east-1)未配 token + 未指定 mantle 模型 → 仍优雅降级 IAM(返 None),不受中国区规则影响。
    store = _FakeStore({**CATALOG, "api_key": ""})
    assert _svc_cn(store, region="us-east-1")._resolve_llm_config(
        _agent({"engine_type": "three_stage"})) is None


# ── default_model 兜底下发(Agent 未指定 llm_model_id 时)──

def test_launch_command_fills_default_model_when_agent_unset():
    # Agent 未指定 llm_model_id + 有 mantle config → 下发 config 的 default_model(而非留 None
    # 让实时服务用 IAM env 默认)。这是浏览器 e2e 暴露的真实 bug 的回归防线。
    cmd = resolve_launch_command(_session(), _agent({"engine_type": "three_stage"}), CATALOG)
    assert cmd["llm_model_id"] == "anthropic.claude-haiku-4-5"  # = CATALOG default_model


def test_launch_command_agent_model_overrides_default():
    # Agent 显式指定 → 用 Agent 的,不被 default_model 覆盖。
    cmd = resolve_launch_command(
        _session(), _agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}), CATALOG)
    assert cmd["llm_model_id"] == "zai.glm-4.7-flash"


# ── design contract:主备 fallback 备用模型序逐通下发 + TOCTOU 闸门 + 中国区守卫 ──

CATALOG_FB = {**CATALOG, "fallback_models": ["zai.glm-4.7-flash"]}


def test_launch_command_injects_fallback_models():
    # 有 fallback_models → 逐通下发 llm_fallback_model_ids(剔除与主模型同名)。
    cmd = resolve_launch_command(
        _session(), _agent({"engine_type": "three_stage", "llm_model_id": "anthropic.claude-haiku-4-5"}), CATALOG_FB)
    assert cmd["llm_fallback_model_ids"] == ["zai.glm-4.7-flash"]


def test_launch_command_fallback_excludes_primary():
    # 备用序含主模型 → 剔除(不自我重试);全被剔除则不下发字段。
    cfg = {**CATALOG, "default_model": "zai.glm-4.7-flash", "fallback_models": ["zai.glm-4.7-flash"]}
    cmd = resolve_launch_command(
        _session(), _agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}), cfg)
    assert "llm_fallback_model_ids" not in cmd


def test_launch_command_no_fallback_when_unset():
    cmd = resolve_launch_command(_session(), _agent({"engine_type": "three_stage"}), CATALOG)
    assert "llm_fallback_model_ids" not in cmd


def test_resolve_fallback_model_not_in_catalog_failfast():
    # 备用模型不在清单 → LaunchError(TOCTOU 闸门,同主模型口径)。
    store = _FakeStore({**CATALOG, "fallback_models": ["xai.grok-4.3"]})
    with pytest.raises(LaunchError, match="备用模型"):
        _svc(store)._resolve_llm_config(
            _agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}))


def test_resolve_fallback_in_catalog_ok():
    store = _FakeStore(CATALOG_FB)
    cfg = _svc(store)._resolve_llm_config(
        _agent({"engine_type": "three_stage", "llm_model_id": "anthropic.claude-haiku-4-5"}))
    assert cfg["fallback_models"] == ["zai.glm-4.7-flash"]


def test_cn_region_anthropic_fallback_failfast():
    # 中国区:主模型合规(GLM)但备用序含 Claude → fail-fast(备用切到 Claude 在中国区同样地域封锁)。
    store = _FakeStore({**CATALOG, "default_model": "zai.glm-4.7-flash",
                        "fallback_models": ["anthropic.claude-haiku-4-5"]})
    with pytest.raises(LaunchError, match="不支持 Anthropic"):
        _svc_cn(store)._resolve_llm_config(
            _agent({"engine_type": "three_stage", "llm_model_id": "zai.glm-4.7-flash"}))
