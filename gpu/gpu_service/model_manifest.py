"""Generate and identify the immutable FunASR model manifest."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

MODEL_DIRECTORIES = (
    Path("funasr/models/paraformer-zh-streaming"),
    Path("funasr/models/SenseVoiceSmall"),
    Path("funasr/modelscope/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"),
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def generate_manifest(root: Path, output: Path) -> str:
    """Write sorted ``sha256  relative/path`` entries and return the manifest ID."""
    root = root.resolve()
    files: list[Path] = []
    for relative_directory in MODEL_DIRECTORIES:
        directory = root / relative_directory
        if not directory.is_dir():
            raise FileNotFoundError(f"缺少 ASR 模型目录: {relative_directory.as_posix()}")
        model_files = [path for path in directory.rglob("*") if path.is_file()]
        if not model_files:
            raise ValueError(f"ASR 模型目录为空: {relative_directory.as_posix()}")
        files.extend(model_files)

    entries = [
        f"{_sha256(path)}  {path.relative_to(root).as_posix()}"
        for path in sorted(files, key=lambda path: path.relative_to(root).as_posix())
    ]
    content = "\n".join(entries) + "\n"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(content, encoding="utf-8", newline="\n")
    return hashlib.sha256(content.encode()).hexdigest()


def manifest_id(path: Path) -> str | None:
    if not path.is_file():
        return None
    return _sha256(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate deterministic FunASR model SHA-256 manifest")
    parser.add_argument("--root", type=Path, required=True, help="Model root containing funasr/")
    parser.add_argument("--output", type=Path, required=True, help="Manifest output path")
    args = parser.parse_args()
    identifier = generate_manifest(args.root, args.output)
    print(f"{args.output}: sha256:{identifier}")


if __name__ == "__main__":
    main()
