#!/usr/bin/env bash

# Shared local environment loader for VivaVoce scripts.
# shellcheck shell=bash

VIVA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

viva_env_error() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

viva_check_env_permissions() {
  local file="$1"
  local mode

  [[ -f "$file" ]] || return 0
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file" 2>/dev/null)" \
    || { viva_env_error "cannot read permissions for $file"; return 1; }
  mode="${mode: -3}"
  [[ "$mode" =~ ^[0-7]{3}$ ]] \
    || { viva_env_error "cannot validate permissions for $file"; return 1; }

  if (( (8#$mode & 077) != 0 )); then
    viva_env_error "$file permissions are $mode; run: chmod 600 $file"
    return 1
  fi
}

viva_source_env_file() {
  local file="$1"
  local had_allexport=0

  [[ -f "$file" ]] || return 0
  viva_check_env_permissions "$file" || return 1

  case "$-" in
    *a*) had_allexport=1 ;;
  esac
  set -a
  # shellcheck disable=SC1090
  source "$file"
  (( had_allexport == 1 )) || set +a
}

viva_map_env() {
  local public_name="$1"
  local legacy_name="$2"
  local value="${!public_name-}"

  if [[ -n "$value" ]]; then
    export "$legacy_name=$value"
  fi
  return 0
}

viva_export_compatibility_env() {
  viva_map_env VIVA_EXPECT_ACCOUNT AIM_EXPECT_ACCOUNT
  viva_map_env VIVA_CUSTOM_DOMAIN AIM_CUSTOM_DOMAIN
  viva_map_env VIVA_ROUTE53_ZONE_ID AIM_CUSTOM_DOMAIN_ZONE_ID
  viva_map_env VIVA_ROUTE53_ZONE_NAME AIM_CUSTOM_DOMAIN_ZONE_NAME

  viva_map_env VIVA_AUTH_REGION AIM_AUTH_REGION
  viva_map_env VIVA_AUTH_USER_POOL_ID AIM_AUTH_USER_POOL_ID
  viva_map_env VIVA_AUTH_USER_POOL_CLIENT_ID AIM_AUTH_USER_POOL_CLIENT_ID
  viva_map_env VIVA_AUTH_MCP_CLIENT_ID AIM_AUTH_MCP_CLIENT_ID
  viva_map_env VIVA_AUTH_HOSTED_UI_DOMAIN AIM_AUTH_HOSTED_UI_DOMAIN

  viva_map_env VIVA_GPU_INSTANCE_TYPE AIM_GPU_INSTANCE_TYPE
  viva_map_env VIVA_GPU_IMAGE_TAG AIM_GPU_IMAGE_TAG
  viva_map_env VIVA_GPU_SESSIONS_PER_INSTANCE AIM_GPU_SESSIONS_PER_INSTANCE
  viva_map_env VIVA_CONTAINER_ARCH AIM_CONTAINER_ARCH
  viva_map_env VIVA_PIP_INDEX_URL AIM_PIP_INDEX_URL
  viva_map_env VIVA_NPM_REGISTRY AIM_NPM_REGISTRY

  viva_map_env VIVA_MODEL_WEIGHTS_URL AIM_MODEL_WEIGHTS_URL
  viva_map_env VIVA_WORK_DIR AIM_WORK_DIR
  viva_map_env VIVA_MINIMAX_API_KEY AIM_MINIMAX_API_KEY
  viva_map_env VIVA_BEDROCK_API_KEY AWS_BEARER_TOKEN_BEDROCK

  if [[ -n "${AWS_REGION:-}" ]]; then
    export CDK_DEFAULT_REGION="$AWS_REGION"
  fi
  return 0
}

viva_load_env() {
  local mode="${1:-optional}"
  local common_file="$VIVA_ROOT/.env"
  local region_file="$VIVA_ROOT/.env.region"

  if [[ "$mode" == "required" ]]; then
    [[ -f "$common_file" ]] \
      || { viva_env_error "missing .env; copy .env.example to .env"; return 1; }
    [[ -f "$region_file" ]] \
      || { viva_env_error "missing .env.region; copy .env.region.example to .env.region"; return 1; }
  fi

  viva_source_env_file "$common_file" || return 1
  viva_source_env_file "$region_file" || return 1
  viva_export_compatibility_env
  return 0
}

viva_require_env() {
  local name="$1"
  [[ -n "${!name-}" ]] || { viva_env_error "$name is required"; return 1; }
}

viva_report_env() {
  local name
  for name in "$@"; do
    if [[ -n "${!name-}" ]]; then
      printf '  %-35s set\n' "$name"
    else
      printf '  %-35s not set\n' "$name"
    fi
  done
}
