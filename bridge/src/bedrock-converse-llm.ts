/**
 * 传统 Bedrock Runtime **Converse API** LLM 客户端(design contract)。
 *
 * 与 MantleStreamer(design contract,mantle gateway 两路径)并存,由 call_method=bedrock_converse 选用。
 * 用途:拿 mantle gateway 没有的模型(如 Sonnet 4.6)——它们只在传统 Bedrock Runtime 有。
 *
 * wire(review 定案 + SDK 源码核实):
 *  - 用 AWS SDK `ConverseStreamCommand`(SDK 已把 AWS eventstream 二进制解码成 JS 事件对象,无需手写解码);
 *  - **endpoint = 代理域名(纯 host,无 query)**——SDK 会丢弃 endpoint 里的 query;
 *  - **token:{token} + authSchemePreference:["httpBearerAuth"]** 强制 Bearer(SDK 默认 SigV4,不覆盖会去签名);
 *  - **middleware 在 build 阶段把 `?mantle=false&region=<r>` 注入请求 URL**——这是 mantle-proxy 的路由参数
 *    (转发前被代理剥除、不达上游 Bedrock)。中国区经代理东京出口绕 Anthropic 源 IP 地域封锁。
 *  - 请求体走 SDK 结构化字段(messages/system/inferenceConfig),SDK 内部序列化成 Bedrock Converse JSON。
 *  - 流式取事件 `contentBlockDelta.delta.text`;其它事件(messageStart/contentBlockStart/Stop/messageStop/
 *    metadata)不含对话文本、跳过。结束 = 事件流自然耗尽(无 SSE [DONE] 哨兵)。
 *
 * 凭据(bedrockApiKey)逐通注入(design contract),用完即弃,不缓存、不落持久层。abort 经 AbortSignal 中途停流。
 *
 * 封在 voice-engine.ts::LlmStreamer 接口下 —— 上层对 provider/wire 零感知(与 MantleStreamer 同接口)。
 */
import { BedrockRuntimeClient, ConverseStreamCommand, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent as HttpsAgent } from "node:https";
import { LlmStreamer, LlmTurn, LlmMessage } from "./bedrock-llm";

/**
 * 进程级 keepAlive 传输层单例(design contract,实时性优化)。
 *
 * 背景(真机 deployment validation):converse 每轮新建 client → 各自新建 handler/Agent,连接池不跨轮共享 → 每轮重付
 * 跨境 TLS 握手(~190ms)。修法 = **所有 converse 请求(对话 stream + fixer completeOnce)共享同一进程级
 * handler/Agent**,socket 跨轮/跨会话复用(第 2 轮起省握手)。对齐 mantle-llm 的 keepAlive 先例(design contract)。
 *
 * ★ 凭据红线(评审 #3):Agent 是**纯网络层、不含任何凭据**——token 经每轮新建的 client(config.token)
 *   在**请求级 Authorization 头**下发,不进 Agent。复用连接 ≠ 复用凭据。
 * ★ 生命周期(评审 #2):此单例**只随进程回收**,per-turn client MUST NOT 调 destroy()(会级联销毁本池)。
 * ★ keepAliveMsecs 语义:是 TCP keepalive 探测间隔(非 undici 的 idle TTL);真复用由真机连接数/TLS 计时实证。
 * ★ 复用域:Agent 按 origin(host)分池;同代理 host + 不同 ?region= query 复用同池(当前全局单选单一 host)。
 */
/** keepalive 默认值(design contract:单一事实源)。`||` 口径同 mantle。 */
export const CONVERSE_KEEPALIVE_DEFAULT_MS = 60_000;
export const converseKeepaliveMs = (): number =>
  Number(process.env.AIM_CONVERSE_KEEPALIVE_MS) || CONVERSE_KEEPALIVE_DEFAULT_MS;
const CONVERSE_KEEPALIVE_MS = converseKeepaliveMs();
let sharedHandler: NodeHttpHandler | undefined;
/** 取进程级共享 keepAlive handler(懒建单例)。测试经 `buildConverseClient(cfg, fakeHandler)` 的第二参数注入替身
 *  (不走本单例);生产路径不传第二参数 → 用本共享单例。 */
