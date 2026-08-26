/**
 * design contract:排水悬挂输入的时序资格 —— 跨题界/念出前陈货 MUST NOT 驱动游标推进。
 *
 * feature-flag 归并进 AIM_CURSOR_VOICED_GATE(与 design contract 同门);单独模块图,import 前设 env。
 *
 * 真机 bug(sess_example):AI 一轮合并「确认上一题追问 + 念出当前题 QK」;考生答上一题追问的续说被
 * design contract 忙时排水存 pendingDrain;该陈货在 QK 成为当前题之后被消费、误驱动 QK→QK+1,考生从未拿到答 QK 的
 * 窗口。判据 = 捕获时游标身份(capturedCursor)+ 当前题 voiced 快照(capturedCursorVoiced)双锚。
 *
 * 关键测试基建:排水只走 **llmBusy=true** 的 turn_end 分支(design contract)。ScriptedLlm 同步 yield 完即返回、
 * llmBusy 立刻 false → 走不到排水。故用 HoldableLlm:流挂在测试可控 gate 上,制造「轮 A 流未完(busy)时
 * 考生续说 → 排水捕获」。
 */
process.env.AIM_CURSOR_VOICED_GATE = "1";
process.env.AIM_STALE_ANSWER_MAX = "2";
// design contract:排水陈货时序资格验的是**即时**推进/不推进,锁 AIM_ANSWER_GRACE_MS=0(关宽限窗=逐字节等价现状),
//   否则默认 4000 宽限窗会把正常推进延迟,破坏同步断言。陈货强推兜底(staleAnswerStall)本就不经宽限窗(spec §7)。
process.env.AIM_ANSWER_GRACE_MS = "0";

import { GpuClient, WsLike } from "../src/gpu-client";
import { ThreeStageEngine } from "../src/three-stage-engine";
import { LlmStreamer, LlmTurn } from "../src/bedrock-llm";
import { EngineParams } from "../src/voice-engine";

const _engines: ThreeStageEngine[] = [];
afterEach(async () => {
  jest.clearAllTimers();
  jest.useRealTimers();
  for (const e of _engines.splice(0)) await e.stop().catch(() => undefined);
});

class FakeWs implements WsLike {
  sent: Array<{ kind: "text" | "bin"; data: string | Buffer }> = [];
  private msgCb: (d: Buffer, b: boolean) => void = () => {};
  send(d: string | Buffer): void {
    this.sent.push(typeof d === "string" ? { kind: "text", data: d } : { kind: "bin", data: d });
  }
  close(): void {}
  on(ev: "message" | "open" | "close" | "error", cb: (...a: never[]) => void): void {
    if (ev === "message") this.msgCb = cb as never;
  }
  emitControl(obj: Record<string, unknown>): void {
    this.msgCb(Buffer.from(JSON.stringify(obj), "utf-8"), false);
  }
  textsSent(): Record<string, unknown>[] {
    return this.sent.filter((s) => s.kind === "text").map((s) => JSON.parse(s.data as string));
  }
}

/** 可挂起的 LLM:第 holdTurnIdx 轮(0-based)yield 完脚本后挂在 gate 上,直到测试 release() 才结束流。
 *  其余轮同步 yield 完即结束。用于制造 llmBusy=true 的排水窗口。 */
class HoldableLlm implements LlmStreamer {
  turns: LlmTurn[] = [];
  private gates = new Map<number, { promise: Promise<void>; open: () => void; released: boolean }>();
  constructor(
    private scripts: string[][],
    holdTurnIdx: number | number[],
  ) {
    for (const idx of Array.isArray(holdTurnIdx) ? holdTurnIdx : [holdTurnIdx]) {
      let open = () => {};
      const promise = new Promise<void>((res) => (open = res));
      this.gates.set(idx, { promise, open, released: false });
    }
  }
  release(turnIdx?: number): void {
    const idx = turnIdx ?? [...this.gates.entries()].find(([, gate]) => !gate.released)?.[0];
    if (idx === undefined) return;
    const gate = this.gates.get(idx);
    if (!gate || gate.released) return;
    gate.released = true;
    gate.open();
  }
  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    const idx = this.turns.length;
    this.turns.push(turn);
    const script = this.scripts[idx] ?? ["嗯。"];
    for (const t of script) {
      if (signal.aborted) return;
      yield t;
    }
    const gate = this.gates.get(idx);
    if (gate) await gate.promise; // 挂住:流未完 → llmBusy 保持
  }
}

