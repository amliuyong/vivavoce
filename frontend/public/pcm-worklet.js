// PCM 采集 AudioWorkletProcessor(M1-C,替换 ScriptProcessor):
// 输入 128 帧 float32(ctx 采样率,通常 48k)→ 累积 → 线性插值重采样到 16k → int16 →
// port.postMessage(ArrayBuffer, transfer)。主线程侧(Exam.tsx)收到后经 WS binary 直发实时会话服务。
// 运行在 AudioWorkletGlobalScope:`sampleRate` 是全局(= AudioContext 采样率),无 DOM/window。
const TARGET_RATE = 16000;
// 每 ~20ms(16k × 0.02 = 320 样本)出一包:与服务端 20ms 帧粒度对齐,消息频率适中(≈50/s)。
const MIN_CHUNK = 320;

class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / TARGET_RATE; // 输入→16k 抽取步长(48k → 3.0)
    this._buf = new Float32Array(0); // 未消费的输入样本(跨 process 块累积)
    this._pos = 0; // 相对 _buf 起点的分数读取位置(保持跨块相位连续,不逐块取整漂移)
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; // mono:多声道只取第 0 声道
    if (!ch || ch.length === 0) return true;
    // 累积输入(128 帧/块,量太小,先攒够再出包)
    const merged = new Float32Array(this._buf.length + ch.length);
    merged.set(this._buf, 0);
    merged.set(ch, this._buf.length);
    this._buf = merged;

    // 线性插值需要 idx+1,故可产出样本数按 (len-1-pos)/ratio 计
    const maxOut = Math.floor((this._buf.length - 1 - this._pos) / this._ratio);
    if (maxOut < MIN_CHUNK) return true;

    const out = new Int16Array(maxOut);
    let pos = this._pos;
    for (let i = 0; i < maxOut; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      let v = this._buf[idx] * (1 - frac) + this._buf[idx + 1] * frac;
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      out[i] = v < 0 ? v * 32768 : v * 32767;
      pos += this._ratio;
    }
    // 丢弃已消费的输入,保留分数相位
    const consumed = Math.floor(pos);
    this._buf = this._buf.subarray(consumed);
    this._pos = pos - consumed;
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorkletProcessor);
