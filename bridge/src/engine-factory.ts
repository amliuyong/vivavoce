/**
 * VoiceEngine 工厂 —— 按引擎类型为一通会话造引擎(design contract)。
 *   three_stage(唯一实现):连 GPU WS(ASR/TTS)+ LLM(Bedrock IAM / mantle Bearer)→ ThreeStageEngine
 *
 * VoiceEngine 抽象保留(为将来可能的引擎扩展留缝);Nova S2S 引擎已删
 * (VISION §1 设计决策:简化版只留三段式,Nova 中国区不可用会造成两分区行为分叉)。
 *
 * 上层(MediaSession)只拿 VoiceEngine 接口,对具体引擎零感知。GPU WS 用真实 `ws`,
 * 但连接动作经 connectGpu 注入,便于单测替身。
 */
import WebSocket from "ws";
import { randomInt } from "node:crypto";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { GpuClient, WsLike } from "./gpu-client";
import { BedrockStreamer, LlmStreamer } from "./bedrock-llm";
import { MantleStreamer } from "./mantle-llm";
import { BedrockConverseStreamer } from "./bedrock-converse-llm";
import { FallbackLlmStreamer } from "./fallback-llm";
import { ThreeStageEngine } from "./three-stage-engine";
import { EngineParams, VoiceEngine } from "./voice-engine";

// Keep ai_turn_id as a JSON-safe integer while assigning each connection a
// 65,536-wide range (offsets 1..65,535 are issued). A 37-bit random namespace
// makes reconnect collisions negligible across bridge tasks.
const AI_TURN_ID_STRIDE = 65_536;
const AI_TURN_ID_NAMESPACES = 2 ** 37;

export interface EngineFactoryDeps {
  gpuWsUrl?: string;
  region?: string;
  /** 注入 GPU WS 连接(默认真实 ws);单测替身用。 */
  connectGpu?: (url: string, sessionId: string) => WsLike;
  /** 注入三段式 LLM streamer(默认真实 MantleStreamer);单测替身用。 */
  llm?: LlmStreamer;
  /** Optional strict byte cap for audio queued before the GPU ready/reset fence. */
  gpuQueuedAudioLimitBytes?: number;
}

/** 真实 GPU WS 连接:把 `ws` 适配成 GpuClient 需要的 WsLike。
 *
 * N1:`new WebSocket()` 立即返回(CONNECTING),但 ThreeStageEngine.start() 会立刻 gpu.start() 发 start 帧。
 * 在 socket OPEN 之前调 sock.send() 会抛 "WebSocket is not open" → 真机上会话一开始就静默/失败,而单测
 * 替身(同步 send)掩盖了它。这里在适配层做**发送缓冲**:OPEN 前的帧入队,open 时按序冲刷;之后直发。 */
function realConnectGpu(url: string): WsLike {
  const sock = new WebSocket(url, { perMessageDeflate: false });
  sock.binaryType = "nodebuffer";
  const sendQueue: Array<string | Buffer> = [];
  let open = false;
  sock.on("open", () => {
    open = true;
    for (const item of sendQueue.splice(0)) {
      try {
        sock.send(item);
      } catch {
        /* open 后仍失败极罕见,交给 error/close 事件上报 */
      }
    }
  });
  return {
    send: (data) => {
      if (open && sock.readyState === WebSocket.OPEN) sock.send(data);
      else sendQueue.push(data); // 未 OPEN:入队,open 时冲刷(保序)
    },
    close: () => sock.close(),
    on: (event: "message" | "open" | "close" | "error", cb: never) => {
      if (event === "message") {
        sock.on("message", (data: WebSocket.RawData, isBinary: boolean) =>
          (cb as (d: Buffer, b: boolean) => void)(data as Buffer, isBinary),
        );
      } else {
        sock.on(event, cb as () => void);
      }
    },
  };
}

