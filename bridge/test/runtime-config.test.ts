/**
 * design contract —— registry 守门测试。
 *
 * 这些断言是 design contract 1 的**可执行形式**。首轮移植的失败模式是:
 * 「registry 手抄默认值 + 人工审计 + 报告声称 100% 已审计」→ 实测 50 项手抄里 **23 项错**(46%),
 * 而 805 条单测**同时全绿**(因为断言校验的是 registry 自己声明的默认值)。
 *
 * 故本文件的守门刻意分三层,缺一层都会留下同样的假绿缝隙:
 *  ① **源码级**:registry 里不得出现默认值字面量(禁「第二份可写副本」在物理上出现)
 *  ② **语义级**:逐 key 断言 `default` === 叶子模块导出值(禁「换个名字继续手抄」)
 *  ③ **架构级**:叶子模块不得 import registry(禁循环依赖 —— 实证会致 RC 随加载顺序变 undefined)
 * 外加 ④ 清单一致性(与机械扫描产物 `config-inventory.json` 比对,新增 key 漏登记即红)。
 */
import * as fs from "fs";
import * as path from "path";

import {
  EXCLUDED_KEYS,
  TUNABLE_KEYS,
  loadRuntimeConfig,
  type ConfigEntry,
} from "../src/runtime-config";
import { TURN_HANDLING_DEFAULTS } from "../src/turn-handling";
import { SPEAKER_LOCK_DEFAULTS } from "../src/speaker-lock";
import { MEDIA_DEFAULTS } from "../src/media-config";
import { ENGINE_DEFAULTS } from "../src/engine-config";
import { ACK_TIMEOUT_DEFAULTS } from "../src/playback-settlement";
import { ANTIALIAS_DEFAULTS } from "../src/resample";
import { BYPASS_LLM_TIMEOUT_DEFAULTS } from "../src/bypass-llm-config";
import { MANTLE_KEEPALIVE_DEFAULT_MS } from "../src/mantle-llm";
import { CONVERSE_KEEPALIVE_DEFAULT_MS } from "../src/bedrock-converse-llm";
import { LLM_FALLBACK_ATTEMPT_DEFAULT_MS } from "../src/fallback-llm";
import {
  CALM_TONE_DEFAULT,
  INTERACTION_STYLE_DEFAULT,
  OPEN_CHAT_DIRECTIVE_DEFAULT,
} from "../src/prompt-compose";

const SRC_DIR = path.join(__dirname, "..", "src");
const readSrc = (f: string) => fs.readFileSync(path.join(SRC_DIR, f), "utf8");

/**
 * 剥掉块注释与行注释(含**代码行尾**的 `//` 注释),避免注释内容被当成代码判读。
 *
 * ⚠ 必须处理行尾注释:`session-context.ts:36` 有
 *   `const TTL_MS = 30 * 60 * 1000; // …对齐 backend AIM_SESSION_JOIN_EXPIRE_MIN`
 * 那个 key 是 **backend 的 env**,bridge 根本不读它 —— 只剥「整行注释」会把它误当成 bridge 未登记开关。
 *
 * ⚠ 同时 MUST 跳过字符串字面量里的 `//`(如 `"https://host"`),否则会把后半行代码连带吃掉
 * (机械抽取脚本踩过这个坑:`AIM_MANTLE_HOST` 曾因此整个漏抓)。
 */
function stripComments(ts: string): string {
  const noBlock = ts.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === "\\") { i++; continue; }
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === "`") {
          quote = c;
        } else if (c === "/" && line[i + 1] === "/") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

const byKey = (entries: ConfigEntry[]) => new Map(entries.map((e) => [e.key, e]));

