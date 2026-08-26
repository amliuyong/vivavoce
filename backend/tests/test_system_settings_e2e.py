"""design contract —— 运行时诊断配置聚合端点 e2e。

覆盖评审收敛后的硬要求:
  ① 权限:admin 200 / staff 403 / 无 token 401
  ② 结构化降级**固定枚举**:401→unauthorized(**不是**停机)、503→endpoint_disabled、
     超时→connect_timeout、schema 不支持→incompatible_schema、格式坏→upstream_error
  ③ ``planned_stopped`` MUST 有独立依据(design contract 容量意图=0),**不可**由「连不上」推断
  ④ 脱敏优先级:未登记双 None / 敏感名布尔 / 整段响应无 secret 明文
  ⑤ 同名跨源 ``(source,key)`` 两条目并存不覆盖
  ⑥ 单子系统故障不让整页 500
"""
from __future__ import annotations

import json
from typing import Any

import pytest

from app.system_settings_meta import is_sensitive_name


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class _FakeResp:
    """httpx.get 的假返回。"""

    def __init__(self, status_code: int, payload: Any = None, *, bad_json: bool = False):
        self.status_code = status_code
        self._payload = payload
        self._bad_json = bad_json

    def json(self) -> Any:
        if self._bad_json:
            raise ValueError("响应不是合法 JSON")
        return self._payload


def _ok_payload(source: str, entries: list[dict], *, version: int = 1) -> dict:
    body = {"schema_version": version, "source": source, "entries": entries}
    if source == "gpu":
        body["instance"] = {"task": "abc123", "backend": "funasr", "image_tag": "v1"}
    return body


@pytest.fixture
def wired(app_and_db, monkeypatch: pytest.MonkeyPatch):
    """把控制面的子系统通路配上(否则一律 not_configured)。

    ⚠ ``Settings`` 是 **frozen dataclass**,不能 setattr —— 用 ``dataclasses.replace`` 造
    一份带通路的副本再挂回 ``app.state``(monkeypatch 会在用例结束后自动还原)。
    """
    import dataclasses

    app, _db = app_and_db
    wired_settings = dataclasses.replace(
        app.state.settings,
        bridge_dial_url="http://rt.test.local:3001",
        bridge_callback_secret="bridge-secret",
        gpu_control_url="http://gpu.test.local:8080",
        gpu_control_secret="drain-secret",
    )
    monkeypatch.setattr(app.state, "settings", wired_settings)
    return app


def _patch_httpx(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """拦 ``httpx.get``(router 内是 ``import httpx`` 后 ``httpx.get``)。"""
    import httpx

    monkeypatch.setattr(httpx, "get", handler)


# ── ① 权限 ──


def test_requires_admin(client, make_token):
    assert client.get("/api/admin/system-settings").status_code == 401
    staff = _auth(make_token(groups=["staff"]))
    assert client.get("/api/admin/system-settings", headers=staff).status_code == 403


def test_admin_gets_200_even_when_subsystems_down(client, make_token):
    """子系统全不可达时,整体仍 200(控制面段照常)—— 单点故障不得让整页挂。"""
    r = client.get("/api/admin/system-settings", headers=_auth(make_token(groups=["admin"])))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sources"]["control"]["status"] == "ok"
    assert body["groups"], "至少应有控制面的分组"


def test_no_store_cache_header(client, make_token):
    r = client.get("/api/admin/system-settings", headers=_auth(make_token(groups=["admin"])))
    assert r.headers.get("cache-control") == "no-store"


# ── ② 结构化降级:固定枚举 ──


@pytest.mark.parametrize(
    ("status_code", "expected"),
    [
        (401, "unauthorized"),
        (503, "endpoint_disabled"),
        (500, "upstream_error"),
    ],
)
def test_http_status_maps_to_fixed_enum(
    wired, client, make_token, monkeypatch, status_code: int, expected: str
):
    """401 MUST 映射为 unauthorized —— 显示成「停机」会掩盖密钥错配事故。"""
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(status_code))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert body["sources"]["media"]["status"] == expected
    assert body["sources"]["gpu"]["status"] == expected
    # 401/503 时服务**是可达的** —— transport_reachable 与 status 分离
    if status_code in (401, 503):
        assert body["sources"]["media"]["transport_reachable"] is True