export function createEngine(
  sessionId: string,
  params: EngineParams,
  deps: EngineFactoryDeps = {},
): VoiceEngine {
  const gpuWsUrl = deps.gpuWsUrl ?? process.env.AIM_GPU_WS_URL ?? "";
  const region = deps.region ?? process.env.AWS_REGION ?? "us-east-1";

  // 运行时 fail-fast:非法 engineType(API 旁路/历史脏数据)不静默降级成 three_stage(design contract review)。
  // 注:s2s 已删(VISION §1);历史数据带 s2s 的会话在此 fail-fast,不静默换引擎。
  if (params.engineType !== "three_stage") {
    throw new Error(`非法 engineType: ${params.engineType}(仅 three_stage;s2s 已删除)`);
  }

  // 三段式:GPU(ASR/TTS)+ LLM。LLM 段按 **call_method(design contract,全局单选)** + 凭据选路:
  //   ① callMethod=bedrock_converse(design contract)→ BedrockConverseStreamer:经代理调传统 Bedrock Converse API
  //      (拿 mantle 没有的模型如 Sonnet 4.6),凭据 = Bedrock API Key;
  //   ② 配了 mantle token(design contract,callMethod=mantle/缺省)→ MantleStreamer:经 mantle 端点,anthropic/minimax/zai 多 provider;
  //   ③ 都没配(默认/回退)→ BedrockStreamer:IAM role(SigV4)调 Bedrock,env AIM_LLM_MODEL_ID(默认 Haiku 4.5),仅 Global。
  // 凭据/host 由控制面逐通注入(params);实时会话服务不读 Secret、不缓存。
  const connect = deps.connectGpu ?? ((url: string) => realConnectGpu(url));
  const ws = connect(gpuWsUrl, sessionId);
  const gpu = new GpuClient(
    ws,
    sessionId,
    5_000,
    deps.gpuQueuedAudioLimitBytes,
  );
  // D-2(design contract):握手期 CAPACITY_FULL(GPU 冷启动/缩容窗/瞬时满载)→ jitter 退避重连换实例,
  // 而非直接拆机。同一 connect 工厂重建 WS(DNS 轮询/NLB 可能落到有空位的实例)。运行中断连仍拆机。
  gpu.enableReconnect({ connect: () => connect(gpuWsUrl, sessionId) });
  let llm: LlmStreamer;
  if (deps.llm) {
    llm = deps.llm; // 单测注入
  } else if (params.llmCallMethod === "bedrock_converse") {
    // design contract:传统 Bedrock Converse 方式(拿 mantle 没有的模型如 Sonnet 4.6)。凭据 = Bedrock API Key,
    //   host = 代理/端点域名(llmMantleHost 复用),region = llmBedrockRegion(mantle-proxy ?region=)。
    //   全局单选下 fallback 备用模型同走 converse(同 wire),FallbackLlmStreamer 直接包(streamer 模型无关)。
    const converse = new BedrockConverseStreamer({
      apiKey: params.llmBedrockApiKey ?? "",
      host: params.llmMantleHost ?? "",
      bedrockRegion: params.llmBedrockRegion ?? "us-east-1",
    });
    const fbs = params.llmFallbackModelIds?.filter((m) => !!m) ?? [];
    llm = fbs.length > 0 ? new FallbackLlmStreamer(converse, fbs) : converse;
  } else if (params.llmBearerToken) {
    const mantle = new MantleStreamer({ token: params.llmBearerToken, host: params.llmMantleHost });
    // design contract:配了备用模型序 → 包一层 FallbackLlmStreamer(主出首 token 前失败/超时切备,已出 token 不回退);
    //   备用同用逐通注入的 token/host(MantleStreamer 模型无关,每轮 modelId 决定路径)。空 → 不包(单模型)。
    const fbs = params.llmFallbackModelIds?.filter((m) => !!m) ?? [];
    llm = fbs.length > 0 ? new FallbackLlmStreamer(mantle, fbs) : mantle;
  } else {
    // 回退:IAM role + Bedrock InvokeModel(旧路径)。model id 用 params.llmModelId(通常已回退 env 默认 Haiku)。
    // IAM 回退是单模型开箱路径(仅 Global);design contract 主备仅在 mantle 路径生效(中国区必走 mantle)。
    // 注:此 IAM 路径未配 design contract 的 keepAlive 共享 handler(与 evaluator 同类:非中国区旁路/开箱场景,
    //     优化收益有限)。未来若成瓶颈,可参考 bedrock-converse-llm.ts::getSharedConverseHandler 共享 handler 模式。
    llm = new BedrockStreamer(new BedrockRuntimeClient({ region }) as never);
  }
  const aiTurnIdBase = randomInt(AI_TURN_ID_NAMESPACES) * AI_TURN_ID_STRIDE;
  return new ThreeStageEngine(gpu, llm, aiTurnIdBase);
}
