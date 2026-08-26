/**
 * design contract:沉默防作弊计数集成测试(服务端计时,不走 LLM)。断言:
 *  - 真沉默(有帧低能量)超阈值 → 计一次消极对抗事件;
 *  - 一次长沉默(watchdog 每 250ms tick,180 次)只计 1 次(silenceCountedThisWait 防重复);
 *  - 断流(无帧超 NO_FRAME_MS)不计(物理断连非作弊);
 *  - 考生开口 → 退出等待态,下段沉默重新起窗再计;
 *  - enforcement 关(默认)→ 只 log 计数,不 nudge 警告 / 不 end 挂断(shadow);
 *  - enforcement 开:前 N 次 nudge 警告,第 N+1 次 end("silence_violation")。
 *
 * 常量在模块加载期读 env(VIOLATION_ENFORCEMENT/SILENCE_*),故用 jest.resetModules() + 设 env + fresh require。
 * fake timers 驱动 watchdog(250ms/tick)+ Date.now。
 */

// ★ 模块标记(勿删):本文件用 `require()` 动态加载被测模块(为了在模块加载期先设 env),
//   故没有顶层 `import` —— 而**没有顶层 import/export 的 .ts 会被 TypeScript 当成「全局脚本」**,
//   顶层声明(`type MS`、`const silentFrame` 等)进全局作用域 → 与其它同形态测试文件**跨文件重名冲突**
//   (CI 实测:TS2300 Duplicate identifier / TS2451 Cannot redeclare,整个 suite 加载失败)。
//   本地逐文件转译时不一定暴露,CI 全项目编译必现。`export {}` 把它标记为模块,声明即文件级私有。
export {};
type MS = import("../src/media-session").MediaSession;

// ── 可控 fake 引擎/连接(每个测试 fresh require MediaSession,故这里用工厂而非顶层 import 类)──
function makeFakes() {
  const nudges: string[] = [];
  const ends: string[] = [];
  const engine: any = {
    started: false,
    async start() { this.started = true; },
    pushAudio() {}, cancel() {}, async stop() {},
    onAudioOut(cb: any) { this._audioOut = cb; }, onTranscript(cb: any) { this._t = cb; }, onTurnEvent(cb: any) { this._turn = cb; },
    onError() {}, onLlmText() {}, onAiDone(cb: any) { this._aiDone = cb; }, onMetrics() {},
    correctionContext() { return { history: [] }; },
    endTurn() {},
    nudge(text: string) { nudges.push(text); return true; }, // 空闲 fake:nudge 被接受(design contract)
    // design contract:_hasQuestions 默认 true(现有沉默测试均"有题考官"语境,行为不变);豁免测试显式置 false。
    _hasQuestions: true,
    hasQuestions() { return this._hasQuestions; },
    _t: (_: any) => {}, _turn: (_: any) => {}, _aiDone: () => {}, _audioOut: (_: any) => {},
  };
  const conn: any = {
    sent: [] as unknown[], closed: false,
    send(d: unknown) { this.sent.push(d); }, close() { this.closed = true; },
    _msg: (_d: Buffer, _b: boolean) => {}, _close: () => {},
    on(ev: string, cb: any) { if (ev === "message") this._msg = cb; else this._close = cb; },
    rxBinary(pcm: Buffer) { this._msg(pcm, true); },
  };
  return { engine, conn, nudges, ends };
}

// 低能量帧(RMS < 端点阈值)= 真沉默时仍在流入的「静音帧」。
const silentFrame = Buffer.alloc(640); // 全 0 → RMS 0 < 阈值
// AI 出向音频帧(24k s16le,非空 → onAudioOut 置 aiSpeaking=true)。内容任意(降采样后仍非空即可)。
const aiAudioFrame = Buffer.alloc(960, 1); // 24k 20ms;非零字节(内容无所谓,只为置 aiSpeaking)
// 考生高能量入向帧(RMS 3000 >> 端点阈值 500)= 真说话帧。640B = 320 samples int16 @16k = 20ms。
const speechFrame = (() => { const b = Buffer.alloc(640); for (let i = 0; i < 320; i++) b.writeInt16LE(3000, i * 2); return b; })();

function freshMediaSession() {
  jest.resetModules();
  return require("../src/media-session").MediaSession as typeof import("../src/media-session").MediaSession;
}

async function setup(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const MediaSession = freshMediaSession();
  const { engine, conn, nudges } = makeFakes();
  const ends: string[] = [];
  const session = new MediaSession(
    conn,
    { sessionId: "sess_s", systemPrompt: "你是考官", engineParams: { engineType: "three_stage", language: "zh-CN" } as any },
    { engine, recorder: null as any, transcripts: { async putFinal() {} } as any, onEnded: (i: any) => ends.push(i.reason) },
  );
  await session.begin();
  return { session, engine, conn, nudges, ends };
}

