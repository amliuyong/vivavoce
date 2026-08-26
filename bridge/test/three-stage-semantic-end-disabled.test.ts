const previousEnv = {
  answerGraceMs: process.env.AIM_ANSWER_GRACE_MS,
  maxFollowUps: process.env.AIM_QUESTION_MAX_FOLLOW_UPS,
  semanticEnd: process.env.AIM_SEMANTIC_END,
};
process.env.AIM_ANSWER_GRACE_MS = "0";
process.env.AIM_QUESTION_MAX_FOLLOW_UPS = "0";
process.env.AIM_SEMANTIC_END = "0";

import { LlmStreamer, LlmTurn } from "../src/bedrock-llm";
import { GpuClient, WsLike } from "../src/gpu-client";
import { ThreeStageEngine } from "../src/three-stage-engine";

const openEngines: ThreeStageEngine[] = [];

afterEach(async () => {
  for (const engine of openEngines.splice(0)) {
    await engine.stop().catch(() => undefined);
  }
});

afterAll(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("AIM_ANSWER_GRACE_MS", previousEnv.answerGraceMs);
  restore("AIM_QUESTION_MAX_FOLLOW_UPS", previousEnv.maxFollowUps);
  restore("AIM_SEMANTIC_END", previousEnv.semanticEnd);
});

class FakeWs implements WsLike {
  sent: Array<{ kind: "text" | "bin"; data: string | Buffer }> = [];
  private messageCb: (data: Buffer, isBinary: boolean) => void = () => {};

  send(data: string | Buffer): void {
    this.sent.push(typeof data === "string" ? { kind: "text", data } : { kind: "bin", data });
  }

  close(): void {}

  on(event: "message" | "open" | "close" | "error", cb: (...args: never[]) => void): void {
    if (event === "message") this.messageCb = cb as never;
  }

  emitControl(message: Record<string, unknown>): void {
    this.messageCb(Buffer.from(JSON.stringify(message), "utf8"), false);
  }

  textsSent(): Record<string, unknown>[] {
    return this.sent
      .filter((entry) => entry.kind === "text")
      .map((entry) => JSON.parse(entry.data as string));
  }
}

class SentinelLlm implements LlmStreamer {
  turns: LlmTurn[] = [];

  async *stream(turn: LlmTurn): AsyncIterable<string> {
    this.turns.push(turn);
    yield "好的。\n[[NEXT]][[END_CALL]]";
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!condition() && Date.now() - startedAt <= timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ThreeStageEngine AIM_SEMANTIC_END=0", () => {
  it("design contract:强制收口无条件吞掉 END_CALL 哨兵,模型原文不进入任何可见面", async () => {
    const ws = new FakeWs();
    const llm = new SentinelLlm();
    const engine = new ThreeStageEngine(new GpuClient(ws, "sess-semantic-off"), llm);
    openEngines.push(engine);
    const aiTexts: string[] = [];
    engine.onTurnEvent(() => {});
    engine.onLlmText((text) => aiTexts.push(text));
    await engine.start("sess-semantic-off", "你是面试官", {
      engineType: "three_stage",
      language: "zh-CN",
      questions: [{ text: "唯一题:自我介绍" }],
    });

    ws.emitControl({ type: "asr_final", text: "我叫张三,负责支付系统" });
    ws.emitControl({ type: "turn_end" });
    await waitUntil(() => ws.textsSent().some((message) => message.type === "tts_text"));

    const spoken = ws.textsSent()
      .filter((message) => message.type === "tts_text")
      .map((message) => String(message.text ?? ""))
      .join("");
    expect(spoken).toBe("好的,这个问题我们先到这里。");
    expect(spoken).not.toContain("[[END_CALL]]");
    expect(aiTexts.join("")).not.toContain("[[END_CALL]]");

    const ttsCount = ws.textsSent().filter((message) => message.type === "tts_text").length;
    for (let i = 0; i < ttsCount; i++) ws.emitControl({ type: "tts_done" });
    await waitUntil(() => engine.correctionContext().history.length >= 2);
    expect(engine.correctionContext().history.at(-1)?.content).not.toContain("[[END_CALL]]");
  });
});
