"""design contract:LLM 配置服务纯逻辑单测(校验 / 脱敏 / merge / catalog / default 校验)。"""
from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.llm_config_service import (
    DEFAULT_EVALUATOR_MODEL,
    LlmConfigError,
    catalog_ids,
    effective_evaluator_model,
    llm_credential_status,
    masked_view,
    merge_config,
    validate_config_patch,
    validate_default_in_models,
)


def test_effective_evaluator_model_fallback_chain():
    """design contract(review):evaluator_model → default_model → 硬默认。发起下发裁判模型与 evaluator 读侧同口径。"""
    assert effective_evaluator_model({"evaluator_model": "minimax.minimax-m2.5"}) == "minimax.minimax-m2.5"
    # 无 evaluator_model → 回退 default_model
    assert effective_evaluator_model({"default_model": "zai.glm-4.7-flash"}) == "zai.glm-4.7-flash"
    # 都无 → 硬默认(不返回空,避免下发空致裁判永降级)
    assert effective_evaluator_model({}) == DEFAULT_EVALUATOR_MODEL
    # evaluator_model 为 None(raw 常见)→ 不当有值,回退 default
    assert effective_evaluator_model({"evaluator_model": None, "default_model": "zai.glm-4.7-flash"}) == "zai.glm-4.7-flash"
    # masked_view 与之同口径(单一事实源)
    assert masked_view({"default_model": "zai.glm-4.7-flash"})["evaluator_model"] == "zai.glm-4.7-flash"


def test_validate_host_must_https():
    with pytest.raises(LlmConfigError):
        validate_config_patch({"host": "http://insecure"})
    out = validate_config_patch({"host": "https://bedrock-mantle.us-east-1.api.aws/"})
    assert out["host"] == "https://bedrock-mantle.us-east-1.api.aws"  # 去尾斜杠


def test_validate_models_structure():
    out = validate_config_patch({"models": [{"id": "anthropic.claude-haiku-4-5", "label": "Haiku"}]})
    assert out["models"] == [{"id": "anthropic.claude-haiku-4-5", "label": "Haiku"}]
    # label 缺省 → 用 id
    out2 = validate_config_patch({"models": [{"id": "zai.glm-4.7-flash"}]})
    assert out2["models"][0]["label"] == "zai.glm-4.7-flash"


def test_validate_models_rejects_bad():
    with pytest.raises(LlmConfigError):
        validate_config_patch({"models": []})  # 空
    with pytest.raises(LlmConfigError):
        validate_config_patch({"models": [{"id": "no-dot-prefix"}]})  # 无 provider 前缀
    with pytest.raises(LlmConfigError):
        validate_config_patch({"models": [{"id": "a.x"}, {"id": "a.x"}]})  # 重复


def test_masked_view_hides_key():
    raw = {"host": "https://h", "models": [{"id": "anthropic.claude-haiku-4-5"}],
           "default_model": "anthropic.claude-haiku-4-5", "api_key": "sk-secret-wxyz"}
    v = masked_view(raw)
    assert v["has_key"] is True
    assert v["last4"] == "wxyz"
    assert "api_key" not in v
    assert "sk-secret-wxyz" not in str(v)


def test_masked_view_no_key():
    assert masked_view({}) == {
        "enabled": False,
        "host": "https://bedrock-mantle.us-east-1.api.aws",
        "models": [],
        "default_model": "zai.glm-4.7-flash",
        "evaluator_model": "minimax.minimax-m2.5",  # 空配置回退 DEFAULT_EVALUATOR_MODEL(BUG-1 打分模型)
        "fallback_models": [],  # design contract:缺省空 = 关闭 fallback
        "transcript_fixer_model": "",  # design contract:空 = 不修(不回退 default,区别于 evaluator_model)
        "call_method": "mantle",  # design contract:缺省 mantle(向后兼容)
        "bedrock_region": "us-east-1",  # design contract:converse ?region= 默认
        "bedrock_api_key_expires_at": None,
        "has_key": False,
        "last4": None,
        "has_bedrock_key": False,  # design contract:converse 凭据脱敏
        "bedrock_last4": None,
    }