const SILENCE_ENVS = ["AIM_VIOLATION_ENFORCEMENT", "AIM_SILENCE_VIOLATION_MS", "AIM_SILENCE_WARN_MAX", "AIM_NO_FRAME_MS", "AIM_FORCED_END_MAX_WAIT_MS", "AIM_MAX_PLAYBACK_LEAD_MS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  // 先存后删:清除继承自外部 shell / 前一测试的 env,确保「未设 = 默认」语义纯净(review)。
  for (const k of SILENCE_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
  // ★ design contract:锁 AIM_MAX_PLAYBACK_LEAD_MS=0 → computePlaybackNotBeforeMs 恒返回 now(clamp lead 到 0),
  //   使沉默起算锚点逐字节等价现状(=tts_done 后 now)。本文件专测 design contract 沉默逻辑,与 design contract
  //   播放边界后移正交;R3 的锚点后移由 media-session-playback-boundary.test.ts 专测。
  process.env.AIM_MAX_PLAYBACK_LEAD_MS = "0";
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers(); jest.useRealTimers();
  for (const k of SILENCE_ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
});

// AI 真说一句话(出向音频)后**正常完整播完** onAiDone(completed=true)→ enterWaitingForAnswer 进等待作答态。
//   design contract(review二审修):onAiDone 只在引擎权威 `completed=true`(本轮正常完整播完)才进等待。
//   打断/超时/流错走 completed=false(见下方 Blocker 回归测试),故此处显式传 true 模拟正常收尾。
function aiSpeaksThenDone(s: { engine: any }) {
  s.engine._audioOut(aiAudioFrame); // AI 出声(真机上 fullyPlayed 前必出过音频)
  s.engine._aiDone(true); // 正常完整播完 → enterWaitingForAnswer(waitingSinceMs=now)
}

// 驱动:AI 说完(进入等待作答)→ 推低能量帧 → 推进时间到沉默阈值,让 watchdog tick 检测。
async function enterWaitingAndSilence(s: { engine: any; conn: any }, silenceMs: number) {
  aiSpeaksThenDone(s); // AI 出声 + onAiDone → 进等待作答态(waitingSinceMs=now)
  // 每 250ms 一个静音帧(保持"有帧",非断流)+ 让 watchdog tick。
  const ticks = Math.ceil(silenceMs / 250);
  for (let i = 0; i < ticks; i++) {
    s.conn.rxBinary(silentFrame); // 更新 lastInboundFrameAtMs(有帧)
    await jest.advanceTimersByTimeAsync(250); // 走一个 watchdog tick
  }
}

test("enforcement **显式关**(kill switch):真沉默超阈值 → 只计数不 nudge/不 end(shadow)", async () => {
  // ★ design contract B 类:AIM_VIOLATION_ENFORCEMENT 默认已改开 → shadow 契约须显式 =0。
  const s = await setup({ AIM_SILENCE_VIOLATION_MS: "1000", AIM_VIOLATION_ENFORCEMENT: "0" });
  await enterWaitingAndSilence(s, 1500);
  expect(s.nudges).toHaveLength(0); // 关:不警告
  expect(s.ends).toHaveLength(0); // 关:不挂断
});

test("design contract(沉默豁免):自由聊天(无题)长沉默 → 不计沉默违规、不 nudge、不 end(聊天不因静默被强制收尾)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "3" });
  s.engine._hasQuestions = false; // 自由聊天(无题)
  await enterWaitingAndSilence(s, 45_000); // 45s 连续沉默——有题会强制结束,自由聊天应豁免
  expect(s.nudges).toHaveLength(0); // ★ 无题:不 nudge 警告(沉默豁免,计数前门控)
  expect(s.ends).toHaveLength(0);   // ★ 无题:不强制结束(守住「AI 永不主动挂」)
});

test("design contract(违规保留对照):自由聊天沉默豁免不影响有题——有题同样长沉默仍强制结束", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "1" });
  s.engine._hasQuestions = true; // 有题(测评)——现状不变
  await enterWaitingAndSilence(s, 5_000); // 第 1 段沉默 → nudge 警告(WARN_MAX=1)
  expect(s.nudges.length).toBeGreaterThanOrEqual(1); // 有题:仍计沉默、仍警告(R3 不豁免有题)
});

test("一次长沉默只计一次(45s / 180 tick,不重复计数)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "3" });
  await enterWaitingAndSilence(s, 45_000); // 45s 连续沉默(180 tick)
  // 一次沉默只计一次 → 只 1 次警告(nudge),绝非 45 次。
  expect(s.nudges).toHaveLength(1);
  expect(s.ends).toHaveLength(0);
});

