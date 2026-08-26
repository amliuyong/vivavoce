/**
 * design contract:违规强制结束路径 + 挂断铁律白名单例外。断言:
 *  - 严重违规状态机:severeViolationCount < SEVERE_VIOLATION_MAX → 警告一次(nudge);>= → forcedEndAfterNotice;
 *  - forcedEndAfterNotice:先注入原因句(nudge)→ 等原因句轮 onAiDone(播完)才 end(severe_violation);
 *  - 硬超时兜底:原因句 onAiDone 不来 → 到点强制 end;
 *  - forcedEndAfterNotice 幂等(多违规源不重复触发);
 *  - 违规强制结束**不走两步确认**(直接 end,非等 [[END_CALL]]/已确认的设计决策);
 *  - severe 独立轨:不与消极对抗轨(idle/silence)共享计数;
 *  - 默认关(enforcement 关)→ severe 只 shadow log,不 nudge/不 end。
 *
 * 常量模块加载期读 env,故 jest.resetModules() + 设 env + fresh require;judgeModeration mock 可控返回。
 * severe 来自裁判(judgeModeration)→ emitFinal 触发 asr_final → maybeJudgeModeration → mock verdict。
 */

// ★ 模块标记(勿删):本文件用 `require()` 动态加载被测模块(为了在模块加载期先设 env),
//   故没有顶层 `import` —— 而**没有顶层 import/export 的 .ts 会被 TypeScript 当成「全局脚本」**,
//   顶层声明(`type MS`、`const silentFrame` 等)进全局作用域 → 与其它同形态测试文件**跨文件重名冲突**
//   (CI 实测:TS2300 Duplicate identifier / TS2451 Cannot redeclare,整个 suite 加载失败)。
//   本地逐文件转译时不一定暴露,CI 全项目编译必现。`export {}` 把它标记为模块,声明即文件级私有。
export {};
type MS = import("../src/media-session").MediaSession;

let mockVerdict: unknown = null;
jest.mock("../src/moderation-verdict", () => ({
  judgeModeration: jest.fn(() => Promise.resolve(mockVerdict)),
}));

function freshMediaSession() {
  jest.resetModules();
  return require("../src/media-session").MediaSession as typeof import("../src/media-session").MediaSession;
}

function makeFakes() {
  const nudges: string[] = [];
  const engine: any = {
    started: false,
    async start() { this.started = true; },
    pushAudio() {}, cancel() {}, async stop() {},
    onAudioOut() {}, onTranscript(cb: any) { this._t = cb; }, onTurnEvent(cb: any) { this._turn = cb; },
    onError() {}, onLlmText() {}, onAiDone(cb: any) { this._aiDone = cb; }, onMetrics() {},
    correctionContext() { return { history: [] }; },
    endTurn() {},
    // fake 引擎默认空闲 → nudge 被接受(返回 true);busy 场景由专门测试覆盖(设 _nudgeBusy)。
    nudge(text: string) { if (this._nudgeBusy) return false; nudges.push(text); return true; },
    _nudgeBusy: false,
    questionCursor() { return 0; },
    // 正常告别两步确认路径:wantsEndCall 表 LLM 语义挂断(默认 false;测试可覆盖)。hasPendingQuestions 默认无题。
    wantsEndCall() { return this._wantsEnd ?? false; },
    hasPendingQuestions() { return false; },
    // design contract:本测试验证「严重违规」强制结束(违规保留、不豁免),与「无题=自由聊天」正交。设 true(有题语境),
    // 使 blockedByOpenChat 恒 false,证明违规强制结束路径不被 design contract 闸门干扰(R3 违规保留)。
    hasQuestions() { return true; },
    wantsEarlyExit() { return false; },
    _wantsEnd: false,
    _t: (_: any) => {}, _turn: (_: any) => {}, _aiDone: (_?: boolean) => {},
  };
  const conn: any = {
    sent: [] as unknown[], closed: false,
    send(d: unknown) { this.sent.push(d); }, close() { this.closed = true; },
    _msg: (_d: Buffer, _b: boolean) => {}, _close: () => {},
    on(ev: string, cb: any) { if (ev === "message") this._msg = cb; else this._close = cb; },
  };
  return { engine, conn, nudges };
}

