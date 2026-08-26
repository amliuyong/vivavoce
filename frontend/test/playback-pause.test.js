const { test } = require('node:test');
const assert = require('node:assert');
const {
  PlaybackPauseController,
  PLAYBACK_PAUSE_CAPABILITY,
  negotiatedPause,
} = require('../src/lib/playback-pause.ts');

test('work item capability: only an echoed playback_pause_v1 enables control', () => {
  assert.equal(negotiatedPause([PLAYBACK_PAUSE_CAPABILITY]), true);
  assert.equal(negotiatedPause(['playback_ack_v1']), false);
  assert.equal(negotiatedPause(PLAYBACK_PAUSE_CAPABILITY), false);
  assert.equal(negotiatedPause(undefined), false);
});

test('work item controller: matching pause/resume is ordered and idempotent', () => {
  const posted = [];
  let contextTime = 1.25;
  const controller = new PlaybackPauseController(
    (message) => posted.push(message),
    () => contextTime,
  );
  controller.negotiate([PLAYBACK_PAUSE_CAPABILITY]);

  controller.onPause({ type: 'pause', ai_turn_id: 7, pause_id: 1 });
  controller.onResume({ type: 'resume', ai_turn_id: 7, pause_id: 1 });
  assert.deepEqual(posted, [], 'pause-before-audio/resume-before-pause 必须忽略');

  controller.onAudioStart(7);
  controller.onAudioStart(7);
  controller.onPause({ type: 'pause', ai_turn_id: 7, pause_id: 2 });
  controller.onPause({ type: 'pause', ai_turn_id: 7, pause_id: 2 });
  controller.onResume({ type: 'resume', ai_turn_id: 7, pause_id: 1 });
  contextTime = 1.5;
  controller.onResume({ type: 'resume', ai_turn_id: 7, pause_id: 2 });
  controller.onResume({ type: 'resume', ai_turn_id: 7, pause_id: 2 });

  assert.deepEqual(posted, [
    { type: 'control_begin_turn', seq: 7 },
    {
      type: 'pause_turn',
      seq: 7,
      pause_id: 2,
      pause_context_time: 1.25,
    },
    { type: 'resume_turn', seq: 7, pause_id: 2 },
  ]);
});

test('work item controller: stale turn and stale pause episode cannot affect playback', () => {
  const posted = [];
  const controller = new PlaybackPauseController(
    (message) => posted.push(message),
    () => 2,
  );
  controller.negotiate([PLAYBACK_PAUSE_CAPABILITY]);
  controller.onAudioStart(8);
  controller.onPause({ type: 'pause', ai_turn_id: 8, pause_id: 3 });
  controller.onResume({ type: 'resume', ai_turn_id: 8, pause_id: 3 });
  controller.onPause({ type: 'pause', ai_turn_id: 8, pause_id: 2 });
  controller.onAudioEnd(8);
  controller.onPause({ type: 'pause', ai_turn_id: 8, pause_id: 4 });
  controller.onAudioStart(9);
  controller.onPause({ type: 'pause', ai_turn_id: 8, pause_id: 5 });

  assert.deepEqual(posted, [
    { type: 'control_begin_turn', seq: 8 },
    { type: 'pause_turn', seq: 8, pause_id: 3, pause_context_time: 2 },
    { type: 'resume_turn', seq: 8, pause_id: 3 },
    { type: 'control_end_turn', seq: 8 },
    { type: 'control_begin_turn', seq: 9 },
  ]);
});

test('work item controller: malformed identity fields are ignored fail-soft', () => {
  const posted = [];
  const controller = new PlaybackPauseController(
    (message) => posted.push(message),
    () => 3,
  );
  controller.negotiate([PLAYBACK_PAUSE_CAPABILITY]);
  controller.onPause({ type: 'pause', pause_id: 1 });
  controller.onPause({ type: 'pause', ai_turn_id: Number.NaN, pause_id: 1 });
  controller.onAudioStart(10);
  controller.onResume({ type: 'resume', ai_turn_id: 10 });
  controller.onPause({ type: 'pause', ai_turn_id: 10, pause_id: Number.NaN });
  controller.onResume({ type: 'resume', ai_turn_id: 10, pause_id: -1 });
  assert.deepEqual(posted, [{ type: 'control_begin_turn', seq: 10 }]);
});

test('work item controller: disconnect reset rejects stale control and allows a fresh connection', () => {
  const posted = [];
  const controller = new PlaybackPauseController(
    (message) => posted.push(message),
    () => 4,
  );
  controller.negotiate([PLAYBACK_PAUSE_CAPABILITY]);
  controller.onAudioStart(1);
  controller.onPause({ type: 'pause', ai_turn_id: 1, pause_id: 1 });
  controller.reset();
  controller.onResume({ type: 'resume', ai_turn_id: 1, pause_id: 1 });

  controller.negotiate([PLAYBACK_PAUSE_CAPABILITY]);
  controller.onAudioStart(1);
  assert.deepEqual(posted, [
    { type: 'control_begin_turn', seq: 1 },
    { type: 'pause_turn', seq: 1, pause_id: 1, pause_context_time: 4 },
    { type: 'control_begin_turn', seq: 1 },
  ]);
});