test("断流(无帧超 NO_FRAME_MS)不计沉默", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_NO_FRAME_MS: "500" });
  aiSpeaksThenDone(s); // AI 出声 + onAiDone → 进等待;但**不推任何入向帧**(模拟断流;AI 出向音频不算入向)
  await jest.advanceTimersByTimeAsync(3000); // 沉默超阈值,但无帧超 NO_FRAME_MS
  expect(s.nudges).toHaveLength(0); // 断流不计(物理断连,非作弊)
  expect(s.ends).toHaveLength(0);
});

test("考生开口 → 退出等待态,下段沉默重新计(每段一次)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "5" });
  await enterWaitingAndSilence(s, 1500); // 第 1 段沉默 → 计 1
  expect(s.nudges).toHaveLength(1);
  s.engine._turn("turn_end"); // 一轮结束
  await enterWaitingAndSilence(s, 1500); // 第 2 段沉默(helper 内 AI 再说 → 新窗)→ 再计 1
  expect(s.nudges).toHaveLength(2);
});

test("警告升级:前 N 次 nudge 警告,第 N+1 次 forcedEndAfterNotice(说明原因→onAiDone→end silence_violation)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "3" });
  for (let seg = 0; seg < 4; seg++) {
    await enterWaitingAndSilence({ engine: s.engine, conn: s.conn }, 1500); // helper 内 AI 说 → 新窗 → 沉默计 1
    s.engine._turn("turn_end");
  }
  // design contract:前 3 次警告 nudge + 第 4 次注入「说明原因」nudge = 共 4 条;此刻**还没 end**(等原因句 onAiDone)。
  expect(s.nudges).toHaveLength(4);
  expect(s.nudges[3]).toContain("本次测评到此结束"); // 第 4 条是违规结束原因句
  expect(s.ends).toHaveLength(0); // 原因句未播完 → 尚未 end
  // 原因句轮下发完(onAiDone completed)→ design contract:经 drain 延迟(待客户端播完原因句)才违规强制结束。
  s.engine._aiDone(true);
  await jest.advanceTimersByTimeAsync(0);
  expect(s.ends).toHaveLength(0); // drain 窗内尚未 end(不立即截断客户端播放尾)
  await jest.advanceTimersByTimeAsync(1500); // 走完 drain(drain 关 → 回退固定 FAREWELL_HANGUP_DELAY_MS 1500)
  expect(s.ends).toContain("silence_violation");
});

test("R3 硬超时兜底:违规原因句卡住(onAiDone 不来)→ 到点强制 end", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "3", AIM_FORCED_END_MAX_WAIT_MS: "5000" });
  for (let seg = 0; seg < 4; seg++) {
    await enterWaitingAndSilence({ engine: s.engine, conn: s.conn }, 1500);
    s.engine._turn("turn_end");
  }
  expect(s.ends).toHaveLength(0); // 原因句注入,等 onAiDone
  // **不触发 onAiDone**(原因句 LLM/TTS 卡住)→ 推进时间过硬超时 → 兜底强制 end
  await jest.advanceTimersByTimeAsync(5001);
  expect(s.ends).toContain("silence_violation"); // 硬超时兜底结束(不永久卡)
});

test("考生真开口(高能量入向帧走 trackEndpoint)→ 退出等待态复位(review:真实复位路径,非 mock)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "5" });
  aiSpeaksThenDone(s); // 进等待态(aiSpeaking 已在 onAiDone 置回 false → 入向走 trackEndpoint 而非 detectBargeIn)
  // 沉默 750ms(未达 1000ms 阈值)后考生真开口:连推 ≥ ENDPOINT_MIN_SPEECH_MS(300ms)高能量帧 → trackEndpoint
  //   累计 speechMs 达门槛 → 清 waitingSinceMs。这是真实音频路径(rxBinary→onMessage→trackEndpoint),非 helper mock。
  for (let i = 0; i < 3; i++) { s.conn.rxBinary(silentFrame); await jest.advanceTimersByTimeAsync(250); }
  expect(s.nudges).toHaveLength(0); // 750ms < 1000ms,还没到阈值
  for (let i = 0; i < 20; i++) { s.conn.rxBinary(speechFrame); await jest.advanceTimersByTimeAsync(20); } // 400ms 真语音 > 300ms 门
  // 再沉默很久:因考生刚说过话(lastSpeechAtMs 刚刷新)+ waitingSinceMs 已被 trackEndpoint 清 → 不该计沉默。
  for (let i = 0; i < 8; i++) { s.conn.rxBinary(silentFrame); await jest.advanceTimersByTimeAsync(250); }
  expect(s.nudges).toHaveLength(0); // 考生开口复位了等待态 → 这段沉默不计(要等 AI 再说完才重新起窗)
});

