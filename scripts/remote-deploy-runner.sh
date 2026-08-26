#!/usr/bin/env bash
# shellcheck disable=SC2016
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

DO_DEPLOY=0
SKIP_E2E=0
E2E_WAV=""
ALLOW_DESTRUCTIVE=0
ALLOW_SECURITY_CHANGES=0
STAGE_FILE="$ROOT_DIR/.remote-deploy-stage"
RC_FILE="$ROOT_DIR/.remote-deploy.rc"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/remote-deploy-runner.sh [--deploy] [--skip-e2e]
      [--e2e-wav <remote-wav>] [--allow-destructive]
      [--allow-security-changes]

This command runs inside an exact-commit remote release directory. Use
`./scripts/viva remote-deploy` from the source workstation instead of invoking
it directly.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

write_stage() {
  printf '%s\n' "$1" >"$STAGE_FILE"
  chmod 600 "$STAGE_FILE"
  printf 'REMOTE_STAGE: %s\n' "$1"
}

finish() {
  local rc=$?
  if (( rc != 0 )); then
    write_stage "failed"
  fi
  printf '%s\n' "$rc" >"$RC_FILE"
  chmod 600 "$RC_FILE"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy) DO_DEPLOY=1; shift ;;
    --skip-e2e) SKIP_E2E=1; shift ;;
    --e2e-wav) E2E_WAV="$2"; shift 2 ;;
    --allow-destructive) ALLOW_DESTRUCTIVE=1; shift ;;
    --allow-security-changes) ALLOW_SECURITY_CHANGES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
trap finish EXIT

cd "$ROOT_DIR"
umask 077
viva_load_env required

for command_name in aws curl flock jq node npm python3 timeout; do
  command -v "$command_name" >/dev/null 2>&1 \
    || die "missing required command: $command_name"
done

lock_file="$(dirname "$ROOT_DIR")/.vivavoce-deploy.lock"
exec 9>"$lock_file"
flock -n 9 || die "another VivaVoce remote plan or deployment is running"

region="${AWS_REGION:?AWS_REGION is required}"
stack="${VIVA_STACK_NAME:-Voce}"
account="$(aws sts get-caller-identity --region "$region" --query Account --output text)"
[[ -n "${VIVA_EXPECT_ACCOUNT:-}" ]] \
  || die "VIVA_EXPECT_ACCOUNT is required for remote deployment"
[[ "$account" == "$VIVA_EXPECT_ACCOUNT" ]] \
  || die "active AWS account does not match VIVA_EXPECT_ACCOUNT"
[[ -n "${VIVA_GPU_IMAGE_TAG:-}" ]] \
  || die "VIVA_GPU_IMAGE_TAG must be pinned for reproducible remote deployment"

session_table="${stack}-Sessions"
inflight_sessions() {
  aws dynamodb query \
    --region "$region" \
    --table-name "$session_table" \
    --index-name StatusIndex \
    --key-condition-expression '#status = :value' \
    --expression-attribute-names '{"#status":"status"}' \
    --expression-attribute-values '{":value":{"S":"in_progress"}}' \
    --limit 1 \
    --no-paginate \
    --select COUNT \
    --query Count \
    --output text
}

require_no_inflight_sessions() {
  local count
  count="$(inflight_sessions)"
  printf 'REMOTE_CHECK: inflight_sessions=%s\n' "$count"
  [[ "$count" == "0" ]] \
    || die "active sessions exist; wait for them to finish before deployment"
}

write_stage "preflight"
require_no_inflight_sessions
VIVA_PLAN_DIR="$(dirname "$ROOT_DIR")/.vivavoce-plans/$(basename "$ROOT_DIR")"
export VIVA_PLAN_DIR
export VIVA_PLAN_REQUIRE_EXISTING_STACK=1
(( ALLOW_DESTRUCTIVE == 1 )) && export VIVA_PLAN_ALLOW_DESTRUCTIVE=1
(( ALLOW_SECURITY_CHANGES == 1 )) \
  && export VIVA_PLAN_ALLOW_SECURITY_CHANGES=1
# CDK asset staging must preserve executable directory bits for non-root
# containers. Private orchestration files are protected by their parent
# directory and explicit chmod calls.
umask 022
./scripts/viva plan

if (( DO_DEPLOY == 0 )); then
  write_stage "planned"
  exit 0
fi

require_no_inflight_sessions
write_stage "deploying"
export VIVA_AUTO_APPROVE=1
./scripts/viva deploy

