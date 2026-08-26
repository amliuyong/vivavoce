/**
 * 声纹锁定(design contract)media-session 集成测试 —— 真 MediaSession + 注入式 stub embedder + FakeEngine。
 *
 * 声纹门只在 recovery 开时启用(effective_speaker_lock ⟹ recovery 开,D7),故本文件在 import 前开 recovery。
 * 验证异步声纹门:注册状态机(未就绪 fail-open / 多段一致 ENROLLED)、三态裁决(TARGET 接管 / NONTARGET
 * 抑制+cooldown / UNCERTAIN fail-open)、单飞、stale 丢弃、超时 fail-open、清 bargeMs 防逐帧打爆 GPU。
 */
process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
process.env.AIM_FALSE_INTERRUPTION_WINDOW_MS = "2000";
process.env.AIM_FALSE_INTERRUPTION_TAKEOVER_MS = "700";
process.env.AIM_SPEAKER_LOCK_ENROLL_MS = "200"; // 短门槛,便于测试快速攒够一段
process.env.AIM_SPEAKER_LOCK_ENROLL_GAP_MS = "600";
// 二审重构:验证在 tentative-pause 期发起,门 = media-session 模块常量 SPEAKER_MIN_VERIFY_MS(读此 env)。
//   测试设 100ms,使 confirmMs(200)进 pause 后下一高能量帧即满足窗门发起验证(无需推到 400ms)。
process.env.AIM_SPEAKER_LOCK_MIN_VERIFY_MS = "100";

import { MediaSession, WsConn } from "../src/media-session";
import { SpeakerLock, type Embedder, type SpeakerLockConfig } from "../src/speaker-lock";
import { SPEAKER_EMBEDDING_DIM } from "../src/gpu-embedding-dim";
import {
  AudioOutCb, EngineErrorCb, EngineMetricsCb, LlmTextCb, TranscriptCb, TurnEventCb, VoiceEngine,
} from "../src/voice-engine";

class FakeEngine implements VoiceEngine {
  hasQuestions() { return true; }
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
  textFrames(): Record<string, unknown>[] {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }
}

function ampFrame(amp: number): Buffer {
  const n = 320;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(amp, i * 2);
  return b;
}
function silent(): Buffer { return ampFrame(0); }
const flush = () => new Promise((r) => setImmediate(r)); // 让异步 embedder.then 微任务跑完

/** 可控 stub embedder:按调用序返回预设向量;可注入延迟/失败。 */
class StubEmbedder implements Embedder {
  calls = 0;
  constructor(private readonly plan: (call: number) => number[] | null | Promise<number[] | null>) {}
  async embed(_pcm: Buffer): Promise<number[] | null> {
    const r = this.plan(this.calls++);
    return r instanceof Promise ? r : r;
  }
}

const V_TARGET = new Array<number>(SPEAKER_EMBEDDING_DIM).fill(0).map((_, i) => Math.sin(i * 0.1));
const V_OTHER = new Array<number>(SPEAKER_EMBEDDING_DIM).fill(0).map((_, i) => Math.cos(i * 0.7));

function cfg(over: Partial<SpeakerLockConfig> = {}): SpeakerLockConfig {
  return {
    enabled: true, thresholdHigh: 0.35, thresholdLow: 0.2, enrollMs: 200, enrollGapMs: 600,
    enrollConsistency: 0.6, timeoutMs: 200, ema: 0, minVerifyMs: 100, verifyWindowMs: 1000,
    embeddingUrl: "http://x", embeddingSecret: "s", valid: true, ...over,
  };
}

const _sessions: MediaSession[] = [];
afterEach(async () => {
  for (const s of _sessions.splice(0)) await s.detach().catch(() => undefined);
  jest.useRealTimers();
});

async function setup(embedder: Embedder, effective = true, cfgOver: Partial<SpeakerLockConfig> = {}) {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const speakerLock = new SpeakerLock(cfg(cfgOver), embedder);
  const session = new MediaSession(
    conn,
    { sessionId: "s_sl", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" },
      effectiveSpeakerLock: effective },
    { engine, recorder: null, transcripts: null, metrics: null, speakerLock },
  );
  await session.begin();
  _sessions.push(session);
  return { engine, conn, speakerLock };
}

