import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { OpenAIRealtimeAdapter } from "../src/openai-realtime/adapter";
import { GpuQueuedAudioLimitError } from "../src/gpu-client";
import type {
  MediaSessionCommand,
  MediaSessionOutputEvent,
} from "../src/media-session-port";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  terminated = false;
  private readonly callbacks: Array<(error?: Error) => void> = [];

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    this.bufferedAmount += Buffer.byteLength(data);
    this.callbacks.push(callback);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = this.CLOSED;
    this.emit("close");
  }

  receive(value: unknown, isBinary = false): void {
    const data = Buffer.isBuffer(value)
      ? value
      : Buffer.from(
          typeof value === "string" ? value : JSON.stringify(value),
        );
    this.emit("message", data, isBinary);
  }

  release(error?: Error): void {
    const callback = this.callbacks.shift();
    if (!callback) throw new Error("no pending WebSocket send");
    const index = this.sent.length - this.callbacks.length - 1;
    this.bufferedAmount -= Buffer.byteLength(this.sent[index]);
    callback(error);
  }

  releaseAll(): void {
    while (this.callbacks.length > 0) this.release();
  }
}

function createAdapter(
  socket: FakeSocket,
  options: ConstructorParameters<typeof OpenAIRealtimeAdapter>[1] = {},
): OpenAIRealtimeAdapter {
  return new OpenAIRealtimeAdapter(
    socket as unknown as WebSocket,
    options,
  );
}

function parsedFrames(socket: FakeSocket): Array<Record<string, any>> {
  return socket.sent.map((frame) => JSON.parse(frame));
}

