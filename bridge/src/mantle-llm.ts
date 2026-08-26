/**
 * Bedrock mantle LLM 流式客户端(design contract)。
 *
 * 取代 bedrock-llm.ts::BedrockStreamer(SigV4 + SDK InvokeModel)——改经 Amazon Bedrock
 * **mantle 端点** + **Bearer token**,同一 host / 同一 token,按 model id 前缀分流两条路径
 * (实测钉死 deployment validation,见 validation rationale):
 *   - `anthropic.*` → POST {host}/anthropic/v1/messages(原生 Anthropic Messages body,
 *       头 anthropic-version + anthropic-workspace-id),SSE 事件 content_block_delta.text_delta。
 *   - 其它(xai./zai./minimax./openai.…) → POST {host}/v1/chat/completions(OpenAI Chat body,
 *       头 OpenAI-Project),SSE choices[].delta.content + [DONE] 哨兵。
 *
 * 路径由 model id 前缀**推断**(不下发、不存 Secret):`anthropic.` → anthropic,否则 openai。
 * token/host 由控制面逐通经 /dial 注入(design contract 凭据模型:媒体面不持系统级 token、不缓存)。
 *
 * 封在 voice-engine.ts::LlmStreamer 接口之下 —— 上层(媒体泵/打断/记账/看门狗)对 provider 零感知。
 * abort:AbortSignal 触发即关连接;循环内每步查 signal.aborted 丢弃残留 token(barge-in 停流)。
 */
import { Agent, fetch as undiciFetch } from "undici";
import { LlmStreamer, LlmTurn } from "./bedrock-llm";

/**
 * 跨境 LLM 连接保活(性能:LATENCY-REPORT §4 的隐藏主因)。
 * undici 默认 keepAliveTimeout≈4s,而一个口试回合的空闲间隔(用户思考+说话 5–15s)远超 4s →
 * **每回合之间连接被关,下一回合重付跨境 TLS 握手(实测 ~968ms)**。用长 keepalive 的 Agent 作 dispatcher,
 * 让跨境连接跨回合复用,每回合省 ~700ms(端到端首声 2.5–2.8s → ~1.9s)。不依赖换国内模型,立即可得。
 * connect timeout 10s(跨境建连给足);keepAliveTimeout 60s(> 回合间隔)。
 *
 * ★ 用 **undici 自己的 fetch + 显式 dispatcher**(而非 setGlobalDispatcher + globalThis.fetch):
 *   后者依赖"npm undici 与 Node 内置 undici 共享 globalThis dispatcher symbol"的隐式版本兼容
 *   (实测当前 Node22/undici6 生效,但内置 undici 大版本变更可能失效 → 静默退化回短 keepalive)。
 *   显式传 dispatcher 明确无歧义,不受内置版本影响(review 关注点)。
 */
/** keepalive 默认值(design contract:单一事实源;registry 复用,勿另抄)。
 *  ⚠ `|| ` 口径:值为 0 或空串也会回退默认(与 `??` 族不同,刻意保留)。 */
export const MANTLE_KEEPALIVE_DEFAULT_MS = 60_000;
export const mantleKeepaliveMs = (): number =>
  Number(process.env.AIM_MANTLE_KEEPALIVE_MS) || MANTLE_KEEPALIVE_DEFAULT_MS;
const MANTLE_KEEPALIVE_MS = mantleKeepaliveMs();
const mantleAgent = new Agent({
  keepAliveTimeout: MANTLE_KEEPALIVE_MS,
  keepAliveMaxTimeout: MANTLE_KEEPALIVE_MS,
  connect: { timeout: 10_000 },
});

/** Default provider host; deployment configuration may override it. */
export const DEFAULT_MANTLE_HOST =
  process.env.AIM_MANTLE_HOST || "https://bedrock-mantle.us-east-1.api.aws";

/** mantle 调用配置(逐通注入;token 绝不缓存、绝不落持久层)。 */
export interface MantleConfig {
  /** Bearer token(AWS_BEARER_TOKEN_BEDROCK);逐通注入,用完即弃。 */
  token: string;
  /** mantle host base(默认 DEFAULT_MANTLE_HOST)。 */
  host?: string;
}

