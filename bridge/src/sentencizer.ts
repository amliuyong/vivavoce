/**
 * 流式分句器:把 LLM 的 token 流按句末标点切成短句,供 TTS 流式合成(design contract:
 * "Bridge 按分句边界攒短句下发 GPU TTS",全流式、不等整段)。
 *
 * 规则:遇到句末标点(。!?；…、中文逗号 兼顾自然停顿)即吐一句;flush() 吐残留。
 * 设计成无状态可注入,便于单测。
 */

const SENTENCE_END = /[。！？!?；;…]/;
const SOFT_BREAK = /[，,]/; // 软停顿:句太长时也可在此切,降低首音延迟
const MAX_CHARS_BEFORE_SOFT_FLUSH = 18;

export class Sentencizer {
  private buf = "";

  /** 喂一段 token 文本,返回此次产生的完整短句(可能 0~N 句)。 */
  push(token: string): string[] {
    this.buf += token;
    const out: string[] = [];
    let cut = this.findCut();
    while (cut > 0) {
      out.push(this.buf.slice(0, cut).trim());
      this.buf = this.buf.slice(cut);
      cut = this.findCut();
    }
    return out.filter((s) => s.length > 0);
  }

  /** 流结束:吐出残留(最后一句可能无句末标点)。 */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest.length > 0 ? [rest] : [];
  }

  reset(): void {
    this.buf = "";
  }

  /** 返回应切断的位置(含标点),0 表示暂不切。 */
  private findCut(): number {
    for (let i = 0; i < this.buf.length; i++) {
      if (SENTENCE_END.test(this.buf[i])) {
        return i + 1; // 含句末标点
      }
    }
    // 软停顿:积累过长时在逗号处提前切,降低 TTS 首音延迟
    if (this.buf.length >= MAX_CHARS_BEFORE_SOFT_FLUSH) {
      for (let i = MAX_CHARS_BEFORE_SOFT_FLUSH - 1; i < this.buf.length; i++) {
        if (SOFT_BREAK.test(this.buf[i])) {
          return i + 1;
        }
      }
    }
    return 0;
  }
}
