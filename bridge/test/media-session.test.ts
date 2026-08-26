/**
 * MediaSession 单测(design contract)—— 注入假 VoiceEngine/录音/转写,断言:
 *  - 入向 PCM 喂引擎;AI 播报期间回声抑制(喂静音)
 *  - engine.onAudioOut → 回发 WS + 录 AI 声道
 *  - asr_final → 转写落库(user)
 *  - WS close → 收尾(停引擎 + 上传录音 + 关连接 + onEnded 回报)
 *  - barge-in → engine.cancel(barge_in) + 关回声抑制窗
 */
import { MediaSession, WsConn, isUserLeaveIntent } from "../src/media-session";
import { TURN_HANDLING_DEFAULTS } from "../src/turn-handling"; // design contract:静音帧数从权威默认值派生
import {
  AudioOutCb,
  EngineErrorCb,
  EngineMetricsCb,
  LlmTextCb,
  TranscriptCb,
  TurnEventCb,
  VoiceEngine,
  endReasonToEvent,
} from "../src/voice-engine";
import { EngineTurnMetrics } from "../src/turn-metrics";

class FakeEngine implements VoiceEngine {
  pushed: Buffer[] = [];
  cancels: string[] = [];
  endTurns = 0;
  kickoffs = 0; // design contract:主动开场 kickoff 调用次数
  stopped = false;
  started = false;
  private audioOutCb: AudioOutCb = () => {};
  private transcriptCb: TranscriptCb = () => {};
  private turnCb: TurnEventCb = () => {};
  private errorCb: EngineErrorCb = () => {};
  private llmTextCb: LlmTextCb = () => {};
  async start() {
    this.started = true;
  }
  pushAudio(pcm: Buffer) {
    this.pushed.push(pcm);
  }
  cancel(reason: string) {
    this.cancels.push(reason);
  }
  onAudioOut(cb: AudioOutCb) {
    this.audioOutCb = cb;
  }
  onTranscript(cb: TranscriptCb) {
    this.transcriptCb = cb;
  }
  onTurnEvent(cb: TurnEventCb) {
    this.turnCb = cb;
  }
  onError(cb: EngineErrorCb) {
    this.errorCb = cb;
  }
  onLlmText(cb: LlmTextCb) {
    this.llmTextCb = cb;
  }
  private aiDoneCb: () => void = () => {};
  onAiDone(cb: () => void) {
    this.aiDoneCb = cb;
  }
  private metricsCb: EngineMetricsCb = () => {};
  onMetrics(cb: EngineMetricsCb) {
    this.metricsCb = cb;
  }
  private turnAudioBeginCb: (aiTurnId: number) => void = () => {};
  private turnAudioEndCb: (aiTurnId: number) => void = () => {};
  onTurnAudioBegin(cb: (aiTurnId: number) => void) {
    this.turnAudioBeginCb = cb;
  }
  onTurnAudioEnd(cb: (aiTurnId: number) => void) {
    this.turnAudioEndCb = cb;
  }
  endCallSignal = false; // 测试可设:模拟 LLM 语义挂断信号
  wantsEndCall(): boolean {
    const v = this.endCallSignal;
    this.endCallSignal = false;
    return v;
  }
  // design contract:考试完成强制。测试可设 pending 模拟「有未问完题」;endRequests 记 noteEndRequest 次数。
  pending = false;
  earlyExit = false;
  endRequests = 0;
  // design contract:这场有没有(有效)预设题。默认 true(现状多数测试是"有题面试官"语境,与旧行为等价:
  // 有题时 blockedByOpenChat 恒 false,不影响既有挂断断言)。自由聊天测试显式置 false。
  hasQ = true;
  hasPendingQuestions(): boolean {
    return this.pending;
  }
  hasQuestions(): boolean {
    return this.hasQ;
  }
  noteEndRequest(): boolean {
    this.endRequests += 1;
    return this.earlyExit;
  }
  wantsEarlyExit(): boolean {
    return this.earlyExit;
  }
  async stop() {
    this.stopped = true;
  }
  endTurn() {
    this.endTurns += 1;
  }
  kickoff() {
    this.kickoffs += 1;
  }
  // 测试触发器
  emitAudio(pcm: Buffer) {
    this.audioOutCb(pcm);
  }
  emitTurnEvent() {
    this.turnCb("turn_end");
  }
  emitFinal(text: string) {
    this.transcriptCb({ text, isFinal: true });
  }
  emitLlmText(text: string) {
    this.llmTextCb(text);
  }
  emitAiDone() {
    this.aiDoneCb();
  }
  emitMetrics(m: EngineTurnMetrics) {
    this.metricsCb(m);
  }
  emitAudioBegin(aiTurnId: number) {
    this.turnAudioBeginCb(aiTurnId);
  }
  emitAudioEnd(aiTurnId: number) {
    this.turnAudioEndCb(aiTurnId);
  }
  emitError(code: string, msg: string) {
    this.errorCb(code, msg);
  }
}

