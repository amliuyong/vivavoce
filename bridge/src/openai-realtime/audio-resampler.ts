const FILTER_CUTOFF_HZ = 7_200;
const FILTER_HALF_WIDTH = 64;
const KAISER_BETA = 8.6;
const LEFT_OFFSET = -FILTER_HALF_WIDTH + 1;
const RIGHT_OFFSET = FILTER_HALF_WIDTH;

export interface StreamingPcmResamplerOptions {
  mode?: "lookahead" | "causal";
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function besselI0(value: number): number {
  let sum = 1;
  let term = 1;
  const quarter = (value * value) / 4;
  for (let index = 1; index < 32; index += 1) {
    term *= quarter / (index * index);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-12) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function clampInt16(value: number): number {
  if (value > 32_767) return 32_767;
  if (value < -32_768) return -32_768;
  return Math.round(value);
}

function encodePcm(samples: number[]): Buffer {
  const output = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    output.writeInt16LE(clampInt16(samples[index]), index * 2);
  }
  return output;
}

/**
 * Fixed-coefficient mono s16le resampler for the Realtime 24 kHz wire seam.
 * Lookahead mode delays the symmetric kernel until future input is available.
 * Causal mode shifts the same support into the past, preserving its response
 * with fixed group delay while ensuring future input cannot change sent PCM.
 * Both modes are independent of JSON/audio chunk boundaries.
 */
export class StreamingPcmResampler {
  private readonly passthrough: boolean;
  private readonly phaseCount: number;
  private readonly phaseKernels: readonly number[][];
  private readonly causal: boolean;
  private readonly leftOffset: number;
  private readonly rightOffset: number;
  private readonly kernelDelay: number;
  readonly tailOutputSamples: number;
  private samples: number[] = [];
  private bufferStart = 0;
  private inputSampleCount = 0;
  private outputSampleCount = 0;
  private finalized = false;

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
    options: StreamingPcmResamplerOptions = {},
  ) {
    if (!Number.isInteger(fromRate) || fromRate <= 0 || !Number.isInteger(toRate) || toRate <= 0) {
      throw new RangeError("sample rates must be positive integers");
    }
    this.passthrough = fromRate === toRate;
    this.causal = options.mode === "causal";
    this.kernelDelay = this.causal ? RIGHT_OFFSET : 0;
    this.leftOffset = LEFT_OFFSET - this.kernelDelay;
    this.rightOffset = RIGHT_OFFSET - this.kernelDelay;
    this.phaseCount = toRate / gcd(fromRate, toRate);
    this.phaseKernels = this.passthrough ? [] : this.designPhaseKernels();
    this.tailOutputSamples = this.passthrough ? 0 : this.deriveTailOutputSamples();
  }

  push(pcm: Buffer): Buffer {
    if (this.finalized) throw new Error("resampler must be reset after finalize");
    if (pcm.length % 2 !== 0) throw new RangeError("PCM16 input must contain an even byte count");
    if (pcm.length === 0) return Buffer.alloc(0);
    if (this.passthrough) {
      this.inputSampleCount += pcm.length / 2;
      this.outputSampleCount += pcm.length / 2;
      return pcm;
    }

    for (let offset = 0; offset < pcm.length; offset += 2) {
      this.samples.push(pcm.readInt16LE(offset));
    }
    this.inputSampleCount += pcm.length / 2;
    return this.produce(false);
  }

  finalize(): Buffer {
    if (this.finalized) return Buffer.alloc(0);
    this.finalized = true;
    if (this.passthrough) return Buffer.alloc(0);
    return this.produce(true);
  }

  reset(): void {
    this.samples = [];
    this.bufferStart = 0;
    this.inputSampleCount = 0;
    this.outputSampleCount = 0;
    this.finalized = false;
  }

