/**
 * 误打断恢复(design contract)media-session 侧 tentative-pause 状态机单测。
 *
 * 恢复配置是**模块级**(turn-handling 在 import 时读 env)→ 本文件在 import media-session 前设 env 开启恢复,
 * 与默认关的 media-session.test.ts 隔离(单独文件 = 单独模块图)。
 *   - AIM_FALSE_INTERRUPTION_RECOVERY=1 开
 *   - AIM_FALSE_INTERRUPTION_WINDOW_MS=2000
 *   - AIM_FALSE_INTERRUPTION_TAKEOVER_MS=700(> confirmMs 200、< window 2000)
 *   - AIM_FALSE_INTERRUPTION_MAX_HOLD_MS=5000(能量域顺延硬上限)
 *   - AIM_RECOVERY_TAKEOVER_DECAY=0.5(低能量按 0.5:1 缓降)
 *   - AIM_RMS_DIAG=1 + EVERY=1:每帧打印 barge-diag(inbound/门槛/refPeak/bargeMs),供诊断采集测试解析轨迹。
 */
process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
process.env.AIM_FALSE_INTERRUPTION_WINDOW_MS = "2000";
process.env.AIM_FALSE_INTERRUPTION_TAKEOVER_MS = "700";
process.env.AIM_FALSE_INTERRUPTION_MAX_HOLD_MS = "5000";
process.env.AIM_RECOVERY_TAKEOVER_DECAY = "0.5";
process.env.AIM_RMS_DIAG = "1";
process.env.AIM_RMS_DIAG_EVERY = "1";

import { MediaSession, WsConn } from "../src/media-session";
import {
  AudioOutCb, EngineErrorCb, EngineMetricsCb, LlmTextCb, TranscriptCb, TurnEventCb, VoiceEngine,
} from "../src/voice-engine";
import { EngineTurnMetrics } from "../src/turn-metrics";

class FakeEngine implements VoiceEngine {
  hasQuestions() { return true; } // design contract:默认有题(现状语境),blockedByOpenChat 恒 false 不影响既有断言
  cancels: string[] = [];
  paused = 0;
  resumed = 0;
  private audioOutCb: AudioOutCb = () => {};
  private transcriptCb: TranscriptCb = () => {};
  private turnCb: TurnEventCb = () => {};
  private metricsCb: EngineMetricsCb = () => {};
  private turnAudioBeginCb: (aiTurnId: number) => void = () => {};
  private audioStarted = false;
  async start() {}
  pushAudio() {}
  cancel(r: string) { this.cancels.push(r); }
  pause() { this.paused += 1; }
  resume() { this.resumed += 1; }
  onAudioOut(cb: AudioOutCb) { this.audioOutCb = cb; }
  onTranscript(cb: TranscriptCb) { this.transcriptCb = cb; }
  onTurnEvent(cb: TurnEventCb) { this.turnCb = cb; }
  onError(_cb: EngineErrorCb) {}
  onLlmText(_cb: LlmTextCb) {}
  onAiDone(_cb: () => void) {}
  onMetrics(cb: EngineMetricsCb) { this.metricsCb = cb; }
  onTurnAudioBegin(cb: (aiTurnId: number) => void) { this.turnAudioBeginCb = cb; }
  async stop() {}
  emitAudio(pcm: Buffer) {
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.turnAudioBeginCb(17);
    }
    this.audioOutCb(pcm);
  }
  emitAudioWithoutTurnBoundary(pcm: Buffer) { this.audioOutCb(pcm); }
  emitTurnEvent() { this.turnCb("turn_end"); }
  emitFinal(text: string) { this.transcriptCb({ text, isFinal: true }); }
  emitMetrics(m: EngineTurnMetrics) { this.metricsCb(m); }
}

class FakeConn implements WsConn {
  sent: (string | Buffer)[] = [];
  private msgCb: (d: Buffer, b: boolean) => void = () => {};
  send(d: string | Buffer) { this.sent.push(d); }
  close() {}
  on(ev: "message" | "close", cb: never) { if (ev === "message") this.msgCb = cb as never; }
  rxBinary(pcm: Buffer) { this.msgCb(pcm, true); }
  textFrames(): Record<string, unknown>[] {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }
}

/** 定幅 16k s16le 帧(20ms=320 sample):amp 决定 RMS。 */
function ampFrame(amp: number): Buffer {
  const n = 320;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(amp, i * 2);
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
  const metrics = { records: [] as Record<string, unknown>[], async put(m: Record<string, unknown>) { this.records.push(m); } };
  const session = new MediaSession(
    conn,
    { sessionId: "s_rec", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: null, transcripts: null, metrics: metrics as never },
  );
  await session.begin();
  _sessions.push(session);
  return { engine, conn, metrics, session };
}

