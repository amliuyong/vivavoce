// **新旧实现对拍** —— 分片队列 vs 改造前的线性数组实现,同 trace 逐样本一致。
//
// 为什么必须这样(实现review):`worklet-core-parity.test.js` 只比较**两份新实现**
// (core 与 worklet),它们是同一套逻辑手写两遍 —— **可能共享同一个回归而双双通过**。
// 唯一能证明「改造没改变听感」的，是拿改造前的实现当基准对拍。
//
// 基准 fixture:`test/fixtures/legacy-resampler.ts` 是改造前
// `src/lib/playback-resampler.ts` 的冻结副本。它**不再被生产引用**，仅作本测试的对照物。
// ⚠ 该 fixture MUST NOT 随生产实现一起演进 —— 它的价值就在于"冻结在改造前那一刻"。
//
// 覆盖 design contract 的两级:
//   R2a 纯相位等价(关 fade/FIR):锁重采样内核本身(相位推进/插值/跨分片衔接)未被改坏;
//   R2b 生产配置同 trace 对拍(fade+FIR 全开):含静音/语音/句间间隙/中途 underrun/恢复,
//       并按第 3 轮评审要求覆盖「分片边界落在 FIR 窗口内」。
// 允许偏离的路径(本文件刻意不对拍):容量溢出(新实现有污点记账)、
//   flush 后相位起点(等价但形态不同)。
const { test } = require('node:test');
const assert = require('node:assert');
const { PlaybackResampler: New } = require('../src/lib/playback-resampler.ts');
const { PlaybackResampler: Legacy } = require('./fixtures/legacy-resampler.ts');

const IN_RATE = 16000;

/** 确定性 PCM(不用随机:trace 必须可复算)。phase 让相继分片在时间上连续。 */
function pcm16(n, phase = 0, amp = 0.3) {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(32767 * amp * Math.sin((2 * Math.PI * 300 * (i + phase)) / IN_RATE));
  return a;
}

/** 造「静音 lead-in + 语音 + 尾静音」的句型(GPU 真机实测形态,design contract 探针)。 */
function sentence(leadInSilence, voiced, tailSilence, phase = 0) {
  const a = new Int16Array(leadInSilence + voiced + tailSilence);
  for (let i = 0; i < voiced; i++) {
    // 起振斜坡(模拟真实语音的平滑 onset)+ 谐波
    const env = Math.min(1, i / 240);
    a[leadInSilence + i] = Math.round(
      32767 * 0.35 * env * (Math.sin((2 * Math.PI * 220 * (i + phase)) / IN_RATE) + 0.3 * Math.sin((2 * Math.PI * 1900 * (i + phase)) / IN_RATE))
    );
  }
  return a;
}

/**
 * 用同一条 trace 驱动新旧两个实现,返回最大逐样本偏差。
 * trace 元素:{ push: Int16Array } 或 { pull: n }
 */
function runTrace(trace, mkNew, mkLegacy) {
  const a = mkNew();
  const b = mkLegacy();
  let maxDiff = 0;
  let compared = 0;
  for (const step of trace) {
    if (step.push) {
      a.push(step.push);
      b.push(step.push);
    } else {
      const oa = new Float32Array(step.pull);
      const ob = new Float32Array(step.pull);
      a.pull(oa);
      b.pull(ob);
      for (let i = 0; i < step.pull; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(oa[i] - ob[i]));
        compared++;
      }
    }
  }
  return { maxDiff, compared };
}

// ── R2a:纯相位等价(关 fade + 关 FIR)──

test('R2a:纯相位等价 —— 关 fade/FIR,新旧逐样本一致(≤1e-6)', () => {
  const trace = [];
  let phase = 0;
  for (let k = 0; k < 30; k++) {
    if (k % 2 === 0) {
      trace.push({ push: pcm16(320, phase) });
      phase += 320;
    }
    trace.push({ pull: 128 });
  }
  const { maxDiff, compared } = runTrace(
    trace,
    () => new New(48000, 0, false),
    () => new Legacy(48000, 0, false)
  );
  assert.ok(compared > 3000, `对拍样本数应充足,实得 ${compared}`);
  assert.ok(maxDiff < 1e-6, `R2a 纯相位 MUST 逐样本一致,实测 maxDiff=${maxDiff}`);
});

test('R2a:跨分片边界相位不漂移 —— 大量小分片 vs 少量大分片,各自与 legacy 一致', () => {
  // 小分片(20ms)交替 pull
  const t1 = [];
  let p = 0;
  for (let k = 0; k < 60; k++) {
    t1.push({ push: pcm16(320, p) });
    p += 320;
    t1.push({ pull: 128 });
  }
  const r1 = runTrace(t1, () => new New(48000, 0, false), () => new Legacy(48000, 0, false));
  assert.ok(r1.maxDiff < 1e-6, `小分片 trace MUST 一致,实测 ${r1.maxDiff}`);

  // 大分片(0.5s)少量 push
  const t2 = [];
  p = 0;
  for (let k = 0; k < 4; k++) {
    t2.push({ push: pcm16(8000, p) });
    p += 8000;
    for (let j = 0; j < 40; j++) t2.push({ pull: 128 });
  }
  const r2 = runTrace(t2, () => new New(48000, 0, false), () => new Legacy(48000, 0, false));
  assert.ok(r2.maxDiff < 1e-6, `大分片 trace MUST 一致,实测 ${r2.maxDiff}`);
});

// ── R2b:生产配置同 trace 对拍(fade + FIR 全开)──

