"""MiniMax TTS provider 配置 e2e(design contract)—— admin 读写 + 脱敏 + 非 admin 拒绝 + 热加载回执。

复用 app_and_db(其在 mock_aws 上下文内 yield):用 moto 真建一个 Secret,dataclasses.replace
把 settings.minimax_secret_arn 指向它,验证 backend 经 Secrets Manager 读写 + key 脱敏。
"""
from __future__ import annotations

import dataclasses
import json

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from app.minimax_config_service import MiniMaxConfigStore


@pytest.fixture(autouse=True)
def _no_real_get_voice(monkeypatch):
    """默认让 get_voice 不可达(确定性 fail-open),避免测试真打 MiniMax 网络。
    需要特定音色清单的测试用 _patch_get_voice 覆盖。"""
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda *a, **k: (_ for _ in ()).throw(TimeoutError("no network in tests")),
    )


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _app_with_secret(app, *, gpu_url=None, gpu_secret=None):
    """在当前 moto 上下文建一个 MiniMax Secret,并把 settings 指向它(+ 可选 GPU 热加载通路)。"""
    sm = boto3.client("secretsmanager", region_name="us-east-1")
    arn = sm.create_secret(Name="aim-minimax-config", SecretString="{}")["ARN"]
    app.state.settings = dataclasses.replace(
        app.state.settings, minimax_secret_arn=arn,
        gpu_control_url=gpu_url, gpu_control_secret=gpu_secret,
    )
    return arn


def _patch_get_voice(monkeypatch, *, voice_ids=None, fail=False):
    """patch get_voice 底层 urlopen:返回含给定 voice_id 的清单,或抛错(模拟不可达)。"""
    class _Resp:
        def __init__(self, data):
            self._data = data
        def read(self):
            return self._data
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        if fail:
            raise TimeoutError("get_voice unreachable")
        body = json.dumps({
            "system_voice": [{"voice_id": v, "voice_name": f"name-{v}"} for v in (voice_ids or [])],
            "base_resp": {"status_code": 0, "status_msg": "success"},
        }).encode("utf-8")
        return _Resp(body)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)


def test_put_rejects_unknown_voice_id(app_and_db, make_token, monkeypatch):
    """用户填的 voice_id 不在账号 get_voice 清单 → 400(不等真机 2013 才失败)。"""
    app, _ = app_and_db
    arn = _app_with_secret(app)
    boto3.client("secretsmanager", region_name="us-east-1").put_secret_value(
        SecretId=arn, SecretString=json.dumps({"enabled": True, "api_key": "sk-k"}))
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    # 账号只有 voiceA;用户填 voiceX → 400
    _patch_get_voice(monkeypatch, voice_ids=["Chinese (Mandarin)_voiceA"])
    r = client.put("/api/admin/tts-config",
                   json={"voice_map": {"female_std": "Chinese (Mandarin)_voiceX"}}, headers=admin)
    assert r.status_code == 400, r.text
    assert "voice_id" in r.json()["detail"]
    # 填清单里有的 → 通过
    r = client.put("/api/admin/tts-config",
                   json={"voice_map": {"female_std": "Chinese (Mandarin)_voiceA"}}, headers=admin)
    assert r.status_code == 200, r.text


def test_put_voice_validation_fail_open(app_and_db, make_token, monkeypatch):
    """get_voice 不可达(网络/限流)→ fail-open:跳过校验、配置照常保存(MiniMax 抖动不该让人配不了)。"""
    app, _ = app_and_db
    arn = _app_with_secret(app)
    boto3.client("secretsmanager", region_name="us-east-1").put_secret_value(
        SecretId=arn, SecretString=json.dumps({"enabled": True, "api_key": "sk-k"}))
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    _patch_get_voice(monkeypatch, fail=True)  # get_voice 抛错
    r = client.put("/api/admin/tts-config",
                   json={"voice_map": {"female_std": "Chinese (Mandarin)_whatever"}}, headers=admin)
    assert r.status_code == 200, r.text  # 不阻塞保存


def test_get_voices_endpoint(app_and_db, make_token, monkeypatch):
    """GET /voices 返回账号音色清单(voice_id+voice_name);无 key → available=false 不报错。"""
    app, _ = app_and_db
    arn = _app_with_secret(app)
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    # 无 key → available=false
    r = client.get("/api/admin/tts-config/voices", headers=admin)
    assert r.status_code == 200 and r.json()["available"] is False
    # 配 key + mock get_voice → 返回清单
    boto3.client("secretsmanager", region_name="us-east-1").put_secret_value(
        SecretId=arn, SecretString=json.dumps({"enabled": True, "api_key": "sk-k"}))
    _patch_get_voice(monkeypatch, voice_ids=["Chinese (Mandarin)_Gentleman"])
    r = client.get("/api/admin/tts-config/voices", headers=admin)
    body = r.json()
    assert body["available"] is True
    assert any(v["voice_id"] == "Chinese (Mandarin)_Gentleman" for v in body["voices"])
    # 非 admin 拒绝
    assert client.get("/api/admin/tts-config/voices",
                      headers=_auth(make_token(groups=["staff"]))).status_code == 403


