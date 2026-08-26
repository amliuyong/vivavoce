/**
 * 媒体面运行时配置 registry(design contract)—— 把散落各模块的 `AIM_*` env 读取 + 钳制归拢为**单一 typed
 * effective-config 快照**,业务逻辑与只读 `/config` 端点**共读同一份**。
 *
 * ## 铁律:本文件 MUST NOT 出现任何默认值字面量
 *
 * 每个条目的 `default` 一律 **import 自配置叶子模块**(`TURN_HANDLING_DEFAULTS` / `MEDIA_DEFAULTS` /
 * `ENGINE_DEFAULTS` / `SPEAKER_LOCK_DEFAULTS` / `ACK_TIMEOUT_DEFAULTS` / 各 `*_DEFAULT_MS` …),
 * 解析一律**调用叶子模块自己的解析函数**(不重写钳制边界)。
 *
 * 为什么是铁律(实测,非洁癖):首版本文件用「手抄 `const D_X = <字面量>`」的做法,机械全量比对
 * (`tools/audit-registry-drift.py`)结果 ——
 *
 * | 默认值来源 | 项数 | 与源码不符 |
 * |---|---|---|
 * | 手抄字面量 | 50 | **23(46%)** |
 * | import 叶子模块 | 36 | **0** |
 *
 * 最严重 `AIM_SPEAKER_LOCK_TIMEOUT_MS` 源码 200 vs 手抄 15000(**差 75 倍**);`AIM_PLAYBACK_ACK_MODE`
 * 被抄成**不存在的枚举值** `"ack_only"`;`AIM_INTERACTION_STYLE` 布尔开关被抄成字符串。而 805 条单测
 * **同时全绿** —— 因为断言校验的是 registry 自己声明的默认值,不是源码里的。
 *
 * 结论:漂移根因是**架构**(默认值存在第二份可写副本)而非审计不严。故让手抄在**物理上不可能**。
 * 守门见 `bridge/test/runtime-config.test.ts`(源码级断言 + 逐 key 对叶子模块导出)。
 *
 * ## 依赖方向(不成环)
 *
 * ```
 * media-session / three-stage-engine / index ─┐
 *                                             ├─→ runtime-config(本文件)─→ 各配置叶子模块
 * config-endpoint ────────────────────────────┘
 * ```
 * 叶子模块 **MUST NOT** import 本文件(有测试守门)。实证:若默认值与 registry 消费方同文件,
 * 加载顺序决定 `RC` 是否为 `undefined`(先加载业务模块 → undefined;先加载 registry → 正常)。
 *
 * ## 模块加载时快照
 *
 * 值在 import 时冻结;之后改 env 对业务逻辑 + `/config` 序列化均无效 —— 这是设计:端点必须报告与
 * 业务一致的快照,不可重解析 env。测试需不同快照时用 `jest.resetModules()` + `require()`。
 */
import * as engineConfig from "./engine-config";
import * as mediaConfig from "./media-config";
// 三条旁路 LLM 超时:从**纯叶子** bypass-llm-config 取(不从 moderation-verdict/eou-verdict/
// transcript-fixer 这些行为模块取 —— 它们常被 jest.mock,partial mock 会让 registry 加载期崩)。
import {
  BYPASS_LLM_TIMEOUT_DEFAULTS,
  eouVerdictTimeoutMs,
  fixerTimeoutMs,
  moderationTimeoutMs,
} from "./bypass-llm-config";
import {
  ACK_TIMEOUT_DEFAULTS,
  loadAckTimeoutConfig,
  type AckTimeoutConfig,
} from "./playback-settlement";
import {
  CALM_TONE_DEFAULT,
  INTERACTION_STYLE_DEFAULT,
  OPEN_CHAT_DIRECTIVE_DEFAULT,
  calmToneEnabled,
  interactionStyleEnabled,
  openChatDirectiveEnabled,
} from "./prompt-compose";
import { ANTIALIAS_DEFAULTS, antialiasFcHz, antialiasOn, antialiasTaps } from "./resample";
import {
  SPEAKER_LOCK_DEFAULTS,
  loadSpeakerLockConfig,
  type SpeakerLockConfig,
} from "./speaker-lock";
import {
  EOU_CORRELATION_MARGIN_MS,
  TURN_HANDLING_DEFAULTS,
  loadTurnHandling,
  type TurnHandling,
} from "./turn-handling";
import { CONVERSE_KEEPALIVE_DEFAULT_MS, converseKeepaliveMs } from "./bedrock-converse-llm";
import { MANTLE_KEEPALIVE_DEFAULT_MS, mantleKeepaliveMs } from "./mantle-llm";
import { LLM_FALLBACK_ATTEMPT_DEFAULT_MS, llmFallbackAttemptMs } from "./fallback-llm";

