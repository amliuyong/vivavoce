#!/usr/bin/env python3
"""Launch an instrumented GPU server for one work item baseline mode."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--run-kind",
        choices=("20ms-sync", "600ms-sync", "600ms-dedicated-thread"),
        required=True,
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo_root / "gpu"))

    import uvicorn

    from gpu_service.server import create_app

    uvicorn.run(
        create_app(asr_run_kind=args.run_kind),
        host=args.host,
        port=args.port,
    )


if __name__ == "__main__":
    main()