def test_get_tts_config_masks_key(app_and_db, make_token):
    app, _ = app_and_db
    arn = _app_with_secret(app)
    # 预置一份含明文 key 的配置
    boto3.client("secretsmanager", region_name="us-east-1").put_secret_value(
        SecretId=arn,
        SecretString=json.dumps({"enabled": True, "api_key": "sk-secret-ABCD1234", "model": "speech-2.8-turbo"}),
    )
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    r = client.get("/api/admin/tts-config", headers=admin)
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    # 脱敏:仅 has_key + 末4位,明文绝不回显
    assert cfg["has_key"] is True
    assert cfg["last4"] == "1234"
    assert "sk-secret" not in json.dumps(r.json())  # 明文不出现在响应任何角落
    assert cfg["enabled"] is True


def test_put_tts_config_writes_secret_and_masks(app_and_db, make_token):
    app, _ = app_and_db
    arn = _app_with_secret(app)
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    # 首次配置:enabled + key + voice_map
    r = client.put("/api/admin/tts-config", json={
        "enabled": True, "api_key": "sk-newkey-WXYZ9999",
        "voice_map": {"male_std": "Chinese (Mandarin)_Gentleman"},
    }, headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["config"]["has_key"] is True and body["config"]["last4"] == "9999"
    assert "sk-newkey" not in json.dumps(body)  # PUT 响应也脱敏
    # Secret 里确实写了明文 key(供 GPU 直读),但绝不回前端
    raw = json.loads(boto3.client("secretsmanager", region_name="us-east-1")
                     .get_secret_value(SecretId=arn)["SecretString"])
    assert raw["api_key"] == "sk-newkey-WXYZ9999"
    assert raw["enabled"] is True
    # 未配 GPU 热加载通路 → reload.triggered=false(配置仍落 Secret)
    assert body["reload"]["triggered"] is False


def test_put_tts_config_preserves_key_when_omitted(app_and_db, make_token):
    app, _ = app_and_db
    arn = _app_with_secret(app)
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    client.put("/api/admin/tts-config", json={"enabled": True, "api_key": "sk-keep-0001"}, headers=admin)
    # 再改非密参数(不带 api_key)→ 旧 key 保留
    r = client.put("/api/admin/tts-config", json={"model": "speech-2.8-turbo", "enabled": False}, headers=admin)
    assert r.status_code == 200
    raw = json.loads(boto3.client("secretsmanager", region_name="us-east-1")
                     .get_secret_value(SecretId=arn)["SecretString"])
    assert raw["api_key"] == "sk-keep-0001"  # 未带 key → 保留
    assert raw["enabled"] is False


def test_put_tts_config_invalid_base_url_400(app_and_db, make_token):
    app, _ = app_and_db
    _app_with_secret(app)
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    r = client.put("/api/admin/tts-config", json={"base_url": "http://insecure"}, headers=admin)
    assert r.status_code == 400  # 须 https


def test_enable_without_key_rejected_400(app_and_db, make_token):
    """启用 MiniMax 但无有效 key(既没现存也没新填)→ 400(不让"启用却无 key"落库)。
    关闭(enabled=false)则允许无 key。"""
    app, _ = app_and_db
    _app_with_secret(app)  # Secret 初值 {} → 无 key
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    # enabled=true 无 key → 400
    r = client.put("/api/admin/tts-config", json={"enabled": True}, headers=admin)
    assert r.status_code == 400, r.text
    assert "API Key" in r.json()["detail"]
    # enabled=false 无 key → 允许(disable 态)
    assert client.put("/api/admin/tts-config", json={"enabled": False}, headers=admin).status_code == 200
    # enabled=true + 同时带 key → 允许
    assert client.put("/api/admin/tts-config",
                      json={"enabled": True, "api_key": "sk-now-have-key"}, headers=admin).status_code == 200


def test_non_admin_cannot_read_write(app_and_db, make_token):
    app, _ = app_and_db
    _app_with_secret(app)
    client = TestClient(app)
    staff = _auth(make_token(groups=["staff"]))
    assert client.get("/api/admin/tts-config", headers=staff).status_code == 403
    assert client.put("/api/admin/tts-config", json={"enabled": True}, headers=staff).status_code == 403
    # 未鉴权
    assert client.get("/api/admin/tts-config").status_code == 401


def test_reload_receipt_passed_through(app_and_db, make_token, monkeypatch):
    """配了 GPU 热加载通路 → PUT 后调 /reload-tts-config,回执透传前端(已生效/key 无效)。"""
    app, _ = app_and_db
    _app_with_secret(app, gpu_url="http://gpu.local:8080", gpu_secret="s3cr3t")
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))

    captured = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"ok": True, "enabled": True, "detail": "校验通过",
                    "per_voice": {"male_std": "ok", "female_std": "ok"}}

    def fake_post(url, headers=None, timeout=None):
        captured["url"] = url
        captured["secret"] = headers.get("X-Drain-Secret")
        return _Resp()

    import httpx
    monkeypatch.setattr(httpx, "post", fake_post)
    r = client.put("/api/admin/tts-config", json={"enabled": True, "api_key": "sk-xyz-1234"}, headers=admin)
    assert r.status_code == 200, r.text
    reload_info = r.json()["reload"]
    assert reload_info["triggered"] is True and reload_info["ok"] is True
    assert reload_info["detail"] == "校验通过"
    assert captured["url"].endswith("/reload-tts-config")
    assert captured["secret"] == "s3cr3t"


