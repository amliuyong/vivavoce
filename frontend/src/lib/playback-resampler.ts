/**
 * 播放端连续重采样纯逻辑(design contract)—— 与 AudioWorklet/DOM 解耦,便于原生 node --test 直接单测
 * (本仓前端无 jsdom/jest,策略见 svg-face-core.ts / waveform-core.ts)。
 *
 * 为什么需要:下行 AI 语音是 **16k s16le**,但浏览器 AudioContext 硬件率几乎必是 44.1k/48k。
 * 旧实现(Exam.tsx::enqueuePcm)对**每个 20ms 分片**单独 `createBuffer(1,n,16000)` + 独立
 * `createBufferSource().start()` → 浏览器逐片独立重采样 + 调度浮点误差 → **分片边界 glitch**
 * (咔哒/毛刺,长文本分片多→杂音密。design contract 真机坐实此为杂音主因,非降采样)。
 *
 * 本类:把整通 AI 语音当**一条连续流**做 16k→硬件率**升采样**(线性插值),跨 `pull` 块保持分数读取
 * 相位(不逐块取整→不漂移),**没有逐片边界**。镜像采集侧 `pcm-worklet.js`(48k→16k 降采样)的
 * 跨块相位连续算法,方向相反。
 *
 * ★ design contract 抗 imaging(纠正 design contract「升采样不产生混叠故不需低通」的错误论断):**线性插值升采样确实
 *   产生 imaging(频谱镜像)** —— 16k 输入的频谱镜像在 `k·16000 ± f` 处不被抑制(数值实测:6kHz 输入 → 10kHz
 *   镜像达基频 39.6%)。语音辅音/起振宽带高频 → 强 imaging = 用户报的「每句起句杂音」;稳态元音低频 → 弱 imaging
 *   =「后面消失」。修:升采样**后**在输出(硬件率)域加抗 imaging **windowed-sinc FIR 低通**(fc≈7800,原始 16k
 *   Nyquist 略下),跨 `pull` 块保历史(与 design contract 降采样抗混叠同款机理)。默认开;`antiImaging=false` 关(供纯相位
 *   单测隔离,与 design contract 的 AIM_TTS_ANTIALIAS 同思路)。
 *
 * ring buffer:累积尚未输出的 16k 输入样本(float32,[-1,1])。`pull` 连续消费;欠载(ring 不足)
 * → 剩余输出静音(0),不 glitch,后续 push 续上相位连续。`flush` 立即清空(barge-in 即时停声)。
 *
 * ★ 本类有**两份实现**:此处(供 node --test 单测 `test/playback-resampler.test.js`)+ `public/pcm-playback-worklet.js`
 *   内联同款 push/pull/flush 逻辑(AudioWorklet 不能 import TS)。worklet 额外有 preroll(首次冷启动攒够再播)
 *   + drained 边沿回传(驱动 aiSpeaking)。**改此处核心算法务必同步改 worklet + 跑单测**(反之亦然)。
 */

const INPUT_RATE = 16000;
// ring 防御上限(16k×300s):**纯 OOM backstop**,正常长回复(几十秒~数分钟)绝不触发。
// ★ design contract(真机根因!):原值 20s 太小——下发远快于播放(design contract:48s音频12s下发完),长回复
//   ring 快速堆积深(前期积压 >20s),20s 上限在**正常长回复就频繁截断**、丢掉排队待播的后续句 =
//   "下一句冲掉上一句"(前期积压深最严重、后期排空变轻的渐变正是此)。截断丢的是**未播**内容,绝不可接受。
//   300s 远超任何真实回复(峰值内存 ~19MB@4.8M样本×4B,正常 40s 回复峰值仅 ~1.8MB),只在真病态
//   (标签页挂起累积数分钟)才作 OOM backstop。数值验证:40/90/180s 回复零截断零丢失。
const RING_MAX_SAMPLES = 4800000;
// design contract:underrun 边界淡出/淡入窗(输出域样本数)。长回复中段 ring 追空(跨境 TTS 还在生成)→
// 硬切到 0 = 咔哒;恢复从 0 跳回非零 = 又一咔哒。fade 消除波形突跳。~2.7ms @48k ≈ 128 样本
// (消 click 足够;太长则每次恢复出声要更久爬满、体感"渐入"明显)。
const FADE_SAMPLES = 128;
// design contract 抗 imaging FIR:截止频率(Hz,原始 16k 输入 Nyquist=8000 略下)+ 抽头数。
//   ★ review⑥ 调参(31taps/fc7800 过渡带太宽:44.1/48k 下 9kHz 镜像残留 13-15%、7kHz 齿音只保 75%)。
//   频响实测选 **fc=7500/63taps**:44.1/48k(真机硬件率)6kHz 保 100%、7kHz 保 82-83%、imaging(9k/10k)= 0%;
//   96k(罕见)6kHz 保 91%、9k 镜像残 9%(可接受,96k 本底镜像能量也低)。群延迟 (63-1)/2=31 样本≈0.65ms@48k
//   (纯延迟,播放无感)。成本 63 乘加/输出样本 @48k≈3M/s,AudioWorklet 音频线程可承受(scratch 复用零分配)。
const ANTI_IMAGING_FC_HZ = 7500;
const ANTI_IMAGING_TAPS = 63;
// design contract 契约订正 3:完成判据尾差容差(输入域 16k 样本)。线性插值需 idx+1,末样本 renderAbs
//   最多停在 endAbs-1(48k 下约 endAbs-0.667),EPS=1 恰好接住;不设 EPS 则末段完成条件永不成立。
const EPS_SAMPLES = 1;
// design contract:段账本硬上限(review 防泄漏;review:与 worklet LEDGER_MAX=64 同步,否则病态场景
//   ——引擎疯狂发 begin_turn 不封口——ledger 无界增长)。正常账本 ≤ 数个 open 段;超此丢最旧 open 段。
const LEDGER_MAX = 64;
// design contract:终态记录上限(FIFO 淘汰)。正常会话轮数远小于此;仅作防伪造守卫的有界记忆。
const FINALIZED_MAX = 256;

