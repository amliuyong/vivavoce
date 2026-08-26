"""FastAPI app 装配 —— AIM Orchestrator API(控制面)。

安全红线(HLD D9):除具名公开路由(/health、/config.json、/.well-known/* 发现文档、静态前端资源)外,
所有端点 MUST 带鉴权(四种认证之一,fail-closed)。
verifier / db 挂在 app.state,生产用真实 Cognito + DynamoDB;测试覆盖 app.state 注入本地 JWKS + moto。

前端托管(设计决策,VISION §2 去 CloudFront + S3):frontend/out/ 静态导出由 Dockerfile
多阶段烘进镜像 ./static,这里 StaticFiles(html=True) 挂根;/config.json 动态渲染(frontend_config)。
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .auth import CognitoVerifier
from .config import Settings, load_settings
from .db import Db
from .routers import (
    admin_capacity,
    admin_llm,
    admin_settings,
    admin_tts,
    agents,
    candidate,
    frontend_config,
    health,
    integration,
    llm_status,
    mcp,
    mcp_facade,
    me,
    questionbanks,
    results,
    sessions,
    well_known,
)

# 前端静态产物的默认位置:<backend>/static(容器内 Dockerfile COPY frontend/out → /app/static)。
# 本地 uvicorn 直跑通常没有此目录 → 优雅缺席(见 _mount_static)。
_DEFAULT_STATIC_DIR = Path(__file__).resolve().parents[1] / "static"


def _configure_logging() -> None:
    """让 app 自己的 `aim.*` logger 输出到 stdout(uvicorn/CloudWatch 捕获)。

    根因:app 此前无任何 logging 配置,uvicorn 只配自己的 logger → 我们的 `logger.info(...)`
    传播到无 handler 的 root,被 lastResort(WARNING 阈值)丢弃 → 线上看不到 INFO 诊断日志。
    这里给 `aim` 顶层 logger 挂一个 stdout handler + INFO(级别可经 AIM_LOG_LEVEL 调),
    propagate=False 避免与 uvicorn 的 root handler 重复打印。"""
    level = getattr(logging, os.getenv("AIM_LOG_LEVEL", "INFO").upper(), logging.INFO)
    aim_logger = logging.getLogger("aim")
    aim_logger.setLevel(level)
    if not aim_logger.handlers:
        handler = logging.StreamHandler()  # 默认 stderr;ECS/CloudWatch 同样捕获
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        aim_logger.addHandler(handler)
    aim_logger.propagate = False


def create_app(settings: Settings | None = None) -> FastAPI:
    _configure_logging()
    settings = settings or load_settings()

    # 生产禁用 /docs、/redoc、/openapi.json(减少攻击面;本地/测试可开)。
    expose_docs = settings.auth_mode == "local"
    app = FastAPI(
        title="VivaVoce Orchestrator API",
        version="0.1.0",
        description="VivaVoce control plane (real-time voice oral-exam). All /api/* endpoints require authentication.",
        docs_url="/docs" if expose_docs else None,
        redoc_url="/redoc" if expose_docs else None,
        openapi_url="/openapi.json" if expose_docs else None,
    )
    app.state.settings = settings
    app.state.verifier = CognitoVerifier(settings)
    app.state.db = Db(settings)
    # 录音访问层(design contract):按 session_id 推导固定 S3 key,按需生成限时预签名回放 URL。
    from .recording import RecordingStore

    app.state.recordings = RecordingStore(settings)
    # per-client 限流器(design contract):API client 细粒度令牌桶(进程内;WAF 已做粗粒度)。
    from .rate_limit import TokenBucketLimiter

    app.state.api_rate_limiter = TokenBucketLimiter()

    app.include_router(health.router)
    # 前端运行时配置(公开,与 /health 同类;去 CDN 拍板后由动态渲染取代 S3 config.json)
    app.include_router(frontend_config.router)
    # MCP OAuth 发现端点(design contract,RFC 9728/8414;/.well-known/* 公开发现文档,D9 已登记豁免)
    app.include_router(well_known.router)
    # MCP OAuth facade(design contract full facade:假 DCR /register + HMAC state /oauth/*;client 零配置不填 client_id;
    # app 层公开路由 D9 已登记豁免——只搬 OAuth 握手字节 / 回预建公开 client_id,facade 不自签 token)
    app.include_router(mcp_facade.router)
    app.include_router(me.router)
    app.include_router(agents.router)  # Agent(design contract,取代 Profile;人设/rubric/引擎/出题策略)
    app.include_router(questionbanks.router)  # 可复用题库(design contract,admin-only)
    app.include_router(sessions.router)
    app.include_router(results.router)
    app.include_router(llm_status.router)  # 登录用户可读的 LLM 凭据非密到期状态(work item)
    app.include_router(admin_capacity.router)  # GPU 容量管理(v1,design contract;admin-only)
    app.include_router(admin_tts.router)  # MiniMax TTS provider 配置(v1,design contract;admin-only)
    app.include_router(admin_llm.router)  # 三段式 LLM 配置(mantle host/模型清单/token,v1,design contract;admin-only)
    app.include_router(admin_settings.router)  # 运行时诊断配置只读总览(design contract;admin-only)
    app.include_router(candidate.hr_router)  # 候选人自助 HR 侧:时段池/签链接(v2,design contract;admin-only)
    app.include_router(candidate.cand_router)  # 候选人侧:token 鉴权选时段/状态/取消(v2,design contract)
    app.include_router(integration.admin_router)  # API client 管理(v2,design contract;admin-only)
    app.include_router(integration.api_router)  # 机器程序化访问(v2,design contract;API Key + scope)
    app.include_router(integration.deleg_router)  # staff 自助委托第三方 agent(v2,design contract)
    app.include_router(mcp.router)  # MCP 协议端点 /api/mcp(v2,design contract;委托 token 鉴权)

    # 前端静态托管 —— **必须在全部 include_router 之后 mount**:Starlette 路由按注册顺序匹配,
    # 已注册的显式路由(/health、/api/*、/config.json、/.well-known/*、/rt/* 等)永远先命中,
    # 根 mount 只接住剩余路径,不遮挡任何 API。
    _mount_static(app, settings)
    return app


def _mount_static(app: FastAPI, settings: Settings) -> None:
    """把前端静态导出(frontend/out → 镜像 ./static)挂到 '/'(html=True)。

    - 目录不存在(本地 uvicorn 直跑、纯 API 测试)→ 优雅缺席:只打 warning,API 照常。
    - html=True:'/' 自动回 index.html;前端是 hash 路由(design contract),刷新任何 #/x 天然命中
      index.html,无需 SPA fallback 改写。
    - D9:静态资源是具名公开路由(与 /health 同类)——只吐随镜像烘入的前端产物,无受保护数据。
    """
    static_dir = Path(settings.static_dir) if settings.static_dir else _DEFAULT_STATIC_DIR
    if not static_dir.is_dir():
        logging.getLogger("aim.main").warning(
            "前端静态目录不存在(%s),跳过静态托管 —— 本地开发/纯 API 形态,API 不受影响", static_dir
        )
        return
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="frontend")


# uvicorn 入口:`uvicorn app.main:app`
app = create_app()