describe("OpenAIRealtimeAdapter", () => {
  it("boots with session.created first and drains pre-core input through the command port", async () => {
    const socket = new FakeSocket();
    const adapter = createAdapter(socket, {
      connectionNamespace: "00112233445566778899aabbccddeeff",
    });
    adapter.start();
    expect(parsedFrames(socket)[0]?.type).toBe("session.created");

    socket.receive({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 3).toString("base64"),
    });
    const commands: MediaSessionCommand[] = [];
    adapter.onCommand((command) => {
      commands.push(command);
    });
    await Promise.resolve();

    expect(commands).toEqual([
      expect.objectContaining({
        type: "input_audio",
        inputEpoch: 0,
        sourceBytes: 960,
      }),
    ]);
    socket.releaseAll();
    expect(parsedFrames(socket).slice(0, 2).map((event) => event.type)).toEqual([
      "session.created",
      "conversation.created",
    ]);
  });

  it("replays a pre-response writer pause onto the generation when it starts", () => {
    const socket = new FakeSocket();
    socket.bufferedAmount = 600_000;
    const adapter = createAdapter(socket, {
      connectionNamespace: "00112233445566778899aabbccddeeee",
    });
    const commands: MediaSessionCommand[] = [];
    adapter.onCommand((command) => {
      commands.push(command);
    });
    adapter.start();

    expect(
      commands.filter((command) => command.type === "set_output_flow"),
    ).toEqual([]);
    adapter.emit({
      type: "response_started",
      responseGeneration: 12,
      turnSeq: 13,
    });

    expect(commands).toContainEqual({
      type: "set_output_flow",
      responseGeneration: 12,
      paused: true,
      residentWireBytes: expect.any(Number),
    });
  });

  it("advances handoff and wire-drained feedback only on ordered send callbacks", () => {
    const socket = new FakeSocket();
    let nowMs = 10_000;
    const adapter = createAdapter(socket, {
      connectionNamespace: "11112222333344445555666677778888",
      now: () => nowMs,
    });
    const commands: MediaSessionCommand[] = [];
    adapter.onCommand((command) => {
      commands.push(command);
    });
    adapter.start();
    socket.releaseAll();

    const response = { responseGeneration: 7, turnSeq: 8 };
    const events: MediaSessionOutputEvent[] = [
      { type: "response_started", ...response },
      {
        type: "response_segment_declared",
        ...response,
        segmentId: 1,
        text: "回答。",
      },
      {
        type: "response_audio",
        ...response,
        segmentId: 1,
        pcm16k: Buffer.alloc(640, 4),
      },
      {
        type: "response_segment_completed",
        ...response,
        segmentId: 1,
      },
      { type: "response_core_terminal", ...response, status: "completed" },
    ];
    events.forEach((event) => adapter.emit(event));

    expect(
      commands.filter((command) => command.type === "note_output_handoff"),
    ).toHaveLength(0);
    expect(
      commands.filter(
        (command) => command.type === "note_response_wire_drained",
      ),
    ).toHaveLength(0);

    while (socket.bufferedAmount > 0) {
      nowMs += 1;
      socket.release();
    }
    const handoffs = commands.filter(
      (command): command is Extract<
        MediaSessionCommand,
        { type: "note_output_handoff" }
      > => command.type === "note_output_handoff",
    );
    expect(handoffs.length).toBeGreaterThan(0);
    expect(handoffs.map((command) => command.deltaSeq)).toEqual(
      handoffs.map((_, index) => index),
    );
    expect(handoffs.every((command) => command.samples24k > 0)).toBe(true);
    expect(
      commands.filter(
        (command) => command.type === "note_response_wire_drained",
      ),
    ).toEqual([
      expect.objectContaining({
        responseGeneration: 7,
        type: "note_response_wire_drained",
      }),
    ]);
    expect(parsedFrames(socket).at(-1)?.type).toBe("response.done");
  });

  it("closes 1011 when a response terminal cannot drain before its deadline", () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const adapter = createAdapter(socket, {
        connectionNamespace: "22223333444455556666777788889999",
        drainTimeoutMs: 25,
      });
      const commands: MediaSessionCommand[] = [];
      adapter.onCommand((command) => {
        commands.push(command);
      });
      adapter.start();
      adapter.emit({
        type: "response_started",
        responseGeneration: 1,
        turnSeq: 1,
      });
      adapter.emit({
        type: "response_core_terminal",
        responseGeneration: 1,
        turnSeq: 1,
        status: "completed",
      });

      jest.advanceTimersByTime(26);
      jest.runAllTimers();
      expect(commands).toContainEqual(
        expect.objectContaining({
          type: "note_output_wire_failure",
          responseGeneration: 1,
        }),
      );
      expect(socket.closes).toContainEqual({
        code: 1011,
        reason: "protocol failure",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("ignores duplicate and stale response terminals without arming a drain timeout", () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const adapter = createAdapter(socket, {
        connectionNamespace: "2222333344445555666677778888aaaa",
        drainTimeoutMs: 25,
      });
      const commands: MediaSessionCommand[] = [];
      adapter.onCommand((command) => {
        commands.push(command);
      });
      adapter.start();
      socket.releaseAll();

      adapter.emit({
        type: "response_started",
        responseGeneration: 3,
        turnSeq: 4,
      });
      adapter.emit({
        type: "response_core_terminal",
        responseGeneration: 3,
        turnSeq: 4,
        status: "completed",
      });
      socket.releaseAll();
      adapter.emit({
        type: "response_core_terminal",
        responseGeneration: 3,
        turnSeq: 4,
        status: "completed",
      });
      adapter.emit({
        type: "response_core_terminal",
        responseGeneration: 2,
        turnSeq: 2,
        status: "cancelled",
      });

      jest.advanceTimersByTime(100);
      expect(
        commands.filter(
          (command) => command.type === "note_output_wire_failure",
        ),
      ).toEqual([]);
      expect(socket.closes).toEqual([]);
      expect(
        parsedFrames(socket).filter((event) => event.type === "response.done"),
      ).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("waits for terminal handoff before starting the close handshake fallback", () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const adapter = createAdapter(socket, {
        connectionNamespace: "2222333344445555666677778888bbbb",
        drainTimeoutMs: 100,
        closeDrainTimeoutMs: 25,
      });
      adapter.start();
      socket.releaseAll();

      adapter.close({ type: "session_ended", reason: "session_end" });
      socket.release();
      expect(parsedFrames(socket).at(-1)?.type).toBe("viva.session.ended");

      jest.advanceTimersByTime(99);
      expect(socket.closes).toEqual([]);
      expect(socket.terminated).toBe(false);

      jest.advanceTimersByTime(1);
      expect(socket.closes).toContainEqual({
        code: 1011,
        reason: "terminal delivery failed",
      });
      expect(socket.terminated).toBe(false);

      jest.advanceTimersByTime(25);
      expect(socket.terminated).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("uses fixed close classes for binary frames and repeated recoverable violations", () => {
    jest.useFakeTimers();
    try {
      const binarySocket = new FakeSocket();
      const binary = createAdapter(binarySocket);
      binary.start();
      binarySocket.receive(Buffer.from([1, 2]), true);
      expect(binarySocket.closes).toContainEqual({
        code: 1003,
        reason: "binary client frames are unsupported",
      });

      const violationSocket = new FakeSocket();
      const violations = createAdapter(violationSocket);
      violations.start();
      for (let index = 0; index < 8; index += 1) {
        violationSocket.receive("{");
      }
      jest.runAllTimers();
      expect(violationSocket.closes).toContainEqual({
        code: 1008,
        reason: "too many protocol violations",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("reports an internal error and closes 1011 when a core command rejects", async () => {
    const socket = new FakeSocket();
    const adapter = createAdapter(socket, {
      connectionNamespace: "3333444455556666777788889999aaaa",
    });
    adapter.onCommand(async (command) => {
      if (command.type === "input_audio") {
        throw new Error("core input failed");
      }
    });
    adapter.start();
    socket.releaseAll();
    socket.receive({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 9).toString("base64"),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(parsedFrames(socket)).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          code: "internal_error",
        }),
      }),
    );
    expect(socket.closes).toContainEqual({
      code: 1011,
      reason: "protocol failure",
    });
  });

  it("reports pending input overflow and closes 1009 with a registered core", async () => {
    const socket = new FakeSocket();
    const adapter = createAdapter(socket, {
      connectionNamespace: "444455556666777788889999aaaabbbb",
    });
    adapter.onCommand((command) => {
      if (command.type === "input_audio") {
        throw new GpuQueuedAudioLimitError(384_000);
      }
    });
    adapter.start();
    socket.releaseAll();
    socket.receive({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 9).toString("base64"),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(parsedFrames(socket)).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          code: "payload_too_large",
          param: "input_audio_buffer",
        }),
      }),
    );
    expect(socket.closes).toContainEqual({
      code: 1009,
      reason: "message too large",
    });
  });
});
