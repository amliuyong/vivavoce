#!/usr/bin/env python3
"""
从 bridge/src/*.ts 机械抽取每个 AIM_* 的**读取形态 + 默认字面量 + 钳制**,产出权威基线。

用途:runtime-config.ts 的 registry 不得靠人转录默认值(实测会漂移)。本脚本是 CI 守门
`runtime-config.baseline.test.ts` 的数据源,也可单独跑做人工复核:

    python3 tools/extract-env-baseline.py            # 人读表格
    python3 tools/extract-env-baseline.py --json     # 机器读

覆盖的读取形态(bridge/src 实测全谱):
  A. num("KEY", DEFAULT) / numEnv("KEY", DEFAULT) / numBounded("KEY", DEFAULT, lo, hi)  —— helper 首参
  B. Number(process.env.KEY ?? DEFAULT)                                                 —— 内联 ??
  C. process.env.KEY ?? "DEFAULT" / process.env.KEY || "DEFAULT"                        —— 字符串兜底
  D. process.env.KEY !== "0"  → 默认开 ; === "1" → 默认关 ; === "0" → 默认开(取反)
  E. IIFE 守卫式:const X = (() => { const raw = Number(process.env.KEY); ... return <default>; })()
     —— 默认值 = return 语句里的字面量(三元的 false 分支 / 单 return)
  F. 独立 helper 函数式:function f() { const raw = Number(process.env.KEY); if (!ok) return D; ... }
     —— 同 E,取 return 的字面量;并抽 Math.min/Math.max 钳制边界
  G. num(env.KEY, DEFAULT, lo, hi, "KEY")  —— playback-settlement 的 fail-fast 形态
  H. **多行** helper 调用(prettier 换行后 key 独占一行):
        num(
          "AIM_X",
          TURN_HANDLING_DEFAULTS.a.b,
          0, 5,
        )
     —— 单行正则抓不到,须先把源码按调用括号规整成逻辑行
  I. 委托解析:const X = parseAckMode(process.env.AIM_PLAYBACK_ACK_MODE)
     —— 默认在被调函数内(`raw ?? "off"`),标 kind="delegated" 并记下被调函数名,
        由 registry 复用同一函数(不比字面量)

**故意不做**的事:不解析派生默认(如 media-session 的 ADVANCE_NUDGE_MS 默认 = SILENCE_VIOLATION_MS*0.4)
—— 那不是字面量,机械抽取会得出错误结论;此类 key 标 kind="derived",由 registry 显式复用源模块函数,
守门测试对它只校验「registry 未手抄字面量」,不比数值。
"""
import argparse
import json
import pathlib
import re
import sys

SRC = pathlib.Path("bridge/src")
# registry 自身不参与抽取(它是被校验方,不是事实源)
SKIP_FILES = {"runtime-config.ts", "config-endpoint.ts"}

KEY = r"(AIM_[A-Z0-9_]+)"
NUMLIT = r"(-?[0-9][0-9_]*(?:\.[0-9]+)?)"

