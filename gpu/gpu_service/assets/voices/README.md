# Local reference voices

This directory contains deployment-local voice-cloning inputs. Git ignores
every file here except this README. The public source distribution intentionally
does not include voice audio or matching transcripts.

Only add audio that you have the right and consent to use. Do not publish,
commit, or redistribute generated/provider voices unless their terms
explicitly permit it.

三段式 TTS(OmniVoice)用 **voice clone** 模式锁声纹:每句合成都从同一段参考音克隆音色,
跨句、跨轮、整场完全一致(修「voice design / instruct 仍句间漂移」根因)。

## 文件

| 文件 | 含义 |
|---|---|
| `<key>.wav` | 参考音(24kHz mono s16le,~8s)。`key` = 语义音色 key:`female_std` / `male_std`。**裸文件名 = 默认语言 = 中文母语。** |
| `<key>.txt` | 该 wav 的真实转写,作 `create_voice_clone_prompt` 的 `ref_text`。 |
| `<key>.<lang>.wav` | **语言特化参考音**(如 `male_std.en.wav` = 英文母语声纹)。修「英文用中文声纹 → 口音重」。 |
| `<key>.<lang>.txt` | 该语言特化 wav 的转写(英文用 MiniMax 忠实朗读文本,逐字匹配音频)。 |

**语言维度(修英文口音根因)**:voice clone 锁的是「谁的嗓子 + 什么发音习惯」,中文母语参考音念英文
必带中式口音。故按会话 `engine.language` 选**语言特化参考音**:
- `language=en`(或 en-US…)→ 用 `<key>.en.wav`(英文母语声纹)整场固定;
- `language=auto`(跟随题目语言)→ **逐句**按文本 CJK/拉丁占比检测选中/英参考音(`_detect_text_lang`);
- 无对应 `<key>.<lang>.wav` → 回退裸 `<key>.wav`(= 中文默认,现状语义不变)。

代码入口:`gpu_service/funasr_backend.py::_voice_ref(voice, lang)`(按 key×语言取 wav+txt,带回退链)。
Dockerfile `COPY gpu_service ./gpu_service` 自动把本目录烘进镜像,runtime 不触网。

## ⚠ 两个 `.txt` 不要互相对齐

`female_std.txt` 与 `male_std.txt` 内容**故意不同**(一个有标点、一个没有),这是正确的:

- 每个 `.txt` 必须匹配**它对应那段 wav 的真实发音**,而不是匹配另一个 key 的文本。
- 两段 wav 是分别生成的(男/女声采样路径不同),Whisper 对各自的转写本就略有差异。
- voice clone 把 `(ref_audio, ref_text)` 成对喂给模型;若把 `ref_text` 改成与 wav 发音不符的内容,
  模型会「读错词 / 跑飞」→ 破坏 clone。
- 它们内容相近只是因为生成时用了同一句输入文本,但各自独立服务于各自的 wav。

## 重新生成 / 新增音色

新增音色 = 在带 GPU 的机器上生成一段 wav + 用 OmniVoice 自带 Whisper 转写出 `.txt`,
两者一起 checkin,并在 `funasr_backend.KNOWN_VOICE_KEYS` 加上 key(若要前端可选还需扩
`backend EngineParams.voice` 的 Literal + 前端 i18n)。
中文参考音须通过有权使用和再分发的生成流程重新生成，并在发布前记录来源与授权。

## 生成英文母语参考音(`<key>.en.wav`)

英文参考音可用 **MiniMax T2A**(项目已集成)合成 —— `ref_text` 直接用输入文本、
**无需 Whisper 转写**,故可在**无 GPU** 机器上跑:

```bash
python gpu/scripts/gen_reference_voice.py \
    --secret-id <secret name> --profile <profile> --region <region>
# 或通过 .env 中的 VIVA_MINIMAX_API_KEY:
./scripts/viva voices
```

脚本输出 24kHz mono s16le WAV(与中文参考音同格式),英文 system voice 与中文音色性别/气质对齐
(见 `gen_reference_voice.py::EN_VOICE_BY_KEY`)。新增某语言参考音 = 加 `<key>.<lang>.{wav,txt}`,
运行时链路(`_voice_ref` / `OmniVoiceTts` / `make_tts`)**不用改**——语言是正交维度,自动生效。
