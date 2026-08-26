import WebSocket, { type RawData } from "ws";
import {
  type MediaSessionCloseEvent,
  type MediaSessionCommand,
  type MediaSessionCommandHandler,
  type MediaSessionOutputEvent,
  type MediaSessionTransport,
} from "../media-session-port";
import { VOICE_INPUT_PENDING_LIMIT_ERROR } from "../voice-engine";
import {
  OrderedRealtimeWriter,
  type RealtimeWriterLimits,
} from "./ordered-writer";
import {
  REALTIME_LIMITS,
  RealtimeProtocolError,
} from "./protocol";
import {
  OpenAIRealtimeSessionState,
  type RealtimeClientEvent,
  type RealtimeCoreEvent,
  type RealtimeEventDelivery,
  type RealtimeServerEvent,
} from "./session-state";

const PROTOCOL_VIOLATION_WINDOW_MS = 10_000;
const MAX_PROTOCOL_VIOLATIONS = 8;
const CLOSE_DRAIN_TIMEOUT_MS = 250;

export interface OpenAIRealtimeAdapterOptions {
  now?: () => number;
  drainTimeoutMs?: number;
  closeDrainTimeoutMs?: number;
  connectionNamespace?: string;
  writerLimits?: Partial<RealtimeWriterLimits>;
}

interface PendingCoreCommand {
  command: MediaSessionCommand;
  inputBytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new TypeError("unsupported WebSocket frame storage");
}

