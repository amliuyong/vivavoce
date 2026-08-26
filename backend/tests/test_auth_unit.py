"""鉴权单元测试 —— 直接打 CognitoVerifier,覆盖每条 fail-closed 分支。

这些是安全红线的核心断言:任一校验项不过都必须拒绝。
"""
from __future__ import annotations

import pytest

from app.auth import AuthError, CognitoVerifier, JwksCache
from tests.conftest import _make_settings


@pytest.fixture
def verifier(jwks):
    import time

    settings = _make_settings()
    # 节流窗口设大 + 标记刚补刷过 → unknown kid 走"节流不刷新"路径(避免单测打网络),
    # 这样 test_unknown_kid_rejected 验证的是"新鲜缓存 + 已补刷过 → 未知 kid 直接拒"。
    v = CognitoVerifier(settings, jwks=JwksCache(settings.jwks_url, miss_refresh_min_interval=9999.0))
    v.jwks.seed(jwks["keys"])
    v.jwks._last_miss_refresh = time.time()
    return v


def test_valid_access_token_passes(verifier, make_token):
    principal = verifier.verify(make_token(groups=["admin"]))
    assert principal.is_admin
    assert principal.username == "alice@corp.com"


def test_empty_token_rejected(verifier):
    with pytest.raises(AuthError) as exc:
        verifier.verify("")
    assert exc.value.status_code == 401


def test_garbage_token_rejected(verifier):
    with pytest.raises(AuthError):
        verifier.verify("not-a-jwt")


def test_unknown_kid_rejected(verifier, make_token):
    with pytest.raises(AuthError) as exc:
        verifier.verify(make_token(groups=["staff"], kid="unknown-kid"))
    assert exc.value.status_code == 401


def test_expired_token_rejected(verifier, make_token):
    with pytest.raises(AuthError):
        verifier.verify(make_token(groups=["staff"], expired=True))


def test_wrong_issuer_rejected(verifier, make_token):
    with pytest.raises(AuthError):
        verifier.verify(make_token(groups=["staff"], issuer="https://evil.example.com/pool"))


def test_id_token_rejected_only_access(verifier, make_token):
    # token_use=id 不可用于调 API(必须 access)
    with pytest.raises(AuthError):
        verifier.verify(make_token(groups=["staff"], token_use="id"))


def test_wrong_client_id_rejected(verifier, make_token):
    with pytest.raises(AuthError):
        verifier.verify(make_token(groups=["staff"], client_id="someoneelse"))


def test_no_groups_means_no_roles(verifier, make_token):
    principal = verifier.verify(make_token())  # 无 cognito:groups
    assert principal.groups == []
    assert not principal.is_admin
    assert not principal.is_staff


def test_tampered_signature_rejected(verifier, make_token):
    token = make_token(groups=["admin"])
    # 篡改 payload 段
    head, payload, sig = token.split(".")
    tampered = head + "." + payload[:-2] + ("AA" if payload[-2:] != "AA" else "BB") + "." + sig
    with pytest.raises(AuthError):
        verifier.verify(tampered)


def test_alg_none_rejected(verifier, make_token):
    """算法混淆防御:alg=none 的无签名 token 必须被拒(只接受 RS256)。"""
    import base64

    def b64(d: bytes) -> str:
        return base64.urlsafe_b64encode(d).decode().rstrip("=")

    header = b64(b'{"alg":"none","typ":"JWT","kid":"testkey-1"}')
    payload = b64(b'{"sub":"x","token_use":"access","client_id":"' + b"testclient0123456789" + b'"}')
    forged = f"{header}.{payload}."  # 无签名
    with pytest.raises(AuthError):
        verifier.verify(forged)


# ── JWKS 缓存行为(review 修复)──
def test_jwks_rotation_refetches_for_unknown_kid(jwks):
    """密钥轮转:缓存里没有的新 kid 应触发补刷(而非直接误拒,#4)。"""
    cache = JwksCache("https://example/jwks", miss_refresh_min_interval=0.0)
    cache.seed(jwks["keys"])  # 只有 testkey-1
    refreshed = {"n": 0}

    def fake_refresh():
        refreshed["n"] += 1
        # 模拟轮转后 JWKS 多了 newkid
        cache._keys = {**cache._keys, "newkid": {"kid": "newkid"}}
        import time as _t
        cache._fetched_at = _t.time()

    cache._refresh = fake_refresh  # type: ignore
    got = cache.get_key("newkid")
    assert refreshed["n"] == 1
    assert got is not None and got["kid"] == "newkid"


