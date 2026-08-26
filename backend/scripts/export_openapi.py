"""导出 OpenAPI 契约到 backend/openapi.json(前后端接口的单一事实源)。

Code-first 工作流:FastAPI 的 Pydantic 模型 + 路由是事实源,本脚本把 app.openapi() 导出为
checked-in 的 openapi.json,供前端生成 client。test_openapi_contract.py 守门:代码改了契约
不同步即红 —— 强制「改接口必更新契约」。

用法:
  python scripts/export_openapi.py            # 写入 backend/openapi.json
  python scripts/export_openapi.py --check    # 只校验是否最新(不写),不一致退出码 1

为稳定 diff:auth_mode=local 装配(确保 openapi 段被启用)+ sort_keys + 末尾换行。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]
OPENAPI_PATH = _BACKEND_DIR / "openapi.json"


def generate() -> dict:
    # 确保 import app 不依赖真实 AWS;local 模式启用 openapi 暴露
    os.environ.setdefault("AIM_AUTH_MODE", "local")
    sys.path.insert(0, str(_BACKEND_DIR))
    from app.config import load_settings
    from app.main import create_app

    settings = load_settings()
    app = create_app(settings)
    return app.openapi()


def serialize(spec: dict) -> str:
    return json.dumps(spec, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="只校验契约是否最新,不写文件")
    args = parser.parse_args()

    content = serialize(generate())
    if args.check:
        if not OPENAPI_PATH.exists():
            print("openapi.json 不存在,请运行 python scripts/export_openapi.py", file=sys.stderr)
            return 1
        current = OPENAPI_PATH.read_text(encoding="utf-8")
        if current != content:
            print("openapi.json 与当前代码不一致 —— 请运行 python scripts/export_openapi.py 更新", file=sys.stderr)
            return 1
        print("openapi.json 已是最新")
        return 0
    OPENAPI_PATH.write_text(content, encoding="utf-8")
    print(f"已写入 {OPENAPI_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
