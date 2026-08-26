/**
 * TurnHandling 配置收口单测(design contract)。
 * 注:loadTurnHandling 读 process.env;每个用例存档并恢复相关 env,避免串扰。
 */
import { loadTurnHandling, TURN_HANDLING_DEFAULTS } from "../src/turn-handling";

const KEYS = [
  "AIM_ENDPOINT_RMS_THRESHOLD",
  "AIM_ENDPOINT_SILENCE_GAP_MS",
  "AIM_ENDPOINT_MIN_SPEECH_MS",
  "AIM_BARGE_RMS_THRESHOLD",
  "AIM_BARGE_CONFIRM_MS",
  "AIM_BARGE_HANGOVER_MS",
  "AIM_INTERRUPTION_MIN_WORDS",
  "AIM_BARGE_DTD",
  "AIM_BARGE_DTD_FLOOR",
  "AIM_BARGE_DTD_ECHO_GAIN",
  "AIM_BARGE_DYN_FLOOR",
  "AIM_BARGE_DYN_FLOOR_WINDOW_MS",
  "AIM_BARGE_DYN_FLOOR_K",
  "AIM_JOIN_WARMUP_MS",
  "AIM_MIN_INPUT_CHARS",
  "AIM_PROACTIVE_OPENING",
  "AIM_PROACTIVE_OPENING_SILENCE_MS",
  "AIM_AI_SPEAKING_MAX_IDLE_MS",
  "AIM_VAD_ENERGY_THRESHOLD",
  "AIM_FALSE_INTERRUPTION_RECOVERY",
  "AIM_FALSE_INTERRUPTION_WINDOW_MS",
  "AIM_FALSE_INTERRUPTION_TAKEOVER_MS",
  "AIM_FALSE_INTERRUPTION_MAX_HOLD_MS",
  "AIM_RECOVERY_TAKEOVER_DECAY",
  "AIM_MAX_PLAYBACK_LEAD_MS",
  "AIM_PLAYBACK_LEAD_MARGIN_MS",
  "AIM_ANSWER_GRACE_MS",
  "AIM_AUTO_NEXT_GRACE_MS",
  "AIM_QUESTION_MAX_FOLLOW_UPS",
  "AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS",
];

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("默认值 = 真机最佳值(design contract 铁律:默认值即最佳值)", () => {
  const th = loadTurnHandling();
  // ★ design contract B 类:silenceGapMs 900 → **1500**(design contract 端点静音容忍,北京 :76/:79 实跑值)。
  //   不变量 silenceGapMs ≥ GPU VAD hangover(800)✓。
  expect(th.endpointing).toEqual({ rmsThreshold: 500, silenceGapMs: 1500, minSpeechMs: 300 });
  expect(th.interruption).toEqual({
    // hangoverMs=60:确认窗容忍 ≤3 帧(60ms)的 RMS 跌落不清零(治浊/清音交替致漏判)
    rmsThreshold: 1500, confirmMs: 200, minWords: 0, hangoverMs: 60,
    dtdEnabled: true, dtdFloor: 700, dtdEchoGain: 0.3, // design contract DTD,deployment validation 真机标定固化
    // 021-metrics 动态噪声地板(治高底噪误打断):默认开,3s 窗 p20 × 1.5 抬高 dtdFloor
    dynFloorEnabled: true, dynFloorWindowMs: 3000, dynFloorK: 1.5,
    // ★ design contract B 类:design contract 误打断恢复**默认开**(CDK 原硬编码 '1' 已删,默认值搬回代码 = 行为等价重构)
    recoveryEnabled: true, recoveryWindowMs: 2000, recoveryTakeoverMs: 700, recoveryTakeoverDecay: 0.5,
    // ★ design contract B 类:design contract 恢复窗能量域顺延硬上限 0 → **5000**(北京 :76/:79 实跑值)
    recoveryMaxHoldMs: 5000,
    // design contract AI 开口冷却窗:默认 0=关(回退现状),mult 1.5 仅 openCooldownMs>0 时生效
    openCooldownMs: 0, openCooldownMult: 1.5,
  });
  // joinGating(入会门控)已随电话链路删除(VISION §1)
  // design contract 分组:拒垃圾输入门槛(默认 2 中文字符)+ 主动开场(默认开,静默 3s 触发)
  expect(th.meaningfulInput).toEqual({ minChars: 2 });
  expect(th.proactiveOpening).toEqual({ enabled: true, silenceMs: 3000 });
  expect(th.aiDoneWatchdog).toEqual({ maxIdleMs: 8000 });
  expect(th.answerGrace).toEqual({ defaultMs: 4000, autoNextMs: 800 });
  expect(th.questionProgression).toEqual({
    minAnswerChars: 4,
    maxRetryPerQuestion: 3,
    maxFollowUpsPerQuestion: 2,
    forceClosureStreamTimeoutMs: 15000,
  });
});

