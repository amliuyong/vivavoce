/**
 * design contract(缺陷2:被暂停/打断的 AI 轮**禁止污染推进状态**)—— 变异自证。
 *
 * 根因:推进整段(maybeAdvanceCursor 计 retry / advance / 启 waiting)此前在 maybeFireAiDone 里,先于 fireAiDone;
 *   tentative-pause defer 只拦 fireAiDone 出声,不拦之前已计的 retry。修复:推进整段迁入 fireAiDone,**仅本次传入
 *   的轮级 completed=true 时执行**。退出矩阵:resume(续发完缓存)保留原始 completed;所有**丢缓存**退出
 *   (confirmTakeover→cancel / 任意 cancel / 防御性 turn_end)兑现 completed=**false** → 不推进、不计 retry、不启 waiting。
 *
 * 本文件锁 AIM_ANSWER_GRACE_MS=0(与主引擎测试一致:正常已作答立即推进,便于同步断言推进/retry)。
 * 用可控 gate LLM 精确制造「暂停期内 LLM 流完 + 播完 → fireAiDone 被 defer」,再走不同退出路径验证 completed 语义。
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
  textsSent(): Record<string, unknown>[] {
    return this.sent.filter((s) => s.kind === "text").map((s) => JSON.parse(s.data as string));
  }
  ttsCount(): number {
    return this.textsSent().filter((m) => m.type === "tts_text").length;
  }
}

/** 同步 yield 固定 token 的假 LLM(不 await)。 */
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

const QS = [
  { text: "第一题:自我介绍" },
  { text: "第二题:讲讲项目经历" },
  { text: "第三题:什么是零信任" },
];
const qParams = (questions: unknown[]): EngineParams => ({ engineType: "three_stage", language: "zh-CN", questions });

async function drain(n = 16): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function makeEngine(tokens: string[]) {
  const ws = new FakeWs();
  const gpu = new GpuClient(ws, "sessR1");
  const llm = new FakeLlm(tokens);
  const engine = new ThreeStageEngine(gpu, llm);
  engine.onTurnEvent(() => {});
  return { ws, gpu, llm, engine };
}

/** 驱动到「暂停期内本轮完整播完、onAiDone 被 defer」:起轮 → 排空(LLM 流完+句下发)→ pause → 补 tts_done。 */
async function driveToDefer(ws: FakeWs, engine: ThreeStageEngine, userText: string): Promise<void> {
  const before = ws.ttsCount();
  ws.emitControl({ type: "asr_final", text: userText });
  ws.emitControl({ type: "turn_end" });
  await drain();
  const after = ws.ttsCount();
  engine.pause(); // 进 tentative-pause(pausedTurn = 当前活跃轮)
  for (let i = before; i < after; i++) ws.emitControl({ type: "tts_done" }); // 播完 → fireAiDone 进 defer
  await drain();
}