// design contract/R4:worklet/core 回传主线程的单轮播放事件(与 design contract 全局 `drained` 解耦,drained 只驱动
//   UI/playbackActive,不触发单轮 ACK)。generation 供主线程丢弃 flushAll 之前代次的迟到事件。
export type PlaybackEvent =
  | { type: 'turn_played'; generation: number; seq: number; positionMs: number }   // 某轮自然播完(越封口水位线)
  | { type: 'turn_aborted'; generation: number; seq: number; positionMs: number }; // 某轮被 flushAll 打断(带截断 position)

// design contract:段账本条目。startAbs/endAbs 均**会话级绝对输入域 16k 样本位**(不随 ring 回收/flush 漂移)。
interface Seg {
  generation: number;        // beginTurn 时的代次(flushAll 后 +1);跨代次条目被 flushAll 清除
  seq: number;               // = 引擎 turnSeq(轮级单调),非句级
  startAbs: number;          // beginTurn 记 writeAbs(该轮音频起点绝对位)
  endAbs: number | null;     // endTurn(轮封口=onAiDone)记 writeAbs;未封口为 null
  state: 'open' | 'complete' | 'aborted';
  // ── design contract:容量溢出的段级污点 ──
  // 「丢弃的样本没被听到」由污点表达,**不由坐标偏移表达**(坐标偏移会致新段永不完成,
  //   见 renderAbs() 注释里的 Blocker 1)。tainted 段完成时降级发 turn_aborted。
  tainted: boolean;          // 是否与某次溢出的丢弃区间相交
  taintedSamples: number;    // 累计被丢弃的本段样本数(多次溢出累加)
  // ★ design contract(实现review):本段是否**真的渲染过至少一个样本**。
  //   零样本段(beginTurn 紧跟 endAbs=startAbs)与单样本段(无法插值)会让完成判据
  //   `renderAbs >= endAbs - EPS` 天然成立 → 发出 turn_played 而实际一声未出。
  //   **既有缺陷**在改造前实现中同样存在,但与「不得多报已播」完全同类,故一并修。
  rendered: boolean;
}

/** 设计 windowed-sinc(Hamming 窗)低通 FIR,归一化到 DC 增益 1。fc/sr 单位 Hz。taps 建议奇数(线性相位对称)。
 *  design contract:输出域抗 imaging;与 worklet 内联同款公式(改此处务必同步 worklet + 跑单测)。 */
export function designLowpass(fc: number, sr: number, taps: number): Float32Array {
  const h = new Float32Array(taps);
  const M = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - M;
    const sinc = k === 0 ? (2 * fc) / sr : Math.sin((2 * Math.PI * fc * k) / sr) / (Math.PI * k);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)); // Hamming
    h[i] = sinc * win;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum; // 归一 DC 增益 1(带内不增益/不衰减)
  return h;
}

/**
 * design contract/R4:分片队列 —— 播放缓冲的唯一内聚单元。
 *
 * **为什么不是「可增长线性数组 + 相对位」(design contract 原实现)**:那种结构的 `push` 每帧
 * `new Float32Array(keep+n)` + `set(整个未播缓冲)` = **O(缓冲深度)** 拷贝 + 一次分配,而
 * `port.onmessage` 跑在**音频渲染线程**:长回复缓冲堆到 20~30s 时单帧 push 峰值 4072~5761µs,
 * **超出 render quantum 预算 2667µs** → 渲染来不及填输出 = 咔哒(design contract 根因)。
 *
 * 本结构参考公开 AudioWorklet 播放实现(唯一与我们约束
 * 完全相同的生产实现):`queue.push(chunk)` **O(1) 入队、不碰既有数据**;消费用「队头读索引 +
 * 分数相位」;播完的分片 `shift()` 弹出。分片由主线程 transferable 转移所有权(零拷贝)。
 *
 * ★ **五个入口全部收口在此**(push / 消费 / shift / flush / 溢出丢弃),`queuedSamples` **只在内部维护**
 *   —— 评审+review 一致指出「多处手工同步计数」是漂移根源,业务代码 MUST NOT 直接改这些字段。
 * ★ **`queuedSamples` 的同步点只有三处**:`push(+=n)` / 消费(每推进一个整样本 `-=1`)/ `flush(=0)`。
 *   `shift()` 时 **MUST NOT 再减** —— 消费时已逐样本减过,再减即**双减**(变异实测 drift=320)。
 *   溢出丢弃走单独的 `dropOldest()`。
 */
class ChunkQueue {
  private chunks: Float32Array[] = []; // 未播分片(队头为最早/正在播的)
  private readIdx = 0;                 // 队头分片内的整样本读位
  private frac = 0;                    // 分数相位([0,1),跨 pull 块保留,守 design contract 连续相位)
  private queued = 0;                  // O(1) 维护的未播样本数(renderAbs 每块要读,不可遍历求和)
  private touched = 0;                 // 仅测试用:累计"触碰"的样本数,证 push 为 O(帧长)(design contract)