async function setup(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const MediaSession = freshMediaSession();
  const { engine, conn, nudges } = makeFakes();
  const ends: string[] = [];
  const session = new MediaSession(
    conn,
    {
      sessionId: "sess_r3",
      systemPrompt: "你是考官",
      engineParams: { engineType: "three_stage", language: "zh-CN", llmModerationModelId: "eval.model", llmBearerToken: "sk-t" } as any,
    },
    { engine, recorder: null as any, transcripts: { async putFinal() {} } as any, onEnded: (i: any) => ends.push(i.reason) },
  );
  await session.begin();
  return { session, engine, conn, nudges, ends };
}

const R3_ENVS = ["AIM_VIOLATION_ENFORCEMENT", "AIM_SEVERE_VIOLATION_MAX", "AIM_FORCED_END_MAX_WAIT_MS", "AIM_MODERATION_CONFIDENCE_THRESHOLD", "AIM_SEMANTIC_END", "AIM_FAREWELL_HANGUP"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of R3_ENVS) { saved[k] = process.env[k]; delete process.env[k]; } mockVerdict = null; jest.useFakeTimers(); });
afterEach(() => {
  jest.clearAllTimers(); jest.useRealTimers();
  for (const k of R3_ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
});

const flush = () => jest.advanceTimersByTimeAsync(0);
// 一整轮裁判:asr_final(触发 maybeJudgeModeration → mock verdict)→ flush(.then 跑完)→ turn_end(清 moderatedThisTurn)。
async function judgedTurn(s: { engine: any }, text: string) {
  s.engine._t({ text, isFinal: true });
  await flush();
  s.engine._turn("turn_end");
}

test("严重违规第 1 次(<max=2)→ AI 警告一次,不结束", async () => {
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SEVERE_VIOLATION_MAX: "2" });
  await judgedTurn(s, "辱骂考官");
  expect(s.nudges).toHaveLength(1); // 警告一次
  expect(s.nudges[0]).toContain("注意言辞");
  expect(s.ends).toHaveLength(0); // 第 1 次不结束
});

test("严重违规第 2 次(>=max)→ forcedEndAfterNotice:注入原因句 → onAiDone → end(severe_violation)", async () => {
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SEVERE_VIOLATION_MAX: "2" });
  await judgedTurn(s, "辱骂1"); // count=1 警告
  await judgedTurn(s, "辱骂2"); // count=2 → forcedEndAfterNotice(注入原因句)
  expect(s.nudges).toHaveLength(2); // 警告 + 原因句
  expect(s.nudges[1]).toContain("本次测评到此结束");
  expect(s.ends).toHaveLength(0); // 原因句未播完 → 尚未 end
  s.engine._aiDone(true); await flush(); // 原因句下发完(tts_done)→ 排 drain 延迟(design contract:不立即 end 截断客户端播放尾)
  expect(s.ends).toHaveLength(0); // drain 窗内尚未 end
  await jest.advanceTimersByTimeAsync(1500); // 走完 drain(无音频帧 → 回退固定 FAREWELL_HANGUP_DELAY_MS 1500)
  expect(s.ends).toContain("severe_violation");
});

test("forcedEndAfterNotice 硬超时兜底:原因句 onAiDone 不来 → 到点强制 end", async () => {
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SEVERE_VIOLATION_MAX: "1", AIM_FORCED_END_MAX_WAIT_MS: "5000" });
  await judgedTurn(s, "严重辱骂"); // max=1 → 第 1 次即 forcedEndAfterNotice
  expect(s.ends).toHaveLength(0); // 等原因句 onAiDone
  await jest.advanceTimersByTimeAsync(5001); // **不触发 onAiDone** → 硬超时兜底
  expect(s.ends).toContain("severe_violation");
});