describe("design contract ① 源码级:registry 不得含默认值字面量", () => {
  const code = stripComments(readSrc("runtime-config.ts"));

  it("不存在 `const D_XXX = <字面量>` 形态(首轮 46% 出错的载体)", () => {
    const hits = code.match(/^\s*const\s+D_[A-Z0-9_]+\s*(?::[^=]+)?=\s*.+$/gm) ?? [];
    expect(hits).toEqual([]);
  });

  it("`e(key, value, default)` 的第三参不得是字面量(必须是 import 来的引用)", () => {
    // 匹配 e("AIM_X", <任意>, <第三参>) 的第三参;字面量 = 纯数字 / 带引号字符串 / true|false
    const bad: string[] = [];
    const re = /\be\(\s*"(AIM_[A-Z0-9_]+)"\s*,([\s\S]*?),([^,()]*?)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const [, key, , dflt] = m;
      const tok = dflt.trim();
      if (/^-?[0-9][0-9_.]*$/.test(tok) || /^["'`]/.test(tok) || tok === "true" || tok === "false") {
        bad.push(`${key} → ${tok}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("design contract ② 语义级:逐 key default === 叶子模块导出值", () => {
  const entries = loadRuntimeConfig();
  const map = byKey(entries);

  /**
   * 期望表:key → 该 key 的 default **应当等于**哪个叶子模块导出。
   *
   * ⚠ 表里的右值一律是**对导出的引用**,不是字面量 —— 若写字面量,本测试就退化成
   * 「registry 手抄 vs 测试手抄」的自我印证(首轮 805 绿 + 23 项错的成因)。
   */
  const EXPECT: Record<string, unknown> = {
    // turn-handling
    AIM_ENDPOINT_RMS_THRESHOLD: TURN_HANDLING_DEFAULTS.endpointing.rmsThreshold,
    AIM_ENDPOINT_SILENCE_GAP_MS: TURN_HANDLING_DEFAULTS.endpointing.silenceGapMs,
    AIM_ENDPOINT_MIN_SPEECH_MS: TURN_HANDLING_DEFAULTS.endpointing.minSpeechMs,
    AIM_VAD_ENERGY_THRESHOLD: TURN_HANDLING_DEFAULTS.endpointing.rmsThreshold,
    AIM_BARGE_RMS_THRESHOLD: TURN_HANDLING_DEFAULTS.interruption.rmsThreshold,
    AIM_BARGE_CONFIRM_MS: TURN_HANDLING_DEFAULTS.interruption.confirmMs,
    AIM_BARGE_HANGOVER_MS: TURN_HANDLING_DEFAULTS.interruption.hangoverMs,
    AIM_INTERRUPTION_MIN_WORDS: TURN_HANDLING_DEFAULTS.interruption.minWords,
    AIM_BARGE_DTD: TURN_HANDLING_DEFAULTS.interruption.dtdEnabled,
    AIM_BARGE_DTD_FLOOR: TURN_HANDLING_DEFAULTS.interruption.dtdFloor,
    AIM_BARGE_DTD_ECHO_GAIN: TURN_HANDLING_DEFAULTS.interruption.dtdEchoGain,
    AIM_BARGE_DYN_FLOOR: TURN_HANDLING_DEFAULTS.interruption.dynFloorEnabled,
    AIM_BARGE_DYN_FLOOR_WINDOW_MS: TURN_HANDLING_DEFAULTS.interruption.dynFloorWindowMs,
    AIM_BARGE_DYN_FLOOR_K: TURN_HANDLING_DEFAULTS.interruption.dynFloorK,
    AIM_FALSE_INTERRUPTION_RECOVERY: TURN_HANDLING_DEFAULTS.interruption.recoveryEnabled,
    AIM_FALSE_INTERRUPTION_WINDOW_MS: TURN_HANDLING_DEFAULTS.interruption.recoveryWindowMs,
    AIM_FALSE_INTERRUPTION_TAKEOVER_MS: TURN_HANDLING_DEFAULTS.interruption.recoveryTakeoverMs,
    AIM_RECOVERY_TAKEOVER_DECAY: TURN_HANDLING_DEFAULTS.interruption.recoveryTakeoverDecay,
    AIM_FALSE_INTERRUPTION_MAX_HOLD_MS: TURN_HANDLING_DEFAULTS.interruption.recoveryMaxHoldMs,
    AIM_BARGE_OPEN_COOLDOWN_MS: TURN_HANDLING_DEFAULTS.interruption.openCooldownMs,
    AIM_BARGE_OPEN_COOLDOWN_MULT: TURN_HANDLING_DEFAULTS.interruption.openCooldownMult,
    AIM_MIN_INPUT_CHARS: TURN_HANDLING_DEFAULTS.meaningfulInput.minChars,
    AIM_PROACTIVE_OPENING: TURN_HANDLING_DEFAULTS.proactiveOpening.enabled,
    AIM_PROACTIVE_OPENING_SILENCE_MS: TURN_HANDLING_DEFAULTS.proactiveOpening.silenceMs,
    AIM_AI_SPEAKING_MAX_IDLE_MS: TURN_HANDLING_DEFAULTS.aiDoneWatchdog.maxIdleMs,
    AIM_MAX_PLAYBACK_LEAD_MS: TURN_HANDLING_DEFAULTS.playbackClock.maxLeadMs,
    AIM_PLAYBACK_LEAD_MARGIN_MS: TURN_HANDLING_DEFAULTS.playbackClock.leadMarginMs,
    AIM_ANSWER_GRACE_MS: TURN_HANDLING_DEFAULTS.answerGrace.defaultMs,
    AIM_AUTO_NEXT_GRACE_MS: TURN_HANDLING_DEFAULTS.answerGrace.autoNextMs,
    AIM_QUESTION_MIN_ANSWER_CHARS: TURN_HANDLING_DEFAULTS.questionProgression.minAnswerChars,
    AIM_QUESTION_MAX_RETRY: TURN_HANDLING_DEFAULTS.questionProgression.maxRetryPerQuestion,
    AIM_QUESTION_MAX_FOLLOW_UPS: TURN_HANDLING_DEFAULTS.questionProgression.maxFollowUpsPerQuestion,
    AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS:
      TURN_HANDLING_DEFAULTS.questionProgression.forceClosureStreamTimeoutMs,
    AIM_EOU_CORRECTION_ENABLED: TURN_HANDLING_DEFAULTS.eouCorrection.enabled,
    AIM_EOU_CORRELATION_MS: TURN_HANDLING_DEFAULTS.eouCorrection.correlationMs,
    // design contract:降门槛窗独立于关联窗(此前共用 correlationMs)
    AIM_EOU_SUB_THRESHOLD_WINDOW_MS: TURN_HANDLING_DEFAULTS.eouCorrection.subThresholdWindowMs,
    AIM_EOU_SUB_THRESHOLD_MULT: TURN_HANDLING_DEFAULTS.eouCorrection.subThresholdMult,
    AIM_EOU_VERDICT_TIMEOUT_MS: BYPASS_LLM_TIMEOUT_DEFAULTS.eouVerdictMs,
    // engine-config
    AIM_TTS_TIMEOUT_MS: ENGINE_DEFAULTS.ttsTimeoutMs,
    AIM_LLM_TTFT_TIMEOUT_MS: ENGINE_DEFAULTS.llmTtftTimeoutMs,
    AIM_CANCEL_ACK_TIMEOUT_MS: ENGINE_DEFAULTS.cancelAckTimeoutMs,
    AIM_KICKOFF_WAKE_TEXT: ENGINE_DEFAULTS.kickoffWakeText,
    AIM_CURSOR_VOICED_GATE: ENGINE_DEFAULTS.cursorVoicedGate,
    AIM_CURSOR_VOICED_MAX_STALL: ENGINE_DEFAULTS.cursorVoicedMaxStall,
    AIM_STALE_ANSWER_MAX: ENGINE_DEFAULTS.staleAnswerMax,
    // media-config
    AIM_RMS_DIAG: MEDIA_DEFAULTS.rmsDiag,
    AIM_RMS_DIAG_EVERY: MEDIA_DEFAULTS.rmsDiagEvery,
    AIM_SEMANTIC_END: MEDIA_DEFAULTS.semanticEnd,
    AIM_FAREWELL_HANGUP: MEDIA_DEFAULTS.farewellHangup,
    AIM_FAREWELL_HANGUP_DELAY_MS: MEDIA_DEFAULTS.farewellHangupDelayMs,
    AIM_FAREWELL_TAIL_MS: MEDIA_DEFAULTS.farewellTailMs,
    AIM_FAREWELL_DRAIN_MAX_MS: MEDIA_DEFAULTS.farewellDrainMaxMs,
    AIM_BARGE_DTD_WINDOW_MS: MEDIA_DEFAULTS.bargeDtdWindowMs,
    AIM_MODERATION_TIMEOUT_MS: BYPASS_LLM_TIMEOUT_DEFAULTS.moderationMs,
    AIM_MODERATION_CONFIDENCE_THRESHOLD: MEDIA_DEFAULTS.moderationConfidenceThreshold,
    AIM_VIOLATION_ENFORCEMENT: MEDIA_DEFAULTS.violationEnforcement,
    AIM_SILENCE_VIOLATION_MS: MEDIA_DEFAULTS.silenceViolationMs,
    AIM_SILENCE_WARN_MAX: MEDIA_DEFAULTS.silenceWarnMax,
    AIM_SEVERE_VIOLATION_MAX: MEDIA_DEFAULTS.severeViolationMax,
    AIM_NO_FRAME_MS: MEDIA_DEFAULTS.noFrameMs,
    AIM_R3_SILENCE_ADVANCE: MEDIA_DEFAULTS.r3SilenceAdvance,
    AIM_IDLE_CHATTER_MIN_TURNS: MEDIA_DEFAULTS.idleChatterMinTurns,
    AIM_FORCED_END_MAX_WAIT_MS: MEDIA_DEFAULTS.forcedEndMaxWaitMs,
    // 派生默认(design contract):= silenceViolationMs × 40%,故用算式而非字面量
    AIM_ADVANCE_NUDGE_MS: Math.floor(MEDIA_DEFAULTS.silenceViolationMs * 0.4),
    AIM_ADVANCE_AFTER_NUDGE_MS: Math.floor(MEDIA_DEFAULTS.silenceViolationMs * 0.4),
    // prompt-compose
    AIM_CALM_TONE: CALM_TONE_DEFAULT,
    AIM_INTERACTION_STYLE: INTERACTION_STYLE_DEFAULT,
    AIM_OPEN_CHAT_DIRECTIVE: OPEN_CHAT_DIRECTIVE_DEFAULT,
    // transcript-fixer / playback-settlement
    AIM_TRANSCRIPT_FIXER_TIMEOUT_MS: BYPASS_LLM_TIMEOUT_DEFAULTS.fixerMs,
    AIM_PLAYBACK_ACK_GRACE_MS: ACK_TIMEOUT_DEFAULTS.graceMs,
    AIM_PLAYBACK_ACK_INPUT_GRACE_MS: ACK_TIMEOUT_DEFAULTS.inputGraceMs,
    AIM_PLAYBACK_ACK_MAX_WAIT_MS: ACK_TIMEOUT_DEFAULTS.maxWaitMs,
    // resample
    AIM_TTS_ANTIALIAS: ANTIALIAS_DEFAULTS.on,
    AIM_TTS_ANTIALIAS_FC_HZ: ANTIALIAS_DEFAULTS.fcHz,
    AIM_TTS_ANTIALIAS_TAPS: ANTIALIAS_DEFAULTS.taps,
    // speaker-lock
    AIM_SPEAKER_LOCK_ENABLED: SPEAKER_LOCK_DEFAULTS.enabled,
    AIM_SPEAKER_LOCK_EMA: SPEAKER_LOCK_DEFAULTS.ema,
    AIM_SPEAKER_LOCK_ENROLL_MS: SPEAKER_LOCK_DEFAULTS.enrollMs,
    AIM_SPEAKER_LOCK_ENROLL_GAP_MS: SPEAKER_LOCK_DEFAULTS.enrollGapMs,
    AIM_SPEAKER_LOCK_ENROLL_CONSISTENCY: SPEAKER_LOCK_DEFAULTS.enrollConsistency,
    AIM_SPEAKER_LOCK_MIN_VERIFY_MS: SPEAKER_LOCK_DEFAULTS.minVerifyMs,
    AIM_SPEAKER_LOCK_VERIFY_WINDOW_MS: SPEAKER_LOCK_DEFAULTS.verifyWindowMs,
    AIM_SPEAKER_LOCK_THRESHOLD_HIGH: SPEAKER_LOCK_DEFAULTS.thresholdHigh,
    AIM_SPEAKER_LOCK_THRESHOLD_LOW: SPEAKER_LOCK_DEFAULTS.thresholdLow,
    AIM_SPEAKER_LOCK_TIMEOUT_MS: SPEAKER_LOCK_DEFAULTS.timeoutMs,
    // LLM keepalive / fallback
    AIM_CONVERSE_KEEPALIVE_MS: CONVERSE_KEEPALIVE_DEFAULT_MS,
    AIM_MANTLE_KEEPALIVE_MS: MANTLE_KEEPALIVE_DEFAULT_MS,
    AIM_LLM_FALLBACK_ATTEMPT_MS: LLM_FALLBACK_ATTEMPT_DEFAULT_MS,
  };

  it("期望表覆盖全部 TUNABLE_KEYS(漏一个即红,防新增 key 不设守门)", () => {
    const missing = TUNABLE_KEYS.filter((k) => !(k in EXPECT));
    expect(missing).toEqual([]);
  });

  it("序列化条目与 TUNABLE_KEYS 一一对应(无缺、无多、无重)", () => {
    const keys = entries.map((e) => e.key);
    expect(keys.length).toBe(new Set(keys).size); // 无重复
    expect([...keys].sort()).toEqual([...TUNABLE_KEYS].sort());
  });

  for (const key of Object.keys(EXPECT)) {
    it(`${key} 的 default 来自叶子模块导出`, () => {
      const entry = map.get(key);
      expect(entry).toBeDefined();
      expect(entry!.default).toBe(EXPECT[key]);
    });
  }

  it("未设 env 时 value === default 且 override_state=absent", () => {
    for (const entry of entries) {
      if (process.env[entry.key] !== undefined) continue; // 宿主环境设了的跳过
      expect(entry.override_state).toBe("absent");
      expect(entry.value).toBe(entry.default);
    }
  });
});

describe("design contract ③ 架构级:配置叶子模块不得 import registry(防循环依赖)", () => {
  /**
   * 实证:defaults 与 registry 消费方同文件时,加载顺序决定 RC 是否为 undefined ——
   * 先加载业务模块得 `undefined`、先加载 registry 得正常值。TS 能编译、测试可能碰巧绿、生产随机炸。
   */
  const LEAVES = [
    "media-config.ts",
    "engine-config.ts",
    "turn-handling.ts",
    "speaker-lock.ts",
    "prompt-compose.ts",
    "resample.ts",
    "eou-verdict.ts",
    "transcript-fixer.ts",
    "moderation-verdict.ts",
    "playback-settlement.ts",
    "bypass-llm-config.ts",
    "mantle-llm.ts",
    "bedrock-converse-llm.ts",
    "fallback-llm.ts",
  ];

  for (const leaf of LEAVES) {
    it(`${leaf} 不 import runtime-config`, () => {
      expect(stripComments(readSrc(leaf))).not.toMatch(/from\s+["']\.\/runtime-config["']/);
    });
  }

  it("三个新配置叶子是纯叶子(零本地 import)", () => {
    for (const leaf of ["media-config.ts", "engine-config.ts", "bypass-llm-config.ts"]) {
      const imports = stripComments(readSrc(leaf)).match(/from\s+["']\.\/[a-z0-9-]+["']/g) ?? [];
      expect(imports).toEqual([]);
    }
  });

  /**
   * registry MUST 被业务真正消费 —— 否则「业务与端点共读同一快照」的前提不成立,
   * 这一段做了等于没做(首轮实测:零个生产文件 import,是 review 的头号 Critical)。
   */
  it("registry 被业务模块真正 import(非死代码)", () => {
    const consumers = fs
      .readdirSync(SRC_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "runtime-config.ts")
      .filter((f) => /from\s+["']\.\/runtime-config["']/.test(stripComments(readSrc(f))));
    // 至少 media-session 与 three-stage-engine 两个核心业务模块要读它
    expect(consumers).toEqual(expect.arrayContaining(["media-session.ts", "three-stage-engine.ts"]));
  });

  it("核心业务模块不再直读 process.env.AIM_*(全部经 registry)", () => {
    for (const f of ["media-session.ts", "three-stage-engine.ts"]) {
      const hits = stripComments(readSrc(f)).match(/process\.env\.AIM_[A-Z0-9_]+/g) ?? [];
      expect(hits).toEqual([]);
    }
  });

  /**
   * registry **不得**依赖会被 `jest.mock()` 的行为模块取配置。
   *
   * 实测:registry 曾从 `moderation-verdict`(行为模块)import 超时配置,而 4 个 suite 用
   * partial mock 只声明 `judgeModeration` → registry 在模块加载期 `moderationTimeoutMs is not a
   * function`,炸了 5 个 suite / 27 个用例。配置属纯数据,MUST 住在纯配置叶子里。
   */
  it("registry 不从三个常被 mock 的行为模块取配置", () => {
    const code = stripComments(readSrc("runtime-config.ts"));
    for (const behavior of ["moderation-verdict", "eou-verdict", "transcript-fixer"]) {
      expect(code).not.toMatch(new RegExp(`from\\s+["']\\./${behavior}["']`));
    }
  });
});

describe("design contract ④ 清单一致性 + 枚举完整性", () => {
  it("registry 登记集与机械扫描清单(config-inventory.json)一致", () => {
    const inv = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "config-inventory.json"), "utf8"),
    ) as { entries: { key: string; status: string }[] };
    const invIncluded = inv.entries.filter((e) => e.status === "included").map((e) => e.key);
    const invExcluded = inv.entries.filter((e) => e.status === "excluded").map((e) => e.key);

    // 清单的 included 必须全部在 TUNABLE_KEYS 里(漏登记即红)
    expect(invIncluded.filter((k) => !TUNABLE_KEYS.includes(k as never)).sort()).toEqual([]);
    // 清单的 excluded 必须全部在 EXCLUDED_KEYS 里
    expect(invExcluded.filter((k) => !EXCLUDED_KEYS.includes(k)).sort()).toEqual([]);
  });

  it("源码里出现的 AIM_* 要么登记、要么排除(不许两头空)", () => {
    const files = fs
      .readdirSync(SRC_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "runtime-config.ts" && f !== "config-endpoint.ts");
    const found = new Set<string>();
    for (const f of files) {
      for (const m of stripComments(readSrc(f)).matchAll(/\b(AIM_[A-Z0-9_]+)\b/g)) {
        found.add(m[1]);
      }
    }
    const orphans = [...found].filter(
      (k) => !TUNABLE_KEYS.includes(k as never) && !EXCLUDED_KEYS.includes(k),
    );
    expect(orphans.sort()).toEqual([]);
  });
});

describe("design contract ⑤ 纯查表:序列化零 env 访问(review 回归)", () => {
  /**
   * `loadRuntimeConfig()` MUST 只读 `RC` 冻结快照 —— 含 `override_state`。
   *
   * 曾经的缺陷:`override_state` 经 `overrideState(key,…)` 内部调 `isSet()` 重读 env,
   * 致「value 已冻结、状态却随 env 漂移」的自相矛盾。实证:
   * ```
   * 加载时设 env  → value: 300  override_state: valid
   * 删 env 后序列化 → value: 300  override_state: absent   ← 同一份快照两种状态
   * ```
   * 这违背本页存在的唯一理由(端点必须报告业务实际在用的那一份)。
   */
  it("模块加载后改 env,override_state MUST 不变(与 value 一样冻结)", () => {
    const KEY = "AIM_BARGE_CONFIRM_MS";
    const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
    const prev = process.env[KEY];
    try {
      process.env[KEY] = "300";
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rc = require("../src/runtime-config") as typeof import("../src/runtime-config");
      const before = rc.loadRuntimeConfig().find((e) => e.key === KEY)!;
      expect(before.value).toBe(300);
      expect(before.override_state).toBe("valid");

      // 加载后删 env —— 快照 MUST 不受影响(value 与 override_state 都不变)
      delete process.env[KEY];
      const after = rc.loadRuntimeConfig().find((e) => e.key === KEY)!;
      expect(after.value).toBe(before.value);
      expect(after.override_state).toBe(before.override_state);

      // 反向:加载后**新增** env 也不得影响快照
      process.env["AIM_SILENCE_WARN_MAX"] = "9";
      const other = rc.loadRuntimeConfig().find((e) => e.key === "AIM_SILENCE_WARN_MAX")!;
      expect(other.override_state).toBe("absent");
      delete process.env["AIM_SILENCE_WARN_MAX"];
    } finally {
      if (had) process.env[KEY] = prev;
      else delete process.env[KEY];
      jest.resetModules();
    }
  });

  it("源码级:loadRuntimeConfig 函数体内不得出现 process.env / isSet(", () => {
    const code = stripComments(readSrc("runtime-config.ts"));
    const start = code.indexOf("export function loadRuntimeConfig");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start);
    expect(body).not.toMatch(/process\.env/);
    expect(body).not.toMatch(/\bisSet\(/);
  });
});


// ── design contract:派生默认值 MUST 贯通 registry(review)──────────────────
//
// 关联窗的默认是**派生**的(生效判定超时 + 余量)。若 registry 上报 `thd.eouCorrection.correlationMs`
// (= 超时取默认时的派生结果 7000),则 timeout=8000 时业务用 9000、registry 报 7000 →
// 只读页把**完全正确**的配置误标「异于默认」。这恰是本 spec 要消灭的假信号,故逐值钉死。
describe("design contract:关联窗派生默认贯通 registry", () => {
  const KEYS = ["AIM_EOU_VERDICT_TIMEOUT_MS", "AIM_EOU_CORRELATION_MS"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.resetModules();
  });

  it.each([
    ["500", 1500],
    ["2000", 3000],
    ["6000", 7000],   // 默认组合
    ["8000", 9000],   // review 的复现场景(合法上限)
  ])("timeout=%s → registry 的 value 与 default 同为 %i(不误标 differs)", (timeout, want) => {
    process.env.AIM_EOU_VERDICT_TIMEOUT_MS = timeout as string;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadRuntimeConfig } = require("../src/runtime-config");
    const row = loadRuntimeConfig().find(
      (e: { key: string }) => e.key === "AIM_EOU_CORRELATION_MS",
    ) as { value: number; default: number };
    expect(row.value).toBe(want);
    expect(row.default).toBe(want);
  });
});
