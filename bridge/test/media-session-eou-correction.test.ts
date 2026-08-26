/**
 * design contract:MediaSession 旁路 EOU 事后纠偏集成测试。断言:
 *  ① 双条件触发:判 incomplete + 关联窗内考生**亚阈**重新出声(< 常规门槛但 ≥ 常规×subMult)→ tentative-pause(pause 帧)
 *  ② 仅判 incomplete、考生**未**重新出声 → 不纠偏(不 pause,AI 继续说)
 *  ③ 判 complete / null(判不了)→ 不降门槛,亚阈能量不触发(回归防护)
 *  ④ turn-state 守卫:AI 未在播报(未 emitAudio)→ 判 incomplete 也不开窗(无处暂停)
 *  ⑤ 请求超时/报错 → judgeEou 返回 null → 不纠偏(fail-open)
 *  ⑥ L3 关闭(未在本文件设 env)由 media-session.test.ts 等既有测试覆盖「逐字节等价」
 *
 * L3 配置是**模块级**(turn-handling import 时读 env)→ 本文件在 import media-session 前设 env 开启,
 * 与默认关的测试隔离(单独文件=单独模块图)。judgeEou 经 jest.mock 拦截(不触网、可控返回/挂起)。
 *
 * 门槛模型:AI 几乎静默(ampFrame(50) 参考峰值≈50)→ 基门槛 = max(dtdFloor 700, 0.3×50)=700。
 *   L3 降门槛 ×0.6 → 420。故:
 *   - 亚阈能量 RMS≈500:常规(700)不触发、L3 降门槛(420)触发 → 用来验「判 incomplete 才降门槛」。
 *   - 高能量 RMS≈2000:常规也触发(真打断,L3 无关)。
 */
process.env.AIM_EOU_CORRECTION_ENABLED = "1";
process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1"; // L3 前置:recovery 开,barge 走 tentative-pause(可恢复暂停)
// ★ design contract:关联窗与降门槛窗已解耦为两个 env。本 suite 的用例⑦测的是**关联窗过期**(judge 迟到),
//   故 correlationMs 保持 2500;但新增的启动期 fail-fast 守门要求 `关联窗 ≥ 判定超时`,而判定超时默认已
//   改为 6000(design contract B 类)→ 必须同步把超时设小,否则该组合非法、拒绝启动(守门正确工作的证据)。
process.env.AIM_EOU_CORRELATION_MS = "2500";
process.env.AIM_EOU_VERDICT_TIMEOUT_MS = "2000"; // ≤ 关联窗 2500,满足不变式
process.env.AIM_EOU_SUB_THRESHOLD_WINDOW_MS = "2500"; // 降门槛窗:保持与原行为(旧实现 = 关联窗)等价
process.env.AIM_EOU_SUB_THRESHOLD_MULT = "0.6";
// fixer 模型 + 凭据(L3 复用 fixer 的旁路模型/凭据判定)——engineParams 里配。

import { MediaSession, WsConn } from "../src/media-session";
import {
  AudioOutCb, EngineErrorCb, EngineMetricsCb, LlmTextCb, TranscriptCb, TurnEventCb, VoiceEngine,
} from "../src/voice-engine";

// 拦截真实 EOU 判定:测试注入 mock 返回(complete/incomplete/null)或挂起。
jest.mock("../src/eou-verdict", () => ({
  judgeEou: jest.fn(),
}));
import { judgeEou } from "../src/eou-verdict";
const mockedJudge = judgeEou as jest.MockedFunction<typeof judgeEou>;

class FakeEngine implements VoiceEngine {
  hasQuestions() { return true; } // design contract:默认有题(现状语境),blockedByOpenChat 恒 false 不影响既有断言
  cancels: string[] = [];
  paused = false;
  resumed = false;
  cursor = 0;
  private audioOutCb: AudioOutCb = () => {};
  private turnAudioBeginCb: (aiTurnId: number) => void = () => {};
  private audioStarted = false;
  private transcriptCb: TranscriptCb = () => {};
  private turnCb: TurnEventCb = () => {};
  async start() {}
  pushAudio() {}
  cancel(r: string) { this.cancels.push(r); }
  pause() { this.paused = true; }
  resume() { this.resumed = true; this.paused = false; }
  onAudioOut(cb: AudioOutCb) { this.audioOutCb = cb; }
  onTurnAudioBegin(cb: (aiTurnId: number) => void) { this.turnAudioBeginCb = cb; }
  onTranscript(cb: TranscriptCb) { this.transcriptCb = cb; }
  onTurnEvent(cb: TurnEventCb) { this.turnCb = cb; }
  onError(_cb: EngineErrorCb) {}
  onLlmText(_cb: LlmTextCb) {}
  private aiDoneCb: () => void = () => {};
  onAiDone(cb: () => void) { this.aiDoneCb = cb; }
  onMetrics(_cb: EngineMetricsCb) {}
  correctionContext() { return { history: [], question: "介绍一下你自己" }; }
  questionCursor() { return this.cursor; }
  async stop() {}
  emitAudio(pcm: Buffer) {
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.turnAudioBeginCb(17);
    }
    this.audioOutCb(pcm);
  }
  emitFinal(text: string) { this.transcriptCb({ text, isFinal: true }); }
  emitAiDone() { this.aiDoneCb(); } // AI 轮结束 → media-session markAiDonePlaying(aiSpeaking=false)
}

