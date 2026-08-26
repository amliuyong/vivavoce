"""MiniMax TTS 后端单测(design contract)—— mock HTTP,不触网。

覆盖:pcm hex 解码切帧、HTTP 200 但 base_resp 非 0 抛错、data=null/空音频抛错、voice 映射、
make_tts provider 分流、cancel 在帧间生效(经 SessionOrchestrator)、配置原子热加载。
"""
from __future__ import annotations

import json

import pytest

from gpu_service import minimax_config as mc
from gpu_service.minimax_tts import FRAME_MS, MiniMaxTts, MiniMaxTtsError
from gpu_service.protocol import TTS_SAMPLE_RATE


@pytest.fixture
def cfg_enabled():
    """一份启用 + 有 key 的配置(测试直接传入,不读 Secret/env)。"""
    return mc.MiniMaxConfig(enabled=True, api_key="sk-test", base_url="https://api.minimaxi.com/v1/t2a_v2")


def _ok_response(pcm: bytes) -> bytes:
    """构造一条成功的 MiniMax 响应 JSON(base_resp.status_code=0,data.audio=hex)。"""
    return json.dumps({
        "data": {"audio": pcm.hex(), "status": 2},
        "extra_info": {"usage_characters": 2},
        "base_resp": {"status_code": 0, "status_msg": "success"},
    }).encode("utf-8")


def _patch_request(monkeypatch, *, raw: bytes | None = None, exc: Exception | None = None):
    """monkeypatch MiniMaxTts._request_audio 的底层 urlopen,返回构造的 raw 或抛 exc。"""
    captured = {}

    class _Resp:
        def __init__(self, data):
            self._data = data

        def read(self):
            return self._data

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        captured["body"] = json.loads(req.data.decode("utf-8"))
        captured["timeout"] = timeout
        if exc is not None:
            raise exc
        return _Resp(raw)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    return captured


