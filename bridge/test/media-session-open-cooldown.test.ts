/**
 * design contract:AI 开口冷却窗——开口首 openCooldownMs 内 bargeThreshold ×mult 抬门槛,压开口期塌陷误触发。
 *
 * 冷却配置是**模块级**(turn-handling import 时读 env)→ 本文件在 import media-session 前设 env 开启,
 * 与默认关的 media-session.test.ts 隔离(单独文件=单独模块图)。
 *   - AIM_BARGE_OPEN_COOLDOWN_MS=500(开口 500ms 内抬门槛)
 *   - AIM_BARGE_OPEN_COOLDOWN_MULT=1.5(门槛 ×1.5)
 *   - 误打断恢复默认关(不影响本测试:验的是冷却窗对初判 barge-in 的抑制)
 *
 * 门槛模型:AI 几乎静默(ampFrame(50) 参考峰值≈50)→ bargeThreshold = max(dtdFloor 700, 0.3×50)=700。
 *   冷却窗内 ×1.5 → 1050。故 RMS≈900 的中等能量:窗内(门槛 1050)不触发、窗后(门槛 700)触发。
 */
process.env.AIM_BARGE_OPEN_COOLDOWN_MS = "500";
process.env.AIM_BARGE_OPEN_COOLDOWN_MULT = "1.5";

import { MediaSession, WsConn } from "../src/media-session";
import {
  AudioOutCb, EngineErrorCb, EngineMetricsCb, LlmTextCb, TranscriptCb, TurnEventCb, VoiceEngine,
} from "../src/voice-engine";

class FakeEngine implements VoiceEngine {
  hasQuestions() { return true; } // design contract:默认有题(现状语境),blockedByOpenChat 恒 false 不影响既有断言
  cancels: string[] = [];
  private audioOutCb: AudioOutCb = () => {};
  private turnCb: TurnEventCb = () => {};
  async start() {}
  pushAudio() {}
  cancel(r: string) { this.cancels.push(r); }
  onAudioOut(cb: AudioOutCb) { this.audioOutCb = cb; }
  onTranscript(_cb: TranscriptCb) {}
  onTurnEvent(cb: TurnEventCb) { this.turnCb = cb; }
  onError(_cb: EngineErrorCb) {}
  onLlmText(_cb: LlmTextCb) {}
  onAiDone(_cb: () => void) {}
  onMetrics(_cb: EngineMetricsCb) {}
  async stop() {}
  emitAudio(pcm: Buffer) { this.audioOutCb(pcm); }
}

class FakeConn implements WsConn {
  sent: (string | Buffer)[] = [];
  private msgCb: (d: Buffer, b: boolean) => void = () => {};
  send(d: string | Buffer) { this.sent.push(d); }
  close() {}
  on(ev: "message" | "close", cb: never) { if (ev === "message") this.msgCb = cb as never; }
  rxBinary(pcm: Buffer) { this.msgCb(pcm, true); }
}

/** 定幅 16k s16le 帧(20ms=320 sample);amp 决定 RMS。 */
function ampFrame(amp: number): Buffer {
  const b = Buffer.alloc(320 * 2);
  for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
}

const _sessions: MediaSession[] = [];
afterEach(async () => {
  for (const s of _sessions.splice(0)) await s.detach().catch(() => undefined);
});

async function setup() {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const session = new MediaSession(
    conn,
    { sessionId: "s_cd", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: null, transcripts: null, metrics: null },
  );
  await session.begin();
  _sessions.push(session);
  return { engine, conn, session };
}

test("R2:AI 开口冷却窗内,中等能量短附和(RMS≈900 < 门槛×1.5=1050)不触发 barge-in", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50)); // AI 开口(aiSpeaking false→true,记 aiSpeakingSinceMs);参考峰值≈50→基门槛 700
  // 开口冷却窗内(< 500ms):门槛 ×1.5 = 1050。RMS≈900 中等能量短附和,持续 ~200ms(10 帧)。
  for (let i = 0; i < 10; i++) conn.rxBinary(ampFrame(900));
  expect(engine.cancels).not.toContain("barge_in"); // ★ 冷却窗抬门槛 → 900 < 1050 → 不触发(不产生停顿)
});

test("R2:冷却窗过后,同等中等能量(RMS≈900 ≥ 基门槛 700)正常触发 barge-in(窗后不残留)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn } = await setup();
    engine.emitAudio(ampFrame(50)); // 开口,基门槛 700
    jest.advanceTimersByTime(600); // 超冷却窗 500ms → 门槛乘数恢复 1.0
    // 窗后:门槛回 700。RMS≈900 持续 ≥ confirmMs(200ms,~15 帧)→ 正常触发。
    for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(900));
    expect(engine.cancels).toContain("barge_in"); // 窗后门槛恢复,同等能量正常打断
  } finally {
    jest.useRealTimers();
  }
});

test("R2:开口冷却窗不挡真打断(高能量 RMS≈2000 ≥ 门槛×1.5=1050)——只挡中等附和,不挡真插话", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50)); // 开口,冷却窗内门槛 ×1.5=1050
  // 高能量真打断 RMS≈2000 > 1050:即便在冷却窗内也应触发(冷却只挡"中等能量顺口附和",不挡真插话)。
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(2000));
  expect(engine.cancels).toContain("barge_in"); // 真打断能量足够高,冷却窗不误伤
});
