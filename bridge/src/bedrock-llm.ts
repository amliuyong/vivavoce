/**
 * Bedrock LLM 流式客户端(design contract:由 Bridge 调,GPU 不持 Bedrock 凭证)。
 * 默认 Claude Haiku(us. inference profile)。封装 InvokeModelWithResponseStream 的
 * token 流为一个 async generator;支持中途 abort(barge-in 停流)。
 *
 * 真实实现用 @aws-sdk/client-bedrock-runtime;此处把"流来源"抽象成 LlmStreamer 接口,
 * 便于单测注入假的 token 流,而真实 BedrockStreamer 在生产装配。
 */

/** 一条历史消息(Claude Messages 交替的 user/assistant)。 */
export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmTurn {
  systemPrompt: string;
  userText: string; // 一轮对方的 ASR final 文本
  modelId: string;
  temperature?: number;
  /** 之前轮次的对话历史(后端按 session 维护;client 只发音频,不碰历史)。本轮 userText 追加在末尾。 */
  history?: LlmMessage[];
}

export interface LlmStreamer {
  /** 流式产出 token 文本;调用方可通过 AbortSignal 中途停流(barge-in)。 */
  stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string>;
}

/**
 * 真实 Bedrock 实现(Claude Messages API on Bedrock,响应流)。
 * 仅在生产装配;单测用假 streamer,故这里不在测试路径上。
 */
export class BedrockStreamer implements LlmStreamer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private client: any /* BedrockRuntimeClient */) {}

  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    const {
      InvokeModelWithResponseStreamCommand,
    } = await import("@aws-sdk/client-bedrock-runtime");
    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1024,
      // temperature 彻底不传(设计决策 deployment validation):新模型(Opus4.7/Sonnet4.6 等)converse 拒该参数(400
      // deprecated),mantle 侧非默认值也易 400 —— 一律用模型默认,避免跨模型踩坑。
      system: turn.systemPrompt,
      // 历史(后端按 session 维护)+ 本轮 user。多轮上下文,AI 才记得上文。
      messages: [...(turn.history ?? []), { role: "user", content: turn.userText }],
    };
    const cmd = new InvokeModelWithResponseStreamCommand({
      modelId: turn.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    });
    const resp = await this.client.send(cmd, { abortSignal: signal });
    for await (const event of resp.body ?? []) {
      if (signal.aborted) break;
      const bytes = event?.chunk?.bytes;
      if (!bytes) continue;
      const chunk = JSON.parse(Buffer.from(bytes).toString("utf-8"));
      if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
        yield chunk.delta.text as string;
      }
    }
  }
}

/**
 * 默认 LLM 模型 ID。优先从 env `AIM_LLM_MODEL_ID` 读(CDK 经 bedrock-region.ts 单一事实源下发),
 * 缺失时回退到 Haiku 的 us. inference profile。Profile 仍可 per-call 覆盖。
 */
export const DEFAULT_LLM_MODEL_ID =
  process.env.AIM_LLM_MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0";
