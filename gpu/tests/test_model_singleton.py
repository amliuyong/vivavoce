"""模型权重进程级单例回归测试(GPU-free)。

契约(修复"每连接重载模型 → 首句高延迟 / 并发 OOM"):
  - 不论 new 多少个 FunAsr/OmniVoiceTts(= 多少通会话),重型模型权重只加载一次;
  - 多个会话共享同一模型对象;
  - 但每会话的流式解码状态(cache/缓冲)各自独立、不串话。

用注入假的 funasr / omnivoice 模块验证,无需 GPU 或真实权重。
"""
from __future__ import annotations

import sys
import types

import numpy as np
import pytest


@pytest.fixture
def fake_models(monkeypatch, tmp_path):
    """注入假的 funasr.AutoModel / omnivoice.OmniVoice,记录加载次数;并清/复位单例缓存。"""
    from gpu_service import funasr_backend as fb

    counters = {"automodel": 0, "omni_from_pretrained": 0}
    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()
    for stem in ("female_std", "male_std", "female_std.en", "male_std.en"):
        (voices_dir / f"{stem}.wav").write_bytes(b"test-audio")
        (voices_dir / f"{stem}.txt").write_text(f"transcript for {stem}\n", encoding="utf-8")
    monkeypatch.setattr(fb, "_VOICES_DIR", voices_dir)

    class FakeAutoModel:
        def __init__(self, **kw):
            counters["automodel"] += 1
            self.kw = kw

        def generate(self, **kw):
            return [{"text": "识别"}]

    class FakeOmniVoice:
        sampling_rate = 24000

        @classmethod
        def from_pretrained(cls, *a, **kw):
            counters["omni_from_pretrained"] += 1
            return cls()

        def create_voice_clone_prompt(self, *, ref_audio, ref_text=None):
            counters["clone_prompt"] = counters.get("clone_prompt", 0) + 1
            # 回一个可比较的标记对象,记录用了哪段参考音 + ref_text(测试断言 generate 收到同一 prompt)
            return ("clone", ref_audio, ref_text)

        def generate(self, **kw):
            # 记录最近一次 generate 收到的 voice_clone_prompt(测试断言 voice clone 真生效)
            counters["last_generate_kw"] = kw
            return [np.zeros(240, dtype=np.float32)]

    fake_funasr = types.ModuleType("funasr")
    fake_funasr.AutoModel = FakeAutoModel
    fake_omnivoice = types.ModuleType("omnivoice")
    fake_omnivoice.OmniVoice = FakeOmniVoice
    fake_torch = types.ModuleType("torch")
    fake_torch.float16 = "float16"  # _tts_engine 引用 torch.float16
    monkeypatch.setitem(sys.modules, "funasr", fake_funasr)
    monkeypatch.setitem(sys.modules, "omnivoice", fake_omnivoice)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    monkeypatch.setenv("AIM_GPU_BACKEND", "funasr")
    monkeypatch.setenv("AIM_FORCE_CPU", "1")
    monkeypatch.setenv("AIM_TTS_IMPL", "omnivoice")

    # 清单例缓存(避免受其它测试/顺序影响),用完再清,避免把假模型泄漏给后续测试
    fb._stream_model.cache_clear()
    fb._final_model.cache_clear()
    fb._tts_engine.cache_clear()
    fb._voice_ref.cache_clear()
    fb._voice_clone_prompt.cache_clear()
    try:
        yield counters
    finally:
        fb._stream_model.cache_clear()
        fb._final_model.cache_clear()
        fb._tts_engine.cache_clear()
        fb._voice_ref.cache_clear()
        fb._voice_clone_prompt.cache_clear()


def test_asr_models_load_once_across_sessions(fake_models):
    from gpu_service import engines

    sessions = [engines.make_asr() for _ in range(5)]  # 模拟 5 通会话

    # stream + final 各加载一次(共 2),不随会话数增长(否则就是每连接重载的 bug)
    assert fake_models["automodel"] == 2
    # 不同会话是不同的薄实例,但共享同一组模型对象
    assert sessions[0] is not sessions[1]
    assert all(s._stream is sessions[0]._stream for s in sessions)
    assert all(s._final is sessions[0]._final for s in sessions)


def test_asr_per_session_state_is_isolated(fake_models):
    from gpu_service import engines

    a, b = engines.make_asr(), engines.make_asr()
    # 每会话的可变状态必须各自独立,绝不共享(否则会串话)
    assert a._cache is not b._cache
    assert a._pcm_buf is not b._pcm_buf
    a.transcribe_chunk(b"\x01\x00" * 160)
    assert len(a._pcm_buf) > 0 and len(b._pcm_buf) == 0


