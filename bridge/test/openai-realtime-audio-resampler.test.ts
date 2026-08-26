import { StreamingPcmResampler } from "../src/openai-realtime/audio-resampler";

function pcm(samples: number[]): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => out.writeInt16LE(sample, index * 2));
  return out;
}

function samples(buffer: Buffer): number[] {
  return Array.from(
    { length: buffer.length / 2 },
    (_, index) => buffer.readInt16LE(index * 2),
  );
}

function resample(
  input: number[],
  fromRate: number,
  toRate: number,
  chunkSizes: number[],
  mode: "lookahead" | "causal" = "lookahead",
): number[] {
  const resampler = new StreamingPcmResampler(fromRate, toRate, { mode });
  const output: Buffer[] = [];
  let offset = 0;
  for (const size of chunkSizes) {
    if (offset >= input.length) break;
    output.push(resampler.push(pcm(input.slice(offset, offset + size))));
    offset += size;
  }
  if (offset < input.length) output.push(resampler.push(pcm(input.slice(offset))));
  output.push(resampler.finalize());
  return samples(Buffer.concat(output));
}

function sine(sampleRate: number, frequency: number, count: number): number[] {
  return Array.from(
    { length: count },
    (_, index) =>
      Math.round(20_000 * Math.sin((2 * Math.PI * frequency * index) / sampleRate)),
  );
}

function toneAmplitude(
  input: number[],
  frequency: number,
  sampleRate: number,
  trim = 512,
): number {
  const values = input.slice(trim, input.length - trim);
  const omega = (2 * Math.PI * frequency) / sampleRate;
  let real = 0;
  let imaginary = 0;
  values.forEach((value, index) => {
    real += value * Math.cos(omega * index);
    imaginary -= value * Math.sin(omega * index);
  });
  return (2 * Math.hypot(real, imaginary)) / values.length;
}

