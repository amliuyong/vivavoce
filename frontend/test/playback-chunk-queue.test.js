// design contract:播放缓冲改分片队列(push 与缓冲深度解耦)+ 容量溢出污点记账 + 漂移断言。
//
// ★ 本文件按 TDD 先写(实现前会红),对应 design contract / 0.5a / 0.5e 的硬要求:
//   - 三轮双评审要求的「变异测试自证漂移断言有效」(review明确指出预验证脚本不在提交物里);
//   - 段级污点的 7 项边界(此前只在 tools/verify-taint-edges.mjs 验过,须落成正式 UT);
//   - push 与深度解耦的**可数指标**断言(墙钟留给 tools/bench-*.mjs,不进 CI)。
//
// 与既有 playback-resampler.test.js 的分工:那份锁 design contract 的既有行为(相位/fade/FIR/等价性),
// 本份锁 design contract 新增的数据结构与记账语义。两份都必须绿。
const { test } = require('node:test');
const assert = require('node:assert');
const { PlaybackResampler } = require('../src/lib/playback-resampler.ts');

const IN_RATE = 16000;

/** 造一段 16k int16 PCM(非零,便于区分静音)。 */
function pcm16(n, amp = 0.3) {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(32767 * amp * Math.sin((2 * Math.PI * 300 * i) / IN_RATE));
  return a;
}

/** 把 resampler 拉空到指定输出样本数(模拟 process 每次 128 帧)。 */
function drain(r, outSamples) {
  let got = 0;
  while (got < outSamples) {
    const out = new Float32Array(128);
    const w = r.pull(out);
    got += w;
    if (w === 0) break; // underrun,无更多可播
  }
  return got;
}

/** 彻底排空(直到 available()===0)。用于「段应当自然完成」的用例 ——
 *  drain(r, N) 在 underrun 时会提前 break,若 N 估算偏小会导致段没播完、误判实现有 bug。 */
function drainAll(r, maxBlocks = 5000) {
  let guard = 0;
  while (r.available() > 0 && guard++ < maxBlocks) r.pull(new Float32Array(128));
  r.pull(new Float32Array(128)); // 末块:触发尾部完成判定
}

// ══════════════════════════════════════════════════════════════════
// R1 — push 与缓冲深度解耦(可数指标,非墙钟)
// ══════════════════════════════════════════════════════════════════

test('R1:push 只触碰本帧样本 —— 深队列与浅队列的触碰数相同', () => {
  // 该断言需要实现暴露一个可数指标(如 __touchedSamples 计数器,仅测试用)。
  // 若实现未提供,本测试应失败并提示 —— 这是 design contract 的可验证性要求。
  const shallow = new PlaybackResampler(48000);
  const deep = new PlaybackResampler(48000);

  shallow.push(pcm16(320)); // 浅:1 个分片
  // 深:堆 1500 个分片(30s @20ms),不消费
  for (let i = 0; i < 1500; i++) deep.push(pcm16(320));

  assert.ok(
    typeof shallow.__touchedSamples === 'number' && typeof deep.__touchedSamples === 'number',
    'PlaybackResampler MUST 暴露 __touchedSamples(仅测试用可数指标)以验证 push 的 O(帧长) 性质'
  );

  const before = deep.__touchedSamples;
  deep.push(pcm16(320));
  const deepTouched = deep.__touchedSamples - before;

  const before2 = shallow.__touchedSamples;
  shallow.push(pcm16(320));
  const shallowTouched = shallow.__touchedSamples - before2;

  assert.strictEqual(
    deepTouched,
    shallowTouched,
    `push 触碰样本数 MUST 与队列深度无关:深队列 ${deepTouched} vs 浅队列 ${shallowTouched}`
  );
  assert.strictEqual(deepTouched, 320, `push MUST 只触碰本帧 320 样本,实得 ${deepTouched}`);
});