function isClientEvent(value: unknown): value is RealtimeClientEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export class OpenAIRealtimeAdapter implements MediaSessionTransport {
  readonly protocolNeutral = true as const;
  readonly outputDelivery = "callback_confirmed" as const;
  readonly inputPendingLimitBytes = REALTIME_LIMITS.MAX_PENDING_INPUT_BYTES;

  private readonly writer: OrderedRealtimeWriter;
  private readonly state: OpenAIRealtimeSessionState;
  private readonly closeHandlers = new Set<() => void>();
  private readonly coreBacklog: PendingCoreCommand[] = [];
  private readonly drainTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly protocolViolationTimes: number[] = [];
  private commandHandler: MediaSessionCommandHandler | null = null;
  private coreBacklogInputBytes = 0;
  private started = false;
  private socketClosed = false;
  private closeRequested = false;
  private fatalFailure = false;
  private pausedGeneration: number | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalDeliveryTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalClosePending = false;
  private closeRequestResolve!: () => void;
  private readonly closeRequestPromise = new Promise<void>((resolve) => {
    this.closeRequestResolve = resolve;
  });

  constructor(
    private readonly socket: WebSocket,
    private readonly options: OpenAIRealtimeAdapterOptions = {},
  ) {
    this.writer = new OrderedRealtimeWriter(socket, {
      limits: options.writerLimits,
      onFlowChange: (paused, residentBytes) =>
        this.handleOutputFlowChange(paused, residentBytes),
      onFailure: (error) => this.handleWriterFailure(error),
    });
    this.state = new OpenAIRealtimeSessionState({
      connectionNamespace: options.connectionNamespace,
      emit: (event, delivery) => this.enqueueServerEvent(event, delivery),
      core: {
        pushInputPcm: ({ inputEpoch, pcm16k, sourceBytes }) => {
          this.sendCoreCommandOrFail({
            type: "input_audio",
            inputEpoch,
            pcm16k,
            sourceBytes,
          });
        },
        commitInput: ({ inputEpoch, inputTurnId }) => {
          this.sendCoreCommandOrFail({
            type: "commit_input",
            inputEpoch,
            ...(inputTurnId === undefined ? {} : { inputTurnId }),
          });
        },
        resetInput: ({
          fromInputEpoch,
          nextInputEpoch,
          retiredInputTurnId,
        }) =>
          this.sendCoreCommand({
            type: "reset_input",
            fromInputEpoch,
            nextInputEpoch,
            ...(retiredInputTurnId === undefined
              ? {}
              : { retiredInputTurnId }),
          }),
        cancelActiveResponse: ({ responseGeneration, reason }) => {
          this.sendCoreCommandOrFail(
            {
              type: "cancel_response",
              responseGeneration,
              reason,
            },
            responseGeneration,
          );
        },
        requestSessionEnd: () => {
          this.sendCoreCommandOrFail({ type: "request_end" });
        },
      },
      now: options.now,
      onAudioHandoff: (handoff) => {
        this.sendCoreCommandOrFail(
          {
            type: "note_output_handoff",
            responseGeneration: handoff.responseGeneration,
            segmentId: handoff.segmentId,
            deltaSeq: handoff.deltaSeq,
            samples24k: handoff.samples24k,
            handedOffAtMs: this.now(),
          },
          handoff.responseGeneration,
        );
      },
      onProtocolError: (error) => this.handleProtocolError(error),
    });

    socket.on("message", (data, isBinary) =>
      this.handleSocketMessage(data, isBinary),
    );
    socket.once("close", () => this.handleSocketClose());
    socket.on("error", (error) => {
      if (!this.closeRequested && !this.socketClosed) {
        this.failInternal(
          error instanceof Error ? error.message : "WebSocket error",
        );
      }
    });
  }

  start(): void {
    if (this.started || this.socketClosed) return;
    this.started = true;
    this.state.open();
  }

  waitForCloseRequest(): Promise<void> {
    return this.closeRequestPromise;
  }

  failConnectionTakeover(): void {
    this.requestSocketClose(1011, "connection takeover failed");
  }

  onCommand(callback: MediaSessionCommandHandler): void {
    if (this.commandHandler) {
      throw new Error("realtime media command handler is already registered");
    }
    this.commandHandler = callback;
    void this.flushCoreBacklog();
  }

  onClose(callback: () => void): void {
    this.closeHandlers.add(callback);
    if (this.socketClosed) queueMicrotask(callback);
  }

  emit(event: MediaSessionOutputEvent): void {
    if (this.socketClosed || this.closeRequested) return;
    try {
      const coreEvent = this.toCoreEvent(event);
      if (!coreEvent) return;
      if (coreEvent.type === "response_core_terminal") {
        this.dispatchResponseTerminal(coreEvent);
      } else {
        this.state.dispatchCoreEvent(coreEvent);
        if (
          coreEvent.type === "response_started" &&
          this.writer.isPaused &&
          this.pausedGeneration === null
        ) {
          this.pauseOutputGeneration(
            coreEvent.responseGeneration,
            this.writer.residentBytes,
          );
        }
      }
    } catch (error) {
      this.handleDispatchFailure(error);
    }
  }

  close(event: MediaSessionCloseEvent): void {
    if (this.socketClosed || this.closeRequested || this.terminalClosePending) {
      return;
    }
    this.terminalClosePending = true;
    this.scheduleTerminalDeliveryTimeout();
    try {
      if (event.type === "session_ended") {
        this.state.dispatchCoreEvent({
          type: "playback_clear",
          reason: "session_end",
        });
        this.state.dispatchCoreEvent(
          { type: "session_ended", reason: event.reason },
          {
            onHandoff: () => this.requestSocketClose(1000, "session ended"),
            onFailure: () =>
              this.requestSocketClose(1011, "terminal delivery failed"),
          },
        );
      } else {
        this.state.dispatchCoreEvent({
          type: "playback_clear",
          reason: "superseded",
        });
        this.state.dispatchCoreEvent(
          { type: "connection_superseded" },
          {
            onHandoff: () => this.requestSocketClose(1000, "superseded"),
            onFailure: () =>
              this.requestSocketClose(1011, "terminal delivery failed"),
          },
        );
      }
    } catch (error) {
      this.requestSocketClose(
        1011,
        error instanceof Error ? "terminal dispatch failed" : "internal error",
      );
    }
  }

  private handleSocketMessage(data: RawData, isBinary: boolean): void {
    if (this.socketClosed || this.closeRequested) return;
    if (isBinary) {
      this.requestSocketClose(1003, "binary client frames are unsupported");
      return;
    }
    const raw = rawDataToBuffer(data);
    if (raw.length > REALTIME_LIMITS.MAX_TEXT_FRAME_BYTES) {
      this.state.reportProtocolError(
        new RealtimeProtocolError(
          "payload_too_large",
          `text frame exceeds ${REALTIME_LIMITS.MAX_TEXT_FRAME_BYTES} bytes`,
          undefined,
          undefined,
          1009,
        ),
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      this.state.reportProtocolError(
        new RealtimeProtocolError(
          "invalid_request",
          "client frame must be a JSON object",
        ),
      );
      return;
    }
    if (!isClientEvent(parsed)) {
      this.state.reportProtocolError(
        new RealtimeProtocolError(
          "invalid_request",
          "client event must be an object with a string type",
          "type",
        ),
      );
      return;
    }
    void this.state.dispatchClientEvent(parsed).catch((error) => {
      this.handleDispatchFailure(error);
    });
  }

  private dispatchResponseTerminal(
    event: Extract<RealtimeCoreEvent, { type: "response_core_terminal" }>,
  ): void {
    // The core terminal is idempotent. A duplicate or retired generation must
    // not arm a drain timeout for an event the FSM intentionally ignores.
    if (
      !this.state.matchesActiveResponse(
        event.responseGeneration,
        event.turnSeq,
      )
    ) {
      return;
    }
    if (this.drainTimers.has(event.responseGeneration)) {
      throw new Error("response drain timer already exists");
    }
    const timeoutMs =
      this.options.drainTimeoutMs ?? REALTIME_LIMITS.OUTBOUND_DRAIN_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.drainTimers.delete(event.responseGeneration);
      this.failInternal(
        `response ${event.responseGeneration} wire drain timed out`,
        event.responseGeneration,
      );
    }, timeoutMs);
    timer.unref?.();
    this.drainTimers.set(event.responseGeneration, timer);

    this.state.dispatchCoreEvent(event, {
      onHandoff: () => {
        this.clearDrainTimer(event.responseGeneration);
        this.sendCoreCommandOrFail(
          {
            type: "note_response_wire_drained",
            responseGeneration: event.responseGeneration,
            responseDoneHandedOffAtMs: this.now(),
          },
          event.responseGeneration,
        );
      },
      onFailure: (error) => {
        this.clearDrainTimer(event.responseGeneration);
        if (!this.socketClosed) {
          this.failInternal(error.message, event.responseGeneration);
        }
      },
    });
  }

  private toCoreEvent(event: MediaSessionOutputEvent): RealtimeCoreEvent | null {
    switch (event.type) {
      case "input_speech_started":
        return event;
      case "input_committed":
        return event;
      case "input_rejected":
        return event;
      case "user_transcript_partial":
        return {
          type: "user_transcript_partial",
          inputEpoch: event.inputEpoch,
          inputTurnId: event.inputTurnId,
          delta: event.text,
        };
      case "user_transcript_final":
        return {
          type: "user_transcript_final",
          inputEpoch: event.inputEpoch,
          inputTurnId: event.inputTurnId,
          transcript: event.text,
        };
      case "response_started":
      case "response_segment_declared":
      case "response_audio":
      case "response_segment_completed":
      case "response_core_terminal":
        return event;
      case "playback_clear":
        return event;
      case "interruption_confirmed":
        return {
          type: "playback_clear",
          responseGeneration:
            this.state.activeResponseGeneration ?? undefined,
          reason: "barge_in",
        };
      case "exam_incomplete":
        return {
          type: "exam_incomplete",
          reason: "questions_remaining",
        };
      case "response_output_delivery_failed":
        this.failInternal(event.reason, event.responseGeneration);
        return null;
      case "audio":
        throw new Error("realtime output audio is missing response identity");
      case "interruption_paused":
      case "interruption_resumed":
      case "turn_audio_started":
      case "turn_audio_ended":
      case "transcript_partial":
      case "transcript_final":
      case "transcript_corrected":
        return null;
    }
  }

  private enqueueServerEvent(
    event: RealtimeServerEvent,
    delivery?: RealtimeEventDelivery,
  ): void {
    if (this.socketClosed || this.closeRequested) {
      delivery?.onFailure?.(new Error("realtime socket is closing"));
      return;
    }
    this.writer.enqueue(JSON.stringify(event), delivery);
  }

  private handleOutputFlowChange(
    paused: boolean,
    residentWireBytes: number,
  ): void {
    if (paused) {
      const generation = this.state.activeResponseGeneration;
      if (generation === null) return;
      this.pauseOutputGeneration(generation, residentWireBytes);
      return;
    }
    const generation = this.pausedGeneration;
    this.pausedGeneration = null;
    if (generation === null) return;
    this.sendCoreCommandOrFail(
      {
        type: "set_output_flow",
        responseGeneration: generation,
        paused: false,
        residentWireBytes,
      },
      generation,
    );
  }

  private sendCoreCommand(command: MediaSessionCommand): Promise<void> {
    if (this.socketClosed || this.fatalFailure) {
      return Promise.reject(new Error("realtime adapter is closed"));
    }
    const handler = this.commandHandler;
    if (handler) return this.invokeCoreCommand(handler, command);

    const inputBytes =
      command.type === "input_audio"
        ? command.sourceBytes ?? command.pcm16k.length
        : 0;
    if (
      this.coreBacklogInputBytes + inputBytes >
      REALTIME_LIMITS.MAX_PENDING_INPUT_BYTES
    ) {
      const error = new RealtimeProtocolError(
        "payload_too_large",
        "pending core input exceeds the connection limit",
        "input_audio_buffer",
        undefined,
        1009,
      );
      this.state.reportProtocolError(error);
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      this.coreBacklog.push({ command, inputBytes, resolve, reject });
      this.coreBacklogInputBytes += inputBytes;
    });
  }

  private sendCoreCommandOrFail(
    command: MediaSessionCommand,
    responseGeneration?: number,
  ): void {
    void this.sendCoreCommand(command).catch((error: unknown) => {
      if (this.socketClosed || this.closeRequested || this.fatalFailure) return;
      if (this.isInputPendingLimitError(error)) {
        this.failInputPendingLimit();
        return;
      }
      if (error instanceof RealtimeProtocolError && error.closeCode) return;
      this.failInternal(
        error instanceof Error ? error.message : String(error),
        responseGeneration,
      );
    });
  }

  private async flushCoreBacklog(): Promise<void> {
    const handler = this.commandHandler;
    if (!handler) return;
    while (this.coreBacklog.length > 0 && !this.socketClosed) {
      const pending = this.coreBacklog.shift()!;
      this.coreBacklogInputBytes -= pending.inputBytes;
      try {
        await this.invokeCoreCommand(handler, pending.command);
        pending.resolve();
      } catch (error) {
        const typed = error instanceof Error ? error : new Error(String(error));
        pending.reject(typed);
        if (this.isInputPendingLimitError(typed)) {
          this.failInputPendingLimit();
          return;
        }
        this.failInternal(typed.message);
        return;
      }
    }
  }

  private invokeCoreCommand(
    handler: MediaSessionCommandHandler,
    command: MediaSessionCommand,
  ): Promise<void> {
    try {
      return Promise.resolve(handler(command)).then(() => undefined);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private pauseOutputGeneration(
    generation: number,
    residentWireBytes: number,
  ): void {
    if (this.pausedGeneration === generation) return;
    this.pausedGeneration = generation;
    this.sendCoreCommandOrFail(
      {
        type: "set_output_flow",
        responseGeneration: generation,
        paused: true,
        residentWireBytes,
      },
      generation,
    );
  }

  private isInputPendingLimitError(error: unknown): boolean {
    return (
      error !== null &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === VOICE_INPUT_PENDING_LIMIT_ERROR
    );
  }

  private failInputPendingLimit(): void {
    if (this.fatalFailure || this.socketClosed || this.closeRequested) return;
    this.fatalFailure = true;
    this.state.reportProtocolError(
      new RealtimeProtocolError(
        "payload_too_large",
        "pending input exceeds the connection limit",
        "input_audio_buffer",
        undefined,
        1009,
      ),
    );
  }

  private handleProtocolError(error: RealtimeProtocolError): void {
    if (error.closeCode) {
      setImmediate(() =>
        this.requestSocketClose(
          error.closeCode!,
          error.closeCode === 1009 ? "message too large" : "protocol failure",
        ),
      );
      return;
    }
    const now = this.now();
    this.protocolViolationTimes.push(now);
    while (
      this.protocolViolationTimes.length > 0 &&
      this.protocolViolationTimes[0] <= now - PROTOCOL_VIOLATION_WINDOW_MS
    ) {
      this.protocolViolationTimes.shift();
    }
    if (this.protocolViolationTimes.length >= MAX_PROTOCOL_VIOLATIONS) {
      setImmediate(() =>
        this.requestSocketClose(1008, "too many protocol violations"),
      );
    }
  }

  private handleDispatchFailure(error: unknown): void {
    const protocolError =
      error instanceof RealtimeProtocolError
        ? error
        : new RealtimeProtocolError(
            "internal_error",
            error instanceof Error ? error.message : "internal adapter error",
            undefined,
            undefined,
            1011,
          );
    this.state.reportProtocolError(protocolError);
  }

  private failInternal(message: string, responseGeneration?: number): void {
    if (this.fatalFailure || this.socketClosed) return;
    this.fatalFailure = true;
    this.clearAllDrainTimers();
    const reason = message.slice(0, 160);
    const handler = this.commandHandler;
    if (handler) {
      void this.invokeCoreCommand(handler, {
        type: "note_output_wire_failure",
        ...(responseGeneration === undefined ? {} : { responseGeneration }),
        reason,
      }).catch(() => undefined);
    }
    this.state.reportProtocolError(
      new RealtimeProtocolError(
        "internal_error",
        "realtime transport failed",
        undefined,
        undefined,
        1011,
      ),
    );
  }

  private handleWriterFailure(error: Error): void {
    if (this.socketClosed || this.closeRequested) return;
    this.failInternal(error.message, this.state.activeResponseGeneration ?? undefined);
  }

  private requestSocketClose(
    code: 1000 | 1003 | 1008 | 1009 | 1011,
    reason: string,
  ): void {
    if (this.socketClosed || this.closeRequested) return;
    this.closeRequested = true;
    this.terminalClosePending = false;
    this.closeRequestResolve();
    this.clearTerminalDeliveryTimer();
    this.clearAllDrainTimers();
    this.rejectCoreBacklog(new Error("realtime adapter is closing"));
    try {
      this.socket.close(code, reason.slice(0, 123));
    } catch {
      this.socket.terminate();
    }
    this.scheduleCloseFallback();
  }

  private scheduleCloseFallback(): void {
    if (this.closeTimer || this.socketClosed) return;
    const timeoutMs =
      this.options.closeDrainTimeoutMs ?? CLOSE_DRAIN_TIMEOUT_MS;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (!this.socketClosed) this.socket.terminate();
    }, timeoutMs);
    this.closeTimer.unref?.();
  }

  private scheduleTerminalDeliveryTimeout(): void {
    if (this.terminalDeliveryTimer || this.socketClosed) return;
    const timeoutMs =
      this.options.drainTimeoutMs ?? REALTIME_LIMITS.OUTBOUND_DRAIN_TIMEOUT_MS;
    this.terminalDeliveryTimer = setTimeout(() => {
      this.terminalDeliveryTimer = null;
      if (!this.socketClosed && !this.closeRequested) {
        this.requestSocketClose(1011, "terminal delivery failed");
      }
    }, timeoutMs);
    this.terminalDeliveryTimer.unref?.();
  }

  private clearTerminalDeliveryTimer(): void {
    if (!this.terminalDeliveryTimer) return;
    clearTimeout(this.terminalDeliveryTimer);
    this.terminalDeliveryTimer = null;
  }

  private handleSocketClose(): void {
    if (this.socketClosed) return;
    this.socketClosed = true;
    this.closeRequested = true;
    this.terminalClosePending = false;
    this.closeRequestResolve();
    this.clearTerminalDeliveryTimer();
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.clearAllDrainTimers();
    this.rejectCoreBacklog(new Error("realtime socket closed"));
    this.writer.fail(new Error("realtime socket closed"));
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        // Closing one observer must not prevent the remaining cleanup hooks.
      }
    }
  }

  private rejectCoreBacklog(error: Error): void {
    for (const pending of this.coreBacklog.splice(0)) pending.reject(error);
    this.coreBacklogInputBytes = 0;
  }

  private clearDrainTimer(responseGeneration: number): void {
    const timer = this.drainTimers.get(responseGeneration);
    if (!timer) return;
    clearTimeout(timer);
    this.drainTimers.delete(responseGeneration);
  }

  private clearAllDrainTimers(): void {
    for (const timer of this.drainTimers.values()) clearTimeout(timer);
    this.drainTimers.clear();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
