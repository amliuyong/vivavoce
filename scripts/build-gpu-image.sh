#!/usr/bin/env bash
#
# Build the GPU image in AWS CodeBuild and push it to ECR.
#
# 流程:打包源码 → S3 → 建/更新 CodeBuild 项目(privileged + amd64)→ start-build → 等完成。
# 产出镜像:<ECR_REGISTRY>/aim-gpu:<tag>,供 gpu-inference CDK 引用(ContainerImage.fromEcrRepository)。
#
# Usage: ./scripts/viva gpu-image -t <tag>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
viva_load_env optional

REGION="${AWS_REGION:-us-east-1}"
TAG="${VIVA_GPU_IMAGE_TAG:-}"

usage() {
  cat <<'EOF'
Build the VivaVoce GPU image in AWS CodeBuild and push it to ECR.

Usage:
  ./scripts/viva gpu-image -t <tag>

Options:
  -p, --profile <name>  AWS CLI profile
  -r, --region <name>   AWS region
  -t, --tag <tag>       Required image tag
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--profile) export AWS_PROFILE="$2"; shift 2 ;;
    -r|--region) REGION="$2"; shift 2 ;;
    -t|--tag) TAG="$2"; shift 2 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) echo "未知参数 $1"; exit 1 ;;
  esac
done

[[ -n "$TAG" ]] || { echo "ERROR: set VIVA_GPU_IMAGE_TAG or pass -t <tag>" >&2; exit 1; }
ACCOUNT="$(aws sts get-caller-identity --region "$REGION" --query Account --output text)"
if [[ -n "${VIVA_EXPECT_ACCOUNT:-}" && "$ACCOUNT" != "$VIVA_EXPECT_ACCOUNT" ]]; then
  echo "ERROR: active AWS account does not match VIVA_EXPECT_ACCOUNT" >&2
  exit 1
fi

# Partition-aware ECR and Deep Learning Container configuration.
case "$REGION" in
  cn-*) PARTITION="aws-cn"; ECR_SUFFIX="amazonaws.com.cn"; DLC_ACCOUNT="727897471807"
        DLC_TAG="2.6.0-gpu-py312-cu124-ubuntu22.04-ec2-v1.74" ;;
  *)    PARTITION="aws";    ECR_SUFFIX="amazonaws.com";    DLC_ACCOUNT="763104351884"
        DLC_TAG="2.6.0-gpu-py312-cu124-ubuntu22.04-ec2-v1.70" ;;
esac
ECR_REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.${ECR_SUFFIX}"
ECR_REPO="aim-gpu"
PROJECT="aim-gpu-image-build"
BUCKET="aim-codebuild-src-${ACCOUNT}-${REGION}"
MODEL_BUCKET="aim-model-weights-${ACCOUNT}-${REGION}"  # 预下载模型权重桶(deployment environment 上传)
ROLE_NAME="aim-gpu-codebuild-role"

echo "==> 账号 $ACCOUNT / region $REGION / tag $TAG"

# 0. 模型权重桶预检 —— buildspec 会从 s3://$MODEL_BUCKET 同步权重 COPY 进镜像;
#    桶名按「账号-region」拼,故每个账号读自己的桶(不是别人的)。**首次在新账号构建必须先备权重**,
#    否则 CodeBuild 在 `aws s3 sync` 阶段失败。这里 fail-fast 给出明确的获取指引(用户要求:
#    缺权重 → 提示如何获取,如喂 presigned URL 给 scripts/prepare-model-weights.sh 播种)。
#    探测两个 sentinel(funasr 关键对象 + omnivoice 主权重),都在才放行。
check_model_weights() {
  local ok=true
  aws s3api head-object --bucket "$MODEL_BUCKET" \
    --key "omnivoice/hf-snapshot/model.safetensors" --region "$REGION" >/dev/null 2>&1 || ok=false
  # funasr 顶层 92 个对象,用 ListObjects 探一个前缀即可(对象名随 modelscope 版本变,不钉死单 key)。
  # ★ 用 --max-keys 1 + KeyCount(单值);勿用 --max-items(会额外输出分页 NextToken 计数 → 多行,整数比较崩)。
  local funasr_n
  funasr_n="$(aws s3api list-objects-v2 --bucket "$MODEL_BUCKET" --prefix "funasr/" \
    --max-keys 1 --query 'KeyCount' --output text --region "$REGION" 2>/dev/null || echo 0)"
  [ "$funasr_n" = "None" ] && funasr_n=0
  [ "${funasr_n:-0}" -ge 1 ] 2>/dev/null || ok=false
  aws s3api head-object --bucket "$MODEL_BUCKET" \
    --key "funasr/modelscope/iic/speech_campplus_sv_zh-cn_16k-common/campplus_cn_common.bin" \
    --region "$REGION" >/dev/null 2>&1 || ok=false
  [ "$ok" = true ]
}

