/**
 * design contract:BedrockConverseStreamer 单测(fake SDK client,不触网)。断言:
 *  - Converse body 构造(messages content:[{text}] + system + inferenceConfig)
 *  - 流式取 contentBlockDelta.delta.text,跳过其它事件类型
 *  - 错误事件 → 抛错(fail-fast)
 *  - abort 中途停流
 *  - 无 API Key → fail-fast(buildConverseClient)
 *  - bedrockConverseCompleteOnce 取 output.message.content[].text
 */
import {
  BedrockConverseStreamer,
  bedrockConverseCompleteOnce,
  buildConverseClient,
  getSharedConverseHandler,
  ConverseClientLike,
  BedrockConverseConfig,
} from "../src/bedrock-converse-llm";
import { LlmTurn } from "../src/bedrock-llm";

const CFG: BedrockConverseConfig = { apiKey: "bedrock-key-x", host: "https://proxy.test", bedrockRegion: "us-east-1" };

function turn(modelId = "global.anthropic.claude-sonnet-4-6"): LlmTurn {
  return { systemPrompt: "你是助手", userText: "在吗", modelId, history: [] };
}

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const t of gen) out.push(t);
  return out;
}

/** fake client:发出预设的 ConverseStream 事件序列。 */
function fakeStreamClient(events: Record<string, unknown>[], captured?: { cmd?: unknown }): ConverseClientLike {
  return {
    async send(cmd: unknown) {
      if (captured) captured.cmd = cmd;
      return {
        async *[Symbol.asyncIterator]() {}, // 不用
        stream: (async function* () {
          for (const e of events) yield e;
        })(),
      } as never;
    },
  };
}

describe("BedrockConverseStreamer.stream", () => {
  it("取 contentBlockDelta.delta.text,跳过其它事件", async () => {
    const events = [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { text: "你好" } } },
      { contentBlockDelta: { delta: { text: ",在的" } } },
      { contentBlockStop: {} },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 5 } } },
    ];
    const s = new BedrockConverseStreamer(CFG, () => fakeStreamClient(events));
    expect(await collect(s.stream(turn(), new AbortController().signal))).toEqual(["你好", ",在的"]);
  });

  it("Converse body:messages content:[{text}] + system + inferenceConfig", async () => {
    const captured: { cmd?: unknown } = {};
    const s = new BedrockConverseStreamer(CFG, () => fakeStreamClient([{ contentBlockDelta: { delta: { text: "x" } } }], captured));
    const t: LlmTurn = {
      systemPrompt: "人设",
      userText: "第二句",
      modelId: "global.anthropic.claude-sonnet-4-6",
      history: [{ role: "user", content: "第一句" }, { role: "assistant", content: "回应" }],
      temperature: 0.3,
    };
    await collect(s.stream(t, new AbortController().signal));
    const input = (captured.cmd as { input: Record<string, unknown> }).input;
    expect(input.modelId).toBe("global.anthropic.claude-sonnet-4-6");
    expect(input.system).toEqual([{ text: "人设" }]);
    // history(2)+ 本轮 user(1)= 3 条,末条是本轮 userText,content 是 [{text}] 结构
    expect(input.messages).toEqual([
      { role: "user", content: [{ text: "第一句" }] },
      { role: "assistant", content: [{ text: "回应" }] },
      { role: "user", content: [{ text: "第二句" }] },
    ]);
    // converse 不传 temperature(真机:Opus4.7/Sonnet4.6 拒该参数 "deprecated for this model")
    expect(input.inferenceConfig).toEqual({ maxTokens: 1024 });
    expect((input.inferenceConfig as Record<string, unknown>).temperature).toBeUndefined();
  });

  it("错误事件 → 抛错(fail-fast)", async () => {
    const s = new BedrockConverseStreamer(CFG, () => fakeStreamClient([{ throttlingException: { message: "rate limited" } }]));
    await expect(collect(s.stream(turn(), new AbortController().signal))).rejects.toThrow(/流错误.*rate limited/);
  });

  it("abort 中途停流", async () => {
    const events = [
      { contentBlockDelta: { delta: { text: "一" } } },
      { contentBlockDelta: { delta: { text: "二" } } },
      { contentBlockDelta: { delta: { text: "三" } } },
    ];
    const s = new BedrockConverseStreamer(CFG, () => fakeStreamClient(events));
    const ctrl = new AbortController();
    const out: string[] = [];
    for await (const t of s.stream(turn(), ctrl.signal)) {
      out.push(t);
      ctrl.abort(); // 拿到第一个即打断
    }
    expect(out).toEqual(["一"]);
  });
});

