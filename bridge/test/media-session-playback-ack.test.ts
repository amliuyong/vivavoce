/**
 * design contract Phase 4:media-session 播放 ACK observe 接线 —— 验证:
 *  - 协商成功(cfg.playbackAck)→ 引擎 onTurnAudioBegin/End 触发时下发 ai_audio_start/end 帧(有序,start 先);
 *  - 客户端上行 playback_complete/aborted → coordinator 结算(记指标);
 *  - **observe 模式:结算不驱动任何推进副作用**(engine 的 advance 不被调用);
 *  - 未协商(无 cfg.playbackAck)→ 仍发 UX telemetry marker，但不建 ACK coordinator。
 */
import { test, expect, beforeEach, afterEach, jest } from "@jest/globals";

function makeFakes() {
  const advanceCalls: number[] = [];
  const engine: any = {
    _cursor: 0,
    async start() {}, pushAudio() {}, cancel() {}, async stop() {},
    onAudioOut(cb: any) { this._audioOut = cb; },
    onTurnAudioBegin(cb: any) { this._turnBegin = cb; },
    onTurnAudioEnd(cb: any) { this._turnEnd = cb; },
    onUserTurnStart(cb: any) { this._userTurnStart = cb; },
    onTranscript(cb: any) { this._t = cb; },
    onTurnEvent(cb: any) { this._turn = cb; }, onError() {}, onLlmText() {}, onAiDone(cb: any) { this._aiDone = cb; },
    onMetrics() {}, endTurn() {},
    nudge() { return true; },
    hasQuestions() { return true; }, hasPendingQuestions() { return true; },
    answerSeenForCursor() { return true; },
    questionCursor() { return this._cursor; },
    advanceOnSilenceTimeout(epoch: number) { advanceCalls.push(epoch); this._cursor += 1; return true; },
    _t: (_: any) => {}, _turn: (_: any) => {}, _aiDone: (_?: boolean) => undefined as number | void,
    _audioOut: (_: any) => {}, _turnBegin: (_: number) => {}, _turnEnd: (_: number) => {}, _userTurnStart: () => {},
  };
  const conn: any = {
    sent: [] as unknown[], closed: false,
    send(d: unknown) { this.sent.push(d); }, close() { this.closed = true; },
    _msg: (_d: Buffer, _b: boolean) => {}, _close: () => {},
    on(ev: string, cb: any) { if (ev === "message") this._msg = cb; else this._close = cb; },
    rxBinary(pcm: Buffer) { this._msg(pcm, true); },
    rxText(obj: any) { this._msg(Buffer.from(JSON.stringify(obj), "utf8"), false); },
    textFrames() { return (this.sent as unknown[]).filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s)); },
  };
  return { engine, conn, advanceCalls };
}

function freshMediaSession() {
  jest.resetModules();
  return require("../src/media-session").MediaSession as typeof import("../src/media-session").MediaSession;
}

const TCFG = { graceMs: 3000, maxWaitMs: 45000, inputGraceMs: 1000, maxPlaybackLeadMs: 20000 };
// ★ design contract:mode 三态已删 —— 只剩「客户端是否声明 capability」二态(有 cfg = 声明了 / undefined = 没声明)。
const CFG = { cfg: TCFG };

async function setup(playbackAck: typeof CFG | undefined) {
  const MediaSession = freshMediaSession();
  const { engine, conn, advanceCalls } = makeFakes();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_ack", systemPrompt: "你是考官", engineParams: { engineType: "three_stage", language: "zh-CN" } as any, playbackAck },
    { engine, recorder: null as any, transcripts: { async putFinal() {} } as any, onEnded: () => {} },
  );
  await session.begin();
  return { session, engine, conn, advanceCalls };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test("协商成功:onTurnAudioBegin/End → 下发 ai_audio_start/end(start 先,带 ai_turn_id)", async () => {
  const { engine, conn } = await setup(CFG);
  engine._turnBegin(17);
  engine._turnEnd(17);
  const frames = conn.textFrames().filter((f: any) => f.type === "ai_audio_start" || f.type === "ai_audio_end");
  expect(frames).toEqual([
    { type: "ai_audio_start", ai_turn_id: 17 },
    { type: "ai_audio_end", ai_turn_id: 17 },
  ]);
});

