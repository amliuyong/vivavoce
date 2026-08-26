// design contract:本文件断言的是**现状即时推进**(逐字节)语义。答完补充宽限窗默认开(4000ms)会把「已作答→
//   立即推进+下一轮换题/自动问下一题」延迟到窗到期,破坏这些同步跨轮断言。故本文件锁 AIM_ANSWER_GRACE_MS=0
//   (= 关宽限窗,spec 明确「<=0 逐字节等价现状」);宽限窗开(4000)行为由专门文件 three-stage-answer-grace.test.ts
//   用假定时器验。**MUST 在 import 引擎前设**(模块常量 ANSWER_GRACE_MS 加载期读 env;单独文件=单独模块图,与
//   grace 测试隔离,同 design contract 的 AIM_CURSOR_VOICED_GATE 模式)。
process.env.AIM_ANSWER_GRACE_MS = "0";
process.env.AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS = "1000";

import { GpuClient, WsLike } from "../src/gpu-client";
import { ThreeStageEngine as RealThreeStageEngine } from "../src/three-stage-engine";
import { LlmStreamer, LlmTurn } from "../src/bedrock-llm";
import { EngineParams } from "../src/voice-engine";

// ★ 提高本 suite 超时(jest 默认 5000ms):最慢用例(design contract 自动 terminal 并入 history)
//   本地实测 ~4.0s —— 余量仅 1s,CI runner 稍慢即超时(同 media-session-farewell-playback-tail
//   避免不同 CI runner 速度导致偶发超时。
//   慢的原因是这些用例推进虚拟时钟跨越多个 watchdog 周期,累计大量微任务,与代码正确性无关。
//   30000ms 给足余量,又远小于「真死锁」耗时,故仍能把死锁暴露为超时而非静默挂起。
jest.setTimeout(30_000);
import { EngineTurnMetrics } from "../src/turn-metrics";

// ── 测试收尾守门(CI bridge:jest 根因)──:引擎内部有真定时器(GpuClient 5s 握手看门狗 + 引擎级 12s
//    TTS 超时 + 300ms cancel_ack 核对)。真定时器测试若不收尾,jest --ci 在测试结束后定时器仍 fire →
//    晚到的 console.log/warn 触发「Cannot log after tests are done」+「worker failed to exit gracefully /
//    active timers」→ CI 失败(本地宽松不报)。这里用追踪构造器登记每个 ThreeStageEngine,afterEach 统一
//    stop()(内部 clearTtsWatchdog + clearCancelAck + gpu.end() 停握手看门狗),并兜底 clearAllTimers。
const _openEngines: RealThreeStageEngine[] = [];
// 子类化:每个 `new ThreeStageEngine(...)`(含 18 处内联 + setup)自动登记,afterEach 统一收尾。
class ThreeStageEngine extends RealThreeStageEngine {
  constructor(gpu: GpuClient, llm: LlmStreamer, aiTurnIdBase = 0) {
    super(gpu, llm, aiTurnIdBase);
    _openEngines.push(this);
  }
}
beforeEach(() => {
  _openEngines.length = 0; // 防上一个 throw 的测试残留(review)
});
afterEach(async () => {
  // 顺序(review):先恢复真定时器环境(stop() 可能调度微任务,避免在假定时器下卡住),再逐个收尾。
  jest.clearAllTimers();
  jest.useRealTimers();
  for (const e of _openEngines.splice(0)) {
    await e.stop().catch(() => undefined); // 停 LLM/GPU + 清引擎所有真定时器(clearTtsWatchdog/clearCancelAck/gpu.end)
  }
});

/** 可编程的假 WS:记录上行,允许测试注入下行 + 连接级 error/close(N2)。 */
class FakeWs implements WsLike {
  sent: Array<{ kind: "text" | "bin"; data: string | Buffer }> = [];
  private msgCb: (data: Buffer, isBinary: boolean) => void = () => {};
  private errorCb: (err: Error) => void = () => {};
  private closeCb: () => void = () => {};
  send(data: string | Buffer): void {
    this.sent.push(typeof data === "string" ? { kind: "text", data } : { kind: "bin", data });
  }
  close(): void {}
  on(event: "message" | "open" | "close" | "error", cb: (...a: never[]) => void): void {
    if (event === "message") this.msgCb = cb as never;
    else if (event === "error") this.errorCb = cb as never;
    else if (event === "close") this.closeCb = cb as never;
  }
  /** 测试驱动:模拟 WS 连接错误 / 意外断开。 */
  emitError(err: Error): void {
    this.errorCb(err);
  }
  emitClose(): void {
    this.closeCb();
  }
  /** 测试驱动:模拟 GPU 下行控制帧。 */
  emitControl(obj: Record<string, unknown>): void {
    this.msgCb(Buffer.from(JSON.stringify(obj), "utf-8"), false);
  }
  emitAudio(meta: Record<string, unknown>, pcm: Buffer): void {
    this.msgCb(Buffer.from(JSON.stringify({ type: "tts_audio_meta", ...meta }), "utf-8"), false);
    this.msgCb(pcm, true);
  }
  textsSent(): Record<string, unknown>[] {
    return this.sent.filter((s) => s.kind === "text").map((s) => JSON.parse(s.data as string));
  }
}

/** 假 LLM:产出固定 token 序列,响应 abort。 */
class FakeLlm implements LlmStreamer {
  turns: LlmTurn[] = []; // 记录每轮收到的 turn(校验历史注入)
  constructor(private tokens: string[], private onAbortCheck?: () => void) {}
  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    this.turns.push(turn);
    for (const t of this.tokens) {
      if (signal.aborted) {
        this.onAbortCheck?.();
        return;
      }
      yield t;
    }
  }
}

/** 每轮返回独立脚本，便于验证追问预算耗尽后的特殊收口轮和 terminal-completion。 */
class ScriptedLlm implements LlmStreamer {
  turns: LlmTurn[] = [];
  constructor(private replies: string[]) {}
  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    const i = this.turns.length;
    this.turns.push(turn);
    if (!signal.aborted) yield this.replies[Math.min(i, this.replies.length - 1)] ?? "";
  }
}

class FailFirstTerminalLlm implements LlmStreamer {
  turns: LlmTurn[] = [];
  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    const i = this.turns.length;
    this.turns.push(turn);
    if (i === 0) {
      yield "好的。\n[[NEXT]]";
      return;
    }
    if (i === 1) throw new Error("terminal transient failure");
    if (!signal.aborted) yield "预设问题都已聊完。还有补充吗?";
  }
}

class FailBothTerminalLlm implements LlmStreamer {
  turns: LlmTurn[] = [];
  async *stream(turn: LlmTurn): AsyncIterable<string> {
    const i = this.turns.length;
    this.turns.push(turn);
    if (i === 0) {
      yield "好的。\n[[NEXT]]";
      return;
    }
    if (i === 1 || i === 2) throw new Error("terminal persistent failure");
    yield "预设问题都聊完了。还有什么需要补充的吗?";
  }
}

class HoldFinalQuestionStreamLlm implements LlmStreamer {
  turns: LlmTurn[] = [];
  private releaseFirst!: () => void;
  private readonly firstReleased = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  release(): void {
    this.releaseFirst();
  }

  async *stream(turn: LlmTurn): AsyncIterable<string> {
    this.turns.push(turn);
    yield "先回应第一句。";
    await this.firstReleased;
    yield "这个问题我们继续聊。\n";
  }
}

class HoldFirstTurnLlm implements LlmStreamer {
  turns: LlmTurn[] = [];
  private releaseFirst!: () => void;
  private readonly firstReleased = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  release(): void {
    this.releaseFirst();
  }

  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    const i = this.turns.length;
    this.turns.push(turn);
    if (i === 0) {
      yield "好的。\n[[NEXT]]";
      await this.firstReleased;
      return;
    }
    if (!signal.aborted) yield "预设问题都聊完了。还有补充吗?";
  }
}

class HoldPiggybackTurnLlm implements LlmStreamer {
  turns: LlmTurn[] = [];
  private releaseFirst!: () => void;
  private readonly firstReleased = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  release(): void {
    this.releaseFirst();
  }

  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    const i = this.turns.length;
    this.turns.push(turn);
    if (i === 0) {
      yield "全部预设问题都聊完了。还有什么需要补充的吗?\n[[NEXT]]";
      await this.firstReleased;
      return;
    }
    if (!signal.aborted) yield "问题已经全部聊完了。你还有什么需要补充的吗?";
  }
}

class HangForceClosureAfterFirstTokenLlm implements LlmStreamer {
  turns: LlmTurn[] = [];

  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    const i = this.turns.length;
    this.turns.push(turn);
    if (i < 2) {
      yield i === 0 ? "能再展开一下吗?" : "还能具体说明吗?";
      return;
    }
    if (i === 2) {
      yield "好的";
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }
    yield "好的,这个问题我们先到这里。\n[[NEXT]]";
  }
}

class HangFirstTerminalAfterFirstTokenLlm implements LlmStreamer {
  turns: LlmTurn[] = [];

  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    const i = this.turns.length;
    this.turns.push(turn);
    if (i === 0) {
      yield "好的。\n[[NEXT]]";
      return;
    }
    if (i === 1) {
      yield "预设问题";
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }
    yield "预设问题都聊完了。还有补充吗?";
  }
}

const params: EngineParams = { engineType: "three_stage", language: "zh-CN" };

function setup(tokens: string[]) {
  const ws = new FakeWs();
  const gpu = new GpuClient(ws, "sess1");
  const llm = new FakeLlm(tokens);
  const engine = new ThreeStageEngine(gpu, llm);
  return { ws, gpu, llm, engine };
}

/** 轮询等条件成立(有界超时)。替代固定 setTimeout(ms)——慢 CI runner 上 LLM 流分句下发耗时不定,
 *  固定等待会 flaky(CI 真机:20ms 不够 → tts_text 未发出断言失败)。每 5ms 查一次,默认上限 2s。 */
async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return; // 到点放行,由调用方断言给出明确失败
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ThreeStageEngine 编排", () => {
  it("start 向 GPU 发 start 控制帧", async () => {
    const { ws, engine } = setup([]);
    await engine.start("sess1", "你是面试官", params);
    const starts = ws.textsSent().filter((m) => m.type === "start");
    expect(starts.length).toBe(1);
    expect(starts[0].engine_type).toBe("three_stage");
  });

  it("voice 透传到 GPU start.voice;缺省不下发(GPU 回退默认参考音)", async () => {
    const withVoice = setup([]);
    await withVoice.engine.start("sess1", "p", { engineType: "three_stage", language: "zh-CN", voice: "male_std" });
    expect(withVoice.ws.textsSent().find((m) => m.type === "start")?.voice).toBe("male_std");

    const noVoice = setup([]);
    await noVoice.engine.start("sess2", "p", params); // params 无 voice
    expect("voice" in (noVoice.ws.textsSent().find((m) => m.type === "start") ?? {})).toBe(false);
  });

  it("design contract:ttsProvider 透传到 GPU start.tts_provider;缺省不下发(GPU 回退默认)", async () => {
    const withProvider = setup([]);
    await withProvider.engine.start("sess1", "p", {
      engineType: "three_stage", language: "zh-CN", ttsProvider: "minimax",
    });
    expect(withProvider.ws.textsSent().find((m) => m.type === "start")?.tts_provider).toBe("minimax");

    const noProvider = setup([]);
    await noProvider.engine.start("sess2", "p", params); // params 无 ttsProvider
    expect("tts_provider" in (noProvider.ws.textsSent().find((m) => m.type === "start") ?? {})).toBe(false);
  });

  it("pushAudio 发 audio_meta + 紧跟 binary,同 seq(ready 后)", () => {
    const { ws, engine } = setup([]);
    ws.emitControl({ type: "ready" }); // §3.2:ready 握手后才直发音频
    engine.pushAudio(Buffer.alloc(320));
    const meta = ws.sent[0];
    const bin = ws.sent[1];
    expect(meta.kind).toBe("text");
    expect(JSON.parse(meta.data as string).type).toBe("audio_meta");
    expect(JSON.parse(meta.data as string).bytes).toBe(320);
    expect(JSON.parse(meta.data as string).input_epoch).toBe(0);
    expect(bin.kind).toBe("bin");
    expect((bin.data as Buffer).length).toBe(320);
  });

  it("resetInput waits for the matching GPU fence before advancing audio epoch", async () => {
    const { ws, engine } = setup([]);
    ws.emitControl({ type: "ready" });

    const reset = engine.resetInput(0, 1);
    expect(ws.textsSent().at(-1)).toMatchObject({
      type: "input_reset",
      from_input_epoch: 0,
      next_input_epoch: 1,
    });
    ws.emitControl({ type: "input_reset_ack", input_epoch: 1 });
    await reset;

    engine.pushAudio(Buffer.alloc(320), 1);
    expect(ws.textsSent().at(-1)).toMatchObject({
      type: "audio_meta",
      input_epoch: 1,
    });
  });

  it("§3.2 ready 门:ready 前的音频入队,ready 到达后按序冲刷", () => {
    const { ws, engine } = setup([]);
    // ready 前推 2 帧 → 不应有任何上行(入队)
    engine.pushAudio(Buffer.alloc(160));
    engine.pushAudio(Buffer.alloc(240));
    expect(ws.sent.length).toBe(0);
    // ready 到达 → 按序冲刷两帧(各 meta+bin)
    ws.emitControl({ type: "ready" });
    const metas = ws.textsSent().filter((m) => m.type === "audio_meta");
    expect(metas.map((m) => m.bytes)).toEqual([160, 240]); // 保序
    expect(ws.sent.filter((s) => s.kind === "bin").length).toBe(2);
  });

  it("§3.2 ready 前音频入队有上限(FIFO 丢最老帧防 OOM,review),冲刷不超 500 帧", () => {
    const { ws, engine } = setup([]);
    // ready 前狂送 600 帧(模拟 GPU 迟 ready,电话持续送音频)
    for (let i = 0; i < 600; i++) engine.pushAudio(Buffer.alloc(2));
    expect(ws.sent.length).toBe(0); // 全入队,未发
    ws.emitControl({ type: "ready" });
    // 冲刷的 audio_meta 不超过上限 500(最老的被丢)
    const metas = ws.textsSent().filter((m) => m.type === "audio_meta");
    expect(metas.length).toBe(500);
  });

  it("§3.2 握手超时:start 后未见 ready → 上报连接级错误 GPU_HANDSHAKE_TIMEOUT", () => {
    jest.useFakeTimers();
    try {
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "sess1", 5000);
      const llm = new FakeLlm([]);
      const engine = new ThreeStageEngine(gpu, llm);
      const errs: Array<{ code: string }> = [];
      engine.onError((code) => errs.push({ code }));
      void engine.start("sess1", "x", params);
      jest.advanceTimersByTime(5001);
      expect(errs.some((e) => e.code === "GPU_HANDSHAKE_TIMEOUT")).toBe(true);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("§3.2 ready 在握手超时前到达 → 不报超时", () => {
    jest.useFakeTimers();
    try {
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "sess1", 5000);
      const engine = new ThreeStageEngine(gpu, new FakeLlm([]));
      const errs: string[] = [];
      engine.onError((code) => errs.push(code));
      void engine.start("sess1", "x", params);
      ws.emitControl({ type: "ready" });
      jest.advanceTimersByTime(6000);
      expect(errs).not.toContain("GPU_HANDSHAKE_TIMEOUT");
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("asr_partial/asr_final 触发 onTranscript", async () => {
    const { ws, engine } = setup([]);
    const got: Array<{ text: string; isFinal: boolean }> = [];
    engine.onTranscript((t) => got.push(t));
    ws.emitControl({ type: "asr_partial", text: "你" });
    ws.emitControl({ type: "asr_final", text: "你好" });
    expect(got).toEqual([
      { text: "你", isFinal: false },
      { text: "你好", isFinal: true },
    ]);
  });

  it("turn_end → 起 Bedrock LLM 流,分句后逐句下发 GPU TTS", async () => {
    const { ws, engine } = setup(["我是", "AI", "助手", "。", "很高兴", "认识你", "。"]);
    await engine.start("sess1", "prompt", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "你好" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20)); // 等异步 LLM 流

    const ttsTexts = ws.textsSent().filter((m) => m.type === "tts_text").map((m) => m.text);
    expect(ttsTexts.length).toBeGreaterThanOrEqual(2);
    expect(ttsTexts.join("")).toContain("我是AI助手。");
    expect(ttsTexts.join("")).toContain("很高兴认识你。");
  });

  it("design contract:suppressNewTurns=true 时 turn_end 有实质输入也不起新 LLM 轮(drain 期不打断原因句)", async () => {
    const { ws, engine } = setup(["新", "回复", "。"]);
    await engine.start("sess1", "prompt", params);
    engine.onTurnEvent(() => {});
    (engine as unknown as { suppressNewTurns: boolean }).suppressNewTurns = true; // 模拟 bridge 在 drain 期置
    ws.emitControl({ type: "asr_final", text: "我还想再说几句" }); // 实质输入
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    const ttsTexts = ws.textsSent().filter((m) => m.type === "tts_text");
    expect(ttsTexts.length).toBe(0); // ★ 不起新轮 → 无 tts_text 下发(原因句 drain 期不被新音频打断)
  });

  it("design contract:suppressNewTurns 恢复 false 后 turn_end 正常起轮(drain 完不永久禁言)", async () => {
    const { ws, engine } = setup(["恢", "复", "了", "。"]);
    await engine.start("sess1", "prompt", params);
    engine.onTurnEvent(() => {});
    const e = engine as unknown as { suppressNewTurns: boolean };
    e.suppressNewTurns = true;
    ws.emitControl({ type: "asr_final", text: "drain 期说的话" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.textsSent().filter((m) => m.type === "tts_text").length).toBe(0); // drain 期不起轮
    e.suppressNewTurns = false; // drain 完恢复
    ws.emitControl({ type: "asr_final", text: "现在正常说话" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.textsSent().filter((m) => m.type === "tts_text").length).toBeGreaterThan(0); // ★ 恢复后正常起轮
  });

  it("语义挂断:LLM 末尾输出 [[END_CALL]] → 标记不进 TTS,wantsEndCall=true", async () => {
    // LLM 回复「好的,拜拜!」+ 末尾哨兵。哨兵应被剥离(不念出来),wantsEndCall 置真。
    const { ws, engine } = setup(["好的", ",", "拜拜", "!", "\n", "[[END_CALL]]"]);
    await engine.start("sess1", "prompt", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "没有了,拜拜" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));

    const ttsTexts = ws.textsSent().filter((m) => m.type === "tts_text").map((m) => m.text);
    const joined = ttsTexts.join("");
    expect(joined).toContain("好的"); // 正常内容照常下发
    expect(joined).toContain("拜拜");
    expect(joined).not.toMatch(/END_CALL|\[\[|\]\]/); // 哨兵任何残形都不进 TTS
    expect(engine.wantsEndCall()).toBe(true); // 语义挂断信号置位
  });

  it("语义挂断:普通回复无哨兵 → wantsEndCall=false", async () => {
    const { ws, engine } = setup(["2027", "年", "不是", "闰年", "。"]);
    await engine.start("sess1", "prompt", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "明年是闰年吗" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.wantsEndCall()).toBe(false);
  });

  it("wantsEndCall 读后清(不跨轮残留)", async () => {
    const { ws, engine } = setup(["拜拜", "[[END_CALL]]"]);
    await engine.start("sess1", "prompt", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "拜拜" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.wantsEndCall()).toBe(true);
    expect(engine.wantsEndCall()).toBe(false); // 第二次读已清
  });

  it("语义挂断竞态:AI 告别播放中被 barge-in 打断 → 清结束信号,不误挂(用户想继续)", async () => {
    // LLM 已出完「拜拜+[[END_CALL]]」(endCallSignaled=true),但 TTS 播放中用户插话打断。
    // cancel(barge_in) 必须清掉结束信号,否则 media-session 会误挂(打断拜拜反被挂电话)。
    const { ws, engine } = setup(["拜拜", "[[END_CALL]]"]);
    await engine.start("sess1", "prompt", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "拜拜" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    // 此刻 LLM 流已出完,endCallSignaled=true。模拟用户插话打断:
    engine.cancel("barge_in");
    expect(engine.wantsEndCall()).toBe(false); // 竞态修复:被打断的告别轮作废,不挂
  });

  it("多轮:对话历史由引擎维护并注入下一轮 LLM(client 不碰历史)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sess1");
    const llm = new FakeLlm(["好", "的", "。"]);
    const engine = new ThreeStageEngine(gpu, llm);
    await engine.start("sess1", "你是助手", params);
    engine.onTurnEvent(() => {});

    // 第 1 轮
    ws.emitControl({ type: "asr_final", text: "今天几号" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    // 第 1 轮 LLM 收到的 history 应为空
    expect(llm.turns[0].history ?? []).toEqual([]);
    expect(llm.turns[0].userText).toBe("今天几号");

    // 第 2 轮
    ws.emitControl({ type: "asr_final", text: "那明天呢" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    // 第 2 轮 history 必须包含第 1 轮的 user + assistant(AI 才记得上文)
    expect(llm.turns[1].history).toEqual([
      { role: "user", content: "今天几号" },
      { role: "assistant", content: "好的。" },
    ]);
    expect(llm.turns[1].userText).toBe("那明天呢");
  });

  it("GPU tts_audio_meta+binary → onAudioOut 收到 PCM", () => {
    const { ws, engine } = setup([]);
    const chunks: Buffer[] = [];
    engine.onAudioOut((pcm) => chunks.push(pcm));
    ws.emitAudio({ seq: 1, bytes: 4 }, Buffer.from([1, 2, 3, 4]));
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("B7 barge-in 残音守卫:cancel 后丢弃在途残音,下一轮 turn_end 才恢复 onAudioOut", () => {
    const { ws, engine } = setup([]);
    const chunks: Buffer[] = [];
    engine.onAudioOut((pcm) => chunks.push(pcm));
    // 正常出声
    ws.emitAudio({ seq: 1, bytes: 2 }, Buffer.from([1, 1]));
    expect(chunks.length).toBe(1);
    // barge-in 打断 → interrupted;此后 GPU 在途残音应被丢弃(不回灌被打断的 AI 余音)
    engine.cancel("barge_in");
    ws.emitAudio({ seq: 2, bytes: 2 }, Buffer.from([2, 2]));
    ws.emitAudio({ seq: 3, bytes: 2 }, Buffer.from([3, 3]));
    expect(chunks.length).toBe(1); // 残音被丢
    // 下一轮 turn_end → 解除守卫,音频恢复
    ws.emitControl({ type: "turn_end" });
    ws.emitAudio({ seq: 4, bytes: 2 }, Buffer.from([4, 4]));
    expect(chunks.length).toBe(2);
    expect(chunks[1]).toEqual(Buffer.from([4, 4]));
  });

  it("barge-in: cancel 停 Bedrock 流 + 向 GPU 发 cancel,不再下发剩余句子", async () => {
    // 长 token 流;在第一句后 barge-in
    const { ws, engine } = setup(["第一句", "。", "第二句", "。", "第三句", "。"]);
    await engine.start("sess1", "p", params);
    ws.emitControl({ type: "asr_final", text: "嗯嗯" });
    ws.emitControl({ type: "turn_end" });
    // 立刻 barge-in(LLM 流还没跑完)
    engine.cancel("barge_in");
    await new Promise((r) => setTimeout(r, 20));

    const cancels = ws.textsSent().filter((m) => m.type === "cancel");
    expect(cancels.length).toBe(1);
    expect(cancels[0].reason).toBe("barge_in");
  });

  it("stop 发会话级 cancel + end", async () => {
    const { ws, engine } = setup([]);
    await engine.start("sess1", "p", params);
    await engine.stop();
    const types = ws.textsSent().map((m) => m.type);
    expect(types).toContain("cancel");
    expect(types).toContain("end");
  });
});

describe("ThreeStageEngine 健壮性(review 修复)", () => {
  it("LLM 流抛错不抛出未捕获异常,且降级为本轮失败不拆机(#2 + P2-9)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const boom: LlmStreamer = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<string> {
        throw new Error("bedrock throttled");
      },
    };
    const engine = new ThreeStageEngine(gpu, boom);
    const errors: Array<{ code: string; msg: string }> = [];
    engine.onError((code, msg) => errors.push({ code, msg }));
    await engine.start("s1", "p", params);
    ws.emitControl({ type: "asr_final", text: "hi" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    // P2-9:LLM 流异常**降级为本轮失败,会话继续**——不再经 errorCb 拆机(此前一次跨境抖动毁整场)。
    // 关键:不抛未捕获异常(进程不崩,本 await 正常返回)+ 不发致命 error(errorCb 零调用 → 媒体面不拆机)。
    expect(errors.length).toBe(0);
  });

  it("LLM 首 token 超时 → abort + 降级本轮失败触发 onAiDone,不拆机(P2-9 TTFT)", async () => {
    jest.useFakeTimers();
    try {
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "s1");
      // LLM 挂起:永不吐首 token,但响应 abort(TTFT 超时会 abort signal)。
      const hang: LlmStreamer = {
        async *stream(_turn, signal): AsyncIterable<string> {
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve());
          });
        },
      };
      const engine = new ThreeStageEngine(gpu, hang);
      let aiDone = 0;
      const completedArgs: (boolean | undefined)[] = [];
      const errors: string[] = [];
      engine.onAiDone?.((completed) => { aiDone++; completedArgs.push(completed); });
      engine.onError((code) => errors.push(code));
      engine.onTurnEvent(() => {});
      await engine.start("s1", "p", params);
      ws.emitControl({ type: "asr_final", text: "问题" });
      ws.emitControl({ type: "turn_end" });
      // 推进超过 TTFT 超时窗(默认 25s,已放宽以覆盖跨境 GLM TTFB 抖动)→ 触发 abort + 降级。
      await jest.advanceTimersByTimeAsync(26000);
      expect(errors).not.toContain("LLM_STREAM_ERROR"); // 降级不拆机
      expect(aiDone).toBe(1); // 超时降级仍触发 onAiDone(aiSpeaking 复位,会话可继续)
      expect(completedArgs).toEqual([false]); // ★ design contract:LLM 超时=本轮没说完 → completed=false(不进等待作答态)
    } finally {
      jest.useRealTimers();
    }
  });

  it("barge-in 后旧轮不踩踏新轮的 llmBusy(#1 epoch 守卫)", async () => {
    // 慢 LLM:逐 token 间等一拍,给 barge-in 介入窗口
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const slow: LlmStreamer = {
      async *stream(_turn, signal): AsyncIterable<string> {
        for (const t of ["第一", "句", "。", "第二", "句", "。"]) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, 5));
          yield t;
        }
      },
    };
    const engine = new ThreeStageEngine(gpu, slow);
    await engine.start("s1", "p", params);
    // 第 1 轮
    ws.emitControl({ type: "asr_final", text: "轮1" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 8));
    // barge-in 打断
    engine.cancel("barge_in");
    // 紧接第 2 轮
    ws.emitControl({ type: "asr_final", text: "轮2" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 60));
    // 第 2 轮应能完整跑(没被旧轮 finally 踩踏 llmBusy 导致卡死或并发)
    const cancels = ws.textsSent().filter((m) => m.type === "cancel");
    expect(cancels.length).toBe(1);
    // 第 2 轮有 tts_text 产出(说明新轮正常执行,未被旧轮污染/阻塞)
    const ttsAfterCancel = ws.textsSent().filter((m) => m.type === "tts_text");
    expect(ttsAfterCancel.length).toBeGreaterThan(0);
  });

  it("连续 turn_end(无 cancel)不会让 llmBusy 卡死(死锁回归)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const slow: LlmStreamer = {
      async *stream(_turn, signal): AsyncIterable<string> {
        for (const t of ["甲", "。", "乙", "。"]) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, 5));
          yield t;
        }
      },
    };
    const engine = new ThreeStageEngine(gpu, slow);
    await engine.start("s1", "p", params);
    // 第 1 轮进行中,第 2 个 turn_end 直接到达(无 cancel)→ 应被忽略,不破坏状态
    ws.emitControl({ type: "asr_final", text: "轮1" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 3));
    ws.emitControl({ type: "asr_final", text: "轮1b" });
    ws.emitControl({ type: "turn_end" }); // busy,应被忽略
    // 等第 1 轮自然跑完
    await new Promise((r) => setTimeout(r, 60));
    // 之后新一轮必须能正常执行(llmBusy 未卡死)
    const before = ws.textsSent().filter((m) => m.type === "tts_text").length;
    ws.emitControl({ type: "asr_final", text: "轮2" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 60));
    const after = ws.textsSent().filter((m) => m.type === "tts_text").length;
    expect(after).toBeGreaterThan(before); // 新轮产出了 TTS → 未死锁
  });

  it("GPU error 帧经 onError 上报,不静默丢弃(#13)", () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const engine = new ThreeStageEngine(gpu, new FakeLlm([]));
    const errors: string[] = [];
    engine.onError((code) => errors.push(code));
    ws.emitControl({ type: "error", code: "CAPACITY_FULL", message: "满" });
    expect(errors).toContain("CAPACITY_FULL");
  });
});