  /** 未播样本数(O(1))。 */
  get size(): number {
    return this.queued;
  }

  /** 仅测试用:push 累计触碰的样本数(与队列深度无关即证 O(帧长))。 */
  get touchedSamples(): number {
    return this.touched;
  }

  /** 结构不变量:`queued` 与独立遍历算出的实际未播量之差(design contract 唯一有信息量的漂移断言)。
   *  ⚠ 本身是 O(队列长度):实测 300s 病态深度(15000 分片)约 1750µs = quantum 预算 66%
   *  → **MUST NOT 每块调用**(仅开发模式/降频/测试)。 */
  structuralDrift(): number {
    let actual = -this.readIdx;
    for (const c of this.chunks) actual += c.length;
    return Math.abs(this.queued - actual);
  }

  /** O(1) 入队(不触碰既有分片)。`chunk` 的所有权移交本队列,调用方不得再改。 */
  push(chunk: Float32Array): void {
    this.chunks.push(chunk);
    this.queued += chunk.length;
    this.touched += chunk.length; // 只记本帧长度 —— 与深度无关
  }

  /** 当前读位样本;队列空时返回 null(调用方据此判 underrun)。 */
  head(): number | null {
    const c = this.chunks[0];
    if (!c || this.readIdx >= c.length) return null;
    return c[this.readIdx];
  }

  /** 插值所需的"下一个"样本:同分片下一样本 → **下一分片首样本** → null(无后继=underrun)。
   *  ★ design contract:分片边界 MUST 无插值断点;后继缺席时 MUST NOT 访问 `chunks[1][0]`(否则 TypeError)。 */
  next(): number | null {
    const c = this.chunks[0];
    if (!c) return null;
    if (this.readIdx + 1 < c.length) return c[this.readIdx + 1];
    const n = this.chunks[1];
    return n && n.length > 0 ? n[0] : null;
  }

  /** 当前分数相位。 */
  get phase(): number {
    return this.frac;
  }

  /** 按 ratio 推进读位;跨过整样本则 `queued--`,播完的分片 shift 弹出(此处**不再**减 queued)。 */
  advance(ratio: number): void {
    this.frac += ratio;
    while (this.frac >= 1) {
      this.frac -= 1;
      this.readIdx += 1;
      if (this.queued > 0) this.queued -= 1;
    }
    // 弹出已播完的队头分片,读索引同步平移(design contract 边界 2:不平移则下次读越界)
    while (this.chunks.length > 0 && this.readIdx >= this.chunks[0].length) {
      this.readIdx -= this.chunks[0].length;
      this.chunks.shift();
    }
  }

  /** 清空(barge-in / flush):三个状态 MUST 同清(design contract 边界 3;漏清则下轮从旧相位起播)。 */
  clear(): void {
    this.chunks = [];
    this.readIdx = 0;
    this.frac = 0;
    this.queued = 0;
  }

  /** 容量溢出:丢弃最旧的 n 个**未播**样本,返回实际丢弃数。相位归零(不连续点,同 underrun 语义)。
   *  ★ 调用方(design contract)MUST 在此之前按丢弃区间给相交段打污点 —— 本方法只管数据、不碰账本。 */
  dropOldest(n: number): number {
    let remain = Math.min(n, this.queued);
    const dropped = remain;
    while (remain > 0 && this.chunks.length > 0) {
      const avail = this.chunks[0].length - this.readIdx;
      if (avail > remain) {
        this.readIdx += remain;
        remain = 0;
      } else {
        remain -= avail;
        this.chunks.shift();
        this.readIdx = 0;
      }
    }
    this.queued -= dropped;
    this.frac = 0; // 丢弃是不连续点:相位重新起
    return dropped;
  }
}

