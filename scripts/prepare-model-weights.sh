#!/usr/bin/env bash
set -euo pipefail

# Upload licensed model weights to the current deployment account.
#
# Source options:
#   VIVA_MODEL_WEIGHTS_DIR=/absolute/path/to/model-bundle
#   VIVA_MODEL_WEIGHTS_URL=<short-lived-presigned-zip-url>
#
# Expected source layout:
#   funasr/...
#   omnivoice/hf-snapshot/model.safetensors

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
viva_load_env optional

REGION="${AWS_REGION:-us-east-1}"
SOURCE_DIR="${VIVA_MODEL_WEIGHTS_DIR:-}"
SOURCE_URL="${VIVA_MODEL_WEIGHTS_URL:-}"
WORK_BASE="${VIVA_WORK_DIR:-${TMPDIR:-/tmp}}"

usage() {
  cat <<'EOF'
Upload licensed model weights to the current deployment account.

Usage:
  ./scripts/viva models
  ./scripts/viva models --source-dir /absolute/path/to/model-bundle
  ./scripts/viva models --url <short-lived-presigned-zip-url>

Configuration:
  VIVA_MODEL_WEIGHTS_DIR
  VIVA_MODEL_WEIGHTS_URL
  VIVA_WORK_DIR
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--profile) export AWS_PROFILE="$2"; shift 2 ;;
    -r|--region) REGION="$2"; shift 2 ;;
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    --url) SOURCE_URL="$2"; shift 2 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR: unknown argument: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v aws >/dev/null 2>&1 || die "aws CLI is required"
[[ -d "$WORK_BASE" ]] || die "work directory does not exist: $WORK_BASE"

if [[ -n "$SOURCE_DIR" && -n "$SOURCE_URL" ]]; then
  die "set only one of VIVA_MODEL_WEIGHTS_DIR or VIVA_MODEL_WEIGHTS_URL"
fi

ACCOUNT="$(aws sts get-caller-identity --region "$REGION" --query Account --output text)" \
  || die "AWS credentials are not valid"
if [[ -n "${VIVA_EXPECT_ACCOUNT:-}" && "$ACCOUNT" != "$VIVA_EXPECT_ACCOUNT" ]]; then
  die "active AWS account does not match VIVA_EXPECT_ACCOUNT"
fi

MODEL_BUCKET="aim-model-weights-${ACCOUNT}-${REGION}"
CAMPPLUS_SENTINEL="funasr/modelscope/iic/speech_campplus_sv_zh-cn_16k-common/campplus_cn_common.bin"

bucket_ready() {
  aws s3api head-object \
    --bucket "$MODEL_BUCKET" \
    --key "omnivoice/hf-snapshot/model.safetensors" \
    --region "$REGION" >/dev/null 2>&1 \
    && aws s3api head-object \
      --bucket "$MODEL_BUCKET" \
      --key "$CAMPPLUS_SENTINEL" \
      --region "$REGION" >/dev/null 2>&1
}

validate_source() {
  local root="$1"
  [[ -d "$root/funasr" ]] || die "source is missing funasr/"
  [[ -f "$root/omnivoice/hf-snapshot/model.safetensors" ]] \
    || die "source is missing omnivoice/hf-snapshot/model.safetensors"
  [[ -f "$root/$CAMPPLUS_SENTINEL" ]] \
    || die "source is missing the CAM++ speaker model"
}

create_or_secure_bucket() {
  if ! aws s3api head-bucket --bucket "$MODEL_BUCKET" --region "$REGION" 2>/dev/null; then
    if [[ "$REGION" == "us-east-1" ]]; then
      aws s3api create-bucket \
        --bucket "$MODEL_BUCKET" \
        --region "$REGION" >/dev/null
    else
      aws s3api create-bucket \
        --bucket "$MODEL_BUCKET" \
        --region "$REGION" \
        --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
    fi
  fi

  aws s3api put-public-access-block \
    --bucket "$MODEL_BUCKET" \
    --region "$REGION" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption \
    --bucket "$MODEL_BUCKET" \
    --region "$REGION" \
    --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":false}]}'
}

upload_source() {
  local root="$1"
  validate_source "$root"
  create_or_secure_bucket
  aws s3 sync "$root/funasr/" "s3://$MODEL_BUCKET/funasr/" \
    --region "$REGION" --only-show-errors
  aws s3 sync "$root/omnivoice/hf-snapshot/" \
    "s3://$MODEL_BUCKET/omnivoice/hf-snapshot/" \
    --region "$REGION" --only-show-errors
}

if bucket_ready; then
  printf 'Model bucket is already ready: s3://%s\n' "$MODEL_BUCKET"
  exit 0
fi

if [[ -n "$SOURCE_DIR" ]]; then
  [[ "$SOURCE_DIR" == /* ]] || die "VIVA_MODEL_WEIGHTS_DIR must be an absolute path"
  upload_source "$SOURCE_DIR"
elif [[ -n "$SOURCE_URL" ]]; then
  command -v curl >/dev/null 2>&1 || die "curl is required for URL bootstrap"
  command -v unzip >/dev/null 2>&1 || die "unzip is required for URL bootstrap"

  WORK_DIR="$(mktemp -d -p "$WORK_BASE" vivavoce-models.XXXXXX)"
  cleanup() {
    rm -rf -- "$WORK_DIR"
  }
  trap cleanup EXIT

  ARCHIVE="$WORK_DIR/model-weights.zip"
  curl --fail --location --retry 3 --output "$ARCHIVE" "$SOURCE_URL" \
    || die "model archive download failed or the URL expired"

  while IFS= read -r entry; do
    if [[ "$entry" == /* || "$entry" == ../* || "$entry" == *"/../"* ]]; then
      die "model archive contains an unsafe path"
    fi
  done < <(unzip -Z1 "$ARCHIVE")

  unzip -q "$ARCHIVE" -d "$WORK_DIR/extracted"
  upload_source "$WORK_DIR/extracted"
else
  die "set VIVA_MODEL_WEIGHTS_DIR or VIVA_MODEL_WEIGHTS_URL in .env"
fi

bucket_ready || die "uploaded model bundle did not pass readiness checks"
printf 'Model weights are ready: s3://%s\n' "$MODEL_BUCKET"
