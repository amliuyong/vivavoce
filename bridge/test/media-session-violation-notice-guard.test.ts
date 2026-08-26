/**
 * design contract:违规发言(警告句 + 挂断原因句)不可被打断。
 *
 * 根因(部署验证 sess_example):进入「违规强制结束」后注入的原因句在播报期间被用户持续说话反复
 *   barge-in / tentative-pause 让位 → onAiDone 永不到达 → 撞 10s 硬超时被硬切,用户听不到挂断原因。
 * 契约:受保护违规发言轮(nudge 起播 → onAiDone)期间抑制 detectBargeIn(服务端) + 客户端上行 barge_in;
 *   完整播完(onAiDone completed)才挂;硬超时退化为 LLM/TTS 真故障兜底。
 *
 * 恢复配置模块级(turn-handling import 期读 env)→ 本文件在 import media-session 前设 env 开启恢复 + enforcement,
 *   与默认关的其它文件隔离(单独文件 = 单独模块图)。用 fake timers 驱动 watchdog(250ms/tick)+ 硬超时。
 */

// ★ 模块标记(勿删):本文件用 `require()` 动态加载被测模块(为了在模块加载期先设 env),
//   故没有顶层 `import` —— 而**没有顶层 import/export 的 .ts 会被 TypeScript 当成「全局脚本」**,
//   顶层声明(`type MS`、`const silentFrame` 等)进全局作用域 → 与其它同形态测试文件**跨文件重名冲突**
//   (CI 实测:TS2300 Duplicate identifier / TS2451 Cannot redeclare,整个 suite 加载失败)。
//   本地逐文件转译时不一定暴露,CI 全项目编译必现。`export {}` 把它标记为模块,声明即文件级私有。
export {};
process.env.AIM_FALSE_INTERRUPTION_RECOVERY = "1";
process.env.AIM_FALSE_INTERRUPTION_WINDOW_MS = "2000";
process.env.AIM_FALSE_INTERRUPTION_TAKEOVER_MS = "700";
process.env.AIM_VIOLATION_ENFORCEMENT = "1";
process.env.AIM_SILENCE_VIOLATION_MS = "1000";
process.env.AIM_SILENCE_WARN_MAX = "1"; // 第 1 段沉默警告、第 2 段沉默 → 违规强制结束(原因句)
process.env.AIM_FORCED_END_MAX_WAIT_MS = "10000";
process.env.AIM_MAX_PLAYBACK_LEAD_MS = "0"; // 锚点等价现状(与 design contract 正交)
process.env.AIM_FAREWELL_HANGUP_DELAY_MS = "1500"; // design contract:违规原因句 end 前 drain 延迟(drain 关时的固定回退)

type MSType = typeof import("../src/media-session").MediaSession;

function makeFakes() {
  const nudges: string[] = [];
  const ends: string[] = [];
  const engine: any = {
    started: false,
    paused: 0,
    cancels: [] as string[],
    async start() { this.started = true; },
    pushAudio() {},
    cancel(r: string) { this.cancels.push(r); },
    pause() { this.paused += 1; },
    resume() {},
    async stop() {},
    onAudioOut(cb: any) {
      this._audioOut = (pcm: Buffer) => {
        if (!this._audioStarted) {
          this._audioStarted = true;
          this._turnAudioBegin(17);
        }
        cb(pcm);
      };
    },
    onTurnAudioBegin(cb: any) { this._turnAudioBegin = cb; },
    onTranscript(cb: any) { this._t = cb; },
    onTurnEvent(cb: any) { this._turn = cb; },
    onError() {}, onLlmText() {}, onAiDone(cb: any) { this._aiDone = cb; }, onMetrics() {},
    correctionContext() { return { history: [] }; },
    endTurn() {},
    nudge(text: string) { nudges.push(text); return true; }, // 空闲 fake:nudge 被接受
    suppressNewTurns: false, // design contract:media 在原因句 drain 期置 true(禁引擎起新轮)
    _hasQuestions: true, // 有题(违规裁判/沉默轨生效);无题豁免见 r4-moderation 测试
    hasQuestions() { return this._hasQuestions; },
    _audioStarted: false,
    _turnAudioBegin: (_aiTurnId: number) => {},
    _t: (_: any) => {}, _turn: (_: any) => {}, _aiDone: (_?: boolean) => {}, _audioOut: (_: any) => {},
  };
  const conn: any = {
    sent: [] as unknown[], closed: false,
    send(d: unknown) { this.sent.push(d); }, close() { this.closed = true; },
    _msg: (_d: Buffer, _b: boolean) => {}, _close: () => {},
    on(ev: string, cb: any) { if (ev === "message") this._msg = cb; else this._close = cb; },
    rxBinary(pcm: Buffer) { this._msg(pcm, true); },
    rxText(obj: unknown) { this._msg(Buffer.from(JSON.stringify(obj)), false); },
    textFrames(): Record<string, unknown>[] {
      return this.sent.filter((s: unknown): s is string => typeof s === "string").map((s: string) => JSON.parse(s));
    },
  };
  return { engine, conn, nudges, ends };
}

