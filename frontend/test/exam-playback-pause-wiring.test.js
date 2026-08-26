const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'views', 'Exam.tsx'),
  'utf8',
);

test('work item Exam: auth advertises playback_pause_v1 with playback ACK', () => {
  assert.ok(
    /capabilities:\s*\[PLAYBACK_ACK_CAPABILITY,\s*PLAYBACK_PAUSE_CAPABILITY\]/.test(src),
    'auth 必须同时声明两个独立 capability',
  );
});

test('work item Exam: ready and audio boundaries drive the pause controller', () => {
  assert.ok(
    /pauseControllerRef\.current\?\.negotiate\(m\.capabilities\)/.test(src),
    'ready 必须协商 pause capability',
  );
  assert.ok(
    /pauseControllerRef\.current\?\.onAudioStart\(m\.ai_turn_id\)/.test(src),
    'ai_audio_start 必须建立 worklet 控制 turn',
  );
  assert.ok(
    /pauseControllerRef\.current\?\.onAudioEnd\(m\.ai_turn_id\)/.test(src),
    'ai_audio_end 必须退休 worklet 控制 turn',
  );
});

test('work item Exam: identity-bearing pause/resume frames reach the controller', () => {
  assert.ok(
    /pauseControllerRef\.current\?\.onPause\(m/.test(src),
    'pause 帧必须交给控制器校验身份',
  );
  assert.ok(
    /pauseControllerRef\.current\?\.onResume\(m/.test(src),
    'resume 帧必须交给控制器校验身份',
  );
  assert.ok(
    /pauseControllerRef\.current\?\.clear\(\)/.test(src),
    'flush/teardown 必须清暂停身份',
  );
});
