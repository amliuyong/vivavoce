/**
 * design contract:aiSpeaking 安全看门狗 MUST NOT 在 tentative-pause 期间误触发强制恢复。
 *
 * 恢复配置是**模块级**(turn-handling import 时读 env)→ 本文件在 import media-session 前设 env 开启恢复,
 * 与默认关的 media-session.test.ts / 窗 400ms 的 media-session-recovery.test.ts 隔离(单独文件=单独模块图)。
 *   - AIM_FALSE_INTERRUPTION_RECOVERY=1 开
 *   - AIM_FALSE_INTERRUPTION_WINDOW_MS=2000(恢复窗)
 *   - AIM_FALSE_INTERRUPTION_TAKEOVER_MS=700(> confirmMs 200、< window 2000)
 *   - AIM_AI_SPEAKING_MAX_IDLE_MS=3000(看门狗兜底窗;> recoveryWindowMs 2000,满足 R1 不变式)
 *
 * 缺陷:暂停期引擎缓存音频不下发 → lastAiAudioAtMs 冻结;若看门狗不跳过,idle 超 maxIdleMs 会误
 * markAiDonePlaying(aiSpeaking=false),engine 仍 paused → 入向路由切正常收听、detectBargeIn 停摆。
 * 因 maxIdleMs > recoveryWindowMs(不变式),暂停期内看门狗能超 maxIdleMs 的唯一途径是 idle 早于 pause
 * 起算(AI 自然静默 → 其上叠加 barge-in tentative-pause)——本测试即构造该场景。
 * 观测点:看门狗触发时自身 console.warn("aiSpeaking 卡 true …强制恢复收听")——直接观测该分支是否执行。
 */
process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
process.env.AIM_FALSE_INTERRUPTION_WINDOW_MS = "2000";
process.env.AIM_FALSE_INTERRUPTION_TAKEOVER_MS = "700";
process.env.AIM_AI_SPEAKING_MAX_IDLE_MS = "3000";

import { MediaSession, WsConn } from "../src/media-session";
import {
  AudioOutCb, EngineErrorCb, EngineMetricsCb, LlmTextCb, TranscriptCb, TurnEventCb, VoiceEngine,
} from "../src/voice-engine";

class FakeEngine implements VoiceEngine {
  hasQuestions() { return true; } // design contract:默认有题(现状语境),blockedByOpenChat 恒 false 不影响既有断言
  cancels: string[] = [];
  paused = 0;
  resumed = 0;
  private audioOutCb: AudioOutCb = () => {};
  private turnAudioBeginCb: (aiTurnId: number) => void = () => {};
  private audioStarted = false;
  private turnCb: TurnEventCb = () => {};
  async start() {}
  pushAudio() {}
  cancel(r: string) { this.cancels.push(r); }
  pause() { this.paused += 1; }
  resume() {
    this.resumed += 1;
    // 真引擎 resume 会续发暂停期缓存的 TTS 音频 → media-session 的 audioOutCb 刷新 lastAiAudioAtMs。
    // FakeEngine 模拟这一步:续发一帧,使暂停退出后看门狗的 idle 计时从"now"重新起算(不残留暂停前陈旧时戳)。
    this.audioOutCb(ampFrame(50));
  }
  onAudioOut(cb: AudioOutCb) { this.audioOutCb = cb; }
  onTurnAudioBegin(cb: (aiTurnId: number) => void) { this.turnAudioBeginCb = cb; }
  onTranscript(_cb: TranscriptCb) {}
  onTurnEvent(cb: TurnEventCb) { this.turnCb = cb; }
  onError(_cb: EngineErrorCb) {}
  onLlmText(_cb: LlmTextCb) {}
  onAiDone(_cb: () => void) {}
  onMetrics(_cb: EngineMetricsCb) {}
  async stop() {}
  emitAudio(pcm: Buffer) {
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.turnAudioBeginCb(17);
    }
    this.audioOutCb(pcm);
  }
}

class FakeConn implements WsConn {
  sent: (string | Buffer)[] = [];
  private msgCb: (d: Buffer, b: boolean) => void = () => {};
  send(d: string | Buffer) { this.sent.push(d); }
  close() {}
  on(ev: "message" | "close", cb: never) { if (ev === "message") this.msgCb = cb as never; }
  rxBinary(pcm: Buffer) { this.msgCb(pcm, true); }
}

function ampFrame(amp: number): Buffer {
  const n = 320;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(amp, i * 2);
  return b;
}