// 静音帧(RMS 0,保持"有帧"非断流)+ AI 出向帧(非空 → aiSpeaking=true)+ 考生高能量帧(RMS 3000)。
const silentFrame = Buffer.alloc(640);
const aiAudioFrame = Buffer.alloc(960, 1); // 24k 20ms
function speechFrame(): Buffer { const b = Buffer.alloc(640); for (let i = 0; i < 320; i++) b.writeInt16LE(3000, i * 2); return b; }

function freshMediaSession(): MSType {
  jest.resetModules();
  return require("../src/media-session").MediaSession as MSType;
}

async function setup() {
  const MediaSession = freshMediaSession();
  const { engine, conn, nudges, ends } = makeFakes();
  const putFinals: { speaker: string; text: string }[] = [];
  const session = new MediaSession(
    conn,
    { sessionId: "sess_vg", systemPrompt: "你是考官", engineParams: { engineType: "three_stage", language: "zh-CN" } as any },
    { engine, recorder: null as any,
      transcripts: { async putFinal(_sid: string, speaker: string, text: string) { putFinals.push({ speaker, text }); } } as any,
      onEnded: (i: any) => ends.push(i.reason) },
  );
  await session.begin();
  return { session, engine, conn, nudges, ends, putFinals };
}

class FakeRealtimeSocket extends (require("node:events").EventEmitter as typeof import("node:events").EventEmitter) {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    callback();
  }

  close(): void {
    this.readyState = this.CLOSED;
  }

  terminate(): void {
    this.readyState = this.CLOSED;
    this.emit("close");
  }

  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }

  frames(): Array<Record<string, any>> {
    return this.sent.map((frame) => JSON.parse(frame));
  }
}