export class PlaybackResampler {
  private readonly ratio: number; // 输入样本 / 输出样本 = 16000 / outRate(升采样时 < 1)
  // design contract:分片队列取代「可增长线性数组 buf + 相对分数位 pos」(根因见 ChunkQueue 文档注释)。
  private readonly q = new ChunkQueue();
  private driftWarned = false; // 一次性闩:溢出告警不刷日志(照 LiveKit _speech_buffer_max_reached)
  // design contract:累计被溢出丢弃的样本数。**纯诊断**(日志/指标),MUST NOT 进任何判据 ——
  //   第 2 轮 review:把它减进 renderAbs 会致「溢出后新段永不完成」。
  private droppedSamples = 0;
  // ★ design contract(实现review):终态记录 —— 逐 `(generation, seq)` 的单调状态机。
  //   终态段立即出队(防账本泄漏),出队后同一 key 若再 beginTurn 就能**再发一次终态事件**
  //   (实测:同 generation=0/seq=7 重开后发出两个 turn_played)。真实链路里 seq 由引擎轮级单调
  //   递增、同代次不复用,但 R7 要求结构性防线**不依赖上游正确** → 记录已终态 key 并拒绝重复。
  //   **有界**(FINALIZED_MAX 条 FIFO 淘汰),防长会话内存泄漏。
  private finalized: string[] = [];
  private prevRenderAbs = 0;        // R4 单调性守卫的水位线(O(1),生产路径可用)
  private monotonicWarned = false;  // 一次性闩
  // design contract:underrun 边界淡出/淡入包络增益(0..1,跨 pull 块保持)。每输出样本乘 fadeGain;
  //   预判即将 underrun(ring 剩余 < FADE 窗)→ 朝 0 淡出;有充足数据 → 朝 1 淡入。消中段咔哒。
  private fadeGain = 0;
  private readonly fadeSamples: number; // fade 窗(输出域样本数);0 = 关闭 fade(测试验证纯相位用)
  // ── design contract 播放 ACK 段账本(默认惰性:未 beginTurn 则全程 inert,与 design contract 现状逐字节等价)──
  // ★ 关键设计(自主核实后偏离 spec 字面「独立 renderAbs 计数器」——见 renderAbs() 注释):writeAbs 是**唯一**
  //   会话级单调真源;renderAbs **派生**自 writeAbs - buf.length + floor(pos)。此举从构造上根除 review
  //   死结(flush 若归零一个坐标而非另一个 → 新代次 endAbs 恒 > renderAbs、完成条件永不成立)。派生下 flush 清 ring
  //   后 renderAbs 自然 = writeAbs(与新轮 startAbs 同基线),两坐标永不发散。
  private writeAbs = 0;                 // 会话级:累计写入 ring 的输入域 16k 样本数(单调,flushAll 不归零)
  private generation = 0;               // 每次 flushAll 递增的代次(隔离旧代次 PCM/迟到事件)
  private ledger: Seg[] = [];           // 段账本(仅当前代次;终态立即出队)
  private tombstone = false;            // flushAll 后丢弃旧代次在途 PCM,直到下一 beginTurn(新轮)解除
  private events: PlaybackEvent[] = []; // 事件队列(node --test 用 takeEvents 消费;worklet 侧改 postMessage)
  private onEvent?: (e: PlaybackEvent) => void; // 可选事件回调(主线程/测试实时接收)
  // design contract 抗 imaging FIR(输出域):系数 + 跨 pull 块历史(前 taps-1 个**输出域**样本,零相位对称中心对齐)。
  private readonly fir: Float32Array | null;   // null = 关闭(antiImaging=false / 退化率)
  private readonly firHist: Float32Array;      // 卷积历史(输出域;首块首样本填充首值消瞬态)
  private firPrimed = false;                    // 首块用首输出样本预填历史(消启动瞬态)
  private firY: Float32Array = new Float32Array(0);        // applyFir 复用滤波结果 scratch(避免热路径每 pull 分配,review)
  private firNextHist: Float32Array;            // applyFir 复用下块历史 scratch(固定 H,不随 pull 重分配)

  /** @param outRate 输出(硬件)采样率,如 48000 / 44100。输入固定 16k。
   *  @param fadeSamples underrun fade 窗(默认 FADE_SAMPLES;传 0 关闭,供相位单测隔离 fade)。
   *  @param antiImaging design contract 抗 imaging 低通(默认开;传 false 关闭,供纯相位/imaging 对照单测)。 */
  constructor(outRate: number, fadeSamples: number = FADE_SAMPLES, antiImaging = true) {
    this.ratio = INPUT_RATE / (outRate > 0 ? outRate : INPUT_RATE);
    this.fadeSamples = fadeSamples >= 0 ? fadeSamples : FADE_SAMPLES;
    // 仅升采样(outRate > 16k)才需抗 imaging;退化率(outRate<=16k,ratio>=1)无升采样镜像,关闭。
    const upsampling = outRate > INPUT_RATE;
    this.fir = antiImaging && upsampling ? designLowpass(ANTI_IMAGING_FC_HZ, outRate, ANTI_IMAGING_TAPS) : null;
    this.firHist = new Float32Array(ANTI_IMAGING_TAPS - 1);
    this.firNextHist = new Float32Array(ANTI_IMAGING_TAPS - 1); // 复用 scratch(固定 H)
  }