test("疑似打断确认 → tentative-pause(engine.pause + 下行 pause 帧,不销毁)", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50)); // AI 开口(aiSpeaking=true,参考低)
  // 11 帧 × 20ms = 220ms:> confirmMs 200(触发 tentative-pause)、< takeover 700(不到真接管)。
  for (let i = 0; i < 11; i++) conn.rxBinary(ampFrame(3000));
  expect(engine.paused).toBe(1);
  expect(engine.cancels).not.toContain("barge_in"); // 未销毁
  expect(conn.textFrames().filter((f) => f.type === "pause")).toEqual([
    { type: "pause", ai_turn_id: 17, pause_id: 1 },
  ]);
});

test("缺少 ai_turn_id 时 tentative pause fail-closed 为确认打断", async () => {
  const { engine, conn } = await setup();
  engine.emitAudioWithoutTurnBoundary(ampFrame(50));
  for (let i = 0; i < 11; i++) conn.rxBinary(ampFrame(3000));

  expect(engine.paused).toBe(0);
  expect(engine.cancels).toContain("barge_in");
  expect(conn.textFrames().filter((f) => f.type === "pause")).toEqual([]);
  expect(conn.textFrames().filter((f) => f.type === "barge_in")).toEqual([
    { type: "barge_in" },
  ]);
});

test("窗内无接管(一声「嗯」后静默)→ resume 续播 + 记 false_interruption", async () => {
  jest.useFakeTimers();
  const { engine, conn, metrics } = await setup();
  // 真实一轮:用户先说话(建 pendingEndpoint,承载本轮误打断标记)→ turn_end → AI 播报期误打断 → resume。
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(800)); // 用户语音(>500 阈值,建 turnPending + lastSpeechAt)
  engine.emitFinal("你好");
  engine.emitTurnEvent();                // turn_end → 建本轮 pendingEndpoint
  engine.emitAudio(ampFrame(50));        // AI 开口(aiSpeaking)
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000)); // 触发 pause(~240ms > confirm 200)
  expect(engine.paused).toBe(1);
  for (let i = 0; i < 20; i++) conn.rxBinary(silent()); // 400ms 安静,证据衰减到 0
  jest.advanceTimersByTime(2050);        // 超恢复窗 2000ms → resume
  expect(engine.resumed).toBe(1);
  expect(engine.cancels).not.toContain("barge_in"); // 未销毁(误打断)
  expect(conn.textFrames().filter((f) => f.type === "pause" || f.type === "resume")).toEqual([
    { type: "pause", ai_turn_id: 17, pause_id: 1 },
    { type: "resume", ai_turn_id: 17, pause_id: 1 },
  ]);
  // 本轮 AI 播报结束 → engine 上报 metrics → 合并本轮 pendingEndpoint(含 falseInterruption)落库
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "full", bargeIn: false });
  expect(metrics.records[0].falseInterruption).toBe(true);
});

test("同一 AI 轮多次 tentative pause 使用单调 pause_id 且各自成对", async () => {
  jest.useFakeTimers();
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50));

  for (let episode = 1; episode <= 2; episode++) {
    for (let i = 0; i < 11; i++) conn.rxBinary(ampFrame(3000));
    expect(engine.paused).toBe(episode);
    for (let i = 0; i < 20; i++) conn.rxBinary(silent());
    jest.advanceTimersByTime(2050);
    expect(engine.resumed).toBe(episode);
  }

  expect(conn.textFrames().filter(
    (frame) => frame.type === "pause" || frame.type === "resume",
  )).toEqual([
    { type: "pause", ai_turn_id: 17, pause_id: 1 },
    { type: "resume", ai_turn_id: 17, pause_id: 1 },
    { type: "pause", ai_turn_id: 17, pause_id: 2 },
    { type: "resume", ai_turn_id: 17, pause_id: 2 },
  ]);
});