test('R2b:生产配置同 trace 对拍 —— 静音/语音/句间间隙,逐样本一致(≤1e-6)', () => {
  const trace = [];
  let phase = 0;
  // 三个句型:[125ms 静音][语音][110ms 尾静音](GPU 真机实测形态)
  for (let s = 0; s < 3; s++) {
    trace.push({ push: sentence(2000, 24000, 1760, phase) });
    phase += 27760;
    // 每句后连续 pull 到大致排空(每 pull 128 输出 ≈ 42.7 输入样本)
    for (let k = 0; k < 700; k++) trace.push({ pull: 128 });
  }
  const { maxDiff, compared } = runTrace(trace, () => new New(48000), () => new Legacy(48000));
  assert.ok(compared > 200000, `对拍样本数应充足,实得 ${compared}`);
  assert.ok(maxDiff < 1e-6, `R2b 生产配置 MUST 逐样本一致(含 fade+FIR),实测 maxDiff=${maxDiff}`);
});

test('R2b:含中途 underrun 与恢复 —— fade 包络与 FIR 重置时机一致', () => {
  const trace = [];
  let phase = 0;
  // 第一段
  trace.push({ push: pcm16(4800, phase) });
  phase += 4800;
  for (let k = 0; k < 200; k++) trace.push({ pull: 128 }); // 拉过头 → 进入 underrun
  // 恢复:再来一段(第一次 underrun 后的 fade-in + FIR reprime 路径)
  trace.push({ push: pcm16(4800, phase) });
  phase += 4800;
  for (let k = 0; k < 200; k++) trace.push({ pull: 128 }); // 再次 underrun
  // 二次恢复
  trace.push({ push: pcm16(2400, phase) });
  for (let k = 0; k < 120; k++) trace.push({ pull: 128 });
  const { maxDiff } = runTrace(trace, () => new New(48000), () => new Legacy(48000));
  assert.ok(maxDiff < 1e-6, `underrun/恢复路径 MUST 一致(fade 包络 + FIR 重置时机),实测 ${maxDiff}`);
});

test('R2b:分片边界落在 FIR 窗口内(63 taps)—— 逐样本一致', () => {
  // FIR 63 taps:用远小于窗长的分片(如 16 样本 @16k → 48 输出样本)使边界密集落在窗内
  const trace = [];
  let phase = 0;
  for (let k = 0; k < 200; k++) {
    trace.push({ push: pcm16(16, phase) });
    phase += 16;
    if (k % 2 === 1) trace.push({ pull: 128 });
  }
  for (let k = 0; k < 100; k++) trace.push({ pull: 128 });
  const { maxDiff } = runTrace(trace, () => new New(48000), () => new Legacy(48000));
  assert.ok(maxDiff < 1e-6, `分片边界密集落在 FIR 窗内时 MUST 一致,实测 ${maxDiff}`);
});

test('R2b:多种硬件率(44.1k/48k/96k)均与 legacy 一致', () => {
  for (const rate of [44100, 48000, 96000]) {
    const trace = [];
    let phase = 0;
    for (let s = 0; s < 2; s++) {
      trace.push({ push: sentence(1600, 16000, 1600, phase) });
      phase += 19200;
      for (let k = 0; k < 450; k++) trace.push({ pull: 128 });
    }
    const { maxDiff } = runTrace(trace, () => new New(rate), () => new Legacy(rate));
    assert.ok(maxDiff < 1e-6, `@${rate}Hz MUST 与 legacy 一致,实测 maxDiff=${maxDiff}`);
  }
});

test('R2b:flush 后重新起播 —— 与 legacy 一致(允许偏离项之外的路径)', () => {
  const trace = [];
  let phase = 0;
  trace.push({ push: pcm16(3200, phase) });
  phase += 3200;
  for (let k = 0; k < 50; k++) trace.push({ pull: 128 });
  const a = new New(48000);
  const b = new Legacy(48000);
  for (const step of trace) {
    if (step.push) {
      a.push(step.push);
      b.push(step.push);
    } else {
      a.pull(new Float32Array(step.pull));
      b.pull(new Float32Array(step.pull));
    }
  }
  a.flush();
  b.flush();
  // flush 后喂新数据,对拍输出
  let maxDiff = 0;
  const fresh = pcm16(3200, 0);
  a.push(fresh);
  b.push(fresh);
  for (let k = 0; k < 100; k++) {
    const oa = new Float32Array(128);
    const ob = new Float32Array(128);
    a.pull(oa);
    b.pull(ob);
    for (let i = 0; i < 128; i++) maxDiff = Math.max(maxDiff, Math.abs(oa[i] - ob[i]));
  }
  assert.ok(maxDiff < 1e-6, `flush 后重新起播 MUST 与 legacy 一致,实测 ${maxDiff}`);
});

test('legacy fixture 是改造前的实现(冻结物,不得随生产演进)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-resampler.ts'), 'utf8');
  // 冻结特征:必须是**线性数组**实现(有 buf/pos 与全量重建 push),且**没有** ChunkQueue
  assert.ok(/private buf: Float32Array/.test(src), 'legacy fixture MUST 是线性数组实现(private buf)');
  assert.ok(/new Float32Array\(Math\.max\(0, keep\)/.test(src), 'legacy fixture MUST 含改造前的全量重建 push');
  assert.ok(!/class ChunkQueue/.test(src), 'legacy fixture MUST NOT 含 ChunkQueue(那是改造后的结构)');
  // 且必须含 design contract 的 fade 与 FIR(否则对拍不覆盖生产配置)
  assert.ok(/designLowpass/.test(src), 'legacy fixture MUST 含 design contract FIR');
  assert.ok(/fadeGain/.test(src), 'legacy fixture MUST 含 design contract fade');
});