if ! check_model_weights; then
  cat >&2 <<EOF

✗ 模型权重缺失:s3://$MODEL_BUCKET 没有就绪的权重
  (探测 OmniVoice、FunASR 和 CAM++ 必需文件,至少一项缺失)。
  GPU 镜像在 build 期从该桶预下载权重烘进镜像;首次在本账号($ACCOUNT)构建须先备权重。

  Configure one licensed source in .env:
    VIVA_MODEL_WEIGHTS_DIR=/absolute/path/to/model-bundle
    VIVA_MODEL_WEIGHTS_URL=<short-lived-presigned-zip-url>

  Then run:
    ./scripts/viva models

  After the model bucket is ready, run this command again.
EOF
  exit 1
fi
echo "  ✓ 模型权重就绪 s3://$MODEL_BUCKET(funasr + omnivoice/hf-snapshot)"

# 1. 源码桶(head-bucket 须带 --region,否则 cn 分区打错端点误判不存在 → 重复 create 报 BucketAlreadyOwnedByYou)
aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null || \
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    $([ "$REGION" != "us-east-1" ] && echo "--create-bucket-configuration LocationConstraint=$REGION") >/dev/null
echo "  源码桶 $BUCKET"

# 2. CodeBuild service role(自包含创建,最小权限:ECR push + S3 读源 + 日志)
# ★ IAM 虽是全局服务,但 cn 分区须显式 --region(否则 CLI 打 aws 分区全局端点 → InvalidClientTokenId)。
NEW_ROLE="false"
if ! aws iam get-role --role-name "$ROLE_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" --region "$REGION" --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  NEW_ROLE="true"
fi
# 每次都更新 inline policy(确保最小权限策略最新,不留旧的宽 policy)
# ★ ARN 前缀分区感知($PARTITION = aws | aws-cn);DLC pytorch-inference base 账号按分区($DLC_ACCOUNT)。
aws iam put-role-policy --role-name "$ROLE_NAME" --region "$REGION" --policy-name inline --policy-document '{
  "Version":"2012-10-17","Statement":[
    {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:'"$PARTITION"':logs:'"$REGION"':'"$ACCOUNT"':log-group:/aws/codebuild/'"$PROJECT"'*"},
    {"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion"],"Resource":"arn:'"$PARTITION"':s3:::'"$BUCKET"'/*"},
    {"Effect":"Allow","Action":["s3:GetObject","s3:ListBucket"],"Resource":["arn:'"$PARTITION"':s3:::'"$MODEL_BUCKET"'","arn:'"$PARTITION"':s3:::'"$MODEL_BUCKET"'/*"]},
    {"Effect":"Allow","Action":["ecr:GetAuthorizationToken"],"Resource":"*"},
    {"Effect":"Allow","Action":["ecr:CreateRepository","ecr:DescribeRepositories"],"Resource":"*"},
    {"Effect":"Allow","Action":["ecr:BatchCheckLayerAvailability","ecr:CompleteLayerUpload","ecr:InitiateLayerUpload","ecr:PutImage","ecr:UploadLayerPart","ecr:BatchGetImage","ecr:GetDownloadUrlForLayer"],"Resource":"arn:'"$PARTITION"':ecr:'"$REGION"':'"$ACCOUNT"':repository/'"$ECR_REPO"'"},
    {"Effect":"Allow","Action":["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer","ecr:BatchCheckLayerAvailability"],"Resource":"arn:'"$PARTITION"':ecr:'"$REGION"':'"$DLC_ACCOUNT"':repository/pytorch-inference"}
  ]}' >/dev/null
[ "$NEW_ROLE" = "true" ] && { echo "  创建 role $ROLE_NAME(等待 IAM 生效)"; sleep 12; }
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --region "$REGION" --query 'Role.Arn' --output text)"