test("forcedEndAfterNotice 幂等:再次触发违规不重复 end / 不重排硬超时", async () => {
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SEVERE_VIOLATION_MAX: "1" });
  await judgedTurn(s, "辱骂1"); // 触发 forcedEndAfterNotice
  await judgedTurn(s, "辱骂2"); // 再次 severe(count=2)→ armForcedEndAfterNotice 幂等(已在态)→ 不重复
  s.engine._aiDone(true); await flush();
  await jest.advanceTimersByTimeAsync(1500); // design contract:原因句 drain 后才 end
  expect(s.ends.filter((r) => r === "severe_violation")).toHaveLength(1); // 只 end 一次
});

test("enforcement **显式关**(kill switch):severe 只 shadow 计数,不 nudge / 不 end", async () => {  // ★ design contract B 类:AIM_VIOLATION_ENFORCEMENT 默认已改为**开**(带 kill switch),
  //   故 shadow 契约须显式 =0 才成立。测试意图不变(shadow 只 log 不动作),仅前提由「默认关」→「显式关」。

  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "0" }); // design contract:显式关(默认已改开)
  await judgedTurn(s, "辱骂1");
  await judgedTurn(s, "辱骂2");
  expect(s.nudges).toHaveLength(0);
  expect(s.ends).toHaveLength(0);
});

test("违规强制结束**不走两步确认**:直接 end(不需 wantsEndCall / 已确认的设计决策)", async () => {
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  // wantsEndCall 恒 false(考生从未确认结束)——正常告别路径此时绝不会挂;但违规路径直接结束。
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SEVERE_VIOLATION_MAX: "1" });
  s.engine._wantsEnd = false;
  await judgedTurn(s, "严重辱骂"); // forcedEndAfterNotice
  s.engine._aiDone(true); await flush(); // 原因句下发完 → drain 延迟(design contract)
  await jest.advanceTimersByTimeAsync(1500); // drain 后直接 end(不查 wantsEndCall)
  expect(s.ends).toContain("severe_violation"); // 违规:无需两步确认即结束
});

test("review 被拒(原因句没送达)→ 无关活跃轮 onAiDone **不** end,空闲后重试注入才 end", async () => {
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SEVERE_VIOLATION_MAX: "1", AIM_FORCED_END_MAX_WAIT_MS: "60000" });
  s.engine._nudgeBusy = true; // 引擎 busy:nudge 全被拒(原因句送不出去)
  await judgedTurn(s, "严重辱骂"); // armForcedEndAfterNotice:nudge 被拒 → forcedEndNoticePlaying=false
  expect(s.nudges).toHaveLength(0); // busy:原因句没送达
  // **无关活跃轮**结束(onAiDone)——此刻 forcedEndReason 已设但原因句没播过 → MUST NOT end(否则「没送达就挂」)
  s.engine._aiDone(true); await flush();
  expect(s.ends).toHaveLength(0); // ★ 关键:无关轮 onAiDone 不触发违规结束
  // 引擎此刻空闲了 → 上面的 onAiDone 已重试注入原因句(_nudgeBusy 仍 true 则仍失败)。放开 busy 再来一轮无关 onAiDone:
  s.engine._nudgeBusy = false;
  s.engine._aiDone(true); await flush(); // 重试注入成功 → forcedEndNoticePlaying=true(原因句轮已起),但本次是无关轮 → 不 end
  expect(s.nudges).toHaveLength(1); // 原因句这次送达了
  expect(s.ends).toHaveLength(0); // 原因句轮刚起、还没播完 → 仍不 end
  // 原因句轮播完 onAiDone → drain 延迟后 end
  s.engine._aiDone(true); await flush();
  await jest.advanceTimersByTimeAsync(1500); // design contract:原因句 drain 后才 end
  expect(s.ends).toContain("severe_violation"); // 原因句送达并播完后才结束(不「没听到说明就挂」)
});