def test_pcm_hex_decode_and_frame_split(monkeypatch, cfg_enabled):
    """成功响应:hex 解码后按 20ms 帧切块 yield;帧字节数 = 24k*20ms*2。"""
    # 5 帧的 PCM(每帧 24000*0.02*2 = 960 字节)
    frame_bytes = TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2
    pcm = b"\x01\x02" * (frame_bytes * 5 // 2)
    cap = _patch_request(monkeypatch, raw=_ok_response(pcm))
    tts = MiniMaxTts("female_std", config=cfg_enabled)
    chunks = list(tts.synthesize("你好"))
    assert b"".join(chunks) == pcm
    assert all(len(c) == frame_bytes for c in chunks[:-1])  # 除最后一帧外都满帧
    # 请求契约:无 GroupId、Bearer、pcm/24k/mono、stream=false、output_format=hex
    assert "GroupId" not in cap["url"] and "group_id" not in cap["body"]
    assert cap["body"]["audio_setting"] == {"format": "pcm", "sample_rate": 24000, "channel": 1}
    assert cap["body"]["stream"] is False
    assert cap["body"]["output_format"] == "hex"
    assert cap["body"]["model"] == "speech-2.8-turbo"
    assert cap["body"]["language_boost"] == "Chinese"
    # Bearer 头(headers key 经 urllib 规范化为 Authorization)
    assert any(v == "Bearer sk-test" for v in cap["headers"].values())
    assert cap["timeout"] == cfg_enabled.timeout_s


def test_voice_id_mapping(monkeypatch, cfg_enabled):
    """语义 voice key → MiniMax voice_id(默认映射)。"""
    frame_bytes = TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2
    cap = _patch_request(monkeypatch, raw=_ok_response(b"\x00" * frame_bytes))
    list(MiniMaxTts("male_std", config=cfg_enabled).synthesize("hi"))
    assert cap["body"]["voice_setting"]["voice_id"] == "Chinese (Mandarin)_Gentleman"
    list(MiniMaxTts("female_std", config=cfg_enabled).synthesize("hi"))
    assert cap["body"]["voice_setting"]["voice_id"] == "Chinese (Mandarin)_Kind-hearted_Antie"


def test_unknown_voice_falls_back_default(cfg_enabled):
    """未知/缺省 voice key fail-safe 回退默认 voice_id(male_std=Gentleman,全链路同一默认),不抛。"""
    assert cfg_enabled.voice_id_for("does_not_exist") == "Chinese (Mandarin)_Gentleman"
    assert cfg_enabled.voice_id_for(None) == "Chinese (Mandarin)_Gentleman"


def test_voice_id_language_dimension(cfg_enabled):
    """语言维度(修英文口音):lang='en' → 英文母语 system voice;lang=None/无对应键 → 裸 key(中文)。"""
    # en:选英文音色(male_std.en / female_std.en)
    assert cfg_enabled.voice_id_for("male_std", "en") == "English_Trustworth_Man"
    assert cfg_enabled.voice_id_for("female_std", "en") == "English_Graceful_Lady"
    # None / 中文:裸 key(中文音色)
    assert cfg_enabled.voice_id_for("male_std", None) == "Chinese (Mandarin)_Gentleman"
    assert cfg_enabled.voice_id_for("male_std", "zh") == "Chinese (Mandarin)_Gentleman"
    # 无对应语言键(ja 未配)→ 回退裸 key(中文),不抛
    assert cfg_enabled.voice_id_for("male_std", "ja") == "Chinese (Mandarin)_Gentleman"


def test_boost_for_language(cfg_enabled):
    """language_boost 逐句:en→English、zh→Chinese、其它→配置默认(Chinese)。"""
    assert cfg_enabled.boost_for("en") == "English"
    assert cfg_enabled.boost_for("zh") == "Chinese"
    assert cfg_enabled.boost_for(None) == cfg_enabled.language_boost


def test_synthesize_english_uses_english_voice_and_boost(monkeypatch, cfg_enabled):
    """会话 language='en':英文句用英文母语 voice_id + language_boost=English(修口音的核心断言)。"""
    frame_bytes = TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2
    cap = _patch_request(monkeypatch, raw=_ok_response(b"\x00" * frame_bytes))
    list(MiniMaxTts("male_std", "en", config=cfg_enabled).synthesize("Hello there"))
    assert cap["body"]["voice_setting"]["voice_id"] == "English_Trustworth_Man"
    assert cap["body"]["language_boost"] == "English"


def test_synthesize_auto_switches_voice_per_sentence(monkeypatch, cfg_enabled):
    """language='auto':同一实例逐句按文本判语言 —— 中文句用中文音色、英文句用英文音色 + 各自 boost。"""
    frame_bytes = TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2
    tts = MiniMaxTts("female_std", "auto", config=cfg_enabled)
    cap = _patch_request(monkeypatch, raw=_ok_response(b"\x00" * frame_bytes))
    list(tts.synthesize("你好世界"))
    assert cap["body"]["voice_setting"]["voice_id"] == "Chinese (Mandarin)_Kind-hearted_Antie"
    assert cap["body"]["language_boost"] == "Chinese"
    list(tts.synthesize("Good morning everyone"))
    assert cap["body"]["voice_setting"]["voice_id"] == "English_Graceful_Lady"
    assert cap["body"]["language_boost"] == "English"


def test_http200_but_base_resp_nonzero_raises(monkeypatch, cfg_enabled):
    """★ 失败时 HTTP 仍可能 200,错误在 body base_resp —— 必须解析 body 判定,不只看 HTTP 码。"""
    raw = json.dumps({"data": None, "base_resp": {"status_code": 1004, "status_msg": "invalid api key"}}).encode()
    _patch_request(monkeypatch, raw=raw)
    with pytest.raises(MiniMaxTtsError) as ei:
        list(MiniMaxTts("female_std", config=cfg_enabled).synthesize("你好"))
    assert ei.value.status_code == 1004
    assert "1004" in str(ei.value)


def test_data_null_raises(monkeypatch, cfg_enabled):
    """官方明确 data 可能为 null;data=null(即便 status_code=0)→ 抛错,不静默/不回灌静音。"""
    raw = json.dumps({"data": None, "base_resp": {"status_code": 0}}).encode()
    _patch_request(monkeypatch, raw=raw)
    with pytest.raises(MiniMaxTtsError, match="data 为空"):
        list(MiniMaxTts("female_std", config=cfg_enabled).synthesize("你好"))


def test_empty_audio_raises(monkeypatch, cfg_enabled):
    """成功码但 audio hex 解码为 0 字节 → 抛错(漏句降级,非静音冒充)。"""
    raw = json.dumps({"data": {"audio": ""}, "base_resp": {"status_code": 0}}).encode()
    _patch_request(monkeypatch, raw=raw)
    with pytest.raises(MiniMaxTtsError):
        list(MiniMaxTts("female_std", config=cfg_enabled).synthesize("你好"))


def test_timeout_raises(monkeypatch, cfg_enabled):
    """超时(短超时封顶不可断窗口)→ 抛 MiniMaxTtsError 走降级。"""
    _patch_request(monkeypatch, exc=TimeoutError("timed out"))
    with pytest.raises(MiniMaxTtsError, match="超时|失败"):
        list(MiniMaxTts("female_std", config=cfg_enabled).synthesize("你好"))


def test_no_key_raises(monkeypatch):
    """enabled 但无 key → synthesize 抛错(不静默回灌静音);GPU 整体仍 ready(此测不验 readyz)。"""
    cfg = mc.MiniMaxConfig(enabled=True, api_key="")
    with pytest.raises(MiniMaxTtsError, match="API key"):
        list(MiniMaxTts("female_std", config=cfg).synthesize("你好"))


def test_disabled_raises_even_with_key(monkeypatch):
    """review=false 即便有 key 也**不合成**(关闭开关真生效,不继续计费)。"""
    cfg = mc.MiniMaxConfig(enabled=False, api_key="sk-still-here")
    # 即便 patch 了 HTTP,也不该走到请求 —— enabled 闸门在前
    called = {"n": 0}
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: called.__setitem__("n", called["n"] + 1))
    with pytest.raises(MiniMaxTtsError, match="未启用"):
        list(MiniMaxTts("female_std", config=cfg).synthesize("你好"))
    assert called["n"] == 0  # 未发起任何外部请求(不计费)


