/**
 * 流式线性重采样(design contract 媒体面回灌)。
 *
 * 为什么需要:引擎下行 TTS 是 **24k mono s16le**(三段式 GPU 出 24k),但客户端播放/录音
 * 统一走 **16k**。24k 字节当 16k 播 → 1.5× 变速、音调上移
 * (B1 真机第一通就暴露)。这里在回灌前把 24k 下采样到 16k;录音器同样吃 16k(B2)。
 *
 * 实现:**有状态**线性插值(跨 chunk 连续)。每次 process 把上一块的最后一个样本作为虚拟索引 -1
 * 参与首样本插值,并把读取位置的小数余量带到下一块 —— 避免每块独立重采样在块边界引入断点/爆音。
 * 线性插值对语音质量足够(电话窄带),未做抗混叠低通(MVP 取舍,真机听感可接受;如需更干净再加 FIR)。
 *
 * fromRate === toRate 时零开销直通(返回原 Buffer)。
 */

function clamp16(v: number): number {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}

// ── design contract:抗混叠低通(消降采样杂音)──
// 降采样(24k→16k)前必须低通滤除 ≥ 目标 Nyquist(8kHz)的频率,否则高频混叠折回带内成杂音
// (数值实证:10kHz 正弦不低通 → 16k 端 6kHz 混叠像能量 8249;加低通降到 ~1)。windowed-sinc FIR + 汉明窗。
// env 在**构造时**读(非模块加载时):便于测试逐例切换 + 生产每会话新建 Resampler 时取当时配置。
/**
 * 抗混叠默认值(design contract:**单一事实源**;registry / `/config` MUST import,勿另抄)。
 * 数值系 design contract 真机标定:taps=47 收窄主瓣、fc=7200 留 800Hz 过渡带(详见各解析器注释)。
 */
export const ANTIALIAS_DEFAULTS = { on: true, fcHz: 7200, taps: 47 } as const;

export function antialiasOn(): boolean {
  return process.env.AIM_TTS_ANTIALIAS !== "0"; // 默认开(ANTIALIAS_DEFAULTS.on);=0 回退纯线性(A/B)
}
export function antialiasTaps(): number {
  const raw = Number(process.env.AIM_TTS_ANTIALIAS_TAPS);
  // 奇数 taps(对称零相位群延迟 (taps-1)/2)。默认 **47**(design contract 真机残留杂音修正):
  //   taps=31 过渡带太宽,近 Nyquist(8–8.7kHz TTS 齿音带)只衰减 14–29dB → 混叠折回 7–7.5kHz 带内残留可听杂音
  //   (定标:8500→7500 混叠像 321.8 ≈ 带内 2.5%)。taps=47 收窄主瓣,同频混叠像降到 ~8.8(≈0.07%),
  //   齿音带(7kHz)仍保 7380(fc=7200 配合,不削闷)。群延迟 (47-1)/2/24000≈0.96ms,可忽略。
  const n = Number.isFinite(raw) && raw >= 3 ? Math.floor(raw) : ANTIALIAS_DEFAULTS.taps;
  return n % 2 === 0 ? n + 1 : n;
}
export function antialiasFcHz(): number {
  const raw = Number(process.env.AIM_TTS_ANTIALIAS_FC_HZ);
  // 默认 **7200**(design contract):比 8k Nyquist 留 800Hz 过渡带。配 taps=47 使 8kHz 折叠点 ~-43dB、
  //   8.5kHz(折回7.5k)~-61dB,同时 7kHz 齿音仅 -3dB(fc=7000 会把 7kHz 削到 -6dB 偏闷)。
  return Number.isFinite(raw) && raw > 0 ? raw : ANTIALIAS_DEFAULTS.fcHz;
}

/** windowed-sinc 低通 FIR 系数(汉明窗,DC 增益归一化=1,不改音量)。fc/sr 为截止/采样率。 */
function designLowpass(taps: number, fcHz: number, srHz: number): number[] {
  const h: number[] = [];
  const M = taps - 1;
  const wc = (2 * Math.PI * fcHz) / srHz;
  for (let n = 0; n < taps; n++) {
    const k = n - M / 2;
    const sinc = k === 0 ? wc / Math.PI : Math.sin(wc * k) / (Math.PI * k);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M); // 汉明窗
    h.push(sinc * win);
  }
  const sum = h.reduce((a, b) => a + b, 0);
  return h.map((v) => v / sum); // 归一化 DC 增益 = 1
}

