/**
 * design contract —— **characterization 测试**(重构前置硬门)。
 *
 * 目的:在 Task 1 的配置归拢重构**之前**,把每个 `AIM_*` 的**现状**解析行为逐格钉死。
 * 「纯行为等价」唯一可验证的定义 = 重构后本文件逐格仍绿(不改断言值)。
 *
 * 为什么必须先写(评审 + review 一致):
 *  - 首轮移植把四种不同的空值语义**统一**成「空白→默认」,属静默改线上行为
 *    (实测:`AIM_TTS_TIMEOUT_MS=""` 现状得 0,而 0 会**禁用 TTS 看门狗**)。
 *  - 无 characterization 基线时,这类改动测试全绿也看不出来 —— 因为断言校验的是新写的期望值。
 *
 * 覆盖矩阵(每 key):`undefined` / `""` / `"  "` / 合法值 / 非法值 / 越界值 / `"0"` / `"1"`。
 * 断言用**表驱动 + 快照式期望**:期望值来自跑当前代码实测,而非人工推断(人工推断正是 46% 出错的来源)。
 *
 * ⚠ 本文件**直接调各源模块的真实解析函数**,不经 registry —— registry 是被验证方。
 */
import { loadTurnHandling, TURN_HANDLING_DEFAULTS } from "../src/turn-handling";
import { loadSpeakerLockConfig } from "../src/speaker-lock";
import { eouVerdictTimeoutMs } from "../src/eou-verdict";
import { fixerTimeoutMs } from "../src/transcript-fixer";
import { moderationTimeoutMs } from "../src/moderation-verdict";
import { loadAckTimeoutConfig } from "../src/playback-settlement";
// ★ 评审两方一致指出的覆盖缺口(review):原先本文件只测既有模块的解析器,
//   **从未直接测**新抽的三个配置叶子 —— 而那 25 个解析器正是我从 media-session(18)/
//   three-stage-engine(7)**手工搬运**的,最需要行为等价证明的恰恰是它们。
import * as mediaConfig from "../src/media-config";
import * as engineConfig from "../src/engine-config";
import * as bypassConfig from "../src/bypass-llm-config";

/** 各 env 的取值样本(覆盖矩阵)。 */
const SAMPLES = ["<unset>", "", "  ", "0", "1"] as const;