test.each(["NaN", "-1", "10001"])("题间短宽限非法值 %s 回退默认 800ms", (value) => {
  process.env.AIM_AUTO_NEXT_GRACE_MS = value;
  expect(loadTurnHandling().answerGrace.autoNextMs).toBe(800);
});

test("design contract:env 覆盖拒垃圾门槛/主动开场", () => {
  process.env.AIM_MIN_INPUT_CHARS = "3";
  process.env.AIM_PROACTIVE_OPENING = "0";
  process.env.AIM_PROACTIVE_OPENING_SILENCE_MS = "5000";
  const th = loadTurnHandling();
  expect(th.meaningfulInput.minChars).toBe(3);
  expect(th.proactiveOpening.enabled).toBe(false); // =0 关
  expect(th.proactiveOpening.silenceMs).toBe(5000);
});

test("env 覆盖各字段", () => {
  process.env.AIM_ENDPOINT_SILENCE_GAP_MS = "1200";
  process.env.AIM_BARGE_CONFIRM_MS = "500";
  process.env.AIM_BARGE_HANGOVER_MS = "0"; // =0 关 hangover(回退单帧掉线即清零)
  process.env.AIM_AI_SPEAKING_MAX_IDLE_MS = "10000";
  const th = loadTurnHandling();
  expect(th.endpointing.silenceGapMs).toBe(1200);
  expect(th.interruption.confirmMs).toBe(500);
  expect(th.interruption.hangoverMs).toBe(0);
  expect(th.aiDoneWatchdog.maxIdleMs).toBe(10000);
});

test("design contract DTD:env 覆盖 + 关开关回退固定阈值", () => {
  process.env.AIM_BARGE_DTD = "0";
  process.env.AIM_BARGE_DTD_FLOOR = "1000";
  process.env.AIM_BARGE_DTD_ECHO_GAIN = "0.5";
  const th = loadTurnHandling();
  expect(th.interruption.dtdEnabled).toBe(false); // =0 关
  expect(th.interruption.dtdFloor).toBe(1000);
  expect(th.interruption.dtdEchoGain).toBe(0.5);
});

test("021-metrics 动态噪声地板:默认开 + env 覆盖窗/K + 关开关回退固定 floor", () => {
  // 默认开
  expect(loadTurnHandling().interruption.dynFloorEnabled).toBe(true);
  // env 覆盖窗/K
  process.env.AIM_BARGE_DYN_FLOOR_WINDOW_MS = "5000";
  process.env.AIM_BARGE_DYN_FLOOR_K = "2.0";
  let th = loadTurnHandling();
  expect(th.interruption.dynFloorWindowMs).toBe(5000);
  expect(th.interruption.dynFloorK).toBe(2.0);
  // =0 关(回退固定 dtdFloor)
  process.env.AIM_BARGE_DYN_FLOOR = "0";
  th = loadTurnHandling();
  expect(th.interruption.dynFloorEnabled).toBe(false);
});

test("单一事实源守门:endpoint < GPU VAD 阈值 → fail-fast(throw)", () => {
  process.env.AIM_ENDPOINT_RMS_THRESHOLD = "350";
  process.env.AIM_VAD_ENERGY_THRESHOLD = "500";
  expect(() => loadTurnHandling()).toThrow(/endpoint ≥ vad/);
});

