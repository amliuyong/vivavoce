export const MEDIA_SESSION_OUTPUT_LIMITS = {
  MAX_PENDING_BYTES: 384_000,
  MAX_QUEUE_AGE_MS: 5_000,
} as const;

export const UX_TELEMETRY_LIMITS = {
  MAX_DURATION_MS: 24 * 60 * 60 * 1000,
  MAX_RING_DEPTH_MS: 5 * 60 * 1000,
  MAX_UNDERRUNS: 1_000_000,
} as const;

export interface UxTelemetryMetrics {
  markerToFirstBinaryMs?: number;
  firstBinaryToFirstRenderMs?: number;
  markerToFirstRenderMs?: number;
  coldPrerollMs?: number;
  underrunsBeforeFirstRender?: number;
  pauseToFirstSilentRenderMs?: number;
  confirmToWorkletFlushMs?: number;
  browserRingDepthAtConfirmMs?: number;
  browserRingDepthBeforeFlushMs?: number;
  browserRingDepthAfterFlushMs?: number;
}

export type MediaSessionCommand =
  | {
      type: "input_audio";
      pcm16k: Buffer;
      inputEpoch?: number;
      sourceBytes?: number;
    }
  | { type: "commit_input"; inputEpoch: number; inputTurnId?: number }
  | {
      type: "reset_input";
      fromInputEpoch: number;
      nextInputEpoch: number;
      retiredInputTurnId?: number;
    }
  | {
      type: "cancel_response";
      responseGeneration: number;
      reason: string;
    }
  | {
      type: "set_output_flow";
      responseGeneration: number;
      paused: boolean;
      residentWireBytes: number;
    }
  | {
      type: "note_output_handoff";
      responseGeneration: number;
      segmentId: number;
      deltaSeq: number;
      samples24k: number;
      handedOffAtMs: number;
    }
  | {
      type: "note_response_wire_drained";
      responseGeneration: number;
      responseDoneHandedOffAtMs: number;
    }
  | {
      type: "note_output_wire_failure";
      responseGeneration?: number;
      reason: string;
    }
  | { type: "request_end" }
  | { type: "interrupt" }
  | { type: "playback_complete"; aiTurnId: number; reason?: string }
  | { type: "playback_aborted"; aiTurnId: number; reason?: string }
  | { type: "ux_telemetry"; aiTurnId: number; metrics: UxTelemetryMetrics };

export type MediaSessionCommandHandler = (
  command: MediaSessionCommand,
) => unknown;

export type MediaSessionOutputEvent =
  | {
      type: "audio";
      pcm16k: Buffer;
    }
  | {
      type: "input_speech_started";
      inputEpoch: number;
      inputTurnId: number;
    }
  | {
      type: "input_committed";
      inputEpoch: number;
      inputTurnId: number;
    }
  | {
      type: "input_rejected";
      inputEpoch: number;
      inputTurnId: number;
      reason: "no_speech" | "session_ending";
    }
  | {
      type: "user_transcript_partial";
      text: string;
      inputEpoch: number;
      inputTurnId: number;
    }
  | {
      type: "user_transcript_final";
      seq: number;
      text: string;
      inputEpoch: number;
      inputTurnId: number;
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
      type: "response_output_delivery_failed";
      responseGeneration: number;
      reason: "core_pending_output_limit" | "core_pending_output_timeout";
    }
  | {
      type: "playback_clear";
      responseGeneration?: number;
      reason: "barge_in" | "new_user_turn" | "session_end" | "superseded";
    }
  | { type: "interruption_confirmed"; aiTurnId?: number; pauseId?: number }
  | { type: "interruption_paused"; aiTurnId: number; pauseId: number }
  | { type: "interruption_resumed"; aiTurnId: number; pauseId: number }
  | { type: "turn_audio_started"; aiTurnId: number }
  | { type: "turn_audio_ended"; aiTurnId: number }
  | { type: "transcript_partial"; speaker: "user"; text: string }
  | {
      type: "transcript_final";
      speaker: "user" | "ai";
      seq: number;
      text: string;
      inputEpoch?: number;
      inputTurnId?: number;
    }
  | {
      type: "transcript_corrected";
      speaker: "user";
      seq: number;
      text: string;
    }
  | { type: "exam_incomplete" };

export type MediaSessionResponseOutputEvent = Extract<
  MediaSessionOutputEvent,
  { responseGeneration: number }
>;

export type MediaSessionCloseEvent =
  | { type: "session_ended"; reason: string }
  | { type: "connection_superseded" };

export interface MediaSessionTransport {
  readonly protocolNeutral: true;
  readonly outputDelivery: "immediate" | "callback_confirmed";
  readonly inputPendingLimitBytes?: number;
  onCommand(callback: MediaSessionCommandHandler): void;
  onClose(callback: () => void): void;
  emit(event: MediaSessionOutputEvent): void;
  close(event: MediaSessionCloseEvent): void;
}
