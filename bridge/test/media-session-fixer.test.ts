/**
 * design contract:MediaSession 旁路 ASR 字幕修正集成测试。断言:
 *  - user final 下行 transcript 帧带单调 seq;先落原文占位(固定 tsMs)
 *  - 修正成功 → 下行 transcript_corrected(同 seq)+ 覆盖落库(同 tsMs sk)
 *  - 未配 fixer / 无 token → 不修(不下行 corrected、只落原文一次)
 *  - 修正 fail-open(报错/输出不可信)→ 不下行 corrected、转写留原文
 *  - 对话路径喂原文不受影响(engine.lastFinalText 语义:transcriptCb 原文 → 对话 LLM,与修正解耦)
 *  - 并发上限:超上限的轮跳过修正
 *  - 会话结束 abort 飞行中修正、迟到结果被丢弃(不下行、不覆盖)
 *  - AI 侧 transcript 也带 seq(单调)
 *
 * fixer 调用经 jest.mock("../src/transcript-fixer") 拦截 correctTranscript(不触网、可控返回/挂起)。
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

// 拦截真实修正调用:测试注入 mock 实现(默认成功返回可控值)。
jest.mock("../src/transcript-fixer", () => ({
  correctTranscript: jest.fn(),
}));
import { correctTranscript } from "../src/transcript-fixer";
const mockedCorrect = correctTranscript as jest.MockedFunction<typeof correctTranscript>;

class FakeEngine implements VoiceEngine {
  hasQuestions() { return true; } // design contract:默认有题(现状语境),blockedByOpenChat 恒 false 不影响既有断言
  started = false;
  ctx: { history: { role: "user" | "assistant"; content: string }[]; question?: string } = { history: [] };
  private audioOutCb: AudioOutCb = () => {};
  private transcriptCb: TranscriptCb = () => {};
  private turnCb: TurnEventCb = () => {};
  private errorCb: EngineErrorCb = () => {};
  private llmTextCb: LlmTextCb = () => {};
  async start() { this.started = true; }
  pushAudio() {}
  cancel() {}
  async stop() {}
  onAudioOut(cb: AudioOutCb) { this.audioOutCb = cb; }
  onTranscript(cb: TranscriptCb) { this.transcriptCb = cb; }
  onTurnEvent(cb: TurnEventCb) { this.turnCb = cb; }
  onError(cb: EngineErrorCb) { this.errorCb = cb; }
  onLlmText(cb: LlmTextCb) { this.llmTextCb = cb; }
  correctionContext() { return this.ctx; }
  // design contract:questionCursor 供 media-session 若误读时暴露(本测试用它证明「不读全局 cursor」——转写题号来自回调快照)。
  cursor = 0;
  questionCursor() { return this.cursor; }
  // 触发器(design contract:可带 questionIndex 事件快照)
  emitFinal(text: string, questionIndex?: number) { this.transcriptCb({ text, isFinal: true, questionIndex }); }
  emitLlmText(text: string, questionIndex?: number) { this.llmTextCb(text, questionIndex); }
  // 无关方法留空
  onAiDone() {}
  onMetrics() {}
}

class FakeConn implements WsConn {
  sent: (string | Buffer)[] = [];
  closed = false;
  private msgCb: (d: Buffer, b: boolean) => void = () => {};
  private closeCb: () => void = () => {};
  send(data: string | Buffer) { this.sent.push(data); }
  close() { this.closed = true; }
  on(event: "message" | "close", cb: never) {
    if (event === "message") this.msgCb = cb as unknown as (d: Buffer, b: boolean) => void;
    else this.closeCb = cb as unknown as () => void;
  }
  textFrames(): Record<string, unknown>[] {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function mkTranscripts() {
  return {
    finals: [] as { speaker: string; text: string; tsMs?: number; questionIndex?: number }[],
    async putFinal(_sid: string, speaker: "user" | "ai", text: string, tsMs?: number, questionIndex?: number) {
      this.finals.push({ speaker, text, tsMs, questionIndex });
    },
  };
}

const _open: MediaSession[] = [];
afterEach(async () => {
  for (const s of _open.splice(0)) await s.detach().catch(() => undefined);
  mockedCorrect.mockReset();
  jest.useRealTimers();
});

async function setup(fixerModel: string | undefined, token = "sk-tok") {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const transcripts = mkTranscripts();
  const engineParams: EngineParams = {
    engineType: "three_stage",
    language: "zh-CN",
    llmBearerToken: token,
    llmMantleHost: "https://h",
    llmTranscriptFixerModelId: fixerModel,
  };
  const session = new MediaSession(
    conn,
    { sessionId: "sess_x", systemPrompt: "你是考官", engineParams },
    { engine, recorder: null, transcripts: transcripts as never, onEnded: () => {} },
  );
  await session.begin();
  _open.push(session);
  return { engine, conn, transcripts, session };
}

// 让微任务 + then 链跑完(修正是 fire-and-forget promise)。
const flush = () => new Promise((r) => setImmediate(r));

test("配了 fixer:user final 下行带 seq + 先落原文占位,修正成功后下行 corrected(同 seq)+ 覆盖落库(同 tsMs)", async () => {
  mockedCorrect.mockResolvedValue("62"); // ASR "42" → 修正 "62"
  const { engine, conn, transcripts } = await setup("anthropic.claude-haiku-4-5");
  engine.emitFinal("42");
  await flush();

  const frames = conn.textFrames();
  const t = frames.find((f) => f.type === "transcript");
  const c = frames.find((f) => f.type === "transcript_corrected");
  expect(t).toMatchObject({ type: "transcript", speaker: "user", seq: 0, text: "42" });
  expect(c).toMatchObject({ type: "transcript_corrected", speaker: "user", seq: 0, text: "62" });

  // 落库:先原文占位(tsMs=T)后修正覆盖(同 tsMs=T)——两次 putFinal 同 tsMs(覆盖同 sk)。
  const userFinals = transcripts.finals.filter((f) => f.speaker === "user");
  expect(userFinals).toHaveLength(2);
  expect(userFinals[0].text).toBe("42");
  expect(userFinals[1].text).toBe("62");
  expect(userFinals[0].tsMs).toBe(userFinals[1].tsMs); // 同 tsMs → 覆盖同一行,顺序不变
  expect(typeof userFinals[0].tsMs).toBe("number");
});

test("对话路径喂原文不受修正影响:修正即便改了字,transcriptCb 仍是原文(engine 侧 lastFinalText 用原文)", async () => {
  mockedCorrect.mockResolvedValue("62");
  const { engine, conn } = await setup("m");
  engine.emitFinal("42");
  await flush();
  // media-session 不改 engine 的输入;transcript 帧原文即证据(engine 内部 lastFinalText 走原文,与修正解耦)。
  const t = conn.textFrames().find((f) => f.type === "transcript");
  expect(t!.text).toBe("42"); // 下行原文(修正是随后 corrected 帧,不改对话喂给 LLM 的原文)
});

test("未配 fixer model → 不修:不下行 corrected,只落原文一次", async () => {
  const { engine, conn, transcripts } = await setup(undefined);
  engine.emitFinal("42");
  await flush();
  expect(mockedCorrect).not.toHaveBeenCalled();
  expect(conn.textFrames().some((f) => f.type === "transcript_corrected")).toBe(false);
  expect(transcripts.finals.filter((f) => f.speaker === "user")).toHaveLength(1);
});

test("无 mantle token(IAM 回退路径)→ 不修", async () => {
  const { engine, conn } = await setup("m", ""); // token 空
  engine.emitFinal("42");
  await flush();
  expect(mockedCorrect).not.toHaveBeenCalled();
  expect(conn.textFrames().some((f) => f.type === "transcript_corrected")).toBe(false);
});

test("空句不修", async () => {
  const { engine } = await setup("m");
  engine.emitFinal("   ");
  await flush();
  expect(mockedCorrect).not.toHaveBeenCalled();
});

// design contract:converse 方式 —— fixer 用 Bedrock API Key(非 mantle token)。
async function setupConverse(fixerModel: string | undefined, bedrockKey = "bk-x") {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const transcripts = mkTranscripts();
  const engineParams: EngineParams = {
    engineType: "three_stage",
    language: "zh-CN",
    llmCallMethod: "bedrock_converse",
    llmBedrockApiKey: bedrockKey, // converse 凭据
    llmBedrockRegion: "us-east-1",
    llmMantleHost: "https://proxy.test",
    // 注意:无 llmBearerToken(converse 不用 mantle token)
    llmTranscriptFixerModelId: fixerModel,
  };
  const session = new MediaSession(
    conn,
    { sessionId: "sess_conv", systemPrompt: "你是考官", engineParams },
    { engine, recorder: null, transcripts: transcripts as never, onEnded: () => {} },
  );
  await session.begin();
  _open.push(session);
  return { engine, conn, transcripts, session };
}

test("design contract:converse 方式用 Bedrock API Key 修正(无 mantle token 也修)", async () => {
  mockedCorrect.mockResolvedValue("那道题");
  const { engine, conn } = await setupConverse("global.anthropic.claude-haiku-4-6");
  engine.emitFinal("那到底");
  await flush();
  // converse 凭据(bedrockApiKey)在,fixer 应触发(不因缺 mantle token 而跳过)。
  expect(mockedCorrect).toHaveBeenCalledTimes(1);
  const c = conn.textFrames().find((f) => f.type === "transcript_corrected");
  expect(c).toMatchObject({ type: "transcript_corrected", speaker: "user", seq: 0, text: "那道题" });
});

test("design contract:converse 方式但无 Bedrock API Key → 不修", async () => {
  const { engine, conn } = await setupConverse("m", ""); // bedrockKey 空
  engine.emitFinal("那到底");
  await flush();
  expect(mockedCorrect).not.toHaveBeenCalled();
  expect(conn.textFrames().some((f) => f.type === "transcript_corrected")).toBe(false);
});

test("修正返回原文(无变化 / fail-open)→ 不下行 corrected、不重复覆盖", async () => {
  mockedCorrect.mockResolvedValue("42"); // 无变化
  const { engine, conn, transcripts } = await setup("m");
  engine.emitFinal("42");
  await flush();
  expect(conn.textFrames().some((f) => f.type === "transcript_corrected")).toBe(false);
  expect(transcripts.finals.filter((f) => f.speaker === "user")).toHaveLength(1); // 只占位那次
});

test("修正把上下文喂给了 engine.correctionContext", async () => {
  mockedCorrect.mockResolvedValue("62");
  const { engine } = await setup("m");
  engine.ctx = { history: [{ role: "assistant", content: "25+37=?" }], question: "25+37=?" };
  engine.emitFinal("42");
  await flush();
  const call = mockedCorrect.mock.calls[0];
  // 签名:(original, modelId, mantle, ctx, deps)
  expect(call[0]).toBe("42");
  expect(call[1]).toBe("m");
  expect(call[3]).toMatchObject({ question: "25+37=?" });
});

test("并发上限:超 FIXER_MAX_INFLIGHT(4)的轮跳过修正", async () => {
  // 让修正永久挂起(不 resolve),占满飞行槽。
  mockedCorrect.mockImplementation(() => new Promise<string>(() => {}));
  const { engine } = await setup("m");
  for (let i = 0; i < 6; i++) engine.emitFinal(`句${i}`);
  await flush();
  // 上限 4 → 只前 4 轮起了修正,后 2 轮跳过。
  expect(mockedCorrect).toHaveBeenCalledTimes(4);
});

test("会话结束:迟到的修正结果被丢弃(不下行 corrected、不覆盖落库)", async () => {
  let resolveFn: (v: string) => void = () => {};
  mockedCorrect.mockImplementation(() => new Promise<string>((res) => { resolveFn = res; }));
  const { engine, conn, transcripts, session } = await setup("m");
  engine.emitFinal("42");
  await flush();
  // 会话结束(飞行中修正还没回)。
  await session.end("session_end");
  const beforeUserFinals = transcripts.finals.filter((f) => f.speaker === "user").length;
  // 修正现在才回 → 应被丢弃(closed 守卫)。
  resolveFn("62");
  await flush();
  expect(conn.textFrames().some((f) => f.type === "transcript_corrected")).toBe(false);
  expect(transcripts.finals.filter((f) => f.speaker === "user").length).toBe(beforeUserFinals); // 未新增覆盖
});

test("AI 侧 transcript 也带单调 seq(与 user 共用同一计数器)", async () => {
  mockedCorrect.mockResolvedValue("修正后"); // user 会修
  const { engine, conn } = await setup("m");
  engine.emitFinal("用户句"); // seq 0
  await flush();
  engine.emitLlmText("AI 回复"); // seq 1
  const frames = conn.textFrames();
  const userT = frames.find((f) => f.type === "transcript" && f.speaker === "user");
  const aiT = frames.find((f) => f.type === "transcript" && f.speaker === "ai");
  expect(userT!.seq).toBe(0);
  expect(aiT!.seq).toBe(1); // 单调递增,user/ai 共用
});

// ── design contract:题号事件快照落库(user/ai/修正三路径)+ 字幕帧无题号 ──
test("design contract:user/ai 落库用回调带来的 questionIndex 快照,**不读**落库时刻 engine.questionCursor()", async () => {
  const { engine, transcripts } = await setup(undefined); // 不配 fixer → 只落原文一次
  engine.cursor = 99; // ★变异自证:若误读全局 cursor 会落 99;正确应落回调携带的快照值
  engine.emitFinal("用户答第一题", 0); // 回调快照 = 0
  engine.emitLlmText("AI 念第二题", 1); // 回调快照 = 1
  await flush();
  const userF = transcripts.finals.find((f) => f.speaker === "user")!;
  const aiF = transcripts.finals.find((f) => f.speaker === "ai")!;
  expect(userF.questionIndex).toBe(0); // 用回调快照 0(非全局 cursor 99)
  expect(aiF.questionIndex).toBe(1); // 用回调快照 1(非全局 cursor 99)
});

test("design contract:字幕帧(transcript/transcript_corrected)**不含** question_index(用户不可见)", async () => {
  mockedCorrect.mockResolvedValue("修正后"); // 触发 corrected 帧
  const { engine, conn } = await setup("m");
  engine.emitFinal("用户答", 0);
  await flush();
  engine.emitLlmText("AI 问", 1);
  const frames = conn.textFrames();
  for (const f of frames.filter((x) => x.type === "transcript" || x.type === "transcript_corrected")) {
    expect("question_index" in f).toBe(false);
    expect("questionIndex" in f).toBe(false);
  }
});

test("design contract:修正覆盖落库沿用**原文 asr_final 捕获的 questionIndex**(不用返回时刻游标)", async () => {
  mockedCorrect.mockResolvedValue("62"); // ASR "42" → 修正 "62"
  const { engine, transcripts } = await setup("anthropic.claude-haiku-4-5");
  engine.emitFinal("42", 2); // 原文捕获快照 = 2(用户答第 3 题)
  await flush();
  engine.cursor = 99; // 修正返回时游标已推进(变异自证:若重查会落 99)
  await flush(); // 让修正 then 链跑完(覆盖 putFinal)
  const userFinals = transcripts.finals.filter((f) => f.speaker === "user");
  expect(userFinals).toHaveLength(2); // 原文占位 + 修正覆盖
  expect(userFinals[0].questionIndex).toBe(2); // 原文占位:快照 2
  expect(userFinals[1].questionIndex).toBe(2); // ★ 修正覆盖沿用原捕获 2(非返回时刻 99)
});

test("design contract:无题号(越界/无题/老会话)→ 落库 questionIndex 为 undefined(稀疏)", async () => {
  const { engine, transcripts } = await setup(undefined);
  engine.emitFinal("收尾语"); // 无 questionIndex(越界/无题)
  engine.emitLlmText("结语"); // 无 questionIndex
  await flush();
  expect(transcripts.finals.find((f) => f.speaker === "user")!.questionIndex).toBeUndefined();
  expect(transcripts.finals.find((f) => f.speaker === "ai")!.questionIndex).toBeUndefined();
});
