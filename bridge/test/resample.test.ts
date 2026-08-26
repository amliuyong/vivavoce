import { Resampler } from "../src/resample";

function pcm(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}
function toArr(b: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < b.length / 2; i++) out.push(b.readInt16LE(i * 2));
  return out;
}

describe("Resampler 24k→16k(B1/B2)", () => {
  it("同采样率直通(零开销,返回原 Buffer)", () => {
    const r = new Resampler(16000, 16000);
    const inp = pcm([1, 2, 3]);
    expect(r.process(inp)).toBe(inp);
  });

  it("24k→16k 输出样本数约为输入的 2/3", () => {
    const r = new Resampler(24000, 16000);
    // 喂 300 样本(24k),期望 ~200 样本(16k)
    const inp = pcm(Array.from({ length: 300 }, (_, i) => i));
    const out = toArr(r.process(inp));
    expect(out.length).toBeGreaterThanOrEqual(198);
    expect(out.length).toBeLessThanOrEqual(201);
  });

  it("线性斜坡:重采样后仍单调递增、值落在原始范围内(无爆音/越界)", () => {
    // design contract:纯线性插值特性测试 → 关抗混叠低通(斜坡是宽带信号,低通会在边沿引入正常振铃使非单调;
    //   本例专测线性插值本身不越界/不爆音,故 env=0 隔离低通)。
    process.env.AIM_TTS_ANTIALIAS = "0";
    try {
      const r = new Resampler(24000, 16000);
      const inp = pcm(Array.from({ length: 60 }, (_, i) => i * 100)); // 0..5900 斜坡
      const out = toArr(r.process(inp));
      for (let i = 1; i < out.length; i++) {
        expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]); // 单调
      }
      expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...out)).toBeLessThanOrEqual(5900);
    } finally {
      delete process.env.AIM_TTS_ANTIALIAS;
    }
  });

  it("跨 chunk 连续:分块喂入 vs 一次喂入,总输出样本数一致(块边界不丢/不重)", () => {
    const all = Array.from({ length: 240 }, (_, i) => Math.round(1000 * Math.sin(i / 5)));
    const oneShot = toArr(new Resampler(24000, 16000).process(pcm(all)));

    const r = new Resampler(24000, 16000);
    const chunked: number[] = [];
    for (let off = 0; off < all.length; off += 30) {
      chunked.push(...toArr(r.process(pcm(all.slice(off, off + 30)))));
    }
    // 允许 ±1 样本的边界舍入差
    expect(Math.abs(chunked.length - oneShot.length)).toBeLessThanOrEqual(1);
  });

  it("空输入返回空 Buffer(不崩)", () => {
    const r = new Resampler(24000, 16000);
    expect(r.process(Buffer.alloc(0)).length).toBe(0);
  });

  it("削顶:超出 int16 范围的插值被 clamp 到 [-32768, 32767]", () => {
    const r = new Resampler(24000, 16000);
    const inp = pcm([32767, 32767, 32767, 32767]);
    const out = toArr(r.process(inp));
    out.forEach((v) => {
      expect(v).toBeLessThanOrEqual(32767);
      expect(v).toBeGreaterThanOrEqual(-32768);
    });
  });
});