  private designPhaseKernels(): readonly number[][] {
    const cutoff = Math.min(FILTER_CUTOFF_HZ / this.fromRate, 0.5);
    const windowDenominator = besselI0(KAISER_BETA);
    return Array.from({ length: this.phaseCount }, (_, phase) => {
      const fraction = phase / this.phaseCount;
      const kernel: number[] = [];
      for (let offset = this.leftOffset; offset <= this.rightOffset; offset += 1) {
        const distance = offset + this.kernelDelay - fraction;
        const normalizedDistance = Math.abs(distance) / FILTER_HALF_WIDTH;
        const window =
          normalizedDistance > 1
            ? 0
            : besselI0(
                KAISER_BETA * Math.sqrt(Math.max(0, 1 - normalizedDistance * normalizedDistance)),
              ) / windowDenominator;
        kernel.push(2 * cutoff * sinc(2 * cutoff * distance) * window);
      }
      const gain = kernel.reduce((sum, coefficient) => sum + coefficient, 0);
      return kernel.map((coefficient) => coefficient / gain);
    });
  }

  private deriveTailOutputSamples(): number {
    const boundaryPeriod = this.fromRate / gcd(this.fromRate, this.toRate);
    const baseBoundary = Math.max(Math.abs(this.leftOffset), this.rightOffset) * 4;
    let maximumTail = 0;

    for (let boundaryOffset = 0; boundaryOffset < boundaryPeriod; boundaryOffset += 1) {
      const boundary = baseBoundary + boundaryOffset;
      let outputIndex = Math.max(
        0,
        Math.floor(((boundary - this.rightOffset) * this.toRate) / this.fromRate) - 4,
      );
      while (this.outputCenter(outputIndex) + this.rightOffset < boundary) {
        outputIndex += 1;
      }
      const firstPendingOutput = outputIndex;
      while (this.outputDependsOnInputBefore(outputIndex, boundary)) {
        outputIndex += 1;
      }
      maximumTail = Math.max(maximumTail, outputIndex - firstPendingOutput);
    }
    return maximumTail;
  }

  private outputDependsOnInputBefore(outputIndex: number, boundary: number): boolean {
    const center = this.outputCenter(outputIndex);
    const kernel = this.phaseKernels[this.outputPhase(outputIndex)];
    return kernel.some(
      (coefficient, kernelIndex) =>
        coefficient !== 0 && center + this.leftOffset + kernelIndex < boundary,
    );
  }

  private outputCenter(outputIndex: number): number {
    return Math.floor((outputIndex * this.fromRate) / this.toRate);
  }

  private outputPhase(outputIndex: number): number {
    const numerator = outputIndex * this.fromRate;
    return (
      Math.round(
        ((numerator % this.toRate) * this.phaseCount) / this.toRate,
      ) % this.phaseCount
    );
  }

  private produce(flush: boolean): Buffer {
    const targetCount = flush || this.causal
      ? Math.round((this.inputSampleCount * this.toRate) / this.fromRate)
      : Number.POSITIVE_INFINITY;
    const output: number[] = [];

    while (this.outputSampleCount < targetCount) {
      const center = this.outputCenter(this.outputSampleCount);
      if (!flush && center + this.rightOffset >= this.inputSampleCount) break;
      const phase = this.outputPhase(this.outputSampleCount);
      const kernel = this.phaseKernels[phase];
      let value = 0;
      for (let offset = this.leftOffset; offset <= this.rightOffset; offset += 1) {
        value += this.readSample(center + offset) * kernel[offset - this.leftOffset];
      }
      output.push(value);
      this.outputSampleCount += 1;
    }

    this.discardConsumedInput();
    return encodePcm(output);
  }

  private readSample(absoluteIndex: number): number {
    if (absoluteIndex < 0 || absoluteIndex >= this.inputSampleCount) return 0;
    const localIndex = absoluteIndex - this.bufferStart;
    return localIndex >= 0 && localIndex < this.samples.length ? this.samples[localIndex] : 0;
  }

  private discardConsumedInput(): void {
    const nextCenter = this.outputCenter(this.outputSampleCount);
    const retainFrom = Math.max(0, nextCenter + this.leftOffset);
    const discard = Math.min(this.samples.length, retainFrom - this.bufferStart);
    if (discard <= 0) return;
    this.samples.splice(0, discard);
    this.bufferStart += discard;
  }
}