# 单行形态(A/B/C/D/G)
LINE_PATS = [
    # G: num(env.KEY, <默认>, lo, hi, "KEY") —— 带上下界的 fail-fast(playback-settlement)。
    #    默认可为字面量或**引用**(如 ACK_TIMEOUT_DEFAULTS.graceMs,design contract 下沉后的形态)。
    (re.compile(rf'\bnum\(\s*env\.{KEY}\s*,\s*(?:{NUMLIT}|([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+))'), "num_bounded_env"),
    # A: numBounded/intBounded("KEY", DEFAULT_EXPR, lo, hi) —— 默认可能是 TURN_HANDLING_DEFAULTS.x.y(非字面量);
    #    **界也可能是引用**(design contract 修 M9 后:`PLAYBACK_LEAD_BOUNDS.min/.max`),故界用宽松匹配。
    (re.compile(rf'\b(?:numBounded|intBounded)\(\s*"{KEY}"\s*,\s*([^,]+?)\s*,'), "num_bounded"),
    # A: num("KEY", DEFAULT) / numEnv("KEY", DEFAULT) —— DEFAULT 可为字面量或 THD 引用
    (re.compile(rf'\b(?:numEnv|num)\(\s*"{KEY}"\s*,\s*([^,)]+?)\s*[,)]'), "num"),
    # B: Number(process.env.KEY ?? 12000)
    (re.compile(rf'Number\(\s*process\.env\.{KEY}\s*\?\?\s*{NUMLIT}\s*\)'), "num_inline"),
    # B': Number(process.env.KEY) || 60_000  —— 注意 0 也会取默认(与 ?? 语义不同,如实记录)
    (re.compile(rf'Number\(\s*process\.env\.{KEY}\s*\)\s*\|\|\s*(?:{NUMLIT}|([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*))'), "num_or"),
    # C: process.env.KEY || "文本" / ?? "文本"
    (re.compile(rf'process\.env\.{KEY}\s*(?:\|\||\?\?)\s*"([^"]*)"'), "str"),
    # D: 布尔三形态
    (re.compile(rf'process\.env\.{KEY}\s*!==\s*"0"'), "bool_default_on"),
    (re.compile(rf'process\.env\.{KEY}\s*===\s*"0"'), "bool_default_on_inverted"),
    (re.compile(rf'process\.env\.{KEY}\s*===\s*"1"'), "bool_default_off"),
    # J: 叶子模块的布尔 helper 包装(design contract 引入):
    #      export const rmsDiag = (): boolean => boolOnByOne("AIM_RMS_DIAG");
    #    语义与 D 完全相同,只是多套一层本地 helper。
    (re.compile(rf'\bboolOffByZero\(\s*"{KEY}"\s*\)'), "bool_default_on"),
    (re.compile(rf'\bboolOnByOne\(\s*"{KEY}"\s*\)'), "bool_default_off"),
    # K: 叶子模块的 `?? <DEFAULTS 引用>` 形态:
    #      Number(process.env.AIM_RMS_DIAG_EVERY ?? MEDIA_DEFAULTS.rmsDiagEvery)
    #    默认值是对同模块 DEFAULTS 的引用(非字面量)→ 记 default_expr,由守门测试解析其真值。
    (re.compile(rf'process\.env\.{KEY}\s*\?\?\s*([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)'), "num_inline"),
    # L: 叶子模块的 `|| <DEFAULTS 引用>`(字符串族,如 kickoffWakeText)
    (re.compile(rf'process\.env\.{KEY}\s*\|\|\s*([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)'), "str"),
    # M: 通用钳制 helper(bypass-llm-config,design contract):
    #      clampTimeout(Number(process.env.AIM_X), DEFAULTS.y, BOUNDS.y)
    #    默认与界都是**引用**;界的真值由守门测试解析导出对象,此处只记默认出处。
    (re.compile(
        rf'\bclampTimeout\(\s*Number\(\s*process\.env\.{KEY}\s*\)\s*,'
        rf'\s*([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)'), "num"),
]

# I: 委托给另一个解析函数(默认值在被调函数内,不在调用点)
DELEGATED = re.compile(rf'\b([a-z][A-Za-z0-9_]*)\(\s*process\.env\.{KEY}\s*\)')

# E/F 形态:先定位含 Number(process.env.KEY) 的行,再在其后若干行找 return 的字面量与钳制
GUARD_START = re.compile(rf'Number\(\s*process\.env\.{KEY}\s*\)')
# 默认值可能是**数字字面量**(搬迁前)或**对 DEFAULTS 的引用**(搬迁后,design contract)
DFLT = rf'(?:{NUMLIT}|([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+))'
RETURN_NUM = re.compile(rf'\breturn\s+{DFLT}\s*;')
# 三元:cond ? <expr> : <default>  —— 默认在冒号右侧
TERNARY_TAIL = re.compile(rf':\s*{DFLT}\s*;')
CLAMP_MIN = re.compile(rf'Math\.min\(\s*{NUMLIT}')
CLAMP_MAX = re.compile(rf'Math\.max\(\s*{NUMLIT}')
# 派生默认(非字面量):默认值是「另一个配置的算式」而非字面量。
#   实例(media-session,design contract 的全环境自洽设计):
#     return Number.isFinite(raw) && raw > 0 ? raw : Math.floor(SILENCE_VIOLATION_MS * 0.4);
#   注意默认值在**三元的 false 分支**,不是 `return Math.floor(...)`,故不能锚 return 后紧跟。
#   搬迁后(design contract)派生源从模块级常量 `SILENCE_VIOLATION_MS` 变成**函数参数**
#   `silenceMs`(叶子模块不持状态,由调用方传入)→ 故标识符大小写都要认,不能只锚 [A-Z]。
DERIVED = re.compile(r'Math\.(?:floor|round|ceil)\(\s*[A-Za-z_][A-Za-z0-9_]*\s*[*/+\-]')


