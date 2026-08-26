/**
 * 实时会话服务进程入口(VISION §3:原媒体面 Bridge 的减法改造)。
 *
 * 三件事:
 *  1. HTTP(:BRIDGE_HEALTH_PORT,默认 3001;`/rt` 前缀等价——公网 ALB /rt/* path 路由原样转发,
 *     入口统一 strip 前导 "/rt")
 *      - GET  /health              存活探针(无 FreeSWITCH 后只看进程/活动会话)
 *      - POST /sessions/:id/ready  控制面预创建:下发会话内核(prompt/questions/engine 参数),
 *                                  暂存待客户端连入(X-Bridge-Secret 鉴权,fail-closed)
 *      - POST /sessions/:id/hangup 控制面强制收尾(max_duration 上限等)
 *  2. WS(同端口 /ws 或 /rt/ws)接客户端音频流:每连接 = 一场会话。
 *     **公网暴露(公网 ALB /rt/*)→ WS 必须 fail-closed 鉴权(D9 红线)**:
 *     首条 text 帧必须是 {"type":"auth","token":"v1...."}(join token,HMAC 同
 *     AIM_BRIDGE_CALLBACK_SECRET 双用途);10s 不发 auth → 关;验签失败/过期/与 ?session_id=
 *     不符 → error(auth_failed)后关;无该 session 暂存上下文 → error(not_ready)后关(客户端
 *     重试,backend /join 会先重新预创建);未配密钥 → 拒一切连接。鉴权成功回 {"type":"ready"},
 *     然后才建 MediaSession(PCM 双向流,M1 起客户端为浏览器 AudioWorklet)。
 *     兼容口:AIM_RT_INSECURE=1 显式跳过鉴权(本地开发/内网旧行为);默认不设 = 强制鉴权。
 *  3. 进程级兜底:单场会话错误不杀整进程。
 *
 * join key = session_id 贯穿:backend 预创建 → 客户端凭 join token(内含 session_id)连入 →
 * WS 服务端取暂存内核,无反查、无 orphan(沿用 AIM 骨架)。
 *
 * 电话链路(FreeSWITCH/ESL/originate/DTMF)已删(VISION §1)。
 */
import * as http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { createEngine } from "./engine-factory";
import { MediaSession, WsConn } from "./media-session";
import type { MediaSessionTransport } from "./media-session-port";
import { V1MediaSessionTransport } from "./media-session-v1-adapter";
import { StereoRecorder } from "./stereo-recorder";
import { TranscriptStore } from "./transcript-store";
import { MetricsStore } from "./turn-metrics";
import { getSessionContext, putSessionContext, dropSessionContext } from "./session-context";
import { composeSessionPrompt, validQuestions } from "./prompt-compose";
import { EngineParams, endReasonToEvent } from "./voice-engine";
import { reportEvent } from "./callback";
import { verifyJoinToken } from "./join-token";
// design contract:kill-switch 解析收敛到 speaker-lock 叶子模块(原为此处独立 `!== "0"` 字面量)
import { speakerLockEnabled } from "./speaker-lock";
// design contract:只读诊断配置端点(fail-closed 鉴权 + 带版本信封)
import { handleConfigRequest } from "./config-endpoint";
import { loadTurnHandling } from "./turn-handling";
import { loadAckTimeoutConfig } from "./playback-settlement";
import { RealtimeUpgradeGateway } from "./openai-realtime/upgrade-gateway";
import { OpenAIRealtimeAdapter } from "./openai-realtime/adapter";
import {
  RealtimeConnectionOwners,
  type RealtimeConnectionLease,
} from "./openai-realtime/connection-owner";

// 误打断恢复模式(design contract):开启时打断判定统一由服务端做,客户端 MUST 禁用本地销毁性 barge_in
// (改由服务端 pause/resume/barge_in 驱动)。经 ready 帧下发给客户端感知模式。模块级读一次(env 启动即定)。
const FALSE_INTERRUPTION_RECOVERY = loadTurnHandling().interruption.recoveryEnabled;

// 声纹锁定说话人全局 kill-switch(design contract):唯 "0" 关(默认开、上线即生效,设计决策 D3)。effective_speaker_lock
// = Agent 请求(SessionContext.speakerLock)&& 此开关 && recovery 开(D7:recovery 关时客户端本地打断会绕过服务端门)。
const SPEAKER_LOCK_ENABLED = speakerLockEnabled();

// 进程级兜底(#3):单场会话的流错误/坏帧/监听错误不应杀整个服务(会断该进程所有会话)。
process.on("unhandledRejection", (reason) => {
  console.error("[rt-session] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[rt-session] uncaughtException:", err);
});

