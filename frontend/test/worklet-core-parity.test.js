// design contract:**行为级**两份同步守门 —— 在 Node VM 里加载**真实的** public/pcm-playback-worklet.js,
// 与 core `PlaybackResampler` 按同一 trace 对拍输出与事件流。
//
// 为什么必须这样(第 2 轮 review):现有守门主要是**源码正则**(断言两份都含某常量),
// 但「绕回/溢出/flush 少更新一个索引」这类行为差异**正则测不出**;而基准脚本跑的是手写克隆、
// 不是生产 worklet。本文件消除这两个盲区。
//
// ★ 对拍契约(第 3 轮 review,已按其四条要求实现):
//   1. **只对拍两者都有的部分**:输出样本序列 + turn_played/turn_aborted 事件流;
//   2. **worklet 独有的 preroll / drained / 连续静默块计数排除在对拍之外**(core 无对应物)——
//      且**仅"排除"不够**:worklet preroll 期输出静音且不消费,core 立即消费 → 状态会永久错位。
//      故本 harness **预热跨过 preroll**(先喂满 PREROLL_SAMPLES 再开始比对),并在每次 flush 后重做;
//   3. **固定 seed 生成合法 trace**(非纯随机:flush 后的合法差异会让随机 trace 必然分叉);
//   4. **每个采样率用全新 VM context**,且 Float32Array/ArrayBuffer **构造器统一 realm**
//      (跨 realm 的 instanceof 会失败 —— worklet 里有 `d instanceof Float32Array` 判据)。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PlaybackResampler } = require('../src/lib/playback-resampler.ts');

const WORKLET_PATH = path.join(__dirname, '..', 'public', 'pcm-playback-worklet.js');
const PREROLL_SAMPLES = 1920; // 与 worklet 常量同步(守门测试另有断言锁定该值)

/** 在独立 VM context 里加载真 worklet,返回一个可驱动的 processor 句柄。 */
function loadWorklet(sampleRate) {
  const src = fs.readFileSync(WORKLET_PATH, 'utf8');
  let registered = null;
  const posted = [];
  const sandbox = {
    sampleRate,
    currentTime: 0,
    // ★ 构造器统一 realm:把宿主的 TypedArray 注入 sandbox,使 worklet 内的 instanceof 与
    //   我们从测试侧传入的实例同源(否则 `d instanceof Float32Array` 永为 false → 载荷被忽略)。
    Float32Array,
    Int16Array,
    ArrayBuffer,
    Math,
    console,
    registerProcessor: (_name, cls) => {
      registered = cls;
    },
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          onmessage: null,
          postMessage: (m) => posted.push(m),
        };
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'pcm-playback-worklet.js' });
  assert.ok(registered, 'worklet MUST 调用 registerProcessor');
  const proc = new registered();
  return {
    proc,
    posted,
    send: (msg) => proc.port.onmessage({ data: msg }),
    setTime: (seconds) => { sandbox.currentTime = seconds; },
    /** 驱动一个 render quantum,返回输出块(副本)。 */
    render: (n = 128) => {
      const out = new Float32Array(n);
      proc.process([], [[out]]);
      sandbox.currentTime += n / sampleRate;
      return out;
    },
  };
}

/** 确定性 PCM(不用 Math.random:trace 必须可复算)。 */
function pcm16(n, phase = 0) {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(32767 * 0.3 * Math.sin((2 * Math.PI * 300 * (i + phase)) / 16000));
  return a;
}

/** 把 int16 转成 float32(与两份实现同款公式)——用于给 worklet 喂新格式载荷。 */
function toFloat(pcm) {
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    f[i] = v < 0 ? v / 32768 : v / 32767;
  }
  return f;
}

