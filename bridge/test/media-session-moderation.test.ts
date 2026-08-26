/**
 * design contract:MediaSession 旁路违规裁判集成测试(shadow only)。断言:
 *  - 配了 llmModerationModelId + 有凭据 → user final 触发一次 judgeModeration(每 userTurnId 一次)
 *  - **同一逻辑轮重复/分段 final 不重复裁判**(userTurnId 去重,review)——但这里重复 final 会各自 ++userTurnId?
 *    实际:每条 asr_final 到达即 ++userTurnId,故不同 final 是不同轮;去重针对「同一 turnId 被调多次」(防御)。
 *  - 未配 model / 无凭据 → 不裁判
 *  - shadow:裁判返回**不产生任何用户可感知动作**(不挂断 onEnded、不下发额外信令帧)
 *  - 独立背压:飞行中达上限跳过
 *  - fail-open:judgeModeration 返回 null 不崩、不动作
 *
 * judgeModeration 经 jest.mock("../src/moderation-verdict") 拦截(不触网、可控返回/挂起)。
 */
import { MediaSession, WsConn } from "../src/media-session";
import {
  AudioOutCb,
  EngineErrorCb,
  LlmTextCb,
  TranscriptCb,
  TurnEventCb,
  VoiceEngine,
  EngineParams,
} from "../src/voice-engine";

jest.mock("../src/moderation-verdict", () => ({
  judgeModeration: jest.fn(),
}));
import { judgeModeration } from "../src/moderation-verdict";
const mockedJudge = judgeModeration as jest.MockedFunction<typeof judgeModeration>;

class FakeEngine implements VoiceEngine {
  hasQuestions() { return true; } // design contract:默认有题(现状语境),blockedByOpenChat 恒 false 不影响既有断言
  started = false;
  ctx: { history: { role: "user" | "assistant"; content: string }[]; question?: string } = { history: [] };
  private transcriptCb: TranscriptCb = () => {};
  private turnCb: TurnEventCb = () => {};
  async start() { this.started = true; }
  pushAudio() {}
  cancel() {}
  async stop() {}
  onAudioOut(_cb: AudioOutCb) {}
  onTranscript(cb: TranscriptCb) { this.transcriptCb = cb; }
  onTurnEvent(cb: TurnEventCb) { this.turnCb = cb; }
  onError(_cb: EngineErrorCb) {}
  onLlmText(_cb: LlmTextCb) {}
  correctionContext() { return this.ctx; }
  emitFinal(text: string) { this.transcriptCb({ text, isFinal: true }); }
  emitTurnEnd() { this.turnCb("turn_end"); } // → resetTurn 清 moderatedThisTurn(新逻辑轮)
  onAiDone() {}
  onMetrics() {}
}