def test_timeout_maps_to_connect_timeout(wired, client, make_token, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("connect timed out")

    _patch_httpx(monkeypatch, boom)
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert body["sources"]["media"]["status"] == "connect_timeout"
    assert body["sources"]["media"]["transport_reachable"] is False


def test_dns_failure_maps_to_dns_unresolved(wired, client, make_token, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("getaddrinfo failed: Name or service not known")

    _patch_httpx(monkeypatch, boom)
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert body["sources"]["gpu"]["status"] == "dns_unresolved"


def test_unsupported_schema_version(wired, client, make_token, monkeypatch):
    _patch_httpx(monkeypatch,
                 lambda *a, **k: _FakeResp(200, _ok_payload("media", [], version=99)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert body["sources"]["media"]["status"] == "incompatible_schema"


def test_malformed_json_distinguished_from_version(wired, client, make_token, monkeypatch):
    """格式损坏 ≠ 版本不兼容(两者 MUST 可区分)。"""
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, None, bad_json=True))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert body["sources"]["media"]["status"] == "upstream_error"


def test_not_configured_when_no_url(client, make_token):
    """控制面未配子系统通路 → not_configured(压根没通路,不是故障)。"""
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert body["sources"]["media"]["status"] == "not_configured"


# ── ③ planned_stopped 必须有独立依据 ──


def test_planned_stopped_requires_capacity_intent_zero(
    wired, client, make_token, monkeypatch, app_and_db
):
    """容量意图 = 0(admin 主动停机)+ 连不上 → planned_stopped。"""
    app, db = app_and_db
    db.put_gpu_capacity_config({"mode": "fixed", "fixed_count": 0}, expected_version=None)

    def boom(*a, **k):
        raise RuntimeError("Name or service not known")

    _patch_httpx(monkeypatch, boom)
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert body["sources"]["gpu"]["status"] == "planned_stopped"


def test_not_planned_stopped_when_intent_positive(
    wired, client, make_token, monkeypatch, app_and_db
):
    """容量意图 > 0 却连不上 → MUST NOT 报 planned_stopped(那是**故障**,不能掩盖)。"""
    app, db = app_and_db
    db.put_gpu_capacity_config({"mode": "fixed", "fixed_count": 2}, expected_version=None)

    def boom(*a, **k):
        raise RuntimeError("Name or service not known")

    _patch_httpx(monkeypatch, boom)
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert body["sources"]["gpu"]["status"] == "dns_unresolved"
    assert body["sources"]["gpu"]["status"] != "planned_stopped"


def test_unauthorized_never_becomes_planned_stopped(
    wired, client, make_token, monkeypatch, app_and_db
):
    """即便容量意图=0,401 也 MUST 保持 unauthorized —— 服务活着只是拒绝,不是停机。"""
    app, db = app_and_db
    db.put_gpu_capacity_config({"mode": "fixed", "fixed_count": 0}, expected_version=None)
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(401))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert body["sources"]["gpu"]["status"] == "unauthorized"


# ── ④ 脱敏 ──


def _find(body: dict, source: str, key: str) -> dict | None:
    for g in body["groups"]:
        for item in g["items"]:
            if item["source"] == source and item["key"] == key:
                return item
    return None


def test_unregistered_key_hidden_but_listed(wired, client, make_token, monkeypatch):
    """未登记 key **仍列出**(不漏项),但 value 与 default **双 None**。"""
    entries = [{"key": "AIM_FOO_MS", "value": 123, "default": 100, "override_state": "valid"}]
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("media", entries)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    item = _find(body, "media", "AIM_FOO_MS")
    assert item is not None, "未登记项不得被丢弃"
    assert item["effective_value"] is None
    assert item["default"] is None
    assert item["metadata_missing"] is True


def test_unregistered_sensitive_key_becomes_boolean(wired, client, make_token, monkeypatch):
    """未登记**且**命中 denylist → 按优先级出布尔(denylist 优先于 allowlist 缺失)。"""
    entries = [{"key": "AIM_FOO_TOKEN", "value": "super-secret", "default": "",
                "override_state": "valid"}]
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("media", entries)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    item = _find(body, "media", "AIM_FOO_TOKEN")
    assert item is not None
    assert item["effective_value"] is True, "应只回「已配置」布尔"
    assert item["default"] is None
    assert "super-secret" not in json.dumps(body, ensure_ascii=False)


def test_denylist_is_suffix_anchored_not_substring():
    """`is_sensitive_name` MUST 后缀锚定 —— 名字**含**敏感词但不以其结尾的 key 不得判敏感。

    ★ 变异验证补出,但**靶子要选对**:我第一版拿了三个「未登记」key 走整条聚合链路,
      红的原因是 allowlist 缺失置 None(正确规则),**不是**误脱敏 —— 构造错了。
      且实测当前 93 个已登记 key 中「含敏感词但不以其结尾」的有 **0 个**,故去掉尾锚 `$` 时
      端到端**确实无差异**(35 条全绿不是疏漏,是数据集下无可观测差别)。
      真正需要钉死的是**判定函数本身的口径**:它是给未来新增 key 用的护栏。
    """
    # 含敏感词但不以其结尾 → MUST NOT 敏感(子串匹配会误伤这些,AIM 已实测固化的历史坑)
    for key in ("MCP_REFRESH_TOKEN_VALIDITY_DAYS", "AIM_TOKEN_TTL_MS", "AIM_KEY_ROTATION_DAYS",
                "AIM_SECRET_ROTATION_ENABLED", "AIM_API_KEY_SCOPE_MODE"):
        assert not is_sensitive_name(key), (
            f"{key} 名字含敏感词但不以其结尾,MUST NOT 判敏感 —— "
            f"退回子串匹配会把这类普通配置脱敏成布尔,运维再也看不到真实值"
        )
    # 以敏感词结尾 → MUST 敏感(反向对照,防上面被「一律 False」满足)
    for key in ("AIM_BRIDGE_SECRET", "AIM_LLM_API_KEY", "AIM_DB_PASSWORD",
                "AIM_X_CREDENTIAL", "AIM_X_CREDENTIALS", "AIM_JWT_SIGNING_KEY",
                "AIM_TLS_PRIVATE_KEY", "aim_bridge_secret"):
        assert is_sensitive_name(key), f"{key} 以敏感词结尾,MUST 判敏感"


def test_denylist_still_catches_true_suffixes(wired, client, make_token, monkeypatch):
    """反向对照:真正以敏感词**结尾**的 key 必须仍被脱敏(防上一条测试被「一律不脱敏」满足)。"""
    entries = [
        {"key": "AIM_BRIDGE_SECRET", "value": "s3cr3t-value", "default": "",
         "override_state": "valid"},
        {"key": "AIM_LLM_API_KEY", "value": "sk-examplevalue", "default": "",
         "override_state": "valid"},
        {"key": "AIM_DB_PASSWORD", "value": "hunter2", "default": "", "override_state": "valid"},
    ]
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("media", entries)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    text = json.dumps(body, ensure_ascii=False)
    for key in ("AIM_BRIDGE_SECRET", "AIM_LLM_API_KEY", "AIM_DB_PASSWORD"):
        item = _find(body, "media", key)
        assert item is not None and item["effective_value"] is True, f"{key} 应脱敏为布尔"
    for leak in ("s3cr3t-value", "sk-examplevalue", "hunter2"):
        assert leak not in text, f"{leak} 明文泄漏"


def test_no_secret_plaintext_anywhere(wired, client, make_token, monkeypatch):
    """整段响应文本不含任何 fixture secret 明文(值形状守门 + 名称 denylist 双轴)。"""
    entries = [
        {"key": "AIM_SOME_API_KEY", "value": "sk-examplevalue1234", "default": "",
         "override_state": "valid"},
        {"key": "AIM_HARMLESS_MS", "value": "arn:aws:secretsmanager:us-east-1:1:secret:x",
         "default": "", "override_state": "valid"},
    ]
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("media", entries)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    text = json.dumps(body, ensure_ascii=False)
    assert "sk-examplevalue1234" not in text
    # 值形状守门:名称不敏感但值是 Secret ARN → 也拦
    assert "arn:aws:secretsmanager" not in text


def test_control_secrets_only_boolean(client, make_token):
    """控制面各 Secret 只回「已配置/未配置」布尔,MUST NOT 含明文或末 4 位。"""
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    item = _find(body, "control", "AIM_BRIDGE_CALLBACK_SECRET")
    assert item is not None
    assert isinstance(item["effective_value"], bool)


# ── ⑤ 同名跨源 ──


def test_same_key_across_sources_both_present(wired, client, make_token, monkeypatch):
    """``AIM_VAD_ENERGY_THRESHOLD`` 在 media 与 gpu 各一条,MUST 并存不覆盖。

    两值不同即为部署漂移 —— 这是本页最有诊断价值的一项。
    """
    def handler(url, **kwargs):
        if "rt.test.local" in url:
            return _FakeResp(200, _ok_payload("media", [
                {"key": "AIM_VAD_ENERGY_THRESHOLD", "value": 600, "default": 500,
                 "override_state": "valid"}]))
        return _FakeResp(200, _ok_payload("gpu", [
            {"key": "AIM_VAD_ENERGY_THRESHOLD", "value": 500, "default": 500,
             "override_state": "absent"}]))

    _patch_httpx(monkeypatch, handler)
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    media_item = _find(body, "media", "AIM_VAD_ENERGY_THRESHOLD")
    gpu_item = _find(body, "gpu", "AIM_VAD_ENERGY_THRESHOLD")
    assert media_item is not None and gpu_item is not None, "同名跨源两条目须并存"
    assert media_item["effective_value"] == 600
    assert gpu_item["effective_value"] == 500
    # 各自的中文名要能区分「真驱动」与「仅校验」
    assert media_item["name_zh"] != gpu_item["name_zh"]


def test_gpu_scope_marked_sampled(wired, client, make_token, monkeypatch):
    """GPU 组 MUST 标采样单实例(不冒充集群一致值)。"""
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("gpu", [])))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert body["gpu_scope"] == "sampled_instance"


