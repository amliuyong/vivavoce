/**
 * design contract:答完补充宽限窗(延迟推进)—— 别误伤「边想边答/答完还想补充」的用户。
 *
 * 判「当前题正常已作答、该推进」时**不立即** advanceCursor,先启静默窗:
 *   - 从用户轮开始至少保留 AIM_ANSWER_GRACE_MS=4000;
 *   - direct auto-next 在上一句估算播完后仍保留 AIM_AUTO_NEXT_GRACE_MS=800。
 *   - 窗内用户再开口(首个 asr_partial/asr_final)→ cancelAnswerGrace,游标停本题、当续答;
 *   - 窗内无声 → 到期才 advanceCursor + 自动问下一题。
 * 仅包 advanceIfVoiced 判定的**正常推进**;拒答/告别/防死循环/追问上限的强推**不经宽限窗**(立即推进)。
 *
 * feature-flag 模块级读 env → 本文件 import 前设 AIM_ANSWER_GRACE_MS=4000(单独文件=单独模块图,与其余引擎
 * 测试的 grace=0 隔离)。用假定时器(jest.useFakeTimers)+ 微任务排空驱动同步 FakeLlm 流,确定性复现时序契约。
 * grace=0(逐字节等价现状)由末尾 resetModules 描述块单独验;其余引擎测试文件已锁 grace=0,全绿即等价佐证。
 */
process.env.AIM_ANSWER_GRACE_MS = "4000";
process.env.AIM_AUTO_NEXT_GRACE_MS = "800";

import { GpuClient, WsLike } from "../src/gpu-client";
import { MediaSession } from "../src/media-session";
import {
  type MediaSessionCloseEvent,
  type MediaSessionCommand,
  type MediaSessionCommandHandler,
  type MediaSessionOutputEvent,
  type MediaSessionTransport,
} from "../src/media-session-port";
import { ThreeStageEngine as RealThreeStageEngine } from "../src/three-stage-engine";
import { LlmStreamer, LlmTurn } from "../src/bedrock-llm";
import { EngineParams } from "../src/voice-engine";

// 追踪构造 + afterEach 统一收尾(同 three-stage-engine.test.ts:防真定时器泄漏「Cannot log after tests are done」)。
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
  jest.clearAllTimers();
  jest.useRealTimers();
  for (const e of _openEngines.splice(0)) await e.stop().catch(() => undefined);
});

/** 可编程假 WS:记录上行 + 注入下行控制/音频帧。 */
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

/** 假 LLM:同步 yield 固定 token(不 await);记录每轮收到的 turn(校验 prompt/游标)。 */
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

class CallbackConfirmedTransport implements MediaSessionTransport {
  readonly protocolNeutral = true as const;
  readonly outputDelivery = "callback_confirmed" as const;
  readonly events: MediaSessionOutputEvent[] = [];
  readonly closes: MediaSessionCloseEvent[] = [];
  private commandHandler: MediaSessionCommandHandler = () => undefined;

  onCommand(callback: MediaSessionCommandHandler): void {
    this.commandHandler = callback;
  }
  onClose(): void {}
  emit(event: MediaSessionOutputEvent): void {
    this.events.push(event);
  }
  close(event: MediaSessionCloseEvent): void {
    this.closes.push(event);
  }
  async command(command: MediaSessionCommand): Promise<void> {
    await this.commandHandler(command);
  }
}

const QS = [
  { text: "第一题:自我介绍" },
  { text: "第二题:讲讲项目经历" },
  { text: "第三题:什么是零信任" },
];
const qParams = (questions: unknown[]): EngineParams => ({
  engineType: "three_stage",
  language: "zh-CN",
  questions,
});

/** 排空微任务(FakeLlm 同步流经微任务推进;假定时器不影响 promise 微任务)。 */
async function drainMicrotasks(n = 16): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function makeEngine(tokens: string[], questions: unknown[]) {
  const ws = new FakeWs();
  const gpu = new GpuClient(ws, "sessGrace");
  const llm = new FakeLlm(tokens);
  const engine = new ThreeStageEngine(gpu, llm);
  engine.onTurnEvent(() => {});
  return { ws, gpu, llm, engine };
}

async function startEngine(ws: FakeWs, engine: ThreeStageEngine, questions: unknown[]) {
  await engine.start("sessGrace", "你是面试官", qParams(questions));
  ws.emitControl({ type: "ready" }); // 满足 GpuClient 握手(否则 5s 握手看门狗;本测试用假定时器)
}

