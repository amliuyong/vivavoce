import { randomBytes } from "node:crypto";
import {
  decodePcm16Base64,
  REALTIME_LIMITS,
  RealtimeProtocolError,
} from "./protocol";
import { StreamingPcmResampler } from "./audio-resampler";

export type RealtimeServerEvent = {
  type: string;
  event_id: string;
  [key: string]: unknown;
};

export type RealtimeClientEvent = {
  type: string;
  event_id?: string;
  [key: string]: unknown;
};

export interface RealtimeEventDelivery {
  onHandoff?: () => void;
  onFailure?: (error: Error) => void;
}

export interface RealtimeSessionCore {
  pushInputPcm(command: {
    inputEpoch: number;
    pcm16k: Buffer;
    sourceBytes: number;
  }): void;
  commitInput(command: { inputEpoch: number; inputTurnId?: number }): void;
  resetInput(command: {
    fromInputEpoch: number;
    nextInputEpoch: number;
    retiredInputTurnId?: number;
  }): Promise<void>;
  cancelActiveResponse(command: { responseGeneration: number; reason: string }): void;
  requestSessionEnd(reason: string): void;
}

export interface RealtimeAudioHandoff {
  responseGeneration: number;
  segmentId: number;
  deltaSeq: number;
  samples24k: number;
}

export type RealtimeCoreEvent =
  | {
    type: "input_speech_started";
    inputEpoch: number;
    inputTurnId: number;
    audioStartMs?: number;
  }
  | {
    type: "user_transcript_partial";
    inputEpoch: number;
    inputTurnId: number;
    delta: string;
  }
  | {
    type: "user_transcript_final";
    inputEpoch: number;
    inputTurnId: number;
    transcript: string;
  }
  | {
    type: "input_committed";
    inputEpoch: number;
    inputTurnId: number;
    audioEndMs?: number;
  }
  | {
    type: "input_rejected";
    inputEpoch: number;
    inputTurnId: number;
    reason: "no_speech" | "session_ending";
  }
  | {
    type: "response_started";
    responseGeneration: number;
    turnSeq: number;
  }
  | {
    type: "response_segment_declared";
    responseGeneration: number;
    turnSeq: number;
    segmentId: number;
    text: string;
  }
  | {
    type: "response_audio";
    responseGeneration: number;
    turnSeq: number;
    segmentId: number;
    pcm16k: Buffer;
  }
  | {
    type: "response_segment_completed";
    responseGeneration: number;
    turnSeq: number;
    segmentId: number;
  }
  | {
    type: "response_core_terminal";
    responseGeneration: number;
    turnSeq: number;
    status: "completed" | "cancelled" | "failed";
    reason?: string;
  }
  | {
    type: "exam_incomplete";
    reason: string;
  }
  | {
    type: "playback_clear";
    responseGeneration?: number;
    reason: "barge_in" | "new_user_turn" | "session_end" | "superseded";
  }
  | {
    type: "session_ended";
    reason: string;
  }
  | {
    type: "connection_superseded";
  };

type InputLifecycleCoreEvent = Extract<
  RealtimeCoreEvent,
  { inputEpoch: number; inputTurnId: number }
>;

export interface OpenAIRealtimeSessionStateOptions {
  connectionNamespace?: string;
  emit: (event: RealtimeServerEvent, delivery?: RealtimeEventDelivery) => void;
  core?: Partial<RealtimeSessionCore>;
  now?: () => number;
  onAudioHandoff?: (handoff: RealtimeAudioHandoff) => void;
  onProtocolError?: (error: RealtimeProtocolError) => void;
}

const SERVER_MANAGED_FIELDS = [
  "model",
  "instructions",
  "voice",
  "tools",
  "audio.input.turn_detection",
  "question_bank",
  "rubric",
] as const;

interface InputItemState {
  itemId: string;
  inputEpoch: number;
  inputTurnId?: number;
  speechStarted: boolean;
  commitRequested: boolean;
  commitEventId?: string;
  committed: boolean;
  transcript?: string;
  previousItemId: string | null;
  wireStartSample: number;
  wireEndSample: number;
}

interface ResponseItemState {
  responseGeneration: number;
  turnSeq: number;
  responseId: string;
  itemId: string;
  previousItemId: string | null;
  transcript: string;
  itemOpened: boolean;
  audioOpened: boolean;
  transcriptOpened: boolean;
  terminal: boolean;
  interruptRequested: boolean;
  declaredSegments: Map<number, ResponseSegmentState>;
  completedSegments: Set<number>;
  outputResampler: StreamingPcmResampler;
  outputSamplesProduced: number;
  nextDeltaSeq: number;
  nextHandoffSeq: number;
  emittedAudioSamples: number;
  deltaLedger: Map<number, AudioDeltaState>;
  truncateSampleFence?: number;
  truncateAudioEndMs?: number;
}

interface ResponseSegmentState {
  segmentId: number;
  text: string;
  rawEndSample?: number;
  conservativeEndSample?: number;
}

interface AudioDeltaState {
  startSample: number;
  sampleCount: number;
  handedOff: boolean;
}

interface InterruptedResponseTombstone {
  response: ResponseItemState;
  expiresAtMs: number;
}

export class OpenAIRealtimeSessionState {
  private readonly namespace: string;
  private eventCounter = 0;
  private opened = false;
  private fullBootstrapAccepted = false;
  private readonly sessionId: string;
  private readonly conversationId: string;
  private objectCounter = 1;
  private inputEpoch = 0;
  private inputSamples24k = 0;
  // Explicit commit must seal immediately, so input conversion cannot depend
  // on a future append. Output conversion keeps lookahead mode for FIR tails.
  private readonly inputResampler = new StreamingPcmResampler(24_000, 16_000, {
    mode: "causal",
  });
  private currentInput: InputItemState | null = null;
  private readonly committedInputs = new Map<string, InputItemState>();
  private readonly completedInputTurns = new Set<string>();
  private readonly retiredInputTurns = new Set<string>();
  private readonly highestInputTurnByEpoch = new Map<number, number>();
  private readonly pendingInputPcm24k: Buffer[] = [];
  private pendingInputBytes = 0;
  private inputResetCandidate: InputItemState | null = null;
  private readonly inputResetCandidateEvents: InputLifecycleCoreEvent[] = [];
  private readonly knownItems = new Map<string, Record<string, unknown>>();
  private previousItemId: string | null = null;
  private inputResetPending = false;
  private lateCommitEligible = false;
  private responseCreateEligible = false;
  private activeResponse: ResponseItemState | null = null;
  private interruptedResponse: InterruptedResponseTombstone | null = null;