const PORT = Number(process.env.BRIDGE_HEALTH_PORT ?? 3001);
// 控制面 ↔ 实时会话服务的共享密钥(与 BridgeCallbackSecret 同值,**三用途**):
//  ① /sessions/:id/ready 的 X-Bridge-Secret(控制面 → 本服务,fail-closed)
//  ② 本服务 → 控制面事件回报(callback.ts)
//  ③ 客户端 WS join token 的 HMAC key(backend 签发 / 本服务验签,join-token.ts)
// 惰性读(每次取用时读 env):单测可按用例切换「配/未配」两分支;生产 env 启动即定,行为等价。
const bridgeSecret = (): string => process.env.AIM_BRIDGE_CALLBACK_SECRET ?? "";
// 兼容口:显式 AIM_RT_INSECURE=1 跳过 WS 鉴权(本地开发/内网旧行为,?session_id= 直连)。
// 默认不设 = 强制鉴权(公网 CloudFront rt/* 暴露,D9 红线 fail-closed)。
const rtInsecure = (): boolean => process.env.AIM_RT_INSECURE === "1";
// auth 帧等待窗:连接后这么久没收到合法 auth → 关连接(防挂空连接占资源)。
const AUTH_TIMEOUT_MS = 10_000;

// 客户端 WS 语音协议版本(design contract)。契约文档 docs/REALTIME-WS-PROTOCOL.md。
//  - 客户端 auth 首帧 MAY 携带 protocol_version;缺省即视为 v1(现有前端零改动,零回归)。
//  - ready 帧回显生效版本;未知版本 fail-closed(不静默降级)。
//  - 破坏性帧变更 MUST 递增此列表并在文档升版本;向后兼容变更(加可选帧/字段)不升版本。
const SUPPORTED_PROTOCOL_VERSIONS = ["1"] as const;
const DEFAULT_PROTOCOL_VERSION = "1";

// 播放 ACK(design contract):**design contract A 类 —— `AIM_PLAYBACK_ACK_MODE` 三态开关已删,结算恒生效**。
//   capability 协商**保留**:它是**传输能力**协商(客户端是否实现 ACK 上行 playback_complete/aborted),
//   不是 feature flag。声明了 → 双方启用轮标记 + 真 ACK 结算;未声明(如缓存的旧版前端)→ 无 ACK 上行,
//   但**服务端仍下发 `playback_superseded`**(见 media-session:清 ring 是单向通知,不需要 ACK 能力)。
//   timeout 配置(grace/maxWait/inputGrace + 跨参数不变量)在 loadAckTimeoutConfig 校验(非法 fail-fast)。
const PLAYBACK_ACK_CAPABILITY = "playback_ack_v1";
const PLAYBACK_PAUSE_CAPABILITY = "playback_pause_v1";
const PLAYBACK_ACK_TIMEOUT_CFG = loadAckTimeoutConfig();

// 活动会话表(session_id → MediaSession),用于强制收尾/并发观测。
const sessions = new Map<string, MediaSession>();
// 终态回报权威代次。物理 close 可先从 sessions 移除实例,但只有最新代次可以
// 删除 SessionContext 或回报业务终态;防旧连接慢清理完成后终结已接管的新会话。
const sessionAuthorities = new Map<string, symbol>();

// OpenAI Realtime SDK-compatible 入口使用独立 client-secret key,不得复用 join/callback key。
// 惰性读取便于密钥轮换后的新 upgrade 与单测环境覆盖;缺失/过短由 verifier fail-closed。
const realtimeClientSecret = (): string =>
  process.env.AIM_REALTIME_CLIENT_SECRET ?? "";
const realtimeConnectionOwners = new RealtimeConnectionOwners();
const realtimeUpgradeGateway = new RealtimeUpgradeGateway({
  getSigningKey: realtimeClientSecret,
  isContextReady: (sessionId) => getSessionContext(sessionId) !== null,
  owners: realtimeConnectionOwners,
  onConnection: startOpenAIRealtimeSession,
});

/** /rt 前缀兼容(CloudFront rt/* 行为、ALB path 路由不重写路径):统一 strip 前导 "/rt",
 *  使 /rt/health、/rt/ws、/rt/sessions/:id/ready 与不带前缀的等价。
 *  只剥「/rt/ 段边界」:/rt → /,/rt/ws → /ws;/rtx 这类非段边界不动。 */