/** env 被显式设置的三态(design contract:二值 `fromEnv` 分不清「没设」与「设了但被丢弃」)。 */
export type OverrideState =
  /** 未设(undefined / 空串 / 纯空白)。 */
  | "absent"
  /** 设了且被接受(生效值即来自 env)。 */
  | "valid"
  /** 设了但非法/越界,被回退或钳制 —— 运维最需看见的错配信号。 */
  | "ignored_invalid";

export interface ConfigEntry {
  /** env 变量名(= 条目 key)。 */
  key: string;
  /** 业务**实际在用**的生效值(已解析 + 已钳制)。 */
  value: string | number | boolean;
  /** 内建默认值(env 未设时的值)。**一律来自叶子模块导出**,不在本文件写字面量。 */
  default: string | number | boolean;
  /** env 覆盖状态三态(控制面据此判 origin)。 */
  override_state: OverrideState;
}

/** env 原始值是否「已设置」(空串/纯空白视作未设,与各 num() 口径一致)。 */
function isSet(key: string): boolean {
  const raw = process.env[key];
  return raw !== undefined && raw.trim() !== "";
}

/**
 * 判 override_state:比较「env 设了没」与「生效值是否等于默认」。
 *
 * `ignored_invalid` 的判据 = **设了 env、但生效值仍等于内建默认** —— 说明该 env 被解析器丢弃
 * (非法/越界/非数字)。注意存在**假阴性**:显式把 env 设成恰好等于默认值时会判 `valid`,
 * 这是可接受的(此时行为与默认一致,运维无需被提示)。
 */
function overrideState(
  wasSet: boolean,
  value: string | number | boolean,
  dflt: string | number | boolean,
): OverrideState {
  if (!wasSet) return "absent";
  return value === dflt ? "ignored_invalid" : "valid";
}

/**
 * 单一事实源:所有**可调** `AIM_*` key。与 `bridge/config-inventory.json`(机械扫描产物)对齐,
 * 由守门测试比对 —— 新增开关漏登记即红。
 */