def strip_comment(line: str) -> str:
    """
    去掉整行注释与行尾 `//` 注释(防注释里的数字被当默认值)。

    ⚠ MUST NOT 用朴素 `re.sub(r'//.*$', '', line)` —— 它会吃掉**字符串字面量里**的 `//`,
      把 `process.env.AIM_MANTLE_HOST || "https://host"` 截成 `... || "https:`,
      导致该 key 整个漏抓(实测踩过)。故须逐字符扫,跳过引号内内容。
    """
    s = line.strip()
    if s.startswith("*") or s.startswith("//") or s.startswith("/*"):
        return ""
    quote = None
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "\"'`":
            quote = c
        elif c == "/" and i + 1 < n and line[i + 1] == "/":
            return line[:i]
        i += 1
    return line


def num_of(tok: str):
    """字面量 → float;THD 引用等非字面量 → None(标记为 import 来源,不比数值)。"""
    t = tok.strip().replace("_", "")
    try:
        return float(t)
    except ValueError:
        return None


def logical_lines(lines: list[str]) -> list[tuple[int, str]]:
    """
    形态 H:把跨行的表达式折成一条逻辑行,让单行正则能命中。

    两种续行触发条件(缺一就会漏抓,实测):
      ① 括号未闭合 —— prettier 把 `num("KEY", D, lo, hi)` 拆多行
      ② 行尾是 `=` / `??` / `||` / `&&` / `,` / `(` —— 如
             export const DEFAULT_MANTLE_HOST =
               process.env.AIM_MANTLE_HOST || "https://…";
         (`AIM_MANTLE_HOST` 曾因只查 ① 而漏抓)

    持续拼接直到两条件都不再成立(上限 8 行,防跑飞)。
    返回 (原始起始行号, 折叠后的单行文本);折叠用单空格。
    """
    CONT_TAIL = re.compile(r'(?:=|\?\?|\|\||&&|,|\()\s*$')
    out: list[tuple[int, str]] = []
    i = 0
    n = len(lines)
    while i < n:
        start, buf = i, lines[i]
        j = i
        while j + 1 < n and j - i < 8:
            unbalanced = buf.count("(") - buf.count(")") > 0
            if not (unbalanced or CONT_TAIL.search(buf)):
                break
            j += 1
            buf = buf + " " + lines[j]
        out.append((start + 1, buf))
        # 注意:不跳过被吞掉的行 —— 它们可能自身含独立的 env 读取(如 fail-fast 校验行)。
        # 折叠行与原行都参与匹配,重复命中由 (key,file,line,kind) 去重处理。
        i += 1
    return out