const QS = [
  { text: "光合作用的原料是什么" }, // Q1(与 Q2/Q3 无共享 token,避免 questionVoiced 串扰)
  { text: "细胞呼吸在哪个细胞器进行" }, // Q2
  { text: "DNA 由哪几种碱基组成" }, // Q3
];
const qParams = (questions: unknown[]): EngineParams => ({ engineType: "three_stage", language: "zh-CN", questions });

function makeEngine(llm: LlmStreamer, questions: unknown[]) {
  const ws = new FakeWs();
  const gpu = new GpuClient(ws, "sessDS");
  const engine = new ThreeStageEngine(gpu, llm);
  _engines.push(engine);
  return { ws, engine };
}

async function waitUntil(cond: () => boolean, tries = 80): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`waitUntil timed out after ${tries * 5}ms`);
}
function ttsCount(ws: FakeWs): number {
  return ws.textsSent().filter((m) => m.type === "tts_text").length;
}
const drainedTtsByWs = new WeakMap<FakeWs, number>();
function drainNewTts(ws: FakeWs): number {
  const drained = drainedTtsByWs.get(ws) ?? 0;
  const total = ttsCount(ws);
  for (let i = drained; i < total; i++) ws.emitControl({ type: "tts_done" });
  drainedTtsByWs.set(ws, total);
  return total - drained;
}
function prompts(llm: HoldableLlm): string[] {
  return llm.turns.map((t) => t.systemPrompt);
}

/** 驱一整轮正常完成(不挂):asr_final + turn_end → 等出句 → 补 tts_done。 */
async function fullTurn(ws: FakeWs, llm: HoldableLlm, userText: string): Promise<void> {
  const turnsBefore = llm.turns.length;
  const before = ttsCount(ws);
  ws.emitControl({ type: "asr_final", text: userText });
  ws.emitControl({ type: "turn_end" });
  await waitUntil(() => llm.turns.length > turnsBefore);
  await waitUntil(() => ttsCount(ws) > before);
  await pumpTts(ws, 6);
}

