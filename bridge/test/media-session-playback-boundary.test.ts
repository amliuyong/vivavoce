/**
 * design contract:会话级客户端播放边界估算(治 tts_done≠客户端播完的早推进,缺陷1)—— media 层。
 *
 * 验证:
 *  - onAudioOut 累加**会话级队尾** estimatedClientPlaybackEndMs(max(now,end)+frameMs),多轮同时间轴不低估;
 *  - computePlaybackNotBeforeMs():队尾+margin 的剩余 clamp 到 [now, now+MAX];fail-safe(无音频/负→now)、
 *    有限超上限→clamp now+MAX(不退 now);
 *  - onAiDone 返回该快照(engine armAnswerGrace 用其延后);waiting 锚点后移(silenceSince ≈ 估算播完);
 *  - **user final 不重置队尾**(review);**barge-in 重置**队尾;
 *  - markAiDonePlaying 清单轮统计后,会话级队尾仍正确(独立于单轮统计)。
 *
 * fake engine + 假定时器精确控制 Date.now。aiAudioFrame(24k 960B)经 downsampler → 16k 640B = 20ms/帧。
 */
import { test, expect, beforeEach, afterEach, jest } from "@jest/globals";

function makeFakes() {
  const nudges: string[] = [];
  const advanceCalls: number[] = [];
  const engine: any = {
    _cursor: 0,
    async start() {}, pushAudio() {}, cancel() {}, async stop() {},
    onAudioOut(cb: any) { this._audioOut = cb; }, onTranscript(cb: any) { this._t = cb; },
    onTurnEvent(cb: any) { this._turn = cb; }, onError() {}, onLlmText() {}, onAiDone(cb: any) { this._aiDone = cb; },
    onMetrics() {}, correctionContext() { return { history: [] }; }, endTurn() {},
    nudge(text: string) { nudges.push(text); return true; },
    hasQuestions() { return true; },
    answerSeenForCursor() { return true; },
    questionCursor() { return this._cursor; },
    advanceOnSilenceTimeout(epoch: number) { advanceCalls.push(epoch); this._cursor += 1; return true; },
    _t: (_: any) => {}, _turn: (_: any) => {}, _aiDone: (_?: boolean) => undefined as number | void, _audioOut: (_: any) => {},
  };
  const conn: any = {
    sent: [] as unknown[], closed: false,
    send(d: unknown) { this.sent.push(d); }, close() { this.closed = true; },
    _msg: (_d: Buffer, _b: boolean) => {}, _close: () => {},
    on(ev: string, cb: any) { if (ev === "message") this._msg = cb; else this._close = cb; },
    rxBinary(pcm: Buffer) { this._msg(pcm, true); },
    rxText(obj: any) { this._msg(Buffer.from(JSON.stringify(obj), "utf8"), false); }, // 上行控制帧
  };
  return { engine, conn, nudges, advanceCalls };
}

const aiAudioFrame = Buffer.alloc(960, 1); // 24k 20ms → 16k 640B = 20ms/帧

function freshMediaSession() {
  jest.resetModules();
  return require("../src/media-session").MediaSession as typeof import("../src/media-session").MediaSession;
}

async function setup(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const MediaSession = freshMediaSession();
  const { engine, conn, nudges, advanceCalls } = makeFakes();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_pb", systemPrompt: "你是考官", engineParams: { engineType: "three_stage", language: "zh-CN" } as any },
    { engine, recorder: null as any, transcripts: { async putFinal() {} } as any, onEnded: () => {} },
  );
  await session.begin();
  return { session, engine, conn, nudges, advanceCalls };
}

const ENVS = ["AIM_MAX_PLAYBACK_LEAD_MS", "AIM_PLAYBACK_LEAD_MARGIN_MS", "AIM_SILENCE_VIOLATION_MS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENVS) { saved[k] = process.env[k]; delete process.env[k]; } jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); for (const k of ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

/** 读私有字段/调私有方法。 */
function peek(s: { session: any }) {
  return s.session as {
    estimatedClientPlaybackEndMs: number;
    computePlaybackNotBeforeMs(): number;
    markAiDonePlaying(p?: number | void): void;
    onBargeIn(): void;
    aiSpeaking: boolean;
  };
}

test("onAudioOut 累加会话级队尾:N 帧(20ms)后 estimatedClientPlaybackEndMs = 首帧 now + N×20ms", async () => {
  const s = await setup({});
  const p = peek(s);
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) s.engine._audioOut(aiAudioFrame); // 同一 now 下 10 帧
  // 队尾 = max(now,end)+frameMs 累加:首帧 now+20,…,第10帧 now+200(帧内 Date.now 未推进 → max(now,end)=end)。
  expect(p.estimatedClientPlaybackEndMs).toBe(t0 + 200);
});