def test_tts_engine_loads_once_across_sessions(fake_models):
    from gpu_service import engines

    ttss = [engines.make_tts() for _ in range(5)]
    # OmniVoice 引擎只 from_pretrained 一次,跨会话共享
    assert fake_models["omni_from_pretrained"] == 1
    assert all(t._engine is ttss[0]._engine for t in ttss)


def test_tts_empty_text_yields_nothing(fake_models):
    """空/纯空白文本:synthesize 不调引擎、不产出(真机短语开场前的防御)。"""
    from gpu_service.funasr_backend import OmniVoiceTts

    tts = OmniVoiceTts()
    assert list(tts.synthesize("")) == []
    assert list(tts.synthesize("   ")) == []


def test_tts_empty_audio_raises_clean_error(fake_models, monkeypatch):
    """引擎对非空文本返回空音频(zero-size)→ synthesize 抛**可读** RuntimeError,
    而非 numpy 的「zero-size array to reduction operation maximum」崩溃(真机根因 deployment validation)。"""
    import numpy as np

    from gpu_service.funasr_backend import OmniVoiceTts

    tts = OmniVoiceTts()
    # 让引擎对任意文本返回 0 长度音频(模拟 OmniVoice 去静音后整段被清空的退化)
    monkeypatch.setattr(tts._engine, "generate", lambda **kw: [np.zeros(0, dtype=np.float32)])
    with pytest.raises(RuntimeError, match="空结果"):
        list(tts.synthesize("你好"))


def test_tts_synthesize_uses_voice_clone_prompt(fake_models):
    """voice clone:synthesize 必须把 voice_clone_prompt(锁声纹)喂给 generate,
    而非旧的 instruct(voice design 句间漂移根因)。"""
    from gpu_service.funasr_backend import OmniVoiceTts

    tts = OmniVoiceTts("female_std")
    list(tts.synthesize("你好"))
    kw = fake_models["last_generate_kw"]
    assert "voice_clone_prompt" in kw and kw["voice_clone_prompt"] is not None
    assert "instruct" not in kw  # 不再用 voice design


def test_voice_clone_prompt_cached_per_voice(fake_models):
    """同一 voice 的 clone prompt 只编码一次(进程级缓存);不同 voice 各编码一次。"""
    from gpu_service import funasr_backend as fb

    fb._voice_clone_prompt.cache_clear()
    try:
        # female 合成 3 次只编码 1 次
        f = fb.OmniVoiceTts("female_std")
        for _ in range(3):
            list(f.synthesize("一句话"))
        assert fake_models["clone_prompt"] == 1
        # 换 male → 再编码一次(共 2)
        m = fb.OmniVoiceTts("male_std")
        list(m.synthesize("另一句"))
        assert fake_models["clone_prompt"] == 2
    finally:
        fb._voice_clone_prompt.cache_clear()


def test_tts_telemetry_cache_state_tracks_prompt_encoding(fake_models):
    """work item:cache telemetry observes prompt readiness without warming it."""
    from gpu_service import funasr_backend as fb

    fb._voice_clone_prompt.cache_clear()
    fb._voice_ref.cache_clear()
    fb._warm_voice_clone_prompts.clear()
    try:
        tts = fb.OmniVoiceTts("female_std")
        assert tts.telemetry_cache_state("你好") == "cold"
        list(tts.synthesize("你好"))
        assert tts.telemetry_cache_state("你好") == "warm"
    finally:
        fb._voice_clone_prompt.cache_clear()
        fb._voice_ref.cache_clear()
        fb._warm_voice_clone_prompts.clear()


def test_voice_ref_resolves_known_and_falls_back(fake_models):
    """voice key 解析:已知 key → 对应 wav+sidecar ref_text;未知/None → 回退默认 key。"""
    from gpu_service import funasr_backend as fb

    wav_m, txt_m = fb._voice_ref("male_std")
    assert wav_m.endswith("male_std.wav")
    assert txt_m and txt_m.strip()

    # 未知 key → 回退默认(female_std),不抛错
    wav_x, _ = fb._voice_ref("does_not_exist")
    assert wav_x.endswith(f"{fb._VOICE_DEFAULT}.wav")
    # None 同样回退默认
    wav_n, _ = fb._voice_ref(None)
    assert wav_n.endswith(f"{fb._VOICE_DEFAULT}.wav")


