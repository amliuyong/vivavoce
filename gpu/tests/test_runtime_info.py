from __future__ import annotations

import io
from pathlib import Path

from gpu_service import runtime_info as runtime_info_module
from gpu_service.funasr_backend import FUNASR_DEFAULTS


def test_runtime_info_uses_model_default_source(monkeypatch):
    observed: list[Path] = []
    monkeypatch.delenv("AIM_MODEL_ROOT", raising=False)
    monkeypatch.delenv("ECS_CONTAINER_METADATA_URI_V4", raising=False)
    runtime_info_module._image_digest.cache_clear()
    monkeypatch.setattr(
        runtime_info_module,
        "manifest_id",
        lambda path: observed.append(path) or "manifest",
    )

    info = runtime_info_module.runtime_info()

    assert observed == [
        Path(FUNASR_DEFAULTS["model_root"]) / "funasr-models.sha256"
    ]
    assert info["model_manifest_id"] == "manifest"


def test_runtime_info_reads_ecs_image_digest_once(monkeypatch):
    calls = 0

    def open_metadata(url: str, *, timeout: float):
        nonlocal calls
        calls += 1
        assert url == "http://169.254.170.2/v4/container"
        assert timeout == 0.2
        return io.BytesIO(b'{"ImageID":"sha256:abc123"}')

    monkeypatch.setenv(
        "ECS_CONTAINER_METADATA_URI_V4",
        "http://169.254.170.2/v4/container",
    )
    monkeypatch.setattr(runtime_info_module.urllib.request, "urlopen", open_metadata)
    runtime_info_module._image_digest.cache_clear()

    assert runtime_info_module._image_digest() == "sha256:abc123"
    assert runtime_info_module._image_digest() == "sha256:abc123"
    assert calls == 1
    runtime_info_module._image_digest.cache_clear()
