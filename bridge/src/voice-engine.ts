/**
 * VoiceEngine 抽象(design contract)。上层(实时会话/录音/转写/AEC/状态机)只依赖此接口,
 * 对"用哪个引擎"零感知。当前唯一实现:ThreeStageEngine(Nova S2S 已删,VISION §1;
 * 抽象保留为将来可能的引擎扩展留缝)。
 *
 * cancel(reason) 区别于 stop():
 *   - cancel(barge_in)      : 打断当前播报,会话继续(listen 新输入)
 *   - cancel(session_end|manual_hangup|error): 中止当前合成,准备收尾
 *   - cancel(peer_hangup)   : 对端物理断连(WS close);走 failed 语义,不被 design contract 游标门拦(design contract)
 *   - cancel(silence_violation|severe_violation): 违规强制结束(design contract);走 failed 语义,不被游标门拦
 *   - stop()                : 整通结束
 *
 * ★ design contract:收尾类 reason 分两语义——**正常收尾**(session_end/manual_hangup/error → completed)vs
 *   **异常/违规结束**(peer_hangup/silence_violation/severe_violation → failed)。design contract 游标门(未问完题不许挂)
 *   **只拦 session_end**,放行其余所有 reason(见 media-session 客户端 end 帧 / onAiDone 拦截点)。
 */

export type CancelReason =
  | "barge_in"
  | "session_end"
  | "manual_hangup"
  | "error"
  | "peer_hangup" // 对端物理断连(design contract:修此前 WS close 误用 session_end 会被游标门拦的 bug)
  | "silence_violation" // 沉默防作弊第 4 次(design contract)
  | "severe_violation"; // 严重违规再犯(design contract)

/** VoiceEngine 输入尚未可下发时的有界积压已满。上层只依赖该稳定错误码，不感知具体引擎。 */
export const VOICE_INPUT_PENDING_LIMIT_ERROR = "VOICE_INPUT_PENDING_LIMIT";

