/**
 * design contract:ASR 字幕修正纯逻辑单测(prompt 构建 / 输出校验 / correctTranscript fail-open / 超时 / 外部 abort)。
 * 不触网:注入 fake complete。
 */
import {
  buildFixerSystemPrompt,
  validateFixerOutput,
  correctTranscript,
  fixerTimeoutMs,
} from "../src/transcript-fixer";

describe("buildFixerSystemPrompt", () => {
  test("含硬约束:只纠错字、不改写/补全/解释/答题", () => {
    const p = buildFixerSystemPrompt({});
    expect(p).toContain("只纠错字"); // 克制约束
    expect(p).toContain("不补全没说完的话");
    expect(p).toContain("不替用户回答问题");
    expect(p).toContain("不要输出任何解释");
    expect(p).toContain("结合上下文"); // 引导据上下文判错字
  });

  test("带 history 与题干(题干仅供判断,不含参考答案)", () => {
    const p = buildFixerSystemPrompt({
      history: [
        { role: "assistant", content: "请计算 25 加 37 等于几" },
        { role: "user", content: "62" },
      ],
      question: "25+37=?",
    });
    expect(p).toContain("请计算 25 加 37 等于几");
    expect(p).toContain("25+37=?");
    // 空白 history 项被过滤
    const p2 = buildFixerSystemPrompt({ history: [{ role: "user", content: "  " }] });
    expect(p2).not.toContain("最近对话");
  });
});

describe("validateFixerOutput", () => {
  test("正常修正 → 返回去空白文本", () => {
    expect(validateFixerOutput("42", " 62 ")).toBe("62");
  });
  test("空输出 → null(不信,fail-open)", () => {
    expect(validateFixerOutput("42", "")).toBeNull();
    expect(validateFixerOutput("42", "   ")).toBeNull();
  });
  test("多行(疑似解释)→ null", () => {
    expect(validateFixerOutput("42", "62\n(这里把 42 改成 62)")).toBeNull();
  });
  test("明显超长(疑似改写/补全)→ null", () => {
    const original = "你好";
    const bloated = "你好呀我觉得你刚才说的这句话应该是这个意思吧对不对呢";
    expect(validateFixerOutput(original, bloated)).toBeNull();
  });
  test("等长/略短的正常修正 → 通过", () => {
    expect(validateFixerOutput("俩个苹果", "两个苹果")).toBe("两个苹果");
  });
});

describe("correctTranscript", () => {
  const mantle = { token: "sk-x", host: "https://h" };

  test("成功修正 → 返回修正版", async () => {
    const complete = jest.fn().mockResolvedValue("62");
    const out = await correctTranscript("42", "anthropic.claude-haiku-4-5", mantle, {}, { complete });
    expect(out).toBe("62");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test("空句 → 不调 LLM,原样返回", async () => {
    const complete = jest.fn();
    const out = await correctTranscript("   ", "m", mantle, {}, { complete });
    expect(out).toBe("   ");
    expect(complete).not.toHaveBeenCalled();
  });

  test("LLM 报错 → fail-open 原文 + onError(error)", async () => {
    const complete = jest.fn().mockRejectedValue(new Error("HTTP 429"));
    const onError = jest.fn();
    const out = await correctTranscript("42", "m", mantle, {}, { complete, onError });
    expect(out).toBe("42");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("error:"));
  });

  test("输出不可信(多行)→ fail-open 原文 + onError(invalid_output)", async () => {
    const complete = jest.fn().mockResolvedValue("62\n解释一堆");
    const onError = jest.fn();
    const out = await correctTranscript("42", "m", mantle, {}, { complete, onError });
    expect(out).toBe("42");
    expect(onError).toHaveBeenCalledWith("invalid_output");
  });

  test("超时 → fail-open 原文 + onError(timeout)", async () => {
    // complete 永不 resolve,直到被 abort;correctTranscript 用 timeoutMs 触发 abort。
    const complete = jest.fn(
      (_c: unknown, _r: unknown, signal: AbortSignal) =>
        new Promise<string>((_res, rej) => {
          signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const onError = jest.fn();
    const out = await correctTranscript("42", "m", mantle, {}, { complete, onError, timeoutMs: 20 });
    expect(out).toBe("42");
    expect(onError).toHaveBeenCalledWith("timeout");
  });

  test("外部信号已 abort(会话结束)→ fail-open + onError(session_ended)", async () => {
    const complete = jest.fn(
      (_c: unknown, _r: unknown, signal: AbortSignal) =>
        new Promise<string>((_res, rej) => {
          if (signal.aborted) rej(new Error("aborted"));
          signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const onError = jest.fn();
    const ext = new AbortController();
    ext.abort(); // 会话已结束
    const out = await correctTranscript("42", "m", mantle, {}, { complete, onError, externalSignal: ext.signal });
    expect(out).toBe("42");
    expect(onError).toHaveBeenCalledWith("session_ended");
  });
});

describe("fixerTimeoutMs", () => {
  const orig = process.env.AIM_TRANSCRIPT_FIXER_TIMEOUT_MS;
  afterEach(() => {
    if (orig === undefined) delete process.env.AIM_TRANSCRIPT_FIXER_TIMEOUT_MS;
    else process.env.AIM_TRANSCRIPT_FIXER_TIMEOUT_MS = orig;
  });
  test("默认 8s", () => {
    delete process.env.AIM_TRANSCRIPT_FIXER_TIMEOUT_MS;
    expect(fixerTimeoutMs()).toBe(8000);
  });
  test("env 覆盖,夹在 [1s,15s]", () => {
    process.env.AIM_TRANSCRIPT_FIXER_TIMEOUT_MS = "3000";
    expect(fixerTimeoutMs()).toBe(3000);
    process.env.AIM_TRANSCRIPT_FIXER_TIMEOUT_MS = "99999";
    expect(fixerTimeoutMs()).toBe(15000); // 上限
    process.env.AIM_TRANSCRIPT_FIXER_TIMEOUT_MS = "10";
    expect(fixerTimeoutMs()).toBe(1000); // 下限
    process.env.AIM_TRANSCRIPT_FIXER_TIMEOUT_MS = "bad";
    expect(fixerTimeoutMs()).toBe(8000); // 非法回退默认
  });
});
