/**
 * design contract Phase 3:引擎轮媒体边界 seam(onTurnAudioBegin/onTurnAudioEnd)——变异自证。
 *
 * 契约(R2):
 *  - onTurnAudioBegin(turnSeq):**首个下行 binary 之前**恰一次(每轮);无音频轮不发。
 *  - onTurnAudioEnd(turnSeq):**正常完整播完(completed=true)且产生过音频**才发;被打断/异常/无音频轮不发。
 *  - 默认未接 = no-op(逐字节等价现状,已由 739 全绿覆盖)。
 */
process.env.AIM_ANSWER_GRACE_MS = "0";

import { GpuClient, WsLike } from "../src/gpu-client";
import { ThreeStageEngine as RealThreeStageEngine } from "../src/three-stage-engine";
import { LlmStreamer, LlmTurn } from "../src/bedrock-llm";
import { EngineParams } from "../src/voice-engine";

const _openEngines: RealThreeStageEngine[] = [];
class ThreeStageEngine extends RealThreeStageEngine {
  constructor(gpu: GpuClient, llm: LlmStreamer) {
    super(gpu, llm);
    _openEngines.push(this);
  }
}
beforeEach(() => {
  _openEngines.length = 0;
});
afterEach(async () => {
  for (const e of _openEngines.splice(0)) await e.stop().catch(() => undefined);
});

class FakeWs implements WsLike {
  sent: Array<{ kind: "text" | "bin"; data: string | Buffer }> = [];
  private msgCb: (data: Buffer, isBinary: boolean) => void = () => {};
  send(data: string | Buffer): void {
    this.sent.push(typeof data === "string" ? { kind: "text", data } : { kind: "bin", data });
  }
  close(): void {}
  on(event: "message" | "open" | "close" | "error", cb: (...a: never[]) => void): void {
    if (event === "message") this.msgCb = cb as never;
  }
  emitControl(obj: Record<string, unknown>): void {
    this.msgCb(Buffer.from(JSON.stringify(obj), "utf-8"), false);
  }
  /** 下行一帧 TTS 音频:tts_audio_meta(text)+ 紧跟 binary(gpu-client 成对解析 → engine.onAudio)。 */
  emitTtsAudio(seq: number): void {
    this.emitControl({ type: "tts_audio_meta", seq });
    this.msgCb(Buffer.from(new Int16Array(160).buffer), true); // 10ms@16k 裸 PCM
  }
  ttsCount(): number {
    return this.sent.filter((s) => s.kind === "text").map((s) => JSON.parse(s.data as string)).filter((m) => m.type === "tts_text").length;
  }
}

class FakeLlm implements LlmStreamer {
  turns: LlmTurn[] = [];
  constructor(private tokens: string[]) {}
  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    this.turns.push(turn);
    for (const t of this.tokens) {
      if (signal.aborted) return;
      yield t;
    }
  }
}

const QS = [{ text: "第一题:自我介绍" }, { text: "第二题:讲讲项目经历" }];
const qParams = (questions: unknown[]): EngineParams => ({ engineType: "three_stage", language: "zh-CN", questions });

async function drain(n = 16): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function makeEngine(tokens: string[]) {
  const ws = new FakeWs();
  const gpu = new GpuClient(ws, "sessTAB");
  const llm = new FakeLlm(tokens);
  const engine = new ThreeStageEngine(gpu, llm);
  engine.onTurnEvent(() => {});
  const begins: number[] = [];
  const ends: number[] = [];
  const audioOut: Buffer[] = [];
  let userTurnStarts = 0;
  engine.onTurnAudioBegin((id) => begins.push(id));
  engine.onTurnAudioEnd((id) => ends.push(id));
  engine.onUserTurnStart(() => (userTurnStarts += 1));
  engine.onAudioOut((pcm) => audioOut.push(pcm));
  return { ws, gpu, llm, engine, begins, ends, audioOut, userTurnStarts: () => userTurnStarts };
}

