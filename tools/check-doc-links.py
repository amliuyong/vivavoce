#!/usr/bin/env python3
"""Check relative Markdown links without network access."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
failures: list[str] = []


def check_file(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    for line_number, line in enumerate(text.splitlines(), 1):
        for match in LINK_RE.finditer(line):
            target = match.group(1).strip().strip("<>")
            if not target or target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            target = unquote(target.split("#", 1)[0])
            if not target:
                continue
            resolved = (path.parent / target).resolve()
            try:
                resolved.relative_to(ROOT)
            except ValueError:
                failures.append(f"{path.relative_to(ROOT)}:{line_number}: link escapes repository: {target}")
                continue
            if not resolved.exists():
                failures.append(f"{path.relative_to(ROOT)}:{line_number}: missing link target: {target}")


for candidate in [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md"))]:
    if candidate.is_file():
        check_file(candidate)

if failures:
    print("\n".join(failures), file=sys.stderr)
    raise SystemExit(1)

print("DOC-LINKS: PASS")