# ── ⑥ origin / differs / 派生 ──


def test_origin_deployment_env_when_valid_override(wired, client, make_token, monkeypatch):
    entries = [{"key": "AIM_BARGE_CONFIRM_MS", "value": 300, "default": 200,
                "override_state": "valid"}]
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("media", entries)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    item = _find(body, "media", "AIM_BARGE_CONFIRM_MS")
    assert item["origin"] == "deployment_env"
    assert item["differs_from_default"] is True


def test_origin_builtin_when_ignored_invalid(wired, client, make_token, monkeypatch):
    """设了但被丢弃(ignored_invalid)→ origin=builtin(生效值确实来自内建默认)。

    但 ``override_state`` 保留 ignored_invalid —— 那是运维最需看见的错配信号。
    """
    entries = [{"key": "AIM_BARGE_CONFIRM_MS", "value": 200, "default": 200,
                "override_state": "ignored_invalid"}]
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("media", entries)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    item = _find(body, "media", "AIM_BARGE_CONFIRM_MS")
    assert item["origin"] == "builtin"
    assert item["override_state"] == "ignored_invalid"
    assert item["differs_from_default"] is False


def test_derived_default_marked(wired, client, make_token, monkeypatch):
    """派生默认项标 default_kind=derived + derived_from,不冒充固定字面量。"""
    entries = [{"key": "AIM_ADVANCE_NUDGE_MS", "value": 4000, "default": 4000,
                "override_state": "absent"}]
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("media", entries)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    item = _find(body, "media", "AIM_ADVANCE_NUDGE_MS")
    assert item["default_kind"] == "derived"
    assert item["origin"] == "derived"
    assert item["derived_from"] == [{"source": "media", "key": "AIM_SILENCE_VIOLATION_MS"}]


