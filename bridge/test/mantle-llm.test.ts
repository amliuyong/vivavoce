/**
 * design contract:MantleStreamer 单测。假 fetch 产 SSE → 断言 token 序列 / 路径分流 / abort 停流 / 无 token fail-fast。
 * 跨语言防漂移(review):SSE fixture 与 Python backend/tests/test_mantle_llm.py 共用同一份
 *   期望(同 delta 序列 → 同解析 token),两侧独立验证同契约。
 */
import { MantleStreamer, MantleConfig, FetchLike, mantlePathFor, mantleCompleteOnce } from "../src/mantle-llm";
import { LlmTurn } from "../src/bedrock-llm";

// ── 跨语言共享 fixture(与 Python 对齐) ──
// OpenAI 路径:choices[].delta.content 增量。
const OPENAI_SSE = [
  'data: {"choices":[{"delta":{"content":"你好"}}]}',
  'data: {"choices":[{"delta":{"content":",很"}}]}',
  'data: {"choices":[{"delta":{"content":"高兴"}}]}',
  "data: [DONE]",
].join("\n\n") + "\n\n";
// Anthropic 路径:content_block_delta.text_delta。
const ANTHROPIC_SSE = [
  'data: {"type":"message_start"}',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"您好"}}',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"呀"}}',
  'data: {"type":"message_stop"}',
].join("\n\n") + "\n\n";
const EXPECTED_OPENAI = ["你好", ",很", "高兴"];
const EXPECTED_ANTHROPIC = ["您好", "呀"];

/** 把一段文本切成多个 chunk 的可迭代流(模拟网络分片),abort 时提前停。 */
function sseBody(text: string, chunkSize = 7): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        yield bytes.slice(i, i + chunkSize);
      }
    },
  };
}

function fakeFetch(sse: string, status = 200): { fetch: FetchLike; calls: Array<{ url: string; init: Record<string, unknown> }> } {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      body: sseBody(sse),
      text: async () => sse,
    };
  };
  return { fetch, calls };
}

const CFG: MantleConfig = { token: "sk-test-token", host: "https://mantle.test" };

function turn(modelId: string): LlmTurn {
  return { systemPrompt: "你是助手", userText: "在吗", modelId, history: [] };
}

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const t of gen) out.push(t);
  return out;
}