test('R1:跨分片插值取下一分片首样本(边界无断点)', () => {
  const r = new PlaybackResampler(48000, 0, false); // 关 fade/FIR,纯相位
  // 两个分片:第一片末样本与第二片首样本在时间上相邻
  const c1 = new Int16Array([1000, 2000, 3000]);
  const c2 = new Int16Array([4000, 5000, 6000]);
  r.push(c1);
  r.push(c2);
  const out = new Float32Array(18);
  r.pull(out);
  // 相邻样本差应平滑(线性插值),不出现回跳或与自身插值造成的平台
  let maxJump = 0;
  for (let i = 1; i < 15; i++) maxJump = Math.max(maxJump, Math.abs(out[i] - out[i - 1]));
  // 1000→6000 跨 6 个输入样本、18 个输出样本,单步差应 ≈ (6000-1000)/32767/15
  assert.ok(maxJump < 0.02, `跨分片边界 MUST 无突跳,实测 maxJump=${maxJump}`);
});

test('R1:后继分片缺席时判 underrun,不访问 queue[1](不得抛)', () => {
  const r = new PlaybackResampler(48000);
  r.push(pcm16(3)); // 极短分片,读到末样本就没有后继了
  assert.doesNotThrow(() => {
    for (let i = 0; i < 10; i++) r.pull(new Float32Array(128));
  }, '后继分片缺席 MUST 判 underrun 并输出静音,MUST NOT 抛 TypeError');
});

test('R1:flush 同清读索引/相位/计数 —— 下一轮从新分片首样本起播', () => {
  const r = new PlaybackResampler(48000, 0, false);
  r.push(pcm16(320));
  drain(r, 300); // 消费一部分
  r.flush();
  const fresh = new Int16Array([20000, 20000, 20000, 20000]);
  r.push(fresh);
  const out = new Float32Array(4);
  r.pull(out);
  const expected = 20000 / 32767;
  assert.ok(
    Math.abs(out[0] - expected) < 1e-4,
    `flush 后 MUST 从新分片首样本起播(期望 ${expected},实得 ${out[0]})—— 漏清 readIdx/posFrac 会跳过头几样本`
  );
});

// ══════════════════════════════════════════════════════════════════
// R4 — queuedSamples 漂移断言 + 变异自证(review要求落成正式 UT)
// ══════════════════════════════════════════════════════════════════

test('R4:结构不变量 —— queuedSamples 与独立算出的实际未播量一致', () => {
  const r = new PlaybackResampler(48000);
  assert.ok(
    typeof r.__structuralDrift === 'function',
    'PlaybackResampler MUST 暴露 __structuralDrift()(结构不变量校验)以支撑 R4 漂移防线'
  );
  r.push(pcm16(320));
  r.push(pcm16(320));
  for (let i = 0; i < 20; i++) {
    r.pull(new Float32Array(128));
    assert.ok(r.__structuralDrift() < 1, `queuedSamples 漂移 ${r.__structuralDrift()} >= 1(第 ${i} 次 pull 后)`);
  }
});

test('R4:renderAbs 单调不回退(含溢出路径)', () => {
  const r = new PlaybackResampler(48000);
  r.beginTurn(1);
  let prev = -1;
  for (let k = 0; k < 30; k++) {
    r.push(pcm16(320));
    r.pull(new Float32Array(128));
    const cur = r.__renderAbsForTest();
    assert.ok(typeof cur === 'number', 'MUST 暴露 __renderAbsForTest() 供单调性断言');
    assert.ok(cur >= prev, `renderAbs MUST 单调:${prev} → ${cur}`);
    prev = cur;
  }
});

// ══════════════════════════════════════════════════════════════════
// R5 — 容量溢出污点记账(7 项边界,此前只在 tools/verify-taint-edges.mjs 验过)
// ══════════════════════════════════════════════════════════════════

test('R5:溢出丢弃的未播段 MUST 判 turn_aborted 而非 turn_played', () => {
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  r.beginTurn(1);
  r.push(pcm16(1000));
  r.endTurn(1); // 封口但一个样本没播
  assert.ok(typeof r.__forceOverflow === 'function', 'MUST 暴露 __forceOverflow(n) 以可测溢出路径(免造 300s 数据)');
  r.__forceOverflow(1000); // 丢弃全部
  r.pull(new Float32Array(128));
  const evs = r.takeEvents();
  const played = evs.filter((e) => e.type === 'turn_played' && e.seq === 1);
  const aborted = evs.filter((e) => e.type === 'turn_aborted' && e.seq === 1);
  assert.strictEqual(played.length, 0, '全被丢弃的段 MUST NOT 发 turn_played(这是现行实现的缺陷)');
  assert.strictEqual(aborted.length, 1, '全被丢弃的段 MUST 发一次 turn_aborted');
  assert.ok(Math.abs(aborted[0].positionMs) < 1e-6, `未播段 positionMs MUST 为 0,实得 ${aborted[0].positionMs}`);
});