describe("buildConverseClient fail-fast", () => {
  it("无 API Key → 抛错", () => {
    expect(() => buildConverseClient({ ...CFG, apiKey: "" })).toThrow(/凭据未注入/);
  });
  it("有 API Key → 构造成功(SDK client)", () => {
    const c = buildConverseClient(CFG);
    expect(c).toBeTruthy();
  });

  // review 阻断 #2:真实 SDK client + 注入 requestHandler 拦截出站 HttpRequest,断言 middleware 真把
  // ?mantle=false&region= 注入 query + Bearer 头 + path 含 /model/<id>/converse-stream。不触网(handler 抛错短路)。
  it("middleware 真注入 ?mantle=false&region= + Bearer 头(非假绿,拦截真实出站请求)", async () => {
    const captured: { query?: Record<string, unknown>; headers?: Record<string, string>; path?: string } = {};
    // fake requestHandler:SDK 走完整 middleware 链(含 build step 的注入)后调 handle(request)。
    const requestHandler = {
      async handle(request: { query?: Record<string, unknown>; headers?: Record<string, string>; path?: string }) {
        captured.query = request.query;
        captured.headers = request.headers;
        captured.path = request.path;
        throw new Error("__intercepted__"); // 拦到即短路,不真发网络
      },
      // SDK 可能读 metadata/destroy;给最小实现
      destroy() {},
      metadata: { handlerProtocol: "http/1.1" },
    };
    const client = buildConverseClient(CFG, requestHandler);
    const { ConverseStreamCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const cmd = new ConverseStreamCommand({
      modelId: "global.anthropic.claude-sonnet-4-6",
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      inferenceConfig: { maxTokens: 16 },
    });
    await client.send(cmd).catch((e: Error) => {
      if (!/__intercepted__/.test(e.message)) throw e; // 只吞我们的拦截标记,其它错(如构造错)照抛
    });
    // 真断言:middleware 注入的路由参数 + Bearer 头 + converse-stream path 都到了出站请求。
    expect(captured.query?.mantle).toBe("false");
    expect(captured.query?.region).toBe("us-east-1");
    expect(captured.path).toContain("/model/global.anthropic.claude-sonnet-4-6/converse-stream");
    const authHeader = captured.headers?.authorization ?? captured.headers?.Authorization;
    expect(authHeader).toBe("Bearer bedrock-key-x");
  });
});

describe("bedrockConverseCompleteOnce", () => {
  it("取 output.message.content[].text 拼接去空白", async () => {
    const captured: { cmd?: unknown } = {};
    const fake: ConverseClientLike = {
      async send(cmd: unknown) {
        captured.cmd = cmd;
        return { output: { message: { content: [{ text: " 修正后 " }] } } };
      },
    };
    const out = await bedrockConverseCompleteOnce(
      CFG, { modelId: "global.anthropic.claude-haiku-4-6", systemPrompt: "纠错", userText: "42" },
      new AbortController().signal, () => fake,
    );
    expect(out).toBe("修正后");
    // 非流式 body:converse 不传 temperature(真机拒该参数)
    const input = (captured.cmd as { input: Record<string, unknown> }).input;
    expect((input.inferenceConfig as Record<string, unknown>).temperature).toBeUndefined();
  });
});

// ── design contract:keepAlive 连接复用(进程级共享 handler,不复用凭据)──
describe("R4 keepAlive 共享 handler 单例", () => {
  it("getSharedConverseHandler 是进程级单例(多次取同一个)", () => {
    const h1 = getSharedConverseHandler();
    const h2 = getSharedConverseHandler();
    expect(h1).toBe(h2); // 同一引用 → 跨轮/跨会话共享连接池
  });

  it("默认 buildConverseClient 用共享 handler(不传 requestHandler 时)", () => {
    // 构造两个不同 cfg 的 client,都应复用同一进程级 handler(连接池共享的前提)。
    const c1 = buildConverseClient(CFG);
    const c2 = buildConverseClient({ ...CFG, apiKey: "another-key" });
    // config.requestHandler 应是同一个共享单例实例
    expect(c1.config.requestHandler).toBe(getSharedConverseHandler());
    expect(c2.config.requestHandler).toBe(getSharedConverseHandler());
    expect(c1.config.requestHandler).toBe(c2.config.requestHandler);
  });

  it("共享 handler 是纯网络层,不含任何 token(红线)", () => {
    const h = getSharedConverseHandler() as unknown as Record<string, unknown>;
    const dumped = JSON.stringify(h, (_k, v) => (typeof v === "function" ? undefined : v));
    // handler/Agent 序列化里不得出现任何 Bearer token 痕迹
    expect(dumped).not.toContain("bedrock-key-x");
    expect(dumped.toLowerCase()).not.toContain("authorization");
    expect(dumped.toLowerCase()).not.toContain("bearer");
  });

  it("双 token 红线:两 client 共享 handler,各带各的 Bearer,无串号(验最终请求签名)", async () => {
    // 注入同一个拦截 requestHandler 给两个不同 token 的 client,断言最终 HttpRequest 各带各的 Authorization。
    const seen: string[] = [];
    const mkIntercept = () => ({
      async handle(request: { headers?: Record<string, string> }) {
        const auth = request.headers?.authorization ?? request.headers?.Authorization ?? "";
        seen.push(auth);
        throw new Error("__intercepted__");
      },
      destroy() {},
      metadata: { handlerProtocol: "http/1.1" },
    });
    const shared = mkIntercept(); // 模拟「共享同一 handler」
    const runOne = async (apiKey: string) => {
      const client = buildConverseClient({ ...CFG, apiKey }, shared);
      const { ConverseStreamCommand } = await import("@aws-sdk/client-bedrock-runtime");
      await client.send(new ConverseStreamCommand({
        modelId: "global.anthropic.claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { maxTokens: 8 },
      })).catch((e: Error) => { if (!/__intercepted__/.test(e.message)) throw e; });
    };
    await runOne("token-session-A");
    await runOne("token-session-B");
    // 各请求带各自 token,无跨请求残留/串号
    expect(seen[0]).toBe("Bearer token-session-A");
    expect(seen[1]).toBe("Bearer token-session-B");
  });
});