class FakeConn implements WsConn {
  sent: (string | Buffer)[] = [];
  closed = false;
  send(data: string | Buffer) { this.sent.push(data); }
  close() { this.closed = true; }
  on(_event: "message" | "close", _cb: never) {}
  textFrames(): Record<string, unknown>[] {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function mkTranscripts() {
  return { finals: [] as unknown[], async putFinal() { this.finals.push(1); } };
}

const _open: MediaSession[] = [];
beforeEach(() => {
  mockedJudge.mockReset();
  mockedJudge.mockResolvedValue(null); // 默认返回 Promise(null=判不了),避免 mockReset 后返回 undefined 致 .then 崩
});
afterEach(async () => {
  for (const s of _open.splice(0)) await s.detach().catch(() => undefined);
});

async function setup(moderationModel: string | undefined, token: string | undefined = "sk-tok") {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const transcripts = mkTranscripts();
  const endeds: unknown[] = [];
  const engineParams: EngineParams = {
    engineType: "three_stage",
    language: "zh-CN",
    llmBearerToken: token,
    llmMantleHost: "https://h",
    llmModerationModelId: moderationModel,
  };
  const session = new MediaSession(
    conn,
    { sessionId: "sess_m", systemPrompt: "你是考官", engineParams },
    { engine, recorder: null, transcripts: transcripts as never, onEnded: (i) => endeds.push(i) },
  );
  await session.begin();
  _open.push(session);
  return { engine, conn, transcripts, session, endeds };
}

const flush = () => new Promise((r) => setImmediate(r));
const okVerdict = { klass: "on_topic_attempt" as const, confidence: 0.9, answerComplete: true };

test("每逻辑轮最多判一次:同轮重复/分段 final 只判 1 次,turn_end 后新轮再判(M1 去重)", async () => {
  mockedJudge.mockResolvedValue(okVerdict);
  const { engine } = await setup("minimax.minimax-m2.5");
  // 同一逻辑轮的两条 final(ASR 分段/重发,无 turn_end 间隔)→ 只判 1 次(moderatedThisTurn 去重)
  engine.emitFinal("代码太大");
  await flush();
  engine.emitFinal("代码太大 呃"); // 同轮修订/分段
  await flush();
  expect(mockedJudge).toHaveBeenCalledTimes(1); // 去重:同轮只判一次(M1 修:此前每 final 自增 id 去重失效)
  // turn_end → resetTurn 清 moderatedThisTurn → 新逻辑轮可再判
  engine.emitTurnEnd();
  engine.emitFinal("下一题的回答");
  await flush();
  expect(mockedJudge).toHaveBeenCalledTimes(2);
});

test("未配裁判 model → 不裁判(逐字节等价现状)", async () => {
  const { engine } = await setup(undefined);
  engine.emitFinal("答案");
  await flush();
  expect(mockedJudge).not.toHaveBeenCalled();
});

test("无凭据(token 空)→ 不裁判", async () => {
  const { engine } = await setup("minimax.minimax-m2.5", ""); // 空 token(默认参数陷阱:显式 undefined 会走默认值,故用 "")
  engine.emitFinal("答案");
  await flush();
  expect(mockedJudge).not.toHaveBeenCalled();
});

test("shadow:裁判返回(含高置信 severe)MUST NOT 产生用户可感知动作(不挂断、无额外信令)", async () => {
  mockedJudge.mockResolvedValue({ klass: "severe_directed_abuse", confidence: 0.99, answerComplete: false });
  const { engine, conn, endeds } = await setup("minimax.minimax-m2.5");
  const framesBefore = conn.textFrames().length;
  engine.emitFinal("严重不当内容");
  await flush();
  expect(mockedJudge).toHaveBeenCalledTimes(1);
  expect(endeds).toHaveLength(0); // R2 shadow:即便判 severe 高置信也不挂断(挂断在 R3,flag 门控)
  // 不下发违规相关信令(只 transcript 帧,不多发)。断言未新增非 transcript 帧。
  const nonTranscript = conn.textFrames().slice(framesBefore).filter((f) => f.type !== "transcript");
  expect(nonTranscript).toHaveLength(0);
});

test("fail-open:judgeModeration 返回 null → 不崩、不动作", async () => {
  mockedJudge.mockResolvedValue(null);
  const { engine, endeds } = await setup("minimax.minimax-m2.5");
  engine.emitFinal("模糊回答");
  await flush();
  expect(mockedJudge).toHaveBeenCalledTimes(1);
  expect(endeds).toHaveLength(0);
});

test("串行门(review):裁判在飞行时后续轮跳过 → 至多 1 个在飞行", async () => {
  // idle 裁判**串行**(idleChatterInFlight):第 1 个裁判挂起未 resolve → 后续轮全被背压跳过。每轮间 emitTurnEnd
  //   (新逻辑轮,清 moderatedThisTurn),否则同轮去重只判 1 次。串行下 judgeModeration 只被调 1 次(非旧并发上限 3)。
  const resolvers: (() => void)[] = [];
  mockedJudge.mockImplementation(() => new Promise((res) => { resolvers.push(() => res(okVerdict)); }));
  const { engine } = await setup("minimax.minimax-m2.5");
  for (let i = 0; i < 5; i++) {
    if (i > 0) engine.emitTurnEnd(); // 每轮独立(清 moderatedThisTurn)
    engine.emitFinal(`答案${i}`);
    await flush();
  }
  // 串行:第 1 个裁判在飞行 → 后 4 轮全跳过 → judgeModeration 只被调 1 次。
  expect(mockedJudge).toHaveBeenCalledTimes(1);
  resolvers.forEach((r) => r());
  await flush();
});