for (const rate of [44100, 48000, 96000]) {
  test(`worklet↔core 行为对拍 @${rate}Hz(输出逐样本一致)`, () => {
    const w = loadWorklet(rate); // 每个采样率全新 VM context
    const c = new PlaybackResampler(rate);

    // ── 预热跨过 preroll(契约 2):worklet 在攒够 PREROLL_SAMPLES 前输出静音且不消费 ──
    const warm = pcm16(PREROLL_SAMPLES, 0);
    w.send(toFloat(warm));
    c.push(warm);
    // worklet 此刻恰好达到 preroll 门;两侧从下一次 render 起状态对齐。

    let maxDiff = 0;
    let phase = PREROLL_SAMPLES;
    // 固定 trace:交替 push 与 render(契约 3)
    for (let step = 0; step < 40; step++) {
      if (step % 3 === 0) {
        const chunk = pcm16(320, phase);
        phase += 320;
        w.send(toFloat(chunk));
        c.push(chunk);
      }
      const ow = w.render(128);
      const oc = new Float32Array(128);
      c.pull(oc);
      for (let i = 0; i < 128; i++) maxDiff = Math.max(maxDiff, Math.abs(ow[i] - oc[i]));
    }
    assert.ok(maxDiff < 1e-6, `两份实现输出 MUST 逐样本一致(≤1e-6),实测 maxDiff=${maxDiff}`);
  });
}

test('worklet↔core 事件流对拍(turn_played;段账本语义一致)', () => {
  const w = loadWorklet(48000);
  const c = new PlaybackResampler(48000);
  const cEvents = [];
  c.setEventSink((e) => cEvents.push(e));

  // 预热跨 preroll
  const warm = pcm16(PREROLL_SAMPLES, 0);
  w.send(toFloat(warm));
  c.push(warm);

  w.send({ type: 'begin_turn', seq: 7 });
  c.beginTurn(7);
  const body = pcm16(3200, PREROLL_SAMPLES);
  w.send(toFloat(body));
  c.push(body);
  w.send({ type: 'end_turn', seq: 7 });
  c.endTurn(7);

  // 排空两侧
  for (let i = 0; i < 200; i++) {
    w.render(128);
    c.pull(new Float32Array(128));
  }

  const wPlayed = w.posted.filter((m) => m.type === 'turn_played' && m.seq === 7);
  const cPlayed = cEvents.filter((e) => e.type === 'turn_played' && e.seq === 7);
  assert.strictEqual(wPlayed.length, 1, `worklet MUST 发一次 turn_played,实得 ${wPlayed.length}`);
  assert.strictEqual(cPlayed.length, 1, `core MUST 发一次 turn_played,实得 ${cPlayed.length}`);
  assert.ok(
    Math.abs(wPlayed[0].positionMs - cPlayed[0].positionMs) < 1e-6,
    `positionMs MUST 一致:worklet ${wPlayed[0].positionMs} vs core ${cPlayed[0].positionMs}`
  );
});

test('worklet 对旧格式载荷(裸 int16 ArrayBuffer)fail-soft 兼容,不抛不静默丢弃', () => {
  // design contract:backend StaticFiles 不发 cache-control、worklet 无文件名指纹 →
  // 可能出现「旧 Exam.tsx + 新 worklet」。此时仍须能出声。
  const w = loadWorklet(48000);
  const pcm = pcm16(PREROLL_SAMPLES * 2, 0);
  assert.doesNotThrow(() => w.send(pcm.buffer), '旧格式载荷 MUST NOT 抛异常');
  let anyNonZero = false;
  for (let i = 0; i < 60; i++) {
    const o = w.render(128);
    for (let k = 0; k < o.length; k++) if (Math.abs(o[k]) > 1e-9) anyNonZero = true;
  }
  assert.ok(anyNonZero, '旧格式载荷 MUST 仍能出声(fail-soft 兼容,不是静默丢弃)');
});

test('worklet 对未预期载荷类型静默忽略(不抛、不污染播放)', () => {
  const w = loadWorklet(48000);
  assert.doesNotThrow(() => {
    w.send({ type: 'unknown_message_kind' });
    w.send(null);
    w.send(12345);
  }, '未预期载荷 MUST fail-soft 忽略');
  const o = w.render(128);
  for (let i = 0; i < o.length; i++) assert.strictEqual(o[i], 0, 'preroll 未满 → 应为静音,且未被污染');
});