/** 看门狗触发时 console.warn 含此片段(直接观测强制恢复分支是否执行)。 */
const WATCHDOG_WARN = "aiSpeaking 卡 true";

const _sessions: MediaSession[] = [];
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const s of _sessions.splice(0)) await s.detach().catch(() => undefined);
  jest.useRealTimers();
  warnSpy.mockRestore();
});
function watchdogFired(): boolean {
  return warnSpy.mock.calls.some((c) => String(c[0] ?? "").includes(WATCHDOG_WARN));
}

async function setup() {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const session = new MediaSession(
    conn,
    { sessionId: "s_wd", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: null, transcripts: null, metrics: null },
  );
  await session.begin();
  _sessions.push(session);
  return { engine, conn, session };
}

test("R1:idle 早于 pause 起算、暂停期内 idle 超 maxIdleMs → 看门狗跳过(不强制恢复)", async () => {
  jest.useFakeTimers();
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50)); // AI 开口(lastAiAudioAtMs=T0=now)
  // 先让 AI 自然静默一段(idle 起算,仍未 pause):推进 2500ms(< maxIdleMs 3000,看门狗不该触发)。
  jest.advanceTimersByTime(2500);
  expect(watchdogFired()).toBe(false); // 未暂停但 idle<3000 → 未触发(前提正确)
  // 此刻叠加疑似打断 → tentative-pause(11 帧 ×20ms=220ms > confirmMs 200、< takeover 700)。
  for (let i = 0; i < 11; i++) conn.rxBinary(ampFrame(3000));
  expect(engine.paused).toBe(1);
  // 暂停期内继续推进到 idle 超 maxIdleMs(now→3300,idle=3300>3000),但仍在恢复窗内(pause 于 2500 起、窗满 4500)。
  jest.advanceTimersByTime(800);
  expect(watchdogFired()).toBe(false); // ★ R1:tentativePausing 期间看门狗跳过,不误强制恢复
  expect(engine.resumed).toBe(0); // 恢复窗(4500)未到
  expect(engine.cancels).not.toContain("barge_in"); // 未被误清后走错路径销毁
});

test("R1 回归:未暂停时 idle 超 maxIdleMs → 看门狗仍正常兜底(强制恢复)", async () => {
  jest.useFakeTimers();
  const { engine } = await setup();
  engine.emitAudio(ampFrame(50)); // AI 开口后 GPU 丢 tts_done、无后续音频,且**不**进入 tentative-pause
  jest.advanceTimersByTime(3300); // idle 超 maxIdleMs 3000
  expect(engine.paused).toBe(0); // 从未暂停
  expect(watchdogFired()).toBe(true); // ★ 既有兜底不因 R1 而失效:真早停仍强制恢复
});

test("R1:暂停超恢复窗 → resume 续播(暂停期看门狗没抢先把它当早停清掉)", async () => {
  jest.useFakeTimers();
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 11; i++) conn.rxBinary(ampFrame(3000)); // tentative-pause(now=T0)
  expect(engine.paused).toBe(1);
  jest.advanceTimersByTime(2500); // 超恢复窗 2000 → recoveryTimer fire → resume;期间 idle 也没让看门狗抢跑
  expect(engine.resumed).toBe(1); // 窗满正常 resume(误打断续播)
  expect(watchdogFired()).toBe(false); // 暂停期看门狗全程跳过
  expect(engine.cancels).not.toContain("barge_in");
});

test("R1:resume 后看门狗立即恢复正常职责(review:非暂停期真早停仍兜底)", async () => {
  jest.useFakeTimers();
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 11; i++) conn.rxBinary(ampFrame(3000)); // tentative-pause
  jest.advanceTimersByTime(2500); // 超恢复窗 → resume(FakeEngine.resume 续发一帧,刷新 lastAiAudioAtMs)
  expect(engine.resumed).toBe(1);
  expect(engine.paused).toBe(1);
  expect(watchdogFired()).toBe(false); // 暂停期没误触发
  // resume 后 tentativePausing=false;此后该轮又真早停(GPU 丢 tts_done、无音频)。
  // 看门狗职责 MUST 立即恢复:idle 从 resume 续发帧起算,超 maxIdleMs(3000)后强制恢复。
  jest.advanceTimersByTime(3300);
  expect(watchdogFired()).toBe(true); // ★ 暂停退出后看门狗立即恢复,无残留陈旧时戳、无额外宽限期
});