/** 喂两段一致的目标人语音注册(每段 ≥ enrollMs=200ms=10 帧,段间静默 > gap 断段)→ ENROLLED。 */
async function enrollTarget(conn: FakeConn) {
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(800)); // 段1(AI 未在说路径)
  await flush(); // 段1 embedding 飞行 → 完成
  for (let i = 0; i < 35; i++) conn.rxBinary(silent()); // 段间静默 > gap 断段(且退出注册飞行)
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(800)); // 段2
  await flush(); // 段2 embedding → 一致 → ENROLLED
}

test("注册:两段一致 → ENROLLED", async () => {
  const emb = new StubEmbedder(() => V_TARGET);
  const { conn, speakerLock } = await setup(emb);
  await enrollTarget(conn);
  expect(speakerLock.enrolled).toBe(true);
});

test("注册未就绪 → 打断 fail-open(照现状 tentative-pause,不卡等)", async () => {
  const emb = new StubEmbedder(() => V_TARGET);
  const { engine, conn, speakerLock } = await setup(emb);
  expect(speakerLock.enrolled).toBe(false);
  engine.emitAudio(ampFrame(50)); // AI 开口
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000)); // 触发 confirmMs
  await flush();
  expect(engine.paused).toBe(1); // 现状 tentative-pause 照走(fail-open,未因声纹门卡住)
});

test("目标人打断:验证 TARGET → 确认接管销毁(engine.cancel barge_in)", async () => {
  // 注册返 V_TARGET;验证也返 V_TARGET → cosine=1 ≥ τ_high → TARGET
  const emb = new StubEmbedder(() => V_TARGET);
  const { engine, conn } = await setup(emb);
  await enrollTarget(conn);
  engine.emitAudio(ampFrame(50)); // AI 开口
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000)); // confirmMs 命中 → tentative-pause + 异步验证
  expect(engine.paused).toBe(1);
  await flush(); // 验证回调 TARGET → confirmTakeover → onBargeIn
  expect(engine.cancels).toContain("barge_in");
});

test("旁人打断:验证 NONTARGET → 抑制打断(resume 续播,不 cancel)", async () => {
  // 注册段返 V_TARGET(前 2 次 embed);之后打断验证返 V_OTHER → cosine 低 → NONTARGET
  const emb = new StubEmbedder((c) => (c < 2 ? V_TARGET : V_OTHER));
  const { engine, conn } = await setup(emb);
  await enrollTarget(conn);
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000)); // confirmMs → tentative-pause + 验证
  expect(engine.paused).toBe(1);
  await flush(); // NONTARGET → resume 续播,不销毁
  expect(engine.resumed).toBe(1);
  expect(engine.cancels).not.toContain("barge_in");
  expect(conn.textFrames().some((f) => f.type === "resume")).toBe(true);
});

test("单飞:同一 tentative-pause 内旁人持续高能量多帧 → 只发一次验证(pauseVerifyDone,不逐帧打爆 GPU)", async () => {
  // 验证 promise 挂起(不 resolve)→ 保持在**同一 pause**;期间推 40 高能量帧,断言只发起 1 次 embed(单飞)。
  let embedCalls = 0;
  let resolveVerify: (v: number[] | null) => void = () => {};
  const emb = new StubEmbedder((c) => {
    embedCalls = c + 1;
    if (c < 2) return V_TARGET; // 注册两段
    return new Promise<number[] | null>((res) => { resolveVerify = res; }); // 验证挂起
  });
  const { engine, conn } = await setup(emb);
  await enrollTarget(conn);
  const callsAfterEnroll = embedCalls; // = 2
  engine.emitAudio(ampFrame(50));
  // 旁人持续高能量:confirmMs → pause,pause 内窗够 → 发一次验证(挂起);后续 40 帧同一 pause 内不重发(pauseVerifyDone)。
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000));
  for (let i = 0; i < 40; i++) conn.rxBinary(ampFrame(3000)); // 同一 pause 继续吵
  expect(embedCalls).toBe(callsAfterEnroll + 1); // 本 pause 只发 1 次验证(单飞,review)
  expect(engine.paused).toBe(1); // 仍在 pause 等验证裁决
  // 验证挂起期能量攒到 takeover?——不应接管(验证未回,能量证据照常;这里 40 帧远超 takeover 700ms)。
  // 注:验证挂起时能量证据仍可 takeover(fail-open,不误聋目标人)——这是设计:验证慢不阻塞打断。
  resolveVerify(V_OTHER); // 收尾:放行挂起的 promise,避免悬挂
  await flush();
});