describe("StreamingPcmResampler", () => {
  it("finalizes one second of 16 kHz PCM as one second of 24 kHz PCM", () => {
    const input = Array.from(
      { length: 16_000 },
      (_, index) => Math.round(12_000 * Math.sin((2 * Math.PI * 1_000 * index) / 16_000)),
    );
    const resampler = new StreamingPcmResampler(16_000, 24_000);
    const output = Buffer.concat([
      resampler.push(pcm(input.slice(0, 7_111))),
      resampler.push(pcm(input.slice(7_111))),
      resampler.finalize(),
    ]);

    expect(Math.abs(output.length / 2 - 24_000)).toBeLessThanOrEqual(1);
  });

  it("produces the same 24 kHz to 16 kHz stream across arbitrary sample chunks", () => {
    const input = Array.from(
      { length: 24_137 },
      (_, index) =>
        Math.round(
          9_000 * Math.sin((2 * Math.PI * 997 * index) / 24_000) +
            2_000 * Math.sin((2 * Math.PI * 5_431 * index) / 24_000),
        ),
    );
    let seed = 0x730010;
    const chunkSizes = Array.from({ length: 400 }, () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return 1 + (seed % 127);
    });

    const oneShot = resample(input, 24_000, 16_000, [input.length]);
    const chunked = resample(input, 24_000, 16_000, chunkSizes);

    expect(chunked.length).toBe(oneShot.length);
    expect(chunked).toEqual(oneShot);
  });

  it.each([
    [24_000, 16_000, "lookahead"],
    [16_000, 24_000, "lookahead"],
    [24_000, 16_000, "causal"],
  ] as const)(
    "matches one-shot output across randomized %i Hz to %i Hz chunk boundaries in %s mode",
    (fromRate, toRate, mode) => {
      let seed = fromRate ^ toRate ^ 0x730073;
      const next = () => {
        seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
        return seed;
      };
      const input = Array.from({ length: 32_003 }, () => {
        const raw = next() & 0xffff;
        return raw > 32_767 ? raw - 65_536 : raw;
      });
      const chunkSizes = Array.from(
        { length: 1_200 },
        () => 1 + (next() % 73),
      );

      const oneShot = resample(input, fromRate, toRate, [input.length], mode);
      const chunked = resample(input, fromRate, toRate, chunkSizes, mode);

      expect(Math.abs(chunked.length - oneShot.length)).toBeLessThanOrEqual(1);
      expect(chunked).toEqual(oneShot);
      expect(chunked).toHaveLength(
        Math.round((input.length * toRate) / fromRate),
      );
    },
  );

  it("meets the anti-imaging and anti-alias spectral gates", () => {
    const up1k = resample(sine(16_000, 1_000, 16_000), 16_000, 24_000, [317, 89, 1_009]);
    const up6k = resample(sine(16_000, 6_000, 16_000), 16_000, 24_000, [211, 997, 43]);
    const oneKhzRatio = toneAmplitude(up1k, 1_000, 24_000) / 20_000;
    const sixKhzAmplitude = toneAmplitude(up6k, 6_000, 24_000);
    const sixKhzRatio = sixKhzAmplitude / 20_000;
    const imageRatio = toneAmplitude(up6k, 10_000, 24_000) / sixKhzAmplitude;

    expect(oneKhzRatio).toBeGreaterThanOrEqual(0.97);
    expect(oneKhzRatio).toBeLessThanOrEqual(1.03);
    expect(sixKhzRatio).toBeGreaterThan(0.9);
    expect(imageRatio).toBeLessThan(0.01);

    const down3k = resample(sine(24_000, 3_000, 24_000), 24_000, 16_000, [509, 37, 1_301]);
    const down8_5k = resample(sine(24_000, 8_500, 24_000), 24_000, 16_000, [127, 2_003, 61]);
    const aliasRatio =
      toneAmplitude(down8_5k, 7_500, 16_000) /
      toneAmplitude(down3k, 3_000, 16_000);

    expect(aliasRatio).toBeLessThan(0.005);
  });

  it("meets the input anti-alias and passband gates in causal mode", () => {
    const down1k = resample(
      sine(24_000, 1_000, 24_000),
      24_000,
      16_000,
      [317, 89, 1_009],
      "causal",
    );
    const down3k = resample(
      sine(24_000, 3_000, 24_000),
      24_000,
      16_000,
      [509, 37, 1_301],
      "causal",
    );
    const down8_5k = resample(
      sine(24_000, 8_500, 24_000),
      24_000,
      16_000,
      [127, 2_003, 61],
      "causal",
    );

    expect(toneAmplitude(down1k, 1_000, 16_000) / 20_000).toBeGreaterThanOrEqual(0.97);
    expect(toneAmplitude(down1k, 1_000, 16_000) / 20_000).toBeLessThanOrEqual(1.03);
    expect(
      toneAmplitude(down8_5k, 7_500, 16_000) /
        toneAmplitude(down3k, 3_000, 16_000),
    ).toBeLessThan(0.005);
  });

  it("derives a conservative segment tail from every 16k to 24k polyphase boundary", () => {
    for (const segmentSamples of [256, 257]) {
      const impulse = Array(segmentSamples).fill(0);
      impulse[segmentSamples - 1] = 32_000;
      const resampler = new StreamingPcmResampler(16_000, 24_000);
      const raw = samples(resampler.push(pcm(impulse)));
      const after = samples(
        Buffer.concat([
          resampler.push(pcm(Array(512).fill(0))),
          resampler.finalize(),
        ]),
      );
      const combined = [...raw, ...after];

      expect(resampler.tailOutputSamples).toBe(191);
      expect(
        combined.slice(raw.length + resampler.tailOutputSamples).every((sample) => sample === 0),
      ).toBe(true);
      expect(
        combined
          .slice(raw.length, raw.length + resampler.tailOutputSamples)
          .some((sample) => sample !== 0),
      ).toBe(true);
    }
  });

  it("bounds impulse support for every upsampling phase and adjacent short segments", () => {
    for (let segmentSamples = 1; segmentSamples <= 12; segmentSamples += 1) {
      const first = Array(segmentSamples).fill(0);
      first[segmentSamples - 1] = 32_000;
      const second = Array(13 - segmentSamples).fill(0);
      second[0] = -32_000;
      const resampler = new StreamingPcmResampler(16_000, 24_000);
      const beforeBoundary = samples(resampler.push(pcm(first)));
      const afterBoundary = samples(
        Buffer.concat([
          resampler.push(pcm(second)),
          resampler.push(pcm(Array(512).fill(0))),
          resampler.finalize(),
        ]),
      );
      const combined = [...beforeBoundary, ...afterBoundary];

      expect(
        combined
          .slice(beforeBoundary.length + resampler.tailOutputSamples)
          .every((sample) => sample === 0),
      ).toBe(true);
      expect(combined.some((sample) => sample !== 0)).toBe(true);
    }
  });

  it("keeps causal input exact across committed boundaries without resetting phase", () => {
    for (const segmentSamples of [256, 257, 258]) {
      const impulse = Array(segmentSamples).fill(0);
      impulse[segmentSamples - 1] = 32_000;
      const followingSilence = Array(512).fill(0);
      const oneShot = resample(
        [...impulse, ...followingSilence],
        24_000,
        16_000,
        [segmentSamples, followingSilence.length],
        "causal",
      );
      const resampler = new StreamingPcmResampler(24_000, 16_000, {
        mode: "causal",
      });
      const beforeCommit = resampler.push(pcm(impulse));
      const nextTurn = resampler.push(pcm(followingSilence));
      const committed = samples(
        Buffer.concat([beforeCommit, nextTurn, resampler.finalize()]),
      );

      expect(committed).toHaveLength(oneShot.length);
      expect(committed).toEqual(oneShot);
    }
  });

  it("keeps the full input timeline continuous across an explicit commit", () => {
    const first = sine(24_000, 997, 2_057);
    const second = sine(24_000, 2_113, 3_001);
    const oneShot = resample(
      [...first, ...second],
      24_000,
      16_000,
      [first.length, second.length],
      "causal",
    );
    const resampler = new StreamingPcmResampler(24_000, 16_000, {
      mode: "causal",
    });
    const beforeCommit = resampler.push(pcm(first));
    const afterCommit = resampler.push(pcm(second));
    const committed = samples(
      Buffer.concat([
        beforeCommit,
        afterCommit,
        resampler.finalize(),
      ]),
    );

    expect(committed).toHaveLength(oneShot.length);
    expect(committed).toHaveLength(
      Math.round(((first.length + second.length) * 16_000) / 24_000),
    );
    expect(committed).toEqual(oneShot);
  });

  it.each([
    [24_000, 16_000],
    [16_000, 24_000],
  ] as const)(
    "reset isolates old FIR history for %i Hz to %i Hz",
    (fromRate, toRate) => {
      const resampler = new StreamingPcmResampler(fromRate, toRate);
      const impulse = Array(257).fill(0);
      impulse[256] = 32_000;
      resampler.push(pcm(impulse));
      resampler.reset();

      const output = Buffer.concat([
        resampler.push(pcm(Array(1_024).fill(0))),
        resampler.finalize(),
      ]);
      expect(samples(output).every((sample) => sample === 0)).toBe(true);
    },
  );

  it.each([
    [24_000, 16_000],
    [16_000, 24_000],
  ] as const)(
    "keeps full-scale %i Hz to %i Hz output finite and inside PCM16",
    (fromRate, toRate) => {
      const input = Array.from(
        { length: 16_001 },
        (_, index) => (index % 2 === 0 ? 32_767 : -32_768),
      );
      const output = resample(input, fromRate, toRate, [1, 2, 3, 5, 8, 13]);

      expect(output).toHaveLength(
        Math.round((input.length * toRate) / fromRate),
      );
      for (const sample of output) {
        expect(Number.isFinite(sample)).toBe(true);
        expect(Number.isInteger(sample)).toBe(true);
        expect(sample).toBeGreaterThanOrEqual(-32_768);
        expect(sample).toBeLessThanOrEqual(32_767);
      }
    },
  );

  it("rejects unaligned PCM without consuming the stream", () => {
    const resampler = new StreamingPcmResampler(24_000, 16_000);
    expect(() => resampler.push(Buffer.from([1]))).toThrow(
      "PCM16 input must contain an even byte count",
    );
    expect(
      samples(
        Buffer.concat([
          resampler.push(pcm(Array(240).fill(1_000))),
          resampler.finalize(),
        ]),
      ),
    ).toHaveLength(160);
  });
});
