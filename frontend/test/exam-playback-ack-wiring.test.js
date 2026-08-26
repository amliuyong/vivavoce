// design contract Phase 2:Exam.tsx 播放 ACK 接线源码守门(Web Audio/WS 副作用 node --test 无法真跑,沿用源码守门)。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../src/views/Exam.tsx'), 'utf8');

test('059 Exam:auth 声明 playback_ack_v1 capability', () => {
  assert.ok(
    /capabilities:\s*\[PLAYBACK_ACK_CAPABILITY,\s*PLAYBACK_PAUSE_CAPABILITY\]/.test(src),
    'auth 帧须声明 playback_ack_v1(允许同时声明独立的 pause capability)',
  );
});

test('059 Exam:ready 帧按 capabilities 协商 tracker', () => {
  assert.ok(/ackTrackerRef\.current\?\.negotiate\(m\.capabilities\)/.test(src), 'ready 须调 negotiate(capabilities)');
});

test('059 Exam:ai_audio_start/end 下发 tracker;playback_superseded flush', () => {
  assert.ok(/m\.type === 'ai_audio_start'/.test(src), '须处理 ai_audio_start');
  assert.ok(/m\.type === 'ai_audio_end'/.test(src), '须处理 ai_audio_end');
  assert.ok(/onAudioStart\(m\.ai_turn_id\)/.test(src), 'ai_audio_start → onAudioStart');
  assert.ok(/onAudioEnd\(m\.ai_turn_id\)/.test(src), 'ai_audio_end → onAudioEnd');
  assert.ok(/m\.type === 'playback_superseded'/.test(src), '须处理 playback_superseded(R5 服务端权威清 ring)');
});

test('059 Exam:worklet turn_played/turn_aborted 路由到 tracker', () => {
  assert.ok(/d\.type === 'turn_played' \|\| d\.type === 'turn_aborted'/.test(src), 'worklet 回执须路由');
  assert.ok(/ackTrackerRef\.current\?\.onWorkletEvent/.test(src), '回执 → onWorkletEvent');
});

test('059 Exam:各停播点标 abort reason(barge_in/superseded/session_end/teardown)', () => {
  assert.ok(/flushWithReason\('barge_in'\)/.test(src), 'barge_in reason');
  assert.ok(/flushWithReason\('superseded'\)/.test(src), 'superseded reason');
  assert.ok(/flushWithReason\('session_end'\)/.test(src), 'session_end reason');
  assert.ok(/flushWithReason\('client_teardown'\)/.test(src), 'teardown reason');
});

test('059 Exam:drained 仍照发(与单轮 ACK 解耦,design contract 机制不删)', () => {
  assert.ok(/d\.type === 'drained'/.test(src) && /onPlaybackDrained\(\)/.test(src), 'drained 仍驱动 playbackActive/UI');
});
