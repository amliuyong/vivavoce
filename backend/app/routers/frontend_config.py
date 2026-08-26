"""前端运行时配置 `GET /config.json` —— **具名公开路由**(D9 与 `/health` 同类,显式登记豁免)。

设计决策(VISION §2,两分区统一去 CloudFront + S3):前端静态产物由 backend 容器托管,
原来由 CDK BucketDeployment 部署期写死进 S3 的 config.json 改为本端点**动态渲染**——值全部来自
CDK 注入的 env(config.py),同一镜像可部署到任意栈。字段形状与旧 S3 config.json 一字不差
(camelCase,frontend/src/lib/config.ts 零改动,仍启动 fetch('/config.json'))。

安全边界:只吐**公开**配置——Cognito 池/客户端 ID 本就随前端 JS 对浏览器可见(public client,
无 secret),不含任何密钥 / 表名 / 内网地址 / 受保护数据。
"""
from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(tags=["frontend-config"])


class FrontendConfig(BaseModel):
    """与 frontend/src/lib/config.ts 的 RuntimeConfig 同形(camelCase 即约定,别改蛇形)。"""

    region: str
    userPoolId: str
    userPoolClientId: str
    apiBase: str
    # design contract:MCP OAuth code-flow client_id(staff MCP 助手弹窗拼 mcp-remote 命令);空=未配,前端回退委托 token。
    mcpClientId: str
    # design contract:mcp-remote 本地回调 URL(与 Cognito 预注册一字不差);空=前端用内置默认。
    mcpOauthCallbackUrl: str
    # VISION §2:认证(Cognito)所在 region(中国区复用美东池 → us-east-1);Global = 部署 region。
    # 前端凡拼 Cognito/AWS 认证端点一律用它,不用 region(region 仅表其余资源所在区)。
    authRegion: str


@router.get("/config.json", response_model=FrontendConfig)
def frontend_config(request: Request) -> FrontendConfig:
    s = request.app.state.settings
    return FrontendConfig(
        region=s.region,
        userPoolId=s.user_pool_id or "",
        userPoolClientId=s.user_pool_client_id or "",
        apiBase="/api",  # 同源相对路径(域名直挂 ALB,前端与 API 同 host)
        mcpClientId=s.mcp_client_id or "",
        mcpOauthCallbackUrl=s.mcp_oauth_callback_url or "",
        authRegion=s.effective_auth_region,
    )
