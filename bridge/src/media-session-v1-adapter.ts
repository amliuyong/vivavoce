import {
  MediaSessionCloseEvent,
  MediaSessionCommand,
  MediaSessionCommandHandler,
  MediaSessionOutputEvent,
  MediaSessionTransport,
  UX_TELEMETRY_LIMITS,
} from "./media-session-port";

export interface WsConn {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close", cb: () => void): void;
}

export class V1MediaSessionTransport implements MediaSessionTransport {
  readonly protocolNeutral = true as const;
  readonly outputDelivery = "immediate" as const;
  private closeRequested = false;
  private closeRequestResolve!: () => void;
  private readonly closeRequestPromise = new Promise<void>((resolve) => {
    this.closeRequestResolve = resolve;
  });

  constructor(private readonly conn: WsConn) {}

  onCommand(callback: MediaSessionCommandHandler): void {
    const dispatch = (command: MediaSessionCommand) => {
      void Promise.resolve(callback(command)).catch(() => {
        // v1 has no command-level error response and historically ignored failures.
      });
    };
    this.conn.on("message", (data, isBinary) => {
      if (isBinary) {
        dispatch({ type: "input_audio", pcm16k: data });
        return;
      }
      try {
        const message = JSON.parse(data.toString("utf8")) as {
          type?: unknown;
          ai_turn_id?: unknown;
          reason?: unknown;
          marker_to_first_binary_ms?: unknown;
          first_binary_to_first_render_ms?: unknown;
          marker_to_first_render_ms?: unknown;
          cold_preroll_ms?: unknown;
          underruns_before_first_render?: unknown;
          pause_to_first_silent_render_ms?: unknown;
          confirm_to_worklet_flush_ms?: unknown;
          browser_ring_depth_at_confirm_ms?: unknown;
          browser_ring_depth_before_flush_ms?: unknown;
          browser_ring_depth_after_flush_ms?: unknown;
        };
        if (message.type === "end") {
          dispatch({ type: "request_end" });
        } else if (message.type === "barge_in") {
          dispatch({ type: "interrupt" });
        } else if (
          (message.type === "playback_complete" ||
            message.type === "playback_aborted") &&
          typeof message.ai_turn_id === "number"
        ) {
          dispatch({
            type: message.type,
            aiTurnId: message.ai_turn_id,
            ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
          });
        } else if (
          message.type === "ux_telemetry" &&
          Number.isSafeInteger(message.ai_turn_id) &&
          Number(message.ai_turn_id) >= 0
        ) {
          const metrics = {
            markerToFirstBinaryMs: finiteDuration(message.marker_to_first_binary_ms),
            firstBinaryToFirstRenderMs: finiteDuration(message.first_binary_to_first_render_ms),
            markerToFirstRenderMs: finiteDuration(message.marker_to_first_render_ms),
            coldPrerollMs: finiteDuration(message.cold_preroll_ms),
            underrunsBeforeFirstRender: finiteNonNegativeInteger(
              message.underruns_before_first_render,
              UX_TELEMETRY_LIMITS.MAX_UNDERRUNS,
            ),
            pauseToFirstSilentRenderMs: finiteDuration(
              message.pause_to_first_silent_render_ms,
            ),
            confirmToWorkletFlushMs: finiteDuration(
              message.confirm_to_worklet_flush_ms,
            ),
            browserRingDepthAtConfirmMs: finiteNonNegative(
              message.browser_ring_depth_at_confirm_ms,
              UX_TELEMETRY_LIMITS.MAX_RING_DEPTH_MS,
            ),
            browserRingDepthBeforeFlushMs: finiteNonNegative(
              message.browser_ring_depth_before_flush_ms,
              UX_TELEMETRY_LIMITS.MAX_RING_DEPTH_MS,
            ),
            browserRingDepthAfterFlushMs: finiteNonNegative(
              message.browser_ring_depth_after_flush_ms,
              UX_TELEMETRY_LIMITS.MAX_RING_DEPTH_MS,
            ),
          };
          if (Object.values(metrics).some((value) => value !== undefined)) {
            dispatch({
              type: "ux_telemetry",
              aiTurnId: Number(message.ai_turn_id),
              metrics,
            });
          }
        }
      } catch {
        // v1 has always ignored malformed or unknown text control frames.
      }
    });
  }