async function setupOpenAI() {
  const MediaSession = freshMediaSession();
  const { OpenAIRealtimeAdapter } = require("../src/openai-realtime/adapter") as typeof import("../src/openai-realtime/adapter");
  const { engine, nudges, ends } = makeFakes();
  const socket = new FakeRealtimeSocket();
  const adapter = new OpenAIRealtimeAdapter(socket as any, {
    connectionNamespace: "aabbccddeeff00112233445566778899",
  });
  const session = new MediaSession(
    adapter,
    {
      sessionId: "sess_vg_openai",
      systemPrompt: "你是考官",
      engineParams: { engineType: "three_stage", language: "zh-CN" } as any,
    },
    { engine, recorder: null as any, onEnded: (info: any) => ends.push(info.reason) },
  );
  adapter.start();
  await session.begin();
  const conn = {
    rxBinary(pcm: Buffer) {
      socket.receive({
        type: "input_audio_buffer.append",
        audio: pcm.toString("base64"),
      });
    },
  };
  return { session, engine, conn, nudges, ends, socket };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

// AI 真说一句话(出向音频)后正常完整播完 → 进入等待作答态。
function aiSpeaksThenDone(s: { engine: any }) {
  s.engine._audioOut(aiAudioFrame);
  s.engine._aiDone(true);
}
// 驱动一段沉默:AI 说完进等待 → 每 250ms 静音帧 + watchdog tick,累计到 silenceMs。
async function enterWaitingAndSilence(s: { engine: any; conn: any }, silenceMs: number) {
  aiSpeaksThenDone(s);
  const ticks = Math.ceil(silenceMs / 250);
  for (let i = 0; i < ticks; i++) { s.conn.rxBinary(silentFrame); await jest.advanceTimersByTimeAsync(250); }
}

// 触发违规强制结束的原因句:两段沉默(WARN_MAX=1 → 第 1 段警告、第 2 段终局 → armForcedEndAfterNotice 注入原因句)。
async function triggerForcedEndNotice(s: { engine: any; conn: any }) {
  await enterWaitingAndSilence(s, 1500); // 第 1 段 → 警告 nudge
  s.conn.rxBinary(speechFrame());        // 考生开口一下(复位等待窗,让第 2 段沉默重新计)
  s.engine._t({ text: "嗯", isFinal: true }); s.engine._turn("turn_end");
  await enterWaitingAndSilence(s, 1500); // 第 2 段 → 终局 → armForcedEndAfterNotice(注入原因句 nudge)
}

test("R2:违规原因句播报期推持续高能量 → 不 barge-in/不 tentative-pause(受保护轮抑制打断)", async () => {
  const s = await setup();
  await triggerForcedEndNotice(s);
  // 此刻原因句已注入(nudge 起播);模拟原因句轮出声(aiSpeaking=true)。
  s.engine._audioOut(aiAudioFrame);
  const pausedBefore = s.engine.paused;
  // 推持续高能量帧(常规会触发 tentative-pause/barge-in):40 帧 × 20ms。
  for (let i = 0; i < 40; i++) s.conn.rxBinary(speechFrame());
  expect(s.engine.paused).toBe(pausedBefore);       // ★ 受保护:未 pause(无 tentative-pause)
  expect(s.engine.cancels).not.toContain("barge_in"); // ★ 受保护:未确认打断销毁
});

test("R2:抑制打断后原因句 onAiDone(completed)→ 经 drain 延迟后挂断 silence_violation(不立即 end 截断客户端播放尾)", async () => {
  const s = await setup();
  await triggerForcedEndNotice(s);
  s.engine._audioOut(aiAudioFrame);            // 原因句出声
  for (let i = 0; i < 40; i++) s.conn.rxBinary(speechFrame()); // 用户持续说话(被抑制,不打断)
  s.engine._aiDone(true);                       // 原因句完整下发(tts_done)
  // ★ review(completed) 是「服务端下发完成」≠「客户端播完」。若立即 end,前端收 ended 清队列 →
  //   原因句尾被截断。故 end MUST 经 drain 延迟(与 design contract farewell 一致)。
  await jest.advanceTimersByTimeAsync(0);       // 刷微任务
  expect(s.ends).toHaveLength(0);               // ★ 未立即 end(drain 窗内)
  await jest.advanceTimersByTimeAsync(1500);    // 走完 drain 延迟(drain 关回退固定 1500ms)
  expect(s.ends).toContain("silence_violation"); // drain 后才挂(客户端播完原因句)
});

test("R2 drain:违规 end 的 drain 延迟期间用户持续说话**不能取消**该 end(违规结束不可被用户挽留)", async () => {
  const s = await setup();
  await triggerForcedEndNotice(s);
  s.engine._audioOut(aiAudioFrame);
  s.engine._aiDone(true);                       // 原因句下发完 → 排 drain 延迟 end
  await jest.advanceTimersByTimeAsync(0);
  expect(s.ends).toHaveLength(0);               // drain 窗内未挂
  // drain 窗内用户持续说话(高能量帧)——普通告别 drain 会被 cancelPendingHangup 取消,违规 end MUST NOT 被取消。
  for (let i = 0; i < 40; i++) s.conn.rxBinary(speechFrame());
  await jest.advanceTimersByTimeAsync(1500);
  expect(s.ends).toContain("silence_violation"); // 违规 end 仍如期发生(用户说话不能挽留违规结束)
});

test("R2 drain(review 复核 Blocker):drain 期新轮 onAiDone(completed) **不重排/不重注入** → drain 不被无限延期", async () => {
  const s = await setup();
  await triggerForcedEndNotice(s);
  s.engine._audioOut(aiAudioFrame);
  const noticeNudges = s.nudges.length;         // 记原因句注入后的 nudge 数
  s.engine._aiDone(true);                       // 原因句下发完 → 排 drain(t=0 起 1500ms)
  await jest.advanceTimersByTimeAsync(0);
  expect(s.ends).toHaveLength(0);
  // drain 窗内(750ms 处)混进一个"新轮" onAiDone(completed)——模拟 review 场景:用户 drain 期说话触发新普通轮完成。
  await jest.advanceTimersByTimeAsync(750);
  s.engine._audioOut(aiAudioFrame);
  s.engine._aiDone(true);                       // ★ 若重入 completed 分支 → 重排 drain(延期)+ 可能重注入原因句
  expect(s.nudges).toHaveLength(noticeNudges);  // ★ 不重注入原因句(drain 期不再说一遍)
  // 从原 drain 起点算,再过 750ms 即到原定 1500ms → end MUST 如期发生(未被新轮延期)
  await jest.advanceTimersByTimeAsync(750);
  expect(s.ends).toContain("silence_violation"); // ★ drain 未被延期:原定时刻就 end(证明新轮没重排)
});

test("R2:客户端上行 barge_in 帧在受保护轮被忽略(不切源/不销毁)", async () => {
  const s = await setup();
  await triggerForcedEndNotice(s);
  s.engine._audioOut(aiAudioFrame);   // 原因句出声(aiSpeaking=true)
  s.conn.rxText({ type: "barge_in" }); // 客户端上行 barge_in
  expect(s.engine.cancels).not.toContain("barge_in"); // ★ 受保护轮忽略,不 onBargeIn 切源
});

// ── review 复核 Blocker 1+2:drain 期保持 guard + AI 独占窗口抑制 ASR 副作用(不下发 user transcript 帧防前端 stopPlayback)──

test("R2.5(review):原因句进 drain 后 guard 仍保持(不在 onAiDone 顶部误清)", async () => {
  const s = await setup();
  await triggerForcedEndNotice(s);
  s.engine._audioOut(aiAudioFrame);
  s.engine._aiDone(true);              // 原因句下发完 → 进 drain
  await jest.advanceTimersByTimeAsync(0);
  expect(s.ends).toHaveLength(0);      // drain 窗内(未 end)
  // guard 仍为真的**有意义**证据:drain 期 user final **不下发 transcript 帧**(AI 独占窗口仍生效)。
  //   若 guard 在 onAiDone 顶部被误清(Blocker 1),drain 期 user final 会照常下发帧 → 前端 stopPlayback 截断尾音。
  const framesBefore = s.conn.textFrames().filter((f: Record<string, unknown>) => f.type === "transcript").length;
  s.engine._t({ text: "我想打断说话", isFinal: true });
  const framesAfter = s.conn.textFrames().filter((f: Record<string, unknown>) => f.type === "transcript").length;
  expect(framesAfter).toBe(framesBefore); // ★ drain 期 guard 保持 → user final 不下发帧(尾音不被前端截断)
  expect(s.putFinals.some((p) => p.text === "我想打断说话")).toBe(true); // 仍落库(evaluator 看到)
});

test("R2.5(review):AI 独占窗口内 user final **不下发 transcript 帧**(防前端 stopPlayback 截断)但仍 putFinal 落库", async () => {
  const s = await setup();
  await triggerForcedEndNotice(s);
  s.engine._audioOut(aiAudioFrame);   // 原因句出声(guard=true)
  const framesBefore = s.conn.textFrames().filter((f: Record<string, unknown>) => f.type === "transcript").length;
  const putBefore = s.putFinals.length;
  // 窗口内用户说话产生 ASR final
  s.engine._t({ text: "我还想再说两句", isFinal: true });
  const framesAfter = s.conn.textFrames().filter((f: Record<string, unknown>) => f.type === "transcript").length;
  expect(framesAfter).toBe(framesBefore); // ★ 不下发 user transcript 帧(前端收不到 → 不 stopPlayback → 尾音不截断)
  expect(s.putFinals.some((p) => p.speaker === "user" && p.text === "我还想再说两句")).toBe(true); // ★ 仍落库供 evaluator
});

test("R2.5 OpenAI port:drain 期 user final 被 discard,不创建悬空 GA user item", async () => {
  const s = await setupOpenAI();
  // The preceding tests prove the forced-end transition. Start this boundary
  // test at its stable drain state so unrelated response audio does not need a
  // synthetic response identity.
  Object.assign(s.session as any, {
    violationNoticeGuard: true,
    forcedEndDraining: true,
  });

  s.conn.rxBinary(speechFrame());
  s.engine._t({
    text: "原因句 drain 期输入",
    isFinal: true,
    inputEpoch: 0,
    inputTurnId: 0,
  });
  s.engine._turn("turn_end", { inputEpoch: 0, inputTurnId: 0 });
  await Promise.resolve();

  const frames = s.socket.frames();
  expect(frames.filter((frame) => frame.type === "conversation.item.added")).toHaveLength(0);
  expect(frames.filter((frame) => frame.type === "conversation.item.done")).toHaveLength(0);
  expect(frames).toContainEqual(
    expect.objectContaining({
      type: "error",
      error: expect.objectContaining({
        code: "invalid_request",
        message: "input audio was discarded while the session was ending",
      }),
    }),
  );
  await s.session.detach();
});

test("R2.5(挡新轮):原因句进 drain → engine.suppressNewTurns 置 true;drain 完 end→teardown 清回 false", async () => {
  const s = await setup();
  await triggerForcedEndNotice(s);
  s.engine._audioOut(aiAudioFrame);
  s.engine._aiDone(true);              // 原因句下发完 → 进 drain
  await jest.advanceTimersByTimeAsync(0);
  expect(s.engine.suppressNewTurns).toBe(true); // ★ drain 期禁引擎起新轮(防新音频打断原因句尾)
  await jest.advanceTimersByTimeAsync(1500);    // drain 完 → end → teardown
  expect(s.engine.suppressNewTurns).toBe(false); // ★ 收尾清回 false(不永久禁言)
});

test("R2.5(警告句不置):警告句轮不进 drain → 不置 suppressNewTurns(继续对话)", async () => {
  const s = await setup();
  await enterWaitingAndSilence(s, 1500); // 警告 nudge(未到终局,不 drain)
  s.engine._audioOut(aiAudioFrame);
  s.engine._aiDone(true);             // 警告句播完(非 drain)
  expect(s.engine.suppressNewTurns).toBe(false); // ★ 警告句不禁新轮(播完继续对话)
});

test("R2.5 边界(不回归):警告句轮播完后 guard 关 → 用户正常应答**照常下发** transcript 帧(不吞应答)", async () => {
  const s = await setup();
  await enterWaitingAndSilence(s, 1500); // 第 1 段沉默 → 警告 nudge(guard 置)
  expect(s.nudges.length).toBeGreaterThanOrEqual(1);
  s.engine._audioOut(aiAudioFrame);   // 警告句出声(guard=true)
  s.engine._aiDone(true);             // 警告句播完 → guard 关(非 drain,警告轮结束)
  const framesBefore = s.conn.textFrames().filter((f: Record<string, unknown>) => f.type === "transcript").length;
  s.engine._t({ text: "好我继续说", isFinal: true }); // 警告后用户正常应答
  const framesAfter = s.conn.textFrames().filter((f: Record<string, unknown>) => f.type === "transcript").length;
  expect(framesAfter).toBe(framesBefore + 1); // ★ 警告轮后 guard 已关 → 用户应答照常下发(不误吞)
});

test("R2 对照(不回归):普通对话轮同样高能量仍触发 tentative-pause(guard 仅违规发言轮为真)", async () => {
  const s = await setup();
  // 普通 AI 轮:出声(aiSpeaking=true),非违规发言。
  s.engine._audioOut(aiAudioFrame);
  const pausedBefore = s.engine.paused;
  for (let i = 0; i < 40; i++) s.conn.rxBinary(speechFrame());
  expect(s.engine.paused).toBeGreaterThan(pausedBefore); // 普通轮仍可 tentative-pause(现状不回归)
});

test("R2 真故障兜底:原因句 onAiDone 始终不来 → 硬超时仍强制 end(不永久卡)", async () => {
  const s = await setup();
  await triggerForcedEndNotice(s);
  s.engine._audioOut(aiAudioFrame); // 原因句出声,但引擎故障:onAiDone 永不到达
  for (let i = 0; i < 40; i++) s.conn.rxBinary(speechFrame()); // 用户持续说话(被抑制)
  await jest.advanceTimersByTimeAsync(10_000); // 硬超时到点
  expect(s.ends).toContain("silence_violation"); // 真故障兜底仍结束
});

test("R2:违规警告句(未到终局)播报期也受保护 → 不打断,播完后继续对话(不挂断)", async () => {
  const s = await setup();
  await enterWaitingAndSilence(s, 1500); // 第 1 段沉默 → 警告 nudge(WARN_MAX=1,未到终局)
  expect(s.nudges.length).toBeGreaterThanOrEqual(1); // 已发警告
  s.engine._audioOut(aiAudioFrame);   // 警告句出声(aiSpeaking=true)
  const pausedBefore = s.engine.paused;
  for (let i = 0; i < 40; i++) s.conn.rxBinary(speechFrame()); // 用户持续说话
  expect(s.engine.paused).toBe(pausedBefore);       // ★ 警告句也受保护:不打断
  s.engine._aiDone(true);                            // 警告句播完
  expect(s.ends).toHaveLength(0);                    // 警告轮播完继续对话,不挂断
});

test("变异验证:clearViolationNoticeGuard 在 onAiDone 必须调用(否则 guard 泄漏到下一普通轮)", async () => {
  const s = await setup();
  await enterWaitingAndSilence(s, 1500); // 第 1 段沉默 → 警告 nudge(置 guard)
  expect(s.nudges.length).toBeGreaterThanOrEqual(1); // 已发警告
  s.engine._audioOut(aiAudioFrame); // 警告句出声
  s.engine._aiDone(true);            // 警告句播完 → 应清 guard
  // 下一轮:普通 AI 对话轮
  s.engine._audioOut(aiAudioFrame);
  const pausedBefore = s.engine.paused;
  for (let i = 0; i < 40; i++) s.conn.rxBinary(speechFrame()); // 高能量
  // ★ 断言:普通轮仍可打断(guard 已清,未泄漏)
  expect(s.engine.paused).toBeGreaterThan(pausedBefore); // 普通轮触发 tentative-pause
});

test("R2 边界:原因句被打断(completed=false)→ 清 playing 但 guard 也清(下次重试重置 guard)", async () => {
  const s = await setup();
  await triggerForcedEndNotice(s);
  s.engine._audioOut(aiAudioFrame); // 原因句出声
  // 模拟原因句轮异常终止(LLM/TTS 失败,completed=false)
  s.engine._aiDone(false);
  // 此时:forcedEndNoticePlaying=false(清了),guard 也应清(onAiDone 顶部)
  // 下一轮普通对话应可打断
  s.engine._audioOut(aiAudioFrame);
  const pausedBefore = s.engine.paused;
  for (let i = 0; i < 40; i++) s.conn.rxBinary(speechFrame());
  expect(s.engine.paused).toBeGreaterThan(pausedBefore); // 可打断
});