export interface EngineParams {
  engineType: "three_stage";
  language: string; // 默认 zh-CN
  /** 三段式:LLM 模型 ID(mantle model id,如 anthropic.claude-haiku-4-5 / zai.glm-4.7-flash;
   *  缺省回退 env AIM_LLM_MODEL_ID)。design contract:经 Bedrock mantle 端点调用。 */
  llmModelId?: string;
  /** 三段式:mantle Bearer token(design contract)。控制面逐通注入,实时会话服务不持久、不缓存。
   *  缺省(未注入)→ 三段式 LLM 无凭据 → MantleStreamer fail-fast(不静默产出空流)。 */
  llmBearerToken?: string;
  /** 三段式:mantle host base(design contract)。缺省回退 MantleStreamer 内置默认(us-east-1)。 */
  llmMantleHost?: string;
  /** 三段式:LLM 主备 fallback 备用模型序(design contract,已由控制面校验 ∈ 清单 + 中国区非 anthropic)。
   *  主模型 = llmModelId;主在**出首 token 前**失败/超时 → 依次切这些备用重跑本轮(已出 token 不回退)。
   *  缺省/空 → 不启用 fallback(单模型,行为回退 design contract)。备用同用逐通注入的 token/host(不缓存)。 */
  llmFallbackModelIds?: string[];
  /** 三段式:ASR 字幕修正模型 id(design contract)。**旁路增强**——media-session 收到 user ASR final 后,
   *  用此模型**非流式单次**修正错字,更新字幕 + 覆盖转写落库;**不碰对话路径、不加首声延迟**。
   *  修正走的上游随 `llmCallMethod`(design contract):mantle→复用 llmBearerToken/llmMantleHost;bedrock_converse→
   *  复用 llmBedrockApiKey/llmMantleHost(代理域名)/llmBedrockRegion(不额外注入凭据)。缺省/空 → 不修(走 ASR 原文)。
   *  控制面已校验合法(∈ 清单 + 中国区代理可达),不合法时已在控制面降级剔除、不下发此字段。 */
  llmTranscriptFixerModelId?: string;
  /** 三段式:旁路**违规裁判**模型 id(design contract)。**旁路增强**——media-session 收到 user ASR final 后异步裁判
   *  「答题/不会/闲话/严重违规」+ answer_complete;不阻塞对话/游标。= 控制面下发的 evaluator_model effective 值
   *  (复用打分模型,不新增配置)。走的上游随 `llmCallMethod`(复用同通 token/host/凭据)。缺省/空 → 不跑裁判。 */
  llmModerationModelId?: string;
  /** 三段式:LLM 调用方式(design contract,全局单选)。`mantle`(默认/现状,design contract 两路径)或 `bedrock_converse`
   *  (传统 Bedrock Runtime Converse API,拿 mantle 没有的模型如 Sonnet 4.6)。缺省 → mantle(向后兼容)。 */
  llmCallMethod?: "mantle" | "bedrock_converse";
  /** 三段式:Bedrock API Key(design contract,`bedrock_converse` 方式的凭据)。逐通注入,不缓存。
   *  仅 `llmCallMethod==="bedrock_converse"` 时用;此时 llmMantleHost 复用为代理/端点域名。 */
  llmBedrockApiKey?: string;
  /** 三段式:converse 上游 Bedrock region(design contract,mantle-proxy 的 ?region= 参数)。缺省 us-east-1。 */
  llmBedrockRegion?: string;
  /** 语义音色 key(male_std/female_std…,统一抽象,与引擎无关):
   *  → GPU TTS voice clone 参考音(锁声纹,见 gpu funasr_backend)。
   *  缺省 → 引擎用自身默认。注:不再用「固定 seed」(voice design 仍句间漂移,已改 voice clone)。 */
  voice?: string;
  /** TTS provider 段级维度(design contract):TTS 由哪家合成(gpu_omnivoice|minimax)。
   *  仅**透传**至 GPU start 帧,无任何条件分支(GPU 据此选 TtsEngine);凭据/voice_id 映射
   *  由 GPU 直读 Secret,不经服务下发。缺省 → undefined,GPU 回退系统默认(gpu_omnivoice)。 */
  ttsProvider?: string;
  /** 出题题目(design contract:控制面固化的 resolved_questions,每题 {text, reference_answer?, weight?};design contract 去题目级 follow_up)。
   *  引擎持此数组 + **服务端游标**逐题注入(composePrompt(prompt, questions, cursor)),顺序由代码保证。
   *  缺省/空 = 纯人设对话(无游标、无逐题注入,退化为开放式对话,design contract)。**不**在会话预创建时烘进
   *  静态 system_prompt(那是旧「一次性铺全部题」做法);systemPrompt 只含人设 + 语言/语气/时间等指令。 */
  questions?: unknown[];
  // 注:不含 temperature(不开放配置,LLM 内部固定 0.4)。
}

/** 一轮转写(对齐 GPU 下行 asr_partial/asr_final)。 */
export interface Transcript {
  text: string;
  isFinal: boolean;
  inputEpoch?: number;
  inputTurnId?: number;
  /** design contract:该句被记录那一刻的服务端出题游标题号(0-based，与 cursor/questions[] 下标一致；用户不可见)。
   *  **事件快照**——user asr_final 到达那一刻捕获(= 用户开口答这句时的游标 = 他正在答的题),随回调传下去落库;
   *  绝不在落库时重查全局 cursor(避免尾音 FINAL 迟到、游标已推进后误标下一题)。越界(cursor>=len)/ 无题
   *  (len===0)→ undefined(不写字段,稀疏)。asr_partial 不带(partial 不落库)。 */
  questionIndex?: number;
}

export interface ResponseIdentity {
  responseGeneration: number;
  turnSeq: number;
}

export interface ResponseSegmentIdentity extends ResponseIdentity {
  segmentId: number;
}

export interface ResponseSegmentDeclared extends ResponseSegmentIdentity {
  text: string;
}

export type ResponseCoreTerminalStatus = "completed" | "cancelled" | "failed";

export interface ResponseCoreTerminal extends ResponseIdentity {
  status: ResponseCoreTerminalStatus;
  reason?: string;
}

