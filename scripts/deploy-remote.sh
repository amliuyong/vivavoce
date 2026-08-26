#!/usr/bin/env bash
# shellcheck disable=SC2029
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

DO_DEPLOY=0
SKIP_E2E=0
ALLOW_DESTRUCTIVE=0
ALLOW_SECURITY_CHANGES=0
SKIP_CI=0
REMOTE_HOST=""
REMOTE_BASE_DIR=""
REMOTE_ACTIVE_LINK=""
REMOTE_CONFIG_DIR=""
REMOTE_E2E_WAV=""
DEPLOY_REF="origin/main"

usage() {
  cat <<'EOF'
VivaVoce exact-commit remote deployment

Usage:
  ./scripts/viva remote-deploy
  ./scripts/viva remote-deploy --yes

Options:
  --host <ssh-host>             Override VIVA_REMOTE_HOST
  --base-dir <absolute-path>    Override VIVA_REMOTE_BASE_DIR
  --active-link <absolute-path> Override VIVA_REMOTE_ACTIVE_LINK
  --config-dir <absolute-path>  Remote directory containing .env files
  --e2e-wav <absolute-path>     Remote 24 kHz mono PCM16 WAV for online check
  --ref <git-ref>               Deploy this ref (default origin/main)
  --yes                         Execute deployment; without it only plan
  --skip-e2e                    Skip the online audio check
  --allow-security-changes      Permit IAM/security-group changes in the plan
  --allow-destructive           Permit removals and non-task replacements
  --skip-ci                     Skip the successful-CI requirement
  -h, --help                    Show help

Remote settings belong in the ignored .env.region file. The remote release
copies .env and .env.region from the previous active/config directory; it never
puts their values in Git or command output.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

validate_host() {
  [[ "$1" =~ ^[A-Za-z0-9._:@-]+$ ]] \
    || die "remote host contains unsupported characters"
}

validate_remote_path() {
  local path="$1"
  [[ "$path" == /* ]] || die "remote paths must be absolute: $path"
  [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    || die "remote path contains unsupported characters: $path"
  [[ "$path" != *"/../"* && "$path" != */.. && "$path" != *"/./"* ]] \
    || die "remote path must not contain dot traversal: $path"
  [[ "$path" != "/" ]] || die "remote path must not be filesystem root"
}

viva_load_env optional
REMOTE_HOST="${VIVA_REMOTE_HOST:-}"
REMOTE_BASE_DIR="${VIVA_REMOTE_BASE_DIR:-}"
REMOTE_ACTIVE_LINK="${VIVA_REMOTE_ACTIVE_LINK:-}"
REMOTE_CONFIG_DIR="${VIVA_REMOTE_CONFIG_DIR:-}"
REMOTE_E2E_WAV="${VIVA_REMOTE_E2E_WAV:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) REMOTE_HOST="$2"; shift 2 ;;
    --base-dir) REMOTE_BASE_DIR="$2"; shift 2 ;;
    --active-link) REMOTE_ACTIVE_LINK="$2"; shift 2 ;;
    --config-dir) REMOTE_CONFIG_DIR="$2"; shift 2 ;;
    --e2e-wav) REMOTE_E2E_WAV="$2"; shift 2 ;;
    --ref) DEPLOY_REF="$2"; shift 2 ;;
    --yes) DO_DEPLOY=1; shift ;;
    --skip-e2e) SKIP_E2E=1; shift ;;
    --allow-security-changes) ALLOW_SECURITY_CHANGES=1; shift ;;
    --allow-destructive) ALLOW_DESTRUCTIVE=1; shift ;;
    --skip-ci) SKIP_CI=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$REMOTE_HOST" ]] || die "set VIVA_REMOTE_HOST or pass --host"
[[ -n "$REMOTE_BASE_DIR" ]] \
  || die "set VIVA_REMOTE_BASE_DIR or pass --base-dir"
[[ -n "$REMOTE_ACTIVE_LINK" ]] \
  || die "set VIVA_REMOTE_ACTIVE_LINK or pass --active-link"
[[ -n "$REMOTE_CONFIG_DIR" ]] || REMOTE_CONFIG_DIR="$REMOTE_ACTIVE_LINK"
if (( SKIP_E2E == 0 )); then
  [[ -n "$REMOTE_E2E_WAV" ]] \
    || die "set VIVA_REMOTE_E2E_WAV or pass --skip-e2e"