export function getSharedConverseHandler(): NodeHttpHandler {
  if (!sharedHandler) {
    const agent = new HttpsAgent({
      keepAlive: true,
      keepAliveMsecs: CONVERSE_KEEPALIVE_MS, // TCP keepalive 探测间隔
      maxSockets: 100, // > GPU_HARD_MAX(8)×sessions/instance(≈24)留足余量,远低于进程 fd 限
    });
    sharedHandler = new NodeHttpHandler({ httpsAgent: agent, connectionTimeout: 10_000 });
  }
  return sharedHandler;
}

export interface BedrockConverseConfig {
  /** Bedrock API Key(长期 Bearer,create-api-key 生成);逐通注入,不缓存。 */
  apiKey: string;
  /** 端点 host(经 mantle-proxy 时 = 代理域名;Global 可直连 bedrock-runtime.<region>.amazonaws.com)。 */
  host: string;
  /** 上游 Bedrock region(mantle-proxy 的 ?region= 参数;决定用哪个区域的 inference profile)。 */
  bedrockRegion: string;
}

/** 把内部 LlmMessage(role + string content)转成 Bedrock Converse 的 content:[{text}] 结构。 */
function toConverseMessages(history: LlmMessage[] | undefined, userText: string): {
  role: "user" | "assistant";
  content: { text: string }[];
}[] {
  const msgs = (history ?? []).map((m) => ({
    role: m.role,
    content: [{ text: m.content }],
  }));
  msgs.push({ role: "user", content: [{ text: userText }] });
  return msgs;
}

/** 建一个指向代理 + Bearer + 注入 ?mantle=false&region= 的 BedrockRuntimeClient。
 *  requestHandler 可注入(单测拦截出站 HttpRequest 断言 query/headers;不注入则用**进程级共享 keepAlive
 *  单例**(R4:socket 跨轮复用,省 TLS 握手)。★ 生命周期:此 client 用完即弃 GC,**MUST NOT 调 destroy()**
 *  ——那会级联 requestHandler.destroy() 销毁共享 Agent 连接池、殃及其它在飞会话(评审 #2)。 */
export function buildConverseClient(
  cfg: BedrockConverseConfig,
  requestHandler?: unknown,
): BedrockRuntimeClient {
  if (!cfg.apiKey) {
    // fail-fast:未注入 Bedrock API Key 不静默(否则 SDK 会尝试 SigV4/匿名,静默失败)。
    throw new Error("Bedrock Converse 凭据未注入(bedrock_api_key 缺失)");
  }
  // 不注入(生产)→ 用进程级共享 keepAlive handler(跨轮/跨会话复用 socket);注入(单测)→ 用替身。
  const handler = requestHandler ?? getSharedConverseHandler();
  const client = new BedrockRuntimeClient({
    region: cfg.bedrockRegion, // SDK 需要一个 region;实际上游由代理的 ?region= 决定(下方 middleware 注入)
    endpoint: cfg.host.replace(/\/+$/, ""), // 纯 host,无 query(SDK 会丢弃 endpoint query)
    token: { token: cfg.apiKey },
    authSchemePreference: ["httpBearerAuth"], // 强制 Bearer,禁 SigV4(SDK 默认 SigV4)
    requestHandler: handler as never, // 共享 keepAlive 单例(或注入的替身);token 不在此、只在请求头(红线)
  });
  // middleware:在请求发出前把 mantle-proxy 路由参数 ?mantle=false&region=<r> 注入 URL query。
  // 代理据此把上游切到 bedrock-runtime.<region>.amazonaws.com,并在转发前剥除这两个参数(不达上游)。
  client.middlewareStack.add(
    (next) => async (args) => {
      const req = args.request as { query?: Record<string, string | string[]> };
      if (req && typeof req === "object" && "query" in req) {
        req.query = { ...(req.query ?? {}), mantle: "false", region: cfg.bedrockRegion };
      }
      return next(args);
    },
    { step: "build", name: "injectMantleProxyRouting", priority: "high" },
  );
  return client;
}

