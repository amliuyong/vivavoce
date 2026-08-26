"""Cheap runtime version evidence for diagnostics and benchmark reports."""

from __future__ import annotations

import json
import os
import platform
import urllib.request
from functools import lru_cache
from importlib import metadata
from pathlib import Path

from .funasr_backend import FUNASR_DEFAULTS
from .model_manifest import manifest_id


def _distribution_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


@lru_cache(maxsize=1)
def _image_digest() -> str | None:
    metadata_uri = os.getenv("ECS_CONTAINER_METADATA_URI_V4")
    if not metadata_uri:
        return None
    try:
        with urllib.request.urlopen(metadata_uri, timeout=0.2) as response:
            payload = json.load(response)
    except (OSError, TimeoutError, ValueError):
        return None
    image_id = payload.get("ImageID") if isinstance(payload, dict) else None
    return image_id if isinstance(image_id, str) and image_id.startswith("sha256:") else None


def runtime_info() -> dict[str, str | None]:
    model_root = Path(os.getenv("AIM_MODEL_ROOT", FUNASR_DEFAULTS["model_root"]))
    return {
        "python": platform.python_version(),
        "funasr": _distribution_version("funasr"),
        "numpy": _distribution_version("numpy"),
        "pytorch": _distribution_version("torch"),
        "cuda": os.getenv("CUDA_VERSION") or os.getenv("CUDA_TOOLKIT_VERSION"),
        "image_tag": os.getenv("AIM_GPU_IMAGE_TAG") or None,
        "image_digest": _image_digest(),
        "model_manifest_id": manifest_id(model_root / "funasr-models.sha256"),
    }
