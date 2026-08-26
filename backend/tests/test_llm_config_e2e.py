"""design contract:LLM 配置 admin e2e —— admin 读写 + key 脱敏 + 非 admin 拒绝 + default∈models 校验。

复用 app_and_db(在 mock_aws 上下文内 yield):moto 真建 Secret,dataclasses.replace 指 settings.llm_secret_arn。
"""
from __future__ import annotations

import dataclasses
import json

import boto3
import pytest
from fastapi.testclient import TestClient


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _app_with_secret(app):
    sm = boto3.client("secretsmanager", region_name="us-east-1")
    arn = sm.create_secret(Name="aim-llm-config", SecretString="{}")["ARN"]
    app.state.settings = dataclasses.replace(app.state.settings, llm_secret_arn=arn)
    return arn


def test_non_admin_rejected(app_and_db, make_token):
    app, _ = app_and_db
    _app_with_secret(app)
    client = TestClient(app)
    staff = _auth(make_token(groups=["staff"]))
    assert client.get("/api/admin/llm-config", headers=staff).status_code == 403
    assert client.put("/api/admin/llm-config", json={"host": "https://x"}, headers=staff).status_code == 403


def test_admin_put_then_get_masked(app_and_db, make_token):
    app, _ = app_and_db
    _app_with_secret(app)
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    # 首次配置:host + 模型清单 + 默认 + token
    r = client.put("/api/admin/llm-config", headers=admin, json={
        "host": "https://bedrock-mantle.us-east-1.api.aws",
        "models": [
            {"id": "anthropic.claude-haiku-4-5", "label": "Haiku"},
            {"id": "zai.glm-4.7-flash", "label": "GLM"},
        ],
        "default_model": "anthropic.claude-haiku-4-5",
        "api_key": "sk-mantle-token-wxyz",
    })
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    assert cfg["has_key"] is True and cfg["last4"] == "wxyz"
    assert "sk-mantle-token-wxyz" not in r.text  # 明文绝不回显

    # GET 脱敏
    g = client.get("/api/admin/llm-config", headers=admin)
    assert g.status_code == 200
    body = g.json()
    assert body["config"]["has_key"] is True and body["config"]["last4"] == "wxyz"
    assert "sk-mantle-token-wxyz" not in g.text
    assert len(body["config"]["models"]) == 2
    assert "recommended" in body  # 前端预填推荐清单


def test_put_default_not_in_models_400(app_and_db, make_token):
    app, _ = app_and_db
    _app_with_secret(app)
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    r = client.put("/api/admin/llm-config", headers=admin, json={
        "models": [{"id": "anthropic.claude-haiku-4-5"}],
        "default_model": "xai.grok-4.3",  # 不在清单
        "api_key": "sk-x",
    })
    assert r.status_code == 400


def test_put_preserves_token_when_absent(app_and_db, make_token):
    app, _ = app_and_db
    _app_with_secret(app)
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    client.put("/api/admin/llm-config", headers=admin, json={
        "host": "https://h", "models": [{"id": "a.b"}], "default_model": "a.b", "api_key": "sk-keep-1234",
    })
    # 只改清单,不带 api_key → 保留旧 token
    r = client.put("/api/admin/llm-config", headers=admin, json={
        "models": [{"id": "a.b"}, {"id": "c.d"}], "default_model": "c.d",
    })
    assert r.status_code == 200
    assert r.json()["config"]["last4"] == "1234"  # 旧 token 仍在