test("computePlaybackNotBeforeMs:队尾 + margin 的剩余(未超上限)→ now + (队尾-now) + margin", async () => {
  const s = await setup({ AIM_PLAYBACK_LEAD_MARGIN_MS: "1000", AIM_MAX_PLAYBACK_LEAD_MS: "35000" });
  const p = peek(s);
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) s.engine._audioOut(aiAudioFrame); // 队尾 = t0 + 1000ms
  // lead = (队尾1000 + margin1000) - now(=t0) = 2000 < 35000 → 返回 now + 2000。
  expect(p.computePlaybackNotBeforeMs()).toBe(t0 + 2000);
});

test("fail-safe①:无音频 → 返回 now(无估算依据)", async () => {
  const s = await setup({});
  const p = peek(s);
  expect(p.computePlaybackNotBeforeMs()).toBe(Date.now()); // estimatedClientPlaybackEndMs=0 → now
});

test("fail-safe②:队尾已过去(lead 负)→ 返回 now(客户端应已播完)", async () => {
  const s = await setup({ AIM_PLAYBACK_LEAD_MARGIN_MS: "0" });
  const p = peek(s);
  for (let i = 0; i < 10; i++) s.engine._audioOut(aiAudioFrame); // 队尾 = t0 + 200
  jest.advanceTimersByTime(5000); // now 推进到远超队尾 → lead = (队尾+0) - now < 0
  expect(p.computePlaybackNotBeforeMs()).toBe(Date.now()); // 退回 now
});

test("★clamp(评审 Major2):队尾虚高使 lead 超上限 → clamp 到 now+MAX(不退回 now)", async () => {
  // 模拟「旧音频被前端 R4 清但服务端队尾未重置」→ 队尾虚高。lead 超 MAX → clamp 到 now+MAX(有界保护,非退 now)。
  const s = await setup({ AIM_MAX_PLAYBACK_LEAD_MS: "35000", AIM_PLAYBACK_LEAD_MARGIN_MS: "1000" });
  const p = peek(s);
  const t0 = Date.now();
  // 直接把队尾设成远未来(相当于虚高很多秒的音频):
  (s.session as any).estimatedClientPlaybackEndMs = t0 + 600_000; // 10 分钟虚高
  // lead = (600000 + 1000) - t0 ... 远超 35000 → clamp。
  expect(p.computePlaybackNotBeforeMs()).toBe(t0 + 35000); // ★ clamp 到 now+MAX,不退回 now(t0)
});

test("多轮同时间轴不低估:轮 A 未播完轮 B 又下发 → 队尾累积(max(now,end)+frame)", async () => {
  const s = await setup({});
  const p = peek(s);
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) s.engine._audioOut(aiAudioFrame); // 轮 A:队尾 = t0 + 2000
  jest.advanceTimersByTime(500); // now = t0+500,轮 A 还在播(队尾 t0+2000 > now)
  for (let i = 0; i < 100; i++) s.engine._audioOut(aiAudioFrame); // 轮 B:从队尾 t0+2000 继续累加 → t0+4000
  expect(p.estimatedClientPlaybackEndMs).toBe(t0 + 4000); // 不从 now(t0+500)重算(不低估)
});

test("★user final 不重置队尾(review:不假设前端 stopPlayback)", async () => {
  const s = await setup({});
  const p = peek(s);
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) s.engine._audioOut(aiAudioFrame); // 队尾 = t0 + 1000
  // 用户 final 到达(经 engine.onTranscript final 回调)——旧客户端不清队列,服务端队尾 MUST NOT 归零。
  s.engine._t({ text: "我的回答", isFinal: true });
  expect(p.estimatedClientPlaybackEndMs).toBe(t0 + 1000); // ★ 未被 user final 重置
});

