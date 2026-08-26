# AIM Orchestrator API — FastAPI on Python 3.12 + 前端静态产物托管(设计决策,VISION §2)。
#
# **build context = 仓库根**(非 backend/):CDK DockerImageAsset 用 directory=<仓库根> +
# file='backend/Dockerfile';本地构建等价命令 `docker build -f backend/Dockerfile <仓库根>`。
# 所有 COPY 路径均以仓库根为基准(backend/... 与 frontend/...);context 体积由根 .dockerignore 控制。
#
# 多阶段:①node 阶段构建 frontend(Next.js 静态导出 out/,design contract);②最终镜像 COPY 进 ./static,
# 由 FastAPI StaticFiles 挂根托管(app/main.py::_mount_static)——去 CloudFront + S3 后前端随 backend 容器走。
# 目标架构由构建方(CDK DockerImageAsset platform / buildx --platform)控制,不在此硬编码。

# 镜像源 build-arg(区域构建加速,默认空 = 官方源):中国区构建机 docker.io/pypi.org/npm
# 跨境慢,构建时传 NPM_REGISTRY(如 https://registry.npmmirror.com)+ PIP_INDEX_URL
# (如 https://pypi.tuna.tsinghua.edu.cn/simple)。CDK 从 env AIM_NPM_REGISTRY / AIM_PIP_INDEX_URL 透传。
# 默认空 → 官方源(Global 部署零变化)。
ARG NPM_REGISTRY=
ARG PIP_INDEX_URL=

# ── 阶段 1:前端静态导出(frontend/out)──
FROM node:22-slim AS frontend-build
ARG NPM_REGISTRY

# 保持 /repo/{backend,frontend} 相对布局:frontend 的 prebuild(sync-openapi)按相对路径
# 读 ../backend/openapi.json 拷进 public/(前端据 OpenAPI 契约做运行时自检)。
WORKDIR /repo/frontend

# 先只拷 lockfile 装依赖,让 npm ci 层最大化缓存命中(改前端源码不重装依赖)。
COPY frontend/package.json frontend/package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm ci

COPY backend/openapi.json /repo/backend/openapi.json
COPY frontend/next.config.js frontend/tsconfig.json ./
COPY frontend/public ./public
COPY frontend/app ./app
COPY frontend/src ./src

# 静态导出到 out/(next.config.js output:'export');禁用遥测避免构建期外呼。
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── 阶段 2:后端运行镜像 ──
FROM python:3.12-slim AS base
ARG PIP_INDEX_URL

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir ${PIP_INDEX_URL:+--index-url "$PIP_INDEX_URL"} \
    ${PIP_INDEX_URL:+--trusted-host $(echo "$PIP_INDEX_URL" | sed -E 's#https?://([^/]+).*#\1#')} \
    -r requirements.txt

COPY backend/app ./app
# 前端静态产物 → ./static(app/main.py 默认从 <backend>/static 挂载;/config.json 走动态路由,
# 产物里的占位 config.json 被显式路由遮蔽,不生效)。
COPY --from=frontend-build /repo/frontend/out ./static

EXPOSE 8000

# 非 root 运行(ECS2 安全硬化)
RUN useradd --create-home --uid 10001 appuser
USER appuser

# 健康检查与 ALB 一致(/health 开放,无需鉴权)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
