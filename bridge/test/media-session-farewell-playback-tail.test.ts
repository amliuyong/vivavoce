/**
 * Regression for sess_example:
 * tts_done was followed by the configured 8s farewell cap, while the browser
 * still had queued audio and cut the final sentence after "进一步巩固".
 */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";

// ★ 提高本 suite 超时(jest 默认 5000ms)—— **不是掩盖死锁,是这两个用例天然慢**。
//
//   它们用 `jest.advanceTimersByTimeAsync(8001)` 逐 tick 推进虚拟时钟,期间每个 250ms 的
//   watchdog interval 都触发一次回调 → 累计上万次微任务,本地实测单个用例 3.5~3.8s。
//   默认 5000ms 只剩 ~1.3s 余量,CI runner 稍慢即可能超时(
//   `bridge:jest` 因此失败,而同一份代码在本地与 GitHub Actions 均通过 —— 典型的
//   「阈值贴着实测值」的脆弱测试,不是代码缺陷)。
//
//   30000ms ≈ 本地最慢值的 8 倍:CI 慢几倍都够,又远小于「真死锁」会耗尽的时间,
//   故仍能把死锁暴露为超时失败而非静默挂起。
jest.setTimeout(30_000);

function makeFakes() {
  const engine: any = {
    async start() {}, pushAudio() {}, cancel() {}, async stop() {},
    onAudioOut(cb: any) { this._audioOut = cb; },
    onTranscript() {},
    onTurnEvent() {},
    onError() {},
    onLlmText(cb: any) { this._llmText = cb; },
    onAiDone(cb: any) { this._aiDone = cb; },
    onResponseStarted(cb: any) { this._responseStarted = cb; },
    onResponseSegmentDeclared(cb: any) { this._responseSegmentDeclared = cb; },
    onResponseServerDrained(cb: any) { this._responseServerDrained = cb; },
    setResponseWireDrainRequired(required: boolean) {
      this._responseWireDrainRequired = required;
    },
    onMetrics() {},
    hasPendingQuestions() { return false; },
    hasQuestions() { return true; },
    _audioOut: (_pcm: Buffer) => {},
    _llmText: (_text: string) => {},
    _aiDone: (_completed?: boolean) => {},
    _responseStarted: () => {},
    _responseSegmentDeclared: () => {},
    _responseServerDrained: () => Date.now(),
    _responseWireDrainRequired: false,
  };
  const conn: any = {
    closed: false,
    send() {},
    close() { this.closed = true; },
    on() {},
  };
  return { engine, conn };
}

function audioFrame(durMs: number): Buffer {
  return Buffer.alloc(Math.round(24_000 * durMs / 1000) * 2);
}

const ENVS = [
  "AIM_FAREWELL_TAIL_MS",
  "AIM_FAREWELL_DRAIN_MAX_MS",
  "AIM_FAREWELL_HANGUP_DELAY_MS",
  "AIM_SEMANTIC_END",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENVS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AIM_FAREWELL_TAIL_MS = "1000";
  process.env.AIM_FAREWELL_HANGUP_DELAY_MS = "1500";
  process.env.AIM_SEMANTIC_END = "0";
  jest.useFakeTimers();
  jest.resetModules();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  for (const key of ENVS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
});

async function setup() {
  const { MediaSession } = await import("../src/media-session");
  const { engine, conn } = makeFakes();
  const session = new MediaSession(
    conn,
    {
      sessionId: "sess_example",
      systemPrompt: "你是考官",
      engineParams: { engineType: "three_stage", language: "zh-CN" } as any,
    },
    { engine, recorder: null, transcripts: null, metrics: null },
  );
  await session.begin();
  return { session, engine, conn };
}

function finishAiTurn(engine: any, text: string, audioMs: number): void {
  engine._audioOut(audioFrame(audioMs));
  engine._llmText(text);
  engine._aiDone(true);
}

test("长告别默认不会在旧 8s 硬上限处切断", async () => {
  const { session, engine, conn } = await setup();
  try {
    finishAiTurn(
      engine,
      "好的，整体来看你对 Amazon Q 的核心概念有一定的了解，一些细节上还可以进一步巩固。感谢你的参与，再见。",
      12_000,
    );

    await jest.advanceTimersByTimeAsync(8_001);
    expect(conn.closed).toBe(false);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(conn.closed).toBe(true);
  } finally {
    await session.detach();
  }
});

test("告别挂断等待会话级播放队尾，而不是只等告别轮首帧加本轮时长", async () => {
  const { session, engine, conn } = await setup();
  try {
    finishAiTurn(engine, "上一轮仍在客户端队列中。", 4_000);
    await jest.advanceTimersByTimeAsync(500);

    finishAiTurn(engine, "感谢你的参与，再见。", 4_000);

    await jest.advanceTimersByTimeAsync(5_001);
    expect(conn.closed).toBe(false);

    await jest.advanceTimersByTimeAsync(3_500);
    expect(conn.closed).toBe(true);
  } finally {
    await session.detach();
  }
});

async function setupCallbackConfirmedFarewell() {
  const { MediaSession } = await import("../src/media-session");
  const { engine } = makeFakes();
  let commandHandler: (command: any) => void | Promise<void> = () => undefined;
  const transport: any = {
    protocolNeutral: true,
    outputDelivery: "callback_confirmed",
    closed: false,
    onCommand(callback: (command: any) => void | Promise<void>) {
      commandHandler = callback;
    },
    onClose() {},
    emit() {},
    close() {
      this.closed = true;
    },
  };
  const session = new MediaSession(
    transport,
    {
      sessionId: "sess_callback_confirmed_farewell",
      systemPrompt: "你是考官",
      engineParams: { engineType: "three_stage", language: "zh-CN" } as any,
    },
    { engine, recorder: null, transcripts: null, metrics: null },
  );
  await session.begin();
  engine._responseStarted({ responseGeneration: 1, turnSeq: 1 });
  engine._responseSegmentDeclared({
    responseGeneration: 1,
    turnSeq: 1,
    segmentId: 1,
    text: "感谢你的参与，再见。",
  });
  engine._audioOut(audioFrame(4_000), {
    responseGeneration: 1,
    turnSeq: 1,
    segmentId: 1,
  });
  await commandHandler({
    type: "note_output_handoff",
    responseGeneration: 1,
    segmentId: 1,
    deltaSeq: 0,
    samples24k: 96_000,
    handedOffAtMs: Date.now(),
  });
  engine._llmText("感谢你的参与，再见。");
  return { engine, session, transport };
}

test("callback-confirmed 告别只等到绝对播放 deadline，不在 settlement 后重复整段延迟", async () => {
  const { engine, session, transport } =
    await setupCallbackConfirmedFarewell();
  try {
    const playbackNotBeforeMs = engine._responseServerDrained(1);
    expect(playbackNotBeforeMs - Date.now()).toBe(5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    engine._aiDone(true, 1);
    await jest.advanceTimersByTimeAsync(1);

    expect(transport.closed).toBe(true);
  } finally {
    await session.detach();
  }
});

test("callback-confirmed 违规原因句也只等待绝对播放 deadline", async () => {
  const { engine, session, transport } =
    await setupCallbackConfirmedFarewell();
  const state = session as any;
  state.forcedEndReason = "severe_violation";
  state.forcedEndNoticePlaying = true;
  try {
    const playbackNotBeforeMs = engine._responseServerDrained(1);
    expect(playbackNotBeforeMs - Date.now()).toBe(5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    engine._aiDone(true, 1);
    await jest.advanceTimersByTimeAsync(1);

    expect(transport.closed).toBe(true);
  } finally {
    await session.detach();
  }
});
