/**
 * 媒体面配置**叶子模块**(design contract)—— 告别挂断 / 违规检测 / 静默推进 / RMS 诊断 /
 * 语义端 / DTD 窗 各族的**默认值 + 解析器**单一事实源。
 *
 * ## 为什么要这个文件(架构约束,勿合并回 media-session.ts)
 *
 * design contract 1:registry(`runtime-config.ts`)的 `default` MUST 由源模块导出、
 * MUST NOT 手抄字面量 —— 实测手抄 50 项里 23 项与源码不符(46%,最严重差 75 倍)。
 *
 * 但 `media-session.ts`(2550 行)**同时**是「默认值的家」与「registry 的消费方」,若让 registry
 * 直接 import 它就形成 `runtime-config → media-session → runtime-config` **真循环**。
 * 实证(最小复现):defaults 与 registry 消费方同文件时——
 * ```
 * 入口先加载业务模块 → RC.x = undefined   ← Warning: Accessing non-existent property
 * 入口先加载 registry  → RC.x = 1500      ← 正常
 * ```
 * 同一份代码两种结果、随入口顺序变;TS 能编译、测试可能碰巧绿、生产随机炸。
 *
 * 故把默认值与解析器下沉到本叶子模块。**依赖方向单向**:
 * ```
 * media-session.ts ─┐
 *                   ├─→ runtime-config.ts ─→ media-config.ts(本文件,叶子)
 * config-endpoint ──┘
 * ```
 * 本文件 **MUST NOT** import `runtime-config` / `media-session` / 任何业务大模块(有测试守门)。
 *
 * ## 行为等价红线
 *
 * 每个解析器都是从 `media-session.ts` **逐字搬运**(含 `>0` / `>=1` / `Math.floor` / 派生默认等
 * 判据差异),MUST NOT 借机「统一空值语义」——四种形态对 `""` / `"  "` 的处理本就互不相同,
 * 统一即静默改线上行为(`bridge/test/config-characterization.test.ts` 逐格钉死)。
 */

// ── 默认值(逐字沿用搬运前 media-session.ts 的字面量;改这里 = 改线上行为)──
export const MEDIA_DEFAULTS = {
  /** RMS 诊断日志:默认关(生产不刷屏)。 */
  rmsDiag: false,
  /** 诊断打印周期(帧);~25×20ms=0.5s。 */
  rmsDiagEvery: 25,
  /** 语义挂断总开关:默认开。 */
  farewellHangup: true,
  /** 检测到告别语义后延迟收尾(ms)。 */
  farewellHangupDelayMs: 1500,
  // ★ design contract A 类:`farewellTtsDrainEnabled` 字段与解析器**已整条删除**(不是「恒 true 的开关」)——
  //   保留一个恒真的配置项违反「配置应该是可变的」直觉,且只读页会多出一个信息量为零的展示行
  //   (review)。design contract 的 drain 推算现在无条件生效,失败上限由 farewellDrainMaxMs 兜住。
  /** 网络传输 + 客户端 jitter/播放缓冲余量(ms)。 */
  farewellTailMs: 1000,
  /** drain 硬上限(ms):防推算值过大而永久不挂。 */
  farewellDrainMaxMs: 20_000,
  /** LLM 语义挂断(两步确认):默认开;=0 时正则告别才作兜底。 */
  semanticEnd: true,
  /** 违规裁判高置信门槛,夹 (0,1]。 */
  moderationConfidenceThreshold: 0.8,
  /** design contract 违规 enforcement:**默认开**(design contract B 类,deployment validation 由关改开)。
   *
   *  ⚠ **这是 kill switch,不是调优参数**:开时会产生考生可感知动作(警告 / 强制结束会话写 `failed`)。
   *  `AIM_VIOLATION_ENFORCEMENT=0` 退回 shadow(只 log 计数)。误判率异常时用它紧急降级。
   *
   *  为什么改默认开而**不删开关**(design contract review,已采纳):design contract 明写
   *  「默认关……真机验证前只观察计数日志」,且它会改变**会话终态**(≠ A 类的纯呈现修复)。
   *  「宁漏判不误判」红线要求保留紧急退路 —— 北京区回滚需上区内 x86 机跑完整部署,不是几分钟的事。 */
  violationEnforcement: true,
  /** 沉默阈值(ms):等待作答期连续无有效语音超此 → 计一次。
   *  **默认 20000**(design contract B 类,由 10000 改):design contract 真机验通值(10s 对口试思考偏短,易冤判)。 */
  silenceViolationMs: 20_000,
  /** 前 N 次警告,第 N+1 次 fail 挂断。 */
  silenceWarnMax: 3,
  /** 入向无帧超此(ms)= 断流(物理断连,不计沉默)。 */
  noFrameMs: 30_000,
  /** design contract 静默兜底:默认开(防死锁,非防作弊)。 */
  r3SilenceAdvance: true,
  /** 离题连续跨 ≥N 轮重复才计一次消极对抗。 */
  idleChatterMinTurns: 2,
  /** 违规强制结束前「先说明原因再挂」的硬超时(ms)。 */
  forcedEndMaxWaitMs: 10_000,
  /** 严重违规硬结束阈值(默认 2:第 1 次警告、第 2 次结束)。 */
  severeViolationMax: 2,
  /** DTD 参考窗(ms):MediaSession.REF_WINDOW_MS。 */
  bargeDtdWindowMs: 400,
} as const;