class FakeConn implements WsConn {
  sent: (string | Buffer)[] = [];
  closed = false;
  private msgCb: (d: Buffer, b: boolean) => void = () => {};
  private closeCb: () => void = () => {};
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  on(event: "message" | "close", cb: never) {
    if (event === "message") this.msgCb = cb as unknown as (d: Buffer, b: boolean) => void;
    else this.closeCb = cb as unknown as () => void;
  }
  rxBinary(pcm: Buffer) {
    this.msgCb(pcm, true);
  }
  /** 上行 text 帧(M1 信令,如 {"type":"end"})。 */
  rxText(obj: unknown) {
    this.msgCb(Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj), "utf8"), false);
  }
  fireClose() {
    this.closeCb();
  }
  /** 已发的下行 text 帧(JSON 解析;binary 音频帧不在内)。 */
  textFrames(): Record<string, unknown>[] {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function mkRecorder() {
  return {
    started: false,
    caller: [] as Buffer[],
    ai: [] as Buffer[],
    uploaded: false,
    stopCalls: 0, // design contract:stopAndUpload 调用次数(评审 八审:布尔已被首次 teardown 置,用计数更精确)
    async start() {
      this.started = true;
    },
    pushCaller(b: Buffer) {
      this.caller.push(b);
    },
    pushAi(b: Buffer) {
      this.ai.push(b);
    },
    async stopAndUpload() {
      this.uploaded = true;
      this.stopCalls++;
      return "recordings/by-session/x.wav";
    },
  };
}

function mkTranscripts() {
  return {
    finals: [] as { speaker: string; text: string }[],
    async putFinal(_sid: string, speaker: "user" | "ai", text: string) {
      this.finals.push({ speaker, text });
    },
  };
}

function mkMetrics() {
  return {
    records: [] as Record<string, unknown>[],
    async put(m: Record<string, unknown>) {
      this.records.push(m);
    },
  };
}

/** onEnded 回报记录(语义收尾/正常收尾断言用;detach 不回报)。 */
type EndedInfo = { durationS: number; hasRecording: boolean; reason: string };

// 追踪 setup() 建的 session,afterEach 统一收尾:停掉其周期看门狗(setInterval),否则真定时器测试
// 留活的 watchdog 会在测试结束后继续 tick → 触发 console.warn(aiSpeaking 安全看门狗)→ jest --ci
// 报「Cannot log after tests are done」(CI bridge:jest 失败根因)。
const _openSessions: MediaSession[] = [];
afterEach(async () => {
  for (const s of _openSessions.splice(0)) {
    await s.detach().catch(() => undefined); // detach 停引擎/看门狗,不触发 onEnded 回报(测试收尾)
  }
  jest.useRealTimers();
});

async function setup() {
  const engine = new FakeEngine();
  const recorder = mkRecorder();
  const transcripts = mkTranscripts();
  const conn = new FakeConn();
  const endeds: EndedInfo[] = []; // onEnded 回报记录(end 路径回报;detach 不回报)
  const session = new MediaSession(
    conn,
    { sessionId: "sess_x", systemPrompt: "你是面试官", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    {
      engine,
      recorder: recorder as never,
      transcripts: transcripts as never,
      onEnded: (info) => {
        endeds.push(info);
      },
    },
  );
  await session.begin();
  _openSessions.push(session); // afterEach 收尾,停看门狗 setInterval(防真定时器泄漏到测试后)
  return { engine, recorder, transcripts, conn, session, endeds };
}

test("起会:启动引擎 + 起录音", async () => {
  const { engine, recorder } = await setup();
  expect(engine.started).toBe(true);
  expect(recorder.started).toBe(true);
});

test("入向 PCM 正常喂引擎 + 录对端声道", async () => {
  const { engine, recorder, conn } = await setup();
  const pcm = Buffer.from([1, 2, 3, 4]);
  conn.rxBinary(pcm);
  expect(engine.pushed).toHaveLength(1);
  expect(engine.pushed[0]).toEqual(pcm);
  expect(recorder.caller).toHaveLength(1);
});

test("AI 播报期间回声抑制:入向喂静音(非原帧)", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(Buffer.from([9, 9])); // AI 开始说话 → aiSpeaking=true
  const pcm = Buffer.from([1, 2, 3, 4]);
  conn.rxBinary(pcm);
  const last = engine.pushed[engine.pushed.length - 1];
  expect(last.equals(Buffer.alloc(4))).toBe(true); // 喂的是静音
});

test("AI 音频回发 WS + 录 AI 声道(经 24k→16k 重采样)", async () => {
  const { engine, recorder, conn } = await setup();
  // 240 样本 24k(B1):重采样后 ~160 样本 16k 回发 + 录音(同一 16k 时基,B2)
  const out = Buffer.alloc(240 * 2);
  for (let i = 0; i < 240; i++) out.writeInt16LE(((i * 37) % 1000) - 500, i * 2);
  engine.emitAudio(out);
  // 回发即时直发(无限速),无需推 tick。
  const sentBuf = conn.sent.find((s) => Buffer.isBuffer(s)) as Buffer | undefined;
  expect(sentBuf).toBeDefined();
  // 回发的是降采样后的 16k(样本数约为输入 2/3),不再是原始 24k 字节
  const outSamples = sentBuf!.length / 2;
  expect(outSamples).toBeGreaterThanOrEqual(158);
  expect(outSamples).toBeLessThanOrEqual(162);
  // 录音 AI 声道拿到的是同一份 16k(与回发一致,时基对齐;回发即时不限速)
  expect(recorder.ai).toHaveLength(1);
  expect((recorder.ai[0] as Buffer).equals(sentBuf!)).toBe(true);
});

test("asr_final → 转写落库(user)", async () => {
  const { engine, transcripts } = await setup();
  engine.emitFinal("我叫张三");
  expect(transcripts.finals).toEqual([{ speaker: "user", text: "我叫张三" }]);
});

test("AI 本轮文本 → 转写落库(ai),review 双侧转写", async () => {
  const { engine, transcripts } = await setup();
  engine.emitFinal("我叫张三"); // user
  engine.emitLlmText("你好张三,请做个自我介绍。"); // ai
  expect(transcripts.finals).toEqual([
    { speaker: "user", text: "我叫张三" },
    { speaker: "ai", text: "你好张三,请做个自我介绍。" },
  ]);
});

test("WS close → 收尾:停引擎 + 上传录音 + 关连接 + onEnded 回报(design contract:peer_hangup 非 session_end)", async () => {
  const { engine, recorder, conn, endeds } = await setup();
  conn.fireClose();
  await new Promise((r) => setTimeout(r, 0));
  expect(engine.stopped).toBe(true);
  expect(recorder.uploaded).toBe(true);
  expect(conn.closed).toBe(true);
  expect(endeds).toHaveLength(1);
  // design contract(修 design contract bug):WS 裸 close = 物理断连 → peer_hangup(**非** session_end,后者会被游标门拦)。
  expect(endeds[0].reason).toBe("peer_hangup");
});

// design contract 三审(评审:启动窗内 engine.start await 期间 WS close)→ MUST 安全收尾**且完整清理资源**:
//   ①启动期极简 handler 只置 startupAborted,不跑 teardown(避免清在资源起来前);②启动完成后一次性 end →
//   teardown 完整停 engine+recorder(不泄漏,这是 review 三审揪出的永久泄漏根因);③恰好一次 peer_hangup 回报;
//   ④不残留 watchdog(teardown 清 + 不再新启)。
test("design contract:启动窗内(engine.start 中)WS close → 完整清理资源 + 恰好一次 peer_hangup", async () => {
  const engine = new FakeEngine();
  let releaseStart!: () => void;
  const startGate = new Promise<void>((r) => { releaseStart = r; });
  engine.start = async () => { await startGate; engine.started = true; }; // 卡住启动,模拟慢引擎
  const recorder = mkRecorder();
  const transcripts = mkTranscripts();
  const conn = new FakeConn();
  const endeds: EndedInfo[] = [];
  const session = new MediaSession(
    conn,
    { sessionId: "sess_sw", systemPrompt: "p", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: recorder as never, transcripts: transcripts as never, onEnded: (i) => endeds.push(i) },
  );
  const begun = session.begin(); // 不 await:此刻卡在 engine.start 的 startGate
  await new Promise((r) => setTimeout(r, 0));
  conn.fireClose(); // 启动窗内断连 → 极简 handler 置 startupAborted(不 teardown)
  await new Promise((r) => setTimeout(r, 0));
  releaseStart(); // 放行 engine.start;begin() await 返回后检出 startupAborted → end("peer_hangup") 完整清理
  await begun;
  _openSessions.push(session);
  expect(endeds).toHaveLength(1); // 恰好一次回报
  expect(endeds[0].reason).toBe("peer_hangup");
  // ★ 资源完整清理(review 三审:防「teardown 跑在资源起来前 → 泄漏」)——engine/recorder 最终都被停
  expect(engine.stopped).toBe(true); // engine.stop 被调(资源已完整启动后 teardown 清)
  expect(recorder.uploaded).toBe(true); // recorder.stopAndUpload 被调(不泄漏文件/定时器)
  expect(conn.closed).toBe(true); // 连接关闭
  expect((session as unknown as { watchdog: unknown }).watchdog).toBeNull(); // 无残留 watchdog
});

// design contract 四审(评审:engine.onError 也是启动期终止入口,同样不能提前 teardown → 泄漏)。
//   启动期(recorder.start 飞行中)引擎报错 → 只置 startupAborted="error",不 teardown;物化后一次性 end("error") 完整清理。
test("design contract:启动窗内 engine.onError → 完整清理资源(不提前 teardown 泄漏)", async () => {
  const engine = new FakeEngine();
  let releaseRec!: () => void;
  const recGate = new Promise<void>((r) => { releaseRec = r; });
  const recorder = mkRecorder();
  const origStart = recorder.start.bind(recorder);
  recorder.start = async () => { await recGate; return origStart(); }; // 卡住录音启动(engine.start 尚未到)
  const transcripts = mkTranscripts();
  const conn = new FakeConn();
  const endeds: EndedInfo[] = [];
  const session = new MediaSession(
    conn,
    { sessionId: "sess_err", systemPrompt: "p", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: recorder as never, transcripts: transcripts as never, onEnded: (i) => endeds.push(i) },
  );
  const begun = session.begin(); // 卡在 recorder.start 的 recGate
  await new Promise((r) => setTimeout(r, 0));
  engine.emitError("gpu_down", "boom"); // 启动窗内引擎报错 → 只置 startupAborted="error"(onError handler 已注册)
  await new Promise((r) => setTimeout(r, 0));
  releaseRec(); // 放行 recorder.start;后续 engine.start 完成后检出 startupAborted → end("error") 完整清理
  await begun;
  _openSessions.push(session);
  expect(engine.stopped).toBe(true); // 完整清理(不泄漏)
  expect(recorder.uploaded).toBe(true);
  expect(conn.closed).toBe(true);
  expect(endeds).toHaveLength(1);
  expect(endeds[0].reason).toBe("error"); // 引擎错走 error(非 peer_hangup)
});

// design contract 五审(评审:第三个启动期入口 = 外部 manual_hangup,index.ts DELETE /sessions/:id/end 可在
//   begin() 完成前强杀)。根治 = end() 内 `!this.started` guard 收敛所有入口 → 启动期只置标志、物化后统一 teardown。
test("design contract:启动窗内外部 end('manual_hangup')→ 完整清理资源(根治:end 内 guard 收敛)", async () => {
  const engine = new FakeEngine();
  let releaseStart!: () => void;
  const startGate = new Promise<void>((r) => { releaseStart = r; });
  engine.start = async () => { await startGate; engine.started = true; };
  const recorder = mkRecorder();
  const transcripts = mkTranscripts();
  const conn = new FakeConn();
  const endeds: EndedInfo[] = [];
  const session = new MediaSession(
    conn,
    { sessionId: "sess_mh", systemPrompt: "p", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: recorder as never, transcripts: transcripts as never, onEnded: (i) => endeds.push(i) },
  );
  const begun = session.begin(); // 卡在 engine.start
  await new Promise((r) => setTimeout(r, 0));
  void session.end("manual_hangup"); // 外部强杀(模拟 index.ts DELETE)——启动期,end() guard 收敛为置标志
  await new Promise((r) => setTimeout(r, 0));
  releaseStart();
  await begun;
  _openSessions.push(session);
  expect(engine.stopped).toBe(true); // 资源完整清理(不泄漏)
  expect(recorder.uploaded).toBe(true);
  expect(conn.closed).toBe(true);
  expect(endeds).toHaveLength(1); // 恰好一次回报
  expect(endeds[0].reason).toBe("manual_hangup");
});

// design contract 六审(review):detach()(重复 session_id 清旧会话,绕过 end 直接 teardown)在**本会话启动窗**
//   触发也不泄漏——begin 每步 closed 复查兜底。detach reportCompleted=false → 不回报(替换非结束)。
test("design contract:启动窗内 detach() → 完整清理资源、不回报(review)", async () => {
  const engine = new FakeEngine();
  let releaseStart!: () => void;
  const startGate = new Promise<void>((r) => { releaseStart = r; });
  engine.start = async () => { await startGate; engine.started = true; };
  const recorder = mkRecorder();
  const transcripts = mkTranscripts();
  const conn = new FakeConn();
  const endeds: EndedInfo[] = [];
  const session = new MediaSession(
    conn,
    { sessionId: "sess_dt", systemPrompt: "p", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: recorder as never, transcripts: transcripts as never, onEnded: (i) => endeds.push(i) },
  );
  const begun = session.begin(); // 卡在 engine.start
  await new Promise((r) => setTimeout(r, 0));
  void session.detach(); // 重复 session_id → 清旧(本会话此刻在启动窗)
  await new Promise((r) => setTimeout(r, 0));
  releaseStart();
  await begun;
  _openSessions.push(session);
  expect(engine.stopped).toBe(true); // 资源完整清理(不泄漏)
  expect(recorder.uploaded).toBe(true);
  expect(endeds).toHaveLength(0); // detach 不回报(reportCompleted=false)
});

// design contract 六审(review):偏序失败——recorder.start 成功、engine.start **reject** → begin() 抛错,
//   由调用方(index.ts catch)end("error") 收尾;此处直接验 begin() reject 时已 start 的 recorder 能被后续 end 清理不泄漏。
test("design contract:recorder 成功 + engine.start reject → begin 抛错,end('error') 清理不泄漏", async () => {
  const engine = new FakeEngine();
  engine.start = async () => { throw new Error("engine boom"); }; // engine 启动失败
  const recorder = mkRecorder();
  const transcripts = mkTranscripts();
  const conn = new FakeConn();
  const endeds: EndedInfo[] = [];
  const session = new MediaSession(
    conn,
    { sessionId: "sess_pf", systemPrompt: "p", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: recorder as never, transcripts: transcripts as never, onEnded: (i) => endeds.push(i) },
  );
  await expect(session.begin()).rejects.toThrow("engine boom"); // recorder 已 start,engine reject → begin 抛
  await session.end("error"); // 模拟 index.ts catch 的收尾
  _openSessions.push(session);
  expect(recorder.uploaded).toBe(true); // 已 start 的 recorder 被清(不泄漏)
  expect(engine.stopped).toBe(true);
});

// design contract 七审(评审 偏序逃逸):termination 先跑 teardown、engine.start **之后**才 reject
//   → reject 跳过 closed 复查分支 + 调用方 end() 被幂等守挡 → 逃逸。begin() catch 兜底:无论 closed 都停两资源再 re-throw。
test("design contract:teardown 后 engine.start 延迟 reject → catch 兜底清理不泄漏(契约级)", async () => {
  const engine = new FakeEngine();
  let rejectStart!: (e: Error) => void;
  engine.start = () => new Promise<void>((_, rej) => { rejectStart = rej; }); // 挂起,待手动 reject
  const recorder = mkRecorder();
  const transcripts = mkTranscripts();
  const conn = new FakeConn();
  const endeds: EndedInfo[] = [];
  const session = new MediaSession(
    conn,
    { sessionId: "sess_po", systemPrompt: "p", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: recorder as never, transcripts: transcripts as never, onEnded: (i) => endeds.push(i) },
  );
  const begun = session.begin(); // 卡在 engine.start(pending)
  await new Promise((r) => setTimeout(r, 0));
  conn.fireClose(); // 先 termination:teardown 跑、closed=true、engine.stop 调
  await new Promise((r) => setTimeout(r, 0));
  rejectStart(new Error("late reject")); // engine.start **之后**才 reject → begin catch 兜底停资源 + re-throw
  await expect(begun).rejects.toThrow("late reject");
  _openSessions.push(session);
  expect(engine.stopped).toBe(true); // catch 兜底停 engine(不泄漏)
  // ★ 用调用**次数**断言(评审 八审:uploaded 布尔已被首次 teardown 置,证明不了 catch 也清;计数才精确)。
  //   teardown(close 触发)清一次 + begin catch 再兜底一次 → stopCalls≥1 证明 reject 路径资源确被清(幂等多次无害)。
  expect(recorder.stopCalls).toBeGreaterThanOrEqual(1);
});

test("N7:detach() 仅清理资源,**不**触发 onEnded 回报(重复 session_id 替换旧会话不是会话结束)", async () => {
  const { session, endeds, engine, recorder, conn } = await setup();
  await session.detach();
  expect(engine.stopped).toBe(true); // 引擎停了
  expect(recorder.uploaded).toBe(true); // 录音上传了
  expect(conn.closed).toBe(true); // 旧 WS 关了
  expect(endeds).toHaveLength(0); // 但不回报 completed(N4:替换旧会话不是会话结束)
});

test("design contract「新挤旧」:detach() 关旧 WS 前下发 error(superseded),非 ended", async () => {
  const { session, conn } = await setup();
  await session.detach();
  // 旧客户端据 superseded 区分「被新连接取代」与「裸断连」,不当错误重试;不发 ended(那是正常收尾)。
  expect(conn.textFrames()).toEqual([{ type: "error", code: "superseded" }]);
});

test("end() 触发 onEnded 回报(正常收尾,区别于 detach)+ 下发 ended 帧", async () => {
  const { session, endeds, conn } = await setup();
  await session.end("session_end");
  expect(endeds).toHaveLength(1);
  expect(endeds[0].reason).toBe("session_end");
  expect(endeds[0].hasRecording).toBe(true);
  // 正常收尾下发 ended(带 reason),非 superseded
  expect(conn.textFrames()).toEqual([{ type: "ended", reason: "session_end" }]);
});

test("barge-in → cancel(barge_in) + 关回声抑制窗(恢复正常入向)", async () => {
  const { engine, conn, session } = await setup();
  engine.emitAudio(Buffer.from([1, 1])); // AI 说话中 → aiSpeaking=true
  session.onBargeIn();
  expect(engine.cancels).toContain("barge_in");
  // 抑制窗已关:入向恢复喂原帧(非静音)
  const pcm = Buffer.from([7, 7, 7, 7]);
  conn.rxBinary(pcm);
  expect(engine.pushed[engine.pushed.length - 1]).toEqual(pcm);
});

test("design contract:回声抑制喂静音全零 + 长度 = 入向帧长(复用零 buffer,行为等价 Buffer.alloc)", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(Buffer.from([1, 1])); // AI 说话中 → aiSpeaking=true(走回声抑制分支)
  const before = engine.pushed.length;
  const inbound = Buffer.from([9, 9, 9, 9, 9, 9]); // 6 字节真实入向(非零)
  conn.rxBinary(inbound);
  const fed = engine.pushed[engine.pushed.length - 1];
  expect(engine.pushed.length).toBe(before + 1);
  expect(fed.length).toBe(inbound.length);           // 长度 = 入向帧长
  expect([...fed]).toEqual([0, 0, 0, 0, 0, 0]);        // 全零(静音,非入向内容)
});

test("design contract:静音 buffer 扩容——先小帧后大帧,两次都全零且长度正确", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(Buffer.from([1, 1])); // aiSpeaking=true
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    conn.rxBinary(Buffer.from([5, 5, 5, 5]));        // 4B(首次建缓存)
    const f1 = engine.pushed[engine.pushed.length - 1];
    expect(f1.length).toBe(4);
    expect([...f1]).toEqual([0, 0, 0, 0]);
    conn.rxBinary(Buffer.alloc(8, 7));               // 8B(> 缓存 → 扩容)
    const f2 = engine.pushed[engine.pushed.length - 1];
    expect(f2.length).toBe(8);
    expect([...f2]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]); // 扩容后仍全零
    conn.rxBinary(Buffer.from([3, 3]));              // 2B(≤ 缓存 → 切片,不缩容)
    const f3 = engine.pushed[engine.pushed.length - 1];
    expect(f3.length).toBe(2);
    expect([...f3]).toEqual([0, 0]);
  } finally {
    warn.mockRestore();
  }
});

