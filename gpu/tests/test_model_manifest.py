from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from gpu_service.model_manifest import MODEL_DIRECTORIES, generate_manifest, manifest_id


def _write_models(root: Path) -> None:
    for index, directory in enumerate(MODEL_DIRECTORIES):
        target = root / directory
        target.mkdir(parents=True)
        (target / "weights.bin").write_bytes(f"weights-{index}".encode())
        (target / "config.json").write_text(f'{{"model": {index}}}\n')


def test_generate_model_manifest_is_sorted_and_deterministic(tmp_path):
    _write_models(tmp_path)
    output = tmp_path / "funasr-models.sha256"

    first_id = generate_manifest(tmp_path, output)
    first = output.read_text()
    second_id = generate_manifest(tmp_path, output)

    lines = first.splitlines()
    paths = [line.split("  ", 1)[1] for line in lines]
    assert paths == sorted(paths)
    assert first == output.read_text()
    assert first_id == second_id == hashlib.sha256(first.encode()).hexdigest()
    assert manifest_id(output) == first_id


def test_generate_model_manifest_rejects_missing_model(tmp_path):
    with pytest.raises(FileNotFoundError, match="缺少 ASR 模型目录"):
        generate_manifest(tmp_path, tmp_path / "manifest.sha256")