test("design contract:metrics 在恢复窗结束**之后**才上报(engine 推迟)→ falseInterruption 不丢失", async () => {
  // design contract 修复的时序:引擎把 full metrics 推迟到 fireAiDone(resume 兑现后)才上报,故 metrics 到达
  // media-session 时已在 onRecoveryWindowElapsed 之后 → pendingEndpoint 已含 falseInterruption。
  // 本测试从 media-session 侧固化这条契约:只要 metrics 上报晚于 resume,falseInterruption 必落库。
  jest.useFakeTimers();
  const { engine, conn, metrics } = await setup();
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(800)); // 用户语音 → turnPending + pendingEndpoint
  engine.emitFinal("你好");
  engine.emitTurnEvent();
  engine.emitAudio(ampFrame(50));                            // AI 开口
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000)); // 触发 pause
  expect(engine.paused).toBe(1);
  for (let i = 0; i < 20; i++) conn.rxBinary(silent());       // 安静,不到 takeover
  jest.advanceTimersByTime(2050);                             // 超恢复窗 → resume + 写 falseInterruption
  expect(engine.resumed).toBe(1);
  // ★ design contract:引擎在此(resume 兑现 fireAiDone)之后才上报 metrics —— pendingEndpoint 已含 falseInterruption。
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "full", bargeIn: false });
  expect(metrics.records.length).toBe(1);
  expect(metrics.records[0].falseInterruption).toBe(true);   // 不丢失(design contract 保证上报晚于恢复窗结束)
});

test("窗内真接管(高能量持续到 takeover)→ 转确认打断 engine.cancel(barge_in) 销毁", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50));
  // 持续高能量:先触发 pause(200ms),继续累计到 takeover 700ms → 真接管销毁
  for (let i = 0; i < 40; i++) conn.rxBinary(ampFrame(3000));
  expect(engine.paused).toBe(1);       // 先暂停
  expect(engine.cancels).toContain("barge_in"); // 再确认销毁
  expect(conn.textFrames().filter((f) => f.type === "barge_in")).toEqual([
    { type: "barge_in", ai_turn_id: 17, pause_id: 1 },
  ]);
});

test("密集真接管含短于 300ms 的自然音节跌落时仍净累计到 takeover", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50));
  // 先用 220ms 高能量进入 tentative-pause;随后每段 120ms 高能量 + 160ms 低能量,
  // 默认 K=0.5 时每段净增 40ms。160ms 跌落超过初判 hangover 60ms,但不会整段清零。
  // 若错误退回 K=1,每段净减 40ms,本用例无法达到 takeover。
  for (let i = 0; i < 11; i++) conn.rxBinary(ampFrame(3000));
  for (let phrase = 0; phrase < 13 && !engine.cancels.includes("barge_in"); phrase++) {
    for (let i = 0; i < 6; i++) conn.rxBinary(ampFrame(3000));
    for (let i = 0; i < 8; i++) conn.rxBinary(silent());
  }
  expect(engine.paused).toBe(1);
  expect(engine.cancels).toContain("barge_in");
});

test("稀疏背景音尖峰不会误累计 takeover,证据归零后仍经恢复窗 resume + 记 metrics", async () => {
  jest.useFakeTimers();
  const { engine, conn, metrics } = await setup();
  // 建 pendingEndpoint,验证 decay 到 0 不会绕开 onRecoveryWindowElapsed 的 metrics 收口。
  for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(800));
  engine.emitFinal("你好");
  engine.emitTurnEvent();
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 11; i++) conn.rxBinary(ampFrame(3000)); // 220ms → tentative-pause
  expect(engine.paused).toBe(1);

  // 每 340ms 一个 40ms 尖峰:每轮 +40ms 后有 300ms 低能量,默认 K=0.5 足以把证据降到 0。
  // 高能量仍按 R3 重置 2s 恢复窗,但只允许顺延到 5s 硬上限;衰减与顺延分别控制证据和结束时机。
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 2; i++) {
      conn.rxBinary(ampFrame(3000));
      jest.advanceTimersByTime(20);
    }
    for (let i = 0; i < 15; i++) {
      conn.rxBinary(silent());
      jest.advanceTimersByTime(20);
    }
    expect(engine.cancels).not.toContain("barge_in");
  }
  expect(engine.resumed).toBe(0); // bargeMs=0 本身不提前结束 episode
  jest.advanceTimersByTime(1650); // 到 tentative-pause 起点 + 5s 硬上限
  expect(engine.resumed).toBe(1);
  expect(engine.cancels).not.toContain("barge_in");
  expect(conn.textFrames().some((f) => f.type === "resume")).toBe(true);

  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "full", bargeIn: false });
  expect(metrics.records).toHaveLength(1);
  expect(metrics.records[0].falseInterruption).toBe(true);
});

// ── 诊断采集(用户要求):两条对照 + 采集 bargeMs/RMS/threshold/refPeak/decay 轨迹 ──
//   复用生产 RMS_DIAG 诊断日志(media-session barge-diag 行)——既采集轨迹,又验证 RMS_DIAG 诊断路径本身可用
//   (部署验证标定打断也靠它)。barge-diag 打印在本帧 bargeMs 更新**之前**,故轨迹是"进入该帧时的累计值"。
type DiagSample = { inbound: number; threshold: number; refPeak: number; baseline: number; bargeMs: number };
function captureDiag(fn: () => void): DiagSample[] {
  const samples: DiagSample[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    const m = line.match(/barge-diag inbound=(-?\d+) 门槛=(-?\d+) AI参考峰值=(-?\d+) 噪声基线=(-?\d+) bargeMs=(-?\d+)/);
    if (m) samples.push({ inbound: +m[1], threshold: +m[2], refPeak: +m[3], baseline: +m[4], bargeMs: +m[5] });
  };
  try { fn(); } finally { console.log = orig; }
  return samples;
}

