/**
 * design contract:误打断恢复窗**能量域顺延**——tentative-pause 期每帧高能量重置恢复窗计时(resume 推迟到
 * "最后一次高能量后 recoveryWindowMs 静默"),但从暂停起点算超 recoveryMaxHoldMs 即不再顺延(有界)。
 *
 * 恢复配置模块级 → 本文件 import media-session 前设 env(单独文件=单独模块图):
 *   - AIM_FALSE_INTERRUPTION_RECOVERY=1 开
 *   - AIM_FALSE_INTERRUPTION_WINDOW_MS=400(恢复窗,fake timer 推进快)
 *   - AIM_FALSE_INTERRUPTION_TAKEOVER_MS=390(> confirmMs 200、< window 400)
 *   - AIM_FALSE_INTERRUPTION_MAX_HOLD_MS=2000(顺延硬上限,> window)
 */
process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
process.env.AIM_FALSE_INTERRUPTION_WINDOW_MS = "400";
process.env.AIM_FALSE_INTERRUPTION_TAKEOVER_MS = "390";
process.env.AIM_FALSE_INTERRUPTION_MAX_HOLD_MS = "2000";
process.env.AIM_RECOVERY_TAKEOVER_DECAY = "0.5";

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
  resume() { this.resumed += 1; }
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
  const b = Buffer.alloc(320 * 2);
  for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
}
function silent(): Buffer { return ampFrame(0); }

const _sessions: MediaSession[] = [];
afterEach(async () => {
  for (const s of _sessions.splice(0)) await s.detach().catch(() => undefined);
  jest.useRealTimers();
});

async function setup() {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const session = new MediaSession(
    conn,
    { sessionId: "s_hold", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: null, transcripts: null, metrics: null },
  );
  await session.begin();
  _sessions.push(session);
  return { engine, conn, session };
}

/** 进入 tentative-pause:AI 开口 + 10 帧高能量(200ms = confirm、< takeover 390)。 */
function enterPause(engine: FakeEngine, conn: FakeConn) {
  engine.emitAudio(ampFrame(50)); // AI 开口
  for (let i = 0; i < 10; i++) conn.rxBinary(ampFrame(3000)); // 触发 pause(不到 takeover)
}
/** 一次"断续 tap":1 帧高能量(+20ms,重置恢复窗)+ 5 帧静音(默认 K=0.5 衰减 50ms)。
 * 证据降到 0,模拟不会跨长间隔攒成 takeover 的稀疏背景尖峰。 */
function intermittentTap(conn: FakeConn) {
  conn.rxBinary(ampFrame(3000));
  for (let i = 0; i < 5; i++) conn.rxBinary(silent());
}

/** 一段带自然跌落的语音:120ms 高能量 + 80ms 低能量(默认 K=0.5),净增 80ms。 */
function speechLikePhrase(conn: FakeConn) {
  for (let i = 0; i < 6; i++) conn.rxBinary(ampFrame(3000));
  for (let i = 0; i < 4; i++) conn.rxBinary(silent());
}

test("R3:断续插话顺延恢复窗——超原 window(400ms)仍不 resume(每 tap 重置计时)", async () => {
  jest.useFakeTimers();
  const { engine, conn } = await setup();
  enterPause(engine, conn);
  expect(engine.paused).toBe(1);
  // 断续 tap:每轮"tap(高能量重置窗)+ 推进 200ms(< window 400,不到期)",3 轮 → 总 ~600ms > 原 400ms。
  for (let round = 0; round < 3; round++) {
    intermittentTap(conn); // 高能量帧重置恢复窗;静音缓降 takeover 证据
    jest.advanceTimersByTime(200); // < window 400,单轮不到期
  }
  expect(engine.resumed).toBe(0); // ★ 顺延生效:超原固定 400ms wall-clock 仍 hold
  expect(engine.cancels).not.toContain("barge_in"); // 断续累计仍未达 takeover → 未销毁
  // 之后真安静:最后一次高能量后静默超 window 400ms → resume
  jest.advanceTimersByTime(450);
  expect(engine.resumed).toBe(1);
});

test("R3:带短停顿的真人语音按泄漏累计达 takeover → 确认真接管", async () => {
  jest.useFakeTimers();
  const { engine, conn } = await setup();
  enterPause(engine, conn);
  // 初判已有 200ms;每段语音净增 80ms,短停顿不清零,3 段后达到 takeover 390ms。
  for (let i = 0; i < 3; i++) speechLikePhrase(conn);
  expect(engine.cancels).toContain("barge_in");
  expect(engine.resumed).toBe(0);
});

test("R3:硬上限是真硬——边界前一帧高能量的顺延 clamp 到 maxHold,resume 不晚于 start+maxHold(Major#3)", async () => {
  jest.useFakeTimers();
  const { engine, conn } = await setup();
  enterPause(engine, conn); // tentativePauseStartMs=0(fake timer:Date.now 也被 mock),恢复窗@400
  // 每 200ms(< window 400,单轮不到期)做一次净衰减 tap,推进到 t=1800(< maxHold 2000):
  // takeover 证据始终低于 390;最后一次 tap 在 elapsed=1800,
  // 顺延 delay=min(window 400, maxHold-elapsed 200)=200 → resume@2000(=硬上限)。
  // ★ 修复前(未 clamp):最后一次 tap 顺延固定 window 400 → resume@2200,超硬上限 200ms(Major#3)。
  for (let t = 200; t <= 1800; t += 200) {
    jest.advanceTimersByTime(200);
    intermittentTap(conn);
  }
  jest.advanceTimersByTime(150); // t=1950 < 2000:两种实现都未 resume
  expect(engine.resumed).toBe(0);
  jest.advanceTimersByTime(100); // t=2050:clamp 后 resume@2000 已触发;未 clamp(@2200)则仍未触发
  expect(engine.resumed).toBe(1); // ★ 硬上限真硬:resume 不晚于 start+maxHold
  expect(engine.cancels).not.toContain("barge_in");
});

test("R3:安静(无断续能量)时行为与现状一致——window 后 resume(回归防护)", async () => {
  jest.useFakeTimers();
  const { engine, conn } = await setup();
  enterPause(engine, conn);
  for (let i = 0; i < 20; i++) conn.rxBinary(silent()); // 真安静,无高能量帧(不触发顺延)
  jest.advanceTimersByTime(450); // 超 window 400
  expect(engine.resumed).toBe(1); // 与现状一致:window 后 resume
  expect(engine.cancels).not.toContain("barge_in");
});