test('R5:多次溢出叠加同一段 —— taintedSamples 累加不重复计', () => {
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  r.beginTurn(1);
  r.push(pcm16(1000));
  r.endTurn(1);
  r.__forceOverflow(300);
  r.__forceOverflow(200);
  drainAll(r); // 彻底播完剩余
  const evs = r.takeEvents().filter((e) => e.seq === 1);
  const ab = evs.find((e) => e.type === 'turn_aborted');
  assert.ok(ab, '经溢出的段 MUST 发 turn_aborted');
  const expectedMs = ((1000 - 500) / IN_RATE) * 1000;
  assert.ok(
    Math.abs(ab.positionMs - expectedMs) < 1e-6,
    `多次溢出 taintedSamples MUST 累加(期望 ${expectedMs}ms,实得 ${ab.positionMs}ms)`
  );
});

test('R5:未封口段(endAbs=null)也参与污点求交', () => {
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  r.beginTurn(1);
  r.push(pcm16(1000)); // 不 endTurn
  r.__forceOverflow(400);
  r.push(pcm16(200));
  r.endTurn(1);
  drainAll(r);
  const ab = r.takeEvents().find((e) => e.seq === 1 && e.type === 'turn_aborted');
  assert.ok(ab, '未封口期间被溢出的段,封口后 MUST 仍判 turn_aborted(污点须保留)');
});

test('R5:flushAll 打断 tainted 段 —— positionMs MUST 扣除污点(第3轮 review)', () => {
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  r.beginTurn(1);
  r.push(pcm16(1000));
  r.endTurn(1); // 封口但一个样本没播
  r.__forceOverflow(1000); // 全丢
  r.flushAll();
  const ab = r.takeEvents().find((e) => e.seq === 1 && e.type === 'turn_aborted');
  assert.ok(ab, 'flushAll MUST 为 open 段发 turn_aborted');
  assert.ok(
    Math.abs(ab.positionMs) < 1e-6,
    `全未播段被 flush MUST 报 0ms(不扣污点会报整段时长,实得 ${ab.positionMs}ms)`
  );
});

test('R5:flush 早于 check 且丢弃跨段边界 —— positionMs MUST 夹紧到 endAbs(第4轮 review)', () => {
  // 段 [0,1000) 已播约 800;丢弃区间跨过 endAbs → renderAbs 可超过 endAbs。
  // 不夹紧会把超出部分算作本段已播(实测高报 6.25ms)。
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  r.beginTurn(1);
  r.push(pcm16(1000));
  r.endTurn(1);
  drain(r, 2400); // 播约 800 输入样本(48k 下 2400 输出 ≈ 800 输入)
  r.push(pcm16(200)); // 再入 200,使丢弃区间可跨过 endAbs=1000
  r.__forceOverflow(300); // 丢 [~800, ~1100):与段 1 仅相交约 200
  r.flushAll();
  const ab = r.takeEvents().find((e) => e.seq === 1 && e.type === 'turn_aborted');
  assert.ok(ab, 'flushAll MUST 发 turn_aborted');
  const segLenMs = (1000 / IN_RATE) * 1000; // 段总时长 62.5ms
  assert.ok(
    ab.positionMs <= segLenMs + 1e-6,
    `positionMs MUST NOT 超过段总时长(夹紧到 endAbs);段长 ${segLenMs}ms,实得 ${ab.positionMs}ms`
  );
  // 且不得把跨段丢弃的那部分算进来:真实已播 ≈ 800 样本 = 50ms
  const expected = (800 / IN_RATE) * 1000;
  assert.ok(
    Math.abs(ab.positionMs - expected) < 2, // 容 ±2ms(drain 粒度)
    `期望 ≈${expected}ms(不夹紧会报 ≈56.25ms),实得 ${ab.positionMs}ms`
  );
});