def test_registered_keys_carry_chinese_metadata(wired, client, make_token, monkeypatch):
    """已登记项须带中文名/说明/分组(元数据集中在 backend,子系统不承载中文)。"""
    entries = [{"key": "AIM_SILENCE_VIOLATION_MS", "value": 10000, "default": 10000,
                "override_state": "absent"}]
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("media", entries)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    item = _find(body, "media", "AIM_SILENCE_VIOLATION_MS")
    assert item["name_zh"] and item["name_zh"] != item["key"]
    assert item["desc_zh"]
    assert item["group"] == "违规检测"


# ── ⑦ 部署清单(Task 5):CDK 生成 → backend 加载 ──


def test_manifest_loaded_from_env(client, make_token, monkeypatch):
    """CDK 注入的清单能被 backend 解析并进入聚合结果。

    fixture 是**真 CDK 产物**(``ts-node`` 跑 ``buildDeploymentManifest`` 导出),不是手写 JSON ——
    手写会退化成「测试手抄 vs 实现手抄」的自我印证。
    """
    import pathlib

    sample = (pathlib.Path(__file__).parent / "fixtures" / "deployment_manifest_sample.json")
    monkeypatch.setenv("AIM_DEPLOYMENT_MANIFEST", sample.read_text(encoding="utf-8"))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    iac = body["sources"]["iac_manifest"]
    assert iac["status"] == "ok", iac
    assert iac["region"] and iac["stack_name"]
    # 清单项进了分组,且 origin 标 iac_manifest(「部署时固化,改需重新部署」)
    item = _find(body, "iac_manifest", "GPU_HARD_MAX")
    assert item is not None
    assert item["origin"] == "iac_manifest"


def test_manifest_absent_is_not_configured_not_error(client, make_token, monkeypatch):
    """未注入清单 → not_configured,**不影响其余三段**(整体仍 200)。"""
    monkeypatch.delenv("AIM_DEPLOYMENT_MANIFEST", raising=False)
    r = client.get("/api/admin/system-settings", headers=_auth(make_token(groups=["admin"])))
    assert r.status_code == 200
    assert r.json()["sources"]["iac_manifest"]["status"] == "not_configured"
    assert r.json()["sources"]["control"]["status"] == "ok"


def test_manifest_malformed_is_contained(client, make_token, monkeypatch):
    """清单损坏 → upstream_error,不让整页 500。"""
    monkeypatch.setenv("AIM_DEPLOYMENT_MANIFEST", "{not json")
    r = client.get("/api/admin/system-settings", headers=_auth(make_token(groups=["admin"])))
    assert r.status_code == 200
    assert r.json()["sources"]["iac_manifest"]["status"] == "upstream_error"


def test_value_semantics_explicit_not_inferred(wired, client, make_token, monkeypatch):
    """布尔语义由后端**显式**给出,前端不从 redacted_reason 反推。

    反推(`Boolean(redacted_reason)`)当前能 work,但属隐式耦合:一旦将来给正常项也填 reason
    (如「已钳制到上限」),真开关就会被误渲染成「已配置」。故契约里显式表达并在此锁住。
    """
    entries = [
        # 真开关(非敏感)→ switch
        {"key": "AIM_BARGE_DTD", "value": True, "default": True, "override_state": "absent"},
        # 敏感名被脱敏成布尔 → configured
        {"key": "AIM_FOO_TOKEN", "value": "x", "default": "", "override_state": "valid"},
        # 数值 → none
        {"key": "AIM_SILENCE_VIOLATION_MS", "value": 10000, "default": 10000,
         "override_state": "absent"},
    ]
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("media", entries)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    assert _find(body, "media", "AIM_BARGE_DTD")["value_semantics"] == "switch"
    assert _find(body, "media", "AIM_FOO_TOKEN")["value_semantics"] == "configured"
    assert _find(body, "media", "AIM_SILENCE_VIOLATION_MS")["value_semantics"] == "none"