  constructor(private readonly options: OpenAIRealtimeSessionStateOptions) {
    this.namespace =
      options.connectionNamespace ?? randomBytes(16).toString("hex");
    if (!/^[0-9a-f]{32}$/i.test(this.namespace)) {
      throw new Error("connectionNamespace must be a 128-bit hexadecimal value");
    }
    this.sessionId = `sess_${this.namespace}`;
    this.conversationId = `conv_${this.namespace}_1`;
  }

  get activeResponseGeneration(): number | null {
    return this.activeResponse?.responseGeneration ?? null;
  }

  matchesActiveResponse(responseGeneration: number, turnSeq: number): boolean {
    const response = this.activeResponse;
    return (
      !!response &&
      !response.terminal &&
      response.responseGeneration === responseGeneration &&
      response.turnSeq === turnSeq
    );
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.emit("session.created", { session: this.sessionSnapshot() });
    this.emit("conversation.created", {
      conversation: {
        id: this.conversationId,
        object: "realtime.conversation",
      },
    });
  }

  async dispatchClientEvent(event: RealtimeClientEvent): Promise<void> {
    if (!this.opened) throw new Error("realtime session is not open");
    if (event.type === "session.update") {
      this.handleSessionUpdate(event);
      return;
    }
    if (event.type === "input_audio_buffer.append") {
      this.handleInputAppend(event);
      return;
    }
    if (event.type === "input_audio_buffer.commit") {
      this.handleInputCommit(event);
      return;
    }
    if (event.type === "input_audio_buffer.clear") {
      await this.handleInputClear(event);
      return;
    }
    if (event.type === "conversation.item.retrieve") {
      this.handleItemRetrieve(event);
      return;
    }
    if (event.type === "response.cancel") {
      this.handleResponseCancel(event);
      return;
    }
    if (event.type === "conversation.item.truncate") {
      this.handleItemTruncate(event);
      return;
    }
    if (event.type === "response.create") {
      this.handleResponseCreate(event);
      return;
    }
    if (event.type === "viva.session.end") {
      this.options.core?.requestSessionEnd?.("client_request");
      return;
    }
    if (
      event.type === "conversation.item.create" ||
      event.type === "conversation.item.delete"
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "unsupported_feature",
          `${event.type} is not supported by Viva R1`,
          "type",
          event.event_id,
        ),
      );
      return;
    }
    this.emitError(
      new RealtimeProtocolError(
        "unknown_event",
        `client event ${event.type} is not supported`,
        "type",
        event.event_id,
      ),
    );
  }

  dispatchCoreEvent(
    event: RealtimeCoreEvent,
    delivery?: RealtimeEventDelivery,
  ): void {
    if (this.handleInputResetCandidateEvent(event)) return;
    if (event.type === "input_speech_started") {
      this.handleInputSpeechStarted(event);
      return;
    }
    if (event.type === "user_transcript_partial") {
      this.handleUserTranscriptPartial(event);
      return;
    }
    if (event.type === "user_transcript_final") {
      this.handleUserTranscriptFinal(event);
      return;
    }
    if (event.type === "input_committed") {
      this.handleInputCommitted(event);
      return;
    }
    if (event.type === "input_rejected") {
      this.handleInputRejected(event);
      return;
    }
    if (event.type === "response_started") {
      this.handleResponseStarted(event);
      return;
    }
    if (event.type === "response_segment_declared") {
      this.handleResponseSegmentDeclared(event);
      return;
    }
    if (event.type === "response_audio") {
      this.handleResponseAudio(event);
      return;
    }
    if (event.type === "response_segment_completed") {
      this.handleResponseSegmentCompleted(event);
      return;
    }
    if (event.type === "response_core_terminal") {
      this.handleResponseCoreTerminal(event, delivery);
      return;
    }
    if (event.type === "exam_incomplete") {
      this.emit("viva.exam.incomplete", {
        viva_version: "1",
        reason: event.reason,
      });
      return;
    }
    if (event.type === "playback_clear") {
      this.emit("viva.playback.clear", {
        viva_version: "1",
        ...(event.responseGeneration === undefined
          ? {}
          : { response_generation: event.responseGeneration }),
        reason: event.reason,
      });
      return;
    }
    if (event.type === "session_ended") {
      this.interruptedResponse = null;
      this.emit("viva.session.ended", {
        viva_version: "1",
        reason: event.reason,
      }, delivery);
      return;
    }
    if (event.type === "connection_superseded") {
      this.emit("viva.connection.superseded", {
        viva_version: "1",
      }, delivery);
    }
  }

  private handleInputAppend(event: RealtimeClientEvent): void {
    let pcm24k: Buffer;
    try {
      pcm24k = decodePcm16Base64(event.audio as string);
    } catch (error) {
      if (error instanceof RealtimeProtocolError) {
        this.emitError(
          new RealtimeProtocolError(
            error.code,
            error.message,
            error.param,
            event.event_id,
            error.closeCode,
          ),
        );
        return;
      }
      throw error;
    }
    if (
      this.inputResetPending ||
      (this.currentInput?.commitRequested === true &&
        !this.currentInput.committed)
    ) {
      this.queuePendingInput(pcm24k, event.event_id);
      return;
    }
    this.processInputPcm(pcm24k);
  }

  private processInputPcm(pcm24k: Buffer): void {
    if (!this.currentInput) {
      this.lateCommitEligible = false;
      this.responseCreateEligible = false;
      this.currentInput = {
        itemId: this.nextObjectId("item"),
        inputEpoch: this.inputEpoch,
        speechStarted: false,
        commitRequested: false,
        committed: false,
        previousItemId: this.previousItemId,
        wireStartSample: this.inputSamples24k,
        wireEndSample: this.inputSamples24k,
      };
    }
    this.inputSamples24k += pcm24k.length / 2;
    this.currentInput.wireEndSample = this.inputSamples24k;
    const pcm16k = this.inputResampler.push(pcm24k);
    if (pcm16k.length > 0) {
      this.options.core?.pushInputPcm?.({
        inputEpoch: this.inputEpoch,
        pcm16k,
        sourceBytes: pcm24k.length,
      });
    }
  }

  private queuePendingInput(pcm24k: Buffer, eventId?: string): void {
    if (
      this.pendingInputBytes + pcm24k.length >
      REALTIME_LIMITS.MAX_PENDING_INPUT_BYTES
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "payload_too_large",
          `pending input exceeds ${REALTIME_LIMITS.MAX_PENDING_INPUT_BYTES} bytes`,
          "input_audio_buffer",
          eventId,
          1009,
        ),
      );
      return;
    }
    this.pendingInputPcm24k.push(pcm24k);
    this.pendingInputBytes += pcm24k.length;
  }

  private flushPendingInput(): void {
    if (this.inputResetPending || this.currentInput?.commitRequested) return;
    const queued = this.pendingInputPcm24k.splice(0);
    this.pendingInputBytes = 0;
    for (const pcm24k of queued) this.processInputPcm(pcm24k);
  }

  private clearPendingInput(): void {
    this.pendingInputPcm24k.length = 0;
    this.pendingInputBytes = 0;
  }

  private handleInputSpeechStarted(
    event: Extract<RealtimeCoreEvent, { type: "input_speech_started" }>,
  ): void {
    this.ensureInputForSpeechStart(event.inputEpoch, event.inputTurnId);
    const input = this.findInput(event.inputEpoch, event.inputTurnId);
    if (!input) return;
    if (input.inputTurnId !== undefined && input.inputTurnId !== event.inputTurnId) {
      throw new Error("input item cannot be rebound to another core turn");
    }
    input.inputTurnId = event.inputTurnId;
    if (input.speechStarted) return;
    input.speechStarted = true;
    this.emit("input_audio_buffer.speech_started", {
      item_id: input.itemId,
      audio_start_ms:
        event.audioStartMs ??
        Math.floor((input.wireStartSample * 1_000) / 24_000),
    });
  }

  /**
   * Server VAD may seal a GPU turn after the bridge has already accepted PCM
   * that the GPU will process as the next turn. The first identity-bearing
   * callback is authoritative and must be able to allocate that next item.
   */
  private ensureInputForSpeechStart(inputEpoch: number, inputTurnId: number): void {
    if (
      !Number.isInteger(inputEpoch) ||
      inputEpoch < 0 ||
      !Number.isInteger(inputTurnId) ||
      inputTurnId < 0
    ) {
      throw this.coreInputProtocolError("invalid input callback identity");
    }
    if (
      inputEpoch !== this.inputEpoch ||
      this.inputResetPending ||
      this.currentInput ||
      this.committedInputs.has(this.inputKey(inputEpoch, inputTurnId)) ||
      this.completedInputTurns.has(this.inputKey(inputEpoch, inputTurnId)) ||
      this.retiredInputTurns.has(this.inputKey(inputEpoch, inputTurnId))
    ) {
      return;
    }
    const highWater = this.highestInputTurnByEpoch.get(inputEpoch) ?? -1;
    if (inputTurnId <= highWater) {
      throw this.coreInputProtocolError(
        `input turn ${inputTurnId} is not greater than ${highWater}`,
      );
    }
    this.lateCommitEligible = false;
    this.responseCreateEligible = false;
    this.currentInput = {
      itemId: this.nextObjectId("item"),
      inputEpoch,
      inputTurnId,
      speechStarted: false,
      commitRequested: false,
      committed: false,
      previousItemId: this.previousItemId,
      wireStartSample: this.inputSamples24k,
      wireEndSample: this.inputSamples24k,
    };
    this.highestInputTurnByEpoch.set(inputEpoch, inputTurnId);
  }

  private handleUserTranscriptPartial(
    event: Extract<RealtimeCoreEvent, { type: "user_transcript_partial" }>,
  ): void {
    const input = this.findInput(event.inputEpoch, event.inputTurnId);
    if (!input || !event.delta) return;
    this.emit("conversation.item.input_audio_transcription.delta", {
      item_id: input.itemId,
      content_index: 0,
      delta: event.delta,
    });
  }

  private handleInputCommit(event: RealtimeClientEvent): void {
    const input = this.currentInput;
    if (!input) {
      if (this.lateCommitEligible) {
        this.lateCommitEligible = false;
        return;
      }
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "input audio buffer is empty",
          "input_audio_buffer",
          event.event_id,
        ),
      );
      return;
    }
    if (input.commitRequested || input.committed) return;
    input.commitRequested = true;
    input.commitEventId = event.event_id;
    this.options.core?.commitInput?.({
      inputEpoch: input.inputEpoch,
      ...(input.inputTurnId === undefined ? {} : { inputTurnId: input.inputTurnId }),
    });
  }

  private async handleInputClear(event: RealtimeClientEvent): Promise<void> {
    if (this.inputResetPending) {
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "input reset is already in progress",
          "input_audio_buffer",
          event.event_id,
        ),
      );
      return;
    }
    const resetInput = this.options.core?.resetInput;
    if (!resetInput) {
      throw new RealtimeProtocolError(
        "internal_error",
        "input reset is unavailable",
        undefined,
        event.event_id,
        1011,
      );
    }

    const retired = this.currentInput;
    const fromInputEpoch = this.inputEpoch;
    const nextInputEpoch = fromInputEpoch + 1;
    this.inputResetPending = true;
    this.lateCommitEligible = false;
    this.currentInput = null;
    this.inputResetCandidate = retired;
    this.inputResetCandidateEvents.length = 0;
    this.clearPendingInput();
    this.inputResampler.reset();
    try {
      await resetInput({
        fromInputEpoch,
        nextInputEpoch,
        ...(retired?.inputTurnId === undefined
          ? {}
          : { retiredInputTurnId: retired.inputTurnId }),
      });
      if (
        this.inputResetCandidate?.inputTurnId !== undefined &&
        !this.inputResetCandidate.committed
      ) {
        this.retiredInputTurns.add(
          this.inputKey(
            this.inputResetCandidate.inputEpoch,
            this.inputResetCandidate.inputTurnId,
          ),
        );
      }
      this.inputResetCandidate = null;
      this.inputResetCandidateEvents.length = 0;
      this.releaseInputEpochState(fromInputEpoch);
      this.inputEpoch = nextInputEpoch;
      this.emit("input_audio_buffer.cleared", {});
    } catch (error) {
      this.inputResetCandidate = null;
      this.inputResetCandidateEvents.length = 0;
      this.clearPendingInput();
      throw new RealtimeProtocolError(
        "internal_error",
        `input reset fence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "input_audio_buffer",
        event.event_id,
        1011,
      );
    } finally {
      this.inputResetPending = false;
    }
    this.flushPendingInput();
  }

  private handleUserTranscriptFinal(
    event: Extract<RealtimeCoreEvent, { type: "user_transcript_final" }>,
  ): void {
    const input = this.findInput(event.inputEpoch, event.inputTurnId);
    if (!input || input.transcript !== undefined) return;
    input.transcript = event.transcript;
    if (input.committed) this.completeUserItem(input);
  }

  private handleInputCommitted(
    event: Extract<RealtimeCoreEvent, { type: "input_committed" }>,
  ): void {
    const input = this.findInput(event.inputEpoch, event.inputTurnId);
    if (!input || input.committed) return;
    input.committed = true;
    input.commitRequested = true;
    this.lateCommitEligible = true;
    this.responseCreateEligible = true;
    if (input.speechStarted) {
      this.emit("input_audio_buffer.speech_stopped", {
        item_id: input.itemId,
        audio_end_ms:
          event.audioEndMs ??
          Math.floor((input.wireEndSample * 1_000) / 24_000),
      });
    }
    this.emit("input_audio_buffer.committed", {
      item_id: input.itemId,
      previous_item_id: input.previousItemId,
    });
    this.emit("conversation.item.added", {
      item: this.userItemSnapshot(input, "in_progress", null),
      previous_item_id: input.previousItemId,
    });
    this.committedInputs.set(this.inputKey(input.inputEpoch, event.inputTurnId), input);
    if (this.inputResetCandidate === input) {
      this.inputResetCandidate = null;
      this.inputResetCandidateEvents.length = 0;
    }
    this.previousItemId = input.itemId;
    if (this.currentInput === input) this.currentInput = null;
    if (input.transcript !== undefined) this.completeUserItem(input);
    this.flushPendingInput();
  }

  private handleInputRejected(
    event: Extract<RealtimeCoreEvent, { type: "input_rejected" }>,
  ): void {
    const input = this.findInput(event.inputEpoch, event.inputTurnId);
    if (!input) return;
    if (input.speechStarted) {
      this.emit("input_audio_buffer.speech_stopped", {
        item_id: input.itemId,
        audio_end_ms: Math.floor((input.wireEndSample * 1_000) / 24_000),
      });
    }
    this.retiredInputTurns.add(
      this.inputKey(event.inputEpoch, event.inputTurnId),
    );
    if (this.currentInput === input) this.currentInput = null;
    this.lateCommitEligible = true;
    this.responseCreateEligible = false;
    this.emitError(
      new RealtimeProtocolError(
        "invalid_request",
        event.reason === "session_ending"
          ? "input audio was discarded while the session was ending"
          : "input audio did not contain recognizable speech",
        "input_audio_buffer",
        input.commitEventId,
      ),
    );
    this.flushPendingInput();
  }

  private completeUserItem(input: InputItemState): void {
    const transcript = input.transcript;
    if (!input.committed || transcript === undefined) return;
    const item = this.userItemSnapshot(input, "completed", transcript);
    this.knownItems.set(input.itemId, item);
    this.emit("conversation.item.done", {
      item,
      previous_item_id: input.previousItemId,
    });
    this.emit("conversation.item.input_audio_transcription.completed", {
      item_id: input.itemId,
      content_index: 0,
      transcript,
    });
    if (input.inputTurnId !== undefined) {
      const key = this.inputKey(input.inputEpoch, input.inputTurnId);
      this.committedInputs.delete(key);
      this.completedInputTurns.add(key);
    }
  }

  private handleItemRetrieve(event: RealtimeClientEvent): void {
    const itemId = event.item_id;
    if (typeof itemId !== "string" || !this.knownItems.has(itemId)) {
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "conversation item is unknown on this connection",
          "item_id",
          event.event_id,
        ),
      );
      return;
    }
    this.emit("conversation.item.retrieved", {
      item: this.knownItems.get(itemId)!,
    });
  }

  private handleResponseStarted(
    event: Extract<RealtimeCoreEvent, { type: "response_started" }>,
  ): void {
    if (this.activeResponse && !this.activeResponse.terminal) {
      throw new Error("cannot start a concurrent realtime response");
    }
    const response: ResponseItemState = {
      responseGeneration: event.responseGeneration,
      turnSeq: event.turnSeq,
      responseId: this.nextObjectId("resp"),
      itemId: this.nextObjectId("item"),
      previousItemId: this.previousItemId,
      transcript: "",
      itemOpened: false,
      audioOpened: false,
      transcriptOpened: false,
      terminal: false,
      interruptRequested: false,
      declaredSegments: new Map(),
      completedSegments: new Set(),
      outputResampler: new StreamingPcmResampler(16_000, 24_000),
      outputSamplesProduced: 0,
      nextDeltaSeq: 0,
      nextHandoffSeq: 0,
      emittedAudioSamples: 0,
      deltaLedger: new Map(),
    };
    this.activeResponse = response;
    this.emit("response.created", {
      response: this.responseSnapshot(response, "in_progress", []),
    });
  }

  private handleResponseSegmentDeclared(
    event: Extract<RealtimeCoreEvent, { type: "response_segment_declared" }>,
  ): void {
    const response = this.matchActiveResponse(event);
    if (!response || response.declaredSegments.has(event.segmentId)) return;
    response.declaredSegments.set(event.segmentId, {
      segmentId: event.segmentId,
      text: event.text,
    });
    this.openResponseItem(response);
    response.transcript += event.text;
    response.transcriptOpened = true;
    this.emitResponseEvent(response, "response.output_audio_transcript.delta", {
      delta: event.text,
    });
  }

  private handleResponseAudio(
    event: Extract<RealtimeCoreEvent, { type: "response_audio" }>,
  ): void {
    const response = this.matchActiveResponse(event);
    if (!response || !response.declaredSegments.has(event.segmentId)) return;
    const pcm24k = response.outputResampler.push(event.pcm16k);
    if (pcm24k.length === 0) return;
    response.audioOpened = true;
    this.emitAudioDelta(response, event.segmentId, pcm24k);
  }

  private handleResponseSegmentCompleted(
    event: Extract<RealtimeCoreEvent, { type: "response_segment_completed" }>,
  ): void {
    const response = this.matchActiveResponse(event);
    if (!response || !response.declaredSegments.has(event.segmentId)) return;
    response.completedSegments.add(event.segmentId);
    const segment = response.declaredSegments.get(event.segmentId)!;
    segment.rawEndSample = response.outputSamplesProduced;
    segment.conservativeEndSample =
      segment.rawEndSample + response.outputResampler.tailOutputSamples;
  }

  private handleResponseCoreTerminal(
    event: Extract<RealtimeCoreEvent, { type: "response_core_terminal" }>,
    delivery?: RealtimeEventDelivery,
  ): void {
    const response = this.matchActiveResponse(event, true);
    if (!response || response.terminal) return;
    response.terminal = true;

    if (event.status === "completed") {
      const tail = response.outputResampler.finalize();
      if (tail.length > 0) {
        response.audioOpened = true;
        const lastSegmentId = Array.from(response.declaredSegments.keys()).at(-1);
        if (lastSegmentId !== undefined) {
          this.emitAudioDelta(response, lastSegmentId, tail);
        }
      }
      const lastSegment = Array.from(response.declaredSegments.values()).at(-1);
      if (
        lastSegment &&
        lastSegment.rawEndSample !== undefined &&
        lastSegment.conservativeEndSample !== undefined
      ) {
        lastSegment.conservativeEndSample = Math.min(
          lastSegment.conservativeEndSample,
          response.outputSamplesProduced,
        );
      }
    } else {
      response.outputResampler.reset();
    }

    const itemStatus = event.status === "completed" ? "completed" : "incomplete";
    const item = this.assistantItemSnapshot(response, itemStatus);
    if (response.itemOpened) {
      if (response.audioOpened) {
        this.emitResponseEvent(response, "response.output_audio.done", {});
      }
      if (response.transcriptOpened) {
        this.emitResponseEvent(response, "response.output_audio_transcript.done", {
          transcript: this.visibleResponseTranscript(response),
        });
      }
      this.emitResponseEvent(response, "response.content_part.done", {
        part: { type: "audio", transcript: this.visibleResponseTranscript(response) },
      });
      this.emit("response.output_item.done", {
        response_id: response.responseId,
        output_index: 0,
        item,
      });
      this.emit("conversation.item.done", {
        item,
        previous_item_id: response.previousItemId,
      });
      this.knownItems.set(response.itemId, item);
    }
    this.emit("response.done", {
      response: this.responseSnapshot(
        response,
        event.status,
        response.itemOpened ? [item] : [],
        event.reason,
      ),
    }, delivery);
    if (event.status === "cancelled" && response.itemOpened) {
      this.interruptedResponse = {
        response,
        expiresAtMs: this.now() + 10_000,
      };
    }
    this.activeResponse = null;
  }

  private openResponseItem(response: ResponseItemState): void {
    if (response.itemOpened) return;
    response.itemOpened = true;
    const item = this.assistantItemSnapshot(response, "in_progress", "");
    this.emit("response.output_item.added", {
      response_id: response.responseId,
      output_index: 0,
      item,
    });
    this.emit("conversation.item.added", {
      item,
      previous_item_id: response.previousItemId,
    });
    this.emitResponseEvent(response, "response.content_part.added", {
      part: { type: "audio", transcript: "" },
    });
    this.knownItems.set(response.itemId, item);
    this.previousItemId = response.itemId;
  }

  private emitResponseEvent(
    response: ResponseItemState,
    type: string,
    payload: Record<string, unknown>,
    delivery?: RealtimeEventDelivery,
  ): void {
    this.emit(type, {
      response_id: response.responseId,
      item_id: response.itemId,
      output_index: 0,
      content_index: 0,
      ...payload,
    }, delivery);
  }

  private emitAudioDelta(
    response: ResponseItemState,
    segmentId: number,
    pcm24k: Buffer,
  ): void {
    const sampleCount = pcm24k.length / 2;
    const deltaSeq = response.nextDeltaSeq;
    response.nextDeltaSeq += 1;
    const startSample = response.outputSamplesProduced;
    response.outputSamplesProduced += sampleCount;
    response.deltaLedger.set(deltaSeq, {
      startSample,
      sampleCount,
      handedOff: false,
    });
    this.emitResponseEvent(
      response,
      "response.output_audio.delta",
      { delta: pcm24k.toString("base64") },
      {
        onHandoff: () => this.noteAudioHandoff(response, deltaSeq, segmentId),
      },
    );
  }

  private noteAudioHandoff(
    response: ResponseItemState,
    deltaSeq: number,
    segmentId: number,
  ): void {
    const delta = response.deltaLedger.get(deltaSeq);
    if (!delta || delta.handedOff) return;
    delta.handedOff = true;
    while (true) {
      const next = response.deltaLedger.get(response.nextHandoffSeq);
      if (!next?.handedOff) break;
      response.emittedAudioSamples = next.startSample + next.sampleCount;
      response.nextHandoffSeq += 1;
    }
    this.options.onAudioHandoff?.({
      responseGeneration: response.responseGeneration,
      segmentId,
      deltaSeq,
      samples24k: delta.sampleCount,
    });
  }

  private handleResponseCancel(event: RealtimeClientEvent): void {
    const requestedId = event.response_id;
    if (requestedId !== undefined && typeof requestedId !== "string") {
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "response_id must be a string",
          "response_id",
          event.event_id,
        ),
      );
      return;
    }
    const response = this.activeResponse;
    if (response && (requestedId === undefined || requestedId === response.responseId)) {
      this.interruptResponse(response);
      return;
    }
    const tombstone = this.currentTombstone();
    if (
      tombstone &&
      (requestedId === undefined || requestedId === tombstone.response.responseId)
    ) {
      return;
    }
    this.emitError(
      new RealtimeProtocolError(
        "invalid_request",
        "response is not active on this connection",
        "response_id",
        event.event_id,
      ),
    );
  }

  private handleResponseCreate(event: RealtimeClientEvent): void {
    const rawResponse = event.response;
    if (
      rawResponse !== undefined &&
      (!rawResponse || typeof rawResponse !== "object" || Array.isArray(rawResponse))
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "response.create response must be an object",
          "response",
          event.event_id,
        ),
      );
      return;
    }
    const response = (rawResponse ?? {}) as Record<string, unknown>;
    const keys = Object.keys(response);
    const disallowedKey = keys.find((key) => key !== "conversation");
    if (disallowedKey) {
      const serverManaged = [
        "instructions",
        "prompt",
        "input",
        "output_modalities",
        "audio",
        "max_output_tokens",
        "reasoning",
        "metadata",
      ].includes(disallowedKey);
      this.emitError(
        new RealtimeProtocolError(
          serverManaged ? "server_managed_field" : "unsupported_feature",
          `response.${disallowedKey} is not supported by Viva R1`,
          `response.${disallowedKey}`,
          event.event_id,
        ),
      );
      return;
    }
    if (
      Object.prototype.hasOwnProperty.call(response, "conversation") &&
      response.conversation !== "auto"
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "unsupported_feature",
          'response.conversation only supports "auto"',
          "response.conversation",
          event.event_id,
        ),
      );
      return;
    }
    if (!this.responseCreateEligible && !this.activeResponse) {
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "no committed input is awaiting a response",
          "response",
          event.event_id,
        ),
      );
    }
  }

  private handleItemTruncate(event: RealtimeClientEvent): void {
    const itemId = event.item_id;
    const contentIndex = event.content_index;
    const audioEndMs = event.audio_end_ms;
    if (
      typeof itemId !== "string" ||
      contentIndex !== 0 ||
      !Number.isInteger(audioEndMs) ||
      (audioEndMs as number) < 0
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "truncate requires a current audio item, content_index 0, and integer audio_end_ms",
          "conversation.item.truncate",
          event.event_id,
        ),
      );
      return;
    }

    const active =
      this.activeResponse?.itemId === itemId ? this.activeResponse : undefined;
    const tombstone = this.currentTombstone();
    const response =
      active ?? (tombstone?.response.itemId === itemId ? tombstone.response : undefined);
    if (!response || !response.itemOpened) {
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "assistant audio item is not current or recently interrupted",
          "item_id",
          event.event_id,
        ),
      );
      return;
    }

    const emittedAudioMs = Math.floor(
      (response.emittedAudioSamples * 1_000) / 24_000,
    );
    if ((audioEndMs as number) > emittedAudioMs) {
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "audio_end_ms exceeds callback-confirmed audio",
          "audio_end_ms",
          event.event_id,
        ),
      );
      return;
    }
    const requestedFence = Math.floor(((audioEndMs as number) * 24_000) / 1_000);
    response.truncateSampleFence =
      response.truncateSampleFence === undefined
        ? Math.min(response.emittedAudioSamples, requestedFence)
        : Math.min(response.truncateSampleFence, requestedFence);
    response.truncateAudioEndMs =
      response.truncateAudioEndMs === undefined
        ? (audioEndMs as number)
        : Math.min(response.truncateAudioEndMs, audioEndMs as number);
    const item = this.assistantItemSnapshot(response, "incomplete");
    this.knownItems.set(response.itemId, item);
    this.emit("conversation.item.truncated", {
      item_id: response.itemId,
      content_index: 0,
      audio_end_ms: response.truncateAudioEndMs,
    });
    if (active) this.interruptResponse(response);
  }

  private interruptResponse(response: ResponseItemState): void {
    if (response.interruptRequested || response.terminal) return;
    response.interruptRequested = true;
    this.options.core?.cancelActiveResponse?.({
      responseGeneration: response.responseGeneration,
      reason: "client_cancelled",
    });
  }

  private currentTombstone(): InterruptedResponseTombstone | null {
    const tombstone = this.interruptedResponse;
    if (tombstone && tombstone.expiresAtMs > this.now()) return tombstone;
    this.interruptedResponse = null;
    return null;
  }

  private visibleResponseTranscript(response: ResponseItemState): string {
    if (response.truncateSampleFence === undefined) return response.transcript;
    let transcript = "";
    for (const segment of response.declaredSegments.values()) {
      if (
        !response.completedSegments.has(segment.segmentId) ||
        segment.conservativeEndSample === undefined ||
        segment.conservativeEndSample > response.truncateSampleFence
      ) {
        break;
      }
      transcript += segment.text;
    }
    return transcript;
  }

  private matchActiveResponse(event: {
    responseGeneration: number;
    turnSeq: number;
  }, allowInterrupted = false): ResponseItemState | undefined {
    const response = this.activeResponse;
    if (
      !response ||
      response.terminal ||
      (response.interruptRequested && !allowInterrupted) ||
      response.responseGeneration !== event.responseGeneration ||
      response.turnSeq !== event.turnSeq
    ) {
      return undefined;
    }
    return response;
  }

  private assistantItemSnapshot(
    response: ResponseItemState,
    status: "in_progress" | "completed" | "incomplete",
    transcript = this.visibleResponseTranscript(response),
  ): Record<string, unknown> {
    return {
      id: response.itemId,
      object: "realtime.item",
      type: "message",
      role: "assistant",
      status,
      content: [{ type: "output_audio", transcript }],
    };
  }

  private responseSnapshot(
    response: ResponseItemState,
    status: "in_progress" | "completed" | "cancelled" | "failed",
    output: Record<string, unknown>[],
    reason?: string,
  ): Record<string, unknown> {
    const statusDetails =
      status === "in_progress" || status === "completed"
        ? null
        : {
            type: status,
            ...(reason ? { reason } : {}),
          };
    return {
      id: response.responseId,
      object: "realtime.response",
      conversation_id: this.conversationId,
      status,
      status_details: statusDetails,
      output,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private findInput(inputEpoch: number, inputTurnId: number): InputItemState | undefined {
    if (
      !Number.isInteger(inputEpoch) ||
      inputEpoch < 0 ||
      !Number.isInteger(inputTurnId) ||
      inputTurnId < 0
    ) {
      throw this.coreInputProtocolError("invalid input callback identity");
    }
    if (inputEpoch !== this.inputEpoch) {
      throw this.coreInputProtocolError(
        `stale input callback epoch ${inputEpoch}; current epoch is ${this.inputEpoch}`,
      );
    }
    const key = this.inputKey(inputEpoch, inputTurnId);
    if (
      this.retiredInputTurns.has(key) ||
      this.completedInputTurns.has(key)
    ) {
      return undefined;
    }
    const committed = this.committedInputs.get(key);
    if (committed) return committed;
    const resetCandidate = this.inputResetCandidate;
    if (
      this.inputResetPending &&
      resetCandidate?.inputEpoch === inputEpoch &&
      resetCandidate.inputTurnId === inputTurnId
    ) {
      return resetCandidate;
    }
    if (this.inputResetPending) return undefined;
    const current = this.currentInput;
    if (current && current.inputEpoch === inputEpoch) {
      if (current.inputTurnId === undefined) {
        const highWater = this.highestInputTurnByEpoch.get(inputEpoch) ?? -1;
        if (inputTurnId <= highWater) {
          throw this.coreInputProtocolError(
            `input turn ${inputTurnId} is not greater than ${highWater}`,
          );
        }
        current.inputTurnId = inputTurnId;
        this.highestInputTurnByEpoch.set(inputEpoch, inputTurnId);
      }
      if (current.inputTurnId === inputTurnId) return current;
      throw this.coreInputProtocolError(
        `input callback turn ${inputTurnId} does not match active turn ${current.inputTurnId}`,
      );
    }
    throw this.coreInputProtocolError(
      `input callback ${inputEpoch}:${inputTurnId} has no matching buffer`,
    );
  }

  private coreInputProtocolError(message: string): RealtimeProtocolError {
    return new RealtimeProtocolError(
      "internal_error",
      message,
      "input_audio_buffer",
      undefined,
      1011,
    );
  }

  private inputKey(inputEpoch: number, inputTurnId: number): string {
    return `${inputEpoch}:${inputTurnId}`;
  }

  private handleInputResetCandidateEvent(event: RealtimeCoreEvent): boolean {
    if (
      !this.inputResetPending ||
      !this.inputResetCandidate ||
      !(
        event.type === "input_speech_started" ||
        event.type === "user_transcript_partial" ||
        event.type === "user_transcript_final" ||
        event.type === "input_committed" ||
        event.type === "input_rejected"
      )
    ) {
      return false;
    }

    const candidate = this.inputResetCandidate;
    if (event.inputEpoch !== candidate.inputEpoch) return false;
    const key = this.inputKey(event.inputEpoch, event.inputTurnId);
    if (
      this.committedInputs.has(key) ||
      this.completedInputTurns.has(key) ||
      this.retiredInputTurns.has(key)
    ) {
      return false;
    }
    if (candidate.inputTurnId === undefined) {
      const highWater = this.highestInputTurnByEpoch.get(event.inputEpoch) ?? -1;
      if (event.inputTurnId <= highWater) {
        throw this.coreInputProtocolError(
          `input turn ${event.inputTurnId} is not greater than ${highWater}`,
        );
      }
      candidate.inputTurnId = event.inputTurnId;
      this.highestInputTurnByEpoch.set(event.inputEpoch, event.inputTurnId);
    } else if (candidate.inputTurnId !== event.inputTurnId) {
      return false;
    }

    if (event.type === "input_rejected") {
      this.retiredInputTurns.add(key);
      this.inputResetCandidate = null;
      this.inputResetCandidateEvents.length = 0;
      return true;
    }
    if (event.type !== "input_committed") {
      this.inputResetCandidateEvents.push(event);
      return true;
    }

    const buffered = this.inputResetCandidateEvents.splice(0);
    for (const pending of buffered) {
      if (pending.type === "input_speech_started") {
        this.handleInputSpeechStarted(pending);
      } else if (pending.type === "user_transcript_partial") {
        this.handleUserTranscriptPartial(pending);
      } else if (pending.type === "user_transcript_final") {
        this.handleUserTranscriptFinal(pending);
      }
    }
    this.handleInputCommitted(event);
    return true;
  }

  private releaseInputEpochState(inputEpoch: number): void {
    const prefix = `${inputEpoch}:`;
    for (const inputs of [
      this.committedInputs,
      this.completedInputTurns,
      this.retiredInputTurns,
    ]) {
      for (const key of inputs.keys()) {
        if (key.startsWith(prefix)) inputs.delete(key);
      }
    }
    this.highestInputTurnByEpoch.delete(inputEpoch);
  }

  private userItemSnapshot(
    input: InputItemState,
    status: "in_progress" | "completed",
    transcript: string | null,
  ): Record<string, unknown> {
    return {
      id: input.itemId,
      object: "realtime.item",
      type: "message",
      role: "user",
      status,
      content: [{ type: "input_audio", transcript }],
    };
  }

  private handleSessionUpdate(event: RealtimeClientEvent): void {
    if (!event.session || typeof event.session !== "object" || Array.isArray(event.session)) {
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "session.update requires a session object",
          "session",
          event.event_id,
        ),
      );
      return;
    }
    const session = event.session as Record<string, unknown>;
    const keys = Object.keys(session);
    if (
      Object.prototype.hasOwnProperty.call(session, "type") &&
      session.type !== "realtime"
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "unsupported_feature",
          'session.type only supports "realtime"',
          "session.type",
          event.event_id,
        ),
      );
      return;
    }

    const allowedInitialFields = new Set([
      "type",
      "instructions",
      "model",
      "output_modalities",
      "audio",
      "tool_choice",
      "tools",
      "tracing",
      "metadata",
    ]);
    const unsupportedField = keys.find(
      (key) => !allowedInitialFields.has(key),
    );
    if (unsupportedField) {
      this.emitError(
        new RealtimeProtocolError(
          "unsupported_feature",
          `session.${unsupportedField} is not supported by Viva R1`,
          `session.${unsupportedField}`,
          event.event_id,
        ),
      );
      return;
    }

    if (
      Object.prototype.hasOwnProperty.call(session, "tools") &&
      (!Array.isArray(session.tools) || session.tools.length > 0)
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "unsupported_feature",
          "session.tools is not supported by Viva R1",
          "session.tools",
          event.event_id,
        ),
      );
      return;
    }

    const compatibilityOnly = keys.every(
      (key) =>
        key === "type" ||
        key === "tracing" ||
        key === "metadata" ||
        (key === "tools" &&
          Array.isArray(session.tools) &&
          session.tools.length === 0),
    );
    if (compatibilityOnly) {
      this.emit("session.updated", { session: this.sessionSnapshot() });
      return;
    }

    if (this.fullBootstrapAccepted) {
      const managedField = keys.find(
        (key) =>
          key !== "type" &&
          key !== "tracing" &&
          key !== "metadata" &&
          key !== "tools",
      );
      this.emitError(
        new RealtimeProtocolError(
          "server_managed_field",
          managedField
            ? `session.${managedField} is managed by Viva`
            : "Viva session configuration is server managed",
          managedField ? `session.${managedField}` : "session",
          event.event_id,
        ),
      );
      return;
    }

    if (
      Object.prototype.hasOwnProperty.call(session, "model") &&
      session.model !== "gpt-realtime-2.1"
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "server_managed_field",
          "session.model is managed by Viva",
          "session.model",
          event.event_id,
        ),
      );
      return;
    }
    if (
      Object.prototype.hasOwnProperty.call(session, "instructions") &&
      typeof session.instructions !== "string"
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "invalid_request",
          "session.instructions must be a string",
          "session.instructions",
          event.event_id,
        ),
      );
      return;
    }
    if (
      Object.prototype.hasOwnProperty.call(session, "output_modalities") &&
      (!Array.isArray(session.output_modalities) ||
        session.output_modalities.length !== 1 ||
        session.output_modalities[0] !== "audio")
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "unsupported_feature",
          "only audio output is supported by Viva R1",
          "session.output_modalities",
          event.event_id,
        ),
      );
      return;
    }
    if (
      Object.prototype.hasOwnProperty.call(session, "tool_choice") &&
      session.tool_choice !== "auto"
    ) {
      this.emitError(
        new RealtimeProtocolError(
          "unsupported_feature",
          'session.tool_choice only supports the pinned SDK default "auto"',
          "session.tool_choice",
          event.event_id,
        ),
      );
      return;
    }
    const audio = session.audio;
    if (audio !== undefined) {
      const audioError = this.validateInitialAudioConfig(audio, event.event_id);
      if (audioError) {
        this.emitError(audioError);
        return;
      }
    }
    this.fullBootstrapAccepted = true;
    this.emit("session.updated", { session: this.sessionSnapshot() });
  }

  private validateInitialAudioConfig(
    value: unknown,
    eventId?: string,
  ): RealtimeProtocolError | null {
    const unsupported = (param: string, message: string) =>
      new RealtimeProtocolError(
        "unsupported_feature",
        message,
        param,
        eventId,
      );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return unsupported(
        "session.audio",
        "session audio must be an object using PCM16 at 24 kHz",
      );
    }
    const audio = value as Record<string, unknown>;
    const unknownAudioField = Object.keys(audio).find(
      (key) => key !== "input" && key !== "output",
    );
    if (unknownAudioField) {
      return unsupported(
        `session.audio.${unknownAudioField}`,
        `session.audio.${unknownAudioField} is not supported by Viva R1`,
      );
    }
    for (const direction of ["input", "output"] as const) {
      const rawDirection = audio[direction];
      if (rawDirection === undefined) continue;
      if (
        !rawDirection ||
        typeof rawDirection !== "object" ||
        Array.isArray(rawDirection)
      ) {
        return unsupported(
          `session.audio.${direction}`,
          `session.audio.${direction} must be an object`,
        );
      }
      const directionConfig = rawDirection as Record<string, unknown>;
      const allowedDirectionFields =
        direction === "input"
          ? new Set([
              "format",
              "noise_reduction",
              "transcription",
              "turn_detection",
            ])
          : new Set(["format", "voice", "speed"]);
      const unknownDirectionField = Object.keys(directionConfig).find(
        (key) => !allowedDirectionFields.has(key),
      );
      if (unknownDirectionField) {
        return unsupported(
          `session.audio.${direction}.${unknownDirectionField}`,
          `session.audio.${direction}.${unknownDirectionField} is not supported by Viva R1`,
        );
      }

      const format = directionConfig.format;
      if (format === undefined) continue;
      if (!format || typeof format !== "object" || Array.isArray(format)) {
        return unsupported(
          `session.audio.${direction}.format`,
          "session audio must use PCM16 at 24 kHz",
        );
      }
      const typedFormat = format as Record<string, unknown>;
      if (
        Object.keys(typedFormat).some(
          (key) => key !== "type" && key !== "rate",
        ) ||
        typedFormat.type !== "audio/pcm" ||
        typedFormat.rate !== 24_000
      ) {
        return unsupported(
          `session.audio.${direction}.format`,
          "session audio must use PCM16 at 24 kHz",
        );
      }
    }

    const input = audio.input as Record<string, unknown> | undefined;
    if (
      input &&
      Object.prototype.hasOwnProperty.call(input, "noise_reduction") &&
      input.noise_reduction !== null
    ) {
      return unsupported(
        "session.audio.input.noise_reduction",
        "input noise reduction is not supported by Viva R1",
      );
    }
    if (input?.transcription !== undefined) {
      const transcription = input.transcription;
      if (
        !transcription ||
        typeof transcription !== "object" ||
        Array.isArray(transcription) ||
        Object.keys(transcription).some((key) => key !== "model") ||
        (transcription as Record<string, unknown>).model !==
          "gpt-4o-mini-transcribe"
      ) {
        return unsupported(
          "session.audio.input.transcription",
          "only the pinned SDK transcription bootstrap is supported",
        );
      }
    }
    if (
      input?.turn_detection !== undefined &&
      (input.turn_detection === null ||
        typeof input.turn_detection !== "object" ||
        Array.isArray(input.turn_detection))
    ) {
      return unsupported(
        "session.audio.input.turn_detection",
        "turn detection must use the pinned SDK bootstrap shape",
      );
    }
    if (input?.turn_detection !== undefined) {
      const turnDetection = input.turn_detection as Record<string, unknown>;
      const allowedTurnDetectionFields = new Set([
        "type",
        "create_response",
        "eagerness",
        "interrupt_response",
        "prefix_padding_ms",
        "silence_duration_ms",
        "threshold",
        "idle_timeout_ms",
        "model_version",
      ]);
      const unknownTurnDetectionField = Object.keys(turnDetection).find(
        (key) => !allowedTurnDetectionFields.has(key),
      );
      if (unknownTurnDetectionField) {
        return unsupported(
          `session.audio.input.turn_detection.${unknownTurnDetectionField}`,
          `session.audio.input.turn_detection.${unknownTurnDetectionField} is not supported by Viva R1`,
        );
      }
      if (
        turnDetection.type !== "semantic_vad" &&
        turnDetection.type !== "server_vad"
      ) {
        return unsupported(
          "session.audio.input.turn_detection.type",
          "turn detection must use a pinned SDK VAD type",
        );
      }
      for (const field of ["create_response", "interrupt_response"] as const) {
        if (
          turnDetection[field] !== undefined &&
          typeof turnDetection[field] !== "boolean"
        ) {
          return unsupported(
            `session.audio.input.turn_detection.${field}`,
            `session.audio.input.turn_detection.${field} must be boolean`,
          );
        }
      }
      if (
        turnDetection.eagerness !== undefined &&
        !["auto", "low", "medium", "high"].includes(
          String(turnDetection.eagerness),
        )
      ) {
        return unsupported(
          "session.audio.input.turn_detection.eagerness",
          "session.audio.input.turn_detection.eagerness is not supported",
        );
      }
      for (const field of [
        "prefix_padding_ms",
        "silence_duration_ms",
        "threshold",
        "idle_timeout_ms",
      ] as const) {
        if (
          turnDetection[field] !== undefined &&
          (typeof turnDetection[field] !== "number" ||
            !Number.isFinite(turnDetection[field]))
        ) {
          return unsupported(
            `session.audio.input.turn_detection.${field}`,
            `session.audio.input.turn_detection.${field} must be finite`,
          );
        }
      }
      if (
        turnDetection.model_version !== undefined &&
        typeof turnDetection.model_version !== "string"
      ) {
        return unsupported(
          "session.audio.input.turn_detection.model_version",
          "session.audio.input.turn_detection.model_version must be a string",
        );
      }
    }
    const output = audio.output as Record<string, unknown> | undefined;
    if (
      output?.voice !== undefined &&
      (typeof output.voice !== "string" || output.voice.length === 0)
    ) {
      return unsupported(
        "session.audio.output.voice",
        "session audio voice must use the pinned SDK bootstrap shape",
      );
    }
    if (output?.speed !== undefined && output.speed !== 1) {
      return unsupported(
        "session.audio.output.speed",
        "session audio speed is managed by Viva",
      );
    }
    return null;
  }

  private sessionSnapshot(): Record<string, unknown> {
    return {
      id: this.sessionId,
      type: "realtime",
      object: "realtime.session",
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          turn_detection: {
            type: "server_vad",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: 24_000 },
        },
      },
      tracing: null,
      viva: {
        server_managed_fields: [...SERVER_MANAGED_FIELDS],
      },
    };
  }

  private emit(
    type: string,
    payload: Record<string, unknown>,
    delivery?: RealtimeEventDelivery,
  ): void {
    this.options.emit(
      {
        type,
        event_id: this.nextEventId(),
        ...payload,
      },
      delivery,
    );
  }

  private emitError(error: RealtimeProtocolError): void {
    this.emit("error", {
      error: {
        type: error.errorType,
        code: error.code,
        message: error.message,
        ...(error.param ? { param: error.param } : {}),
        ...(error.eventId ? { event_id: error.eventId } : {}),
      },
    });
    this.options.onProtocolError?.(error);
  }

  reportProtocolError(error: RealtimeProtocolError): void {
    this.emitError(error);
  }

  private nextEventId(): string {
    this.eventCounter += 1;
    return `event_${this.namespace}_${this.eventCounter}`;
  }

  private nextObjectId(prefix: "item" | "resp"): string {
    const id = `${prefix}_${this.namespace}_${this.objectCounter}`;
    this.objectCounter += 1;
    return id;
  }
}
