/**
 * design contract:离题三分接裁判分类(idle_chatter 跨轮计数)。断言:
 *  - 单轮 unrelated_chatter 不计违规(未达 IDLE_CHATTER_MIN_TURNS);
 *  - 连续 ≥N 轮 unrelated_chatter 才计一次消极对抗(与沉默合并阶梯,enforcement 开 → nudge 警告);
 *  - 中途 on_topic_attempt / explicit_decline 断链(清 streak,重新计);
 *  - 低置信 / uncertain / null(判不了)断连续链(严格「连续高置信 unrelated」,宁漏勿误);
 *  - **idle 裁判串行**(idleChatterInFlight):前轮裁判在飞行时后轮跳过 + 作废在途裁判(gen)→ 保 verdict 按轮序,
 *    不让「导致背压的在途裁判晚返回重建 streak,跨越被跳过的轮」凑假连续(review);
 *  - severe_directed_abuse:enforcement 关 shadow 不动作;独立轨不动 idleChatterStreak(R3 严重违规轨已接入,完整状态机测试在 R3 文件)。
 *  注:R4(4.2)辅助推进票已砍(见 design contract「4.2 决策」),无对应测试。
 *
 * 常量(VIOLATION_ENFORCEMENT / IDLE_CHATTER_MIN_TURNS / MODERATION_CONFIDENCE_THRESHOLD)模块加载期读 env,
 * 故用 jest.resetModules() + 设 env + fresh require;judgeModeration 经 jest.mock 拦截(可控返回/挂起)。
 */

// ★ 模块标记(勿删):本文件用 `require()` 动态加载被测模块(为了在模块加载期先设 env),
//   故没有顶层 `import` —— 而**没有顶层 import/export 的 .ts 会被 TypeScript 当成「全局脚本」**,
//   顶层声明(`type MS`、`const silentFrame` 等)进全局作用域 → 与其它同形态测试文件**跨文件重名冲突**
//   (CI 实测:TS2300 Duplicate identifier / TS2451 Cannot redeclare,整个 suite 加载失败)。
//   本地逐文件转译时不一定暴露,CI 全项目编译必现。`export {}` 把它标记为模块,声明即文件级私有。
export {};
type MS = import("../src/media-session").MediaSession;

// judgeModeration mock。默认(mockDeferred=false)每次同步 resolve mockVerdict;
//   mockDeferred=true 时每次调用返回一个**挂起** promise + push 其 resolver 到 deferredResolvers,
//   由测试手动按序/乱序 resolve(测异步时序:顺序提交、迟到票 epoch 门)。每个 fresh require 命中此 mock(顶层 hoist)。
let mockVerdict: unknown = null;
let mockDeferred = false;
const deferredResolvers: ((v: unknown) => void)[] = [];
jest.mock("../src/moderation-verdict", () => ({
  judgeModeration: jest.fn(() => {
    if (mockDeferred) return new Promise((res) => deferredResolvers.push(res));
    return Promise.resolve(mockVerdict);
  }),
}));

function freshMediaSession() {
  jest.resetModules();
  return require("../src/media-session").MediaSession as typeof import("../src/media-session").MediaSession;
}

function makeFakes() {
  const nudges: string[] = [];
  const ends: string[] = [];
  const engine: any = {
    started: false,
    async start() { this.started = true; },
    pushAudio() {}, cancel() {}, async stop() {},
    onAudioOut() {}, onTranscript(cb: any) { this._t = cb; }, onTurnEvent(cb: any) { this._turn = cb; },
    onError() {}, onLlmText() {}, onAiDone(cb: any) { this._aiDone = cb; }, onMetrics() {},
    correctionContext() { return { history: [] }; },
    endTurn() {},
    nudge(text: string) { nudges.push(text); return true; }, // 空闲 fake:nudge 被接受(design contract)
    questionCursor() { return 0; },
    _hasQuestions: true, // design contract:默认有题语境(既有 R4 断言不变);无题豁免测试显式置 false
    hasQuestions() { return this._hasQuestions; },
    _t: (_: any) => {}, _turn: (_: any) => {}, _aiDone: (_?: boolean) => {},
  };
  const conn: any = {
    sent: [] as unknown[], closed: false,
    send(d: unknown) { this.sent.push(d); }, close() { this.closed = true; },
    _msg: (_d: Buffer, _b: boolean) => {}, _close: () => {},
    on(ev: string, cb: any) { if (ev === "message") this._msg = cb; else this._close = cb; },
  };
  return { engine, conn, nudges, ends };
}