def test_reload_failure_does_not_block_save(app_and_db, make_token, monkeypatch):
    """GPU 不可达 → 保存不阻塞(配置已落 Secret),reload.ok=None 提示'正在下发'。"""
    app, _ = app_and_db
    arn = _app_with_secret(app, gpu_url="http://gpu.local:8080", gpu_secret="s3cr3t")
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))

    import httpx
    monkeypatch.setattr(httpx, "post", lambda *a, **k: (_ for _ in ()).throw(httpx.ConnectError("unreachable")))
    r = client.put("/api/admin/tts-config", json={"enabled": True, "api_key": "sk-abc-5678"}, headers=admin)
    assert r.status_code == 200  # 保存成功
    assert r.json()["reload"]["ok"] is None  # 下发未确认
    # 配置已落 Secret(GPU 下次启动/重载兜底)
    raw = json.loads(boto3.client("secretsmanager", region_name="us-east-1")
                     .get_secret_value(SecretId=arn)["SecretString"])
    assert raw["api_key"] == "sk-abc-5678"


def test_voice_map_partial_update_preserves_other_key(app_and_db, make_token):
    """部分更新 voice_map(只改 male_std)→ 后端深合并,female_std 映射保留(不被整体替换丢弃)。"""
    app, _ = app_and_db
    arn = _app_with_secret(app)
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    # 先配两条映射
    client.put("/api/admin/tts-config", json={
        "enabled": True, "api_key": "sk-1234",
        "voice_map": {"male_std": "Old_Male", "female_std": "Old_Female"},
    }, headers=admin)
    # 只改 male_std(直接 API 部分更新)→ female_std 必须保留
    r = client.put("/api/admin/tts-config", json={"voice_map": {"male_std": "New_Male"}}, headers=admin)
    assert r.status_code == 200, r.text
    raw = json.loads(boto3.client("secretsmanager", region_name="us-east-1")
                     .get_secret_value(SecretId=arn)["SecretString"])
    assert raw["voice_map"]["male_std"] == "New_Male"
    assert raw["voice_map"]["female_std"] == "Old_Female"  # 深合并:未提及的 key 保留


def test_put_aborts_on_transient_read_failure_no_clobber(app_and_db, make_token, monkeypatch):
    """review:读 Secret 瞬时失败(非 NotFound)→ PUT 502 中止,**绝不**拿空配置 merge 写回
    覆盖现有 key。模拟 get_secret_value 抛限流异常。"""
    app, _ = app_and_db
    arn = _app_with_secret(app)
    # 预置含 key 的配置
    boto3.client("secretsmanager", region_name="us-east-1").put_secret_value(
        SecretId=arn, SecretString=json.dumps({"enabled": True, "api_key": "sk-precious-9999"}))
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))

    # 让 read_raw 的 get_secret_value 抛"限流"(ClientError 但非 NotFound)
    orig = MiniMaxConfigStore._sm

    class _Boom:
        def get_secret_value(self, **kw):
            raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "GetSecretValue")
        def put_secret_value(self, **kw):
            raise AssertionError("读失败时绝不应走到写")

    monkeypatch.setattr(MiniMaxConfigStore, "_sm", lambda self: _Boom())
    # 改 enabled(不带 api_key)→ 读失败 → 502,不写
    r = client.put("/api/admin/tts-config", json={"enabled": False}, headers=admin)
    assert r.status_code == 502, r.text
    # 恢复正常 client,确认 Secret 里的 key 仍在(未被覆盖)
    monkeypatch.setattr(MiniMaxConfigStore, "_sm", orig)
    raw = json.loads(boto3.client("secretsmanager", region_name="us-east-1")
                     .get_secret_value(SecretId=arn)["SecretString"])
    assert raw["api_key"] == "sk-precious-9999"  # 现有 key 未被瞬时读失败抹掉


def test_config_503_when_secret_unconfigured(app_and_db, make_token):
    """未部署 019(无 Secret ARN)→ fail-closed 503(不静默)。"""
    app, _ = app_and_db  # settings.minimax_secret_arn 默认 None
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    assert client.get("/api/admin/tts-config", headers=admin).status_code == 503
    assert client.put("/api/admin/tts-config", json={"enabled": True}, headers=admin).status_code == 503