// ── 解析器(逐字搬运,判据差异刻意保留)──

/** 「=1 开」型布尔:默认关,显式 `"1"` 才开。 */
const boolOnByOne = (key: string): boolean => process.env[key] === "1";
/** 「=0 关」型布尔:默认开,显式 `"0"` 才关。
 *
 *  ⚠ 已知局限(**既有行为,design contract 要求逐 key 保留、MUST NOT 统一**):`"false"` / `"off"` / `""`
 *  都**不**关闭(只认字面 `"0"`)。既有项(`AIM_FAREWELL_HANGUP` 等)沿用此口径不动。
 *  新迁入的 **kill switch 类**请用 `boolKillSwitch`(见下)。 */
const boolOffByZero = (key: string): boolean => process.env[key] !== "0";

/** 「kill switch」型布尔:默认开,但**宽松识别关闭意图**(`0` / `false` / `off` / `no`,大小写与空白不敏感)。
 *
 *  ★ 为什么单独一个口径(design contract,review 实证)——
 *  `boolOffByZero` 只认字面 `"0"`,于是运维写 `AIM_VIOLATION_ENFORCEMENT=false` 想紧急关闭
 *  「违规强制结束会话」时,**实际反而是开着的**:kill switch 静默失效,而这类 flag 正是
 *  「误判率异常时救命」用的 —— 救命开关拧不动是最坏的失败形状。
 *
 *  ★ 为什么不改 `boolOffByZero` 本身:design contract 明确「空值语义逐 key 保留现状,MUST NOT 统一」
 *  (四种解析形态对 `""`/`"  "` 处理互不相同,统一即静默改线上行为)。故只给**新迁入的 kill switch**
 *  用更安全的口径,既有项一格不动。
 *
 *  ⚠ 仍**不**把空串/空白当关闭:`X=""` 常见于「变量存在但未赋值」的脚本失误,把它当「关掉救命开关」
 *  比当「保持默认开」更危险(前者静默降级保护能力,后者只是没生效那次覆盖)。 */