class FakeConn implements WsConn {
  sent: (string | Buffer)[] = [];
  private msgCb: (d: Buffer, b: boolean) => void = () => {};
  send(d: string | Buffer) { this.sent.push(d); }
  close() {}
  on(ev: "message" | "close", cb: never) { if (ev === "message") this.msgCb = cb as never; }
  rxBinary(pcm: Buffer) { this.msgCb(pcm, true); }
  signals(): Record<string, unknown>[] {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => { try { return JSON.parse(s); } catch { return {}; } });
  }
  hasSignal(type: string): boolean { return this.signals().some((f) => f.type === type); }
}

/** 定幅 16k s16le 帧(20ms=320 sample);amp 决定 RMS。 */
function ampFrame(amp: number): Buffer {
  const b = Buffer.alloc(320 * 2);
  for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

const _sessions: MediaSession[] = [];
afterEach(async () => {
  for (const s of _sessions.splice(0)) await s.detach().catch(() => undefined);
  mockedJudge.mockReset();
});

async function setup() {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const session = new MediaSession(
    conn,
    {
      sessionId: "s_eou",
      systemPrompt: "x",
      // L3 复用 fixer 模型/凭据判定:配 model + mantle token 才会 fire 判定。
      engineParams: {
        engineType: "three_stage", language: "zh-CN",
        llmTranscriptFixerModelId: "anthropic.claude-haiku-4-5", llmBearerToken: "sk-x", llmMantleHost: "https://h",
      },
    },
    { engine, recorder: null, transcripts: null, metrics: null },
  );
  await session.begin();
  _sessions.push(session);
  return { engine, conn, session };
}

// 真机时序:asr_final 时 fire judge(此刻 AI 未开口),judge ~1s 后返回时 AI 已乐观开口。
//   故用可控挂起的 judge:emitFinal 起判定(挂住)→ emitAudio(AI 开口)→ 再 resolve 判定 → 校验「AI 仍在」通过。
function deferredJudge(): { resolve: (v: "complete" | "incomplete" | null) => void } {
  let resolve!: (v: "complete" | "incomplete" | null) => void;
  const promise = new Promise<"complete" | "incomplete" | null>((r) => (resolve = r));
  mockedJudge.mockReturnValue(promise);
  return { resolve };
}

test("① 双条件:判 incomplete + 亚阈重新出声 → tentative-pause(降门槛纠偏生效)", async () => {
  const gate = deferredJudge();
  const { engine, conn } = await setup();
  engine.emitFinal("我觉得它主要是"); // asr_final → fire judge(挂住,模拟旁路慢)
  engine.emitAudio(ampFrame(50)); // AI 乐观开口(aiSpeaking=true),基门槛 700
  gate.resolve("incomplete"); // judge 返回 → 校验(AI 仍在/游标未变/关联窗内)通过 → 开降门槛窗
  await flush();
  // 亚阈能量 RMS≈500:< 常规 700,但 ≥ L3 降门槛 700×0.6=420。持续 ≥ confirmMs(200ms,~15 帧)。
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(650));
  expect(engine.paused).toBe(true); // ★ L3 降门槛 → 亚阈续说触发 tentative-pause(pause 不销毁)
  expect(conn.hasSignal("pause")).toBe(true);
  expect(engine.cancels).not.toContain("barge_in"); // 是可恢复暂停,非销毁性硬切
});

test("② 判 incomplete 但考生未重新出声 → 不纠偏(不 pause,回归防护)", async () => {
  const gate = deferredJudge();
  const { engine } = await setup();
  engine.emitFinal("我觉得它主要是");
  engine.emitAudio(ampFrame(50)); // AI 开口
  gate.resolve("incomplete");
  await flush();
  // 考生不再出声(只有 AI 静默参考帧,无入向高能量)
  for (let i = 0; i < 20; i++) engine.emitAudio(ampFrame(50));
  expect(engine.paused).toBe(false); // 缺「重新出声」条件 → 不纠偏
});

test("③ 判 complete → 不降门槛,亚阈能量不触发(模型判说完了)", async () => {
  const gate = deferredJudge();
  const { engine, conn } = await setup();
  engine.emitFinal("它是一个数据分析工具");
  engine.emitAudio(ampFrame(50));
  gate.resolve("complete");
  await flush();
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(650)); // 亚阈能量
  expect(engine.paused).toBe(false); // complete → 无降门槛窗 → 500 < 700 常规门槛 → 不触发
});

test("③b 判 null(判不了/超时) → 不降门槛,亚阈不触发(fail-open)", async () => {
  const gate = deferredJudge();
  const { engine, conn } = await setup();
  engine.emitFinal("嗯那个");
  engine.emitAudio(ampFrame(50));
  gate.resolve(null);
  await flush();
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(650));
  expect(engine.paused).toBe(false); // null → fail-open 不纠偏
});

