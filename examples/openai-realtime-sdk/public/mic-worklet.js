class Pcm24kMicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.input = new Float32Array(0);
    this.position = 0;
    this.output = [];
    this.step = sampleRate / 24_000;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    const combined = new Float32Array(this.input.length + channel.length);
    combined.set(this.input);
    combined.set(channel, this.input.length);
    this.input = combined;

    while (this.position + 1 < this.input.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const sample =
        this.input[index] +
        (this.input[index + 1] - this.input[index]) * fraction;
      this.output.push(
        Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767))),
      );
      this.position += this.step;
      if (this.output.length === 480) {
        const pcm = Int16Array.from(this.output);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.output = [];
      }
    }

    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.input = this.input.slice(consumed);
      this.position -= consumed;
    }
    return true;
  }
}

registerProcessor("pcm24k-microphone", Pcm24kMicrophoneProcessor);