export const TUNABLE_KEYS = [
  // turn-handling(端点/打断/出题游标/主动开场/误打断恢复/动态噪声地板/EOU 纠偏/开口冷却/播放时钟…)
  "AIM_ENDPOINT_RMS_THRESHOLD", "AIM_ENDPOINT_SILENCE_GAP_MS", "AIM_ENDPOINT_MIN_SPEECH_MS",
  "AIM_VAD_ENERGY_THRESHOLD",
  "AIM_BARGE_RMS_THRESHOLD", "AIM_BARGE_CONFIRM_MS", "AIM_BARGE_HANGOVER_MS",
  "AIM_INTERRUPTION_MIN_WORDS", "AIM_BARGE_DTD", "AIM_BARGE_DTD_FLOOR", "AIM_BARGE_DTD_ECHO_GAIN",
  "AIM_BARGE_DYN_FLOOR", "AIM_BARGE_DYN_FLOOR_WINDOW_MS", "AIM_BARGE_DYN_FLOOR_K",
  "AIM_FALSE_INTERRUPTION_RECOVERY", "AIM_FALSE_INTERRUPTION_WINDOW_MS",
  "AIM_FALSE_INTERRUPTION_TAKEOVER_MS", "AIM_RECOVERY_TAKEOVER_DECAY",
  "AIM_FALSE_INTERRUPTION_MAX_HOLD_MS",
  "AIM_BARGE_OPEN_COOLDOWN_MS", "AIM_BARGE_OPEN_COOLDOWN_MULT",
  "AIM_MIN_INPUT_CHARS",
  "AIM_PROACTIVE_OPENING", "AIM_PROACTIVE_OPENING_SILENCE_MS",
  "AIM_AI_SPEAKING_MAX_IDLE_MS",
  "AIM_MAX_PLAYBACK_LEAD_MS", "AIM_PLAYBACK_LEAD_MARGIN_MS",
  "AIM_ANSWER_GRACE_MS", "AIM_AUTO_NEXT_GRACE_MS",
  "AIM_QUESTION_MIN_ANSWER_CHARS", "AIM_QUESTION_MAX_RETRY",
  "AIM_QUESTION_MAX_FOLLOW_UPS", "AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS",
  "AIM_EOU_CORRECTION_ENABLED", "AIM_EOU_CORRELATION_MS",
  "AIM_EOU_SUB_THRESHOLD_WINDOW_MS", "AIM_EOU_SUB_THRESHOLD_MULT",
  "AIM_EOU_VERDICT_TIMEOUT_MS",
  // engine-config(三段式引擎超时 / kickoff / 出题游标兜底)
  "AIM_TTS_TIMEOUT_MS", "AIM_LLM_TTFT_TIMEOUT_MS", "AIM_CANCEL_ACK_TIMEOUT_MS",
  "AIM_KICKOFF_WAKE_TEXT",
  "AIM_CURSOR_VOICED_GATE", "AIM_CURSOR_VOICED_MAX_STALL", "AIM_STALE_ANSWER_MAX",
  // media-config(诊断 / 告别挂断 / 语义端 / DTD 窗)
  "AIM_RMS_DIAG", "AIM_RMS_DIAG_EVERY",
  "AIM_SEMANTIC_END",
  "AIM_FAREWELL_HANGUP", "AIM_FAREWELL_HANGUP_DELAY_MS",
  "AIM_FAREWELL_TAIL_MS", "AIM_FAREWELL_DRAIN_MAX_MS",
  "AIM_BARGE_DTD_WINDOW_MS",
  // media-config(违规检测 / 沉默 / 静默推进)
  "AIM_MODERATION_TIMEOUT_MS", "AIM_MODERATION_CONFIDENCE_THRESHOLD",
  "AIM_VIOLATION_ENFORCEMENT", "AIM_SILENCE_VIOLATION_MS", "AIM_SILENCE_WARN_MAX",
  "AIM_SEVERE_VIOLATION_MAX",
  "AIM_NO_FRAME_MS", "AIM_ADVANCE_NUDGE_MS", "AIM_ADVANCE_AFTER_NUDGE_MS",
  "AIM_R3_SILENCE_ADVANCE", "AIM_IDLE_CHATTER_MIN_TURNS", "AIM_FORCED_END_MAX_WAIT_MS",
  // prompt-compose(提示词注入总开关)
  "AIM_CALM_TONE", "AIM_INTERACTION_STYLE", "AIM_OPEN_CHAT_DIRECTIVE",
  // transcript-fixer / playback-settlement
  "AIM_TRANSCRIPT_FIXER_TIMEOUT_MS",
  "AIM_PLAYBACK_ACK_GRACE_MS",
  "AIM_PLAYBACK_ACK_INPUT_GRACE_MS", "AIM_PLAYBACK_ACK_MAX_WAIT_MS",
  // resample(TTS 抗混叠)
  "AIM_TTS_ANTIALIAS", "AIM_TTS_ANTIALIAS_FC_HZ", "AIM_TTS_ANTIALIAS_TAPS",
  // speaker-lock(声纹锁定说话人)
  "AIM_SPEAKER_LOCK_ENABLED", "AIM_SPEAKER_LOCK_EMA",
  "AIM_SPEAKER_LOCK_ENROLL_MS", "AIM_SPEAKER_LOCK_ENROLL_GAP_MS",
  "AIM_SPEAKER_LOCK_ENROLL_CONSISTENCY",
  "AIM_SPEAKER_LOCK_MIN_VERIFY_MS", "AIM_SPEAKER_LOCK_VERIFY_WINDOW_MS",
  "AIM_SPEAKER_LOCK_THRESHOLD_HIGH", "AIM_SPEAKER_LOCK_THRESHOLD_LOW",
  "AIM_SPEAKER_LOCK_TIMEOUT_MS",
  // LLM keepalive / fallback
  "AIM_CONVERSE_KEEPALIVE_MS", "AIM_MANTLE_KEEPALIVE_MS", "AIM_LLM_FALLBACK_ATTEMPT_MS",
] as const;

/**
 * 明确**不**纳入只读总览的 `AIM_*`:逐通下发的凭据 / 寻址 URL / 模型 ID / dev-only flag。
 * 枚举完整性守门用它判「源码里出现但既未登记也未排除」= 漏登记。
 */
export const EXCLUDED_KEYS: readonly string[] = [
  "AIM_LLM_MODEL_ID",            // 逐通下发(控制面 Agent.engine),此处仅回退默认
  "AIM_GPU_WS_URL",              // 寻址
  "AIM_GPU_EMBEDDING_URL",       // 寻址
  "AIM_CONTROL_CALLBACK_URL",    // 寻址
  "AIM_MANTLE_HOST",             // 逐通下发 LLM 配置
  "AIM_BRIDGE_CALLBACK_SECRET",  // 密钥
  "AIM_EMBEDDING_SECRET",        // 密钥
  "AIM_RT_INSECURE",             // dev-only flag
];

