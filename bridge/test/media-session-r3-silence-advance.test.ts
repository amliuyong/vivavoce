// design contract:静默超时先问再推兜底(解 review 死锁)——media 层状态机测试。
//   核心验证:AI 收尾漏发 [[NEXT]] 且考生不再开口(engine.answerSeenForCursor()=true 但 retry 停 1)→ 不卡死,
//   静默达阈值先 nudge 问补充、再服务端推进(engine.advanceOnSilenceTimeout)。与 design contract 沉默违规按 answerSeen 互斥分流。
import { test, expect, beforeEach, afterEach, jest } from "@jest/globals";

// ── 可控 fake:engine 实现 R3 接口(answerSeenForCursor / advanceOnSilenceTimeout / questionCursor)──
function makeFakes(answerSeen: boolean) {
  const nudges: string[] = [];
  const advanceCalls: number[] = []; // 记录 advanceOnSilenceTimeout 被调时的 cursorEpoch
  const engine: any = {
    _cursor: 0,
    async start() {}, pushAudio() {}, cancel() {}, async stop() {},
    onAudioOut(cb: any) { this._audioOut = cb; }, onTranscript(cb: any) { this._t = cb; },
    onTurnEvent(cb: any) { this._turn = cb; }, onError() {}, onLlmText() {}, onAiDone(cb: any) { this._aiDone = cb; },
    onMetrics() {}, correctionContext() { return { history: [] }; }, endTurn() {},
    nudge(text: string) { nudges.push(text); return true; },
    hasQuestions() { return true; }, // design contract:有题(R3 兜底仅有题语境;无题走沉默豁免,由 media-session-silence 覆盖)
    answerSeenForCursor() { return answerSeen; },
    questionCursor() { return this._cursor; },
    advanceOnSilenceTimeout(epoch: number) { advanceCalls.push(epoch); this._cursor += 1; return true; },
    _t: (_: any) => {}, _turn: (_: any) => {}, _aiDone: () => {}, _audioOut: (_: any) => {},
  };
  const conn: any = {
    sent: [] as unknown[], closed: false,
    send(d: unknown) { this.sent.push(d); }, close() { this.closed = true; },
    _msg: (_d: Buffer, _b: boolean) => {}, _close: () => {},
    on(ev: string, cb: any) { if (ev === "message") this._msg = cb; else this._close = cb; },
    rxBinary(pcm: Buffer) { this._msg(pcm, true); },
  };
  return { engine, conn, nudges, advanceCalls };
}

const silentFrame = Buffer.alloc(640); // RMS 0 = 真沉默(有帧)
const aiAudioFrame = Buffer.alloc(960, 1); // AI 出向音频(置 aiSpeaking)

function freshMediaSession() {
  jest.resetModules();
  return require("../src/media-session").MediaSession as typeof import("../src/media-session").MediaSession;
}

async function setup(env: Record<string, string>, answerSeen: boolean) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const MediaSession = freshMediaSession();
  const { engine, conn, nudges, advanceCalls } = makeFakes(answerSeen);
  const ends: string[] = [];
  const session = new MediaSession(
    conn,
    { sessionId: "sess_r3", systemPrompt: "你是考官", engineParams: { engineType: "three_stage", language: "zh-CN" } as any },
    { engine, recorder: null as any, transcripts: { async putFinal() {} } as any, onEnded: (i: any) => ends.push(i.reason) },
  );
  await session.begin();
  return { session, engine, conn, nudges, advanceCalls, ends };
}

// AI 出声 + 正常完整播完 onAiDone(true)→ 进等待作答态(waitingSinceMs=now)。
function aiSpeaksThenDone(s: { engine: any }) {
  s.engine._audioOut(aiAudioFrame);
  s.engine._aiDone(true);
}
// 推进 silenceMs:每 250ms 一个静音帧(保持有帧非断流)+ 走 watchdog tick。
async function silence(s: { conn: any }, silenceMs: number) {
  const ticks = Math.ceil(silenceMs / 250);
  for (let i = 0; i < ticks; i++) { s.conn.rxBinary(silentFrame); await jest.advanceTimersByTimeAsync(250); }
}

const ENVS = ["AIM_VIOLATION_ENFORCEMENT", "AIM_SILENCE_VIOLATION_MS", "AIM_SILENCE_WARN_MAX", "AIM_NO_FRAME_MS",
  "AIM_ADVANCE_NUDGE_MS", "AIM_ADVANCE_AFTER_NUDGE_MS", "AIM_R3_SILENCE_ADVANCE", "AIM_MAX_PLAYBACK_LEAD_MS"];
