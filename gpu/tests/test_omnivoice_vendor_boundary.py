"""Compliance and runtime-boundary checks for the vendored OmniVoice subset."""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path

GPU_ROOT = Path(__file__).resolve().parents[1]
VENDOR_ROOT = GPU_ROOT / "vendor"
PACKAGE_ROOT = VENDOR_ROOT / "omnivoice"
UPSTREAM_COMMIT = "33a8ca325d9c95df20512b36864b9041c7532b35"
UPSTREAM_LICENSE_SHA256 = "c843a20ede4d1e7595c2736b88fc62cb7483a8c082eb7092a3772248849c59e2"

EXPECTED_FILES = {
    "UPSTREAM.md",
    "UPSTREAM.json",
    "__init__.py",
    "models/__init__.py",
    "models/omnivoice.py",
    "utils/__init__.py",
    "utils/audio.py",
    "utils/duration.py",
    "utils/lang_map.py",
    "utils/text.py",
    "utils/voice_design.py",
}


def test_vendor_contains_only_runtime_inference_subset():
    actual = {
        path.relative_to(PACKAGE_ROOT).as_posix()
        for path in PACKAGE_ROOT.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
    }
    assert actual == EXPECTED_FILES


def test_all_internal_imports_resolve_inside_vendor_subset():
    missing: list[tuple[str, str]] = []
    for relative in sorted(EXPECTED_FILES):
        if not relative.endswith(".py"):
            continue
        source_path = PACKAGE_ROOT / relative
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        for node in ast.walk(tree):
            modules: list[str] = []
            if isinstance(node, ast.ImportFrom) and node.module:
                modules.append(node.module)
            elif isinstance(node, ast.Import):
                modules.extend(alias.name for alias in node.names)

            for module in modules:
                if not module.startswith("omnivoice."):
                    continue
                module_path = PACKAGE_ROOT.parent / Path(*module.split("."))
                if not module_path.with_suffix(".py").is_file() and not (module_path / "__init__.py").is_file():
                    missing.append((relative, module))
    assert missing == []


def test_provenance_records_baseline_and_local_change():
    record = (PACKAGE_ROOT / "UPSTREAM.md").read_text(encoding="utf-8")
    assert UPSTREAM_COMMIT in record
    assert "silence-empty-output-guard-v1" in record

    modified_model = (PACKAGE_ROOT / "models" / "omnivoice.py").read_text(encoding="utf-8")
    assert "VivaVoce local change" in modified_model


def test_provenance_manifest_matches_every_retained_source_file():
    manifest = json.loads((PACKAGE_ROOT / "UPSTREAM.json").read_text(encoding="utf-8"))
    assert manifest["repository"] == "https://github.com/k2-fsa/OmniVoice"
    assert manifest["commit"] == UPSTREAM_COMMIT
    assert manifest["license"]["sha256"] == UPSTREAM_LICENSE_SHA256

    source_files = {relative for relative in EXPECTED_FILES if relative.endswith(".py")}
    assert set(manifest["files"]) == source_files

    for relative, provenance in manifest["files"].items():
        digest = hashlib.sha256((PACKAGE_ROOT / relative).read_bytes()).hexdigest()
        assert digest == provenance["sha256"]
        if provenance["origin"] == "upstream":
            assert digest == provenance["upstream_sha256"]
        else:
            assert provenance["origin"] == "modified"
            assert digest != provenance["upstream_sha256"]
            assert provenance["modification_id"] == "silence-empty-output-guard-v1"


def test_vendor_license_is_exact_upstream_copy():
    digest = hashlib.sha256((VENDOR_ROOT / "LICENSE").read_bytes()).hexdigest()
    assert digest == UPSTREAM_LICENSE_SHA256