test("barge-in 重置队尾为 now(服务端确定客户端已清播放队列)", async () => {
  const s = await setup({});
  const p = peek(s);
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) s.engine._audioOut(aiAudioFrame); // 队尾 = t0 + 1000,且 aiSpeaking=true
  expect(p.aiSpeaking).toBe(true);
  s.session.onBargeIn(); // 下行 barge_in 帧 → 客户端清队列 → 队尾重置 now
  expect(p.estimatedClientPlaybackEndMs).toBe(Date.now());
});

test("★review_done 后客户端上行 barge_in(aiSpeaking=false)→ 无条件重置队尾 + 清 waiting/R3", async () => {
  // 真实窗口:GPU tts_done → markAiDonePlaying 令 aiSpeaking=false,但客户端仍在播 tts_done 后排队的长音频 →
  //   用户插话 → 客户端 stopPlayback + 上行 {type:barge_in}。此帧落 `!aiSpeaking` 分支:onBargeIn 会提前返回不重置
  //   队尾 → 下一轮从虚假旧队尾累加 → 推进被延迟至多 MAX。修复:onMessage 的 barge_in `!aiSpeaking` 分支无条件
  //   重置 estimatedClientPlaybackEndMs + 清 waiting/R3。变异:删该分支重置 → 队尾残留 → 本断言红。
  const s = await setup({ AIM_SILENCE_VIOLATION_MS: "10000" });
  const p = peek(s);
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) s.engine._audioOut(aiAudioFrame); // 队尾 = t0 + 2000(长音频)
  // 模拟 tts_done 后:引擎 onAiDone(completed=true)→ markAiDonePlaying(aiSpeaking=false) + 进等待态。
  s.engine._aiDone(true);
  expect(p.aiSpeaking).toBe(false); // tts_done 后
  const tailBefore = p.estimatedClientPlaybackEndMs;
  expect(tailBefore).toBeGreaterThan(Date.now()); // 队尾仍在未来(客户端还在播)
  // 客户端仍在播这 2s 队列,用户插话 → 上行 barge_in(aiSpeaking 已 false)。
  s.conn.rxText({ type: "barge_in" });
  expect(p.estimatedClientPlaybackEndMs).toBe(Date.now()); // ★ 无条件重置为 now(不残留旧队尾)
  // 且 waiting 态被清(客户端接管,不背旧等待)。
  expect((s.session as any).waitingSinceMs).toBe(0);
});

test("markAiDonePlaying 清单轮统计后,会话级队尾仍正确(独立于单轮统计)", async () => {
  const s = await setup({});
  const p = peek(s);
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) s.engine._audioOut(aiAudioFrame); // 队尾 = t0 + 1000
  p.markAiDonePlaying(); // 清单轮 aiTurnFirstAudioAtMs/aiTurnAudioMs
  expect(p.estimatedClientPlaybackEndMs).toBe(t0 + 1000); // ★ 会话级队尾不受单轮清零影响
});

test("onAiDone 返回 playbackNotBeforeMs(engine armAnswerGrace 据此延后);无音频轮返回 now", async () => {
  const s = await setup({ AIM_PLAYBACK_LEAD_MARGIN_MS: "1000", AIM_MAX_PLAYBACK_LEAD_MS: "35000" });
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) s.engine._audioOut(aiAudioFrame); // 队尾 = t0 + 1000
  const ret = s.engine._aiDone(true); // onAiDone 回调返回快照
  expect(ret).toBe(t0 + 2000); // now + (1000 队尾 + 1000 margin) = t0+2000
});

test("env AIM_MAX_PLAYBACK_LEAD_MS=0(锁死)→ computePlaybackNotBeforeMs 恒 now(逐字节等价现状)", async () => {
  const s = await setup({ AIM_MAX_PLAYBACK_LEAD_MS: "0", AIM_PLAYBACK_LEAD_MARGIN_MS: "1000" });
  const p = peek(s);
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) s.engine._audioOut(aiAudioFrame);
  expect(p.computePlaybackNotBeforeMs()).toBe(t0); // clamp lead 到 0 → now(现状等价:tts_done 后即起算)
});