function stripRtPrefix(url: string): string {
  if (url === "/rt") return "/";
  if (url.startsWith("/rt/") || url.startsWith("/rt?")) return url.slice(3);
  return url;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer((req, res) => {
  const url = stripRtPrefix(req.url ?? "");
  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", activeSessions: sessions.size }));
    return;
  }
  // design contract:只读诊断配置(内网 Cloud Map 由控制面调用;`X-Bridge-Secret` fail-closed,
  //   未配 503 / 缺头或错头 401)。⚠ `/rt/config` **MUST NOT** 进 ALB path allowlist(CDK UT 守门)——
  //   本层鉴权是纵深第二层,不是唯一防线。
  if (req.method === "GET" && url === "/config") {
    handleConfigRequest(req, res, bridgeSecret() || undefined);
    return;
  }
  const readyMatch = req.method === "POST" && /^\/sessions\/([^/]+)\/ready$/.exec(url);
  if (readyMatch) {
    handleSessionReady(readyMatch[1], req, res);
    return;
  }
  const hangupMatch = req.method === "POST" && /^\/sessions\/([^/]+)\/hangup$/.exec(url);
  if (hangupMatch) {
    handleHangup(hangupMatch[1], req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on("error", (err) => console.error(`[rt-session] http server error on :${PORT}:`, err));

/** 控制面预创建(原 /dial 的减法版):暂存会话内核(prompt/questions/engine 参数),等客户端连入。
 *  鉴权 fail-closed:X-Bridge-Secret 必须与 AIM_BRIDGE_CALLBACK_SECRET 一致(未配置 = 全拒)。 */
async function handleSessionReady(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const readySecret = bridgeSecret();
    if (!readySecret || req.headers["x-bridge-secret"] !== readySecret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const body = await readJsonBody(req);
    // engine_type 严格校验:非法值(typo/脏数据)不静默降级 —— 400 拒绝。缺省按默认 three_stage。
    const rawEngine = body.engine_type;
    if (rawEngine != null && rawEngine !== "three_stage") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `非法 engine_type: ${rawEngine}(仅 three_stage)` }));
      return;
    }
    const language = typeof body.language === "string" ? body.language : undefined;
    const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt : undefined;
    // 题库(resolved_questions):**不再**在此烘进静态 prompt(旧「一次性铺全部题」)。改由引擎持数组 +
    // 服务端游标**逐题注入**(design contract「出题游标由服务端强推进」)——经 engineParams.questions 下传,
    // 引擎每轮 composePrompt(persona, questions, cursor) 动态渲染,顺序由代码保证。缺省/非数组 = 纯人设对话。
    const questions = Array.isArray(body.questions) ? (body.questions as unknown[]) : [];
    // 置顶语言硬约束(真机:AI 说英/日 → 钉死输出语言,压过弱 Agent 提示词)+ 当前时间
    // + ASR 容错指令(对方语音经 ASR 转文字可能有误 → LLM 据上下文推断意图,不被识别错字绊住)。
    // 题目**不**在此拼入(见上);引擎逐题注入时把当前题追加在这段人设 prompt 之后。
    // design contract:组装抽为 prompt-compose.ts 单一事实源纯函数(接线条件可单测)。置顶硬指令 + 人设;
    // 完成强制(design contract)/ 交互风格(design contract)门控在各函数内据 questionCount 决定。
    // ★ questionCount 传**有效题数**(validQuestions 过滤后),与引擎 composePrompt 同口径(review:
    //   避免全脏题时注入「本场有题」指令但实际一道不问的自相矛盾)。
    const effectivePrompt = composeSessionPrompt({
      language,
      systemPrompt: systemPrompt ?? process.env.SYSTEM_PROMPT ?? "",
      questionCount: validQuestions(questions).length,
    });
    // 硬连接截止(review):控制面下发 connect_deadline(ISO);晚于此刻的 WS 连入拒绝
    // (会话可能已被调度器判 failed,不能靠 join token 4h TTL 放行)。解析失败/缺省 → 不设硬截止(仅 TTL 兜底)。
    let connectDeadlineMs: number | undefined;
    if (typeof body.connect_deadline === "string") {
      const parsed = Date.parse(body.connect_deadline);
      if (!Number.isNaN(parsed)) connectDeadlineMs = parsed;
    }
    // 实时字幕显示开关(design contract):**唯字面 false 才关**(缺省/true/null/未升级 backend → true 默认开)。
    // 会话级呈现配置,仅暂存 + 经 ready 帧回显前端;bridge 自身不据此改任何行为(不碰 media-session/引擎/GPU)。
    const showSubtitles = body.show_subtitles !== false;
    // 头像风格(design contract):**字符串枚举须显式校验合法四值**(不同 bool 的 show_subtitles)——只存合法值,非法/缺省 =
    // undefined → 前端兜底 minimal;ready 帧回显时 undefined 字段省略,避免协议出现脏值(review)。
    const VALID_AVATAR_STYLES = ["minimal", "round", "tech", "waveform"];
    const avatarStyle =
      typeof body.avatar_style === "string" && VALID_AVATAR_STYLES.includes(body.avatar_style)
        ? body.avatar_style
        : undefined;
    // 声纹锁定说话人(design contract):**唯字面 false 才关**(缺省/true/null/未升级 backend → true 默认锁定)。
    // 仅暂存;实际是否启用声纹门由 media-session 用 effective_speaker_lock 裁定(需 recovery 开 + kill-switch)。
    const speakerLock = body.speaker_lock !== false;
    // 暂存会话内核,供稍后客户端 WS 连上时取用(避免 AI 退化为默认 prompt)。
    putSessionContext(sessionId, effectivePrompt, {
      engineType: "three_stage",
      language: language ?? "zh-CN",
      llmModelId: typeof body.llm_model_id === "string" ? body.llm_model_id : process.env.AIM_LLM_MODEL_ID,
      // mantle Bearer token / host(design contract):逐通注入,暂存于内存 session-context(进程内、随会话结束清)。
      // ⚠ 绝不整体记录 body:token 在此,日志/异常栈 MUST NOT 打印。绝不落 DDB/磁盘/日志。
      llmBearerToken: typeof body.llm_bearer_token === "string" ? body.llm_bearer_token : undefined,
      llmMantleHost: typeof body.llm_mantle_host === "string" ? body.llm_mantle_host : undefined,
      // 主备 fallback 备用模型序(design contract):控制面已校验 ∈ 清单 + 中国区非 anthropic;仅取字符串项。
      // 缺省/非数组 → undefined,engine-factory 不启用 fallback(单模型)。
      llmFallbackModelIds: Array.isArray(body.llm_fallback_model_ids)
        ? (body.llm_fallback_model_ids as unknown[]).filter((m): m is string => typeof m === "string")
        : undefined,
      // ASR 字幕修正模型(design contract):控制面已校验(∈ 清单 + 中国区代理可达,否则降级剔除不下发)。
      // 缺省/空 → undefined,media-session 不做旁路修正(字幕/转写走 ASR 原文)。复用同通 token/host。
      llmTranscriptFixerModelId:
        typeof body.llm_transcript_fixer_model_id === "string" && body.llm_transcript_fixer_model_id
          ? body.llm_transcript_fixer_model_id
          : undefined,
      // design contract:旁路违规裁判模型(= evaluator_model 的 effective 求值,控制面下发)。缺省/空 → undefined,
      //   media-session 不跑裁判(逐字节等价现状)。复用同通 token/host/凭据(随 call_method)。裁判默认 shadow 只 log。
      llmModerationModelId:
        typeof body.llm_moderation_model_id === "string" && body.llm_moderation_model_id
          ? body.llm_moderation_model_id
          : undefined,
      // design contract:调用方式(全局单选)。缺省/非 converse → mantle(向后兼容)。
      llmCallMethod: body.llm_call_method === "bedrock_converse" ? "bedrock_converse" : "mantle",
      // design contract:Bedrock API Key(converse 凭据,逐通注入,同 token 绝不打日志)+ 上游 region。
      llmBedrockApiKey:
        typeof body.llm_bedrock_api_key === "string" ? body.llm_bedrock_api_key : undefined,
      llmBedrockRegion:
        typeof body.llm_bedrock_region === "string" && body.llm_bedrock_region
          ? body.llm_bedrock_region
          : undefined,
      // 语义音色 key:缺省时不设(undefined),引擎回退默认音色。
      voice: typeof body.voice === "string" ? body.voice : undefined,
      // TTS provider(design contract):缺省时不设(undefined),GPU 回退系统默认(gpu_omnivoice)。
      ttsProvider: typeof body.tts_provider === "string" ? body.tts_provider : undefined,
      // 出题题目(design contract):控制面固化的 resolved_questions,引擎持此 + 游标逐题注入。空数组 = 纯人设对话。
      questions,
    }, Date.now(), connectDeadlineMs, showSubtitles, avatarStyle, speakerLock);
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true, session_id: sessionId }));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
}