async function pumpTts(ws: FakeWs, rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    drainNewTts(ws);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * 通用驱动:kickoff seed Q1 → 轮1(hold,答 Q1 + 念 Q2)挂起期间考生续说(drainText)→ release + 补齐所有
 * tts_done。返回 { prompts, engine, ws, llm }。scripts[0]=kickoff 念 Q1,[1]=轮1 念 Q2(hold),[2..]=排水/后续轮。
 */
async function driveMergedThenDrain(opts: {
  scripts: string[][];
  q1Answer: string;
  drainText: string;
  holdTurnIdx?: number | number[];
}): Promise<{ ps: string[]; ws: FakeWs; llm: HoldableLlm; engine: ThreeStageEngine }> {
  const llm = new HoldableLlm(opts.scripts, opts.holdTurnIdx ?? 1);
  const { ws, engine } = makeEngine(llm, QS);
  engine.onTurnEvent(() => {});
  await engine.start("sessDS", "你是考官", qParams(QS));
  // 轮0:kickoff seed Q1
  engine.kickoff();
  await waitUntil(() => ttsCount(ws) > 0);
  drainNewTts(ws);
  await new Promise((r) => setTimeout(r, 40));
  // 轮1:答 Q1 → 起轮(念 Q2),流挂住
  const before1 = ttsCount(ws);
  ws.emitControl({ type: "asr_final", text: opts.q1Answer });
  ws.emitControl({ type: "turn_end" });
  await waitUntil(() => llm.turns.length >= 2);
  await waitUntil(() => ttsCount(ws) > before1);
  // 挂住期间续说 → busy 分支存 pendingDrain
  ws.emitControl({ type: "asr_final", text: opts.drainText });
  ws.emitControl({ type: "turn_end" });
  await new Promise((r) => setTimeout(r, 10));
  // release + 持续补齐所有 tts_done(轮1 fullyPlayed → 推进 + 排水 verify 轮起并出句 → 补它的 tts_done)
  llm.release();
  await pumpTts(ws);
  return { ps: prompts(llm), ws, llm, engine };
}

test("design contract:第二锚 capturedCursor==现cursor 但 capturedVoiced=false → 不驱动推进", async () => {
  const llm = new HoldableLlm(
    [
      ["现在开始。光合作用的原料是什么?"],
      ["好的。", "\n", "[[NEXT]]"], // design contract:答 Q1 轮带 [[NEXT]] 才推进 Q1→Q2(去 follow_up 后作答不再自动推进)
      ["细胞呼吸在哪个细胞器进行呢?"], // direct Q2 播放期捕获的陈货 verify 轮
    ],
    [],
  );
  const { ws, engine } = makeEngine(llm, QS);
  engine.onTurnEvent(() => {});
  await engine.start("sessDS", "你是考官", qParams(QS));

  engine.kickoff();
  await waitUntil(() => ttsCount(ws) > 0);
  drainNewTts(ws);
  await new Promise((r) => setTimeout(r, 40));

  const beforeAnswer = ttsCount(ws);
  ws.emitControl({ type: "asr_final", text: "原料是水和二氧化碳" });
  ws.emitControl({ type: "turn_end" });
  await waitUntil(() => llm.turns.length >= 2);
  await waitUntil(() => ttsCount(ws) > beforeAnswer);
  drainNewTts(ws); // 只确认 Q1 回应；同步触发 direct Q2，但它尚未 done。
  await waitUntil(() => ws.textsSent().some(
    (m) => m.type === "tts_text" && String(m.text ?? "").includes(QS[1].text),
  ));

  ws.emitControl({ type: "asr_final", text: "上一题还包括阳光" });
  ws.emitControl({ type: "turn_end" });
  drainNewTts(ws); // direct Q2 完成后消费 pending；捕获时 Q2 尚未 voiced。
  await waitUntil(() => llm.turns.length >= 3);
  await pumpTts(ws);

  const ps = prompts(llm);
  expect(ps.some((p) => p.includes("第 2/3 题"))).toBe(true);
  // Mutation: remove `capCursor === this.cursor && !this.pendingDrainVoiced` at three-stage-engine.ts:461 -> this stale drain becomes eligible and advances to Q3.
  expect(ps.some((p) => p.includes("第 3/3 题"))).toBe(false);
});

// design contract:同题内连续 2 次陈货达 staleAnswerStall 上限 → 兜底放行并报警(确定性复现)。
//  历史:此测试曾 SKIP,注释归因「UT 基建 timing 限制」。经调研(deployment validation)复核,真正卡点是**编排疏漏**而非
//    基建不可能——原写法在 `release(2)` 后只 `setTimeout(50)` + `waitUntil(turns>=4)`,**没泵 turn2 的 tts_done**,
//    turn2 不 fullyPlayed(ttsPending>0)→ fireAiDone 不触发 → drain1 不被消费 → turn3 不起 → waitUntil 空转超时。
//    HoldableLlm 的 gate 可挂任意久(不 release 就恒 busy),完全能构造「当前题未念出的持续 busy 轮」;把单 hold 轮
//    的「持续泵 tts_done」编排(driveMergedThenDrain)扩到两连 hold 轮(gate [2,3]、逐轮泵 tts_done 到下一轮起),
//    即确定性命中兜底分支。此测试遂从变异测试提升为确定性 UT(填补原「仅变异覆盖」的兜底分支缺口)。
//  两兜底关系(review 实证):不重叠、互补——voicedStall(042)管正常作答轮的「未念出」,staleAnswerStall(044)管
//    排水陈货轮的「跨题界/念出前」。本测试所有轮都不念 Q2(cursorVoiced 对 Q2 恒 false)+ 续说全走 busy 让位排水,
//    故走 staleAnswerStall 而非 voicedStall。
test("design contract:同一题内连续 2 次陈货达 staleAnswerStall 上限 → 兜底放行并报警", async () => {
  const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const llm = new HoldableLlm(
      [
        ["现在开始。光合作用的原料是什么?"], // 轮0 kickoff seed Q1
        ["好的。", "\n", "[[NEXT]]"], // 轮1 hold:完成后推进 Q1→Q2
        ["再想想。"], // 轮2 hold:drain1 stale verify,不念 Q2
        ["明白了。细胞呼吸在哪个细胞器进行?", "\n", "[[NEXT]]"], // drain2 达上限后的 eligible 轮
      ],
      [1, 2],
    );
    const { ws, engine } = makeEngine(llm, QS);
    engine.onTurnEvent(() => {});
    await engine.start("sessDS", "你是考官", qParams(QS));

    engine.kickoff();
    await waitUntil(() => ttsCount(ws) > 0);
    drainNewTts(ws);
    await new Promise((r) => setTimeout(r, 40));

    const beforeQ1Answer = ttsCount(ws);
    ws.emitControl({ type: "asr_final", text: "原料是阳光和水" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => llm.turns.length >= 2);
    await waitUntil(() => ttsCount(ws) > beforeQ1Answer);
    // Q1 回应仍 hold 时捕获 drain1；完成推进后 capturedCursor<Q2，成为第一条陈货。
    ws.emitControl({ type: "asr_final", text: "还有二氧化碳" }); // drain1
    ws.emitControl({ type: "turn_end" });
    llm.release(1);
    await pumpTts(ws, 6);
    await waitUntil(() => llm.turns.length >= 3); // drain1 verify 已起并 hold

    // verify 轮未念 Q2，hold 期间捕获 drain2：capturedCursor==Q2 且 capturedVoiced=false。
    ws.emitControl({ type: "asr_final", text: "对了还有阳光" }); // drain2
    ws.emitControl({ type: "turn_end" });
    llm.release(2);
    await pumpTts(ws, 16);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("design contract:排水陈货连续 2 轮不推进达上限"));
    expect(ws.textsSent().some(
      (m) => m.type === "tts_text" && String(m.text ?? "").includes(QS[2].text),
    )).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }
});