test('work item worklet: valid pause freezes output and ring without terminal events', () => {
  const w = loadWorklet(48000);
  w.send({ type: 'control_begin_turn', seq: 41 });
  w.send(toFloat(pcm16(PREROLL_SAMPLES * 3, 0)));
  let beforePause = null;
  for (let i = 0; i < 8; i++) beforePause = w.render();

  const queuedBeforePause = w.proc._q.size();
  assert.ok(queuedBeforePause > 0, 'pause 前必须仍有待播音频');
  w.send({
    type: 'pause_turn',
    seq: 41,
    pause_id: 1,
    pause_context_time: 1,
  });

  for (let quantum = 0; quantum < 4; quantum++) {
    const out = w.render();
    if (quantum === 0) {
      assert.ok(
        out.some((sample) => sample !== 0),
        '首个 quantum 应做有界淡出而非瞬时硬切零',
      );
      assert.ok(
        Math.abs(out[0] - beforePause[beforePause.length - 1]) < 1e-6,
        'pause 淡出必须从上个真实输出样本连续起步',
      );
    } else {
      assert.ok(
        out.every((sample) => sample === 0),
        `pause 淡出后第 ${quantum + 1} 个 render quantum 必须全静音`,
      );
    }
  }
  assert.equal(w.proc._q.size(), queuedBeforePause, 'pause 期间不得消费 ring');
  const pausedEvents = w.posted.filter(
    (message) => message.type === 'telemetry_paused',
  );
  assert.equal(pausedEvents.length, 1, '首个静音 render 只回执一次');
  assert.deepEqual(
    {
      ...pausedEvents[0],
      silent_context_time: undefined,
    },
    {
      type: 'telemetry_paused',
      ai_turn_id: 41,
      pause_id: 1,
      pause_context_time: 1,
      silent_context_time: undefined,
    },
  );
  assert.ok(
    Math.abs(pausedEvents[0].silent_context_time - 9 * 128 / 48000) < 1e-12,
    '首个静音 render 必须使用同一 AudioContext 时钟',
  );
  assert.equal(
    w.posted.filter((message) =>
      message.type === 'drained' ||
      message.type === 'turn_played' ||
      message.type === 'turn_aborted').length,
    0,
    'pause 不是 drain 或终态',
  );
});

test('work item worklet: malformed pause identity/time cannot freeze render', () => {
  const w = loadWorklet(48000);
  w.send({ type: 'control_begin_turn', seq: 44 });
  w.send(toFloat(pcm16(PREROLL_SAMPLES * 4, 0)));
  for (let i = 0; i < 8; i++) w.render();

  for (const frame of [
    { type: 'pause_turn', seq: 44, pause_context_time: 1 },
    { type: 'pause_turn', seq: 44, pause_id: 1 },
    { type: 'pause_turn', seq: 44, pause_id: 1, pause_context_time: Number.NaN },
    { type: 'pause_turn', seq: 43, pause_id: 1, pause_context_time: 1 },
  ]) {
    w.send(frame);
  }
  assert.ok(
    w.render().some((sample) => sample !== 0),
    '缺字段、脏时间或 stale turn 不得冻结播放',
  );
  assert.equal(
    w.posted.filter((message) => message.type === 'telemetry_paused').length,
    0,
  );
});

test('work item worklet: only matching resume continues from the exact frozen sample', () => {
  const paused = loadWorklet(48000);
  const baseline = loadWorklet(48000);
  for (const worklet of [paused, baseline]) {
    worklet.send({ type: 'control_begin_turn', seq: 42 });
    worklet.send(toFloat(pcm16(PREROLL_SAMPLES * 4, 0)));
    for (let i = 0; i < 8; i++) worklet.render();
  }

  paused.send({
    type: 'pause_turn',
    seq: 42,
    pause_id: 7,
    pause_context_time: 1,
  });
  for (let i = 0; i < 4; i++) paused.render();
  paused.send({ type: 'resume_turn', seq: 42, pause_id: 6 });
  assert.ok(
    paused.render().every((sample) => sample === 0),
    '错误 pause_id 的 resume 不得解冻',
  );

  paused.send({ type: 'resume_turn', seq: 42, pause_id: 7 });
  for (let quantum = 0; quantum < 12; quantum++) {
    const actual = paused.render();
    const expected = baseline.render();
    let maxDiff = 0;
    for (let i = 0; i < actual.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(actual[i] - expected[i]));
    }
    if (quantum === 0) {
      assert.ok(actual.some((sample) => sample !== 0), 'resume 首块必须开始淡入');
      assert.ok(
        Math.abs(actual[0]) <= Math.abs(expected[0]) + 1e-9,
        'resume 淡入首样本不得放大冻结点',
      );
    } else {
      assert.ok(
        maxDiff < 1e-6,
        `淡入后第 ${quantum + 1} 块必须与冻结点基线逐样本一致,maxDiff=${maxDiff}`,
      );
    }
  }
  assert.equal(
    paused.proc._q.size(),
    baseline.proc._q.size(),
    'pause/resume 只改输出增益,不得跳样或重样',
  );
});