async function handleHangup(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // ★ D9(review):本端点经公网 ALB /rt/* 可达——与 /ready 同口径 fail-closed 鉴权,
  //   否则任何人猜到 session_id 就能 POST 终止进行中的会话。
  const secret = bridgeSecret();
  if (!secret || req.headers["x-bridge-secret"] !== secret) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const s = sessions.get(sessionId);
  if (s) await s.end("manual_hangup").catch(() => undefined);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// ── WS:接客户端音频流(/ws 或 /rt/ws)──
// M1 信令 v1:先鉴权后建会话(见 attachWsAuth)。?session_id=(或 M0 兼容名 fsUuid)可选,
// 与 join token 内 session_id 交叉校验,不一致拒。
// noServer + 手动 upgrade:WebSocketServer 的 path 选项只认单一路径,/rt 前缀 strip 需自管。
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const requestPath = (req.url ?? "").split("?")[0];
  if (requestPath === "/v1/realtime") {
    realtimeUpgradeGateway.handleUpgrade(req, socket, head);
    return;
  }

  const url = stripRtPrefix(req.url ?? "");
  const pathOnly = url.split("?")[0];
  if (pathOnly !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (conn) => {
    wss.emit("connection", conn, req);
  });
});

/** WS text/binary 收发最小面(测试替身与真实 ws 共面);在 media-session.WsConn 上加 off(鉴权后
 *  摘掉 auth 阶段的临时监听,避免与 MediaSession 的 message handler 双收)。 */
export interface AuthWsConn extends WsConn {
  off?(event: "message", cb: (data: Buffer, isBinary: boolean) => void): void;
}

