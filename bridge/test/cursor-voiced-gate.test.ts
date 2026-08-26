/**
 * design contract:出题游标推进闭环——「AI 已把当前题独立念出」才允许推进(信号① F1)。
 *
 * feature-flag 模块级 → 本文件 import 前设 env(单独文件 = 单独模块图,与其余引擎测试的默认关隔离):
 *   AIM_CURSOR_VOICED_GATE=1 开启闭环。关闭时(其余测试)= 现状开环推进,逐字节等价。
 *
 * 地面真值来自部署回归:AI 揉合/吞题时输出文本不含当前题干关键词 → 不推进(不吞题);
 * 正常念出题干 → 推进。用 FakeLlm 的 token 序列模拟「AI 是否把当前题念出来」。
 */
process.env.AIM_CURSOR_VOICED_GATE = "1";
// design contract:本文件验闭环推进的**即时**判定,锁 AIM_ANSWER_GRACE_MS=0(关宽限窗=逐字节等价现状),
//   否则默认 4000 宽限窗会把「已作答→推进」延迟,破坏这些同步跨轮断言。宽限窗开由 three-stage-answer-grace.test.ts 验。
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

/** 假 LLM:每轮从队列取一组 token 作为该轮 AI 输出(模拟「这轮 AI 到底念了什么」)。 */
class ScriptedLlm implements LlmStreamer {
  turns: LlmTurn[] = [];
  constructor(private scripts: string[][]) {}
  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    this.turns.push(turn);
    const script = this.scripts[this.turns.length - 1] ?? ["嗯。"];
    for (const t of script) {
      if (signal.aborted) return;
      yield t;
    }
  }
}

const QS = [
  { text: "Amazon Quick Sight 这个功能是做什么的" },
  { text: "什么是 Space 空间它的作用是什么" },
  { text: "动作连接器可以基于哪两种开放标准" },
];
const qParams = (questions: unknown[]): EngineParams => ({ engineType: "three_stage", language: "zh-CN", questions });

function makeEngine(scripts: string[][], questions: unknown[]) {
  const ws = new FakeWs();
  const gpu = new GpuClient(ws, "sessVG");
  const llm = new ScriptedLlm(scripts);
  const engine = new ThreeStageEngine(gpu, llm);
  _engines.push(engine);
  return { ws, llm, engine };
}

async function waitUntil(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

/** 驱一整轮正常完成:asr_final + turn_end → 等本轮 LLM 起并出句 → 补 tts_done 触发 maybeFireAiDone(→推进/auto-ask)。
 *  用固定 settle(而非 waitUntil(true,n))给异步 auto-ask kickoff 轮起的时间——它在 fireAiDone 后异步发起。 */
async function fullTurn(ws: FakeWs, llm: ScriptedLlm, userText: string): Promise<void> {
  const turnsBefore = llm.turns.length;
  const before = ws.textsSent().filter((m) => m.type === "tts_text").length;
  ws.emitControl({ type: "asr_final", text: userText });
  ws.emitControl({ type: "turn_end" });
  await waitUntil(() => llm.turns.length > turnsBefore);
  await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > before);
  const after = ws.textsSent().filter((m) => m.type === "tts_text").length;
  for (let i = before; i < after; i++) ws.emitControl({ type: "tts_done" });
  await new Promise((r) => setTimeout(r, 40)); // settle:让 fireAiDone → auto-ask kickoff 轮(异步)起
}

test("★F1:AI 输出未念出当前题(揉合/吞题)+ 考生已作答 → 不推进、不触发自动问下一题", async () => {
  // 第1题轮 AI 输出「好的」(不含第1题干关键词)→ 信号①未置位 → 即便考生作答,不推进 → autoNextAfterDone=false
  //   → 不会直接下发下一题。故全程仅 1 个 LLM 轮,且没有下一题 TTS。
  const { ws, llm, engine } = makeEngine([["好的,", "我们继续。"]], QS);
  engine.onTurnEvent(() => {});
  await engine.start("sessVG", "你是考官", qParams(QS));
  await fullTurn(ws, llm, "我觉得是数据可视化和商业智能"); // 有效作答但 AI 没念出题
  await waitUntil(() => false, 6); // 给潜在的 auto-ask 一点时间(不该发生)
  expect(llm.turns.length).toBe(1); // ★ 未念出 → 不推进 → 无 auto-ask,仍停在第1题
  expect(llm.turns[0].systemPrompt).toContain("第 1/3 题");
});