/** 据 model id 前缀推断走哪条路径(实测:anthropic 在 openai 路径 404)。
 *
 * ★ Claude 一律经**跨区 inference profile**(硬性要求,见 bedrock-region.ts),真实 model id 形如
 *   `us.anthropic.claude-haiku-4-5-...`(前缀 `us.`/`eu.`/`apac.`)。故须**先剥区域前缀再判 anthropic.**——
 *   否则 `us.anthropic.*` 被判成 openai 路径 → mantle `/v1/chat/completions` 404
 *   ("model does not exist";浏览器 e2e 实测暴露)。 */
export function mantlePathFor(modelId: string): "anthropic" | "openai" {
  const base = modelId.replace(/^(us|eu|apac)\./, "");
  return base.startsWith("anthropic.") ? "anthropic" : "openai";
}

/** 注入 fetch(单测替身);默认用 **undici fetch + 长 keepalive dispatcher**(跨境连接跨回合复用)。 */
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  body: AsyncIterable<Uint8Array> | null;
  text: () => Promise<string>;
}>;

/** 默认 fetch:undici fetch,显式绑定长 keepalive Agent(dispatcher);跨回合复用跨境 TLS 连接。 */
const keepAliveFetch: FetchLike = (url, init) =>
  undiciFetch(url as string, { ...init, dispatcher: mantleAgent } as never) as unknown as ReturnType<FetchLike>;

export class MantleStreamer implements LlmStreamer {
  private readonly host: string;
  constructor(
    private cfg: MantleConfig,
    private fetchImpl: FetchLike = keepAliveFetch,
  ) {
    this.host = (cfg.host || DEFAULT_MANTLE_HOST).replace(/\/+$/, "");
  }

  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    if (!this.cfg.token) {
      // fail-fast:未注入 token 不静默产出空流(否则 AI 静默,design contract fail-fast 契约)。
      throw new Error("mantle LLM 凭据未注入(llm_bearer_token 缺失)");
    }
    const path = mantlePathFor(turn.modelId);
    if (path === "anthropic") {
      yield* this.streamAnthropic(turn, signal);
    } else {
      yield* this.streamOpenAI(turn, signal);
    }
  }

  /** Anthropic 原生 Messages 路径(/anthropic/v1/messages)。 */
  private async *streamAnthropic(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    const body = {
      model: turn.modelId,
      max_tokens: 1024,
      // temperature 彻底不传(设计决策 deployment validation):新模型/部分模型对非默认 temperature 返 400,一律用模型默认。
      system: turn.systemPrompt,
      messages: [...(turn.history ?? []), { role: "user", content: turn.userText }],
      stream: true,
    };
    const resp = await this.fetchImpl(`${this.host}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-workspace-id": "default",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      throw new Error(`mantle anthropic ${turn.modelId} HTTP ${resp.status}: ${await safeText(resp)}`);
    }
    for await (const evt of sseEvents(resp.body, signal)) {
      if (signal.aborted) break;
      // Anthropic SSE:data 行是 JSON;取 content_block_delta.text_delta。
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(evt);
      } catch {
        continue;
      }
      if (
        obj.type === "content_block_delta" &&
        (obj.delta as Record<string, unknown> | undefined)?.type === "text_delta"
      ) {
        const t = (obj.delta as Record<string, unknown>).text;
        if (typeof t === "string" && t) yield t;
      }
    }
  }

  /** OpenAI 兼容路径(/v1/chat/completions);非 Anthropic provider(xai/zai/minimax/openai)。 */
  private async *streamOpenAI(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    // system 作为首条 system 消息(OpenAI 语义);history + 本轮 user 追加。
    const messages = [
      ...(turn.systemPrompt ? [{ role: "system", content: turn.systemPrompt }] : []),
      ...(turn.history ?? []),
      { role: "user", content: turn.userText },
    ];
    const body = {
      model: turn.modelId,
      max_tokens: 1024,
      // OpenAI 路径省略 temperature(跨 provider 默认差异大,非默认值易 400;用模型默认)。
      messages,
      stream: true,
    };
    const resp = await this.fetchImpl(`${this.host}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        "Content-Type": "application/json",
        "OpenAI-Project": "default",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      throw new Error(`mantle openai ${turn.modelId} HTTP ${resp.status}: ${await safeText(resp)}`);
    }
    for await (const evt of sseEvents(resp.body, signal)) {
      if (signal.aborted) break;
      if (evt === "[DONE]") break;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(evt);
      } catch {
        continue;
      }
      const choices = obj.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      const content = delta?.content;
      if (typeof content === "string" && content) yield content;
    }
  }
}