test('R5:污点判定 MUST 只作用于 state==="open" 的段(review)', () => {
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  r.beginTurn(1);
  r.push(pcm16(320));
  r.endTurn(1);
  drain(r, 1000); // 段 1 自然播完 → 已发 turn_played 并出队
  const evs1 = r.takeEvents();
  assert.ok(
    evs1.some((e) => e.type === 'turn_played' && e.seq === 1),
    '正常播完的段 MUST 发 turn_played'
  );
  // 此后溢出不得再影响已终态的段 1
  r.beginTurn(2);
  r.push(pcm16(320));
  r.endTurn(2);
  r.__forceOverflow(100);
  drain(r, 1000);
  const evs2 = r.takeEvents();
  assert.strictEqual(
    evs2.filter((e) => e.seq === 1).length,
    0,
    '已终态的段 MUST NOT 因后续溢出再产生任何事件'
  );
});

test('R5:溢出后新段仍能正常完成(第2轮 review 的回归锁)', () => {
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  // 段 1 播完
  r.beginTurn(1);
  r.push(pcm16(1000));
  r.endTurn(1);
  drain(r, 3000);
  r.takeEvents();
  // 溢出丢弃一段
  r.push(pcm16(500));
  r.__forceOverflow(500);
  // 新段应能正常 turn_played —— 旧实现下 renderAbs 永久落后 dropped 会使其永不完成
  r.beginTurn(2);
  r.push(pcm16(800));
  r.endTurn(2);
  drain(r, 2500);
  const evs = r.takeEvents();
  assert.ok(
    evs.some((e) => e.type === 'turn_played' && e.seq === 2),
    '溢出之后的新段 MUST 能正常发 turn_played(坐标系不得因丢弃而永久偏移)'
  );
});

// ══════════════════════════════════════════════════════════════════
// R7 — 完成事件防伪造守卫(逐 (generation, seq) 状态机)
// ══════════════════════════════════════════════════════════════════

test('R7:同一段的终态事件至多一次', () => {
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  r.beginTurn(1);
  r.push(pcm16(320));
  r.endTurn(1);
  drain(r, 1000);
  // 再次 endTurn(迟到)不得产生第二个终态
  r.endTurn(1);
  drain(r, 500);
  const finals = r.takeEvents().filter((e) => e.seq === 1 && (e.type === 'turn_played' || e.type === 'turn_aborted'));
  assert.strictEqual(finals.length, 1, `终态事件 MUST 至多一次,实得 ${finals.length}`);
});

test('R7:未 beginTurn 先 endTurn(未开先终)MUST fail-soft 不发事件', () => {
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  assert.doesNotThrow(() => r.endTurn(99), '未知 seq 的 endTurn MUST fail-soft');
  r.push(pcm16(320));
  drain(r, 500);
  assert.strictEqual(
    r.takeEvents().filter((e) => e.seq === 99).length,
    0,
    '未开先终 MUST NOT 产生事件'
  );
});

test('R7:非 ACK 模式(未 beginTurn)全程惰性 —— 不产生任何轮事件', () => {
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  r.push(pcm16(3200));
  drain(r, 9000);
  const evs = r.takeEvents().filter((e) => e.type === 'turn_played' || e.type === 'turn_aborted');
  assert.strictEqual(evs.length, 0, '非 ACK 模式 MUST 与 design contract 行为等价(无轮事件)');
});

// ══════════════════════════════════════════════════════════════════
// R5 补充:**真实**溢出路径(非 __forceOverflow 测试钩子)—— 自审发现的覆盖缺口
// ══════════════════════════════════════════════════════════════════