describe("design contract Phase 3:轮媒体边界 seam", () => {
  it("正常完整播完:begin 在首帧前恰一次,end 在播完恰一次,均带 turnSeq", async () => {
    const { ws, engine, begins, ends, audioOut } = makeEngine(["你好", "。", "[[NEXT]]"]);
    await engine.start("sessTAB", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端工程师" });
    ws.emitControl({ type: "turn_end" });
    await drain();
    const ttsN = ws.ttsCount();
    expect(ttsN).toBeGreaterThan(0);
    // 下发若干帧音频(每句一 tts_audio_meta+binary),再补 tts_done 播完
    for (let i = 0; i < ttsN; i++) ws.emitTtsAudio(i);
    // begin 必须在首帧 audioOut 之前(同步栈):此刻已有 begin,且恰一次
    expect(begins.length).toBe(1);
    expect(audioOut.length).toBeGreaterThan(0);
    expect(ends.length).toBe(0); // 尚未播完(tts_done 未齐)
    for (let i = 0; i < ttsN; i++) ws.emitControl({ type: "tts_done" });
    await drain();
    expect(ends.length).toBe(1); // 正常播完发一次 end
    expect(begins[0]).toBe(ends[0]); // 同一 turnSeq
    expect(begins[0]).toBeGreaterThan(0);
  });

  it("被打断轮(cancel barge_in):发过 begin 但 completed=false → 不发 end", async () => {
    const { ws, engine, begins, ends } = makeEngine(["你好这是一段较长的回答", "。"]);
    await engine.start("sessTAB", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端工程师" });
    ws.emitControl({ type: "turn_end" });
    await drain();
    const ttsN = ws.ttsCount();
    for (let i = 0; i < ttsN; i++) ws.emitTtsAudio(i); // 出了音频 → begin 已发
    expect(begins.length).toBe(1);
    engine.cancel("barge_in"); // 打断:completed=false
    await drain();
    expect(ends.length).toBe(0); // ★ 变异自证:被打断轮不发 end(否则客户端会误判自然播完)
  });

  it("无音频轮(kickoff LLM 空回复,一帧不下发):不发 begin 也不发 end", async () => {
    const { ws, engine, begins, ends } = makeEngine([]); // LLM 无 token → 无 tts_text → 无音频
    await engine.start("sessTAB", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端工程师" });
    ws.emitControl({ type: "turn_end" });
    await drain();
    expect(begins.length).toBe(0); // 无音频 → 无 begin
    expect(ends.length).toBe(0);   // 无音频 → 无 end
  });

  it("R5:用户驱动新轮起 → onUserTurnStart 触发(每个用户轮一次)", async () => {
    const { ws, engine, userTurnStarts } = makeEngine(["你好", "。", "[[NEXT]]"]);
    await engine.start("sessTAB", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    expect(userTurnStarts()).toBe(0); // 尚无用户轮
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端工程师" });
    ws.emitControl({ type: "turn_end" });
    await drain();
    expect(userTurnStarts()).toBe(1); // 用户轮起 → 恰一次
  });

  it("R5:kickoff 主动开场轮不触发 onUserTurnStart(非用户换话题)", async () => {
    const { engine, userTurnStarts } = makeEngine(["开场白"]);
    await engine.start("sessTAB", "你是面试官", qParams(QS));
    // kickoff 是引擎主动开场(isKickoff=true),不算用户驱动新轮
    engine.kickoff?.();
    await drain();
    expect(userTurnStarts()).toBe(0); // kickoff 不触发(豁免)
  });

  it("R5:nudge 系统指示轮不触发 onUserTurnStart(isKickoff=true 豁免)", async () => {
    const { engine, userTurnStarts } = makeEngine(["请及时作答"]);
    await engine.start("sessTAB", "你是面试官", qParams(QS));
    // nudge(沉默警告/违规通知)= 系统主动让 AI 说一句,isKickoff=true → 不算用户换话题
    engine.nudge?.("请回到问题作答");
    await drain();
    expect(userTurnStarts()).toBe(0); // nudge 不触发(豁免)
  });

  it("R5:多个用户轮各触发一次(不漏不重)", async () => {
    // 用**不含 [[NEXT]]** 的回复 → 不推进游标、不触发 auto-next(startDirectAutoNext 会占 busy 使第二轮走排水路径,
    //   属既有 auto-next 行为,与本测试无关)→ 每轮 tts_done 收齐后引擎转空闲,第二轮 turn_end 直接起新用户轮。
    const { ws, engine, userTurnStarts } = makeEngine(["请再详细说说", "。"]);
    await engine.start("sessTAB", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    // 第一轮用户作答
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端工程师" });
    ws.emitControl({ type: "turn_end" });
    await drain();
    const ttsN = ws.ttsCount();
    for (let i = 0; i < ttsN; i++) ws.emitControl({ type: "tts_done" });
    await drain();
    expect(userTurnStarts()).toBe(1);
    // 第二轮用户作答(引擎已空闲:无 [[NEXT]] → 无 auto-next 占 busy)
    ws.emitControl({ type: "asr_final", text: "第二个回答讲讲我的项目经历做过什么" });
    ws.emitControl({ type: "turn_end" });
    await drain();
    expect(userTurnStarts()).toBe(2); // 各一次,不漏不重
  });

  it("begin 严格早于首帧 audioOut(有序性:ai_audio_start 必先于 binary)", async () => {
    // 用 audioOut 回调里断言此刻 begins 已非空 —— 首帧到达时 begin 必已发。
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessTAB");
    const llm = new FakeLlm(["你好", "。", "[[NEXT]]"]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    const order: string[] = [];
    engine.onTurnAudioBegin(() => order.push("begin"));
    engine.onAudioOut(() => order.push("audio"));
    await engine.start("sessTAB", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端工程师" });
    ws.emitControl({ type: "turn_end" });
    await drain();
    ws.emitTtsAudio(0);
    expect(order[0]).toBe("begin"); // begin 在第一个 audio 之前
    expect(order.indexOf("begin")).toBeLessThan(order.indexOf("audio"));
    await engine.stop().catch(() => undefined);
  });
});
