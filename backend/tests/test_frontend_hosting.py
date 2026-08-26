"""前端托管(设计决策,VISION §2 去 CloudFront + S3)—— /config.json 动态渲染 + 静态挂载。

覆盖三个形态:
  1. /config.json 无鉴权可取,形状与 frontend/src/lib/config.ts RuntimeConfig 一字不差,无敏感值泄漏;
  2. 静态目录不存在(本地 uvicorn / 纯 API 测试)→ 优雅缺席,API 照常(现有全部 e2e 即此形态);
  3. 静态目录存在 → '/' 回 index.html、任意静态文件可取,且 /health、/config.json、/api/* 不被遮挡
     (mount 在 include_router 之后,显式路由永远先命中)。
"""
from __future__ import annotations

import dataclasses

from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import _make_settings

# ── 1. /config.json:动态渲染,公开,形状契约 ──


def test_config_json_shape_and_values(client):
    """无 Authorization 头即可取;字段 = RuntimeConfig 的七个 camelCase key,不多不少(防敏感值混入)。"""
    r = client.get("/config.json")
    assert r.status_code == 200
    body = r.json()
    # key 集合精确相等:多一个 key 都算泄漏面扩大(表名/secret/内网地址绝不能出现在这里)
    assert set(body.keys()) == {
        "region",
        "userPoolId",
        "userPoolClientId",
        "apiBase",
        "mcpClientId",
        "mcpOauthCallbackUrl",
        "authRegion",
    }
    # 值来自 settings(conftest _make_settings),与旧 S3 config.json 语义一致
    assert body["region"] == "us-east-1"
    assert body["userPoolId"] == "us-east-1_TESTPOOL"
    assert body["userPoolClientId"] == "testclient0123456789"
    assert body["apiBase"] == "/api"
    assert body["mcpClientId"] == "mcpclient0123456789"
    assert body["mcpOauthCallbackUrl"] == ""  # 未注入 AIM_MCP_OAUTH_CALLBACK_URL → 空串(前端用内置默认)
    assert body["authRegion"] == "us-east-1"  # auth_region 未设 → 回退 region(Global 零变化)


def test_config_json_auth_region_decoupled(client, app_and_db):
    """VISION §2:auth_region 注入(中国区场景)→ authRegion 透出美东,region 仍是部署区。"""
    app, _ = app_and_db
    app.state.settings = dataclasses.replace(
        app.state.settings, region="cn-north-1", auth_region="us-east-1"
    )
    r = client.get("/config.json")
    assert r.status_code == 200
    body = r.json()
    assert body["region"] == "cn-north-1"
    assert body["authRegion"] == "us-east-1"


def test_config_json_mcp_oauth_callback_url_from_settings(client, app_and_db):
    """AIM_MCP_OAUTH_CALLBACK_URL(CDK 注入)→ mcpOauthCallbackUrl 原样透出。"""
    app, _ = app_and_db
    app.state.settings = dataclasses.replace(
        app.state.settings, mcp_oauth_callback_url="http://localhost:23456/oauth/callback"
    )
    r = client.get("/config.json")
    assert r.status_code == 200
    assert r.json()["mcpOauthCallbackUrl"] == "http://localhost:23456/oauth/callback"


# ── 2. 静态目录不存在:优雅缺席,API 照常 ──


def test_static_dir_absent_api_unaffected(tmp_path):
    """static_dir 指向不存在的目录 → 不挂载、只告警;/health 正常,'/' 404(无前端产物)。"""
    settings = dataclasses.replace(_make_settings(), static_dir=str(tmp_path / "no-such-dir"))
    app = create_app(settings)
    c = TestClient(app)
    assert c.get("/health").status_code == 200
    assert c.get("/config.json").status_code == 200
    assert c.get("/").status_code == 404


# ── 3. 静态目录存在:'/' 回 index.html,显式路由不被遮挡 ──


def _make_static_dir(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html><body>AIM-FRONTEND-MARKER</body></html>", encoding="utf-8")
    # 产物里的占位 config.json(Next 静态导出会带上 public/config.json)——必须被动态路由遮蔽
    (static / "config.json").write_text('{"region": "PLACEHOLDER-MUST-NOT-SERVE"}', encoding="utf-8")
    assets = static / "_next"
    assets.mkdir()
    (assets / "app.js").write_text("// js asset", encoding="utf-8")
    return static


def test_static_dir_present_serves_spa(tmp_path):
    settings = dataclasses.replace(_make_settings(), static_dir=str(_make_static_dir(tmp_path)))
    app = create_app(settings)
    c = TestClient(app)

    # '/' → index.html(html=True);hash 路由刷新天然命中 index.html,无需 fallback 改写
    r = c.get("/")
    assert r.status_code == 200
    assert "AIM-FRONTEND-MARKER" in r.text

    # 静态资源文件可取
    r = c.get("/_next/app.js")
    assert r.status_code == 200
    assert "js asset" in r.text

    # 不存在的路径 → 404(不吞成 index.html)
    assert c.get("/no-such-file.js").status_code == 404


def test_static_mount_does_not_shadow_named_routes(tmp_path):
    """mount 在 include_router 之后:/health、/config.json、/api/* 显式路由先命中。"""
    settings = dataclasses.replace(_make_settings(), static_dir=str(_make_static_dir(tmp_path)))
    app = create_app(settings)
    c = TestClient(app)

    # /health 仍是 JSON 健康检查(非静态文件)
    r = c.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

    # /config.json 仍是动态渲染(产物占位文件被遮蔽,绝不透出 PLACEHOLDER)
    r = c.get("/config.json")
    assert r.status_code == 200
    assert r.json()["region"] == "us-east-1"
    assert "PLACEHOLDER" not in r.text

    # /api/* 不被遮挡:无 token → 401(命中 API 路由的鉴权,而非静态 404)
    r = c.get("/api/me")
    assert r.status_code == 401