test("review:原因句被打断(onAiDone completed=false)→ 不 end,清 playing 等重试/硬超时兜底", async () => {
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SEVERE_VIOLATION_MAX: "1", AIM_FORCED_END_MAX_WAIT_MS: "5000" });
  await judgedTurn(s, "严重辱骂"); // forcedEndAfterNotice:nudge 接受(空闲)→ forcedEndNoticePlaying=true
  expect(s.nudges).toHaveLength(1); // 原因句已注入
  // 原因句轮**被打断**(barge-in / TTS 失败)→ onAiDone(completed=false):没完整播完 → **不 end**(spec 要求播完再挂)
  s.engine._aiDone(false); await flush();
  expect(s.ends).toHaveLength(0); // ★ 打断没播完 → 不挂断(修 review)
  // 引擎空闲 → 下一个无关 onAiDone 重试注入原因句
  s.engine._aiDone(true); await flush();
  expect(s.nudges).toHaveLength(2); // 重试注入了原因句
  expect(s.ends).toHaveLength(0); // 重试的原因句轮刚起,还没播完
  // 重试的原因句完整播完 → drain 延迟后 end
  s.engine._aiDone(true); await flush();
  await jest.advanceTimersByTimeAsync(1500); // design contract:原因句 drain 后才 end
  expect(s.ends).toContain("severe_violation");
});

test("review:原因句反复被打断 → 硬超时兜底 end(不永久缠斗)", async () => {
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SEVERE_VIOLATION_MAX: "1", AIM_FORCED_END_MAX_WAIT_MS: "5000" });
  await judgedTurn(s, "严重辱骂"); // 原因句注入(playing=true)
  s.engine._aiDone(false); // 打断,不 end,清 playing(timer 保留)
  await flush();
  expect(s.ends).toHaveLength(0);
  await jest.advanceTimersByTimeAsync(5001); // 硬超时兜底(反复打断也不永久卡)
  expect(s.ends).toContain("severe_violation");
});

test("review:首次 severe 警告 busy 被拒 → 计数不推进,下次 severe 重试警告(不「没警告就结束」)", async () => {
  mockVerdict = { klass: "severe_directed_abuse", confidence: 0.95, answerComplete: false };
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SEVERE_VIOLATION_MAX: "2" });
  s.engine._nudgeBusy = true; // 引擎 busy:警告 nudge 被拒
  await judgedTurn(s, "辱骂1"); // 首次 severe:警告 busy 被拒 → 计数 MUST NOT ++(否则「没警告就把计数推向终局」)
  expect(s.nudges).toHaveLength(0); // 警告没送达
  expect(s.ends).toHaveLength(0);
  // 引擎空闲后再 severe:因上次计数没推进,这次仍是「警告」(不是终局)→ 送达警告(count 此刻才 →1)
  s.engine._nudgeBusy = false;
  await judgedTurn(s, "辱骂2"); // count →1(<2)→ 警告送达
  expect(s.nudges).toHaveLength(1); // 考生第一次真听到警告
  expect(s.ends).toHaveLength(0); // 仍是警告,不结束
  // ★ 关键(证明 busy 那次没推进计数):再 severe 才到终局。若 busy 那次误 ++(变异),这里会是「第 3 次」早已结束。
  await judgedTurn(s, "辱骂3"); // count 1+1>=2 → 终局 forcedEndAfterNotice(注入原因句,nudges→2)
  expect(s.nudges).toHaveLength(2); // 原因句注入(第 2 条 nudge)
  s.engine._aiDone(true); await flush(); // 原因句下发完 → drain 延迟(design contract)
  await jest.advanceTimersByTimeAsync(1500); // drain 后 end
  expect(s.ends).toContain("severe_violation"); // 到「送达 1 次警告 + 再犯」才结束(严格「警告后再犯」契约)
});

test("正常告别仍走两步确认(不回归铁律):无违规、wantsEndCall=false 时 onAiDone 不挂", async () => {
  // 无违规;AI 正常说完一轮,wantsEndCall=false(未两步确认)→ MUST NOT 挂断(铁律:AI 说挂断须已确认的设计决策)。
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1" });
  s.engine._wantsEnd = false;
  s.engine._audioOut?.(Buffer.alloc(4)); // 可能未接线,忽略
  s.engine._aiDone(true); await flush(); // 正常 onAiDone,无 forcedEndReason、wantsEndCall=false
  expect(s.ends).toHaveLength(0); // 不挂(两步确认保护未被违规例外泄漏破坏)
});