async function setup(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const MediaSession = freshMediaSession();
  const { engine, conn, nudges } = makeFakes();
  const ends: string[] = [];
  const session = new MediaSession(
    conn,
    {
      sessionId: "sess_r4",
      systemPrompt: "你是考官",
      // 配 llmModerationModelId + 凭据 → maybeJudgeModeration 会跑(调 mock judgeModeration)
      engineParams: { engineType: "three_stage", language: "zh-CN", llmModerationModelId: "eval.model", llmBearerToken: "sk-t" } as any,
    },
    { engine, recorder: null as any, transcripts: { async putFinal() {} } as any, onEnded: (i: any) => ends.push(i.reason) },
  );
  await session.begin();
  return { session, engine, conn, nudges, ends };
}

const R4_ENVS = ["AIM_VIOLATION_ENFORCEMENT", "AIM_IDLE_CHATTER_MIN_TURNS", "AIM_MODERATION_CONFIDENCE_THRESHOLD", "AIM_SILENCE_WARN_MAX", "AIM_SEVERE_VIOLATION_MAX", "AIM_FORCED_END_MAX_WAIT_MS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of R4_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
  mockVerdict = null; mockDeferred = false; deferredResolvers.length = 0;
});
afterEach(() => { for (const k of R4_ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

const flush = () => new Promise((r) => setImmediate(r));

// 驱动一整轮:user final(触发裁判)→ turn_end(清 moderatedThisTurn,下轮可再判)。裁判 mock 同步 resolve。
async function judgedTurn(s: { engine: any }, text: string) {
  s.engine._t({ text, isFinal: true }); // asr_final → maybeJudgeModeration → mock judgeModeration
  await flush(); // 让裁判 .then 跑完(applyModerationVerdict)
  s.engine._turn("turn_end"); // 清 moderatedThisTurn(新逻辑轮)
}

test("单轮 unrelated_chatter 不计违规(未达 min_turns=2)", async () => {
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2" });
  await judgedTurn(s, "今天天气真好");
  expect(s.nudges).toHaveLength(0); // 单轮不罚
  expect(s.ends).toHaveLength(0);
});

test("连续 2 轮 unrelated_chatter → 计一次消极对抗(enforcement 开 → nudge 警告)", async () => {
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2", AIM_SILENCE_WARN_MAX: "3" });
  await judgedTurn(s, "今天天气真好"); // streak=1
  await judgedTurn(s, "你们公司几个人啊"); // streak=2 → 计一次 → nudge
  expect(s.nudges).toHaveLength(1); // 达 min_turns → 一次警告
});

test("中途 on_topic_attempt 断链(清 streak,不累计到违规)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2" });
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话1"); // streak=1
  mockVerdict = { klass: "on_topic_attempt", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "Lambda 冷启动是因为容器初始化"); // 在答 → 清 streak→0
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话2"); // streak=1(重新计,非 2)
  expect(s.nudges).toHaveLength(0); // 断链后未再连续达 2 轮 → 不计违规
});

test("低置信 unrelated_chatter 不累计(宁漏勿误)", async () => {
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.5, answerComplete: false }; // < 0.8 阈值
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2" });
  await judgedTurn(s, "模糊的话1");
  await judgedTurn(s, "模糊的话2");
  await judgedTurn(s, "模糊的话3");
  expect(s.nudges).toHaveLength(0); // 低置信不累计,永不达阈值
});

test("severe_directed_abuse shadow(enforcement **显式关**)仅 log 不动作(R3 严重违规轨的 enforcement 门控)", async () => {  // ★ design contract B 类:AIM_VIOLATION_ENFORCEMENT 默认已改为**开**(带 kill switch),
  //   故 shadow 契约须显式 =0 才成立。测试意图不变(shadow 只 log 不动作),仅前提由「默认关」→「显式关」。

  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "0" }); // design contract:显式关(默认已改开)
  await judgedTurn(s, "严重不当内容");
  expect(s.nudges).toHaveLength(0); // enforcement 关 → shadow 只计数不 nudge
  expect(s.ends).toHaveLength(0); // 不挂断
});

