#!/usr/bin/env python3
"""
生成 design contract 的**带版本 key 清单**(bridge 侧)——唯一事实源。

    python3 tools/gen-key-inventory.py            # 写 bridge/config-inventory.json
    python3 tools/gen-key-inventory.py --check     # 只校验(CI 用,漂移则非零退出)

为什么要它(design contract 1):文档里写「90 key」这类数字会漂移;registry 手抄默认值实测
46% 出错。故 key 范围 + 默认值出处 + 读取形态一律由机械扫描产出,CI 比对,人不转录。

每项字段:
  key            env 变量名
  status         included | excluded
  exclude_reason secret | addressing | dev-only(status=excluded 时必填)
  reads[]        该 key 的全部读取点(file / line / kind / default / clamp)
  default_source literal(字面量) | import(来自模块导出) | derived(派生自其它配置)
                 | delegated(默认在被调函数内)
                 —— registry 对 literal 之外三类 MUST 复用源模块的导出/函数,不得抄值
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys

OUT = pathlib.Path("bridge/config-inventory.json")
SCHEMA_VERSION = 1

SECRET_RE = re.compile(r"(_SECRET|_TOKEN|_API_KEY|_KEY)$|PASSWORD|CREDENTIAL|SIGNING", re.I)
# 寻址 / 逐通下发的 URL 与模型 ID:非「全局调优开关」,且部分随会话变化
ADDRESSING = {
    "AIM_GPU_WS_URL",
    "AIM_GPU_EMBEDDING_URL",
    "AIM_CONTROL_CALLBACK_URL",
    "AIM_MANTLE_HOST",
    "AIM_LLM_MODEL_ID",
}
DEV_ONLY = {"AIM_RT_INSECURE"}


def classify(key: str) -> tuple[str, str | None]:
    if SECRET_RE.search(key):
        return "excluded", "secret"
    if key in ADDRESSING:
        return "excluded", "addressing"
    if key in DEV_ONLY:
        return "excluded", "dev-only"
    return "included", None


def default_source(reads: list[dict]) -> str:
    """该 key 的默认值出处 —— 决定 registry 该 import 什么、不该抄什么。"""
    kinds = {r["kind"] for r in reads}
    if "derived" in kinds:
        return "derived"
    if "delegated" in kinds:
        return "delegated"
    # 任一读取点的默认来自 import(default=None 且带 default_expr)
    if any(r.get("default") is None and r.get("default_expr") for r in reads):
        return "import"
    return "literal"


def build() -> dict:
    raw = subprocess.run(
        [sys.executable, "tools/extract-env-baseline.py", "--json"],
        capture_output=True, text=True, check=True,
    ).stdout
    base = json.loads(raw)

    entries = []
    for key in sorted(base):
        reads = base[key]
        status, reason = classify(key)
        e = {
            "key": key,
            "status": status,
            "default_source": default_source(reads),
            "reads": [
                {k: v for k, v in r.items() if k in
                 ("file", "line", "kind", "default", "default_expr", "clamp", "delegate")}
                for r in reads
            ],
        }
        if reason:
            e["exclude_reason"] = reason
        entries.append(e)

    inc = [e for e in entries if e["status"] == "included"]
    return {
        "schema_version": SCHEMA_VERSION,
        "subsystem": "bridge",
        "note": (
            "design contract 冻结清单 —— 唯一事实源。由 tools/gen-key-inventory.py 生成,"
            "勿手改。registry 的 default 对 default_source != literal 的项 MUST 复用源模块"
            "导出/函数,MUST NOT 抄值(实测手抄 46% 出错)。"
        ),
        "counts": {
            "total": len(entries),
            "included": len(inc),
            "excluded": len(entries) - len(inc),
        },
        "entries": entries,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验与磁盘一致(CI 用)")
    args = ap.parse_args()
    fresh = build()

    if args.check:
        if not OUT.exists():
            sys.exit(f"清单缺失:{OUT} —— 跑 python3 tools/gen-key-inventory.py 生成")
        disk = json.loads(OUT.read_text(encoding="utf-8"))
        if disk != fresh:
            # 给出可读 diff 摘要,便于定位
            dk = {e["key"]: e for e in disk.get("entries", [])}
            fk = {e["key"]: e for e in fresh["entries"]}
            added, removed = sorted(fk - dk.keys()), sorted(dk.keys() - fk)
            changed = sorted(k for k in fk.keys() & dk.keys() if fk[k] != dk[k])
            msg = ["清单与源码漂移 —— 跑 python3 tools/gen-key-inventory.py 更新并复核:"]
            if added:
                msg.append(f"  新增 key: {added}")
            if removed:
                msg.append(f"  删除 key: {removed}")
            if changed:
                msg.append(f"  变更 key: {changed}")
            sys.exit("\n".join(msg))
        print(f"✓ 清单与源码一致({fresh['counts']['included']} included / "
              f"{fresh['counts']['excluded']} excluded)")
        return

    OUT.write_text(json.dumps(fresh, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"已写 {OUT}:{fresh['counts']['total']} key "
          f"({fresh['counts']['included']} included / {fresh['counts']['excluded']} excluded)")
    src = {}
    for e in fresh["entries"]:
        if e["status"] == "included":
            src[e["default_source"]] = src.get(e["default_source"], 0) + 1
    print("included 项的默认值出处分布:", dict(sorted(src.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    main()
