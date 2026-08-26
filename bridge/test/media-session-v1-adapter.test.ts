import {
  MediaSessionCommand,
  MediaSessionOutputEvent,
} from "../src/media-session-port";
import {
  V1MediaSessionTransport,
  WsConn,
} from "../src/media-session-v1-adapter";

class FakeConn implements WsConn {
  readonly sent: Array<string | Buffer> = [];
  closed = false;
  private message?: (data: Buffer, isBinary: boolean) => void;
  private closeHandler?: () => void;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  on(event: "message" | "close", callback: ((data: Buffer, isBinary: boolean) => void) | (() => void)): void {
    if (event === "message") {
      this.message = callback as (data: Buffer, isBinary: boolean) => void;
    } else {
      this.closeHandler = callback as () => void;
    }
  }

  receive(data: Buffer, isBinary: boolean): void {
    this.message?.(data, isBinary);
  }

  disconnect(): void {
    this.closeHandler?.();
  }
}

describe("V1MediaSessionTransport", () => {
  it("translates v1 wire input into protocol-neutral commands", () => {
    const conn = new FakeConn();
    const transport = new V1MediaSessionTransport(conn);
    const commands: MediaSessionCommand[] = [];
    let closed = false;
    transport.onCommand((command) => commands.push(command));
    transport.onClose(() => {
      closed = true;
    });

    conn.receive(Buffer.from([1, 2, 3, 4]), true);
    conn.receive(Buffer.from(JSON.stringify({ type: "end" })), false);
    conn.receive(Buffer.from(JSON.stringify({ type: "barge_in" })), false);
    conn.receive(
      Buffer.from(
        JSON.stringify({ type: "playback_complete", ai_turn_id: 7, reason: "played" }),
      ),
      false,
    );
    conn.disconnect();

    expect(commands).toEqual([
      { type: "input_audio", pcm16k: Buffer.from([1, 2, 3, 4]) },
      { type: "request_end" },
      { type: "interrupt" },
      { type: "playback_complete", aiTurnId: 7, reason: "played" },
    ]);
    expect(closed).toBe(true);
  });

  it("preserves every existing v1 output frame byte-for-byte", () => {
    const conn = new FakeConn();
    const transport = new V1MediaSessionTransport(conn);
    const events: MediaSessionOutputEvent[] = [
      { type: "audio", pcm16k: Buffer.from([5, 6, 7, 8]) },
      { type: "playback_clear", reason: "new_user_turn" },
      { type: "interruption_confirmed", aiTurnId: 8, pauseId: 3 },
      { type: "interruption_paused", aiTurnId: 8, pauseId: 3 },
      { type: "interruption_resumed", aiTurnId: 8, pauseId: 3 },
      { type: "turn_audio_started", aiTurnId: 8 },
      { type: "turn_audio_ended", aiTurnId: 8 },
      { type: "transcript_partial", speaker: "user", text: "partial" },
      { type: "transcript_final", speaker: "user", seq: 9, text: "final" },
      { type: "transcript_corrected", speaker: "user", seq: 9, text: "fixed" },
      { type: "exam_incomplete" },
    ];
    events.forEach((event) => transport.emit(event));
    transport.close({ type: "session_ended", reason: "session_end" });

    expect(conn.sent[0]).toEqual(Buffer.from([5, 6, 7, 8]));
    expect(conn.sent.slice(1).map(String)).toEqual([
      '{"type":"playback_superseded","reason":"accepted_user_turn"}',
      '{"type":"barge_in","ai_turn_id":8,"pause_id":3}',
      '{"type":"pause","ai_turn_id":8,"pause_id":3}',
      '{"type":"resume","ai_turn_id":8,"pause_id":3}',
      '{"type":"ai_audio_start","ai_turn_id":8}',
      '{"type":"ai_audio_end","ai_turn_id":8}',
      '{"type":"transcript_partial","speaker":"user","text":"partial"}',
      '{"type":"transcript","speaker":"user","seq":9,"text":"final"}',
      '{"type":"transcript_corrected","speaker":"user","seq":9,"text":"fixed"}',
      '{"type":"exam_incomplete"}',
      '{"type":"ended","reason":"session_end"}',
    ]);
    expect(conn.closed).toBe(true);
  });

  it("parses valid UX telemetry fields and drops malformed values", () => {
    const conn = new FakeConn();
    const transport = new V1MediaSessionTransport(conn);
    const commands: MediaSessionCommand[] = [];
    transport.onCommand((command) => commands.push(command));

    conn.receive(
      Buffer.from(JSON.stringify({
        type: "ux_telemetry",
        ai_turn_id: 7,
        marker_to_first_binary_ms: 12.5,
        first_binary_to_first_render_ms: 1e20,
        marker_to_first_render_ms: -1,
        cold_preroll_ms: "30",
        underruns_before_first_render: 2.5,
        pause_to_first_silent_render_ms: 2.7,
        confirm_to_worklet_flush_ms: 8,
        browser_ring_depth_at_confirm_ms: 120,
        browser_ring_depth_before_flush_ms: 80,
        browser_ring_depth_after_flush_ms: 0,
      })),
      false,
    );

    expect(commands).toEqual([{
      type: "ux_telemetry",
      aiTurnId: 7,
      metrics: {
        markerToFirstBinaryMs: 12.5,
        firstBinaryToFirstRenderMs: undefined,
        markerToFirstRenderMs: undefined,
        coldPrerollMs: undefined,
        underrunsBeforeFirstRender: undefined,
        pauseToFirstSilentRenderMs: 2.7,
        confirmToWorkletFlushMs: 8,
        browserRingDepthAtConfirmMs: 120,
        browserRingDepthBeforeFlushMs: 80,
        browserRingDepthAfterFlushMs: 0,
      },
    }]);
  });

  it("ignores stale/malformed UX telemetry without throwing", () => {
    const conn = new FakeConn();
    const transport = new V1MediaSessionTransport(conn);
    const commands: MediaSessionCommand[] = [];
    transport.onCommand((command) => commands.push(command));

    expect(() => conn.receive(Buffer.from("{broken"), false)).not.toThrow();
    conn.receive(
      Buffer.from(JSON.stringify({
        type: "ux_telemetry",
        ai_turn_id: -1,
        marker_to_first_binary_ms: 10,
      })),
      false,
    );
    conn.receive(
      Buffer.from(JSON.stringify({
        type: "ux_telemetry",
        ai_turn_id: Number.MAX_SAFE_INTEGER + 1,
        marker_to_first_binary_ms: 10,
      })),
      false,
    );
    conn.receive(
      Buffer.from(JSON.stringify({
        type: "ux_telemetry",
        ai_turn_id: 8,
        marker_to_first_binary_ms: "10",
        underruns_before_first_render: -1,
      })),
      false,
    );

    expect(commands).toHaveLength(0);
  });
});