def test_call_method_defaults_mantle_backward_compat():
    """design contract:旧配置无 call_method → 视作 mantle(向后兼容,现状不变)。"""
    from app.llm_config_service import active_credential, call_method, is_enabled
    assert call_method({}) == "mantle"
    assert call_method({"call_method": "bedrock_converse"}) == "bedrock_converse"
    assert call_method({"call_method": "garbage"}) == "mantle"  # 非法值回退默认
    # active_credential 按 method 取:mantle→api_key、converse→bedrock_api_key
    assert active_credential({"api_key": "mk", "bedrock_api_key": "bk"}) == "mk"  # 默认 mantle
    assert active_credential({"call_method": "bedrock_converse", "api_key": "mk", "bedrock_api_key": "bk"}) == "bk"
    # is_enabled 按 method 看对应凭据:converse 只看 bedrock_api_key(有 mantle token 但没 bedrock key → 不启用)
    assert is_enabled({"enabled": True, "call_method": "bedrock_converse", "api_key": "mk"}) is False
    assert is_enabled({"enabled": True, "call_method": "bedrock_converse", "bedrock_api_key": "bk"}) is True
    assert is_enabled({"enabled": True, "api_key": "mk"}) is True  # mantle 默认看 api_key


def test_validate_call_method_and_bedrock_fields():
    """design contract:call_method 枚举校验;bedrock_region 非空;model id 不强校验前缀(用户自负)。"""
    assert validate_config_patch({"call_method": "bedrock_converse"})["call_method"] == "bedrock_converse"
    assert validate_config_patch({"call_method": "mantle"})["call_method"] == "mantle"
    with pytest.raises(LlmConfigError):
        validate_config_patch({"call_method": "nonsense"})
    assert validate_config_patch({"bedrock_region": " ap-northeast-1 "})["bedrock_region"] == "ap-northeast-1"
    with pytest.raises(LlmConfigError):
        validate_config_patch({"bedrock_region": ""})
    # model id 不强校验前缀:converse 用裸短名(格式"错")也不拦(用户自负,运行时 fail-fast)
    assert validate_config_patch({"default_model": "anthropic.claude-sonnet-5"})["default_model"] == "anthropic.claude-sonnet-5"


def test_validate_bedrock_key_expiry_is_future_timezone_aware_utc():
    now = datetime(2026, 8, 5, 14, 0, tzinfo=UTC)
    out = validate_config_patch(
        {"bedrock_api_key_expires_at": "2026-11-03T22:12:41+08:00"},
        now=now,
    )
    assert out["bedrock_api_key_expires_at"] == "2026-11-03T14:12:41Z"

    for invalid in (
        "not-a-date",
        "2026-11-03T14:12:41",
        "2026-08-05T14:00:00Z",
        "2026-08-05T13:59:59Z",
        "",
        None,
    ):
        with pytest.raises(LlmConfigError):
            validate_config_patch({"bedrock_api_key_expires_at": invalid}, now=now)