export type AudioOutCb = (pcm: Buffer, identity?: ResponseSegmentIdentity) => void; // 合成音频块(回发客户端)
export type ResponseStartedCb = (event: ResponseIdentity) => void;
export type ResponseSegmentDeclaredCb = (event: ResponseSegmentDeclared) => void;
export type ResponseSegmentCompletedCb = (event: ResponseSegmentIdentity) => void;
export type ResponseCoreTerminalCb = (event: ResponseCoreTerminal) => void;
/** The response terminal reached the local socket handoff boundary. The
 *  returned timestamp is the existing bounded playback-settlement estimate. */
export type ResponseServerDrainedCb = (
  responseGeneration: number,
  completed: boolean,
) => number | void;
/** design contract:轮媒体边界回调(播放 ACK 用)。`onTurnAudioBegin` 在**该轮首个下行 binary 之前**触发(= server
 *  向客户端 ai_audio_start(aiTurnId));`onTurnAudioEnd` 在**该轮正常完整播完**(fireAiDone completed=true 且本轮
 *  产生过音频)触发(= ai_audio_end,server_drained 边界,非客户端已播完)。`aiTurnId` = 引擎 turnSeq(轮级单调,
 *  重连重置)。被打断/异常终结/无音频的轮不发 end(R2:清 ring 由 barge_in/supersede 走)。默认未接 = no-op,
 *  逐字节等价现状(Phase 3 引擎侧接线,Phase 4 media 订阅后才产生 wire 效果)。 */
export type TurnAudioBoundaryCb = (aiTurnId: number) => void;
/** design contract:引擎接受一个**用户驱动的新轮**(runLlmTurn 过 busy + meaningful-input 门,非 kickoff/nudge/auto-next)
 *  时触发 —— 服务端权威「起新用户轮」事实。media(enforce 模式)据此下发 playback_superseded 清客户端 ring
 *  (根治「换轮旧音频续播」:tts_done 后客户端仍在播旧轮,用户提新问题 → 清旧音频)。**非由 user-transcript 触发**
 *  (不踩 design contract:客户端凭字幕误清);清 ring 安全由 tombstone 隔离(阶段1)保证不混播。默认未接 = no-op。 */
export type UserTurnStartCb = () => void;
export type TranscriptCb = (t: Transcript) => void;
export interface InputIdentity {
  inputEpoch: number;
  inputTurnId: number;
}
export type TurnEventCb = (event: "turn_end", identity?: InputIdentity) => void;
export type EngineErrorCb = (code: string, message: string) => void; // 引擎/LLM/GPU 错误
/** AI 本轮说出的完整文本(供 speaker=ai 转写落库)。design contract:第二参 `questionIndex` = AI 本轮所问的题号
 *  (0-based),在 **SpeechTurn 创建时**捕获(不是 commitAiText 执行时的全局 cursor——那时可能已推进→误标)。
 *  越界/无题 → undefined(不写字段)。 */
export type LlmTextCb = (text: string, questionIndex?: number) => void;
/** AI 本轮播报结束(GPU tts_done)→ 上层关回声抑制窗、恢复收听。
 *  `completed`(design contract,review):本轮是否**正常完整播完**(LLM 流出完 && 全部句 tts_done)。
 *  true = 正常收尾(仅引擎的 maybeFireAiDone/fullyPlayed 路径 + 暂停期已播完的 deferred 兑现);
 *  false = 打断(barge_in/session_end cancel)/ 异常终结(LLM 超时/流错、TTS 超时)——本轮**没有把话说完**。
 *  上层据此决定是否进「等待考生作答」态起沉默钟(只有正常完整播完才进,否则 AI 没说完不该让考生沉默背锅)。
 *  可选实现的引擎不传 → 默认按 true(向后兼容,退化为现状语义)。
 *  ★ design contract:**返回**「客户端估算播完」推进时钟起点(epoch ms,由 media 的 computePlaybackNotBeforeMs 算)——
 *  engine 的 armAnswerGrace 用它把宽限窗 setTimeout 延后到「估算播完后」而非 tts_done 后(治缺陷1 早推进)。
 *  返回 `void`(旧/未接返回值)→ engine 退回现状 ANSWER_GRACE_MS(逐字节等价)。签名不新增 turn 参。 */