# Post-deployment evidence can include environment-specific diagnostics.
umask 077
write_stage "waiting-for-services"
for cluster in "${stack}-cluster" "${stack}-gpu"; do
  services="$(aws ecs list-services \
    --region "$region" \
    --cluster "$cluster" \
    --query 'serviceArns[]' \
    --output text)"
  [[ -n "$services" && "$services" != "None" ]] \
    || die "no ECS services found in $cluster"
  # shellcheck disable=SC2086
  aws ecs wait services-stable \
    --region "$region" \
    --cluster "$cluster" \
    --services $services
done

wait_for_targets() {
  local deadline now all_healthy service desired running pending rollout groups group
  local healthy total non_healthy
  deadline=$((SECONDS + ${VIVA_REMOTE_DRAIN_TIMEOUT_SECONDS:-600}))
  while (( SECONDS < deadline )); do
    all_healthy=1
    services="$(aws ecs list-services \
      --region "$region" \
      --cluster "${stack}-cluster" \
      --query 'serviceArns[]' \
      --output text)"
    for service in $services; do
      read -r desired running pending rollout <<<"$(
        aws ecs describe-services \
          --region "$region" \
          --cluster "${stack}-cluster" \
          --services "$service" \
          --query 'services[0].[desiredCount,runningCount,pendingCount,deployments[0].rolloutState]' \
          --output text
      )"
      if [[ "$desired" != "$running" || "$pending" != "0" || "$rollout" != "COMPLETED" ]]; then
        all_healthy=0
      fi
      groups="$(aws ecs describe-services \
        --region "$region" \
        --cluster "${stack}-cluster" \
        --services "$service" \
        --query 'services[0].loadBalancers[].targetGroupArn' \
        --output text)"
      [[ -z "$groups" || "$groups" == "None" ]] && continue
      for group in $groups; do
        read -r healthy total non_healthy <<<"$(
          aws elbv2 describe-target-health \
            --region "$region" \
            --target-group-arn "$group" \
            --output json \
          | jq -r '[
              ([.TargetHealthDescriptions[]
                | select(.TargetHealth.State == "healthy")] | length),
              (.TargetHealthDescriptions | length),
              ([.TargetHealthDescriptions[]
                | select(.TargetHealth.State != "healthy")] | length)
            ] | @tsv'
        )"
        if [[ "$healthy" != "$desired" || "$total" != "$desired" || "$non_healthy" != "0" ]]; then
          all_healthy=0
        fi
      done
    done
    if (( all_healthy == 1 )); then
      printf 'REMOTE_CHECK: targets=healthy_only\n'
      return 0
    fi
    sleep 15
  done
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  die "targets did not become healthy-only before timeout at $now"
}

write_stage "verifying"
stack_status="$(aws cloudformation describe-stacks \
  --region "$region" \
  --stack-name "$stack" \
  --query 'Stacks[0].StackStatus' \
  --output text)"
[[ "$stack_status" == "CREATE_COMPLETE" || "$stack_status" == "UPDATE_COMPLETE" ]] \
  || die "stack is not complete: $stack_status"
wait_for_targets

base_url="$(aws cloudformation describe-stacks \
  --region "$region" \
  --stack-name "$stack" \
  --query 'Stacks[0].Outputs[?contains(OutputKey, `PublicEntryFrontendUrl`)].OutputValue | [0]' \
  --output text)"