test("回发即时不限速(emitAudio 同步 conn.send,无 tick 延迟,不卡顿)", async () => {
  const { engine, conn } = await setup();
  const out = Buffer.alloc(240 * 2);
  for (let i = 0; i < 240; i++) out.writeInt16LE(((i * 13) % 800) - 400, i * 2);
  engine.emitAudio(out);
  // 即时直发(无需推 tick / 等待)——限速已撤(真机「一顿一顿」否决)
  expect(conn.sent.some((s) => Buffer.isBuffer(s))).toBe(true);
});

test("§3.4 barge-in 扳机:AI 播报期间持续高能量(多帧确认)→ 自动打断;短尖峰不误触发", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(Buffer.from([9, 9])); // AI 说话中 → aiSpeaking=true
  // 单帧高能量(回声尖峰)不触发(BARGE_CONFIRM_MS 默认 200ms,单帧 20ms 不够)
  conn.rxBinary(frame(true));
  expect(engine.cancels.filter((c) => c === 'barge_in').length).toBe(0);
  // 持续高能量(25 帧 × 20ms = 500ms ≥ confirmMs)→ 确认插话 → 打断
  for (let i = 0; i < 25; i++) conn.rxBinary(frame(true));
  expect(engine.cancels).toContain('barge_in');
});

test("§3.4 barge-in 不被 AI 自身回声误触发:中低能量(回声级)持续也不打断", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(Buffer.from([9, 9])); // aiSpeaking=true
  // 造「回声级」帧:RMS 远低于 BARGE 阈值(1500),高于端点阈值——模拟 AI 回声
  const echo = Buffer.alloc(320 * 2);
  for (let i = 0; i < 320; i++) echo.writeInt16LE(i % 2 ? 500 : -500, i * 2); // RMS≈500 < 1500
  for (let i = 0; i < 50; i++) conn.rxBinary(echo);
  expect(engine.cancels.filter((c) => c === 'barge_in').length).toBe(0); // 回声不打断
});

// ── design contract:reference-aware 双讲检测 DTD ──
/** 造一帧指定振幅的 PCM(RMS≈amp);320 样本 = 20ms。 */
function ampFrame(amp: number): Buffer {
  const b = Buffer.alloc(320 * 2);
  for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
}

test("DTD:AI 静默时,中等能量真人(RMS≈900,低于旧固定 1500)也被识别为打断(治漏判)", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50)); // AI 几乎静默(参考峰值≈50)→ 动态门槛 = max(700, 0.3×50≈15)=700(floor 主导)
  // 中等能量真人 RMS≈900:旧固定阈值 1500 会漏(<1500),DTD 地板 700 能识别(≥700)
  for (let i = 0; i < 25; i++) conn.rxBinary(ampFrame(900)); // 持续 ≥ BARGE_CONFIRM_MS
  expect(engine.cancels).toContain("barge_in"); // DTD 识别出被旧阈值漏掉的真人
});

test("DTD:AI 响时,同等能量的 AI 回声不自打断(动态门槛随参考抬高)", async () => {
  // design contract:本例的动态门槛 magic number(方波经 24k→16k 线性插值 ≈0.707× 衰减,参考峰值≈4233)硬编码了
  //   **纯线性重采样**的数值行为。抗混叠低通会平滑方波(去高频)改变降采样峰值 → 门槛漂移。本例测 DTD 逻辑
  //   (与音频质量正交),故 env=0 关低通,固定在其编写时的纯线性行为。低通质量由 resample.test.ts 专测。
  process.env.AIM_TTS_ANTIALIAS = "0";
  try {
    const { engine, conn } = await setup();
    // 固化默认 echoGain=0.3(真机:混音桥回声 ≈ 参考 30%)。AI 大声回发(emitAudio amp=6000,经 24k→16k 降采样后
    // 参考峰值≈4233)→ 动态门槛 = max(700, 0.3×4233)≈1270;同步回声级入向 RMS≈1000(< 1270)→ 不打断。
    // 注:emitAudio 经降采样(方波线性插值衰减≈0.707×),conn.rxBinary 入向不经降采样(直接 16k,RMS=amp)。
    for (let i = 0; i < 25; i++) {
      engine.emitAudio(ampFrame(6000)); // AI 大声 → 刷新 refRms 峰值(降采样后≈4233)
      conn.rxBinary(ampFrame(1000));    // 回声级入向(< 1270 动态门槛)
    }
    expect(engine.cancels.filter((c) => c === "barge_in").length).toBe(0); // 回声不自打断
  } finally {
    delete process.env.AIM_TTS_ANTIALIAS;
  }
});

test("DTD:AI 响时,显著高于回声的真人(RMS≈3000)仍能打断(双讲)", async () => {
  const { engine, conn } = await setup();
  // AI 大声(emitAudio amp=6000 → 降采样后参考≈4233,门槛 = max(700, 0.3×4233)≈1270);真人入向 RMS≈3000 > 1270 → 双讲,应打断
  for (let i = 0; i < 25; i++) {
    engine.emitAudio(ampFrame(6000));
    conn.rxBinary(ampFrame(3000));
  }
  expect(engine.cancels).toContain("barge_in");
});

// ── 确认窗 hangover(治「单帧掉线即清零」对真实语音过苛致漏判)──
test("hangover:真人浊/清音交替(高能量夹杂单帧跌落)仍凑满确认窗触发打断", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50)); // AI 播报(几乎静默参考)→ 门槛 = dtdFloor 700
  // 模拟真实语音:5 帧高能量(100ms)+ 1 帧清音跌落(20ms < hangover 60ms)交替。
  // 旧逻辑每次跌落清零 → 永远凑不满 confirmMs 200;hangover 下跌落只暂停计时,两段 100ms 累计达标。
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5; i++) conn.rxBinary(ampFrame(2000));
    conn.rxBinary(frame(false)); // 单帧清音跌落
  }
  expect(engine.cancels).toContain("barge_in");
});

test("hangover:短促尖峰 + 长静默(超 hangover)不误触发(仍压单帧尖峰)", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(50)); // AI 播报中
  // 3 组「2 帧尖峰(40ms)+ 6 帧静默(120ms > hangover 60ms)」:每组静默都把累计清零 → 永不达 confirmMs。
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 2; i++) conn.rxBinary(ampFrame(2000));
    for (let i = 0; i < 6; i++) conn.rxBinary(frame(false));
  }
  expect(engine.cancels.filter((c) => c === "barge_in").length).toBe(0);
});

test("DTD:参考窗跨轮清空(turn_end 后上轮 AI 峰值不拉高新轮门槛)", async () => {
  const { engine, conn } = await setup();
  engine.emitAudio(ampFrame(2000)); // 上轮 AI 大声 → refRmsWindow 高峰值
  engine.emitTurnEvent();           // turn_end → resetTurn 清空 refRmsWindow
  // 新轮:AI 还没回发(参考已清空)→ 门槛回到 dtdFloor;中等真人 900 ≥ 门槛 → 应打断(不被上轮峰值压制)
  for (let i = 0; i < 25; i++) conn.rxBinary(ampFrame(900));
  expect(engine.cancels).toContain("barge_in");
});

// ── 动态噪声地板(诊断 021-metrics-diagnosis-deployment validation;治高底噪环境误打断)──
// 默认值 dynFloorEnabled=true / windowMs=3000 / K=1.5(turn-handling DEFAULTS)。
// 机制:近窗 AI 静默帧入向 RMS p20 × K 抬高 dtdFloor。高底噪环境(底噪 ~1500)→ 门槛抬到 ~2250,
// AI 一开口不再被环境噪声误判打断;安静环境(底噪≈0)→ 退回固定 dtdFloor 700,不伤真打断。

test("动态噪声地板:高底噪环境(底噪≈1500)下,底噪级入向不再误触发打断", async () => {
  const { engine, conn } = await setup();
  // ① 先喂足够多 AI 静默帧(trackEndpoint 路径,AI 没在播)建立高噪声基线:底噪 RMS≈1500。
  //    p20≈1500 → effectiveFloor = max(700, 1500×1.5)=2250。需 ≥10 帧样本(noiseBaseline 阈值)。
  for (let i = 0; i < 40; i++) conn.rxBinary(ampFrame(1500));
  // ② AI 开口播报(aiSpeaking=true,几乎静默参考)→ 此时持续「底噪级」入向 1500(< 2250 动态门槛)
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 30; i++) conn.rxBinary(ampFrame(1500)); // 底噪级,不应触发(旧固定 floor 700 会误触发)
  expect(engine.cancels.filter((c) => c === "barge_in").length).toBe(0); // 动态地板挡住环境底噪误打断
});

test("动态噪声地板:高底噪环境下,显著高于底噪的真人(RMS≈3500)仍能打断", async () => {
  const { engine, conn } = await setup();
  for (let i = 0; i < 40; i++) conn.rxBinary(ampFrame(1500)); // 高噪声基线 → 门槛≈2250
  engine.emitAudio(ampFrame(50)); // AI 开口(几乎静默参考)
  // 真人显著高于底噪(3500 > 2250 动态门槛)→ 仍应识别为真打断(不因抬高门槛而漏真人)
  for (let i = 0; i < 30; i++) conn.rxBinary(ampFrame(3500));
  expect(engine.cancels).toContain("barge_in");
});

test("动态噪声地板:安静环境(底噪≈0)退回固定 floor,中等真人(900)照常打断(不伤真打断)", async () => {
  const { engine, conn } = await setup();
  // 安静环境:不喂高底噪(或喂静音)→ 噪声基线≈0 → effectiveFloor = max(700, 0×1.5)=700(退回固定 floor)
  for (let i = 0; i < 20; i++) conn.rxBinary(frame(false)); // 静音帧,基线≈0
  engine.emitAudio(ampFrame(50)); // AI 开口
  for (let i = 0; i < 25; i++) conn.rxBinary(ampFrame(900)); // 中等真人 900 ≥ 700 → 打断(与无动态地板时等价)
  expect(engine.cancels).toContain("barge_in");
});

test("动态噪声地板:噪声基线只取 AI 静默帧(AI 播报期回声不污染基线)", async () => {
  const { engine, conn } = await setup();
  // AI 播报期持续高能量入向(含回声)——这些帧走 detectBargeIn 路径,**不**喂 noteNoiseRms(只 trackEndpoint 喂)。
  // 故基线不被 AI 回声抬高;验证:此后安静环境真人 900 仍能打断(基线≈0、floor=700)。
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 30; i++) conn.rxBinary(ampFrame(1500)); // AI 播报期高入向(回声级)——不进基线
  // 基线仍≈0(AI 播报帧未污染);新真人 900 应能打断
  for (let i = 0; i < 25; i++) conn.rxBinary(ampFrame(900));
  expect(engine.cancels).toContain("barge_in");
});

test("动态噪声地板 metrics:barge-in 触发时记录能量四元组(inbound/baseline/refPeak/threshold)", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_bm", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      metrics: metrics as never },
  );
  await session.begin();
  _openSessions.push(session);
  // 触发一次 barge-in
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 25; i++) conn.rxBinary(ampFrame(2000));
  expect(engine.cancels).toContain("barge_in");
  // engine 上报本轮 metrics(bargeIn=true)→ 合并 barge 能量四元组落库
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "partial", bargeIn: true });
  expect(metrics.records).toHaveLength(1);
  const r = metrics.records[0];
  expect(typeof r.bargeInboundRms).toBe("number"); // 触发时入向 RMS(≈2000)
  expect(r.bargeInboundRms as number).toBeGreaterThan(1500);
  expect(typeof r.bargeThreshold).toBe("number");  // 生效门槛
  expect(r.bargeNoiseBaseline).toBeDefined();       // 噪声基线(可能 0,但字段在)
  expect(r.bargeRefPeak).toBeDefined();
});

test("动态噪声地板 metrics:非 barge-in 轮不附能量四元组(guard 防误附)", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_bm2", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      metrics: metrics as never },
  );
  await session.begin();
  _openSessions.push(session);
  // 正常轮(无 barge):engine 上报 bargeIn=false → 不附 barge 四元组
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "full", bargeIn: false });
  expect(metrics.records).toHaveLength(1);
  expect(metrics.records[0].bargeInboundRms).toBeUndefined();
  expect(metrics.records[0].bargeThreshold).toBeUndefined();
});

