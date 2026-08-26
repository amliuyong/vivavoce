import { MediaSession } from "../src/media-session";
import {
  MediaSessionCloseEvent,
  MediaSessionCommand,
  MediaSessionCommandHandler,
  MediaSessionOutputEvent,
  MediaSessionTransport,
} from "../src/media-session-port";
import {
  AudioOutCb,
  CancelReason,
  EngineErrorCb,
  ResponseCoreTerminalCb,
  ResponseSegmentCompletedCb,
  ResponseSegmentDeclaredCb,
  ResponseStartedCb,
  TranscriptCb,
  TurnEventCb,
  VoiceEngine,
} from "../src/voice-engine";

class FakeTransport implements MediaSessionTransport {
  readonly protocolNeutral = true as const;
  readonly outputDelivery = "callback_confirmed" as const;
  readonly events: MediaSessionOutputEvent[] = [];
  readonly closes: MediaSessionCloseEvent[] = [];
  private commandHandler: MediaSessionCommandHandler = () => undefined;
  private closeHandler: () => void = () => undefined;

  onCommand(callback: MediaSessionCommandHandler): void {
    this.commandHandler = callback;
  }

  onClose(callback: () => void): void {
    this.closeHandler = callback;
  }

  emit(event: MediaSessionOutputEvent): void {
    this.events.push(event);
  }

  close(event: MediaSessionCloseEvent): void {
    this.closes.push(event);
  }

  async command(command: MediaSessionCommand): Promise<void> {
    await this.commandHandler(command);
  }

  disconnect(): void {
    this.closeHandler();
  }
}

class FakeEngine implements VoiceEngine {
  readonly pushed: Array<{
    pcm: Buffer;
    inputEpoch?: number;
    sourceBytes?: number;
  }> = [];
  readonly resets: Array<{ from: number; next: number }> = [];
  readonly cancels: CancelReason[] = [];
  readonly commits: Array<
    { inputEpoch: number; inputTurnId: number } | undefined
  > = [];
  terminalOnCancel = false;
  cancelThrows = false;
  resetInputGate: Promise<void> | null = null;
  private audioCb: AudioOutCb = () => undefined;
  private transcriptCb: TranscriptCb = () => undefined;
  private turnCb: TurnEventCb = () => undefined;
  private errorCb: EngineErrorCb = () => undefined;
  private startedCb: ResponseStartedCb = () => undefined;
  private declaredCb: ResponseSegmentDeclaredCb = () => undefined;
  private completedCb: ResponseSegmentCompletedCb = () => undefined;
  private terminalCb: ResponseCoreTerminalCb = () => undefined;

  async start(): Promise<void> {}
  pushAudio(pcm: Buffer, inputEpoch?: number, sourceBytes?: number): void {
    this.pushed.push({ pcm, inputEpoch, sourceBytes });
  }
  async resetInput(fromInputEpoch: number, nextInputEpoch: number): Promise<void> {
    await (this.resetInputGate ?? Promise.resolve());
    this.resets.push({ from: fromInputEpoch, next: nextInputEpoch });
  }
  endTurn(identity?: { inputEpoch: number; inputTurnId: number }): void {
    this.commits.push(identity);
  }
  commitInput(inputEpoch: number, inputTurnId?: number): void {
    this.commits.push(
      inputTurnId === undefined ? undefined : { inputEpoch, inputTurnId },
    );
  }
  cancel(reason: CancelReason): void {
    this.cancels.push(reason);
    if (this.cancelThrows) throw new Error("cancel failed");
    if (this.terminalOnCancel) {
      this.terminalCb({
        responseGeneration: 7,
        turnSeq: 8,
        status: reason === "error" ? "failed" : "cancelled",
        reason,
      });
    }
  }
  onAudioOut(callback: AudioOutCb): void {
    this.audioCb = callback;
  }
  onResponseStarted(callback: ResponseStartedCb): void {
    this.startedCb = callback;
  }
  onResponseSegmentDeclared(callback: ResponseSegmentDeclaredCb): void {
    this.declaredCb = callback;
  }
  onResponseSegmentCompleted(callback: ResponseSegmentCompletedCb): void {
    this.completedCb = callback;
  }
  onResponseCoreTerminal(callback: ResponseCoreTerminalCb): void {
    this.terminalCb = callback;
  }
  onTranscript(callback: TranscriptCb): void {
    this.transcriptCb = callback;
  }
  onTurnEvent(callback: TurnEventCb): void {
    this.turnCb = callback;
  }
  onError(callback: EngineErrorCb): void {
    this.errorCb = callback;
  }
  hasQuestions(): boolean {
    return false;
  }
  async stop(): Promise<void> {}