test("诊断采集①:真人语音含 <300ms 停顿 → bargeMs 泄漏累计爬升至 takeover → 真接管销毁", async () => {
  const { engine, conn } = await setup();
  const samples = captureDiag(() => {
    engine.emitAudio(ampFrame(50)); // AI 开口
    // 220ms 高能量进 tentative-pause;随后每段 120ms 高能量 + 160ms 低能量(<300ms 停顿),K=0.5 每段净增 40ms。
    for (let i = 0; i < 11; i++) conn.rxBinary(ampFrame(3000));
    for (let phrase = 0; phrase < 13 && !engine.cancels.includes("barge_in"); phrase++) {
      for (let i = 0; i < 6; i++) conn.rxBinary(ampFrame(3000));
      for (let i = 0; i < 8; i++) conn.rxBinary(silent());
    }
  });
  // 行为:真接管销毁(打断即停)
  expect(engine.cancels).toContain("barge_in");
  // 诊断量采集:RMS/门槛/refPeak/bargeMs 都被观测到(RMS_DIAG 诊断路径可用,真机同款)
  expect(samples.length).toBeGreaterThan(10);
  const peakBargeMs = Math.max(...samples.map((s) => s.bargeMs));
  const highRms = samples.filter((s) => s.inbound >= s.threshold);
  expect(highRms.length).toBeGreaterThan(0); // 有超门槛的真人语音帧
  expect(peakBargeMs).toBeGreaterThanOrEqual(700 - 40); // bargeMs 泄漏累计逼近/达 takeover(采样在更新前,末帧触发)
  // 泄漏累计特征:含跌落但净爬升(有低于门槛的停顿帧,但 bargeMs 整体走高而非清零到 0)
  const dipFrames = samples.filter((s) => s.inbound < s.threshold);
  expect(dipFrames.length).toBeGreaterThan(0); // 确有 <300ms 停顿帧
  expect(Math.max(...dipFrames.map((s) => s.bargeMs))).toBeGreaterThan(200); // 停顿帧时 bargeMs 未被清零(泄漏非清零)
});

test("诊断采集②:40ms 尖峰间隔 300ms 静默 → bargeMs 衰减不跨 burst → 未达 takeover → resume", async () => {
  jest.useFakeTimers();
  const { engine, conn, metrics } = await setup();
  const samples = captureDiag(() => {
    for (let i = 0; i < 20; i++) conn.rxBinary(ampFrame(800)); // 建 pendingEndpoint
    engine.emitFinal("你好"); engine.emitTurnEvent(); engine.emitAudio(ampFrame(50));
    for (let i = 0; i < 11; i++) conn.rxBinary(ampFrame(3000)); // 进 tentative-pause
    // 每 340ms 一个 40ms 尖峰(2 帧高 + 15 帧静音=300ms),K=0.5 把证据降到 0,跨 burst 不累计。
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 2; i++) { conn.rxBinary(ampFrame(3000)); jest.advanceTimersByTime(20); }
      for (let i = 0; i < 15; i++) { conn.rxBinary(silent()); jest.advanceTimersByTime(20); }
    }
  });
  // 行为:未触发 takeover(背景音不误接管)
  expect(engine.cancels).not.toContain("barge_in");
  // 诊断量:bargeMs 峰值远低于 takeover 700(每尖峰只 +40,静默衰减吃掉)→ 证明不跨 burst 累计
  const peakBargeMs = Math.max(...samples.map((s) => s.bargeMs));
  expect(peakBargeMs).toBeLessThan(700);
  // 衰减特征:尖峰后出现 bargeMs 回落(相邻采样有下降)——泄漏衰减在起作用
  const hasDecayDrop = samples.some((s, i) => i > 0 && s.bargeMs < samples[i - 1].bargeMs);
  expect(hasDecayDrop).toBe(true);
  // 恢复窗满 → resume + 记 false_interruption(证据归零经 onRecoveryWindowElapsed 收口)
  jest.advanceTimersByTime(1650);
  expect(engine.resumed).toBe(1);
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "full", bargeIn: false });
  expect(metrics.records[0].falseInterruption).toBe(true);
});