export interface RuntimeConfig {
  turnHandling: TurnHandling;
  speakerLock: SpeakerLockConfig;
  ackTimeout: AckTimeoutConfig;
  /** 生效判定超时的**冻结快照**(design contract)—— 关联窗的派生默认要用它。
   *  单独存一份是为守「序列化纯查表、零 env 访问」红线:序列化时不能再调 `eouVerdictTimeoutMs()`。 */
  eouVerdictTimeoutSnapshot: number;
  /** 冻结快照:哪些 key 在模块加载时被显式设置(端点序列化不得重读 env)。 */
  envSet: ReadonlySet<string>;
  /**
   * VAD 阈值快照:bridge 侧**仅**用于跨面不变式校验(endpoint ≥ vad),真驱动在 GPU。
   * MUST 用 `TURN_HANDLING_DEFAULTS.endpointing.rmsThreshold` 作 fallback(与 turn-handling 的
   * fail-fast 解析一致),不可用 `th.endpointing.rmsThreshold`(可能已被 env 覆盖)。
   */
  vadEnergyThreshold: number;
  /** media-config 族的**冻结**生效值(端点不得重调解析器,见下方说明)。 */
  media: {
    rmsDiag: boolean;
    rmsDiagEvery: number;
    semanticEnd: boolean;
    farewellHangup: boolean;
    farewellHangupDelayMs: number;
    farewellTailMs: number;
    farewellDrainMaxMs: number;
    bargeDtdWindowMs: number;
    moderationConfidenceThreshold: number;
    violationEnforcement: boolean;
    silenceViolationMs: number;
    silenceWarnMax: number;
    severeViolationMax: number;
    noFrameMs: number;
    r3SilenceAdvance: boolean;
    idleChatterMinTurns: number;
    forcedEndMaxWaitMs: number;
    /** design contract 派生值:默认 = silenceViolationMs × 40%(非字面量,故 origin=derived)。 */
    advanceNudgeMs: number;
    advanceAfterNudgeMs: number;
    /** 本次计算出的派生默认(供 `default` 字段;派生项的默认不是固定字面量)。 */
    derivedAdvanceDefaultMs: number;
    /** 上述两项是否被**显式** env 覆盖(决定 media-session 是否跑 R3 倒挂 fail-fast 校验)。 */
    r3EnvOverridden: boolean;
  };
  /** engine-config 族的冻结生效值。 */
  engine: {
    ttsTimeoutMs: number;
    llmTtftTimeoutMs: number;
    cancelAckTimeoutMs: number;
    kickoffWakeText: string;
    cursorVoicedGate: boolean;
    cursorVoicedMaxStall: number;
    staleAnswerMax: number;
  };
  /** 其余单项族的冻结生效值。 */
  misc: {
    eouVerdictTimeoutMs: number;
    fixerTimeoutMs: number;
    moderationTimeoutMs: number;
    calmTone: boolean;
    interactionStyle: boolean;
    openChatDirective: boolean;
    ttsAntialias: boolean;
    ttsAntialiasFcHz: number;
    ttsAntialiasTaps: number;
    converseKeepaliveMs: number;
    mantleKeepaliveMs: number;
    llmFallbackAttemptMs: number;
  };
}

/**
 * 在模块加载时**一次性**解析全部配置并冻结。
 *
 * ⚠ 为什么必须在此全量冻结(design contract 的核心语义):端点 MUST 报告「业务实际在用的那一份」。
 * 若 `loadRuntimeConfig()` 在被调用时**再调**各叶子解析器,那就是**第二次解析** —— 业务在模块
 * 加载时求值、端点在请求时求值,两者之间 env 若变化(测试、SSM 改 env 后热读、将来引入动态配置)
 * 就会报出与业务不一致的值,恰好违背本页存在的唯一理由。故序列化只做**查表**,零解析、零 env 访问。
 */
