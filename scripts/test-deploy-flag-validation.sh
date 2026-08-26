#!/usr/bin/env bash
#
# 部署 flag 校验的**负向测试**(design contract / 验收标准 7)。
#
# 为什么需要负向测试:一个「永远通过」的校验和没有校验等价。先前的部署回归的核心教训是
# **失败必须响亮** —— 而 legacy deployment script 原来的成功分支只打印 task def revision,丢了 15 个
# flag 的 `:78` 在那个输出里和正确的 `:76` 一样健康。所以这里逐条注入「已知该被拦的东西」,
# 断言校验真的拦得住、且**不误拦**合法用法。
#
#   ./scripts/test-deploy-flag-validation.sh
#
# 纯离线(用 --env-file,不碰 AWS),可在任何机器跑,适合进 CI。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="$ROOT_DIR/tools/check-deploy-flags.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_red() { printf '\033[31m%s\033[0m\n' "$*"; }

# expect_rc <期望退出码> <用例名> <env 文件内容> [额外参数...]
expect_rc() {
  local want="$1" name="$2" content="$3"; shift 3
  local f="$TMP/env.txt"
  printf '%s\n' "$content" > "$f"
  python3 "$CHECKER" --env-file "$f" "$@" >/dev/null 2>&1
  local got=$?
  if [[ "$got" == "$want" ]]; then
    c_grn "  PASS  $name(退出码 $got)"
    pass=$((pass + 1))
  else
    c_red "  FAIL  $name(期望退出码 $want,实际 $got)"
    fail=$((fail + 1))
  fi
}

echo "==> 部署 flag 校验负向测试(design contract)"

# ── ① A 类:已删开关出现 MUST 硬拒 ────────────────────────────────────────────
# 这两个 key 在 bridge 侧已无 env 读取。设它不会生效,却会让后来者以为「还能开关」——
# 而事故正是「以为 env 能控制行为」的产物。
expect_rc 1 "A 类 AIM_PLAYBACK_ACK_MODE 出现 → 硬拒" \
  'AIM_PLAYBACK_ACK_MODE=enforce'
expect_rc 1 "A 类 AIM_FAREWELL_TTS_DRAIN_ENABLED 出现 → 硬拒" \
  'AIM_FAREWELL_TTS_DRAIN_ENABLED=1'
# 混在一堆合法 env 里也要能揪出来(真实 task def 有 20+ 项)
expect_rc 1 "A 类混在合法 env 中仍被揪出" \
  'AWS_REGION=cn-north-1
AIM_GPU_WS_URL=ws://gpu.local:8080/v1/stream
AIM_PLAYBACK_ACK_MODE=off
RECORDING_BUCKET_NAME=x'

# ── ② B 类:默认放行(kill switch 合法),--forbid-b-class 时硬拒 ──────────────
# B 类**保留** env 覆盖能力(AIM_VIOLATION_ENFORCEMENT 会强制结束会话,误判时须能紧急关)。
# 若这里硬拒,kill switch 就成了不可用 —— 与 design contract 自相矛盾(review)。
expect_rc 0 "B 类 kill switch 临时 export → 放行(不误拦)" \
  'AIM_VIOLATION_ENFORCEMENT=0'
expect_rc 1 "B 类 + --forbid-b-class(CI 模式)→ 硬拒" \
  'AIM_VIOLATION_ENFORCEMENT=0' --forbid-b-class
expect_rc 1 "B 类多项写进清单文件(CI 模式)→ 硬拒" \
  'AIM_EOU_VERDICT_TIMEOUT_MS=6000
AIM_EOU_CORRELATION_MS=7000
AIM_SILENCE_VIOLATION_MS=20000' --forbid-b-class

# ── ③ C 类:确实未标定,标定期需要 env → MUST 放行 ────────────────────────────
# 白名单从 SETTINGS_META 的 calibration_status="pending" **自动派生**(不手工维护,
# 否则它自己会变成第三份可写副本 —— review)。
expect_rc 0 "C 类 AIM_CURSOR_VOICED_GATE(未标定)→ 放行" \
  'AIM_CURSOR_VOICED_GATE=1'
expect_rc 0 "C 类 AIM_BARGE_OPEN_COOLDOWN_MS(未标定)→ 放行" \
  'AIM_BARGE_OPEN_COOLDOWN_MS=500'
expect_rc 0 "C 类 + --forbid-b-class 仍放行(它不是 B 类)" \
  'AIM_CURSOR_VOICED_GATE=1' --forbid-b-class

# ── ④ 干净部署:零运行时 flag → MUST 通过(design contract 的目标态)────────────────
expect_rc 0 "零运行时 flag(design contract 目标态)→ 通过" \
  'AWS_REGION=cn-north-1
AIM_GPU_WS_URL=ws://gpu.local:8080/v1/stream
AIM_CONTROL_CALLBACK_URL=http://api.local:8000/api
RECORDING_BUCKET_NAME=x
SESSION_EVENTS_TABLE_NAME=y'

# ── ⑤ 白名单**真的**从元数据派生(而非硬编码空集造成的假放行)────────────────
# 若 SETTINGS_META 导入失败,白名单会退化为空集 → C 类用例会「因为不在白名单所以放行」,
# 与「因为在白名单所以放行」结果相同、断言分不出来。故显式验白名单非空且含预期项。
echo "  —— 白名单派生自证 ——"
wl="$(python3 "$CHECKER" --print-whitelist 2>/dev/null)"
if grep -q '^AIM_CURSOR_VOICED_GATE$' <<< "$wl"; then
  c_grn "  PASS  C 类白名单确实由 SETTINGS_META 派生(含 AIM_CURSOR_VOICED_GATE)"
  pass=$((pass + 1))
else
  c_red "  FAIL  白名单未含 AIM_CURSOR_VOICED_GATE —— 派生失效,C 类放行是假绿"
  fail=$((fail + 1))
fi

echo
if [[ "$fail" == "0" ]]; then
  c_grn "==> 全部通过(PASS=$pass FAIL=0)"
  exit 0
fi
c_red "==> 有失败(PASS=$pass FAIL=$fail)"
exit 1