test("severe_directed_abuse 不动 idleChatterStreak(独立轨,不影响消极对抗连续计数)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2", AIM_SEVERE_VIOLATION_MAX: "9" });
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话1"); // idleChatterStreak=1
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  await judgedTurn(s, "辱骂"); // severe 独立轨,不动 idleChatterStreak
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话2"); // idleChatterStreak=2 → 触发 idle(证明 severe 没清 streak)
  // idle 达阈值触发 forcedEndAfterNotice 的原因句 nudge;severe 第 1 次(<9)也 nudge 警告 → 共 3 条 nudge
  expect(s.nudges.length).toBeGreaterThanOrEqual(2); // 至少 severe 警告 + idle 原因句(证明两轨都动、互不干扰)
});

test("enforcement **显式关**(shadow):连续 unrelated 达阈值 → 维护 streak 但不 nudge/不 end", async () => {  // ★ design contract B 类:AIM_VIOLATION_ENFORCEMENT 默认已改为**开**(带 kill switch),
  //   故 shadow 契约须显式 =0 才成立。测试意图不变(shadow 只 log 不动作),仅前提由「默认关」→「显式关」。

  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  const s = await setup({ AIM_IDLE_CHATTER_MIN_TURNS: "2", AIM_VIOLATION_ENFORCEMENT: "0" }); // design contract:显式关
  await judgedTurn(s, "闲话1");
  await judgedTurn(s, "闲话2"); // 达阈值 → handleNegativeViolation("idle") 但 enforcement 关 → 只 log
  expect(s.nudges).toHaveLength(0);
  expect(s.ends).toHaveLength(0);
});


// ── review:低置信/uncertain/null 断连续链(严格「连续高置信 unrelated」)──

test("review:高 unrelated → 低置信穿插 → 高 unrelated 不凑成连续(低置信断链)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2" });
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话1"); // streak=1
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.5, answerComplete: false }; // 低置信(判不准)→ 断链清 0
  await judgedTurn(s, "模糊的话");
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话2"); // streak=1(重新计,非 2)→ 未达阈值
  expect(s.nudges).toHaveLength(0); // 低置信穿插断了连续 → 不误计违规(宁漏勿误)
});

test("review:高置信 uncertain 断连续链(不凑连续)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2" });
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话1"); // streak=1
  mockVerdict = { klass: "uncertain", confidence: 0.9, answerComplete: false }; // **高置信** uncertain(拿不准)→ 断链
  await judgedTurn(s, "含糊其辞");
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话2"); // streak=1(重新计,非 2)→ 未达阈值
  expect(s.nudges).toHaveLength(0); // 高置信 uncertain 断链 → 不误凑连续 2 轮(review)
});

test("review:判不了(null)断连续链", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2" });
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话1"); // streak=1
  mockVerdict = null; // 裁判判不了 → 断链清 0
  await judgedTurn(s, "某句");
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话2"); // streak=1 → 未达阈值
  expect(s.nudges).toHaveLength(0); // null 断链 → 不凑连续
});

// ── review 裁判**串行**(idleChatterInFlight)+ 作废在途裁判(gen),保 verdict 按轮序 ──

test("review 裁判串行 —— 前轮裁判在飞行时后轮 asr_final 被跳过(背压)", async () => {
  mockDeferred = true; // 挂起,手动 resolve
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2" });
  // turn1 发起裁判(挂起,idleChatterInFlight=true)
  s.engine._t({ text: "闲话A", isFinal: true }); await flush(); s.engine._turn("turn_end");
  // turn2 asr_final:idle 裁判串行忙 → **不发起**(背压跳过)→ deferredResolvers 仍只 1 个
  s.engine._t({ text: "闲话B", isFinal: true }); await flush();
  expect(deferredResolvers).toHaveLength(1); // 串行:后轮未发起第 2 个裁判
});