[[ "$base_url" == https://* ]] || die "public HTTPS output is missing"
curl -fsS --max-time 30 "${base_url%/}/health" >.remote-health.json
jq -e '.status == "ok"' .remote-health.json >/dev/null
source_hash="$(sha256sum frontend/public/pcm-playback-worklet.js | cut -d' ' -f1)"
live_hash="$(
  curl -fsS --max-time 30 "${base_url%/}/pcm-playback-worklet.js" \
  | sha256sum \
  | cut -d' ' -f1
)"
[[ "$source_hash" == "$live_hash" ]] || die "live worklet does not match source"
python3 tools/check-deploy-flags.py \
  --task-def "${stack}-rt-session" \
  --region "$region"

e2e_status="skipped"
e2e_pcm_bytes=0
e2e_session_status="skipped"
if (( SKIP_E2E == 0 )); then
  [[ -n "$E2E_WAV" ]] || E2E_WAV="${VIVA_REMOTE_E2E_WAV:-}"
  [[ "$E2E_WAV" == /* && -r "$E2E_WAV" ]] \
    || die "set VIVA_REMOTE_E2E_WAV to a readable absolute 24 kHz PCM16 WAV"
  [[ -n "${VIVA_E2E_KEY:-}" ]] \
    || die "VIVA_E2E_KEY is required for the remote audio check"

  python3 - "$E2E_WAV" <<'PY'
import sys
import wave

with wave.open(sys.argv[1], "rb") as source:
    assert source.getnchannels() == 1
    assert source.getsampwidth() == 2
    assert source.getframerate() == 24_000
PY

  example_dir="$ROOT_DIR/examples/openai-realtime-sdk"
  (
    cd "$example_dir"
    npm ci --no-audit --no-fund >"$ROOT_DIR/.remote-e2e-npm.log" 2>&1
  )
  export VIVA_API_BASE="$base_url"
  export VIVA_API_KEY="$VIVA_E2E_KEY"
  e2e_key="remote-${SOURCE_COMMIT:-$(cat .source-commit)}-$(date -u +%Y%m%dT%H%M%S)"
  create_status="$(
    curl -sS --max-time 30 \
      -o .remote-e2e-session.json \
      -w '%{http_code}' \
      -X POST "${base_url%/}/api/integration/sessions" \
      -H "X-Api-Key: $VIVA_API_KEY" \
      -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $e2e_key" \
      --data '{"agent_id":"agent_freechat_default","question_bank_id":null}'
  )"
  [[ "$create_status" == "201" || "$create_status" == "200" ]] \
    || die "online test session creation failed with HTTP $create_status"
  export VIVA_SESSION_ID
  VIVA_SESSION_ID="$(jq -r '.session_id // empty' .remote-e2e-session.json)"
  [[ -n "$VIVA_SESSION_ID" ]] || die "online test session id is missing"

  set +e
  (
    cd "$example_dir"
    timeout 240s bash -c '
      python3 - "$1" <<'"'"'PY'"'"' | node node.mjs > "$2/.remote-e2e-output.pcm" 2> "$2/.remote-e2e-node.log"
import sys
import wave

with wave.open(sys.argv[1], "rb") as source:
    sys.stdout.buffer.write(source.readframes(source.getnframes()))
PY
    ' _ "$E2E_WAV" "$ROOT_DIR"
  )
  e2e_rc=$?
  set -e
  e2e_pcm_bytes="$(stat -c %s .remote-e2e-output.pcm 2>/dev/null || echo 0)"
  [[ "$e2e_rc" == "0" && "$e2e_pcm_bytes" -ge 1000 ]] \
    || die "online audio check failed"
  e2e_session_status="$(aws dynamodb get-item \
    --region "$region" \
    --table-name "$session_table" \
    --key "{\"session_id\":{\"S\":\"$VIVA_SESSION_ID\"}}" \
    --query 'Item.status.S' \
    --output text)"
  [[ "$e2e_session_status" == "completed" ]] \
    || die "online test session did not complete"
  e2e_status="passed"
  printf 'REMOTE_CHECK: online_audio_e2e=passed bytes=%s\n' "$e2e_pcm_bytes"
fi

backend_revision="$(aws ecs describe-task-definition \
  --region "$region" \
  --task-definition "${stack}-backend" \
  --query 'taskDefinition.revision' \
  --output text)"
realtime_revision="$(aws ecs describe-task-definition \
  --region "$region" \
  --task-definition "${stack}-rt-session" \
  --query 'taskDefinition.revision' \
  --output text)"
gpu_revision="$(aws ecs describe-task-definition \
  --region "$region" \
  --task-definition "${stack}-gpu-inference" \
  --query 'taskDefinition.revision' \
  --output text)"

jq -n \
  --arg commit "$(cat .source-commit)" \
  --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg stack_status "$stack_status" \
  --arg backend_revision "$backend_revision" \
  --arg realtime_revision "$realtime_revision" \
  --arg gpu_revision "$gpu_revision" \
  --arg e2e_status "$e2e_status" \
  --arg e2e_session_status "$e2e_session_status" \
  --argjson e2e_pcm_bytes "$e2e_pcm_bytes" \
  --slurpfile plan "$VIVA_PLAN_DIR/summary.json" \
  '{
    commit: $commit,
    completed_at: $completed_at,
    stack_status: $stack_status,
    services: {
      backend_revision: $backend_revision,
      realtime_revision: $realtime_revision,
      gpu_revision: $gpu_revision
    },
    checks: {
      health: "ok",
      worklet_hash: "match",
      targets: "healthy_only",
      runtime_flags: "pass",
      online_audio_e2e: $e2e_status,
      e2e_session_status: $e2e_session_status,
      e2e_pcm_bytes: $e2e_pcm_bytes
    },
    plan: $plan[0]
  }' >.deployment-evidence.json
chmod 600 .remote-* .deployment-evidence.json .source-commit 2>/dev/null || true
write_stage "complete"