const boolKillSwitch = (key: string): boolean => {
  const raw = (process.env[key] ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
};

export const rmsDiag = (): boolean => boolOnByOne("AIM_RMS_DIAG");

/** 注:内联 `?? D` 口径 —— 空串**非** nullish,故 `X=""` 得 0(非默认)。刻意保留。 */
export const rmsDiagEvery = (): number =>
  Number(process.env.AIM_RMS_DIAG_EVERY ?? MEDIA_DEFAULTS.rmsDiagEvery);

export const farewellHangup = (): boolean => boolOffByZero("AIM_FAREWELL_HANGUP");

export const farewellHangupDelayMs = (): number =>
  Number(process.env.AIM_FAREWELL_HANGUP_DELAY_MS ?? MEDIA_DEFAULTS.farewellHangupDelayMs);

// ★ design contract A 类:`farewellTtsDrainEnabled()` 解析器**已删**。
//   为什么删而不是「默认开 + 保留 env」:本项修的是 design contract「跨境告别句尾音被固定 1.5s 延迟切断」——
//   一个**纯呈现缺陷**,关掉它只会让尾音重新被切,没有任何部署场景会想要那个行为。留一个「关掉修复」的
//   开关 = 留一条能静默回退到已知 bug 的路径,而 deployment validation 的事故正是这么发生的。
//   ⚠ **MUST NOT 加回**。回滚靠 git revert + 重新部署(可回退性由版本控制提供,不由运行时开关提供)。

export const farewellTailMs = (): number =>
  Number(process.env.AIM_FAREWELL_TAIL_MS ?? MEDIA_DEFAULTS.farewellTailMs);

export const farewellDrainMaxMs = (): number =>
  Number(process.env.AIM_FAREWELL_DRAIN_MAX_MS ?? MEDIA_DEFAULTS.farewellDrainMaxMs);

export const semanticEnd = (): boolean => boolOffByZero("AIM_SEMANTIC_END");

/** 高置信才判违规(宁漏勿误);夹 (0,1]。 */
export const moderationConfidenceThreshold = (): number => {
  const raw = Number(process.env.AIM_MODERATION_CONFIDENCE_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1
    ? raw
    : MEDIA_DEFAULTS.moderationConfidenceThreshold;
};

/** design contract B 类:**默认开**;`0`/`false`/`off`/`no` 关(kill switch)。
 *  ★ 口径随默认值一起翻转 —— 若只改 MEDIA_DEFAULTS 而留 `boolOnByOne`(唯 "1" 生效),
 *  未设 env 时恒 false,默认值改了也**永不生效**。
 *  ★ 用 `boolKillSwitch` 而非 `boolOffByZero`(review 实证):后者只认字面 `"0"`,
 *  运维写 `=false` 想紧急关闭「违规强制结束会话」时实际**反而开着** —— 救命开关拧不动。 */
export const violationEnforcement = (): boolean => boolKillSwitch("AIM_VIOLATION_ENFORCEMENT");

export const silenceViolationMs = (): number => {
  const raw = Number(process.env.AIM_SILENCE_VIOLATION_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : MEDIA_DEFAULTS.silenceViolationMs;
};

export const silenceWarnMax = (): number => {
  const raw = Number(process.env.AIM_SILENCE_WARN_MAX);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : MEDIA_DEFAULTS.silenceWarnMax;
};

export const noFrameMs = (): number => {
  const raw = Number(process.env.AIM_NO_FRAME_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : MEDIA_DEFAULTS.noFrameMs;
};

/**
 * design contract 派生默认(review):nudge / after 各 = `silenceViolationMs × 40%`,
 * 总和 80% < 100%,保证任何环境下 R3 兜底总时长恒 < 沉默违规阈值 —— **不靠硬编码**。
 * 故这两项的「默认值」不是字面量而是**算式**,registry MUST 标 `origin: derived`。
 */
export const advanceNudgeMs = (silenceMs: number): number => {
  const raw = Number(process.env.AIM_ADVANCE_NUDGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : Math.floor(silenceMs * 0.4);
};

export const advanceAfterNudgeMs = (silenceMs: number): number => {
  const raw = Number(process.env.AIM_ADVANCE_AFTER_NUDGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : Math.floor(silenceMs * 0.4);
};

/** 这两项是否被**显式** env 覆盖(决定是否跑 R3 倒挂 fail-fast 校验)。 */
export const r3EnvOverridden = (): boolean =>
  Number.isFinite(Number(process.env.AIM_ADVANCE_NUDGE_MS)) ||
  Number.isFinite(Number(process.env.AIM_ADVANCE_AFTER_NUDGE_MS));

export const r3SilenceAdvance = (): boolean => boolOffByZero("AIM_R3_SILENCE_ADVANCE");

export const idleChatterMinTurns = (): number => {
  const raw = Number(process.env.AIM_IDLE_CHATTER_MIN_TURNS);
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : MEDIA_DEFAULTS.idleChatterMinTurns;
};

export const forcedEndMaxWaitMs = (): number => {
  const raw = Number(process.env.AIM_FORCED_END_MAX_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : MEDIA_DEFAULTS.forcedEndMaxWaitMs;
};

export const severeViolationMax = (): number => {
  const raw = Number(process.env.AIM_SEVERE_VIOLATION_MAX);
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : MEDIA_DEFAULTS.severeViolationMax;
};

export const bargeDtdWindowMs = (): number =>
  Number(process.env.AIM_BARGE_DTD_WINDOW_MS ?? MEDIA_DEFAULTS.bargeDtdWindowMs);
