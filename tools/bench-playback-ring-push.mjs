#!/usr/bin/env node
/**
 * design contract 取证基准 —— 量化播放 worklet `_push` 在**音频渲染线程**上的耗时(现行 vs 真环形缓冲)。
 *
 * 为什么需要这个脚本(design contract 血教训:凭推断猜根因连错三轮):
 *   长句起句杂音的前三轮修复(064 降采样抗混叠 / 065 连续重采样 worklet / 068 抗 imaging FIR)全部未命中。
 *   deployment validation 用户实听二分定死缺陷侧:**服务端下发字节干净 + 原生 `<audio>` 播同一录音干净,
 *   唯独实时 WS + 自研 AudioWorklet 播放有杂音** → 缺陷在我们的 worklet 播放路径,且「16k→48k 重采样」
 *   本身无罪(浏览器原生播放也在做同样的重采样)。
 *   本脚本给出**根因的可复算数值**:`pcm-playback-worklet.js::_push` 每收一个 20ms 分片就
 *   `new Float32Array(keep+n)` + `merged.set(整个未播 ring)` = **O(ring 深度)** 拷贝 + 一次分配,
 *   而 `port.onmessage` 跑在**音频渲染线程**上,与 `process()` 抢同一预算。
 *
 * 负载取自真机一手事实(不是假设):
 *   - 下发比播放快约 4×(design contract 实测:48s 音频 12s 下发完)→ ring 深度随长回复单调堆积到 20~30s;
 *   - 下发粒度 20ms 分片(bridge `conn.send(pcm16)` 每帧 320 样本 @16k);
 *   - 音频线程预算 = 一个 render quantum = 128 样本 @48k = 2.67ms = 2670µs。
 *     `_push` 与 `process()` 共享这条线程:单次 push 逼近/超出 quantum 预算即渲染来不及填输出 = 咔哒。
 *
 * 跑法:node tools/bench-playback-ring-push.mjs
 * 输出:两种实现的 max/avg 耗时、超预算次数、分配次数。用于 design contract 的验收对照。
 */

const SR_IN = 16000;        // 下行 PCM 采样率(契约固定 16k)
const HW_RATE = 48000;      // 典型硬件率(AudioContext sampleRate)
const FRAME = 320;          // 20ms @16k = bridge 单次下发分片
const QUANTUM = 128;        // AudioWorklet render quantum(样本)
const QUANTUM_US = (QUANTUM / HW_RATE) * 1e6; // 音频线程单块预算 ≈ 2670µs
const RATIO = SR_IN / HW_RATE;
const AUDIO_SEC = 40;       // 一次长回复的音频时长(真机长回复量级)
const SPEED = 4;            // 下发/播放速度比(design contract 实测 ~4×)

/** A:现行实现 —— 每 push 重分配 + 全量拷贝未播 ring(复刻 pcm-playback-worklet.js::_push)。 */
function makeCurrent() {
  return {
    label: 'A 现行(每 push 全量拷贝)',
    buf: new Float32Array(0),
    pos: 0,
    allocs: 0,
    push(n) {
      const consumed = Math.floor(this.pos);
      const keep = this.buf.length - consumed;
      const merged = new Float32Array(Math.max(0, keep) + n); // ← 分配 + 下一行全量拷贝
      this.allocs++;
      if (keep > 0) merged.set(this.buf.subarray(consumed), 0);
      // 真实实现还要逐样本 int16→float 归一;此处只量拷贝成本(归一是 O(n) 与 ring 深度无关,两实现相同)
      this.buf = merged;
      this.pos -= consumed;
      if (this.pos < 0) this.pos = 0;
    },
    pull(k) {
      for (let i = 0; i < k; i++) {
        if (Math.floor(this.pos) + 1 >= this.buf.length) break;
        this.pos += RATIO;
      }
      const c = Math.floor(this.pos);
      if (c > 0 && c <= this.buf.length) {
        this.buf = this.buf.subarray(c);
        this.pos -= c;
      }
    },
    depthSamples() {
      return this.buf.length - Math.floor(this.pos);
    },
  };
}

/** B:真环形缓冲 —— 预分配固定容量,push 为 O(n) 写入(与 ring 深度无关),零分配,读写用绝对索引。
 *  ★ design contract 第 2 版:此方案**未被采纳**(与 C 性能等效但更复杂 + 恒占 18.9MiB),保留作对照。 */
function makeRing(capSamples) {
  return {
    label: 'B 预分配环形缓冲(未采纳)',
    ring: new Float32Array(capSamples),
    cap: capSamples,
    writeAbs: 0,   // 会话级绝对写位(单调,与 design contract 段账本坐标同构)
    readAbs: 0,    // 会话级绝对读位(整样本部分)
    posFrac: 0,    // 分数相位(跨块保留,守 design contract 连续相位不变量)
    allocs: 0,
    push(n) {
      for (let i = 0; i < n; i++) {
        this.ring[(this.writeAbs + i) % this.cap] = 0.1; // 真实实现在此做 int16→float 归一
      }
      this.writeAbs += n;
    },
    pull(k) {
      for (let i = 0; i < k; i++) {
        if (this.writeAbs - this.readAbs < 2) break; // 线性插值需 idx+1
        this.posFrac += RATIO;
        const adv = Math.floor(this.posFrac);
        if (adv > 0) {
          this.readAbs += adv;
          this.posFrac -= adv;
        }
      }
    },
    depthSamples() {
      return this.writeAbs - this.readAbs;
    },
  };
}

