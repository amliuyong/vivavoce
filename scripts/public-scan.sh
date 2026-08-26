#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

failed=0

fail() {
  printf 'PUBLIC-SCAN: %s\n' "$*" >&2
  failed=1
}

for path in .env .env.region; do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    fail "$path is tracked"
  fi
done

while IFS= read -r candidate; do
  fail "local voice or recorded-audio asset would enter Git: $candidate"
done < <(
  git ls-files --cached --others --exclude-standard -- \
    'gpu/gpu_service/assets/voices/*' \
    'backend/tests/fixtures/*.pcm' \
    'backend/tests/fixtures/*.wav' \
  | grep -v '^gpu/gpu_service/assets/voices/README\.md$' || true
)

if find . -mindepth 2 -type d -name .git -print -quit | grep -q .; then
  fail "nested .git directory found"
fi

for path in \
  '*.pem' '*.key' '*.p12' '*.pfx' '*.tfstate' \
  '*.safetensors' '*.onnx' '*.ckpt'; do
  while IFS= read -r candidate; do
    git check-ignore -q "$candidate" && continue
    fail "forbidden file found: $candidate"
  done < <(find . -path './.git' -prune -o -type f -name "$path" -print)
done

if rg -n --hidden -S \
  -e 'AKIA[0-9A-Z]{16}' \
  -e 'ASIA[0-9A-Z]{16}' \
  -e '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----' \
  -e 'gh[pousr]_[A-Za-z0-9_]{20,}' \
  -e 'github_pat_[A-Za-z0-9_]{20,}' \
  -e 'glpat-[A-Za-z0-9_-]{20,}' \
  -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
  -e 'sk-live-[A-Za-z0-9_-]{16,}' \
  --glob '!.git/**' \
  --glob '!scripts/public-scan.sh' \
  .; then
  fail "credential-like content found"
fi

if rg -n --hidden -S \
  -e 'amliuyong' \
  -e 'cn_bj' \
  -e 'my_work_us' \
  -e 'viva\.aws\.' \
  -e 'viva\.awscn\.' \
  -e 'gitlab' \
  -e 'AimV' \
  -e '\.install\.env' \
  -e 'install\.sh' \
  -e 'CLAUDE\.md' \
  -e '\b(?:spec|specs)[ /:#._-]*[0-9]{2,}' \
  -e '\bissue[ /:#._-]*[0-9]+' \
  -e '\b(?:codex|kiro)\b' \
  -e '\bgpu-ec2\b' \
  -e '\bdeploy-bj(?:\.sh)?\b' \
  -e 'task def[[:space:]]*:[0-9]+' \
  -e 'prior-validation' \
  -e 'validated-GPU-environment' \
  -e '用户(?:拍板|确认|指示)' \
  -e '见提交历史' \
  -e '(?:^|[^[:alnum:]_])~/work/' \
  -e '/home/[[:alnum:]_.-]+/' \
  -e 'github_ref/' \
  --glob '!.git/**' \
  --glob '!scripts/public-scan.sh' \
  .; then
  fail "private predecessor or environment marker found"
fi

if rg -n --hidden -S \
  -e '\bsess_[0-9a-f]{12}\b' \
  --glob '!.git/**' \
  --glob '!scripts/public-scan.sh' \
  --glob '!contracts/realtime-client-secret-v1.json' \
  .; then
  fail "production-shaped session identifier found"
fi

python3 tools/check-doc-links.py || failed=1

(( failed == 0 )) || exit 1
printf 'PUBLIC-SCAN: PASS\n'