  /** 追加一块 16k s16le PCM(Int16Array 或其 ArrayBuffer 视图)。
   *
   *  ★ design contract:入队是 **O(本帧样本数)** —— 只做「int16→float32 转换 + `queue.push`」,
   *    **不触碰任何既有分片**(旧实现每帧全量拷贝未播缓冲 = O(深度),是本 spec 的根因)。
   *  注:生产路径的归一已移到主线程(design contract),worklet 只接收 `Float32Array` 所有权;
   *    本方法保留 int16 入口供 core 单测与非 transferable 调用方使用,归一公式逐字节不变。 */
  push(pcm: Int16Array): void {
    if (!pcm || pcm.length === 0) return;
    // design contract tombstone:flushAll(打断)后、下一 beginTurn(新轮)前,丢弃旧代次在途 PCM,不入队、
    //   **不推进 writeAbs**(保 renderAbs 派生一致:队列空则 renderAbs=writeAbs)。防旧轮音频回灌新轮。
    //   仅 ACK 模式(beginTurn 调用过)才可能置 tombstone;非 ACK 模式恒 false,逐字节等价 design contract。
    if (this.tombstone) return;
    const chunk = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i];
      chunk[i] = v < 0 ? v / 32768 : v / 32767; // design contract 已数值排除不对称归一为杂音源,勿"顺手统一"
    }
    this.pushFloat(chunk);
  }

  /** 追加一块**已归一**的 float32 分片(生产路径:主线程 transferable 转移所有权 → worklet 直接入队)。
   *  所有权移交本实例,调用方 MUST NOT 再改该数组。 */
  pushFloat(chunk: Float32Array): void {
    if (!chunk || chunk.length === 0) return;
    if (this.tombstone) return;
    this.q.push(chunk);
    this.writeAbs += chunk.length; // design contract:会话级累计写入,endAbs/renderAbs 派生基线
    // 容量 backstop(病态:标签页 throttle 致 pull 停但 push 继续)。正常长回复恒不触发
    // (design contract 已验 40/90/180s 零截断)。★ design contract:丢弃 MUST NOT 被记作"听到过" ——
    //   先按丢弃区间给相交段打污点,再动数据。
    if (this.q.size > RING_MAX_SAMPLES) {
      this.dropOldestWithTaint(this.q.size - RING_MAX_SAMPLES);
    }
  }

  /** design contract:溢出丢弃最旧 n 个未播样本 —— **先打污点再丢数据**。
   *  丢弃区间 = `[renderAbs, renderAbs + n)`;与之相交的 **open** 段标 tainted 并累加 taintedSamples。
   *  ⚠ MUST 只对 `state === 'open'` 的段求交(评审 第 3 轮 nit-3:已终态段可能仍在数组里,
   *    不设此门会误标)。fade/FIR 按"不连续点"重置(同 underrun 语义)。 */
  private dropOldestWithTaint(n: number): void {
    const lo = this.renderAbs();
    const hi = lo + n;
    for (const seg of this.ledger) {
      if (seg.state !== 'open') continue; // ★ review
      const segHi = seg.endAbs ?? this.writeAbs; // 未封口段用当前写位
      const ovl = Math.max(0, Math.min(hi, segHi) - Math.max(lo, seg.startAbs));
      if (ovl > 0) {
        seg.tainted = true;
        seg.taintedSamples += ovl;
      }
    }
    const dropped = this.q.dropOldest(n);
    this.droppedSamples += dropped; // 纯诊断计数,MUST NOT 进任何判据(第 2 轮 review)
    this.fadeGain = 0;
    this.firPrimed = false;
    if (!this.driftWarned) {
      this.driftWarned = true; // 一次性闩,防持续溢出刷日志
      // eslint-disable-next-line no-console
      console.warn(`[playback] capacity overflow: dropped ${dropped} unplayed samples (oldest-first)`);
    }
    // ★ 溢出后 MUST 就地重查完成(实现期发现的必需项):`pull` 里的完成检查被
    //   `if (written > 0)` 门控(design contract review:防"队列排空即完成"误报,该门 MUST NOT 删)。
    //   而溢出**会把队列清空** → 后续 pull 恒 written=0 → tainted 段的 turn_aborted **永远发不出去**
    //   (实测:段封口后被全量丢弃,events 为空)。故在此显式判一次:此刻 renderAbs 已因丢弃前跳、
    //   污点已标好,判据与自然路径一致。
    this.checkCompletions();
  }

  /**
   * 连续升采样填满 out(mono float32)。返回写入的**有效**样本数:
   * ring 足够 → 返回 out.length;欠载 → 有效部分 + 剩余置 0(静音),返回有效数。
   * 跨块保持分数相位:消费到最后一次插值用到的 idx,余量留给下次(不取整漂移)。
   */
  pull(out: Float32Array): number {
    const n = out.length;
    const fadeOn = this.fadeSamples > 0;
    const step = fadeOn ? 1 / this.fadeSamples : 1; // 每样本 fade 增量(线性包络斜率)
    let written = 0;
    let underran = false;
    for (let i = 0; i < n; i++) {
      // design contract:队头样本 + 插值所需的下一样本(可跨分片取下一分片首样本)。
      //   任一缺席 → 欠载:本样本起(含)全部静音,相位停在此等 push 续。
      const a = this.q.head();
      const b = a === null ? null : this.q.next();
      if (a === null || b === null) {
        // R4:进入欠载 → 已因下方「预判淡出」把 fadeGain 降到 ~0(若数据骤断未淡完,这里继续把残余 gain 归 0
        //   避免 DC 残留),剩余输出静音。fadeGain 停 0,下次有数据从 0 淡入。
        this.fadeGain = 0;
        for (let k = i; k < n; k++) out[k] = 0;
        underran = true;
        break;
      }
      const frac = this.q.phase;
      const sample = a * (1 - frac) + b * frac;
      if (fadeOn) {
        // R4:预判 underrun —— 队列剩余可播输出样本 < fade 窗 → 目标 0(提前淡出);否则目标 1(淡入)。
        // ★ design contract:`q.size - 1 - frac` 等价于旧实现的 `buf.length - 1 - pos`
        //   (`tools/verify-chunk-queue-equivalence.mjs` 已逐样本验证该等价关系)。
        const remainOut = (this.q.size - 1 - frac) / this.ratio;
        const target = remainOut <= this.fadeSamples ? 0 : 1;
        if (this.fadeGain < target) this.fadeGain = Math.min(target, this.fadeGain + step);
        else if (this.fadeGain > target) this.fadeGain = Math.max(target, this.fadeGain - step);
        out[i] = sample * this.fadeGain;
      } else {
        out[i] = sample; // fade 关闭(fadeSamples=0):纯相位输出(相位单测用)
      }
      written++;
      this.q.advance(this.ratio); // 推进读位 + 弹出播完的分片(queuedSamples 在内部同步)
    }
    // design contract:升采样后在**输出域**过抗 imaging 低通(消线性插值镜像 = 每句起句杂音)。
    if (this.fir) {
      // ★ 评审 复审 Blocker 1(欠载尾 FIR/fade 交互跳变):FIR 有 31 样本群延迟,若只滤 [0,written) 再硬切
      //   零尾,FIR 输出的(延迟的)淡出信号在 written 边界被硬截 → 跳变放大(实测 0.004→0.024+)。修:欠载时滤**全块**
      //   [0,n)(含 fade 已置的零尾),让 FIR 把淡出信号平滑 ring-out 进零尾(无硬切;实测边界跳变回落到 ~0.005 基线)。
      //   非欠载(written===n)两者等价。
      this.applyFir(out, underran ? n : written);
      // ★ review④:欠载(underran)是不连续点(fade 已归 0、下段淡入)——FIR 历史也须重置,
      //   否则恢复首块用**欠载前**的旧历史卷积新音频 → 引入恢复瞬态(review 实测 -0.061 vs 应 ~0)。与 fade「下段
      //   从 0 淡入」同语义:欠载即"断",下段当新起,firPrimed=false 使恢复首样本重新预填。
      if (underran) this.firPrimed = false;
    }
    // design contract:分片队列自带回收(`advance` 内 shift 播完的分片)—— 旧实现的 `subarray` 前缀回收整体消失。
    // design contract:仅**实际出声(written>0,renderAbs 真推进)**后才判轮完成;underrun(written=0)不推进、
    //   不判完成(review:靠 R5 timeout 覆盖网络永慢,不误报「排空即完成」)。非 ACK 模式 ledger 空,惰性跳过。
    if (written > 0) {
      // ★ design contract:标记"本段真的渲染过样本" —— 供 checkCompletions 区分
      //   「播完」与「零/单样本段judge天然成立」(见 Seg.rendered 注释)。
      for (const seg of this.ledger) if (seg.state === 'open') seg.rendered = true;
      this.checkCompletions();
    }
    return written;
  }

  /** design contract:对 out[0,len) 就地过抗 imaging 低通 FIR(输出域)。**因果流式**:跨 pull 块保留末 H=taps-1 个**滤波前**
   *  输出样本作历史(firHist),下块续上无边界。首块用首输出样本预填历史(零阶保持消启动瞬态,与 design contract 同法)。
   *  对称 FIR 有常数群延迟 (taps-1)/2=31 ≈ 0.65ms@48k(63 taps)——纯延迟不改音质、播放无感,不做中心对齐(那需
   *  未来样本 = 前瞻延迟,更复杂无收益)。underrun 静音尾(out[len..])不滤(本就 0)。 */
  private applyFir(out: Float32Array, len: number): void {
    if (len <= 0) return;
    const h = this.fir!;
    const taps = h.length;
    const H = taps - 1;
    const hist = this.firHist;
    if (!this.firPrimed) {
      hist.fill(out[0]); // 首块:历史填首样本(消启动瞬态)
      this.firPrimed = true;
    }
    // ext = [hist(H) , out[0..len)],长度 H+len;因果卷积 y[i] = Σ_{j=0}^{taps-1} h[j]·ext[(i+H) - j](i+H..i+H-H=i 全可及)。
    // ★ design contract(实现review):原 `ext` 闭包是渲染路径每块一次的分配 → 已内联到下方循环。
    //   语义:ext(k) = k < H ? hist[k] : out[k - H](即 [hist(H), out[0..len)] 拼接视图)。
    // 先快照本块末 H 个**滤波前**样本作下块历史(卷积读的是滤波前值,故写回前存)。len>=H:取 out[len-H..len);
    //   len<H:旧历史左移 (H-len) + 本块全部 len 个。复用 firNextHist scratch(固定 H,不热路径分配,review)。
    const nextHist = this.firNextHist;
    for (let j = 0; j < H; j++) {
      const src = len - H + j; // 相对本块 out 的索引(可能为负 → 落在旧 hist 尾部)
      nextHist[j] = src >= 0 ? out[src] : hist[H + src];
    }
    // 复用 firY scratch(仅当 len 变大才重分配;render quantum 恒定 128 → 稳态零分配)。
    if (this.firY.length < len) this.firY = new Float32Array(len);
    const y = this.firY;
    for (let i = 0; i < len; i++) {
      let acc = 0;
      for (let j = 0; j < taps; j++) {
        const k = i + H - j;
        acc += h[j] * (k < H ? hist[k] : out[k - H]); // 内联,无闭包
      }
      y[i] = acc;
    }
    for (let i = 0; i < len; i++) out[i] = y[i];
    hist.set(nextHist);
  }

  /** renderAbs:**读游标已推进到的会话级源流位置**(输入域 16k 样本)= 累计写入 − 队列内未播样本。
   *
   *  ★ **单一定义**(design contract;第 2 轮 review 的正解):MUST NOT 出现第二个定义。
   *    曾在 R5 另写 `− droppedSamples`,实测致「溢出后新段永不完成」(丢 500 则永久差 499);
   *    而不减又会把丢弃样本记作已渲染。**两者各修一个 bug 又各引入另一个** → 正解是
   *    「坐标只表达读游标事实,`丢弃没被听到` 由**段级污点**表达」。
   *  ★ 保持**派生**(非独立计数器,与 LiveKit `pushed_duration − queued_duration` 同构):
   *    flush 清队列后 renderAbs 自然 = writeAbs,与新轮 startAbs 同基线,两坐标永不发散。 */
  private renderAbs(): number {
    const r = this.writeAbs - this.q.size;
    // ★ design contract 漂移防线之二(实现review:此前只有测试 getter,生产无守卫)。
    //   **O(1) 单调性检查**,可安全放在渲染路径:renderAbs MUST NOT 回退。
    //   回退意味着 queuedSamples 与 writeAbs 失同步 → 段完成判据会错乱。fail-soft(告警不抛),
    //   一次性闩防刷日志。结构不变量那条是 O(队列长度),按 spec 留开发模式/测试(见 __structuralDrift)。
    if (r < this.prevRenderAbs && !this.monotonicWarned) {
      this.monotonicWarned = true;
      // eslint-disable-next-line no-console
      console.warn(`[playback] renderAbs regressed ${this.prevRenderAbs} → ${r} (queuedSamples drift?)`);
    }
    if (r > this.prevRenderAbs) this.prevRenderAbs = r;
    return r;
  }

  // ────────────────── design contract:漂移防线(两层有信息量的断言)──────────────────
  // ⚠ 原设计曾列「派生式恒等 renderAbs === writeAbs − queuedSamples」为第三层 —— 第 3 轮 review 指出
  //   那是**套套逻辑**(renderAbs() 的实现就是该表达式,断言恒真、零信息量),已删。

  /** 仅测试用:结构不变量偏差(`queuedSamples` vs 独立遍历算出的实际未播量)。
   *  ⚠ 自身 O(队列长度):300s 病态深度约 1750µs = quantum 预算 66% → 生产路径 MUST NOT 每块调用。 */
  __structuralDrift(): number {
    return this.q.structuralDrift();
  }

  /** 仅测试用:push 累计触碰样本数(与队列深度无关即证 push 为 O(帧长),design contract)。 */
  get __touchedSamples(): number {
    return this.q.touchedSamples;
  }

  /** 仅测试用:暴露 renderAbs 供单调性断言(design contract)。 */
  __renderAbsForTest(): number {
    return this.renderAbs();
  }

  /** 仅测试用:强制触发容量溢出路径(免造 300s 数据);走与生产完全相同的污点逻辑。 */
  __forceOverflow(n: number): void {
    this.dropOldestWithTaint(n);
  }

  /** 终态事件的**唯一出口**:按 `(generation, seq)` 拒绝重复(R7 逐段单调状态机),fail-soft 不抛。
   *  拦下的非法迁移含:`played→played` / `played→aborted` / `aborted→aborted` / `aborted→played`
   *  / 未开先终 / 跨代次迟到终态(代次不同则 key 不同,天然隔离)。 */
  private emitTerminal(e: PlaybackEvent): void {
    const key = `${e.generation}:${e.seq}`;
    if (this.finalized.includes(key)) {
      // eslint-disable-next-line no-console
      console.warn(`[playback] duplicate terminal event for turn ${key} (${e.type}) — dropped`);
      return;
    }
    this.finalized.push(key);
    if (this.finalized.length > FINALIZED_MAX) this.finalized.shift(); // 有界:FIFO 淘汰最旧
    this.emit(e);
  }

  private emit(e: PlaybackEvent): void {
    this.events.push(e);
    if (this.onEvent) this.onEvent(e);
  }

  /** 检查各 open 段是否自然播完(endAbs 已定 && renderAbs 越过 endAbs−EPS,或 ring 排空且为末段)→ 发 turn_played。
   *  终态段立即出队(review 防账本泄漏)。仅有账本(ACK 模式)才运行。 */
  private checkCompletions(): void {
    if (this.ledger.length === 0) return;
    const rAbs = this.renderAbs();
    const drained = this.available() === 0;
    for (let i = 0; i < this.ledger.length; i++) {
      const seg = this.ledger[i];
      if (seg.state !== 'open' || seg.endAbs == null) continue;
      const isLast = i === this.ledger.length - 1;
      const reachedByPos = rAbs >= seg.endAbs - EPS_SAMPLES;      // 主判据:越过封口位(EPS 接住尾插值差)
      const reachedByDrain = drained && isLast;                   // 兜底:ring 排空且末段(极短段尾插值不足)
      if (reachedByPos || reachedByDrain) {
        // ★ design contract:tainted 段(其音频被溢出丢弃过)MUST 降级为 turn_aborted,MUST NOT 报 turn_played。
        //   positionMs 只计**真实播出量** = 段长 − taintedSamples(自然完成路径天然以 endAbs 为界,无需夹紧)。
        const segLen = seg.endAbs - seg.startAbs;
        if (seg.tainted || !seg.rendered) {
          // tainted:音频被溢出丢弃过 → 降级(R5)。
          // !rendered:**一个样本都没真渲染过**就满足了完成判据 —— 零样本段(endAbs==startAbs)或
          //   单样本段(无法插值)。此时 MUST NOT 报 turn_played(实现review;
          //   保守方向固定:不确定时报 aborted,多报会让服务端误推进考试游标)。
          seg.state = 'aborted';
          const played = seg.rendered ? Math.max(0, segLen - seg.taintedSamples) : 0;
          const positionMs = (played / INPUT_RATE) * 1000;
          this.emitTerminal({ type: 'turn_aborted', generation: seg.generation, seq: seg.seq, positionMs });
        } else {
          seg.state = 'complete';
          const positionMs = (segLen / INPUT_RATE) * 1000; // 自然完成 = 全段时长
          this.emitTerminal({ type: 'turn_played', generation: seg.generation, seq: seg.seq, positionMs });
        }
      }
    }
    this.ledger = this.ledger.filter((s) => s.state === 'open'); // 出队终态段
  }

  /** 估计队列里还能产出的**输出**样本数(供 available()==0 判 drain)。O(1)。 */
  available(): number {
    const inRemain = this.q.size - 1; // 减 1:末样本需下一样本才能插值
    if (inRemain <= 0) return 0;
    return Math.floor(inRemain / this.ratio);
  }

  /** 立即清空缓冲(barge-in 停声):下次 pull 出静音直到新 push。相位归零(下段重新起相)。
   *  ★ ACK 模式(有 open 段)下,flush() 委托 flushAll() 以先算截断 position 再清缓冲、置 tombstone、代次 ++。
   *  非 ACK 模式(ledger 空)= 纯 design contract 行为,逐字节等价(writeAbs 会跳变但无账本消费者,无副作用)。 */
  flush(): void {
    if (this.ledger.length > 0 || this.tombstone) {
      this.flushAll();
      return;
    }
    this.q.clear(); // design contract:三状态(分片/读索引/相位)+ queuedSamples 一并清
    this.fadeGain = 0; // R4:下段从 0 淡入
    this.firPrimed = false; // design contract:barge-in 新语境 → FIR 历史重置(下段首样本重新预填,不用旧段尾污染)
  }

  // ────────────────── design contract 播放 ACK 段账本 API ──────────────────

  /** 注册轮播放事件回调(主线程实时接收;不设则 events 队列缓存,takeEvents 消费)。 */
  setEventSink(cb: (e: PlaybackEvent) => void): void {
    this.onEvent = cb;
  }

  /** 消费并清空事件队列(node --test 断言用;worklet 侧走 setEventSink→postMessage)。 */
  takeEvents(): PlaybackEvent[] {
    const es = this.events;
    this.events = [];
    return es;
  }

  /** 收 ai_audio_start(seq):开一段,startAbs = 当前 writeAbs(该轮首帧音频起点绝对位)。
   *  新轮 beginTurn 解除 tombstone(旧代次在途 PCM 已丢完,新轮 PCM 正常入 ring)。 */
  beginTurn(seq: number): void {
    this.tombstone = false; // 新轮到 → 旧代次 PCM 不再来,恢复入 ring
    // 幂等/防重(fail-soft):同代次已有该 open seq 则忽略(重复 start)。
    if (this.ledger.some((s) => s.seq === seq && s.state === 'open')) return;
    this.ledger.push({
      generation: this.generation,
      seq,
      startAbs: this.writeAbs,
      endAbs: null,
      state: 'open',
      tainted: false, // design contract
      taintedSamples: 0,
      rendered: false, // design contract:尚未渲染任何样本
    });
    if (this.ledger.length > LEDGER_MAX) this.ledger.shift(); // 病态保护:丢最旧(与 worklet 一致,review)
  }

  /** 收 ai_audio_end(seq,轮封口=onAiDone):记 endAbs = 当前 writeAbs,并**立即重查完成**
   *  (R3「source 已播空、end 稍后到」:ring 早排空、renderAbs 已越过 → end 一到即 complete)。 */
  endTurn(seq: number): void {
    const seg = this.ledger.find((s) => s.seq === seq && s.state === 'open');
    if (!seg) return; // end-before-start / 未知 seq:fail-soft 忽略(R3 要求)
    seg.endAbs = this.writeAbs;
    this.checkCompletions();
  }

  /** 打断/停播:先按当前 renderAbs 为每个 open 段算截断 position 发 turn_aborted,再清 ring + 置 tombstone + 代次++。
   *  ★ 原子(worklet 侧单 onmessage 内):position 权威数据(startAbs/renderAbs)在清账本前快照。renderAbs/writeAbs
   *  **不归零**(review:会话级单调,归零破坏新代次完成判据);隔离靠 generation + tombstone。 */
  flushAll(): void {
    const rAbs = this.renderAbs();
    for (const seg of this.ledger) {
      if (seg.state !== 'open') continue;
      seg.state = 'aborted';
      // ★ design contract 第 5 条(第 4 轮 review):flush 路径的 positionMs 须做**两处**修正 ——
      //   ① **夹紧到 endAbs**:溢出丢弃区间**可跨越段边界** → renderAbs 可能超过本段 endAbs。
      //      反例(实测):段[0,1000) 已播 800、丢弃[800,1100) 与本段仅相交 200,若 flush 早于
      //      checkCompletions 则 rAbs=1100 > endAbs → 不夹紧会把超出的 100 算作本段已播
      //      (报 56.25ms 而实际听到 50ms)。未封口段无上界可夹,退化为不夹。
      //   ② **扣除污点**:被丢弃的样本 MUST NOT 记作已播(否则同类 over-report)。
      //   注:自然完成路径的公式(段长 − taintedSamples)天然以 endAbs 为界,故只有本路径需夹紧。
      const upper = seg.endAbs ?? rAbs;
      const played = Math.max(0, Math.min(rAbs, upper) - seg.startAbs - seg.taintedSamples);
      const positionMs = (played / INPUT_RATE) * 1000;
      this.emitTerminal({ type: 'turn_aborted', generation: seg.generation, seq: seg.seq, positionMs });
    }
    this.ledger = [];                 // 清账本(终态已发事件)
    this.q.clear();                   // design contract:清分片队列(三状态 + queuedSamples)
    this.fadeGain = 0;
    this.firPrimed = false;           // design contract:FIR 历史重置(新语境)
    this.generation += 1;             // 代次++:后续旧代次事件/PCM 被隔离
    this.tombstone = true;            // 丢弃旧代次在途 PCM,直到下一 beginTurn(新轮)
    // renderAbs/writeAbs 不归零:清队列后 renderAbs 派生 = writeAbs(与下一 beginTurn 的 startAbs 同基线)。
  }

  /** 当前代次(主线程丢弃更旧代次迟到事件用)。 */
  currentGeneration(): number {
    return this.generation;
  }
}