test("review:旁人停后目标人开口是**新 episode** → 重新验证,不被旧压制误挡(不误聋目标人)", async () => {
  // 注册 V_TARGET(2 次);第 3 次验证=旁人 V_OTHER→NONTARGET;第 4 次验证=目标人 V_TARGET→TARGET 应接管。
  const emb = new StubEmbedder((c) => (c < 2 || c >= 3 ? V_TARGET : V_OTHER));
  const { engine, conn } = await setup(emb);
  await enrollTarget(conn);
  // 旁人打断 → NONTARGET 抑制
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000));
  await flush();
  expect(engine.cancels).not.toContain("barge_in"); // 旁人被抑制
  // 旁人停(能量跌破 hangover → endSpeakerEpisode 清旁人标记 = 新 episode 边界)
  for (let i = 0; i < 10; i++) conn.rxBinary(silent());
  // 目标人开口打断(新 episode)→ 重新验证 → TARGET → 接管销毁(不被旧旁人压制误挡)
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000));
  await flush();
  expect(engine.cancels).toContain("barge_in"); // 目标人新 episode 能打断(B1 红线:旁人停后不误压目标人)
});

test("review:窗口 < minVerifyMs(短音频)→ verify 内层守卫不发起,交能量证据 fail-open(不下 NONTARGET)", async () => {
  // verify() 内层短窗守卫(cfg.minVerifyMs=300):即便 media-session 门(env 100)已放行,窗 240ms<300 仍不发起。
  let embedCalls = 0;
  const emb = new StubEmbedder((c) => { embedCalls = c + 1; return c < 2 ? V_TARGET : V_OTHER; });
  const { engine, conn } = await setup(emb, true, { minVerifyMs: 300 }); // verify 内层门抬到 300ms
  await enrollTarget(conn);
  const callsAfterEnroll = embedCalls;
  engine.emitAudio(ampFrame(50));
  // 推 12 帧(240ms):confirmMs 命中进 pause,pause 内窗 240ms < 300ms → verify 内层守卫早退不发起(短窗 fail-open)
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000));
  await flush();
  expect(embedCalls).toBe(callsAfterEnroll); // 短窗未发起验证(embed 未被调用)
  expect(engine.paused).toBe(1); // 但 tentative-pause 照走(能量证据 fail-open,不因短窗卡死)
});

test("Major-2 回归:**默认参数**(confirmMs=200 / minVerifyMs=400)下声纹门在 tentative-pause 期真发起验证(不永久 fail-open)", async () => {
  // 血教训(review 二审):此前 verify 只在 confirmMs 首命中(200ms<400)发起 → 默认永不验证。
  // 本测试用**默认 minVerifyMs=400**(不 override),推足够帧让 pause 期窗攒过 400ms → 必发起一次验证 → TARGET 接管。
  const emb = new StubEmbedder(() => V_TARGET);
  const { engine, conn } = await setup(emb, true, { minVerifyMs: 400 }); // 显式默认值,防测试 env(100)掩盖
  await enrollTarget(conn);
  engine.emitAudio(ampFrame(50));
  // confirmMs=200ms(11 帧)进 pause;继续推到窗 ≥ 400ms(再 ~15 帧)→ pause 期发起验证 → TARGET。
  for (let i = 0; i < 30; i++) conn.rxBinary(ampFrame(3000)); // 600ms 高能量,pause 期窗过 400ms
  await flush();
  expect(engine.cancels).toContain("barge_in"); // 默认参数下声纹门真发起 + TARGET 接管(不永久 fail-open)
});