def test_llm_credential_status_uses_server_utc_seven_day_boundary():
    now = datetime(2026, 8, 5, 14, 0, tzinfo=UTC)
    base = {
        "enabled": True,
        "call_method": "bedrock_converse",
        "bedrock_api_key": "secret-key",
    }

    assert llm_credential_status({
        **base, "bedrock_api_key_expires_at": "2026-08-12T14:00:01Z",
    }, now=now) == {
        "status": "ok",
        "expires_at": "2026-08-12T14:00:01Z",
    }
    assert llm_credential_status({
        **base, "bedrock_api_key_expires_at": "2026-08-12T14:00:00Z",
    }, now=now) == {
        "status": "expiring",
        "expires_at": "2026-08-12T14:00:00Z",
    }
    assert llm_credential_status({
        **base, "bedrock_api_key_expires_at": "2026-08-05T14:00:00Z",
    }, now=now) == {
        "status": "expired",
        "expires_at": "2026-08-05T14:00:00Z",
    }
    assert llm_credential_status(base, now=now) == {
        "status": "not_configured",
        "expires_at": None,
    }
    assert llm_credential_status({
        **base, "bedrock_api_key": "", "bedrock_api_key_expires_at": "2026-08-12T14:00:00Z",
    }, now=now) == {
        "status": "not_configured",
        "expires_at": "2026-08-12T14:00:00Z",
    }
    assert llm_credential_status({
        **base, "enabled": False, "bedrock_api_key_expires_at": "2026-08-05T14:00:00Z",
    }, now=now) == {
        "status": "not_applicable",
        "expires_at": None,
    }
    assert llm_credential_status({
        **base, "call_method": "mantle", "bedrock_api_key_expires_at": "2026-08-05T14:00:00Z",
    }, now=now) == {
        "status": "not_applicable",
        "expires_at": None,
    }


def test_masked_view_bedrock_key_separate_from_mantle():
    """design contract:Bedrock API Key 与 mantle token 分开脱敏。"""
    v = masked_view({"api_key": "mantle-xxxx", "bedrock_api_key": "bedrock-yyyy"})
    assert v["has_key"] is True and v["last4"] == "xxxx"
    assert v["has_bedrock_key"] is True and v["bedrock_last4"] == "yyyy"
    assert "mantle-xxxx" not in str(v) and "bedrock-yyyy" not in str(v)  # 明文不出现


def test_merge_bedrock_api_key_preserve_and_replace():
    """design contract:bedrock_api_key 同 api_key 语义——None 保留、非空替换。"""
    cur = {"bedrock_api_key": "old-bk", "api_key": "mk"}
    assert merge_config(cur, {}, new_bedrock_api_key=None)["bedrock_api_key"] == "old-bk"  # 保留
    assert merge_config(cur, {}, new_bedrock_api_key="new-bk")["bedrock_api_key"] == "new-bk"  # 替换
    assert merge_config(cur, {}, new_api_key=None)["api_key"] == "mk"  # mantle key 不受影响


def test_fixer_model_empty_means_no_fix():
    """design contract:transcript_fixer_model **可空=不修** —— null/空串归一化为 ""(校验不拦);masked 不回退 default。"""
    # null / 空串 / 空白 都合法,归一化为 ""
    assert validate_config_patch({"transcript_fixer_model": None})["transcript_fixer_model"] == ""
    assert validate_config_patch({"transcript_fixer_model": ""})["transcript_fixer_model"] == ""
    assert validate_config_patch({"transcript_fixer_model": "  "})["transcript_fixer_model"] == ""
    # 非空 → 保留(去空白)
    assert validate_config_patch({"transcript_fixer_model": " anthropic.claude-haiku-4-5 "})["transcript_fixer_model"] \
        == "anthropic.claude-haiku-4-5"
    # 非字符串非 null → 拒
    with pytest.raises(LlmConfigError):
        validate_config_patch({"transcript_fixer_model": 123})
    # masked_view:配了修正模型 → 原样回;**未配不回退 default_model**(区别 evaluator_model,空=不修)
    assert masked_view({"transcript_fixer_model": "anthropic.claude-haiku-4-5",
                        "default_model": "zai.glm-4.7-flash"})["transcript_fixer_model"] == "anthropic.claude-haiku-4-5"
    assert masked_view({"default_model": "zai.glm-4.7-flash"})["transcript_fixer_model"] == ""