  emitInputLifecycle(): void {
    this.transcriptCb({
      text: "正在说",
      isFinal: false,
      inputEpoch: 2,
      inputTurnId: 4,
    });
    this.transcriptCb({
      text: "说完了",
      isFinal: true,
      inputEpoch: 2,
      inputTurnId: 4,
    });
    this.turnCb("turn_end", { inputEpoch: 2, inputTurnId: 4 });
  }

  emitSilentInputLifecycle(): void {
    this.turnCb("turn_end", { inputEpoch: 2, inputTurnId: 5 });
  }

  emitResponse(): void {
    const response = { responseGeneration: 7, turnSeq: 8 };
    const segment = { ...response, segmentId: 1 };
    this.startedCb(response);
    this.declaredCb({ ...segment, text: "回答。" });
    this.audioCb(Buffer.alloc(960, 1), segment);
    this.completedCb(segment);
    this.terminalCb({ ...response, status: "completed" });
  }

  emitResponseStarted(responseGeneration = 7, turnSeq = 8): void {
    this.startedCb({ responseGeneration, turnSeq });
  }

  emitResponsePayload(): void {
    const response = { responseGeneration: 7, turnSeq: 8 };
    const segment = { ...response, segmentId: 1 };
    this.declaredCb({ ...segment, text: "排队回答。" });
    this.audioCb(Buffer.alloc(960, 2), segment);
    this.completedCb(segment);
  }

  emitResponseSegment(text = "排队回答。"): void {
    this.declaredCb({
      responseGeneration: 7,
      turnSeq: 8,
      segmentId: 1,
      text,
    });
  }

  emitResponseAudio(bytes: number): void {
    this.audioCb(Buffer.alloc(bytes, 2), {
      responseGeneration: 7,
      turnSeq: 8,
      segmentId: 1,
    });
  }

  emitResponseSegmentCompleted(): void {
    this.completedCb({
      responseGeneration: 7,
      turnSeq: 8,
      segmentId: 1,
    });
  }

  emitResponseTerminal(status: "completed" | "cancelled" | "failed"): void {
    this.terminalCb({
      responseGeneration: 7,
      turnSeq: 8,
      status,
    });
  }

  emitResponseForGeneration(
    responseGeneration: number,
    turnSeq: number,
    pcm24k: Buffer,
    status: "completed" | "cancelled" | "failed" = "completed",
  ): void {
    const response = { responseGeneration, turnSeq };
    const segment = { ...response, segmentId: 1 };
    this.startedCb(response);
    this.declaredCb({ ...segment, text: `response ${responseGeneration}` });
    this.audioCb(pcm24k, segment);
    this.completedCb(segment);
    this.terminalCb({ ...response, status });
  }

  emitLateResponseAudio(
    responseGeneration: number,
    turnSeq: number,
    pcm24k: Buffer,
  ): void {
    this.audioCb(pcm24k, {
      responseGeneration,
      turnSeq,
      segmentId: 1,
    });
  }
}