def test_voice_ref_selects_language_specific_asset(fake_models):
    """语言维度(修英文口音根因):lang='en' 且存在 <key>.en.wav → 选英文母语参考音;
    lang=None / 无对应语言资产 → 回退裸 <key>.wav(=中文默认)。"""
    from gpu_service import funasr_backend as fb

    # en:本地提供 male_std.en.wav → 选英文参考音 + 英文 ref_text
    wav_en, txt_en = fb._voice_ref("male_std", "en")
    assert wav_en.endswith("male_std.en.wav")
    assert txt_en and txt_en.strip()
    # lang=None → 裸文件名(中文默认)
    wav_zh, _ = fb._voice_ref("male_std", None)
    assert wav_zh.endswith("male_std.wav") and not wav_zh.endswith(".en.wav")
    # 无对应语言资产(ja 无 <key>.ja.wav)→ 回退裸文件名(=中文),不抛错
    wav_ja, _ = fb._voice_ref("male_std", "ja")
    assert wav_ja.endswith("male_std.wav") and not wav_ja.endswith(".ja.wav")


def test_tts_ref_lang_normalization():
    """会话 language → TTS 参考音语言模式:2字母前缀 / auto 保留 / 空→None。"""
    from gpu_service.funasr_backend import _tts_ref_lang

    assert _tts_ref_lang("en-US") == "en"
    assert _tts_ref_lang("zh-CN") == "zh"
    assert _tts_ref_lang("EN") == "en"          # 大小写不敏感
    assert _tts_ref_lang("auto") == "auto"      # auto 逐句检测,不在此定
    assert _tts_ref_lang(None) is None
    assert _tts_ref_lang("") is None


def test_detect_text_lang_per_sentence():
    """auto 逐句检测:含 CJK→中文参考音(None);纯拉丁→en;纯符号→None。"""
    from gpu_service.funasr_backend import _detect_text_lang

    assert _detect_text_lang("你好世界") is None                    # 中文 → 裸(中文)参考音
    assert _detect_text_lang("Hello, how are you?") == "en"         # 英文 → en 参考音
    assert _detect_text_lang("这个 API 很好") is None               # 中英混含 CJK → 走中文(CJK 优先)
    assert _detect_text_lang("123 !!! ...") is None                 # 纯符号/数字 → 默认


def test_tts_language_selects_english_reference_audio(fake_models):
    """端到端:OmniVoiceTts(voice, language='en') 合成英文句 → generate 收到的 clone prompt
    指向 male_std.en.wav(英文母语声纹),而非裸 male_std.wav(中文声纹)。这是修口音的核心断言。"""
    from gpu_service import funasr_backend as fb

    fb._voice_clone_prompt.cache_clear()
    fb._voice_ref.cache_clear()
    try:
        tts = fb.OmniVoiceTts("male_std", "en")
        list(tts.synthesize("Hello there"))
        kw = fake_models["last_generate_kw"]
        prompt = kw["voice_clone_prompt"]  # fake 返回 ("clone", ref_audio, ref_text)
        assert prompt[1].endswith("male_std.en.wav")  # 用了英文母语参考音
    finally:
        fb._voice_clone_prompt.cache_clear()
        fb._voice_ref.cache_clear()


def test_tts_auto_language_switches_reference_per_sentence(fake_models):
    """auto 模式:同一 OmniVoiceTts 逐句按文本语种选参考音 —— 中文句用裸 wav、英文句用 .en.wav。
    验证 auto=跟随题目语言时中英混合场景各句都地道(voice clone prompt 逐句切换,均命中进程级缓存)。"""
    from gpu_service import funasr_backend as fb

    fb._voice_clone_prompt.cache_clear()
    fb._voice_ref.cache_clear()
    try:
        tts = fb.OmniVoiceTts("male_std", "auto")
        # 中文句 → 裸(中文)参考音
        list(tts.synthesize("你好"))
        assert fake_models["last_generate_kw"]["voice_clone_prompt"][1].endswith("male_std.wav")
        # 英文句 → en 参考音
        list(tts.synthesize("Good morning"))
        assert fake_models["last_generate_kw"]["voice_clone_prompt"][1].endswith("male_std.en.wav")
    finally:
        fb._voice_clone_prompt.cache_clear()
        fb._voice_ref.cache_clear()


def test_make_tts_passes_language_to_local_engine(fake_models):
    """make_tts(voice, language=) 把语言透传到本地 OmniVoice(选中/英参考音)。"""
    from gpu_service import engines
    from gpu_service import funasr_backend as fb

    fb._voice_clone_prompt.cache_clear()
    fb._voice_ref.cache_clear()
    try:
        tts = engines.make_tts("male_std", None, "en")
        list(tts.synthesize("Hello"))
        assert fake_models["last_generate_kw"]["voice_clone_prompt"][1].endswith("male_std.en.wav")
    finally:
        fb._voice_clone_prompt.cache_clear()
        fb._voice_ref.cache_clear()