def test_unconfigured_control_items_are_absent_not_valid(client, make_token):
    """未配置的凭据/通路 MUST 报 ``absent`` + ``origin=builtin``,**不是** ``deployment_env``。

    自查发现的真实缺陷:布尔项传的是 ``bool(...)``,未配时是 ``False`` 而非 ``None``,
    若用 ``value is not None`` 反推 is_set 就会把「压根没配」判成「部署时 env 覆盖」——
    而这恰好误导本页唯一的读者(运维)。
    """
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    # 测试夹具默认不配 bridge/gpu 通路
    for key in ("AIM_BRIDGE_DIAL_URL", "AIM_GPU_CONTROL_URL"):
        item = _find(body, "control", key)
        assert item is not None, key
        assert item["override_state"] == "absent", f"{key} 未配却报 {item['override_state']}"
        assert item["origin"] != "deployment_env", f"{key} 未配却报 deployment_env"


def test_configured_control_items_are_valid(client, make_token, monkeypatch):
    """**env 里设了** → valid(与上一条对称,防把判据改成恒 absent)。

    ⚠ 本用例 MUST 经 **env** 注入(而非 `wired` 夹具的 `dataclasses.replace`):
    `override_state` 表达的是「**env 有没有设**」,而 `wired` 只改 Settings 对象、不动 env。
    我最初误用 `wired` 写这条,修 M6(is_set 改为直查 env)后它才暴露 —— 原先靠的是
    「值非 None 就算 valid」那个已被判定为缺陷的反推。
    """
    monkeypatch.setenv("AIM_BRIDGE_DIAL_URL", "http://rt.test.local:3001")
    monkeypatch.setenv("AIM_GPU_CONTROL_URL", "http://gpu.test.local:8080")
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    for key in ("AIM_BRIDGE_DIAL_URL", "AIM_GPU_CONTROL_URL"):
        item = _find(body, "control", key)
        assert item["override_state"] == "valid", f"{key} env 已设却报 {item['override_state']}"


# ── ⑧ 四段来源**都**要有可读元数据(评审两方一致的 M1/Major 2 回归)──


def test_all_four_sources_render_not_hidden(wired, client, make_token, monkeypatch):
    """四段来源的条目都 MUST 可读 —— 不得有整段显示「未登记(值已隐藏)」。

    这条是**评审揪出的真缺陷**的回归:`SETTINGS_META` 原先只登记 media/gpu,
    control(8 项)与 iac_manifest(17 项)零登记 → 整页 25 项显示「未登记」= 功能为空。
    我原有的测试只断言 media 源的项,故没抓到 —— 这就是「测试覆盖偏斜」造成的假绿。
    """
    import pathlib as _p

    sample = (_p.Path(__file__).parent / "fixtures" / "deployment_manifest_sample.json")
    monkeypatch.setenv("AIM_DEPLOYMENT_MANIFEST", sample.read_text(encoding="utf-8"))

    def handler(url, **kwargs):
        if "rt.test.local" in url:
            return _FakeResp(200, _ok_payload("media", [
                {"key": "AIM_SILENCE_VIOLATION_MS", "value": 10000, "default": 10000,
                 "override_state": "absent"}]))
        return _FakeResp(200, _ok_payload("gpu", [
            {"key": "AIM_VAD_HANGOVER_MS", "value": 800, "default": 800,
             "override_state": "absent"}]))

    _patch_httpx(monkeypatch, handler)
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()

    # 逐源抽一项,断言「有中文名 + 值可见 + 未被标未登记」
    probes = [
        ("control", "MAX_CONCURRENCY"),
        ("media", "AIM_SILENCE_VIOLATION_MS"),
        ("gpu", "AIM_VAD_HANGOVER_MS"),
        ("iac_manifest", "GPU_HARD_MAX"),
    ]
    for source, key in probes:
        item = _find(body, source, key)
        assert item is not None, f"{source}:{key} 缺失"
        assert item["metadata_missing"] is False, f"{source}:{key} 被标未登记"
        assert item["name_zh"] and item["name_zh"] != key, f"{source}:{key} 无中文名"
        assert item["effective_value"] is not None, f"{source}:{key} 值被隐藏"

    # 全局:不得有任何一整段来源的条目**全部**被隐藏
    from collections import defaultdict
    by_source = defaultdict(list)
    for g in body["groups"]:
        for item in g["items"]:
            by_source[item["source"]].append(item)
    for source in ("control", "media", "gpu", "iac_manifest"):
        items = by_source[source]
        assert items, f"{source} 段无任何条目"
        visible = [i for i in items if not i["metadata_missing"]]
        assert visible, f"{source} 段**全部**条目被标未登记(该段功能为空)"