@pytest.mark.parametrize(
    "patch",
    [
        {"bedrock_api_key": "new-bedrock-key"},
        {"bedrock_api_key": "new-bedrock-key", "bedrock_api_key_expires_at": "not-a-date"},
        {"bedrock_api_key": "new-bedrock-key", "bedrock_api_key_expires_at": "2099-11-03T14:12:41"},
        {"bedrock_api_key": "new-bedrock-key", "bedrock_api_key_expires_at": "2000-01-01T00:00:00Z"},
    ],
)
def test_bedrock_key_replacement_requires_valid_expiry_without_partial_write(
    app_and_db,
    make_token,
    patch,
):
    app, _ = app_and_db
    arn = _app_with_secret(app)
    sm = boto3.client("secretsmanager", region_name="us-east-1")
    sm.put_secret_value(SecretId=arn, SecretString=json.dumps({
        "enabled": True,
        "call_method": "bedrock_converse",
        "bedrock_api_key": "old-bedrock-key",
        "bedrock_api_key_expires_at": "2026-11-03T14:12:41Z",
    }))
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))

    response = client.put(
        "/api/admin/llm-config",
        headers=admin,
        json=patch,
    )

    assert response.status_code == 400
    stored = json.loads(sm.get_secret_value(SecretId=arn)["SecretString"])
    assert stored["bedrock_api_key"] == "old-bedrock-key"
    assert stored["bedrock_api_key_expires_at"] == "2026-11-03T14:12:41Z"


def test_bedrock_key_expiry_is_returned_masked_and_preserved(app_and_db, make_token):
    app, _ = app_and_db
    arn = _app_with_secret(app)
    sm = boto3.client("secretsmanager", region_name="us-east-1")
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))

    replaced = client.put(
        "/api/admin/llm-config",
        headers=admin,
        json={
            "bedrock_api_key": "new-bedrock-key-5678",
            "bedrock_api_key_expires_at": "2099-11-03T22:12:41+08:00",
        },
    )

    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["config"]["bedrock_api_key_expires_at"] == "2099-11-03T14:12:41Z"
    assert "new-bedrock-key-5678" not in replaced.text

    updated = client.put("/api/admin/llm-config", headers=admin, json={"bedrock_region": "us-west-2"})
    assert updated.status_code == 200, updated.text
    assert updated.json()["config"]["bedrock_api_key_expires_at"] == "2099-11-03T14:12:41Z"
    stored = json.loads(sm.get_secret_value(SecretId=arn)["SecretString"])
    assert stored["bedrock_api_key"] == "new-bedrock-key-5678"
    assert stored["bedrock_api_key_expires_at"] == "2099-11-03T14:12:41Z"


def test_authenticated_users_can_read_non_secret_llm_credential_status(app_and_db, make_token):
    app, _ = app_and_db
    arn = _app_with_secret(app)
    boto3.client("secretsmanager", region_name="us-east-1").put_secret_value(
        SecretId=arn,
        SecretString=json.dumps({
            "enabled": True,
            "call_method": "bedrock_converse",
            "bedrock_api_key": "secret-bedrock-key-5678",
            "bedrock_api_key_expires_at": "2099-11-03T14:12:41Z",
        }),
    )
    client = TestClient(app)

    for groups in (["admin"], ["staff"]):
        response = client.get(
            "/api/llm-credential-status",
            headers=_auth(make_token(groups=groups)),
        )
        assert response.status_code == 200
        assert response.json() == {
            "status": "ok",
            "expires_at": "2099-11-03T14:12:41Z",
        }
        assert response.headers["cache-control"] == "no-store"
        assert "secret-bedrock-key-5678" not in response.text
        assert "5678" not in response.text

    assert client.get("/api/llm-credential-status").status_code == 401


def test_enable_without_key_400(app_and_db, make_token):
    # 「启用自定义」但既无现存 key 也没填 → 400(不让「启用却无 token」落库)。
    app, _ = app_and_db
    _app_with_secret(app)
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    r = client.put("/api/admin/llm-config", headers=admin, json={
        "enabled": True,
        "models": [{"id": "zai.glm-4.7-flash"}],
        "default_model": "zai.glm-4.7-flash",
    })
    assert r.status_code == 400
    # 关闭自定义则允许无 key(走 Haiku)
    r2 = client.put("/api/admin/llm-config", headers=admin, json={"enabled": False})
    assert r2.status_code == 200
    assert r2.json()["config"]["enabled"] is False


def test_get_503_when_secret_unconfigured(app_and_db, make_token):
    app, _ = app_and_db
    app.state.settings = dataclasses.replace(app.state.settings, llm_secret_arn=None)
    client = TestClient(app)
    admin = _auth(make_token(groups=["admin"]))
    assert client.get("/api/admin/llm-config", headers=admin).status_code == 503
