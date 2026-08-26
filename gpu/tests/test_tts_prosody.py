"""TTS 韵律稳定性配置 UT(语气平稳,deployment validation 真机反馈)。

只测模块级常量 + _tts_generation_config 的降级行为,不加载 OmniVoice 权重(本机无 GPU 包)。
本机 import omnivoice 失败 → _tts_generation_config 回退 None(synthesize 据此不传 generation_config,
等价旧行为)——验证「调参失败降级而非崩 TTS」。
"""
from __future__ import annotations

import importlib

import gpu_service.funasr_backend as fb


def test_default_prosody_values():
    # 中度默认(真机首验):position_temperature 5.0→3.0(韵律更平稳)、guidance_scale 2.0→2.5(更贴参考音)。
    assert fb._TTS_POSITION_TEMPERATURE == 3.0
    assert fb._TTS_GUIDANCE_SCALE == 2.5


def test_env_override(monkeypatch):
    # env 可调真机标定:重载模块使新 env 生效。
    monkeypatch.setenv("AIM_TTS_POSITION_TEMPERATURE", "1.5")
    monkeypatch.setenv("AIM_TTS_GUIDANCE_SCALE", "3.5")
    reloaded = importlib.reload(fb)
    try:
        assert reloaded._TTS_POSITION_TEMPERATURE == 1.5
        assert reloaded._TTS_GUIDANCE_SCALE == 3.5
    finally:
        # 还原模块级常量,避免污染后续用例(reload 会重读当时 env)。
        monkeypatch.delenv("AIM_TTS_POSITION_TEMPERATURE", raising=False)
        monkeypatch.delenv("AIM_TTS_GUIDANCE_SCALE", raising=False)
        importlib.reload(fb)


def test_generation_config_graceful_fallback_without_omnivoice():
    # 本机无 omnivoice 包 → 构建失败必须回退 None(降级用引擎默认),绝不抛(否则整场 TTS 崩)。
    fb._tts_generation_config.cache_clear()
    assert fb._tts_generation_config() is None