def test_fixer_model_in_models_only_when_nonempty():
    """design contract:transcript_fixer_model 非空才要求 ∈ 清单;空则跳过(不修)。"""
    # 非空且不在清单 → 拒
    with pytest.raises(LlmConfigError):
        validate_default_in_models({"models": [{"id": "a.b"}], "default_model": "a.b", "transcript_fixer_model": "x.y"})
    # 非空且在清单 → ok
    validate_default_in_models({"models": [{"id": "a.b"}, {"id": "c.d"}], "default_model": "a.b",
                                "transcript_fixer_model": "c.d"})
    # 空 = 不修 → 不校验(即便清单非空)
    validate_default_in_models({"models": [{"id": "a.b"}], "default_model": "a.b", "transcript_fixer_model": ""})


def test_validate_fallback_models_structure():
    """design contract:fallback_models 须为字符串列表,去空校验、去重保序。"""
    out = validate_config_patch({"fallback_models": ["zai.glm-4.7-flash", "minimax.minimax-m2.5", "zai.glm-4.7-flash"]})
    assert out["fallback_models"] == ["zai.glm-4.7-flash", "minimax.minimax-m2.5"]  # 去重保序
    with pytest.raises(LlmConfigError):
        validate_config_patch({"fallback_models": "not-a-list"})
    with pytest.raises(LlmConfigError):
        validate_config_patch({"fallback_models": ["", "  "]})


def test_fallback_models_must_be_in_models():
    """design contract:每个备用模型都须 ∈ models(TOCTOU 静态闸门,同 default_model 口径)。"""
    with pytest.raises(LlmConfigError):
        validate_default_in_models({"models": [{"id": "a.b"}], "default_model": "a.b", "fallback_models": ["x.y"]})
    # 都在清单内 → ok
    validate_default_in_models({"models": [{"id": "a.b"}, {"id": "c.d"}], "default_model": "a.b", "fallback_models": ["c.d"]})
    # models 空 → 不校验
    validate_default_in_models({"models": [], "default_model": "a.b", "fallback_models": ["z.z"]})


def test_merge_defaults_fallback_models_empty():
    merged = merge_config({}, {}, new_api_key=None)
    assert merged["fallback_models"] == []


def test_is_enabled_requires_toggle_and_key():
    from app.llm_config_service import is_enabled
    assert is_enabled({"enabled": True, "api_key": "sk-x"}) is True
    assert is_enabled({"enabled": False, "api_key": "sk-x"}) is False  # 开关关 → 不启用
    assert is_enabled({"enabled": True, "api_key": ""}) is False       # 无 key → 不启用
    assert is_enabled({}) is False


def test_merge_preserves_key_when_absent():
    current = {"api_key": "old-token", "host": "https://h", "models": [{"id": "a.b"}]}
    merged = merge_config(current, {"default_model": "a.b"}, new_api_key=None)
    assert merged["api_key"] == "old-token"  # 不带 key → 保留旧
    assert merged["default_model"] == "a.b"


def test_merge_replaces_key_when_given():
    merged = merge_config({"api_key": "old"}, {}, new_api_key="new-token")
    assert merged["api_key"] == "new-token"


def test_merge_replaces_models_wholesale():
    current = {"models": [{"id": "a.b"}, {"id": "c.d"}]}
    merged = merge_config(current, {"models": [{"id": "e.f"}]}, new_api_key=None)
    assert catalog_ids(merged) == ["e.f"]  # 整体替换,非合并


def test_default_must_be_in_models():
    with pytest.raises(LlmConfigError):
        validate_default_in_models({"models": [{"id": "a.b"}], "default_model": "x.y"})
    # 在清单内 → ok
    validate_default_in_models({"models": [{"id": "a.b"}], "default_model": "a.b"})
    # models 空 → 不校验(允许先只配 host/key)
    validate_default_in_models({"models": [], "default_model": "a.b"})


def test_catalog_ids():
    assert catalog_ids({"models": [{"id": "a.b"}, {"id": "c.d"}]}) == ["a.b", "c.d"]
    assert catalog_ids({}) == []
