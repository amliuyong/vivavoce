export type UxTelemetryFrame = {
  type: 'ux_telemetry';
  ai_turn_id: number;
  marker_to_first_binary_ms?: number;
  first_binary_to_first_render_ms?: number;
  marker_to_first_render_ms?: number;
  cold_preroll_ms?: number;
  underruns_before_first_render?: number;
  pause_to_first_silent_render_ms?: number;
  confirm_to_worklet_flush_ms?: number;
  browser_ring_depth_at_confirm_ms?: number;
  browser_ring_depth_before_flush_ms?: number;
  browser_ring_depth_after_flush_ms?: number;
};

export type WorkletTelemetryBegin = {
  type: 'telemetry_begin_turn';
  ai_turn_id: number;
  marker_context_time: number;
};

export type WorkletConfirmedFlush = {
  type: 'flush';
  ai_turn_id: number;
  confirm_context_time: number;
};

export type WorkletUxTelemetryEvent =
  | {
      type: 'telemetry_first_rendered';
      ai_turn_id: number;
      render_context_time: number;
      cold_preroll_ms?: number;
      underruns_before_first_render: number;
    }
  | {
      type: 'telemetry_paused';
      ai_turn_id: number;
      pause_id: number;
      pause_context_time: number;
      silent_context_time: number;
    }
  | {
      type: 'telemetry_flushed';
      ai_turn_id: number;
      flush_context_time: number;
      browser_ring_depth_at_confirm_ms?: number;
      browser_ring_depth_before_flush_ms: number;
      browser_ring_depth_after_flush_ms: number;
    };

type TurnState = {
  markerContextTime: number;
  firstBinaryContextTime?: number;
  firstRenderReported: boolean;
  pauseSilentReported: boolean;
  confirmContextTime?: number;
  flushReported: boolean;
};

const MAX_PENDING_TURNS = 32;

/**
 * Correlates browser receive/render/flush events without mixing wall clocks.
 * Every timestamp is an AudioContext time in seconds; only durations cross WS.
 */
export class UxTelemetryTracker {
  private readonly turns = new Map<number, TurnState>();
  private activeTurnId: number | undefined;
  private readonly sendUplink: (frame: UxTelemetryFrame) => void;
  private readonly postWorklet: (
    message: WorkletTelemetryBegin | WorkletConfirmedFlush,
  ) => void;
  private readonly contextTime: () => number;

  constructor(
    sendUplink: (frame: UxTelemetryFrame) => void,
    postWorklet: (
      message: WorkletTelemetryBegin | WorkletConfirmedFlush,
    ) => void,
    contextTime: () => number,
  ) {
    this.sendUplink = sendUplink;
    this.postWorklet = postWorklet;
    this.contextTime = contextTime;
  }

  onAudioStart(aiTurnId: number): void {
    if (!validTurnId(aiTurnId)) return;
    if (this.activeTurnId !== undefined && aiTurnId < this.activeTurnId) return;

    this.activeTurnId = aiTurnId;
    if (this.turns.has(aiTurnId)) return;

    const markerContextTime = finiteNonNegative(this.contextTime());
    if (markerContextTime === undefined) return;
    this.turns.set(aiTurnId, {
      markerContextTime,
      firstRenderReported: false,
      pauseSilentReported: false,
      flushReported: false,
    });
    this.postWorklet({
      type: 'telemetry_begin_turn',
      ai_turn_id: aiTurnId,
      marker_context_time: markerContextTime,
    });
    this.trim();
  }

  onFirstBinary(): void {
    const aiTurnId = this.activeTurnId;
    if (aiTurnId === undefined) return;
    const state = this.turns.get(aiTurnId);
    if (!state || state.firstBinaryContextTime !== undefined) return;

    const firstBinaryContextTime = finiteNonNegative(this.contextTime());
    if (firstBinaryContextTime === undefined) return;
    state.firstBinaryContextTime = firstBinaryContextTime;
    this.sendUplink({
      type: 'ux_telemetry',
      ai_turn_id: aiTurnId,
      marker_to_first_binary_ms: elapsedMs(
        state.markerContextTime,
        firstBinaryContextTime,
      ),
    });
  }