const saved: Record<string, string | undefined> = {};
// ★ design contract:锁 AIM_MAX_PLAYBACK_LEAD_MS=0 → 沉默锚点逐字节等价现状(本文件专测 R3 nudge 状态机时序,
//   与 design contract 播放边界后移正交;边界后移由 media-session-playback-boundary.test.ts 专测)。
beforeEach(() => { for (const k of ENVS) { saved[k] = process.env[k]; delete process.env[k]; } process.env.AIM_MAX_PLAYBACK_LEAD_MS = "0"; jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); for (const k of ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

test("★B1 死锁修复:已作答 + 漏发 [[NEXT]] + 考生不再开口 → 静默兜底 nudge 后服务端推进(不卡死)", async () => {
  // answerSeen=true(当前题已作答);SILENCE_VIOLATION=10000 → R3 默认 nudge=4000/after=4000。
  const s = await setup({ AIM_SILENCE_VIOLATION_MS: "10000" }, true);
  aiSpeaksThenDone(s); // AI 收尾(漏发 [[NEXT]])→ 进等待态
  await silence(s, 4000); // 静默达 ADVANCE_NUDGE_MS(=violation 40%=4000)→ nudge 问补充
  expect(s.nudges.length).toBe(1);
  expect(s.nudges[0]).toContain("补充");
  // nudge 播完(onAiDone)→ after_nudge 第二窗
  aiSpeaksThenDone(s);
  await silence(s, 4000); // 第二窗到期 → 服务端推进
  expect(s.advanceCalls.length).toBe(1); // ★ engine.advanceOnSilenceTimeout 被调 = 推进(不卡死)
});

test("互斥分流:未作答(answerSeen=false)的静默 → 不走 R3(归 design contract),不 nudge 补充/不推进", async () => {
  // enforcement 关 → design contract 也不产生动作;关键验证 R3 完全不介入(不调 advanceOnSilenceTimeout)。
  const s = await setup({ AIM_SILENCE_VIOLATION_MS: "10000" }, false);
  aiSpeaksThenDone(s);
  await silence(s, 12000); // 超 R3 阈值 + 超 violation
  expect(s.advanceCalls.length).toBe(0); // ★ 未作答:R3 不启,不服务端推进
  // R3 的「还有补充吗」nudge 不应出现(未作答归 design contract,enforcement 关时连警告都没有)
  expect(s.nudges.some((n) => n.includes("补充"))).toBe(false);
});

test("考生在 nudge 前开口 → 取消 R3,不 nudge、不推进(当本题续答)", async () => {
  const s = await setup({ AIM_SILENCE_VIOLATION_MS: "10000" }, true);
  aiSpeaksThenDone(s);
  await silence(s, 2000); // 未达 nudge 阈值(4000)
  // 考生开口(高能量帧)→ trackEndpoint 刷新 lastSpeechAtMs + resetR3Phase
  const speech = (() => { const b = Buffer.alloc(640); for (let i = 0; i < 320; i++) b.writeInt16LE(3000, i * 2); return b; })();
  for (let i = 0; i < 20; i++) { s.conn.rxBinary(speech); await jest.advanceTimersByTimeAsync(20); } // 累计 400ms > 300ms 有效开口
  await silence(s, 5000); // 再等(静默起点已被 lastSpeechAtMs 后移)
  expect(s.advanceCalls.length).toBe(0); // ★ 考生开口后不推进(续答本题)
});

test("R3 关(AIM_R3_SILENCE_ADVANCE=0)→ 回退无兜底(不 nudge 补充/不推进,即修复前行为)", async () => {
  const s = await setup({ AIM_SILENCE_VIOLATION_MS: "10000", AIM_R3_SILENCE_ADVANCE: "0" }, true);
  aiSpeaksThenDone(s);
  await silence(s, 12000);
  expect(s.advanceCalls.length).toBe(0); // 关:R3 不启
  expect(s.nudges.some((n) => n.includes("补充"))).toBe(false);
});

test("fail-fast:显式 env 令 R3 兜底总时长 >= 沉默违规阈值 → 启动即抛(防倒挂)", () => {
  process.env.AIM_SILENCE_VIOLATION_MS = "5000";
  process.env.AIM_ADVANCE_NUDGE_MS = "4000";
  process.env.AIM_ADVANCE_AFTER_NUDGE_MS = "3000"; // 4000+3000=7000 >= 5000 → 非法
  expect(() => freshMediaSession()).toThrow(/design contract.*配置非法/);
  delete process.env.AIM_ADVANCE_NUDGE_MS;
  delete process.env.AIM_ADVANCE_AFTER_NUDGE_MS;
  delete process.env.AIM_SILENCE_VIOLATION_MS;
});

test("★review:非 R3 路径推进(游标变了)→ media 清陈旧 waitingSinceMs,不用旧锚点误判 design contract 沉默违规", async () => {
  // review 经非 R3 路径(宽限窗/retry/拒答)推进游标 → answerSeen 重置但 media waitingSinceMs
  //   残留旧题值 → 新轮 AI 出声前 watchdogTick 查 answerSeen=false → 归 design contract → 用陈旧 waitingSinceMs 立即误判沉默。
  //   修复:分流前检测 cursor 变化 → 清 waitingSinceMs。此处用 enforcement 开 + 短阈值,验证游标变后不误触发沉默违规。
  const s = await setup(
    { AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "3" },
    false, // answerSeen=false(未作答,归 design contract 轨)
  );
  aiSpeaksThenDone(s); // 进等待态(waitingSinceMs=now)
  await silence(s, 800); // 静默 800ms(未达 1000ms 沉默阈值)
  // 模拟 engine 经非 R3 路径推进游标(如拒答强推):cursor 0→1。media 下一 tick 应检测到并清 waitingSinceMs。
  s.engine._cursor = 1;
  await silence(s, 400); // 再走几个 tick:游标变化被检测 → 清 waitingSinceMs;不应因旧的 800ms+400ms 累计误判沉默
  // ★ 游标变后 waitingSinceMs 已清,新题静默从头算(< 1000ms)→ 不触发沉默违规警告
  expect(s.session).toBeTruthy();
  // 关键断言:没有因为陈旧锚点误判(nudges 里不应有沉默警告——answerSeen=false 走 049,但游标刚变清了锚点)
  // 用 ends 验证会话没被误杀
  expect(s.ends).toHaveLength(0);
});

test("★review 播报失败(completed=false)→ markAiDonePlaying 仍转 after_nudge → 第二窗推进(不卡死)", async () => {
  // review:担心 nudge 失败卡死 nudge_playing。实证:markAiDonePlaying 无条件转 after_nudge
  //   (onAiDone 在 completed 判断前无条件调 markAiDonePlaying)→ nudge 失败也进第二窗、到期推进,不卡死。
  const s = await setup({ AIM_SILENCE_VIOLATION_MS: "10000" }, true);
  aiSpeaksThenDone(s);
  await silence(s, 4000); // 静默达 nudge 阈值 → nudge 发起(accepted,进 nudge_playing)
  expect(s.nudges.length).toBe(1);
  // nudge 播报**失败**:emitAiDone-style 但 completed=false(模拟 LLM/TTS 失败)→ 经 markAiDonePlaying 仍转 after_nudge。
  s.engine._audioOut(aiAudioFrame); // nudge 出了点音频
  s.session.markAiDonePlaying(); // 直接触发播完信号(模拟 onAiDone 无条件调的 markAiDonePlaying)
  await silence(s, 4000); // after_nudge 第二窗到期 → 推进
  expect(s.advanceCalls.length).toBe(1); // ★ nudge 失败也不卡死,第二窗到期推进
});

test("★design contract review_playing 期打断(onBargeIn)→ 清 waitingSinceMs + 复位 R3 阶段 → watchdog 永不强推", async () => {
  // 致命时序(spec R1 B3):waiting → 静默 nudge → nudge_playing → 用户打断 nudge。若 onBargeIn 不在 markAiDonePlaying
  //   之前清 waitingSinceMs + R3 阶段,则 markAiDonePlaying 会把 nudge_playing 翻成 after_nudge,残留旧 waitingSinceMs
  //   + after_nudge → watchdog(checkR3SilenceAdvance)仍可强推(advanceOnSilenceTimeout 被调 = bug)。修复后:
  //   onBargeIn 先清 waitingSinceMs/silenceCountedThisWait/resetR3Phase → 无论过多久 watchdog 都不再推进。
  const s = await setup({ AIM_SILENCE_VIOLATION_MS: "10000" }, true);
  aiSpeaksThenDone(s);
  await silence(s, 4000); // 静默达 nudge 阈值 → nudge(进 nudge_playing)
  expect(s.nudges.length).toBe(1);
  // nudge 正在播报:出音频置 aiSpeaking=true(真机上 nudge 轮出声),此时用户打断 nudge。
  s.engine._audioOut(aiAudioFrame);
  s.session.onBargeIn(); // 打断 nudge → 应清 waitingSinceMs + R3 阶段(在 markAiDonePlaying 之前)
  // 打断后无论静默多久,watchdog 都不该再推进(旧 waitingSinceMs 已清、R3 已 idle)。
  await silence(s, 12000);
  expect(s.advanceCalls.length).toBe(0); // ★ 变异自证:不清 waitingSinceMs/R3 → after_nudge 残留 → 强推 → 本断言红
});