test('work item worklet: duplicate and stale control frames are idempotent', () => {
  const w = loadWorklet(48000);
  w.send({ type: 'control_begin_turn', seq: 43 });
  w.send(toFloat(pcm16(PREROLL_SAMPLES * 4, 0)));
  for (let i = 0; i < 8; i++) w.render();

  w.send({ type: 'resume_turn', seq: 43, pause_id: 1 });
  w.send({ type: 'pause_turn', seq: 43, pause_id: 2, pause_context_time: 1 });
  w.send({ type: 'control_begin_turn', seq: 43 });
  w.render();
  assert.ok(
    w.render().every((sample) => sample === 0),
    '重复 control_begin_turn 不得解冻当前 pause',
  );
  w.send({ type: 'pause_turn', seq: 43, pause_id: 2, pause_context_time: 1 });
  w.send({ type: 'resume_turn', seq: 43, pause_id: 2 });
  w.send({ type: 'resume_turn', seq: 43, pause_id: 2 });
  assert.ok(w.render().some((sample) => sample !== 0), '匹配 resume 后应继续播放');

  w.send({ type: 'pause_turn', seq: 43, pause_id: 3, pause_context_time: 2 });
  w.send({ type: 'resume_turn', seq: 43, pause_id: 3 });
  w.send({ type: 'pause_turn', seq: 43, pause_id: 2, pause_context_time: 1 });
  assert.ok(
    w.render().some((sample) => sample !== 0),
    '旧 pause_id 迟到不得重新冻结已恢复的 turn',
  );

  w.send({ type: 'pause_turn', seq: 42, pause_id: 99, pause_context_time: 3 });
  assert.ok(
    w.render().some((sample) => sample !== 0),
    '旧 turn 的 pause 不得冻结当前 turn',
  );
});

for (const state of ['paused', 'resumed']) {
  test(`work item worklet: confirmed flush from ${state} aborts once and stale resume cannot revive`, () => {
    const w = loadWorklet(48000);
    w.send({ type: 'control_begin_turn', seq: 50 });
    w.send({ type: 'begin_turn', seq: 50 });
    w.send(toFloat(pcm16(PREROLL_SAMPLES * 4, 0)));
    for (let i = 0; i < 8; i++) w.render();
    w.send({ type: 'pause_turn', seq: 50, pause_id: 10, pause_context_time: 1 });
    if (state === 'resumed') {
      w.send({ type: 'resume_turn', seq: 50, pause_id: 10 });
      w.render();
    }

    w.send({ type: 'flush' });
    w.send({ type: 'flush' });
    assert.equal(
      w.posted.filter((message) => message.type === 'turn_aborted' && message.seq === 50).length,
      1,
      'confirmed flush 必须只结算一次 aborted',
    );
    assert.equal(w.proc._q.size(), 0);
    assert.equal(w.proc._pausedControl, null, 'flush 必须清冻结身份');

    w.send({ type: 'resume_turn', seq: 50, pause_id: 10 });
    w.send(toFloat(pcm16(PREROLL_SAMPLES * 2, 100)));
    assert.equal(w.proc._q.size(), 0, '旧轮 PCM 在 tombstone 下必须丢弃');
    assert.ok(w.render().every((sample) => sample === 0), '迟到 resume 不得复活旧音频');
  });
}