/** C:分片队列 —— 采用公开参考实现中的 AudioWorklet 分片队列方案。
 *  push = O(1) 入队,不碰既有数据;消费 = 队头读索引 + 分数相位,播完 `shift()` 弹出。
 *  真实实现中 PCM 由主线程 transferable 转移(`postMessage(msg,[buf])`),worklet 侧 push 纯 O(1) 零分配;
 *  本模拟为自造样本才有分配,判读请看「触碰既有样本数」与超预算次数。 */
function makeChunkQueue() {
  return {
    label: 'C 分片队列(采纳)',
    queue: [],
    readIdx: 0,
    posFrac: 0,
    queuedSamples: 0, // O(1) 维护(design contract:renderAbs 每块要读,不可遍历队列)
    allocs: 0,
    push(n) {
      const s = new Float32Array(n); // 模拟主线程转移来的分片(真实实现不在此分配)
      this.allocs++;
      for (let i = 0; i < n; i++) s[i] = 0.1;
      this.queue.push(s); // ← O(1),不触碰既有分片
      this.queuedSamples += n;
    },
    pull(k) {
      for (let i = 0; i < k; i++) {
        if (this.queuedSamples < 2) break; // 线性插值需 idx+1
        this.posFrac += RATIO;
        while (this.posFrac >= 1) {
          this.posFrac -= 1;
          this.readIdx += 1;
          this.queuedSamples -= 1;
        }
        while (this.queue.length > 0 && this.readIdx >= this.queue[0].length) {
          this.readIdx -= this.queue[0].length;
          this.queue.shift();
        }
      }
    },
    depthSamples() {
      return this.queuedSamples;
    },
  };
}

function run(impl) {
  const totalFrames = (AUDIO_SEC * SR_IN) / FRAME;
  // 每帧到达间隔 = 20ms / SPEED = 5ms;这 5ms 内播放消费 = 5ms × 48k = 240 输出样本
  const pullPerFrame = Math.round((FRAME / SR_IN / SPEED) * HW_RATE);
  let maxUs = 0;
  let sumUs = 0;
  let overBudget = 0;
  for (let f = 0; f < totalFrames; f++) {
    const t0 = process.hrtime.bigint();
    impl.push(FRAME);
    const t1 = process.hrtime.bigint();
    const us = Number(t1 - t0) / 1000;
    maxUs = Math.max(maxUs, us);
    sumUs += us;
    if (us > QUANTUM_US) overBudget++;
    impl.pull(pullPerFrame);
  }
  return {
    label: impl.label,
    maxUs,
    avgUs: sumUs / totalFrames,
    overBudget,
    allocs: impl.allocs,
    depthSec: impl.depthSamples() / SR_IN,
  };
}

console.log(`=== design contract 播放 ring push 成本对照 ===`);
console.log(`负载:${AUDIO_SEC}s 音频 / ${SPEED}× 速下发 / ${FRAME} 样本分片 / 硬件率 ${HW_RATE}Hz`);
console.log(`音频线程单块预算 = ${QUANTUM} 样本 @${HW_RATE}Hz = ${QUANTUM_US.toFixed(0)}µs\n`);

const a = run(makeCurrent());
const b = run(makeRing(SR_IN * 310)); // 与 RING_MAX_SAMPLES(16k×300s)同量级 + 余量
const c = run(makeChunkQueue());
for (const r of [a, b, c]) {
  console.log(
    `${r.label.padEnd(26)} max=${r.maxUs.toFixed(0).padStart(5)}µs  avg=${r.avgUs.toFixed(1).padStart(6)}µs  ` +
      `超预算=${String(r.overBudget).padStart(3)} 次  分配=${String(r.allocs).padStart(4)} 次  末缓冲深=${r.depthSec.toFixed(1)}s`,
  );
}
console.log(
  `\n改善(C 采纳方案 vs A 现行):max ${(a.maxUs / Math.max(c.maxUs, 0.001)).toFixed(0)}×  ` +
    `avg ${(a.avgUs / Math.max(c.avgUs, 0.001)).toFixed(0)}×  超预算 ${a.overBudget} → ${c.overBudget} 次`,
);
console.log(
  `\n判读:A 的单次 push 峰值 ${a.maxUs.toFixed(0)}µs ${a.maxUs > QUANTUM_US ? '**超出**' : '未超'} 音频线程 ` +
    `${QUANTUM_US.toFixed(0)}µs 预算 → 渲染来不及填输出 = 咔哒;且 ${a.allocs} 次分配在音频线程制造 GC 压力。`,
);
console.log(
  `\nB vs C:性能等效(均 0 次超预算),但 C 无绕回边界插值陷阱、内存按需` +
    `(B 恒占 ${(SR_IN * 310 * 4 / 1024 / 1024).toFixed(1)}MiB)→ **design contract 采纳 C**(设计决策)。`,
);
console.log(
  `注:绝对耗时随机器/GC 波动,**结论看量级差与超预算次数**(A 随缓冲深度线性劣化;B/C 与深度无关)。` +
    `\n    C 的分配数是本模拟自造样本所致;真实实现 PCM 由主线程 transferable 转移,worklet 侧 push 纯 O(1) 零分配。`,
);