test('R5:真实容量溢出(push 超 RING_MAX)—— 段判 turn_aborted 恰一次且 positionMs 扣污点', () => {
  // 走生产路径:连续 push 直到超过 RING_MAX_SAMPLES(4.8M = 16k×300s),不用测试钩子。
  const r = new PlaybackResampler(48000);
  const evs = [];
  r.setEventSink((e) => evs.push(e));
  r.beginTurn(1);
  const big = pcm16(500000);
  for (let i = 0; i < 11; i++) r.push(big); // 5.5M > 4.8M → 真实溢出(累计丢 700k)
  const droppedTotal = r.__renderAbsForTest(); // 未 pull 时 renderAbs 即累计丢弃量
  assert.ok(droppedTotal > 0, '真实溢出 MUST 发生(累计丢弃 > 0)');
  r.endTurn(1);
  // 4.8M 输入样本 @48k 需 14.4M 输出 = 112500 次 pull;给足余量彻底排空
  const out = new Float32Array(128);
  let guard = 0;
  while (r.available() > 0 && guard++ < 200000) r.pull(out);
  r.pull(out);

  const finals = evs.filter((e) => e.seq === 1 && (e.type === 'turn_played' || e.type === 'turn_aborted'));
  assert.strictEqual(finals.length, 1, `终态事件 MUST 恰一次,实得 ${finals.length}`);
  assert.strictEqual(finals[0].type, 'turn_aborted', '被溢出丢弃过的段 MUST 判 turn_aborted 而非 turn_played');
  const segLen = 11 * 500000;
  const expectedMs = ((segLen - droppedTotal) / IN_RATE) * 1000;
  assert.ok(
    Math.abs(finals[0].positionMs - expectedMs) < 1,
    `positionMs MUST 扣除全部污点(期望 ${expectedMs}ms,实得 ${finals[0].positionMs}ms)`
  );
});

test('R5:溢出告警用一次性闩(持续溢出不刷日志)', () => {
  const r = new PlaybackResampler(48000);
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(m);
  try {
    r.push(pcm16(320));
    r.__forceOverflow(100);
    r.__forceOverflow(100);
    r.__forceOverflow(100);
  } finally {
    console.warn = orig;
  }
  assert.strictEqual(warns.length, 1, `溢出告警 MUST 只打一次(一次性闩),实得 ${warns.length} 次`);
});

// ══════════════════════════════════════════════════════════════════
// R7 补充:零/单样本段不得发假 turn_played(实现review)
// ══════════════════════════════════════════════════════════════════

test('R7:零样本段(beginTurn 紧跟 endTurn)MUST NOT 发 turn_played', () => {
  // 既有缺陷在改造前实现中同样存在,与「不得多报已播」同类故一并修:
  // endAbs === startAbs → 完成判据 renderAbs >= endAbs-EPS 天然成立 → 旧实现发 turn_played,
  // 但一个样本都没渲染过。服务端据此推进考试游标 = 与溢出伪造完成同一类正确性缺陷。
  const r = new PlaybackResampler(48000);
  const evs = [];
  r.setEventSink((e) => evs.push(e));
  r.beginTurn(1);
  r.endTurn(1); // 一个样本都没 push
  r.push(pcm16(320)); // 后续别的音频驱动 pull
  drainAll(r);
  const played = evs.filter((e) => e.seq === 1 && e.type === 'turn_played');
  const aborted = evs.filter((e) => e.seq === 1 && e.type === 'turn_aborted');
  assert.strictEqual(played.length, 0, '零样本段 MUST NOT 发 turn_played(实际一声未出)');
  assert.strictEqual(aborted.length, 1, '零样本段 MUST 发 turn_aborted(等价 LiveKit 的 skipped)');
  assert.ok(Math.abs(aborted[0].positionMs) < 1e-9, `零样本段 positionMs MUST 为 0,实得 ${aborted[0].positionMs}`);
});

test('R7:单样本段(无法插值)MUST NOT 发 turn_played', () => {
  const r = new PlaybackResampler(48000);
  const evs = [];
  r.setEventSink((e) => evs.push(e));
  r.beginTurn(2);
  r.push(new Int16Array([12345])); // 单样本:线性插值需 idx+1,无后继 → 永不出声
  r.endTurn(2);
  r.push(pcm16(320));
  drainAll(r);
  const played = evs.filter((e) => e.seq === 2 && e.type === 'turn_played');
  assert.strictEqual(played.length, 0, '单样本段 MUST NOT 发 turn_played(无法插值、实际没出声)');
});