test("F1:AI 念出了当前题(输出含题干关键词)+ 考生作答 → 推进并直接下发第2题", async () => {
  // 第1题轮 AI 输出含「Amazon Quick Sight」关键词 → 信号①置位 → 作答后推进 → 服务端直接下发第2题。
  // design contract:作答后须 [[NEXT]] 才进推进路径(advanceIfVoiced 的 voiced 门在其后)→ 念题轮脚本末尾带 [[NEXT]]。
  const { ws, llm, engine } = makeEngine(
    [["好,Amazon Quick Sight ", "这个功能是做什么的?", "\n", "[[NEXT]]"], ["好的,", "什么是 Space 空间?"]],
    QS,
  );
  engine.onTurnEvent(() => {});
  await engine.start("sessVG", "你是考官", qParams(QS));
  await fullTurn(ws, llm, "提供交互式数据可视化和商业智能"); // 念出了 + 作答 + [[NEXT]] → 推进
  expect(llm.turns).toHaveLength(1);
  expect(engine.questionCursor()).toBe(1);
  expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
});

test("F3:开场 kickoff 念出 Q1 → seed cursorVoiced → 第1题作答后正常推进(Q1→Q2 不被误锁)", async () => {
  // 开场 kickoff 轮 AI 念出含 Q1 关键词的开场白 → cursorVoiced seed;随后考生答 Q1 → 推进(非 kickoff 作答轮)。
  // design contract:Q1 作答轮(第2个脚本)带 [[NEXT]] 触发推进(voiced 已由 kickoff seed)。
  const { ws, llm, engine } = makeEngine(
    [["你好,我们开始。Amazon Quick Sight ", "这个功能是做什么的?"], ["嗯。", "\n", "[[NEXT]]"], ["好,", "什么是 Space 空间?"]],
    QS,
  );
  engine.onTurnEvent(() => {});
  await engine.start("sessVG", "你是考官", qParams(QS));
  engine.kickoff(); // 开场 kickoff 念 Q1(design contract)
  await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > 0);
  const k = ws.textsSent().filter((m) => m.type === "tts_text").length;
  for (let i = 0; i < k; i++) ws.emitControl({ type: "tts_done" }); // kickoff 轮播完
  await new Promise((r) => setTimeout(r, 40));
  await fullTurn(ws, llm, "提供交互式数据可视化和商业智能"); // Q1 作答 → 因 kickoff 已 seed → 推进
  expect(engine.questionCursor()).toBe(1);
  expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
});