test("动态噪声地板 metrics:陈旧 barge 四元组在 turn_end 跨轮清空,不误附给下一 barge 轮(review 竞态修复)", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_bm3", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      metrics: metrics as never },
  );
  await session.begin();
  _openSessions.push(session);
  // 第 1 轮:barge 触发写 pendingBargeMetrics,但模拟 ttsPending===0 路径——engine **不**当场 onMetrics(四元组未消费)
  engine.emitAudio(ampFrame(50));
  for (let i = 0; i < 25; i++) conn.rxBinary(ampFrame(2000));
  expect(engine.cancels).toContain("barge_in");
  expect((session as unknown as { pendingBargeMetrics: unknown }).pendingBargeMetrics).not.toBeNull(); // 残留(未被同步消费)
  // turn_end(新一轮)→ resetTurn 清空陈旧四元组
  engine.emitTurnEvent();
  expect((session as unknown as { pendingBargeMetrics: unknown }).pendingBargeMetrics).toBeNull(); // 跨轮已清
  // 第 2 轮 engine 上报 bargeIn=true(但本轮其实没真触发 detectBargeIn)→ 不应误附上一轮的陈旧四元组
  engine.emitMetrics({ turnIndex: 2, engineType: "three_stage", played: "partial", bargeIn: true });
  const r2 = metrics.records[metrics.records.length - 1];
  expect(r2.turnIndex).toBe(2);
  expect(r2.bargeInboundRms).toBeUndefined(); // 陈旧四元组已清,未误附
});

// 注:DTD 关(AIM_BARGE_DTD=0)/ 动态地板关(AIM_BARGE_DYN_FLOOR=0)回退固定阈值的开关,由 turn-handling.test.ts
// 在配置层覆盖(模块级 TH 在 import 时固化,单测内切 env 不便;配置层验证等价且更稳)。

test("引擎 error → 收尾", async () => {
  const { engine, recorder } = await setup();
  engine.emitError("gpu_error", "ws closed");
  await new Promise((r) => setTimeout(r, 0));
  expect(recorder.uploaded).toBe(true);
});

// ── 端点看门狗(真机根因:GPU VAD 因底噪不出 turn_end → AI 不回话;服务侧兜底端点)──
/** 造一帧 16k s16le PCM:loud=高 RMS(算说话),否则静音。每帧 320 样本 = 20ms。 */
function frame(loud: boolean): Buffer {
  const samples = 320;
  const b = Buffer.alloc(samples * 2);
  if (loud) for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 ? 4000 : -4000, i * 2);
  return b;
}

// ★ design contract:端点静音 gap 的默认值由 900 改为 1500(B 类),原先硬编码「60 帧 + 1200ms」不再够 gap。
//   改为**从权威默认值派生**帧数与推进时长 —— 下次再调默认值时这些测试不会因硬编码而假红/假绿。
//   帧长 320 samples @16k = 20ms;多推 +10 帧余量确保跨过阈值。
const SILENCE_GAP_MS = TURN_HANDLING_DEFAULTS.endpointing.silenceGapMs;
const FRAME_MS = 20;
const SILENCE_FRAMES = Math.ceil(SILENCE_GAP_MS / FRAME_MS) + 10;
const SILENCE_ADVANCE_MS = SILENCE_GAP_MS + 300;