test("review:被跳过轮作废在途裁判 —— 前轮 unrelated 晚返回被丢弃,不跨越跳过轮凑连续", async () => {
  // 反例(review):turn1 起裁判(unrelated)在飞行 → turn2 asr_final 因串行忙被跳过(清 streak + gen++ 作废 turn1)
  //   → turn1 晚返回 unrelated 因 gen 变了被丢弃(不重建 streak)→ turn3 unrelated 只到 streak=1 → 不误凑连续。
  mockDeferred = true;
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2" });
  s.engine._t({ text: "闲话1", isFinal: true }); await flush(); s.engine._turn("turn_end"); // turn1 裁判在飞行(gen=0)
  s.engine._t({ text: "闲话2", isFinal: true }); await flush(); s.engine._turn("turn_end"); // turn2 串行忙 → 跳过 + gen→1 作废 turn1
  deferredResolvers[0]({ klass: "unrelated_chatter", confidence: 0.9, answerComplete: false }); // turn1 晚返回 → gen 0≠1 → 丢弃(不 streak++)
  await flush();
  // turn3 起裁判(此刻串行门已释放)→ unrelated
  mockDeferred = false; mockVerdict = { klass: "unrelated_chatter", confidence: 0.9, answerComplete: false };
  await judgedTurn(s, "闲话3"); // streak=1(turn1 被丢弃、turn2 被跳过 → 无连续)
  expect(s.nudges).toHaveLength(0); // 不误凑连续(turn1 和 turn3 中间夹着被跳过的 turn2)
});

test("review:串行释放后下一轮可正常发起(不永久卡死)", async () => {
  mockDeferred = true;
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2" });
  s.engine._t({ text: "闲话1", isFinal: true }); await flush(); s.engine._turn("turn_end");
  deferredResolvers[0]({ klass: "unrelated_chatter", confidence: 0.9, answerComplete: false }); // turn1 返回 → 释放串行门
  await flush();
  // turn2 起裁判(门已释放)→ 应能发起第 2 个
  s.engine._t({ text: "闲话2", isFinal: true }); await flush();
  expect(deferredResolvers).toHaveLength(2); // 门释放后下一轮正常发起
  deferredResolvers[1]({ klass: "unrelated_chatter", confidence: 0.9, answerComplete: false }); // turn2 → streak=2 → 触发
  await flush();
  expect(s.nudges).toHaveLength(1); // turn1+turn2 真连续(串行、按序)→ 计一次
});

// ── 修复:自由聊天(无题)完全不判违规(离题裁判无题豁免,与 checkSilenceViolation 对称)──
//   根因(部署验证 sess_example / sess_example):无题自由聊天里用户正常闲聊被裁判判 unrelated_chatter
//   → idleChatterStreak 累计 → handleNegativeViolation("idle") → silence_violation 强制结束。违背「AI 永不主动挂」。
//   决策(设计决策):无题自由聊天**连 severe 也不判**——maybeJudgeModeration 在 !hasQuestions() 早退。

test("修复:自由聊天(无题)连续多轮 unrelated_chatter 不计违规、不 nudge、不 end(离题裁判无题豁免)", async () => {
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2", AIM_SILENCE_WARN_MAX: "3" });
  s.engine._hasQuestions = false; // 自由聊天(无题)
  await judgedTurn(s, "今天天气真好");
  await judgedTurn(s, "你们公司几个人啊");
  await judgedTurn(s, "我随便聊聊");
  await judgedTurn(s, "这系统挺好玩的");
  await judgedTurn(s, "再说点别的");
  expect(s.nudges).toHaveLength(0); // ★ 无题:离题裁判豁免,永不累计消极对抗
  expect(s.ends).toHaveLength(0);   // ★ 无题:守住「AI 永不主动挂」
});

test("修复:自由聊天(无题)severe_directed_abuse 也不判(设计决策:无题完全不跑违规裁判)", async () => {
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.98, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SEVERE_VIOLATION_MAX: "2" });
  s.engine._hasQuestions = false; // 自由聊天(无题)
  await judgedTurn(s, "严重不当内容1");
  await judgedTurn(s, "严重不当内容2");
  await judgedTurn(s, "严重不当内容3");
  expect(s.nudges).toHaveLength(0); // ★ 无题:severe 轨也不动作(不裁判)
  expect(s.ends).toHaveLength(0);
});

test("修复(有题对照):有题场景违规裁判现状不变——连续 unrelated 仍计违规、仍 nudge", async () => {
  mockVerdict = { klass: "unrelated_chatter", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_IDLE_CHATTER_MIN_TURNS: "2", AIM_SILENCE_WARN_MAX: "3" });
  s.engine._hasQuestions = true; // 有题(测评)——现状不变
  await judgedTurn(s, "闲话1");
  await judgedTurn(s, "闲话2"); // 达阈值 → 计一次 → nudge
  expect(s.nudges.length).toBeGreaterThanOrEqual(1); // 有题:违规裁判不豁免
});

// 注:design contract(4.2)辅助推进票已砍(见 design contract「4.2 决策」)——不再有 noteAnswerComplete 注入,故无对应测试。