/**
 * 非流式单次补全(design contract:ASR 字幕修正用)。与 MantleStreamer.stream 同 wire(host/token/keepalive Agent +
 * 按 model 前缀分流两路径),但 **stream:false + 一次性拿完整文本**(修正是短文本、旁路,不需要逐 token)。
 *
 * 复用逐通注入的 token/host(不额外注入凭据)。超时/abort 经 AbortSignal(调用方 transcript-fixer 用
 * AbortController 定超时)。返回 assistant 完整文本(去首尾空白);任何失败(HTTP 非 2xx / 网络 / abort)抛错,
 * 由调用方 fail-open 落原文。**不进对话路径**,不碰 history。
 */
export async function mantleCompleteOnce(
  cfg: MantleConfig,
  req: { modelId: string; systemPrompt: string; userText: string; maxTokens?: number },
  signal: AbortSignal,
  fetchImpl: FetchLike = keepAliveFetch,
): Promise<string> {
  if (!cfg.token) throw new Error("mantle 修正凭据未注入(llm_bearer_token 缺失)");
  const host = (cfg.host || DEFAULT_MANTLE_HOST).replace(/\/+$/, "");
  const path = mantlePathFor(req.modelId);
  const maxTokens = req.maxTokens ?? 512; // 修正是短句,给足余量即可
  let url: string;
  let body: Record<string, unknown>;
  let headers: Record<string, string>;
  if (path === "anthropic") {
    url = `${host}/anthropic/v1/messages`;
    body = {
      model: req.modelId,
      max_tokens: maxTokens,
      // temperature 彻底不传(设计决策 deployment validation):部分模型拒该参数(400);用模型默认。
      system: req.systemPrompt,
      messages: [{ role: "user", content: req.userText }],
      stream: false,
    };
    headers = {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-workspace-id": "default",
    };
  } else {
    url = `${host}/v1/chat/completions`;
    body = {
      model: req.modelId,
      max_tokens: maxTokens,
      messages: [
        ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
        { role: "user", content: req.userText },
      ],
      stream: false,
    };
    headers = {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      "OpenAI-Project": "default",
    };
  }
  const resp = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!resp.ok) {
    throw new Error(`mantle 修正 ${req.modelId} HTTP ${resp.status}: ${await safeText(resp)}`);
  }
  const raw = await resp.text();
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`mantle 修正响应非 JSON: ${raw.slice(0, 200)}`);
  }
  // 两路径响应结构不同:Anthropic content[].text;OpenAI choices[].message.content。
  let text = "";
  if (path === "anthropic") {
    const content = obj.content as Array<Record<string, unknown>> | undefined;
    text = (content ?? [])
      .filter((b) => b?.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("");
  } else {
    const choices = obj.choices as Array<Record<string, unknown>> | undefined;
    const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
    text = String(msg?.content ?? "");
  }
  return text.trim();
}

async function safeText(resp: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await resp.text()).slice(0, 300);
  } catch {
    return "(no body)";
  }
}

/**
 * 把 SSE 响应流解析成一串「data 值」(去掉 `data: ` 前缀,跨 chunk 缓冲、按空行分事件)。
 * 每步查 signal.aborted 及早退出(barge-in 停流)。两路径共用(Anthropic/OpenAI 都是 SSE)。
 */
async function* sseEvents(
  body: AsyncIterable<Uint8Array> | null,
  signal: AbortSignal,
): AsyncIterable<string> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = "";
  const drainEvent = function* (raw: string): Iterable<string> {
    for (const line of raw.split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        if (data) yield data;
      }
    }
  };
  for await (const chunk of body) {
    if (signal.aborted) return;
    // 规整 \r\n → \n(部分 SSE 端用 CRLF;否则 \n\n 分帧会漏 / 事件带残 \r,review)。
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    // SSE 事件以空行(\n\n)分隔;逐个抽出完整事件。
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      yield* drainEvent(raw);
    }
  }
  // 冲刷末尾不带结尾空行的残留事件(端提前关流时最后一个事件不丢,review)。
  if (!signal.aborted && buf.trim()) yield* drainEvent(buf);
}