  onClose(callback: () => void): void {
    this.conn.on("close", callback);
  }

  waitForCloseRequest(): Promise<void> {
    return this.closeRequestPromise;
  }

  failConnectionTakeover(): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.closeRequestResolve();
    this.conn.close(1011, "connection takeover failed");
  }

  emit(event: MediaSessionOutputEvent): void {
    if (event.type === "audio" || event.type === "response_audio") {
      this.conn.send(event.pcm16k);
      return;
    }
    const frame = this.toV1Frame(event);
    if (frame) this.conn.send(JSON.stringify(frame));
  }

  close(event: MediaSessionCloseEvent): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    const frame =
      event.type === "session_ended"
        ? { type: "ended", reason: event.reason }
        : { type: "error", code: "superseded" };
    try {
      this.conn.send(JSON.stringify(frame));
    } finally {
      this.closeRequestResolve();
      if (event.type === "connection_superseded") {
        this.conn.close(1000, "superseded");
      } else {
        this.conn.close();
      }
    }
  }

  private toV1Frame(
    event: Exclude<
      MediaSessionOutputEvent,
      { type: "audio" } | { type: "response_audio" }
    >,
  ): object | null {
    switch (event.type) {
      case "playback_clear":
        return event.reason === "new_user_turn"
          ? { type: "playback_superseded", reason: "accepted_user_turn" }
          : null;
      case "interruption_confirmed":
        return {
          type: "barge_in",
          ...(event.aiTurnId !== undefined
            ? { ai_turn_id: event.aiTurnId }
            : {}),
          ...(event.pauseId !== undefined ? { pause_id: event.pauseId } : {}),
        };
      case "interruption_paused":
        return {
          type: "pause",
          ai_turn_id: event.aiTurnId,
          pause_id: event.pauseId,
        };
      case "interruption_resumed":
        return {
          type: "resume",
          ai_turn_id: event.aiTurnId,
          pause_id: event.pauseId,
        };
      case "turn_audio_started":
        return { type: "ai_audio_start", ai_turn_id: event.aiTurnId };
      case "turn_audio_ended":
        return { type: "ai_audio_end", ai_turn_id: event.aiTurnId };
      case "transcript_partial":
        return {
          type: "transcript_partial",
          speaker: event.speaker,
          text: event.text,
        };
      case "user_transcript_partial":
        return {
          type: "transcript_partial",
          speaker: "user",
          text: event.text,
        };
      case "transcript_final":
        return {
          type: "transcript",
          speaker: event.speaker,
          seq: event.seq,
          text: event.text,
        };
      case "user_transcript_final":
        return {
          type: "transcript",
          speaker: "user",
          seq: event.seq,
          text: event.text,
        };
      case "transcript_corrected":
        return {
          type: "transcript_corrected",
          speaker: event.speaker,
          seq: event.seq,
          text: event.text,
        };
      case "exam_incomplete":
        return { type: "exam_incomplete" };
      case "input_speech_started":
      case "input_committed":
      case "input_rejected":
      case "response_started":
      case "response_segment_declared":
      case "response_segment_completed":
      case "response_core_terminal":
      case "response_output_delivery_failed":
        return null;
    }
  }
}

function finiteNonNegative(value: unknown, max: number): number | undefined {
  return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= max
    ? value
    : undefined;
}

function finiteDuration(value: unknown): number | undefined {
  return finiteNonNegative(value, UX_TELEMETRY_LIMITS.MAX_DURATION_MS);
}

function finiteNonNegativeInteger(
  value: unknown,
  max: number,
): number | undefined {
  const number = finiteNonNegative(value, max);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}
