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

export class PlaybackResampler {
  private readonly ratio: number; // 输入样本 / 输出样本 = 16000 / outRate(升采样时 < 1)
  private buf: Float32Array = new Float32Array(0); // 未消费的 16k 输入样本(float32)
  private pos = 0; // 相对 buf 起点的分数读取位置(跨 pull 块保持,不取整漂移)
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

  /** 追加一块 16k s16le PCM(Int16Array 或其 ArrayBuffer 视图)。转 float32 累积进 ring。 */
  push(pcm: Int16Array): void {
    if (!pcm || pcm.length === 0) return;
    // design contract tombstone:flushAll(打断)后、下一 beginTurn(新轮)前,丢弃旧代次在途 PCM,不入 ring、
    //   **不推进 writeAbs**(保 renderAbs 派生一致:buf 空则 renderAbs=writeAbs)。防旧轮音频回灌新轮(混播)。
    //   仅 ACK 模式(beginTurn 调用过)才可能置 tombstone;非 ACK 模式恒 false,逐字节等价 design contract。
    if (this.tombstone) return;
    // 从当前未消费尾部(floor(pos) 起)拼接:先丢弃已完全消费的前缀,保留分数相位。
    const consumed = Math.floor(this.pos);
    const keep = this.buf.length - consumed; // 尚未消费的旧样本(含插值所需的当前 idx)
    const merged = new Float32Array(Math.max(0, keep) + pcm.length);
    if (keep > 0) merged.set(this.buf.subarray(consumed), 0);
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i];
      merged[Math.max(0, keep) + i] = v < 0 ? v / 32768 : v / 32767;
    }
    this.buf = merged;
    this.pos -= consumed; // 相位平移到新 buf 坐标(保留分数部分)
    if (this.pos < 0) this.pos = 0;
    this.writeAbs += pcm.length; // design contract:会话级累计写入(输入域 16k 样本),endAbs/renderAbs 派生基线
    // 防御上限(review):极端场景(标签页 throttle,pull 停但 push 继续)ring 理论可涨;
    // 正常消费≥下发恒有界,此处只作 backstop。超 16k×300s 丢最旧、相位归零(与 worklet 一致)。
    // 注:此处丢弃的是**未播**旧样本,renderAbs 派生 = writeAbs-buf.length+floor(pos) 会因 buf 截断而前跳
    //   (把丢弃样本记作已渲染);仅真病态(标签页挂起数分钟)触发,属已降级态,可接受。
    if (this.buf.length > RING_MAX_SAMPLES) {
      this.buf = this.buf.subarray(this.buf.length - RING_MAX_SAMPLES);
      this.pos = 0;
    }
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
    let pos = this.pos;
    let written = 0;
    let underran = false;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(pos);
      // 线性插值需 idx+1;不足则欠载:本样本起(含)全部静音,停止推进(相位停在此,等 push 续)。
      if (idx + 1 >= this.buf.length) {
        // R4:进入欠载 → 已因下方「预判淡出」把 fadeGain 降到 ~0(若数据骤断未淡完,这里继续把残余 gain 归 0
        //   避免 DC 残留),剩余输出静音。fadeGain 停 0,下次有数据从 0 淡入。
        this.fadeGain = 0;
        for (let k = i; k < n; k++) out[k] = 0;
        underran = true;
        break;
      }
      const frac = pos - idx;
      const sample = this.buf[idx] * (1 - frac) + this.buf[idx + 1] * frac;
      if (fadeOn) {
        // R4:预判 underrun —— ring 剩余可播输出样本 < fade 窗 → 目标 0(提前淡出);否则目标 1(淡入)。
        const remainOut = (this.buf.length - 1 - pos) / this.ratio; // 当前相位起还能插出的输出样本数
        const target = remainOut <= this.fadeSamples ? 0 : 1;
        if (this.fadeGain < target) this.fadeGain = Math.min(target, this.fadeGain + step);
        else if (this.fadeGain > target) this.fadeGain = Math.max(target, this.fadeGain - step);
        out[i] = sample * this.fadeGain;
      } else {
        out[i] = sample; // fade 关闭(fadeSamples=0):纯相位输出(相位单测用)
      }
      written++;
      pos += this.ratio;
    }
    this.pos = pos;
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
    // 丢弃已完全消费的输入前缀,保留分数相位(防 buf 无限增长;push 也会做,这里让长时间只 pull 也回收)。
    // ★ 回收保持 renderAbs 派生不变:buf.length 减 consumed、floor(pos) 减 consumed → renderAbs 值不变。
    const consumed = Math.floor(this.pos);
    if (consumed > 0 && consumed <= this.buf.length) {
      this.buf = this.buf.subarray(consumed);
      this.pos -= consumed;
    }
    // design contract:仅**实际出声(written>0,renderAbs 真推进)**后才判轮完成;underrun(written=0)不推进、
    //   不判完成(review:靠 R5 timeout 覆盖网络永慢,不误报「排空即完成」)。非 ACK 模式 ledger 空,惰性跳过。
    if (written > 0) this.checkCompletions();
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
    const ext = (k: number): number => (k < H ? hist[k] : out[k - H]);
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
      for (let j = 0; j < taps; j++) acc += h[j] * ext(i + H - j);
      y[i] = acc;
    }
    for (let i = 0; i < len; i++) out[i] = y[i];
    hist.set(nextHist);
  }

  /** renderAbs:会话级已渲染的输入域 16k 样本位(派生真源,非独立计数器)= 累计写入 − ring 内未播样本。
   *  ring 内未播 = buf.length − floor(pos)(pos 前为已消费未回收)。回收/flush 清 buf 时 renderAbs 自然 = writeAbs。 */
  private renderAbs(): number {
    return this.writeAbs - this.buf.length + Math.floor(this.pos);
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
        seg.state = 'complete';
        const positionMs = ((seg.endAbs - seg.startAbs) / INPUT_RATE) * 1000; // 自然完成 = 全段时长
        this.emit({ type: 'turn_played', generation: seg.generation, seq: seg.seq, positionMs });
      }
    }
    this.ledger = this.ledger.filter((s) => s.state === 'open'); // 出队终态段
  }

  /** 估计 ring 里还能产出的**输出**样本数(供 available()==0 判 drain)。 */
  available(): number {
    const inRemain = this.buf.length - Math.floor(this.pos) - 1; // 减 1:末样本需 idx+1 才能插值
    if (inRemain <= 0) return 0;
    return Math.floor(inRemain / this.ratio);
  }

  /** 立即清空 ring(barge-in 停声):下次 pull 出静音直到新 push。相位归零(下段重新起相)。
   *  ★ ACK 模式(有 open 段)下,flush() 委托 flushAll() 以先算截断 position 再清 ring、置 tombstone、代次 ++。
   *  非 ACK 模式(ledger 空)= 纯 design contract 行为,逐字节等价(writeAbs 会跳变但无账本消费者,无副作用)。 */
  flush(): void {
    if (this.ledger.length > 0 || this.tombstone) {
      this.flushAll();
      return;
    }
    this.buf = new Float32Array(0);
    this.pos = 0;
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
    this.ledger.push({ generation: this.generation, seq, startAbs: this.writeAbs, endAbs: null, state: 'open' });
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
      const playedFromStart = Math.max(0, rAbs - seg.startAbs); // 截断:已渲染到段内何处(clamp≥0)
      const positionMs = (playedFromStart / INPUT_RATE) * 1000;
      this.emit({ type: 'turn_aborted', generation: seg.generation, seq: seg.seq, positionMs });
    }
    this.ledger = [];                 // 清账本(终态已发事件)
    this.buf = new Float32Array(0);   // 清 ring
    this.pos = 0;
    this.fadeGain = 0;
    this.firPrimed = false;           // design contract:FIR 历史重置(新语境)
    this.generation += 1;             // 代次++:后续旧代次事件/PCM 被隔离
    this.tombstone = true;            // 丢弃旧代次在途 PCM,直到下一 beginTurn(新轮)
    // renderAbs/writeAbs 不归零:清 buf 后 renderAbs 派生 = writeAbs(与下一 beginTurn 的 startAbs 同基线)。
  }

  /** 当前代次(主线程丢弃更旧代次迟到事件用)。 */
  currentGeneration(): number {
    return this.generation;
  }
}
