/**
 * design contract:旁路「判句子完整性」纯逻辑单测(prompt 构建 / 输出解析 / judgeEou fail-open / 超时 / 外部 abort)。
 * 不触网:注入 fake complete。与 transcript-fixer.test.ts 同构。
 *
 * L3 语义关键:判定 = complete/incomplete;任何失败/超时/非法输出 → **null(判不了 → 不纠偏)**,绝不误暂停。
 */
import {
  buildEouSystemPrompt,
  parseEouVerdict,
  judgeEou,
  eouVerdictTimeoutMs,
} from "../src/eou-verdict";
// design contract:默认值断言引用权威叶子导出(不写字面量)
import { BYPASS_LLM_TIMEOUT_DEFAULTS } from "../src/bypass-llm-config";

describe("buildEouSystemPrompt", () => {
  test("含硬约束:判完整性、不改写/不补全/不答题/不给参考答案", () => {
    const p = buildEouSystemPrompt({});
    expect(p).toContain("说完"); // 判「说完没」
    // 结构化输出契约:要求只回 complete / incomplete
    expect(p.toLowerCase()).toContain("complete");
    expect(p.toLowerCase()).toContain("incomplete");
    // 克制:不替用户答题、不补全
    expect(p).toContain("不");
  });

  test("带 history 与题干(题干仅供判断语境,不含参考答案)", () => {
    const p = buildEouSystemPrompt({
      history: [
        { role: "assistant", content: "请说说你对 Amazon Quick 的理解" },
        { role: "user", content: "它主要是" },
      ],
      question: "Amazon Quick 是什么",
    });
    expect(p).toContain("请说说你对 Amazon Quick 的理解");
    expect(p).toContain("Amazon Quick 是什么");
    // 空白 history 项被过滤
    const p2 = buildEouSystemPrompt({ history: [{ role: "user", content: "  " }] });
    expect(p2).not.toContain("最近对话");
  });
});

describe("parseEouVerdict", () => {
  test("complete/incomplete 大小写与首尾空白容错", () => {
    expect(parseEouVerdict("complete")).toBe("complete");
    expect(parseEouVerdict(" INCOMPLETE ")).toBe("incomplete");
    expect(parseEouVerdict("Complete。")).toBe("complete"); // 带标点
  });
  test("嵌在句子里也能抽出(模型没严格只回单词)", () => {
    expect(parseEouVerdict("我判断这句话是 incomplete 的")).toBe("incomplete");
    expect(parseEouVerdict("verdict: complete")).toBe("complete");
  });
  test("同时含两个词 → 取更保守的 incomplete(宁可判没说完,不冤开口)", () => {
    // incomplete 含 "complete" 子串,朴素 includes 会两个都命中;解析 MUST 优先 incomplete
    expect(parseEouVerdict("not complete, so incomplete")).toBe("incomplete");
  });
  test("空 / 无关键词 / 非法 → null(判不了,不纠偏)", () => {
    expect(parseEouVerdict("")).toBeNull();
    expect(parseEouVerdict("   ")).toBeNull();
    expect(parseEouVerdict("不知道")).toBeNull();
    expect(parseEouVerdict("yes")).toBeNull();
  });
});

describe("judgeEou", () => {
  const mantle = { token: "sk-x", host: "https://h" };

  test("判 incomplete → 返回 incomplete", async () => {
    const complete = jest.fn().mockResolvedValue("incomplete");
    const out = await judgeEou("它主要是", "anthropic.claude-haiku-4-5", mantle, {}, { complete });
    expect(out).toBe("incomplete");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test("判 complete → 返回 complete", async () => {
    const complete = jest.fn().mockResolvedValue("complete");
    const out = await judgeEou("它是一个数据分析工具", "m", mantle, {}, { complete });
    expect(out).toBe("complete");
  });

  test("空句 → 不调 LLM,返回 null(判不了)", async () => {
    const complete = jest.fn();
    const out = await judgeEou("   ", "m", mantle, {}, { complete });
    expect(out).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  test("LLM 报错 → fail-open null + onError(error)", async () => {
    const complete = jest.fn().mockRejectedValue(new Error("HTTP 429"));
    const onError = jest.fn();
    const out = await judgeEou("它主要是", "m", mantle, {}, { complete, onError });
    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("error:"));
  });

  test("输出非法(无关键词)→ fail-open null + onError(invalid_output)", async () => {
    const complete = jest.fn().mockResolvedValue("我觉得吧不好说");
    const onError = jest.fn();
    const out = await judgeEou("它主要是", "m", mantle, {}, { complete, onError });
    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledWith("invalid_output");
  });

  test("超时 → fail-open null + onError(timeout)", async () => {
    const complete = jest.fn(
      (_c: unknown, _r: unknown, signal: AbortSignal) =>
        new Promise<string>((_res, rej) => {
          signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const onError = jest.fn();
    const out = await judgeEou("它主要是", "m", mantle, {}, { complete, onError, timeoutMs: 20 });
    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledWith("timeout");
  });

  test("外部信号已 abort(会话结束)→ fail-open null + onError(session_ended)", async () => {
    const complete = jest.fn(
      (_c: unknown, _r: unknown, signal: AbortSignal) =>
        new Promise<string>((_res, rej) => {
          if (signal.aborted) rej(new Error("aborted"));
          signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const onError = jest.fn();
    const ext = new AbortController();
    ext.abort();
    const out = await judgeEou("它主要是", "m", mantle, {}, { complete, onError, externalSignal: ext.signal });
    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledWith("session_ended");
  });
});

describe("eouVerdictTimeoutMs", () => {
  const orig = process.env.AIM_EOU_VERDICT_TIMEOUT_MS;
  afterEach(() => {
    if (orig === undefined) delete process.env.AIM_EOU_VERDICT_TIMEOUT_MS;
    else process.env.AIM_EOU_VERDICT_TIMEOUT_MS = orig;
  });
  test("默认 6s(design contract:跨境标定值回落为默认;原 2000 在跨境几乎必超时)", () => {
    delete process.env.AIM_EOU_VERDICT_TIMEOUT_MS;
    // ★ 断言用叶子模块导出而非字面量 —— 否则将来改默认时本测试会假绿(design contract 要消灭的第二份副本)。
    expect(eouVerdictTimeoutMs()).toBe(BYPASS_LLM_TIMEOUT_DEFAULTS.eouVerdictMs);
    expect(BYPASS_LLM_TIMEOUT_DEFAULTS.eouVerdictMs).toBe(6000); // 值本身钉死一次(防默认被悄悄改回)
  });
  test("env 覆盖,夹在 [500ms,8s]", () => {
    process.env.AIM_EOU_VERDICT_TIMEOUT_MS = "1500";
    expect(eouVerdictTimeoutMs()).toBe(1500);
    process.env.AIM_EOU_VERDICT_TIMEOUT_MS = "6000"; // 跨境标定值
    expect(eouVerdictTimeoutMs()).toBe(6000);
    process.env.AIM_EOU_VERDICT_TIMEOUT_MS = "99999";
    expect(eouVerdictTimeoutMs()).toBe(8000); // 上限(部署验证标定放宽到 8s)
    process.env.AIM_EOU_VERDICT_TIMEOUT_MS = "10";
    expect(eouVerdictTimeoutMs()).toBe(500); // 下限
    process.env.AIM_EOU_VERDICT_TIMEOUT_MS = "bad";
    expect(eouVerdictTimeoutMs()).toBe(BYPASS_LLM_TIMEOUT_DEFAULTS.eouVerdictMs); // 非法回退默认(6000)
  });
});
