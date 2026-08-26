#!/usr/bin/env node
/**
 * design contract —— 基准直接跑**生产实现** `PlaybackResampler`(而非手写克隆)。
 *
 * 为什么需要这一份:`tools/bench-playback-ring-push.mjs` 对照三种数据结构时跑的是手写克隆,
 * 第 2 轮 review 正确指出「基准测的不是生产代码」是个盲区 —— 手写克隆再快也不证明
 * 生产实现快。本脚本 import 真实的 `frontend/src/lib/playback-resampler.ts`。
 *
 * 负载与判据同 bench-playback-ring-push:40s 音频 / 4× 速下发(design contract 实测)/ 20ms 分片,
 * 音频线程单块预算 = 128 样本 @48k = 2667µs。
 *
 * 实测结果(deployment validation,改造后):**max=108µs / avg=2.2µs / 超预算 0 次**,末缓冲深度 29.3s。
 * 对照改造前(手写克隆 A 分支复刻现行实现):max=5761µs / 超预算 28 次。
 *
 * ⚠ 墙钟受机器/GC 波动,**不进 CI 硬门**(同 bench-playback-ring-push);结论看「超预算次数」
 *   与量级差。真机上的 deadline miss 须用 Chrome CDP `WebAudio.getRealtimeData` 的
 *   `renderCapacity` + callback interval 采集(design contract「根因终局验证」)。
 *
 * 跑法:node tools/bench-playback-production.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(here, '..', 'frontend', 'src', 'lib', 'playback-resampler.ts');
const { PlaybackResampler } = await import(modPath);

const SR_IN = 16000;
const HW_RATE = 48000;
const FRAME = 320; // 20ms @16k = bridge 单次下发分片
const QUANTUM = 128; // AudioWorklet render quantum
const QUANTUM_US = (QUANTUM / HW_RATE) * 1e6; // ≈ 2667µs
const AUDIO_SEC = 40;
const SPEED = 4; // 下发/播放速度比(design contract 实测 48s 音频 12s 下发完)

function pcm(n) {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(32767 * 0.3 * Math.sin((2 * Math.PI * 300 * i) / SR_IN));
  return a;
}

const r = new PlaybackResampler(HW_RATE);
const totalFrames = (AUDIO_SEC * SR_IN) / FRAME;
const pullPerFrame = Math.round((FRAME / SR_IN / SPEED) * HW_RATE);
const out = new Float32Array(QUANTUM);

let maxUs = 0;
let sumUs = 0;
let overBudget = 0;
for (let f = 0; f < totalFrames; f++) {
  const chunk = pcm(FRAME);
  const t0 = process.hrtime.bigint();
  r.push(chunk);
  const t1 = process.hrtime.bigint();
  const us = Number(t1 - t0) / 1000;
  maxUs = Math.max(maxUs, us);
  sumUs += us;
  if (us > QUANTUM_US) overBudget++;
  for (let k = 0; k < pullPerFrame; k += QUANTUM) r.pull(out);
}

console.log(`=== design contract 生产实现基准(${AUDIO_SEC}s 音频 / ${SPEED}× 下发 / 预算 ${QUANTUM_US.toFixed(0)}µs)===`);
console.log(
  `生产 PlaybackResampler.push: max=${maxUs.toFixed(0)}µs  avg=${(sumUs / totalFrames).toFixed(1)}µs  ` +
    `超预算=${overBudget} 次`,
);
console.log(`末缓冲深度(输出域可播样本) = ${r.available()} → ≈${(r.available() / HW_RATE).toFixed(1)}s`);
console.log(`\n对照改造前(现行实现,见 bench-playback-ring-push 的 A 分支):max≈5761µs / 超预算≈28 次`);
console.log(
  overBudget === 0
    ? `\n✅ 生产实现:0 次超预算(push 与缓冲深度解耦,design contract 达成)`
    : `\n❌ 生产实现仍有 ${overBudget} 次超预算 —— R1 未达成,须排查`,
);
