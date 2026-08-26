import {
  GpuClient,
  GpuQueuedAudioLimitError,
  WsLike,
} from "../src/gpu-client";

class FakeWs implements WsLike {
  readonly sent: Array<string | Buffer> = [];
  private message: (data: Buffer, isBinary: boolean) => void = () => undefined;
  private closeHandler: () => void = () => undefined;
  private errorHandler: (error: Error) => void = () => undefined;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {}

  on(
    event: "message" | "open" | "close" | "error",
    callback: (...args: never[]) => void,
  ): void {
    if (event === "message") this.message = callback as never;
    else if (event === "close") this.closeHandler = callback as never;
    else if (event === "error") this.errorHandler = callback as never;
  }

  emitControl(payload: Record<string, unknown>): void {
    this.message(Buffer.from(JSON.stringify(payload)), false);
  }

  emitClose(): void {
    this.closeHandler();
  }

  emitError(error: Error): void {
    this.errorHandler(error);
  }

  controls(): Record<string, unknown>[] {
    return this.sent
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.parse(value) as Record<string, unknown>);
  }
}

it("resolves an input reset only after its matching epoch ack", async () => {
  const ws = new FakeWs();
  const client = new GpuClient(ws, "sess_reset", 0);
  ws.emitControl({ type: "ready" });

  client.sendAudio(Buffer.alloc(320), 0);
  expect(ws.controls().find((frame) => frame.type === "audio_meta")).toMatchObject({
    input_epoch: 0,
  });

  let resolved = false;
  const reset = client.resetInput(0, 1).then(() => {
    resolved = true;
  });
  expect(ws.controls().at(-1)).toMatchObject({
    type: "input_reset",
    from_input_epoch: 0,
    next_input_epoch: 1,
  });

  ws.emitControl({ type: "input_reset_ack", input_epoch: 0 });
  await Promise.resolve();
  expect(resolved).toBe(false);

  ws.emitControl({ type: "input_reset_ack", input_epoch: 1 });
  await reset;
  expect(resolved).toBe(true);
});

it("drops queued audio from the reset epoch before the GPU becomes ready", async () => {
  const ws = new FakeWs();
  const client = new GpuClient(ws, "sess_reset_before_ready", 0);

  client.sendAudio(Buffer.alloc(320, 7), 0);
  const reset = client.resetInput(0, 1);
  client.sendAudio(Buffer.alloc(320, 9), 1);
  expect(ws.controls().filter((frame) => frame.type === "input_reset")).toEqual([]);

  ws.emitControl({ type: "ready" });
  expect(ws.controls().at(-1)).toMatchObject({
    type: "input_reset",
    from_input_epoch: 0,
    next_input_epoch: 1,
  });
  expect(ws.controls().filter((frame) => frame.type === "audio_meta")).toEqual([]);

  ws.emitControl({ type: "input_reset_ack", input_epoch: 1 });
  await reset;

  expect(ws.controls().filter((frame) => frame.type === "audio_meta")).toEqual([
    expect.objectContaining({ input_epoch: 1 }),
  ]);
  expect(ws.sent.filter(Buffer.isBuffer)).toEqual([Buffer.alloc(320, 9)]);
});

it("starts the reset ACK timeout only after ready sends the fence", async () => {
  jest.useFakeTimers();
  try {
    const ws = new FakeWs();
    const client = new GpuClient(ws, "sess_reset_timeout", 0);
    let settled = false;
    const reset = client.resetInput(0, 1, 100).finally(() => {
      settled = true;
    });

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(settled).toBe(false);

    ws.emitControl({ type: "ready" });
    jest.advanceTimersByTime(99);
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(reset).rejects.toThrow("input reset ack timeout for epoch 1");
  } finally {
    jest.useRealTimers();
  }
});

