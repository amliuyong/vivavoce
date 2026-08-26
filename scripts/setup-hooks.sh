#!/usr/bin/env bash
# 一次性启用 git pre-commit hook(.githooks/pre-commit):提交前对暂存的 .py/.ts 跑 ruff/eslint。
# clone 仓库后开发者各自跑一次即可(git hooksPath 是本地配置,不随仓库分发)。
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)"
git -C "$ROOT" config core.hooksPath .githooks
echo "✓ 已启用 pre-commit hook(core.hooksPath=.githooks)"
echo "  提交时自动对暂存的 backend/gpu(.py→ruff) + bridge/infrastructure(.ts→eslint) 跑 lint。"
echo "  跳过单次:git commit --no-verify"
echo "  手动全量 lint:各子项目 'npm run lint'(TS) / '.venv/bin/ruff check <dir>'(PY)"