function build(): RuntimeConfig {
  const envSet = new Set(TUNABLE_KEYS.filter((k) => isSet(k)));
  const th = loadTurnHandling();
  const silenceMs = mediaConfig.silenceViolationMs();
  return {
    turnHandling: th,
    speakerLock: loadSpeakerLockConfig(),
    ackTimeout: loadAckTimeoutConfig(),
    eouVerdictTimeoutSnapshot: eouVerdictTimeoutMs(),
    envSet,
    vadEnergyThreshold: (() => {
      const raw = process.env.AIM_VAD_ENERGY_THRESHOLD;
      if (raw === undefined || raw.trim() === "") {
        return TURN_HANDLING_DEFAULTS.endpointing.rmsThreshold;
      }
      const v = Number(raw);
      return Number.isFinite(v) ? v : TURN_HANDLING_DEFAULTS.endpointing.rmsThreshold;
    })(),
    media: {
      rmsDiag: mediaConfig.rmsDiag(),
      rmsDiagEvery: mediaConfig.rmsDiagEvery(),
      semanticEnd: mediaConfig.semanticEnd(),
      farewellHangup: mediaConfig.farewellHangup(),
      farewellHangupDelayMs: mediaConfig.farewellHangupDelayMs(),
      farewellTailMs: mediaConfig.farewellTailMs(),
      farewellDrainMaxMs: mediaConfig.farewellDrainMaxMs(),
      bargeDtdWindowMs: mediaConfig.bargeDtdWindowMs(),
      moderationConfidenceThreshold: mediaConfig.moderationConfidenceThreshold(),
      violationEnforcement: mediaConfig.violationEnforcement(),
      silenceViolationMs: silenceMs,
      silenceWarnMax: mediaConfig.silenceWarnMax(),
      severeViolationMax: mediaConfig.severeViolationMax(),
      noFrameMs: mediaConfig.noFrameMs(),
      r3SilenceAdvance: mediaConfig.r3SilenceAdvance(),
      idleChatterMinTurns: mediaConfig.idleChatterMinTurns(),
      forcedEndMaxWaitMs: mediaConfig.forcedEndMaxWaitMs(),
      advanceNudgeMs: mediaConfig.advanceNudgeMs(silenceMs),
      advanceAfterNudgeMs: mediaConfig.advanceAfterNudgeMs(silenceMs),
      derivedAdvanceDefaultMs: Math.floor(silenceMs * 0.4),
      r3EnvOverridden: mediaConfig.r3EnvOverridden(),
    },
    engine: {
      ttsTimeoutMs: engineConfig.ttsTimeoutMs(),
      llmTtftTimeoutMs: engineConfig.llmTtftTimeoutMs(),
      cancelAckTimeoutMs: engineConfig.cancelAckTimeoutMs(),
      kickoffWakeText: engineConfig.kickoffWakeText(),
      cursorVoicedGate: engineConfig.cursorVoicedGate(),
      cursorVoicedMaxStall: engineConfig.cursorVoicedMaxStall(),
      staleAnswerMax: engineConfig.staleAnswerMax(),
    },
    misc: {
      eouVerdictTimeoutMs: eouVerdictTimeoutMs(),
      fixerTimeoutMs: fixerTimeoutMs(),
      moderationTimeoutMs: moderationTimeoutMs(),
      calmTone: calmToneEnabled(),
      interactionStyle: interactionStyleEnabled(),
      openChatDirective: openChatDirectiveEnabled(),
      ttsAntialias: antialiasOn(),
      ttsAntialiasFcHz: antialiasFcHz(),
      ttsAntialiasTaps: antialiasTaps(),
      converseKeepaliveMs: converseKeepaliveMs(),
      mantleKeepaliveMs: mantleKeepaliveMs(),
      llmFallbackAttemptMs: llmFallbackAttemptMs(),
    },
  };
}

/** 进程级单例(与归拢前「模块级常量解析一次」的行为等价)。 */
export const RC: RuntimeConfig = build();

/**
 * 只读序列化:registry → `ConfigEntry[]`(供 `/config`)。
 *
 * `value` = 业务实际在用的**钳制后**值;`default` = 叶子模块导出的内建默认(**零字面量**)。
 *
 * ★ **纯查表**:本函数 MUST 零 `process.env` 访问、零解析器调用 —— 全部取自 `RC` 的冻结快照
 * (含 `envSet`)。否则业务在模块加载时求值、端点在请求时求值,两者之间 env 若变化就会报出与
 * 业务不一致的值,恰好违背本页存在的唯一理由。守门见 `runtime-config.test.ts` 的「纯查表」用例。
 */