test("design contract:真实排水答案 capturedCursor==现cursor 且 capturedVoiced=true → 不被误判陈货", async () => {
  const llm = new HoldableLlm(
    [
      ["现在开始。光合作用的原料是什么?"],
      ["好的。", "\n", "[[NEXT]]"], // design contract:答 Q1 轮带 [[NEXT]] 推进 Q1→Q2
      ["请具体说说细胞呼吸在哪个细胞器进行。"],
      ["回答到位。", "\n", "[[NEXT]]"], // design contract:真实答 Q2 后确认轮带 [[NEXT]] 推进 Q2→Q3
    ],
    2,
  );
  const { ws, engine } = makeEngine(llm, QS);
  engine.onTurnEvent(() => {});
  await engine.start("sessDS", "你是考官", qParams(QS));

  engine.kickoff();
  await waitUntil(() => ttsCount(ws) > 0);
  drainNewTts(ws);
  await new Promise((r) => setTimeout(r, 40));

  await fullTurn(ws, llm, "原料是水和二氧化碳");
  await waitUntil(() => ws.textsSent().some(
    (m) => m.type === "tts_text" && String(m.text ?? "").includes(QS[1].text),
  ));

  const before = ttsCount(ws);
  ws.emitControl({ type: "asr_final", text: "嗯" });
  ws.emitControl({ type: "turn_end" });
  await waitUntil(() => llm.turns.length >= 3);
  await waitUntil(() => ttsCount(ws) > before);

  ws.emitControl({ type: "asr_final", text: "在线粒体进行" });
  ws.emitControl({ type: "turn_end" });

  llm.release(2);
  await pumpTts(ws);

  expect(llm.turns.some((turn) => turn.userText === "在线粒体进行")).toBe(true);
  expect(ws.textsSent().some(
    (m) => m.type === "tts_text" && String(m.text ?? "").includes(QS[2].text),
  )).toBe(true);
});