describe("MediaSession protocol-neutral port", () => {
  it("maps identity-safe commands and observers without protocol wire knowledge", async () => {
    const transport = new FakeTransport();
    const engine = new FakeEngine();
    const session = new MediaSession(
      transport,
      {
        sessionId: "port-session",
        systemPrompt: "prompt",
        engineParams: { engineType: "three_stage", language: "zh-CN" },
      },
      { engine },
    );
    await session.begin();

    await transport.command({
      type: "input_audio",
      pcm16k: Buffer.from([1, 2, 3, 4]),
      inputEpoch: 2,
      sourceBytes: 6,
    });
    await transport.command({
      type: "commit_input",
      inputEpoch: 2,
      inputTurnId: 4,
    });
    await transport.command({
      type: "commit_input",
      inputEpoch: 2,
    });
    await transport.command({
      type: "reset_input",
      fromInputEpoch: 2,
      nextInputEpoch: 3,
      retiredInputTurnId: 5,
    });
    expect(engine.pushed).toEqual([
      {
        pcm: Buffer.from([1, 2, 3, 4]),
        inputEpoch: 2,
        sourceBytes: 6,
      },
    ]);
    expect(engine.commits).toEqual([
      { inputEpoch: 2, inputTurnId: 4 },
      undefined,
    ]);
    expect(engine.resets).toEqual([{ from: 2, next: 3 }]);

    engine.emitInputLifecycle();
    engine.emitResponse();

    expect(transport.events).toEqual(
      expect.arrayContaining([
        {
          type: "user_transcript_partial",
          text: "正在说",
          inputEpoch: 2,
          inputTurnId: 4,
        },
        {
          type: "user_transcript_final",
          seq: 0,
          text: "说完了",
          inputEpoch: 2,
          inputTurnId: 4,
        },
        {
          type: "input_committed",
          inputEpoch: 2,
          inputTurnId: 4,
        },
        { type: "response_started", responseGeneration: 7, turnSeq: 8 },
        {
          type: "response_segment_declared",
          responseGeneration: 7,
          turnSeq: 8,
          segmentId: 1,
          text: "回答。",
        },
        expect.objectContaining({
          type: "response_audio",
          responseGeneration: 7,
          turnSeq: 8,
          segmentId: 1,
        }),
        {
          type: "response_segment_completed",
          responseGeneration: 7,
          turnSeq: 8,
          segmentId: 1,
        },
        {
          type: "response_core_terminal",
          responseGeneration: 7,
          turnSeq: 8,
          status: "completed",
        },
      ]),
    );

    const beforeSilentTurn = transport.events.length;
    engine.emitSilentInputLifecycle();
    expect(transport.events.slice(beforeSilentTurn)).toEqual([
      {
        type: "input_rejected",
        inputEpoch: 2,
        inputTurnId: 5,
        reason: "no_speech",
      },
    ]);

    engine.emitResponseStarted(9, 10);
    await transport.command({
      type: "cancel_response",
      responseGeneration: 9,
      reason: "client_cancelled",
    });
    expect(engine.cancels).toContain("barge_in");

    await session.detach();
  });

  it("retires pending endpoint watchdog state before input reset completes", async () => {
    jest.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const engine = new FakeEngine();
      let releaseReset!: () => void;
      engine.resetInputGate = new Promise<void>((resolve) => {
        releaseReset = resolve;
      });
      const session = new MediaSession(
        transport,
        {
          sessionId: "input-reset-endpoint",
          systemPrompt: "prompt",
          engineParams: { engineType: "three_stage", language: "zh-CN" },
        },
        { engine },
      );
      await session.begin();

      const speechFrame = Buffer.alloc(640);
      for (let offset = 0; offset < speechFrame.length; offset += 2) {
        speechFrame.writeInt16LE(2_000, offset);
      }
      for (let frame = 0; frame < 15; frame += 1) {
        await transport.command({
          type: "input_audio",
          pcm16k: speechFrame,
          inputEpoch: 2,
          sourceBytes: 960,
        });
      }

      const reset = transport.command({
        type: "reset_input",
        fromInputEpoch: 2,
        nextInputEpoch: 3,
      });
      jest.advanceTimersByTime(2_000);
      expect(engine.commits).toEqual([]);

      releaseReset();
      await reset;
      for (let frame = 0; frame < 5; frame += 1) {
        await transport.command({
          type: "input_audio",
          pcm16k: speechFrame,
          inputEpoch: 3,
          sourceBytes: 960,
        });
      }
      jest.advanceTimersByTime(2_000);
      expect(engine.commits).toEqual([]);

      await session.detach();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("holds the complete response stream behind flow pause and flushes FIFO on resume", async () => {
    const transport = new FakeTransport();
    const engine = new FakeEngine();
    const session = new MediaSession(
      transport,
      {
        sessionId: "flow-session",
        systemPrompt: "prompt",
        engineParams: { engineType: "three_stage", language: "zh-CN" },
      },
      { engine },
    );
    await session.begin();

    engine.emitResponseStarted();
    await transport.command({
      type: "set_output_flow",
      responseGeneration: 7,
      paused: true,
      residentWireBytes: 600_000,
    });
    engine.emitResponsePayload();
    engine.emitResponseTerminal("completed");

    expect(transport.events.map((event) => event.type)).toEqual([
      "response_started",
    ]);

    await transport.command({
      type: "set_output_flow",
      responseGeneration: 7,
      paused: false,
      residentWireBytes: 100_000,
    });
    expect(transport.events.map((event) => event.type)).toEqual([
      "response_started",
      "response_segment_declared",
      "response_audio",
      "response_segment_completed",
      "response_core_terminal",
    ]);

    await session.detach();
  });

  it.each(["cancelled", "failed"] as const)(
    "retires queued PCM before a paused %s terminal",
    async (status) => {
      const transport = new FakeTransport();
      const engine = new FakeEngine();
      const session = new MediaSession(
        transport,
        {
          sessionId: `flow-${status}`,
          systemPrompt: "prompt",
          engineParams: { engineType: "three_stage", language: "zh-CN" },
        },
        { engine },
      );
      await session.begin();

      engine.emitResponseStarted();
      await transport.command({
        type: "set_output_flow",
        responseGeneration: 7,
        paused: true,
        residentWireBytes: 600_000,
      });
      engine.emitResponsePayload();
      engine.emitResponseTerminal(status);

      expect(transport.events).toEqual([
        { type: "response_started", responseGeneration: 7, turnSeq: 8 },
        {
          type: "response_core_terminal",
          responseGeneration: 7,
          turnSeq: 8,
          status,
        },
      ]);

      await session.detach();
    },
  );

  it("fails closed when paused core output exceeds its byte or age bound", async () => {
    jest.useFakeTimers();
    try {
      const limitTransport = new FakeTransport();
      const limitEngine = new FakeEngine();
      const limitSession = new MediaSession(
        limitTransport,
        {
          sessionId: "flow-limit",
          systemPrompt: "prompt",
          engineParams: { engineType: "three_stage", language: "zh-CN" },
        },
        { engine: limitEngine },
      );
      await limitSession.begin();
      limitEngine.emitResponseStarted();
      await limitTransport.command({
        type: "set_output_flow",
        responseGeneration: 7,
        paused: true,
        residentWireBytes: 600_000,
      });
      limitEngine.emitResponseSegment();
      // Engine PCM is 24 kHz and MediaSession emits 16 kHz PCM to the port.
      limitEngine.emitResponseAudio(600_002);
      expect(limitTransport.events.at(-1)).toEqual({
        type: "response_output_delivery_failed",
        responseGeneration: 7,
        reason: "core_pending_output_limit",
      });
      await limitSession.detach();

      const ageTransport = new FakeTransport();
      const ageEngine = new FakeEngine();
      const ageSession = new MediaSession(
        ageTransport,
        {
          sessionId: "flow-age",
          systemPrompt: "prompt",
          engineParams: { engineType: "three_stage", language: "zh-CN" },
        },
        { engine: ageEngine },
      );
      await ageSession.begin();
      ageEngine.emitResponseStarted();
      await ageTransport.command({
        type: "set_output_flow",
        responseGeneration: 7,
        paused: true,
        residentWireBytes: 600_000,
      });
      ageEngine.emitResponseSegment();
      ageEngine.emitResponseAudio(640);
      jest.advanceTimersByTime(5_001);
      expect(ageTransport.events.at(-1)).toEqual({
        type: "response_output_delivery_failed",
        responseGeneration: 7,
        reason: "core_pending_output_timeout",
      });
      await ageSession.detach();
    } finally {
      jest.useRealTimers();
    }
  });

  it("retires completed generations and resets callback-confirmed downsampling", async () => {
    const transport = new FakeTransport();
    const engine = new FakeEngine();
    const session = new MediaSession(
      transport,
      {
        sessionId: "port-generation-retirement",
        systemPrompt: "prompt",
        engineParams: { engineType: "three_stage", language: "zh-CN" },
      },
      { engine },
    );
    await session.begin();

    const nonZero = Buffer.alloc(960);
    for (let offset = 0; offset < nonZero.length; offset += 2) {
      nonZero.writeInt16LE(12_000, offset);
    }
    engine.emitResponseForGeneration(7, 8, nonZero);
    const eventCountAfterTerminal = transport.events.length;

    engine.emitLateResponseAudio(7, 8, nonZero);
    expect(transport.events).toHaveLength(eventCountAfterTerminal);

    engine.emitResponseForGeneration(9, 10, Buffer.alloc(960));
    const generationNineAudio = transport.events.find(
      (event) =>
        event.type === "response_audio" && event.responseGeneration === 9,
    );
    expect(generationNineAudio).toMatchObject({
      type: "response_audio",
      responseGeneration: 9,
    });
    if (generationNineAudio?.type !== "response_audio") {
      throw new Error("missing generation nine audio");
    }
    expect([...generationNineAudio.pcm16k]).toEqual(
      expect.arrayContaining([0]),
    );
    expect(generationNineAudio.pcm16k.every((byte) => byte === 0)).toBe(true);
    expect(
      transport.events.filter(
        (event) => event.type === "response_output_delivery_failed",
      ),
    ).toEqual([]);

    await session.detach();
  });

  it("delivers the active response terminal before the business close during teardown", async () => {
    const transport = new FakeTransport();
    const engine = new FakeEngine();
    const session = new MediaSession(
      transport,
      {
        sessionId: "port-teardown-terminal",
        systemPrompt: "prompt",
        engineParams: { engineType: "three_stage", language: "zh-CN" },
      },
      { engine },
    );
    await session.begin();
    engine.emitResponseStarted();
    engine.terminalOnCancel = true;

    await session.end("session_end");

    expect(transport.events.at(-1)).toMatchObject({
      type: "response_core_terminal",
      responseGeneration: 7,
      status: "cancelled",
      reason: "session_end",
    });
    expect(transport.closes).toEqual([
      { type: "session_ended", reason: "session_end" },
    ]);
  });

  it("fails the active response exactly once when engine cancellation throws during teardown", async () => {
    const transport = new FakeTransport();
    const engine = new FakeEngine();
    const session = new MediaSession(
      transport,
      {
        sessionId: "port-teardown-cancel-failure",
        systemPrompt: "prompt",
        engineParams: { engineType: "three_stage", language: "zh-CN" },
      },
      { engine },
    );
    await session.begin();
    engine.emitResponseStarted();
    engine.cancelThrows = true;

    await session.end("session_end");

    expect(
      transport.events.filter(
        (event) => event.type === "response_core_terminal",
      ),
    ).toEqual([
      {
        type: "response_core_terminal",
        responseGeneration: 7,
        turnSeq: 8,
        status: "failed",
        reason: "engine_cancel_failed",
      },
    ]);
    expect(transport.closes).toEqual([
      { type: "session_ended", reason: "session_end" },
    ]);
  });

  it("replaces a flow-paused completed terminal with one teardown terminal", async () => {
    const transport = new FakeTransport();
    const engine = new FakeEngine();
    const session = new MediaSession(
      transport,
      {
        sessionId: "port-teardown-paused-terminal",
        systemPrompt: "prompt",
        engineParams: { engineType: "three_stage", language: "zh-CN" },
      },
      { engine },
    );
    await session.begin();
    engine.emitResponseStarted();
    await transport.command({
      type: "set_output_flow",
      responseGeneration: 7,
      paused: true,
      residentWireBytes: 600_000,
    });
    engine.emitResponsePayload();
    engine.emitResponseTerminal("completed");

    await session.end("session_end");

    expect(
      transport.events.filter(
        (event) => event.type === "response_core_terminal",
      ),
    ).toEqual([
      {
        type: "response_core_terminal",
        responseGeneration: 7,
        turnSeq: 8,
        status: "cancelled",
        reason: "session_end",
      },
    ]);
    expect(
      transport.events.some((event) => event.type === "response_audio"),
    ).toBe(false);
  });

  it("accepts only ordered callback-confirmed handoff feedback before wire drain", async () => {
    const transport = new FakeTransport();
    const engine = new FakeEngine();
    const session = new MediaSession(
      transport,
      {
        sessionId: "handoff-order",
        systemPrompt: "prompt",
        engineParams: { engineType: "three_stage", language: "zh-CN" },
      },
      { engine },
    );
    await session.begin();
    engine.emitResponseStarted();
    engine.emitResponseSegment();
    engine.emitResponseAudio(640);

    await expect(
      transport.command({
        type: "note_output_handoff",
        responseGeneration: 7,
        segmentId: 1,
        deltaSeq: 1,
        samples24k: 480,
        handedOffAtMs: 10_000,
      }),
    ).rejects.toThrow("invalid or out-of-order realtime output handoff");
    await transport.command({
      type: "note_output_handoff",
      responseGeneration: 7,
      segmentId: 1,
      deltaSeq: 0,
      samples24k: 480,
      handedOffAtMs: 10_000,
    });
    await transport.command({
      type: "note_response_wire_drained",
      responseGeneration: 7,
      responseDoneHandedOffAtMs: 10_010,
    });
    await expect(
      transport.command({
        type: "note_output_handoff",
        responseGeneration: 7,
        segmentId: 1,
        deltaSeq: 9,
        samples24k: 480,
        handedOffAtMs: 10_020,
      }),
    ).resolves.toBeUndefined();

    await session.detach();
  });
});