wss.on("connection", (conn, req) => {
  const qs = new URL(stripRtPrefix(req.url ?? ""), "http://localhost").searchParams;
  const querySessionId = qs.get("session_id") || qs.get("fsUuid") || "";
  handleWsConnection(conn as unknown as AuthWsConn, querySessionId);
});

/** WS 连接处置(M1 信令 v1):先鉴权后建会话。
 *  - AIM_RT_INSECURE=1:跳过鉴权(内网旧行为),?session_id= 必填,直接建会话(不回 ready 帧——旧客户端不识)。
 *  - 默认(强制鉴权):等首条 text auth 帧(10s 超时);验签(fail-closed,密钥未配 = 全拒)→
 *    交叉校验 ?session_id= → 查暂存上下文(无 → not_ready)→ 回 ready → 建 MediaSession。
 *  导出供单测(fake conn)直接驱动鉴权流;start 注入建会话动作(默认真实 startMediaSession)。 */
export function handleWsConnection(
  conn: AuthWsConn,
  querySessionId: string,
  start: (sessionId: string, conn: AuthWsConn, playbackAck?: boolean) => Promise<void> = startV1MediaSession,
): void {
  if (rtInsecure()) {
    // 兼容口:显式声明的本地开发/内网旧行为(M0 直连,无 auth 帧)。
    if (!querySessionId) {
      conn.close();
      return;
    }
    void start(querySessionId, conn);
    return;
  }

  // ── 强制鉴权(默认,D9 fail-closed)──
  let settled = false; // 鉴权已了结(成功建会话 / 已拒),后续 auth 阶段事件不再处理
  const authTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    detachAuthListener();
    console.warn("[rt-session] WS 连接 10s 未发 auth 帧 → 关连接");
    try {
      conn.close();
    } catch {
      /* ignore */
    }
  }, AUTH_TIMEOUT_MS);
  authTimer.unref?.();

  /** 拒绝:error 帧(best-effort,可带额外字段如 server_supports)→ 关连接。 */
  const reject = (
    code: "auth_failed" | "not_ready" | "unsupported_protocol_version",
    extra: Record<string, unknown> = {},
  ): void => {
    settled = true;
    clearTimeout(authTimer);
    detachAuthListener();
    try {
      conn.send(JSON.stringify({ type: "error", code, ...extra }));
    } catch {
      /* ignore */
    }
    try {
      conn.close();
    } catch {
      /* ignore */
    }
  };

  const onAuthMessage = (data: Buffer, isBinary: boolean): void => {
    if (settled) return;
    // 鉴权前的 binary 帧(音频)一律丢弃(未鉴权不进引擎);首条 **text** 帧必须是 auth。
    if (isBinary) return;
    let msg: { type?: unknown; token?: unknown; protocol_version?: unknown; capabilities?: unknown };
    try {
      msg = JSON.parse(data.toString("utf8")) as {
        type?: unknown;
        token?: unknown;
        protocol_version?: unknown;
        capabilities?: unknown;
      };
    } catch {
      reject("auth_failed"); // 首条 text 帧非 JSON = 协议违规,拒
      return;
    }
    if (msg?.type !== "auth" || typeof msg.token !== "string") {
      reject("auth_failed"); // 首条 text 帧必须是 auth
      return;
    }
    // 验签(fail-closed:密钥未配(空)→ verifyJoinToken 恒 null → 拒一切连接)。
    const verified = verifyJoinToken(msg.token, bridgeSecret());
    if (!verified) {
      reject("auth_failed");
      return;
    }
    // ?session_id=(可选)与 token 内 session_id 交叉校验,不一致拒。
    if (querySessionId && querySessionId !== verified.sessionId) {
      reject("auth_failed");
      return;
    }
    // 验签通过但本进程无该 session 的暂存上下文 → not_ready(客户端重试;backend /join 会先重新预创建)。
    // 注:只探测不消费(getSessionContext 本就「取并保留」),startMediaSession 稍后再取。
    if (!getSessionContext(verified.sessionId)) {
      reject("not_ready");
      return;
    }
    // 协议版本协商(design contract):缺省即 v1(现有客户端零改动);携带则必须在支持列表内,未知版本
    // fail-closed(不静默降级)。**计算与检查都在验签之后**(review:不给未鉴权连接跑版本逻辑),
    // 作为发 ready 前的最后一道门;clientVersion 供 ready 帧回显。
    const clientVersion =
      msg.protocol_version === undefined ? DEFAULT_PROTOCOL_VERSION : msg.protocol_version;
    const versionOk =
      typeof clientVersion === "string" &&
      (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(clientVersion);
    if (!versionOk) {
      reject("unsupported_protocol_version", { server_supports: SUPPORTED_PROTOCOL_VERSIONS });
      return;
    }
    // 鉴权成功:了结 auth 阶段(摘临时监听,防与 MediaSession 的 message handler 双收)→ ready → 建会话。
    settled = true;
    clearTimeout(authTimer);
    detachAuthListener();
    // 播放 ACK 协商结果(design contract):在 try 外声明,供 ready 帧回显 + 透传给 startMediaSession(try 内异常也不丢默认 false)。
    let ackNegotiated = false;
    try {
      // ready 帧回显生效协议版本(design contract)+ 携带误打断恢复模式(design contract,开时客户端禁用本地
      // 销毁性 barge_in,改凭服务端 pause/resume/barge_in)。
      // 实时字幕显示开关(design contract):从 SessionContext 回显(控制面 /ready 下发的会话级配置)。此刻
      // getSessionContext 必非空(L357 已探测过);缺省 → true(默认开,向后兼容旧 backend 未下发)。
      // 纯呈现层——前端据此选有字幕 Teams 舞台 vs 无字幕纯声波;bridge 自身不据此改行为。
      const showSubtitles = getSessionContext(verified.sessionId)?.showSubtitles ?? true;
      // 头像风格(design contract):从 SessionContext 回显(已在 /ready 校验为合法四枚举才存)。undefined → 字段省略
      //   (JSON.stringify 行为),前端兜底 minimal;绝不回显脏值(review)。
      const avatarStyle = getSessionContext(verified.sessionId)?.avatarStyle;
      // 声纹锁定(design contract):effective = Agent 请求开锁 && 全局 kill-switch 开 && 误打断恢复开(D7)。
      //   recovery 关时客户端本地打断会绕过服务端声纹门,故声纹门须以 recovery 开为前提,否则降级不启用。
      //   ready 帧回显 effective_speaker_lock:前端据此(且仅此)决定是否禁本地销毁性 barge_in;缺省 false。
      const speakerLockRequested = getSessionContext(verified.sessionId)?.speakerLock ?? true;
      const effectiveSpeakerLock =
        speakerLockRequested && SPEAKER_LOCK_ENABLED && FALSE_INTERRUPTION_RECOVERY;
      if (speakerLockRequested && !effectiveSpeakerLock) {
        console.warn(
          `[rt ${verified.sessionId}] speaker_lock 请求开,但 effective=false(kill-switch=${SPEAKER_LOCK_ENABLED} recovery=${FALSE_INTERRUPTION_RECOVERY})→ 声纹门降级不启用,打断等价现状(design contract D7)`,
        );
      }
      // 播放 ACK 协商(design contract):客户端声明 playback_ack_v1 → ready 回显该 capability,双方启用轮标记
      //   (ai_audio_start/end)与 ACK(playback_complete/aborted)。客户端不声明 → 不回显 → 无 ACK 上行。
      //   capabilities 缺失/非数组 = [];未知项忽略(最多读前 16 项、每项 ≤64 字符,防超大列表)。
      // ★ design contract:服务端侧的 mode 门(`PLAYBACK_ACK_MODE !== "off"`)**已删** —— 此处只剩**客户端能力**判断。
      //   未协商 ≠ 无 supersede:`playback_superseded` 下发不依赖本标志(见 media-session 内对应注释)。
      const clientCaps = Array.isArray(msg.capabilities)
        ? (msg.capabilities as unknown[]).slice(0, 16).filter((c): c is string => typeof c === "string" && c.length <= 64)
        : [];
      ackNegotiated = clientCaps.includes(PLAYBACK_ACK_CAPABILITY);
      const pauseNegotiated = clientCaps.includes(PLAYBACK_PAUSE_CAPABILITY);
      const negotiatedCapabilities = [
        ...(ackNegotiated ? [PLAYBACK_ACK_CAPABILITY] : []),
        ...(pauseNegotiated ? [PLAYBACK_PAUSE_CAPABILITY] : []),
      ];
      conn.send(
        JSON.stringify({
          type: "ready",
          protocol_version: clientVersion,
          false_interruption_recovery: FALSE_INTERRUPTION_RECOVERY,
          show_subtitles: showSubtitles,
          avatar_style: avatarStyle,
          effective_speaker_lock: effectiveSpeakerLock,
          // 只回显双方都支持且本次启用的 capability;未协商则省略(老客户端忽略新增字段/帧)。
          ...(negotiatedCapabilities.length > 0
            ? { capabilities: negotiatedCapabilities }
            : {}),
        }),
      );
    } catch {
      /* ignore:对端刚断,后续 begin/close 路径兜底清理 */
    }
    void start(verified.sessionId, conn, ackNegotiated); // design contract:透传协商结果给会话
  };

  const onAuthClose = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(authTimer); // 对端在鉴权前断开:清 timer 防悬挂
  };

  const detachAuthListener = (): void => {
    // ws 库标准方法是 removeListener(off 是 EventEmitter 别名,类型/旧版本不保证;review:
    // 摘不掉 = auth 监听与 MediaSession 双收 text 帧)。removeListener 优先,off 兜底。
    const c = conn as unknown as {
      removeListener?: (ev: string, cb: unknown) => void;
      off?: (ev: string, cb: unknown) => void;
    };
    (c.removeListener ?? c.off)?.call(conn, "message", onAuthMessage);
    (c.removeListener ?? c.off)?.call(conn, "close", onAuthClose);
  };

  conn.on("message", onAuthMessage);
  conn.on("close", onAuthClose);
}