export type AiDoneCb = (
  completed?: boolean,
  responseGeneration?: number,
) => number | void;
/** 引擎段每轮 metrics(LLM/TTS 实时性);MediaSession 合并端点段后落库(design contract,旁路 best-effort)。
 *  字段定义见 turn-metrics.ts::EngineTurnMetrics。用 unknown 避免接口循环依赖 turn-metrics。 */
export type EngineMetricsCb = (m: import("./turn-metrics").EngineTurnMetrics) => void;

export interface VoiceEngine {
  /** 起一通会话(注入 system_prompt + 引擎参数)。 */
  start(sessionId: string, systemPrompt: string, params: EngineParams): Promise<void>;
  /** 喂一帧对方入向音频(16k mono s16le PCM)。 */
  pushAudio(pcm: Buffer, inputEpoch?: number, sourceBytes?: number): void;
  /** Reset only uncommitted ASR/VAD input. Resolves after the matching GPU fence. */
  resetInput?(fromInputEpoch: number, nextInputEpoch: number): Promise<void>;
  /** 主动结束当前一轮(VAD 没命中尾静音 / 参与者主动结束发言,如 DTMF):finalize → 触发回复。
   *  默认 VAD 自动端点;此入口供「连续说话不停顿/嘈杂会议 VAD 失灵」时由上层主动推进(design contract)。 */
  endTurn?(identity?: InputIdentity): void;
  /** Realtime 显式 commit。缺 turn id 时实现必须用 GPU 已确认的当前 identity，
   *  不得退化成无身份 flush，避免迟到 commit 误封下一 turn。 */
  commitInput?(inputEpoch: number, inputTurnId?: number): void;
  /** 主动开场(design contract):会话建立后持续静默无人开口时,驱动 AI **据 system_prompt 人设主动开场一次**。
   *  用「空/极短唤醒」触发一轮 LLM,该触发输入 MUST NOT 写入对话历史(避免污染上下文)。
   *  three_stage:跑一轮 runLlmTurn(kickoff,跳过有效字符门槛 + 不写 history)→ TTS 出开场。
   *  可选:未实现的引擎静默到点不开场(回退被动等待)。 */
  kickoff?(): void;
  /** design contract/R3:主动让 AI 说一句**系统指示的话**(如沉默警告「请及时作答」、违规结束前的说明)。
   *  与 kickoff 同构(跑一轮 runLlmTurn,isKickoff-style:跳过有效字符门槛 + 触发输入不写 history、不推进游标),
   *  但 instruction 由调用方给(告诉 AI 该说什么);AI 说出的话正常写 history/转写(考生真听到)。busy(已有活跃轮)
   *  时忽略(不抢占)。**返回是否被接受**(design contract,review):true=已起 notice 轮(其 onAiDone 即通知
   *  播完点);false=busy 被拒/空文本(**没送达**,上层不能就地绑 onAiDone 挂断、须等空闲重试)。可选实现;
   *  未实现的引擎上层视作返回 undefined(按未接受处理:仍可计数/靠硬超时兜底结束,只是没 AI 口播警告)。 */
  nudge?(instruction: string): boolean;
  /** 轮内打断 / 会话级中止(见 CancelReason)。 */
  cancel(reason: CancelReason): void;
  /** 误打断恢复(design contract):tentative-pause —— **暂停出声但不销毁本轮**(MUST NOT abort LLM/reset
   *  sentencizer/gpu.cancel;活跃轮存活)。暂停期收到的 TTS 音频**缓存不下发**;resume 时续发。幂等:
   *  无活跃轮 / 已暂停时 no-op。可选实现(默认关时上层不调用)。 */
  pause?(): void;
  /** 误打断恢复(design contract):resume —— 退出 tentative-pause,续发暂停期缓存的音频;暂停期本轮若已播完则
   *  补触发被 defer 的 onAiDone。幂等:非暂停态 no-op。校验轮身份由引擎内部保证(暂停期不换轮)。 */
  resume?(): void;
  onAudioOut(cb: AudioOutCb): void;
  /** design contract:协议中立的 response generation/segment 生命周期。 */
  onResponseStarted?(cb: ResponseStartedCb): void;
  onResponseSegmentDeclared?(cb: ResponseSegmentDeclaredCb): void;
  onResponseSegmentCompleted?(cb: ResponseSegmentCompletedCb): void;
  onResponseCoreTerminal?(cb: ResponseCoreTerminalCb): void;
  /** Callback-confirmed transports resume listening at server drain while
   *  playback-dependent business settlement remains deferred. */
  onResponseServerDrained?(cb: ResponseServerDrainedCb): void;
  /** callback-confirmed transports defer playback-dependent settlement until
   *  the matching response.done handoff and bounded playback estimate. */
  setResponseWireDrainRequired?(required: boolean): void;
  /** Confirms the protocol terminal handoff for one response generation. */
  noteResponseWireDrained?(responseGeneration: number): void;
  /** design contract:轮媒体起点/终点回调(播放 ACK)。可选实现;未实现/未接 = no-op(逐字节等价现状)。 */
  onTurnAudioBegin?(cb: TurnAudioBoundaryCb): void;
  onTurnAudioEnd?(cb: TurnAudioBoundaryCb): void;
  /** design contract:用户驱动新轮起(runLlmTurn 被接受)回调。media enforce 据此清客户端 ring(supersede)。可选/默认 no-op。 */
  onUserTurnStart?(cb: UserTurnStartCb): void;
  onTranscript(cb: TranscriptCb): void;
  onTurnEvent(cb: TurnEventCb): void;
  /** 引擎错误(GPU error 帧 / LLM 流失败等),供上层记录与收尾,不静默丢弃。 */
  onError(cb: EngineErrorCb): void;
  /** AI 本轮说出的完整文本(LLM 回复;供上层写 speaker=ai 转写,review)。可选实现。 */
  onLlmText?(cb: LlmTextCb): void;
  /** AI 本轮播报结束 → 上层关回声抑制窗、恢复对入向音频的正常监听(修「AI 说完听不到人」)。 */
  onAiDone?(cb: AiDoneCb): void;
  /** 每轮 LLM/TTS 段实时性 metrics(design contract,旁路)。可选(三段式实现,持有 LLM/TTS 全状态);
   *  不实现即不上报。MediaSession 合并端点段后落库,失败只告警。 */
  onMetrics?(cb: EngineMetricsCb): void;
  /** 本轮 LLM 是否判定该结束通话(语义挂断信号,比正则鲁棒)。上层在 onAiDone 时查询,真则主动收尾。
   *  可选(三段式实现);未实现的引擎走正则兜底。 */
  wantsEndCall?(): boolean;
  /** 出题游标:是否还有未问完的预设题目(design contract 考试完成强制判据)= `questions.length>0 && cursor<len`。
   *  media-session 据此拦提前挂断(未问完题不许结束,除非三次坚持逃生阀 / max_duration)。可选(三段式实现);
   *  无题(纯人设对话)/ 已问完 → false;未实现的引擎 → 上层视作 false(不介入挂断)。 */
  hasPendingQuestions?(): boolean;
  /** design contract:这场是不是「有(有效)预设题」= 测评语义(vs 无题 = 自由聊天)。**不随游标推进变化**
   *  (hasPendingQuestions 会随问完转 false;本方法恒定反映「这场有没有题」)。media-session 据此分流挂断硬闸门:
   *  false(自由聊天)→ `blockedByOpenChat` 拦 AI 主动挂(design contract);true(测评)→ 归 `blockedByExam` 现状。
   *  **required**(review):不设可选 + `?? false` 兜底——那会把未实现该方法的引擎默认判成「自由聊天」→
   *  挂断被无条件压制,更危险。当前工厂只产 ThreeStageEngine,加 required 无兼容负担。**同步只读、无副作用**。 */
  hasQuestions(): boolean;
  /** design contract:违规原因句 drain 期由 media-session 置 true → 引擎 turn_end **不自主起新 LLM 轮**
   *  (防 drain 期用户说话 → 新 AI 音频打断正在播的原因句尾)。arm drain 置、drain 完/teardown 清。可选
   *  (三段式实现;未实现的引擎无此语义,drain 期新轮 gap 不适用)。**仅挡未来新轮,不影响当前正在播的轮**。 */
  suppressNewTurns?: boolean;
  /** 出题游标当前数值(design contract:旁路 EOU 判定绑 user turn 时的游标快照,返回时比对判 stale——
   *  「判 QK 未完」的判定若返回时游标已推进到 QK+1 则丢弃,防误暂停下一题)。可选(三段式实现,它持 cursor);
   *  无题/未实现 → undefined(上层视作无游标语境,不做游标 stale 校验)。**只读**。 */
  questionCursor?(): number;
  /** design contract:当前 cursor 指向的题**是否已被判过一次有效作答**(sticky,advanceCursor 随游标重置)。
   *  media 静默兜底据此**互斥**分流:true = 答过了的静默 → R3 善意兜底(先 nudge 问、再推进);false = 从未作答的
   *  静默 → design contract 防作弊轨。**同步只读查询**(不跨层异步旁路,engine 仍是唯一推进者);无题/未实现 → false。 */
  answerSeenForCursor?(): boolean;
  /** design contract:media 静默超时兜底到期 → 服务端主动推进游标 + 自动问下一题(解 review 漏发 [[NEXT]] 且
   *  考生不再开口的死锁)。**仅当 answerSeenForCursor()=true 时由 media 调用**;经 design contract questionVoiced 门。
   *  `cursorEpoch` = media 分流时读的游标(防 TOCTOU:调用间若已被别路径推进则不重推)。返回是否真推进。可选(三段式实现)。 */
  advanceOnSilenceTimeout?(cursorEpoch: number): boolean;
  /** 记一次「考生要求结束」(design contract 三次坚持逃生阀,客户端 end 帧来源);返回是否已达阈值放行。
   *  media-session 收到 end 帧且有未问完题时调用。可选(三段式实现)。 */
  noteEndRequest?(): boolean;
  /** 三次坚持逃生阀是否已放行提前结束(design contract);media-session 回报控制面时据此标 early_exit。可选。 */
  wantsEarlyExit?(): boolean;
  /** ASR 字幕修正上下文(design contract):只读快照,供 media-session 旁路修正 user ASR final 时结合上下文纠错。
   *  返回最近几轮对话 history(user/ai 文本)+ 当前题干(出题游标指向的那道题,**不含参考答案** —— 只帮
   *  判断错字,不让 LLM 顺着答案改写/替答)。可选(三段式实现,它持 history+cursor);未实现 → media-session
   *  仅用当前句修正(退化,质量差)。**只读**:MUST NOT 改动对话路径的 history/cursor。 */
  correctionContext?(): { history: { role: "user" | "assistant"; content: string }[]; question?: string };
  /** 整通结束,释放资源。 */
  stop(): Promise<void>;
}

export const ALL_CANCEL_REASONS: readonly CancelReason[] = [
  "barge_in",
  "session_end",
  "manual_hangup",
  "error",
  "peer_hangup",
  "silence_violation",
  "severe_violation",
] as const;

/** design contract:**违规**强制结束 reason → 回报 `violation_end` 事件(backend 写 failed)。
 *  单一事实源。**不含 peer_hangup**——物理断连虽也 failed,但非违规,走独立 `peer_hangup` 事件(见 index.ts onEnded)。
 *  barge_in 是轮内打断非收尾,不在此列;session_end/manual_hangup/error 走 completed。 */
export const VIOLATION_END_REASONS: readonly CancelReason[] = [
  "silence_violation",
  "severe_violation",
] as const;

/** design contract:收尾 reason → 控制面回报事件名(单一事实源,供 index.ts onEnded 用 + 可单测)。
 *  违规 → violation_end(带 fail_reason);物理断连 → peer_hangup;其余正常收尾 → completed。 */
export function endReasonToEvent(reason: CancelReason): "violation_end" | "peer_hangup" | "completed" {
  if (VIOLATION_END_REASONS.includes(reason)) return "violation_end";
  if (reason === "peer_hangup") return "peer_hangup";
  return "completed";
}
