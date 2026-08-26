import { FallbackLlmStreamer, LlmFallbackEvent } from "../src/fallback-llm";
import { LlmStreamer, LlmTurn } from "../src/bedrock-llm";

/** 可编程假底层 streamer:按 modelId 决定行为(出 token / 抛错 / 首 token 前挂起)。 */
class ProgrammableLlm implements LlmStreamer {
  seenModels: string[] = [];
  constructor(
    private behavior: Record<
      string,
      { tokens?: string[]; throwBeforeToken?: Error; hangBeforeToken?: boolean; throwAfterToken?: Error }
    >,
  ) {}
  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    this.seenModels.push(turn.modelId);
    const b = this.behavior[turn.modelId] ?? { tokens: ["ok"] };
    if (b.hangBeforeToken) {
      // 首 token 前挂起,直到本次尝试的 signal(内部 attempt controller)abort。
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return; // abort 后优雅返回(空流)
    }
    if (b.throwBeforeToken) throw b.throwBeforeToken;
    for (const tok of b.tokens ?? []) {
      if (signal.aborted) return;
      yield tok;
    }
    if (b.throwAfterToken) throw b.throwAfterToken;
  }
}

const baseTurn: LlmTurn = { systemPrompt: "s", userText: "u", modelId: "primary" };

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const t of it) out.push(t);
  return out;
}

test("主模型正常出 token → 不切备,只见主模型", async () => {
  const inner = new ProgrammableLlm({ primary: { tokens: ["你", "好"] } });
  const fb = new FallbackLlmStreamer(inner, ["backup"]);
  const events: LlmFallbackEvent[] = [];
  fb.onFallback((e) => events.push(e));
  const out = await collect(fb.stream(baseTurn, new AbortController().signal));
  expect(out).toEqual(["你", "好"]);
  expect(inner.seenModels).toEqual(["primary"]);
  expect(events).toHaveLength(0);
});

test("主模型出首 token 前抛错 → 切备用重跑,备用出声 + 记 fallback 事件", async () => {
  const inner = new ProgrammableLlm({
    primary: { throwBeforeToken: new Error("HTTP 429") },
    backup: { tokens: ["备", "用"] },
  });
  const fb = new FallbackLlmStreamer(inner, ["backup"]);
  const events: LlmFallbackEvent[] = [];
  fb.onFallback((e) => events.push(e));
  const out = await collect(fb.stream(baseTurn, new AbortController().signal));
  expect(out).toEqual(["备", "用"]);
  expect(inner.seenModels).toEqual(["primary", "backup"]);
  expect(events).toEqual([{ fromModel: "primary", toModel: "backup", reason: "error" }]);
});

test("已出 token 后抛错 → MUST NOT 回退(抛给引擎降级)", async () => {
  const inner = new ProgrammableLlm({
    primary: { tokens: ["半"], throwAfterToken: new Error("流中断") },
    backup: { tokens: ["整句"] },
  });
  const fb = new FallbackLlmStreamer(inner, ["backup"]);
  const events: LlmFallbackEvent[] = [];
  fb.onFallback((e) => events.push(e));
  const gen = fb.stream(baseTurn, new AbortController().signal);
  const got: string[] = [];
  await expect(
    (async () => {
      for await (const t of gen) got.push(t);
    })(),
  ).rejects.toThrow("流中断");
  expect(got).toEqual(["半"]); // 已出的半句正常吐出
  expect(inner.seenModels).toEqual(["primary"]); // 从未尝试备用(不拼接)
  expect(events).toHaveLength(0);
});

test("attempt 超时(主模型首 token 前挂起)→ 切备,reason=attempt_timeout", async () => {
  jest.useFakeTimers();
  try {
    const inner = new ProgrammableLlm({
      primary: { hangBeforeToken: true },
      backup: { tokens: ["备用"] },
    });
    const fb = new FallbackLlmStreamer(inner, ["backup"], 100); // 100ms attempt 超时
    const events: LlmFallbackEvent[] = [];
    fb.onFallback((e) => events.push(e));
    const p = collect(fb.stream(baseTurn, new AbortController().signal));
    await jest.advanceTimersByTimeAsync(150);
    const out = await p;
    expect(out).toEqual(["备用"]);
    expect(events[0].reason).toBe("attempt_timeout");
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("caller abort(barge-in)→ 不切备,立即停", async () => {
  const inner = new ProgrammableLlm({ primary: { hangBeforeToken: true }, backup: { tokens: ["不该出现"] } });
  const fb = new FallbackLlmStreamer(inner, ["backup"], 0); // 禁 attempt 超时,只看 caller abort
  const events: LlmFallbackEvent[] = [];
  fb.onFallback((e) => events.push(e));
  const ac = new AbortController();
  const p = collect(fb.stream(baseTurn, ac.signal));
  ac.abort(); // 用户打断
  const out = await p;
  expect(out).toEqual([]); // 空流(优雅停),没切备
  expect(inner.seenModels).toEqual(["primary"]);
  expect(events).toHaveLength(0);
});

test("主备均失败 → 抛最后一次错误(引擎降级本轮)", async () => {
  const inner = new ProgrammableLlm({
    primary: { throwBeforeToken: new Error("主 500") },
    backup: { throwBeforeToken: new Error("备 500") },
  });
  const fb = new FallbackLlmStreamer(inner, ["backup"]);
  await expect(collect(fb.stream(baseTurn, new AbortController().signal))).rejects.toThrow("备 500");
  expect(inner.seenModels).toEqual(["primary", "backup"]);
});

test("备用序去重 + 剔除与主同名(不自我重试)", async () => {
  const inner = new ProgrammableLlm({
    primary: { throwBeforeToken: new Error("x") },
    b1: { tokens: ["b1"] },
  });
  const fb = new FallbackLlmStreamer(inner, ["primary", "b1", "b1"]); // 含主 + 重复
  const out = await collect(fb.stream(baseTurn, new AbortController().signal));
  expect(out).toEqual(["b1"]);
  expect(inner.seenModels).toEqual(["primary", "b1"]); // primary 只试一次,b1 去重
});