def test_control_secrets_registered_as_configured_only(client, make_token):
    """控制面凭据项 MUST 登记为 configured_only(布尔),且**不是** metadata_missing。"""
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    for key in ("AIM_BRIDGE_CALLBACK_SECRET", "AIM_REALTIME_CLIENT_SECRET", "AIM_DRAIN_SECRET"):
        item = _find(body, "control", key)
        assert item is not None, key
        assert item["metadata_missing"] is False, f"{key} 应已登记"
        assert isinstance(item["effective_value"], bool), f"{key} 应只回布尔"
        assert item["value_semantics"] == "configured", f"{key} 语义应为 configured"
        assert item["name_zh"], f"{key} 无中文名"


def test_malformed_entries_structure_contained_not_500(wired, client, make_token, monkeypatch):
    """畸形 ``entries`` 结构 MUST 被就地拒绝,**不得** 500 整页(review 回归)。

    实证过:只校验 `entries` 存在而不校验元素结构时,`_shape_entry` 会在 per-source try 之外
    抛 TypeError/KeyError → 整页 500,击穿「单子系统故障不得让整页挂」。
    """
    for bad in (
        "not-a-list",
        ["not-a-dict"],
        [{}],                      # 缺 key
        [{"key": None}],           # key 非 str
        [{"key": ""}],             # key 空串
        [123],
    ):
        # `entries=bad` MUST 用默认参数**绑定当次值**(而非闭包引用循环变量,ruff B023)——
        # 闭包在延迟调用时会拿到最后一次的 bad,而本测试的价值恰恰在于逐个值分别断言,
        # 那种失效是静默的(测试照绿、实际只验了最后一个输入)。
        _patch_httpx(monkeypatch, lambda *a, _bad=bad, **k: _FakeResp(
            200, {"schema_version": 1, "source": "media", "entries": _bad}))
        r = client.get("/api/admin/system-settings", headers=_auth(make_token(groups=["admin"])))
        assert r.status_code == 200, f"输入 {bad!r} 致整页 {r.status_code}"
        assert r.json()["sources"]["media"]["status"] == "upstream_error", f"输入 {bad!r}"
        # 其余段照常
        assert r.json()["sources"]["control"]["status"] == "ok"


def test_credential_shaped_default_also_redacted(wired, client, make_token, monkeypatch):
    """``default`` 也 MUST 过值形状守门(review 回归)。

    漏洞形态:名称不敏感 + value 干净 + **default 是凭据形状** → default 原样泄漏。
    我第一次自查时用的例子恰好让 value 也命中守门,把这个缺口掩盖了 —— 精确构造才暴露。
    """
    entries = [{"key": "AIM_KICKOFF_WAKE_TEXT", "value": "(请开始)",
                "default": "sk-examplevalue1234", "override_state": "valid"}]
    _patch_httpx(monkeypatch, lambda *a, **k: _FakeResp(200, _ok_payload("media", entries)))
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    item = _find(body, "media", "AIM_KICKOFF_WAKE_TEXT")
    assert item["default"] is None, "凭据形状的 default 未被隐藏"
    # 干净的生效值仍展示(不过度牵连,运维照常排障)
    assert item["effective_value"] == "(请开始)"
    assert "sk-examplevalue1234" not in json.dumps(body, ensure_ascii=False)


def test_control_env_names_match_reality(client, make_token):
    """控制面条目的 key MUST 是**真实 env 名**(review 回归)。

    `max_concurrency` 的 env 真名是 `MAX_CONCURRENCY`(**无** AIM_ 前缀,
    见 `config.py::_max_concurrency_ceiling`)。若页面写成 `AIM_MAX_CONCURRENCY`,
    运维会照着去设一个根本不存在的变量 —— 而本页的唯一读者就是运维。
    """
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    keys = {i["key"] for g in body["groups"] for i in g["items"] if i["source"] == "control"}
    assert "MAX_CONCURRENCY" in keys, "应用真实 env 名"
    assert "AIM_MAX_CONCURRENCY" not in keys, "不得用不存在的 AIM_ 前缀名"