def test_jwks_miss_refresh_throttled(jwks):
    """坏 token 的未知 kid:节流窗口内不应反复刷新(防 thundering herd)。"""
    cache = JwksCache("https://example/jwks", miss_refresh_min_interval=9999.0)
    cache.seed(jwks["keys"])
    calls = {"n": 0}
    cache._refresh = lambda: calls.__setitem__("n", calls["n"] + 1)  # type: ignore
    # 已有过一次 miss 刷新(置时间戳),再次未命中应被节流
    import time as _t
    cache._last_miss_refresh = _t.time()
    assert cache.get_key("bogus-kid") is None
    assert calls["n"] == 0  # 被节流,未刷新


def test_jwks_refresh_failure_raises_503(jwks):
    """JWKS 刷新失败 → 503(不是吞成 None/401),刷新者与等待者语义一致(#5)。"""
    cache = JwksCache("https://example/jwks", ttl_seconds=0)  # 立即过期 → 强制刷新

    def boom():
        raise RuntimeError("cognito down")

    cache._refresh = boom  # type: ignore
    with pytest.raises(AuthError) as exc:
        cache.get_key("any")
    assert exc.value.status_code == 503


# ════════ design contract:角色 claim 可配置 + 值映射 ════════
def _verifier_with(jwks, *, role_claim="cognito:groups", role_map=None):
    """构造带自定义 role_claim/role_map 的 verifier(design contract)。"""
    import time

    settings = _make_settings(role_claim=role_claim, role_map=role_map)
    v = CognitoVerifier(settings, jwks=JwksCache(settings.jwks_url, miss_refresh_min_interval=9999.0))
    v.jwks.seed(jwks["keys"])
    v.jwks._last_miss_refresh = time.time()
    return v


def test_053_default_claim_byte_equivalent(verifier, make_token):
    """默认 role_claim=cognito:groups + 恒等映射 → 与现状逐字节等价(向后兼容)。"""
    principal = verifier.verify(make_token(groups=["admin"]))
    assert principal.groups == ["admin"]
    assert principal.is_admin


def test_053_alternate_claim(jwks, make_token):
    """配 role_claim=roles → 从 roles 取角色(无 cognito:groups 也行)。"""
    v = _verifier_with(jwks, role_claim="roles")
    principal = v.verify(make_token(extra_claims={"roles": ["staff"]}))
    assert principal.groups == ["staff"]
    assert principal.is_staff and not principal.is_admin


def test_053_single_source_ignores_other_claims(jwks, make_token):
    """单一来源:配 role_claim=roles 时,即使 token 同时带 cognito:groups=[admin] 也只读 roles。"""
    v = _verifier_with(jwks, role_claim="roles")
    principal = v.verify(make_token(groups=["admin"], extra_claims={"roles": ["staff"]}))
    assert principal.groups == ["staff"]  # cognito:groups 被忽略,不合并
    assert not principal.is_admin


def test_053_alternate_claim_default_reads_cognito(jwks, make_token):
    """默认 role_claim 时,带 roles 但读的仍是 cognito:groups(变异对照:证真读了配置项)。"""
    v = _verifier_with(jwks)  # 默认 cognito:groups
    principal = v.verify(make_token(groups=["admin"], extra_claims={"roles": ["staff"]}))
    assert principal.groups == ["admin"]  # 只读 cognito:groups


def test_053_claim_missing_empty(jwks, make_token):
    """替代 claim 缺失 → groups=[](不炸)。"""
    v = _verifier_with(jwks, role_claim="roles")
    principal = v.verify(make_token())  # 无 roles claim
    assert principal.groups == []


def test_053_falsy_claim_values_normalize_empty(jwks, make_token):
    """claim 值为 falsy(""/[]/0/False)→ groups=[](现状 `or []` 兜底,"" 不得变 [""])。"""
    for bad in ["", [], 0, False]:
        v = _verifier_with(jwks, role_claim="roles")
        principal = v.verify(make_token(extra_claims={"roles": bad}))
        assert principal.groups == [], f"roles={bad!r} 应归 [],实得 {principal.groups!r}"


def test_053_single_string_claim_wrapped(jwks, make_token):
    """单字符串角色 → [该串](现状 isinstance(str) 分支)。"""
    v = _verifier_with(jwks, role_claim="roles")
    principal = v.verify(make_token(extra_claims={"roles": "admin"}))
    assert principal.groups == ["admin"]
    assert principal.is_admin


def test_053_abnormal_claim_type_empty(jwks, make_token):
    """异常类型(dict/number)→ groups=[](fail-safe 不误授)。"""
    v = _verifier_with(jwks, role_claim="roles")
    for bad in [{"nested": "x"}, 42]:
        principal = v.verify(make_token(extra_claims={"roles": bad}))
        assert principal.groups == [], f"roles={bad!r} 应归 []"