test("看门狗:说话→静默超过 gap → 主动 endTurn(GPU VAD 不出 turn_end 的兜底)", async () => {
  jest.useFakeTimers();
  try {
    const engine = new FakeEngine();
    const conn = new FakeConn();
    const session = new MediaSession(
      conn,
      { sessionId: "sess_wd", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
      { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never },
    );
    await session.begin();
    // 说话 ~400ms(20 帧 loud,超过 MIN_SPEECH 300ms)→ turnPending
    for (let i = 0; i < 20; i++) conn.rxBinary(frame(true));
    expect(engine.endTurns).toBe(0); // 还在说,不触发
    // 静默推进时间过 gap(900ms):喂静音帧 + 跑定时器
    for (let i = 0; i < SILENCE_FRAMES; i++) conn.rxBinary(frame(false));
    jest.advanceTimersByTime(SILENCE_ADVANCE_MS);
    expect(engine.endTurns).toBe(1); // 端点命中 → flush
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("aiSpeaking 安全看门狗:AI 音频停 >8s 无 onAiDone → 强制恢复收听(MiniMax 慢/丢 tts_done 兜底)", async () => {
  jest.useFakeTimers();
  try {
    const engine = new FakeEngine();
    const conn = new FakeConn();
    const session = new MediaSession(
      conn,
      { sessionId: "sess_aiwd", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
      { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never },
    );
    await session.begin();
    // AI 开口 → aiSpeaking=true;此后**不** emitAiDone(模拟 MiniMax 慢/丢 tts_done → onAiDone 永不来)
    engine.emitAudio(Buffer.from([9, 9]));
    expect((session as unknown as { aiSpeaking: boolean }).aiSpeaking).toBe(true);
    // 推进 < 8s:仍卡 true(看门狗未到阈值,不误恢复)
    jest.advanceTimersByTime(5000);
    expect((session as unknown as { aiSpeaking: boolean }).aiSpeaking).toBe(true);
    // 推进过 8s:安全看门狗强制恢复 → aiSpeaking=false(不再永久哑)
    jest.advanceTimersByTime(4000);
    expect((session as unknown as { aiSpeaking: boolean }).aiSpeaking).toBe(false);
    // 恢复后:participant 说话 + 静默 → 端点看门狗能再触发 turn(此前被 aiSpeaking 卡死则恒 0)
    for (let i = 0; i < 20; i++) conn.rxBinary(frame(true));
    for (let i = 0; i < SILENCE_FRAMES; i++) conn.rxBinary(frame(false));
    jest.advanceTimersByTime(SILENCE_ADVANCE_MS);
    expect(engine.endTurns).toBeGreaterThanOrEqual(1);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("aiSpeaking 安全看门狗:正常 onAiDone 路径不受影响(AI 说完即恢复,不等 8s)", async () => {
  jest.useFakeTimers();
  try {
    const engine = new FakeEngine();
    const conn = new FakeConn();
    const session = new MediaSession(
      conn,
      { sessionId: "sess_aiwd2", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
      { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never },
    );
    await session.begin();
    engine.emitAudio(Buffer.from([9, 9]));
    expect((session as unknown as { aiSpeaking: boolean }).aiSpeaking).toBe(true);
    engine.emitAiDone(); // 正常 tts_done 路径 → 立即恢复,无需等看门狗
    expect((session as unknown as { aiSpeaking: boolean }).aiSpeaking).toBe(false);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("看门狗:自然 turn_end 先到 → 不重复 endTurn", async () => {
  jest.useFakeTimers();
  try {
    const engine = new FakeEngine();
    const conn = new FakeConn();
    const session = new MediaSession(
      conn,
      { sessionId: "sess_wd2", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
      { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never },
    );
    await session.begin();
    for (let i = 0; i < 20; i++) conn.rxBinary(frame(true)); // 说话 → turnPending
    engine.emitTurnEvent(); // GPU 自然 turn_end 到 → resetTurn
    for (let i = 0; i < SILENCE_FRAMES; i++) conn.rxBinary(frame(false));
    jest.advanceTimersByTime(SILENCE_ADVANCE_MS);
    expect(engine.endTurns).toBe(0); // 已被自然 turn_end 重置,看门狗不再触发
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("看门狗:flush 后无自然 turn_end → 下个 gap 周期有界重试(不吞掉这轮)", async () => {
  jest.useFakeTimers();
  try {
    const engine = new FakeEngine();
    const conn = new FakeConn();
    const session = new MediaSession(
      conn,
      { sessionId: "sess_wd4", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
      { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never },
    );
    await session.begin();
    for (let i = 0; i < 20; i++) conn.rxBinary(frame(true)); // 说话 → turnPending
    for (let i = 0; i < SILENCE_FRAMES; i++) conn.rxBinary(frame(false)); // 静默
    jest.advanceTimersByTime(SILENCE_ADVANCE_MS); // 第一次 flush(design contract:gap 由默认值派生)
    expect(engine.endTurns).toBe(1);
    // GPU flush 没真出 turn_end(模拟丢失)→ 再过一个 gap,看门狗重试(有界,不刷屏)
    jest.advanceTimersByTime(SILENCE_ADVANCE_MS);
    expect(engine.endTurns).toBe(2);
    // 自然 turn_end 终于到 → 停止重试
    engine.emitTurnEvent();
    jest.advanceTimersByTime(2000);
    expect(engine.endTurns).toBe(2);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("看门狗:只有短促底噪(不足 MIN_SPEECH)→ 不误触发", async () => {
  jest.useFakeTimers();
  try {
    const engine = new FakeEngine();
    const conn = new FakeConn();
    const session = new MediaSession(
      conn,
      { sessionId: "sess_wd3", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
      { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never },
    );
    await session.begin();
    // 仅 5 帧 loud(100ms < MIN_SPEECH 300ms):不算有效一轮
    for (let i = 0; i < 5; i++) conn.rxBinary(frame(true));
    for (let i = 0; i < SILENCE_FRAMES; i++) conn.rxBinary(frame(false));
    jest.advanceTimersByTime(SILENCE_ADVANCE_MS);
    expect(engine.endTurns).toBe(0); // 短促底噪不触发(turnPending 未置位)
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

// ── #3 语义收尾:告别后 AI 说完 → 主动收尾(关连接 + onEnded 回报)──

/** 语义收尾用例的共用装配:注入 onEnded 记录数组(替代电话版的 hangup 记录)。 */
function setupSemantic(sessionId: string) {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const endeds: EndedInfo[] = [];
  const session = new MediaSession(
    conn,
    { sessionId, systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      onEnded: (info) => { endeds.push(info); } },
  );
  return { engine, conn, session, endeds };
}

test("语义收尾:LLM 两步确认后发结束信号 → onAiDone 后延迟主动收尾(onEnded 回报)", async () => {
  // design contract 改:SEMANTIC_END 开时,收尾**只**由 LLM 的 [[END_CALL]](endCallSignal,已两步确认门控)驱动,
  // AI 单说「拜拜」不收尾(那是误判根源)。此处模拟 LLM 确认后发结束信号 → 应延迟主动收尾。
  jest.useFakeTimers();
  try {
    const { engine, conn, session, endeds } = setupSemantic("sess_fw");
    await session.begin();
    engine.emitFinal("嗯,没有了,好吧,拜拜。"); // 用户道别
    engine.emitLlmText("好的,拜拜!"); // AI 回告别
    engine.endCallSignal = true; // LLM 已两步确认 → 输出 [[END_CALL]](wantsEndCall=true)
    expect(endeds).toHaveLength(0); // AI 还没说完,不收尾
    engine.emitAiDone(); // AI 说完 → 启动延迟收尾
    expect(endeds).toHaveLength(0); // 延迟未到
    await jest.advanceTimersByTimeAsync(2000); // 过 FAREWELL_HANGUP_DELAY_MS(1500)+ flush end() 的 async 链
    expect(endeds).toHaveLength(1); // 主动收尾(关连接 + 回报)
    expect(endeds[0].reason).toBe("session_end");
    expect(conn.closed).toBe(true);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾(design contract):AI 单说「拜拜」但无 LLM 结束信号 → **不收尾**(治 ASR 误识→AI 误说再见→误收尾)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_nofw2");
    await session.begin();
    engine.emitLlmText("好的,那你去忙吧,拜拜!"); // AI 说了拜拜,但 endCallSignal=false(LLM 未两步确认)
    engine.emitAiDone();
    await jest.advanceTimersByTimeAsync(3000);
    expect(endeds).toHaveLength(0); // 不收尾(真机误判根源:AI 一说拜拜就收尾 → 已禁)
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾(回归):引擎不实现 wantsEndCall → 回退正则告别兜底,仍能收尾", async () => {
  // 评审 P0 纠偏:无 LLM 语义结束信号的引擎(不实现 wantsEndCall)若收尾一律只认 wantsEnd,
  // 其 wantsEnd 恒 false + 正则被忽略 → **永不收尾**(回归)。修复:hasLlmEndSignal 需引擎实现 wantsEndCall;
  // 否则回退正则告别。此处用「删去 wantsEndCall 的引擎」验证兜底路径仍走正则、双方告别后能正常收尾。
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_regex_fw");
    // 模拟不提供 LLM 语义结束信号的引擎(接口 wantsEndCall? 可选)。
    (engine as unknown as { wantsEndCall?: () => boolean }).wantsEndCall = undefined;
    await session.begin();
    engine.emitFinal("好的没有了,拜拜。"); // 用户道别
    engine.emitLlmText("好的,再见,拜拜~"); // AI 也告别(正则命中)→ 兜底收尾
    engine.emitAiDone();
    await jest.advanceTimersByTimeAsync(2000);
    expect(endeds).toHaveLength(1); // 正则兜底仍生效,不退化为永不收尾
    expect(endeds[0].reason).toBe("session_end");
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾:普通对话(无告别)→ AI 说完不收尾", async () => {
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_nofw");
    await session.begin();
    engine.emitFinal("明年是闰年吗?"); // 普通问题,非告别
    engine.emitLlmText("2027 年不是闰年,下一个闰年是 2028 年。");
    engine.emitAiDone();
    await jest.advanceTimersByTimeAsync(3000);
    expect(endeds).toHaveLength(0); // 不收尾,继续对话
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾:LLM 信号(wantsEndCall)触发收尾,优先于正则", async () => {
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_llmend");
    await session.begin();
    // 用户话不含字面告别词(正则不命中),但 LLM 语义判定该结束 → wantsEndCall=true
    engine.emitFinal("行吧那今天就到这儿");
    engine.endCallSignal = true; // 模拟 LLM 输出了 [[END_CALL]]
    engine.emitAiDone();
    await jest.advanceTimersByTimeAsync(2000);
    expect(endeds).toHaveLength(1); // LLM 语义信号触发收尾
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾竞态:正则置 farewellPending 后 barge-in 打断 → onBargeIn 清标志,不误收尾", async () => {
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_bargefw");
    await session.begin();
    engine.emitLlmText("好的,拜拜"); // AI 告别 → 正则置 farewellPending
    // AI 还在播「拜拜」音频,aiSpeaking=true(emitAudio 置位);用户插话打断:
    engine.emitAudio(Buffer.from([0, 0])); // 触发 aiSpeaking=true(走 onAudioOut)
    session.onBargeIn();                    // 打断 → 应清 farewellPending
    engine.emitAiDone();                    // cancel 触发的 aiDoneCb
    await jest.advanceTimersByTimeAsync(3000);
    expect(endeds).toHaveLength(0); // 用户插话想继续 → 不误收尾(竞态修复)
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾:否定句不误收尾(我还不想挂电话)— 正则否定保护", async () => {
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_neg");
    await session.begin();
    engine.emitFinal("我还不想挂电话"); // 含告别词但否定 → 不应收尾(防误断正在对话的人)
    engine.emitLlmText("好的,那我们继续聊。"); // LLM 不输出结束信号(endCallSignal 默认 false)
    engine.emitAiDone();
    await jest.advanceTimersByTimeAsync(3000);
    expect(endeds).toHaveLength(0); // 不误收尾
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾:收尾 timer 排程后窗内用户又开口(有效语音)→ 取消收尾(更稳)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn, session, endeds } = setupSemantic("sess_cancel");
    await session.begin();
    engine.emitLlmText("好的,拜拜"); // 告别 → farewellPending
    engine.emitAiDone();              // AI 说完 → 排程 1.5s 收尾 timer
    // 收尾窗内(还没到 1.5s)用户又开口:喂 ~20 帧有效语音(超 MIN_SPEECH 300ms)
    for (let i = 0; i < 20; i++) conn.rxBinary(frame(true));
    await jest.advanceTimersByTimeAsync(3000); // 推过原收尾点
    expect(endeds).toHaveLength(0); // timer 被取消,不收尾(用户改主意继续聊)
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

// ── design contract:自由聊天(无题)挂断硬闸门 blockedByOpenChat(两步确认 latch,非 lifetime sticky)──
describe("design contract:自由聊天不主动挂(blockedByOpenChat)", () => {
  test("无题 + 从未离开意图 + LLM [[END_CALL]] → 压制,不挂(AI 主动收尾被硬闸门拦)", async () => {
    jest.useFakeTimers();
    try {
      const { engine, session, endeds } = setupSemantic("sess_oc_block");
      engine.hasQ = false; // 自由聊天(无题)
      await session.begin();
      // 普通闲聊,用户从没说要走;但 LLM 聊几轮"感觉聊完了"误输出 [[END_CALL]]
      engine.emitFinal("今天天气不错啊");
      engine.emitLlmText("是啊,这样的天气很适合出门走走。");
      engine.endCallSignal = true; // LLM 误判该结束(自由聊天诱因)→ wantsEndCall=true
      engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(3000);
      expect(endeds).toHaveLength(0); // ★ blockedByOpenChat 压制:AI 不许主动挂自由聊天
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("无题 + 用户「我要走了」→ AI 确认 → 用户「没有了」(本轮不含告别词)→ 放行挂断(★关键:latch 非本轮匹配)", async () => {
    jest.useFakeTimers();
    try {
      const { engine, session, endeds } = setupSemantic("sess_oc_release");
      engine.hasQ = false; // 自由聊天
      await session.begin();
      // 第一步:用户明确离开意图(isUserLeaveIntent 命中 → latch=LEAVE_PENDING)
      engine.emitFinal("好啦我要走了");
      engine.emitLlmText("好的,还有其他想聊的吗?没有的话我就先不打扰你了。"); // AI 两步确认(不发结束信号)
      engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(100);
      expect(endeds).toHaveLength(0); // 确认轮不挂
      // 第二步:用户仅回"没有了"(**不含**告别词)→ 若用"本轮匹配"判会误压制永远挂不掉;latch 保持 → 放行
      engine.emitFinal("没有了");
      engine.emitLlmText("好的,那就先这样,拜拜。");
      engine.endCallSignal = true; // LLM 两步确认后输出 [[END_CALL]]
      engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(2000);
      expect(endeds).toHaveLength(1); // ★ 放行:用户已表达离开意图 + 两步确认走完
      expect(endeds[0].reason).toBe("session_end");
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("★stale-intent 撤销(防误挂):无题 + 早期一次离开意图 → 继续实质聊天 → 之后 LLM 误 [[END_CALL]] → 不挂", async () => {
    jest.useFakeTimers();
    try {
      const { engine, session, endeds } = setupSemantic("sess_oc_stale");
      engine.hasQ = false;
      await session.begin();
      // 用户说了句含离开意图的话(进 LEAVE_PENDING)
      engine.emitFinal("我等下可能要走了");
      engine.emitLlmText("好的,那在你走之前还想聊点什么吗?");
      engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(50);
      // 但用户改主意继续实质聊天(命中 FAREWELL_CONTINUE / 实质新内容 → 清 latch 回 IDLE)
      engine.emitFinal("其实我们再聊聊你刚说的那个话题吧");
      engine.emitLlmText("当然可以,我们接着聊。");
      engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(50);
      // 又聊几轮后 LLM 误输出 [[END_CALL]]——此时 latch 已清,应被压制不挂(否则陈旧离开意图=定时炸弹)
      engine.emitFinal("这个观点挺有意思的");
      engine.emitLlmText("是的,还可以从另一个角度看。");
      engine.endCallSignal = true;
      engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(3000);
      expect(endeds).toHaveLength(0); // ★ latch 已被继续对话清除 → 不误挂(守住宁漏挂不误挂)
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("★B1/C2:latch 放弃计数按 AI 轮(非用户轮)——用户连说多句中性词、AI 未回,不提前清 latch", async () => {
    jest.useFakeTimers();
    try {
      const { engine, session, endeds } = setupSemantic("sess_oc_aiturn");
      engine.hasQ = false;
      await session.begin();
      engine.emitFinal("我要走了"); // 进 LEAVE_PENDING
      // 用户在 AI 还没回话时连说 3 句中性纯确认(模拟 ASR 分段/用户碎碎念)——若按"用户轮"计数会到 MAX 提前清 latch
      engine.emitFinal("嗯");
      engine.emitFinal("好的");
      engine.emitFinal("没有了");
      // 现在 AI 第一次两步确认后收尾:latch 应仍 PENDING(AI 轮才刚第 1 轮)→ 放行挂断
      engine.emitLlmText("好的,那就先这样,拜拜。");
      engine.endCallSignal = true;
      engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(2000);
      expect(endeds).toHaveLength(1); // ★ 放行:用户多句中性词不该按用户轮耗尽计数误清 latch
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("★B1/C2:放弃防御按 AI 轮——latch pending 后 AI 连过 N 轮未挂未确认 → 清 latch(不误挂)", async () => {
    jest.useFakeTimers();
    try {
      const { engine, session, endeds } = setupSemantic("sess_oc_abandon");
      engine.hasQ = false;
      await session.begin();
      engine.emitFinal("我要走了"); // 进 LEAVE_PENDING(AI 轮计数=0)
      // AI 连过 2 轮都没挂也没确认(LLM 飘了继续聊别的)——达 LEAVE_PENDING_MAX_TURNS=2 → 放弃防御清 latch
      engine.emitLlmText("对了,说到这个我想起来一件事。"); engine.emitAiDone(); // AI 轮 1
      await jest.advanceTimersByTimeAsync(50);
      engine.emitLlmText("其实还有个有意思的角度。"); engine.emitAiDone(); // AI 轮 2 → 清 latch
      await jest.advanceTimersByTimeAsync(50);
      // 此后 AI 误输出 [[END_CALL]] → latch 已清 → 不挂
      engine.emitLlmText("那就到这里吧。"); engine.endCallSignal = true; engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(3000);
      expect(endeds).toHaveLength(0); // ★ 放弃防御后 latch 清 → 陈旧离开意图不误挂
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("★F1/M2:两步确认第二步「没有了谢谢你辛苦了」(纯确认+客套,9 字 > 旧阈值 8)不误当实质新内容 → 仍放行挂断", async () => {
    jest.useFakeTimers();
    try {
      const { engine, session, endeds } = setupSemantic("sess_oc_polite");
      engine.hasQ = false;
      await session.begin();
      engine.emitFinal("我要走了"); // 进 LEAVE_PENDING
      engine.emitLlmText("好的,还有其他想聊的吗?"); engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(50);
      // 第二步:纯确认 + 客套(9 字,超旧 length>=8 阈值会被误判"实质新内容"→ 清 latch → 挂不掉)。语义仍是"没有了"。
      engine.emitFinal("没有了谢谢你辛苦了");
      engine.emitLlmText("好的,那就先这样,拜拜。"); engine.endCallSignal = true; engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(2000);
      expect(endeds).toHaveLength(1); // ★ 纯确认+客套不误判实质新内容,latch 保持 → 放行
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("回归:有题(hasQuestions=true)不受 blockedByOpenChat 影响 → 现状挂断行为不变", async () => {
    jest.useFakeTimers();
    try {
      const { engine, session, endeds } = setupSemantic("sess_oc_exam");
      engine.hasQ = true; // 有题(测评)
      engine.pending = false; // 题已问完(hasPendingQuestions=false)→ 正常收尾语境
      await session.begin();
      engine.emitFinal("好的没有了");
      engine.emitLlmText("好的,那就到这里,再见。");
      engine.endCallSignal = true;
      engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(2000);
      expect(endeds).toHaveLength(1); // 有题问完:blockedByOpenChat 恒 false → 正常收尾(现状不变)
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

// ── design contract:isUserLeaveIntent 语料(变异自证——独立契约,不复用 isFarewell 的后缀锚定)──
describe("design contract:isUserLeaveIntent 短语语料", () => {
  test("正例:句尾告别 + 非句尾离开意图都命中", () => {
    // 句尾告别(旧 isFarewell 也认)
    expect(isUserLeaveIntent("好的没有了,拜拜")).toBe(true);
    expect(isUserLeaveIntent("那就再见吧")).toBe(true);
    // ★ 非句尾离开意图(旧 isFarewell 后缀锚定认不出,review 核心)
    expect(isUserLeaveIntent("我要走了")).toBe(true);
    expect(isUserLeaveIntent("我得走了先")).toBe(true);
    expect(isUserLeaveIntent("不聊了")).toBe(true);
    expect(isUserLeaveIntent("我要去忙了")).toBe(true);
    expect(isUserLeaveIntent("结束吧")).toBe(true);
    expect(isUserLeaveIntent("bye")).toBe(true);
  });

  test("负例:否定意愿(FAREWELL_NEGATION)不算离开", () => {
    expect(isUserLeaveIntent("我不是要走")).toBe(false);
    expect(isUserLeaveIntent("先别挂")).toBe(false);
    expect(isUserLeaveIntent("我还不想结束")).toBe(false);
  });

  test("负例:继续意愿(FAREWELL_CONTINUE)不算离开", () => {
    expect(isUserLeaveIntent("我们继续聊")).toBe(false);
    expect(isUserLeaveIntent("还有个问题")).toBe(false);
  });

  test("★负例:引述他人(转告)不算本人离开意图(review)", () => {
    expect(isUserLeaveIntent("他让我跟你说拜拜")).toBe(false);
    expect(isUserLeaveIntent("帮我转告他再见")).toBe(false);
  });

  test("与旧 isFarewell 的差异用例:「我要走了」isFarewell 后缀锚定认不出,isUserLeaveIntent 认得出", () => {
    // isFarewell 未导出,此处以行为差异佐证:isUserLeaveIntent 命中「我要走了」(句中离开意图)
    expect(isUserLeaveIntent("我要走了")).toBe(true);
    expect(isUserLeaveIntent("")).toBe(false); // 空串保守 false
  });

  test("★负例(review 误挂风险):疑问/反问句不算离开意图(宁漏挂不误挂)", () => {
    expect(isUserLeaveIntent("我要走了吗")).toBe(false);   // 反问/自问
    expect(isUserLeaveIntent("我要走了吗?")).toBe(false);
    expect(isUserLeaveIntent("我先走了吗?")).toBe(false);
    expect(isUserLeaveIntent("现在是不是该结束了呢")).toBe(false); // 疑问语气
  });

  test("★负例(review):句中/句尾否定离开(我不走了)不算离开意图", () => {
    expect(isUserLeaveIntent("算了我不走了")).toBe(false);
    expect(isUserLeaveIntent("我要走了,算了我不走了")).toBe(false); // 先扬后抑:最终不走
    expect(isUserLeaveIntent("还不想走")).toBe(false);
  });
});

test("语义收尾:收尾窗内用户刚开口(不足 MIN_SPEECH)也立即取消收尾(敏感撤销)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn, session, endeds } = setupSemantic("sess_sensitive");
    await session.begin();
    engine.emitLlmText("好的,拜拜"); // 告别 → farewellPending
    engine.emitAiDone();              // 排程 1.5s 收尾
    // 用户在收尾窗内刚开口:只喂 5 帧(100ms < MIN_SPEECH 300ms)——不足以认定有效一轮,但应立即撤销收尾。
    for (let i = 0; i < 5; i++) conn.rxBinary(frame(true));
    await jest.advanceTimersByTimeAsync(3000);
    expect(endeds).toHaveLength(0); // 刚开口即撤销,不收尾(修「1.3s 开口到 1.5s 才 200ms 仍被断」边界)
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾:AI 说完告别前的短促残留声(<MIN_SPEECH)不影响 → 双方告别仍正常收尾", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn, session, endeds } = setupSemantic("sess_residual");
    await session.begin();
    engine.emitFinal("好的没有了拜拜"); // 用户告别
    // AI 还没说完(未 emitAiDone)期间,来了 3 帧残留声/底噪(< MIN_SPEECH 300ms)
    for (let i = 0; i < 3; i++) conn.rxBinary(frame(true));
    engine.emitLlmText("好的,拜拜"); // AI 回告别
    engine.endCallSignal = true;       // design contract:LLM 两步确认后发结束信号(收尾只认此,不认正则)
    engine.emitAiDone();               // AI 说完 → 排程收尾
    await jest.advanceTimersByTimeAsync(2000);
    expect(endeds).toHaveLength(1); // 正常收尾(该收的收)
    expect(endeds[0].reason).toBe("session_end");
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾:用户道别 → AI 挽留(非告别回复)+ 用户静默 → 不误收尾(收尾需 AI 本轮也告别)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_decline");
    await session.begin();
    engine.emitFinal("好的没有了拜拜");        // 用户道别 → userSaidFarewell(仅上下文)
    engine.emitLlmText("别走呀,我们再聊几句"); // AI 挽留(非告别)→ aiSaidFarewellThisTurn=false
    engine.emitAiDone();                       // AI 说完;用户静默(无新语音)
    await jest.advanceTimersByTimeAsync(3000);
    expect(endeds).toHaveLength(0); // AI 拒绝结束 → 不收尾
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾 C9:用户道别 + 本轮 LLM 报错(无 onLlmText)→ onAiDone 不收尾(AI 没真回话不空断)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_llmerr");
    await session.begin();
    engine.emitFinal("好的拜拜");  // 用户道别 → userSaidFarewell
    // LLM 流抛错路径:three-stage-engine catch 分支调 aiDoneCb 但**不调** llmTextCb(模拟之)
    engine.emitAiDone();           // 本轮无 onLlmText → aiSaidFarewellThisTurn=false → 不收尾
    await jest.advanceTimersByTimeAsync(3000);
    expect(endeds).toHaveLength(0); // AI 因报错没回话,绝不空断
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾 C2:AI 回复『继续聊…拜拜~』(挽留+客套收尾)句尾告别词 → 不误收尾", async () => {
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_mixed");
    await session.begin();
    engine.emitFinal("我有点问题");
    engine.emitLlmText("我们继续聊吧,有问题再问我,拜拜~"); // 含「继续」→ FAREWELL_CONTINUE 否决 → 非告别
    engine.emitAiDone();
    await jest.advanceTimersByTimeAsync(3000);
    expect(endeds).toHaveLength(0); // 客套收尾不误判告别
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾(design contract):AI 含『另外…拜拜』但 LLM 未发结束信号 → **不收尾**(收尾须 LLM 两步确认)", async () => {
  // design contract 改:SEMANTIC_END 开时收尾只认 LLM 的 endCallSignal,AI 文本含拜拜的正则判定不再单独驱动收尾
  //(治真机 ASR 误识→AI 误说再见→误收尾)。LLM 真要结束会经两步确认后发 [[END_CALL]],届时才收(见上一组用例)。
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_farewell_conj");
    await session.begin();
    engine.emitFinal("好的就这样");
    engine.emitLlmText("祝你工作顺利,另外有问题随时联系,拜拜~"); // 含拜拜但 endCallSignal=false
    engine.emitAiDone();
    await jest.advanceTimersByTimeAsync(2000);
    expect(endeds).toHaveLength(0); // 不收尾:无 LLM 结束信号,AI 一句拜拜不再触发收尾
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾(design contract):AI 含『继续保持联系…拜拜』但无 LLM 结束信号 → 不收尾", async () => {
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_farewell_jixu");
    await session.begin();
    engine.emitFinal("好的就这样");
    engine.emitLlmText("好的,继续保持联系,拜拜~"); // 含拜拜但 endCallSignal=false
    engine.emitAiDone();
    await jest.advanceTimersByTimeAsync(2000);
    expect(endeds).toHaveLength(0); // 不收尾(同上,收尾须 LLM 两步确认)
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("语义收尾 C17:用户先道别又改主意(下个 final 非告别)+ AI 非告别 → 不收尾(对称清旗)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, session, endeds } = setupSemantic("sess_changemind");
    await session.begin();
    engine.emitFinal("好的拜拜");        // 用户道别 → userSaidFarewell=true
    engine.emitFinal("等等还有个事");    // 改主意(非告别)→ userSaidFarewell=false(对称清)
    engine.emitLlmText("好的你说");      // AI 非告别
    engine.emitAiDone();
    await jest.advanceTimersByTimeAsync(3000);
    expect(endeds).toHaveLength(0); // 用户改主意 → 不收尾
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

// ── design contract:每轮 metrics 端点段采集 + 与 engine 段合并落库 ──

test("metrics:engine 段 + 端点段按 turn 合并落库,turn_end_source=gpu_vad", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_m1", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      metrics: metrics as never },
  );
  await session.begin();
  _openSessions.push(session); // afterEach detach 停看门狗/主动开场真定时器(防泄漏到测试后)
  // 对方说话 → asr_final → 静默后 GPU 自然 turn_end(本轮无 watchdog flush)
  for (let i = 0; i < 20; i++) conn.rxBinary(frame(true)); // 有效语音 → lastSpeechAtMs
  engine.emitFinal("我叫张三");
  engine.emitTurnEvent(); // turn_end:采集端点段(gpu_vad,因没 flush)
  // engine 段上报(模拟引擎 onMetrics)
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", llmTtftMs: 120, played: "full", bargeIn: false });
  expect(metrics.records).toHaveLength(1);
  const r = metrics.records[0];
  expect(r.sessionId).toBe("sess_m1");
  expect(r.turnIndex).toBe(1);
  expect(r.played).toBe("full");
  expect(r.llmTtftMs).toBe(120);
  expect(r.turnEndSource).toBe("gpu_vad"); // 端点段合并进来了
  expect(typeof r.eouDelayMs).toBe("number"); // 「对方停说」→ turn_end 时延
  expect(typeof r.asrFinalDelayMs).toBe("number");
  expect(typeof r.tsIso).toBe("string");
});

test("metrics:e2e_latency 由「参会者停说→AI 首帧」两绝对时刻相减采集(design contract)", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_e2e", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      metrics: metrics as never },
  );
  await session.begin();
  _openSessions.push(session);
  // 一问一答:说话 → final → turn_end(锚定「参会者停说」)→ AI 首帧流出(算 e2e)→ engine 上报
  for (let i = 0; i < 20; i++) conn.rxBinary(frame(true));
  engine.emitFinal("你好");
  engine.emitTurnEvent();          // 锚定 turnStopSpeakingAtMs = lastSpeechAtMs
  engine.emitAudio(Buffer.alloc(48)); // AI 首帧 → 写 pendingEndpoint.e2eLatencyMs
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "full", bargeIn: false });
  const r = metrics.records[0];
  expect(typeof r.e2eLatencyMs).toBe("number");
  expect(r.e2eLatencyMs).toBeGreaterThanOrEqual(0);
  // 不是分段字段累加(独立采集,与 eou/tts_ttfb 无代数关系):这里只断言存在且非负,口径由实现保证
});

test("metrics:kickoff 主动开场轮无「参会者停说」锚点 → 不采 e2e_latency(留空)", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_e2e_ko", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      metrics: metrics as never },
  );
  await session.begin();
  _openSessions.push(session);
  // 无 turn_end(没锚点)直接 AI 首帧 + 上报(模拟 kickoff 开场)
  engine.emitAudio(Buffer.alloc(48));
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "full", bargeIn: false });
  expect(metrics.records[0].e2eLatencyMs).toBeUndefined();
});

test("metrics:看门狗 flush 触发的 turn_end → turn_end_source=bridge_watchdog", async () => {
  jest.useFakeTimers();
  try {
    const engine = new FakeEngine();
    const conn = new FakeConn();
    const metrics = mkMetrics();
    const session = new MediaSession(
      conn,
      { sessionId: "sess_m2", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
      { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
        metrics: metrics as never },
    );
    await session.begin();
    for (let i = 0; i < 20; i++) conn.rxBinary(frame(true)); // 说话 → turnPending
    for (let i = 0; i < SILENCE_FRAMES; i++) conn.rxBinary(frame(false)); // 静默
    jest.advanceTimersByTime(SILENCE_ADVANCE_MS); // 看门狗 flush → endTurn
    expect(engine.endTurns).toBe(1);
    engine.emitFinal("嗯");
    engine.emitTurnEvent(); // turn_end:此时 lastFlushAtMs>0 → bridge_watchdog
    engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "full", bargeIn: false });
    expect(metrics.records[0].turnEndSource).toBe("bridge_watchdog");
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("metrics:engine 段无对应端点段(无 turn_end 采集)也照常落库(端点字段缺省)", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_m3", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      metrics: metrics as never },
  );
  await session.begin();
  _openSessions.push(session); // afterEach detach 停真定时器
  // 不喂语音、不发 turn_end:直接 engine 上报(pendingEndpoint 为空)
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "partial", bargeIn: true });
  expect(metrics.records).toHaveLength(1);
  expect(metrics.records[0].turnEndSource).toBeUndefined();
  expect(metrics.records[0].played).toBe("partial");
});

test("集成:引擎级 TTS 超时(只发 onAiDone,不发 onError)→ 会话继续,不拆机(评审 High)", async () => {
  // 复现真机集成路径:onTtsTimeout 经 onAiDone 自终结本轮恢复收听,**不**经 onError → 不触发 end("error")。
  // 若引擎误经 onError 上报,MediaSession.onError 会 end("error") 整通拆机(违背 spec「会话继续」)。
  const { engine, conn, session, endeds } = await setup();
  engine.emitAudio(Buffer.from([9, 9])); // AI 开始播报 → aiSpeaking=true
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "partial", bargeIn: false, ttsTimeout: true });
  engine.emitAiDone(); // 引擎级 TTS 超时的恢复路径:只 onAiDone,不 onError
  await new Promise((r) => setTimeout(r, 0));
  // 会话未被拆:WS 未关、未回报收尾、引擎未停
  expect((session as unknown as { closed: boolean }).closed).toBe(false);
  expect(conn.closed).toBe(false);
  expect(endeds).toHaveLength(0);
  expect(engine.stopped).toBe(false);
  // 恢复收听:onAiDone 已复位 aiSpeaking → 入向原帧直喂引擎(电话版 FS 播放尾窗已删,无需推窗)
  const before = engine.pushed.length;
  conn.rxBinary(Buffer.from([7, 7, 7, 7]));
  expect(engine.pushed[before]).toEqual(Buffer.from([7, 7, 7, 7]));
});

test("metrics:无 metrics dep(未接)→ engine 上报不崩(旁路可选)", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_m4", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never },
  );
  await session.begin();
  _openSessions.push(session); // afterEach detach 停真定时器
  expect(() =>
    engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "full", bargeIn: false }),
  ).not.toThrow();
});

test("metrics:同 turn_index 重发(cancel_ack 核对)复用首次合并的端点段,不丢端点(评审纠偏)", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_reemit", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      metrics: metrics as never },
  );
  await session.begin();
  _openSessions.push(session); // afterEach detach 停真定时器
  // 轮 1:采集端点段
  for (let i = 0; i < 20; i++) conn.rxBinary(frame(true));
  engine.emitFinal("一句话");
  engine.emitTurnEvent(); // 采集 pendingEndpoint(turn_end_source=gpu_vad)
  // 首报(barge_in,partial)
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "partial", bargeIn: true });
  // 重发(cancel_ack 核对,engine 不带 endpoint)→ 应复用缓存的端点段
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "partial", bargeIn: true, cancelAckTimeout: false });
  expect(metrics.records).toHaveLength(2);
  // 两条都带 turn_end_source(端点段未丢)
  expect(metrics.records[0].turnEndSource).toBe("gpu_vad");
  expect(metrics.records[1].turnEndSource).toBe("gpu_vad");
  expect(metrics.records[1].cancelAckTimeout).toBe(false);
});

test("metrics:迟到 browser telemetry 完整回写同一记录且每字段首份生效", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    {
      sessionId: "sess_browser_late",
      systemPrompt: "x",
      engineParams: { engineType: "three_stage", language: "zh-CN" },
    },
    {
      engine,
      recorder: mkRecorder() as never,
      transcripts: mkTranscripts() as never,
      metrics: metrics as never,
    },
  );
  await session.begin();
  _openSessions.push(session);

  for (let i = 0; i < 20; i++) conn.rxBinary(frame(true));
  engine.emitFinal("你好");
  engine.emitTurnEvent();
  engine.emitAudioBegin(65_537);
  engine.emitAudio(Buffer.alloc(48));
  engine.emitMetrics({
    turnIndex: 1,
    aiTurnId: 65_537,
    engineType: "three_stage",
    ttsProvider: "gpu_omnivoice",
    llmTtftMs: 123,
    played: "full",
    bargeIn: false,
  });
  conn.rxText({
    type: "ux_telemetry",
    ai_turn_id: 65_537,
    marker_to_first_binary_ms: 45.5,
    marker_to_first_render_ms: 80,
    pause_to_first_silent_render_ms: 2.7,
  });
  expect(metrics.records).toHaveLength(2);
  expect(metrics.records[1]).toMatchObject({
    sessionId: "sess_browser_late",
    turnIndex: 1,
    aiTurnId: 65_537,
    ttsProvider: "gpu_omnivoice",
    llmTtftMs: 123,
    played: "full",
    markerToFirstBinaryMs: 45.5,
    markerToFirstRenderMs: 80,
    pauseToFirstSilentRenderMs: 2.7,
  });

  conn.rxText({
    type: "ux_telemetry",
    ai_turn_id: 65_537,
    marker_to_first_binary_ms: 999,
    first_binary_to_first_render_ms: 34.5,
  });
  expect(metrics.records).toHaveLength(3);
  expect(metrics.records[2]).toMatchObject({
    markerToFirstBinaryMs: 45.5,
    firstBinaryToFirstRenderMs: 34.5,
    markerToFirstRenderMs: 80,
    pauseToFirstSilentRenderMs: 2.7,
    llmTtftMs: 123,
  });

  conn.rxText({
    type: "ux_telemetry",
    ai_turn_id: 65_537,
    marker_to_first_binary_ms: 1000,
    first_binary_to_first_render_ms: 1000,
  });
  expect(metrics.records).toHaveLength(3);
});

test("metrics:只缓存已下发 marker 且早于 engine 完整记录的 browser telemetry", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    {
      sessionId: "sess_browser_early",
      systemPrompt: "x",
      engineParams: { engineType: "three_stage", language: "zh-CN" },
    },
    {
      engine,
      recorder: mkRecorder() as never,
      transcripts: mkTranscripts() as never,
      metrics: metrics as never,
    },
  );
  await session.begin();
  _openSessions.push(session);

  conn.rxText({
    type: "ux_telemetry",
    ai_turn_id: 2,
    cold_preroll_ms: 999,
  });
  engine.emitAudioBegin(2);
  conn.rxText({
    type: "ux_telemetry",
    ai_turn_id: 2,
    cold_preroll_ms: 75,
    underruns_before_first_render: 2,
  });
  expect(metrics.records).toHaveLength(0);
  engine.emitMetrics({
    turnIndex: 2,
    aiTurnId: 2,
    engineType: "three_stage",
    ttsProvider: "minimax",
    played: "partial",
    bargeIn: true,
  });
  expect(metrics.records).toHaveLength(1);
  expect(metrics.records[0]).toMatchObject({
    sessionId: "sess_browser_early",
    turnIndex: 2,
    aiTurnId: 2,
    ttsProvider: "minimax",
    played: "partial",
    coldPrerollMs: 75,
    underrunsBeforeFirstRender: 2,
  });
});

test("metrics:重复 turn_end(无新语音)不覆盖在飞行轮的端点段(评审纠偏 Medium-3)", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_dup", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      metrics: metrics as never },
  );
  await session.begin();
  _openSessions.push(session); // afterEach detach 停真定时器
  // 轮 1:真实新语音 → turnPending=true → turn_end 采集端点段
  for (let i = 0; i < 20; i++) conn.rxBinary(frame(true));
  engine.emitTurnEvent(); // 采集 pendingEndpoint(turnPending=true);随后 resetTurn → turnPending=false
  // 重复/busy 期 turn_end(无新语音,turnPending 已 false)→ **不**应再采集/覆盖
  engine.emitTurnEvent();
  // engine 出本轮 metric(busy-drop 的第二 turn_end 无对应 metric)
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "full", bargeIn: false });
  expect(metrics.records).toHaveLength(1);
  // 端点段来自第一个(真实)turn_end,未被重复 turn_end 清掉/覆盖
  expect(metrics.records[0].turnEndSource).toBe("gpu_vad");
  expect(typeof metrics.records[0].eouDelayMs).toBe("number");
});

test("metrics:barge_in 重发期间新轮端点段不错配给旧轮(单槽竞态修复)", async () => {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const metrics = mkMetrics();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_race", systemPrompt: "x", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never,
      metrics: metrics as never },
  );
  await session.begin();
  _openSessions.push(session); // afterEach detach 停真定时器
  // 轮 1 端点 + 首报(立即,barge_in partial)
  for (let i = 0; i < 20; i++) conn.rxBinary(frame(true));
  engine.emitTurnEvent();
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "partial", bargeIn: true });
  // 轮 2 端点采集(若仍单槽会覆盖轮1端点)
  for (let i = 0; i < 20; i++) conn.rxBinary(frame(true));
  engine.emitTurnEvent();
  engine.emitMetrics({ turnIndex: 2, engineType: "three_stage", played: "full", bargeIn: false });
  // 轮 1 的 cancel_ack 重发(此刻 pendingEndpoint 已是轮2的)→ 复用轮1缓存,不取轮2
  engine.emitMetrics({ turnIndex: 1, engineType: "three_stage", played: "partial", bargeIn: true, cancelAckTimeout: true });
  const turn1Records = metrics.records.filter((r) => r.turnIndex === 1);
  // 轮 1 两条记录端点段一致(都来自轮1首次合并),没被轮2覆盖
  expect(turn1Records).toHaveLength(2);
  expect(turn1Records[0].turnEndSource).toBe(turn1Records[1].turnEndSource);
  expect(turn1Records[0].eouDelayMs).toBe(turn1Records[1].eouDelayMs);
});

// ── design contract:会话建立后主动开场(kickoff,默认开)──
// 客户端直连无 IVR/门控:首帧到达即「会话建立」→ 启主动开场静默计时。
// 主动开场默认开(env AIM_PROACTIVE_OPENING != 0),静默 3000ms 到点触发。
function setupProactive(sessionId: string) {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const session = new MediaSession(
    conn,
    { sessionId, systemPrompt: "你是面试官", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: mkRecorder() as never, transcripts: mkTranscripts() as never },
  );
  return { engine, conn, session };
}

test("主动开场:会话建立后无人开口 → 静默到点 AI 主动开场(kickoff 一次)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn, session } = setupProactive("sess_kick1");
    await session.begin();
    conn.rxBinary(frame(false)); // 首帧(静音):会话建立 → 启主动开场静默计时(3000ms)
    expect(engine.kickoffs).toBe(0); // 还没到点
    jest.advanceTimersByTime(3100); // 过静默窗,无人开口 → 主动开场
    expect(engine.kickoffs).toBe(1);
    // 出过开场音频 + onAiDone → 标记已开场,本通不再主动开场
    engine.emitAudio(Buffer.from([9, 9]));
    engine.emitAiDone();
    expect((session as unknown as { opened: boolean }).opened).toBe(true);
    await session.detach();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("主动开场:真人先开口(真 ASR 文本)→ 立即取消主动开场(让位,不等 turn_end)", async () => {
  // design contract:永久让位只认**真 ASR 文本**(非纯能量)。真人开口 ASR 出字 → onTranscript 非空 → cancelKickoff。
  jest.useFakeTimers();
  try {
    const { engine, conn, session } = setupProactive("sess_kick2");
    await session.begin();
    conn.rxBinary(frame(false)); // 会话建立 → 启计时
    engine.emitFinal("你好我准备好了"); // 真人真开口:ASR 出非空文本 → 永久取消主动开场
    jest.advanceTimersByTime(3100); // 推过原静默到点
    expect(engine.kickoffs).toBe(0); // 让位真人,不主动开场
    await session.detach();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("★design contract:连接初期底噪脉冲(纯高能量、无 ASR 文本)不永久取消开场 → 后续仍能主动开场", async () => {
  // 部署回归 根因:0~3s 底噪脉冲(RMS 峰 614>阈)累计过 minSpeechMs 误判「真人先开口」→ 永久 settle →
  //   AI 再不开场、考生干等 ~34s。R1 修复:纯能量(无 ASR)不永久让位;脉冲触发的 turnPending 由端点看门狗 flush→
  //   turn_end→resetTurn 清后重 arm,静默到点仍主动开场。
  jest.useFakeTimers();
  try {
    const { engine, conn, session } = setupProactive("sess_kick_noise");
    await session.begin();
    conn.rxBinary(frame(false)); // 会话建立 → 启计时
    // 连接初期底噪脉冲:高能量帧但**从不出 ASR 文本**(真实底噪不会被 ASR 识别出字)。
    for (let i = 0; i < 20; i++) conn.rxBinary(frame(true)); // 累计 > minSpeechMs → turnPending=true(但无 ASR)
    // 端点看门狗 flush → 自然 turn_end → resetTurn 清 turnPending(模拟真实端点闭合)。
    engine.emitTurnEvent();
    // 之后持续静默无人真开口 → 到点仍应主动开场(未被底噪永久 settle)。
    jest.advanceTimersByTime(6500); // 覆盖 rearm 后的静默窗(可能经一次 turnPending 暂缓 + rearm)
    expect(engine.kickoffs).toBeGreaterThanOrEqual(1); // ★ 底噪没永久取消开场,AI 最终主动开场
    await session.detach();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("★design contract(review):持续高能量底噪令 turnPending 反复 true → rearm 达上限强制开场(不永不开场)", async () => {
  // review:持续底噪(非脉冲)每帧置 turnPending → fireKickoff 每次 rearm 却永不开场。
  //   修复:连续 turnPending 暂缓达 KICKOFF_MAX_REARM_ON_PENDING → 强制开场(真人真开口仍由 ASR 让位)。
  jest.useFakeTimers();
  try {
    const { engine, conn, session } = setupProactive("sess_kick_noisefloor");
    await session.begin();
    conn.rxBinary(frame(false)); // 会话建立 → 启计时
    // 持续高能量底噪:每个 kickoff 静默窗周期都灌高能量帧维持 turnPending=true(模拟嘈杂环境,无真 ASR)。
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 20; i++) conn.rxBinary(frame(true)); // 维持 turnPending
      jest.advanceTimersByTime(3100); // 过一个静默窗 → fireKickoff(turnPending → rearm 或强制)
    }
    // 连续 rearm 达上限(默认 3)后强制开场 → kickoffs 至少 1(不因持续底噪永不开场)。
    expect(engine.kickoffs).toBeGreaterThanOrEqual(1);
    await session.detach();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("主动开场:触发后未出声(被打断/故障)→ 不误标记已开场,有界重试", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn, session } = setupProactive("sess_kick3");
    await session.begin();
    conn.rxBinary(frame(false)); // 会话建立 → 启计时
    jest.advanceTimersByTime(3100); // 第一次 kickoff
    expect(engine.kickoffs).toBe(1);
    // 未出任何音频(被 barge-in 打断 / GPU TTS 故障)就 onAiDone → 不算开场,重 arm
    engine.emitAiDone();
    expect((session as unknown as { opened: boolean }).opened).toBe(false);
    jest.advanceTimersByTime(3100); // 重试窗到点 → 再 kickoff
    expect(engine.kickoffs).toBe(2);
    await session.detach();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("主动开场:成功开场后不重复(出过音频即本通只开场一次)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn, session } = setupProactive("sess_kick4");
    await session.begin();
    conn.rxBinary(frame(false));
    jest.advanceTimersByTime(3100);
    expect(engine.kickoffs).toBe(1);
    engine.emitAudio(Buffer.from([9, 9])); // 出过开场音频
    engine.emitAiDone();                    // → 标记已开场
    // 此后继续静默,推过多个静默窗 → 不再主动开场
    jest.advanceTimersByTime(10000);
    expect(engine.kickoffs).toBe(1);
    await session.detach();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("主动开场:有界重试上限(连续未出声至多 KICKOFF_MAX_ATTEMPTS 次,防无限重试)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn, session } = setupProactive("sess_kick5");
    await session.begin();
    conn.rxBinary(frame(false));
    // 每次 kickoff 都不出声(emitAiDone)→ 重试,直到上限(默认 3)
    for (let i = 0; i < 6; i++) {
      jest.advanceTimersByTime(3100);
      engine.emitAiDone();
    }
    expect(engine.kickoffs).toBe(3); // 封顶,不无限重试
    await session.detach();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

// ── M1 信令 v1:下行 text 帧(transcript/barge_in/ended)+ 上行 end 帧 ──

test("M1 信令:asr_final → 下行 transcript(user)text 帧(带 seq,与落库并行)", async () => {
  const { engine, transcripts, conn } = await setup();
  engine.emitFinal("我叫张三");
  // design contract:transcript 帧带会话内单调 seq(未配 fixer 时不修,只此一帧)。
  expect(conn.textFrames()).toEqual([{ type: "transcript", speaker: "user", seq: 0, text: "我叫张三" }]);
  expect(transcripts.finals).toEqual([{ speaker: "user", text: "我叫张三" }]); // 落库不受影响(并行)
});

test("M1 信令:onLlmText → 下行 transcript(ai)text 帧(带 seq)", async () => {
  const { engine, conn } = await setup();
  engine.emitLlmText("你好,请自我介绍。");
  expect(conn.textFrames()).toEqual([{ type: "transcript", speaker: "ai", seq: 0, text: "你好,请自我介绍。" }]);
});

test("M1 信令:barge-in 确认打断 → 下行 barge_in 帧(客户端清本地播放队列,即时停声闭环)", async () => {
  const { engine, conn, session } = await setup();
  engine.emitAudio(Buffer.from([9, 9])); // AI 播报中 → aiSpeaking=true
  session.onBargeIn();
  expect(engine.cancels).toContain("barge_in");
  expect(conn.textFrames()).toContainEqual({ type: "barge_in" });
});

test("M1 信令:AI 没在播报时 onBargeIn(误调/重复)→ 不发 barge_in 帧", async () => {
  const { conn, session } = await setup();
  session.onBargeIn(); // aiSpeaking=false → 无可打断
  expect(conn.textFrames()).toEqual([]);
});

test("M1 信令:teardown → 关连接前 best-effort 下发 ended 帧(带 CancelReason)", async () => {
  const { conn, session, endeds } = await setup();
  await session.end("manual_hangup");
  const frames = conn.textFrames();
  expect(frames[frames.length - 1]).toEqual({ type: "ended", reason: "manual_hangup" });
  // ended 帧在 close 之前发:close 时 sent 里已有该帧
  expect(conn.closed).toBe(true);
  expect(endeds).toHaveLength(1);
});

test("M1 信令:conn.send 抛错(对端已断)→ ended 帧吞错,收尾不受影响", async () => {
  const { conn, session, endeds } = await setup();
  conn.send = () => {
    throw new Error("socket closed");
  };
  await expect(session.end("session_end")).resolves.toEqual({ recordingKey: expect.any(String) });
  expect(conn.closed).toBe(true);
  expect(endeds).toHaveLength(1); // onEnded 回报照常
});

test("M1 信令:上行 {\"type\":\"end\"} → 考生主动结束,session.end(session_end)+ ended 帧", async () => {
  const { engine, conn, endeds } = await setup();
  conn.rxText({ type: "end" });
  await new Promise((r) => setTimeout(r, 0));
  expect(engine.stopped).toBe(true);
  expect(conn.closed).toBe(true);
  expect(endeds).toHaveLength(1);
  expect(endeds[0].reason).toBe("session_end");
  expect(conn.textFrames()).toContainEqual({ type: "ended", reason: "session_end" });
});

test("M1 信令:其它上行 text 帧(未知类型/非 JSON)忽略,会话继续(向后兼容)", async () => {
  const { engine, conn, session, endeds } = await setup();
  conn.rxText({ type: "future_frame", x: 1 });
  conn.rxText("not-json{{");
  await new Promise((r) => setTimeout(r, 0));
  expect((session as unknown as { closed: boolean }).closed).toBe(false);
  expect(engine.stopped).toBe(false);
  expect(endeds).toHaveLength(0);
  // 会话照常收音
  const pcm = Buffer.from([7, 7, 7, 7]);
  conn.rxBinary(pcm);
  expect(engine.pushed[engine.pushed.length - 1]).toEqual(pcm);
});

test("M1 信令:收尾后(closed)不再下发 transcript 帧(engine 迟到回调不炸)", async () => {
  const { engine, conn, session } = await setup();
  await session.end("session_end");
  const framesAtClose = conn.textFrames().length;
  engine.emitLlmText("迟到的文本"); // 引擎异步迟到回调
  expect(conn.textFrames()).toHaveLength(framesAtClose); // 不再发新信令
});

test("主动开场:引擎不实现 kickoff(模拟旧引擎)→ 回退被动等待,不调 kickoff", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn, session } = setupProactive("sess_kick6");
    // 删去 kickoff(模拟未实现的引擎)→ armKickoff 守门不 arm
    (engine as unknown as { kickoff?: () => void }).kickoff = undefined;
    await session.begin();
    conn.rxBinary(frame(false));
    jest.advanceTimersByTime(10000);
    expect(engine.kickoffs).toBe(0); // 不主动开场(回退被动)
    await session.detach();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

// ── design contract:考试完成强制(media-session 层:onAiDone 游标门 + 客户端 end 帧游标门 + 逃生阀)──
describe("design contract 考试完成强制", () => {
  test("未问完题 + LLM 语义结束信号 → 被游标门拦,不收尾", async () => {
    jest.useFakeTimers();
    try {
      const { engine, session, endeds } = await setup();
      engine.pending = true; // 有未问完题
      engine.endCallSignal = true; // 引擎侧(测试直接给)语义结束信号
      engine.earlyExit = false; // 逃生阀未放行
      engine.emitLlmText("好的");
      engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(3000);
      expect(endeds).toHaveLength(0); // 未问完题 + 未放行 → 不收尾(考试完成强制)
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("逃生阀放行(earlyExit)后 + 结束信号 → 正常收尾", async () => {
    jest.useFakeTimers();
    try {
      const { engine, session, endeds } = await setup();
      engine.pending = true;
      engine.earlyExit = true; // 三次坚持逃生阀已放行
      engine.endCallSignal = true;
      engine.emitLlmText("好的那结束吧");
      engine.emitAiDone();
      await jest.advanceTimersByTimeAsync(2000);
      expect(endeds).toHaveLength(1); // 放行 → 收尾
      expect(endeds[0].reason).toBe("session_end");
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("客户端 end 帧:未问完题时被忽略(不收尾)+ 下发 exam_incomplete", async () => {
    const { engine, conn, session, endeds } = await setup();
    engine.pending = true;
    engine.earlyExit = false; // noteEndRequest 返回 false(未达阈值)
    conn.rxText({ type: "end" });
    await new Promise((r) => setTimeout(r, 10));
    expect(endeds).toHaveLength(0); // 未问完题 → 忽略 end 请求
    expect(engine.endRequests).toBe(1); // 记了一次逃生阀计数
    expect(conn.textFrames().some((f) => (f as { type?: string }).type === "exam_incomplete")).toBe(true);
  });

  test("客户端 end 帧:逃生阀放行时正常收尾", async () => {
    const { engine, conn, session, endeds } = await setup();
    engine.pending = true;
    engine.earlyExit = true; // noteEndRequest 返回 true(达阈值放行)
    conn.rxText({ type: "end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(endeds).toHaveLength(1); // 放行 → 收尾
  });

  test("无题(纯人设)客户端 end 帧:照常收尾(不介入)", async () => {
    const { engine, conn, session, endeds } = await setup();
    engine.pending = false; // 无未问完题
    conn.rxText({ type: "end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(endeds).toHaveLength(1); // 无题 → 照常结束
    expect(engine.endRequests).toBe(0); // 不计逃生阀(未进游标门分支)
  });

  test("max_duration(manual_hangup)不受游标门影响:有未问完题仍收尾(review)", async () => {
    const { engine, session, endeds } = await setup();
    engine.pending = true; // 有未问完题(游标门对 session_end 会拦,但 manual_hangup 走独立路径)
    engine.earlyExit = false;
    // 模拟调度器 max_duration → index.ts handleHangup → end("manual_hangup"),不经 onAiDone/end 帧游标门
    await session.end("manual_hangup");
    expect(endeds).toHaveLength(1); // 强制收尾,不被考试完成强制拦
    expect(endeds[0].reason).toBe("manual_hangup");
    expect(engine.endRequests).toBe(0); // 不经逃生阀计数(直达 end())
  });

  // ── design contract:游标门白名单——违规 reason / peer_hangup 有未问完题也放行(不被「未问完不结束」门拦)──
  test("design contract:WS close(peer_hangup)有未问完题仍收尾(物理断连不被游标门拦)", async () => {
    const { engine, conn, session, endeds } = await setup();
    engine.pending = true; // 有未问完题:若 WS close 走 session_end 会被游标门拦(旧 bug),peer_hangup 放行
    conn.fireClose();
    await new Promise((r) => setTimeout(r, 10));
    expect(endeds).toHaveLength(1); // 物理断连正常终结
    expect(endeds[0].reason).toBe("peer_hangup");
    expect(engine.endRequests).toBe(0); // 不经逃生阀计数(WS close 直达 end())
  });

  test("design contract:违规 reason(silence_violation/severe_violation)有未问完题也直达收尾", async () => {
    for (const reason of ["silence_violation", "severe_violation"] as const) {
      const { engine, session, endeds } = await setup();
      engine.pending = true; // 有未问完题
      engine.earlyExit = false;
      await session.end(reason); // 违规强制结束直达 end()(不经 onAiDone/end 帧游标门)
      expect(endeds).toHaveLength(1);
      expect(endeds[0].reason).toBe(reason);
      expect(engine.endRequests).toBe(0); // 违规结束不经逃生阀计数
    }
  });

  // design contract:reason→事件映射(review:此前只断言 reason,没验 index.ts 的 reason→event)。
  test("design contract:endReasonToEvent 全 reason 映射(违规→violation_end/断连→peer_hangup/其余→completed)", () => {
    expect(endReasonToEvent("silence_violation")).toBe("violation_end");
    expect(endReasonToEvent("severe_violation")).toBe("violation_end");
    expect(endReasonToEvent("peer_hangup")).toBe("peer_hangup");
    expect(endReasonToEvent("session_end")).toBe("completed");
    expect(endReasonToEvent("manual_hangup")).toBe("completed");
    expect(endReasonToEvent("error")).toBe("completed");
    expect(endReasonToEvent("barge_in")).toBe("completed"); // barge_in 非收尾,兜底 completed(不会走 onEnded)
  });
});
