#!/usr/bin/env python3
"""部署期 flag 校验(design contract)—— 拦住「把最佳值寄存在部署 shell」的复发路径。

    python3 tools/check-deploy-flags.py --task-def <stack>-rt-session --region <aws-region>
    python3 tools/check-deploy-flags.py --env-file /tmp/live-env.txt      # 离线:KEY=VALUE 逐行
    python3 tools/check-deploy-flags.py --print-whitelist                 # 只打印 C 类白名单

为什么需要它
------------
部署脚本中的环境覆盖可能在后续 ``cdk deploy`` 中被静默丢失。此类漂移不会必然触发
健康检查或单元测试,却会让运行时行为悄悄回退。

design contract 已把最佳值回落成代码默认值(A 类删开关 / B 类改默认),故**正常部署 shell 不该
再 export 任何运行时 flag**。本工具就守这条:出现即是有人在重建「第二份可写副本」。

三层判据(**不是**「该有的都在」,而是「不该有的别出现」)
--------------------------------------------------------
=========  ==========================================  ========
类别       判据                                         结果
=========  ==========================================  ========
**A 类**   开关已删,代码里连 env 读取都没有            **硬拒**
**B 类**   默认值已是最佳值;env 仅作 kill switch/调参  **警告**
**C 类**   确实未标定,标定期需要 env                   放行
其它       与本检查无关(拓扑/凭据/形态/调参)           放行
=========  ==========================================  ========

★ B 类为何是**警告而非硬拒**(review):B 类**保留** env 覆盖能力
  (``AIM_VIOLATION_ENFORCEMENT`` 会强制结束会话,误判率异常时须能紧急关闭)。
  「硬拒 B 类」会让 kill switch 变成不可用 —— 与 R3 自相矛盾。故:临时 export 放行但**响亮提示**,
  写进部署脚本/清单文件才是问题(那才是在造第二份副本,由 ``--forbid-b-class`` 在 CI 用)。

★ C 类白名单**自动派生**,不手工维护(review):源 = ``SETTINGS_META`` 里
  ``calibration_status == "pending"`` 的项。标定完成 → 改元数据一处 → 白名单自动收缩,
  不会像手工清单那样成为新的欠账列(即「第三份可写副本」)。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: A 类:design contract 已删除的开关。代码里已无 env 读取 → 出现即意味有人加回了开关。
A_CLASS = {
    "AIM_PLAYBACK_ACK_MODE",
    "AIM_FAREWELL_TTS_DRAIN_ENABLED",
}

#: B 类:默认值已是最佳值;env 仅作 kill switch / 调参入口。
B_CLASS = {
    "AIM_VIOLATION_ENFORCEMENT",
    "AIM_EOU_CORRECTION_ENABLED",
    "AIM_EOU_VERDICT_TIMEOUT_MS",
    "AIM_EOU_CORRELATION_MS",
    "AIM_SILENCE_VIOLATION_MS",
    "AIM_ENDPOINT_SILENCE_GAP_MS",
    "AIM_FALSE_INTERRUPTION_RECOVERY",
    "AIM_FALSE_INTERRUPTION_MAX_HOLD_MS",
}


def c_class_whitelist() -> set[str]:
    """C 类(确实未标定)—— 从 SETTINGS_META 自动派生,**names only,不含值**。

    不回写值是刻意的(design contract):清单里一旦有值,它就成了第二份可写副本。
    """
    sys.path.insert(0, str(ROOT / "backend"))
    try:
        from app.system_settings_meta import SETTINGS_META  # type: ignore[import-not-found]
    except Exception as exc:  # pragma: no cover - 环境缺 backend 依赖时降级
        print(f"  ⚠ 无法导入 SETTINGS_META({exc})→ C 类白名单为空(校验更严,不会漏拒)")
        return set()
    return {
        key
        for (_src, key), meta in SETTINGS_META.items()
        if getattr(meta, "calibration_status", "stable") == "pending"
    }


def live_env_from_task_def(task_def: str, region: str, profile: str | None) -> dict[str, str]:
    cmd = [
        "aws", "ecs", "describe-task-definition",
        "--task-definition", task_def, "--region", region,
        "--query", "taskDefinition.containerDefinitions[0].environment", "--output", "json",
    ]
    if profile:
        cmd += ["--profile", profile]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    return {e["name"]: str(e["value"]) for e in json.loads(out or "[]")}


def live_env_from_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()
    return env


def main() -> int:
    ap = argparse.ArgumentParser(description="部署期 flag 校验(design contract)")
    ap.add_argument("--task-def", help="ECS task definition 名(如 <stack>-rt-session)")
    ap.add_argument("--region", default=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"))
    ap.add_argument("--profile", default=None)
    ap.add_argument("--env-file", type=Path, help="离线校验:KEY=VALUE 逐行的文件")
    ap.add_argument("--print-whitelist", action="store_true", help="只打印 C 类白名单后退出")
    ap.add_argument(
        "--forbid-b-class", action="store_true",
        help="把 B 类出现也判为失败(CI 用:部署脚本/清单文件里 MUST NOT 写死 B 类值)",
    )
    args = ap.parse_args()

    whitelist = c_class_whitelist()

    if args.print_whitelist:
        for k in sorted(whitelist):
            print(k)
        return 0

    if args.env_file:
        env = live_env_from_file(args.env_file)
    elif args.task_def:
        if not args.region:
            ap.error("--task-def 模式须通过 --region、AWS_REGION 或 AWS_DEFAULT_REGION 指定区域")
        try:
            env = live_env_from_task_def(args.task_def, args.region, args.profile)
        except subprocess.CalledProcessError as exc:
            print(f"ERROR: 取 task def env 失败:{exc.stderr.strip()}", file=sys.stderr)
            return 2
    else:
        ap.error("须给 --task-def 或 --env-file")
        return 2

    present = set(env)
    a_hits = sorted(present & A_CLASS)
    b_hits = sorted(present & B_CLASS)
    c_hits = sorted(present & whitelist)

    print(f"==> flag 校验(env 共 {len(env)} 项;C 类白名单 {len(whitelist)} 项自动派生)")

    failed = False

    if a_hits:
        failed = True
        print("\n\033[31mFAIL: A 类 key 出现 —— 这些开关已被 design contract 删除\033[0m")
        for k in a_hits:
            print(f"    {k}={env[k]}")
        print("  代码里已无对应 env 读取,设它**不会生效**,只会误导后来者以为还能开关。")
        print("  → 从部署 shell / 脚本里删掉;要回滚行为请 git revert + 重新部署。")

    if b_hits:
        msg_color = "\033[31m" if args.forbid_b_class else "\033[33m"
        label = "FAIL" if args.forbid_b_class else "WARN"
        if args.forbid_b_class:
            failed = True
        print(f"\n{msg_color}{label}: B 类 key 出现 —— 默认值已是最佳值,通常不需要设\033[0m")
        for k in b_hits:
            print(f"    {k}={env[k]}")
        print("  合法用途:临时 kill switch / 标定期调参(此时可忽略本提示)。")
        print("  ⚠ 但 MUST NOT 写进部署脚本或 env 清单文件 —— 那是在重建「默认值的第二份可写副本」,")
        print("     否则后续部署可能静默丢失覆盖值并回退运行时行为。")

    if c_hits:
        print("\n\033[32mOK: C 类(确实未标定)key,标定期设它是预期的\033[0m")
        for k in c_hits:
            print(f"    {k}={env[k]}")

    if not failed:
        print("\n\033[32m==> 通过:无已删开关残留\033[0m")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