test('work item worklet: control end retires the turn identity', () => {
  const w = loadWorklet(48000);
  w.send({ type: 'control_begin_turn', seq: 60 });
  w.send(toFloat(pcm16(PREROLL_SAMPLES * 3, 0)));
  for (let i = 0; i < 8; i++) w.render();
  w.send({ type: 'control_end_turn', seq: 60 });
  w.send({ type: 'pause_turn', seq: 60, pause_id: 1, pause_context_time: 1 });
  assert.ok(
    w.render().some((sample) => sample !== 0),
    '已结束 turn 的迟到 pause 不得冻结播放',
  );
});

test('work item worklet: a new turn supersedes paused audio and stale resume cannot revive it', () => {
  const w = loadWorklet(48000);
  w.send({ type: 'control_begin_turn', seq: 60 });
  w.send({ type: 'begin_turn', seq: 60 });
  w.send(toFloat(pcm16(PREROLL_SAMPLES * 3, 0)));
  for (let i = 0; i < 8; i++) w.render();
  w.send({ type: 'pause_turn', seq: 60, pause_id: 1, pause_context_time: 1 });
  w.render();

  w.send({ type: 'flush' });
  w.send({ type: 'control_begin_turn', seq: 61 });
  w.send({ type: 'begin_turn', seq: 61 });
  w.send({ type: 'resume_turn', seq: 60, pause_id: 1 });
  w.send(toFloat(pcm16(PREROLL_SAMPLES * 3, 100)));

  assert.equal(w.proc._controlTurnId, 61);
  assert.equal(w.proc._pausedControl, null);
  assert.ok(
    Array.from({ length: 8 }, () => w.render()).some((out) =>
      out.some((sample) => sample !== 0)),
    '新轮音频应正常播放',
  );
  assert.equal(
    w.posted.filter((message) =>
      message.type === 'turn_aborted' && message.seq === 60).length,
    1,
    '旧轮只能结算一次 aborted',
  );
});

test('work item worklet: cold preroll first sample emits first_rendered exactly once', () => {
  const w = loadWorklet(48000);
  w.setTime(1);
  w.send({ type: 'telemetry_begin_turn', ai_turn_id: 21, marker_context_time: 0.99 });
  w.setTime(1.02);
  w.send(toFloat(pcm16(320, 0)));
  for (let i = 0; i < 5; i++) w.render();
  assert.equal(
    w.posted.filter((m) => m.type === 'telemetry_first_rendered').length,
    0,
    'receiving/queueing less than preroll is not a render event',
  );

  w.setTime(1.1);
  w.send(toFloat(pcm16(PREROLL_SAMPLES - 320, 320)));
  for (let i = 0; i < 10; i++) w.render();
  const rendered = w.posted.filter(
    (m) => m.type === 'telemetry_first_rendered' && m.ai_turn_id === 21,
  );
  assert.equal(rendered.length, 1);
  assert.ok(rendered[0].render_context_time >= 1.1);
  assert.ok(rendered[0].cold_preroll_ms >= 80);
  assert.equal(rendered[0].underruns_before_first_render, 0);
});

test('work item worklet: a pre-render underrun is counted by episode, not by quantum', () => {
  const w = loadWorklet(48000);
  w.send(toFloat(pcm16(PREROLL_SAMPLES, 0)));
  for (let i = 0; i < 100; i++) w.render();
  w.proc._q.clear();
  assert.equal(w.proc._everStarted, true);

  w.send({ type: 'telemetry_begin_turn', ai_turn_id: 22, marker_context_time: 1 });
  w.send(toFloat(pcm16(1, PREROLL_SAMPLES)));
  for (let i = 0; i < 4; i++) w.render();
  w.send(toFloat(pcm16(640, PREROLL_SAMPLES + 1)));
  for (let i = 0; i < 4; i++) w.render();

  const rendered = w.posted.filter(
    (m) => m.type === 'telemetry_first_rendered' && m.ai_turn_id === 22,
  );
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].underruns_before_first_render, 1);
  assert.equal(rendered[0].cold_preroll_ms, undefined, 'warm turn has no cold-preroll field');
});