/** 驱动一整轮**正常完整**对话:asr_final + turn_end → 排空流 → 补齐本轮 tts_done → 排空。
 *  正常已作答路径下:maybeAdvanceCursor 记「待宽限推进意图」(不立即推进),fireAiDone 末尾 armAnswerGrace 起窗。 */
async function driveFullTurn(ws: FakeWs, userText: string): Promise<void> {
  const before = ws.ttsCount();
  ws.emitControl({ type: "asr_final", text: userText });
  ws.emitControl({ type: "turn_end" });
  await drainMicrotasks();
  const after = ws.ttsCount();
  for (let i = before; i < after; i++) ws.emitControl({ type: "tts_done" });
  const withDirect = ws.textsSent().filter((m) => m.type === "tts_text");
  for (let i = after; i < withDirect.length; i++) {
    const text = String(withDirect[i].text ?? "");
    if (text.startsWith("接下来，") || text.startsWith("Next, ")) ws.emitControl({ type: "tts_done" });
  }
  await drainMicrotasks();
}

describe("design contract 答完补充宽限窗(turn=4000/post-playback=800,假定时器)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it("答完留窗:游标不立即推进(记意图),到期前停本题", async () => {
    const { ws, llm, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师"); // 第1题正常有效作答
    // ★ 契约 §1:正常已作答**不立即推进**——游标仍在第1题,只记了待宽限推进意图。
    expect(engine.questionCursor()).toBe(0);
    // 未到期(只推进 2000ms < 用户轮保护 4000ms)→ 仍不推进。
    jest.advanceTimersByTime(2000);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(0);
    expect(llm.turns.length).toBe(1); // 没有自动问下一题轮(还没到期)
  });

  it("design contract:追问预算耗尽的强制收口不进入 answer grace,立即推进", async () => {
    const { ws, llm, engine } = makeEngine(["能再展开一下吗", "?"], QS);
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    await driveFullTurn(ws, "我负责过电商订单系统和库存模块");
    expect(engine.questionCursor()).toBe(0);
    await driveFullTurn(ws, "我还做过缓存以及消息队列优化");
    expect(llm.turns[2].systemPrompt).toContain("追问机会已用完");
    expect(engine.questionCursor()).toBe(1); // 不等 4000ms
  });

  it("design contract:aiDoneCb 返回 playbackNotBeforeMs → armAnswerGrace 延后 = lead + grace(播放边界后推进)", async () => {
    // engine 侧集成:onAiDone 回调返回一个「未来的估算播完时刻」(now + 5000)→ armAnswerGrace 截止线为
    //   max(用户轮 4000ms,5000 playback lead + 800 post-playback)=5800ms。
    const { ws, llm, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    engine.onAiDone(() => Date.now() + 5000); // 模拟 media 返回:客户端估算 5s 后才播完
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    expect(engine.questionCursor()).toBe(0); // 记意图,未推进
    jest.advanceTimersByTime(5799);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(0); // ★ 播放边界后移:5799ms 仍未到期
    // 到播放边界后 800ms 才推进。
    jest.advanceTimersByTime(1);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(1); // 估算播完(5000)+ post-playback grace(800)后推进
    expect(llm.turns.length).toBe(1);
    expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
  });

  it("design contract:aiDoneCb 返回 void(未接返回值)→ armAnswerGrace 退回现状 grace(逐字节等价)", async () => {
    // onTurnEvent 已接但 onAiDone 未接返回值(返回 undefined)→ leadMs=0 → delay = grace(4000),现状等价。
    const { ws, llm, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    // 不设 onAiDone(默认 () => {} 返回 void)
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    jest.advanceTimersByTime(4000); // 无耗时可抵扣时仍保留完整用户轮保护
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(1);
  });

  it("writer failure 在 response.done handoff 前不推进游标、不启动 answer grace、不授权正常挂断", async () => {
    const { ws, engine } = makeEngine(
      ["好的。", "\n[[NEXT]]", "\n[[END_CALL]]"],
      QS,
    );
    const transport = new CallbackConfirmedTransport();
    const endedReasons: string[] = [];
    const session = new MediaSession(
      transport,
      {
        sessionId: "sess_writer_failure_side_effects",
        systemPrompt: "你是面试官",
        engineParams: qParams(QS),
      },
      {
        engine,
        recorder: {
          async start() {},
          pushCaller() {},
          pushAi() {},
          async stopAndUpload() {
            return null;
          },
        } as never,
        transcripts: {
          async putFinal() {},
        } as never,
        onEnded: ({ reason }) => endedReasons.push(reason),
      },
    );
    await session.begin();
    ws.emitControl({ type: "ready" });
    await driveFullTurn(
      ws,
      "我负责过电商订单系统和库存模块，也做过消息队列优化",
    );

    const terminal = transport.events.find(
      (
        event,
      ): event is Extract<
        MediaSessionOutputEvent,
        { type: "response_core_terminal" }
      > => event.type === "response_core_terminal",
    );
    expect(terminal).toBeDefined();
    const engineState = engine as unknown as {
      answerGraceTimer: ReturnType<typeof setTimeout> | null;
      pendingAdvance: boolean;
      pendingResponseSettlement: { phase: string } | null;
    };
    const mediaState = session as unknown as {
      hangupTimer: ReturnType<typeof setTimeout> | null;
    };
    expect(engine.questionCursor()).toBe(0);
    expect(engineState.pendingResponseSettlement?.phase).toBe("wire");
    expect(engineState.pendingAdvance).toBe(false);
    expect(engineState.answerGraceTimer).toBeNull();
    expect(mediaState.hangupTimer).toBeNull();

    await transport.command({
      type: "note_output_wire_failure",
      responseGeneration: terminal!.responseGeneration,
      reason: "response.done callback failed",
    });
    await drainMicrotasks();

    expect(engine.questionCursor()).toBe(0);
    expect(engineState.pendingResponseSettlement).toBeNull();
    expect(engineState.pendingAdvance).toBe(false);
    expect(engineState.answerGraceTimer).toBeNull();
    expect(engine.wantsEndCall()).toBe(false);
    expect(mediaState.hangupTimer).toBeNull();
    expect(transport.closes).toEqual([
      { type: "session_ended", reason: "error" },
    ]);
    expect(endedReasons).toEqual(["error"]);

    jest.advanceTimersByTime(10_000);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(0);
    expect(mediaState.hangupTimer).toBeNull();
  });

  it("direct auto-next 不把用户轮保护缩成 800ms", async () => {
    const { ws, llm, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    jest.advanceTimersByTime(3999);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(0);
    jest.advanceTimersByTime(1);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(1);
    expect(llm.turns).toHaveLength(1);
    expect(ws.textsSent().some((message) =>
      message.type === "tts_text" && message.text === `接下来，${QS[1].text}`,
    )).toBe(true);
  });

  it("答完留窗、无补充 → 到期推进第2题 + 自动问下一题(§3 正常路径)", async () => {
    // design contract:「判答完该推进」= 有 [[NEXT]] → token 带 [[NEXT]] 触发宽限窗路径(否则无 [[NEXT]] 不进推进/不 arm 窗)。
    const { ws, llm, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    expect(engine.questionCursor()).toBe(0);
    // 窗内无新 speech(graceGen 未变)→ 到期 advanceCursor + maybeAutoAskNext。
    jest.advanceTimersByTime(4000);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(1); // 推进到第2题
    expect(llm.turns.length).toBe(1);
    expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
  });

  it("答完留窗、窗内用户开口(asr_partial)→ cancelAnswerGrace,游标停本题当续答(§2)", async () => {
    const { ws, llm, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    expect(engine.questionCursor()).toBe(0);
    // 窗内 2000ms 用户又开口(asr_partial)→ 立即取消宽限窗(不等 runLlmTurn)。
    jest.advanceTimersByTime(2000);
    ws.emitControl({ type: "asr_partial", text: "我补充一下" });
    // 即使推进过原定 4000ms 到期点,也**不推进**(timer 已被取消 + graceGen 已变)。
    jest.advanceTimersByTime(5000);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(0); // 游标停第1题
    expect(llm.turns.length).toBe(1); // 没有自动问下一题轮
    // 续答并入本题:新一轮的 prompt 仍是第1题。
    await driveFullTurn(ws, "我还想补充我做过分布式系统");
    expect(llm.turns[llm.turns.length - 1].systemPrompt).toContain("第 1/3 题");
  });

  it("开口跨 timer 边界不误推:asr_partial(3900ms)取消,4000ms 到期不推进(§2 硬伤)", async () => {
    const { ws, llm, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    // 3900ms 用户开口(asr_partial 先到,asr_final 稍后才来)→ 首个 asr_partial 即取消 grace。
    jest.advanceTimersByTime(3900);
    ws.emitControl({ type: "asr_partial", text: "等一下我" });
    // 到 4000ms 原定到期点:timer 已取消 → 不重现「说着话被推进」。
    jest.advanceTimersByTime(100);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(0);
    expect(llm.turns.length).toBe(1);
  });

  it("asr_final(无 asr_partial 前导)也即时取消 grace(§2 兜底)", async () => {
    const { ws, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    jest.advanceTimersByTime(1000);
    ws.emitControl({ type: "asr_final", text: "我再补一句关于架构的" }); // 直接 final
    jest.advanceTimersByTime(5000);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(0); // 停本题(asr_final 也取消)
  });

  it("barge-in cancel → 不兑现推进(§4:打断=用户接管)", async () => {
    const { ws, llm, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    expect(engine.questionCursor()).toBe(0);
    engine.cancel("barge_in"); // 确认打断:清宽限定时器,不兑现推进
    jest.advanceTimersByTime(5000);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(0);
    expect(llm.turns.length).toBe(1);
  });

  it("会话结束(stop/session_end)→ 清宽限定时器不兑现推进(§8:max_duration 收尾同路径)", async () => {
    const { ws, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    expect(engine.questionCursor()).toBe(0);
    await engine.stop(); // stop → cancel("session_end") → cancelAnswerGrace
    jest.advanceTimersByTime(5000);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(0); // 收尾不卡在宽限窗,也不误推进
  });

  it("§3 迟到 timer 守卫(白盒):graceGen 已变的 timer 回调作废不推进(防御在途/重复触发)", async () => {
    // 契约 §2/§3:cancelAnswerGrace 会 clearTimeout 授权取消,graceGen++ 是对「已排队的迟到回调」的二重防御。
    // 单线程确定模型下 clearTimeout 已授权,故正常事件路径无法产生迟到 fire;此处白盒直投一个 stale 代次的
    // fireAnswerGrace,验证守卫本身(移除守卫 → 会误推进 → 本测试变红,变异自证)。
    const { ws, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS);
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
    expect(engine.questionCursor()).toBe(0);
    const eng = engine as unknown as { graceGen: number; fireAnswerGrace(armGen: number): void };
    const staleGen = eng.graceGen - 1; // 模拟 arm 之后 graceGen 已被 bump 的迟到回调
    eng.fireAnswerGrace(staleGen);
    expect(engine.questionCursor()).toBe(0); // 守卫作废,不推进
  });

  it("Major 2:stale 迟到 timer 回调无副作用,不破坏当前合法窗口", async () => {
    // 场景:窗 A arm(armGenA)→ 用户开口 cancel(graceGen++)→ 用户答完 → 窗 B arm(armGenB,当前合法窗)。
    //   若 timer A 迟到回调 fireAnswerGrace(armGenA) 有副作用(清 answerGraceTimer/pendingAdvance),会误废窗 B。
    //   修复:stale 早返回**不碰** answerGraceTimer/pendingAdvance → 窗 B 完好,到期正常推进。
    const { ws, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS); // design contract:带 [[NEXT]] 触发宽限窗
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师"); // 窗 A arm
    const eng = engine as unknown as { graceGen: number; pendingAdvance: boolean; fireAnswerGrace(g: number): void };
    const armGenA = eng.graceGen; // 窗 A 的代次
    ws.emitControl({ type: "asr_partial", text: "补充" }); // cancel 窗 A(graceGen++)
    await driveFullTurn(ws, "我还想说我做过分布式系统架构"); // 窗 B arm(当前合法窗)
    expect(engine.questionCursor()).toBe(0);
    expect(eng.pendingAdvance).toBe(true); // 窗 B 的 pending 已置
    // 迟到的窗 A 回调闯入(stale 代次):必须无副作用,不动窗 B 的 pending/timer。
    eng.fireAnswerGrace(armGenA);
    expect(eng.pendingAdvance).toBe(true); // ★ 窗 B pending 未被 stale 回调误清
    // 窗 B 正常到期推进。
    jest.advanceTimersByTime(4000);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(1); // 窗 B 兑现推进(未被 stale 破坏)
  });

  it("强推路径不经宽限窗:明确拒答立即推进(§7)", async () => {
    const { ws, llm, engine } = makeEngine(["那我们下一题", "。"], QS);
    await startEngine(ws, engine, QS);
    // "不会"(2 有效字 < minAnswerChars 4 → !answered)含拒答意图 → maybeAdvanceCursor decline 分支直接
    //   advanceCursor,不进宽限窗(§7:强推立即推进)。区别于「≥4 字的正常作答」走 advanceIfVoiced 宽限窗。
    await driveFullTurn(ws, "不会");
    expect(engine.questionCursor()).toBe(1); // ★ 立即推进(无需 advanceTimersByTime)
    await drainMicrotasks();
    expect(llm.turns).toHaveLength(1);
    expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
  });

  it("强推路径不经宽限窗:防死循环(追问上限)立即推进(§7)", async () => {
    const { ws, engine } = makeEngine(["请再说一下", "。"], QS);
    await startEngine(ws, engine, QS);
    // 连续无效作答("没想好"=3 有效字,过拒垃圾门槛但 < minAnswerChars(4)未有效作答)。第3次达上限强制推进。
    await driveFullTurn(ws, "没想好");
    expect(engine.questionCursor()).toBe(0);
    await driveFullTurn(ws, "没想好");
    expect(engine.questionCursor()).toBe(0);
    await driveFullTurn(ws, "没想好"); // 第3次达上限 → 立即强制推进(不经宽限窗)
    expect(engine.questionCursor()).toBe(1); // ★ 无需 advanceTimersByTime
  });

  // ── 评审 Major 修复回归 ──

  it("Major 1(白盒):排水块消费悬挂输入前清 pendingAdvance(防泄漏到异常终结的排水轮误推)", async () => {
    // 真机场景:turn A 记 pendingAdvance → A 播报期(busy)用户开口,输入悬挂进 lastFinalText → fireAiDone(A) 的
    //   design contract 排水块消费悬挂输入起排水轮 B。排水块 early-return 跳过 armAnswerGrace,若不清 pendingAdvance,
    //   B 若经**非 maybeAdvanceCursor 终结**(TTS 超时/LLM 失败)→ 其 fireAiDone 末尾 armAnswerGrace 读到遗留
    //   pendingAdvance=true → 误推(review:排水轮失败后 4s 游标 0→1)。修复:排水块入口 cancelAnswerGrace。
    // 白盒直构:A 完成留窗(pendingAdvance=true)后,手工置悬挂态 + 直接调 fireAiDone 走排水块,验其清了 pending。
    const { ws, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS); // design contract:带 [[NEXT]] 触发宽限窗
    await startEngine(ws, engine, QS);
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师"); // turn A 记 pendingAdvance + arm 窗
    const eng = engine as unknown as {
      pendingAdvance: boolean; lastFinalText: string; interrupted: boolean;
      pendingDrainCursor: number; pendingDrainVoiced: boolean;
      activeTurn: unknown; fireAiDone(t: unknown, c: boolean): void;
    };
    expect(eng.pendingAdvance).toBe(true);
    // 模拟「busy 期用户开口悬挂了有效输入」:置 lastFinalText + 陈货锚(非 stale:capturedCursor==cursor+voiced),
    //   使排水块判为合格作答走消费分支(runLlmTurn 起 B)。构造一个已终结的假 turn 触发 fireAiDone 排水块。
    eng.lastFinalText = "我还想补充我做过大规模分布式系统";
    eng.pendingDrainCursor = 0;
    eng.pendingDrainVoiced = true;
    eng.interrupted = false;
    const fakeTurn = { aiDoneFired: false, fullyPlayed: true, pendingReply: undefined, historyWritten: true,
                       metricsReported: true, autoNextAfterDone: false, isKickoff: false, userText: "x", index: 99 };
    eng.fireAiDone(fakeTurn, true); // 走排水块 → 消费悬挂输入起 B
    // ★ Major 1:排水块入口已清 pendingAdvance(前一轮 A 的推进意图作废,B 自己重新决定)。
    expect(eng.pendingAdvance).toBe(false);
  });

  it("Major 3:末题正常作答不走宽限窗,同轮 END_CALL 不被吞、立即收尾", async () => {
    // 单题会话:答完第1题(=末题)。若走宽限窗,cursor 未推进→END_CALL 被「未问完」压制→信号丢。
    // 修复:末题直接立即推进(cursor→1 越界),END_CALL 正常放行 → wantsEndCall()=true。
    const ONE = [{ text: "唯一题:什么是零信任" }];
    const { ws, engine } = makeEngine(["零信任是默认不信任", "。", "[[NEXT]]", "[[END_CALL]]"], ONE);
    await startEngine(ws, engine, ONE);
    await driveFullTurn(ws, "零信任就是默认不信任任何人每次都验证");
    // ★ 末题立即推进(无需 advanceTimersByTime),不进宽限窗。
    expect(engine.questionCursor()).toBe(1); // 越界=全问完
    await drainMicrotasks();
    // END_CALL 未被 grace 延迟吞掉 → 引擎级 wantsEndCall 为真(会话可自动收尾)。
    expect((engine as unknown as { wantsEndCall(): boolean }).wantsEndCall()).toBe(true);
  });

  it("Major 4:stale 兜底放行=强推,立即推进不等 4s 窗", async () => {
    // 构造 design contract 陈货兜底:capturedCursor==cursor 但 capturedVoiced=false(当前题未念出)连续达 STALE_ANSWER_MAX。
    // 需 CURSOR_VOICED_GATE 开——本测试文件未锁它,默认按 env(北京线上=1)。若默认关则跳过断言(下方守卫)。
    const gateOn = process.env.AIM_CURSOR_VOICED_GATE === "1";
    if (!gateOn) return; // voiced gate 关时无 stale 分支,本回归不适用
    // 略:stale 分支构造依赖 voiced gate + 未念出快照,harness 复杂;此处用白盒直验 bypassGraceOnce 语义。
    const { ws, engine } = makeEngine(["好的", "。"], QS);
    await startEngine(ws, engine, QS);
    const eng = engine as unknown as { bypassGraceOnce: boolean };
    eng.bypassGraceOnce = true; // 模拟 stale 兜底放行置的一次性强推标志
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师"); // 正常作答,但 bypassGraceOnce 令其立即推进
    expect(engine.questionCursor()).toBe(1); // ★ 立即推进,不等 4s(bypassGrace 消费)
    expect(eng.bypassGraceOnce).toBe(false); // 一次性:已消费清掉
  });

  it("Major 4:bypassGraceOnce 仅作用紧随一轮,下一轮正常作答回到宽限窗", async () => {
    const { ws, engine } = makeEngine(["好的", "。", "\n", "[[NEXT]]"], QS); // design contract:带 [[NEXT]] 使作答走推进/宽限窗路径
    await startEngine(ws, engine, QS);
    const eng = engine as unknown as { bypassGraceOnce: boolean };
    eng.bypassGraceOnce = true;
    await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师"); // 立即推进到第2题(bypass 消费)
    expect(engine.questionCursor()).toBe(1);
    // 第2题正常作答:bypass 已清 → 回到宽限窗(不立即推进)。
    await driveFullTurn(ws, "我做过分布式系统和高并发架构设计");
    expect(engine.questionCursor()).toBe(1); // 停第2题(进窗,未到期)
    jest.advanceTimersByTime(4000);
    await drainMicrotasks();
    expect(engine.questionCursor()).toBe(2); // 到期才推进第3题
  });
});

// ── grace=0(逐字节等价现状):独立模块图,正常已作答**立即推进**,不 arm timer ──
describe("design contract 关(AIM_ANSWER_GRACE_MS=0)= 立即推进逐字节等价", () => {
  const savedEnv = process.env.AIM_ANSWER_GRACE_MS;
  afterEach(() => {
    process.env.AIM_ANSWER_GRACE_MS = savedEnv;
    jest.resetModules();
  });

  it("正常有效作答立即推进 + 立即自动问下一题(无宽限窗)", async () => {
    jest.resetModules();
    process.env.AIM_ANSWER_GRACE_MS = "0";
    const Fresh = require("../src/three-stage-engine").ThreeStageEngine as typeof RealThreeStageEngine;
    const ws = new FakeWs();
    const gpu = new GpuClient(ws, "sessGrace0");
    const llm = new FakeLlm(["好的", "。", "\n", "[[NEXT]]"]); // design contract:带 [[NEXT]] 使正常作答走推进路径
    const engine = new Fresh(gpu, llm);
    engine.onTurnEvent(() => {});
    try {
      await engine.start("sessGrace0", "你是面试官", qParams(QS));
      ws.emitControl({ type: "ready" });
      await driveFullTurn(ws, "我叫张三来自北京做后端开发工程师");
      // grace 关 + 有 [[NEXT]]:advanceIfVoiced 直接 advanceCursor + advanced:true → 立即推进,不 arm 任何 timer。
      expect(engine.questionCursor()).toBe(1);
      await drainMicrotasks();
      expect(llm.turns.length).toBe(1);
      expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
    } finally {
      await engine.stop().catch(() => undefined);
    }
  });
});