def test_manifest_entries_still_pass_security_axes():
    """部署清单项**不走 allowlist 隐藏**,但 MUST 仍过名称 denylist + 值形状两道轴。

    ★ review 实证:原实现注释写「CDK UT 已断言清单只含非密项,故直接用原值」——
      把守门**全押在另一个子系统的测试**上,后端零防线。构造 manifest 项
      `SOME_SIGNING_KEY = "sk-examplevalue1234"` → **原样回出**且 `redacted_reason=None`
      (装作正常值)。当前 17 项确实非密,但未来新增项没有后端兜底 ——
      「跨子系统的单点守门」正是本 spec 反复吃过的教训,故补纵深防御。
    """
    from app.routers.admin_settings import _shape_entry

    def shape(key, value):
        return _shape_entry("iac_manifest", {
            "key": key, "value": value, "name_zh": "测试项", "group": "部署",
            "consumer": "x", "unit": "", "override_state": "absent",
        })

    # ① 名称命中 denylist → 布尔化(只回「已配置」)
    out = shape("SOME_SIGNING_KEY", "sk-examplevalue1234")
    assert out["effective_value"] is True, "名称敏感项应布尔化"
    assert out["default"] is None
    assert out["redacted_reason"], "应给出脱敏原因"
    assert "sk-examplevalue1234" not in str(out), "凭据明文泄漏"

    # ② 名称不敏感但值像凭据 → 抹值保 key
    for bad in (
        "arn:aws:secretsmanager:cn-north-1:1:secret:x",
        "sk-examplevalue5678",
        "AKIAEXAMPLE12345",
        "postgres://user:pass@host/db",
    ):
        out = shape("SOME_PLAIN_NAME", bad)
        assert out["effective_value"] is None, f"值形状疑似凭据应抹掉:{bad}"
        assert bad not in str(out), f"明文泄漏:{bad}"

    # ③ 正常清单项**不受影响**(防上面两条被「一律脱敏」满足 —— 那会让整页失去意义)
    for key, val in (("GPU_HARD_MAX", 8), ("GPU_SESSIONS_PER_INSTANCE", 2),
                     ("AUDIT_RETENTION_DAYS", 90)):
        out = shape(key, val)
        assert out["effective_value"] == val, f"{key} 是普通数值,不该被脱敏"
        assert out["default"] == val
        assert out["redacted_reason"] is None
        assert out["metadata_missing"] is False, "清单项自带元数据,不该显示未登记"


def test_scalar_override_state_reflects_parser_acceptance():
    """标量项 `override_state` MUST 反映「parser 是否接受」,不是「env 是否存在」。

    ★ review 实证:`MAX_CONCURRENCY=bogus` 时
      `config.py::_max_concurrency_ceiling` **容错回退默认 3 并告警**,而原判据只看
      `os.getenv(...) is not None` → 报 `valid` + origin「部署时 env 覆盖」,
      运维以为配置生效了、实际被丢弃。与 GPU `AIM_GPU_LOG_LEVEL=bogus` 同类缺陷。

    ⚠ **为何直测判据而非走端到端**:`_control_entries` 的值取自**进程启动时**构造并缓存的
      `Settings`,`monkeypatch.setenv` 改不动它 —— 我先写的端到端版本因此拿不到「非法 env
      导致生效值回退默认」的状态(实测报 valid 而非期望值)。真实部署里 env 在启动前就位、
      判据成立;测试层面**受缓存限制测不出**,故把判据提到模块级 `control_override_state`
      直测,并如实记录这条测试天花板(不假装端到端覆盖到了)。
    """
    from app.routers.admin_settings import control_override_state as state

    # env 设了、但生效值仍等于内建默认 → 被 parser 丢弃
    assert state("MAX_CONCURRENCY", 3, 3, True) == "ignored_invalid"
    # env 设了且生效值 ≠ 默认 → 真生效
    assert state("MAX_CONCURRENCY", 10, 3, True) == "valid"
    # env 没设 → absent(不该报 valid,否则 origin 会显示「部署时 env 覆盖」)
    assert state("MAX_CONCURRENCY", 3, 3, False) == "absent"
    # 字符串标量同理
    assert state("AIM_ROLE_CLAIM", "cognito:groups", "cognito:groups", True) == "ignored_invalid"
    assert state("AIM_ROLE_CLAIM", "roles", "cognito:groups", True) == "valid"


def test_boolean_control_items_only_check_env_presence(client, make_token, monkeypatch):
    """布尔化项(通路/凭据)只看 env 存在,**不比对值** —— 防误判「未重载」为「被丢弃」。

    ★ 我修 Major 9 时先把所有项都改成「值 == 默认 → ignored_invalid」,既有用例
      `test_configured_control_items_are_valid` **立即转红**:布尔项的 `value` 是
      `bool(Settings.xxx)`,而 `Settings` 是**进程启动时**构造并缓存的 → 运行中改 env
      不反映到 Settings → 「设了但未重载」被误判成「设了被丢弃」。
      这类项只表达「通路/凭据是否已建」,无「非法值」语义,故不做值比对。
    """
    monkeypatch.setenv("AIM_BRIDGE_DIAL_URL", "http://rt.test.local:3001")
    body = client.get("/api/admin/system-settings",
                      headers=_auth(make_token(groups=["admin"]))).json()
    item = _find(body, "control", "AIM_BRIDGE_DIAL_URL")
    assert item["override_state"] == "valid", "布尔化项设了 env 即 valid,不因值未重载而判丢弃"


# ── design contract:differs 判定二维化 ─────────────────────────────────────────────