def test_053_list_filters_non_str_elements(jwks, make_token):
    """list 里混入非 str 元素 → 只保留 str(异常 IdP 防炸)。"""
    v = _verifier_with(jwks, role_claim="roles")
    principal = v.verify(make_token(extra_claims={"roles": ["admin", 123, None, "staff"]}))
    assert principal.groups == ["admin", "staff"]


def test_053_value_map_translates(jwks, make_token):
    """值映射:外部角色名 → 内部(Administrators→admin)。"""
    v = _verifier_with(jwks, role_claim="roles", role_map={"Administrators": "admin", "exam-staff": "staff"})
    principal = v.verify(make_token(extra_claims={"roles": ["Administrators"]}))
    assert principal.groups == ["admin"]
    assert principal.is_admin


def test_053_value_map_unmapped_dropped(jwks, make_token):
    """未在映射表中的外部角色被丢弃(宁少授勿多授)。"""
    v = _verifier_with(jwks, role_claim="roles", role_map={"Administrators": "admin", "exam-staff": "staff"})
    principal = v.verify(make_token(extra_claims={"roles": ["RandomGroup", "exam-staff"]}))
    assert principal.groups == ["staff"]  # RandomGroup 无映射被丢
    assert not principal.is_admin


def test_053_value_map_dedup_and_empty_dropped(jwks, make_token):
    """多外部角色映射同一内部 → 去重;空映射值 → 丢弃。"""
    v = _verifier_with(
        jwks, role_claim="roles",
        role_map={"Administrators": "admin", "SuperAdmin": "admin", "guest": ""},
    )
    principal = v.verify(make_token(extra_claims={"roles": ["Administrators", "SuperAdmin", "guest"]}))
    assert principal.groups == ["admin"]  # 去重成一个 admin;guest→"" 丢弃


def test_053_empty_map_drops_all(jwks, make_token):
    """空 {} 映射:合法但翻译不出角色 → groups=[](与坏 env fail-fast 不同,{} 是合法 dict)。"""
    v = _verifier_with(jwks, role_claim="cognito:groups", role_map={})
    principal = v.verify(make_token(groups=["admin"]))
    assert principal.groups == []


def test_053_identity_map_when_none(jwks, make_token):
    """role_map=None(默认)→ 恒等,claim 值原样(向后兼容)。"""
    v = _verifier_with(jwks, role_claim="cognito:groups", role_map=None)
    principal = v.verify(make_token(groups=["admin", "staff"]))
    assert principal.groups == ["admin", "staff"]


def test_053_alternate_claim_identity_map(jwks, make_token):
    """配替代 claim 但未配 map → 恒等(即使用了替代 claim)。"""
    v = _verifier_with(jwks, role_claim="roles", role_map=None)
    principal = v.verify(make_token(extra_claims={"roles": ["admin"]}))
    assert principal.groups == ["admin"]
    assert principal.is_admin


# ── design contract MCP 路径回归(design contract 重构不得破坏 allowed_client_ids/scope 校验)──
def test_053_mcp_client_id_and_scope_pass(jwks, make_token):
    """MCP 分支:对的 client_id + scope → 过(design contract 契约,重构后仍成立)。"""
    v = _verifier_with(jwks)
    settings = v.settings
    token = make_token(client_id=settings.mcp_client_id, scope="aim/invoke")
    principal = v.verify(token, allowed_client_ids=[settings.mcp_client_id], required_scope="aim/invoke")
    assert principal.client_id == settings.mcp_client_id
    assert "aim/invoke" in principal.scopes


def test_053_mcp_wrong_client_id_rejected(jwks, make_token):
    """MCP 分支:web client 的 token 塞不进 MCP allowed 集 → 401。"""
    from app.auth import AuthError

    v = _verifier_with(jwks)
    token = make_token(client_id="testclient0123456789", scope="aim/invoke")
    with pytest.raises(AuthError):
        v.verify(token, allowed_client_ids=[v.settings.mcp_client_id], required_scope="aim/invoke")


def test_053_mcp_missing_scope_insufficient(jwks, make_token):
    """MCP 分支:缺 required_scope → InsufficientScopeError(403,与 401 区分)。"""
    from app.auth import InsufficientScopeError

    v = _verifier_with(jwks)
    token = make_token(client_id=v.settings.mcp_client_id, scope="other")
    with pytest.raises(InsufficientScopeError):
        v.verify(token, allowed_client_ids=[v.settings.mcp_client_id], required_scope="aim/invoke")