test("客户端上行 playback_complete → coordinator 结算(observe 不驱动推进副作用)", async () => {
  const { engine, conn, advanceCalls } = await setup(CFG);
  engine._turnBegin(3);
  engine._turnEnd(3);
  conn.rxText({ type: "playback_complete", ai_turn_id: 3 });
  // observe:结算只记指标,不调 engine 推进(advanceOnSilenceTimeout 不被触发)
  expect(advanceCalls).toHaveLength(0);
});

test("客户端上行 playback_aborted → 结算 aborted(observe 不推进)", async () => {
  const { engine, conn, advanceCalls } = await setup(CFG);
  engine._turnBegin(4);
  engine._turnEnd(4);
  conn.rxText({ type: "playback_aborted", ai_turn_id: 4, reason: "superseded" });
  expect(advanceCalls).toHaveLength(0);
});

test("未协商(无 playbackAck):仍下发 ai_audio_start/end 供 UX telemetry 使用", async () => {
  const { engine, conn } = await setup(undefined);
  engine._turnBegin(9);
  engine._turnEnd(9);
  const frames = conn.textFrames().filter((f: any) => f.type === "ai_audio_start" || f.type === "ai_audio_end");
  expect(frames).toEqual([
    { type: "ai_audio_start", ai_turn_id: 9 },
    { type: "ai_audio_end", ai_turn_id: 9 },
  ]);
});

test("未协商:上行 playback_complete 被静默忽略(coordinator 为 null,不崩)", async () => {
  const { conn } = await setup(undefined);
  expect(() => conn.rxText({ type: "playback_complete", ai_turn_id: 1 })).not.toThrow();
});

// ── design contract + design contract:playback_superseded 无条件下发(根治换轮旧音频续播)──
const SUP = { type: "playback_superseded", reason: "accepted_user_turn" };

test("R5:引擎起用户驱动新轮 → 下发 playback_superseded + 重置播放队尾", async () => {
  const { engine, conn } = await setup(CFG);
  engine._userTurnStart(); // 引擎起用户新轮
  expect(conn.textFrames().filter((f: any) => f.type === "playback_superseded")).toEqual([SUP]);
});

// ★★ design contract 的核心回归(review):**客户端未声明 capability 时也 MUST 发**。
//   旧实现把 supersede 挂在 coordinator 块内 + isEnforce() 门 → 双重依赖(服务端 mode + 客户端 capability)。
//   前端是 output:'export' 静态导出,浏览器可能缓存旧 JS 而不声明 capability → 若仍依赖协商,
//   已知的「AI 文字已回但旧轮音频还在说圣诞节」会原样复现。
//   清 ring 是纯单向通知(客户端 stopPlayback 自 design contract 即存在),不需要 ACK 上行能力。
test("R5 未协商(旧客户端不声明 capability):仍 MUST 下发 superseded", async () => {
  const { engine, conn } = await setup(undefined); // coordinator 为 null
  engine._userTurnStart();
  expect(conn.textFrames().filter((f: any) => f.type === "playback_superseded")).toEqual([SUP]);
});

test("R5:违规发言保护轮(violationNoticeGuard)不被 supersede(design contract)", async () => {
  const { session, engine, conn } = await setup(CFG);
  (session as any).violationNoticeGuard = true; // 模拟违规警告/原因句播报期
  engine._userTurnStart();
  expect(conn.textFrames().filter((f: any) => f.type === "playback_superseded")).toHaveLength(0);
});

test("R5:违规保护轮 + 未协商 → 仍不发(保护优先于无条件下发)", async () => {
  const { session, engine, conn } = await setup(undefined);
  (session as any).violationNoticeGuard = true;
  engine._userTurnStart();
  expect(conn.textFrames().filter((f: any) => f.type === "playback_superseded")).toHaveLength(0);
});