test("direct auto-next 完整播出极短题干后也置 cursorVoiced,作答可继续推进", async () => {
  const shortQuestions = [
    { text: "请先介绍 Amazon Quick 的主要用途" },
    { text: "1+1?" },
    { text: "请说明 OpenAPI 的主要作用" },
  ];
  const { ws, llm, engine } = makeEngine(
    [
      [`${shortQuestions[0].text}。好。\n[[NEXT]]`],
      ["答对了。\n[[NEXT]]"],
    ],
    shortQuestions,
  );
  engine.onTurnEvent(() => {});
  await engine.start("sessVG", "你是考官", qParams(shortQuestions));

  await fullTurn(ws, llm, "它用于自然语言问答和工作流");
  await waitUntil(() =>
    ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${shortQuestions[1].text}`));
  ws.emitControl({ type: "tts_done" });
  await new Promise((r) => setTimeout(r, 20));
  expect((engine as unknown as { cursorVoiced: boolean }).cursorVoiced).toBe(true);

  await fullTurn(ws, llm, "2");

  expect(engine.questionCursor()).toBe(2);
  expect(ws.textsSent().some((message) =>
    message.type === "tts_text" && message.text === `接下来，${shortQuestions[2].text}`)).toBe(true);
});

test("已念题的回答轮即使 LLM 违约重念,题干也不进 TTS/transcript/history且仍正常推进", async () => {
  const repeatQs = [
    { text: "动作连接器（Action connectors）可以基于哪两种开放标准来创建" },
    { text: "Amazon Quick Research 这个功能是做什么的" },
  ];
  const q1 = repeatQs[0].text;
  const retainedReply = "你提到 OpenAPI 和 MCP 两种开放标准,关键点已覆盖。";
  const { ws, llm, engine } = makeEngine(
    [
      [`你好,我们开始。${q1}?`],
      [`${retainedReply}我们继续下一个问题。${q1}?\n[[NEXT]]`],
      [`${repeatQs[1].text}?`],
    ],
    repeatQs,
  );
  const aiTexts: string[] = [];
  engine.onTurnEvent(() => {});
  engine.onLlmText((text) => aiTexts.push(text));
  await engine.start("sessVG", "你是考官", qParams(repeatQs));

  engine.kickoff();
  await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
  const kickoffTtsCount = ws.textsSent().filter((m) => m.type === "tts_text").length;
  for (let i = 0; i < kickoffTtsCount; i++) ws.emitControl({ type: "tts_done" });
  await waitUntil(() => aiTexts.length >= 1);

  await fullTurn(ws, llm, "它基于 OpenAPI 规范和 MCP 服务器创建");
  await waitUntil(() => llm.turns.some((t) => t.systemPrompt.includes("第 2/2 题")));

  const spoken = ws.textsSent().filter((m) => m.type === "tts_text")
    .map((m) => String(m.text ?? "")).join("");
  expect(spoken.split(q1)).toHaveLength(2); // kickoff 仅出现一次;回答轮的违约重念被硬门丢弃
  expect(spoken).toContain(retainedReply);
  expect(aiTexts[1]).toContain(retainedReply);
  expect(aiTexts[1]).not.toContain(q1);
  const history = engine.correctionContext().history.map((m) => m.content).join("\n");
  expect(history).toContain(retainedReply);
  expect(history).not.toContain(q1);
  const q2Turn = llm.turns.find((t) => t.systemPrompt.includes("第 2/2 题"));
  expect(JSON.stringify(q2Turn?.history ?? [])).not.toContain(q1);
  expect(engine.questionCursor()).toBe(1);
});

test("已念题后的正常回复仅提到题目主题 → 整句保留,不按局部片段误删", async () => {
  const questions = [
    { text: "Amazon Quick Research 这个功能是做什么的" },
    { text: "用户主要通过什么方式与 Amazon Quick 交互" },
  ];
  const reply = "好的，我们继续讨论 Amazon Quick Research。";
  const { ws, llm, engine } = makeEngine(
    [
      [`你好，我们开始。${questions[0].text}？`],
      [reply],
    ],
    questions,
  );
  engine.onTurnEvent(() => {});
  await engine.start("sessVG", "你是考官", qParams(questions));

  engine.kickoff();
  await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
  const kickoffTtsCount = ws.textsSent().filter((m) => m.type === "tts_text").length;
  for (let i = 0; i < kickoffTtsCount; i++) ws.emitControl({ type: "tts_done" });
  await new Promise((r) => setTimeout(r, 20));

  const beforeReply = ws.textsSent().filter((m) => m.type === "tts_text").length;
  ws.emitControl({ type: "asr_final", text: "它用于跨 Web 和内部数据开展深入研究" });
  ws.emitControl({ type: "turn_end" });
  await waitUntil(() => llm.turns.length === 2);
  await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > beforeReply);

  expect(ws.textsSent().filter((m) => m.type === "tts_text").slice(beforeReply)
    .map((m) => String(m.text ?? "")).join("")).toContain(reply);
});

test("完整题干嵌在正常回复同一句时 → 只删题干跨度,保留句首确认和句尾过渡", async () => {
  const questions = [
    { text: "动作连接器可以基于哪两种开放标准来创建" },
    { text: "Amazon Quick Research 这个功能是做什么的" },
  ];
  const replyPrefix = "好的，我们先确认：";
  const replySuffix = "，然后进入下一题。";
  const { ws, llm, engine } = makeEngine(
    [
      [`你好，我们开始。${questions[0].text}？`],
      [`${replyPrefix}${questions[0].text}${replySuffix}\n[[NEXT]]`],
    ],
    questions,
  );
  engine.onTurnEvent(() => {});
  await engine.start("sessVG", "你是考官", qParams(questions));

  engine.kickoff();
  await waitUntil(() => ws.textsSent().some((m) => m.type === "tts_text"));
  const kickoffTtsCount = ws.textsSent().filter((m) => m.type === "tts_text").length;
  for (let i = 0; i < kickoffTtsCount; i++) ws.emitControl({ type: "tts_done" });
  await new Promise((r) => setTimeout(r, 20));

  const beforeReply = ws.textsSent().filter((m) => m.type === "tts_text").length;
  ws.emitControl({ type: "asr_final", text: "它们是 OpenAPI 和 MCP" });
  ws.emitControl({ type: "turn_end" });
  await waitUntil(() => llm.turns.length === 2);
  await waitUntil(() => ws.textsSent().filter((m) => m.type === "tts_text").length > beforeReply);

  const spoken = ws.textsSent().filter((m) => m.type === "tts_text").slice(beforeReply)
    .map((m) => String(m.text ?? "")).join("");
  expect(spoken).toContain(replyPrefix);
  expect(spoken).toContain(replySuffix);
  expect(spoken).not.toContain(questions[0].text);
});

test("只命中 questionVoiced 关键词但未逐字念完整题干,后续轮仍必须正式出题", async () => {
  const { ws, llm, engine } = makeEngine(
    [
      ["Amazon Quick Sight 能帮助用户分析数据。"],
      [`现在请回答:${QS[0].text}?`],
    ],
    QS,
  );
  engine.onTurnEvent(() => {});
  await engine.start("sessVG", "你是考官", qParams(QS));

  await fullTurn(ws, llm, "我准备好了");
  await fullTurn(ws, llm, "它可以做数据分析");

  expect(llm.turns[1].systemPrompt).toContain("问题本身要原文逐字念出");
  expect(llm.turns[1].systemPrompt).not.toContain("当前题已经完整问过");
  const spoken = ws.textsSent().filter((m) => m.type === "tts_text")
    .map((m) => String(m.text ?? "")).join("");
  expect(spoken).toContain(QS[0].text);
});

test("F5:同题连续 2 轮已作答但 AI 都没念出 → 兜底强制推进(不永久卡题)", async () => {
  // 每轮 AI 都只说「好的」(从不念出题干)+ 考生每轮都作答 → 第1轮 stall=1 不推进,第2轮 stall=2 达上限兜底推进。
  // design contract:作答须 [[NEXT]] 才进 advanceIfVoiced 的 voiced 门 → 两轮作答脚本都带 [[NEXT]];AI 从不念题干 → voicedStall 累加兜底。
  const { ws, llm, engine } = makeEngine([["好的。", "\n", "[[NEXT]]"], ["嗯。", "\n", "[[NEXT]]"], ["继续。"]], QS);
  engine.onTurnEvent(() => {});
  await engine.start("sessVG", "你是考官", qParams(QS));
  await fullTurn(ws, llm, "我觉得是数据可视化"); // stall 1/2:不推进
  await fullTurn(ws, llm, "还有商业智能仪表板"); // stall 2/2:兜底强制推进
  expect(engine.questionCursor()).toBe(1);
  expect(ws.textsSent().some((message) => message.type === "tts_text" && message.text === `接下来，${QS[1].text}`)).toBe(true);
});

test("design contract:强制收口是强推路径,即使 voiced-gate 开且题干从未念出也立即推进", async () => {
  const { ws, llm, engine } = makeEngine(
    [
      ["能再展开一下吗?"],
      ["还能具体一点吗?"],
      ["你再想想是什么?"],
      ["第二题。"],
    ],
    QS,
  );
  engine.onTurnEvent(() => {});
  await engine.start("sessVG", "你是考官", qParams(QS));
  await fullTurn(ws, llm, "我认为它是一个数据产品");
  await fullTurn(ws, llm, "它可以帮助企业分析数据");
  expect(engine.questionCursor()).toBe(0);
  await fullTurn(ws, llm, "它还能生成一些可视化报表");
  expect(llm.turns[2].systemPrompt).toContain("追问机会已用完");
  expect(engine.questionCursor()).toBe(1);
});