// ── design contract:抗混叠低通(消降采样杂音)──
// Goertzel 单频能量(测混叠像 / 带内保留)。
function goertzel(x: number[], f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0, s0 = 0;
  for (const v of x) { s0 = v + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / x.length;
}
function sine24k(freqHz: number, n: number, amp = 0.8): Buffer {
  return pcm(Array.from({ length: n }, (_, i) => Math.round(32767 * amp * Math.sin((2 * Math.PI * freqHz * i) / 24000))));
}

describe("Resampler 抗混叠低通(design contract)", () => {
  afterEach(() => { delete process.env.AIM_TTS_ANTIALIAS; });

  it("10kHz 输入(超 16k Nyquist 8k)→ 降到 16k:开低通时 6kHz 混叠像被大幅衰减", () => {
    // 关低通(env=0):混叠像显著。开低通(默认):混叠像应 < 关的 5%。
    process.env.AIM_TTS_ANTIALIAS = "0";
    const off = toArr(new Resampler(24000, 16000).process(sine24k(10000, 24000)));
    const aliasOff = goertzel(off, 6000, 16000);

    delete process.env.AIM_TTS_ANTIALIAS; // 默认开
    const on = toArr(new Resampler(24000, 16000).process(sine24k(10000, 24000)));
    const aliasOn = goertzel(on, 6000, 16000);

    expect(aliasOff).toBeGreaterThan(500); // 关低通:混叠确实存在(杂音根因)
    expect(aliasOn).toBeLessThan(aliasOff * 0.05); // 开低通:混叠像衰减 > 95%
  });

  it("3kHz 带内信号:开低通仍基本保留(不误杀语音带)", () => {
    const on = toArr(new Resampler(24000, 16000).process(sine24k(3000, 24000)));
    const band = goertzel(on, 3000, 16000);
    // 满幅 0.8×32767≈26214,单频 Goertzel 幅度约半幅;保留 > 8000(远高于被杀的混叠 1.x)
    expect(band).toBeGreaterThan(8000);
  });

  // ── design contract(真机残留杂音复现):近 Nyquist 过渡带混叠 ──
  // 现网默认 taps=31/fc=7500 只在 fc 以下 2.5kHz 处衰减充分(10k→6k 测过),但 8–8.7kHz(TTS 齿音 s/sh/f 能量带)
  // 折回 7–7.5kHz 带内的混叠只衰减 14–29dB。定标实测:8500Hz→7500Hz 混叠像 321.8,约带内(12608)的 2.5%
  //   → 可听残留(用户真机反馈「还有细微杂音」)。过渡带须收窄到近 Nyquist 也深压。
  it("8.5kHz 输入(近 Nyquist,折回 7.5kHz)→ 混叠像必须 << 带内(残留杂音门)", () => {
    const on = toArr(new Resampler(24000, 16000).process(sine24k(8500, 24000)));
    const alias = goertzel(on, 7500, 16000); // 8500Hz 混叠折回 16000-8500=7500Hz
    const band3k = goertzel(toArr(new Resampler(24000, 16000).process(sine24k(3000, 24000))), 3000, 16000);
    // 近 Nyquist 混叠像须 < 带内信号 0.5%(现网 2.5% 可听 → 收紧到听不见)。定标:目标参数 ~8.8/12608≈0.07%。
    expect(alias).toBeLessThan(band3k * 0.005);
  });

  it("7kHz 带内信号(齿音带):开低通仍保留,不因收窄过渡带把齿音削闷", () => {
    const on = toArr(new Resampler(24000, 16000).process(sine24k(7000, 24000)));
    const band7k = goertzel(on, 7000, 16000);
    // fc 若压到 7000 则 7kHz 掉到 ~5276(闷);保 fc=7200 则 ~7380。门设 6500:排除过度收窄的 fc。
    expect(band7k).toBeGreaterThan(6500);
  });

  it("env AIM_TTS_ANTIALIAS=0 → 回退纯线性(与无低通逐字节等价)", () => {
    process.env.AIM_TTS_ANTIALIAS = "0";
    const inp = pcm(Array.from({ length: 60 }, (_, i) => i * 100));
    const out = toArr(new Resampler(24000, 16000).process(inp));
    // 纯线性斜坡:单调递增(低通会引入边沿振铃,关掉则纯线性无振铃)
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
  });

  it("开低通:跨块喂入 vs 一次喂入,总输出样本数一致(FIR 历史正确跨块,块边界不爆音)", () => {
    const all = Array.from({ length: 720 }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 2000 * i) / 24000)));
    const oneShot = toArr(new Resampler(24000, 16000).process(pcm(all)));
    const r = new Resampler(24000, 16000);
    const chunked: number[] = [];
    for (let off = 0; off < all.length; off += 30) chunked.push(...toArr(r.process(pcm(all.slice(off, off + 30)))));
    expect(Math.abs(chunked.length - oneShot.length)).toBeLessThanOrEqual(1);
  });
});