export function loadRuntimeConfig(): ConfigEntry[] {
  const th = RC.turnHandling;
  const thd = TURN_HANDLING_DEFAULTS;
  const sl = RC.speakerLock;
  const sld = SPEAKER_LOCK_DEFAULTS;
  const ack = RC.ackTimeout;
  const md = mediaConfig.MEDIA_DEFAULTS;
  const ed = engineConfig.ENGINE_DEFAULTS;
  const mc = RC.media;  // 冻结快照(零解析)
  const en = RC.engine; // 冻结快照(零解析)

  const e = (
    key: string,
    value: string | number | boolean,
    dflt: string | number | boolean,
  ): ConfigEntry => ({
    key,
    value,
    default: dflt,
    // ★ 纯查表:`wasSet` 取自 **build() 时冻结**的 envSet,MUST NOT 再调 isSet()(那会重读 env)。
    //   实证:曾用 `overrideState(key,…)` 内部调 isSet,导致模块加载后改 env 时
    //   override_state 会从 valid 翻成 absent —— value 冻结而状态漂移,自相矛盾。
    override_state: overrideState(RC.envSet.has(key), value, dflt),
  });

  return [
    // ── turn-handling:端点看门狗 ──
    e("AIM_ENDPOINT_RMS_THRESHOLD", th.endpointing.rmsThreshold, thd.endpointing.rmsThreshold),
    e("AIM_ENDPOINT_SILENCE_GAP_MS", th.endpointing.silenceGapMs, thd.endpointing.silenceGapMs),
    e("AIM_ENDPOINT_MIN_SPEECH_MS", th.endpointing.minSpeechMs, thd.endpointing.minSpeechMs),
    // bridge 侧仅作跨面不变式校验(真驱动在 GPU)
    e("AIM_VAD_ENERGY_THRESHOLD", RC.vadEnergyThreshold, thd.endpointing.rmsThreshold),
    // ── turn-handling:打断(barge-in)──
    e("AIM_BARGE_RMS_THRESHOLD", th.interruption.rmsThreshold, thd.interruption.rmsThreshold),
    e("AIM_BARGE_CONFIRM_MS", th.interruption.confirmMs, thd.interruption.confirmMs),
    e("AIM_BARGE_HANGOVER_MS", th.interruption.hangoverMs, thd.interruption.hangoverMs),
    e("AIM_INTERRUPTION_MIN_WORDS", th.interruption.minWords, thd.interruption.minWords),
    e("AIM_BARGE_DTD", th.interruption.dtdEnabled, thd.interruption.dtdEnabled),
    e("AIM_BARGE_DTD_FLOOR", th.interruption.dtdFloor, thd.interruption.dtdFloor),
    e("AIM_BARGE_DTD_ECHO_GAIN", th.interruption.dtdEchoGain, thd.interruption.dtdEchoGain),
    e("AIM_BARGE_DYN_FLOOR", th.interruption.dynFloorEnabled, thd.interruption.dynFloorEnabled),
    e("AIM_BARGE_DYN_FLOOR_WINDOW_MS", th.interruption.dynFloorWindowMs, thd.interruption.dynFloorWindowMs),
    e("AIM_BARGE_DYN_FLOOR_K", th.interruption.dynFloorK, thd.interruption.dynFloorK),
    e("AIM_FALSE_INTERRUPTION_RECOVERY", th.interruption.recoveryEnabled, thd.interruption.recoveryEnabled),
    e("AIM_FALSE_INTERRUPTION_WINDOW_MS", th.interruption.recoveryWindowMs, thd.interruption.recoveryWindowMs),
    e("AIM_FALSE_INTERRUPTION_TAKEOVER_MS", th.interruption.recoveryTakeoverMs, thd.interruption.recoveryTakeoverMs),
    e("AIM_RECOVERY_TAKEOVER_DECAY", th.interruption.recoveryTakeoverDecay, thd.interruption.recoveryTakeoverDecay),
    e("AIM_FALSE_INTERRUPTION_MAX_HOLD_MS", th.interruption.recoveryMaxHoldMs, thd.interruption.recoveryMaxHoldMs),
    e("AIM_BARGE_OPEN_COOLDOWN_MS", th.interruption.openCooldownMs, thd.interruption.openCooldownMs),
    e("AIM_BARGE_OPEN_COOLDOWN_MULT", th.interruption.openCooldownMult, thd.interruption.openCooldownMult),
    // ── turn-handling:有效输入门槛 / 主动开场 / aiDone 看门狗 ──
    e("AIM_MIN_INPUT_CHARS", th.meaningfulInput.minChars, thd.meaningfulInput.minChars),
    e("AIM_PROACTIVE_OPENING", th.proactiveOpening.enabled, thd.proactiveOpening.enabled),
    e("AIM_PROACTIVE_OPENING_SILENCE_MS", th.proactiveOpening.silenceMs, thd.proactiveOpening.silenceMs),
    e("AIM_AI_SPEAKING_MAX_IDLE_MS", th.aiDoneWatchdog.maxIdleMs, thd.aiDoneWatchdog.maxIdleMs),
    // ── turn-handling:播放时钟 / 作答宽限 ──
    e("AIM_MAX_PLAYBACK_LEAD_MS", th.playbackClock.maxLeadMs, thd.playbackClock.maxLeadMs),
    e("AIM_PLAYBACK_LEAD_MARGIN_MS", th.playbackClock.leadMarginMs, thd.playbackClock.leadMarginMs),
    e("AIM_ANSWER_GRACE_MS", th.answerGrace.defaultMs, thd.answerGrace.defaultMs),
    e("AIM_AUTO_NEXT_GRACE_MS", th.answerGrace.autoNextMs, thd.answerGrace.autoNextMs),
    // ── turn-handling:出题推进(design contract)──
    e("AIM_QUESTION_MIN_ANSWER_CHARS", th.questionProgression.minAnswerChars,
      thd.questionProgression.minAnswerChars),
    e("AIM_QUESTION_MAX_RETRY", th.questionProgression.maxRetryPerQuestion,
      thd.questionProgression.maxRetryPerQuestion),
    e("AIM_QUESTION_MAX_FOLLOW_UPS", th.questionProgression.maxFollowUpsPerQuestion,
      thd.questionProgression.maxFollowUpsPerQuestion),
    e("AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS", th.questionProgression.forceClosureStreamTimeoutMs,
      thd.questionProgression.forceClosureStreamTimeoutMs),
    // ── turn-handling:EOU 纠偏(design contract)──
    e("AIM_EOU_CORRECTION_ENABLED", th.eouCorrection.enabled, thd.eouCorrection.enabled),
    // ★ review:关联窗的默认值是**派生**的(生效判定超时 + 余量),故 registry 上报的
    //   `default` MUST 用**同一派生式**,不能用 `thd.eouCorrection.correlationMs`(那是「超时取默认时」
    //   的派生结果 7000)。否则 timeout=8000 时业务实际用 9000、registry 却报默认 7000 →
    //   只读页把它误标「异于默认」,而这恰是本 spec 要消灭的假信号。
    //   ★ 仍是**纯查表**:`RC.ackTimeout` 是冻结快照里的生效超时,不重读 env(design contract 红线)。
    e(
      "AIM_EOU_CORRELATION_MS",
      th.eouCorrection.correlationMs,
      RC.eouVerdictTimeoutSnapshot + EOU_CORRELATION_MARGIN_MS,
    ),
    // design contract:降门槛窗独立于关联窗(此前共用 correlationMs,致「调超时顺带改宽容期」)。
    e("AIM_EOU_SUB_THRESHOLD_WINDOW_MS", th.eouCorrection.subThresholdWindowMs, thd.eouCorrection.subThresholdWindowMs),
    e("AIM_EOU_SUB_THRESHOLD_MULT", th.eouCorrection.subThresholdMult, thd.eouCorrection.subThresholdMult),
    // 两处独立钳制已收敛到 eou-verdict 的同一函数(跨境部署最可能调它)
    e("AIM_EOU_VERDICT_TIMEOUT_MS", RC.misc.eouVerdictTimeoutMs, BYPASS_LLM_TIMEOUT_DEFAULTS.eouVerdictMs),
    // ── engine-config:三段式引擎 ──
    e("AIM_TTS_TIMEOUT_MS", en.ttsTimeoutMs, ed.ttsTimeoutMs),
    e("AIM_LLM_TTFT_TIMEOUT_MS", en.llmTtftTimeoutMs, ed.llmTtftTimeoutMs),
    e("AIM_CANCEL_ACK_TIMEOUT_MS", en.cancelAckTimeoutMs, ed.cancelAckTimeoutMs),
    e("AIM_KICKOFF_WAKE_TEXT", en.kickoffWakeText, ed.kickoffWakeText),
    e("AIM_CURSOR_VOICED_GATE", en.cursorVoicedGate, ed.cursorVoicedGate),
    e("AIM_CURSOR_VOICED_MAX_STALL", en.cursorVoicedMaxStall, ed.cursorVoicedMaxStall),
    e("AIM_STALE_ANSWER_MAX", en.staleAnswerMax, ed.staleAnswerMax),
    // ── media-config:诊断 / 告别 / 语义端 / DTD 窗 ──
    e("AIM_RMS_DIAG", mc.rmsDiag, md.rmsDiag),
    e("AIM_RMS_DIAG_EVERY", mc.rmsDiagEvery, md.rmsDiagEvery),
    e("AIM_SEMANTIC_END", mc.semanticEnd, md.semanticEnd),
    e("AIM_FAREWELL_HANGUP", mc.farewellHangup, md.farewellHangup),
    e("AIM_FAREWELL_HANGUP_DELAY_MS", mc.farewellHangupDelayMs, md.farewellHangupDelayMs),
    e("AIM_FAREWELL_TAIL_MS", mc.farewellTailMs, md.farewellTailMs),
    e("AIM_FAREWELL_DRAIN_MAX_MS", mc.farewellDrainMaxMs, md.farewellDrainMaxMs),
    e("AIM_BARGE_DTD_WINDOW_MS", mc.bargeDtdWindowMs, md.bargeDtdWindowMs),
    // ── media-config:违规检测 / 沉默 / 静默推进 ──
    e("AIM_MODERATION_TIMEOUT_MS", RC.misc.moderationTimeoutMs, BYPASS_LLM_TIMEOUT_DEFAULTS.moderationMs),
    e("AIM_MODERATION_CONFIDENCE_THRESHOLD", mc.moderationConfidenceThreshold,
      md.moderationConfidenceThreshold),
    e("AIM_VIOLATION_ENFORCEMENT", mc.violationEnforcement, md.violationEnforcement),
    e("AIM_SILENCE_VIOLATION_MS", mc.silenceViolationMs, md.silenceViolationMs),
    e("AIM_SILENCE_WARN_MAX", mc.silenceWarnMax, md.silenceWarnMax),
    e("AIM_SEVERE_VIOLATION_MAX", mc.severeViolationMax, md.severeViolationMax),
    e("AIM_NO_FRAME_MS", mc.noFrameMs, md.noFrameMs),
    // ★ 派生默认(design contract):默认 = silenceViolationMs × 40%,非固定字面量。
    //   `default` 取**本次计算出的**派生值 —— 控制面据 default_kind=derived 呈现派生关系。
    e("AIM_ADVANCE_NUDGE_MS", mc.advanceNudgeMs, mc.derivedAdvanceDefaultMs),
    e("AIM_ADVANCE_AFTER_NUDGE_MS", mc.advanceAfterNudgeMs, mc.derivedAdvanceDefaultMs),
    e("AIM_R3_SILENCE_ADVANCE", mc.r3SilenceAdvance, md.r3SilenceAdvance),
    e("AIM_IDLE_CHATTER_MIN_TURNS", mc.idleChatterMinTurns, md.idleChatterMinTurns),
    e("AIM_FORCED_END_MAX_WAIT_MS", mc.forcedEndMaxWaitMs, md.forcedEndMaxWaitMs),
    // ── prompt-compose:提示词注入总开关 ──
    e("AIM_CALM_TONE", RC.misc.calmTone, CALM_TONE_DEFAULT),
    e("AIM_INTERACTION_STYLE", RC.misc.interactionStyle, INTERACTION_STYLE_DEFAULT),
    e("AIM_OPEN_CHAT_DIRECTIVE", RC.misc.openChatDirective, OPEN_CHAT_DIRECTIVE_DEFAULT),
    // ── transcript-fixer / playback-settlement ──
    e("AIM_TRANSCRIPT_FIXER_TIMEOUT_MS", RC.misc.fixerTimeoutMs, BYPASS_LLM_TIMEOUT_DEFAULTS.fixerMs),
    e("AIM_PLAYBACK_ACK_GRACE_MS", ack.graceMs, ACK_TIMEOUT_DEFAULTS.graceMs),
    e("AIM_PLAYBACK_ACK_INPUT_GRACE_MS", ack.inputGraceMs, ACK_TIMEOUT_DEFAULTS.inputGraceMs),
    e("AIM_PLAYBACK_ACK_MAX_WAIT_MS", ack.maxWaitMs, ACK_TIMEOUT_DEFAULTS.maxWaitMs),
    // ── resample:TTS 抗混叠(复用真实解析器,含奇数化)──
    e("AIM_TTS_ANTIALIAS", RC.misc.ttsAntialias, ANTIALIAS_DEFAULTS.on),
    e("AIM_TTS_ANTIALIAS_FC_HZ", RC.misc.ttsAntialiasFcHz, ANTIALIAS_DEFAULTS.fcHz),
    e("AIM_TTS_ANTIALIAS_TAPS", RC.misc.ttsAntialiasTaps, ANTIALIAS_DEFAULTS.taps),
    // ── speaker-lock ──
    e("AIM_SPEAKER_LOCK_ENABLED", sl.enabled, sld.enabled),
    e("AIM_SPEAKER_LOCK_EMA", sl.ema, sld.ema),
    e("AIM_SPEAKER_LOCK_ENROLL_MS", sl.enrollMs, sld.enrollMs),
    e("AIM_SPEAKER_LOCK_ENROLL_GAP_MS", sl.enrollGapMs, sld.enrollGapMs),
    e("AIM_SPEAKER_LOCK_ENROLL_CONSISTENCY", sl.enrollConsistency, sld.enrollConsistency),
    e("AIM_SPEAKER_LOCK_MIN_VERIFY_MS", sl.minVerifyMs, sld.minVerifyMs),
    e("AIM_SPEAKER_LOCK_VERIFY_WINDOW_MS", sl.verifyWindowMs, sld.verifyWindowMs),
    e("AIM_SPEAKER_LOCK_THRESHOLD_HIGH", sl.thresholdHigh, sld.thresholdHigh),
    e("AIM_SPEAKER_LOCK_THRESHOLD_LOW", sl.thresholdLow, sld.thresholdLow),
    e("AIM_SPEAKER_LOCK_TIMEOUT_MS", sl.timeoutMs, sld.timeoutMs),
    // ── LLM keepalive / fallback ──
    e("AIM_CONVERSE_KEEPALIVE_MS", RC.misc.converseKeepaliveMs, CONVERSE_KEEPALIVE_DEFAULT_MS),
    e("AIM_MANTLE_KEEPALIVE_MS", RC.misc.mantleKeepaliveMs, MANTLE_KEEPALIVE_DEFAULT_MS),
    e("AIM_LLM_FALLBACK_ATTEMPT_MS", RC.misc.llmFallbackAttemptMs, LLM_FALLBACK_ATTEMPT_DEFAULT_MS),
  ];
}