test("单一事实源守门:endpoint == GPU VAD 阈值 → 通过(边界 ≥)", () => {
  process.env.AIM_ENDPOINT_RMS_THRESHOLD = "500";
  process.env.AIM_VAD_ENERGY_THRESHOLD = "500";
  expect(() => loadTurnHandling()).not.toThrow();
});

test("design contract:开启误打断恢复默认值(takeover 700 ∈ (confirm 200, window 2000))→ 通过", () => {
  process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
  const th = loadTurnHandling();
  expect(th.interruption.recoveryEnabled).toBe(true);
  expect(() => loadTurnHandling()).not.toThrow();
});

test("误打断恢复衰减系数:默认 0.5 + AIM_RECOVERY_TAKEOVER_DECAY 可覆盖", () => {
  expect(loadTurnHandling().interruption.recoveryTakeoverDecay).toBe(0.5);
  process.env.AIM_RECOVERY_TAKEOVER_DECAY = "1.0";
  expect(loadTurnHandling().interruption.recoveryTakeoverDecay).toBe(1);
});

test.each(["-0.1", "0", "2.1"])("误打断恢复衰减系数越界(%s)→ fail-fast", (value) => {
  process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
  process.env.AIM_RECOVERY_TAKEOVER_DECAY = value;
  expect(() => loadTurnHandling()).toThrow(/recoveryTakeoverDecay.*\[0\.1,2\.0\]/);
});

test.each(["0.1", "2.0"])("误打断恢复衰减系数边界(%s)→ 通过", (value) => {
  process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
  process.env.AIM_RECOVERY_TAKEOVER_DECAY = value;
  expect(() => loadTurnHandling()).not.toThrow();
});

test("design contract 不变式:takeover ≤ confirmMs → fail-fast(tentative-pause 形同虚设)", () => {
  process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
  process.env.AIM_BARGE_CONFIRM_MS = "300";
  process.env.AIM_FALSE_INTERRUPTION_TAKEOVER_MS = "300"; // == confirm,违反 takeover > confirm
  expect(() => loadTurnHandling()).toThrow(/takeover.*confirmMs|confirmMs/);
});

test("design contract 不变式:takeover ≥ window → fail-fast(真接管被误当误打断 resume)", () => {
  process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
  process.env.AIM_FALSE_INTERRUPTION_TAKEOVER_MS = "2000";
  process.env.AIM_FALSE_INTERRUPTION_WINDOW_MS = "2000"; // == window,违反 takeover < window
  expect(() => loadTurnHandling()).toThrow(/takeover.*window|window/);
});

test("误打断恢复**显式关闭**时不校验 recovery 不变式(即便 takeover 配得离谱也不 throw)", () => {
  // ★ design contract:recoveryEnabled 默认已改为 **开**,故此处须显式 =0 才进入「关闭」分支。
  //   测试意图不变(关闭时值不生效、不校验),只是前提从「默认关」变成「显式关」。
  process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "0";
  process.env.AIM_FALSE_INTERRUPTION_TAKEOVER_MS = "9999";
  expect(() => loadTurnHandling()).not.toThrow();
});

test("design contract 不变式:maxIdleMs ≤ recoveryWindowMs → fail-fast(看门狗兜底窗须 > 恢复窗)", () => {
  process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
  process.env.AIM_FALSE_INTERRUPTION_WINDOW_MS = "3000"; // 恢复窗 3000
  process.env.AIM_AI_SPEAKING_MAX_IDLE_MS = "2500"; // 看门狗窗 2500 ≤ 3000 → 违反
  expect(() => loadTurnHandling()).toThrow(/maxIdleMs.*recoveryWindowMs|maxIdleMs > recoveryWindowMs/);
});