def test_settings_differs_only_for_comparable_and_stable():
    """`differs_from_default` MUST 仅对「默认值概念成立 **且** 已标定」的项成立。

    ★ 为什么(design contract §动机):事故前判据是裸比较 `effective != default`,于是只读页把线上
      **正确**配置渲染成「异于默认」—— 修好了被标成偏离标准,默认值反而在宣称「bug 是标准行为」。
      用户据此判决「『只看异于默认』根本就不要存在」。
    """
    from app.routers.admin_settings import _shape_entry

    def shape(source, key, value, default):
        return _shape_entry(source, {
            "key": key, "value": value, "default": default, "override_state": "valid",
        })

    # ① D 类·部署形态:funasr vs 默认 stub —— 有无 GPU 的部署事实,不是「偏离默认」
    out = shape("gpu", "AIM_GPU_BACKEND", "funasr", "stub")
    assert out["default_comparable"] is False
    assert out["calibration_status"] == "n/a"
    assert out["differs_from_default"] is False, "部署形态不该标异于默认"

    # ② D 类·CDK 派生值:MAX_CONCURRENCY = GPU_HARD_MAX × 每实例
    out = shape("control", "MAX_CONCURRENCY", 24, 3)
    assert out["default_comparable"] is False
    assert out["differs_from_default"] is False, "派生值不该标异于默认"

    # ③ D 类·拓扑地址:只有「配了/没配」
    out = shape("control", "AIM_BRIDGE_DIAL_URL", True, False)
    assert out["default_comparable"] is False
    assert out["differs_from_default"] is False, "拓扑地址不该标异于默认"

    # ④ C 类·确实未标定:与默认值不同是**预期**(标定期显式开启)→ 显示「待标定」而非「异于默认」
    out = shape("media", "AIM_BARGE_OPEN_COOLDOWN_MS", 500, 0)
    assert out["default_comparable"] is True, "它有默认值概念,只是还没标定"
    assert out["calibration_status"] == "pending"
    assert out["differs_from_default"] is False, "未标定项不该标异于默认(前端显示「待标定」)"

    # ⑤ C 类·游标念出闭环(design contract 记真机 stall 1/3、阈值待调 → 本 spec 刻意不转默认开)
    out = shape("media", "AIM_CURSOR_VOICED_GATE", True, False)
    assert out["calibration_status"] == "pending"
    assert out["differs_from_default"] is False

    # ⑥ stable 项真被覆盖 → **仍应标出**(这才是「异于默认」该有的语义:真异常)
    out = shape("media", "AIM_BARGE_CONFIRM_MS", 400, 200)
    assert out["default_comparable"] is True
    assert out["calibration_status"] == "stable"
    assert out["differs_from_default"] is True, "已标定项被覆盖 = 真异常,MUST 标出"

    # ⑦ stable 项未被覆盖 → 不标
    out = shape("media", "AIM_BARGE_CONFIRM_MS", 200, 200)
    assert out["differs_from_default"] is False


def test_settings_credentials_and_hidden_are_not_comparable():
    """凭据 / 隐藏项自动 `default_comparable=False`(机械归类,无需逐项人工标注)。

    review 指出:四态枚举覆盖不了凭据类/隐藏项/未登记项 —— 三者共性恰是
    「无默认值可比」,故改为 `default_comparable: bool` 一维统摄。
    """
    from app.routers.admin_settings import _shape_entry

    # 凭据(display_policy=configured_only)→ 不可比
    out = _shape_entry("control", {
        "key": "AIM_BRIDGE_CALLBACK_SECRET", "value": True, "default": None,
        "override_state": "valid",
    })
    assert out["default_comparable"] is False
    assert out["differs_from_default"] is False
    # ★ review:不可比时 calibration MUST 为 "n/a" —— 凭据项在 SETTINGS_META 里
    #   继承字段默认 "stable",若原样输出会自称「已标定」,与「无默认值可比」自相矛盾。
    assert out["calibration_status"] == "n/a", "凭据项不该自称已标定"

    # 未登记项 → 无 META 声明的默认语义 → 不可比
    out = _shape_entry("media", {
        "key": "AIM_TOTALLY_UNREGISTERED_KEY", "value": 1, "default": 0,
        "override_state": "valid",
    })
    assert out["default_comparable"] is False
    assert out["differs_from_default"] is False
    assert out["calibration_status"] == "n/a"


def test_settings_a_class_keys_removed_from_registry():
    """A 类(已删开关)MUST NOT 留在元数据表 —— 否则只读页出现「未登记」幽灵项。"""
    from app.system_settings_meta import SETTINGS_META

    for key in ("AIM_PLAYBACK_ACK_MODE", "AIM_FAREWELL_TTS_DRAIN_ENABLED"):
        assert ("media", key) not in SETTINGS_META, f"{key} 开关已删,元数据条目应一并移除"


def test_settings_decoupled_eou_window_registered():
    """R4 新增的降门槛窗 key MUST 有中文元数据(否则只读页显示「未登记」)。"""
    from app.system_settings_meta import SETTINGS_META

    meta = SETTINGS_META.get(("media", "AIM_EOU_SUB_THRESHOLD_WINDOW_MS"))
    assert meta is not None, "design contract 新增 key 未登记元数据"
    assert "宽容期" in meta.desc_zh or "反悔" in meta.desc_zh, "说明须点明它是考生宽容期(与关联窗区分)"