test('work item worklet: confirmed flush separates confirm, pre-flush, and post-flush depth', () => {
  const w = loadWorklet(48000);
  w.setTime(3);
  w.send({ type: 'telemetry_begin_turn', ai_turn_id: 23, marker_context_time: 3 });
  w.send(toFloat(pcm16(PREROLL_SAMPLES * 2, 0)));
  w.render();
  const confirmContextTime = 3 + 128 / 48000;
  for (let i = 0; i < 5; i++) w.render();
  w.send({ type: 'flush', ai_turn_id: 23, confirm_context_time: confirmContextTime });
  w.send({ type: 'flush', ai_turn_id: 23, confirm_context_time: confirmContextTime });

  const flushed = w.posted.filter(
    (m) => m.type === 'telemetry_flushed' && m.ai_turn_id === 23,
  );
  assert.equal(flushed.length, 1);
  assert.ok(flushed[0].browser_ring_depth_at_confirm_ms > 0);
  assert.ok(
    flushed[0].browser_ring_depth_at_confirm_ms >
      flushed[0].browser_ring_depth_before_flush_ms,
    'samples rendered after confirmation must reduce the pre-flush depth',
  );
  assert.ok(flushed[0].browser_ring_depth_before_flush_ms > 0);
  assert.equal(flushed[0].browser_ring_depth_after_flush_ms, 0);

  const renderedBeforeFlush = w.posted.filter(
    (m) => m.type === 'telemetry_first_rendered' && m.ai_turn_id === 23,
  ).length;
  w.send(toFloat(pcm16(PREROLL_SAMPLES * 2, 0)));
  for (let i = 0; i < 20; i++) w.render();
  assert.equal(
    w.posted.filter((m) => m.type === 'telemetry_first_rendered' && m.ai_turn_id === 23).length,
    renderedBeforeFlush,
    'stale marker cannot fire after flush',
  );
});

test('work item worklet: adjacent turn markers crossed in one quantum each report once', () => {
  const w = loadWorklet(48000);
  w.send(toFloat(pcm16(PREROLL_SAMPLES, 0)));
  for (let i = 0; i < 100; i++) w.render();
  w.proc._q.clear();
  assert.equal(w.proc._everStarted, true);

  w.setTime(4);
  w.send({ type: 'telemetry_begin_turn', ai_turn_id: 30, marker_context_time: 4 });
  w.send(toFloat(pcm16(20, PREROLL_SAMPLES)));
  w.send({ type: 'telemetry_begin_turn', ai_turn_id: 31, marker_context_time: 4.001 });
  w.send(toFloat(pcm16(200, PREROLL_SAMPLES + 20)));
  w.render();
  w.render();

  const rendered = w.posted.filter((message) => message.type === 'telemetry_first_rendered');
  assert.deepEqual(rendered.map((message) => message.ai_turn_id), [30, 31]);
  assert.equal(rendered.filter((message) => message.ai_turn_id === 30).length, 1);
  assert.equal(rendered.filter((message) => message.ai_turn_id === 31).length, 1);
  assert.ok(rendered[1].render_context_time >= rendered[0].render_context_time);
});

test('两份实现的关键常量同步(源码级守门,断出处而非只禁命名)', () => {
  const src = fs.readFileSync(WORKLET_PATH, 'utf8');
  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'playback-resampler.ts'), 'utf8');
  for (const name of ['RING_MAX_SAMPLES', 'FADE_SAMPLES', 'ANTI_IMAGING_FC_HZ', 'ANTI_IMAGING_TAPS', 'EPS_SAMPLES', 'LEDGER_MAX']) {
    const re = new RegExp(`${name}\\s*=\\s*(\\d+)`);
    const mw = src.match(re);
    const mc = coreSrc.match(re);
    assert.ok(mw, `worklet MUST 定义 ${name}`);
    assert.ok(mc, `core MUST 定义 ${name}`);
    assert.strictEqual(mw[1], mc[1], `${name} 两份 MUST 相等:worklet=${mw[1]} core=${mc[1]}`);
  }
  // design contract:两份都必须是分片队列(禁止一侧退回全量拷贝)
  for (const [label, text] of [['worklet', src], ['core', coreSrc]]) {
    assert.ok(/class ChunkQueue/.test(text), `${label} MUST 含 ChunkQueue(分片队列)`);
    assert.ok(
      !/new Float32Array\(Math\.max\(0, keep\)/.test(text),
      `${label} MUST NOT 残留旧的「每 push 全量重建数组」写法(本 spec 根因)`
    );
  }
});