def scan_file(path: pathlib.Path, out: dict) -> None:
    raw_lines = path.read_text(encoding="utf-8").split("\n")
    lines = [strip_comment(l) for l in raw_lines]

    seen: set = set()  # (key, kind, line) 去重(折叠行与原行会重复命中)

    for lineno, line in logical_lines(lines):
        if not line:
            continue
        # I: 委托解析 —— 默认值在被调函数内
        for m in DELEGATED.finditer(line):
            fn, key = m.group(1), m.group(2)
            if fn in ("Number", "String", "Boolean", "parseInt", "parseFloat"):
                continue  # 这些是取值不是解析默认,交给其它形态
            sig = (key, "delegated", lineno)
            if sig in seen:
                continue
            seen.add(sig)
            out.setdefault(key, []).append(
                {"file": path.name, "line": lineno, "kind": "delegated",
                 "default": None, "delegate": fn,
                 "note": f"默认值在 {fn}() 内,registry MUST 复用该函数"})
        # A–D / G / H:单行 + 折叠行形态
        for pat, kind in LINE_PATS:
            for m in pat.finditer(line):
                key = m.group(1)
                if (key, kind, lineno) in seen:
                    continue
                seen.add((key, kind, lineno))
                rec = {"file": path.name, "line": lineno, "kind": kind}
                if kind.startswith("bool"):
                    rec["default"] = kind != "bool_default_off"
                    rec["type"] = "boolean"
                elif kind == "str":
                    rec["type"] = "string"
                    tok = m.group(2)
                    # 形态 L(叶子模块):默认值是 `ENGINE_DEFAULTS.kickoffWakeText` 这类**引用**,
                    # 不是字符串字面量 —— 引用形态由 pattern 的裸标识符捕获组命中(无引号)。
                    if re.fullmatch(r'[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+', tok):
                        rec["default"] = None
                        rec["default_expr"] = tok
                    else:
                        rec["default"] = tok
                else:
                    # 默认值 token:优先 group(2);若它是 None(引用形态命中了后备捕获组),取后续组
                    tok = m.group(2)
                    if tok is None:
                        tok = next((g for g in m.groups()[1:] if g), "")
                    v = num_of(tok)
                    rec["type"] = "number"
                    if v is None:
                        # 默认来自 import(如 TURN_HANDLING_DEFAULTS.x.y)—— 事实源在别处,不比数值
                        rec["default"] = None
                        rec["default_expr"] = tok.strip()
                    else:
                        rec["default"] = v
                    if kind in ("num_bounded", "num_bounded_env"):
                        # 界不靠固定组号(默认值可为字面量或引用,组数会变)——在本次匹配之后的
                        # 文本里就近取两个数字字面量作 [lo, hi]。
                        tail = line[m.end():]
                        nums = re.findall(NUMLIT, tail)
                        if len(nums) >= 2:
                            rec["clamp"] = [num_of(nums[0]), num_of(nums[1])]
                out.setdefault(key, []).append(rec)

    # E/F:守卫式(IIFE / 独立 helper)—— 逐原始行扫,向后看 6 行找 return 的默认与钳制
    for i, line in enumerate(lines):
        if not line:
            continue
        for m in GUARD_START.finditer(line):
            key = m.group(1)
            if (key, "guard", i + 1) in seen or (key, "derived", i + 1) in seen:
                continue
            blob = "\n".join(lines[i:i + 7])
            if DERIVED.search(blob):
                seen.add((key, "derived", i + 1))
                out.setdefault(key, []).append(
                    {"file": path.name, "line": i + 1, "kind": "derived",
                     "type": "number", "default": None,
                     "note": "默认派生自其它配置(非字面量),registry MUST 复用源模块函数"})
                continue
            rm = RETURN_NUM.search(blob)
            tm = TERNARY_TAIL.search(blob)
            m2 = rm or tm
            if m2 is None:
                continue
            lit, ref = m2.group(1), m2.group(2)
            seen.add((key, "guard", i + 1))
            rec: dict = {"file": path.name, "line": i + 1, "kind": "guard", "type": "number"}
            if ref:
                # 默认值是对 DEFAULTS 的引用(搬迁后形态)—— 事实源在叶子模块,不比字面量
                rec["default"] = None
                rec["default_expr"] = ref
            else:
                rec["default"] = num_of(lit)
            lo = CLAMP_MAX.search(blob)   # Math.max(lo, …) 给下界
            hi = CLAMP_MIN.search(blob)   # Math.min(hi, …) 给上界
            if lo or hi:
                rec["clamp"] = [num_of(lo.group(1)) if lo else None,
                                num_of(hi.group(1)) if hi else None]
            out.setdefault(key, []).append(rec)


def dedup(recs: list[dict]) -> list[dict]:
    """
    折叠行与其自身行会对同一处读取各记一条(行号差 1、其余全同)。
    按 (file, kind, type, default, clamp) 去重,保留行号最大者(= 真正含 env 读取的那行)。
    """
    best: dict = {}
    for r in recs:
        sig = (r.get("file"), r.get("kind"), r.get("type"),
               json.dumps(r.get("default"), sort_keys=True),
               json.dumps(r.get("clamp"), sort_keys=True))
        prev = best.get(sig)
        if prev is None or r.get("line", 0) > prev.get("line", 0):
            best[sig] = r
    return sorted(best.values(), key=lambda r: (r.get("file", ""), r.get("line", 0)))


def build() -> dict:
    if not SRC.is_dir():
        sys.exit(f"找不到 {SRC} —— 请在仓库根目录运行")
    out: dict = {}
    for f in sorted(SRC.glob("*.ts")):
        if f.name in SKIP_FILES:
            continue
        scan_file(f, out)
    return {k: dedup(v) for k, v in out.items()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="输出 JSON(守门测试用)")
    args = ap.parse_args()
    data = build()
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True))
        return
    print(f"{'KEY':52} {'TYPE':8} {'DEFAULT':22} KIND / 来源")
    print("-" * 118)
    for key in sorted(data):
        for r in data[key]:
            d = r.get("default")
            if r["kind"] == "derived":
                shown = "«derived»"
            elif r["kind"] == "delegated":
                shown = f"«{r['delegate']}()»"
            elif d is None:
                shown = r.get("default_expr", "«import»")
            else:
                shown = repr(d)
            clamp = f" clamp={r['clamp']}" if r.get("clamp") else ""
            print(f"{key:52} {r.get('type',''):8} {shown:22} {r['kind']} "
                  f"@{r['file']}:{r['line']}{clamp}")
    print(f"\n共 {len(data)} 个 key,{sum(len(v) for v in data.values())} 处读取。")


if __name__ == "__main__":
    main()