fi

validate_host "$REMOTE_HOST"
validate_remote_path "$REMOTE_BASE_DIR"
validate_remote_path "$REMOTE_ACTIVE_LINK"
validate_remote_path "$REMOTE_CONFIG_DIR"
[[ -z "$REMOTE_E2E_WAV" ]] || validate_remote_path "$REMOTE_E2E_WAV"

for command_name in git gh jq ssh sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 \
    || die "missing required command: $command_name"
done

[[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]] \
  || die "working tree must be clean before remote deployment"

if [[ "$DEPLOY_REF" == "origin/main" ]]; then
  git -C "$ROOT_DIR" fetch --prune origin main
fi
commit="$(git -C "$ROOT_DIR" rev-parse "$DEPLOY_REF^{commit}")"
short_commit="${commit:0:12}"
if [[ "${VIVA_REMOTE_MAIN_ONLY:-1}" == "1" ]]; then
  main_commit="$(git -C "$ROOT_DIR" rev-parse 'origin/main^{commit}')"
  [[ "$commit" == "$main_commit" ]] \
    || die "remote deployment is restricted to origin/main"
fi

ci_run_id=""
if [[ "${VIVA_REMOTE_REQUIRE_CI:-1}" == "1" && "$SKIP_CI" == "0" ]]; then
  ci_json="$(gh run list \
    --workflow ci.yml \
    --commit "$commit" \
    --limit 20 \
    --json databaseId,headSha,status,conclusion)"
  ci_run_id="$(
    jq -r --arg commit "$commit" \
      '[.[] | select(
        .headSha == $commit
        and .status == "completed"
        and .conclusion == "success"
      )][0].databaseId // empty' <<<"$ci_json"
  )"
  [[ -n "$ci_run_id" ]] \
    || die "no successful completed CI run found for $commit"
fi

ssh "$REMOTE_HOST" "
  set -eu
  test -f '$REMOTE_CONFIG_DIR/.env'
  test -f '$REMOTE_CONFIG_DIR/.env.region'
  test \"\$(stat -c %a '$REMOTE_CONFIG_DIR/.env')\" = 600
  test \"\$(stat -c %a '$REMOTE_CONFIG_DIR/.env.region')\" = 600
  test \"\$(pgrep -af 'scripts/viva deploy|scripts/deploy-aws.sh|cdk deploy' \
    | grep -v pgrep | wc -l)\" = 0
"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_name="release-${short_commit}-${timestamp}"
remote_release="$REMOTE_BASE_DIR/$release_name"
validate_remote_path "$remote_release"

work_dir="$(mktemp -d)"
cleanup() {
  rm -f "$work_dir/source.tar.gz"
  rmdir "$work_dir" 2>/dev/null || true
}
trap cleanup EXIT
archive="$work_dir/source.tar.gz"
git -C "$ROOT_DIR" archive \
  --format=tar.gz \
  --output "$archive" \
  "$commit"
archive_hash="$(sha256sum "$archive" | cut -d' ' -f1)"

ssh "$REMOTE_HOST" "
  set -eu
  test ! -e '$remote_release'
  install -d -m 700 '$remote_release'
  umask 077
  cat > '$remote_release/.source.tar.gz'
" <"$archive"

ssh "$REMOTE_HOST" "
  set -eu
  actual_hash=\$(sha256sum '$remote_release/.source.tar.gz' | cut -d' ' -f1)
  test \"\$actual_hash\" = '$archive_hash'
  tar -xzf '$remote_release/.source.tar.gz' -C '$remote_release'
  rm '$remote_release/.source.tar.gz'
  install -m 600 '$REMOTE_CONFIG_DIR/.env' '$remote_release/.env'
  install -m 600 '$REMOTE_CONFIG_DIR/.env.region' '$remote_release/.env.region'
  printf '%s\n' '$commit' > '$remote_release/.source-commit'
  chmod 600 '$remote_release/.source-commit'
"

