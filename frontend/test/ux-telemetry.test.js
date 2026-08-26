const { test } = require('node:test');
const assert = require('node:assert');
const { UxTelemetryTracker } = require('../src/lib/ux-telemetry.ts');

function makeTracker() {
  let now = 0;
  const uplinks = [];
  const worklet = [];
  const tracker = new UxTelemetryTracker(
    (frame) => uplinks.push(frame),
    (message) => worklet.push(message),
    () => now,
  );
  return {
    tracker,
    uplinks,
    worklet,
    setTime: (value) => { now = value; },
  };
}

test('work item normal playback: marker, first binary, and first rendered are correlated once', () => {
  const h = makeTracker();
  h.setTime(1);
  h.tracker.onAudioStart(7);
  h.setTime(1.04);
  h.tracker.onFirstBinary();
  h.tracker.onFirstBinary();
  h.tracker.onWorkletEvent({
    type: 'telemetry_first_rendered',
    ai_turn_id: 7,
    render_context_time: 1.16,
    cold_preroll_ms: 120,
    underruns_before_first_render: 2,
  });
  h.tracker.onWorkletEvent({
    type: 'telemetry_first_rendered',
    ai_turn_id: 7,
    render_context_time: 1.2,
    underruns_before_first_render: 9,
  });

  assert.deepEqual(h.worklet, [{
    type: 'telemetry_begin_turn',
    ai_turn_id: 7,
    marker_context_time: 1,
  }]);
  assert.equal(h.uplinks.length, 2, 'duplicate binary/render events must not double count');
  assert.ok(Math.abs(h.uplinks[0].marker_to_first_binary_ms - 40) < 1e-9);
  assert.ok(Math.abs(h.uplinks[1].first_binary_to_first_render_ms - 120) < 1e-9);
  assert.ok(Math.abs(h.uplinks[1].marker_to_first_render_ms - 160) < 1e-9);
  assert.equal(h.uplinks[1].cold_preroll_ms, 120);
  assert.equal(h.uplinks[1].underruns_before_first_render, 2);
});

test('work item tentative pause/resume does not discard pending first-render telemetry', () => {
  const h = makeTracker();
  h.setTime(2);
  h.tracker.onAudioStart(8);
  h.setTime(2.01);
  h.tracker.onFirstBinary();

  // Pause/resume has no destructive tracker operation.
  h.setTime(2.5);
  h.tracker.onWorkletEvent({
    type: 'telemetry_first_rendered',
    ai_turn_id: 8,
    render_context_time: 2.5,
    underruns_before_first_render: 1,
  });
  assert.equal(h.uplinks.length, 2);
  assert.equal(h.uplinks[1].ai_turn_id, 8);
  assert.equal(h.uplinks[1].marker_to_first_render_ms, 500);
});

test('work item tentative pause reports the first silent render once in AudioContext time', () => {
  const h = makeTracker();
  h.setTime(3);
  h.tracker.onAudioStart(11);
  h.tracker.onWorkletEvent({
    type: 'telemetry_paused',
    ai_turn_id: 11,
    pause_id: 4,
    pause_context_time: 3.2,
    silent_context_time: 3.204,
  });
  h.tracker.onWorkletEvent({
    type: 'telemetry_paused',
    ai_turn_id: 11,
    pause_id: 4,
    pause_context_time: 3.2,
    silent_context_time: 3.5,
  });

  assert.equal(h.uplinks.length, 1);
  assert.equal(h.uplinks[0].ai_turn_id, 11);
  assert.ok(
    Math.abs(h.uplinks[0].pause_to_first_silent_render_ms - 4) < 1e-9,
  );
});

test('work item malformed or stale pause telemetry is ignored fail-soft', () => {
  const h = makeTracker();
  h.setTime(4);
  h.tracker.onAudioStart(12);
  for (const event of [
    {
      type: 'telemetry_paused',
      ai_turn_id: 11,
      pause_id: 1,
      pause_context_time: 4,
      silent_context_time: 4.01,
    },
    {
      type: 'telemetry_paused',
      ai_turn_id: 12,
      pause_id: -1,
      pause_context_time: 4,
      silent_context_time: 4.01,
    },
    {
      type: 'telemetry_paused',
      ai_turn_id: 12,
      pause_id: 1,
      pause_context_time: 4.1,
      silent_context_time: 4,
    },
  ]) {
    h.tracker.onWorkletEvent(event);
  }
  assert.equal(h.uplinks.length, 0);
});

test('work item confirmed barge-in reports one AudioContext-domain flush record', () => {
  const h = makeTracker();
  h.setTime(5);
  h.tracker.onAudioStart(9);
  h.setTime(5.1);
  const flush = h.tracker.confirmedFlushMessage();
  assert.deepEqual(flush, {
    type: 'flush',
    ai_turn_id: 9,
    confirm_context_time: 5.1,
  });
  assert.equal(h.tracker.confirmedFlushMessage(), undefined, 'duplicate confirmation is ignored');

  h.tracker.onWorkletEvent({
    type: 'telemetry_flushed',
    ai_turn_id: 9,
    flush_context_time: 5.13,
    browser_ring_depth_at_confirm_ms: 240,
    browser_ring_depth_before_flush_ms: 180,
    browser_ring_depth_after_flush_ms: 0,
  });
  h.tracker.onWorkletEvent({
    type: 'telemetry_flushed',
    ai_turn_id: 9,
    flush_context_time: 5.2,
    browser_ring_depth_at_confirm_ms: 1,
    browser_ring_depth_before_flush_ms: 1,
    browser_ring_depth_after_flush_ms: 0,
  });
  assert.equal(h.uplinks.length, 1);
  assert.ok(Math.abs(h.uplinks[0].confirm_to_worklet_flush_ms - 30) < 1e-9);
  assert.equal(h.uplinks[0].browser_ring_depth_at_confirm_ms, 240);
  assert.equal(h.uplinks[0].browser_ring_depth_before_flush_ms, 180);
  assert.equal(h.uplinks[0].browser_ring_depth_after_flush_ms, 0);
});

test('work item stale markers/events and disconnect cleanup cannot leak into a new connection', () => {
  const h = makeTracker();
  h.setTime(1);
  h.tracker.onAudioStart(10);
  h.tracker.onAudioStart(9);
  assert.equal(h.worklet.length, 1, 'older marker is stale');
  assert.equal(h.tracker.pendingCount(), 1);

  h.tracker.clear();
  assert.equal(h.tracker.pendingCount(), 0);
  h.tracker.onWorkletEvent({
    type: 'telemetry_first_rendered',
    ai_turn_id: 10,
    render_context_time: 2,
    underruns_before_first_render: 0,
  });
  assert.equal(h.uplinks.length, 0, 'late event after disconnect is ignored');
});
