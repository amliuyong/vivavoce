"""TTS 参考音/音色的**语言维度**工具(轻量、零重依赖,OmniVoice 与 MiniMax 两段共用)。

背景(修「英文用中文声纹/中文音色 → 口音重」根因):TTS 音色 key(male_std/female_std)决定
**性别/角色**,语言决定**母语发音**。两段 TTS 后端据会话 language 选语言特化资产:
  - 本地 OmniVoice:选语言特化**参考音**(<key>.<lang>.wav,voice clone 锁英文母语声纹);
  - 云端 MiniMax:选语言特化 **voice_id**(voice_map 的 "<key>.<lang>" 键 → 英文 system voice)。

两段共用同一套「语言归一 + auto 逐句语种检测」逻辑(集中此处,避免两边实现漂移)。本模块只用
标准库,不 import funasr_backend(那模块加载数 GB 权重),故 minimax_tts 亦可安全依赖。
"""
from __future__ import annotations

import re

# 语言特化音色/参考音的命名/映射键约定:"<key>.<lang>"(如 male_std.en)。
LANG_SUFFIX_SEP = "."


def normalize_lang(language: str | None) -> str | None:
    """会话 engine.language(zh-CN / en / en-US / auto…)→ 参考音语言模式。
      - 'auto'(跟随题目语言):整场不定 → 调用方 synthesize 时**逐句** detect_text_lang;
      - 具体语言:取 2 字母前缀(en-US→en、zh-CN→zh);
      - 空/无字母:None(调用方回退默认语言 = 中文)。
    不写死可用语言清单 —— 某语言是否真有特化资产由资产层(wav / voice_map)决定,找不到自然回退默认。"""
    if not language:
        return None
    lang = language.strip().lower()
    if lang.startswith("auto"):
        return "auto"
    m = re.match(r"[a-z]+", lang)
    return m.group(0) if m else None


def detect_text_lang(text: str) -> str | None:
    """auto 模式逐句选语言:按文本字符占比粗判该句语言(纯文本启发,不触网/不加载模型)。
      - 含 CJK(中日韩统一表意文字)→ None(用默认=中文音色):中文音色念偶发英文词尚可,反之
        英文音色念中文极差,故**有 CJK 就走中文**(CJK 优先,与「同句不中英混杂」的语言指令相容);
      - 无 CJK 且有拉丁字母 → 'en';
      - 纯符号/数字/空 → None(默认)。"""
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿" or "㐀" <= ch <= "䶿")
    if cjk:
        return None
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    return "en" if latin else None


def resolve_lang_for_text(ref_lang: str | None, text: str) -> str | None:
    """据参考音语言模式(normalize_lang 的结果)与本句文本,定出本句实际用哪种语言资产。
    'auto' → 逐句 detect_text_lang;具体语言 → 整场固定;None → None(默认中文)。"""
    if ref_lang == "auto":
        return detect_text_lang(text)
    return ref_lang


def lang_key(base_key: str, lang: str | None) -> str:
    """(音色 key, 语言) → 语言特化资产键:lang 为空 → 裸 key(默认中文);否则 "<key>.<lang>"。
    OmniVoice 用它拼参考音文件名前缀,MiniMax 用它查 voice_map 的语言特化键。"""
    if not lang:
        return base_key
    return f"{base_key}{LANG_SUFFIX_SEP}{lang}"