test("④ turn-state 守卫:AI 未在播报 → 判 incomplete 也不开窗(无处暂停)", async () => {
  mockedJudge.mockResolvedValue("incomplete");
  const { engine, conn } = await setup();
  engine.emitFinal("我觉得它主要是");
  await flush();
  // ★ 不 emitAudio → AI 未在播报(aiSpeaking=false)。此时判 incomplete 应被 turn-state 守卫丢弃。
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(650));
  expect(engine.paused).toBe(false); // AI 未在播 → 无处暂停,不开窗
});

// 注:游标 stale 是**双重防护**——judge 返回开窗时校验 + detectBargeIn 应用降门槛时再校验(eouIncompleteCursor)。
//   变异验证须两处都去才变红(单去一处另一处兜住);双重防护是有意冗余(实现更稳),非测试假绿。
test("⑥ stale 丢弃:judge 返回时游标已推进 → 不开窗(防判 QK 未完误降 QK+1 门槛)", async () => {
  const gate = deferredJudge();
  const { engine, conn } = await setup();
  engine.cursor = 2; // fire 时游标 = 2
  engine.emitFinal("我觉得它主要是");
  engine.emitAudio(ampFrame(50));
  engine.cursor = 3; // ★ judge 在途期间游标推进到 3(该轮已被下一题取代)
  gate.resolve("incomplete"); // 返回时校验「游标未变」失败 → 丢弃
  await flush();
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(650)); // 亚阈能量
  expect(engine.paused).toBe(false); // 游标已变 → stale 丢弃,不开降门槛窗
});

test("⑦ 关联窗过期:judge 迟到超 correlationMs → 不开窗(判定已过时)", async () => {
  jest.useFakeTimers();
  try {
    const gate = deferredJudge();
    const { engine, conn } = await setup();
    engine.emitFinal("我觉得它主要是");
    engine.emitAudio(ampFrame(50));
    jest.advanceTimersByTime(3000); // ★ 超关联窗 2500ms 后 judge 才返回
    gate.resolve("incomplete");
    await Promise.resolve(); // 结算 microtask
    for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(650));
    expect(engine.paused).toBe(false); // 超关联窗 → 判定过时丢弃,不开窗
  } finally {
    jest.useRealTimers();
  }
});

test("⑤ 高能量真打断在 L3 关联窗内也照常触发(降门槛不影响真打断路径)", async () => {
  const gate = deferredJudge();
  const { engine, conn } = await setup();
  engine.emitFinal("我觉得它主要是");
  engine.emitAudio(ampFrame(50));
  gate.resolve("incomplete");
  await flush();
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(2000)); // 高能量:远超常规门槛
  expect(engine.paused).toBe(true); // 真打断走 tentative-pause(recovery 开)
});

test("⑧ turn-state 守卫:judge 返回时 AI 轮已结束(onAiDone→aiSpeaking=false)→ 不开窗", async () => {
  const gate = deferredJudge();
  const { engine, conn } = await setup();
  engine.emitFinal("我觉得它主要是");
  engine.emitAudio(ampFrame(50)); // AI 开口
  engine.emitAiDone(); // ★ AI 轮结束 → markAiDonePlaying → aiSpeaking=false
  gate.resolve("incomplete"); // 返回时 AI 已不在播 → turn-state 守卫丢弃
  await flush();
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(650));
  expect(engine.paused).toBe(false); // AI 轮已结束 → 无处暂停,不开窗(评审:aiDoneFired 后守卫)
});

test("⑨ 噪声下限防冤杀:降门槛不低于端点人声阈,低于该阈的噪声/回声不触发(review)", async () => {
  const gate = deferredJudge();
  const { engine, conn } = await setup();
  engine.emitFinal("我觉得它主要是");
  engine.emitAudio(ampFrame(50)); // AI 静默参考,基门槛 700 → 降门槛 max(700×0.6=420, 端点阈 500)=500
  gate.resolve("incomplete");
  await flush();
  // RMS≈450:低于降门槛下限 500(端点人声阈)。模拟环境噪声/AI 回声——不该被误判为考生续说。
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(450));
  expect(engine.paused).toBe(false); // ★ 绝对下限挡住:450 < 500 → 不触发(纯乘数会降到 420 而误触发)
});

// 第二重游标校验(review 建议补):判定开窗时游标未变(通过),但开窗后、detectBargeIn 应用前游标才推进。
test("⑥b stale:开窗后游标推进 → detectBargeIn 降门槛失效(第二重游标校验)", async () => {
  const gate = deferredJudge();
  const { engine, conn } = await setup();
  engine.cursor = 2;
  engine.emitFinal("我觉得它主要是");
  engine.emitAudio(ampFrame(50));
  gate.resolve("incomplete"); // 返回时游标=2,校验通过 → 开窗(eouIncompleteCursor=2)
  await flush();
  engine.cursor = 3; // ★ 开窗后、detectBargeIn 应用前游标推进到 3
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(650)); // 亚阈能量
  expect(engine.paused).toBe(false); // detectBargeIn 里第二重游标校验(≠ eouIncompleteCursor)→ 降门槛失效
});