  confirmedFlushMessage(): WorkletConfirmedFlush | undefined {
    const aiTurnId = this.activeTurnId;
    if (aiTurnId === undefined) return undefined;
    const state = this.turns.get(aiTurnId);
    if (!state || state.confirmContextTime !== undefined) return undefined;

    const confirmContextTime = finiteNonNegative(this.contextTime());
    if (confirmContextTime === undefined) return undefined;
    state.confirmContextTime = confirmContextTime;
    return {
      type: 'flush',
      ai_turn_id: aiTurnId,
      confirm_context_time: confirmContextTime,
    };
  }

  onWorkletEvent(event: WorkletUxTelemetryEvent): void {
    if (!event || !validTurnId(event.ai_turn_id)) return;
    const state = this.turns.get(event.ai_turn_id);
    if (!state) return;

    if (event.type === 'telemetry_first_rendered') {
      if (state.firstRenderReported) return;
      const renderContextTime = finiteNonNegative(event.render_context_time);
      const firstBinaryContextTime = state.firstBinaryContextTime;
      if (
        renderContextTime === undefined ||
        firstBinaryContextTime === undefined
      ) {
        return;
      }
      state.firstRenderReported = true;
      this.sendUplink({
        type: 'ux_telemetry',
        ai_turn_id: event.ai_turn_id,
        first_binary_to_first_render_ms: elapsedMs(
          firstBinaryContextTime,
          renderContextTime,
        ),
        marker_to_first_render_ms: elapsedMs(
          state.markerContextTime,
          renderContextTime,
        ),
        ...(finiteNonNegative(event.cold_preroll_ms) !== undefined
          ? { cold_preroll_ms: event.cold_preroll_ms }
          : {}),
        underruns_before_first_render:
          finiteNonNegativeInteger(event.underruns_before_first_render) ?? 0,
      });
      return;
    }

    if (event.type === 'telemetry_paused') {
      if (state.pauseSilentReported || !validTurnId(event.pause_id)) return;
      const pauseContextTime = finiteNonNegative(event.pause_context_time);
      const silentContextTime = finiteNonNegative(event.silent_context_time);
      if (
        pauseContextTime === undefined ||
        silentContextTime === undefined ||
        silentContextTime < pauseContextTime
      ) {
        return;
      }
      state.pauseSilentReported = true;
      this.sendUplink({
        type: 'ux_telemetry',
        ai_turn_id: event.ai_turn_id,
        pause_to_first_silent_render_ms: elapsedMs(
          pauseContextTime,
          silentContextTime,
        ),
      });
      return;
    }

    if (state.flushReported || state.confirmContextTime === undefined) return;
    const flushContextTime = finiteNonNegative(event.flush_context_time);
    const depthAtConfirm = finiteNonNegative(
      event.browser_ring_depth_at_confirm_ms,
    );
    const depthBeforeFlush = finiteNonNegative(
      event.browser_ring_depth_before_flush_ms,
    );
    const depthAfterFlush = finiteNonNegative(
      event.browser_ring_depth_after_flush_ms,
    );
    if (
      flushContextTime === undefined ||
      depthBeforeFlush === undefined ||
      depthAfterFlush === undefined
    ) {
      return;
    }
    state.flushReported = true;
    this.sendUplink({
      type: 'ux_telemetry',
      ai_turn_id: event.ai_turn_id,
      confirm_to_worklet_flush_ms: elapsedMs(
        state.confirmContextTime,
        flushContextTime,
      ),
      ...(depthAtConfirm !== undefined
        ? { browser_ring_depth_at_confirm_ms: depthAtConfirm }
        : {}),
      browser_ring_depth_before_flush_ms: depthBeforeFlush,
      browser_ring_depth_after_flush_ms: depthAfterFlush,
    });
  }

  clear(): void {
    this.turns.clear();
    this.activeTurnId = undefined;
  }

  pendingCount(): number {
    return this.turns.size;
  }

  private trim(): void {
    while (this.turns.size > MAX_PENDING_TURNS) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
  }
}

function validTurnId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function finiteNonNegativeInteger(value: number | undefined): number | undefined {
  return finiteNonNegative(value) !== undefined && Number.isInteger(value)
    ? value
    : undefined;
}

function elapsedMs(start: number, end: number): number {
  return Math.max(0, (end - start) * 1000);
}