test("design contract 不变式:maxIdleMs == recoveryWindowMs → fail-fast(边界,须严格 >)", () => {
  process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
  process.env.AIM_FALSE_INTERRUPTION_WINDOW_MS = "2000";
  process.env.AIM_AI_SPEAKING_MAX_IDLE_MS = "2000"; // == → 违反(须严格大于)
  expect(() => loadTurnHandling()).toThrow(/maxIdleMs/);
});

test("design contract 不变式:默认值(maxIdle 8000 > window 2000)+ 开启恢复 → 通过", () => {
  process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
  expect(() => loadTurnHandling()).not.toThrow();
});

test("design contract 不变式:误打断恢复**显式关闭**时不校验 maxIdleMs vs window(配得离谱也不 throw)", () => {
  // ★ design contract:同上 —— 默认已改开,须显式 =0 才跳过该不变式。
  process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "0";
  process.env.AIM_AI_SPEAKING_MAX_IDLE_MS = "500";
  process.env.AIM_FALSE_INTERRUPTION_WINDOW_MS = "2000";
  expect(() => loadTurnHandling()).not.toThrow();
});

test("minWords 占位:误设 >0 → 告警并强制回退 0(未启用前提前不假装生效)", () => {
  process.env.AIM_INTERRUPTION_MIN_WORDS = "3";
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const th = loadTurnHandling();
    expect(th.interruption.minWords).toBe(0); // 强制回退
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("非法 env(NaN)→ 回退默认(不静默变 0)", () => {
  process.env.AIM_ENDPOINT_SILENCE_GAP_MS = "abc";
  const th = loadTurnHandling();
  expect(th.endpointing.silenceGapMs).toBe(TURN_HANDLING_DEFAULTS.endpointing.silenceGapMs); // design contract:1500
});

test.each(["0", "2", "5"])("design contract:追问上限合法整数 %s 生效", (value) => {
  process.env.AIM_QUESTION_MAX_FOLLOW_UPS = value;
  expect(loadTurnHandling().questionProgression.maxFollowUpsPerQuestion).toBe(Number(value));
});

test.each(["-1", "1.5", "NaN", "6"])("design contract:追问上限非法值 %s → 回退默认 2", (value) => {
  process.env.AIM_QUESTION_MAX_FOLLOW_UPS = value;
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(loadTurnHandling().questionProgression.maxFollowUpsPerQuestion).toBe(2);
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test.each(["1000", "15000", "60000"])("design contract:强制收口流完成超时合法值 %sms 生效", (value) => {
  process.env.AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS = value;
  expect(loadTurnHandling().questionProgression.forceClosureStreamTimeoutMs).toBe(Number(value));
});

test.each(["0", "999", "NaN", "60001"])("design contract:强制收口流完成超时非法值 %s → 回退默认 15000", (value) => {
  process.env.AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS = value;
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(loadTurnHandling().questionProgression.forceClosureStreamTimeoutMs).toBe(15000);
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

// ── design contract:playbackClock 参数(超前量上限 + 播完余量)守门 ──
test("design contract:playbackClock 默认值(maxLead 35000 / margin 1000)", () => {
  const th = loadTurnHandling();
  expect(th.playbackClock).toEqual({ maxLeadMs: 35000, leadMarginMs: 1000 });
});

test("design contract:env 覆盖合法值命中(边界 0 / 上限)", () => {
  process.env.AIM_MAX_PLAYBACK_LEAD_MS = "0";
  process.env.AIM_PLAYBACK_LEAD_MARGIN_MS = "5000";
  const th = loadTurnHandling();
  expect(th.playbackClock.maxLeadMs).toBe(0);
  expect(th.playbackClock.leadMarginMs).toBe(5000);
});

test("design contract:非法 maxLead(负/NaN/超范围 120000)→ 钳到默认 35000", () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const bad of ["-1", "abc", "120001"]) {
      process.env.AIM_MAX_PLAYBACK_LEAD_MS = bad;
      expect(loadTurnHandling().playbackClock.maxLeadMs).toBe(35000);
    }
  } finally {
    warn.mockRestore();
  }
});

test("design contract:非法 leadMargin(负/超范围 5000)→ 钳到默认 1000", () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const bad of ["-5", "5001", "NaN"]) {
      process.env.AIM_PLAYBACK_LEAD_MARGIN_MS = bad;
      expect(loadTurnHandling().playbackClock.leadMarginMs).toBe(1000);
    }
  } finally {
    warn.mockRestore();
  }
});

