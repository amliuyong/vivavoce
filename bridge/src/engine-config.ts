/**
 * 三段式引擎配置**叶子模块**(design contract)—— TTS/LLM 超时、cancel_ack 窗、kickoff 唤醒文本、
 * 出题游标兜底 各族的**默认值 + 解析器**单一事实源。
 *
 * 存在理由与依赖方向同 `media-config.ts`(见该文件头注释):`three-stage-engine.ts`(2238 行)
 * 既是默认值的家、又要消费 registry,直接 import 会成真循环。故下沉到本叶子模块。
 *
 * 本文件 **MUST NOT** import `runtime-config` / `three-stage-engine` / 任何业务大模块(有测试守门)。
 *
 * 行为等价红线:解析器从 `three-stage-engine.ts` **逐字搬运**,含内联 `?? D` 的空串语义
 * (`X=""` → `Number("")` = 0,**非**默认)与 `Math.max(1, …)` 下限,MUST NOT 借机统一。
 */

// ── 默认值(逐字沿用搬运前 three-stage-engine.ts 的字面量;改这里 = 改线上行为)──
export const ENGINE_DEFAULTS = {
  /**
   * TTS 看门狗(ms):GPU 既无 tts_audio_meta 也无 tts_done 时由引擎自身终结本轮。
   * ⚠ `<= 0` 会**禁用**该看门狗 —— 故 `AIM_TTS_TIMEOUT_MS=""`(得 0)是危险配置,
   *   characterization 测试已钉死此现状语义,勿「顺手修成回退默认」。
   */
  ttsTimeoutMs: 12000,
  /**
   * LLM 首 token 超时(ms)。真机实测跨境 mantle GLM TTFB 抖动 1.2~9.3s,
   * 旧值 8000 会把正常轮误判超时致 AI 频繁哑 → 放宽到 25000。0=禁用。
   */
  llmTtftTimeoutMs: 25000,
  /** cancel_ack 旁路核对超时(ms);GPU WS 内网 RTT 通常 < 20ms,300 留 ~15× 余量。 */
  cancelAckTimeoutMs: 300,
  /** 主动开场唤醒文本(极短、人设无关;**不写入对话历史**)。 */
  kickoffWakeText: "(请开始)",
  /** design contract 出题游标推进闭环:默认关(= 现状开环推进,逐字节等价)。 */
  cursorVoicedGate: false,
  /** 同题连续 N 轮仍未置「已念出」→ fallback 现状推进(防永久卡一题)。 */
  cursorVoicedMaxStall: 2,
  /** design contract 排水陈货连续判「不驱动推进」达此轮数 → 强制推进(不复用 voicedStall)。 */
  staleAnswerMax: 2,
} as const;

// ── 解析器(逐字搬运)──

/** 注:内联 `?? D` 口径 —— 空串**非** nullish,故 `X=""` 得 0(非默认)。刻意保留。 */
export const ttsTimeoutMs = (): number =>
  Number(process.env.AIM_TTS_TIMEOUT_MS ?? ENGINE_DEFAULTS.ttsTimeoutMs);

export const llmTtftTimeoutMs = (): number =>
  Number(process.env.AIM_LLM_TTFT_TIMEOUT_MS ?? ENGINE_DEFAULTS.llmTtftTimeoutMs);

export const cancelAckTimeoutMs = (): number =>
  Number(process.env.AIM_CANCEL_ACK_TIMEOUT_MS ?? ENGINE_DEFAULTS.cancelAckTimeoutMs);

/** 注:`||` 口径 —— 空串是 falsy,故 `X=""` 回退默认(与上面 `??` 族**不同**,刻意保留)。 */
export const kickoffWakeText = (): string =>
  process.env.AIM_KICKOFF_WAKE_TEXT || ENGINE_DEFAULTS.kickoffWakeText;

export const cursorVoicedGate = (): boolean => process.env.AIM_CURSOR_VOICED_GATE === "1";

export const cursorVoicedMaxStall = (): number =>
  Math.max(1, Number(process.env.AIM_CURSOR_VOICED_MAX_STALL ?? ENGINE_DEFAULTS.cursorVoicedMaxStall));

export const staleAnswerMax = (): number =>
  Math.max(1, Number(process.env.AIM_STALE_ANSWER_MAX ?? ENGINE_DEFAULTS.staleAnswerMax));