describe("mantlePathFor", () => {
  it("anthropic 前缀 → anthropic 路径", () => {
    expect(mantlePathFor("anthropic.claude-haiku-4-5")).toBe("anthropic");
  });
  it("跨区 inference profile 前缀(us./eu./apac.)的 anthropic → 仍走 anthropic 路径", () => {
    // Claude 一律经跨区 profile,真实 id 形如 us.anthropic.claude-*;须剥前缀再判,
    // 否则被判 openai → mantle 404(浏览器 e2e 实测暴露)。
    expect(mantlePathFor("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("anthropic");
    expect(mantlePathFor("eu.anthropic.claude-sonnet-5")).toBe("anthropic");
    expect(mantlePathFor("apac.anthropic.claude-haiku-4-5")).toBe("anthropic");
  });
  it("其它前缀 → openai 路径", () => {
    expect(mantlePathFor("zai.glm-4.7-flash")).toBe("openai");
    expect(mantlePathFor("xai.grok-4.3")).toBe("openai");
    expect(mantlePathFor("minimax.minimax-m2.5")).toBe("openai");
  });
});

describe("MantleStreamer OpenAI path (非 anthropic)", () => {
  it("解析 choices[].delta.content 增量,命中 [DONE] 停", async () => {
    const { fetch, calls } = fakeFetch(OPENAI_SSE);
    const s = new MantleStreamer(CFG, fetch);
    const out = await collect(s.stream(turn("zai.glm-4.7-flash"), new AbortController().signal));
    expect(out).toEqual(EXPECTED_OPENAI);
    // 路径 + 头正确
    expect(calls[0].url).toBe("https://mantle.test/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>)["OpenAI-Project"]).toBe("default");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-token");
    // body:含 system 消息 + 无 temperature(OpenAI 路径省略)
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe("zai.glm-4.7-flash");
    expect(body.messages[0]).toEqual({ role: "system", content: "你是助手" });
    expect(body.temperature).toBeUndefined();
  });
});

describe("MantleStreamer Anthropic path", () => {
  it("解析 content_block_delta.text_delta,走 /anthropic/v1/messages", async () => {
    const { fetch, calls } = fakeFetch(ANTHROPIC_SSE);
    const s = new MantleStreamer(CFG, fetch);
    const out = await collect(s.stream(turn("anthropic.claude-sonnet-5"), new AbortController().signal));
    expect(out).toEqual(EXPECTED_ANTHROPIC);
    expect(calls[0].url).toBe("https://mantle.test/anthropic/v1/messages");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-workspace-id"]).toBe("default");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.system).toBe("你是助手");
    expect(body.temperature).toBeUndefined(); // temperature 彻底不传(设计决策 deployment validation,避免跨模型 400)
  });
});

describe("MantleStreamer abort", () => {
  it("signal 中途 abort → 停止产出后续 token", async () => {
    const { fetch } = fakeFetch(OPENAI_SSE);
    const s = new MantleStreamer(CFG, fetch);
    const ctrl = new AbortController();
    const out: string[] = [];
    for await (const t of s.stream(turn("zai.glm-4.7-flash"), ctrl.signal)) {
      out.push(t);
      ctrl.abort(); // 拿到第一个 token 即打断
    }
    expect(out.length).toBeLessThan(EXPECTED_OPENAI.length); // 未跑完全部
    expect(out[0]).toBe("你好");
  });
});

describe("MantleStreamer SSE robustness (review)", () => {
  it("data: 行被切成小 chunk 仍正确重组(逐字节分片)", async () => {
    // 1 字节极端分片:每个 data: 行都跨多个 chunk,验证跨块重组
    const one: FetchLike = async () => ({ ok: true, status: 200, body: sseBody(OPENAI_SSE, 1), text: async () => OPENAI_SSE });
    const s1 = new MantleStreamer(CFG, one);
    expect(await collect(s1.stream(turn("zai.glm-4.7-flash"), new AbortController().signal))).toEqual(EXPECTED_OPENAI);
  });

  it("CRLF(\\r\\n)分帧正确解析(review)", async () => {
    const crlf = OPENAI_SSE.replace(/\n/g, "\r\n");
    const { fetch } = fakeFetch(crlf);
    const s = new MantleStreamer(CFG, fetch);
    expect(await collect(s.stream(turn("zai.glm-4.7-flash"), new AbortController().signal))).toEqual(EXPECTED_OPENAI);
  });

  it("末尾事件无结尾空行也不丢(review)", async () => {
    // 去掉最后的 \n\n,且不带 [DONE],最后一句只靠冲刷
    const noTrailing = 'data: {"choices":[{"delta":{"content":"仅此一句"}}]}';
    const { fetch } = fakeFetch(noTrailing);
    const s = new MantleStreamer(CFG, fetch);
    expect(await collect(s.stream(turn("zai.glm-4.7-flash"), new AbortController().signal))).toEqual(["仅此一句"]);
  });
});

describe("MantleStreamer fail-fast", () => {
  it("未注入 token → 抛错(不静默产出空流)", async () => {
    const s = new MantleStreamer({ token: "" }, fakeFetch(OPENAI_SSE).fetch);
    await expect(collect(s.stream(turn("zai.glm-4.7-flash"), new AbortController().signal))).rejects.toThrow(
      /凭据未注入/,
    );
  });
  it("HTTP 非 2xx → 抛错含状态码", async () => {
    const { fetch } = fakeFetch('{"error":{"message":"bad"}}', 400);
    const s = new MantleStreamer(CFG, fetch);
    await expect(collect(s.stream(turn("zai.glm-4.7-flash"), new AbortController().signal))).rejects.toThrow(
      /HTTP 400/,
    );
  });
  it("HTTP 401(token 过期)→ 抛错含状态码(review)", async () => {
    const { fetch } = fakeFetch('{"message":"Unauthorized"}', 401);
    const s = new MantleStreamer(CFG, fetch);
    await expect(collect(s.stream(turn("zai.glm-4.7-flash"), new AbortController().signal))).rejects.toThrow(
      /HTTP 401/,
    );
  });
});

// ── design contract:非流式单次补全(mantleCompleteOnce,ASR 字幕修正用)──
describe("mantleCompleteOnce(非流式,design contract)", () => {
  function jsonFetch(payload: unknown, status = 200): { fetch: FetchLike; calls: Array<{ url: string; init: Record<string, unknown> }> } {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, body: null, text: async () => raw };
    };
    return { fetch, calls };
  }

  it("OpenAI 路径:取 choices[0].message.content(去空白)", async () => {
    const { fetch, calls } = jsonFetch({ choices: [{ message: { content: " 62 " } }] });
    const out = await mantleCompleteOnce(CFG, { modelId: "zai.glm-4.7-flash", systemPrompt: "纠错", userText: "42" },
      new AbortController().signal, fetch);
    expect(out).toBe("62");
    expect(calls[0].url).toBe("https://mantle.test/v1/chat/completions");
    expect(JSON.parse(calls[0].init.body as string).stream).toBe(false);
  });

  it("Anthropic 路径:取 content[].text(拼接,去空白)+ stream:false + 无 temperature", async () => {
    const { fetch, calls } = jsonFetch({ content: [{ type: "text", text: "两个" }] });
    const out = await mantleCompleteOnce(CFG, { modelId: "anthropic.claude-haiku-4-5", systemPrompt: "纠错", userText: "俩个" },
      new AbortController().signal, fetch);
    expect(out).toBe("两个");
    expect(calls[0].url).toBe("https://mantle.test/anthropic/v1/messages");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.stream).toBe(false);
    expect(body.temperature).toBeUndefined(); // temperature 彻底不传(设计决策 deployment validation)
  });

  it("us. 跨区前缀 anthropic → 仍走 anthropic 路径", async () => {
    const { fetch, calls } = jsonFetch({ content: [{ type: "text", text: "x" }] });
    await mantleCompleteOnce(CFG, { modelId: "us.anthropic.claude-haiku-4-5", systemPrompt: "s", userText: "u" },
      new AbortController().signal, fetch);
    expect(calls[0].url).toBe("https://mantle.test/anthropic/v1/messages");
  });

  it("无 token → fail-fast", async () => {
    const { fetch } = jsonFetch({});
    await expect(mantleCompleteOnce({ token: "" }, { modelId: "m.x", systemPrompt: "s", userText: "u" },
      new AbortController().signal, fetch)).rejects.toThrow(/凭据未注入/);
  });

  it("HTTP 非 2xx → 抛错含状态码", async () => {
    const { fetch } = jsonFetch('{"error":"bad"}', 429);
    await expect(mantleCompleteOnce(CFG, { modelId: "zai.glm-4.7-flash", systemPrompt: "s", userText: "u" },
      new AbortController().signal, fetch)).rejects.toThrow(/HTTP 429/);
  });

  it("响应非 JSON → 抛错", async () => {
    const { fetch } = jsonFetch("not json at all");
    await expect(mantleCompleteOnce(CFG, { modelId: "zai.glm-4.7-flash", systemPrompt: "s", userText: "u" },
      new AbortController().signal, fetch)).rejects.toThrow(/非 JSON/);
  });
});