// ── design contract B/R4/R5:默认值即最佳值 + 双窗解耦 + 前置门 ──────────────────────
//
// 这批测试守的不是「功能正常」,而是**「默认值就是生产正确值」这个铁律本身**。
// 先前的部署回归的形状:正确值只活在部署 shell 的 env 里 → 一次 cdk deploy 丢掉 15 个 →
// 十个 spec 的行为静默回退、测试全绿。故这里逐项断言「零 env 时即为最佳值」。
describe("design contract:零 env 部署即最佳值", () => {
  const KEYS = [
    "AIM_FALSE_INTERRUPTION_RECOVERY", "AIM_FALSE_INTERRUPTION_MAX_HOLD_MS",
    "AIM_EOU_CORRECTION_ENABLED", "AIM_EOU_CORRELATION_MS", "AIM_EOU_SUB_THRESHOLD_WINDOW_MS",
    "AIM_EOU_VERDICT_TIMEOUT_MS", "AIM_ENDPOINT_SILENCE_GAP_MS",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("**不设任何 env** 时 B 类各项即为真机最佳值(事故防线)", () => {
    const th = loadTurnHandling();
    expect(th.interruption.recoveryEnabled).toBe(true);   // 原默认关 + CDK 硬编码 '1'
    expect(th.interruption.recoveryMaxHoldMs).toBe(5000); // 原默认 0=关
    expect(th.eouCorrection.enabled).toBe(true);          // 原默认关
    expect(th.endpointing.silenceGapMs).toBe(1500);       // 原默认 900
  });

  it("R4:关联窗与降门槛窗是**两个独立参数**(改超时/关联窗不影响宽容期)", () => {
    const base = loadTurnHandling();
    expect(base.eouCorrection.correlationMs).toBe(7000);        // 判定超时 6000 + 1000 余量
    expect(base.eouCorrection.subThresholdWindowMs).toBe(2500); // 设计决策取代码原意值
    // 关键回归:把关联窗调大,降门槛窗 MUST 不变(旧实现二者共用一个 env → 会一起变)
    process.env.AIM_EOU_CORRELATION_MS = "8000";
    const th = loadTurnHandling();
    expect(th.eouCorrection.correlationMs).toBe(8000);
    expect(th.eouCorrection.subThresholdWindowMs).toBe(2500); // ← 未被牵连
  });

  // ★★ 自查发现的真缺陷回归(fail-fast 引入的爆炸半径):
  //   关联窗默认曾写死 7000。于是「只把判定超时调到**合法上限** 8000」——一个看起来完全合理的
  //   单边调参——会让 7000 < 8000 触发 fail-fast → **整个 rt 进程起不来**(含 /rt/config 诊断端点,
  //   运维连排障手段都失去)。修法:关联窗默认**派生自生效判定超时** + 余量,单边调超时不可能破坏不变式。
  it("单边调判定超时到任意合法值,关联窗自动跟随 → MUST NOT 崩启动", () => {
    for (const t of ["500", "2000", "6000", "8000"]) {
      process.env.AIM_EOU_VERDICT_TIMEOUT_MS = t;
      delete process.env.AIM_EOU_CORRELATION_MS; // 不动关联窗
      expect(() => loadTurnHandling()).not.toThrow();
      const th = loadTurnHandling();
      expect(th.eouCorrection.correlationMs).toBeGreaterThanOrEqual(Number(t));
    }
  });

  // ★ review 收敛:非法组合**不抛**(抛会让整个 rt 进程起不来、连 /rt/config 诊断端点
  //   一起挂,运维失去排障手段 —— 已实证),而是**自愈钳制 + error 级告警**。
  //   这与本文件既有惯例一致(num/numBounded/minWords 皆「告警 + 回退到有效值」),
  //   且与「只 warn 带病运行」有本质区别:行为被修正到正确值,L3 真的生效。
  it("显式设的非法组合 → 自愈钳制 + error 告警(不崩启动、不静默失效)", () => {
    process.env.AIM_EOU_VERDICT_TIMEOUT_MS = "6000";
    process.env.AIM_EOU_CORRELATION_MS = "3000"; // 运维写下的两个互斥数字
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => loadTurnHandling()).not.toThrow(); // MUST NOT 崩启动
      const th = loadTurnHandling();
      // 自愈到合法值 → L3 真生效(而非带着 3000 静默失效)
      expect(th.eouCorrection.correlationMs).toBeGreaterThanOrEqual(6000);
      // MUST 留下无法忽视的信号(error 级,非 warn)
      expect(err.mock.calls.flat().join(" ")).toMatch(/已自愈|关联窗 ≥ 判定超时/);
    } finally {
      err.mockRestore();
    }
  });

  it("R4:关联窗 < 判定超时 → 自愈到合法值(不再带病运行,也不崩启动)", () => {
    process.env.AIM_EOU_CORRELATION_MS = "3000"; // < 默认判定超时 6000
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const th = loadTurnHandling();
      expect(th.eouCorrection.correlationMs).toBeGreaterThanOrEqual(6000);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("R4:守门读的是**权威判定超时**(叶子模块),非另抄的 2000", () => {
    // 把判定超时压到 1000:此时关联窗 1500 应当合法(若守门仍硬编码 2000,会误抛)
    process.env.AIM_EOU_VERDICT_TIMEOUT_MS = "1000";
    process.env.AIM_EOU_CORRELATION_MS = "1500";
    expect(() => loadTurnHandling()).not.toThrow();
  });

  it("R5:显式关 recovery(kill switch)→ 告警 L3 实际不生效,不静默保持", () => {
    process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "0";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const th = loadTurnHandling();
      expect(th.interruption.recoveryEnabled).toBe(false);
      expect(th.eouCorrection.enabled).toBe(true); // L3 自身仍开
      expect(warn.mock.calls.flat().join(" ")).toMatch(/L3 实际不生效|前置门/);
    } finally {
      warn.mockRestore();
    }
  });

  it("kill switch 有效:B 类两个布尔项 =0 时确实关闭", () => {
    process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "0";
    process.env.AIM_EOU_CORRECTION_ENABLED = "0";
    const th = loadTurnHandling();
    expect(th.interruption.recoveryEnabled).toBe(false);
    expect(th.eouCorrection.enabled).toBe(false);
  });

  // ★★ review(实证成立):kill switch MUST 宽松识别关闭意图。
  //   裸 `!== "0"` 只认字面 "0" → 运维写 `=false` 想紧急关闭时**实际反而开着**,
  //   救命开关拧不动 —— 这比它要防的问题更严重。三个 kill switch 统一用 boolKillSwitch。
  it.each(["false", "off", "no", "NO", " False ", "0"])(
    "kill switch 识别关闭意图:%s → 关",
    (val) => {
      process.env.AIM_FALSE_INTERRUPTION_RECOVERY = val;
      process.env.AIM_EOU_CORRECTION_ENABLED = val;
      const th = loadTurnHandling();
      expect(th.interruption.recoveryEnabled).toBe(false);
      expect(th.eouCorrection.enabled).toBe(false);
    },
  );

  // 空串/空白**不**当关闭:多是脚本失误(变量存在未赋值),当成「关掉保护」比「保持默认开」更危险。
  it.each(["", "  ", "1", "true"])("kill switch 非关闭意图:%s → 保持默认开", (val) => {
    process.env.AIM_FALSE_INTERRUPTION_RECOVERY = val;
    process.env.AIM_EOU_CORRECTION_ENABLED = val;
    const th = loadTurnHandling();
    expect(th.interruption.recoveryEnabled).toBe(true);
    expect(th.eouCorrection.enabled).toBe(true);
  });
});
