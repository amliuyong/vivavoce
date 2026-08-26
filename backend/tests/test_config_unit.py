"""config 单测 —— 全局闸门安全阀硬顶 + GPU 容量保守兜底(design contract;不再静态钳制,见 _max_concurrency_ceiling)
+ 认证 region 解耦(VISION §2:auth_region 缺省回退 region,issuer/jwks/Hosted UI 全看 auth_region)。"""
from __future__ import annotations

import dataclasses

import pytest

from app.config import (
    _gpu_capacity_static_fallback,
    _max_concurrency_ceiling,
    _parse_role_map,
    load_settings,
)
from tests.conftest import _make_settings


# ── _max_concurrency_ceiling:安全阀硬顶,不再被 AIM_GPU_CAPACITY 静态钳制(design contract 修正)──
def test_ceiling_not_clamped_by_gpu_capacity(monkeypatch):
    """design contract:MAX_CONCURRENCY 是硬顶,**不再**被 AIM_GPU_CAPACITY 钳小(否则 autoscaling 弹性被封死)。"""
    monkeypatch.setenv("MAX_CONCURRENCY", "24")
    monkeypatch.setenv("AIM_GPU_CAPACITY", "3")  # 旧逻辑会钳到 3;新逻辑忽略它
    assert _max_concurrency_ceiling() == 24


def test_ceiling_default(monkeypatch):
    monkeypatch.delenv("MAX_CONCURRENCY", raising=False)
    assert _max_concurrency_ceiling() == 3


def test_ceiling_bad_env_falls_back(monkeypatch):
    monkeypatch.setenv("MAX_CONCURRENCY", "abc")
    assert _max_concurrency_ceiling() == 3


# ── _gpu_capacity_static_fallback:live 缺失时的保守兜底 ──
def test_fallback_uses_env(monkeypatch):
    monkeypatch.setenv("AIM_GPU_CAPACITY", "3")
    assert _gpu_capacity_static_fallback() == 3


def test_fallback_no_env_conservative_default(monkeypatch):
    monkeypatch.delenv("AIM_GPU_CAPACITY", raising=False)
    assert _gpu_capacity_static_fallback() == 3


def test_fallback_bad_env(monkeypatch):
    monkeypatch.setenv("AIM_GPU_CAPACITY", "abc")
    assert _gpu_capacity_static_fallback() == 3


def test_fallback_zero_or_negative_conservative(monkeypatch):
    """≤0 误配 → 回退保守 3(不全拒、不超派;真无容量由 GPU CAPACITY_FULL 兜底)。"""
    monkeypatch.setenv("AIM_GPU_CAPACITY", "0")
    assert _gpu_capacity_static_fallback() == 3
    monkeypatch.setenv("AIM_GPU_CAPACITY", "-1")
    assert _gpu_capacity_static_fallback() == 3


# ── auth_region 解耦(VISION §2:中国区复用美东 Cognito 作外置标准 OIDC)──
def test_auth_region_defaults_to_region(monkeypatch):
    """AIM_AUTH_REGION 未设 → auth_region=None,effective 回退部署 region(Global 部署零变化)。"""
    monkeypatch.delenv("AIM_AUTH_REGION", raising=False)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    s = load_settings()
    assert s.auth_region is None
    assert s.effective_auth_region == "us-east-1"
    assert s.issuer.startswith("https://cognito-idp.us-east-1.amazonaws.com/")


def test_auth_region_env_overrides(monkeypatch):
    """中国区场景:部署 region=cn-north-1 + AIM_AUTH_REGION=us-east-1 → issuer/jwks 指向美东。"""
    monkeypatch.setenv("AWS_REGION", "cn-north-1")
    monkeypatch.setenv("AIM_AUTH_REGION", "us-east-1")
    s = load_settings()
    assert s.region == "cn-north-1"
    assert s.effective_auth_region == "us-east-1"
    # issuer 恒 amazonaws.com(Cognito 在 aws-cn 分区不存在,不做分区后缀分叉)
    assert s.issuer.startswith("https://cognito-idp.us-east-1.amazonaws.com/")
    assert s.jwks_url == f"{s.issuer}/.well-known/jwks.json"


def test_hosted_ui_base_uses_auth_region():
    """Hosted UI 域的 region 段 = auth_region(池所在区),非部署 region。"""
    s = dataclasses.replace(_make_settings(), region="cn-north-1", auth_region="us-east-1")
    assert s.hosted_ui_base == "https://aim-aimtest-12345678.auth.us-east-1.amazoncognito.com"


# ── design contract:角色 claim 可配置 + 值映射(config 层) ──
def test_role_claim_default(monkeypatch):
    """AIM_ROLE_CLAIM 未设 → 默认 cognito:groups(向后兼容);role_map 默认 None(恒等)。"""
    monkeypatch.delenv("AIM_ROLE_CLAIM", raising=False)
    monkeypatch.delenv("AIM_ROLE_MAP", raising=False)
    s = load_settings()
    assert s.role_claim == "cognito:groups"
    assert s.role_map is None


def test_role_claim_env_override(monkeypatch):
    monkeypatch.setenv("AIM_ROLE_CLAIM", "roles")
    s = load_settings()
    assert s.role_claim == "roles"


def test_role_map_valid_json(monkeypatch):
    monkeypatch.setenv("AIM_ROLE_MAP", '{"Administrators":"admin","exam-staff":"staff"}')
    s = load_settings()
    assert s.role_map == {"Administrators": "admin", "exam-staff": "staff"}


def test_parse_role_map_none_and_empty_string():
    """None / 空串 → None(默认恒等,不解析、不崩)。"""
    assert _parse_role_map(None) is None
    assert _parse_role_map("") is None


def test_parse_role_map_empty_object_is_valid():
    """空 {} 是合法 dict(翻译不出角色,归一后 groups=[]),不 fail-fast。"""
    assert _parse_role_map("{}") == {}


def test_parse_role_map_bad_json_fail_fast():
    """非法 JSON → 抛(fail-fast 拒绝启动,不静默降级)。"""
    with pytest.raises(ValueError):
        _parse_role_map("{不是合法json")


def test_parse_role_map_non_object_fail_fast():
    """合法 JSON 但非对象(list/number/str)→ 抛。"""
    for bad in ["[1,2]", "42", '"astring"', "true"]:
        with pytest.raises(ValueError):
            _parse_role_map(bad)


def test_parse_role_map_non_str_values_fail_fast():
    """键或值非 str → 抛(如 {"a":1})。"""
    with pytest.raises(ValueError):
        _parse_role_map('{"a":1}')
    with pytest.raises(ValueError):
        _parse_role_map('{"a":["nested"]}')


def test_load_settings_bad_role_map_fail_fast(monkeypatch):
    """端到端:坏 AIM_ROLE_MAP → load_settings 抛(进程拒绝启动)。"""
    monkeypatch.setenv("AIM_ROLE_MAP", "[1,2]")
    with pytest.raises(ValueError):
        load_settings()
