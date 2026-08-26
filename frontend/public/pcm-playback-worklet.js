// 播放端连续重采样 AudioWorkletProcessor(design contract,消浏览器杂音):
// 主线程(Exam.tsx)把下行 16k s16le PCM 分片 postMessage 给本 worklet;worklet 内 ring buffer 累积,
// process() 每次被硬件以全局 `sampleRate`(通常 48k)调用,按 16000/sampleRate 步长**连续线性插值升采样**
// 填满输出帧 → 整通 AI 语音是一条连续重采样,**无逐片 createBufferSource 边界**(旧实现逐 20ms 片单独建
// 16k buffer 独立 start → 逐片重采样+调度浮点误差→边界 glitch,长文本分片多→杂音密;design contract 真机坐实)。
//
// 与采集侧 pcm-worklet.js 对称,方向相反(采集 48k→16k 降采样,播放 16k→硬件率升采样)。核心逻辑与
// src/lib/playback-resampler.ts 一致(那份有 node --test 单测;此处内联因 AudioWorklet 不能 import TS)。
// 改这里务必同步改那里 + 跑 test/playback-resampler.test.js。
//
// ★ design contract 抗 imaging(纠正 design contract「升采样不产生混叠不需低通」错误论断):线性插值升采样**产生 imaging**
//   (16k 频谱镜像在 k·16000±f 不被抑制,数值实测 6kHz→10kHz 镜像达基频 39.6%);语音辅音宽带高频→强 imaging
//   =「每句起句杂音」,稳态元音低频→弱=「后面消失」。修:升采样后在输出域过抗 imaging FIR 低通(fc=7800,31 taps),
//   跨 process 块保历史(因果流式,与 core applyFir 同款)。imaging 39.6%→0.8%,6k 基频保 94.5%。
//
// ★ design contract 播放 ACK 段账本(§0.2):在 design contract 连续 ring 之上叠加「会话级绝对坐标 + 段账本」,轮自然
//   播完发 `turn_played`、flush 打断发 `turn_aborted`,给服务端真实播放边界(替代 tts_done 估算)。**ring 连续
//   重采样内核不改**(不切 ring、不重置相位、不打散连续流,守 design contract 消杂音红线);账本只作样本流上的水位线。
//   未 begin_turn(非 ACK 模式)= 账本全程惰性,逐字节等价 design contract(仍发 drained)。
//
// 运行在 AudioWorkletGlobalScope:`sampleRate` 是全局(= AudioContext 采样率),无 DOM/window。
const INPUT_RATE = 16000;
// 首帧预缓冲(抗启动 underrun):ring 攒够 PREROLL_SAMPLES(16k 域)再开播,吸收跨境网络首包抖动
// (替代旧逐片模式的 PLAY_LEAD 首帧提前量)。~120ms @16k = 1920 样本。
const PREROLL_SAMPLES = 1920;
// ring 防御上限(16k×300s):**纯 OOM backstop**。★ design contract 真机根因:原 20s 太小,下发远快于播放
// (design contract:48s音频12s下发完),长回复 ring 堆积深 >20s → 20s 上限在正常长回复就频繁截断、丢排队待播的
// 后续句 = "下一句冲掉上一句"。300s 远超任何真实回复(峰值内存正常仅~1.8MB,上限~19MB),只真病态才触发。
const RING_MAX_SAMPLES = 4800000;
// R4:underrun 边界淡出/淡入窗(输出域样本数,~2.7ms@48k)。与 playback-resampler.ts FADE_SAMPLES 同步。
const FADE_SAMPLES = 128;
// ★ 真正 drain 确认(修"两句叠一起"):ring 空后连续静默这么多 process 块(128帧@48k≈2.7ms/块,~112 块≈300ms)
//   才认定「本轮真正播完」发 drained。瞬时 underrun(中段等下一句)不发 → 主线程 playbackActive 不误翻 false
//   → design contract user-final 停播 / detectBargeIn 判据不误读「没在播」→ 不跳 flush → 旧轮音频不串进新轮(消重叠)。
const DRAIN_CONFIRM_BLOCKS = 112;
// design contract:完成判据尾差容差(输入域 16k 样本)。插值需 idx+1,末样本 renderAbs 最多停在 endAbs-1;EPS=1 接住。
const EPS_SAMPLES = 1;
// design contract:段账本硬上限(review 防泄漏)。正常账本 ≤ 数个 open 段;超此丢最旧 open 段(病态保护)。
const LEDGER_MAX = 64;
// design contract:终态记录上限(FIFO 淘汰;与 core FINALIZED_MAX 同步)。防伪造守卫的有界记忆。
const FINALIZED_MAX = 256;
// work item:bounded browser telemetry state. Entries are removed on every flush.
const TELEMETRY_MAX = 64;
// work item:fixed render-depth history. 512 quanta cover ~1.36s at 48kHz,
// enough to recover queue depth at the main-thread confirmation timestamp
// without allocating or walking the chunk queue on the audio thread.
const DEPTH_HISTORY_SIZE = 512;
// design contract 抗 imaging FIR:截止 Hz + 抽头数(与 playback-resampler.ts 同步)。fc=7500/63taps:44.1/48k 下
//   imaging(9k/10k)=0%、6kHz 保 100%、7kHz 保 82%(review⑥ 调参,替代过宽的 31taps/fc7800)。
const ANTI_IMAGING_FC_HZ = 7500;
const ANTI_IMAGING_TAPS = 63;