describe("design contract 退出矩阵:被暂停/打断轮禁止污染推进状态(缺陷2)", () => {
  it("confirmTakeover→cancel(barge_in)兑现 deferred → completed=false:不推进、不计 retry、不启 waiting", async () => {
    // 第1题有效作答 + [[NEXT]](本会正常推进)→ 但暂停期播完被 defer → cancel 丢缓存 → 兑现 completed=false。
    const { ws, llm, engine } = makeEngine(["好的了解", "。", "[[NEXT]]"]);
    const completedArgs: (boolean | undefined)[] = [];
    engine.onAiDone((c) => completedArgs.push(c));
    await engine.start("sessR1", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    await driveToDefer(ws, engine, "我叫张三来自北京做后端开发工程师"); // 暂停期播完 → defer
    const turnsBefore = llm.turns.length;
    const retryBefore = (engine as unknown as { retryOnCurrent: number }).retryOnCurrent;
    engine.cancel("barge_in"); // 确认打断:丢缓存,兑现 completed=false
    await drain();
    // ★ 变异自证:若 cancel 仍传原始 deferredCompleted(=true),下面三条会红。
    expect(completedArgs).toEqual([false]); // 兑现 completed=false(不进 waiting;review)
    expect(engine.questionCursor()).toBe(0); // MUST NOT 推进(被打断轮不算问过/答过)
    expect((engine as unknown as { retryOnCurrent: number }).retryOnCurrent).toBe(retryBefore); // retry 不虚增
    expect(llm.turns.length).toBe(turnsBefore); // 不起自动问下一题轮(未推进 + interrupted)
  });

  it("防御性 turn_end 兑现 deferred → completed=false + 清 [[NEXT]]/[[END_CALL]] 语义标志(评审 Major:泄漏)", async () => {
    // 本轮 LLM 同时出 [[NEXT]] + [[END_CALL]](暂停期流末置 nextSignaled/endCallSignaled)。防御性 turn_end 丢缓存兑现
    //   completed=false → 跳过 advanceAndScheduleNext(它才消费 nextSignaled/压制 endCallSignaled)→ 若不显式清,
    //   [[NEXT]] 污染下一轮推进、[[END_CALL]] 被 media wantsEndCall 读到误挂断。修:defensive turn_end 对齐 cancel 清两标志。
    const { ws, engine } = makeEngine(["好的了解", "。", "[[NEXT]]", "[[END_CALL]]"]);
    const completedArgs: (boolean | undefined)[] = [];
    engine.onAiDone((c) => completedArgs.push(c));
    await engine.start("sessR1", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    await driveToDefer(ws, engine, "我叫张三来自北京做后端开发工程师");
    const eng = engine as unknown as { nextSignaled: boolean; endCallSignaled: boolean };
    expect(eng.nextSignaled).toBe(true); // 暂停期流末已置(尚未被消费——迁移后 defer 轮不再在 pause 中跑推进)
    // 异常序列:暂停中收到 turn_end → 防御性清理分支兑现 deferred(丢缓存)。
    ws.emitControl({ type: "turn_end" });
    await drain();
    expect(completedArgs).toEqual([false]); // 丢缓存 → completed=false(变异:传原始 true → 红)
    expect(engine.questionCursor()).toBe(0); // 不推进
    // ★ 评审 Major:两语义标志已清,不跨轮泄漏(变异:删两行清理 → nextSignaled/endCallSignaled 残留 true → 红)。
    expect(eng.nextSignaled).toBe(false);
    expect(engine.wantsEndCall()).toBe(false); // endCallSignaled 已清 → media 不会误挂断
  });

  it("任意收尾 cancel(session_end)兑现 deferred → completed=false(不推进/不 waiting)", async () => {
    const { ws, engine } = makeEngine(["好的了解", "。", "[[NEXT]]"]);
    const completedArgs: (boolean | undefined)[] = [];
    engine.onAiDone((c) => completedArgs.push(c));
    await engine.start("sessR1", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    await driveToDefer(ws, engine, "我叫张三来自北京做后端开发工程师");
    engine.cancel("session_end");
    await drain();
    expect(completedArgs).toEqual([false]);
    expect(engine.questionCursor()).toBe(0);
  });

  it("对照:resume(误打断续播)兑现 deferred → 保留原始 completed=true,正常推进", async () => {
    // 同一「答完 + [[NEXT]]」轮暂停期播完,但走 resume(续发完缓存)→ 对方听完了 → 该推进(保留原始 true)。
    const { ws, engine } = makeEngine(["好的了解", "。", "[[NEXT]]"]);
    const completedArgs: (boolean | undefined)[] = [];
    engine.onAiDone((c) => completedArgs.push(c));
    await engine.start("sessR1", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    await driveToDefer(ws, engine, "我叫张三来自北京做后端开发工程师");
    expect(engine.questionCursor()).toBe(0); // defer 中尚未兑现推进
    engine.resume(); // 续发完缓存 → 兑现原始 completed=true
    await drain();
    expect(completedArgs).toEqual([true]); // ★ resume 保留原始 completed(不被 R1 改成 false)
    expect(engine.questionCursor()).toBe(1); // 正常推进到第2题(对方听完了)
  });

  it("回归:正常完整播完(不暂停)completed=true,推进 metrics 不受影响(design contract)", async () => {
    const { ws, engine } = makeEngine(["好的了解", "。", "[[NEXT]]"]);
    const completedArgs: (boolean | undefined)[] = [];
    let metricsCount = 0;
    engine.onAiDone((c) => completedArgs.push(c));
    engine.onMetrics(() => (metricsCount += 1));
    await engine.start("sessR1", "你是面试官", qParams(QS));
    ws.emitControl({ type: "ready" });
    const before = ws.ttsCount();
    ws.emitControl({ type: "asr_final", text: "我叫张三来自北京做后端开发工程师" });
    ws.emitControl({ type: "turn_end" });
    await drain();
    const after = ws.ttsCount();
    for (let i = before; i < after; i++) ws.emitControl({ type: "tts_done" });
    await drain();
    expect(completedArgs).toEqual([true]); // 正常播完 → completed=true
    expect(engine.questionCursor()).toBe(1); // 正常推进
    expect(metricsCount).toBe(1); // full metrics 恰一次(按 fullyPlayed 独立,不受 completed 门控影响)
  });
});