test("验证超时/失败(embed 返 null)→ UNCERTAIN fail-open(不误聋:tentative-pause 能量证据照常裁决)", async () => {
  const emb = new StubEmbedder((c) => (c < 2 ? V_TARGET : null)); // 注册成功;验证 embed 失败 → null
  const { engine, conn } = await setup(emb);
  await enrollTarget(conn);
  engine.emitAudio(ampFrame(50));
  // 持续高能量到 takeover(700ms):UNCERTAIN 不抑制,能量证据照常接管销毁(不误聋目标人)
  for (let i = 0; i < 40; i++) conn.rxBinary(ampFrame(3000));
  await flush();
  expect(engine.cancels).toContain("barge_in"); // fail-open:能量证据仍能接管
});

test("effective 关(speaker_lock 未启用)→ 声纹门不介入,打断等价现状", async () => {
  const emb = new StubEmbedder(() => V_OTHER); // 即便会判 NONTARGET,也不该被调用
  const { engine, conn } = await setup(emb, /* effective */ false);
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 40; i++) conn.rxBinary(ampFrame(3000)); // 持续高能量 → takeover
  await flush();
  expect(emb.calls).toBe(0); // 声纹门全程未介入(embedder 没被调用)
  expect(engine.cancels).toContain("barge_in"); // 等价现状:能量证据接管销毁
});

test("teardown 后迟到的验证回调作废(不操作已销毁的轮)", async () => {
  let resolveVerify: (v: number[] | null) => void = () => {};
  const emb = new StubEmbedder((c) => {
    if (c < 2) return V_TARGET; // 注册
    return new Promise<number[] | null>((res) => { resolveVerify = res; }); // 验证挂起
  });
  const { engine, conn, speakerLock } = await setup(emb);
  await enrollTarget(conn);
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000)); // 发起验证(挂起)
  expect(engine.paused).toBe(1);
  speakerLock.dispose(); // 模拟 teardown
  resolveVerify(V_TARGET); // 迟到 resolve
  await flush();
  expect(engine.cancels).not.toContain("barge_in"); // 已 dispose → 回调作废,不误接管
});

test("二审 Critical-1(D1 泄漏根治):旁人 NONTARGET(pause1)→ resume → 目标人(pause2)重新验证 TARGET 接管,不被旧压制误挡", async () => {
  // 二审揪出的 fail-closed 泄漏:旧设计旁人 NONTARGET 置 **sticky** 标志,旁人→目标人间隙 < hangover 时永久压制目标人。
  // 新设计:旁人判定 **scoped 到本 pause**(beginTentativePause 重置 pauseBystanderConfirmed)——旁人 pause1 resume 后,
  // 目标人开口进 pause2,pauseBystanderConfirmed 已被重置为 false → 正常验证 → TARGET 接管。**无论两次间隙多短**都不泄漏。
  const emb = new StubEmbedder((c) => (c < 2 || c >= 3 ? V_TARGET : V_OTHER)); // 注册2 + 第3次旁人 + 之后目标人
  const { engine, conn } = await setup(emb);
  await enrollTarget(conn);
  // pause1:旁人打断 → NONTARGET → resume(pauseBystanderConfirmed 本 pause 内 true,resume 后 pause 结束即失效)
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000));
  await flush();
  expect(engine.resumed).toBe(1); // 旁人被抑制(resume)
  expect(engine.cancels).not.toContain("barge_in");
  // **极短间隙**(仅 2 帧静音 < 60ms hangover):旧 sticky 设计此处标志未清 → 目标人会被永久压制(fail-closed 破 D1)。
  for (let i = 0; i < 2; i++) conn.rxBinary(silent());
  // pause2:目标人开口 → beginTentativePause 重置 pauseBystanderConfirmed=false → 重新验证 → TARGET → 接管销毁。
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 12; i++) conn.rxBinary(ampFrame(3000));
  await flush();
  expect(engine.cancels).toContain("barge_in"); // 目标人能打断(D1 红线:短间隙下旧旁人判定不泄漏、不误压目标人)
});