async function startV1MediaSession(
  sessionId: string,
  conn: AuthWsConn,
  playbackAck = false,
): Promise<void> {
  try {
    await realtimeConnectionOwners.replace(sessionId, (lease) => ({
      socket: conn as unknown as WebSocket,
      activate: async () => {
        const transport = new V1MediaSessionTransport(conn);
        if (
          !lease.setSupersedeController({
            waitForCloseRequest: () => transport.waitForCloseRequest(),
            fail: () => transport.failConnectionTakeover(),
          })
        ) {
          throw new Error("v1 connection lease is no longer active");
        }
        await startMediaSessionWithTransport(
          sessionId,
          transport,
          playbackAck,
          (session) => {
            const registered = lease.setCoreRevoker(() => {
              void session.detach().catch((error) => {
                console.error(
                  `[rt-session] session ${sessionId} background detach failed:`,
                  (error as Error).message,
                );
              });
            });
            if (!registered) {
              throw new Error("v1 connection lease is no longer active");
            }
          },
          !rtInsecure(),
        );
      },
    }));
  } catch (e) {
    console.error(
      `[rt-session] session ${sessionId} start failed:`,
      (e as Error).message,
    );
    try {
      conn.close(1011, "session initialization failed");
    } catch {
      /* ignore */
    }
  }
}

