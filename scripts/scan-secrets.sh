#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-workspace}"

if [[ "$MODE" != "workspace" && "$MODE" != "--history" ]]; then
  printf 'Usage: %s [--history]\n' "$0" >&2
  exit 2
fi

for tool_name in git tar jq gitleaks trufflehog; do
  command -v "$tool_name" >/dev/null 2>&1 || {
    printf 'SECRET-SCAN: missing required tool: %s\n' "$tool_name" >&2
    exit 2
  }
done

# Scan only tracked and non-ignored candidate files. Local .env files, model
# weights, reference voices, recordings, dependencies, and build output never
# enter this snapshot.
SCAN_RUN="$(mktemp -d "${TMPDIR:-/tmp}/vivavoce-secret-scan.XXXXXX")"
SOURCE_DIR="$SCAN_RUN/source"
mkdir "$SOURCE_DIR"

git -C "$ROOT_DIR" ls-files --cached --others --exclude-standard -z \
  | tar -C "$ROOT_DIR" --null --files-from=- -cf - \
  | tar -C "$SOURCE_DIR" -xf -

if find "$SOURCE_DIR" -type f \( -name '.env' -o -name '.env.region' \) \
    -print -quit | grep -q .; then
  printf 'SECRET-SCAN: local environment file entered candidate snapshot\n' >&2
  exit 2
fi

set +e
gitleaks dir "$SOURCE_DIR" \
  --config "$SOURCE_DIR/.gitleaks.toml" \
  --no-banner --no-color --redact=100 --log-level error \
  --report-format json --report-path "$SCAN_RUN/gitleaks.json" \
  >"$SCAN_RUN/gitleaks.stdout" 2>"$SCAN_RUN/gitleaks.stderr"
GITLEAKS_RC=$?

trufflehog filesystem "$SOURCE_DIR" \
  --json --no-update --no-verification --filter-unverified \
  --results=verified,unknown,unverified --fail --fail-on-scan-errors \
  --exclude-paths "$SOURCE_DIR/.trufflehog-exclude-paths" \
  >"$SCAN_RUN/trufflehog.jsonl" 2>"$SCAN_RUN/trufflehog.stderr"
TRUFFLEHOG_RC=$?
set -e

if [[ -s "$SCAN_RUN/gitleaks.json" ]]; then
  GITLEAKS_COUNT="$(jq 'length' "$SCAN_RUN/gitleaks.json")"
else
  GITLEAKS_COUNT=0
fi
TRUFFLEHOG_COUNT="$(wc -l < "$SCAN_RUN/trufflehog.jsonl")"

printf 'SECRET-SCAN: candidate files=%s\n' \
  "$(find "$SOURCE_DIR" -type f | wc -l)"
printf 'SECRET-SCAN: gitleaks rc=%s findings=%s\n' \
  "$GITLEAKS_RC" "$GITLEAKS_COUNT"
printf 'SECRET-SCAN: trufflehog rc=%s findings=%s\n' \
  "$TRUFFLEHOG_RC" "$TRUFFLEHOG_COUNT"

# Never print a detected value. Metadata is enough to locate and review it.
if (( GITLEAKS_COUNT > 0 )); then
  jq -r '.[] | "gitleaks finding: rule=" + .RuleID
    + " file=" + .File + " line=" + (.StartLine|tostring)' \
    "$SCAN_RUN/gitleaks.json"
fi
if (( TRUFFLEHOG_COUNT > 0 )); then
  jq -r '"trufflehog finding: detector=" + (.DetectorName // "unknown")
    + " file=" + (.SourceMetadata.Data.Filesystem.file // "unknown")
    + " line=" + ((.SourceMetadata.Data.Filesystem.line // 0)|tostring)' \
    "$SCAN_RUN/trufflehog.jsonl"
fi

printf 'SECRET-SCAN: private report directory=%s\n' "$SCAN_RUN"

if (( GITLEAKS_COUNT > 0 || TRUFFLEHOG_COUNT > 0 )); then
  exit 1
fi
if (( GITLEAKS_RC != 0 || TRUFFLEHOG_RC != 0 )); then
  printf 'SECRET-SCAN: scanner execution failed; inspect redacted logs in %s\n' \
    "$SCAN_RUN" >&2
  exit 2
fi

if [[ "$MODE" == "--history" ]]; then
  set +e
  gitleaks git "$ROOT_DIR" \
    --log-opts="--all" \
    --config "$ROOT_DIR/.gitleaks.toml" \
    --no-banner --no-color --redact=100 --log-level error \
    --report-format json --report-path "$SCAN_RUN/gitleaks-history.json" \
    >"$SCAN_RUN/gitleaks-history.stdout" \
    2>"$SCAN_RUN/gitleaks-history.stderr"
  GITLEAKS_HISTORY_RC=$?

  trufflehog git "file://$ROOT_DIR" \
    --json --no-update --no-verification --filter-unverified \
    --results=verified,unknown,unverified --fail --fail-on-scan-errors \
    --exclude-paths "$ROOT_DIR/.trufflehog-exclude-paths" \
    >"$SCAN_RUN/trufflehog-history.jsonl" \
    2>"$SCAN_RUN/trufflehog-history.stderr"
  TRUFFLEHOG_HISTORY_RC=$?
  set -e

  if [[ -s "$SCAN_RUN/gitleaks-history.json" ]]; then
    GITLEAKS_HISTORY_COUNT="$(jq 'length' "$SCAN_RUN/gitleaks-history.json")"
  else
    GITLEAKS_HISTORY_COUNT=0
  fi
  TRUFFLEHOG_HISTORY_COUNT="$(wc -l < "$SCAN_RUN/trufflehog-history.jsonl")"

  printf 'SECRET-SCAN: history gitleaks rc=%s findings=%s\n' \
    "$GITLEAKS_HISTORY_RC" "$GITLEAKS_HISTORY_COUNT"
  printf 'SECRET-SCAN: history trufflehog rc=%s findings=%s\n' \
    "$TRUFFLEHOG_HISTORY_RC" "$TRUFFLEHOG_HISTORY_COUNT"

  if (( GITLEAKS_HISTORY_COUNT > 0 )); then
    jq -r '.[] | "gitleaks history finding: rule=" + .RuleID
      + " file=" + .File + " line=" + (.StartLine|tostring)' \
      "$SCAN_RUN/gitleaks-history.json"
  fi
  if (( TRUFFLEHOG_HISTORY_COUNT > 0 )); then
    jq -r '"trufflehog history finding: detector="
      + (.DetectorName // "unknown")
      + " file=" + (.SourceMetadata.Data.Git.file // "unknown")
      + " line=" + ((.SourceMetadata.Data.Git.line // 0)|tostring)' \
      "$SCAN_RUN/trufflehog-history.jsonl"
  fi

  if (( GITLEAKS_HISTORY_COUNT > 0 || TRUFFLEHOG_HISTORY_COUNT > 0 )); then
    exit 1
  fi
  if (( GITLEAKS_HISTORY_RC != 0 || TRUFFLEHOG_HISTORY_RC != 0 )); then
    printf 'SECRET-SCAN: history scanner execution failed; inspect redacted logs in %s\n' \
      "$SCAN_RUN" >&2
    exit 2
  fi
fi

printf 'SECRET-SCAN: PASS\n'
