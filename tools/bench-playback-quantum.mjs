#!/usr/bin/env node
/**
 * design contract —— **完整 render quantum** 基准(实现review 的正解)。
 *
 * 为什么需要这一份:`bench-playback-production.mjs` 只计 `push()` 的耗时,而 review 正确指出
 * 「`pull()` / `shift()` / 溢出 / flush / FIR 都在计时区间之外,故其零超预算结论**不足以**
 * 证明音频线程安全」。本脚本改计**每个 quantum 的完整工作量**:
 *   一次 quantum = (可能到达的 push) + pull(128) —— 即 worklet 里 `onmessage` + `process()`
 *   在同一线程上的实际总开销;并单独统计**分片边界(shift 发生)**、**溢出**、**flush** 三类
 *   高成本 quantum 的峰值。
 *
 * 判据:单个 quantum 的总耗时 MUST 显著低于 render quantum 预算(128 样本 @48k = 2667µs)。
 *
 * ⚠ 墙钟受机器/GC 波动,不进 CI;真机 deadline miss 须用 Chrome CDP
 *   `WebAudio.getRealtimeData` 的 `renderCapacity` + callback interval 采集。
 *
 * 跑法:node tools/bench-playback-quantum.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { PlaybackResampler } = await import(path.join(here, '..', 'frontend', 'src', 'lib', 'playback-resampler.ts'));

const SR_IN = 16000;
const HW = 48000;
const FRAME = 320; // 20ms @16k
const QUANTUM = 128;
const QUANTUM_US = (QUANTUM / HW) * 1e6; // ≈ 2667µs
const AUDIO_SEC = 40;
const SPEED = 4;

function pcm(n) {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(32767 * 0.3 * Math.sin((2 * Math.PI * 300 * i) / SR_IN));
  return a;
}

function bench(label, { withOverflow = false, withFlush = false } = {}) {
  const r = new PlaybackResampler(HW);
  r.setEventSink(() => {});
  r.beginTurn(1);
  const out = new Float32Array(QUANTUM);
  // 每个 20ms 分片对应 4× 速下发 → 每 5ms 一帧;5ms 内播放消费 240 样本 ≈ 1.875 quantum
  const totalFrames = (AUDIO_SEC * SR_IN) / FRAME;
  const quantaPerFrame = 2; // 每帧到达后跑 2 个 quantum(≈ 匹配 4× 速)
  let maxUs = 0;
  let sumUs = 0;
  let count = 0;
  let over = 0;
  let maxShiftUs = 0; // 分片边界 quantum 的峰值
  let maxSpecialUs = 0; // 溢出/flush quantum 的峰值

  for (let f = 0; f < totalFrames; f++) {
    const chunk = pcm(FRAME);
    // ── 一个"含 push 的 quantum":onmessage(push)+ process(pull)在同一线程串行 ──
    const t0 = process.hrtime.bigint();
    r.push(chunk);
    r.pull(out);
    const t1 = process.hrtime.bigint();
    const us = Number(t1 - t0) / 1000;
    maxUs = Math.max(maxUs, us);
    maxShiftUs = Math.max(maxShiftUs, us); // push+pull 的 quantum 必然涉及队列增删
    sumUs += us;
    count++;
    if (us > QUANTUM_US) over++;

    // ── 纯 process 的 quantum ──
    for (let q = 1; q < quantaPerFrame; q++) {
      const s0 = process.hrtime.bigint();
      r.pull(out);
      const s1 = process.hrtime.bigint();
      const u = Number(s1 - s0) / 1000;
      maxUs = Math.max(maxUs, u);
      sumUs += u;
      count++;
      if (u > QUANTUM_US) over++;
    }

    // ── 高成本路径:溢出 / flush 也计时 ──
    if (withOverflow && f === Math.floor(totalFrames / 2)) {
      const s0 = process.hrtime.bigint();
      r.__forceOverflow(500000); // 大量丢弃(跨多分片)
      r.pull(out);
      const s1 = process.hrtime.bigint();
      const u = Number(s1 - s0) / 1000;
      maxSpecialUs = Math.max(maxSpecialUs, u);
      maxUs = Math.max(maxUs, u);
      if (u > QUANTUM_US) over++;
    }
    if (withFlush && f === Math.floor(totalFrames * 0.75)) {
      const s0 = process.hrtime.bigint();
      r.flushAll(); // 深队列下 flush(清全部分片)
      r.pull(out);
      const s1 = process.hrtime.bigint();
      const u = Number(s1 - s0) / 1000;
      maxSpecialUs = Math.max(maxSpecialUs, u);
      maxUs = Math.max(maxUs, u);
      if (u > QUANTUM_US) over++;
      r.beginTurn(2); // 解除 tombstone,继续
    }
  }
  return { label, maxUs, avgUs: sumUs / count, count, over, maxShiftUs, maxSpecialUs, depthS: r.available() / HW };
}

console.log(`=== design contract 完整 quantum 基准(${AUDIO_SEC}s / ${SPEED}× 下发)===`);
console.log(`一个 quantum = onmessage(push) + process(pull 128) 的**总**开销;预算 ${QUANTUM_US.toFixed(0)}µs\n`);

for (const cfg of [
  ['基线(push+pull+FIR+shift)', {}],
  ['含溢出(跨多分片丢弃)', { withOverflow: true }],
  ['含 flush(深队列清空)', { withFlush: true }],
  ['含溢出+flush', { withOverflow: true, withFlush: true }],
]) {
  const r = bench(cfg[0], cfg[1]);
  console.log(
    `${r.label.padEnd(30)} max=${r.maxUs.toFixed(0).padStart(5)}µs  avg=${r.avgUs.toFixed(1).padStart(5)}µs  ` +
      `超预算=${String(r.over).padStart(3)}/${r.count}  ` +
      (r.maxSpecialUs > 0 ? `特殊路径峰值=${r.maxSpecialUs.toFixed(0)}µs  ` : '') +
      `末深=${r.depthS.toFixed(1)}s`,
  );
}
console.log(
  `\n判读:所有配置的 quantum 总耗时 MUST 远低于 ${QUANTUM_US.toFixed(0)}µs 预算。` +
    `\n      改造前同负载下**仅 push 一项**峰值即 5761µs(28 次超预算),见 bench-playback-ring-push 的 A 分支。`,
);