# 3. 打包源码(gpu/)上传 S3。buildspec 在 gpu/buildspec.yml,下面 source 用相对路径指定。
TMP_ZIP="$(mktemp "${TMPDIR:-/tmp}/vivavoce-gpu-src.XXXXXX.zip")"
cleanup_source_zip() {
  rm -f -- "$TMP_ZIP"
}
trap cleanup_source_zip EXIT
( cd "$ROOT_DIR" && zip -qr "$TMP_ZIP" gpu/ -x '*/.venv/*' '*/__pycache__/*' '*/node_modules/*' )
aws s3 cp "$TMP_ZIP" "s3://$BUCKET/gpu-src.zip" --region "$REGION" >/dev/null
echo "  源码已上传 s3://$BUCKET/gpu-src.zip"
cleanup_source_zip
trap - EXIT

# 4. 建/更新 CodeBuild 项目(amd64 标准镜像 + privileged 跑 docker)
# ENV_VARS:注入分区/DLC 维度(buildspec 据此拼 DLC base host + tag,按分区拉正确 pytorch-inference)。
# PIP_INDEX_URL(可选,区域构建加速):从本机环境透传(中国区传清华源避免 gpu stage pip 跨境超时)。
# Generate JSON with Python so values are escaped correctly.
ENV_VARS="$(AWS_DEFAULT_REGION="$REGION" ECR_REGISTRY="$ECR_REGISTRY" ECR_REPO="$ECR_REPO" \
  IMAGE_TAG="$TAG" AIM_MODEL_BUCKET="$MODEL_BUCKET" AWS_PARTITION="$PARTITION" \
  DLC_ACCOUNT="$DLC_ACCOUNT" DLC_TAG="$DLC_TAG" PIP_INDEX_URL="${AIM_PIP_INDEX_URL:-}" \
  python3 -c '
import json, os
keys = ["AWS_DEFAULT_REGION","ECR_REGISTRY","ECR_REPO","IMAGE_TAG","AIM_MODEL_BUCKET",
        "AWS_PARTITION","DLC_ACCOUNT","DLC_TAG"]
env = [{"name": k, "value": os.environ[k]} for k in keys]
pip = os.environ.get("PIP_INDEX_URL", "")
if pip:
    env.append({"name": "PIP_INDEX_URL", "value": pip})
print(json.dumps(env))
')"
SRC="{\"type\":\"S3\",\"location\":\"$BUCKET/gpu-src.zip\",\"buildspec\":\"gpu/buildspec.yml\"}"
ENV_CFG="{\"type\":\"LINUX_CONTAINER\",\"image\":\"aws/codebuild/amazonlinux2-x86_64-standard:5.0\",\"computeType\":\"BUILD_GENERAL1_LARGE\",\"privilegedMode\":true,\"environmentVariables\":$ENV_VARS}"
ART="{\"type\":\"NO_ARTIFACTS\"}"
# timeout 120min:镜像含构建期预烘焙模型(从 ModelScope/HF 拉数 GB 权重),给足时间(默认 60min 可能不够)
if aws codebuild batch-get-projects --names "$PROJECT" --region "$REGION" --query 'projects[0].name' --output text 2>/dev/null | grep -q "$PROJECT"; then
  aws codebuild update-project --name "$PROJECT" --source "$SRC" --environment "$ENV_CFG" \
    --artifacts "$ART" --service-role "$ROLE_ARN" --timeout-in-minutes 120 --region "$REGION" >/dev/null
else
  aws codebuild create-project --name "$PROJECT" --source "$SRC" --environment "$ENV_CFG" \
    --artifacts "$ART" --service-role "$ROLE_ARN" --timeout-in-minutes 120 --region "$REGION" >/dev/null
fi
echo "  CodeBuild 项目 $PROJECT 就绪"

# 5. start-build + 轮询
BUILD_ID="$(aws codebuild start-build --project-name "$PROJECT" --region "$REGION" --query 'build.id' --output text)"
echo "==> 构建启动 $BUILD_ID(GPU 镜像约 10-20min)"
while true; do
  PHASE="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" --query 'builds[0].currentPhase' --output text)"
  STATUS="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" --query 'builds[0].buildStatus' --output text)"
  echo "  [$PHASE] $STATUS"
  case "$STATUS" in
    SUCCEEDED) echo "✓ GPU 镜像构建成功: $ECR_REGISTRY/$ECR_REPO:$TAG"; exit 0 ;;
    FAILED|FAULT|STOPPED|TIMED_OUT) echo "✗ 构建失败($STATUS),看 CodeBuild 日志"; exit 1 ;;
  esac
  sleep 20
done