// windowed-sinc(Hamming)低通,归一 DC 增益 1(与 core designLowpass 同款公式,改一处同步另一处)。
function designLowpass(fc, sr, taps) {
  const h = new Float32Array(taps);
  const M = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - M;
    const sinc = k === 0 ? (2 * fc) / sr : Math.sin((2 * Math.PI * fc * k) / sr) / (Math.PI * k);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * win;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

/**
 * design contract/R4:分片队列 —— 与 `src/lib/playback-resampler.ts::ChunkQueue` **同款**(改一处同步另一处)。
 *
 * 取代旧的「可增长线性数组 _buf + 相对分数位 _pos」:那种结构 `_push` 每帧 `new Float32Array(keep+n)` +
 * `set(整个未播缓冲)` = **O(缓冲深度)** 拷贝 + 一次分配,而 `port.onmessage` 就跑在**音频渲染线程**上、
 * 与 `process()` 抢同一个 render quantum 预算(128 样本 @48k = 2667µs)。长回复缓冲堆到 20~30s 时
 * 单帧 push 峰值 5761µs → 渲染来不及填输出 = **咔哒**(design contract 根因;生产实现改造后实测 108µs / 0 次超预算)。
 *
 * 五个入口(push/消费/shift/flush/溢出)全部收口在此,`_queued` **只在内部维护**;
 * 同步点仅三处(push += n / 消费每整样本 -= 1 / clear = 0),**shift 时不再减**(双减实测 drift=320)。
 */
class ChunkQueue {
  constructor() {
    this._chunks = []; // 未播分片(队头为最早/正在播的)
    this._readIdx = 0; // 队头分片内的整样本读位
    this._frac = 0;    // 分数相位([0,1),跨 process 块保留,守 design contract 连续相位)
    this._queued = 0;  // O(1) 维护的未播样本数(renderAbs 每块要读,不可遍历求和)
  }
  size() { return this._queued; }
  phase() { return this._frac; }
  /** O(1) 入队(不触碰既有分片)。chunk 所有权移交本队列。 */
  push(chunk) { this._chunks.push(chunk); this._queued += chunk.length; }
  /** 当前读位样本;空则 null(调用方判 underrun)。 */
  head() {
    const c = this._chunks[0];
    if (!c || this._readIdx >= c.length) return null;
    return c[this._readIdx];
  }
  /** 插值所需的下一样本:同分片下一个 → **下一分片首样本** → null(无后继=underrun)。
   *  ★ design contract:后继缺席时 MUST NOT 访问 _chunks[1][0](否则 TypeError)。 */
  next() {
    const c = this._chunks[0];
    if (!c) return null;
    if (this._readIdx + 1 < c.length) return c[this._readIdx + 1];
    const n = this._chunks[1];
    return n && n.length > 0 ? n[0] : null;
  }
  /** 推进读位;跨整样本则 _queued--;播完的分片 shift 弹出并平移 readIdx(此处**不再**减 _queued)。 */
  advance(ratio) {
    this._frac += ratio;
    while (this._frac >= 1) {
      this._frac -= 1;
      this._readIdx += 1;
      if (this._queued > 0) this._queued -= 1;
    }
    while (this._chunks.length > 0 && this._readIdx >= this._chunks[0].length) {
      this._readIdx -= this._chunks[0].length;
      this._chunks.shift();
    }
  }
  /** 清空(flush):三状态 + 计数 MUST 同清(漏清则下轮从旧相位起播、跳过头几样本)。 */
  clear() { this._chunks = []; this._readIdx = 0; this._frac = 0; this._queued = 0; }
  /** 溢出:丢弃最旧 n 个未播样本,返回实际丢弃数。相位归零(不连续点,同 underrun 语义)。
   *  ★ 调用方(R5)MUST 先按丢弃区间给相交段打污点 —— 本方法只管数据、不碰账本。 */
  dropOldest(n) {
    let remain = Math.min(n, this._queued);
    const dropped = remain;
    while (remain > 0 && this._chunks.length > 0) {
      const avail = this._chunks[0].length - this._readIdx;
      if (avail > remain) { this._readIdx += remain; remain = 0; }
      else { remain -= avail; this._chunks.shift(); this._readIdx = 0; }
    }
    this._queued -= dropped;
    this._frac = 0;
    return dropped;
  }
}

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = INPUT_RATE / sampleRate; // 输入→输出步长(48k → 0.3333;升采样 < 1)
    this._q = new ChunkQueue();            // design contract:分片队列取代 _buf/_pos
    this._droppedSamples = 0;              // R5:溢出丢弃累计(**纯诊断**,MUST NOT 进判据)
    this._overflowWarned = false;          // 一次性闩,防持续溢出刷日志
    this._legacyPayloadWarned = false;     // 一次性闩:收到旧格式载荷(版本不一致)只报一次
    // ★ design contract(实现review):终态记录,逐 (generation, seq) 拒绝重复终态事件。
    //   终态段立即出队后同一 key 重开会再发一次(实测 core 侧同 gen/seq 重开发出两个 turn_played)。
    //   有界 FIFO,防长会话泄漏。与 core finalized 同款。
    this._finalized = [];
    this._everStarted = false; // 是否已过**首次**冷启动 preroll(drained 后保持 true,只 flush 重置)
    this._wasActive = false; // 上一 process 是否在出声(用于检测 drain 边沿回传主线程)
    this._fadeGain = 0; // R4:underrun fade 包络增益(跨 process 块)
    this._silentBlocks = 0; // R4:ring 空后连续静默块计数(达 DRAIN_CONFIRM_BLOCKS 才认定真 drain)
    // ── design contract 播放 ACK 段账本(§0.2)──
    this._writeAbs = 0;      // 会话级:累计写入 ring 的输入域 16k 样本数(单调,flushAll 不归零)
    this._generation = 0;    // 每次 flushAll 递增的代次(隔离旧代次 PCM/迟到事件)
    this._ledger = [];       // 段账本 [{generation,seq,startAbs,endAbs|null,state}];终态立即出队
    this._tombstone = false; // flushAll 后丢弃旧代次在途 PCM,直到下一 begin_turn(新轮)解除
    this._controlTurnId = null; // work item:pause/resume 控制面当前轮身份(独立于可选 ACK 账本)
    this._pausedControl = null; // {seq,pauseId,pauseContextTime};非 null 时 render 冻结且不消费 ring
    this._lastPauseId = -1; // 当前 control turn 已接受的最大 pause_id,拒绝同轮迟到旧 episode
    this._controlFadeInRemaining = 0; // resume 后对冻结点源样本淡入,只改增益、不改 ring 游标
    this._lastOutputSample = 0; // pause 淡出从上个真实输出样本续接,避免瞬时切零 click
    // Browser telemetry uses the AudioContext clock only. startAbs ties each
    // marker to the first source sample that must actually reach process().
    this._telemetryTurns = [];
    this._telemetryActiveTurnId = null;
    this._depthHistoryTimes = new Float64Array(DEPTH_HISTORY_SIZE);
    this._depthHistorySamples = new Float64Array(DEPTH_HISTORY_SIZE);
    this._depthHistoryWrite = 0;
    this._depthHistoryCount = 0;
    this._recordRingDepth(currentTime);
    // ── design contract 抗 imaging FIR(输出域;仅升采样 sampleRate>16k 才建)──
    this._fir = sampleRate > INPUT_RATE ? designLowpass(ANTI_IMAGING_FC_HZ, sampleRate, ANTI_IMAGING_TAPS) : null;
    this._firHist = new Float32Array(ANTI_IMAGING_TAPS - 1); // 跨 process 块历史(滤波前输出样本)
    this._firPrimed = false; // 首块用首输出样本预填历史(消启动瞬态)
    this._firY = new Float32Array(0);                        // applyFir 复用 scratch(音频线程零分配防 GC 卡顿)
    this._firNextHist = new Float32Array(ANTI_IMAGING_TAPS - 1); // 下块历史 scratch(固定 H)
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'flush') {
        // The main thread stamps confirmation before MessagePort delivery.
        // Preserve that boundary separately from the queue depth observed here.
        this._recordRingDepth(currentTime);
        const ringDepthAtConfirmSamples = this._ringDepthAt(d.confirm_context_time);
        const ringDepthBeforeFlushSamples = this._q.size();
        // barge-in 即时停声。★ ACK 模式(有 open 段/tombstone)委托 _flushAll:先算截断 position 发 turn_aborted、
        //   清 ring、代次++、置 tombstone。非 ACK 模式(账本空)= 纯 design contract 清 ring 行为。
        if (this._ledger.length > 0 || this._tombstone) {
          this._flushAll();
        } else {
          this._q.clear();
        }
        this._everStarted = false; // barge-in 新语境重新 preroll
        this._wasActive = false;
        this._fadeGain = 0;
        this._silentBlocks = 0;
        this._controlTurnId = null;
        this._pausedControl = null;
        this._lastPauseId = -1;
        this._controlFadeInRemaining = 0;
        this._lastOutputSample = 0;
        this._firPrimed = false; // design contract:FIR 历史重置(新语境,下段首样本重新预填)
        const ringDepthAfterFlushSamples = this._q.size();
        this._reportConfirmedFlush(
          d,
          ringDepthAtConfirmSamples,
          ringDepthBeforeFlushSamples,
          ringDepthAfterFlushSamples,
        );
        this._resetRingDepthHistory(currentTime);
        // Any unresolved render marker belongs to the discarded source stream.
        this._telemetryTurns = [];
        this._telemetryActiveTurnId = null;
        return;
      }
      if (d && d.type === 'control_begin_turn') {
        const seq = d.seq;
        if (Number.isSafeInteger(seq) && seq >= 0 &&
            (this._controlTurnId == null || seq > this._controlTurnId)) {
          const silenceStarted = this._pausedControl?.silenceStarted === true;
          this._controlTurnId = seq;
          this._pausedControl = null;
          this._lastPauseId = -1;
          this._controlFadeInRemaining = silenceStarted ? FADE_SAMPLES : 0;
        }
        return;
      }
      if (d && d.type === 'control_end_turn') {
        if (d.seq === this._controlTurnId) {
          const silenceStarted = this._pausedControl?.silenceStarted === true;
          this._controlTurnId = null;
          this._pausedControl = null;
          this._lastPauseId = -1;
          this._controlFadeInRemaining = silenceStarted ? FADE_SAMPLES : 0;
        }
        return;
      }
      if (d && d.type === 'pause_turn') {
        const pauseId = d.pause_id;
        const pauseContextTime = d.pause_context_time;
        if (Number.isSafeInteger(d.seq) && d.seq === this._controlTurnId &&
            Number.isSafeInteger(pauseId) && pauseId >= 0 &&
            typeof pauseContextTime === 'number' && Number.isFinite(pauseContextTime) &&
            pauseContextTime >= 0) {
          if (this._pausedControl) {
            // 同 episode 重复 pause 幂等；不同 pause 在尚未 resume 前乱序到达,均不替换当前冻结身份。
            if (pauseId === this._pausedControl.pauseId) return;
          } else if (pauseId > this._lastPauseId) {
            this._lastPauseId = pauseId;
            this._pausedControl = {
              seq: d.seq,
              pauseId,
              pauseContextTime,
              fadeStartSample: this._lastOutputSample,
              fadeRemaining: this._lastOutputSample === 0 ? 0 : FADE_SAMPLES,
              silenceStarted: false,
              silenceReported: false,
            };
            this._controlFadeInRemaining = 0;
          }
        }
        return;
      }
      if (d && d.type === 'resume_turn') {
        if (this._pausedControl &&
            d.seq === this._pausedControl.seq &&
            d.pause_id === this._pausedControl.pauseId) {
          const silenceStarted = this._pausedControl.silenceStarted;
          this._pausedControl = null;
          this._controlFadeInRemaining = silenceStarted ? FADE_SAMPLES : 0;
        }
        return;
      }
      if (d && d.type === 'telemetry_begin_turn') { this._telemetryBeginTurn(d); return; }
      if (d && d.type === 'begin_turn') { this._beginTurn(d.seq); return; } // 收 ai_audio_start(轮级 seq)
      if (d && d.type === 'end_turn') { this._endTurn(d.seq); return; }     // 收 ai_audio_end(轮封口=onAiDone)
      // ★ design contract:音频分片载荷是**已归一的 Float32Array**(归一移到主线程,worklet 只接收所有权
      //   → push 真零分配)。主线程用 postMessage(msg, [samples.buffer]) transferable 转移。
      if (d instanceof Float32Array && d.length > 0) { this._pushFloat(d); return; }
      // ★ 兼容/fail-soft(design contract):旧格式裸 int16 ArrayBuffer —— 新旧文件缓存不一致时(backend
      //   StaticFiles 不发 cache-control、worklet 无文件名指纹)可能收到旧载荷。就地转换而非丢弃,
      //   保证"旧 Exam.tsx + 新 worklet"仍能出声;MUST NOT 抛异常使播放节点失效。
      //   ★ 实现review:该路径每帧多一次 Float32Array 分配、且与"忽略未预期载荷"的
      //     契约有张力 → **保留**(缓存不一致是真实风险,静默失声比多一次分配严重得多)但改为
      //     **一次性告警**使其可观测:线上若真走到这条,说明前端文件版本不一致,需清缓存/重部署。
      if (d instanceof ArrayBuffer && d.byteLength >= 2) {
        if (!this._legacyPayloadWarned) {
          this._legacyPayloadWarned = true;
          this.port.postMessage({ type: 'legacy_payload' }); // 主线程落日志(可选消息)
        }
        this._push(new Int16Array(d));
        return;
      }
      // 其它未预期载荷:静默忽略(不抛)。
    };
  }

  /** 旧格式入口(裸 int16):就地归一后入队。仅 fail-soft 兼容路径用(生产走 _pushFloat)。 */
  _push(pcm) {
    if (this._tombstone) return;
    const chunk = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i];
      chunk[i] = v < 0 ? v / 32768 : v / 32767; // 公式逐字节不变(design contract 已排除其为杂音源)
    }
    this._pushFloat(chunk);
  }

  /** 生产入口:接收主线程 transferable 转移来的**已归一** Float32Array 分片。
   *  ★ design contract:入队 O(1)、**零分配、不触碰既有分片**(旧实现每帧全量拷贝未播缓冲 = 本 spec 根因)。 */
  _pushFloat(chunk) {
    // design contract tombstone:flushAll 后、下一 begin_turn 前丢弃旧代次在途 PCM(不入队、不推进 _writeAbs,
    //   保 renderAbs 派生一致)。防旧轮音频回灌新轮(新旧混播)。非 ACK 模式恒 false,逐字节等价 design contract。
    if (this._tombstone) return;
    const writeBefore = this._writeAbs;
    const telemetry = this._telemetryTurns.find((turn) =>
      turn.aiTurnId === this._telemetryActiveTurnId && !turn.rendered);
    if (telemetry && telemetry.firstChunkContextTime == null && telemetry.startAbs === writeBefore) {
      telemetry.firstChunkContextTime = currentTime;
    }
    if (telemetry && telemetry.firstChunkContextTime != null) telemetry.underrunActive = false;
    this._q.push(chunk);
    this._writeAbs += chunk.length; // design contract:会话级累计写入,endAbs/renderAbs 派生基线
    // 容量 backstop(病态:切标签页 → AudioContext throttle,process 停但 WS 仍推帧)。正常长回复
    // 恒不触发(design contract 已验 40/90/180s 零截断)。★ design contract:丢弃 MUST NOT 记作"听到过"。
    if (this._q.size() > RING_MAX_SAMPLES) {
      this._dropOldestWithTaint(this._q.size() - RING_MAX_SAMPLES);
    }
    this._recordRingDepth(currentTime);
  }

  /** design contract:溢出丢弃最旧 n 个未播样本 —— **先打污点再丢数据**。与 core dropOldestWithTaint 同款。
   *  丢弃区间 = [renderAbs, renderAbs+n);与之相交的 **open** 段标 tainted 并累加 taintedSamples。
   *  ⚠ MUST 只对 state==='open' 求交(评审 nit-3:已终态段可能仍在数组里,不设门会误标)。 */
  _dropOldestWithTaint(n) {
    const lo = this._renderAbs();
    const hi = lo + n;
    for (const seg of this._ledger) {
      if (seg.state !== 'open') continue;
      // 未封口段用当前写位。★ 这里用 `!= null` 而非 `??` 是**刻意的**:本文件是浏览器
      //   **直接加载的原始 JS**(不经 tsc/babel 转译),而 core 侧是 TS 会被编译 —— 故两份写法
      //   不同但行为等价(endAbs 取值域为 number|null)。实现评审曾提议统一为 `??`,
      //   因上述转译差异不采纳,勿"顺手统一"。
      const segHi = seg.endAbs != null ? seg.endAbs : this._writeAbs;
      const ovl = Math.max(0, Math.min(hi, segHi) - Math.max(lo, seg.startAbs));
      if (ovl > 0) { seg.tainted = true; seg.taintedSamples += ovl; }
    }
    const dropped = this._q.dropOldest(n);
    this._droppedSamples += dropped; // 纯诊断,MUST NOT 进判据
    this._fadeGain = 0;
    this._firPrimed = false;
    if (!this._overflowWarned) {
      this._overflowWarned = true; // 一次性闩
      this.port.postMessage({ type: 'overflow', dropped }); // 主线程可日志化(可选消息,旧主线程忽略即可)
    }
    // ★ 溢出后 MUST 就地重查完成:process 里的完成检查被 `written > 0` 门控(design contract 防误报门,不可删),
    //   而溢出会清空队列 → 后续 process 恒 written=0 → tainted 段的 turn_aborted 永远发不出去。
    this._checkCompletions();
  }

  _telemetryBeginTurn(message) {
    const aiTurnId = message.ai_turn_id;
    const markerContextTime = message.marker_context_time;
    if (!Number.isSafeInteger(aiTurnId) || aiTurnId < 0 ||
        typeof markerContextTime !== 'number' || !Number.isFinite(markerContextTime) || markerContextTime < 0) {
      return;
    }
    if (this._telemetryActiveTurnId != null && aiTurnId < this._telemetryActiveTurnId) return;
    this._telemetryActiveTurnId = aiTurnId;
    if (this._telemetryTurns.some((turn) => turn.aiTurnId === aiTurnId)) return;
    this._telemetryTurns.push({
      aiTurnId,
      markerContextTime,
      startAbs: this._writeAbs,
      firstChunkContextTime: null,
      coldAtBegin: !this._everStarted,
      underrunsBeforeFirstRender: 0,
      underrunActive: false,
      rendered: false,
      flushed: false,
    });
    if (this._telemetryTurns.length > TELEMETRY_MAX) this._telemetryTurns.shift();
  }

  _emitFirstRendered(renderStartAbs, written, renderStartContextTime) {
    if (written <= 0) return;
    const renderEndAbs = this._renderAbs();
    for (const turn of this._telemetryTurns) {
      if (turn.rendered || turn.firstChunkContextTime == null) continue;
      if (turn.startAbs > renderStartAbs && renderEndAbs <= turn.startAbs) continue;

      const inputOffset = Math.max(0, turn.startAbs - renderStartAbs);
      const outputOffset = Math.min(written - 1, Math.ceil(inputOffset / this._ratio));
      const renderContextTime = renderStartContextTime + outputOffset / sampleRate;
      turn.rendered = true;
      const message = {
        type: 'telemetry_first_rendered',
        ai_turn_id: turn.aiTurnId,
        render_context_time: renderContextTime,
        underruns_before_first_render: turn.underrunsBeforeFirstRender,
      };
      if (turn.coldAtBegin) {
        message.cold_preroll_ms =
          Math.max(0, (renderContextTime - turn.firstChunkContextTime) * 1000);
      }
      this.port.postMessage(message);
    }
  }

  _notePreRenderUnderrun() {
    for (const turn of this._telemetryTurns) {
      if (turn.rendered || turn.firstChunkContextTime == null || turn.underrunActive) continue;
      turn.underrunsBeforeFirstRender += 1;
      turn.underrunActive = true;
    }
  }

  _recordRingDepth(contextTime) {
    if (typeof contextTime !== 'number' || !Number.isFinite(contextTime) || contextTime < 0) return;
    const depth = this._q.size();
    if (this._depthHistoryCount > 0) {
      const last = (this._depthHistoryWrite + DEPTH_HISTORY_SIZE - 1) % DEPTH_HISTORY_SIZE;
      const lastTime = this._depthHistoryTimes[last];
      if (contextTime < lastTime) return;
      if (contextTime === lastTime) {
        this._depthHistorySamples[last] = depth;
        return;
      }
    }
    this._depthHistoryTimes[this._depthHistoryWrite] = contextTime;
    this._depthHistorySamples[this._depthHistoryWrite] = depth;
    this._depthHistoryWrite = (this._depthHistoryWrite + 1) % DEPTH_HISTORY_SIZE;
    if (this._depthHistoryCount < DEPTH_HISTORY_SIZE) this._depthHistoryCount += 1;
  }

  _resetRingDepthHistory(contextTime) {
    this._depthHistoryWrite = 0;
    this._depthHistoryCount = 0;
    this._recordRingDepth(contextTime);
  }

  _ringDepthAt(contextTime) {
    if (typeof contextTime !== 'number' || !Number.isFinite(contextTime) ||
        contextTime < 0 || this._depthHistoryCount === 0) {
      return null;
    }
    const oldest =
      (this._depthHistoryWrite + DEPTH_HISTORY_SIZE - this._depthHistoryCount) %
      DEPTH_HISTORY_SIZE;
    let havePrevious = false;
    let previousTime = 0;
    let previousDepth = 0;
    for (let i = 0; i < this._depthHistoryCount; i++) {
      const index = (oldest + i) % DEPTH_HISTORY_SIZE;
      const time = this._depthHistoryTimes[index];
      const depth = this._depthHistorySamples[index];
      if (time <= contextTime) {
        havePrevious = true;
        previousTime = time;
        previousDepth = depth;
        continue;
      }
      if (!havePrevious) return null;
      const span = time - previousTime;
      if (span <= 0) return previousDepth;
      const fraction = (contextTime - previousTime) / span;
      return Math.max(0, previousDepth + (depth - previousDepth) * fraction);
    }
    return havePrevious ? previousDepth : null;
  }

  _reportConfirmedFlush(
    message,
    ringDepthAtConfirmSamples,
    ringDepthBeforeFlushSamples,
    ringDepthAfterFlushSamples,
  ) {
    const aiTurnId = message.ai_turn_id;
    const confirmContextTime = message.confirm_context_time;
    if (!Number.isSafeInteger(aiTurnId) || aiTurnId < 0 ||
        typeof confirmContextTime !== 'number' || !Number.isFinite(confirmContextTime) ||
        confirmContextTime < 0) {
      return;
    }
    const turn = this._telemetryTurns.find((candidate) => candidate.aiTurnId === aiTurnId);
    if (!turn || turn.flushed) return;
    turn.flushed = true;
    const flushContextTime = currentTime;
    const event = {
      type: 'telemetry_flushed',
      ai_turn_id: aiTurnId,
      flush_context_time: flushContextTime,
      browser_ring_depth_before_flush_ms:
        (ringDepthBeforeFlushSamples / INPUT_RATE) * 1000,
      browser_ring_depth_after_flush_ms:
        (ringDepthAfterFlushSamples / INPUT_RATE) * 1000,
    };
    if (ringDepthAtConfirmSamples != null) {
      event.browser_ring_depth_at_confirm_ms =
        (ringDepthAtConfirmSamples / INPUT_RATE) * 1000;
    }
    this.port.postMessage(event);
  }

  // 队列里还能产出的输出样本数(末样本需下一样本才能插值,故 -1)。O(1)。
  _available() {
    const inRemain = this._q.size() - 1;
    return inRemain <= 0 ? 0 : Math.floor(inRemain / this._ratio);
  }

  // design contract:对 out[0,len) 就地过抗 imaging 低通 FIR(输出域,因果流式,跨 process 块保历史)。与 core applyFir 同款。
  //   首块用首输出样本预填历史(消启动瞬态);对称 FIR 常数群延迟 (taps-1)/2≈0.3ms@48k(纯延迟不改音质,不做中心对齐)。
  _applyFir(out, len) {
    if (len <= 0) return;
    const h = this._fir;
    const taps = h.length;
    const H = taps - 1;
    const hist = this._firHist;
    if (!this._firPrimed) { hist.fill(out[0]); this._firPrimed = true; }
    // ★ design contract(实现review):原用 `const ext = (k) => ...` 闭包索引 ——
    //   那是**音频线程每块一次的分配**。已内联为直接分支索引,消掉该闭包。
    //   语义不变:ext(k) = k < H ? hist[k] : out[k - H](即 [hist(H), out[0..len)] 的拼接视图)。
    const nextHist = this._firNextHist; // 复用 scratch(音频线程零分配)
    for (let j = 0; j < H; j++) { const src = len - H + j; nextHist[j] = src >= 0 ? out[src] : hist[H + src]; }
    if (this._firY.length < len) this._firY = new Float32Array(len); // quantum 恒定 → 仅首块一次
    const y = this._firY;
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

  // renderAbs:**读游标已推进到的会话级源流位置**(输入域 16k 样本)= 累计写入 − 队列内未播样本。
  // ★ design contract **单一定义**(第 2 轮 review 正解):MUST NOT 出现第二个定义。曾试过再减
  //   droppedSamples,实测致「溢出后新段永不完成」(丢 500 则永久差 499);不减又会把丢弃样本记作已渲染。
  //   正解 = 坐标只表达读游标事实,「丢弃没被听到」由**段级污点**表达(见 _dropOldestWithTaint)。
  // ★ 保持**派生**(非独立计数器,与 LiveKit pushed_duration − queued_duration 同构):flush 清队列后
  //   renderAbs 自然 = writeAbs(与新轮 startAbs 同基线),两坐标永不发散。
  _renderAbs() {
    return this._writeAbs - this._q.size();
  }

  _beginTurn(seq) {
    this._tombstone = false; // 新轮到 → 旧代次 PCM 不再来,恢复入 ring
    if (this._ledger.some((s) => s.seq === seq && s.state === 'open')) return; // 幂等/防重
    this._ledger.push({ generation: this._generation, seq, startAbs: this._writeAbs, endAbs: null,
      state: 'open', tainted: false, taintedSamples: 0, rendered: false }); // design contract 污点 + R7 rendered
    if (this._ledger.length > LEDGER_MAX) this._ledger.shift(); // 病态保护:丢最旧
  }

  _endTurn(seq) {
    const seg = this._ledger.find((s) => s.seq === seq && s.state === 'open');
    if (!seg) return; // end-before-start / 未知 seq:fail-soft
    seg.endAbs = this._writeAbs;
    // M6:封口的**极短段**(< PREROLL_SAMPLES)——若整轮 < 120ms,preroll 门会永卡(既不播也不越界)。
    //   已封口即知全轮总量,解除首次冷启动 preroll 门放它出声。
    if (!this._everStarted && seg.endAbs - seg.startAbs < PREROLL_SAMPLES) this._everStarted = true;
    this._checkCompletions(); // R3「end 后到」:ring 早排空 → 立即 complete
  }

  /** 终态事件的**唯一出口**:按 (generation, seq) 拒绝重复(R7),fail-soft 不抛。与 core emitTerminal 同款。 */
  _emitTerminal(msg) {
    const key = msg.generation + ':' + msg.seq;
    if (this._finalized.indexOf(key) !== -1) return; // 重复终态:丢弃(worklet 内不 console 以免音频线程分配)
    this._finalized.push(key);
    if (this._finalized.length > FINALIZED_MAX) this._finalized.shift();
    this.port.postMessage(msg);
  }

  // 检查各 open 段自然播完 → postMessage turn_played;终态出队。仅实际出声(process written>0)后调用。
  _checkCompletions() {
    if (this._ledger.length === 0) return;
    const rAbs = this._renderAbs();
    const drained = this._available() === 0;
    let changed = false;
    for (let i = 0; i < this._ledger.length; i++) {
      const seg = this._ledger[i];
      if (seg.state !== 'open' || seg.endAbs == null) continue;
      const isLast = i === this._ledger.length - 1;
      const reachedByPos = rAbs >= seg.endAbs - EPS_SAMPLES;
      const reachedByDrain = drained && isLast;
      if (reachedByPos || reachedByDrain) {
        // ★ design contract:tainted 段(音频被溢出丢弃过)MUST 降级为 turn_aborted、MUST NOT 报 turn_played。
        //   positionMs 只计真实播出量 = 段长 − taintedSamples(自然完成路径天然以 endAbs 为界,无需夹紧)。
        const segLen = seg.endAbs - seg.startAbs;
        if (seg.tainted || !seg.rendered) {
          // tainted:被溢出丢弃过 → 降级(R5)。!rendered:一个样本都没真渲染过就满足完成判据
          //   (零样本段 endAbs==startAbs / 单样本段无法插值)→ MUST NOT 报 turn_played
          //   (实现review;保守方向:多报会让服务端误推进考试游标)。
          seg.state = 'aborted';
          const played = seg.rendered ? Math.max(0, segLen - seg.taintedSamples) : 0;
          const positionMs = (played / INPUT_RATE) * 1000;
          this._emitTerminal({ type: 'turn_aborted', generation: seg.generation, seq: seg.seq, positionMs });
        } else {
          seg.state = 'complete';
          const positionMs = (segLen / INPUT_RATE) * 1000;
          this._emitTerminal({ type: 'turn_played', generation: seg.generation, seq: seg.seq, positionMs });
        }
        changed = true;
      }
    }
    if (changed) this._ledger = this._ledger.filter((s) => s.state === 'open');
  }

  // 打断/停播:原子(单 onmessage 内)——先按当前 renderAbs 为每 open 段算截断 position 发 turn_aborted,
  // 再清 ring、代次++、置 tombstone。renderAbs/writeAbs 不归零(review)。position 用清账本前快照算。
  _flushAll() {
    const rAbs = this._renderAbs();
    for (const seg of this._ledger) {
      if (seg.state !== 'open') continue;
      seg.state = 'aborted';
      // ★ design contract 第 5 条(第 4 轮 review):flush 路径 positionMs 须**两处**修正 ——
      //   ① **夹紧到 endAbs**:丢弃区间可跨越段边界 → rAbs 可能超过本段 endAbs(实测反例:段[0,1000)
      //      已播 800、丢弃[800,1100) 仅相交 200,若 flush 早于 checkCompletions 则 rAbs=1100 > endAbs,
      //      不夹紧会把超出的 100 算作本段已播 → 报 56.25ms 而实际听到 50ms);
      //   ② **扣除污点**:被丢弃的样本 MUST NOT 记作已播。
      //   注:自然完成路径公式(段长 − taintedSamples)天然以 endAbs 为界,只有本路径需夹紧。
      const upper = seg.endAbs != null ? seg.endAbs : rAbs; // `!= null` 而非 `??`:同上(未转译的原始 JS)
      const played = Math.max(0, Math.min(rAbs, upper) - seg.startAbs - seg.taintedSamples);
      const positionMs = (played / INPUT_RATE) * 1000;
      this._emitTerminal({ type: 'turn_aborted', generation: seg.generation, seq: seg.seq, positionMs });
    }
    this._ledger = [];
    this._q.clear();          // design contract:清分片队列(三状态 + queuedSamples)
    this._generation += 1;
    this._tombstone = true;
    // renderAbs/writeAbs 不归零:清队列后 renderAbs 派生 = writeAbs(与下一 begin_turn 的 startAbs 同基线)。
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0]; // mono
    if (!out) return true;
    const n = out.length;
    this._recordRingDepth(currentTime);

    // work item:tentative pause 在 render 线程冻结。只写静音,不消费 ring/相位、不推进账本、
    // 不累计 drain 静默块；首 quantum 从上个输出样本做有界淡出,仍不消费源样本。resume 后对冻结点
    // 源样本做等长淡入,只改增益、不跳样/重样,随后与未暂停基线逐样本一致。
    if (this._pausedControl) {
      out.fill(0);
      const paused = this._pausedControl;
      paused.silenceStarted = true;
      let fadedSamples = 0;
      while (fadedSamples < n && paused.fadeRemaining > 0) {
        out[fadedSamples] =
          paused.fadeStartSample * (paused.fadeRemaining / FADE_SAMPLES);
        paused.fadeRemaining -= 1;
        fadedSamples += 1;
      }
      if (!paused.silenceReported && paused.fadeRemaining === 0) {
        paused.silenceReported = true;
        this.port.postMessage({
          type: 'telemetry_paused',
          ai_turn_id: paused.seq,
          pause_id: paused.pauseId,
          pause_context_time: paused.pauseContextTime,
          silent_context_time: currentTime + fadedSamples / sampleRate,
        });
      }
      this._lastOutputSample = out[n - 1];
      this._recordRingDepth(currentTime + n / sampleRate);
      return true;
    }

    // preroll:**仅首次冷启动**等 ring 攒够 PREROLL_SAMPLES 再开播(抗跨境首包抖动);期间输出静音。
    // ★ 评审(review):drained 后**不重置** _everStarted → 后续句(AI 说→停→再说)push
    //   首分片即出声,不再每句等 120ms preroll(否则快问快答「慢半拍」)。只有 flush(barge-in,新语境)
    //   才重置 _everStarted 回到需 preroll 态。preroll 期 _wasActive 恒 false → drained 判据不误触发。
    if (!this._everStarted) {
      const avail16k = this._q.size(); // design contract:未播样本数(O(1))
      if (avail16k < PREROLL_SAMPLES) {
        out.fill(0);
        this._lastOutputSample = 0;
        this._recordRingDepth(currentTime + n / sampleRate);
        return true;
      }
      this._everStarted = true;
    }

    const renderStartAbs = this._telemetryTurns.length > 0 ? this._renderAbs() : 0;
    const renderStartContextTime = this._telemetryTurns.length > 0 ? currentTime : 0;
    // R4:underrun 边界 fade 包络(消中段咔哒)。step = 每样本增量;预判即将 underrun → 淡出,有充足数据 → 淡入。
    const step = 1 / FADE_SAMPLES;
    let written = 0;
    let underran = false;
    for (let i = 0; i < n; i++) {
      // design contract:队头样本 + 插值所需的下一样本(可跨分片取下一分片首样本);任一缺席 → 欠载。
      const a = this._q.head();
      const b = a === null ? null : this._q.next();
      if (a === null || b === null) {
        // 欠载:剩余静音,停止推进(相位停此等 push 续)。fadeGain 归 0(下次有数据从 0 淡入,无突跳)。
        this._fadeGain = 0;
        for (let k = i; k < n; k++) out[k] = 0;
        underran = true;
        break;
      }
      const frac = this._q.phase();
      const sample = a * (1 - frac) + b * frac;
      // R4:队列剩余可播输出样本 < FADE 窗 → 目标 0(提前淡出);否则目标 1(淡入)。
      // ★ design contract:`q.size()-1-frac` 等价于旧实现的 `buf.length-1-pos`
      //   (tools/verify-chunk-queue-equivalence.mjs 已逐样本验证该等价关系)。
      const remainOut = (this._q.size() - 1 - frac) / this._ratio;
      const target = remainOut <= FADE_SAMPLES ? 0 : 1;
      if (this._fadeGain < target) this._fadeGain = Math.min(target, this._fadeGain + step);
      else if (this._fadeGain > target) this._fadeGain = Math.max(target, this._fadeGain - step);
      out[i] = sample * this._fadeGain;
      written++;
      this._q.advance(this._ratio); // 推进读位 + 弹出播完分片(queuedSamples 内部同步)
    }
    // design contract:升采样后在输出域过抗 imaging 低通(消线性插值镜像=每句起句杂音)。
    if (this._fir) {
      // ★ 评审 复审 Blocker 1:欠载时滤**全块** [0,n)(含 fade 零尾),让 FIR 把淡出信号平滑 ring-out 进零尾,
      //   消 FIR 群延迟与 fade 硬切的交互跳变(只滤 [0,written) 会放大边界跳变)。非欠载 written===n 等价。
      this._applyFir(out, underran ? n : written);
      // ★ review④:欠载是不连续点(fade 已归 0)→ FIR 历史也须重置,否则恢复首块用欠载前旧历史
      //   卷积新音频引入恢复瞬态。与 fade「下段从 0 淡入」同语义。
      if (underran) this._firPrimed = false;
    }
    if (this._controlFadeInRemaining > 0 && written > 0) {
      const fadeLength = Math.min(written, this._controlFadeInRemaining);
      for (let i = 0; i < fadeLength; i++) {
        const gain =
          1 - (this._controlFadeInRemaining - 1) / FADE_SAMPLES;
        out[i] *= gain;
        this._controlFadeInRemaining -= 1;
      }
    }
    this._lastOutputSample = out[n - 1];
    // design contract:分片队列自带回收(advance 内 shift 播完的分片)—— 旧实现的 subarray 前缀回收整体消失。
    this._recordRingDepth(currentTime + n / sampleRate);

    if (this._telemetryTurns.length > 0) {
      this._emitFirstRendered(renderStartAbs, written, renderStartContextTime);
      if (underran && written === 0) this._notePreRenderUnderrun();
    }

    // design contract:仅**实际出声(written>0,renderAbs 真推进)**后判轮完成;underrun(written=0)不推进不判
    //   (review:靠服务端 R5 timeout 覆盖网络永慢,不误报「排空即完成」)。账本空则惰性跳过。
    if (written > 0) {
      // ★ design contract:标记"本段真渲染过样本" —— 供 _checkCompletions 区分「播完」与
      //   「零/单样本段让判据天然成立」(实现review:零样本段会发假 turn_played)。
      for (const seg of this._ledger) if (seg.state === 'open') seg.rendered = true;
      this._checkCompletions();
    }

    // ★★ 真正 drain vs 瞬时 underrun(修"两句叠一起"根因):长回复中段 ring 追空(跨境 TTS 还在生成)是
    //   **瞬时 underrun**,不等于「本轮播完」。若此时就发 drained → 主线程 playbackActive 翻 false →
    //   design contract user-final 停播 / detectBargeIn 判据误读「没在播」跳过 flush → 旧轮缓冲音频串进新轮 = 重叠。
    //   故:ring 空后累计**连续静默块**,达 DRAIN_CONFIRM_BLOCKS(~300ms)才认定真正 drain 并发 drained。
    //   瞬时 underrun(几十 ms 内续上数据)不发 drained → playbackActive 保持 true → 停播判据正确。
    // ★ design contract:drained 与 turn_played **解耦**(review)——drained 只驱动主线程 playbackActive/UI,
    //   **不触发任何单轮 ACK**;单轮 ACK 只由上方 turn_played/turn_aborted 驱动。未协商时仍照发 drained。
    const activeNow = written > 0;
    if (activeNow) {
      this._silentBlocks = 0; // 出声 → 重置静默计数
      this._wasActive = true;
    } else if (this._wasActive) {
      // 曾出声、本块无输出(underrun/播完)→ 累计静默块
      this._silentBlocks += 1;
      if (this._silentBlocks >= DRAIN_CONFIRM_BLOCKS) {
        this.port.postMessage({ type: 'drained' }); // 确认真正播完(持续静默),驱动 aiSpeaking 转在听
        this._wasActive = false;
        this._silentBlocks = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-playback', PcmPlaybackProcessor);
