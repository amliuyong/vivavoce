# VivaVoce GPU inference (ASR + TTS) — streaming WebSocket service
#
# 两个 target:
#   stub  (默认):python-slim,AIM_GPU_BACKEND=stub —— 无 GPU 也能起,本地/CI/快验
#   gpu          :CUDA base + 真实模型(FunASR ASR + ChatTTS/OmniVoice TTS),AIM_GPU_BACKEND=funasr
# CDK 真实部署到 G6E 用 `--target gpu`;本地冒烟用默认 stub。

# 全局 ARG:必须在所有 FROM 之前声明,否则在某个 stage 的 FROM 里引用为空(多 stage 作用域规则)。
# DLC base = AWS Deep Learning Container PyTorch GPU 镜像。注:763104351884 是 **AWS 官方 DLC
# 公共发布账号**(所有 AWS 用户拉 DLC 都用它,非本项目账号、非敏感信息;见 AWS deep-learning-containers 文档)。
# buildspec 按构建 region 覆写此 arg(--build-arg DLC_BASE=...${region}...),默认 us-east-1。
ARG DLC_BASE=763104351884.dkr.ecr.us-east-1.amazonaws.com/pytorch-inference:2.6.0-gpu-py312-cu124-ubuntu22.04-ec2-v1.70
ARG PIP_INDEX_URL=
ARG NPM_REGISTRY=

# ── stub target(轻量,默认)──
FROM python:3.12-slim AS stub
ARG PIP_INDEX_URL
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 AIM_GPU_BACKEND=stub
WORKDIR /srv
COPY pyproject.toml .
COPY gpu_service ./gpu_service
RUN pip install --no-cache-dir ${PIP_INDEX_URL:+--index-url "$PIP_INDEX_URL"} \
    ${PIP_INDEX_URL:+--trusted-host $(echo "$PIP_INDEX_URL" | sed -E 's#https?://([^/]+).*#\1#')} .
EXPOSE 8080
RUN useradd --create-home --uid 10002 gpusvc
USER gpusvc
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/readyz').status==200 else 1)"
CMD ["uvicorn", "gpu_service.server:app", "--host", "0.0.0.0", "--port", "8080"]

# ── gpu target(真实模型,部署 G6E)──
# base = AWS Deep Learning Container(PyTorch 2.6 GPU + CUDA12.4 + py312)。选它而非 nvidia/cuda 因:
#   ① 在 AWS ECR(763104351884),CodeBuild 拉取无 Docker Hub 429 限流;
#   ② 已含 CUDA + torch + torchaudio(省掉最大的 torch 安装层,构建快很多)。
# buildspec 在 pre_build 登录该 DLC ECR。FunASR 模型首启从 ModelScope 拉(数 GB),readiness 给足启动宽限。
FROM ${DLC_BASE} AS gpu
ARG PIP_INDEX_URL
# 模型权重锚定到镜像内固定路径 AIM_MODEL_ROOT;build 期从 S3 同步到这里,runtime 命中同路径不触网。
# vendor/omnivoice(真 OmniVoice 源码)纳入 PYTHONPATH 供 import。
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 \
    AIM_GPU_BACKEND=funasr AIM_TTS_IMPL=omnivoice \
    AIM_MODEL_ROOT=/opt/aim-models \
    PYTHONPATH=/srv/vendor \
    DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 curl && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY pyproject.toml .
COPY gpu_service ./gpu_service
COPY vendor ./vendor
# torch 已在 DLC,只装本服务 + 真实模型 extras(funasr/modelscope + OmniVoice 推理依赖)
# PIP_INDEX_URL(区域构建加速,默认空=官方源):中国区构建机传清华源避免跨境超时。
RUN pip install --no-cache-dir ${PIP_INDEX_URL:+--index-url "$PIP_INDEX_URL"} \
    ${PIP_INDEX_URL:+--trusted-host $(echo "$PIP_INDEX_URL" | sed -E 's#https?://([^/]+).*#\1#')} \
    ".[models]"
# ★ 模型权重:buildspec 在 build 前已 `aws s3 sync` 到 gpu/_models/(CodeBuild host 有 role 凭证;
#   docker build 容器内无凭证故不能在 Dockerfile 内 sync)。这里 COPY 进镜像 /opt/aim-models。
#   权重须先由 `scripts/viva models` 上传到当前部署账号的同区 S3,
#   CodeBuild 再从该桶拉取。模型权重及其分发授权不属于本仓库。
#   runtime 加载用本地路径,readyz 数十秒就绪(不再运行时拉权重 → 不超 ECS 就绪窗口)。
COPY _models /opt/aim-models
EXPOSE 8080
# 真实模型加载耗时长(拉权重 + 上显存)。注:此 Docker 层 HEALTHCHECK 仅本地 docker run 生效;
# ECS 用 container definition 的 healthCheck(startPeriod 硬上限 300s)覆盖它。两者保持一致用 300s。
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8080/readyz || exit 1
# DLC base 是 py312,用 python(非 python3.11);DLC 的 python 即 3.12
CMD ["python", "-m", "uvicorn", "gpu_service.server:app", "--host", "0.0.0.0", "--port", "8080"]
