// design contract/R3:客户端 PlaybackAckTracker 单测(capability 协商 + 轮边界下发 + ACK 上行 + 去重 + reason 归属)。
const { test } = require('node:test');
const assert = require('node:assert');
const { PlaybackAckTracker, negotiatedAck, PLAYBACK_ACK_CAPABILITY } = require('../src/lib/playback-ack.ts');

function mk() {
  const uplinks = [];
  const worklet = [];
  const tr = new PlaybackAckTracker((f) => uplinks.push(f), (m) => worklet.push(m));
  return { tr, uplinks, worklet };
}

// ── negotiatedAck fail-soft ──
test('059 negotiate:仅 ready capabilities 含 playback_ack_v1 才启用;非数组/缺失→false', () => {
  assert.equal(negotiatedAck([PLAYBACK_ACK_CAPABILITY]), true);
  assert.equal(negotiatedAck(['other']), false);
  assert.equal(negotiatedAck([]), false);
  assert.equal(negotiatedAck(undefined), false);
  assert.equal(negotiatedAck(null), false);
  assert.equal(negotiatedAck('playback_ack_v1'), false); // 字符串非数组
});

// ── 未协商:完全 inert(逐字节等价现状)──
test('059 未协商:onAudioStart/End 不下发 worklet,worklet 事件不上行(inert)', () => {
  const { tr, uplinks, worklet } = mk();
  tr.negotiate(['nope']); // 未启用
  tr.onAudioStart(1);
  tr.onAudioEnd(1);
  tr.onWorkletEvent({ type: 'turn_played', generation: 0, seq: 1, positionMs: 500 });
  assert.equal(worklet.length, 0, '未协商不下发轮边界');
  assert.equal(uplinks.length, 0, '未协商不上行 ACK');
});

// ── 协商后:start/end 下发 worklet begin_turn/end_turn ──
test('059 协商后:ai_audio_start/end → worklet begin_turn/end_turn', () => {
  const { tr, worklet } = mk();
  assert.equal(tr.negotiate([PLAYBACK_ACK_CAPABILITY]), true);
  tr.onAudioStart(17);
  tr.onAudioEnd(17);
  assert.deepEqual(worklet, [{ type: 'begin_turn', seq: 17 }, { type: 'end_turn', seq: 17 }]);
});

// ── turn_played → playback_complete 上行 ──
test('059 turn_played → playback_complete 上行(一次)', () => {
  const { tr, uplinks } = mk();
  tr.negotiate([PLAYBACK_ACK_CAPABILITY]);
  tr.onWorkletEvent({ type: 'turn_played', generation: 0, seq: 17, positionMs: 800 });
  assert.deepEqual(uplinks, [{ type: 'playback_complete', ai_turn_id: 17 }]);
});

// ── turn_aborted → playback_aborted 带 pendingReason ──
test('059 turn_aborted → playback_aborted 带 flushWithReason 记录的 reason', () => {
  const { tr, uplinks } = mk();
  tr.negotiate([PLAYBACK_ACK_CAPABILITY]);
  tr.flushWithReason('superseded'); // 主线程停播前记原因
  tr.onWorkletEvent({ type: 'turn_aborted', generation: 1, seq: 20, positionMs: 300 });
  assert.deepEqual(uplinks, [{ type: 'playback_aborted', ai_turn_id: 20, reason: 'superseded' }]);
});

// ── 去重:同 (generation,seq) terminal 只上行一次 ──
test('059 去重:重复 turn_played 同 (generation,seq) 只上行一次', () => {
  const { tr, uplinks } = mk();
  tr.negotiate([PLAYBACK_ACK_CAPABILITY]);
  tr.onWorkletEvent({ type: 'turn_played', generation: 0, seq: 17, positionMs: 800 });
  tr.onWorkletEvent({ type: 'turn_played', generation: 0, seq: 17, positionMs: 800 });
  assert.equal(uplinks.length, 1, '重复终态不重复上行');
});

// ── 不同代次同 seq 各上行一次(flush 后 generation++,同 seq 数字可复用不冲突)──
test('059 代次隔离:不同 generation 同 seq 各上行一次', () => {
  const { tr, uplinks } = mk();
  tr.negotiate([PLAYBACK_ACK_CAPABILITY]);
  tr.onWorkletEvent({ type: 'turn_aborted', generation: 0, seq: 5, positionMs: 100 });
  tr.onWorkletEvent({ type: 'turn_played', generation: 1, seq: 5, positionMs: 400 });
  assert.equal(uplinks.length, 2, '不同代次同 seq 独立上行');
});

// ── reset:清去重表 + 复位 enabled(重连隔离)──
test('059 reset:清去重 + enabled 归 false(重连不受旧连接影响)', () => {
  const { tr, uplinks } = mk();
  tr.negotiate([PLAYBACK_ACK_CAPABILITY]);
  tr.onWorkletEvent({ type: 'turn_played', generation: 0, seq: 1, positionMs: 100 });
  tr.reset();
  assert.equal(tr.isEnabled(), false, 'reset 后未启用');
  // reset 后未重新 negotiate → inert
  tr.onWorkletEvent({ type: 'turn_played', generation: 0, seq: 1, positionMs: 100 });
  assert.equal(uplinks.length, 1, 'reset 后未协商不再上行');
});

// ── 非法 ai_turn_id fail-soft(负数/非整数不下发)──
test('059 fail-soft:非法 ai_turn_id 不下发 worklet', () => {
  const { tr, worklet } = mk();
  tr.negotiate([PLAYBACK_ACK_CAPABILITY]);
  tr.onAudioStart(-1);
  tr.onAudioStart(1.5);
  assert.equal(worklet.length, 0, '负数/非整数 id 不下发');
});