test('R7:正常段仍能发 turn_played(rendered 标记不误伤正常路径)', () => {
  const r = new PlaybackResampler(48000);
  const evs = [];
  r.setEventSink((e) => evs.push(e));
  r.beginTurn(3);
  r.push(pcm16(3200)); // 0.2s
  r.endTurn(3);
  drainAll(r);
  const played = evs.filter((e) => e.seq === 3 && e.type === 'turn_played');
  assert.strictEqual(played.length, 1, '正常播完的段 MUST 发 turn_played(变异保护:rendered 标记不得误伤)');
  const expectedMs = (3200 / IN_RATE) * 1000;
  assert.ok(Math.abs(played[0].positionMs - expectedMs) < 1e-6, `positionMs 期望 ${expectedMs},实得 ${played[0].positionMs}`);
});

// ══════════════════════════════════════════════════════════════════
// R7:非法迁移全覆盖(实现review 明确要求"不只测重复终态")
// ══════════════════════════════════════════════════════════════════

/** 播一个完整段并排空。 */
function playSeg(r, seq, samples = 3200) {
  r.beginTurn(seq);
  r.push(pcm16(samples));
  r.endTurn(seq);
  drainAll(r);
}

test('R7 非法迁移①:played → played 被拦(同 generation+seq 重开再播完)', () => {
  const r = new PlaybackResampler(48000);
  const evs = [];
  r.setEventSink((e) => evs.push(e));
  playSeg(r, 7);
  assert.strictEqual(evs.filter((e) => e.seq === 7).length, 1, '首次 MUST 发一次终态');
  playSeg(r, 7); // 同 key 重开(实测:无守卫时会再发一次 turn_played)
  assert.strictEqual(
    evs.filter((e) => e.seq === 7).length,
    1,
    `played→played MUST 被终态守卫拦下,实得 ${evs.filter((e) => e.seq === 7).length}`
  );
});

test('R7 非法迁移②:played → aborted 被拦(同 key 重开后被 flush)', () => {
  const r = new PlaybackResampler(48000);
  const evs = [];
  r.setEventSink((e) => evs.push(e));
  playSeg(r, 8);
  const genAfterPlay = evs.find((e) => e.seq === 8).generation;
  r.beginTurn(8); // 同 generation(playSeg 不含 flush)
  r.push(pcm16(3200));
  r.pull(new Float32Array(128));
  r.flushAll();
  const sameKey = evs.filter((e) => e.seq === 8 && e.generation === genAfterPlay);
  assert.strictEqual(sameKey.length, 1, `played→aborted MUST 被拦,同 key 实得 ${sameKey.length}`);
});

test('R7 非法迁移③:未 beginTurn 先 endTurn(未开先终)不产生事件', () => {
  const r = new PlaybackResampler(48000);
  const evs = [];
  r.setEventSink((e) => evs.push(e));
  r.endTurn(42);
  r.push(pcm16(3200));
  drainAll(r);
  assert.strictEqual(evs.filter((e) => e.seq === 42).length, 0, '未开先终 MUST NOT 产生事件');
});

test('R7:跨 generation 的同 seq 各自能发终态(守卫不误拦新代次)', () => {
  const r = new PlaybackResampler(48000);
  const evs = [];
  r.setEventSink((e) => evs.push(e));
  playSeg(r, 5); // generation 0
  r.flushAll(); // generation → 1
  playSeg(r, 5); // 同 seq、新 generation → MUST 允许
  const byGen = new Map();
  for (const e of evs.filter((x) => x.seq === 5)) byGen.set(e.generation, (byGen.get(e.generation) || 0) + 1);
  for (const [g, n] of byGen) assert.strictEqual(n, 1, `generation ${g} 的 seq=5 MUST 只有一个终态,实得 ${n}`);
  assert.ok(byGen.size >= 2, '不同 generation 的同 seq MUST 各自能发终态(跨代次隔离)');
});

test('R7:终态记录有界(FIFO 淘汰不吞当前轮,防长会话泄漏)', () => {
  const r = new PlaybackResampler(48000);
  r.setEventSink(() => {});
  for (let seq = 0; seq < 300; seq++) playSeg(r, seq, 320); // 300 > FINALIZED_MAX(256)
  const evs = r.takeEvents().filter((e) => e.type === 'turn_played' || e.type === 'turn_aborted');
  assert.ok(evs.length >= 250, `300 轮 MUST 各发终态(实得 ${evs.length});有界淘汰不应吞掉当前轮`);
});