test("design contract:陈货 verify 轮不永久锁住游标,下一轮真实作答仍可推进", async () => {
  const { ps: stalePs, ws, llm } = await driveMergedThenDrain({
    scripts: [
      ["现在开始。光合作用的原料是什么?"],
      ["好,细胞呼吸在哪个细胞器进行?", "\n", "[[NEXT]]"], // design contract:轮1 答 Q1 带 [[NEXT]] 推进 Q1→Q2
      ["细胞呼吸在哪个细胞器进行呢?"],
      ["回答到位。", "\n", "[[NEXT]]"], // design contract:下一轮真实答 Q2 后确认带 [[NEXT]] 推进 Q2→Q3
      ["DNA 由哪几种碱基组成?"],
    ],
    q1Answer: "原料是阳光和水",
    drainText: "还有二氧化碳",
  });

  expect(stalePs.some((p) => p.includes("第 2/3 题"))).toBe(true);
  expect(stalePs.some((p) => p.includes("第 3/3 题"))).toBe(false);

  await fullTurn(ws, llm, "在线粒体进行");
  await waitUntil(() => ws.textsSent().some(
    (m) => m.type === "tts_text" && String(m.text ?? "").includes(QS[2].text),
  ));
  expect(ws.textsSent().some(
    (m) => m.type === "tts_text" && String(m.text ?? "").includes(QS[2].text),
  )).toBe(true);
});