def test_status_code_string_zero_is_success(monkeypatch, cfg_enabled):
    """review_resp.status_code 返字符串 "0" 也判成功(归一为 int 比较),不误判失败漏句。"""
    import json as _json
    frame = TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2
    pcm = b"\x01\x02" * (frame // 2)
    raw = _json.dumps({"data": {"audio": pcm.hex()}, "base_resp": {"status_code": "0"}}).encode()
    _patch_request(monkeypatch, raw=raw)
    chunks = list(MiniMaxTts("female_std", config=cfg_enabled).synthesize("你好"))
    assert b"".join(chunks) == pcm  # 字符串 "0" 不被误判失败


def test_empty_text_yields_nothing(cfg_enabled):
    tts = MiniMaxTts("female_std", config=cfg_enabled)
    assert list(tts.synthesize("")) == []
    assert list(tts.synthesize("   ")) == []


def test_make_tts_provider_dispatch(monkeypatch):
    """make_tts(voice, provider) 分流(回退语义):
    - minimax 且配置可用(enabled+key)→ FallbackTts(MiniMax 优先,失败回退本地);
    - minimax 但配置不可用(enabled=false / 无 key)→ 直接本地引擎(零浪费,不构造 MiniMaxTts);
    - 缺省/gpu_omnivoice → 本地引擎(AIM_GPU_BACKEND=stub → StubTts)。"""
    from gpu_service import engines
    from gpu_service import minimax_config as mc
    from gpu_service.engines import FallbackTts, StubTts

    monkeypatch.setenv("AIM_GPU_BACKEND", "stub")
    # 配置可用 → FallbackTts
    monkeypatch.setenv("AIM_MINIMAX_SECRET_ID", "")
    monkeypatch.setenv("AIM_MINIMAX_ENABLED", "1")
    monkeypatch.setenv("AIM_MINIMAX_API_KEY", "sk-x")
    mc._reset_for_test()
    assert isinstance(engines.make_tts("female_std", "minimax"), FallbackTts)
    # 配置不可用(关闭)→ 直接本地 StubTts(不构造 MiniMax)
    monkeypatch.delenv("AIM_MINIMAX_ENABLED", raising=False)
    mc._reset_for_test()
    assert isinstance(engines.make_tts("female_std", "minimax"), StubTts)
    mc._reset_for_test()
    # 非 minimax provider 始终本地
    assert isinstance(engines.make_tts("female_std", "gpu_omnivoice"), StubTts)
    assert isinstance(engines.make_tts("female_std", None), StubTts)
    assert isinstance(engines.make_tts("female_std"), StubTts)


def test_fallback_tts_uses_local_on_minimax_failure(monkeypatch, cfg_enabled):
    """FallbackTts:MiniMax 单句抛错 → 用本地引擎合成同句出音(不漏句);MiniMax 成功则用 MiniMax 帧。"""
    from gpu_service import engines
    from gpu_service import minimax_config as mc

    monkeypatch.setenv("AIM_GPU_BACKEND", "stub")  # 本地回退 = StubTts(确定出音)
    # FallbackTts 内部 new MiniMaxTts 会读 get_minimax_config → 需 enabled+key,否则 MiniMax 在 enabled 门就抛
    monkeypatch.setenv("AIM_MINIMAX_SECRET_ID", "")
    monkeypatch.setenv("AIM_MINIMAX_ENABLED", "1")
    monkeypatch.setenv("AIM_MINIMAX_API_KEY", "sk-x")
    mc._reset_for_test()
    engines._reset_health_for_test()  # design contract:清进程级 provider 健康态(免受其它测试残留熔断影响)
    fb = engines.FallbackTts("female_std")
    # 注入一个"必失败"的 MiniMax(限流响应)
    raw = json.dumps({"data": None, "base_resp": {"status_code": 1039}}).encode()
    _patch_request(monkeypatch, raw=raw)
    out = list(fb.synthesize("回退这句"))
    assert len(out) > 0  # 本地 stub 出了音(回退生效,非漏句/静默)

    # MiniMax 成功 → 用 MiniMax 的 PCM(不走回退)。先清健康态(上一句失败已开熔断,否则本句会跳过主直连本地)。
    engines._reset_health_for_test()
    frame = TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2
    pcm = b"\x07\x08" * (frame // 2)
    fb2 = engines.FallbackTts("female_std")
    _patch_request(monkeypatch, raw=_ok_response(pcm))
    assert b"".join(fb2.synthesize("成功这句")) == pcm
    mc._reset_for_test()
    engines._reset_health_for_test()


def test_provider_health_circuit_breaker(monkeypatch, cfg_enabled):
    """design contract:MiniMax 失败 → 开熔断,cooldown 内后续句**跳过 MiniMax 直连本地**(不每句盲试);
    探针成功 → 关熔断切回主。用注入的独立 _ProviderHealth + 计数 request 校验「是否真调了 MiniMax」。"""
    from gpu_service import engines
    from gpu_service import minimax_config as mc

    monkeypatch.setenv("AIM_GPU_BACKEND", "stub")
    monkeypatch.setenv("AIM_MINIMAX_SECRET_ID", "")
    monkeypatch.setenv("AIM_MINIMAX_ENABLED", "1")
    monkeypatch.setenv("AIM_MINIMAX_API_KEY", "sk-x")
    mc._reset_for_test()

    calls = {"n": 0}
    resp_holder = {"raw": b""}
    fail_raw = json.dumps({"data": None, "base_resp": {"status_code": 1039}}).encode()
    ok_pcm = b"\x07\x08" * ((TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2) // 2)

    class _R:
        def read(self): return resp_holder["raw"]
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        return _R()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    # 独立健康态(cooldown 长,便于验「窗内不再调主」),注入 FallbackTts。
    health = engines._ProviderHealth(cooldown_s=999)

    # 句1:MiniMax 失败 → 本地出音 + 开熔断(真调了一次 MiniMax)。
    resp_holder["raw"] = fail_raw
    assert len(list(engines.FallbackTts("female_std", health=health).synthesize("句1"))) > 0
    assert calls["n"] == 1

    # 句2/句3(cooldown 内):跳过 MiniMax(calls 不增)直连本地,仍出音(不漏句)。
    resp_holder["raw"] = _ok_response(ok_pcm)  # 即便注入"会成功"的响应,也不该被调到
    assert len(list(engines.FallbackTts("female_std", health=health).synthesize("句2"))) > 0
    assert len(list(engines.FallbackTts("female_std", health=health).synthesize("句3"))) > 0
    assert calls["n"] == 1  # 熔断 OPEN:窗内一次 MiniMax 都没再调

    # cooldown 到期 → HALF_OPEN 放一句探针(成功)→ 关熔断,后续切回主。
    health._open_until = engines.time.monotonic() - 1  # 手工过期(monotonic)
    out = b"".join(engines.FallbackTts("female_std", health=health).synthesize("探针句"))
    assert out == ok_pcm  # 用了 MiniMax 帧(探针成功)
    assert calls["n"] == 2  # 探针真调了主
    # 探针成功后 healthy:下一句正常走主(再 +1)。
    assert b"".join(engines.FallbackTts("female_std", health=health).synthesize("恢复后")) == ok_pcm
    assert calls["n"] == 3
    mc._reset_for_test()


def test_cancel_between_frames_via_orchestrator(monkeypatch, cfg_enabled):
    """打断等价性(回灌阶段):SessionOrchestrator.on_tts_text 在帧间查 _cancelled,
    与 OmniVoice 逐字节一致 —— 用 minimax 注入的会话同样停在帧间。"""
    from gpu_service.session import SessionOrchestrator

    frame_bytes = TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2
    pcm = b"\x01\x02" * (frame_bytes * 4 // 2)  # 4 帧
    _patch_request(monkeypatch, raw=_ok_response(pcm))
    orch = SessionOrchestrator("sess", tts=MiniMaxTts("female_std", config=cfg_enabled))
    gen = orch.on_tts_text("一句话")
    out1 = next(gen)
    assert out1.control.type == "tts_audio_meta"
    orch._cancelled = True  # 模拟 barge-in:下一帧前置位
    rest = list(gen)
    # 被 cancel:不再产 tts_audio_meta,也不发 tts_done(与 OmniVoice 路径一致)
    assert all(o.control.type != "tts_done" for o in rest)


def test_minimax_probe_covers_english_voice(monkeypatch):
    """probe key-space(review):配了英文键(<key>.en)时,probe 额外验英文 voice_id
    ——否则英文音色非法只在真实英文会话才 2013 失败。断言 probe 真调了英文 voice_id + English boost。"""
    from gpu_service import minimax_config as mc
    from gpu_service import server

    mc._reset_for_test()
    monkeypatch.setenv("AIM_MINIMAX_SECRET_ID", "")
    monkeypatch.setenv("AIM_MINIMAX_ENABLED", "1")
    monkeypatch.setenv("AIM_MINIMAX_API_KEY", "sk-x")

    frame_bytes = TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2
    seen: list[tuple[str, str]] = []  # (voice_id, language_boost) 每次请求

    class _Resp:
        def read(self): return _ok_response(b"\x00" * frame_bytes)
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout=None):
        body = json.loads(req.data.decode("utf-8"))
        seen.append((body["voice_setting"]["voice_id"], body["language_boost"]))
        return _Resp()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    receipt = server.minimax_probe()
    mc._reset_for_test()

    assert receipt["ok"] is True
    # 中文裸键 + 英文 .en 键都被探(env 回退用默认 voice_map,含英文键)
    assert set(receipt["per_voice"]) == {"female_std", "male_std", "female_std.en", "male_std.en"}
    # 英文键真调了英文 voice_id + English boost(否则非法英文音色 probe 期发现不了)
    assert ("English_Trustworth_Man", "English") in seen
    assert ("English_Graceful_Lady", "English") in seen
    # 中文键仍是中文音色 + Chinese boost
    assert ("Chinese (Mandarin)_Gentleman", "Chinese") in seen


def test_config_atomic_hot_reload(monkeypatch):
    """热加载原子替换:reload_minimax_config 整体替换引用;已 snapshot 旧配置的实例不受影响。"""
    mc._reset_for_test()
    monkeypatch.setenv("AIM_MINIMAX_SECRET_ID", "")  # 走 env 回退
    monkeypatch.setenv("AIM_MINIMAX_ENABLED", "1")
    monkeypatch.setenv("AIM_MINIMAX_API_KEY", "old-key")
    monkeypatch.delenv("AIM_MINIMAX_BASE_URL", raising=False)
    old = mc.get_minimax_config()
    assert old.api_key == "old-key"
    # 一通在途会话 snapshot 了 old
    tts_inflight = MiniMaxTts("female_std", config=old)
    # admin 改 key → 热加载
    monkeypatch.setenv("AIM_MINIMAX_API_KEY", "new-key")
    new = mc.reload_minimax_config()
    assert new.api_key == "new-key"
    assert mc.get_minimax_config().api_key == "new-key"  # 新会话读到新值
    assert tts_inflight._cfg.api_key == "old-key"  # 在途会话不受影响(原子替换,非半更新)
    mc._reset_for_test()