async function startOpenAIRealtimeSession(
  sessionId: string,
  socket: WebSocket,
  lease: RealtimeConnectionLease,
): Promise<void> {
  const adapter = new OpenAIRealtimeAdapter(socket);
  if (
    !lease.setSupersedeController({
      waitForCloseRequest: () => adapter.waitForCloseRequest(),
      fail: () => adapter.failConnectionTakeover(),
    })
  ) {
    throw new Error("realtime connection lease is no longer active");
  }
  await startMediaSessionWithTransport(
    sessionId,
    adapter,
    false,
    (session) => {
      const registered = lease.setCoreRevoker(() => {
        void session.detach().catch((error) => {
          console.error(
            `[rt-session] realtime session ${sessionId} background detach failed:`,
            (error as Error).message,
          );
        });
      });
      if (!registered) {
        throw new Error("realtime connection lease is no longer active");
      }
      adapter.start();
    },
    true,
  );
}

async function startMediaSessionWithTransport(
  sessionId: string,
  transport: MediaSessionTransport,
  playbackAck: boolean,
  beforeBegin?: (session: MediaSession) => void | Promise<void>,
  requireContext = false,
): Promise<MediaSession> {
  // 取控制面预创建暂存的会话内核(Agent system_prompt + 引擎参数);无暂存(直连测试)则用环境默认。
  const ctx = getSessionContext(sessionId);
  if (!ctx && requireContext) {
    throw new Error(`session ${sessionId} context is no longer ready`);
  }
  let authority: symbol | null = null;
  const releaseAuthority = (): boolean => {
    if (!authority || sessionAuthorities.get(sessionId) !== authority) {
      return false;
    }
    sessionAuthorities.delete(sessionId);
    return true;
  };
  const params: EngineParams = ctx?.engineParams ?? {
    engineType: "three_stage",
    language: "zh-CN",
    llmModelId: process.env.AIM_LLM_MODEL_ID,
  };
  const systemPrompt = ctx?.systemPrompt ?? process.env.SYSTEM_PROMPT ?? "";
  let engine;
  try {
    engine = createEngine(sessionId, params, {
      gpuQueuedAudioLimitBytes: transport.inputPendingLimitBytes,
    });
  } catch (e) {
    releaseAuthority();
    console.error(`[rt-session] createEngine ${sessionId} failed:`, (e as Error).message);
    throw e;
  }
  // 同 session_id 的撤权和接管由进程级 RealtimeConnectionOwners 串行化。
  // 这里不得再次等待旧 session 的录音上传/engine stop，否则慢清理会阻塞新 core 激活。
  // 声纹锁定(design contract):与 ready 帧同一 effective 裁定(Agent 请求 && kill-switch && recovery)。
  //   与 ready 帧回显对称——两处必一致(前端据 ready 禁本地打断、服务端据此启用声纹门)。
  const effectiveSpeakerLock =
    (ctx?.speakerLock ?? true) && SPEAKER_LOCK_ENABLED && FALSE_INTERRUPTION_RECOVERY;
  let session: MediaSession;
  try {
    session = new MediaSession(
      transport,
      {
        sessionId,
        systemPrompt,
        engineParams: params,
        effectiveSpeakerLock,
        // 播放 ACK(design contract):客户端声明 capability 才建 coordinator(收 ACK 上行)。
        //   ★ design contract:mode 已删,不再传;undefined 只意味「无 ACK 上行」,**不影响 supersede 下发**。
        playbackAck: playbackAck ? { cfg: PLAYBACK_ACK_TIMEOUT_CFG } : undefined,
      },
      {
        engine,
        recorder: new StereoRecorder(sessionId),
        transcripts: new TranscriptStore(),
        metrics: new MetricsStore(), // 每轮实时性 metrics 落库(design contract,旁路 best-effort)
        // 会话收尾 → 回报控制面,驱动 in_progress→(completed|failed)+ 触发评估。
        // design contract:按 reason 分三事件——
        //   正常收尾(session_end/manual_hangup/error)→ `completed`(触发评估);
        //   **违规**(silence_violation/severe_violation ∈ VIOLATION_END_REASONS)→ `violation_end`(带 fail_reason)→ backend failed;
        //   **物理断连**(peer_hangup,非违规)→ `peer_hangup` 事件 → backend failed(fail_reason=peer_hangup,对齐 design contract)。
        // 违规/断连都 failed(evaluator 只在 completed 触发,不打分),但事件分开(语义:违规 vs 断连)。
        onEnded: ({ durationS, hasRecording, reason, earlyExit }) => {
          if (!releaseAuthority()) return;
          if (sessions.get(sessionId) === session) sessions.delete(sessionId);
          dropSessionContext(sessionId);
          const event = endReasonToEvent(reason); // design contract:reason→事件(单一事实源,voice-engine 可单测)
          void reportEvent(sessionId, {
            event,
            end_trigger: reason,
            ...(event === "violation_end" ? { fail_reason: reason } : {}),
            duration_s: durationS,
            has_recording: hasRecording,
            // design contract:三次坚持逃生阀放行的提前结束(考生主动放弃剩余题)。backend 不认则忽略(向后兼容)。
            ...(earlyExit ? { early_exit: true } : {}),
          });
        },
      },
    );
  } catch (error) {
    releaseAuthority();
    throw error;
  }
  const preparation = beforeBegin?.(session);
  if (preparation) await preparation;
  // Claim business-terminal authority only after transport/revoker setup
  // succeeds. Early initialization failure leaves an in-flight predecessor
  // entitled to finish its terminal callback.
  authority = Symbol(sessionId);
  sessionAuthorities.set(sessionId, authority);
  sessions.delete(sessionId);
  sessions.set(sessionId, session);
  // 客户端连入即视为会话开始 → 回报控制面 connected(置 in_progress)。fire-and-forget(不阻塞 begin)。
  // ★ design contract:connected(scheduled→in_progress)与启动窗断连的 peer_hangup(→failed)即便乱序也**安全**——
  //   backend 双守卫兜底:fail_from_media 放行 scheduled→failed(peer_hangup 先到直接 failed);mark_connected 有
  //   终态守卫(connected 后到读到 failed 幂等返回、**不覆盖**)。故无需 await 序列化(await 反而在 begin 注册
  //   close handler 前新开一个盲窗,评审 二审)。仅剩「两回调各读到 scheduled 旧快照」的 TOCTOU = 全系统既有
  //   非原子写债(Task 0.6,极窄且有 max_duration reaper 兜底),不在 R0 修。
  void reportEvent(sessionId, { event: "connected" });
  try {
    await session.begin();
  } catch (e) {
    console.error(`[rt-session] session ${sessionId} begin failed:`, (e as Error).message);
    await session.end("error").catch(() => undefined);
    // begin() 抛错(recorder.start/engine.start 失败)时 conn.on("close") 清理 handler 还没挂上 →
    // 不显式清会在 sessions 表残留一个已 closed 的死会话(/health activeSessions 虚高 + 后续同
    // session_id 连接先 detach 一个死对象,排障混乱)。这里身份校验后显式清(review)。
    if (releaseAuthority()) {
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      dropSessionContext(sessionId);
    }
    throw e;
  }
  // 物理 close 只清活动实例。SessionContext 由真正业务 onEnded 清理；接管 detach 不得让旧连接
  // 的 close 抢先删除新连接稍后仍需读取的服务端 prompt/engine params。
  // 身份校验:只在表里仍是**本** session 时才删 —— 否则旧连接 close(被新连接替换后)会误删新会话(N4 竞态)。
  transport.onClose(() => {
    if (sessions.get(sessionId) === session) {
      sessions.delete(sessionId);
    }
  });
  return session;
}

// 仅作为主模块(Dockerfile: node dist/src/index.js)时监听端口;被 import(单测驱动
// handleWsConnection/stripRtPrefix)时不绑端口(否则 jest 并发 worker 抢 :3001)。
if (require.main === module) {
  server.listen(PORT, () =>
    console.log(
      `[rt-session] realtime session service on :${PORT} (/health /ws /v1/realtime /sessions/:id/ready;/rt 前缀仅用于既有入口;/ws 鉴权=${rtInsecure() ? "跳过(AIM_RT_INSECURE=1)" : "join token"};/v1/realtime 鉴权=client secret upgrade)`,
    ),
  );
}

export { server, stripRtPrefix };
