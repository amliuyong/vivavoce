// design contract:Exam.tsx 音频能量旁挂(增量,行为零改)的源码守门。
//
// 音频旁挂是 Web Audio 副作用,原生 node --test 无法真起 AudioContext 断言拓扑,故用源码守门层锁死
// 评审收敛的阻断项(review + review):
//   - 播放侧双 connect 并联(禁串联),analyser 不接下游;
//   - 麦克风 analyser 旁挂 srcNode、不接下游(防回授);
//   - detectBargeIn 输入源仍是 worklet port(不改,红线);
//   - teardown disconnect 两个 analyser(无泄漏)。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../src/views/Exam.tsx'), 'utf8');

test('R2 播放侧:双 connect 并联(播放 worklet→destination + →playbackAnalyser),禁串联', () => {
  // design contract:播放路径从逐片 src 迁到播放 worklet 节点 pnode。pnode→destination 出声。
  assert.ok(/pnode\.connect\(ctx\.destination\)/.test(src), '必须保留 播放worklet→destination 出声路径');
  // 并联 tap:pnode→playbackAnalyser
  assert.ok(/pnode\.connect\(playbackAnalyserRef\.current\)/.test(src), '必须 播放worklet→playbackAnalyser 并联 tap');
  // 严禁串联:analyser 不得 connect 到 destination(引 FFT 窗时延)
  assert.ok(!/playbackAnalyser\w*\.connect\(ctx\.destination\)/.test(src), '禁止 analyser→destination 串联(引 FFT 窗时延)');
  assert.ok(!/micAnalyser\w*\.connect\(ctx\.destination\)/.test(src), 'micAnalyser 禁止接 destination(防回授)');
});

test('R2 麦克风侧:micAnalyser 旁挂 srcNode,不接下游(防回授)', () => {
  assert.ok(/srcNode\.connect\(ma\)/.test(src), '必须 srcNode→micAnalyser 旁挂');
  // ma 只被 connect(srcNode→ma),不主动 connect 其它节点
  assert.ok(!/\bma\.connect\(/.test(src), 'micAnalyser 不得 connect 任何下游节点');
});

test('R2 红线:detectBargeIn 输入源仍是 worklet port 的 PCM(未改从 analyser 读)', () => {
  // 打断检测入参来自 worklet node.port.onmessage 的 e.data,不是 analyser
  assert.ok(/detectBargeIn\(new Int16Array\(e\.data\)\)/.test(src), 'detectBargeIn 必须继续吃 worklet port 的 e.data');
  // detectBargeIn 内部不得引用 analyser(不换源)
  const fnStart = src.indexOf('function detectBargeIn');
  const fnEnd = src.indexOf('function ensureAudio');
  const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 2000);
  assert.ok(!/Analyser/.test(fnBody), 'detectBargeIn 内不得引用任何 analyser(打断检测与波形正交)');
});

test('R2 降级:analyser 建失败置 null(播放 worklet 建节点时 null→跳过 tap,不接波形不阻断播放)', () => {
  assert.ok(/playbackAnalyserRef\.current = null/.test(src), 'playbackAnalyser 建失败必须置 null');
  assert.ok(/micAnalyserRef\.current = null/.test(src), 'micAnalyser 建失败必须置 null');
  // design contract:tap 接线从 enqueuePcm 迁到 ensureAudio 建播放 worklet 时;null 时跳过 tap(波形降级,播放不受影响)。
  assert.ok(/if \(playbackAnalyserRef\.current\) \{[\s\S]{0,160}pnode\.connect\(playbackAnalyserRef\.current\)/.test(src), '播放 worklet 必须在 analyser 非 null 时才接 tap(null→波形降级)');
});

test('R2 清理:teardownAudio disconnect 两个 analyser + 置 null(无泄漏)', () => {
  assert.ok(/playbackAnalyserRef\.current\?\.disconnect\(\)/.test(src), 'teardown 必须 disconnect playbackAnalyser');
  assert.ok(/micAnalyserRef\.current\?\.disconnect\(\)/.test(src), 'teardown 必须 disconnect micAnalyser');
});

test('R2 打断红线未动:BARGE_ 阈值与 PLAY_SR 常量仍在(未被重构改动)', () => {
  // design contract:PLAY_LEAD 首帧提前量已移入播放 worklet 的 PREROLL_SAMPLES(逐片排程废除);其余打断红线不动。
  for (const k of ['BARGE_GUARD_MS', 'BARGE_CONFIRM_MS', 'BARGE_RMS_FLOOR', 'PLAY_SR']) {
    assert.ok(new RegExp(`const ${k} =`).test(src), `常量 ${k} 必须保留(不改打断红线)`);
  }
  // 播放 worklet 模块必须加载 + 建节点(替代逐片 createBufferSource)
  assert.ok(/addModule\('\/pcm-playback-worklet\.js'\)/.test(src), '必须加载播放 worklet 模块');
  assert.ok(/new AudioWorkletNode\(ctx, 'pcm-playback'/.test(src), '必须建 pcm-playback worklet 节点');
});

test('R3 波形 active 用 phase(live/ending)而非 aiSpeaking(review:用户说话波形须跟随)', () => {
  // waveActive 由 phase 决定:live/ending 期两路波形都 active(聆听态用户说话时绿波形真实起伏)
  assert.ok(/waveActive = phase === 'live' \|\| phase === 'ending'/.test(src), 'waveActive 必须由 phase 决定');
  assert.ok(/active=\{waveActive\}/.test(src), 'Waveform 必须传 active={waveActive}(不是 aiSpeaking)');
  assert.ok(!/active=\{aiSpeaking\}/.test(src), '不得再传 active={aiSpeaking}(会使聆听态用户波形不动)');
});

test('R3 getComputedStyle 读色:useLayoutEffect + 只读一次守卫(review)', () => {
  assert.ok(/colorReadRef/.test(src), '必须有只读一次守卫 colorReadRef');
  assert.ok(/useLayoutEffect\(\(\) => \{[\s\S]{0,80}colorReadRef\.current/.test(src), '读色必须用 useLayoutEffect + 守卫');
  assert.ok(/if \(ai && user\)/.test(src), '只在 ai&&user 都读到时才更新(否则保留默认色,不锁死空值)');
});