describe("ThreeStageEngine 回声抑制恢复 + flush", () => {
  it("整轮 TTS 全部 tts_done 才触发 onAiDone(轮级记账,非每句)", async () => {
    // 一轮:asr_final→turn_end→LLM 出「句一。句二。」2 句 → ttsPending=2;
    // 收第 1 个 tts_done 不触发,收齐 2 个才触发 onAiDone(修句间误恢复 review)。
    const { ws, engine } = setup(["句一", "。", "句二", "。"]);
    await engine.start("s1", "p", params);
    let aiDone = 0;
    const completedArgs: (boolean | undefined)[] = [];
    engine.onAiDone?.((completed) => { aiDone++; completedArgs.push(completed); });
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20)); // 等 LLM 分句下发(应发 2 句 tts_text)
    const ttsCount = ws.textsSent().filter((m) => m.type === "tts_text").length;
    expect(ttsCount).toBe(2);
    ws.emitControl({ type: "tts_done" });
    expect(aiDone).toBe(0); // 第 1 句完成,还没整轮完
    ws.emitControl({ type: "tts_done" });
    expect(aiDone).toBe(1); // 整轮 2 句都完成 → 触发
    expect(completedArgs).toEqual([true]); // ★ design contract:正常完整播完 → completed=true(进等待作答态)
  });

  it("emits generation-tagged response, segment, audio, and terminal observers in FIFO order", async () => {
    const { ws, engine } = setup(["句一", "。", "句二", "。"]);
    const observed: Array<Record<string, unknown>> = [];
    engine.onResponseStarted?.((event) => observed.push({ type: "started", ...event }));
    engine.onResponseSegmentDeclared?.((event) =>
      observed.push({ type: "declared", ...event }),
    );
    engine.onAudioOut((pcm, identity) =>
      observed.push({ type: "audio", bytes: pcm.length, ...identity }),
    );
    engine.onResponseSegmentCompleted?.((event) =>
      observed.push({ type: "segment_done", ...event }),
    );
    engine.onResponseCoreTerminal?.((event) =>
      observed.push({ type: "terminal", ...event }),
    );
    await engine.start("s1", "p", params);
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(
      () => ws.textsSent().filter((message) => message.type === "tts_text").length === 2,
    );
    ws.emitAudio({ seq: 1, bytes: 4 }, Buffer.from([1, 2, 3, 4]));
    ws.emitControl({ type: "tts_done" });
    ws.emitAudio({ seq: 2, bytes: 4 }, Buffer.from([5, 6, 7, 8]));
    ws.emitControl({ type: "tts_done" });

    expect(observed).toEqual([
      { type: "started", responseGeneration: 1, turnSeq: 1 },
      {
        type: "declared",
        responseGeneration: 1,
        turnSeq: 1,
        segmentId: 1,
        text: "句一。",
      },
      {
        type: "declared",
        responseGeneration: 1,
        turnSeq: 1,
        segmentId: 2,
        text: "句二。",
      },
      {
        type: "audio",
        bytes: 4,
        responseGeneration: 1,
        turnSeq: 1,
        segmentId: 1,
      },
      {
        type: "segment_done",
        responseGeneration: 1,
        turnSeq: 1,
        segmentId: 1,
      },
      {
        type: "audio",
        bytes: 4,
        responseGeneration: 1,
        turnSeq: 1,
        segmentId: 2,
      },
      {
        type: "segment_done",
        responseGeneration: 1,
        turnSeq: 1,
        segmentId: 2,
      },
      {
        type: "terminal",
        responseGeneration: 1,
        turnSeq: 1,
        status: "completed",
      },
    ]);
  });

  it("defers aiDone settlement until response wire drain and tolerates synchronous feedback", async () => {
    const drive = async (synchronousDrain: boolean) => {
      const { ws, engine } = setup(["回答", "。"]);
      const wireAware = engine as unknown as {
        setResponseWireDrainRequired(required: boolean): void;
        noteResponseWireDrained(responseGeneration: number): void;
      };
      wireAware.setResponseWireDrainRequired?.(true);
      const order: string[] = [];
      engine.onAiDone?.(() => {
        order.push("ai_done");
      });
      engine.onResponseCoreTerminal?.((event) => {
        order.push("core_terminal");
        if (synchronousDrain) {
          wireAware.noteResponseWireDrained?.(event.responseGeneration);
        }
      });
      await engine.start("s1", "p", params);
      ws.emitControl({ type: "asr_final", text: "问题" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(
        () =>
          ws.textsSent().filter((message) => message.type === "tts_text")
            .length === 1,
      );
      ws.emitControl({ type: "tts_done" });
      return { ws, engine, order, wireAware };
    };

    const deferred = await drive(false);
    expect(deferred.order).toEqual(["core_terminal"]);
    deferred.wireAware.noteResponseWireDrained?.(2);
    expect(deferred.order).toEqual(["core_terminal"]);
    deferred.wireAware.noteResponseWireDrained?.(1);
    expect(deferred.order).toEqual(["core_terminal", "ai_done"]);

    const synchronous = await drive(true);
    expect(synchronous.order).toEqual(["core_terminal", "ai_done"]);

    const cancelled = await drive(false);
    cancelled.engine.cancel("barge_in");
    cancelled.wireAware.noteResponseWireDrained?.(1);
    expect(cancelled.order).toEqual(["core_terminal"]);

    cancelled.ws.emitControl({ type: "asr_final", text: "新问题" });
    cancelled.ws.emitControl({ type: "turn_end" });
    await waitUntil(
      () =>
        cancelled.ws
          .textsSent()
          .filter((message) => message.type === "tts_text").length === 2,
    );
    cancelled.ws.emitControl({ type: "tts_done" });
    expect(cancelled.order).toEqual(["core_terminal", "core_terminal"]);
    cancelled.wireAware.noteResponseWireDrained?.(2);
    expect(cancelled.order).toEqual([
      "core_terminal",
      "core_terminal",
      "ai_done",
    ]);
  });

  it("keeps cursor and aiDone side effects behind the estimated playback boundary", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const engine = new ThreeStageEngine(gpu, new FakeLlm(["好的。"]));
    const wireAware = engine as unknown as {
      setResponseWireDrainRequired(required: boolean): void;
      noteResponseWireDrained(responseGeneration: number): void;
    };
    const aiDone: boolean[] = [];
    wireAware.setResponseWireDrainRequired(true);
    engine.onResponseServerDrained?.(() => Date.now() + 1_000);
    engine.onAiDone?.((completed) => {
      aiDone.push(completed !== false);
    });
    await engine.start("s1", "p", {
      ...params,
      questions: [{ text: "问题一" }, { text: "问题二" }],
    });
    ws.emitControl({ type: "asr_final", text: "跳过" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(
      () =>
        ws.textsSent().filter((message) => message.type === "tts_text")
          .length === 1,
    );
    ws.emitControl({ type: "tts_done" });

    jest.useFakeTimers();
    wireAware.noteResponseWireDrained(1);
    expect(engine.questionCursor?.()).toBe(0);
    expect(aiDone).toEqual([]);

    jest.advanceTimersByTime(999);
    expect(engine.questionCursor?.()).toBe(0);
    expect(aiDone).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(engine.questionCursor?.()).toBe(1);
    expect(aiDone).toEqual([true]);
  });

  it("user speech or teardown aborts pending playback settlement without progression", async () => {
    const drive = async () => {
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "s1");
      const engine = new ThreeStageEngine(gpu, new FakeLlm(["好的。"]));
      const wireAware = engine as unknown as {
        setResponseWireDrainRequired(required: boolean): void;
        noteResponseWireDrained(responseGeneration: number): void;
      };
      const aiDone: boolean[] = [];
      wireAware.setResponseWireDrainRequired(true);
      engine.onResponseServerDrained?.(() => Date.now() + 1_000);
      engine.onAiDone?.((completed) => {
        aiDone.push(completed !== false);
      });
      await engine.start("s1", "p", {
        ...params,
        questions: [{ text: "问题一" }, { text: "问题二" }],
      });
      ws.emitControl({ type: "asr_final", text: "跳过" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(
        () =>
          ws.textsSent().filter((message) => message.type === "tts_text")
            .length === 1,
      );
      ws.emitControl({ type: "tts_done" });
      return { ws, engine, aiDone, wireAware };
    };

    const interrupted = await drive();
    jest.useFakeTimers();
    interrupted.wireAware.noteResponseWireDrained(1);
    interrupted.ws.emitControl({ type: "asr_partial", text: "我补充" });
    jest.advanceTimersByTime(1_000);
    expect(interrupted.engine.questionCursor?.()).toBe(0);
    expect(interrupted.aiDone).toEqual([false]);

    jest.useRealTimers();
    const failed = await drive();
    jest.useFakeTimers();
    failed.wireAware.noteResponseWireDrained(1);
    failed.engine.cancel("error");
    jest.advanceTimersByTime(1_000);
    expect(failed.engine.questionCursor?.()).toBe(0);
    expect(failed.aiDone).toEqual([]);
  });

  it("keeps late cancelled PCM on its original response generation", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const engine = new ThreeStageEngine(
      gpu,
      new ScriptedLlm(["第一轮。", "第二轮。"]),
    );
    const audio: Array<Record<string, unknown>> = [];
    engine.onAudioOut((pcm, identity) =>
      audio.push({ bytes: pcm.length, ...identity }),
    );
    engine.onTurnEvent(() => {});
    await engine.start("s1", "p", params);

    ws.emitControl({ type: "asr_final", text: "问题一" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(
      () => ws.textsSent().filter((message) => message.type === "tts_text").length === 1,
    );
    engine.cancel("barge_in");

    ws.emitControl({ type: "asr_final", text: "问题二" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(
      () => ws.textsSent().filter((message) => message.type === "tts_text").length === 2,
    );

    ws.emitAudio({ seq: 1, bytes: 4 }, Buffer.from([1, 2, 3, 4]));
    expect(audio).toEqual([
      {
        bytes: 4,
        responseGeneration: 1,
        turnSeq: 1,
        segmentId: 1,
      },
    ]);

    ws.emitControl({ type: "cancel_ack", reason: "barge_in" });
    ws.emitAudio({ seq: 2, bytes: 4 }, Buffer.from([5, 6, 7, 8]));
    expect(audio.at(-1)).toEqual({
      bytes: 4,
      responseGeneration: 2,
      turnSeq: 2,
      segmentId: 1,
    });
  });

  it("裸 tts_done(无在途 TTS)不触发 onAiDone(防 ttsPending 负数/误触发)", () => {
    const { ws, engine } = setup([]);
    let aiDone = 0;
    engine.onAiDone?.(() => aiDone++);
    ws.emitControl({ type: "tts_done" });
    expect(aiDone).toBe(0);
  });

  it("barge-in cancel 也触发 onAiDone(cancel 路径 GPU 不发 tts_done,避免 aiSpeaking 卡死)", async () => {
    const { ws, engine } = setup(["很长", "的", "回复", "。"]);
    await engine.start("s1", "p", params);
    let aiDone = 0;
    const completedArgs: (boolean | undefined)[] = [];
    engine.onAiDone?.((completed) => { aiDone++; completedArgs.push(completed); });
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20)); // 已下发若干 tts_text(ttsPending>0)
    engine.cancel("barge_in");
    expect(aiDone).toBe(1); // cancel 清账并主动触发 AI-done
    expect(completedArgs).toEqual([false]); // ★ design contract:打断=本轮没说完 → completed=false(不进等待作答态)
  });

  it("B3:LLM 还在流时第一句 tts_done 归零**不**误触发 onAiDone(句间空窗门)", async () => {
    // 慢 LLM:逐 token 间隔,第一句下发后第二句还没出。第一句 tts_done 让 ttsPending 暂时归 0,
    // 但 llmStreamComplete 还没置 → maybeFireAiDone 被门挡住,不触发(否则句间空窗误开入向)。
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    // 第一句「句一。」在 token[0..1] 后切出(~30ms);第二句「句二。」在 token[2..3] 后(~60ms)。
    const slow: LlmStreamer = {
      async *stream(_turn, signal): AsyncIterable<string> {
        for (const t of ["句一", "。", "句二", "。"]) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, 15));
          yield t;
        }
      },
    };
    const engine = new ThreeStageEngine(gpu, slow);
    await engine.start("s1", "p", params);
    let aiDone = 0;
    engine.onAiDone?.(() => aiDone++);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    // 等到第一句已切出下发(~40ms,过了第一个「。」),此时 LLM 流还在跑(第二句未出)
    await new Promise((r) => setTimeout(r, 40));
    const firstCount = ws.textsSent().filter((m) => m.type === "tts_text").length;
    expect(firstCount).toBeGreaterThanOrEqual(1);
    expect(firstCount).toBeLessThan(2); // 第二句还没出(证明确实在流中途)
    ws.emitControl({ type: "tts_done" }); // 第一句完成 → ttsPending 暂时归 0
    expect(aiDone).toBe(0); // 门挡住:LLM 流未结束,不触发
    // 等 LLM 流跑完 + 第二句下发,补齐 tts_done
    await new Promise((r) => setTimeout(r, 60));
    const total = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 1; i < total; i++) ws.emitControl({ type: "tts_done" }); // 余下句的 done
    expect(aiDone).toBe(1); // 流已完成 + 全部 tts_done → 此刻才触发
  });

  it("B4:LLM 流异常(非打断)清本轮 ttsPending 残留并触发 onAiDone,降级不拆机(P2-9)", async () => {
    // LLM 先吐一句(下发 1 句 tts_text,ttsPending=1)再抛错 → 异常路径必须清账 + 触发 aiDone,
    // 否则残留的 ttsPending 让后续轮永远凑不齐归零。P2-9:且降级为本轮失败(不 errorCb 拆机),会话继续。
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const boomAfterOne: LlmStreamer = {
      async *stream(_turn, signal): AsyncIterable<string> {
        if (signal.aborted) return;
        yield "半句";
        yield "。";
        throw new Error("bedrock mid-stream drop");
      },
    };
    const engine = new ThreeStageEngine(gpu, boomAfterOne);
    let aiDone = 0;
    const errors: string[] = [];
    engine.onAiDone?.(() => aiDone++);
    engine.onError((code) => errors.push(code));
    engine.onTurnEvent(() => {});
    await engine.start("s1", "p", params);
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(errors).not.toContain("LLM_STREAM_ERROR"); // P2-9:降级不拆机(不发致命 error)
    expect(aiDone).toBe(1); // 异常路径仍强制结束整轮 → aiSpeaking 必复位(清 ttsPending 残留,B4 核心)
  });

  it("N2:GPU WS 意外断开 → onError 上报(GPU_WS_CLOSED),不静默死", async () => {
    const { ws, engine } = setup([]);
    await engine.start("s1", "p", params);
    const errors: string[] = [];
    engine.onError((code) => errors.push(code));
    ws.emitClose(); // 模拟 GPU 意外断流(非主动 end)
    expect(errors).toContain("GPU_WS_CLOSED");
  });

  it("N2:GPU WS error → onError 上报(GPU_WS_ERROR)", async () => {
    const { ws, engine } = setup([]);
    await engine.start("s1", "p", params);
    const errors: Array<{ code: string; msg: string }> = [];
    engine.onError((code, msg) => errors.push({ code, msg }));
    ws.emitError(new Error("ECONNREFUSED"));
    expect(errors[0].code).toBe("GPU_WS_ERROR");
    expect(errors[0].msg).toContain("ECONNREFUSED");
  });

  it("N2:主动 end() 后的 close 不再当作错误上报", async () => {
    const { ws, engine } = setup([]);
    await engine.start("s1", "p", params);
    const errors: string[] = [];
    engine.onError((code) => errors.push(code));
    await engine.stop(); // 内部 gpu.end() 置 closed
    ws.emitClose();
    expect(errors).toHaveLength(0);
  });

  it("endTurn() → 向 GPU 发 flush(主动结束本轮,VAD 兜底逃生口)", () => {
    const { ws, engine } = setup([]);
    engine.endTurn?.();
    const flush = ws.textsSent().filter((m) => m.type === "flush");
    expect(flush.length).toBe(1);
  });

  it("endTurn(identity) → flush 携带 matching input epoch/turn fence", () => {
    const { ws, engine } = setup([]);
    engine.endTurn?.({ inputEpoch: 3, inputTurnId: 7 });
    expect(ws.textsSent().at(-1)).toMatchObject({
      type: "flush",
      input_epoch: 3,
      input_turn_id: 7,
    });
  });

  it("commitInput before the first ASR callback still sends a stable turn fence", () => {
    const { ws, engine } = setup([]);
    engine.commitInput(0);
    expect(ws.textsSent().at(-1)).toMatchObject({
      type: "flush",
      input_epoch: 0,
      input_turn_id: 0,
    });
  });

  it("turn_end 后清空 lastFinalText(空 turn_end 不拿旧文本重答)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const llm = new FakeLlm(["好"]);
    const engine = new ThreeStageEngine(gpu, llm);
    await engine.start("s1", "p", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "第一句" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    // 再来一个空 turn_end(无新 asr_final)→ 不应再起 LLM(lastFinalText 已清空)
    const before = llm.turns.length;
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(llm.turns.length).toBe(before); // 没有新增轮
  });
});

