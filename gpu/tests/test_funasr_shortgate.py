"""FunASR 短句门 + 去标点纯逻辑 UT(review:不误杀中文一字答、挡住噪声残片)。

只测模块级纯函数/常量,不实例化 FunAsr(那需 GPU 模型权重)。
"""
from __future__ import annotations

from gpu_service.funasr_backend import _SHORT_ALLOWLIST, _SHORT_ALLOWLIST_EN, _strip_punct


def test_strip_punct_keeps_cjk_drops_punctuation():
    assert _strip_punct("下。") == "下"
    assert _strip_punct("ど?") == "ど"
    assert _strip_punct("。，！？ ") == ""
    assert _strip_punct("闰年") == "闰年"
    assert _strip_punct("hello, world!") == "helloworld"


def _passes_short_gate(text: str, min_chars: int = 2) -> bool:
    """复刻 finalize 短句门判定:去标点后 >= min_chars 或在中/英 allowlist(英文大小写不敏感)→ 放行。"""
    s = _strip_punct(text)
    return not (
        min_chars > 0
        and len(s) < min_chars
        and s not in _SHORT_ALLOWLIST
        and s.lower() not in _SHORT_ALLOWLIST_EN
    )


def test_short_gate_passes_common_single_char_answers():
    # review:中文合法一字答不能被误杀
    for ans in ["对", "嗯", "好", "是", "不", "行", "有", "没"]:
        assert _passes_short_gate(ans), f"一字答 {ans!r} 应放行"


def test_short_gate_passes_english_single_char_answers():
    # review:英文 Profile 的合法单字符答复(选择题 A/B/C/D、yes-no 单字母)不被误杀,大小写不敏感
    for ans in ["A", "b", "C", "d", "Y", "n", "OK", "yes", "No"]:
        assert _passes_short_gate(ans), f"英文短答 {ans!r} 应放行"


def test_short_gate_blocks_noise_fragments():
    # 噪声/截断/IVR 残片 / 非答案单字幻听 → 过滤(注:A/B/C/D 现为合法选择题答案,见上;此处用非答案字母)
    for noise in ["下", "我", "ど", "Z", "。", "", " "]:
        assert not _passes_short_gate(noise), f"残片 {noise!r} 应过滤"


def test_short_gate_passes_multi_char():
    for ok in ["闰年", "你好", "下一个闰年", "好的"]:
        assert _passes_short_gate(ok)


def test_short_gate_disabled_when_min_zero():
    # AIM_ASR_MIN_FINAL_CHARS=0 关闭过滤 → 任何非空都放行
    assert _passes_short_gate("下", min_chars=0)