/** 设/清 env 并跑 fn,用后恢复 —— 防用例间串扰。 */
function withEnv<T>(key: string, raw: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (raw === undefined) delete process.env[key];
  else process.env[key] = raw;
  try {
    return fn();
  } finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

const val = (s: string) => (s === "<unset>" ? undefined : s);

/**
 * 表驱动:每项 = 一个 key + 取其生效值的 getter(调真实解析函数)。
 * `getter` 必须在 withEnv 内**重新解析**,故 loader 类须整体重调。
 */
interface Probe {
  key: string;
  get: () => number | boolean | string;
}

const PROBES: Probe[] = [
  // ── turn-handling(数值,num() 口径:undefined/"" → 默认;"  " → 0)──
  { key: "AIM_BARGE_CONFIRM_MS", get: () => loadTurnHandling().interruption.confirmMs },
  { key: "AIM_ENDPOINT_SILENCE_GAP_MS", get: () => loadTurnHandling().endpointing.silenceGapMs },
  { key: "AIM_MIN_INPUT_CHARS", get: () => loadTurnHandling().meaningfulInput.minChars },
  { key: "AIM_QUESTION_MAX_RETRY", get: () => loadTurnHandling().questionProgression.maxRetryPerQuestion },
  // ── turn-handling(布尔:!== "0" 默认开)──
  { key: "AIM_BARGE_DTD", get: () => loadTurnHandling().interruption.dtdEnabled },
  { key: "AIM_PROACTIVE_OPENING", get: () => loadTurnHandling().proactiveOpening.enabled },
  // ── turn-handling(布尔:=== "1" 默认关)──
  { key: "AIM_FALSE_INTERRUPTION_RECOVERY", get: () => loadTurnHandling().interruption.recoveryEnabled },
  { key: "AIM_EOU_CORRECTION_ENABLED", get: () => loadTurnHandling().eouCorrection.enabled },
  // ── turn-handling(numBounded:带上下界)──
  { key: "AIM_ANSWER_GRACE_MS", get: () => loadTurnHandling().answerGrace.defaultMs },
  { key: "AIM_MAX_PLAYBACK_LEAD_MS", get: () => loadTurnHandling().playbackClock.maxLeadMs },
  // ── speaker-lock(numEnv 口径,与 turn-handling num 同)──
  { key: "AIM_SPEAKER_LOCK_TIMEOUT_MS", get: () => loadSpeakerLockConfig().timeoutMs },
  { key: "AIM_SPEAKER_LOCK_THRESHOLD_HIGH", get: () => loadSpeakerLockConfig().thresholdHigh },
  { key: "AIM_SPEAKER_LOCK_ENROLL_MS", get: () => loadSpeakerLockConfig().enrollMs },
  { key: "AIM_SPEAKER_LOCK_ENABLED", get: () => loadSpeakerLockConfig().enabled },
  // ── 独立 guard 式 helper(各有自己的钳制区间)──
  { key: "AIM_EOU_VERDICT_TIMEOUT_MS", get: () => eouVerdictTimeoutMs() },
  { key: "AIM_TRANSCRIPT_FIXER_TIMEOUT_MS", get: () => fixerTimeoutMs() },
  { key: "AIM_MODERATION_TIMEOUT_MS", get: () => moderationTimeoutMs() },
  // ── playback-settlement(严格 fail-fast:越界抛)──
  { key: "AIM_PLAYBACK_ACK_GRACE_MS", get: () => loadAckTimeoutConfig().graceMs },
  { key: "AIM_PLAYBACK_ACK_INPUT_GRACE_MS", get: () => loadAckTimeoutConfig().inputGraceMs },
  // ★ design contract:AIM_PLAYBACK_ACK_MODE(原「委托解析」样例)已删 —— 开关不存在,无 env 口径可 characterize。
];

/**
 * 现状快照:`key → { 样本 → 结果 }`。
 * 结果为 `"THROW:<msg 前缀>"` 表示该输入下现状**抛错**(fail-fast)。
 *
 * ⚠ 这些值是**跑当前代码实测得来**的,不是人工推断。重构后 MUST 逐格不变;
 *   若某格确需改变,MUST 另立行为变更 spec 并在此显式改写 + 说明理由。
 */
const EXPECTED: Record<string, Partial<Record<(typeof SAMPLES)[number], unknown>>> = {
  // num():undefined/"" → 默认;"  " → Number("  ")=0;"0"→0;"1"→1
  AIM_BARGE_CONFIRM_MS: { "<unset>": TURN_HANDLING_DEFAULTS.interruption.confirmMs, "": TURN_HANDLING_DEFAULTS.interruption.confirmMs, "  ": 0, "0": 0, "1": 1 },
  AIM_ENDPOINT_SILENCE_GAP_MS: { "<unset>": TURN_HANDLING_DEFAULTS.endpointing.silenceGapMs, "": TURN_HANDLING_DEFAULTS.endpointing.silenceGapMs, "  ": 0, "0": 0, "1": 1 },
  AIM_MIN_INPUT_CHARS: { "<unset>": TURN_HANDLING_DEFAULTS.meaningfulInput.minChars, "": TURN_HANDLING_DEFAULTS.meaningfulInput.minChars, "  ": 0, "0": 0, "1": 1 },
  // maxRetry 有 max(1,…) 钳制 → "0"/"  " 被抬回 1
  AIM_QUESTION_MAX_RETRY: { "<unset>": TURN_HANDLING_DEFAULTS.questionProgression.maxRetryPerQuestion, "": TURN_HANDLING_DEFAULTS.questionProgression.maxRetryPerQuestion, "  ": 1, "0": 1, "1": 1 },
  // 布尔 !== "0":唯 "0" 关,空串/空白/"1" 皆开
  AIM_BARGE_DTD: { "<unset>": true, "": true, "  ": true, "0": false, "1": true },
  AIM_PROACTIVE_OPENING: { "<unset>": true, "": true, "  ": true, "0": false, "1": true },
  // 布尔 === "1":唯 "1" 开
  // ★ design contract B 类:两项默认由关改开,解析口径随之从 `=== "1"` 翻转为 `!== "0"` ——
  //   故「未设/空串/空白」全部变 true,唯 "0" 关。这不是口径漂移,是**默认值与口径必须一致**
  //   (只改 DEFAULTS 而留 onByOne 会让默认值永不生效 —— 本 spec 要防的同族陷阱)。
  AIM_FALSE_INTERRUPTION_RECOVERY: { "<unset>": true, "": true, "  ": true, "0": false, "1": true },
  AIM_EOU_CORRECTION_ENABLED: { "<unset>": true, "": true, "  ": true, "0": false, "1": true },
  // numBounded [0,10000] / [0,120000]:合法区间内原值,"  "→0 亦在区间内
  AIM_ANSWER_GRACE_MS: { "<unset>": TURN_HANDLING_DEFAULTS.answerGrace.defaultMs, "": TURN_HANDLING_DEFAULTS.answerGrace.defaultMs, "  ": 0, "0": 0, "1": 1 },
  AIM_MAX_PLAYBACK_LEAD_MS: { "<unset>": TURN_HANDLING_DEFAULTS.playbackClock.maxLeadMs, "": TURN_HANDLING_DEFAULTS.playbackClock.maxLeadMs, "  ": 0, "0": 0, "1": 1 },
  // speaker-lock numEnv 同 num 口径;默认值 = 源码字面量(200/0.35/4000)
  AIM_SPEAKER_LOCK_TIMEOUT_MS: { "<unset>": 200, "": 200, "  ": 0, "0": 0, "1": 1 },
  AIM_SPEAKER_LOCK_THRESHOLD_HIGH: { "<unset>": 0.35, "": 0.35, "  ": 0, "0": 0, "1": 1 },
  AIM_SPEAKER_LOCK_ENROLL_MS: { "<unset>": 4000, "": 4000, "  ": 0, "0": 0, "1": 1 },
  AIM_SPEAKER_LOCK_ENABLED: { "<unset>": true, "": true, "  ": true, "0": false, "1": true },
  // guard 式:非法/非正 → 默认;合法则钳到区间。"0"/"  "(→0)非正 → 默认
  // ★ design contract B 类:默认 2000 → 6000(跨境标定值回落为默认)。钳制区间 [500,8000] 不变。
  AIM_EOU_VERDICT_TIMEOUT_MS: { "<unset>": 6000, "": 6000, "  ": 6000, "0": 6000, "1": 500 },
  AIM_TRANSCRIPT_FIXER_TIMEOUT_MS: { "<unset>": 8000, "": 8000, "  ": 8000, "0": 8000, "1": 1000 },
  AIM_MODERATION_TIMEOUT_MS: { "<unset>": 8000, "": 8000, "  ": 8000, "0": 8000, "1": 1000 },
  // playback 严格式:undefined/"" → 默认;"  " → Number 得 0(在 [0,15000] 内)→ 0
  AIM_PLAYBACK_ACK_GRACE_MS: { "<unset>": 3000, "": 3000, "  ": 0, "0": 0, "1": 1 },
  // inputGrace 下界 100 → "0"/"1"/"  " 均越界 → 抛
  AIM_PLAYBACK_ACK_INPUT_GRACE_MS: { "<unset>": 1000, "": 1000, "  ": "THROW", "0": "THROW", "1": "THROW" },
  // 委托:默认 "off";"0"/"1" 非法枚举 → 抛;""/"  " trim 后空 → ?? 不触发(空串非 nullish)→ 抛
};

describe("design contract —— 配置解析现状 characterization(重构前基线)", () => {
  for (const probe of PROBES) {
    describe(probe.key, () => {
      for (const sample of SAMPLES) {
        const expected = EXPECTED[probe.key]?.[sample];
        const label = sample === "<unset>" ? "未设" : JSON.stringify(sample);

        it(`${label} → ${expected === "THROW" ? "抛错(fail-fast)" : JSON.stringify(expected)}`, () => {
          // 期望表必须覆盖每格 —— 漏格即失败(防新增 key 时静默漏测)
          expect(EXPECTED[probe.key]).toHaveProperty(sample);

          if (expected === "THROW") {
            expect(() => withEnv(probe.key, val(sample), probe.get)).toThrow();
            return;
          }
          const actual = withEnv(probe.key, val(sample), probe.get);
          expect(actual).toBe(expected);
        });
      }
    });
  }

  it("期望表不含 PROBES 之外的 key(防表与探针漂移)", () => {
    const probed = new Set(PROBES.map((p) => p.key));
    expect(Object.keys(EXPECTED).filter((k) => !probed.has(k))).toEqual([]);
  });

  it("每个探针都有期望表(防加探针忘写期望)", () => {
    expect(PROBES.filter((p) => !EXPECTED[p.key]).map((p) => p.key)).toEqual([]);
  });
});

describe("design contract —— 空值语义逐 key 不同(证「统一」即改线上行为)", () => {
  /**
   * 这组断言是**反统一**的护栏:四种形态对 `""` / `"  "` 的处理互不相同,
   * 首轮移植把它们统一成「空白→默认」= 静默行为变更。此处把差异钉死。
   */
  it('内联 `?? D` 形态:空串得 0,未设得默认(0 会禁用 TTS 看门狗,故不可统一)', () => {
    // three-stage-engine.ts:40 是 `Number(process.env.AIM_TTS_TIMEOUT_MS ?? 12000)`。
    // 空串**非** nullish → `??` 不触发 → Number("") = 0;未设才走默认。
    // 用真实 env 走同一表达式(不用字面量,TS 会判 ?? 不可达)。
    const readInline = (): number => Number(process.env.AIM_TTS_TIMEOUT_MS ?? 12000);
    expect(withEnv("AIM_TTS_TIMEOUT_MS", "", readInline)).toBe(0);
    expect(withEnv("AIM_TTS_TIMEOUT_MS", undefined, readInline)).toBe(12000);
    expect(withEnv("AIM_TTS_TIMEOUT_MS", "  ", readInline)).toBe(0);
  });

  it("num() 口径与 guard 口径对空白的处理相反", () => {
    // num():"  " → Number("  ")=0 且 isFinite → 取 0
    const numLike = withEnv("AIM_BARGE_CONFIRM_MS", "  ", () => loadTurnHandling().interruption.confirmMs);
    expect(numLike).toBe(0);
    // guard(>0 判据):"  " → 0 不满足 >0 → 回退默认
    //   ★ 断言引用权威默认(design contract 已把它由 2000 改为 6000);本测试的要点是**两种口径对空白的处理相反**,
    //     而非具体数值 —— 用字面量会让它在改默认时假红。
    const guardLike = withEnv("AIM_EOU_VERDICT_TIMEOUT_MS", "  ", () => eouVerdictTimeoutMs());
    expect(guardLike).toBe(bypassConfig.BYPASS_LLM_TIMEOUT_DEFAULTS.eouVerdictMs);
  });

  it("playback 严格式对越界抛错,而 turn-handling numBounded 钳制不抛", () => {
    expect(() => withEnv("AIM_PLAYBACK_ACK_INPUT_GRACE_MS", "99999", () => loadAckTimeoutConfig())).toThrow();
    // numBounded 越界 → 回退默认(不抛)
    const clamped = withEnv("AIM_ANSWER_GRACE_MS", "99999", () => loadTurnHandling().answerGrace.defaultMs);
    expect(clamped).toBe(TURN_HANDLING_DEFAULTS.answerGrace.defaultMs);
  });
});


describe("design contract —— 配置叶子模块解析器直测(搬运行为等价的直接证明)", () => {
  /**
   * 表驱动:逐个叶子解析器 × 取值样本,断言口径**与搬运前逐字一致**。
   *
   * 口径差异是刻意保留的(勿统一):
   *  - `?? D` 内联族:空串**非** nullish → `Number("")` = 0(**非**默认)
   *  - `|| D` 族:空串是 falsy → 回退默认
   *  - guard 族(`>0` / `>=1`):0 或空白→0 不满足判据 → 回退默认
   *  - `Math.floor` / `Math.max(1,…)`:钳制后取整
   */
  const CASES: {
    name: string;
    get: () => number | boolean | string;
    key: string;
    expect: Partial<Record<(typeof SAMPLES)[number], unknown>>;
  }[] = [
    // ── media-config:内联 `?? D` 族(空串得 0)──
    { name: "rmsDiagEvery", key: "AIM_RMS_DIAG_EVERY", get: () => mediaConfig.rmsDiagEvery(),
      expect: { "<unset>": 25, "": 0, "  ": 0, "0": 0, "1": 1 } },
    { name: "farewellHangupDelayMs", key: "AIM_FAREWELL_HANGUP_DELAY_MS",
      get: () => mediaConfig.farewellHangupDelayMs(),
      expect: { "<unset>": 1500, "": 0, "  ": 0, "0": 0, "1": 1 } },
    { name: "farewellTailMs", key: "AIM_FAREWELL_TAIL_MS", get: () => mediaConfig.farewellTailMs(),
      expect: { "<unset>": 1000, "": 0, "  ": 0, "0": 0, "1": 1 } },
    { name: "farewellDrainMaxMs", key: "AIM_FAREWELL_DRAIN_MAX_MS",
      get: () => mediaConfig.farewellDrainMaxMs(),
      expect: { "<unset>": 20000, "": 0, "  ": 0, "0": 0, "1": 1 } },
    { name: "bargeDtdWindowMs", key: "AIM_BARGE_DTD_WINDOW_MS",
      get: () => mediaConfig.bargeDtdWindowMs(),
      expect: { "<unset>": 400, "": 0, "  ": 0, "0": 0, "1": 1 } },
    // ── media-config:布尔「唯 0 关」族 ──
    { name: "farewellHangup", key: "AIM_FAREWELL_HANGUP", get: () => mediaConfig.farewellHangup(),
      expect: { "<unset>": true, "": true, "  ": true, "0": false, "1": true } },
    { name: "semanticEnd", key: "AIM_SEMANTIC_END", get: () => mediaConfig.semanticEnd(),
      expect: { "<unset>": true, "": true, "  ": true, "0": false, "1": true } },
    { name: "r3SilenceAdvance", key: "AIM_R3_SILENCE_ADVANCE",
      get: () => mediaConfig.r3SilenceAdvance(),
      expect: { "<unset>": true, "": true, "  ": true, "0": false, "1": true } },
    // ── media-config:布尔「唯 1 开」族 ──
    { name: "rmsDiag", key: "AIM_RMS_DIAG", get: () => mediaConfig.rmsDiag(),
      expect: { "<unset>": false, "": false, "  ": false, "0": false, "1": true } },
    // ★ design contract B 类:默认由关改开 → 口径从 boolOnByOne 翻转为 boolOffByZero(唯 "0" 关)。
    { name: "violationEnforcement", key: "AIM_VIOLATION_ENFORCEMENT",
      get: () => mediaConfig.violationEnforcement(),
      expect: { "<unset>": true, "": true, "  ": true, "0": false, "1": true } },
    // ★ design contract A 类:`farewellTtsDrainEnabled` **整条配置链已删**(字段 + 解析器 + registry 项),
    //   故此处无解析器可 characterize —— 条目一并移除。「开关不存在」由
    //   `media-config` 无该导出(tsc 会红)+ CDK 测试断言不透传共同守门,比留一条恒 true 的快照更强。
    // ── media-config:guard 族(>0 / >=1 / Math.floor)──
    // ★ design contract B 类:默认 10000 → 20000(design contract 真机验通;10s 对口试思考偏短易冤判)。
    { name: "silenceViolationMs", key: "AIM_SILENCE_VIOLATION_MS",
      get: () => mediaConfig.silenceViolationMs(),
      expect: { "<unset>": 20000, "": 20000, "  ": 20000, "0": 20000, "1": 1 } },
    { name: "silenceWarnMax(>=1 + floor)", key: "AIM_SILENCE_WARN_MAX",
      get: () => mediaConfig.silenceWarnMax(),
      expect: { "<unset>": 3, "": 3, "  ": 3, "0": 3, "1": 1 } },
    { name: "noFrameMs", key: "AIM_NO_FRAME_MS", get: () => mediaConfig.noFrameMs(),
      expect: { "<unset>": 30000, "": 30000, "  ": 30000, "0": 30000, "1": 1 } },
    { name: "severeViolationMax(>=1)", key: "AIM_SEVERE_VIOLATION_MAX",
      get: () => mediaConfig.severeViolationMax(),
      expect: { "<unset>": 2, "": 2, "  ": 2, "0": 2, "1": 1 } },
    { name: "idleChatterMinTurns(>=1)", key: "AIM_IDLE_CHATTER_MIN_TURNS",
      get: () => mediaConfig.idleChatterMinTurns(),
      expect: { "<unset>": 2, "": 2, "  ": 2, "0": 2, "1": 1 } },
    { name: "forcedEndMaxWaitMs", key: "AIM_FORCED_END_MAX_WAIT_MS",
      get: () => mediaConfig.forcedEndMaxWaitMs(),
      expect: { "<unset>": 10000, "": 10000, "  ": 10000, "0": 10000, "1": 1 } },
    { name: "moderationConfidenceThreshold((0,1])", key: "AIM_MODERATION_CONFIDENCE_THRESHOLD",
      get: () => mediaConfig.moderationConfidenceThreshold(),
      expect: { "<unset>": 0.8, "": 0.8, "  ": 0.8, "0": 0.8, "1": 1 } },
    // ── engine-config:内联 `?? D` 族 ──
    { name: "ttsTimeoutMs(0 会禁看门狗!)", key: "AIM_TTS_TIMEOUT_MS",
      get: () => engineConfig.ttsTimeoutMs(),
      expect: { "<unset>": 12000, "": 0, "  ": 0, "0": 0, "1": 1 } },
    { name: "llmTtftTimeoutMs", key: "AIM_LLM_TTFT_TIMEOUT_MS",
      get: () => engineConfig.llmTtftTimeoutMs(),
      expect: { "<unset>": 25000, "": 0, "  ": 0, "0": 0, "1": 1 } },
    { name: "cancelAckTimeoutMs", key: "AIM_CANCEL_ACK_TIMEOUT_MS",
      get: () => engineConfig.cancelAckTimeoutMs(),
      expect: { "<unset>": 300, "": 0, "  ": 0, "0": 0, "1": 1 } },
    // ── engine-config:`|| D` 族(空串**回退默认**,与 `??` 相反)──
    { name: "kickoffWakeText(|| 口径)", key: "AIM_KICKOFF_WAKE_TEXT",
      get: () => engineConfig.kickoffWakeText(),
      expect: { "<unset>": "(请开始)", "": "(请开始)", "  ": "  ", "0": "0", "1": "1" } },
    // ── engine-config:Math.max(1,…) 族 ──
    { name: "cursorVoicedMaxStall(max 1)", key: "AIM_CURSOR_VOICED_MAX_STALL",
      get: () => engineConfig.cursorVoicedMaxStall(),
      expect: { "<unset>": 2, "": 1, "  ": 1, "0": 1, "1": 1 } },
    { name: "staleAnswerMax(max 1)", key: "AIM_STALE_ANSWER_MAX",
      get: () => engineConfig.staleAnswerMax(),
      expect: { "<unset>": 2, "": 1, "  ": 1, "0": 1, "1": 1 } },
    { name: "cursorVoicedGate(唯 1 开)", key: "AIM_CURSOR_VOICED_GATE",
      get: () => engineConfig.cursorVoicedGate(),
      expect: { "<unset>": false, "": false, "  ": false, "0": false, "1": true } },
    // ── bypass-llm-config:三条旁路超时(guard + 钳制)──
    // ★ design contract B 类:默认 2000 → 6000(跨境标定值回落为默认);钳制 [500,8000] 不变。
    { name: "eouVerdictTimeoutMs[500,8000]", key: "AIM_EOU_VERDICT_TIMEOUT_MS",
      get: () => bypassConfig.eouVerdictTimeoutMs(),
      expect: { "<unset>": 6000, "": 6000, "  ": 6000, "0": 6000, "1": 500 } },
    { name: "fixerTimeoutMs[1000,15000]", key: "AIM_TRANSCRIPT_FIXER_TIMEOUT_MS",
      get: () => bypassConfig.fixerTimeoutMs(),
      expect: { "<unset>": 8000, "": 8000, "  ": 8000, "0": 8000, "1": 1000 } },
    { name: "moderationTimeoutMs[1000,20000]", key: "AIM_MODERATION_TIMEOUT_MS",
      get: () => bypassConfig.moderationTimeoutMs(),
      expect: { "<unset>": 8000, "": 8000, "  ": 8000, "0": 8000, "1": 1000 } },
  ];

  for (const c of CASES) {
    describe(`${c.name}(${c.key})`, () => {
      for (const sample of SAMPLES) {
        const want = c.expect[sample];
        it(`${sample === "<unset>" ? "未设" : JSON.stringify(sample)} → ${JSON.stringify(want)}`, () => {
          expect(c.expect).toHaveProperty(sample); // 漏格即失败
          expect(withEnv(c.key, val(sample), c.get)).toBe(want);
        });
      }
    });
  }

  it("派生默认:advanceNudge/After = silenceViolationMs × 40%(非字面量)", () => {
    // 未设 env → 派生;显式设 → 用显式值(逐字沿用 design contract 语义)
    expect(mediaConfig.advanceNudgeMs(10000)).toBe(4000);
    expect(mediaConfig.advanceAfterNudgeMs(10000)).toBe(4000);
    expect(mediaConfig.advanceNudgeMs(20000)).toBe(8000); // 随源配置变,证明是派生非固定
    expect(withEnv("AIM_ADVANCE_NUDGE_MS", "1234", () => mediaConfig.advanceNudgeMs(10000)))
      .toBe(1234);
  });

  it("r3EnvOverridden:仅显式设了两项之一才为 true", () => {
    expect(withEnv("AIM_ADVANCE_NUDGE_MS", undefined, () => mediaConfig.r3EnvOverridden())).toBe(false);
    expect(withEnv("AIM_ADVANCE_NUDGE_MS", "5000", () => mediaConfig.r3EnvOverridden())).toBe(true);
    expect(withEnv("AIM_ADVANCE_AFTER_NUDGE_MS", "5000", () => mediaConfig.r3EnvOverridden())).toBe(true);
  });
});


describe("design contract —— 判据区分样本(补覆盖缺口:5 样本矩阵分不清 `>=1` 与 `>0`)", () => {
  /**
   * ⚠ **我自己的测试设计缺口**(变异验证暴露):上面的 `SAMPLES = ["<unset>","","  ","0","1"]`
   * 里**没有**能区分 `>= 1` 与 `> 0` 的值 —— 把 `raw >= 1` 错抄成 `raw > 0` 时 247 条全绿。
   * 分数值(如 `0.5`)才能区分:`>=1` 判否 → 回退默认;`>0` 判是 → `Math.floor(0.5)` = **0**
   * (而 0 次警告 = 第一次沉默就挂断,严重行为变化)。
   *
   * 同理补负数样本(验 `>0` 判据)与超大值(验无上界项不被误钳)。
   */
  const FRACTIONAL_GE1 = [
    { name: "silenceWarnMax", key: "AIM_SILENCE_WARN_MAX", get: () => mediaConfig.silenceWarnMax(),
      dflt: 3 },
    { name: "severeViolationMax", key: "AIM_SEVERE_VIOLATION_MAX",
      get: () => mediaConfig.severeViolationMax(), dflt: 2 },
    { name: "idleChatterMinTurns", key: "AIM_IDLE_CHATTER_MIN_TURNS",
      get: () => mediaConfig.idleChatterMinTurns(), dflt: 2 },
  ];

  for (const c of FRACTIONAL_GE1) {
    it(`${c.name}:0.5 MUST 回退默认 ${c.dflt}(判据是 >=1,不是 >0)`, () => {
      // 若判据被错写成 `>0`,这里会得 Math.floor(0.5)=0 —— 0 次警告 = 第一次就挂断
      expect(withEnv(c.key, "0.5", c.get)).toBe(c.dflt);
    });
    it(`${c.name}:负数 MUST 回退默认`, () => {
      expect(withEnv(c.key, "-1", c.get)).toBe(c.dflt);
    });
    it(`${c.name}:1.9 MUST floor 到 1(取整口径)`, () => {
      expect(withEnv(c.key, "1.9", c.get)).toBe(1);
    });
  }

  const POSITIVE_ONLY = [
    { name: "silenceViolationMs", key: "AIM_SILENCE_VIOLATION_MS",
      get: () => mediaConfig.silenceViolationMs(), dflt: 20000 }, // design contract B 类
    { name: "noFrameMs", key: "AIM_NO_FRAME_MS", get: () => mediaConfig.noFrameMs(), dflt: 30000 },
    { name: "forcedEndMaxWaitMs", key: "AIM_FORCED_END_MAX_WAIT_MS",
      get: () => mediaConfig.forcedEndMaxWaitMs(), dflt: 10000 },
  ];

  for (const c of POSITIVE_ONLY) {
    it(`${c.name}:0.5 MUST 被接受(判据是 >0,**不**取整)`, () => {
      // 与上一组相反:这些项无 floor、判据是 >0,故 0.5 原样通过 —— 钉死两组的差别
      expect(withEnv(c.key, "0.5", c.get)).toBe(0.5);
    });
    it(`${c.name}:负数 MUST 回退默认`, () => {
      expect(withEnv(c.key, "-1", c.get)).toBe(c.dflt);
    });
  }

  it("moderationConfidenceThreshold:上界 1 —— >1 MUST 回退默认(夹 (0,1])", () => {
    expect(withEnv("AIM_MODERATION_CONFIDENCE_THRESHOLD", "1.5",
      () => mediaConfig.moderationConfidenceThreshold())).toBe(0.8);
    expect(withEnv("AIM_MODERATION_CONFIDENCE_THRESHOLD", "0.5",
      () => mediaConfig.moderationConfidenceThreshold())).toBe(0.5);
    expect(withEnv("AIM_MODERATION_CONFIDENCE_THRESHOLD", "-0.1",
      () => mediaConfig.moderationConfidenceThreshold())).toBe(0.8);
  });

  it("engine cursorVoicedMaxStall / staleAnswerMax:Math.max(1,…) 下限", () => {
    expect(withEnv("AIM_CURSOR_VOICED_MAX_STALL", "0", () => engineConfig.cursorVoicedMaxStall())).toBe(1);
    expect(withEnv("AIM_CURSOR_VOICED_MAX_STALL", "-5", () => engineConfig.cursorVoicedMaxStall())).toBe(1);
    expect(withEnv("AIM_STALE_ANSWER_MAX", "0", () => engineConfig.staleAnswerMax())).toBe(1);
  });

  it("bypass 三族:越界值 MUST 被钳到区间端点(不是回退默认)", () => {
    // 钳制语义 ≠ 回退语义:合法但越界 → 夹到端点;非法/非正 → 回退默认
    expect(withEnv("AIM_EOU_VERDICT_TIMEOUT_MS", "99999", () => bypassConfig.eouVerdictTimeoutMs())).toBe(8000);
    expect(withEnv("AIM_EOU_VERDICT_TIMEOUT_MS", "100", () => bypassConfig.eouVerdictTimeoutMs())).toBe(500);
    expect(withEnv("AIM_TRANSCRIPT_FIXER_TIMEOUT_MS", "99999", () => bypassConfig.fixerTimeoutMs())).toBe(15000);
    expect(withEnv("AIM_MODERATION_TIMEOUT_MS", "99999", () => bypassConfig.moderationTimeoutMs())).toBe(20000);
    // 跨境标定值须原样通过(北京运维最可能设的值)
    expect(withEnv("AIM_EOU_VERDICT_TIMEOUT_MS", "6000", () => bypassConfig.eouVerdictTimeoutMs())).toBe(6000);
  });
});

describe("design contract —— 扩展样本全解析器快照(review 样本矩阵分不清多种走样)", () => {
  /**
   * ★ 为什么需要这一段:主矩阵 `SAMPLES` 只有 `["<unset>","","  ","0","1"]`,review 给出 5 个
   * **能全绿通过**的走样反例。实测其中一个:给 `cursorVoicedMaxStall` 加 `Math.floor`
   * (1.9→1),**381 条全绿** —— 确认是假绿。
   *
   * 这里把「全部新抽叶子解析器 × 分数/负数/越界/非有限/布尔口径」的**当前行为**逐格钉死。
   * 期望值由机器跑一遍产出、人工逐格审过(而非手写猜测,手写又会引入本 spec 要消灭的第二份副本)。
   *
   * ⚠ 审快照时发现两处**既有缺陷**(搬运前就存在,已核对 `git show HEAD` 逐字节相同):
   *  ① `Math.max(1, Number("abc"))` = `Math.max(1, NaN)` = **NaN** —— 非法值既不回退默认也不抛错,
   *     得到 NaN(经 JSON 序列化成 `null`)。影响 `cursorVoicedMaxStall`/`staleAnswerMax`/
   *     `ttsTimeoutMs`/`rmsDiagEvery`。
   *  ② `rmsDiagEvery`/`ttsTimeoutMs` **接受负数**(`-1` 原样通过,无非负钳制)。
   *
   * 这两条**本 spec 不改** —— 本 spec 的契约是「搬运行为逐字节等价」,顺手"修正"就是静默改线上行为
   * (`AIM_TTS_TIMEOUT_MS` 为 0 会**禁用 TTS 看门狗**,这类语义碰不得)。钉死现状,
   * 留待独立立项。**测试在此如实记录缺陷,不掩盖、也不假装修好了。**
   */
  const EXT_SAMPLES = ["0.5", "1.9", "-1", "999999999", "Infinity", "NaN", "abc", "true", "TRUE"] as const;

  // NaN 无法用 toBe 比较 → 用哨兵标记「期望是 NaN」
  //
  // ⚠ 踩过的坑:我最初用 `JSON.stringify` 打印机器快照来人工审,而它把 **`Infinity` 和 `NaN`
  //   都印成 `null`** → 我把两者混为一谈,把 `Infinity` 那格也写成 NaN(4 条红才发现)。
  //   真实区别:`Number("Infinity")` = `Infinity`(有限、可比较),只有 `"NaN"`/`"abc"`/`"true"`
  //   这类不可解析串才得 NaN。**审快照别用 JSON.stringify 看数值边界。**
  const NAN = Symbol("NaN");

  const TABLE: {
    name: string;
    key: string;
    get: () => unknown;
    want: Record<(typeof EXT_SAMPLES)[number], unknown>;
  }[] = [
    { name: "cursorVoicedMaxStall", key: "AIM_CURSOR_VOICED_MAX_STALL",
      get: () => engineConfig.cursorVoicedMaxStall(),
      // 无 Math.floor(1.9 原样)· Math.max(1,…) 抬起 0.5/-1 · 非有限 → NaN(既有缺陷①)
      want: { "0.5": 1, "1.9": 1.9, "-1": 1, "999999999": 999999999,
              Infinity: Infinity, NaN: NAN, abc: NAN, true: NAN, TRUE: NAN } },
    { name: "staleAnswerMax", key: "AIM_STALE_ANSWER_MAX",
      get: () => engineConfig.staleAnswerMax(),
      want: { "0.5": 1, "1.9": 1.9, "-1": 1, "999999999": 999999999,
              Infinity: Infinity, NaN: NAN, abc: NAN, true: NAN, TRUE: NAN } },
    { name: "silenceWarnMax", key: "AIM_SILENCE_WARN_MAX",
      get: () => mediaConfig.silenceWarnMax(),
      // guard `>=1`:0.5 不满足 → 默认 3;1.9 满足 → Math.floor = 1(**非** 1.9)
      want: { "0.5": 3, "1.9": 1, "-1": 3, "999999999": 999999999,
              Infinity: 3, NaN: 3, abc: 3, true: 3, TRUE: 3 } },
    { name: "advanceNudgeMs", key: "AIM_ADVANCE_NUDGE_MS",
      get: () => mediaConfig.advanceNudgeMs(10000),
      // guard `>0`:0.5 满足(**与 silenceWarnMax 的 `>=1` 不同,勿统一**)· 派生默认 4000
      want: { "0.5": 0.5, "1.9": 1.9, "-1": 4000, "999999999": 999999999,
              Infinity: 4000, NaN: 4000, abc: 4000, true: 4000, TRUE: 4000 } },
    { name: "moderationConfidenceThreshold", key: "AIM_MODERATION_CONFIDENCE_THRESHOLD",
      get: () => mediaConfig.moderationConfidenceThreshold(),
      // 区间 (0,1]:1.9/999999999/-1 越界 → 回退 0.8(**回退**语义,非钳制)
      want: { "0.5": 0.5, "1.9": 0.8, "-1": 0.8, "999999999": 0.8,
              Infinity: 0.8, NaN: 0.8, abc: 0.8, true: 0.8, TRUE: 0.8 } },
    { name: "eouVerdictTimeoutMs", key: "AIM_EOU_VERDICT_TIMEOUT_MS",
      get: () => bypassConfig.eouVerdictTimeoutMs(),
      // 钳制族:合法但越界 → 夹到端点 [500,8000];非法 → 回退默认 **6000**(design contract B 类,原 2000)
      want: { "0.5": 500, "1.9": 500, "-1": 6000, "999999999": 8000,
              Infinity: 6000, NaN: 6000, abc: 6000, true: 6000, TRUE: 6000 } },
    { name: "fixerTimeoutMs", key: "AIM_TRANSCRIPT_FIXER_TIMEOUT_MS",
      get: () => bypassConfig.fixerTimeoutMs(),
      want: { "0.5": 1000, "1.9": 1000, "-1": 8000, "999999999": 15000,
              Infinity: 8000, NaN: 8000, abc: 8000, true: 8000, TRUE: 8000 } },
    { name: "moderationTimeoutMs", key: "AIM_MODERATION_TIMEOUT_MS",
      get: () => bypassConfig.moderationTimeoutMs(),
      want: { "0.5": 1000, "1.9": 1000, "-1": 8000, "999999999": 20000,
              Infinity: 8000, NaN: 8000, abc: 8000, true: 8000, TRUE: 8000 } },
    { name: "rmsDiagEvery", key: "AIM_RMS_DIAG_EVERY",
      get: () => mediaConfig.rmsDiagEvery(),
      // 裸 `?? D` + Number():**接受负数**(既有缺陷②)· 非有限 → NaN(既有缺陷①)
      want: { "0.5": 0.5, "1.9": 1.9, "-1": -1, "999999999": 999999999,
              Infinity: Infinity, NaN: NAN, abc: NAN, true: NAN, TRUE: NAN } },
    { name: "ttsTimeoutMs", key: "AIM_TTS_TIMEOUT_MS",
      get: () => engineConfig.ttsTimeoutMs(),
      // ⚠ 此 key 为 0 会**禁用 TTS 看门狗** → 语义碰不得,现状必须原样钉死
      want: { "0.5": 0.5, "1.9": 1.9, "-1": -1, "999999999": 999999999,
              Infinity: Infinity, NaN: NAN, abc: NAN, true: NAN, TRUE: NAN } },
    { name: "kickoffWakeText", key: "AIM_KICKOFF_WAKE_TEXT",
      get: () => engineConfig.kickoffWakeText(),
      // 字符串族(`||` 口径):任何非空串原样透传
      want: { "0.5": "0.5", "1.9": "1.9", "-1": "-1", "999999999": "999999999",
              Infinity: "Infinity", NaN: "NaN", abc: "abc", true: "true", TRUE: "TRUE" } },
  ];

  for (const row of TABLE) {
    describe(`${row.name}(${row.key})`, () => {
      for (const sample of EXT_SAMPLES) {
        const want = row.want[sample];
        it(`${sample} → ${want === NAN ? "NaN(既有缺陷:非法值不回退)" : JSON.stringify(want)}`, () => {
          const got = withEnv(row.key, sample, row.get);
          if (want === NAN) {
            expect(typeof got === "number" && Number.isNaN(got)).toBe(true);
          } else {
            expect(got).toBe(want);
          }
        });
      }
    });
  }
});

describe("design contract —— 布尔口径快照(评审 反例⑤:严格 `\"1\"` 被放宽成也接受 `\"true\"`)", () => {
  /**
   * ★ 补覆盖缺口:上一段快照只列数值/字符串族,**漏了布尔** → 实测把
   * `cursorVoicedGate` 从 `=== "1"` 放宽成 `["1","true","True"].includes(...)`,
   * 全部用例**仍绿**。这正是 AIM 期把布尔口径「统一」后致 **GPU 静默切 CPU** 的那类 Critical
   * (`AIM_FORCE_CPU` 唯 `"1"` 生效,`"true"` 不生效;统一口径 = 静默改线上行为)。
   *
   * 两个族**刻意不同、MUST NOT 统一**:
   *  - 严格 `=== "1"`(默认关):只有字面 `"1"` 开,`"true"`/`"TRUE"`/`"yes"` **都不开**
   *  - 宽松 `!== "0"`(默认开):只有字面 `"0"` 关,空串/空白/任意其它值 **都开**
   */
  const BOOL_SAMPLES = ["<unset>", "", "  ", "0", "1", "true", "TRUE", "True", "yes", "on", "-1"] as const;

  // 严格族:唯 "1" 为 true(默认关的项)
  const STRICT: { name: string; key: string; get: () => boolean }[] = [
    // ★ design contract:`AIM_CURSOR_VOICED_GATE` 归 **C 类**(design contract 记真机 stall 1/3 + 阈值待调 → 最佳值未定,
    //   保持默认关)。故它**仍在严格族** —— 这是本 spec 刻意不动的一项。
    { name: "cursorVoicedGate", key: "AIM_CURSOR_VOICED_GATE", get: () => engineConfig.cursorVoicedGate() },
    { name: "rmsDiag", key: "AIM_RMS_DIAG", get: () => mediaConfig.rmsDiag() },
    // ★ design contract B 类:`violationEnforcement` 已**移出严格族**(默认改开 → 口径翻转为 offByZero),见下 LOOSE。
  ];
  // 宽松族:唯 "0" 为 false(默认开的项)
  const LOOSE: { name: string; key: string; get: () => boolean }[] = [
    { name: "farewellHangup", key: "AIM_FAREWELL_HANGUP", get: () => mediaConfig.farewellHangup() },
    { name: "semanticEnd", key: "AIM_SEMANTIC_END", get: () => mediaConfig.semanticEnd() },
    { name: "r3SilenceAdvance", key: "AIM_R3_SILENCE_ADVANCE", get: () => mediaConfig.r3SilenceAdvance() },
    // ★ design contract B 类:默认开 + kill switch(会 end() 写 failed,故保留紧急退路)。
    //   ⚠ 它用 `boolKillSwitch` 而非 `boolOffByZero` —— 故**不属于**本「宽松族」的
    //   「唯 '0' 关」口径(`false`/`off`/`no` 也关)。逐格快照见下方独立 describe。
    { name: "violationEnforcement", key: "AIM_VIOLATION_ENFORCEMENT", get: () => mediaConfig.violationEnforcement() },
  ];

  for (const row of STRICT) {
    describe(`严格族 ${row.name}(${row.key}):唯 "1" 开`, () => {
      for (const sample of BOOL_SAMPLES) {
        const want = sample === "1";
        it(`${sample} → ${want}`, () => {
          expect(withEnv(row.key, sample === "<unset>" ? undefined : sample, row.get)).toBe(want);
        });
      }
    });
  }
  for (const row of LOOSE) {
    describe(`宽松族 ${row.name}(${row.key}):唯 "0" 关`, () => {
      for (const sample of BOOL_SAMPLES) {
        const want = sample !== "0";
        it(`${sample} → ${want}`, () => {
          expect(withEnv(row.key, sample === "<unset>" ? undefined : sample, row.get)).toBe(want);
        });
      }
    });
  }
});


// ── design contract:kill switch 口径逐格快照(与 boolOffByZero 刻意不同)────────────────
//
// 为什么单独一族(review 实证):`boolOffByZero` 只认字面 `"0"`,于是
// `AIM_VIOLATION_ENFORCEMENT=false` 实际**反而开着** —— 而这些 flag 正是「误判率异常时救命」用的,
// 救命开关拧不动是最坏的失败形状。故新迁入的 kill switch 用宽松关闭识别。
//
// ⚠ 既有的 boolOffByZero 项(farewellHangup/semanticEnd/r3SilenceAdvance)**一格不动** ——
//   design contract 明确「空值语义逐 key 保留现状,MUST NOT 统一」。这里只钉新口径,不改旧口径。
describe("design contract —— kill switch 口径逐格快照", () => {
  const KILL_SWITCHES: { name: string; key: string; get: () => boolean }[] = [
    { name: "violationEnforcement", key: "AIM_VIOLATION_ENFORCEMENT",
      get: () => mediaConfig.violationEnforcement() },
  ];
  // 关闭意图:大小写与前后空白不敏感
  const CLOSING = ["0", "false", "FALSE", " False ", "off", "OFF", "no", "NO"];
  // 非关闭:空串/空白刻意**不**当关闭(脚本失误 `X=""` 不该静默关掉保护能力)
  const NOT_CLOSING = ["<unset>", "", "  ", "1", "true", "yes", "on", "-1"];

  for (const ks of KILL_SWITCHES) {
    describe(`${ks.name}(${ks.key})`, () => {
      for (const v of CLOSING) {
        it(`${JSON.stringify(v)} → 关`, () => {
          expect(withEnv(ks.key, v, ks.get)).toBe(false);
        });
      }
      for (const v of NOT_CLOSING) {
        it(`${JSON.stringify(v)} → 开(默认)`, () => {
          expect(withEnv(ks.key, val(v), ks.get)).toBe(true);
        });
      }
    });
  }
});