test("★design contract:排水陈货 capturedCursor<现cursor → 不驱动推进(考生保住答当前题窗口)", async () => {
  // 编排:
  //  轮0 = 开场 kickoff,念出 Q1 题干("光合作用的原料")→ seed cursorVoiced(Q1)。
  //  轮1(holdTurn)= 考生答 Q1 后的轮,AI 念出 Q2 题干;此轮 LLM 流**挂住**(busy)。
  //    挂住期间考生续说("阳光和二氧化碳"= 补答 Q1)→ busy 分支存 pendingDrain(capturedCursor=Q1=0)。
  //    release + 补 tts_done → 轮1 fullyPlayed → 推进 Q1→Q2(Q1 已 voiced + 已答)→ 排水消费 pendingDrain。
  //    capturedCursor(0) < 现 cursor(1)→ 陈货 → verify 轮回应但 **不推进到 Q3**。
  const llm = new HoldableLlm(
    [
      ["现在开始。光合作用的原料是什么?"], // 轮0 kickoff:念 Q1 → seed
      ["好,细胞呼吸在哪个细胞器进行?", "\n", "[[NEXT]]"], // 轮1 hold:念 Q2(不含 Q1 token)+[[NEXT]] 推进 Q1→Q2(design contract)
      // 轮2 = 排水陈货 verify 轮:**也念出 Q2 题干** → Q2 cursorVoiced 会置 true。
      //   若无 044,042 gate 会因 cursorVoiced=true 放行 → 陈货推进 Q2→Q3(bug)。只有 044 时序门能挡住。
      ["细胞呼吸在哪个细胞器进行呢?"],
      ["还有别的吗?"], // 轮3 备用
    ],
    1, // 轮1 挂住
  );
  const { ws, engine } = makeEngine(llm, QS);
  engine.onTurnEvent(() => {});
  await engine.start("sessDS", "你是考官", qParams(QS));

  // 轮0:开场 kickoff seed Q1
  engine.kickoff();
  await waitUntil(() => ttsCount(ws) > 0);
  drainNewTts(ws);
  await new Promise((r) => setTimeout(r, 40));

  // 轮1:考生答 Q1 → 起轮(念 Q2),流挂住(busy)
  const before1 = ttsCount(ws);
  ws.emitControl({ type: "asr_final", text: "原料是阳光和水" }); // 答 Q1
  ws.emitControl({ type: "turn_end" });
  await waitUntil(() => llm.turns.length >= 2); // 轮1 已起
  await waitUntil(() => ttsCount(ws) > before1); // 轮1 已出句

  // 挂住期间考生续说(补答 Q1)→ busy 分支存 pendingDrain(capturedCursor=Q1=0)
  ws.emitControl({ type: "asr_final", text: "还有二氧化碳" });
  ws.emitControl({ type: "turn_end" });
  await new Promise((r) => setTimeout(r, 10));

  // release 轮1 流 + 持续补齐所有新出句的 tts_done(轮1 fullyPlayed 推进 Q1→Q2 → 排水 verify 轮起并出句
  //   → 也要补它的 tts_done 让它 fullyPlayed 触发 maybeAdvanceCursor;否则排水轮卡半途,"没推进"是假象非 044)。
  llm.release();
  await pumpTts(ws);

  // ★ 断言:游标推进到 Q2(第 2/3 题)正确,但陈货 MUST NOT 把它推到 Q3(第 3/3 题)。
  const ps = prompts(llm);
  expect(ps.some((p) => p.includes("第 2/3 题"))).toBe(true); // Q1→Q2 正常
  expect(ps.some((p) => p.includes("第 3/3 题"))).toBe(false); // ★ 陈货不推进到 Q3
});

// ── 场景 3(Blocker 5 回归):陈货文本含 decline/farewell → 门在 maybeAdvanceCursor 顶部拦,不被直推分支绕过 ──
test("design contract:陈货文本含拒答意图 → 顶部门拦截,不被 decline 直推分支绕过(Blocker 5)", async () => {
  // 排水陈货 verify 轮的 userText = "不会跳过这题"(命中 DECLINE_RE);若门只加在 advanceIfVoiced,decline 分支
  //   会在其之前直接 advanceCursor 推进 → 绕过。门在顶部则先拦。用 drainText 触发陈货 + 含拒答词。
  const { ps } = await driveMergedThenDrain({
    scripts: [
      ["现在开始。光合作用的原料是什么?"], // kickoff seed Q1
      ["好,细胞呼吸在哪个细胞器进行?", "\n[[NEXT]]"], // 轮1 hold 念 Q2并明确推进 Q1
      ["细胞呼吸在哪个细胞器进行呢?"], // 轮2 排水陈货 verify(念 Q2,但 eligible=false)
      ["还有吗?"],
    ],
    q1Answer: "原料是阳光和水",
    drainText: "不会跳过这题", // 含 DECLINE_RE:若绕过顶部门会经 decline 直推
  });
  expect(ps.some((p) => p.includes("第 2/3 题"))).toBe(true);
  expect(ps.some((p) => p.includes("第 3/3 题"))).toBe(false); // ★ decline 陈货不被直推分支绕过
});

// ── 场景 7(回归):gate 关 → 逐字节等价现状(排水即推进)──
// 注:本文件模块级已设 AIM_CURSOR_VOICED_GATE=1,gate 关的等价性由其余 gate-off 测试套件(默认关)整体覆盖;
//    044 逻辑 isStale 判定被 `CURSOR_VOICED_GATE &&` 短路,门关时 pendingDrain 快照记但不读 → 零影响。