runner_args=()
(( DO_DEPLOY == 1 )) && runner_args+=(--deploy)
(( SKIP_E2E == 1 )) && runner_args+=(--skip-e2e)
[[ -n "$REMOTE_E2E_WAV" ]] && runner_args+=(--e2e-wav "$REMOTE_E2E_WAV")
(( ALLOW_DESTRUCTIVE == 1 )) && runner_args+=(--allow-destructive)
(( ALLOW_SECURITY_CHANGES == 1 )) \
  && runner_args+=(--allow-security-changes)
printf -v runner_command '%q ' ./scripts/remote-deploy-runner.sh "${runner_args[@]}"

if [[ -n "$ci_run_id" ]]; then
  ssh "$REMOTE_HOST" "
    printf '%s\n' '$ci_run_id' > '$remote_release/.ci-run-id'
    chmod 600 '$remote_release/.ci-run-id'
  "
fi

printf 'REMOTE_RELEASE: %s\n' "$remote_release"
printf 'REMOTE_COMMIT: %s\n' "$commit"

if (( DO_DEPLOY == 0 )); then
  ssh "$REMOTE_HOST" "cd '$remote_release' && $runner_command"
  printf 'REMOTE_RESULT: plan complete; rerun with --yes to deploy\n'
  exit 0
fi

ssh "$REMOTE_HOST" "
  set -eu
  cd '$remote_release'
  test ! -e .remote-deploy.pid
  nohup $runner_command > .remote-deploy.log 2>&1 < /dev/null &
  printf '%s\n' \"\$!\" > .remote-deploy.pid
  chmod 600 .remote-deploy.pid .remote-deploy.log
"

deadline=$((SECONDS + ${VIVA_REMOTE_DEPLOY_TIMEOUT_SECONDS:-3600}))
last_stage=""
ssh_failures=0
remote_rc=""
while (( SECONDS < deadline )); do
  set +e
  status="$(
    ssh "$REMOTE_HOST" "
      cd '$remote_release'
      printf 'stage='
      cat .remote-deploy-stage 2>/dev/null || printf 'starting'
      printf '\nrc='
      cat .remote-deploy.rc 2>/dev/null || true
    " 2>/dev/null
  )"
  status_rc=$?
  set -e
  if (( status_rc != 0 )); then
    ssh_failures=$((ssh_failures + 1))
    (( ssh_failures <= 5 )) || die "lost contact with remote deployment"
    sleep 15
    continue
  fi
  ssh_failures=0
  stage="$(sed -n 's/^stage=//p' <<<"$status")"
  remote_rc="$(sed -n 's/^rc=//p' <<<"$status")"
  if [[ "$stage" != "$last_stage" ]]; then
    printf 'REMOTE_STAGE: %s\n' "$stage"
    last_stage="$stage"
  fi
  [[ -z "$remote_rc" ]] || break
  sleep 15
done

[[ -n "$remote_rc" ]] || die "remote deployment timed out"
if [[ "$remote_rc" != "0" ]]; then
  printf 'REMOTE_RESULT: failed; inspect %s/.remote-deploy.log\n' "$remote_release" >&2
  ssh "$REMOTE_HOST" "
    grep -E 'ERROR:|PLAN BLOCKER:|failed|FAILED' \
      '$remote_release/.remote-deploy.log' \
      | tail -n 30 \
      | sed -E \
          -e 's/[0-9]{12}/<account>/g' \
          -e 's#https?://[^[:space:]]+#<url>#g' \
          -e 's/[[:alnum:]._%+-]+@[[:alnum:].-]+/<email>/g'
  " >&2 || true
  exit "$remote_rc"
fi

next_link="${REMOTE_ACTIVE_LINK}.next-${short_commit}"
validate_remote_path "$next_link"
ssh "$REMOTE_HOST" "
  set -eu
  if test -e '$REMOTE_ACTIVE_LINK' && ! test -L '$REMOTE_ACTIVE_LINK'; then
    echo 'ERROR: active path exists and is not a symlink' >&2
    exit 1
  fi
  rm -f '$next_link'
  ln -s '$remote_release' '$next_link'
  mv -Tf '$next_link' '$REMOTE_ACTIVE_LINK'
"

ssh "$REMOTE_HOST" "
  jq '{
    commit,
    stack_status,
    services,
    checks
  }' '$remote_release/.deployment-evidence.json'
"
printf 'REMOTE_RESULT: deployed and activated %s\n' "$remote_release"
