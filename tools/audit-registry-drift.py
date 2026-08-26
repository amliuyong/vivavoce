#!/usr/bin/env python3
"""一次性核对工具:把 extract-env-baseline 的机械基线 与 runtime-config.ts 里手抄的 D_* 默认值比对。

用于量化「手抄漂移」的真实规模(仅诊断用;长期守门由 jest 测试承担)。
"""
import re
import pathlib
import subprocess
import json

rc = pathlib.Path("bridge/src/runtime-config.ts").read_text(encoding="utf-8")
base = json.loads(subprocess.run(
    ["python3", "tools/extract-env-baseline.py", "--json"],
    capture_output=True, text=True, check=True).stdout)

# 解析 registry: const D_X = <literal>;  以及 e("AIM_...", ..., D_X) 的映射
consts = {}
for m in re.finditer(r'^const (D_[A-Z0-9_]+)(?::[^=]+)? = (.+?);\s*(?://.*)?$', rc, re.M):
    name, lit = m.group(1), m.group(2).strip()
    if lit in ("true", "false"):
        consts[name] = lit == "true"
    elif lit.startswith('"'):
        consts[name] = lit.strip('"')
    else:
        try:
            consts[name] = float(lit.replace("_", ""))
        except ValueError:
            consts[name] = ("«expr»", lit)

# e("AIM_KEY", value, DEFAULT)
entry_default = {}
for m in re.finditer(r'e\(\s*"(AIM_[A-Z0-9_]+)"\s*,\s*([^,]+?)\s*,\s*([^)]+?)\)', rc, re.S):
    entry_default[m.group(1)] = (m.group(2).strip(), m.group(3).strip())

print(f"{'KEY':46} {'SOURCE(源码)':>16}  {'REGISTRY':>16}  判定")
print("-" * 104)
bad, ok, skipped = [], [], []
for key, (val_expr, def_expr) in sorted(entry_default.items()):
    recs = base.get(key, [])
    lits = [r for r in recs if r.get("default") is not None and r["kind"] != "derived"]
    if not recs:
        skipped.append((key, "源码未抽到(检查是否已删/形态未覆盖)"))
        continue
    if not lits:
        skipped.append((key, f"默认来自 import/derived({recs[0]['kind']})—— 不比数值"))
        continue
    src = lits[0]["default"]
    # registry 侧:若 def_expr 是 D_* 取其字面量;若是 thd.* 则视为 import(不比)
    if def_expr.startswith("D_"):
        reg = consts.get(def_expr, ("«missing»", def_expr))
    else:
        skipped.append((key, f"registry 用 import({def_expr})"))
        continue
    if isinstance(reg, tuple):
        skipped.append((key, f"registry 非字面量 {reg[1]}"))
        continue
    same = (float(src) == float(reg)) if isinstance(reg, (int, float)) and not isinstance(reg, bool) \
        and isinstance(src, (int, float)) and not isinstance(src, bool) else (src == reg)
    mark = "✅" if same else "❌ 不符"
    print(f"{key:46} {str(src):>16}  {str(reg):>16}  {mark}  @{lits[0]['file']}:{lits[0]['line']}")
    (ok if same else bad).append(key)

print(f"\n比对 {len(ok)+len(bad)} 项:✅ {len(ok)} 符 / ❌ {len(bad)} 不符")
if bad:
    print("不符清单:", ", ".join(bad))
print(f"\n未比对 {len(skipped)} 项:")
for k, why in skipped:
    print(f"  - {k}: {why}")