export class Resampler {
  private readonly ratio: number; // 输入样本 / 输出样本 = from/to
  private readonly passthrough: boolean;
  private carry: number | null = null; // 上一块最后一个样本(下一块首样本插值用,虚拟索引 -1)
  private offset = 0; // 带到下一块的读取位置(块坐标,carry 在 -1)
  // design contract:抗混叠低通(仅降采样启用)。FIR 系数 + 跨块历史(前 taps-1 输入样本,防块边界不连续爆音)。
  private readonly lowpass: number[] | null;
  private lpHist: number[] = []; // 上一块尾部 taps-1 个输入样本(卷积历史,跨块保留)

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
  ) {
    this.ratio = fromRate / toRate;
    this.passthrough = fromRate === toRate;
    // 仅**降采样**(from > to)且开关开时启用抗混叠低通;升采样/直通不需要。截止基于**目标** Nyquist。
    this.lowpass = antialiasOn() && fromRate > toRate ? designLowpass(antialiasTaps(), antialiasFcHz(), fromRate) : null;
  }

  /** 抗混叠低通:对输入块卷积(跨块保历史)。返回滤波后的样本数组(same 长度,不改样本数)。
   *  历史 = 上一块尾 taps-1 样本(首块用 0 填充,首帧起振极短可忽略)。 */
  private applyLowpass(samples: number[]): number[] {
    const h = this.lowpass!;
    const taps = h.length;
    // ★ design contract(review):首块用**首样本**填充历史(而非零填充)——DC 连续,消首块边沿瞬态(冷启动"啵"声/
    //   RMS 抖动)。稳态块 lpHist 已是上块尾部真实样本。
    if (this.lpHist.length === 0 && samples.length > 0) {
      this.lpHist = new Array(taps - 1).fill(samples[0]);
    }
    // 拼接历史 + 本块:卷积时每个输出样本用其前 taps-1 个输入(含历史)。
    const ext = this.lpHist.concat(samples); // 长度 = (taps-1) + samples.length
    const histLen = this.lpHist.length; // = taps-1
    const out: number[] = new Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      // 对齐:输出样本 i 对应 ext 中位置 histLen+i;FIR 取其及前 taps-1 个(因果),中心对齐补偿群延迟在 same 卷积里体现。
      let acc = 0;
      const base = histLen + i;
      for (let j = 0; j < taps; j++) {
        const k = base - j + Math.floor((taps - 1) / 2); // 中心对称:+ (taps-1)/2 使零相位对齐
        if (k >= 0 && k < ext.length) acc += ext[k] * h[j];
      }
      out[i] = acc;
    }
    // 更新历史:保留本块(**原始输入** samples)尾部 taps-1 样本供下块卷积(review:语义清晰,
    //   不依赖中间变量 ext;samples 短于 keep 时取全部,拼接首样本填充由下块的 histLen 自然处理——但稳态块
    //   samples 恒 ≥ 帧长 240 > taps-1,不触边界)。
    const keep = taps - 1;
    this.lpHist = samples.length >= keep ? samples.slice(samples.length - keep) : ext.slice(ext.length - keep);
    return out;
  }

  /** 重采样一块 PCM(s16le)。返回新 Buffer(16-bit 对齐);空输入返回空 Buffer。 */
  process(pcm: Buffer): Buffer {
    if (this.passthrough) return pcm;
    const inSamples = pcm.length >> 1; // 丢弃尾部不足 2 字节的残字节(理论上不该有)
    if (inSamples === 0) return Buffer.alloc(0);

    // design contract:抽出输入样本;降采样时**先抗混叠低通**(跨块保历史),再走原线性插值(carry/offset 逻辑不变,
    //   只是从滤波后的样本数组读)。低通不改样本数,时基/样本数契约不变(design contract)。
    //   ★ 处理顺序 + 两套跨块状态的域分离(review):
    //     pcm → inArr(原始 24k) → src=applyLowpass(inArr)(滤波后 24k;lpHist 保 inArr 尾 taps-1,原始域)
    //       → 线性插值 read(src)(carry/offset;carry=src[maxPos] 滤波后域)→ 16k 输出。
    //     lpHist(原始域,FIR 卷积历史)与 carry(滤波后域,插值历史)是两个不同域的跨块状态,勿混。
    const inArr: number[] = new Array(inSamples);
    for (let i = 0; i < inSamples; i++) inArr[i] = pcm.readInt16LE(i * 2);
    const src = this.lowpass ? this.applyLowpass(inArr) : inArr;

    const read = (idx: number): number => {
      if (idx < 0) return this.carry ?? src[0]; // 首块无 carry → 用首样本(等价零阶保持)
      const clamped = idx > inSamples - 1 ? inSamples - 1 : idx;
      return src[clamped];
    };

    const out: number[] = [];
    const maxPos = inSamples - 1;
    let pos = this.offset; // 可能为负(从 carry 起插)
    while (pos <= maxPos) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = read(i0);
      const s1 = read(i0 + 1);
      out.push(s0 + (s1 - s0) * frac);
      pos += this.ratio;
    }

    // 带状态:carry=本块最后样本(下块虚拟 -1);offset=读取位置换算到下块坐标(本块末样本 → -1)
    //   design contract:carry 用**滤波后**样本(与插值读的 src 一致,跨块连续正确)。
    this.carry = src[maxPos];
    this.offset = pos - inSamples;

    const buf = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) buf.writeInt16LE(clamp16(Math.round(out[i])), i * 2);
    return buf;
  }
}