// ── design contract:每轮结构化 metrics(旁路)+ cancel_ack 核对 + 引擎级 TTS 超时 ──
describe("ThreeStageEngine design contract 实时性 metrics", () => {
  it("正常一轮:onMetrics 上报一条 full,含 turn_index/llm_ttft/tts_ttfb/sentence_count", async () => {
    const { ws, engine } = setup(["你好", "。", "再见", "。"]);
    const metrics: EngineTurnMetrics[] = [];
    engine.onMetrics?.((m) => metrics.push(m));
    await engine.start("s1", "p", { engineType: "three_stage", language: "zh-CN", ttsProvider: "minimax" });
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    // 2 句 → 收齐 2 个 tts_done(每个前带一帧音频 meta,触发 firstAudioAt)
    ws.emitAudio({ seq: 1, bytes: 4 }, Buffer.from([1, 2, 3, 4]));
    ws.emitControl({ type: "tts_done" });
    ws.emitControl({ type: "tts_done" });
    expect(metrics).toHaveLength(1);
    const m = metrics[0];
    expect(m.turnIndex).toBe(1);
    expect(m.engineType).toBe("three_stage");
    expect(m.played).toBe("full");
    expect(m.bargeIn).toBe(false);
    expect(m.sentenceCount).toBe(2);
    expect(m.ttsProvider).toBe("minimax");
    expect(m.llmTtftMs).toBeGreaterThanOrEqual(0);
    expect(m.ttsTtfbMs).toBeGreaterThanOrEqual(0);
    expect(m.ttsAudioDurationMs).toBeGreaterThan(0); // 收到 4 字节音频 → 时长 > 0
  });

  it("turn_index 随轮递增(引擎权威序号)", async () => {
    const { ws, engine } = setup(["甲", "。"]);
    const metrics: EngineTurnMetrics[] = [];
    engine.onMetrics?.((m) => metrics.push(m));
    await engine.start("s1", "p", params);
    engine.onTurnEvent(() => {});
    for (let i = 0; i < 2; i++) {
      ws.emitControl({ type: "asr_final", text: `问${i}` });
      ws.emitControl({ type: "turn_end" });
      await new Promise((r) => setTimeout(r, 20));
      ws.emitControl({ type: "tts_done" }); // 1 句一轮
    }
    expect(metrics.map((m) => m.turnIndex)).toEqual([1, 2]);
  });

  it("非零 ai_turn_id 命名空间不改变本地 turn_index", async () => {
    const ws = new FakeWs();
    const engine = new ThreeStageEngine(
      new GpuClient(ws, "s1"),
      new FakeLlm(["甲", "。"]),
      65_536,
    );
    const metrics: EngineTurnMetrics[] = [];
    engine.onMetrics?.((m) => metrics.push(m));
    await engine.start("s1", "p", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    ws.emitControl({ type: "tts_done", ai_turn_id: 65_537, segment_id: 1 });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      turnIndex: 1,
      aiTurnId: 65_537,
    });
    expect(ws.textsSent().find((message) => message.type === "tts_text")).toMatchObject({
      ai_turn_id: 65_537,
    });
  });

  it("barge-in:onMetrics 立即上报 partial+bargeIn;收 cancel_ack → 重发置 cancel_ack_timeout=false", async () => {
    const { ws, engine } = setup(["很长", "的", "回复", "。"]);
    const metrics: EngineTurnMetrics[] = [];
    engine.onMetrics?.((m) => metrics.push(m));
    await engine.start("s1", "p", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20)); // ttsPending>0
    engine.cancel("barge_in");
    // 评审纠偏:立即首报(endpoint 同步合并,无延迟落库竞态)
    expect(metrics).toHaveLength(1);
    expect(metrics[0].played).toBe("partial");
    expect(metrics[0].bargeIn).toBe(true);
    // cancel_ack 到 → 同 turn_index 重发,置 timeout=false(同 SK 覆盖)
    ws.emitControl({ type: "cancel_ack", reason: "barge_in" });
    expect(metrics).toHaveLength(2);
    expect(metrics[1].turnIndex).toBe(metrics[0].turnIndex);
    expect(metrics[1].cancelAckTimeout).toBe(false);
  });

  it("迟到 GPU telemetry 以完整记录覆盖同一 turn，重复 segment 首份生效", async () => {
    const { ws, engine } = setup(["第一句", "。"]);
    const metrics: EngineTurnMetrics[] = [];
    engine.onMetrics?.((metric) => metrics.push({ ...metric }));
    await engine.start("s1", "p", {
      engineType: "three_stage",
      language: "zh-CN",
      ttsProvider: "gpu_omnivoice",
    });
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().some((message) => message.type === "tts_text"));

    const tts = ws.textsSent().find((message) => message.type === "tts_text");
    expect(tts).toMatchObject({ ai_turn_id: 1, segment_id: 1 });
    ws.emitControl({
      type: "tts_done",
      ai_turn_id: tts?.ai_turn_id,
      segment_id: tts?.segment_id,
    });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      turnIndex: 1,
      aiTurnId: 1,
      played: "full",
      sentenceCount: 1,
    });
    expect(metrics[0].ttsGenerationWallTimeMs).toBeUndefined();

    ws.emitControl({
      type: "tts_metrics",
      ai_turn_id: 1,
      segment_id: 1,
      tts_provider: "gpu_omnivoice",
      provider_start_to_first_send_ms: 80,
      generation_wall_time_ms: 240,
      generated_audio_duration_ms: 600,
      rtf: 0.4,
      cache_state: "cold",
      concurrency: 3,
      model_first_chunk_unavailable_reason: "provider_api_has_no_model_chunk_boundary",
    });
    expect(metrics).toHaveLength(2);
    expect(metrics[1]).toMatchObject({
      turnIndex: 1,
      aiTurnId: 1,
      played: "full",
      sentenceCount: 1,
      ttsProvider: "gpu_omnivoice",
      providerStartToFirstSendMs: 80,
      ttsGenerationWallTimeMs: 240,
      generatedAudioDurationMs: 600,
      ttsRtf: 0.4,
      ttsCacheState: "cold",
      ttsConcurrency: 3,
      concurrencyBucket: "2-4",
      modelFirstChunkUnavailableReason:
        "provider_api_has_no_model_chunk_boundary",
    });

    ws.emitControl({
      type: "tts_metrics",
      ai_turn_id: 1,
      segment_id: 1,
      tts_provider: "minimax",
      provider_start_to_first_send_ms: 999,
      generation_wall_time_ms: 999,
      generated_audio_duration_ms: 1,
      rtf: 999,
      cache_state: "warm",
      concurrency: 9,
    });
    expect(metrics).toHaveLength(2);
    expect(metrics[1].providerStartToFirstSendMs).toBe(80);
  });

  it("乱序 segment telemetry 按 segment_id 聚合且不重复计数", async () => {
    const { ws, engine } = setup(["第一句。", "第二句。"]);
    const metrics: EngineTurnMetrics[] = [];
    engine.onMetrics?.((metric) => metrics.push({ ...metric }));
    await engine.start("s1", "p", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(
      () => ws.textsSent().filter((message) => message.type === "tts_text").length === 2,
    );

    const emitSegmentMetric = (
      segmentId: number,
      generationMs: number,
      audioMs: number,
      cacheState: "cold" | "warm",
      concurrency: number,
    ) => ws.emitControl({
      type: "tts_metrics",
      ai_turn_id: 1,
      segment_id: segmentId,
      tts_provider: "gpu_omnivoice",
      provider_start_to_first_send_ms: segmentId * 10,
      generation_wall_time_ms: generationMs,
      generated_audio_duration_ms: audioMs,
      rtf: generationMs / audioMs,
      cache_state: cacheState,
      concurrency,
    });
    emitSegmentMetric(2, 300, 500, "warm", 5);
    emitSegmentMetric(1, 100, 500, "cold", 2);
    emitSegmentMetric(2, 900, 100, "cold", 9);
    ws.emitControl({ type: "tts_done", ai_turn_id: 1, segment_id: 1 });
    ws.emitControl({ type: "tts_done", ai_turn_id: 1, segment_id: 2 });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      providerStartToFirstSendMs: 10,
      ttsGenerationWallTimeMs: 400,
      generatedAudioDurationMs: 1000,
      ttsRtf: 0.4,
      ttsCacheState: "cold",
      ttsConcurrency: 5,
      concurrencyBucket: "5+",
    });
  });

  it("多句轮被 cancel 时接受在飞 segment 的尾延迟但不发布半轮 RTF", async () => {
    const { ws, engine } = setup(["第一句。", "第二句。"]);
    const metrics: EngineTurnMetrics[] = [];
    engine.onMetrics?.((metric) => metrics.push({ ...metric }));
    await engine.start("s1", "p", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(
      () => ws.textsSent().filter((message) => message.type === "tts_text").length === 2,
    );

    engine.cancel("barge_in");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ sentenceCount: 2, played: "partial" });

    ws.emitControl({
      type: "tts_metrics",
      ai_turn_id: 1,
      segment_id: 2,
      tts_provider: "gpu_omnivoice",
      generation_wall_time_ms: 120,
      generated_audio_duration_ms: 300,
      rtf: 0.4,
      cache_state: "warm",
      concurrency: 3,
      cancel_to_last_model_compute_ms: 31,
      cancel_to_last_gpu_send_ms: 4,
    });

    expect(metrics).toHaveLength(2);
    expect(metrics[1]).toMatchObject({
      ttsProvider: "gpu_omnivoice",
      ttsCacheState: "warm",
      concurrencyBucket: "2-4",
      cancelToLastModelComputeMs: 31,
      cancelToLastGpuSendMs: 4,
    });
    expect(metrics[1].ttsGenerationWallTimeMs).toBeUndefined();
    expect(metrics[1].generatedAudioDurationMs).toBeUndefined();
    expect(metrics[1].ttsRtf).toBeUndefined();
  });

  // 排空 sync-yielding 假 LLM 的 for-await 微任务(fake timers 不影响微任务;多刷几轮确保 tts_text 已下发)。
  const drain = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };

  it("barge-in:cancel_ack 超时未到 → 重发置 cancel_ack_timeout=true(仍落库,不阻塞)", async () => {
    jest.useFakeTimers();
    try {
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "s1");
      const engine = new ThreeStageEngine(gpu, new FakeLlm(["回复", "。"]));
      const metrics: EngineTurnMetrics[] = [];
      engine.onMetrics?.((m) => metrics.push(m));
      void engine.start("s1", "p", params);
      ws.emitControl({ type: "ready" }); // 关 GpuClient 握手看门狗(否则 5s 先触发污染)
      engine.onTurnEvent(() => {});
      ws.emitControl({ type: "asr_final", text: "问题" });
      ws.emitControl({ type: "turn_end" });
      await drain(); // 排空 LLM 流 → 下发 tts_text(ttsPending>0)
      engine.cancel("barge_in");
      expect(metrics).toHaveLength(1); // 立即首报
      jest.advanceTimersByTime(301); // 过 CANCEL_ACK_TIMEOUT_MS(默认 300)
      expect(metrics).toHaveLength(2); // 超时重发
      expect(metrics[1].cancelAckTimeout).toBe(true);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("引擎级 TTS 超时:发 tts_text 后一帧未回 → 自终结本轮 + onAiDone + 记 tts_timeout(不走 errorCb 拆机)", async () => {
    jest.useFakeTimers();
    try {
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "s1");
      const engine = new ThreeStageEngine(gpu, new FakeLlm(["回复", "。"]));
      let aiDone = 0;
      const errs: string[] = [];
      const metrics: EngineTurnMetrics[] = [];
      engine.onAiDone?.(() => aiDone++);
      engine.onError((code) => errs.push(code));
      engine.onMetrics?.((m) => metrics.push(m));
      void engine.start("s1", "p", params);
      ws.emitControl({ type: "ready" }); // 关握手看门狗
      engine.onTurnEvent(() => {});
      ws.emitControl({ type: "asr_final", text: "问题" });
      ws.emitControl({ type: "turn_end" });
      await drain(); // 下发 tts_text → 武装引擎级 TTS 超时
      // 已下发 tts_text 但 GPU 一帧 tts_audio_meta/tts_done 都不回(半断):超时兜底
      jest.advanceTimersByTime(12001); // 过 AIM_TTS_TIMEOUT_MS(默认 12000)
      // ★ 集成路径修复:**不**走 errorCb(MediaSession.onError 会 end("error") 整通拆机,违背「会话继续」)。
      expect(errs).not.toContain("TTS_TIMEOUT");
      expect(aiDone).toBe(1); // 引擎自终结本轮 → 恢复收听(会话继续)
      expect(metrics).toHaveLength(1);
      expect(metrics[0].played).toBe("partial");
      expect(metrics[0].ttsTimeout).toBe(true); // 可观测标志落 metrics
      // 下一轮 turn_end 必须能正常起 LLM(llmBusy 未卡死)
      ws.emitControl({ type: "asr_final", text: "再问" });
      ws.emitControl({ type: "turn_end" });
      await drain();
      const tts = ws.textsSent().filter((m) => m.type === "tts_text");
      expect(tts.length).toBeGreaterThanOrEqual(2); // 第二轮也下发了 → 未卡死
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("引擎级 TTS 超时:收到 tts_audio_meta 即解除 + 后续 tts_done 正常完结整轮", async () => {
    jest.useFakeTimers();
    try {
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "s1");
      const engine = new ThreeStageEngine(gpu, new FakeLlm(["回复", "。"]));
      const errs: string[] = [];
      let aiDone = 0;
      engine.onError((code) => errs.push(code));
      engine.onAiDone?.(() => aiDone++);
      void engine.start("s1", "p", params);
      ws.emitControl({ type: "ready" }); // 关握手看门狗
      engine.onTurnEvent(() => {});
      ws.emitControl({ type: "asr_final", text: "问题" });
      ws.emitControl({ type: "turn_end" });
      await drain();
      const ttsCount = ws.textsSent().filter((m) => m.type === "tts_text").length;
      // GPU 回了一帧音频 → 超时应被解除
      ws.emitAudio({ seq: 1, bytes: 2 }, Buffer.from([1, 1]));
      jest.advanceTimersByTime(13000);
      expect(errs).not.toContain("TTS_TIMEOUT"); // 已有响应,不误报超时
      // review:解除后,后续 tts_done 收齐 → 整轮正常完结(onAiDone 触发一次)
      for (let i = 0; i < ttsCount; i++) ws.emitControl({ type: "tts_done" });
      expect(aiDone).toBe(1);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("LLM 异常路径也上报 partial metrics(不静默丢轮数据)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const boom: LlmStreamer = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<string> {
        throw new Error("bedrock throttled");
      },
    };
    const engine = new ThreeStageEngine(gpu, boom);
    const metrics: EngineTurnMetrics[] = [];
    engine.onMetrics?.((m) => metrics.push(m));
    await engine.start("s1", "p", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(metrics).toHaveLength(1);
    expect(metrics[0].played).toBe("partial");
  });

  it("cancel_ack 仅计量,不改通话状态(消费它不触发额外 aiDone/cancel)", async () => {
    const { ws, engine } = setup([]);
    let aiDone = 0;
    engine.onAiDone?.(() => aiDone++);
    await engine.start("s1", "p", params);
    // 无未决 metric 时收到 cancel_ack:安全 no-op,不崩、不触发 aiDone
    ws.emitControl({ type: "cancel_ack", reason: "barge_in" });
    expect(aiDone).toBe(0);
  });
});

// ── design contract:SpeechTurn 生命周期不变量(竞态回归基准 + 重构专属)──
describe("ThreeStageEngine SpeechTurn 生命周期不变量", () => {
  it("不变量:onAiDone 恰好触发一次(整轮播完路径)", async () => {
    const { ws, engine } = setup(["句一", "。", "句二", "。"]);
    let aiDone = 0;
    engine.onAiDone?.(() => aiDone++);
    await engine.start("s1", "p", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "问题" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    ws.emitControl({ type: "tts_done" });
    ws.emitControl({ type: "tts_done" });
    expect(aiDone).toBe(1);
    // 多余的 tts_done(GPU 抖动重发)不再触发第二次(activeTurn 已清)
    ws.emitControl({ type: "tts_done" });
    expect(aiDone).toBe(1);
  });

  it("不变量:连续 turn_end(busy)被忽略,不抢占活跃轮,不卡死(死锁回归)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const slow: LlmStreamer = {
      async *stream(_t, signal): AsyncIterable<string> {
        for (const t of ["甲", "。", "乙", "。"]) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, 5));
          yield t;
        }
      },
    };
    const engine = new ThreeStageEngine(gpu, slow);
    const metrics: EngineTurnMetrics[] = [];
    engine.onMetrics?.((m) => metrics.push(m));
    await engine.start("s1", "p", params);
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text: "轮1" });
    ws.emitControl({ type: "turn_end" });
    // 等轮 1 起跑(出第一句),再发第二个 turn_end 验 busy 忽略不抢占;固定 3ms 在慢 runner 上可能轮 1 还没起。
    await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
    ws.emitControl({ type: "asr_final", text: "轮1b" });
    ws.emitControl({ type: "turn_end" }); // busy → 忽略,不抢占(不新建第二个 turn)
    // 轮 1 流完整出 "甲。乙。"(2 句);轮询等这 2 句都下发(慢 runner 固定 60ms 不够,flaky 根因)。
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length >= 2);
    // 轮 1 出 "甲。乙。"=2 句 → 收齐 2 个 tts_done 才完结
    const tts1 = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < tts1; i++) ws.emitControl({ type: "tts_done" });
    // 第 1 轮正常完结(metrics 上报一次,turnIndex=1),活跃轮未被第二个 turn_end 改写
    expect(metrics.filter((m) => m.turnIndex === 1)).toHaveLength(1);
    expect(metrics.some((m) => m.turnIndex === 2)).toBe(false); // 被忽略的 turn_end 没起新轮
    // 之后真正的新一轮能起(busy 守门已释放)
    ws.emitControl({ type: "asr_final", text: "轮2" });
    ws.emitControl({ type: "turn_end" });
    // 轮 2 的 LLM 流("甲。乙。"=2 句)异步分句下发;为每句补 tts_done 直到轮 2 metric 上报。
    // 原固定 60ms 等待在慢 CI runner 上不够(异步流未出全句 → tts_done 不足 → 轮 2 永不完结 →
    // turnIndex=2 缺失,flaky 根因):改「轮询已下发句、逐句补 done、等 metric」的确定性收敛。
    let doneSent = 0;
    await waitUntil(() => {
      const emitted = ws.textsSent().filter((m) => m.type === "tts_text").length - tts1;
      for (; doneSent < emitted; doneSent++) ws.emitControl({ type: "tts_done" });
      return metrics.some((m) => m.turnIndex === 2);
    });
    expect(metrics.some((m) => m.turnIndex === 2)).toBe(true);
  });

  it("不变量:被打断的轮由抢占方收尾,新轮以全新计数干净开始(身份守尾)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "s1");
    const slow: LlmStreamer = {
      async *stream(_t, signal): AsyncIterable<string> {
        for (const t of ["第一", "句", "。", "第二", "句", "。"]) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, 5));
          yield t;
        }
      },
    };
    const engine = new ThreeStageEngine(gpu, slow);
    const metrics: EngineTurnMetrics[] = [];
    let aiDone = 0;
    engine.onMetrics?.((m) => metrics.push(m));
    engine.onAiDone?.(() => aiDone++);
    await engine.start("s1", "p", params);
    engine.onTurnEvent(() => {});
    // 轮 A
    ws.emitControl({ type: "asr_final", text: "轮A" });
    ws.emitControl({ type: "turn_end" });
    // 轮询等第一句「第一句。」下发(ttsPending>0,流仍在跑);慢 CI runner 上固定 20ms 不够(flaky 根因)。
    await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
    expect(ws.textsSent().filter((m) => m.type === "tts_text").length).toBeGreaterThan(0);
    engine.cancel("barge_in"); // 抢占 A → A 收尾(partial)+ aiDone
    expect(aiDone).toBe(1);
    // GPU guarantees cancel_ack as the output-generation fence before it can
    // process the following turn's tts_text.
    ws.emitControl({ type: "cancel_ack", reason: "barge_in" });
    const ttsAfterA = ws.textsSent().filter((m) => m.type === "tts_text").length;
    // 轮 B(新一轮 turn_end)以全新计数开始
    ws.emitControl({ type: "turn_end" }); // 清 interrupted
    ws.emitControl({ type: "asr_final", text: "轮B" });
    ws.emitControl({ type: "turn_end" });
    // 轮 B 流完整跑完出 "第一句。第二句。"(2 句);轮询等这 2 句都下发(慢 runner 固定 60ms 不够,flaky 根因)。
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length - ttsAfterA >= 2);
    // 轮 B 出 "第一句。第二句。" 收齐其 tts_done 才完结
    const ttsB = ws.textsSent().filter((m) => m.type === "tts_text").length - ttsAfterA;
    for (let i = 0; i < ttsB; i++) ws.emitControl({ type: "tts_done" });
    // A 的 finally 不踩踏 B:B 完整跑完并独立上报(turnIndex=2,full)
    const bMetric = metrics.find((m) => m.turnIndex === 2);
    expect(bMetric?.played).toBe("full");
    // A 被打断 partial(turnIndex=1,cancel 时已立即首报;cancel_ack 再重发核对)
    expect(metrics.find((m) => m.turnIndex === 1)?.played).toBe("partial");
  });

  it("不变量:GPU WS 半断(只收不回)后 busy 守门释放,下一轮能起(P2.0 回归)", async () => {
    jest.useFakeTimers();
    try {
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "s1");
      const engine = new ThreeStageEngine(gpu, new FakeLlm(["回复", "。"]));
      const metrics: EngineTurnMetrics[] = [];
      engine.onMetrics?.((m) => metrics.push(m));
      void engine.start("s1", "p", params);
      ws.emitControl({ type: "ready" });
      engine.onTurnEvent(() => {});
      ws.emitControl({ type: "asr_final", text: "问1" });
      ws.emitControl({ type: "turn_end" });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      jest.advanceTimersByTime(12001); // TTS 超时兜底 → 终结轮1
      expect(metrics.filter((m) => m.turnIndex === 1)).toHaveLength(1);
      // 轮 2 能起(busy 未卡死)
      ws.emitControl({ type: "asr_final", text: "问2" });
      ws.emitControl({ type: "turn_end" });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(metrics.some((m) => m.turnIndex === 2) || ws.textsSent().filter((m) => m.type === "tts_text").length >= 2).toBe(true);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

// ── design contract:拒垃圾输入门槛(治门控解除后漏网的单字残识幻觉开场)──
describe("ThreeStageEngine design contract 拒垃圾输入门槛", () => {
  /** 跑一轮 asr_final + turn_end,返回本轮是否真起了 LLM(以 GPU 收到 tts_text 为准)。 */
  async function runTurn(text: string): Promise<{ ttsTexts: number }> {
    const { ws, engine } = setup(["你好", "。"]); // LLM 会产出一句话
    await engine.start("sess1", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    engine.onTurnEvent(() => {});
    ws.emitControl({ type: "asr_final", text });
    ws.emitControl({ type: "turn_end" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const ttsTexts = ws.textsSent().filter((m) => m.type === "tts_text").length;
    await engine.stop().catch(() => undefined);
    return { ttsTexts };
  }

  it("门控解除后漏网的单字残识(去标点后 < 2 字)→ 不触发 LLM(无 tts_text)", async () => {
    expect((await runTurn("嗯")).ttsTexts).toBe(0); // 单字
    expect((await runTurn("。")).ttsTexts).toBe(0); // 纯标点
    expect((await runTurn(" , ")).ttsTexts).toBe(0); // 空白+标点
    expect((await runTurn("啊。")).ttsTexts).toBe(0); // 单字+标点(去标点后 1 字 < 2)
  });

  it("真人短开场/短回答(≥2 字)仍正常触发 LLM(不误伤)", async () => {
    expect((await runTurn("你好")).ttsTexts).toBeGreaterThan(0);
    expect((await runTurn("在吗")).ttsTexts).toBeGreaterThan(0);
    expect((await runTurn("嗯,能听到")).ttsTexts).toBeGreaterThan(0);
  });
});

// ── design contract:主动开场 kickoff(唤醒输入不写 history;豁免拒垃圾门槛)──
describe("ThreeStageEngine design contract 主动开场 kickoff", () => {
  it("kickoff 跑一轮 LLM(豁免拒垃圾门槛)→ 出 tts_text;唤醒输入不写 history", async () => {
    const { ws, engine, llm } = setup(["你好,我是面试官", "。"]);
    await engine.start("sess1", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    engine.onTurnEvent(() => {});
    engine.kickoff(); // 主动开场
    for (let i = 0; i < 12; i++) await Promise.resolve();
    // 据人设出了开场白(tts_text 下发)
    expect(ws.textsSent().filter((m) => m.type === "tts_text").length).toBeGreaterThan(0);
    // kickoff 轮的唤醒输入用了豁免门槛的极短文本(否则会被拒)
    expect(llm.turns.length).toBe(1);
    await engine.stop().catch(() => undefined);
  });

  it("kickoff 后真人首轮:history 不含 kickoff 唤醒/开场白(不污染上下文)", async () => {
    const { ws, engine, llm } = setup(["开场白", "。"]);
    await engine.start("sess1", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    engine.onTurnEvent(() => {});
    engine.kickoff();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    // 收齐 tts_done 让 kickoff 轮干净结束
    const k = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < k; i++) ws.emitControl({ type: "tts_done" });
    // 真人首轮
    ws.emitControl({ type: "asr_final", text: "我叫张三" });
    ws.emitControl({ type: "turn_end" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    // 真人首轮 LLM 收到的 history 应为空(kickoff 没写进去)
    const realTurn = llm.turns[llm.turns.length - 1];
    expect(realTurn.userText).toBe("我叫张三");
    expect(realTurn.history ?? []).toEqual([]);
    await engine.stop().catch(() => undefined);
  });

  it("kickoff 在已有活跃轮(busy)时忽略,不抢占", async () => {
    const { ws, engine } = setup(["回答", "。"]);
    await engine.start("sess1", "p", params);
    ws.emitControl({ type: "ready" });
    engine.onTurnEvent(() => {});
    // 起一轮真人轮(不收 tts_done,保持 busy/活跃)
    ws.emitControl({ type: "asr_final", text: "你好啊" });
    ws.emitControl({ type: "turn_end" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const before = ws.textsSent().filter((m) => m.type === "tts_text").length;
    engine.kickoff(); // busy → 应忽略
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(ws.textsSent().filter((m) => m.type === "tts_text").length).toBe(before);
    await engine.stop().catch(() => undefined);
  });

  // ── 误打断恢复(design contract):pause/resume 可恢复暂停,区别于 cancel 不可逆销毁 ──

  // ── design contract:nudge(沉默警告/违规说明,让 AI 说一句系统指示的话;isKickoff-style)──
  describe("ThreeStageEngine design contract nudge 契约(review)", () => {
    const qP = (q: unknown[]): EngineParams => ({ engineType: "three_stage", language: "zh-CN", questions: q });
    const QN = [{ text: "第一题:请自我介绍" }, { text: "第二题:谈谈你的项目" }];

    it("空闲时 nudge → 跑一轮 LLM 出 tts_text(AI 说出系统指示的话)", async () => {
      const { ws, engine, llm } = setup(["请及时作答", "。"]);
      await engine.start("sess1", "你是考官", params);
      ws.emitControl({ type: "ready" });
      engine.onTurnEvent(() => {});
      engine.nudge("请提醒对方及时作答");
      await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > 0, 1000);
      expect(ws.textsSent().filter((m) => m.type === "tts_text").length).toBeGreaterThan(0);
      expect(llm.turns.length).toBe(1); // 跑了一轮
      await engine.stop().catch(() => undefined);
    });

    it("busy(已有活跃轮)时 nudge → 忽略,不抢占(不新起轮)", async () => {
      const { ws, engine, llm } = setup(["回答", "。"]);
      await engine.start("sess1", "你是考官", params);
      ws.emitControl({ type: "ready" });
      engine.onTurnEvent(() => {});
      // 起一轮真人轮(不收 tts_done,保持活跃)
      ws.emitControl({ type: "asr_final", text: "我在回答问题" });
      ws.emitControl({ type: "turn_end" });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      const turnsBefore = llm.turns.length;
      const ttsBefore = ws.textsSent().filter((m) => m.type === "tts_text").length;
      engine.nudge("请提醒对方"); // busy → 忽略
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(llm.turns.length).toBe(turnsBefore); // 未新起轮
      expect(ws.textsSent().filter((m) => m.type === "tts_text").length).toBe(ttsBefore);
      await engine.stop().catch(() => undefined);
    });

    it("nudge 触发的指令不写 history(考生没说话,系统指示不进上下文)", async () => {
      const { ws, engine, llm } = setup(["提醒的话", "。"]);
      await engine.start("sess1", "你是考官", params);
      ws.emitControl({ type: "ready" });
      engine.onTurnEvent(() => {});
      engine.nudge("请提醒对方及时作答");
      await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > 0, 1000);
      const k = ws.textsSent().filter((m) => m.type === "tts_text").length;
      for (let i = 0; i < k; i++) ws.emitControl({ type: "tts_done" }); // 让 nudge 轮干净结束
      await waitUntil(() => true, 10);
      // 真人首轮:history 不含 nudge 的系统指示/AI 回应
      ws.emitControl({ type: "asr_final", text: "我叫张三" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => llm.turns.some((t) => t.userText === "我叫张三"), 1000);
      const realTurn = llm.turns[llm.turns.length - 1];
      expect(realTurn.userText).toBe("我叫张三");
      expect(realTurn.history ?? []).toEqual([]); // nudge 未污染 history
      await engine.stop().catch(() => undefined);
    });

    it("nudge 不推进出题游标(警告不是考生作答)", async () => {
      const { ws, engine } = setup(["请及时作答", "。"]);
      await engine.start("sess1", "你是考官", qP(QN));
      ws.emitControl({ type: "ready" });
      engine.onTurnEvent(() => {});
      const cursorBefore = engine.questionCursor?.();
      engine.nudge("请提醒对方及时作答");
      await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > 0, 1000);
      const k = ws.textsSent().filter((m) => m.type === "tts_text").length;
      for (let i = 0; i < k; i++) ws.emitControl({ type: "tts_done" }); // nudge 轮结束(经 maybeAdvanceCursor)
      await waitUntil(() => true, 10);
      expect(engine.questionCursor?.()).toBe(cursorBefore); // 游标未推进
      expect(engine.hasPendingQuestions?.()).toBe(true); // 题还没问完
      await engine.stop().catch(() => undefined);
    });
  });
  describe("误打断恢复 pause/resume(design contract)", () => {
    it("pause 期间 GPU 音频缓存不下发;resume 后按序续发(不丢、不销毁)", async () => {
      const { ws, engine } = setup(["回答"]);
      const chunks: Buffer[] = [];
      engine.onAudioOut((pcm) => chunks.push(pcm));
      engine.onTurnEvent(() => {});
      await engine.start("sess1", "p", params);
      ws.emitControl({ type: "ready" });
      ws.emitControl({ type: "asr_final", text: "你好" });
      ws.emitControl({ type: "turn_end" }); // 起一轮 LLM(活跃轮存活到 onAiDone)
      for (let i = 0; i < 12; i++) await Promise.resolve();
      ws.emitAudio({ seq: 1, bytes: 2 }, Buffer.from([1, 1])); // 暂停前:直发
      engine.pause();
      ws.emitAudio({ seq: 2, bytes: 2 }, Buffer.from([2, 2])); // 暂停期:缓存不发
      ws.emitAudio({ seq: 3, bytes: 2 }, Buffer.from([3, 3]));
      expect(chunks.map((c) => [...c])).toEqual([[1, 1]]); // 只有暂停前那帧
      engine.resume();
      expect(chunks.map((c) => [...c])).toEqual([[1, 1], [2, 2], [3, 3]]); // 缓存续发,顺序不变
    });

    it("pause 期间本轮播完 → onAiDone 被 defer,resume 后补触发", async () => {
      const { ws, engine } = setup(["答", "。"]);
      let aiDone = 0;
      const completedArgs: (boolean | undefined)[] = [];
      engine.onAiDone((completed) => { aiDone += 1; completedArgs.push(completed); });
      engine.onTurnEvent(() => {});
      await engine.start("sess1", "p", params);
      ws.emitControl({ type: "ready" });
      ws.emitControl({ type: "asr_final", text: "你好" });
      ws.emitControl({ type: "turn_end" });
      for (let i = 0; i < 12; i++) await Promise.resolve(); // 等 LLM 出句
      const nSent = ws.textsSent().filter((m) => m.type === "tts_text").length;
      engine.pause();
      // 收齐所有 tts_done(本轮播完)——但在 pause 中,onAiDone 应被 defer
      for (let i = 0; i < nSent; i++) ws.emitControl({ type: "tts_done" });
      expect(aiDone).toBe(0); // defer:暂停期不收尾
      engine.resume();
      expect(aiDone).toBe(1); // resume 后补触发恰好一次
      expect(completedArgs).toEqual([true]); // ★ design contract:暂停期正常播完的 deferred → completed=true
    });

    it("design contract 三审自检:pause 期间本轮 LLM **中途失败**被 defer → 兑现时 completed=false(不误报正常播完)", async () => {
      // 可达路径(pause 不 abort LLM):AI 已出 token 播报 → 考生 barge-in → media-session pause → LLM 继续流 →
      //   LLM 中途 drop(fireAiDone(turn,false))此刻仍 paused → 被 defer。若 defer 兑现硬编码 true 会把「没说完的
      //   失败轮」误报正常播完 → media-session 误进等待作答态起沉默钟。用一个「yield 后等门、放门即抛」的可控 LLM 精确
      //   在 pause 后触发 LLM 抛错。
      let releaseError: () => void = () => {};
      const gate = new Promise<void>((r) => { releaseError = r; });
      const boomWhilePaused: LlmStreamer = {
        async *stream(_turn, signal): AsyncIterable<string> {
          if (signal.aborted) return;
          yield "半句";
          yield "。";
          await gate; // 等测试在 pause 后放门
          throw new Error("bedrock mid-stream drop(paused 期)");
        },
      };
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "sessP");
      const engine = new ThreeStageEngine(gpu, boomWhilePaused);
      let aiDone = 0;
      const completedArgs: (boolean | undefined)[] = [];
      const errors: string[] = [];
      engine.onAiDone((completed) => { aiDone += 1; completedArgs.push(completed); });
      engine.onError((code) => errors.push(code));
      engine.onTurnEvent(() => {});
      await engine.start("sessP", "p", params);
      ws.emitControl({ type: "ready" });
      ws.emitControl({ type: "asr_final", text: "你好" });
      ws.emitControl({ type: "turn_end" });
      for (let i = 0; i < 12; i++) await Promise.resolve(); // LLM 出 2 token、下发 tts_text(活跃轮在途)
      engine.pause(); // 考生 barge-in → 暂停(活跃轮存活,LLM 未 abort)
      releaseError(); // LLM 在暂停期抛错 → fireAiDone(turn,false) → 因 paused 被 defer(保存 completed=false)
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(errors).not.toContain("LLM_STREAM_ERROR"); // 降级不拆机
      expect(aiDone).toBe(0); // 暂停期不收尾(defer)
      engine.resume(); // 退出暂停 → 兑现 deferred
      expect(aiDone).toBe(1);
      // ★ 核心断言:失败轮的 deferred 兑现 MUST 传原始 completed=false(硬编码 true 会让 media-session 误进等待作答态)
      expect(completedArgs).toEqual([false]);
    });

    it("pause 后 cancel(确认打断)→ 丢缓存不续发,resume 变 no-op(销毁优先)", async () => {
      const { ws, engine } = setup(["回答"]);
      const chunks: Buffer[] = [];
      engine.onAudioOut((pcm) => chunks.push(pcm));
      engine.onTurnEvent(() => {});
      await engine.start("sess1", "p", params);
      ws.emitControl({ type: "ready" });
      ws.emitControl({ type: "asr_final", text: "你好" });
      ws.emitControl({ type: "turn_end" });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      engine.pause();
      ws.emitAudio({ seq: 1, bytes: 2 }, Buffer.from([9, 9])); // 暂停期缓存
      engine.cancel("barge_in"); // 确认打断:销毁,清缓存
      engine.resume(); // 已销毁 → no-op
      expect(chunks).toEqual([]); // 缓存被丢,resume 不续发
    });

    it("无活跃轮时 pause = no-op;非暂停态 resume = no-op(幂等)", () => {
      const { engine } = setup(["x"]);
      expect(() => engine.pause()).not.toThrow(); // 无活跃轮
      expect(() => engine.resume()).not.toThrow(); // 非暂停态
    });
  });
});

// ── design contract:退出 tentative-pause 的非 resume 路径 MUST 兑现 deferred onAiDone ──
// 缺口:pause 期间本轮完整播完 → fireAiDone 进 defer 分支(只欠一次 onAiDone),此前只有 resume() 会兑现;
// cancel(确认打断)/turn_end 防御性清理会静默丢弃该完成回调,导致 media-session 收尾记账(kickoff 结算/
// wantsEndCall 评估)整轮被跳过。修复:这两条退出路径清暂停态前也兑现 deferred。
describe("ThreeStageEngine design contract tentative-pause 退出兑现 deferred onAiDone", () => {
  const QS035 = [
    { text: "第一题:自我介绍" },
    { text: "第二题:讲讲项目经历", follow_up: true },
    { text: "第三题:什么是零信任" },
  ];
  const qParams035 = (questions: unknown[]): EngineParams => ({
    engineType: "three_stage",
    language: "zh-CN",
    questions,
  });
  function makeEngine035(tokens: string[], questions?: unknown[]) {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sess035");
    const llm = new FakeLlm(tokens);
    const engine = new ThreeStageEngine(gpu, llm);
    return { ws, gpu, llm, engine };
  }
  /** 把当前活跃轮驱动到「暂停期内完整播完、onAiDone 被 defer」的状态:
   *  起轮 → 排空微任务(LLM 流出完 + 全部 tts_text 下发 + llmStreamComplete=true)→ pause → 补齐全部 tts_done
   *  (最后一个 tts_done 使 fullyPlayed → maybeFireAiDone 调用 fireAiDone,后者进 defer 分支;design contract 起
   *  full metrics 在 fireAiDone 内上报(而非 maybeFireAiDone),故 defer 期间 metrics 未报,兑现/resume 后才报)。
   *  返回 tts_text 句数。 */
  async function driveToDefer(ws: FakeWs, engine: ThreeStageEngine, userText: string): Promise<number> {
    ws.emitControl({ type: "asr_final", text: userText });
    ws.emitControl({ type: "turn_end" });
    for (let i = 0; i < 12; i++) await Promise.resolve(); // 排空:LLM 流出完、句已下发、llmStreamComplete=true
    const nSent = ws.textsSent().filter((m) => m.type === "tts_text").length;
    engine.pause(); // 进 tentative-pause(pausedTurn = 当前活跃轮)
    for (let i = 0; i < nSent; i++) ws.emitControl({ type: "tts_done" }); // 播完 → fireAiDone 进 defer(不触发 onAiDone)
    for (let i = 0; i < 4; i++) await Promise.resolve();
    return nSent;
  }

  it("核心:pause 期间播完 → cancel(barge_in)确认打断 → 兑现 deferred onAiDone(恰一次,metrics 不重复)", async () => {
    const { ws, engine } = makeEngine035(["回答", "。"]);
    let aiDone = 0;
    let metricsCount = 0;
    engine.onAiDone(() => (aiDone += 1));
    engine.onMetrics(() => (metricsCount += 1));
    engine.onTurnEvent(() => {});
    await engine.start("sess035", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    await driveToDefer(ws, engine, "你好");
    // defer:暂停期播完,onAiDone 未触发。★ design contract 起:metrics 也推迟到 fireAiDone 上报,故 defer 期间
    // 尚未上报(修复前 maybeFireAiDone 会先报,现移到 fireAiDone → defer 期不报)。
    expect(aiDone).toBe(0);
    expect(metricsCount).toBe(0);
    // 确认打断(真接管):cancel 清暂停态前 MUST 兑现 deferred onAiDone(此刻才 fireAiDone → 才上报 metrics)。
    engine.cancel("barge_in");
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(aiDone).toBe(1); // deferred 被兑现(修复前:静默丢弃,恒 0)
    expect(metricsCount).toBe(1); // 兑现时上报一次(full,fullyPlayed);metricsReported 守卫防重复
  });

  it("C1 回归:deferred 轮带 [[END_CALL]] 被确认打断 → 兑现前已清 endCallSignaled,不误挂断", async () => {
    // deferred 轮恰是「AI 说完告别语([[END_CALL]])、暂停期播完」的轮。cancel 语义是「用户想继续」,
    // 兑现 fireAiDone → aiDoneCb→wantsEndCall() 读到的必须是已清的 false,否则「打断告别轮反而被挂断」。
    const { ws, engine } = makeEngine035(["好的再见", "\n", "[[END_CALL]]"]); // 无题(纯人设)→ END_CALL 不被压制
    let endCallAtAiDone: boolean | null = null;
    engine.onAiDone(() => {
      // 模拟 media-session.onAiDone 的真实查询(wantsEndCall 读后清)。
      endCallAtAiDone = engine.wantsEndCall();
    });
    engine.onTurnEvent(() => {});
    await engine.start("sess035", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    await driveToDefer(ws, engine, "我说完了");
    engine.cancel("barge_in");
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(endCallAtAiDone).toBe(false); // 兑现时告别信号已被清(先清 endCallSignaled 再 fireAiDone)
  });

  it("确认打断时 autoNextAfterDone 被消费但因 interrupted 放弃发起(让位,不抢话问下一题)", async () => {
    const { ws, llm, engine } = makeEngine035(["我叫张三来自北京做后端开发", "。"], QS035);
    let aiDone = 0;
    engine.onAiDone(() => (aiDone += 1));
    engine.onTurnEvent(() => {});
    await engine.start("sess035", "你是面试官", qParams035(QS035));
    ws.emitControl({ type: "ready" });
    // 第 1 题(非 follow_up)有效作答 → 游标推进到第 2 题、autoNextAfterDone=true;暂停期播完 → defer。
    await driveToDefer(ws, engine, "我叫张三来自北京做后端开发");
    const turnsBefore = llm.turns.length;
    engine.cancel("barge_in"); // 确认打断:兑现 aiDoneCb,但 interrupted=true 使 maybeAutoAskNext 放弃
    await waitUntil(() => aiDone === 1, 200); // 等收尾回调真正兑现(cancel 内 fireAiDone 同步触发)
    await new Promise((r) => setTimeout(r, 80)); // 再给一个真实延迟窗,确认没有自动轮偷偷起来
    expect(aiDone).toBe(1); // 收尾回调兑现
    expect(llm.turns.length).toBe(turnsBefore); // MUST NOT 起自动问下一题轮(用户已接管,让位)
  });

  it("回归:pause 期间本轮未播完(ttsPending>0)cancel → 走既有 partial 分支,不因本 spec 多触发", async () => {
    const { ws, engine } = makeEngine035(["第一句", "。", "第二句", "。"]);
    let aiDone = 0;
    let metricsCount = 0;
    engine.onAiDone(() => (aiDone += 1));
    engine.onMetrics(() => (metricsCount += 1));
    engine.onTurnEvent(() => {});
    await engine.start("sess035", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    ws.emitControl({ type: "asr_final", text: "你好" });
    ws.emitControl({ type: "turn_end" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const nSent = ws.textsSent().filter((m) => m.type === "tts_text").length;
    expect(nSent).toBeGreaterThan(1); // 有多句在飞
    engine.pause();
    ws.emitControl({ type: "tts_done" }); // 只收一个 → ttsPending 仍 >0,未 fullyPlayed,不进 defer
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(aiDone).toBe(0); // 尚未播完,也未 defer(deferredAiDoneTurn 为空)
    engine.cancel("barge_in"); // 走既有 `ttsPending>0` 半途轮分支:partial 上报 + fireAiDone 一次
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(aiDone).toBe(1); // 恰一次(既有行为,不因本 spec 新分支叠加)
    expect(metricsCount).toBe(1); // 仅这一次 partial(deferred 分支未命中,不产生额外 metrics)
  });

  it("turn_end 防御性清理:暂停中残留 deferred 收到 turn_end → 兑现而非静默丢弃", async () => {
    const { ws, engine } = makeEngine035(["回答", "。"]);
    let aiDone = 0;
    engine.onAiDone(() => (aiDone += 1));
    engine.onTurnEvent(() => {});
    await engine.start("sess035", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    await driveToDefer(ws, engine, "你好");
    expect(aiDone).toBe(0); // defer 中
    // 异常序列(理论上不可达,防御一致性):暂停中收到 turn_end → 防御性清理分支先兑现 deferred 再清暂停态。
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => aiDone === 1, 200); // 显式等兑现(不靠固定 microtask 次数,避免 flaky)
    expect(aiDone).toBe(1); // deferred 被兑现(修复前:随暂停态被静默清掉,恒 0)
  });

  it("turn_end 防御性清理 + lastFinalText 非空:兑现 deferred 后不产生双轮(review补覆盖)", async () => {
    // review补覆盖:防御分支兑现 deferred 时 interrupted 已被本 turn_end 置 false → 兑现的 fireAiDone
    // 会走 design contract 排水;若此刻 lastFinalText 非空,排水起一轮 runLlmTurn(设 activeTurn),紧随其后的
    // `!llmBusy` 分支见 busy 让位——**只起一轮**,不叠加双轮。此测试锁死这条契约。
    const { ws, llm, engine } = makeEngine035(["回答", "。"]);
    let aiDone = 0;
    engine.onAiDone(() => (aiDone += 1));
    engine.onTurnEvent(() => {});
    await engine.start("sess035", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    await driveToDefer(ws, engine, "你好"); // 进 defer(deferredAiDoneTurn 已置)
    const turnsBefore = llm.turns.length;
    // 防御分支到达前先来一个新 asr_final,使 lastFinalText 非空(模拟"排水有料可消费")。
    ws.emitControl({ type: "asr_final", text: "还有一个问题" });
    ws.emitControl({ type: "turn_end" }); // 防御性清理 → 兑现 deferred(排水消费"还有一个问题"起一轮)
    await waitUntil(() => aiDone === 1, 200);
    await new Promise((r) => setTimeout(r, 80)); // 真实延迟窗:确认没有第二轮偷偷起来
    expect(aiDone).toBe(1); // deferred 兑现恰一次
    expect(llm.turns.length).toBe(turnsBefore + 1); // 排水只起一轮(非空 lastFinalText),MUST NOT 双轮
    expect(llm.turns[llm.turns.length - 1].userText).toBe("还有一个问题"); // 起的是排水消费的那句
  });

  // ── design contract:full metrics 上报推迟到 fireAiDone(而非 maybeFireAiDone),使 falseInterruption 不丢失 ──
  it("design contract:暂停期播完时 metrics 不提前上报(推迟到 fireAiDone,让 falseInterruption 能先写入)", async () => {
    // 核心保证:tentative-pause 期间本轮播完,full metrics MUST NOT 在此刻上报(否则 media-session 的
    // onMetrics 会消费 pendingEndpoint,之后 onRecoveryWindowElapsed 写 falseInterruption 落空)。推迟到
    // fireAiDone 真正执行(resume/cancel 兑现)时才报 → 那时 falseInterruption 已写进 pendingEndpoint。
    const { ws, engine } = makeEngine035(["回答", "。"]);
    let metricsCount = 0;
    engine.onMetrics(() => (metricsCount += 1));
    engine.onTurnEvent(() => {});
    await engine.start("sess038", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    await driveToDefer(ws, engine, "你好"); // 暂停期播完 → fireAiDone 进 defer
    expect(metricsCount).toBe(0); // ★ design contract:defer 期间 MUST 未上报(修复前 maybeFireAiDone 会先报=1 → bug)
    engine.resume(); // 误打断恢复 → 兑现 fireAiDone → 此刻才上报
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(metricsCount).toBe(1); // resume 兑现时上报一次(full)
  });

  it("design contract:resume 兑现的 full metrics 恰好一次;正常播完(无暂停)metrics 时机不变", async () => {
    // 无暂停正常播完:fireAiDone 立即执行(不 defer)→ metrics 在其中上报,对上层仍是"播完即上报"一次。
    const { ws, engine } = makeEngine035(["好", "的", "。"]);
    let aiDone = 0;
    let metricsCount = 0;
    engine.onAiDone(() => (aiDone += 1));
    engine.onMetrics(() => (metricsCount += 1));
    engine.onTurnEvent(() => {});
    await engine.start("sess038", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    ws.emitControl({ type: "asr_final", text: "在吗" });
    ws.emitControl({ type: "turn_end" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const nSent = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < nSent; i++) ws.emitControl({ type: "tts_done" }); // 全播完 → fireAiDone 立即执行
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(aiDone).toBe(1);
    expect(metricsCount).toBe(1); // 恰好一次(full),无暂停时上报时机与修复前等价
  });
});

// ── design contract:cancel 在句间空窗(ttsPending==0 但本轮未收尾)也收尾本轮 ──
// design contract 的同源姊妹修复:035 补"暂停期已播完的 deferred 轮",R2 补"未暂停、打断落在句间空窗、
// 本轮尚未 aiDoneFired"的轮。旧判据 `ttsPending > 0` 会漏掉:①句间空窗(第1句已收 tts_done、
// ttsPending 归零,LLM 仍在生成第2句)②首句未 dispatch 即打断——这些轮 aiDoneFired 永不置、metrics 丢失。
describe("ThreeStageEngine design contract cancel 句间空窗收尾", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const TOKEN_DELAY_MS = 30;
  /** 慢速多句 LLM:第1句"你好。"先出,随后间隔吐第2句"再见。"——留出"第1句已下发、第2句还在流"的窗口。 */
  function makeSlowMultiSentence() {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sess036");
    const turns: LlmTurn[] = [];
    const slow: LlmStreamer = {
      async *stream(turn, signal): AsyncIterable<string> {
        turns.push(turn);
        for (const t of ["你好。", "再见。"]) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, TOKEN_DELAY_MS));
          yield t;
        }
      },
    };
    const engine = new ThreeStageEngine(gpu, slow);
    return { ws, gpu, engine, turns };
  }
  function ttsCount(ws: FakeWs): number {
    return ws.textsSent().filter((m) => m.type === "tts_text").length;
  }

  it("句间空窗(ttsPending==0、第2句还在流)被打断 → reportMetrics(partial,bargeIn)+fireAiDone 恰一次", async () => {
    const { ws, engine } = makeSlowMultiSentence();
    let aiDone = 0;
    const metrics: EngineTurnMetrics[] = [];
    engine.onAiDone(() => (aiDone += 1));
    engine.onMetrics((m) => metrics.push(m));
    engine.onTurnEvent(() => {});
    await engine.start("sess036", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    ws.emitControl({ type: "asr_final", text: "你好" });
    ws.emitControl({ type: "turn_end" });
    // 等第1句"你好。"下发(tts_text 出现),此刻 LLM 仍在等 TOKEN_DELAY 吐第2句(llmStreamComplete=false)。
    await waitUntil(() => ttsCount(ws) >= 1, 500);
    ws.emitControl({ type: "tts_done" }); // 第1句播完 → ttsPending 归零(句间空窗形成)
    await sleep(2); // 让 tts_done 处理完;此刻 ttsPending==0 且 llmStreamComplete 仍 false
    // 确定性(review):cancel 前只下发过 1 句(第2句还没 dispatch),坐实"句间空窗"前提。
    expect(ttsCount(ws)).toBe(1);
    // 句间空窗打断:旧判据 ttsPending>0 为假会完全跳过收尾;R2 放宽后仍收尾一次。
    engine.cancel("barge_in");
    await sleep(TOKEN_DELAY_MS * 2); // 给足时间确认无重复/遗漏
    expect(aiDone).toBe(1); // 恰一次(修复前:恒 0,静默丢轮)
    expect(metrics.length).toBe(1); // partial 恰一次
    expect(metrics[0].played).toBe("partial"); // 口径:被打断合成未完成
    expect(metrics[0].bargeIn).toBe(true); // barge_in 触发标记(供误打断 vs 真打断分析)
  });

  it("句间空窗被打断的 kickoff 轮:kickoffPending 结算不卡死(fireAiDone 触发 onAiDone)", async () => {
    // kickoff 轮走同一 cancel 收尾路径;媒体面在 onAiDone 里 settleKickoff。这里只验引擎侧 onAiDone 恰触发一次
    //(媒体面结算是 onAiDone 的下游,引擎侧不丢 onAiDone 即保证不卡死)。
    const { ws, engine } = makeSlowMultiSentence();
    let aiDone = 0;
    engine.onAiDone(() => (aiDone += 1));
    engine.onTurnEvent(() => {});
    await engine.start("sess036", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    engine.kickoff(); // kickoff 轮(慢速多句)
    await waitUntil(() => ttsCount(ws) >= 1, 500);
    ws.emitControl({ type: "tts_done" }); // 第1句播完 → 句间空窗
    await sleep(2);
    engine.cancel("barge_in");
    await sleep(TOKEN_DELAY_MS * 2);
    expect(aiDone).toBe(1); // kickoff 轮也恰好收尾一次(不卡死到下一次不相关 onAiDone)
  });

  it("首句未 dispatch 即被打断(dispatchedText 空、ttsPending==0)→ 收尾恰一次、history 不写", async () => {
    const { ws, engine } = makeSlowMultiSentence();
    let aiDone = 0;
    let metricsCount = 0;
    const aiTranscripts: string[] = [];
    engine.onAiDone(() => (aiDone += 1));
    engine.onMetrics(() => (metricsCount += 1));
    engine.onTranscript(() => {}); // 忽略 asr
    engine.onLlmText((text) => aiTranscripts.push(text)); // AI 文本落库入口
    engine.onTurnEvent(() => {});
    await engine.start("sess036", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    ws.emitControl({ type: "asr_final", text: "你好" });
    ws.emitControl({ type: "turn_end" });
    // 不等任何 tts_text(TOKEN_DELAY 前 LLM 一个 token 都没出)→ dispatchedText 空、ttsPending==0。
    await sleep(TOKEN_DELAY_MS / 3); // 远早于首 token(30ms)
    expect(ttsCount(ws)).toBe(0); // 确认一句都没下发
    engine.cancel("barge_in");
    await sleep(TOKEN_DELAY_MS * 3);
    expect(aiDone).toBe(1); // 收尾恰一次(不因"无句下发"静默丢轮)
    expect(metricsCount).toBe(1);
    // history 不写截断记录(无"已听到内容",沿用 design contract):onLlmText 未被以截断文本调用。
    expect(aiTranscripts.filter((t) => t.includes("[被打断]"))).toEqual([]);
  });

  it("回归:半途轮(ttsPending>0)被打断仍走既有 partial 分支,行为不变", async () => {
    const { ws, engine } = makeSlowMultiSentence();
    let aiDone = 0;
    let metricsCount = 0;
    engine.onAiDone(() => (aiDone += 1));
    engine.onMetrics(() => (metricsCount += 1));
    engine.onTurnEvent(() => {});
    await engine.start("sess036", "你是面试官", params);
    ws.emitControl({ type: "ready" });
    ws.emitControl({ type: "asr_final", text: "你好" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ttsCount(ws) >= 1, 500); // 第1句已下发
    // 不补 tts_done → ttsPending 仍 >0(半途轮);打断走既有分支。
    engine.cancel("barge_in");
    await sleep(TOKEN_DELAY_MS * 2);
    expect(aiDone).toBe(1); // 恰一次(既有行为)
    expect(metricsCount).toBe(1);
  });
});

// ── 出题游标服务端强推进(design contract「出题游标由服务端强推进」+ 021 [[NEXT]] 哨兵)──
describe("ThreeStageEngine 出题游标", () => {
  const QS = [
    { text: "第一题:自我介绍" },
    { text: "第二题:讲讲项目经历", follow_up: true },
    { text: "第三题:什么是零信任", reference_answer: "永不信任始终验证" },
  ];
  const qParams = (questions: unknown[]): EngineParams => ({
    engineType: "three_stage",
    language: "zh-CN",
    questions,
  });

  /** 驱动一整轮**正常完整**对话:asr_final + turn_end → 等 LLM 流 → 为本轮每句补 tts_done(触发 maybeFireAiDone
   *  正常完成路径,唯一会评估游标推进的路径)。userText 决定判据 (b) 的有效字数。 */
  async function fullTurn(ws: FakeWs, userText: string): Promise<void> {
    const before = ws.textsSent().filter((m) => m.type === "tts_text").length;
    ws.emitControl({ type: "asr_final", text: userText });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > before);
    // 为本轮新下发的每句补 tts_done(GPU 正常播完)→ ttsPending 归零 + llmStreamComplete → maybeFireAiDone。
    const after = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = before; i < after; i++) ws.emitControl({ type: "tts_done" });
    // 最后一条 done 可同步触发 direct auto-next；常规多轮 helper 将它也视为完整播完，避免下一次
    // turn_end 被正确的 direct busy 守门悬挂。专门的 direct 打断测试不用本 helper。
    const withDirect = ws.textsSent().filter((m) => m.type === "tts_text");
    for (let i = after; i < withDirect.length; i++) {
      const text = String(withDirect[i].text ?? "");
      if (text.startsWith("接下来，") || text.startsWith("Next, ")) ws.emitControl({ type: "tts_done" });
    }
    await waitUntil(() => true, 10);
  }

  function makeEngine(tokens: string[], questions: unknown[]) {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new FakeLlm(tokens);
    const engine = new ThreeStageEngine(gpu, llm);
    return { ws, gpu, llm, engine };
  }

  it("第1轮 prompt 只含第1题,未问的第2/3题不可见(顺序由代码保证)", async () => {
    const { ws, llm, engine } = makeEngine(["回答", "。"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    ws.emitControl({ type: "asr_final", text: "你好我准备好了" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length >= 1);
    const sp = llm.turns[0].systemPrompt;
    expect(sp).toContain("第 1/3 题");
    expect(sp).toContain("自我介绍");
    expect(sp).not.toContain("项目经历"); // 未问题不可见
    expect(sp).not.toContain("零信任");
  });

  it("当前题参考答案不进入实时 LLM prompt,只保留给 evaluator", async () => {
    const privateAnswer = "所有现有 QuickSight API、SDK 和集成都可继续工作且无需改动";
    const questions = [{
      text: "Amazon Quick 与原来的 Amazon QuickSight 是什么关系?现有 API 和集成会受影响吗?",
      reference_answer: privateAnswer,
    }];
    const { ws, llm, engine } = makeEngine(["请回答这个问题。"], questions);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));

    ws.emitControl({ type: "asr_final", text: "我准备好了" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length >= 1);

    expect(llm.turns[0].systemPrompt).toContain(questions[0].text);
    expect(llm.turns[0].systemPrompt).not.toContain(privateAnswer);
    expect(llm.turns[0].systemPrompt).not.toContain("参考答案");
  });

  it("当前题已完整念出后,下一轮 prompt 禁止重复题干", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "第一题:自我介绍?",
      "好的。\n[[NEXT]]",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));

    await fullTurn(ws, "你好我准备好了"); // 本轮完整逐字念出 Q1
    await fullTurn(ws, "我叫张三,从事后端开发"); // 回答后的同题处理轮

    expect(llm.turns.length).toBeGreaterThanOrEqual(2);
    const followupPrompt = llm.turns[1].systemPrompt;
    expect(followupPrompt).toContain("已经完整问过");
    expect(followupPrompt).toContain("不要重复题干");
    expect(followupPrompt).not.toContain("问题本身要原文逐字念出");
  });

  it("有效作答 + [[NEXT]] → 推进到第2题(下一轮 prompt 换题)", async () => {
    // design contract:去题目级 follow_up,所有题「[[NEXT]] 主导」——无信号时不抢推,等待澄清回应或静默兜底。
    const { ws, llm, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京做后端开发"); // 第1题有效作答 + [[NEXT]] → 推进到第2题
    await fullTurn(ws, "我做过一个电商项目负责订单系统"); // 触发第2轮 → 校验 prompt 已换题
    expect(llm.turns.length).toBeGreaterThanOrEqual(2);
    expect(llm.turns[1].systemPrompt).toContain("第 2/3 题");
    expect(llm.turns[1].systemPrompt).toContain("项目经历");
    // 已问摘要含题干,但 MUST NOT 泄漏未来题的参考答案(第3题 reference_answer);当前题(第2题)无参考答案。
    expect(llm.turns[1].systemPrompt).not.toContain("永不信任"); // 第3题 reference_answer 不得提前出现
    expect(llm.turns[1].systemPrompt).toContain("已聊过的问题"); // 承上启下摘要(design contract 措辞)
  });

  it("沉默/空轮(有效字数不足)→ 不推进,仍停在第1题", async () => {
    const { ws, llm, engine } = makeEngine(["请再说一下", "。"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    // "没想好"(3 有效字):过拒垃圾门槛(≥2,一轮会跑)但 < minAnswerChars(4)→ 判未有效作答,不推进。
    await fullTurn(ws, "没想好");
    await fullTurn(ws, "不太会"); // 再次未有效作答
    expect(llm.turns.length).toBeGreaterThanOrEqual(2);
    // 两轮都跑了但游标始终停在第1题
    expect(llm.turns[0].systemPrompt).toContain("第 1/3 题");
    expect(llm.turns[llm.turns.length - 1].systemPrompt).toContain("第 1/3 题");
  });

  it("design contract:最多播出两次追问,第三次用户回答进入强制收口并推进", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "能展开说说吗?",
      "还可以再具体一点吗?",
      "好的,这个问题我们先到这里。\n[[NEXT]]",
      "请回答第二题。",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京做后端");
    await fullTurn(ws, "我做过一个电商订单系统项目");
    expect(engine.questionCursor()).toBe(0); // 两个已播追问都获得用户回答机会
    await fullTurn(ws, "还负责了库存模块的重构");
    expect(llm.turns[2].systemPrompt).toContain("追问机会已用完");
    expect(llm.turns[2].systemPrompt).toContain("[[NEXT]]");
    expect(llm.turns[2].systemPrompt).not.toContain("问题本身要原文逐字念出");
    expect(llm.turns[2].systemPrompt).not.toContain("答得不充分");
    expect(llm.turns[1].systemPrompt).toContain("不要在本轮做总体评价");
    expect(engine.questionCursor()).toBe(1);
  });

  it("design contract:强制收口轮若模型仍追问,原文不进 TTS/transcript/history,改播固定中立文本并推进", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const rawVisible = "所有问题都完成了。请解释权限模型。";
    const rawViolation = `${rawVisible}\n[[NEXT]]`;
    const llm = new ScriptedLlm(["请再展开一下?", "还能补充一点吗?", rawViolation, "第二题"]);
    const engine = new ThreeStageEngine(gpu, llm);
    const aiTexts: string[] = [];
    engine.onTurnEvent(() => {});
    engine.onLlmText((text) => aiTexts.push(text));
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京做后端");
    await fullTurn(ws, "我负责订单系统和库存模块");
    const ttsBefore = ws.textsSent().filter((m) => m.type === "tts_text").length;
    await fullTurn(ws, "我还做了缓存和消息队列优化");
    const spoken = ws.textsSent().filter((m) => m.type === "tts_text").slice(ttsBefore)
      .map((m) => String(m.text ?? "")).join("");
    expect(spoken).toContain("这个问题我们先到这里");
    expect(spoken).not.toContain(rawVisible);
    expect(aiTexts.join("\n")).not.toContain(rawVisible);
    expect(engine.correctionContext().history.map((m) => m.content).join("\n")).not.toContain(rawVisible);
    expect(engine.questionCursor()).toBe(1);
  });

  it("design contract:completed=false 的追问轮不消耗预算,下轮仍有两次完整追问机会", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "第一次追问吗?", // 被 cancel,不计
      "完整追问一吗?",
      "完整追问二吗?",
      "好的,这个问题我们先到这里。\n[[NEXT]]",
      "第二题",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
    engine.cancel("barge_in"); // completed=false
    // Fence cancelled TTS identities before the next turn can produce output.
    ws.emitControl({ type: "cancel_ack", reason: "barge_in" });
    await fullTurn(ws, "我负责电商订单系统");
    await fullTurn(ws, "我还负责库存和缓存");
    expect(engine.questionCursor()).toBe(0);
    await fullTurn(ws, "最后还做了消息队列优化");
    expect(llm.turns[3].systemPrompt).toContain("追问机会已用完");
    expect(engine.questionCursor()).toBe(1);
  });

  it("有效作答 + AI 非问句收口(漏发 [[NEXT]])→ retry 达上限仍强推(design contract backstop 保留)", async () => {
    // 对照上一测试:AI 回复是**陈述收口**(「好的这个问题就到这里」无疑问 cue)但漏发 [[NEXT]] → aiIsAsking=false →
    //   retry 达上限**仍强推**(防 R3 关时死锁)。豁免只作用于真追问,不放过漏发哨兵的收尾。
    const { ws, llm, engine } = makeEngine(["好的这个问题就到这里", "。"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京做后端"); // retry 1
    await fullTurn(ws, "我做过一个电商订单系统项目"); // retry 2
    await fullTurn(ws, "还负责了库存模块的重构"); // retry 3 = 上限,非问句 → 强推到第2题
    expect(engine.questionCursor()).toBe(1);
    expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
  });

  it("追问题:LLM 输出 [[NEXT]] → 推进到第3题([[NEXT]] 辅助信号)", async () => {
    // 第2题(follow_up)轮,LLM 回复末尾带 [[NEXT]] → 已作答 + 收尾信号 → 推进
    const { ws, llm, engine } = makeEngine(["好的了解", "\n", "[[NEXT]]"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京"); // 第1题 → 推进到第2题
    await fullTurn(ws, "我做过电商订单系统这个项目挺复杂的"); // 第2题作答 + LLM 发 [[NEXT]] → 推进到第3题
    expect(engine.questionCursor()).toBe(2);
    expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[2].text}`)).toBe(true);
  });

  it("[[NEXT]] 哨兵被剥离,不进 TTS", async () => {
    const { ws, engine } = makeEngine(["下一题", "\n", "[[NEXT]]"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
    const joined = ws.textsSent().filter((m) => m.type === "tts_text").map((m) => m.text).join("");
    expect(joined).toContain("下一题");
    expect(joined).not.toMatch(/NEXT|\[\[|\]\]/); // 哨兵任何残形不进 TTS
  });

  it("防死循环:同题重问达上限(默认3)→ 强制推进", async () => {
    const { ws, llm, engine } = makeEngine(["请回答", "。"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    // 第1题连续无效作答("没想好"=3字,过拒垃圾门槛但 <4 未有效作答)→ 达上限(3)强制推进
    await fullTurn(ws, "没想好");
    await fullTurn(ws, "没想好");
    await fullTurn(ws, "没想好"); // 第3次达上限 → 强制推进到第2题
    await fullTurn(ws, "没想好"); // 再跑一轮观察推进后的游标
    const last = llm.turns[llm.turns.length - 1].systemPrompt;
    expect(last).toContain("第 2/3 题");
  });

  // ── design contract:aiIsAsking 判据(白盒 + 集成)——追问豁免只作用真追问 ──
  it("design contract:无问号追问也计入独立预算,两次后第三轮强制收口", async () => {
    // 覆盖 design contract 铁证:AI 问「具体可以做哪些响应?」这类**含疑问词但真机 ASR 可能丢问号**的追问也要豁免。
    // 这里 LLM 输出「请具体说说有哪些响应」——含「哪」cue 词,QUESTION_CUE_RE 命中 → aiIsAsking=true。
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "请具体说说有哪些响应。",
      "请再说说哪一种最重要。",
      "好的,这个问题我们先到这里。\n[[NEXT]]",
      "第二题",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    for (let i = 0; i < 3; i++) await fullTurn(ws, "我做过一个电商订单系统项目很复杂");
    expect(engine.questionCursor()).toBe(1);
  });

  it("R2 白盒 aiIsAsking:剥哨兵后判疑问 + pendingReply undefined fail-safe", async () => {
    const { engine } = makeEngine(["x"], QS);
    const eng = engine as unknown as { aiIsAsking(t: { pendingReply?: string }): boolean };
    // 剥 [[NEXT]] 后含 ? → true(虽有 [[NEXT]] 本走推进,测剥离正确性);
    expect(eng.aiIsAsking({ pendingReply: "还有吗?[[NEXT]]" })).toBe(true);
    // 含疑问词无问号 → true;
    expect(eng.aiIsAsking({ pendingReply: "能再展开一下吗" })).toBe(true);
    // 陈述收口(无 cue)→ false;
    expect(eng.aiIsAsking({ pendingReply: "好的这个问题就到这里" })).toBe(false);
    // pendingReply undefined(异常轮没走到流末暂存)→ false(不豁免异常轮);
    expect(eng.aiIsAsking({ pendingReply: undefined })).toBe(false);
    // 纯哨兵剥完为空 → false。
    expect(eng.aiIsAsking({ pendingReply: "[[NEXT]]" })).toBe(false);
  });

  it("明确拒答(不会/跳过)→ 视作已尝试,立即推进(不熬 retry 上限,判据 d-SHOULD)", async () => {
    const { ws, llm, engine } = makeEngine(["那我们继续", "。"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    // "不会"= 2 有效字 < minAnswerChars(4) → 进 !answered 分支 + 命中 DECLINE_RE → 立即推进(不经 [[NEXT]]/不熬 3 轮)。
    // (design contract:拒答/告别的立即推进走 !answered 分支,不受「所有题 [[NEXT]] 主导」影响——只有已作答分支才要 [[NEXT]]。)
    await fullTurn(ws, "不会");
    await fullTurn(ws, "我说说项目经历"); // 触发下一轮,校验已推进到第2题
    expect(llm.turns[llm.turns.length - 1].systemPrompt).toContain("第 2/3 题");
  });

  it("短实质作答(含歧义字如'过')不被拒答正则误推(DECLINE_RE 收窄回归)", async () => {
    const { ws, llm, engine } = makeEngine(["请展开说说", "。"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "说过了"); // 3 字 < 4 未达门槛,但"过"不该触发拒答 → 不推进,停第1题
    await fullTurn(ws, "学过的"); // 同样含"过"但非拒答
    expect(llm.turns[llm.turns.length - 1].systemPrompt).toContain("第 1/3 题");
  });

  it("长答案中的'不能/不会'是题目观点而非拒答,不得强推游标", async () => {
    const { ws, llm, engine } = makeEngine(["你能再确认一下吗?"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "这个功能不能访问自己的数据,也不会生成带引用的报告");
    expect(engine.questionCursor()).toBe(0);
    expect(llm.turns).toHaveLength(1);
  });

  it("异常终结(TTS 超时)不推进游标(判据 a)", async () => {
    jest.useFakeTimers();
    const { ws, llm, engine } = makeEngine(["回答一", "。"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端开发" });
    ws.emitControl({ type: "turn_end" });
    // 等 LLM 流出完、发出 tts_text,但 GPU **只收不回**(不补 tts_done)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(13000); // 触发引擎级 TTS 超时(onTtsTimeout → fireAiDone,不经 maybeFireAiDone)
    jest.useRealTimers();
    // 下一轮:游标仍应在第1题(异常终结不推进)
    ws.emitControl({ type: "asr_final", text: "喂还在吗我继续说" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length >= 2);
    expect(llm.turns[llm.turns.length - 1].systemPrompt).toContain("第 1/3 题");
  });

  it("念题中被 barge-in 打断不推进、游标不回退", async () => {
    // design contract:作答后须 [[NEXT]] 才推进 → 第1轮作答带 [[NEXT]] 推进到第2题;后续被打断轮不经推进路径(cancel 直达)。
    const { ws, llm, engine } = makeEngine(["自我介绍一下", "。", "\n", "[[NEXT]]"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    // 第1题:先正常作答(第1轮 prompt=第1题;推进在轮末发生)
    await fullTurn(ws, "我叫张三来自北京做后端");
    // 第2轮 AI 念题中被打断(cancel 走 fireAiDone 直达,不经 maybeFireAiDone → 不推进);
    // 此第2轮起时游标已在第2题(校验推进已生效)。
    ws.emitControl({ type: "asr_final", text: "我想想" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length >= 2 && ws.textsSent().some((m) => m.type === "tts_text"));
    expect(llm.turns[1].systemPrompt).toContain("第 2/3 题"); // 第1题作答后已推进
    engine.cancel("barge_in");
    // 下一轮:游标仍在第2题(打断不前进、不回退)
    ws.emitControl({ type: "asr_final", text: "好我说说我的项目经历" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length >= 3);
    expect(llm.turns[llm.turns.length - 1].systemPrompt).toContain("第 2/3 题");
  });

  // ── design contract:去题目级 follow_up,所有题「[[NEXT]] 主导」——已问出口的澄清必须给回答机会 ──
  it("design contract:任意题有效作答但无 [[NEXT]] → 不抢推(给澄清回答机会),游标停当前题", async () => {
    // 旧「非 follow_up 题作答即推进」已去除;无 [[NEXT]] 时等待澄清回应或静默兜底。
    const { ws, llm, engine } = makeEngine(["能再展开说说吗", "?"], QS); // AI 追问、不发 [[NEXT]]
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京做后端开发"); // 第1题有效作答但 AI 追问无 [[NEXT]]
    await fullTurn(ws, "主要用 Java 和 Go"); // 继续答追问,仍无 [[NEXT]]
    // 游标 MUST 仍停第1题(不被 autoNext 抢推到第2题)——这正是部署回归 问题②的修复
    expect(llm.turns[llm.turns.length - 1].systemPrompt).toContain("第 1/3 题");
    expect(engine.questionCursor()).toBe(0);
  });

  it("design contract:answerSeenForCursor sticky —— 作答前 false / 有效作答后 true / 推进后新题重置 false", async () => {
    const { ws, llm, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    // 第1题尚未作答 → false(media 静默兜底据此归 design contract 防作弊轨,不启 R3 善意兜底)
    expect(engine.answerSeenForCursor?.()).toBe(false);
    await fullTurn(ws, "我叫张三来自北京做后端开发"); // 有效作答 + [[NEXT]] → 置 sticky 后推进到第2题
    // 推进后到新题(第2题)→ answerSeenForCursor 随游标重置 false(新题从头)
    expect(engine.questionCursor()).toBe(1);
    expect(engine.answerSeenForCursor?.()).toBe(false);
  });

  it("design contract:有效作答后即便本轮无 [[NEXT]] 也置 answerSeen=true(态2 真实追问在等回应)", async () => {
    const { ws, llm, engine } = makeEngine(["能展开说说吗", "?"], QS); // 无 [[NEXT]]
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京做后端开发"); // 有效作答(未推进,AI 在追问)
    // answerSeen=true(答过了)→ media 静默兜底据此归 R3 善意轨(而非 design contract 防作弊);游标仍停第1题
    expect(engine.answerSeenForCursor?.()).toBe(true);
    expect(engine.questionCursor()).toBe(0);
  });

  it("design contract:长告别句(字数达门槛)仍立即推进(DECLINE/FAREWELL 前置于 [[NEXT]] 判定,防真机回归)", async () => {
    // 回归锁:去 follow_up 后若不把 DECLINE/FAREWELL 前置,长告别句(answered=true)会落入「无 [[NEXT]] 不推进」被卡住。
    const { ws, llm, engine } = makeEngine(["好的我们继续", "。"], QS); // 不含 [[NEXT]]
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我不想继续了到这里吧"); // 长告别句(≥4 字)→ FAREWELL 前置命中 → 立即推进(不等 [[NEXT]])
    await fullTurn(ws, "那说说项目经历"); // 下一轮校验已在第2题
    expect(llm.turns[llm.turns.length - 1].systemPrompt).toContain("第 2/3 题");
  });

  it("同轮 [[NEXT]] + [[END_CALL]] 且未至末题 → 推进优先,压制收尾", async () => {
    const { ws, llm, engine } = makeEngine(["好的", "\n", "[[NEXT]]", "[[END_CALL]]"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京做后端开发"); // 第1题作答 + 同轮双哨兵
    // 未至末题:END_CALL 被压制(不挂),游标推进到第2题
    expect(engine.wantsEndCall()).toBe(false);
    expect(llm.turns.length).toBeGreaterThanOrEqual(1);
  });

  it("design contract 反转(废止 review 尊重早退):未问完题时压制单独 [[END_CALL]],不提前结束", async () => {
    // design contract(b) 原为「[[END_CALL]] 单独出现尊重早退」;design contract 反转为考试语义——未问完题时压制。
    const { ws, engine } = makeEngine(["好的那就到这里", "\n", "[[END_CALL]]"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是口算老师", qParams(QS));
    await fullTurn(ws, "我不想继续了谢谢"); // 想走 → 命中 FAREWELL_INTENT 强制推进 + 压制 END_CALL
    expect(engine.wantsEndCall()).toBe(false); // 未问完题:压制,不结束(第 1 次要求,未达逃生阀阈值 3)
  });

  it("design contract:末题作答推进后无需用户再开口,自动发起且仅发起一次收尾轮", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "好的。\n[[NEXT]]",
      "预设问题都聊完了。你还有什么需要补充的吗?",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));
    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await waitUntil(() => llm.turns.length >= 2);
    expect(llm.turns[1].systemPrompt).toContain("都聊完了");
    expect(llm.turns[1].userText).toBe("(请开始)");
    const terminalTts = ws.textsSent().filter((m) => m.type === "tts_text");
    for (let i = 1; i < terminalTts.length; i++) ws.emitControl({ type: "tts_done" });
    await new Promise((r) => setTimeout(r, 20));
    expect(llm.turns).toHaveLength(2);
  });

  it("design contract:末题推进轮已给出合法整场收尾 → 记为 piggyback delivered,不重复发 terminal", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const terminalReply =
      "好的,这个问题我们就到这里。全部问题都聊完了，整体来看你的回答比较完整。还有什么需要补充的吗?\n[[NEXT]]";
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([terminalReply]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));

    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await new Promise((r) => setTimeout(r, 20));

    expect(engine.questionCursor()).toBe(1);
    expect(llm.turns).toHaveLength(1);
    expect(engine.correctionContext().history).toEqual([
      { role: "user", content: "我叫张三来自北京做后端开发工程师" },
      { role: "assistant", content: "好的,这个问题我们就到这里。全部问题都聊完了，整体来看你的回答比较完整。还有什么需要补充的吗?" },
    ]);
  });

  it("design contract 回归:末题整场收尾漏 [[NEXT]] → 隐式推进并 piggyback,不在用户告别后双收尾", async () => {
    const questions = [{ text: "唯一题:Quick 与 QuickSight 的关系" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "关于现有 API 和集成，升级之后会受到什么影响?",
      "好的，收到你的回答了。我们这几个问题都聊完了。还有其他需要我帮忙的吗？如果没有的话，我们就先到这里。",
      "好的，再见。\n[[END_CALL]]",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));

    await fullTurn(ws, "Quick 会替代 QuickSight");
    expect(engine.questionCursor()).toBe(0);
    await fullTurn(ws, "现有 API 需要升级，否则不能使用");

    expect(engine.questionCursor()).toBe(1);
    expect(llm.turns).toHaveLength(2);
    expect((engine as unknown as { terminalCompletionState: string }).terminalCompletionState).toBe("delivered");

    await fullTurn(ws, "好，就到这里吧，谢谢");
    const spoken = ws.textsSent()
      .filter((message) => message.type === "tts_text")
      .map((message) => String(message.text ?? ""))
      .join("");
    expect(llm.turns).toHaveLength(3);
    expect(spoken).toContain("好的，再见");
    expect(spoken).not.toContain("这个问题我们先到这里");
    expect(spoken).not.toContain("预设的问题都聊完了");
  });

  it("design contract 回归:末题说「所有问题我们都聊过了」也视为 piggyback,不重复收尾", async () => {
    const closure =
      "好的，这道题聊完了。所有问题我们都聊过了，整体来看你对主要功能有基本的了解。" +
      "还有其他需要我帮忙的吗？如果没有的话，我就先挂了。";
    const questions = [{ text: "最后一个问题是什么" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      `${closure}\n[[NEXT]]`,
      "不应启动专用 terminal 轮。",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是考官", qParams(questions));

    ws.emitControl({ type: "asr_final", text: "这是我的答案" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().some((message) => message.type === "tts_text"));
    for (const _message of ws.textsSent().filter((message) => message.type === "tts_text")) {
      ws.emitControl({ type: "tts_done" });
    }
    await waitUntil(() => engine.questionCursor() === 1);

    expect(llm.turns).toHaveLength(1);
    const spoken = ws.textsSent().map((message) => String(message.text ?? "")).join("");
    expect(spoken.replace(/\s/g, "")).toContain(closure.replace(/\s/g, ""));
    expect(spoken).not.toContain("预设的问题都聊完了");
  });

  it("design contract:英文固定收尾 finished 在 planned questions 前 → 仍 piggyback,不重复 terminal", async () => {
    const questions = [{ text: "Only question: introduce yourself" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "We have finished the planned questions. Is there anything else you would like to add?\n[[NEXT]]",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "You are an interviewer", {
      engineType: "three_stage",
      language: "en-US",
      questions,
    });

    await fullTurn(ws, "I am a backend engineer with payments experience");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(engine.questionCursor()).toBe(1);
    expect(llm.turns).toHaveLength(1);
    expect(engine.correctionContext().history.at(-1)?.content).toContain("finished the planned questions");
  });

  it("design contract:末题推进轮虽可 piggyback 但已有悬挂用户输入 → 用户优先消费 terminal,不提前 delivered", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new HoldPiggybackTurnLlm();
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));

    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端开发工程师" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length === 1);
    ws.emitControl({ type: "asr_final", text: "我还想补充负责过支付系统" });
    ws.emitControl({ type: "turn_end" });
    llm.release();
    await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
    const firstTurnTts = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < firstTurnTts; i++) ws.emitControl({ type: "tts_done" });

    await waitUntil(() => llm.turns.length >= 2);
    expect(llm.turns).toHaveLength(2);
    expect(llm.turns[1].userText).toBe("我还想补充负责过支付系统");
    expect(llm.turns[1].systemPrompt).toContain("收尾已经完整说过");
    await waitUntil(() =>
      ws.textsSent().some((message) => String(message.text ?? "").includes("你的补充我记下了")));
    const spoken = ws.textsSent()
      .filter((message) => message.type === "tts_text")
      .map((message) => String(message.text ?? ""))
      .join("\n");
    expect(spoken.match(/全部预设问题都聊完了/g)).toHaveLength(1);
    expect(spoken).toContain("你的补充我记下了");
  });

  it("design contract:仅说总体/当前题结束不算整场收尾 → 仍主动发 dedicated terminal", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "总体来说,这个问题就到这里结束。\n[[NEXT]]",
      "预设问题都聊完了。还有什么需要补充的吗?",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));

    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await waitUntil(() => llm.turns.length >= 2);

    expect(llm.turns).toHaveLength(2);
    expect(llm.turns[1].systemPrompt).toContain("都聊完了");
  });

  it("design contract:terminal 模型误出新知识题时不播原文,替换为固定收尾", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const invalidTerminal = "所有问题都完成了。能否解释权限模型?";
    const llm = new ScriptedLlm([
      "好的。\n[[NEXT]]",
      invalidTerminal,
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    const aiTexts: string[] = [];
    engine.onTurnEvent(() => {});
    engine.onLlmText((text) => aiTexts.push(text));
    await engine.start("sessQ", "你是面试官", qParams(questions));
    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length >= 2);

    const spoken = ws.textsSent()
      .filter((m) => m.type === "tts_text")
      .map((m) => String(m.text ?? ""))
      .join("");
    expect(spoken).toContain("预设的问题都聊完了");
    expect(spoken).not.toContain(invalidTerminal);
    expect(aiTexts.join("\n")).not.toContain(invalidTerminal);
  });

  it("design contract:R3 静默兜底推进末题后也自动发起 terminal-completion", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm(["能再展开一下吗?", "预设问题都已聊完。还有补充吗?"]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));
    await fullTurn(ws, "我叫张三来自北京做后端开发工程师"); // answerSeen=true,无 NEXT
    expect(engine.advanceOnSilenceTimeout(0)).toBe(true);
    await waitUntil(() => llm.turns.length >= 2);
    expect(llm.turns[1].systemPrompt).toContain("都聊完了");
    expect(engine.questionCursor()).toBe(1);
  });

  it("design contract:terminal-completion 技术失败后立即且仅重试一次", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new FailFirstTerminalLlm();
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));
    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await waitUntil(() => llm.turns.length >= 3);
    expect(llm.turns).toHaveLength(3); // 作答轮 + 失败 terminal + 一次重试
    const tts = ws.textsSent().filter((m) => m.type === "tts_text");
    for (let i = 1; i < tts.length; i++) ws.emitControl({ type: "tts_done" });
    await new Promise((r) => setTimeout(r, 20));
    expect(llm.turns).toHaveLength(3);
  });

  it("design contract:terminal 连续两次技术失败后不冒充 delivered,后续用户仍走普通 doneNote", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new FailBothTerminalLlm();
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));
    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await waitUntil(() => llm.turns.length >= 3);

    ws.emitControl({ type: "asr_final", text: "刚才没有听到收尾,请继续" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length >= 4);

    expect(llm.turns[3].systemPrompt).toContain("预设的问题都聊完了");
    expect(llm.turns[3].systemPrompt).not.toContain("收尾已经完整说过");
  });

  it("design contract:末题普通回复保持流式首声,不等待整轮 LLM 结束", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new HoldFinalQuestionStreamLlm();
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));

    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端开发工程师" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length === 1);
    await waitUntil(() => ws.textsSent().some((message) => message.type === "tts_text"));

    expect(ws.textsSent().filter((message) => message.type === "tts_text")).toHaveLength(1);
    expect(ws.textsSent().find((message) => message.type === "tts_text")?.text).toBe("先回应第一句。");
    llm.release();
  });

  it("design contract:terminal-completion 被接管后收到空 turn_end → 自动重新兑现,不永久 pending", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "好的。\n[[NEXT]]",
      "预设问题都聊完了。还有补充吗?",
      "预设问题都聊完了。你还需要补充吗?",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));
    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await waitUntil(() => llm.turns.length >= 2);

    engine.cancel("barge_in");
    ws.emitControl({ type: "asr_final", text: "" });
    ws.emitControl({ type: "turn_end" });

    await waitUntil(() => llm.turns.length >= 3);
    expect(llm.turns).toHaveLength(3);
    expect(llm.turns[2].systemPrompt).toContain("都聊完了");
  });

  it("design contract:terminal TTS drain 期收到实质输入 → 用户轮继承 terminal 身份并完成结算", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "好的。\n[[NEXT]]",
      "预设问题都聊完了。还有补充吗?",
      "请解释权限模型?",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    const completedSignals: Array<boolean | undefined> = [];
    const audioChunks: Buffer[] = [];
    engine.onTurnEvent(() => {});
    engine.onAiDone((completed) => { completedSignals.push(completed); });
    engine.onAudioOut((pcm) => audioChunks.push(pcm));
    await engine.start("sessQ", "你是面试官", qParams(questions));
    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");

    await waitUntil(() => llm.turns.length >= 2);
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length >= 2);
    const terminalTtsCount = ws.textsSent().filter((m) => m.type === "tts_text").length;
    // terminal 的 LLM 已返回,但不发 tts_done:此时 llmBusy=false、activeTurn/state 仍属于 in-flight terminal。
    ws.emitControl({ type: "asr_final", text: "我还要补充支付系统经验" });
    ws.emitControl({ type: "turn_end" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(llm.turns).toHaveLength(2);
    ws.emitAudio({ seq: 999 }, Buffer.from([1, 2, 3, 4]));
    expect(audioChunks).toHaveLength(0);

    ws.emitControl({ type: "cancel_ack", reason: "barge_in" });
    await waitUntil(() => llm.turns.length >= 3);
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > terminalTtsCount);
    const internal = engine as unknown as {
      activeTurn: { isTerminalCompletion: boolean } | null;
      terminalCompletionState: string;
    };
    expect(llm.turns[2].userText).toBe("我还要补充支付系统经验");
    expect(internal.activeTurn?.isTerminalCompletion).toBe(true);

    const afterTakeoverTts = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = terminalTtsCount; i < afterTakeoverTts; i++) ws.emitControl({ type: "tts_done" });
    await waitUntil(() => internal.terminalCompletionState === "delivered");
    expect(internal.terminalCompletionState).toBe("delivered");
    expect(completedSignals).toEqual([true, false, true]);
  });

  it("design contract:terminal TTS drain 接管未收到 cancel_ack → 超时后启动用户轮且此前残音持续丢弃", async () => {
    try {
      const questions = [{ text: "唯一题:自我介绍" }];
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "sessQ");
      const llm = new ScriptedLlm([
        "好的。\n[[NEXT]]",
        "预设问题都聊完了。还有补充吗?",
        "请解释权限模型?",
      ]);
      const engine = new ThreeStageEngine(gpu, llm);
      const audioChunks: Buffer[] = [];
      engine.onTurnEvent(() => {});
      engine.onAudioOut((pcm) => audioChunks.push(pcm));
      await engine.start("sessQ", "你是面试官", qParams(questions));
      await fullTurn(ws, "我叫张三来自北京做后端开发工程师");

      await waitUntil(() => llm.turns.length >= 2);
      await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length >= 2);
      // 模拟未来 metrics 提前落过的状态：接管释放不能依赖 reportMetrics 再次 arm cancelAck timer。
      const beforeTakeover = engine as unknown as {
        activeTurn: { metricsReported: boolean } | null;
      };
      expect(beforeTakeover.activeTurn).not.toBeNull();
      beforeTakeover.activeTurn!.metricsReported = true;
      jest.useFakeTimers();
      ws.emitControl({ type: "asr_final", text: "我还要补充支付系统经验" });
      ws.emitControl({ type: "turn_end" });

      await Promise.resolve();
      expect(llm.turns).toHaveLength(2);
      ws.emitAudio({ seq: 999 }, Buffer.from([1, 2, 3, 4]));
      expect(audioChunks).toHaveLength(0);
      expect(engine.nudge("请提醒对方继续")).toBe(false);
      engine.kickoff();
      ws.emitControl({ type: "asr_final", text: "" });
      ws.emitControl({ type: "turn_end" });
      await Promise.resolve();
      expect(llm.turns).toHaveLength(2);
      ws.emitAudio({ seq: 1000 }, Buffer.from([5, 6, 7, 8]));
      expect(audioChunks).toHaveLength(0);

      jest.advanceTimersByTime(301);
      await Promise.resolve();
      await Promise.resolve();

      expect(llm.turns).toHaveLength(3);
      expect(llm.turns[2].userText).toBe("我还要补充支付系统经验");
    } finally {
      jest.useRealTimers();
    }
  });

  it("design contract:用户 pending-drain 消费 terminal 时保留 user+assistant 交替 history", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new HoldFirstTurnLlm();
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));

    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端开发工程师" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length === 1);
    ws.emitControl({ type: "asr_final", text: "继续啊" });
    ws.emitControl({ type: "turn_end" }); // 首轮 LLM 仍 busy,输入进入 pending-drain
    llm.release();
    await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
    const firstTurnTtsCount = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < firstTurnTtsCount; i++) ws.emitControl({ type: "tts_done" });
    await waitUntil(() => llm.turns.length >= 2);
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length >= 3);
    const terminalTtsCount = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 1; i < terminalTtsCount; i++) ws.emitControl({ type: "tts_done" });
    await waitUntil(() => engine.correctionContext().history.length >= 4);

    expect(engine.correctionContext().history).toEqual([
      { role: "user", content: "我叫张三来自北京做后端开发工程师" },
      { role: "assistant", content: "好的。" },
      { role: "user", content: "继续啊" },
      { role: "assistant", content: "预设的问题都聊完了。你还有什么需要补充的吗？如果没有,我们就到这里结束。" },
    ]);
  });

  it("design contract:自动 terminal 文本并入末条 assistant,history 始终角色交替", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new ScriptedLlm([
      "好的。\n[[NEXT]]",
      "预设问题都聊完了。还有补充吗?",
    ]);
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));
    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length >= 3);
    const terminalTtsCount = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 1; i < terminalTtsCount; i++) ws.emitControl({ type: "tts_done" });
    await waitUntil(() => engine.correctionContext().history[1]?.content.includes("预设问题都聊完了"));

    expect(engine.correctionContext().history).toEqual([
      { role: "user", content: "我叫张三来自北京做后端开发工程师" },
      { role: "assistant", content: "好的。\n预设的问题都聊完了。你还有什么需要补充的吗？如果没有,我们就到这里结束。" },
    ]);
  });

  it("design contract:强制收口首 token 后停流 → 有界失败并允许下一轮重新收口", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new HangForceClosureAfterFirstTokenLlm();
    const engine = new ThreeStageEngine(gpu, llm);
    const completed: (boolean | undefined)[] = [];
    engine.onTurnEvent(() => {});
    engine.onAiDone?.((value) => completed.push(value));
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await fullTurn(ws, "我负责电商订单和库存系统");

    jest.useFakeTimers();
    ws.emitControl({ type: "asr_final", text: "我还负责缓存和消息队列优化" });
    ws.emitControl({ type: "turn_end" });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1001);
    expect(completed.at(-1)).toBe(false);
    expect(engine.questionCursor()).toBe(0);

    const ttsBeforeRetry = ws.textsSent().filter((m) => m.type === "tts_text").length;
    ws.emitControl({ type: "asr_final", text: "这就是我的完整回答" });
    ws.emitControl({ type: "turn_end" });
    await jest.advanceTimersByTimeAsync(0);
    expect(llm.turns).toHaveLength(4);
    expect(ws.textsSent().filter((m) => m.type === "tts_text")).toHaveLength(ttsBeforeRetry + 1);
    expect(ws.textsSent().filter((m) => m.type === "tts_text").at(-1)?.text).toContain("这个问题我们先到这里");
  });

  it("design contract:terminal 首 token 后停流 → 同一缓冲 watchdog 终结并仅重试一次", async () => {
    const questions = [{ text: "唯一题:自我介绍" }];
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessQ");
    const llm = new HangFirstTerminalAfterFirstTokenLlm();
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(questions));

    await fullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await waitUntil(() => llm.turns.length >= 3, 2000);

    expect(llm.turns).toHaveLength(3);
    expect(ws.textsSent().map((m) => String(m.text ?? "")).join("\n")).toContain("预设的问题都聊完了");
  });

  it("纯人设对话(无题):无游标、无逐题注入,prompt 不含题目块", async () => {
    const { ws, llm, engine } = makeEngine(["你好", "。"], []);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是聊天助手", qParams([]));
    ws.emitControl({ type: "asr_final", text: "随便聊聊天气吧" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length >= 1);
    const sp = llm.turns[0].systemPrompt;
    expect(sp).toContain("你是聊天助手");
    expect(sp).not.toContain("当前要聊的问题"); // design contract 措辞
    expect(sp).not.toContain("第 1/");
  });

  it("kickoff 主动开场轮不推进游标(对方未作答)", async () => {
    const { ws, llm, engine } = makeEngine(["您好请开始", "。"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    engine.kickoff(); // AI 主动开场
    await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
    const after = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < after; i++) ws.emitControl({ type: "tts_done" });
    await waitUntil(() => true, 10);
    // kickoff 轮完成但不推进;下一轮真人首答仍看到第1题
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length >= 2);
    expect(llm.turns[1].systemPrompt).toContain("第 1/3 题");
  });

  it("打断恢复后继续同题、有效作答推进(barge-in 不吞后续正常轮)", async () => {
    const { ws, llm, engine } = makeEngine(["好的", "。"], QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京做后端"); // 第1题 → 推进到第2题
    // 第2题念题中被打断(不推进、不回退)
    ws.emitControl({ type: "asr_final", text: "等一下我想想" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length >= 2 && ws.textsSent().some((m) => m.type === "tts_text"));
    engine.cancel("barge_in");
    // 打断后恢复:继续第2题,有效作答(≥4 字)→ 推进到第3题(打断的轮不吞掉后续正常推进)
    await fullTurn(ws, "我做过订单系统和库存重构两个大项目"); // 第2题(follow_up)有效作答
    await fullTurn(ws, "零信任是种安全模型"); // 若已到第3题,此轮 prompt 应显示第 3 题
    // 第2题是 follow_up,无 [[NEXT]] 时靠 retry 推进;至少 barge-in 后正常轮能继续评估(不卡死在第2题之前)
    expect(engine.questionCursor()).toBeGreaterThanOrEqual(1);
    expect(ws.textsSent().some((message) => String(message.text ?? "").includes(QS[1].text))).toBe(true);
  });

  it("max_duration 中途 stop:游标停在当前题,未问题留给 evaluator 判未作答(design contract)", async () => {
    const { ws, llm, engine } = makeEngine(["好的", "。"], QS); // 3 题
    engine.onTurnEvent(() => {});
    await engine.start("sessQ", "你是面试官", qParams(QS));
    await fullTurn(ws, "我叫张三来自北京做后端"); // 第1题 → 第2题
    // 模拟调度器 max_duration backstop → engine.stop()(会话销毁,不等游标走完)
    await engine.stop();
    // stop 后游标停在第2题(cursor=1);未问的第2/3题由 evaluator 按全量 meta.questions index 判未作答
    // (bridge 无 evaluator,此处只验 stop 不推进游标、不抛错;evaluator 隔离见 design contract 留 M1 integration)
    const stops = ws.textsSent().filter((m) => m.type === "cancel").length;
    expect(stops).toBeGreaterThanOrEqual(1); // stop 发了会话级 cancel
    expect(llm.turns.length).toBeGreaterThanOrEqual(1);
  });

  // ── design contract:短答连续出题(短答判已作答 + 游标推进后 AI 主动问下一题)──
  describe("design contract 短答连续出题", () => {
    // 手动驱动一轮 + 补齐本轮 tts_done(触发 onAiDone → 评估推进 + 可能的自动轮)。返回该轮起时 llm.turns 长度。
    // ★ MUST 先等 tts_text 出现再数/补 done:llm.turns 在 stream() 第一行即 push(早于吐 token),
    //   若不等流吐句就数 tts_text 会得 0、补 0 个 done → 永不 onAiDone(超时)。
    async function driveTurnAndDrain(ws: FakeWs, llm: FakeLlm, userText: string): Promise<number> {
      const before = ws.textsSent().filter((m) => m.type === "tts_text").length;
      const turnsBefore = llm.turns.length;
      ws.emitControl({ type: "asr_final", text: userText });
      ws.emitControl({ type: "turn_end" });
      // 等本轮 LLM 产出至少一句 tts_text(证明流已推进);纯 0 字符/被拦轮不会产句,交调用方另判。
      await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > before, 500).catch(() => {});
      const after = ws.textsSent().filter((m) => m.type === "tts_text").length;
      for (let i = before; i < after; i++) ws.emitControl({ type: "tts_done" });
      await waitUntil(() => true, 10);
      return turnsBefore;
    }

    it("R3(a) 短答单字「8」+ [[NEXT]] → 进 LLM 且推进(不被前置门槛/minAnswerChars 卡住)", async () => {
      // 口算题:单字答案「8」有效字符 1。前置门槛(游标模式降到 1)放它进 LLM;LLM 发 [[NEXT]] → 门槛降到 1 判已作答 → 推进。
      const { ws, llm, engine } = makeEngine(["答对了", "\n", "[[NEXT]]"], QS);
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qParams(QS));
      await driveTurnAndDrain(ws, llm, "8"); // 单字答案
      expect(llm.turns[0].systemPrompt).toContain("第 1/3 题"); // 首轮确实看到第1题(前置门槛放行,单字进了 LLM)
      expect(engine.questionCursor()).toBe(1);
      expect(llm.turns).toHaveLength(1);
      expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
    });

    it("R3(c) 重连(M1 换新引擎从头重问):新引擎游标从第1题起,重问路径自动连续出题不退化", async () => {
      // 真机 M1 重连:index.ts 每次连接 createEngine 新实例(旧的 detach)。这里 new 第二个引擎模拟。
      const first = makeEngine(["答对了", "\n", "[[NEXT]]"], QS);
      first.engine.onTurnEvent(() => {});
      await first.engine.start("sessQ", "你是口算老师", qParams(QS));
      await driveTurnAndDrain(first.ws, first.llm, "62"); // 推进到第2题
      expect(first.ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
      // 断线重连 = 新引擎实例(旧引擎那场作废):游标天然从第1题起。
      const re = makeEngine(["答对了", "\n", "[[NEXT]]"], QS);
      re.engine.onTurnEvent(() => {});
      await re.engine.start("sessQ", "你是口算老师", qParams(QS));
      await driveTurnAndDrain(re.ws, re.llm, "8"); // 重连后首答
      expect(re.llm.turns[0].systemPrompt).toContain("第 1/3 题"); // 从头重问
      expect(re.llm.turns).toHaveLength(1);
      expect(re.ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
    });

    it("R3(c) 防御:同一引擎二次 start 幂等复位(残留 activeTurn/history 不污染新场)", async () => {
      const { ws, llm, engine } = makeEngine(["答对了", "\n", "[[NEXT]]"], QS);
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qParams(QS));
      await driveTurnAndDrain(ws, llm, "62"); // 推进 + 直接 TTS 自动问下一题
      await waitUntil(() => ws.textsSent().some((message) => String(message.text ?? "").includes(QS[1].text)));
      // 二次 start(未来若复用实例):MUST 清残留 activeTurn/history/cursor,否则首个 turn_end 撞 llmBusy 卡死。
      await engine.start("sessQ", "你是口算老师", qParams(QS));
      const afterRestart = llm.turns.length;
      await driveTurnAndDrain(ws, llm, "8"); // 若未复位 → 撞残留 llmBusy 被忽略,turns 不增长
      expect(llm.turns.length).toBeGreaterThan(afterRestart); // 新轮真的起了(未卡 busy)
      expect(llm.turns[afterRestart].systemPrompt).toContain("第 1/3 题"); // 游标复位
      expect(llm.turns[afterRestart].history ?? []).toEqual([]); // history 清空(旧场不污染)
    });

    it("R3(b) 推进后直接下发下一题原文 TTS,不再等待第二次 LLM", async () => {
      const { ws, llm, engine } = makeEngine(["答对了", "\n", "[[NEXT]]"], QS);
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qParams(QS));
      // 仅驱动一轮手动作答。下一题必须由服务端按游标直接送 TTS,不能再起跨境 LLM 请求。
      await driveTurnAndDrain(ws, llm, "62");
      const manualTurns = llm.turns.length;
      await waitUntil(() =>
        ws.textsSent().some((message) => String(message.text ?? "").includes(QS[1].text)));
      expect(llm.turns).toHaveLength(manualTurns);
      expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
    });

    it("R3(b) 末题答完不自动发起新题(off-by-one:cursor 越界)", async () => {
      const { ws, llm, engine } = makeEngine(["答对了", "\n", "[[NEXT]]"], [{ text: "唯一题:1+1" }]);
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qParams([{ text: "唯一题:1+1" }]));
      await driveTurnAndDrain(ws, llm, "2");
      const manualTurns = llm.turns.length;
      // 等一小会儿确认没有自动轮(唯一题答完 cursor 越界 → 不自动发起)
      await waitUntil(() => true, 80);
      expect(llm.turns.length).toBe(manualTurns); // 无自动轮
    });

    it("design contract:未问完题时压制 [[END_CALL]] 且继续自动问下一题(不干等死锁)", async () => {
      // design contract 反转 design contract(b):考试语义下未问完题时用户要走 → 压制 END_CALL + 强制推进 + 继续问下一题。
      const { ws, llm, engine } = makeEngine(["好的那到这里", "\n", "[[END_CALL]]"], QS);
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qParams(QS));
      await driveTurnAndDrain(ws, llm, "我不想继续了到这里吧"); // 想走 → FAREWELL 强制推进 + 压制 END_CALL
      const manualTurns = llm.turns.length;
      expect(engine.wantsEndCall()).toBe(false); // 未问完题(第 1 次要求,未达逃生阀)→ 压制,不结束
      expect(llm.turns).toHaveLength(manualTurns);
      expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
    });

    it("R3(a) 纯静默(0 有效字符)不进 LLM、不推进(前置门槛仍拦纯噪声)", async () => {
      const { ws, llm, engine } = makeEngine(["答对了", "\n", "[[NEXT]]"], QS);
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qParams(QS));
      ws.emitControl({ type: "asr_final", text: "。。。" }); // 纯标点 → 有效字符 0
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => true, 60);
      expect(llm.turns.length).toBe(0); // 纯 0 字符不触发 LLM(游标模式门槛=1 仍要求 ≥1)
    });

    it("R3(b) 自动问下一题轮可被 barge-in 打断(不豁免打断)", async () => {
      const { ws, llm, engine } = makeEngine(["答对了", "\n", "[[NEXT]]"], QS);
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qParams(QS));
      ws.emitControl({ type: "asr_final", text: "62" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => llm.turns.length >= 1);
      const manualTurns = llm.turns.length;
      const n = ws.textsSent().filter((m) => m.type === "tts_text").length;
      for (let i = 0; i < n; i++) ws.emitControl({ type: "tts_done" });
      await waitUntil(() => ws.textsSent().some((message) => String(message.text ?? "").includes(QS[1].text)));
      expect(llm.turns).toHaveLength(manualTurns);
      // 自动轮播报中打断 → 正常 cancel(不抛错、幂等);证明自动轮走常规轮生命周期、可打断
      expect(() => engine.cancel("barge_in")).not.toThrow();
    });

    it("direct auto-next 服务端 done 后仍在客户端播放时开口 → 撤销完整念题证据并允许重问", async () => {
      const q2 = QS[1].text;
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "sessQ");
      const llm = new ScriptedLlm([
        "好的。\n[[NEXT]]",
        `请听完整，${q2}`,
      ]);
      const engine = new ThreeStageEngine(gpu, llm);
      engine.onTurnEvent(() => {});
      // GPU tts_done 只代表服务端排水；客户端队尾仍需约 5 秒才能播放完。
      engine.onAiDone(() => Date.now() + 5000);
      await engine.start("sessQ", "你是口算老师", qParams(QS));

      ws.emitControl({ type: "asr_final", text: "62" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => llm.turns.length >= 1);
      await waitUntil(() => ws.textsSent().some((message) => message.type === "tts_text"));
      for (const _message of ws.textsSent().filter((message) => message.type === "tts_text")) {
        ws.emitControl({ type: "tts_done" });
      }
      await waitUntil(() =>
        ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${q2}`));
      ws.emitControl({ type: "tts_done" }); // direct Q2 服务端排水，但客户端尚未播完

      for (const shortInput of ["是的", "好的", "继续啊"]) {
        const beforeRetry = ws.textsSent().filter((message) => message.type === "tts_text").length;
        ws.emitControl({ type: "asr_partial", text: shortInput.slice(0, 1) });
        ws.emitControl({ type: "asr_final", text: shortInput });
        ws.emitControl({ type: "turn_end" });
        await waitUntil(() => ws.textsSent().filter((message) => message.type === "tts_text").length > beforeRetry);

        expect(llm.turns).toHaveLength(1); // 短确认不进 LLM、不累计无效 retry
        expect(engine.questionCursor()).toBe(1); // 连续三次也不能触发 retry 上限跳到 Q3
        expect(ws.textsSent().filter((message) => message.type === "tts_text").slice(beforeRetry)
          .some((message) => String(message.text ?? "") === `刚才被打断了，我们重新来。${q2}`)).toBe(true);
        ws.emitControl({ type: "tts_done" }); // 本次重播服务端排水，下一次仍模拟客户端播放中开口
      }
    });

    it("direct auto-next 服务端 done 前被短输入打断 → 排水后直接重播且不进 LLM", async () => {
      const q2 = QS[1].text;
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "sessQ");
      const llm = new ScriptedLlm(["好的。\n[[NEXT]]"]);
      const engine = new ThreeStageEngine(gpu, llm);
      engine.onTurnEvent(() => {});
      engine.onAiDone(() => Date.now() + 5000);
      await engine.start("sessQ", "你是口算老师", qParams(QS));

      ws.emitControl({ type: "asr_final", text: "62" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => llm.turns.length === 1);
      await waitUntil(() => ws.textsSent().some((message) => message.type === "tts_text"));
      for (const _message of ws.textsSent().filter((message) => message.type === "tts_text")) {
        ws.emitControl({ type: "tts_done" });
      }
      await waitUntil(() =>
        ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${q2}`));

      const beforeReplay = ws.textsSent().filter((message) => message.type === "tts_text").length;
      ws.emitControl({ type: "asr_partial", text: "是" });
      ws.emitControl({ type: "asr_final", text: "是的" });
      ws.emitControl({ type: "turn_end" }); // direct 轮仍 busy，短输入先进入 pending-drain
      expect(ws.textsSent().filter((message) => message.type === "tts_text")).toHaveLength(beforeReplay);

      ws.emitControl({ type: "tts_done" }); // 服务端排水后消费 pending-drain
      await waitUntil(() => ws.textsSent().filter((message) => message.type === "tts_text").length > beforeReplay);

      expect(llm.turns).toHaveLength(1);
      expect(engine.questionCursor()).toBe(1);
      expect(ws.textsSent().filter((message) => message.type === "tts_text").slice(beforeReplay)
        .some((message) => String(message.text ?? "") === `刚才被打断了，我们重新来。${q2}`)).toBe(true);
    });

    it.each(["等一下", "MCP", "8"])(
      "direct auto-next 播放中断后的短实质输入「%s」不按确认词吞掉 → 仍送 LLM",
      async (answer) => {
        const q2 = QS[1].text;
        const ws = new FakeWs();
        const gpu = new GpuClient(ws, "sessQ");
        const llm = new ScriptedLlm([
          "好的。\n[[NEXT]]",
          "收到，我会按你的回答继续。",
        ]);
        const engine = new ThreeStageEngine(gpu, llm);
        engine.onTurnEvent(() => {});
        engine.onAiDone(() => Date.now() + 5000);
        await engine.start("sessQ", "你是口算老师", qParams(QS));

        ws.emitControl({ type: "asr_final", text: "62" });
        ws.emitControl({ type: "turn_end" });
        await waitUntil(() => llm.turns.length === 1);
        await waitUntil(() => ws.textsSent().some((message) => message.type === "tts_text"));
        for (const _message of ws.textsSent().filter((message) => message.type === "tts_text")) {
          ws.emitControl({ type: "tts_done" });
        }
        await waitUntil(() =>
          ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${q2}`));
        ws.emitControl({ type: "tts_done" }); // 服务端已排水，客户端仍在题干尾播

        ws.emitControl({ type: "asr_partial", text: answer.slice(0, 1) });
        ws.emitControl({ type: "asr_final", text: answer });
        ws.emitControl({ type: "turn_end" });
        await waitUntil(() => llm.turns.length === 2);

        expect(llm.turns[1].userText).toBe(answer);
        expect(engine.questionCursor()).toBe(1);
        expect(ws.textsSent().filter((message) => message.type === "tts_text")
          .some((message) => String(message.text ?? "") === `刚才被打断了，我们重新来。${q2}`)).toBe(false);
      },
    );

    it("direct 题干中断已由实质回答消费后,下一轮短确认不重播旧题", async () => {
      const q2 = QS[1].text;
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "sessQ");
      const llm = new ScriptedLlm([
        "好的。\n[[NEXT]]",
        "收到你的回答，能再补充一个细节吗？",
        "明白了。",
      ]);
      const engine = new ThreeStageEngine(gpu, llm);
      engine.onTurnEvent(() => {});
      engine.onAiDone(() => Date.now() + 5000);
      await engine.start("sessQ", "你是口算老师", qParams(QS));

      ws.emitControl({ type: "asr_final", text: "62" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => llm.turns.length === 1);
      await waitUntil(() => ws.textsSent().some((message) => message.type === "tts_text"));
      for (const _message of ws.textsSent().filter((message) => message.type === "tts_text")) {
        ws.emitControl({ type: "tts_done" });
      }
      await waitUntil(() =>
        ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${q2}`));
      ws.emitControl({ type: "tts_done" });

      const beforeSubstantiveAnswer = ws.textsSent().filter((message) => message.type === "tts_text").length;
      ws.emitControl({ type: "asr_partial", text: "我来" });
      ws.emitControl({ type: "asr_final", text: "我来补充这道题的答案" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => llm.turns.length === 2);
      await waitUntil(() =>
        ws.textsSent().filter((message) => message.type === "tts_text").length > beforeSubstantiveAnswer);
      ws.emitControl({ type: "tts_done" });

      const beforeConfirmation = ws.textsSent().filter((message) => message.type === "tts_text").length;
      ws.emitControl({ type: "asr_final", text: "好的" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => llm.turns.length === 3);

      expect(llm.turns[2].userText).toBe("好的");
      expect(ws.textsSent().filter((message) => message.type === "tts_text").slice(beforeConfirmation)
        .some((message) => String(message.text ?? "") === `刚才被打断了，我们重新来。${q2}`)).toBe(false);
    });
  });

  // ── design contract:忙时用户输入排水(fireAiDone 非 cancel 触发时消费悬挂的 lastFinalText)──
  // 评审收敛(review):原版测试把悬挂输入注入在"自动问下一题"轮(isKickoff=true)的忙碌窗口里,
  // 但 maybeAdvanceCursor 对 isKickoff 轮恒返回 advanced=false(:678),导致 autoNextAfterDone 永远不会
  // 被置 true——"排水 vs 自动问下一题同时满足"这个分支根本没被打到;且用 waitUntil(() => true, N) 制造
  // 等待窗口是假等待(cond 恒真,循环立即退出,不产生真实延迟,见 waitUntil:95-101),cancel/defer 测试
  // 的"等待"形同虚设。改为:①用会真正推进游标的**普通用户轮**(isKickoff=false)作忙碌载体,让
  // autoNextAfterDone 有机会被真置 true;②所有等待窗口换成真实 setTimeout;③cancel/defer 测试改为
  // 等到 ttsPending>0 / 真正进入 defer 分支后才做下一步动作。
  describe("design contract 忙时用户输入排水", () => {
    // 4 题(第1题快速作答推进;第2题是"忙碌轮"本身用慢速 LLM,流式期间注入悬挂输入;第2题结束时
    // 若推进到第3题(未到末题)→ autoNextAfterDone 真被置 true,与排水形成真实的"同时满足"竞争)。
    const QS4 = [
      { text: "第一题:1+1" },
      { text: "第二题:2+2" },
      { text: "第三题:3+3" },
      { text: "第四题:4+4" },
    ];
    const qP4 = (): EngineParams => ({ engineType: "three_stage", language: "zh-CN", questions: QS4 });

    /** 慢速 LLM:每 token 间隔一点时间,给测试窗口在"当前轮忙着"时注入新的 turn_end
     *  (模拟用户在 AI 还没答完/还没问完时说话,被 busy 让位悬挂进 lastFinalText)。记录每轮收到的
     *  turn(同 FakeLlm.turns 模式),供断言排水轮的入参文本 + 区分是否 kickoff(userText 是否为
     *  KICKOFF_WAKE_TEXT "(请开始)")。TOKEN_DELAY_MS 足够大于测试里的注入时机,保证确定性
     *  (不依赖真实并发时序竞态,注入动作在 await 之前用同步 emitControl 完成)。 */
    const TOKEN_DELAY_MS = 30;
    function makeSlowEngine() {
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "sessQ");
      const turns: LlmTurn[] = [];
      const slow: LlmStreamer = {
        async *stream(turn, signal): AsyncIterable<string> {
          turns.push(turn);
          for (const t of ["答对了", "\n", "[[NEXT]]"]) {
            if (signal.aborted) return;
            await new Promise((r) => setTimeout(r, TOKEN_DELAY_MS));
            yield t;
          }
        },
      };
      const engine = new ThreeStageEngine(gpu, slow);
      return { ws, gpu, engine, turns };
    }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    function ttsCount(ws: FakeWs): number {
      return ws.textsSent().filter((m) => m.type === "tts_text").length;
    }
    /** 补齐**尚未 drain 过**的 tts_text(用调用方传入的游标 drainedRef 追踪已补位置,避免对同一句
     *  重复发 tts_done——重复发会让 ttsPending 计数错乱)。返回补齐后的新游标供下次调用传入。 */
    function drainTts(ws: FakeWs, drainedSoFar: number): number {
      const total = ttsCount(ws);
      for (let i = drainedSoFar; i < total; i++) ws.emitControl({ type: "tts_done" });
      return total;
    }

    it("核心 bug 场景:忙时用户说话被悬挂,轮结束后 AI 主动回应(不再静默)", async () => {
      const { ws, engine, turns } = makeSlowEngine();
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qP4());
      // 第1题(慢速 LLM,流式期间 llmBusy=true)。
      ws.emitControl({ type: "asr_final", text: "2" });
      ws.emitControl({ type: "turn_end" });
      // 在第1题仍在流式(未收满 tts_done)期间,用户又说话 → 触发 turn_end,busy 让位悬挂。
      await sleep(TOKEN_DELAY_MS / 2); // 早于首个 token(30ms)吐出,确认仍处于 llmBusy 窗口
      ws.emitControl({ type: "asr_final", text: "发给了。" });
      ws.emitControl({ type: "turn_end" }); // busy → 悬挂 lastFinalText="发给了。"
      // 驱动第1题播完(等它出句、补 tts_done → fireAiDone 非 cancel 触发 → 排水应消费悬挂文本)。
      await waitUntil(() => ttsCount(ws) >= 1);
      drainTts(ws, 0);
      // 排水轮应该起(第2次 stream() 调用,userText="发给了。"),而不是自动问下一题(userText=唤醒词)。
      await waitUntil(() => turns.length >= 2);
      expect(turns[1].userText).toBe("发给了。");
    });

    it("direct auto-next 播放期输入先悬挂,tts_done 后排水且不替换活跃轮", async () => {
      const { ws, engine, turns } = makeSlowEngine();
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qP4());
      ws.emitControl({ type: "asr_final", text: "2" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => ttsCount(ws) >= 1);
      drainTts(ws, 0); // 第1题结束后，服务端立即下发第2题，不新增 LLM turn。
      await waitUntil(() => ws.textsSent().some((message) => String(message.text ?? "").includes("第二题")));
      const beforeTakeover = turns.length;
      ws.emitControl({ type: "asr_final", text: "等一下" });
      ws.emitControl({ type: "turn_end" });
      await sleep(TOKEN_DELAY_MS / 2);
      expect(turns).toHaveLength(beforeTakeover);

      // direct 题干的 tts_done 才释放活跃轮；fireAiDone 随后消费悬挂输入并启动用户 LLM。
      ws.emitControl({ type: "tts_done" });
      await waitUntil(() => turns.length > beforeTakeover);
      expect(turns[beforeTakeover].userText).toBe("等一下");
      const countAfterTakeover = turns.length;
      await sleep(TOKEN_DELAY_MS * 3);
      expect(turns.length).toBe(countAfterTakeover);
    });

    it("悬挂值非空但未达有效性门槛(纯标点残识)→ 不消费,原有自动问下一题正常触发(回归防护)", async () => {
      const { ws, engine, turns } = makeSlowEngine();
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qP4());
      ws.emitControl({ type: "asr_final", text: "2" });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => ttsCount(ws) >= 1);
      let drained = drainTts(ws, 0); // 第1题完 → 推进并直接下发下一题 TTS
      await sleep(TOKEN_DELAY_MS / 2);
      // 忙时只有纯标点残识(有效字符 0,低于游标模式门槛 1)
      ws.emitControl({ type: "asr_final", text: "。" });
      ws.emitControl({ type: "turn_end" });
      const beforeDrain = turns.length;
      await waitUntil(() => ttsCount(ws) > drained);
      drained = drainTts(ws, drained);
      // 未达门槛 → 不应因残识多起一轮"排水轮"(排水轮的 userText 会是"。",不应出现)。
      await sleep(TOKEN_DELAY_MS * 3);
      const allUserTexts = turns.slice(beforeDrain).map((t) => t.userText);
      expect(allUserTexts).not.toContain("。");
    });

    it("悬挂值被新 asr_final 覆盖:排水消费覆盖后的值,不恢复更早悬挂的那句", async () => {
      const { ws, engine, turns } = makeSlowEngine();
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qP4());
      ws.emitControl({ type: "asr_final", text: "2" });
      ws.emitControl({ type: "turn_end" });
      await sleep(TOKEN_DELAY_MS / 2); // 仍在第1题流式期间(忙碌)
      // 用户先说"发给了。"(悬挂 A),随后(仍在同一忙碌轮内)又说"等一下"(新 asr_final 覆盖 A)。
      ws.emitControl({ type: "asr_final", text: "发给了。" });
      ws.emitControl({ type: "turn_end" }); // busy → 悬挂 A(仅打日志,lastFinalText="发给了。")
      ws.emitControl({ type: "asr_final", text: "等一下" }); // 覆盖为 B(纯覆盖写,不经 turn_end)
      const turnsBeforeDrain = turns.length; // =1(仅第1题本身)
      await waitUntil(() => ttsCount(ws) >= 1);
      drainTts(ws, 0); // 第1题结束 → 排水应消费此刻的当前值"等一下"
      await waitUntil(() => turns.length > turnsBeforeDrain);
      // 黄金断言:排水轮的入参文本是覆盖后的"等一下",不是被覆盖的"发给了。"(消费的是当前值,不恢复历史)。
      expect(turns[turnsBeforeDrain].userText).toBe("等一下");
    });

    it("确认打断(cancel)路径:悬挂输入不被本排水机制消费(明确边界,非遗漏)", async () => {
      const { ws, engine, turns } = makeSlowEngine();
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qP4());
      ws.emitControl({ type: "asr_final", text: "2" });
      ws.emitControl({ type: "turn_end" });
      // 等确实已进入 ttsPending>0 窗口(第1句 tts_text 已下发,cancel() 内部 fireAiDone 的
      // `turn.ttsPending > 0` 条件才可能成立——否则 cancel 根本不会调 fireAiDone,测试没有意义)。
      await waitUntil(() => ttsCount(ws) >= 1);
      // 用户先说 A(悬挂),随后真打断(达 barge-in 门槛,走 cancel)。
      ws.emitControl({ type: "asr_final", text: "发给了" });
      ws.emitControl({ type: "turn_end" }); // busy → 悬挂 A(此时 activeTurn 仍是第1题轮,llmBusy=true)
      const turnsBefore = turns.length;
      expect(() => engine.cancel("barge_in")).not.toThrow(); // 真打断 → cancel 内部 fireAiDone,MUST NOT 排水
      // cancel 不应触发排水轮(!this.interrupted 为 false,排水前置条件不满足)。给足时间确认无新 stream()。
      await sleep(TOKEN_DELAY_MS * 3);
      expect(turns.length).toBe(turnsBefore); // 没有因悬挂的"发给了"多起一轮
    });

    it("tentative-pause defer 期间不触发排水,resume 后真正 fireAiDone 时排水才生效", async () => {
      const { ws, engine, turns } = makeSlowEngine();
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qP4());
      ws.emitControl({ type: "asr_final", text: "2" });
      ws.emitControl({ type: "turn_end" });
      // 第 1 步:LLM 仍在流式(llmBusy=true)时用户说话 → turn_end 走"让位"分支,悬挂进 lastFinalText
      // (若等 LLM 流跑完才说话,llmBusy 已 false,会走正常消费路径,不是本测试要验证的让位场景)。
      await sleep(TOKEN_DELAY_MS / 2);
      ws.emitControl({ type: "asr_final", text: "发给了" });
      ws.emitControl({ type: "turn_end" }); // busy → 悬挂 lastFinalText="发给了"
      // 第 2 步:等 LLM 流**完全跑完**(llmReturned=true,llmBusy 转 false)但 TTS 还没播完
      // (ttsPending>0,尚无 tts_done)——此刻 pause 才是"暂停出声、不销毁本轮"的正确适用窗口。
      await sleep(TOKEN_DELAY_MS * 4);
      await waitUntil(() => ttsCount(ws) >= 1); // 确认这轮确实出了句子(ttsPending>0)
      engine.pause();
      const turnsBeforePause = turns.length;
      // 让本轮剩余句子的 tts_done 到达(暂停中 ttsPending 归零 + llmStreamComplete=true → maybeFireAiDone
      // 判定"本轮播完"→ fireAiDone 因 this.paused 走 defer 分支,不到排水检查)。
      drainTts(ws, 0);
      await sleep(TOKEN_DELAY_MS * 2); // 给足时间确认 defer 期间确实没有排水
      expect(turns.length).toBe(turnsBeforePause); // pause+播完 期间无新轮(defer 分支正确挡住)
      // resume(非 cancel)→ defer 补触发真正的 fireAiDone → 排水应消费悬挂的"发给了"。
      engine.resume();
      await waitUntil(() => turns.length > turnsBeforePause, 1000).catch(() => {});
      expect(turns.length).toBeGreaterThan(turnsBeforePause); // resume 后排水真的生效
      expect(turns[turnsBeforePause].userText).toBe("发给了");
    });

    it("排水触发的新一轮仍可被 barge-in 正常打断,不豁免", async () => {
      const { ws, engine, turns } = makeSlowEngine();
      engine.onTurnEvent(() => {});
      await engine.start("sessQ", "你是口算老师", qP4());
      ws.emitControl({ type: "asr_final", text: "2" });
      ws.emitControl({ type: "turn_end" });
      await sleep(TOKEN_DELAY_MS / 2);
      ws.emitControl({ type: "asr_final", text: "发给了" });
      ws.emitControl({ type: "turn_end" }); // busy → 悬挂
      const turnsBeforeDrain = turns.length;
      await waitUntil(() => ttsCount(ws) >= 1);
      drainTts(ws, 0); // 第1题结束 → 排水消费"发给了",起新轮
      await waitUntil(() => turns.length > turnsBeforeDrain); // 排水轮已起(新 stream() 调用)
      expect(() => engine.cancel("barge_in")).not.toThrow(); // 排水轮可被正常打断,不特殊豁免
    });
  });

  // ── design contract:考试完成强制(未问完题禁提前结束 + 三次坚持逃生阀)──
  describe("design contract 考试完成强制", () => {
    const QS3 = [{ text: "第一题" }, { text: "第二题" }, { text: "第三题" }];
    const qP = (q: unknown[]): EngineParams => ({ engineType: "three_stage", language: "zh-CN", questions: q });
    async function fullTurn(ws: FakeWs, llm: FakeLlm, userText: string) {
      const before = ws.textsSent().filter((m) => m.type === "tts_text").length;
      ws.emitControl({ type: "asr_final", text: userText });
      ws.emitControl({ type: "turn_end" });
      await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > before, 500).catch(() => {});
      const after = ws.textsSent().filter((m) => m.type === "tts_text").length;
      for (let i = before; i < after; i++) ws.emitControl({ type: "tts_done" });
      const withDirect = ws.textsSent().filter((m) => m.type === "tts_text");
      for (let i = after; i < withDirect.length; i++) {
        const text = String(withDirect[i].text ?? "");
        if (text.startsWith("接下来，") || text.startsWith("Next, ")) ws.emitControl({ type: "tts_done" });
      }
      await waitUntil(() => true, 10);
    }
    function mk(tokens: string[], q: unknown[]) {
      const ws = new FakeWs();
      const gpu = new GpuClient(ws, "sessR1");
      const llm = new FakeLlm(tokens);
      const engine = new ThreeStageEngine(gpu, llm);
      return { ws, gpu, llm, engine };
    }

    it("hasPendingQuestions:有未问完题=true;无题/问完=false", async () => {
      const { engine } = mk(["好", "。"], QS3);
      engine.onTurnEvent(() => {});
      await engine.start("sessR1", "你是老师", qP(QS3));
      expect(engine.hasPendingQuestions()).toBe(true); // 游标在第1题
      const noq = mk(["好", "。"], []);
      noq.engine.onTurnEvent(() => {});
      await noq.engine.start("sessR1", "你是助手", qP([]));
      expect(noq.engine.hasPendingQuestions()).toBe(false); // 无题
    });

    it("design contract hasQuestions:有效题 → true;无题 → false;全脏题(空 text)→ false(validQuestions 口径,不落双重失效缝)", async () => {
      // 有有效题:hasQuestions=true(不随游标推进变化,回答「这场是不是自由聊天」)
      const withQ = mk(["好", "。"], QS3);
      withQ.engine.onTurnEvent(() => {});
      await withQ.engine.start("sessR1", "你是老师", qP(QS3));
      expect(withQ.engine.hasQuestions()).toBe(true);
      // 无题(空数组):hasQuestions=false = 自由聊天
      const noq = mk(["好", "。"], []);
      noq.engine.onTurnEvent(() => {});
      await noq.engine.start("sessR1", "你是助手", qP([]));
      expect(noq.engine.hasQuestions()).toBe(false);
      // ★ 全脏题(非空数组但 validQuestions 过滤后为 0):必须判 false = 自由聊天(review 双重失效缝)。
      //   若用裸 this.questions.length 会判 true(误当有题)→ 既不被 exam 保护也不被 openChat 保护。
      const dirty = [{ text: "" }, { text: "   " }, { notText: 1 }];
      const dq = mk(["好", "。"], dirty);
      dq.engine.onTurnEvent(() => {});
      await dq.engine.start("sessR1", "你是助手", qP(dirty));
      expect(dq.engine.hasQuestions()).toBe(false); // validQuestions 口径:全脏 = 无有效题
      expect(dq.engine.hasPendingQuestions()).toBe(false); // 与 hasPendingQuestions 同口径
    });

    it("design contract mode-aware END_CALL_DIRECTIVE:有题=测评变体(允许感觉收尾时确认);无题=自由聊天变体(绝不主动结束)", async () => {
      // ★ review:测**最终传给 llm.stream 的 systemPrompt**(含 END_CALL_DIRECTIVE 追加),非只测 composeSessionPrompt。
      // 有题:测评变体——含"话题自然收尾"主动性措辞(问完后能自然收尾)
      const withQ = mk(["好", "。"], QS3);
      withQ.engine.onTurnEvent(() => {});
      await withQ.engine.start("sessR1", "你是老师", qP(QS3));
      withQ.ws.emitControl({ type: "asr_final", text: "你好" });
      withQ.ws.emitControl({ type: "turn_end" });
      await waitUntil(() => withQ.llm.turns.length >= 1, 500);
      const spExam = withQ.llm.turns[0].systemPrompt;
      expect(spExam).toContain("话题自然收尾"); // 测评变体(1)保留主动性
      expect(spExam).not.toContain("你绝不主动发起结束"); // 不含自由聊天变体的强约束

      // 无题:自由聊天变体——**删**主动性,含"你绝不主动发起结束" + "只有当对方明确表示"
      const noq = mk(["好", "。"], []);
      noq.engine.onTurnEvent(() => {});
      await noq.engine.start("sessR1", "你是聊天伙伴", qP([]));
      noq.ws.emitControl({ type: "asr_final", text: "你好呀" });
      noq.ws.emitControl({ type: "turn_end" });
      await waitUntil(() => noq.llm.turns.length >= 1, 500);
      const spOpen = noq.llm.turns[0].systemPrompt;
      expect(spOpen).toContain("你绝不主动发起结束"); // 自由聊天变体:AI 不主动结束
      expect(spOpen).toContain("只有当对方明确表示"); // 只有用户明确要走才确认
      expect(spOpen).not.toContain("话题自然收尾"); // ★ 删掉了测评变体的主动收尾诱因(review 核心)
      // 两步确认门控 (2)-(5) 两变体都在(共用 END_CALL_STEPS_COMMON):
      expect(spOpen).toContain("没问过确认就不许输出结束标记");
      expect(spExam).toContain("没问过确认就不许输出结束标记");
    });

    it("未问完题:单独 [[END_CALL]] 被压制(wantsEndCall=false),不结束", async () => {
      const { ws, llm, engine } = mk(["到这里吧", "\n", "[[END_CALL]]"], QS3);
      engine.onTurnEvent(() => {});
      await engine.start("sessR1", "你是老师", qP(QS3));
      await fullTurn(ws, llm, "我不想做了"); // 第1题,想走 → 压制
      expect(engine.wantsEndCall()).toBe(false);
      expect(engine.hasPendingQuestions()).toBe(true); // 仍有未问完题
    });

    it("三次坚持逃生阀:第3次要求结束后放行 [[END_CALL]] + earlyExit", async () => {
      const { ws, llm, engine } = mk(["到这里吧", "\n", "[[END_CALL]]"], QS3);
      engine.onTurnEvent(() => {});
      await engine.start("sessR1", "你是老师", qP(QS3));
      // 每轮都想走(命中 FAREWELL 强制推进 + END_CALL);前 2 次压制,第 3 次放行
      await fullTurn(ws, llm, "我不想做了");     // 第1次:压制
      expect(engine.wantsEndCall()).toBe(false);
      await fullTurn(ws, llm, "真的要结束");     // 第2次:压制
      expect(engine.wantsEndCall()).toBe(false);
      await fullTurn(ws, llm, "我得走了");       // 第3次:放行
      expect(engine.wantsEndCall()).toBe(true);  // 逃生阀放行,结束信号保留
      expect(engine.wantsEarlyExit()).toBe(true);
    });

    it("noteEndRequest:客户端 end 帧来源计数,达阈值放行", async () => {
      const { engine } = mk(["好", "。"], QS3);
      engine.onTurnEvent(() => {});
      await engine.start("sessR1", "你是老师", qP(QS3));
      expect(engine.noteEndRequest()).toBe(false); // 1
      expect(engine.noteEndRequest()).toBe(false); // 2
      expect(engine.noteEndRequest()).toBe(true);  // 3 → 放行
      expect(engine.wantsEarlyExit()).toBe(true);
    });

    it("题目全问完后 [[END_CALL]] 不再压制(恢复正常收尾)", async () => {
      // design contract:末题作答 + [[NEXT]] → 立即推进至越界=问完;第2轮同轮出 [[END_CALL]](已问完不压制,正常收尾)。
      const { ws, llm, engine } = mk(["好的", "\n", "[[NEXT]]", "[[END_CALL]]"], [{ text: "唯一题" }]);
      engine.onTurnEvent(() => {});
      await engine.start("sessR1", "你是老师", qP([{ text: "唯一题" }]));
      await fullTurn(ws, llm, "我的答案是这样的挺完整"); // 有效作答 + [[NEXT]] → 推进,cursor 越界=问完
      // 问完后再一轮出 END_CALL(此时 hasPendingQuestions=false,不压制)
      await fullTurn(ws, llm, "好的没有了谢谢");
      expect(engine.hasPendingQuestions()).toBe(false);
      expect(engine.wantsEndCall()).toBe(true); // 问完:END_CALL 生效
    });

    it("纯人设对话(无题):[[END_CALL]] 不受考试强制影响,正常结束", async () => {
      const { ws, llm, engine } = mk(["好的再见", "\n", "[[END_CALL]]"], []);
      engine.onTurnEvent(() => {});
      await engine.start("sessR1", "你是助手", qP([]));
      await fullTurn(ws, llm, "没有了谢谢拜拜");
      expect(engine.hasPendingQuestions()).toBe(false);
      expect(engine.wantsEndCall()).toBe(true); // 无题:不介入,END_CALL 正常
    });
  });

  // 注:design contract(4.2)裁判辅助推进票已砍(见 design contract「4.2 决策:砍掉」)——引擎不再有 noteAnswerComplete,
  //   游标推进逐字节保持现状(design contract),故本文件无对应测试。
});

// ── design contract:打断后 AI 上下文与用户实际听到的内容对齐(truncated message)──
describe("ThreeStageEngine design contract 打断后上下文对齐", () => {
  // 慢 LLM:逐句间等一拍,给 barge-in 卡在「已下发部分句、后续句未发」的中途窗口。
  function slowLlm(sentences: string[]): LlmStreamer {
    return {
      async *stream(_turn, signal): AsyncIterable<string> {
        for (const s of sentences) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, 8));
          yield s;
        }
      },
    };
  }

  it("LLM 生成中被 barge_in 打断:history/转写记「已下发部分 + [被打断]」而非完整全文", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessR4");
    // 每句自带句号,分句器逐句吐;慢 LLM 使打断时只发出前几句。
    const llm = slowLlm(["第一句。", "第二句。", "第三句。", "第四句。", "第五句。"]);
    const engine = new ThreeStageEngine(gpu, llm);
    const aiTexts: string[] = [];
    engine.onLlmText((t) => aiTexts.push(t));
    engine.onTurnEvent(() => {});
    await engine.start("sessR4", "你是助手", params);

    ws.emitControl({ type: "asr_final", text: "请讲个长故事" });
    ws.emitControl({ type: "turn_end" });
    // 等到已下发若干句(但不到全部)时打断
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length >= 2);
    const dispatched = ws.textsSent().filter((m) => m.type === "tts_text").length;
    expect(dispatched).toBeLessThan(5); // 确认打断时未发全(否则测不出「截断 < 完整」)
    engine.cancel("barge_in");
    await waitUntil(() => aiTexts.length >= 1);

    // 转写(llmTextCb)收到的是已下发部分 + 截断标记,不是完整五句。
    const recorded = aiTexts[aiTexts.length - 1];
    expect(recorded).toContain("[被打断]");
    expect(recorded).toContain("第一句");
    expect(recorded).not.toContain("第五句"); // 未下发的后半段不进上下文
    expect(recorded.endsWith("[被打断]")).toBe(true); // 截断标记在末尾
  });

  it("被打断轮的截断内容进 history:下一轮 LLM 只见已听到部分,不见未播出的后半", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessR4hist");
    // 用可记录 history 的 FakeLlm 观察下一轮 history;但需慢吐才能中途打断 → 自定义带 turns 记录的慢 LLM。
    const turns: LlmTurn[] = [];
    const llm: LlmStreamer = {
      async *stream(turn, signal): AsyncIterable<string> {
        turns.push(turn);
        for (const s of ["前半句。", "后半句。", "更后面。"]) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, 8));
          yield s;
        }
      },
    };
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sessR4hist", "你是助手", params);
    ws.emitControl({ type: "asr_final", text: "讲讲" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length >= 1);
    engine.cancel("barge_in");
    await new Promise((r) => setTimeout(r, 10));
    // 下一轮
    ws.emitControl({ type: "asr_final", text: "接着说" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => turns.length >= 2);
    const hist = JSON.stringify(turns[1].history ?? []);
    expect(hist).toContain("[被打断]");
    expect(hist).toContain("前半句");
    expect(hist).not.toContain("更后面"); // 未播出的后半段不进 history(AI 不会引用用户没听到的)
  });

  it("收尾类 cancel(session_end)不加截断标记(非「用户听了一半」语义)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessR4b");
    const llm = slowLlm(["甲。", "乙。", "丙。", "丁。"]);
    const engine = new ThreeStageEngine(gpu, llm);
    const aiTexts: string[] = [];
    engine.onLlmText((t) => aiTexts.push(t));
    engine.onTurnEvent(() => {});
    await engine.start("sessR4b", "你是助手", params);
    ws.emitControl({ type: "asr_final", text: "说点什么" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length >= 1);
    engine.cancel("session_end"); // 收尾,非用户打断
    await waitUntil(() => true, 30);
    // session_end 不写截断标记(R4 仅 barge_in 走对齐)。可能一条转写都没有(收尾直接销毁)。
    expect(aiTexts.some((t) => t.includes("[被打断]"))).toBe(false);
  });

  it("正常播完的轮不加截断标记(写完整 reply)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessR4c");
    const llm = new FakeLlm(["你好", "呀", "。"]);
    const engine = new ThreeStageEngine(gpu, llm);
    const aiTexts: string[] = [];
    engine.onLlmText((t) => aiTexts.push(t));
    engine.onTurnEvent(() => {});
    await engine.start("sessR4c", "你是助手", params);
    ws.emitControl({ type: "asr_final", text: "在吗" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
    const n = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < n; i++) ws.emitControl({ type: "tts_done" }); // 正常播完
    await waitUntil(() => aiTexts.length >= 1);
    expect(aiTexts[0]).toBe("你好呀。"); // 完整 reply,无截断标记
    expect(aiTexts[0]).not.toContain("[被打断]");
  });

  it("一句未下发就被打断:不写截断记录(无「听到的内容」)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessR4d");
    const llm = slowLlm(["很长的一整句没有句号所以迟迟不分句下发"]);
    const engine = new ThreeStageEngine(gpu, llm);
    const aiTexts: string[] = [];
    engine.onLlmText((t) => aiTexts.push(t));
    engine.onTurnEvent(() => {});
    await engine.start("sessR4d", "你是助手", params);
    ws.emitControl({ type: "asr_final", text: "说吧" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 4)); // LLM 刚起、还没吐出完整一句(无句号不分句)
    engine.cancel("barge_in");
    await new Promise((r) => setTimeout(r, 20));
    // 一句都没 dispatchTtsText → dispatchedText 空 → 不写任何截断记录(不编造「听到的内容」)。
    expect(aiTexts.length).toBe(0);
  });

  // ── design contract:LLM 已完成、音频未播完时被确认打断 → history 记截断版(不是流末即写的完整 reply)──
  // 候选 A:runLlmTurn 流完不立即 commit(暂存 pendingReply),推迟到 fireAiDone 内 aiDoneCb 之前。
  // 这样"LLM 完成、tts_done 未收齐(音频还在播/缓冲)时被 barge_in"的窗口里,cancel 的 R4 截断分支
  // (!historyWritten 守卫)仍能写截断版——修复前流末即置 historyWritten=true 会把它挡掉、留完整 reply。
  it("design contract:LLM 已完成但音频未播完被确认打断 → history 记截断+[被打断],非完整 reply", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sess037");
    const turns: LlmTurn[] = [];
    // FakeLlm 同步吐完整个 reply(LLM 立即"完成");但下面**不补 tts_done**,模拟音频还没播完。
    const llm: LlmStreamer = {
      async *stream(turn): AsyncIterable<string> {
        turns.push(turn);
        for (const s of ["第一句。", "第二句。"]) yield s;
      },
    };
    const engine = new ThreeStageEngine(gpu, llm);
    const aiTexts: string[] = [];
    engine.onLlmText((t) => aiTexts.push(t));
    engine.onTurnEvent(() => {});
    await engine.start("sess037", "你是助手", params);
    ws.emitControl({ type: "asr_final", text: "讲两句" });
    ws.emitControl({ type: "turn_end" });
    // 等 LLM 流完 + 两句都 dispatch(pendingReply 已暂存);但**故意不发 tts_done**(ttsPending>0,未 fireAiDone)。
    await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length >= 2);
    await new Promise((r) => setTimeout(r, 10)); // 让流末 pendingReply 暂存完成
    // 此刻 LLM 已完成(pendingReply="第一句。第二句。"),但音频未播完(无 tts_done)→ 已确认的设计决策打断。
    engine.cancel("barge_in");
    await waitUntil(() => aiTexts.length >= 1);
    // 修复前:流末已 commit 完整 reply、historyWritten=true → cancel 截断被挡 → 转写是干净完整 reply、无标记。
    // 修复后:pendingReply 未 commit(未 fireAiDone)→ cancel R4 截断分支写"已下发部分 + [被打断]"。
    const recorded = aiTexts[aiTexts.length - 1];
    expect(recorded).toContain("[被打断]"); // ★ 核心:被确认打断的轮带截断标记(非当作干净播完)
    expect(recorded.endsWith("[被打断]")).toBe(true);
    // 下一轮 history 也应是截断版(带标记),不是完整 reply 冒充"用户完整听到"。
    ws.emitControl({ type: "asr_final", text: "继续" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => turns.length >= 2);
    expect(JSON.stringify(turns[1].history ?? [])).toContain("[被打断]");
  });

  it("design contract 回归:LLM 完成 + 音频全播完(正常收尾)→ 写完整 reply,无截断标记", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sess037b");
    const llm = new FakeLlm(["好的", "没问题", "。"]);
    const engine = new ThreeStageEngine(gpu, llm);
    const aiTexts: string[] = [];
    engine.onLlmText((t) => aiTexts.push(t));
    engine.onTurnEvent(() => {});
    await engine.start("sess037b", "你是助手", params);
    ws.emitControl({ type: "asr_final", text: "行吗" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
    const n = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < n; i++) ws.emitControl({ type: "tts_done" }); // 全播完 → fireAiDone → commit 完整 reply
    await waitUntil(() => aiTexts.length >= 1);
    expect(aiTexts[0]).toBe("好的没问题。"); // 完整 reply(推迟到 fireAiDone 才写,但内容不变)
    expect(aiTexts[0]).not.toContain("[被打断]");
  });

  it("design contract:commit(onLlmText) MUST 早于 onAiDone(保 media-session 告别决策顺序)", async () => {
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sess037c");
    const llm = new FakeLlm(["再见", "。"]);
    const engine = new ThreeStageEngine(gpu, llm);
    const order: string[] = [];
    engine.onLlmText(() => order.push("llmText"));
    engine.onAiDone(() => order.push("aiDone"));
    engine.onTurnEvent(() => {});
    await engine.start("sess037c", "你是助手", params);
    ws.emitControl({ type: "asr_final", text: "拜拜" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
    const n = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < n; i++) ws.emitControl({ type: "tts_done" });
    await waitUntil(() => order.includes("aiDone"));
    // 候选 A 落点:fireAiDone 内 commit(→llmText)在 aiDoneCb(→aiDone)之前。
    expect(order).toEqual(["llmText", "aiDone"]);
  });

  it("design contract:stale 轮(LLM 完成未 fireAiDone 就被新轮抢占)完整 reply 仍进下一轮 history(review 补覆盖)", async () => {
    // 回归防护(我跑全量回归时发现的必需修复):快速连续轮下,上一轮 LLM 已流完(pendingReply 设)但
    // tts_done 没收齐、fireAiDone 未触发,新轮 turn_end 已到 → runLlmTurn 的 stale 分支补 commit 上一轮
    // 完整 reply,否则下一轮 LLM 拿不到上一轮 assistant(history 丢整轮上文)。
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sess037d");
    const turns: LlmTurn[] = [];
    // FakeLlm 同步吐完整 reply(LLM 立即完成);记录每轮收到的 turn 以查 history 注入。
    const llm: LlmStreamer = {
      async *stream(turn): AsyncIterable<string> {
        turns.push(turn);
        for (const s of ["第一轮回答", "。"]) yield s;
      },
    };
    const engine = new ThreeStageEngine(gpu, llm);
    engine.onTurnEvent(() => {});
    await engine.start("sess037d", "你是助手", params);
    // 第 1 轮:LLM 流完(pendingReply 设),但**不发 tts_done**(ttsPending>0,fireAiDone 未触发)。
    ws.emitControl({ type: "asr_final", text: "问题一" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => turns.length >= 1);
    await new Promise((r) => setTimeout(r, 10)); // 让第1轮流末暂存 pendingReply
    // 第 2 轮 turn_end 到达(llmBusy 已因 llmReturned 释放)→ runLlmTurn 起新轮,stale 分支补 commit 第1轮。
    ws.emitControl({ type: "asr_final", text: "问题二" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => turns.length >= 2);
    // 第 2 轮 LLM 收到的 history MUST 含第 1 轮完整 assistant(stale 补 commit 生效),不是丢失/截断。
    const hist = JSON.stringify(turns[1].history ?? []);
    expect(hist).toContain("第一轮回答"); // 上一轮完整 reply 进了 history
    expect(hist).toContain("问题一"); // 配对的 user 也在
    expect(hist).not.toContain("[被打断]"); // 正常完成被抢占,非打断,不带截断标记
  });
});

// ── design contract:转写题号事件快照(非落库时重查全局 cursor)──
describe("design contract:转写题号事件快照", () => {
  const qParams = (questions: unknown[]): EngineParams => ({ engineType: "three_stage", language: "zh-CN", questions });

  it("★事件快照:AI 念完当前题→先推游标(cursor 0→1)→其转写仍标本题(questionIndex=0,非全局 cursor=1)", async () => {
    // 变异自证(双评审 Blocker):turn 创建时 cursor=0 → snapshot=0;本轮正常作答→maybeAdvanceCursor 把 cursor
    //   推到 1;之后 fireAiDone→commitAiText→llmTextCb 携带的应是**快照 0**(标本题),而非此刻全局 cursor=1(误标下一题)。
    // design contract:作答须 [[NEXT]] 才推进 → token 带 [[NEXT]] 使本轮推进(题号快照仍在推进前捕获,验证逻辑不变)。
    const { ws, engine } = setup(["这是", "第一题", "的回答", "。", "\n", "[[NEXT]]"]);
    const llmTexts: Array<{ text: string; qi: number | undefined }> = [];
    engine.onLlmText?.((text, qi) => llmTexts.push({ text, qi }));
    engine.onTurnEvent(() => {});
    await engine.start("s052", "你是考官", qParams([{ text: "Q1" }, { text: "Q2" }]));
    ws.emitControl({ type: "asr_final", text: "我的回答是数据分析" }); // >=4 有效字 → answered
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    const n = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < n; i++) ws.emitControl({ type: "tts_done" }); // 播完 → maybeFireAiDone 推进 + commit
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.questionCursor()).toBe(1); // 前提成立:游标确已推进(0→1)
    expect(llmTexts.length).toBeGreaterThanOrEqual(1);
    expect(llmTexts[0].qi).toBe(0); // ★ 转写仍标本题 Q1(快照 0),不是推进后的全局 cursor=1
  });

  it("user asr_final 捕获开口时游标(questionIndex=当时 cursor);asr_partial 不带题号(不落库)", async () => {
    const { ws, engine } = setup([]);
    const got: Array<{ isFinal: boolean; qi: number | undefined }> = [];
    engine.onTranscript((t) => got.push({ isFinal: t.isFinal, qi: t.questionIndex }));
    await engine.start("s052u", "p", qParams([{ text: "Q1" }, { text: "Q2" }]));
    ws.emitControl({ type: "asr_partial", text: "答" });
    ws.emitControl({ type: "asr_final", text: "答案" });
    const partial = got.find((g) => !g.isFinal)!;
    const final = got.find((g) => g.isFinal)!;
    expect(partial.qi).toBeUndefined(); // partial 不落库 → 不带题号
    expect(final.qi).toBe(0); // final 捕获当时游标 0
  });

  it("★评审 Blocker(review):asr_partial(cursor=0)→游标推进(→1)→asr_final,user 题号仍标开口时的 0", async () => {
    // 双评审 揪出:若 user 题号在 asr_final 时刻捕获,「开口(cursor=0)→partial→上一轮推进 cursor=1→final」
    //   会误标 1。修复:首个 asr_partial 那一刻捕获(用户开口时游标),asr_final 用已捕获值,turn_end 清。
    const { ws, engine } = setup([]);
    const finals: Array<number | undefined> = [];
    engine.onTranscript((t) => { if (t.isFinal) finals.push(t.questionIndex); });
    engine.onTurnEvent(() => {});
    await engine.start("s052race", "p", qParams([{ text: "Q1" }, { text: "Q2" }]));
    ws.emitControl({ type: "asr_partial", text: "我" }); // 用户开口,此刻 cursor=0 → 捕获 0
    // 模拟本语音轮内游标被推进(如上一轮宽限窗到期/自动问下一题使 cursor→1):白盒直接推进
    (engine as unknown as { cursor: number }).cursor = 1;
    ws.emitControl({ type: "asr_final", text: "我的答案是数据分析" }); // final 用已捕获的 0,不重取 cursor=1
    expect(finals[0]).toBe(0); // ★ 仍标开口时的 Q1(0),不是推进后的 1
  });

  it("无题会话:asr_final 与 AI 转写题号均 undefined(不落 question_index)", async () => {
    const { ws, engine } = setup(["随便", "聊聊", "。"]);
    const finals: Array<number | undefined> = [];
    const llmTexts: Array<number | undefined> = [];
    engine.onTranscript((t) => { if (t.isFinal) finals.push(t.questionIndex); });
    engine.onLlmText?.((_t, qi) => llmTexts.push(qi));
    engine.onTurnEvent(() => {});
    await engine.start("s052n", "p", params); // 无 questions
    ws.emitControl({ type: "asr_final", text: "随便聊聊天气" });
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    const n = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < n; i++) ws.emitControl({ type: "tts_done" });
    await new Promise((r) => setTimeout(r, 20));
    expect(finals[0]).toBeUndefined(); // 无题 → user 转写不标题号
    expect(llmTexts[0]).toBeUndefined(); // 无题 → AI 转写不标题号
  });

  it("游标越界(题问完)后:user asr_final 题号 undefined(收尾语不标);答题轮 AI 转写仍标本题", async () => {
    // 单题:答完 Q1 → cursor 推到 1 = 越界(length 1)。答题轮 AI 快照=0(标 Q1);越界后新句快照 undefined。
    // design contract:末题作答须 [[NEXT]] 才推进至越界 → token 带 [[NEXT]]。
    const { ws, engine } = setup(["回答", "第一题", "。", "\n", "[[NEXT]]"]);
    const llmTexts: Array<number | undefined> = [];
    const finals: Array<number | undefined> = [];
    engine.onLlmText?.((_t, qi) => llmTexts.push(qi));
    engine.onTranscript((t) => { if (t.isFinal) finals.push(t.questionIndex); });
    engine.onTurnEvent(() => {});
    await engine.start("s052o", "p", qParams([{ text: "Q1" }]));
    ws.emitControl({ type: "asr_final", text: "这是我给出的答案" }); // 答 Q1,快照 0
    ws.emitControl({ type: "turn_end" });
    await new Promise((r) => setTimeout(r, 20));
    const n = ws.textsSent().filter((m) => m.type === "tts_text").length;
    for (let i = 0; i < n; i++) ws.emitControl({ type: "tts_done" }); // 播完 → cursor 0→1(越界)
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.questionCursor()).toBe(1); // 越界(>= length 1)
    expect(llmTexts[0]).toBe(0); // 答题轮 AI 转写标本题 Q1(快照 0)
    ws.emitControl({ type: "asr_final", text: "还有补充吗" }); // 越界后新句
    expect(finals[finals.length - 1]).toBeUndefined(); // 越界后 user 转写不标题号(收尾语稀疏)
  });
});