/** Converse(Stream)的 inferenceConfig。★ 真机(deployment validation):Opus 4.7 / Sonnet 4.6 等新模型 converse
 *  **不接受 `temperature`**(返 400 "`temperature` is deprecated for this model")——converse 家族普遍如此。
 *  故**不传 temperature**(与 mantle 路径 0.3 不同);对话用模型默认。maxTokens 保留。 */
function inferenceConfig(_turn: LlmTurn): { maxTokens: number } {
  return { maxTokens: 1024 };
}

/** SDK client 最小接口(供单测注入 fake,避免真连 Bedrock)。 */
export interface ConverseClientLike {
  send(cmd: unknown, opts?: { abortSignal?: AbortSignal }): Promise<{
    stream?: AsyncIterable<Record<string, unknown>>;
    output?: { message?: { content?: { text?: string }[] } };
  }>;
}

export class BedrockConverseStreamer implements LlmStreamer {
  /** clientFactory 注入(默认 buildConverseClient 真实 SDK client);单测传 fake。 */
  constructor(
    private cfg: BedrockConverseConfig,
    private clientFactory: (cfg: BedrockConverseConfig) => ConverseClientLike = buildConverseClient,
  ) {}

  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    const client = this.clientFactory(this.cfg);
    const cmd = new ConverseStreamCommand({
      modelId: turn.modelId,
      messages: toConverseMessages(turn.history, turn.userText),
      system: turn.systemPrompt ? [{ text: turn.systemPrompt }] : undefined,
      inferenceConfig: inferenceConfig(turn),
    });
    const resp = await client.send(cmd, { abortSignal: signal });
    // resp.stream 是 async iterable of ConverseStreamOutput 事件(SDK 已解码 eventstream 二进制)。
    for await (const raw of resp.stream ?? []) {
      if (signal.aborted) break;
      const event = raw as {
        contentBlockDelta?: { delta?: { text?: string } };
        internalServerException?: { message?: string };
        modelStreamErrorException?: { message?: string };
        throttlingException?: { message?: string };
        validationException?: { message?: string };
      };
      // 只取文本增量事件;其它事件(messageStart/contentBlockStart/Stop/messageStop/metadata)跳过。
      const delta = event.contentBlockDelta?.delta;
      if (delta && typeof delta.text === "string" && delta.text) {
        yield delta.text;
      }
      // 错误事件(throttling/内部错误)→ 抛错(fail-fast,不静默空流)。
      const err = event.internalServerException || event.modelStreamErrorException ||
        event.throttlingException || event.validationException;
      if (err) {
        throw new Error(`Bedrock Converse 流错误 ${turn.modelId}: ${err.message ?? "unknown"}`);
      }
    }
  }
}

/**
 * 非流式单次补全(供 design contract fixer 的 converse 路径;evaluator 走 Python 侧,不用此)。
 * 返回 assistant 完整文本。失败抛错(调用方 fail-open)。与 mantleCompleteOnce 对称。
 */
export async function bedrockConverseCompleteOnce(
  cfg: BedrockConverseConfig,
  req: { modelId: string; systemPrompt: string; userText: string; maxTokens?: number },
  signal: AbortSignal,
  clientFactory: (cfg: BedrockConverseConfig) => ConverseClientLike = buildConverseClient,
): Promise<string> {
  const client = clientFactory(cfg);
  const cmd = new ConverseCommand({
    modelId: req.modelId,
    messages: [{ role: "user", content: [{ text: req.userText }] }],
    system: req.systemPrompt ? [{ text: req.systemPrompt }] : undefined,
    // ★ 真机(deployment validation):Opus 4.7 / Sonnet 4.6 等新模型 converse **不接受 `temperature`**(返 400
    //   "`temperature` is deprecated for this model")。故 converse **不带 temperature**(与 mantle 路径不同)。
    inferenceConfig: { maxTokens: req.maxTokens ?? 512 },
  });
  const resp = await client.send(cmd, { abortSignal: signal });
  // 非流式:output.message.content[] 里取 text 块拼接。
  const content = resp.output?.message?.content ?? [];
  return content
    .map((b) => (typeof (b as { text?: string }).text === "string" ? (b as { text: string }).text : ""))
    .join("")
    .trim();
}