it("preserves a pending reset and new-epoch audio across capacity reconnect", async () => {
  const ws0 = new FakeWs();
  const ws1 = new FakeWs();
  const client = new GpuClient(ws0, "sess_reset_reconnect", 0);
  client.enableReconnect({
    connect: () => ws1,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
  });
  client.start({});

  const reset = client.resetInput(0, 1);
  client.sendAudio(Buffer.alloc(320, 5), 1);
  ws0.emitControl({ type: "error", code: "CAPACITY_FULL" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(ws1.controls().map((frame) => frame.type)).toEqual(["start"]);
  ws1.emitControl({ type: "ready" });
  expect(ws1.controls().at(-1)).toMatchObject({
    type: "input_reset",
    from_input_epoch: 0,
    next_input_epoch: 1,
  });
  expect(ws1.sent.filter(Buffer.isBuffer)).toEqual([]);

  ws1.emitControl({ type: "input_reset_ack", input_epoch: 1 });
  await reset;
  expect(ws1.controls().at(-1)).toMatchObject({
    type: "audio_meta",
    input_epoch: 1,
  });
  expect(ws1.sent.filter(Buffer.isBuffer)).toEqual([Buffer.alloc(320, 5)]);
});

it.each([
  ["GPU error control", (ws: FakeWs) => ws.emitControl({ type: "error", code: "MODEL_NOT_READY" })],
  ["GPU bye control", (ws: FakeWs) => ws.emitControl({ type: "bye" })],
  ["WebSocket close", (ws: FakeWs) => ws.emitClose()],
  ["WebSocket error", (ws: FakeWs) => ws.emitError(new Error("socket failed"))],
])("rejects a pending reset on %s", async (_label, disconnect) => {
  const ws = new FakeWs();
  const client = new GpuClient(ws, "sess_reset_disconnect", 0);
  const reset = client.resetInput(0, 1);
  disconnect(ws);
  await expect(reset).rejects.toThrow(/input reset/i);
});

it("rejects a pending reset when the ready handshake times out", async () => {
  jest.useFakeTimers();
  try {
    const ws = new FakeWs();
    const client = new GpuClient(ws, "sess_reset_handshake_timeout", 100);
    client.start({});
    const reset = client.resetInput(0, 1);

    jest.advanceTimersByTime(100);
    await expect(reset).rejects.toThrow(/handshake timed out.*input reset/i);
  } finally {
    jest.useRealTimers();
  }
});

it("enforces an optional byte cap without partially queueing the overflow frame", () => {
  const ws = new FakeWs();
  const client = new GpuClient(ws, "sess_strict_input_limit", 0, 640);

  client.sendAudio(Buffer.alloc(640, 1), 0);
  expect(() => client.sendAudio(Buffer.alloc(2, 2), 0)).toThrow(
    GpuQueuedAudioLimitError,
  );

  ws.emitControl({ type: "ready" });
  expect(ws.sent.filter(Buffer.isBuffer)).toEqual([Buffer.alloc(640, 1)]);
});

it("charges queued 16 kHz PCM by its decoded 24 kHz source bytes", () => {
  const ws = new FakeWs();
  const client = new GpuClient(ws, "sess_wire_input_limit", 0, 1_000);

  client.sendAudio(Buffer.alloc(640, 1), 0, 960);
  expect(() => client.sendAudio(Buffer.alloc(2, 2), 0, 42)).toThrow(
    GpuQueuedAudioLimitError,
  );

  ws.emitControl({ type: "ready" });
  expect(ws.sent.filter(Buffer.isBuffer)).toEqual([Buffer.alloc(640, 1)]);
});

it("sends an expected input identity with an explicit turn flush", () => {
  const ws = new FakeWs();
  const client = new GpuClient(ws, "sess_identity_flush", 0);

  client.flush({ inputEpoch: 2, inputTurnId: 4 });

  expect(ws.controls()).toContainEqual(
    expect.objectContaining({
      type: "flush",
      input_epoch: 2,
      input_turn_id: 4,
    }),
  );
});

it("fences a pre-callback commit with the GPU-synchronized current turn", () => {
  const ws = new FakeWs();
  const client = new GpuClient(ws, "sess_current_identity_flush", 0);

  client.flushCurrentInput(0);
  expect(ws.controls().at(-1)).toMatchObject({
    type: "flush",
    input_epoch: 0,
    input_turn_id: 0,
  });

  ws.emitControl({ type: "turn_end", input_epoch: 0, input_turn_id: 0 });
  client.flushCurrentInput(0);
  expect(ws.controls().at(-1)).toMatchObject({
    type: "flush",
    input_epoch: 0,
    input_turn_id: 1,
  });
});

it("keeps pre-ack tts_done bound to the cancelled FIFO head", () => {
  const ws = new FakeWs();
  const client = new GpuClient(ws, "sess_tts_cancel_fifo", 0);
  const controls: Array<Record<string, unknown>> = [];
  client.onControl((control) => controls.push(control));

  client.sendTtsText("old", {
    responseGeneration: 1,
    turnSeq: 1,
    segmentId: 1,
  });
  client.cancel("barge_in");
  client.sendTtsText("new", {
    responseGeneration: 2,
    turnSeq: 2,
    segmentId: 1,
  });

  ws.emitControl({ type: "tts_done" });
  ws.emitControl({ type: "cancel_ack", reason: "barge_in" });
  ws.emitControl({ type: "tts_done" });

  expect(controls).toEqual([
    expect.objectContaining({
      type: "tts_done",
      ttsIdentity: {
        responseGeneration: 1,
        turnSeq: 1,
        segmentId: 1,
      },
    }),
    expect.objectContaining({ type: "cancel_ack" }),
    expect.objectContaining({
      type: "tts_done",
      ttsIdentity: {
        responseGeneration: 2,
        turnSeq: 2,
        segmentId: 1,
      },
    }),
  ]);
});

it("sends TTS segment identity on the wire and prefers echoed identity over FIFO", () => {
  const ws = new FakeWs();
  const client = new GpuClient(ws, "sess_tts_wire_identity", 0);
  const controls: Array<Record<string, unknown>> = [];
  client.onControl((control) => controls.push(control));

  client.sendTtsText("first", {
    responseGeneration: 1,
    turnSeq: 1,
    segmentId: 1,
  });
  client.sendTtsText("second", {
    responseGeneration: 2,
    turnSeq: 2,
    segmentId: 1,
  });

  expect(ws.controls().slice(-2)).toEqual([
    expect.objectContaining({
      type: "tts_text",
      text: "first",
      ai_turn_id: 1,
      segment_id: 1,
    }),
    expect.objectContaining({
      type: "tts_text",
      text: "second",
      ai_turn_id: 2,
      segment_id: 1,
    }),
  ]);

  ws.emitControl({ type: "tts_done", ai_turn_id: 2, segment_id: 1 });
  ws.emitControl({ type: "tts_done" });

  expect(controls.map((control) => control.ttsIdentity)).toEqual([
    { responseGeneration: 2, turnSeq: 2, segmentId: 1 },
    { responseGeneration: 1, turnSeq: 1, segmentId: 1 },
  ]);
});

it("does not let a stale wire-qualified tts_done consume a new FIFO head", () => {
  const ws = new FakeWs();
  const client = new GpuClient(ws, "sess_tts_stale_wire", 0);
  const controls: Array<Record<string, unknown>> = [];
  client.onControl((control) => controls.push(control));

  client.sendTtsText("old", {
    responseGeneration: 1,
    turnSeq: 1,
    segmentId: 1,
  });
  client.cancel("barge_in");
  ws.emitControl({ type: "cancel_ack", reason: "barge_in" });
  client.sendTtsText("new", {
    responseGeneration: 2,
    turnSeq: 2,
    segmentId: 1,
  });

  ws.emitControl({ type: "tts_done", ai_turn_id: 1, segment_id: 1 });
  ws.emitControl({ type: "tts_done" });

  expect(controls.at(-2)).toMatchObject({
    type: "tts_done",
    ttsIdentity: { responseGeneration: 1, turnSeq: 1, segmentId: 1 },
  });
  expect(controls.at(-1)).toMatchObject({
    type: "tts_done",
    ttsIdentity: { responseGeneration: 2, turnSeq: 2, segmentId: 1 },
  });
});