test("考生亚阈开口(能量帧但未累计 300ms)刷新沉默钟 → 不被误计/nudge 抢话(review)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "5" });
  aiSpeaksThenDone(s); // 进等待态
  // 考生每 ~800ms 冒一个能量帧(单帧 20ms << 300ms 有效语音门 → 不清 waitingSinceMs,但刷新 lastSpeechAtMs),
  //   其间静音。若沉默基线只看 waitingSinceMs(旧 bug),1000ms 后就误计;修后基线取 max(waitingSinceMs,lastSpeechAtMs),
  //   考生每次冒声都把钟拨回 → 永不达 1000ms 连续沉默。跑 5 轮(~4s,远超 1000ms)验证不误计。
  for (let round = 0; round < 5; round++) {
    s.conn.rxBinary(speechFrame); await jest.advanceTimersByTimeAsync(20); // 亚阈开口一帧(刷新 lastSpeechAtMs)
    for (let i = 0; i < 3; i++) { s.conn.rxBinary(silentFrame); await jest.advanceTimersByTimeAsync(250); } // 静默 750ms
  }
  expect(s.nudges).toHaveLength(0); // 亚阈开口持续刷新沉默钟 → 无连续 1000ms 沉默 → 不误计/不抢话
});

test("Blocker 回归:AI 一字没说(completed=false)的 onAiDone 不进等待态 → 不计沉默", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "3" });
  s.engine._aiDone(false); // LLM 超时/TTS 失败,引擎自终结 → completed=false → 不进等待态
  for (let i = 0; i < 12; i++) { s.conn.rxBinary(silentFrame); await jest.advanceTimersByTimeAsync(250); } // 3s 静默
  expect(s.nudges).toHaveLength(0); // 没进等待态(waitingSinceMs=0)→ checkSilenceViolation 提前返回,不计
  expect(s.ends).toHaveLength(0);
});

test("Blocker 回归:barge-in 打断(completed=false)的 onAiDone 不进等待态", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "3" });
  s.engine._audioOut(aiAudioFrame); // AI 开口出过音频
  s.session.onBargeIn(); // 考生打断,考生此刻正在说话
  s.engine._aiDone(false); // 引擎 cancel(barge_in)→ fireAiDone(turn,false)→ onAiDone completed=false
  for (let i = 0; i < 12; i++) { s.conn.rxBinary(silentFrame); await jest.advanceTimersByTimeAsync(250); }
  expect(s.nudges).toHaveLength(0); // 打断路径不进等待态 → 考生思考的沉默不背锅
  expect(s.ends).toHaveLength(0);
});

test("Blocker 二审回归:AI 流出半句音频后中途失败(出过音频但 completed=false)不进等待态", async () => {
  // ★ 这是 review 二审揪出的关键场景:旧 aiWasSpeaking 快照(=本轮出过音频)会误判「说完了」→ 题没念完
  //   就起沉默钟。引擎 partial 路径(reportMetrics partial + fireAiDone(turn,false))下 completed=false,
  //   media-session MUST 据引擎权威信号不进等待态——即便本轮确实出过音频(aiSpeaking 曾为 true)。
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "3" });
  s.engine._audioOut(aiAudioFrame); // AI 出了半句音频(aiSpeaking=true)
  s.engine._audioOut(aiAudioFrame); // 又一帧
  s.engine._aiDone(false); // 半句后 LLM 流错 → 引擎 partial + fireAiDone(turn,false)→ completed=false
  for (let i = 0; i < 12; i++) { s.conn.rxBinary(silentFrame); await jest.advanceTimersByTimeAsync(250); } // 3s 静默
  expect(s.nudges).toHaveLength(0); // 题没念完 → 不进等待态 → 不计沉默(旧 aiWasSpeaking 会在此误计)
  expect(s.ends).toHaveLength(0);
});

test("向后兼容:onAiDone 不传 completed(undefined)按正常播完处理(进等待态)", async () => {
  const s = await setup({ AIM_VIOLATION_ENFORCEMENT: "1", AIM_SILENCE_VIOLATION_MS: "1000", AIM_SILENCE_WARN_MAX: "3" });
  s.engine._audioOut(aiAudioFrame);
  s.engine._aiDone(); // 不传参 → aiCompleted = undefined !== false = true → 进等待态(退化为现状语义)
  for (let i = 0; i < 6; i++) { s.conn.rxBinary(silentFrame); await jest.advanceTimersByTimeAsync(250); } // 1.5s 静默
  expect(s.nudges).toHaveLength(1); // 进了等待态 → 沉默超阈值 → 计一次警告
});
