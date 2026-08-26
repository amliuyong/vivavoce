/**
 * ThreeStageEngine(默认引擎,design contract):ASR/TTS 走 GPU WS,LLM 走 Bedrock。
 *
 * 数据流:
 *   pushAudio(PCM) → GpuClient.sendAudio → GPU ASR
 *   GPU 下行 asr_partial/asr_final → onTranscript;turn_end → 起 Bedrock LLM 流
 *   Bedrock token → Sentencizer 分句 → GpuClient.sendTtsText(逐句)
 *   GPU 下行 tts_audio_meta+PCM → onAudioOut(回发客户端)
 *   cancel(barge_in): abort Bedrock 流 + 丢未播句 + GpuClient.cancel → GPU 停 TTS
 *
 * 打断处置全在 Bridge 一处掌控(停 Bedrock 流 + 停 GPU TTS),与 Nova 引擎对接口等价。
 */
import {
  GpuClient,
  GpuControl,
  GpuTtsSegmentIdentity,
} from "./gpu-client";
import { LlmStreamer, LlmMessage, DEFAULT_LLM_MODEL_ID } from "./bedrock-llm";
import { LlmFallbackEvent } from "./fallback-llm";
import { Sentencizer } from "./sentencizer";
import {
  AudioOutCb,
  CancelReason,
  EngineErrorCb,
  EngineMetricsCb,
  EngineParams,
  InputIdentity,
  LlmTextCb,
  ResponseCoreTerminalCb,
  ResponseIdentity,
  ResponseSegmentCompletedCb,
  ResponseSegmentDeclaredCb,
  ResponseSegmentIdentity,
  ResponseServerDrainedCb,
  ResponseStartedCb,
  TranscriptCb,
  TurnAudioBoundaryCb,
  TurnEventCb,
  UserTurnStartCb,
  VoiceEngine,
} from "./voice-engine";
import {
  EngineTurnMetrics,
  GpuTtsSegmentMetrics,
  TTS_SAMPLE_RATE_HZ,
  TtsCacheState,
} from "./turn-metrics";
import { SpeechTurn } from "./speech-turn";
import { loadTurnHandling } from "./turn-handling";
import { composePrompt, validQuestions, questionVoiced } from "./prompt-compose";
import { QUESTION_CUE_RE } from "./question-cue";
// design contract:业务从 registry 的**冻结快照**读配置(与 /config 端点共读同一份)。
//   SEMANTIC_END 与 media-session 共读同一份 RC.media.semanticEnd(原为两处独立 `!== "0"`)。
import { RC } from "./runtime-config";

// ── 实时性/兜底可调参数(design contract)──
// 引擎级 TTS 超时(P0.4,闭合「永久哑」盲区):发某句 tts_text 后,有界超时内既无 tts_audio_meta
// 也无 tts_done(GPU「只收不回」、一帧音频都没流出)→ 引擎自身终结本轮 + 触发 onAiDone。**必须由引擎持有**,
// 不可依赖媒体面 aiSpeaking 看门狗(后者仅在收到首帧 onAudioOut 后才启动,GPU 一帧不回时恒不启动)。
const TTS_TIMEOUT_MS = RC.engine.ttsTimeoutMs;
// LLM 首 token 超时(P2-9):跨境 mantle 若挂起,undici headersTimeout 默认 ~300s 才报错,期间本轮永久哑。
// 超此窗无首 token → 视为本轮 LLM 失败(abort 流 + 降级本轮失败,不拆机,会话继续)。env 可调;0=禁用。
// ★ 真机实测(deployment validation,EC2 直打 mantle GLM 流式 8 次):首字节 TTFB **剧烈抖动 1.2~9.3s**
//   (跨境 RTT + 模型排队)。旧值 8000ms 会把 TTFB>8s 的正常轮误判超时 → abort → AI 频繁哑
//   (真机日志:cfe7ab0d 场 8 轮里 6 轮 "This operation was aborted",全是本 timer 触发)。
//   放宽到 25000ms:覆盖跨境 GLM TTFB 极限(~9s)+ 充足余量,只在真黑洞(连接死/模型卡)兜底。
const LLM_TTFT_TIMEOUT_MS = RC.engine.llmTtftTimeoutMs;
// cancel_ack 旁路核对超时(P0.2):cancel 发出后未在此窗内收到 GPU cancel_ack → 记 cancel_ack_timeout
// 进 metrics(仅计量,不阻塞新轮、不改通话状态)。GPU WS 内网 RTT 通常 < 20ms,300ms 留 ~15× 余量。
const CANCEL_ACK_TIMEOUT_MS = RC.engine.cancelAckTimeoutMs;

// 拒垃圾输入门槛(design contract):触发一轮 LLM 前,本轮识别文本去标点/空白后的有效字符数 < 此则跳过本轮
// (空/纯标点/单残字不触发 LLM,治门控解除后漏网的单字残识幻觉开场)。默认 2(纳入 TurnHandling,env 可调);
// kickoff 主动开场路径**豁免**(它本就是空/极短唤醒,见 runLlmTurn 的 isKickoff)。模块级解析一次。
const MIN_INPUT_CHARS = loadTurnHandling().meaningfulInput.minChars;
// 主动开场唤醒文本(design contract):极短、人设无关的中性唤醒,仅用来让 LLM 据 system_prompt 自然开场;
// **不写入对话历史**(见 runLlmTurn 的 isKickoff 分支)。env 可调(若某人设对特定唤醒词反应更自然)。
const KICKOFF_WAKE_TEXT = RC.engine.kickoffWakeText;

/** 文本有效字符数(design contract):剥离所有空白与标点(中英)后的剩余字符数。用于「有意义输入」门槛。
 *  纯文本判定,不依赖真人/IVR 声学分类。Unicode 标点用 \p{P}\p{S}(ES2022 + u 标志支持)。 */
function meaningfulCharCount(text: string): number {
  if (!text) return 0;
  // 去空白 + 去标点/符号(Unicode 类),剩余即「有效字符」(中文字/字母/数字等)。
  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, "");
  return [...stripped].length; // 展开成码点数组(正确计中文/emoji 长度,非 UTF-16 code unit)
}

/** 全局正则(/gi)的 .test() 有 lastIndex 副作用(review):每次前置归零,保证无状态判定。
 *  .replace(/g) 本身从 0 扫,不受影响;仅 .test() 需此守护。 */
function hasSentinel(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

// 语义挂断(LLM 判定,比正则鲁棒)。让对话 LLM 在「对话自然结束/对方告别且无进一步需求」时,于回复**末尾**
// 输出哨兵标记;Bridge 流式下发时剥离(不进 TTS、不入历史),据此在本轮播完后主动收尾。复用每轮已有的
// Bedrock 调用,零额外延迟/计费。env AIM_SEMANTIC_END=0 关闭(回退 media-session 正则兜底)。
const SEMANTIC_END = RC.media.semanticEnd;
const END_CALL_MARK = "[[END_CALL]]";
// 剥离正则:容忍 LLM 可能写成 [[END_CALL]] / [END_CALL] / 末尾换行包裹;全局去除,不让任何残形进 TTS。
const END_CALL_RE = /\[+\s*END_CALL\s*\]+/gi;
// 出题推进信号(design contract,与 [[END_CALL]] 同族哨兵):LLM 判定当前题问答收尾时于回复末尾输出 [[NEXT]],
// 作为「可推进游标」的**辅助**提示(非唯一开关:推进仍以服务端判据 a–e 为准)。剥离正则容忍 [[NEXT]]/[NEXT]/
// 换行包裹,全局去除不进 TTS/转写/history。
const NEXT_MARK = "[[NEXT]]";
const NEXT_RE = /\[+\s*NEXT\s*\]+/gi;
const MIN_VERBATIM_QUESTION_CHARS = 6;
// 出题游标推进与题间宽限配置(两分区单一事实源,收口在 turn-handling)。模块级读一次。
const TURN_HANDLING = loadTurnHandling();
const QUESTION_PROGRESSION = TURN_HANDLING.questionProgression;
// design contract:出题游标推进闭环开关(默认关 = 现状开环推进,逐字节等价)。开启后,游标推进除「考生已作答」
// 外还要求「AI 已把当前题独立念出」(questionVoiced 文本语义校验,信号①);同题连续 N 轮未念出兜底强制推进。
const CURSOR_VOICED_GATE = RC.engine.cursorVoicedGate;
// 兜底:同题连续这么多轮仍未置「已念出」→ fallback 现状推进(防 barge-in 误判等异常致永久卡在一题)。默认 2。
const CURSOR_VOICED_MAX_STALL = RC.engine.cursorVoicedMaxStall;
// design contract 独立卡死兜底:排水陈货连续判「不驱动推进」达此轮数 → 强制推进(防考生沉默时永久卡当前题)。
// **不复用 voicedStall**——voicedStall 只在「未念出」计,而陈货态是「已念出 + 作答是陈货」,voicedStall 计不到
// (review)。默认 2。
const STALE_ANSWER_MAX = RC.engine.staleAnswerMax;
// design contract:答完补充宽限窗(延迟推进)。判「当前题正常已作答、该推进」时**不立即** advanceCursor,先启一个
//   静默宽限窗:窗内用户再开口 → 取消推进、当本题续答;窗内无声 → 到期才 advanceCursor + 自动问下一题。
//   目的:别误伤「边想边答/答完还想补充」的用户(部署回归:短答被 2 分钟连推 5 题)。
//   **仅包 advanceIfVoiced 判定的正常推进**;拒答/告别/防死循环/追问上限/staleAnswerStall 兜底的**强制推进**
//   不经宽限窗(立即推进,不拖延)。默认 4000ms;**<=0 = 关(逐字节等价现状:直接立即 advanceCursor + autoNext)**。
//   [[cdk-env-passthrough-gap]]:新 flag 必须在 aim-stack.ts RealtimeSession environment 条件透传否则 deploy 静默不生效。
const ANSWER_GRACE_MS = TURN_HANDLING.answerGrace.defaultMs;
// direct auto-next 在上一句估算播完后仍保留的最小补充窗；总截止线同时受 ANSWER_GRACE_MS 保护。
const AUTO_NEXT_GRACE_MS = TURN_HANDLING.answerGrace.autoNextMs;
// 拒答意图(design contract 判据 d 的 SHOULD):对方明确表示「不会/跳过/下一题/不知道…」→ 视作「已尝试作答」
// 直接推进(evaluator 据空作答判不通过),不卡到 retry 上限。**只匹配整句都是拒答/放弃的措辞**;该判定为兼容
// 长拒答而位于 answered 分支之前,所以必须做全句锚定,不能让答案正文里的「不会生成/不知道某字段」误命中。
// ★ 收窄(review 前置自查):**剔除裸「过」**(误伤「说过了/学过/难过」等短答)与裸「pass/next」(英文短答易撞);
//   跳过类要求带「题/问题/这个/吧」等明确宾语(「跳过」保留,「过」不留);中文拒答短语已足够覆盖真机场景。
// ★ design contract(考试完成强制):告别/结束意图(拜拜/挂了/不做了/结束/我要走…)也纳入 —— 考试语义下「想走」=
//   放弃当前题,应**强制推进**到下一题继续(而非死锁干等)。这仅在**有未问完题 + 未有效作答**分支参考;
//   无题会话 maybeAdvanceCursor 早 return 不受影响。与「压制 [[END_CALL]] 不挂断」配合:想走→推进下一题→AI 继续问。
const DECLINE_RE =
  /^(?:(?:这(?:一)?(?:题|个问题))?(?:我)?(?:真的)?(?:不会|不知道|不太懂|没学过|没接触过|答不上来?|不清楚|想不起(?:来)?)(?:怎么)?(?:回答)?(?:这(?:一)?(?:题|个问题))?|跳过(?:这(?:一)?(?:题|个问题))?|(?:这(?:一)?(?:题|个问题))跳过|下一[题个]|换一?[题个])(?:了|啊|呀|呢|吧)?$|^(?:i\s+)?(?:have\s+)?(?:no\s*idea|don'?t\s+know)(?:\s+(?:this|the)\s+(?:answer|question))?$/i;
function isDeclineIntent(text: string): boolean {
  const normalized = (text ?? "").trim().replace(/[，。,.!?！？~～]+$/gu, "").trim();
  return DECLINE_RE.test(normalized);
}
// 告别/提前结束意图(design contract):无歧义的「想结束/想走」措辞。用于考试完成强制下把「想走」当放弃当前题强制推进。
// 收窄避免误伤:要求明确的结束/告别词,不匹配裸字。
const FAREWELL_INTENT_RE = /(拜拜|再见|挂了|挂断|结束吧|结束通话|不想(做|考|继续)|不做了|不考了|我要走|我得走|先这样|到此为止|退出|bye)/i;
// design contract:END_CALL_DIRECTIVE 改 **mode-aware**(不再靠"后注入压过前注入"的涌现行为——review:
//   本指令在 start() 后追加、recency 高于 composeSessionPrompt 的 openChatDirective,若不 mode-aware,自由聊天里
//   (1)条"感觉话题自然收尾就确认"仍会诱导 AI 主动收尾)。两个变体的**两步确认门控 (2)-(5) 完全一致**,只差 (1):
//   - 有题变体:(1) 允许 AI「感觉对话要结束/话题自然收尾」时主动发起确认(测评问完后需能自然收尾)。
//   - 无题变体:(1) 删除主动性——**只有对方明确表示要走/结束时**才发起确认;自由聊天里 AI 不主动判断对话该不该结束。
const END_CALL_STEPS_COMMON =
  `(2)只有在你**已经问过上面这句确认**、且对方在**下一轮**明确表示不用了/可以挂了/再见(或只回应告别无新需求)时,才在该轮回复的最后另起一行只输出 ${END_CALL_MARK}。` +
  "(3)若对方在你确认后仍提出新问题、继续聊、或说「先别挂/还没说完/不是要走」,**绝不**输出该标记,继续正常对话。" +
  `(4)**已确认过一次后不要反复确认**:若你上一轮已问过确认,而对方只回应「没有了/嗯/好的/没事了」或简短告别、或没有提出任何新需求,就**直接**输出 ${END_CALL_MARK} 收尾,不要再问第二遍。` +
  "(5)**任何情况下,没问过确认就不许输出结束标记。** 该标记仅为系统信号,不要在别处提及或读出来。";
const END_CALL_DIRECTIVE_EXAM =
  "\n\n【结束通话——两步确认,绝不擅自挂断】挂断电话前**必须先口头向对方确认**,不允许自己直接挂。规则:" +
  "(1)当你**感觉**对话可能要结束(对方说「没有了/就这样/我要去忙了/差不多了」,或话题自然收尾)时," +
  "**先用一句话确认**,例如「好的~还有其他需要我帮忙的吗?如果没有的话,我就先挂啦」,并**正常结束本轮、不要输出任何结束标记**。" +
  END_CALL_STEPS_COMMON;
const END_CALL_DIRECTIVE_OPEN_CHAT =
  "\n\n【结束通话——两步确认,绝不擅自挂断】这是开放式的自由交流,**你绝不主动发起结束**——不要因为「感觉聊得差不多了/" +
  "没有更多话题了」就说要挂。挂断前**必须先口头向对方确认**,不允许自己直接挂。规则:" +
  "(1)**只有当对方明确表示**要走/要结束/不想聊了/主动告别(如「我要走了/不聊了/拜拜」)时,才**先用一句话确认**," +
  "例如「好的~那你先忙,还有其他想聊的吗?没有的话我就先不打扰啦」,并**正常结束本轮、不要输出任何结束标记**;" +
  "对方没有明确要走时,你**继续自然地陪对方聊下去**,不要提结束。" +
  END_CALL_STEPS_COMMON;

export class ThreeStageEngine implements VoiceEngine {
  private audioOutCb: AudioOutCb = () => {};
  private responseStartedCb: ResponseStartedCb = () => {};
  private responseSegmentDeclaredCb: ResponseSegmentDeclaredCb = () => {};
  private responseSegmentCompletedCb: ResponseSegmentCompletedCb = () => {};
  private responseCoreTerminalCb: ResponseCoreTerminalCb = () => {};
  // design contract:轮媒体边界回调(播放 ACK)。默认 no-op → 逐字节等价现状(Phase 4 media 订阅后才产生 wire 效果)。
  private turnAudioBeginCb: TurnAudioBoundaryCb = () => {};
  private turnAudioEndCb: TurnAudioBoundaryCb = () => {};
  // design contract:用户驱动新轮起回调(media enforce 据此清客户端 ring)。默认 no-op。
  private userTurnStartCb: UserTurnStartCb = () => {};
  private transcriptCb: TranscriptCb = () => {};
  private turnCb: TurnEventCb = () => {};
  private sentencizer = new Sentencizer();
  private systemPrompt = "";
  private params: EngineParams | null = null;
  private sessionId = ""; // 仅用于日志定位(多通并发时区分哪通哪轮)
  private inputEpoch = 0;

  // ── 出题游标(design contract「出题游标由服务端强推进」)──
  // questions = 控制面固化的有效题目数组(validQuestions 过滤后);cursor = 当前应问题的下标(0-based)。
  // 每轮 runLlmTurn 据 cursor 用 composePrompt(persona, questions, cursor) **逐题注入**(LLM 看不到未问的题,
  // 顺序由代码保证)。cursor ≥ questions.length = 全部问完(不再注入新题,AI 自然收尾)。空 questions = 纯人设
  // 对话(无游标)。cursor 是**实时层瞬态**:进程重启/重连即从 0 重来(M1 从头重问,design contract;断点恢复留 M2)。
  private questions: unknown[] = [];
  private cursor = 0;
  // 判据 (d) 防死循环:同一题(cursor 未变)因输入无效/澄清未完成而重问的累计次数;达上限强制推进。
  private retryOnCurrent = 0;
  // design contract:当前题已完整交付的 AI 追问数。与无效输入 retry 独立,推进时清零。
  private followUpCountForCursor = 0;
  // design contract:当前 cursor 指向的题**是否已被判过一次有效作答**(sticky:一旦置 true 保持到 advanceCursor 重置)。
  //   media 侧静默兜底据此**互斥**分流(答过了的静默 → R3 善意兜底;从未作答的静默 → design contract 防作弊)。
  //   单一事实源在 engine(推进/游标/作答判定都在此层),media 经 answerSeenForCursor() 同步查询,不跨层异步旁路(design contract 教训)。
  private answerSeenForCursor_ = false;
  // design contract 信号①:当前 cursor 指向的题是否已被 AI 独立念出(questionVoiced 判)。advanceCursor 重置为 false
  //   (新题未念);commitAiText 里 AI 输出文本含当前题语义时置 true。闭环开启时,推进除「已作答」外还要求此为 true。
  private cursorVoiced = false;
  // design contract 重复出题纠偏:不同于 cursorVoiced 的 30% 关键词近似,这里只记录题干逐字完整下发且该轮正常完成。
  private cursorQuestionVerbatimVoiced = false;
  // tts_done 只代表服务端排水。题干逐字下发后保存 media 返回的客户端估算播放终点(扣除保护 margin);
  // 在该点前收到用户 speech 即证明题干在客户端被打断，撤销 verbatim 证据，直到题干重新完整交付。
  private cursorQuestionPlaybackEndMs = 0;
  private cursorQuestionPlaybackInterrupted = false;
  // design contract F5 兜底:同题连续「已作答但因未念出被挡下」的轮数;达 CURSOR_VOICED_MAX_STALL → fallback 强制推进。
  private voicedStall = 0;
  // design contract:忙时排水悬挂输入 lastFinalText 的**捕获时游标身份 + 当前题 voiced 快照**双锚(与 lastFinalText 同
  //   写同清)。排水消费时判时序资格:capturedCursor < 现 cursor,或(== 现 cursor 且 capturedVoiced=false 即
  //   捕获时当前题尚未念出)→ 跨题界/念出前陈货 → 起 verify 轮回应但 cursorAdvanceEligible=false 不驱动推进。
  //   -1 = 无悬挂(哨兵,避免与合法 cursor 0 混淆)。
  private pendingDrainCursor = -1;
  private pendingDrainVoiced = false;
  // design contract 独立卡死兜底:排水陈货连续「不驱动推进」的轮数;达 STALE_ANSWER_MAX → 强制推进(不借 voicedStall)。
  private staleAnswerStall = 0;
  // ★ design contract 评审 Blocker(review):user 转写题号须在**用户开口那一刻**(首个 asr_partial)捕获,不能等 asr_final——
  //   否则「开口(cursor=0)→ asr_partial → 上一轮 AI 完成推进 cursor=1 → asr_final」时,asr_final 读到已推进的 1,
  //   Q1 的用户答案被误标 Q2。故首个 asr_partial 捕获存此,asr_final 用已捕获值,turn_end 清(下一句语音轮重捕获)。
  //   undefined = 本语音轮尚未捕获(asr_final 若无 partial 前导则在 final 时兜底捕获)。
  private pendingUserQuestionIndex: number | undefined = undefined;
  private userQuestionIndexCaptured = false; // 区分「捕获了 undefined(越界)」vs「尚未捕获」
  // ── design contract:答完补充宽限窗(延迟推进)──
  //   maybeAdvanceCursor 的正常推进分支(advanceIfVoiced 放行那条)不再立即 advanceCursor,而是**记意图**:
  //   置 pendingAdvance=true(+ 存 nextHint 供日志/未来扩展),返回 advanced:false。真正 armAnswerGrace() 在
  //   fireAiDone **越过 pause defer、清 activeTurn 之后**才调用(§1 时序契约:避免 pause 期早推进丢 auto-next)。
  private pendingAdvance = false;
  // 宽限窗代次(单调递增,防迟到 timer):armAnswerGrace 时不变,cancelAnswerGrace/arm 后有新 speech 时 ++。
  //   fireAnswerGrace() 回调入口比对 armGen——不一致(arm 后代次已变)= 期间被取消/有新 speech → 作废不推进。
  private graceGen = 0;
  private answerGraceTimer: ReturnType<typeof setTimeout> | null = null;
  // 记意图时暂存的 nextHint(仅日志/诊断;推进本身由 fireAnswerGrace 到期时 advanceCursor 兑现)。
  private pendingAdvanceNextHint = false;
  private armedAnswerGraceDelayMs = 0;
  // ★ design contract 评审 Major 4(review):stale 兜底放行属「强推」语义(§7 强推不经窗),但它经 runLlmTurn
  //   恢复 eligible 后仍会走 advanceIfVoiced 正常放行分支→再入 grace 多等 4s。置此一次性标志令**该轮**推进
  //   立即兑现不进窗;advanceIfVoiced 正常放行分支消费后即清(仅作用于紧随的那一轮)。
  private bypassGraceOnce = false;
  // 判据 (e) 辅助信号:本轮 LLM 是否输出了 [[NEXT]](收尾时置,推进评估后清)。留引擎级(与 endCallSignaled 同,
  // 供 maybeAdvanceCursor 在 onAiDone 后读)。
  private nextSignaled = false;
  // design contract:推进后的持久 continuation。auto-next 与末题收尾都不能因瞬时 busy/pause 丢失。
  private pendingAutoNext = false;
  private terminalCompletionState: "idle" | "pending" | "in_flight" | "delivered" | "failed" = "idle";
  private terminalCompletionRetryCount = 0;
  // terminal TTS drain 期的用户接管必须等 GPU cancel 落地后再起新轮，期间保持 interrupted 丢弃旧残音。
  private pendingTerminalTakeoverText = "";
  private terminalTakeoverTimer: NodeJS.Timeout | null = null;

  // ── SpeechTurn 生命周期对象(design contract)──:把此前散落的轮级状态(llmBusy / abort / ttsPending /
  //    llmStreamComplete + metrics 累加器)收敛为单一对象。`activeTurn` 存活于**播报生命周期**(runLlmTurn
  //    起 → onAiDone 触发);`turn.llmReturned` 标记 LLM 执行子周期结束(= 旧 llmBusy 清零时机,**早于** TTS
  //    drain)。不变量见 speech-turn.ts:至多一活跃轮 / 身份守尾 / onAiDone 恰好一次。
  //    注:endCallSignaled **故意不收进 SpeechTurn**、留引擎级(见下方 this.endCallSignaled 声明,design contract)。
  private activeTurn: SpeechTurn | null = null;
  private responseWireDrainRequired = false;
  private pendingResponseSettlement: {
    turn: SpeechTurn;
    completed: boolean;
    phase: "wire" | "playback";
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private turnSeq: number; // 引擎权威 ai_turn_id；连接内单调，连接间使用独立高熵区间。
  private readonly maxTurnSeq: number;
  // busy 守门:常规轮守 LLM 执行子周期；direct auto-next 无 LLM，但须守到 TTS 完成，防 turn_end 替换
  // activeTurn 后旧 tts_done 误结算新轮。新 turn_end 见 busy 则悬挂输入、不抢占。
  private get llmBusy(): boolean {
    const turn = this.activeTurn;
    return (
      this.pendingResponseSettlement?.phase === "wire" ||
      (turn !== null &&
        (!turn.llmReturned || (turn.isDirectAutoNext && !turn.aiDoneFired)))
    );
  }
  // barge-in 残音守卫(B7 option ②,对齐 Nova 的 interrupted):cancel(barge_in) 后,GPU 接收队列里
  // 已发出的 tts_text 仍会合成回传 → 若直接 onAudioOut 会让被打断的 AI 余音回灌会议 + 把 aiSpeaking 卡 true。
  // 故 cancel 后丢弃 onAudioOut,直到下一轮 turn_end(新一轮开始)才恢复。这是**轮边界**守卫(空 turn_end 也清),
  // 故留在引擎级、不随单个 SpeechTurn 走。
  private interrupted = false;

  // ── 误打断恢复(design contract):tentative-pause 状态 ──:paused 期间 GPU 下行 TTS 音频**缓存不下发**
  //   (不 abort LLM / 不 reset sentencizer / 不 gpu.cancel;活跃轮存活),resume 时续发。与 interrupted
  //   (销毁语义,丢弃残音)互斥:pause 是可恢复暂停。pausedTurn 记暂停时的活跃轮(身份守尾:resume 只对
  //   同一轮生效);deferredAiDoneTurn = 暂停期本轮已播完、被 defer 的 onAiDone(resume 时补触发)。
  private paused = false;
  private pausedTurn: SpeechTurn | null = null;
  private pausedAudioBuffer: Array<{ pcm: Buffer; identity: ResponseSegmentIdentity }> = [];
  private deferredAiDoneTurn: SpeechTurn | null = null;
  // design contract(评审 三审自检):defer 时**保存原始 completed 值**,兑现时按原值传——否则若一个失败轮
  //   (LLM 流错/超时,completed=false;pause 不 abort LLM,失败轮可在暂停期到达 fireAiDone)在暂停期被 defer,
  //   兑现时硬编码 true 会把「没说完的失败轮」误报成「正常播完」→ media-session 误进等待作答态起沉默钟。
  private deferredAiDoneCompleted = false;

  // 本轮 LLM 是否输出了结束信号(语义挂断):LLM 据语义判定,于回复末尾输出哨兵 END_CALL_MARK。
  // 留在引擎级(非随 SpeechTurn):media-session 在 onAiDone **之后**才 wantsEndCall() 查询,彼时 activeTurn
  // 可能已被清空(cancel 路径)——故由引擎持有,跨「轮对象生命周期」可读。被打断时 cancel() 清,新轮 runLlmTurn 起时不重置
  // (上一轮已读走),仅在 LLM 出完含哨兵时置 true。
  private endCallSignaled = false;

  // 考试完成强制三次坚持逃生阀(design contract):有未问完题时 [[END_CALL]] 被压制(不挂),但每次压制计一次
  // 「考生要求结束」。累计达阈值 → 下次不再压制、放行结束(人道后门:真遇急事不必困到 max_duration)。
  // 会话级累计,不随轮/推进清零。放行时 earlyExit=true(供 wantsEarlyExit 供 media-session 回报 evaluator 知晓早退)。
  private endRequestCount = 0;
  private earlyExitAllowed = false;
  private static readonly END_REQUEST_ESCAPE_THRESHOLD = 3;

  // ── 每轮实时性 metrics(design contract,旁路)──
  private metricsCb: EngineMetricsCb = () => {};
  // GPU telemetry may arrive after tts_done/cancel has already reported the
  // turn. Keep a bounded turn/record cache so late fields can overwrite the
  // same metric#turn with a complete record.
  private readonly recentTurns = new Map<number, SpeechTurn>();
  private readonly metricRecordsByTurn = new Map<number, EngineTurnMetrics>();

  // ── 引擎级 TTS 超时(P0.4)──:发 tts_text 后限时等任一 TTS 下行信号(tts_audio_meta/tts_done);
  // 收到即解除(改由媒体面 aiSpeaking 看门狗兜底「出过音频中途停」);从未收到 → onTtsTimeout 自终结本轮。
  private ttsWatchdog: ReturnType<typeof setTimeout> | null = null;
  private ttsSignalSeen = false; // 本轮是否已收到任一 TTS 下行信号(收到即不再 arm)

  // ── cancel_ack 旁路核对(P0.2)──:barge_in cancel 后延迟落库,等 cancel_ack 解析/超时填 cancel_ack_timeout。
  private cancelAck: { timer: ReturnType<typeof setTimeout>; metric: EngineTurnMetrics } | null = null;

  constructor(
    private gpu: GpuClient,
    private llm: LlmStreamer,
    private readonly aiTurnIdBase = 0,
  ) {
    if (
      !Number.isSafeInteger(aiTurnIdBase) ||
      aiTurnIdBase < 0 ||
      aiTurnIdBase > Number.MAX_SAFE_INTEGER - 65_535
    ) {
      throw new Error("aiTurnIdBase must reserve a JSON-safe 16-bit turn range");
    }
    this.turnSeq = aiTurnIdBase;
    this.maxTurnSeq = aiTurnIdBase + 65_535;
    // design contract:LLM 主备 fallback 切换回调(若底层是 FallbackLlmStreamer)→ 记到当前活跃轮,随本轮 metrics
    //   落库(降级率分析)。用鸭子类型探测 onFallback(不硬依赖具体类,单测注入的裸 streamer 无此方法即跳过)。
    const fb = this.llm as unknown as { onFallback?: (cb: (ev: LlmFallbackEvent) => void) => void };
    if (typeof fb.onFallback === "function") {
      fb.onFallback((ev) => {
        const t = this.activeTurn;
        if (t) {
          t.llmFallback = true;
          t.llmModelUsed = ev.toModel; // 切到的备用模型(可能再切,取最后一次的 toModel)
        }
      });
    }
    this.gpu.onControl((msg) => this.onGpuControl(msg));
    this.gpu.onAudio((meta, pcm) => {
      const identity = this.gpuTtsIdentity(meta);
      const t = this.activeTurn;
      if (!identity) {
        // Legacy v1 has no segment identity, so preserve its existing
        // watchdog semantics.
        this.noteTtsSignal();
        if (this.interrupted) return; // 被打断:丢弃在途残音,不回灌(B7)
        // 旧 v1 对无活跃轮的 GPU PCM 仍逐帧透传；design contract adapter 会拒绝缺 identity 的 stale 帧。
        this.audioOutCb(pcm);
        return;
      }
      if (this.interrupted) return; // 被打断:丢弃在途残音,不回灌(B7)
      const segment = t?.currentSegment();
      if (
        !t ||
        !segment ||
        identity.responseGeneration !== t.index ||
        identity.turnSeq !== t.index ||
        identity.segmentId !== segment.segmentId
      ) {
        // Preserve the producer identity so MediaSession can retire stale
        // generations before they enter the output resampler.
        this.audioOutCb(pcm, identity);
        return;
      }
      // Only the active segment may disarm the current turn's watchdog.
      this.noteTtsSignal();
      // metrics:首音频帧时延 + 累计合成字节(被打断的残音不计,故在 interrupted 守卫之后)。
      if (t.firstAudioAt === 0) t.firstAudioAt = Date.now();
      t.ttsAudioBytes += pcm.length;
      // 误打断恢复(design contract):tentative-pause 期间**缓存音频不下发**(不销毁,resume 时续发)。
      // firstAudioAt/ttsAudioBytes 仍在暂停前记(上面),使 metrics 口径不变;仅出声被 defer。
      if (this.paused) {
        this.pausedAudioBuffer.push({ pcm, identity });
        return;
      }
      this.sendTurnAudio(t, pcm, identity); // design contract:发前补 onTurnAudioBegin(每轮一次),再 audioOutCb
    });
    // N2:GPU 连接级错误(WS 拒连/意外断流)→ 上报上层收尾,否则 AI 静默死、电话空挂。
    this.gpu.onConnError((code, message) => this.errorCb(code, message));
  }

  async start(sessionId: string, systemPrompt: string, params: EngineParams): Promise<void> {
    this.sessionId = sessionId;
    this.params = params;
    // 出题游标(design contract):固化题目 = validQuestions 过滤后的有效题(剔除非对象/空题干);cursor 从 0 起。
    // 空 = 纯人设对话(composePrompt 无题时退回纯人设,无游标)。systemPrompt 只含人设 + 语言/语气/时间指令,
    // 题目由引擎逐题注入(runLlmTurn 里 composePrompt(this.systemPrompt, this.questions, this.cursor))。
    // ★ 先算有效题(供下方 mode-aware END_CALL_DIRECTIVE 选择),再拼 systemPrompt。
    this.questions = validQuestions(params.questions ?? []);
    // 语义挂断:把结束信号指令追加到 system prompt(LLM 据语义在回复末尾输出哨兵)。
    // design contract:mode-aware——有(有效)题=测评变体(允许 AI 感觉收尾时确认);无题=自由聊天变体(只有对方明确要走才确认,
    //   AI 绝不主动发起结束)。不靠"后注入压过前注入"的涌现行为(review)。
    if (SEMANTIC_END) {
      const endCallDirective = this.questions.length > 0 ? END_CALL_DIRECTIVE_EXAM : END_CALL_DIRECTIVE_OPEN_CHAT;
      this.systemPrompt = systemPrompt + endCallDirective;
    } else {
      this.systemPrompt = systemPrompt;
    }
    this.cursor = 0;
    this.retryOnCurrent = 0;
    this.followUpCountForCursor = 0;
    this.answerSeenForCursor_ = false; // design contract:新会话第 1 题尚未作答
    this.cursorVoiced = false; // design contract:新会话第 1 题尚未念出(由开场 kickoff 念出后置位,F3 seed)
    this.cursorQuestionVerbatimVoiced = false;
    this.cursorQuestionPlaybackEndMs = 0;
    this.cursorQuestionPlaybackInterrupted = false;
    this.voicedStall = 0;
    // 幂等重置(design contract(c) 防御):真机 M1 重连**换新引擎实例**(index.ts createEngine),此路径天然干净;
    //   但 start() 被二次调用时(未来若复用实例)MUST 清上一场残留的轮级/会话级状态,否则残留 activeTurn
    //   会让重连后首个 turn_end 撞 llmBusy 被忽略(AI 卡死)、残留 history/interrupted 污染新场。深度防御,零成本。
    if (this.activeTurn) this.activeTurn.abort.abort();
    this.activeTurn = null;
    this.clearPendingResponseSettlement();
    this.interrupted = false;
    this.paused = false;
    this.pausedTurn = null;
    this.pausedAudioBuffer = [];
    this.deferredAiDoneTurn = null;
    this.endCallSignaled = false;
    this.nextSignaled = false;
    this.pendingAutoNext = false;
    this.terminalCompletionState = "idle";
    this.terminalCompletionRetryCount = 0;
    this.clearTerminalTakeoverTimer();
    this.pendingTerminalTakeoverText = "";
    this.lastFinalText = "";
    this.pendingDrainCursor = -1; // design contract:新会话清悬挂快照
    this.pendingDrainVoiced = false;
    this.staleAnswerStall = 0;
    // design contract:清补充宽限窗残留(二次 start 复用实例时,残留 timer/pendingAdvance 会污染新场)。
    this.clearAnswerGraceTimer();
    this.graceGen += 1; // 作废上一场任何在途 grace timer(迟到回调入口比对失败即作废)
    this.pendingAdvance = false;
    this.pendingAdvanceNextHint = false;
    this.armedAnswerGraceDelayMs = 0;
    this.bypassGraceOnce = false; // design contract Major 4:二次 start 清一次性强推标志
    this.userQuestionIndexCaptured = false; // design contract:二次 start 清 user 题号捕获态
    this.pendingUserQuestionIndex = undefined;
    this.inputEpoch = 0;
    this.history = [];
    this.sentencizer.reset();
    this.clearTtsWatchdog();
    this.clearCancelAck();
    this.recentTurns.clear();
    this.metricRecordsByTurn.clear();
    if (this.questions.length > 0) {
      console.log(`[3stage ${sessionId}] 出题游标启用:${this.questions.length} 题,逐题注入(design contract)`);
    }
    this.gpu.start({
      engine_type: params.engineType,
      language: params.language,
      // voice = 语义音色 key(male_std/female_std…);GPU 据此 voice clone 锁声纹。缺省时不下发,GPU 回退默认参考音。
      ...(params.voice ? { voice: params.voice } : {}),
      // tts_provider(design contract):纯透传,GPU 据此选 TtsEngine(gpu_omnivoice|minimax)。缺省不下发,GPU 回退默认。
      ...(params.ttsProvider ? { tts_provider: params.ttsProvider } : {}),
    });
  }

  pushAudio(
    pcm: Buffer,
    inputEpoch = this.inputEpoch,
    sourceBytes?: number,
  ): void {
    if (inputEpoch !== this.inputEpoch) {
      throw new Error(`stale input epoch ${inputEpoch}; current epoch is ${this.inputEpoch}`);
    }
    this.gpu.sendAudio(pcm, inputEpoch, sourceBytes);
  }

  async resetInput(fromInputEpoch: number, nextInputEpoch: number): Promise<void> {
    if (fromInputEpoch !== this.inputEpoch || nextInputEpoch !== this.inputEpoch + 1) {
      throw new Error(
        `invalid input reset ${fromInputEpoch}->${nextInputEpoch}; current epoch is ${this.inputEpoch}`,
      );
    }
    await this.gpu.resetInput(fromInputEpoch, nextInputEpoch);
    this.inputEpoch = nextInputEpoch;
  }

  cancel(reason: CancelReason): void {
    // B7(barge-in 残音耦合)已接 option ②:cancel(尤其 barge_in)后,GPU 接收队列里已发出的 tts_text
    //   仍会合成回传,若直接 onAudioOut 会让被打断的 AI 余音回灌 + aiSpeaking 卡 true。故置 interrupted
    //   丢弃在途残音,直到下一轮 turn_end 恢复(见 constructor 的 onAudio 守卫 + turn_end 清 interrupted)。
    this.interrupted = true;
    if (reason !== "barge_in") {
      this.clearTerminalTakeoverTimer();
      this.pendingTerminalTakeoverText = "";
    }
    // 误打断恢复(design contract):确认打断 → 清 tentative-pause 状态(丢缓存音频、不再 resume)。销毁语义优先于暂停。
    // ★ design contract:先快照 deferredAiDoneTurn —— 若本轮在暂停期内已**完整播完**(fireAiDone 进过 defer 分支、
    //   只欠一次 onAiDone),清空暂停状态会永久丢弃它的完成回调(退出 tentative-pause 此前只有 resume 会兑现)。
    //   在函数末尾(paused 已清 → fireAiDone 不再 defer;endCallSignaled/nextSignaled 已清 → wantsEndCall 不误挂断;
    //   interrupted=true → design contract 排水被跳过)对它补触发 fireAiDone,兑现 aiDoneCb(media-session 收尾记账)。
    // ★ design contract(退出矩阵):cancel **丢弃暂停缓存**(不续发)→ 兑现 completed=**false**(不读原始 deferredCompleted)。
    //   cancel = 确认打断 / 收尾,本轮没「完整交付给对方」→ 不推进、不启 waiting(治 review:此前传原始 true 会让
    //   media 进 waitingForAnswer 起沉默钟)。仅 resume(真续发完缓存)保留原始 completed(见 resume())。
    const deferred = this.deferredAiDoneTurn;
    this.clearPendingResponseSettlement();
    this.paused = false;
    this.pausedTurn = null;
    this.pausedAudioBuffer = [];
    this.deferredAiDoneTurn = null;
    const turn = this.activeTurn;
    if (turn?.isTerminalCompletion) {
      // 用户接管保留收尾意图,由接管后的用户轮消费;会话销毁则停止调度。
      this.terminalCompletionState = reason === "barge_in" ? "pending" : "delivered";
    }
    // 1) 停 Bedrock LLM 流 + 终结活跃轮(身份换走):activeTurn 置 null,旧轮 finally 见 this.activeTurn !== turn
    //    便知已被抢占、不再动状态;busy 守门随 activeTurn=null 立即释放。
    this.activeTurn = null;
    if (turn) turn.abort.abort();
    // ★ 打断后上下文对齐(design contract):**仅 barge_in**(用户主动打断)时,把本轮**已下发**的部分(≈ 用户实际
    //   听到的)+ 截断标记写进 history/转写,取代正常流末的完整 fullText(此刻 abort 已让正常写入块被 signal.aborted
    //   跳过、historyWritten 仍 false)。这样 AI 后续轮不会引用用户没听到的后半段。
    //   收尾类 cancel(session_end/error/manual_hangup)不加截断标记(那不是「用户听了一半」语义,是整通结束)。
    //   已下发为空(一句没发就被打断)则不写(无「听到的内容」);正常流已写过(historyWritten)则不覆盖。
    if (turn && reason === "barge_in" && !turn.historyWritten && turn.dispatchedText.trim()) {
      const truncated = `${this.stripSentinels(turn.dispatchedText)} [被打断]`;
      this.commitAiText(turn, truncated, turn.isKickoff, turn.userText);
    }
    // 2) 丢弃未播句子
    this.sentencizer.reset();
    // 3) 让 GPU 停当前 TTS
    this.gpu.cancel(reason);
    // ★ 语义挂断竞态(review):被打断的告别轮作废 —— 用户在 AI 说「拜拜」时插话,说明他想**继续**,
    //   绝不能挂。清掉本轮的 endCallSignaled,否则下面 aiDoneCb()→media-session.wantsEndCall() 会读到
    //   残留信号误挂电话(打断「拜拜」反而被挂)。
    this.endCallSignaled = false;
    // 出题游标(design contract 判据 a):被打断的轮**不推进游标**(题未问完/对方插话中断)。cancel 走 fireAiDone
    //   直达、不经 maybeFireAiDone,故游标本就不推进;此处仅清本轮遗留的 [[NEXT]] 辅助信号,避免污染下一轮评估。
    this.nextSignaled = false;
    // 引擎级 TTS 超时:本轮已被 cancel 终结,撤销超时看门狗(否则可能误触发下一笔)。
    this.clearTtsWatchdog();
    // ★ design contract(§4/§8):barge-in/确认打断/收尾(session_end/manual_hangup/error)→ 清补充宽限窗、
    //   **不兑现推进**(打断=用户接管;结束=收尾)。graceGen++ 作废任何在途 timer(stop 经 cancel("session_end")
    //   走此路径,故 max_duration backstop 收尾亦覆盖)。
    this.cancelAnswerGrace();
    // ★ design contract:兑现暂停期内已完整播完、被 defer 的 onAiDone(独立于下面半途轮 partial 分支)。
    //   此处 paused 已清(上面)→ fireAiDone 不再走 defer 分支;endCallSignaled/nextSignaled 已清(上面 298/301)
    //   → aiDoneCb→wantsEndCall() 不会读残留告别信号误挂断(review);interrupted=true → 不误触发
    //   design contract 忙时排水(review)。**metrics**:deferred 轮的 full metrics 由 fireAiDone 内上报
    //   (design contract 起——不再在 maybeFireAiDone;deferred 轮 ttsPending===0、fullyPlayed 才会进 defer,故此处
    //   兑现 fireAiDone 时以 full 口径上报一次,metricsReported 守卫防重复)。
    //   与下面 `ttsPending > 0` 半途轮分支互斥:deferred 轮 ttsPending===0,半途轮 deferred 为空(未进 defer)。
    //   autoNextAfterDone 会被 fireAiDone 消费,但 interrupted=true 使 maybeAutoAskNext 放弃发起——预期让位
    //   (用户已接管,不抢话问下一题),非缺陷。
    if (deferred && !deferred.aiDoneFired) {
      this.fireAiDone(deferred, false); // design contract 退出矩阵:cancel 丢缓存 → completed=false(不推进/不 waiting)
    }
    // 4) cancel 路径 GPU 不会再发 tts_done(被打断的 TTS 不发 done)→ 这里清账并主动触发 AI-done,
    //    否则 aiSpeaking 会被在途余包卡 true(review 后第二句被静音化喂 ASR)。
    //    被打断的轮视为「已结束」:只要本轮尚未收尾(!aiDoneFired)就上报 partial + 触发 onAiDone。
    //    ★ design contract:判据从 `ttsPending > 0` 放宽为 `!turn.aiDoneFired`——**句间空窗**(第 1 句已收
    //      tts_done、ttsPending 已归零,LLM 仍在生成第 2 句、llmStreamComplete 未 true)或**首句未下发即打断**
    //      (dispatchedText 空、ttsPending==0)时,旧判据 `ttsPending > 0` 为假会**完全跳过收尾**:该轮
    //      aiDoneFired 永不置 true、metrics 丢失、kickoff 轮 kickoffPending 卡死到下一次不相关 onAiDone。
    //      放宽后这些 ttsPending==0 空窗轮也恰好收尾一次。与上面 design contract deferred 分支**互斥**:deferred
    //      轮已在其分支置 aiDoneFired,`!turn.aiDoneFired` 守卫使本分支不再重复触发(即便 deferred===turn)。
    //      稳定态 `ttsPending==0 && llmStreamComplete==true && !aiDoneFired` 是瞬态(maybeFireAiDone 同步
    //      收尾),cancel 若在其后发生 aiDoneFired 已 true、本分支自然不进入。
    if (turn && !turn.aiDoneFired) {
      turn.terminalStatus = reason === "error" ? "failed" : "cancelled";
      turn.terminalReason = reason;
      turn.retireSegments();
      turn.ttsPending = 0;
      turn.llmStreamComplete = true;
      // metrics:本轮被打断 → played=partial(合成未收齐)。仅 barge_in 视作「打断本轮」语义(延迟等
      // cancel_ack 核对);session_end/manual_hangup/error 也走 cancel,但属收尾,不延迟、bargeIn=false。
      this.reportMetrics(turn, "partial", reason === "barge_in");
      this.fireAiDone(turn, false); // cancel(打断/收尾)→ 本轮未把话说完(design contract:不进等待作答态)
    }
  }

  /** 误打断恢复(design contract):tentative-pause —— 暂停出声、**不销毁本轮**。幂等:无活跃轮/已暂停 → no-op。
   *  与 cancel 的区别:cancel 是不可逆销毁(abort LLM + reset + gpu.cancel + fireAiDone);pause 只把后续
   *  下行音频缓存不发,活跃轮全状态存活。resume 续发;确认打断则 cancel(销毁)。 */
  pause(): void {
    if (this.paused || this.interrupted) return; // 已暂停 / 已销毁:幂等
    const turn = this.activeTurn;
    if (!turn) return; // 无活跃轮无可暂停
    this.paused = true;
    this.pausedTurn = turn;
    this.pausedAudioBuffer = [];
    this.deferredAiDoneTurn = null;
    console.log(`[3stage ${this.sessionId}] tentative-pause 轮${turn.index}(缓存音频不下发,活跃轮存活,等 resume/确认打断)`);
  }

  /** 误打断恢复(design contract):resume —— 退出 tentative-pause,续发暂停期缓存音频;若本轮暂停期已播完则补
   *  触发 defer 的 onAiDone。幂等:非暂停态 no-op。身份守尾:暂停的轮若已被抢占/终结(理论上暂停期不换轮,
   *  防御性)则只清状态、不误续。 */
  resume(): void {
    if (!this.paused) return; // 非暂停:幂等
    const turn = this.pausedTurn;
    const buffered = this.pausedAudioBuffer;
    const deferred = this.deferredAiDoneTurn;
    const deferredCompleted = this.deferredAiDoneCompleted; // 快照原始 completed(下面清空前)
    this.paused = false;
    this.pausedTurn = null;
    this.pausedAudioBuffer = [];
    this.deferredAiDoneTurn = null;
    console.log(`[3stage ${this.sessionId}] resume 轮${turn?.index ?? "?"}:续发 ${buffered.length} 缓存帧(误打断恢复,本轮不丢)`);
    // 身份守尾:仅当暂停的轮仍是当前活跃轮、未被打断、且**未终结**(!aiDoneFired,防御 review:
    // 极端下若本轮已被其他路径 fireAiDone 收尾,activeTurn 已置 null,此处 === 校验已挡;!aiDoneFired 双保险)才续发。
    if (turn && this.activeTurn === turn && !this.interrupted && !turn.aiDoneFired) {
      for (const { pcm, identity } of buffered) {
        this.sendTurnAudio(turn, pcm, identity); // design contract:resume 续发首帧补 onTurnAudioBegin
      }
      // 暂停期本轮已播完(onAiDone 被 defer)→ 缓存续发完后补触发。按 defer 时保存的原始 completed 传
      //   (正常 fullyPlayed=true;失败轮=false,不误报正常播完,评审 三审自检)。
      if (deferred === turn) this.fireAiDone(turn, deferredCompleted);
    }
  }

  /** design contract:下发一帧本轮 TTS 音频 —— **首个真实下行 binary 之前**补发一次 onTurnAudioBegin(轮媒体起点,
   *  = server ai_audio_start(turnSeq))。守「每轮一次」(turn.audioBeginSent)。turn 为 null(极端:activeTurn 已被
   *  换走但在途残音)则只下发不发 begin(无轮身份,不建段;该残音本应被 interrupted 守卫挡在此前)。 */
  private sendTurnAudio(
    turn: SpeechTurn,
    pcm: Buffer,
    identity: ResponseSegmentIdentity,
  ): void {
    if (!turn.audioBeginSent) {
      turn.audioBeginSent = true;
      this.turnAudioBeginCb(turn.index); // 紧前于首帧 binary(同一同步调用栈,有序)
    }
    this.audioOutCb(pcm, identity);
  }

  /** 触发 core terminal(守「恰好一次」),并在 transport 允许后完成业务结算。
   *  `completed`(design contract,review):本轮是否**正常完整播完**——`true` 仅正常收尾路径
   *  (maybeFireAiDone/fullyPlayed)+ 暂停期已播完的 deferred 兑现;`false` = 打断(cancel)/ 异常终结
   *  (LLM 超时/流错、TTS 超时,本轮**没把话说完**)。透传给 aiDoneCb → media-session 据此判是否起沉默钟。 */
  private fireAiDone(turn: SpeechTurn, completed: boolean): void {
    if (turn.aiDoneFired) return;
    // 误打断恢复(design contract):tentative-pause 期间本轮播完(缓存里还有未下发音频)→ **defer onAiDone**,
    // 不清 activeTurn、不关回声抑制窗;resume 续发缓存后再补触发(否则暂停中就"说完了"、缓存音频没人续发)。
    // 仅暂停的正是本轮时 defer;cancel(确认打断)会先清 paused,不经此。
    if (this.paused && this.pausedTurn === turn) {
      this.deferredAiDoneTurn = turn;
      this.deferredAiDoneCompleted = completed; // 保存原始值,兑现时按原值传(不硬编码 true)
      return;
    }
    turn.aiDoneFired = true;
    turn.terminalStatus ??= completed
      ? "completed"
      : turn.llmFailed || turn.ttsTimedOut
        ? "failed"
        : "cancelled";
    if (!completed) turn.retireSegments();
    // ★ design contract(候选 A):本轮真正终结(过了 defer early-return)→ 此刻 commit 暂存的完整 reply。
    //   MUST 在 aiDoneCb() **之前**:media-session 的 onLlmText(commitAiText→llmTextCb 触发)设置本轮
    //   AI 转写 + 告别旗(aiSaidFarewellThisTurn),而 onAiDone(aiDoneCb 触发)据该旗做挂断决策——顺序颠倒
    //   会让告别判定读到过时上下文(review)。commitAiText 守 historyWritten 至多一次:
    //   若本轮已被 cancel 的 R4 截断分支先写过(被打断路径),此处 pendingReply 的完整版不会覆盖(互斥)。
    //   pendingReply 为 undefined(流式中被打断/异常终结,没走到流末暂存)→ 不 commit,cancel/异常路径各自负责。
    if (turn.pendingReply !== undefined && !turn.historyWritten) {
      this.commitAiText(turn, turn.pendingReply, turn.isKickoff, turn.userText);
    }
    // ★ design contract:full metrics 在此上报(而非 maybeFireAiDone)——本轮真正终结(过 defer early-return)时。
    //   若经 resume 而来,onRecoveryWindowElapsed 已先写 pendingEndpoint.falseInterruption=true 再 resume,
    //   故此刻上报时 media-session 的 pendingEndpoint 尚未被消费、已含 falseInterruption,随 metrics 落库。
    //   守 metricsReported 恰好一次:半途 cancel/timeout/异常等 partial 路径在调 fireAiDone **之前**已各自
    //   reportMetrics("partial"),此处对它们 no-op;只有 fullyPlayed 轮(正常/resume/deferred-cancel)在此
    //   以 full 上报(保持现状语义,不按 interrupted 分叉——它们音频确已完整合成收齐,full 是正确口径)。
    if (!turn.metricsReported) this.reportMetrics(turn, "full");
    // ★ design contract:轮媒体终点(server_drained 边界)—— 仅**本轮正常完整播完(completed)且产生过音频**才发
    //   onTurnAudioEnd(= server ai_audio_end(turnSeq));被打断/异常/无音频轮不发(清 ring 由 barge_in/supersede 走,
    //   R2)。落点 = aiDoneCb 之前(与 media 关回声抑制窗/恢复 ASR 同点,= server_drained;非客户端已播完)。
    if (completed && turn.audioBeginSent) this.turnAudioEndCb(turn.index);
    if (this.responseWireDrainRequired) {
      // Register first: a fake/test socket is allowed to invoke send callbacks
      // synchronously from the observer stack.
      this.pendingResponseSettlement = {
        turn,
        completed,
        phase: "wire",
        timer: null,
      };
    }
    this.responseCoreTerminalCb({
      ...this.responseIdentity(turn),
      status: turn.terminalStatus,
      ...(turn.terminalReason ? { reason: turn.terminalReason } : {}),
    });
    if (!this.responseWireDrainRequired) {
      this.settleResponse(turn, completed);
    }
  }

  private settleResponse(turn: SpeechTurn, completed: boolean): void {
    // ★ design contract(缺陷2 治污染源):推进整段(maybeAdvanceCursor → END_CALL 压制 → autoNextAfterDone)**仅在
    //   本轮正常完整播完(completed=true)时执行**。callback-confirmed transport 只在 matching
    //   response.done handoff 后进入本块，防 core terminal enqueue 提前触发播放依赖动作。
    let voicedQuestionVerbatimThisTurn = false;
    if (completed) {
      voicedQuestionVerbatimThisTurn = this.markQuestionVerbatimVoiced(turn);
      this.advanceAndScheduleNext(turn);
    }
    this.settleTerminalCompletion(turn, completed);
    // 本轮播报生命周期结束 → 回空闲。仅当仍是当前轮才清(cancel/timeout 已先行 null,避免误清抢占方的新轮)。
    if (this.activeTurn === turn) this.activeTurn = null;
    // ★ design contract:aiDoneCb 返回「客户端估算播完」推进时钟起点(media 的 computePlaybackNotBeforeMs);
    //   下面 armAnswerGrace 用它把宽限窗延后到估算播完后(而非 tts_done 后)。返回 void → armAnswerGrace 退回现状。
    const playbackNotBeforeMs = this.aiDoneCb(completed, turn.index);
    // 只给本轮实际逐字包含题干、且游标仍指向该题的轮绑定客户端播放终点。若本轮同时推进了游标，
    // advanceCursor 已切到下一题，旧题的播放边界不得污染新题。
    if (
      voicedQuestionVerbatimThisTurn &&
      turn.questionIndexSnapshot === this.cursor &&
      typeof playbackNotBeforeMs === "number" &&
      Number.isFinite(playbackNotBeforeMs)
    ) {
      this.cursorQuestionPlaybackEndMs = Math.max(
        Date.now(),
        playbackNotBeforeMs - TURN_HANDLING.playbackClock.leadMarginMs,
      );
    }
    // 忙时用户输入排水(design contract):`turn_end` 忙时把用户话让位悬挂进 lastFinalText(见 onGpuControl 的
    // turn_end 分支),但此前从无人在引擎转空闲时主动消费它——只能等"下一个 turn_end",而协议保证
    // asr_final 必先于 turn_end 到达,悬挂值在被消费前几乎必然先被覆盖,输入永久丢失(真机 bug)。
    // ⚠️ 排水 MUST NOT 挂在 cancel() 触发的 fireAiDone 上(design contract"排水触发边界",review):
    // cancel() 已在调用本函数前把 this.interrupted 置 true(直到下一个 turn_end 才清),若在此处排水消费
    // 触发 runLlmTurn,新轮的 TTS 音频会被 interrupted 守卫整段丢弃——"排水轮起了但没声",复现新的静默 bug。
    // 用 !this.interrupted 排除 cancel 路径,不新增字段(cancel 路径下悬挂输入沿用 design contract 既有"依赖用户
    // 自然重说"退化路径,不在此挽救——理由见 design contract Purpose)。
    if (!this.interrupted) {
      // 排水资格判据 MUST 与 runLlmTurn 的有效字符门槛一致(design contract:两处共用 meaningfulInputThreshold
      // 单一事实源,不再各自内联同一公式)。不是裸"非空"——否则纯标点残识会被误判为有效输入,既不能被
      // runLlmTurn 内部门槛真正消费,又会抢占本该走的 maybeAutoAskNext 分支,造成两头都不响应的回归。
      const { minChars: drainMinChars } = this.meaningfulInputThreshold();
      const pendingText = this.lastFinalText;
      // pendingText 前置判空(review):非游标模式下若运维把 AIM_MIN_INPUT_CHARS 配成 0,
      // drainMinChars 会变 0,meaningfulCharCount("") >= 0 恒真——不加此判空会让空字符串也走进消费
      // 分支(虽 runLlmTurn 内部 !userText 会 no-op,无实害,但会打出误导性的"消费 lastFinalText=" 日志)。
      if (pendingText && meaningfulCharCount(pendingText) >= drainMinChars) {
        // 用户悬挂输入优先于自动问下一题(design contract):消费即清空(复用现有"起新轮清 lastFinalText"语义),
        // MUST NOT 同时发起两轮——runLlmTurn 同步设置 activeTurn,busy 守门立即生效,天然不叠轮。被让位的
        // "问下一题"意图不强行补发(用户新一轮回复可能已带出下一题,或后续正常 turn_end 路径会再评估)。
        // ★ design contract:判**时序资格**——该悬挂输入是否产生于「当前题成为当前题且已念出」之后。双锚(闭环开启时判):
        //   ①capturedCursor < 现 cursor(捕获时在更早的题、游标已被别的路径推进过)→ 跨题界陈货;
        //   ②capturedCursor == 现 cursor 且 capturedVoiced=false(捕获时当前题尚未念出)→ 念出前陈货(答的是上一题)。
        //   任一成立 → 陈货:仍起 verify 轮回应考生(不丢输入,design contract 承诺不破),但 cursorAdvanceEligible=false,
        //   maybeAdvanceCursor 顶部据此不推进 —— 防「答上一题的续说」把当前题跳过(部署回归)。
        const capCursor = this.pendingDrainCursor;
        const isStale =
          CURSOR_VOICED_GATE &&
          capCursor >= 0 &&
          (capCursor < this.cursor || (capCursor === this.cursor && !this.pendingDrainVoiced));
        this.lastFinalText = "";
        this.pendingDrainCursor = -1;
        this.pendingDrainVoiced = false;
        this.pendingAutoNext = false; // 用户输入优先,本轮会自然使用当前 cursor prompt
        // ★ design contract 评审 Major 1(review):消费 drain 悬挂输入 = 前一轮的宽限推进意图作废,新轮自己
        //   重新决定 → **在起排水轮前显式清 pendingAdvance**(+ graceGen++ 作废任何在途)。否则:前一轮已置
        //   pendingAdvance,排水 early-return 跳过 armAnswerGrace,pendingAdvance 遗留 true;排水轮若经**非
        //   maybeAdvanceCursor 终结**(TTS 超时/LLM 失败)→ fireAiDone 末尾 armAnswerGrace 读到遗留 true → 起窗
        //   到期误推(probe 实证:排水轮失败后 4s 游标 0→1)。maybeAdvanceCursor 顶部的重置只堵 B 正常走它的路径。
        this.cancelAnswerGrace();
        if (this.shouldReplayInterruptedQuestion(pendingText)) {
          console.log(
            `[3stage ${this.sessionId}] 当前题服务端排水前被打断 + 短输入="${pendingText.slice(0, 20)}"` +
            "→ 排水后直接重播当前题(不进 LLM/不计 retry)",
          );
          this.startDirectCurrentQuestion();
          return;
        }
        if (isStale) {
          this.staleAnswerStall += 1;
          // 兜底(review):陈货连续不推进达 STALE_ANSWER_MAX → 放行推进(防考生沉默永久卡当前题;
          //   voicedStall 计不到本态——它只在「未念出」计,此处当前题已念出)。
          if (this.staleAnswerStall >= STALE_ANSWER_MAX) {
            console.warn(`[3stage ${this.sessionId}] design contract:排水陈货连续 ${this.staleAnswerStall} 轮不推进达上限 → 兜底放行(考生可能一直答不到当前题;报警)`);
            // 显式清零(review):兜底放行虽 eligible=true,但若该轮因追问未收尾/字数
            //   不足而未真推进(maybeAdvanceCursor 走不到 advanceCursor 的清零),staleAnswerStall 会残留高值 →
            //   下次 stale 立即又兜底(连续 N 轮保护失效)。故此处显式清,不依赖 advanceCursor 的隐式副作用。
            this.staleAnswerStall = 0;
            this.bypassGraceOnce = true; // design contract Major 4:stale 兜底=强推,该轮推进立即兑现不进宽限窗
            void this.runLlmTurn(pendingText); // eligible 默认 true:本轮允许推进
            return;
          }
          console.log(`[3stage ${this.sessionId}] design contract:排水悬挂输入是跨题界/念出前陈货(capturedCursor=${capCursor}/现 cursor=${this.cursor})→ 起 verify 轮回应但不驱动推进(stall ${this.staleAnswerStall}/${STALE_ANSWER_MAX});pending="${pendingText.slice(0, 20)}"`);
          void this.runLlmTurn(pendingText, false, false); // cursorAdvanceEligible=false:回应但不推进
          return;
        }
        this.staleAnswerStall = 0; // 合格作答被排水消费 → 清兜底计数
        console.log(`[3stage ${this.sessionId}] 忙时悬挂输入排水:引擎转空闲 → 消费 lastFinalText="${pendingText.slice(0, 20)}"(优先于自动问下一题)`);
        void this.runLlmTurn(pendingText);
        return;
      }
    }
    this.maybeRunPendingContinuation();
    // ★ design contract(§1/§2 时序契约):补充宽限窗**只在此处 arm** —— 已越过 pause defer early-return、activeTurn 已
    //   清空、忙时排水 early-return 未触发(无悬挂输入)、autoNextAfterDone 已消费。若本轮 maybeAdvanceCursor 记了
    //   「待宽限推进意图」(pendingAdvance,仅 advanceIfVoiced 正常放行 + grace 开时),此刻起窗:窗内用户开口
    //   §2 cancelAnswerGrace、窗内无声 §3 到期 advanceCursor+auto-next。pendingAdvance=false(强推/关窗/被打断)→ no-op。
    //   ⚠MUST 在 aiDoneCb 之后:媒体面收尾记账先行,宽限窗是纯引擎侧延迟推进,不阻塞收尾。
    //   ★ design contract:传 aiDoneCb 返回的 playbackNotBeforeMs — 宽限窗延后到「估算播完后 + ANSWER_GRACE_MS」。
    this.armAnswerGrace(playbackNotBeforeMs, turn.startedAt);
  }

  /** 有效输入门槛(design contract:单一事实源,消除 fireAiDone 排水与 runLlmTurn 拒垃圾两处逐字节重复)。
   *  游标模式(有当前待问题:questions 非空且游标未越界)门槛**固定 1**(design contract(a):单字答案进 LLM、
   *  纯 0 字符仍跳过;MUST NOT 跟随 MIN_INPUT_CHARS,否则运维设 AIM_MIN_INPUT_CHARS=0 时纯静默也进 LLM);
   *  否则用 MIN_INPUT_CHARS(治幻觉开场)。**同时返回 inQuestionMode 布尔**——因拒垃圾日志需按模式打 label,
   *  不能从 minChars===1 反推(MIN_INPUT_CHARS 也可能配成 1,评审)。 */
  private meaningfulInputThreshold(): { inQuestionMode: boolean; minChars: number } {
    const inQuestionMode = this.questions.length > 0 && this.cursor < this.questions.length;
    return { inQuestionMode, minChars: inQuestionMode ? 1 : MIN_INPUT_CHARS };
  }

  /** 推进后持久记录下一动作。调用点覆盖正常推进、R3 静默和 answerGrace。 */
  private scheduleContinuationAfterAdvance(sourceTurn?: SpeechTurn): void {
    if (this.endCallSignaled || this.questions.length === 0) return;
    if (this.cursor < this.questions.length) {
      this.pendingAutoNext = true;
      return;
    }
    if (this.terminalCompletionState === "idle") {
      if (sourceTurn && this.isPiggybackTerminalCompletion(sourceTurn)) {
        this.terminalCompletionState = "delivered";
        console.log(`[3stage ${this.sessionId}] 末题推进轮已完整收尾 → terminal-completion piggybacked`);
        return;
      }
      this.terminalCompletionState = "pending";
      console.log(`[3stage ${this.sessionId}] 全部题目已完成 → terminal-completion pending`);
    }
  }

  /** 在安全空闲点兑现持久 continuation；guard 不满足时保留 pending。 */
  private maybeRunPendingContinuation(): void {
    if (
      this.activeTurn !== null ||
      this.pendingResponseSettlement !== null ||
      this.interrupted ||
      this.paused ||
      this.pendingTerminalTakeoverText
    ) {
      return;
    }
    if (this.endCallSignaled) return;
    const { minChars } = this.meaningfulInputThreshold();
    if (this.lastFinalText && meaningfulCharCount(this.lastFinalText) >= minChars) return;
    if (this.terminalCompletionState === "pending" && this.questions.length > 0 && this.cursor >= this.questions.length) {
      console.log(`[3stage ${this.sessionId}] terminal-completion started`);
      void this.runLlmTurn(KICKOFF_WAKE_TEXT, true, true, true);
      return;
    }
    if (!this.pendingAutoNext || !(this.questions.length > 0 && this.cursor < this.questions.length)) return;
    this.pendingAutoNext = false;
    console.log(`[3stage ${this.sessionId}] 自动问下一题:游标已推进到第 ${this.cursor + 1}/${this.questions.length} 题 → 服务端直接下发题干 TTS(不等待 LLM)`);
    this.startDirectAutoNext();
  }

  /** terminal turn 的唯一状态结算点。技术失败在回空闲后立即重试一次；cancel 已预先改态,不会误重试。 */
  private settleTerminalCompletion(turn: SpeechTurn, completed: boolean): void {
    if (!turn.isTerminalCompletion || this.terminalCompletionState !== "in_flight") return;
    if (completed) {
      this.terminalCompletionState = "delivered";
      return;
    }
    if (this.terminalCompletionRetryCount < 1) {
      this.terminalCompletionRetryCount += 1;
      this.terminalCompletionState = "pending";
      console.warn(`[3stage ${this.sessionId}] terminal-completion 技术失败 → pending retry ${this.terminalCompletionRetryCount}/1`);
    } else {
      this.terminalCompletionState = "failed";
      console.warn(`[3stage ${this.sessionId}] terminal-completion 技术失败已达重试上限 → 停止自动重试`);
    }
  }

  private clearPendingResponseSettlement(): void {
    const pending = this.pendingResponseSettlement;
    if (pending?.timer) clearTimeout(pending.timer);
    this.pendingResponseSettlement = null;
  }

  /** User speech before the estimated playback boundary aborts the old
   *  playback-dependent settlement. The response remains wire-complete, but
   *  unheard tail audio cannot advance cursor or authorize hangup. */
  private abandonPlaybackSettlementForUserSpeech(): void {
    const pending = this.pendingResponseSettlement;
    if (!pending || pending.phase !== "playback") return;
    this.clearPendingResponseSettlement();
    this.nextSignaled = false;
    this.endCallSignaled = false;
    if (pending.turn.isTerminalCompletion) {
      this.terminalCompletionState = "pending";
    }
    this.aiDoneCb(false, pending.turn.index);
  }

  /** 整轮 AI 播报是否真正结束(LLM 流已出完 && 已下发句全部 tts_done)→ 触发 onAiDone(B3 门)。
   *  ★ 出题游标(design contract 判据 a):**仅此正常完成路径**评估游标推进——异常/打断走 fireAiDone 直达、不经此,
   *    故对方没听到完整题时不会误推。tentative-pause(design contract)会 defer onAiDone,但游标在此(fireAiDone 前)
   *    已按本轮作答评估;defer 只延后 onAiDone 通知,不改推进语义(本轮 AI 已说完、对方已作答与否已定)。 */
  private maybeFireAiDone(turn: SpeechTurn): void {
    if (turn.aiDoneFired) return; // 防御:已终结的轮不重复评估推进/上报(advanceCursor 有状态副作用)
    // ★ design contract:简化为「仅检查 fullyPlayed → fireAiDone(turn, true)」。推进整段(maybeAdvanceCursor +
    //   END_CALL 压制 + autoNextAfterDone)已移入 fireAiDone,**仅 completed 时执行**——被暂停/打断轮走
    //   fireAiDone(turn,false) 不再消耗 retry / 不启 waiting(治缺陷2:被打断的 AI 轮虚增 retry)。
    if (turn.fullyPlayed) {
      this.fireAiDone(turn, true); // design contract:唯一「正常完整播完」路径(turn.fullyPlayed 门)→ completed=true
    }
  }

  /** design contract:推进整段(maybeAdvanceCursor → END_CALL 压制 → autoNextAfterDone),从 maybeFireAiDone 迁入
   *  fireAiDone,**仅 completed(本轮正常完整播完)时**由 fireAiDone 调用。原子块:三步顺序敏感,不拆散。
   *  时序契约(见 fireAiDone):commit 之后(需 history + design contract)、aiDoneCb 之前(END_CALL 压制置 endCallSignaled
   *  供 media onAiDone 读;maybeAdvanceCursor 置 pendingAdvance 供后续 armAnswerGrace 消费)。 */
  private advanceAndScheduleNext(turn: SpeechTurn): void {
    // maybeAdvanceCursor 返回 { nextHint = 本轮是否出现 [[NEXT]],advanced = 是否真推进游标 }
    // (它内部会消费/清 nextSignaled,故由它回传)。
    const { advanced } = this.maybeAdvanceCursor(turn);
    // ★ 考试完成强制(design contract,**废止 design contract(b) 的「尊重早退」**):只要**还有未问完的题**,
    //   本轮 [[END_CALL]] 默认被压制(不挂)——考试语义下题没做完不许提前结束。配合 maybeAdvanceCursor 里
    //   FAREWELL_INTENT 强制推进(告别→放弃当前题→advanced=true),使下面 autoNextAfterDone 正常置 true →
    //   AI 继续问下一题,而非既不挂也不问的死锁(review)。
    //   **三次坚持逃生阀**(人道后门):每次压制计一次「考生要求结束」;累计达阈值 → 不再压制、放行 [[END_CALL]]
    //   + 标记 earlyExitAllowed(真遇急事不必困到 max_duration)。题目全问完(cursor>=len)→ 从不压制,正常收尾。
    if (this.endCallSignaled && this.questions.length > 0 && this.cursor < this.questions.length) {
      this.endRequestCount += 1;
      if (this.endRequestCount >= ThreeStageEngine.END_REQUEST_ESCAPE_THRESHOLD) {
        this.earlyExitAllowed = true; // 放行:不压制,endCallSignaled 保持 true → media-session 收尾
        console.warn(`[3stage ${this.sessionId}] 考生第 ${this.endRequestCount} 次要求结束(仍剩 ${this.questions.length - this.cursor} 题)→ 三次坚持逃生阀放行,允许提前结束(early_exit)`);
      } else {
        console.warn(`[3stage ${this.sessionId}] 考试未问完(还剩 ${this.questions.length - this.cursor} 题,第 ${this.endRequestCount} 次要求结束)→ 压制 [[END_CALL]],坚持继续(design contract)`);
        this.endCallSignaled = false;
      }
    }
    if (advanced && !this.endCallSignaled) this.scheduleContinuationAfterAdvance(turn);
  }

  // ── 引擎级 TTS 超时(P0.4)──
  /** 收到任一 TTS 下行信号(tts_audio_meta / tts_done):解除引擎级 TTS 超时,交媒体面看门狗兜底后续。 */
  private noteTtsSignal(): void {
    this.ttsSignalSeen = true;
    this.clearTtsWatchdog();
  }
  /** 武装引擎级 TTS 超时:发首句 tts_text 后启动;若超时窗内一个 TTS 下行信号都没来 → onTtsTimeout。 */
  private armTtsWatchdog(): void {
    if (TTS_TIMEOUT_MS <= 0 || this.ttsSignalSeen || this.ttsWatchdog) return;
    this.ttsWatchdog = setTimeout(() => this.onTtsTimeout(), TTS_TIMEOUT_MS);
    (this.ttsWatchdog as unknown as { unref?: () => void }).unref?.();
  }
  private clearTtsWatchdog(): void {
    if (this.ttsWatchdog) {
      clearTimeout(this.ttsWatchdog);
      this.ttsWatchdog = null;
    }
  }
  /** GPU「只收不回」(发 tts_text 后一帧 tts_audio_meta/tts_done 都没回,也不触发 connError):引擎自终结
   *  本轮(清账)+ 触发 onAiDone,否则 activeTurn/ttsPending 卡死、aiSpeaking 永不被置位(媒体面看门狗不启动)。
   *
   *  ★ 评审纠偏(集成路径 High):**绝不**经 `errorCb` 上报 —— MediaSession.onError 把任何引擎 error 当**致命**
   *  并 `end("error")` 整通拆机,与本兜底「自终结本轮、**会话继续**、下一轮正常」的语义正相反(违背 design contract
   *  「永不永久哑」)。故只 `console.warn` + 记 metrics 标志,触发 onAiDone 恢复收听,不上报 error、不拆机。 */
  private onTtsTimeout(): void {
    this.ttsWatchdog = null;
    if (this.ttsSignalSeen) return; // 竞态:已收到信号,放弃兜底
    const turn = this.activeTurn;
    if (!turn || turn.aiDoneFired) return; // 本轮已被别的路径终结
    console.warn(`[3stage ${this.sessionId}] 轮${turn.index} TTS 超时 ${TTS_TIMEOUT_MS}ms 无任何下行(GPU 只收不回)→ 引擎自终结本轮 + onAiDone(会话继续,不拆机)`);
    turn.ttsTimedOut = true; // metrics 标志(可观测;非致命,不走 errorCb 拆机路径)
    turn.terminalStatus = "failed";
    turn.terminalReason = "tts_timeout";
    turn.retireSegments();
    turn.ttsPending = 0;
    turn.llmStreamComplete = true;
    turn.llmReturned = true; // 释放 busy 守门(本轮彻底终结,下一轮 turn_end 可起新 LLM)
    if (this.activeTurn === turn) this.activeTurn = null;
    this.reportMetrics(turn, "partial");
    this.fireAiDone(turn, false); // TTS 超时(GPU 只收不回)→ 本轮未把话说完(design contract)
  }

  // ── 每轮 metrics 上报(design contract)──
  /** 终结某轮 metrics 并经 onMetrics 上报(恰好一次)。played 表合成完成度(非「用户听到」);
   *  bargeIn=true(仅 barge_in cancel)时延迟落库等 cancel_ack 核对。 */
  private reportMetrics(turn: SpeechTurn, played: "full" | "partial", bargeIn = false): void {
    if (turn.metricsReported) return;
    turn.metricsReported = true;
    const metric: EngineTurnMetrics = {
      turnIndex: turn.index - this.aiTurnIdBase,
      aiTurnId: turn.index,
      engineType: "three_stage",
      llmModelId: this.params?.llmModelId ?? DEFAULT_LLM_MODEL_ID,
      llmTtftMs: turn.firstTokenAt ? turn.firstTokenAt - turn.startedAt : undefined,
      llmDurationMs: turn.streamCompleteAt ? turn.streamCompleteAt - turn.startedAt : undefined,
      sentenceReadyMs: turn.sentenceReadyAt ? turn.sentenceReadyAt - turn.startedAt : undefined,
      ttsTtfbMs: turn.firstAudioAt ? turn.firstAudioAt - turn.startedAt : undefined,
      bridgeFirstReceiveMs: turn.firstAudioAt ? turn.firstAudioAt - turn.startedAt : undefined,
      ttsAudioDurationMs: turn.ttsAudioBytes
        ? (turn.ttsAudioBytes / 2 / TTS_SAMPLE_RATE_HZ) * 1000
        : undefined,
      sentenceCount: turn.sentenceCount,
      ttsProvider: this.params?.ttsProvider ?? "gpu_omnivoice",
      bargeIn,
      played,
      ttsTimeout: turn.ttsTimedOut || undefined, // 仅在超时兜底触发时落该标志(否则留空)
      llmFailed: turn.llmFailed || undefined, // LLM 流异常/首token超时降级本轮失败(P2-9;供分析降级率)
      llmFallback: turn.llmFallback || undefined, // design contract:本轮发生主备 fallback 切换(供分析主 provider 降级率)
      llmModelUsed: turn.llmModelUsed, // fallback 后实际出声模型(无 fallback 留空,分析时回落 llmModelId)
    };
    const gpuMetrics = turn.gpuMetrics();
    if (gpuMetrics.length >= turn.sentenceCount) {
      this.applyGpuMetrics(metric, gpuMetrics);
    } else {
      this.applyPartialGpuMetrics(metric, gpuMetrics);
    }
    this.metricRecordsByTurn.set(turn.index, metric);
    this.trimMetricCaches();
    // **立即**上报(endpoint 段由 MediaSession 同步合并——此刻 pendingEndpoint 仍是本轮的,无延迟落库竞态,
    // 评审纠偏:原 300ms 延迟落库期间新轮 turn_end 会覆盖单槽 pendingEndpoint → 错配)。
    this.metricsCb(metric);
    // barge_in:cancel_ack 的核对结果(timeout 与否)随后到达,届时**复用同 turn_index 重发**该 metric
    // (同 SK 覆盖,MediaSession 复用已缓存的 endpoint)。纯旁路,不阻塞通话/新轮。
    if (bargeIn && CANCEL_ACK_TIMEOUT_MS > 0) this.armCancelAck(metric);
  }

  /** barge_in 后等 cancel_ack:到 → 重发(cancel_ack_timeout=false);超时 → 重发(=true)。metric 同 turn_index
   *  覆盖首次落库(MediaSession 复用缓存 endpoint)。**仅更新 cancel_ack_timeout 标志,不改其余字段**。 */
  private armCancelAck(metric: EngineTurnMetrics): void {
    this.clearCancelAck(); // 前一笔未决的先冲掉(连续打断;旧的按超时计、重发)
    const timer = setTimeout(() => {
      const pend = this.cancelAck;
      this.cancelAck = null;
      if (pend) {
        pend.metric.cancelAckTimeout = true;
        this.metricsCb(pend.metric); // 重发:同 turn_index 覆盖,置 timeout=true
      }
    }, CANCEL_ACK_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.cancelAck = { timer, metric };
  }

  /** 收到 GPU cancel_ack:重发未决 metric(cancel_ack_timeout=false)。纯计量,不改任何通话状态。 */
  private resolveCancelAck(): void {
    const pend = this.cancelAck;
    if (pend) {
      clearTimeout(pend.timer);
      this.cancelAck = null;
      pend.metric.cancelAckTimeout = false;
      this.metricsCb(pend.metric); // 重发:同 turn_index 覆盖,置 timeout=false
    }
    this.releaseTerminalTakeoverAfterCancelBoundary("cancel_ack");
  }
  private clearCancelAck(): void {
    if (this.cancelAck) {
      clearTimeout(this.cancelAck.timer);
      // 旧笔被新打断挤掉:按超时(未及确认)记账,重发覆盖。
      this.cancelAck.metric.cancelAckTimeout = true;
      this.metricsCb(this.cancelAck.metric);
      this.cancelAck = null;
    }
  }

  /** terminal 接管活性独立于 metrics/cancelAck 记账；即使 metrics 已上报，也必须有界释放。 */
  private armTerminalTakeoverBoundary(): void {
    this.clearTerminalTakeoverTimer();
    if (!this.pendingTerminalTakeoverText) return;
    if (CANCEL_ACK_TIMEOUT_MS <= 0) {
      this.releaseTerminalTakeoverAfterCancelBoundary("cancel_ack_timeout");
      return;
    }
    const timer = setTimeout(() => {
      if (this.terminalTakeoverTimer === timer) this.terminalTakeoverTimer = null;
      this.releaseTerminalTakeoverAfterCancelBoundary("cancel_ack_timeout");
    }, CANCEL_ACK_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.terminalTakeoverTimer = timer;
  }

  private clearTerminalTakeoverTimer(): void {
    if (!this.terminalTakeoverTimer) return;
    clearTimeout(this.terminalTakeoverTimer);
    this.terminalTakeoverTimer = null;
  }

  /** terminal drain 接管的 cancel 已在 GPU 侧落地（或有界超时）后，才解除残音守卫并启动接管轮。 */
  private releaseTerminalTakeoverAfterCancelBoundary(source: "cancel_ack" | "cancel_ack_timeout"): void {
    const text = this.pendingTerminalTakeoverText;
    if (!text) return;
    this.clearTerminalTakeoverTimer();
    this.pendingTerminalTakeoverText = "";
    if (this.activeTurn !== null || this.paused) {
      this.lastFinalText = text;
      this.interrupted = false;
      console.warn(
        `[3stage ${this.sessionId}] terminal 接管 ${source} 到达但引擎非空闲 → 保留 pending-drain`,
      );
      return;
    }
    this.interrupted = false;
    console.log(`[3stage ${this.sessionId}] terminal 接管 ${source} → 解除残音守卫并启动用户收尾轮`);
    void this.runLlmTurn(text);
  }

  onAudioOut(cb: AudioOutCb): void {
    this.audioOutCb = cb;
  }
  onResponseStarted(cb: ResponseStartedCb): void {
    this.responseStartedCb = cb;
  }
  onResponseSegmentDeclared(cb: ResponseSegmentDeclaredCb): void {
    this.responseSegmentDeclaredCb = cb;
  }
  onResponseSegmentCompleted(cb: ResponseSegmentCompletedCb): void {
    this.responseSegmentCompletedCb = cb;
  }
  onResponseCoreTerminal(cb: ResponseCoreTerminalCb): void {
    this.responseCoreTerminalCb = cb;
  }
  onResponseServerDrained(cb: ResponseServerDrainedCb): void {
    this.responseServerDrainedCb = cb;
  }
  setResponseWireDrainRequired(required: boolean): void {
    this.responseWireDrainRequired = required;
  }
  noteResponseWireDrained(responseGeneration: number): void {
    const pending = this.pendingResponseSettlement;
    if (
      !pending ||
      pending.phase !== "wire" ||
      pending.turn.index !== responseGeneration
    ) {
      return;
    }
    const playbackNotBeforeMs = this.responseServerDrainedCb(
      responseGeneration,
      pending.completed,
    );
    if (this.activeTurn === pending.turn) this.activeTurn = null;
    const now = Date.now();
    const delayMs =
      pending.completed &&
      typeof playbackNotBeforeMs === "number" &&
      Number.isFinite(playbackNotBeforeMs)
        ? Math.max(0, playbackNotBeforeMs - now)
        : 0;
    if (delayMs <= 0) {
      this.pendingResponseSettlement = null;
      this.settleResponse(pending.turn, pending.completed);
      return;
    }
    pending.phase = "playback";
    pending.timer = setTimeout(() => {
      if (this.pendingResponseSettlement !== pending) return;
      this.pendingResponseSettlement = null;
      this.settleResponse(pending.turn, pending.completed);
    }, delayMs);
    pending.timer.unref?.();
  }
  /** design contract:轮媒体起点回调(首个下行 binary 前;= ai_audio_start(turnSeq))。 */
  onTurnAudioBegin(cb: TurnAudioBoundaryCb): void {
    this.turnAudioBeginCb = cb;
  }
  /** design contract:轮媒体终点回调(正常完整播完 + 有音频;= ai_audio_end(turnSeq)= server_drained 边界)。 */
  onTurnAudioEnd(cb: TurnAudioBoundaryCb): void {
    this.turnAudioEndCb = cb;
  }
  /** design contract:用户驱动新轮起回调(runLlmTurn 被接受、非 kickoff)。media enforce 据此下发 playback_superseded。 */
  onUserTurnStart(cb: UserTurnStartCb): void {
    this.userTurnStartCb = cb;
  }
  onTranscript(cb: TranscriptCb): void {
    this.transcriptCb = cb;
  }
  onTurnEvent(cb: TurnEventCb): void {
    this.turnCb = cb;
  }

  async stop(): Promise<void> {
    this.cancel("session_end");
    this.clearTtsWatchdog();
    this.clearCancelAck(); // 冲掉未决的 barge_in metric(按超时记账落库,不丢)
    this.gpu.end();
  }

  /** GPU/引擎错误回调(供上层记录 + 收尾,#13)。 */
  private errorCb: EngineErrorCb = () => {};
  onError(cb: EngineErrorCb): void {
    this.errorCb = cb;
  }

  /** AI 本轮完整文本回调(供上层写 speaker=ai 转写,review)。 */
  private llmTextCb: LlmTextCb = () => {};
  onLlmText(cb: LlmTextCb): void {
    this.llmTextCb = cb;
  }

  /** AI 本轮播报结束回调(GPU tts_done)→ 上层关回声抑制窗、恢复收听。
   *  completed(design contract):本轮是否正常完整播完(见 AiDoneCb 文档)。
   *  ★ design contract:**返回** playbackNotBeforeMs(客户端估算播完起点,epoch ms)或 void(未接);
   *  armAnswerGrace 用其延后宽限窗到「估算播完后」而非 tts_done 后。 */
  private aiDoneCb: (
    completed: boolean,
    responseGeneration?: number,
  ) => number | void = () => {};
  private responseServerDrainedCb: ResponseServerDrainedCb = () => {};
  onAiDone(
    cb: (
      completed?: boolean,
      responseGeneration?: number,
    ) => number | void,
  ): void {
    this.aiDoneCb = cb;
  }

  /** 每轮 LLM/TTS 段 metrics 回调(design contract,旁路)。MediaSession 合并端点段后落库。 */
  onMetrics(cb: EngineMetricsCb): void {
    this.metricsCb = cb;
  }

  /** 本轮 LLM 是否输出了结束信号(语义挂断)。media-session 在 onAiDone 时查询;读后清,避免跨轮残留。 */
  wantsEndCall(): boolean {
    const v = this.endCallSignaled;
    this.endCallSignaled = false;
    return v;
  }

  /** 出题游标:是否还有未问完的预设题目(design contract 考试完成强制判据)。无题(纯人设)/ 已问完 → false。
   *  media-session 据此拦提前挂断(未问完不许结束,除非逃生阀 / max_duration)。无副作用、可反复查。 */
  hasPendingQuestions(): boolean {
    return this.questions.length > 0 && this.cursor < this.questions.length;
  }

  /** design contract:这场是不是「有(有效)预设题」= 测评语义(vs 无题=自由聊天)。**不随游标推进变化**
   *  (区别于 hasPendingQuestions:后者随游标问完而转 false)。media-session 据此分流挂断硬闸门:
   *  false(自由聊天)→ blockedByOpenChat 拦 AI 主动挂;true(测评)→ 归 blockedByExam 现状逻辑。
   *  ★ 口径(review):this.questions 在 start() 已经过 validQuestions 过滤(:284),故
   *  `length>0` 即「有有效题」——与 hasPendingQuestions **同口径**,杜绝「全脏题非空数组被裸 length 误判有题、
   *  却既不被 exam 也不被 openChat 保护」的双重失效缝。无副作用、同步只读。 */
  hasQuestions(): boolean {
    return this.questions.length > 0;
  }

  /** 出题游标当前数值(design contract:旁路 EOU 判定绑 turn 时的游标快照,返回时比对判 stale)。无副作用、只读。 */
  questionCursor(): number {
    return this.cursor;
  }

  /** design contract:当前 cursor 指向的题是否已被判过一次有效作答(sticky)。media 静默兜底据此互斥分流
   *  (true → R3 善意兜底;false → design contract 防作弊)。无副作用、同步只读。无题/已问完 → false(无 R3 语境)。 */
  answerSeenForCursor(): boolean {
    if (!(this.questions.length > 0 && this.cursor < this.questions.length)) return false;
    return this.answerSeenForCursor_;
  }

  /** design contract:media 静默超时兜底到期 → 服务端主动推进游标 + 自动问下一题(解 review 收尾漏发 [[NEXT]] 且
   *  考生不再开口时,retry 停在 1 永不达上限、autoNext 从不触发 → 卡到 max_duration)。**仅在当前题已判有效作答
   *  (answerSeenForCursor=true)时由 media 调用**(未作答归 design contract 防作弊,不走此)。经 design contract questionVoiced 门:
   *  当前题已念出 → 正常推进;未念出 → 走 voicedStall 兜底(不吞题)。末题 → 转收尾(cursor 越界,不 autoNext 无下一题)。
   *  返回是否真的推进了(供 media 记账/日志)。cursorEpoch 防 TOCTOU:media 读态到调用间若 cursor 已被别路径推进则不重推。 */
  advanceOnSilenceTimeout(cursorEpoch: number): boolean {
    // cursor epoch 守卫(design contract 时序契约):media 分流时读的 cursor 与此刻不一致 = 期间已被别路径推进 → 不重推。
    //   (review:日志区分「别路径已推(epoch 失配)」vs「R3 真推」,便于真机诊断兜底是否白做。)
    if (cursorEpoch !== this.cursor) {
      console.log(`[3stage ${this.sessionId}] R3 静默兜底:cursor epoch 失配(读 ${cursorEpoch}/现 ${this.cursor})→ 别路径已推进,不重推(兜底本轮未生效)`);
      return false;
    }
    if (!(this.questions.length > 0 && this.cursor < this.questions.length)) return false; // 无题/已问完
    if (!this.answerSeenForCursor_) return false; // 未作答:不归 R3(防作弊归 design contract),防御性再校验
    // design contract questionVoiced 门:AI 未念出当前题时不吞题(记 voicedStall,达上限才兜底强推)。
    if (CURSOR_VOICED_GATE && !this.cursorVoiced) {
      this.voicedStall += 1;
      if (this.voicedStall < CURSOR_VOICED_MAX_STALL) {
        console.log(`[3stage ${this.sessionId}] R3 静默兜底:第 ${this.cursor + 1} 题未念出 → 不推进(voicedStall ${this.voicedStall}/${CURSOR_VOICED_MAX_STALL})`);
        return false;
      }
      console.warn(`[3stage ${this.sessionId}] R3 静默兜底:第 ${this.cursor + 1} 题连续未念出达上限 → 兜底强推(F5)`);
    }
    console.log(`[3stage ${this.sessionId}] R3 静默兜底到期 → 服务端主动推进游标 + 自动问下一题(第 ${this.cursor + 1} 题已作答、AI 未出 [[NEXT]])`);
    this.advanceCursor();
    this.scheduleContinuationAfterAdvance();
    this.maybeRunPendingContinuation();
    return true;
  }

  /** design contract:当前游标对应的**题号事件快照**(0-based；越界/无题 → undefined)。
   *  越界判定 = `cursor >= questions.length`(N 题有效范围 [0, N-1];无题会话 length===0 → 0>=0 → undefined)。
   *  在事件发生那一刻取值(user asr_final 到达 / SpeechTurn 创建),随回调传下去落库——绝不落库时重查(design contract Blocker)。 */
  private snapshotQuestionIndex(): number | undefined {
    return this.cursor >= this.questions.length ? undefined : this.cursor;
  }

  /** ASR 字幕修正上下文(design contract):只读快照 —— 最近几轮对话 history + 当前题干(不含参考答案)。
   *  供 media-session 旁路修正 user ASR final 时判断错字(如上文问「25+37」→ 当前句「42」应为「62」)。
   *  ★ 只读:返回 history 的**浅拷贝切片**(近 CORRECTION_HISTORY_TURNS 轮),不暴露内部数组引用、不改 cursor/history。
   *  ★ 只给题干不给 reference_answer:防 LLM 顺着答案把用户答错的改对(那是篡改作答,非修字幕)。 */
  correctionContext(): { history: LlmMessage[]; question?: string } {
    const history = this.history.slice(-ThreeStageEngine.CORRECTION_HISTORY_MSGS).map((m) => ({ ...m }));
    let question: string | undefined;
    if (this.questions.length > 0 && this.cursor < this.questions.length) {
      const cur = this.questions[this.cursor] as { text?: unknown } | undefined;
      const text = String(cur?.text ?? "").trim();
      if (text) question = text; // 仅题干;reference_answer 故意不带(见方法注释)
    }
    return { history, question };
  }
  // 修正上下文取最近几轮(user+assistant 交替,故 MSGS = 轮数×2)。够判错字即可,不需全 history(省 token)。
  private static readonly CORRECTION_HISTORY_MSGS = 6; // ~3 轮

  /** 记一次「考生要求结束」(design contract 三次坚持逃生阀的**客户端 end 帧**来源;`[[END_CALL]]` 来源在
   *  maybeFireAiDone 里计)。累计达阈值 → earlyExitAllowed=true(放行)。返回是否已达阈值(供 media-session
   *  当次即决定放行,不必再等一轮)。仅在有未问完题时有意义(无题不拦挂断,media-session 不会调本方法)。 */
  noteEndRequest(): boolean {
    this.endRequestCount += 1;
    if (this.endRequestCount >= ThreeStageEngine.END_REQUEST_ESCAPE_THRESHOLD) {
      this.earlyExitAllowed = true;
    }
    console.log(`[3stage ${this.sessionId}] 考生第 ${this.endRequestCount} 次要求结束(客户端 end 帧);逃生阀阈值 ${ThreeStageEngine.END_REQUEST_ESCAPE_THRESHOLD},放行=${this.earlyExitAllowed}`);
    return this.earlyExitAllowed;
  }

  /** 三次坚持逃生阀是否已放行提前结束(design contract)。media-session 回报控制面时据此标 early_exit
   *  (evaluator 知晓「考生主动提前放弃、剩余题未作答」)。读不清(整通结束才读一次)。 */
  wantsEarlyExit(): boolean {
    return this.earlyExitAllowed;
  }

  /** 剥离语义哨兵:[[NEXT]](出题推进,恒剥)+ [[END_CALL]](语义挂断,SEMANTIC_END 开时剥)。
   *  两者独立剥离——同句/同轮同时出现也都去掉,不让任何残形进 TTS/转写/history(design contract)。 */
  private stripSentinels(text: string): string {
    let out = text.replace(NEXT_RE, "");
    if (SEMANTIC_END) out = out.replace(END_CALL_RE, "");
    return out.trim();
  }

  /** design contract:本轮 AI 最终可见文本是否**在追问**(疑问信号)。用于 retry 上限强推的**追问豁免**——
   *  AI 已问出口的澄清必须给用户回答机会,不能被 retry 上限在问句后立即强推。
   *  ★ 来源(评审 Minor):读 **turn.pendingReply**(本轮 AI 流末暂存的完整可见文本),剥哨兵后判——**不误读**
   *    history/transcript(那可能含上一轮)。pendingReply 为 undefined(流式中被打断/异常终结,没走到流末暂存)→
   *    视作非追问(返回 false):异常轮不该触发豁免延迟推进。判据 = 剥 [[NEXT]]/[[END_CALL]] 后含疑问信号
   *    (复用 QUESTION_CUE_RE 同款 pattern,非只 [?？];覆盖「能再展开一下吗」这类无问号追问)。
   *  fail-safe:疑似问句就返回 true(宁多等靠 R3 兜底,不误把追问当收尾强推)。 */
  private aiIsAsking(turn: SpeechTurn): boolean {
    if (turn.pendingReply === undefined) return false; // 异常轮无完整可见文本 → 不豁免
    const reply = this.stripSentinels(turn.pendingReply); // 剥哨兵(pendingReply 已剥,防御性再剥一次无害)
    if (!reply) return false; // 纯哨兵/空 → 非追问
    return QUESTION_CUE_RE.test(reply);
  }

  /**
   * 出题游标推进(design contract 判据 a–e)。**仅由正常完成路径调用**(maybeFireAiDone,即 LLM 流出完 + 本轮
   * TTS 全部收齐 tts_done)——判据 (a):异常终结(cancel/barge_in/TTS 超时/LLM 超时/异常)走 fireAiDone
   * 直达、**不经此**,故天然不推进(对方没听到题就不算问过)。
   *
   * userText = 对方本轮说的话(runLlmTurn 的入参,存于 lastAdvanceUserText);isKickoff = 主动开场轮(不推进)。
   * 判据:
   *  - 无题(纯人设对话)/ 已问完(cursor 越界)→ 空转,不推进。
   *  - kickoff 轮(AI 主动开场,对方没作答)→ 不推进。
   *  - (b) 内容有效性:对方有效字数 ≥ minAnswerChars 才算「已作答」;否则不推进,但计一次 retry。
   *  - (d-SHOULD) 拒答意图:未达有效字数但明确拒答(不会/跳过/下一题…)→ 视作已尝试,直接推进(不熬 retry)。
   *  - (c) **design contract:所有题统一「[[NEXT]] 主导」**(去题目级 follow_up):已作答但 LLM 未发
   *        [[NEXT]] = AI 在澄清 / 漏发哨兵 → **不推进、不抢推**;计 retry。
   *        已作答且发 [[NEXT]] → 正常推进(经 design contract voiced 门 + design contract 宽限窗)。
   *  - (d) 防死循环:同题重问达 maxRetryPerQuestion 后**强制推进**(不卡到 max_duration)。
   *  - (e) [[NEXT]]:**推进主导信号**(design contract,不再只是辅助)。漏发**不卡死**——但 retry 只在「考生开口→AI 完成轮」
   *        递增,若 AI 收尾漏发 [[NEXT]] 且考生不再开口(态3),retry 停在 1 不动 → 靠 **media R3 静默超时兜底**
   *        (先 nudge 问、再服务端推进,不依赖考生再开口;review)。过早发不跳题(未满足 b 时忽略)。
   */
  private maybeAdvanceCursor(turn: SpeechTurn): { nextHint: boolean; advanced: boolean } {
    // 返回:{ nextHint = 本轮是否出现 [[NEXT]] 辅助信号(供 maybeFireAiDone 判「同轮双哨兵」),
    //        advanced = 本轮是否真的推进了游标(供 maybeFireAiDone 判是否触发「自动问下一题」,design contract(b)) }。
    // 消费/清 nextSignaled。
    const { userText, isKickoff } = turn;
    const nextHint = this.nextSignaled;
    this.nextSignaled = false; // 读后清(本轮已评估;无论是否推进都清,不跨轮残留)
    // ★ design contract:每轮**重新**决定「待宽限推进意图」——顶部清 pendingAdvance,防上一轮遗留的意图污染本轮。
    //   唯一泄漏路径 = design contract 排水在 fireAiDone 里 early-return 消费悬挂输入起新轮时,前一轮的 pendingAdvance 未经
    //   armAnswerGrace(early-return 越过它)就滞留;新轮完成再进本函数时若不清,会误 arm 一个「前一轮想推进」的窗。
    //   此处清后,本轮由下面 advanceIfVoiced 正常放行分支重新置(否则保持 false)。grace 窗一旦 arm,新 speech 会
    //   经 §2 cancelAnswerGrace 先清,故 arm 期间不会有别的轮进本函数(无冲突)——此清仅堵 drain 泄漏。
    this.pendingAdvance = false;
    this.pendingAdvanceNextHint = false;
    // ★ design contract:排水陈货轮 cursorAdvanceEligible=false → **顶部**早返回不推进(清 nextSignaled 之后、任何
    //   advance/retry/decline/farewell/follow-up-limit 副作用之前;review:门 MUST NOT 只加在
    //   advanceIfVoiced,否则下方 decline/retry/追问上限的直接 advanceCursor 分支会被陈货文本命中而绕过门)。
    //   该轮已回应考生(不丢输入),只是不驱动游标——考生续答上一题不会把当前题跳过。
    if (!turn.cursorAdvanceEligible) return { nextHint, advanced: false };
    if (this.questions.length === 0 || this.cursor >= this.questions.length) return { nextHint, advanced: false }; // 无题/已问完:空转
    if (isKickoff) return { nextHint, advanced: false }; // 主动开场/系统主动轮:对方没作答,不推进

    // 出题游标模式的「已作答」字数门槛(design contract(a)):
    //  - 本轮有 [[NEXT]](LLM 判定问答已收尾)→ 门槛降到 **1**:口算单字答案「8」「9」也算已作答(信 LLM 语义判定,
    //    它比字数门槛更懂「答对了」;单字噪声残识不会让 LLM 发 [[NEXT]],故不误推)。
    //  - 无 [[NEXT]] → 沿用 minAnswerChars 兜底门槛(默认 4;防噪声/答非所问的短输入误算作答)。
    const answerThreshold = nextHint ? 1 : QUESTION_PROGRESSION.minAnswerChars;
    const answered = meaningfulCharCount(userText) >= answerThreshold;

    // design contract:当前题一旦被判过有效作答 → 置 sticky answerSeenForCursor(供 media 静默兜底互斥分流)。
    //   置位落点 = 判定 answered 处(而非推进处):态(2)真实追问「答过了在等追问回应」也要 answerSeen=true。
    if (answered) this.answerSeenForCursor_ = true;

    // (d) SHOULD:对方明确拒答(「不会/跳过/下一题…」)或**告别/想提前结束**(design contract:考试语义下「想走」=放弃当前题)
    //   → 视作「已尝试作答」直接推进(不熬满 retry 上限)。★ 告别推进 + 上层压制 [[END_CALL]] 配合:想走 → 推进下一题 →
    //   AI 继续问下一题(而非既不挂也不问的死锁,review)。
    // ★ design contract(前置修复):此判定 MUST 在「已作答但无 [[NEXT]] → 不抢推」**之前**——否则用户用**长句**表达告别/拒答
    //   (「我不想继续了到这里吧」字数 ≥ 门槛 → answered=true)会落入下方「无 [[NEXT]] 不推进」被当追问轮卡住,永远走不掉
    //   (旧代码靠 follow_up=false「作答即推进」歪打正着放行;去 follow_up 后必须显式前置,否则真机回归)。
    if (isDeclineIntent(userText) || FAREWELL_INTENT_RE.test(userText)) {
      console.log(`[3stage ${this.sessionId}] 出题游标:第 ${this.cursor + 1} 题对方拒答/放弃/想结束 → 视作已尝试,直接推进(evaluator 判未作答/不通过)`);
      this.advanceCursor();
      return { nextHint, advanced: true };
    }

    if (!answered) {
      // (b) 未有效作答(空轮/噪声/答非所问字数不足):不推进,计一次 retry。
      this.retryOnCurrent += 1;
      if (this.retryOnCurrent >= QUESTION_PROGRESSION.maxRetryPerQuestion) {
        // (d) 防死循环:同题重问达上限 → 强制推进(该题 evaluator 判未作答/不通过)。
        console.log(`[3stage ${this.sessionId}] 出题游标:第 ${this.cursor + 1} 题重问达上限 ${QUESTION_PROGRESSION.maxRetryPerQuestion} 次仍无有效作答 → 强制推进(防死循环)`);
        this.advanceCursor();
        return { nextHint, advanced: true };
      }
      console.log(`[3stage ${this.sessionId}] 出题游标:第 ${this.cursor + 1} 题本轮无有效作答(retry ${this.retryOnCurrent}/${QUESTION_PROGRESSION.maxRetryPerQuestion})→ 不推进,继续本题`);
      return { nextHint, advanced: false };
    }

    // 已有效作答:
    // design contract:去掉题目级 follow_up——所有题统一按「[[NEXT]] 主导」处理:已作答但 LLM 未示意
    //   收尾([[NEXT]] 未出)= AI 在澄清 / 或漏发哨兵 → 不推进、不抢推;答案正确性不在实时层判断。
    //   计 retry(达上限则 (d) 强制推进,防死循环);**服务端静默兜底**(media R3:静默超时先 nudge 问、再推进)兜住
    //   「AI 漏发 [[NEXT]] + 考生不再开口」的死锁(review)——不依赖考生再开口。推进仍以 [[NEXT]] 主导。
    // ★ design contract × design contract:staleAnswerStall 兜底放行(bypassGraceOnce)是**强推路径**(与 decline/retry 上限同级),
    //   MUST NOT 被「无 [[NEXT]] 不推进」拦截——否则陈货连续达上限兜底后起的 verify 轮若无 [[NEXT]] 会卡回 retry 分支、
    //   永远走不到 advanceIfVoiced 的 bypassGrace 推进(design contract 兜底失效)。故 bypassGraceOnce 置时直接走 advanceIfVoiced。
    if (turn.forceQuestionClosure) {
      console.log(`[3stage ${this.sessionId}] 追问预算 ${this.followUpCountForCursor}/${QUESTION_PROGRESSION.maxFollowUpsPerQuestion} → 强制收口推进`);
      this.advanceCursor(); // 强推语义:不经 answerGrace / voiced-gate
      return { nextHint, advanced: true };
    }

    // design contract:末题模型已明确说完整场收尾、但漏发 [[NEXT]] 时,不能把该收尾问句计成追问并继续停在末题。
    // 仅对「最后一题 + 有效作答 + 明确整场完成语义」做窄恢复;仍走 voiced-gate,避免未念题时被模型误收尾吞题。
    if (
      !nextHint &&
      this.cursor === this.questions.length - 1 &&
      turn.pendingReply !== undefined &&
      this.hasWholeSessionClosure(this.stripSentinels(turn.pendingReply))
    ) {
      console.warn(
        `[3stage ${this.sessionId}] 末题整场收尾漏 [[NEXT]] → 隐式推进并复用 terminal-completion piggyback`,
      );
      return this.advanceIfVoiced(true);
    }

    if (!nextHint && !this.bypassGraceOnce) {
      if (this.aiIsAsking(turn)) {
        this.followUpCountForCursor += 1;
        console.log(`[3stage ${this.sessionId}] 第 ${this.cursor + 1} 题追问已完整交付 ${this.followUpCountForCursor}/${QUESTION_PROGRESSION.maxFollowUpsPerQuestion} → 等用户回答`);
        return { nextHint, advanced: false };
      }
      this.retryOnCurrent += 1;
      if (this.retryOnCurrent >= QUESTION_PROGRESSION.maxRetryPerQuestion) {
        console.log(`[3stage ${this.sessionId}] 出题游标:第 ${this.cursor + 1} 题已作答但追问达上限 ${QUESTION_PROGRESSION.maxRetryPerQuestion} 次仍无 [[NEXT]] 且非问句收口 → 强制推进(防死循环)`);
        this.advanceCursor();
        return { nextHint, advanced: true };
      }
      console.log(`[3stage ${this.sessionId}] 出题游标:第 ${this.cursor + 1} 题已作答但未收尾([[NEXT]] 未出)→ 不抢推,给澄清回应/漏信号兜底空间(retry ${this.retryOnCurrent}/${QUESTION_PROGRESSION.maxRetryPerQuestion};静默兜底见 media R3)`);
      return { nextHint, advanced: false };
    }

    // 已作答且(LLM 示意收尾 [[NEXT]] / stale 兜底强推)→ 正常推进(受 design contract 信号①闭环门控 + design contract 宽限窗)。
    return this.advanceIfVoiced(nextHint);
  }

  /** design contract:「已作答 → 推进」的闭环门。开关关 → 直接推进(现状开环,逐字节等价)。开 → 仅当当前题
   *  已被 AI 独立念出(cursorVoiced)才推进;未念出 → 不推进(不吞题),但计 voicedStall,达 CURSOR_VOICED_MAX_STALL
   *  兜底强制推进(防 barge-in 误判等异常永久卡题,F5)。仅门控「正常已作答推进」;拒答/追问上限等强制推进不经此。 */
  private advanceIfVoiced(nextHint: boolean): { nextHint: boolean; advanced: boolean } {
    if (!CURSOR_VOICED_GATE || this.cursorVoiced) {
      // ★ design contract(答完补充宽限窗):这是**正常已作答放行**分支 —— 宽限窗开(ANSWER_GRACE_MS>0)时**不立即
      //   推进**,只记「待宽限推进意图」(pendingAdvance + nextHint),返回 advanced:false;真正推进推迟到
      //   fireAiDone 越过 pause defer、清 activeTurn 之后 armAnswerGrace() 起窗(§1 时序契约),窗内用户再开口
      //   取消(§2)、窗内无声到期才 advanceCursor+auto-next(§3)。**返回 advanced:false 使 maybeFireAiDone 里
      //   turn.autoNextAfterDone=false**(不在 fireAiDone 立即 auto-next;auto-next 由 fireAnswerGrace 到期发起)。
      //   关(<=0):逐字节等价现状——立即 advanceCursor + advanced:true。**仅此正常放行分支进宽限窗**;下面
      //   voicedStall 兜底(F5,防漏念永久卡题)+ maybeAdvanceCursor 里 decline/farewell/retry 上限的强推**不经窗**。
      // ★ design contract 评审 Major 3(review):**末题不走宽限窗**——若推进后即到末题(cursor+1>=题数),
      //   宽限窗对末题无收益(末题后无"下一题"可补充推进),反而会吞掉同轮 [[NEXT]]+[[END_CALL]]:grace 延迟
      //   使 cursor 未推进→maybeFireAiDone 的 `cursor<length` 把 END_CALL 当"未问完"压制清除→4s 后信号已丢、
      //   会话不自动收尾。故末题直接立即推进(cursor→末尾后 `cursor<length` 为 false,END_CALL 正常放行收尾)。
      // design contract Major 4:stale 兜底轮(bypassGraceOnce)= 强推,消费标志后立即推进不进窗。
      const bypassGrace = this.bypassGraceOnce;
      this.bypassGraceOnce = false; // 一次性:仅作用于紧随兜底放行的这一轮
      const isLastQuestion = this.cursor + 1 >= this.questions.length;
      if (ANSWER_GRACE_MS > 0 && !isLastQuestion && !bypassGrace) {
        this.pendingAdvance = true;
        this.pendingAdvanceNextHint = nextHint;
        return { nextHint, advanced: false };
      }
      this.advanceCursor();
      return { nextHint, advanced: true };
    }
    // 闭环开 + 当前题尚未被念出:考生的话多半在答上一题(AI 还没念出本题)→ 不推进(不吞题)。
    this.voicedStall += 1;
    if (this.voicedStall >= CURSOR_VOICED_MAX_STALL) {
      console.warn(`[3stage ${this.sessionId}] 出题游标闭环:第 ${this.cursor + 1} 题连续 ${this.voicedStall} 轮已作答但未检出 AI 念出 → 兜底强制推进(F5,可能 barge-in 误判致漏念,报警)`);
      this.advanceCursor();
      return { nextHint, advanced: true };
    }
    console.log(`[3stage ${this.sessionId}] 出题游标闭环:第 ${this.cursor + 1} 题已作答但 AI 尚未独立念出该题 → 不推进(不吞题,stall ${this.voicedStall}/${CURSOR_VOICED_MAX_STALL})`);
    return { nextHint, advanced: false };
  }

  /** 游标 +1,重置本题 retry 计数。到末题后续轮 composePrompt 走「已问完」收尾分支。 */
  private advanceCursor(): void {
    this.cursor += 1;
    this.retryOnCurrent = 0;
    this.followUpCountForCursor = 0;
    this.answerSeenForCursor_ = false; // design contract:新题从头——「本题作答过没有」复位(media 静默兜底分流据此)
    this.cursorVoiced = false; // design contract:新题尚未念出(信号①复位);voicedStall 归零重新计兜底
    this.cursorQuestionVerbatimVoiced = false;
    this.cursorQuestionPlaybackEndMs = 0;
    this.cursorQuestionPlaybackInterrupted = false;
    this.voicedStall = 0;
    this.staleAnswerStall = 0; // design contract:游标推进=新题 → 排水陈货兜底计数归零(否则上题兜底后残留,新题第一次
    //   stale 就立即又兜底、"连续 N 轮"保护失效)。与 voicedStall 同处同理复位。
    if (this.cursor >= this.questions.length) {
      console.log(`[3stage ${this.sessionId}] 出题游标:全部 ${this.questions.length} 题已问完 → 转入收尾`);
    } else {
      console.log(`[3stage ${this.sessionId}] 出题游标:推进到第 ${this.cursor + 1}/${this.questions.length} 题`);
    }
  }

  // ── design contract:答完补充宽限窗(延迟推进)──
  /** 起补充宽限窗(§1:MUST 由 fireAiDone 在越过 pause defer、清空 activeTurn、drain 未起新轮、autoNext 已消费
   *  之后调用——**不在 maybeAdvanceCursor 里**)。仅当有「待宽限推进意图」(pendingAdvance)且开关开(ANSWER_GRACE_MS>0)
   *  才 arm;否则 no-op。§6:arm 时清悬挂 lastFinalText / pendingDrain 快照(那是旧陈货,宽限窗只留给窗内新输入,
   *  防 M1×design contract 双重延迟)。捕获 armGen = 当前 graceGen,timer 回调 fireAnswerGrace(armGen) 入口比对(防迟到)。
   *  ★ design contract:`playbackNotBeforeMs`(aiDoneCb 返回)= 客户端估算播完起点。实际 delay =
   *    direct auto-next 截止线 = `max(turn.startedAt + ANSWER_GRACE_MS,
   *    playbackNotBeforeMs + AUTO_NEXT_GRACE_MS)`。模型思考/上一句播放可消耗 4s 窗,但用户轮保护不缩成 800ms,
   *    且客户端估算播完后仍至少留 AUTO_NEXT_GRACE_MS。其它正常推进继续用播放边界 + ANSWER_GRACE_MS,
   *    治缺陷1(此前从 tts_done 后即起算,长追问音频仍在播就推进)。undefined/void(旧/未实现)→ 退回现状 ANSWER_GRACE_MS
   *    (逐字节等价)。真机 turn 18 铁证:29.92s 音频但 answerGrace 仍 tts_done 后 ~4s 推进——本参数修这条早推进旁路。 */
  private armAnswerGrace(playbackNotBeforeMs?: number | void, turnStartedAtMs?: number): void {
    if (!this.pendingAdvance || ANSWER_GRACE_MS <= 0) return;
    // §6:清悬挂 lastFinalText —— 宽限窗只接窗内的新输入,不复用上一轮忙时悬挂的陈货(design contract pendingDrain)。
    this.lastFinalText = "";
    this.pendingDrainCursor = -1;
    this.pendingDrainVoiced = false;
    this.clearAnswerGraceTimer();
    // design contract:估算播完前的剩余(playbackNotBeforeMs 已含 R3 的 clamp/margin/fail-safe;finite 且 > now 才后移)。
    //   void/非 finite → 0(退回现状 ANSWER_GRACE_MS,逐字节等价)。
    const now = Date.now();
    const playbackLeadMs =
      typeof playbackNotBeforeMs === "number" && Number.isFinite(playbackNotBeforeMs)
        ? Math.max(0, playbackNotBeforeMs - now)
        : 0;
    const turnGraceRemainingMs =
      typeof turnStartedAtMs === "number" && Number.isFinite(turnStartedAtMs)
        ? Math.max(0, turnStartedAtMs + ANSWER_GRACE_MS - now)
        : ANSWER_GRACE_MS;
    const delayMs = this.pendingAdvanceNextHint
      ? Math.max(turnGraceRemainingMs, playbackLeadMs + AUTO_NEXT_GRACE_MS)
      : playbackLeadMs + ANSWER_GRACE_MS;
    this.armedAnswerGraceDelayMs = delayMs;
    const armGen = this.graceGen;
    this.answerGraceTimer = setTimeout(() => this.fireAnswerGrace(armGen), delayMs);
    (this.answerGraceTimer as unknown as { unref?: () => void }).unref?.();
    console.log(`[3stage ${this.sessionId}] design contract:第 ${this.cursor + 1} 题已作答 → 起补充宽限窗 ${delayMs}ms(用户轮剩余 ${turnGraceRemainingMs}ms;播放边界后移 ${playbackLeadMs}ms + autoNext 最小窗 ${this.pendingAdvanceNextHint ? AUTO_NEXT_GRACE_MS : ANSWER_GRACE_MS}ms;窗内再开口=续答不推进;nextHint=${this.pendingAdvanceNextHint})`);
  }

  /** 取消宽限窗(§2 用户开口 / §4 barge-in cancel):graceGen++ 作废在途 timer + 清定时器 + 清 pendingAdvance。
   *  用户开口 → 当本题续答(不推进);打断 → 用户接管(不兑现推进)。幂等(无 pending 时快速返回)。 */
  private cancelAnswerGrace(): void {
    if (!this.pendingAdvance && this.answerGraceTimer === null) return;
    this.graceGen += 1; // 作废任何已排队但尚未执行的迟到回调(fireAnswerGrace 入口比对 armGen)
    this.clearAnswerGraceTimer();
    this.pendingAdvance = false;
    this.pendingAdvanceNextHint = false;
    this.armedAnswerGraceDelayMs = 0;
  }

  private clearAnswerGraceTimer(): void {
    if (this.answerGraceTimer) {
      clearTimeout(this.answerGraceTimer);
      this.answerGraceTimer = null;
    }
  }

  /** 宽限窗到期回调(§3 入口守卫):armGen 与现 graceGen 不符(arm 后有新 speech/被 cancel)/ !pendingAdvance(已清)/
   *  endCallSignaled(会话要结束)/ activeTurn!==null(新轮已接管)→ **作废、不推进、不 auto-next**;否则
   *  advanceCursor() + maybeAutoAskNext()(到期正常推进 + 自动问下一题)。 */
  private fireAnswerGrace(armGen: number): void {
    // ★ design contract 评审 Major 2(review):**迟到 timer 的 stale callback 必须完全无副作用返回**——
    //   入口第一件事就比对代次,不匹配(arm 后被 cancel/新窗已起)则**不碰 answerGraceTimer、不碰 pendingAdvance**
    //   直接 return。否则:窗 A(armGen=5)被 cancel→窗 B(armGen=6,新 timer)已 arm,若 timer A 迟到执行会先
    //   `answerGraceTimer=null`(清掉 timer B 句柄)+ 清 pendingAdvance(废掉窗 B)→ 当前合法窗 B 被误废。
    if (armGen !== this.graceGen) {
      return; // stale:不是当前窗的 timer,无副作用退出(clearTimeout 已在 cancel/arm 里清过本 timer)
    }
    // 确认是当前窗的 timer 才清句柄 + 走守卫。
    this.answerGraceTimer = null;
    if (!this.pendingAdvance || this.endCallSignaled || this.activeTurn !== null) {
      console.log(`[3stage ${this.sessionId}] design contract:宽限窗到期但作废(pending=${this.pendingAdvance} endCall=${this.endCallSignaled} activeTurn=${this.activeTurn?.index ?? "null"})→ 不推进`);
      this.pendingAdvance = false;
      this.pendingAdvanceNextHint = false;
      this.armedAnswerGraceDelayMs = 0;
      return;
    }
    const graceDelayMs = this.armedAnswerGraceDelayMs;
    this.pendingAdvance = false;
    this.pendingAdvanceNextHint = false;
    this.armedAnswerGraceDelayMs = 0;
    console.log(`[3stage ${this.sessionId}] design contract:补充宽限窗 ${graceDelayMs}ms 无补充到期 → 推进游标 + 自动问下一题`);
    this.advanceCursor();
    this.scheduleContinuationAfterAdvance();
    this.maybeRunPendingContinuation();
  }

  /** 主动结束当前一轮(VAD 没命中尾静音 / 参与者主动结束发言):请 GPU finalize → asr_final+turn_end。 */
  endTurn(identity?: InputIdentity): void {
    this.gpu.flush(identity);
  }

  commitInput(inputEpoch: number, inputTurnId?: number): void {
    if (inputTurnId === undefined) {
      this.gpu.flushCurrentInput(inputEpoch);
      return;
    }
    this.gpu.flush({ inputEpoch, inputTurnId });
  }

  /** 主动开场(design contract):进会议室后持续静默无人开口时由媒体面驱动 → 跑一轮 kickoff LLM,
   *  让 AI 据 system_prompt 人设自然开场。用极短中性唤醒文本触发,**豁免拒垃圾门槛 + 不写 history**
   *  (见 runLlmTurn 的 isKickoff)。busy(已有活跃轮 / 真人已抢先触发轮)时忽略,不抢占。 */
  kickoff(): void {
    // 任何活跃轮(含 LLM 已返回但 TTS 仍在 drain 的轮)在场即忽略——kickoff 只在引擎完全空闲时开场,
    // 不抢占/不与在飞行的轮叠加(比裸 llmBusy 更严:llmBusy 在 TTS drain 期已 false,但 activeTurn 仍在)。
    if (
      this.activeTurn !== null ||
      this.pendingResponseSettlement !== null ||
      this.pendingTerminalTakeoverText
    ) {
      console.log(
        `[3stage ${this.sessionId}] kickoff 忽略:` +
        (this.activeTurn ? `已有活跃轮(turn ${this.activeTurn.index})` : "terminal 接管等待 cancel 边界"),
      );
      return;
    }
    console.log(`[3stage ${this.sessionId}] 主动开场 kickoff:据人设生成开场白(唤醒文本不写 history)`);
    void this.runLlmTurn(KICKOFF_WAKE_TEXT, true);
  }

  /** design contract/R3:让 AI 说一句系统指示的话(沉默警告/违规结束说明)。与 kickoff 同构(isKickoff-style:
   *  不写 history、不推进游标、跳过垃圾门槛),但把 instruction 作为**系统指令**注入(告诉 AI 说什么);AI 的
   *  回应正常出声 + 写转写(考生真听到)。busy 时忽略(不抢占活跃轮)。
   *  **返回是否被接受**(design contract,review):busy 被拒 → false,让上层知道这句**没送达**——违规
   *  强制结束据此**不能**就地绑 onAiDone(否则无关活跃轮的 onAiDone 会被误当「通知已播完」→ 没送达就挂;
   *  更严重:severe 首次警告若被静默丢弃,考生没听到警告就被当再犯结束)。接受 → true,该 notice 轮的 onAiDone
   *  即通知播完点。空文本视作未注入(false)。 */
  nudge(instruction: string): boolean {
    if (
      this.activeTurn !== null ||
      this.pendingResponseSettlement !== null ||
      this.pendingTerminalTakeoverText
    ) {
      console.log(
        `[3stage ${this.sessionId}] nudge 忽略:` +
        (this.activeTurn ? `已有活跃轮(turn ${this.activeTurn.index})` : "terminal 接管等待 cancel 边界") +
        "→ 返回未接受",
      );
      return false;
    }
    const text = (instruction ?? "").trim();
    if (!text) return false;
    console.log(`[3stage ${this.sessionId}] nudge:注入系统指示让 AI 说一句(不写 history/不推进游标):${text.slice(0, 40)}`);
    // 用「系统指示」包裹:告诉 AI 这是系统要求它对考生说的话,不是考生的输入。isKickoff=true → 不写 history、
    //   不推进游标(nudge 不是考生作答);AI 据此生成一句自然的口播(警告/说明)。
    void this.runLlmTurn(`【系统指示,请照此对对方说一句话,不要复述本指示】${text}`, true);
    return true;
  }

  // ── GPU 下行处理 ──
  private onGpuControl(msg: GpuControl): void {
    const identity =
      Number.isInteger(msg.input_epoch) && Number.isInteger(msg.input_turn_id)
        ? {
            inputEpoch: Number(msg.input_epoch),
            inputTurnId: Number(msg.input_turn_id),
          }
        : undefined;
    switch (msg.type) {
      case "asr_partial":
        this.abandonPlaybackSettlementForUserSpeech();
        this.noteQuestionPlaybackInterrupted();
        // ★ design contract(§2):用户一开口(补充宽限窗内的首个新 speech)就**立即**取消 grace,**不等 runLlmTurn**
        //   ——否则「3900ms 开口、5500ms 才 asr_final」时 4000ms timer 先触发误推进(重现「说着话被推进」)。
        //   仅 pendingAdvance 时动作(无待宽限窗则 no-op,不空 bump graceGen)。graceGen++ 作废在途 timer。
        if (this.pendingAdvance) this.cancelAnswerGrace();
        // ★ design contract 评审 Blocker(review):user 题号在**用户开口那一刻**(首个 asr_partial)捕获——那时游标还是
        //   他正在答的题。存起来供 asr_final 用;绝不在 asr_final 时重取(partial→上一轮推进→final 会误标下一题)。
        if (!this.userQuestionIndexCaptured) {
          this.pendingUserQuestionIndex = this.snapshotQuestionIndex();
          this.userQuestionIndexCaptured = true;
        }
        this.transcriptCb({
          text: String(msg.text ?? ""),
          isFinal: false,
          ...(identity ?? {}),
        });
        break;
      case "asr_final":
        this.abandonPlaybackSettlementForUserSpeech();
        this.noteQuestionPlaybackInterrupted();
        // ★ design contract(§2):asr_final 亦即时取消 grace(asr_partial 可能被 GPU 跳过、直接出 final 的路径兜底)。
        if (this.pendingAdvance) this.cancelAnswerGrace();
        // ★ design contract:user 题号用**开口时(首个 asr_partial)已捕获的快照**;若无 partial 前导(GPU 直接出 final),
        //   在此兜底捕获(此刻游标即用户正答的题,无 partial→final 间的推进窗)。绝不用「落库时的全局 cursor」。
        //   越界/无题 → undefined(不落 question_index)。asr_partial 不落库(partial 不带题号)。
        if (!this.userQuestionIndexCaptured) {
          this.pendingUserQuestionIndex = this.snapshotQuestionIndex();
          this.userQuestionIndexCaptured = true;
        }
        this.transcriptCb({
          text: String(msg.text ?? ""),
          isFinal: true,
          questionIndex: this.pendingUserQuestionIndex,
          ...(identity ?? {}),
        });
        // 把这一轮文本交给 LLM(turn_end 触发起流)
        this.lastFinalText = String(msg.text ?? "");
        // design contract:与文本原子同写捕获时游标身份 + 当前题 voiced 快照(每轮 asr_final 覆盖,防 async 交错 attach
        //   错游标)。排水消费时据此判「这句是不是产生于当前题念出之后」(捕获点在 asr_final 非 turn_end,review)。
        this.pendingDrainCursor = this.cursor;
        this.pendingDrainVoiced = this.cursorVoiced;
        break;
      case "turn_end": {
        // 新一轮开始:解除 barge-in 残音守卫(上一轮被打断的在途残音此时早已排空)。
        // terminal drain 接管已由本次 turn_end 发起时，必须继续等 cancel_ack/超时；重复 turn_end
        // 不能提前解除残音守卫或在 barrier 内插入另一轮。
        if (!this.pendingTerminalTakeoverText) this.interrupted = false;
        // ★ design contract:本语音轮结束 → 清 user 题号捕获标志,下一句语音轮在其首个 asr_partial 重新捕获
        //   (那时的游标才是下一句用户答的题)。
        this.userQuestionIndexCaptured = false;
        this.pendingUserQuestionIndex = undefined;
        // 误打断恢复(design contract):防御性清 tentative-pause —— 新轮起时不该有残留暂停(正常路径 resume/cancel
        //   已清;此处兜底,避免上一轮遗留 paused 把新轮音频误缓存)。丢缓存不续发(那是旧轮的)。
        if (this.paused) {
          console.warn(`[3stage ${this.sessionId}] turn_end 到达但仍处 tentative-pause(异常)→ 丢缓存 ${this.pausedAudioBuffer.length} 帧,清暂停态`);
          // ★ design contract:清暂停态前先兑现暂停期已播完、被 defer 的 onAiDone(否则完成回调静默丢失)。
          //   先快照并清 paused(fireAiDone 见 !paused 才不再 defer),再兑现。此分支理论不可达(暂停期
          //   aiSpeaking=true,入向只喂静音,GPU VAD 不该出 turn_end),纯防御一致性。若此刻 lastFinalText
          //   非空使兑现触发 design contract 排水消费该文本起新轮,与下面 `!llmBusy` 分支消费同一文本起 runLlmTurn
          //   等价(排水先起则 llmBusy=true,下面分支自然让位),不产生双轮。
          // ★ design contract(退出矩阵):防御性 turn_end **丢弃暂停缓存**(不续发)→ 兑现 completed=**false**
          //   (不读原始 deferredCompleted)。缓存被丢 = 对方没听到本轮 → 不推进、不启 waiting(此前按原始
          //   completed 兑现 = 缺陷,review)。仅 resume(真续发)保留原始 completed。
          // ★ design contract(评审 Major:语义标志泄漏)——completed=false 使 fireAiDone 跳过 advanceAndScheduleNext,
          //   而它内部才消费 nextSignaled([[NEXT]])/压制 endCallSignaled([[END_CALL]])。旧路径(推进整段在
          //   maybeFireAiDone、defer 前已跑 maybeAdvanceCursor)会消费 nextSignaled;迁移后 defer 轮不再消费 →
          //   本丢缓存轮的 [[NEXT]] 会污染下一轮推进、[[END_CALL]] 可能被 media wantsEndCall 读到误挂断。故此处
          //   **对齐 cancel(:397/400)显式清两标志**——丢缓存 = 本轮语义作废,不跨轮残留。
          this.nextSignaled = false;
          this.endCallSignaled = false;
          const deferredOnTurnEnd = this.deferredAiDoneTurn;
          this.paused = false;
          this.pausedTurn = null;
          this.pausedAudioBuffer = [];
          this.deferredAiDoneTurn = null;
          if (deferredOnTurnEnd && !deferredOnTurnEnd.aiDoneFired) {
            this.fireAiDone(deferredOnTurnEnd, false); // design contract:丢缓存 → completed=false(不推进/不 waiting)
          }
        }
        // 可观测性(真机「说一会就哑」定位):turn_end 到达时记 busy —— busy=true 会**忽略**本轮,
        // 若卡 busy(上轮没正常收尾)则 AI 永不再回话。这是头号嫌疑。
        const at = this.activeTurn;
        console.log(`[3stage] turn_end llmBusy=${this.llmBusy} ttsPending=${at?.ttsPending ?? 0} llmStreamComplete=${at?.llmStreamComplete ?? true}`);
        this.turnCb("turn_end", identity);
        // design contract:terminal 的 LLM 已返回但 TTS 尚未 drain 时,llmBusy=false 不能代表引擎空闲。若此时收到
        // 实质用户输入,直接 runLlmTurn 会替换 activeTurn,旧 terminal 永远失去 settle 身份,state 卡在
        // in_flight。只对 terminal 做接管:先复用 cancel 完整终结旧轮(in_flight→pending),再由下面正常
        // 消费路径起用户轮并原子 pending→in_flight。普通轮仍保留 design contract 的既有 drain 期行为。
        const { minChars: takeoverMinChars } = this.meaningfulInputThreshold();
        const terminalTakeover =
          !this.llmBusy &&
          at?.isTerminalCompletion === true &&
          !at.aiDoneFired &&
          !!this.lastFinalText &&
          meaningfulCharCount(this.lastFinalText) >= takeoverMinChars;
        if (terminalTakeover) {
          console.log(
            `[3stage ${this.sessionId}] terminal-completion TTS drain 期收到实质输入 → ` +
            "终结旧轮并由用户轮接管 terminal 身份",
          );
          // 当前 turn_end 已携带用户实质文本。先从通用即时消费槽移入专用 barrier，cancel 后保持
          // interrupted=true 丢弃旧 terminal 残音；等 cancel_ack（或既有有界超时）再启动用户轮。
          this.pendingTerminalTakeoverText = this.lastFinalText;
          this.lastFinalText = "";
          this.pendingDrainCursor = -1;
          this.pendingDrainVoiced = false;
          this.cancel("barge_in");
          this.armTerminalTakeoverBoundary();
        }
        if (this.pendingTerminalTakeoverText) {
          console.log(`[3stage ${this.sessionId}] turn_end 等待 terminal 接管 cancel 边界 → 暂不启动新轮`);
          break;
        }
        // busy 时不抢占、不动任何共享状态(忽略重复/并发 turn_end),避免活跃轮卡死(连续 turn_end 死锁)。
        // ★ design contract:suppressNewTurns(违规原因句 drain 期)→ 不起新轮(drain 期用户说话不打断正在播的原因句;
        //   drain 必以 session end 收尾,故残留 lastFinalText 不会被"drain 后"的轮回放)。
        if (!this.llmBusy && !this.suppressNewTurns) {
          const text = this.lastFinalText;
          // 消费:起新轮才清 lastFinalText(空 turn_end / 主动 flush 但本轮没识别到语音不会拿旧文本重答,review 二保)。
          this.lastFinalText = "";
          this.pendingDrainCursor = -1; // design contract:即时消费为正常轮 → 清已消费的悬挂快照(下个 asr_final 本会覆盖,防御性清)
          this.pendingDrainVoiced = false;
          const { inQuestionMode, minChars } = this.meaningfulInputThreshold();
          const chars = meaningfulCharCount(text);
          if (text && (minChars <= 0 || chars >= minChars)) {
            // direct auto-next 的 tts_done 早于客户端真正播完。若用户在估算播放终点前开口、且只留下
            // 极短确认词/残识，不把它送进 LLM 计 retry；服务端直接重播当前题，避免题干抑制后静默并最终跳题。
            if (this.shouldReplayInterruptedQuestion(text)) {
              console.log(
                `[3stage ${this.sessionId}] 当前题客户端播放中被打断 + 短输入="${text.slice(0, 20)}"` +
                "→ 直接重播当前题(不进 LLM/不计 retry)",
              );
              this.startDirectCurrentQuestion();
            } else {
              void this.runLlmTurn(text); // eligible 默认 true:即时消费的正常作答轮正常参与推进
            }
          } else {
            if (text) {
              console.log(
                `[3stage ${this.sessionId}] 拒垃圾输入:有效字符 ${chars} < 门槛 ${minChars}` +
                `(${inQuestionMode ? "游标模式" : "默认"};去标点后)→ 跳过本轮、不触发 LLM`,
              );
            }
            // terminal 被确认接管后会保留 pending。空/无效 ASR 的 turn_end 是 destructive cancel
            // 真正解除(interrupted=false)后的首个安全空闲点,必须重新兑现 continuation,不能永久静默。
            this.maybeRunPendingContinuation();
          }
        } else {
          // ★ 让位不丢输入(design contract(b) / review):自动问下一题轮已起(llmBusy)时用户开口的 turn_end 走此分支。
          //   **不清 lastFinalText**——保留本轮识别文本;消费时机 = **当前自动轮 onAiDone(llmBusy→false)后,
          //   下一个 turn_end**(本轮后续 turn_end 或下一轮)起新用户轮(用户话顺序排队,不吞)。
          //   陈旧防护:asr_final **每轮必到且先于 turn_end**(GPU WS 协议 design contract 保证 asr_final→turn_end 有序),
          //   空轮也发 asr_final text="" 覆盖 lastFinalText → 下次 turn_end 不会重答旧文本。
          console.log(`[3stage ${this.sessionId}] turn_end 遇 busy(自动轮/在飞行轮)→ 忽略但保留 lastFinalText="${this.lastFinalText.slice(0, 20)}"(让位不丢输入)`);
        }
        break;
      }
      case "tts_metrics":
        this.onGpuTtsMetrics(msg);
        break;
      case "tts_done": {
        // 每句合成完 -1;只有「LLM 流已出完 && 已下发句全部 tts_done」才触发 onAiDone(整轮真正播完)。
        // 不能每句就恢复——句间会误开入向,把 AI 后续句残音回灌进 ASR(review);也不能在 LLM 还在
        // 出后续句时归零就触发(B3:LLM 慢、GPU 快的句间空窗)。tts_done 归属当前活跃轮。
        const t = this.activeTurn;
        const identity = this.gpuTtsIdentity(msg);
        const currentSegment = t?.currentSegment();
        const matchesActiveSegment =
          !identity ||
          (!!t &&
            !!currentSegment &&
            identity.responseGeneration === t.index &&
            identity.turnSeq === t.index &&
            identity.segmentId === currentSegment.segmentId);
        if (matchesActiveSegment) {
          // A stale generation must not disarm the active turn's watchdog.
          this.noteTtsSignal();
        }
        if (t && t.ttsPending > 0 && matchesActiveSegment) {
          const completedSegment = t.completeSegment();
          t.ttsPending -= 1;
          if (completedSegment) {
            this.responseSegmentCompletedCb(this.segmentIdentity(completedSegment));
          }
          this.maybeFireAiDone(t);
        }
        console.log(`[3stage] tts_done ttsPending=${t?.ttsPending ?? 0} llmStreamComplete=${t?.llmStreamComplete ?? true}`);
        break;
      }
      case "cancel_ack":
        // 旁路核对(design contract):打断的实时效果由 Bridge 本地立即完成(停 Bedrock + interrupted 守卫 +
        // GPU cancel),消费 cancel_ack **不改任何通话状态**;仅落库被延迟的本轮 metrics(cancel_ack_timeout=false)。
        this.resolveCancelAck();
        break;
      case "error":
        // GPU/引擎错误:别静默丢弃(#13),交上层记录/收尾
        this.errorCb(String(msg.code ?? "INTERNAL"), String(msg.message ?? ""));
        break;
      case "bye":
        break; // 服务端正常收尾
      default:
        break;
    }
  }

  private lastFinalText = "";
  // ★ design contract(review 收敛):bridge 在违规原因句 drain 期置 true → turn_end **不自主起新 LLM 轮**
  //   (否则 drain 期用户说话 → runLlmTurn → 新 AI 音频打断正在播的原因句尾)。bridge arm drain 置、drain 完/teardown
  //   清。默认 false = 现状不变。**仅挡未来新轮,不碰当前正在播的轮**(不同于 cancel,后者会中止当前轮=误伤原因句)。
  public suppressNewTurns = false;
  // 对话历史(服务按 session 维护;客户端只发音频,不碰历史)。每轮完成后追加 user+ai。
  // 上限 40 条(~20 轮)防止 prompt 无限增长;超出截掉最旧的整轮。
  private history: LlmMessage[] = [];
  private static readonly MAX_HISTORY = 40;

  /** 写本轮 AI 文本进 history + 转写(design contract:统一入口,守「至多一次」防正常/打断路径双写)。
   *  - text:要落的 AI 文本(正常路径 = 完整 reply;barge_in 打断路径 = 已下发部分 + 截断标记);
   *  - isKickoff:kickoff / 自动问下一题轮的开场白**不进 history**(否则 history 以 assistant 开头,违反 Claude
   *    Messages「首条须 user」;design contract),但仍 llmTextCb 落转写/录音(evaluator 可见);
   *  - userText:本轮用户输入(仅正常路径进 history 配对;kickoff 的合成唤醒文本不进)。
   *  转写(llmTextCb)始终发(打断的半句也让人工复核/evaluator 看到用户实际听到的);仅 history 受 isKickoff 约束。 */
  private commitAiText(turn: SpeechTurn, text: string, isKickoff: boolean, userText: string): void {
    if (turn.historyWritten) return; // 至多一次(正常流末 vs cancel 打断,先到者写)
    turn.historyWritten = true;
    if (!text) return; // 空文本(纯哨兵/一句没下发)不写
    // design contract 信号①:本轮 AI 提交文本是否把**当前 cursor 题**独立念出 → 置 cursorVoiced(闭环推进条件之一)。
    //   在此处(commit 时)判:①开场 kickoff 念 Q1 → seed(F3);②正常轮念当前题 → 置位;③cancel 截断文本(念题
    //   中途被打断)通常不含完整题语义 → 不置位(F4/R4 不变量2:念到一半 ≠ 已念出,下轮重念)。仅有题时判。
    //   一旦置 true,同题内保持(cursorVoiced ||=),不因后续追问轮的短回复回退。
    // ★ design contract:带本轮 AI 题号快照(turn 创建时捕获,非此刻全局 cursor——AI 念完后已推进游标,读全局会误标下一题)。
    this.llmTextCb(text, turn.questionIndexSnapshot);
    if (turn.isTerminalCompletion && isKickoff) {
      // 自动 terminal 的唤醒文本不能伪造成 user。把可见收尾并入前一条 assistant,保持所有 provider
      // 都接受的 user/assistant 交替；替换对象而非原地改,避免污染已交给在途 LLM 的 history 快照。
      const last = this.history.at(-1);
      if (last?.role === "assistant") {
        this.history[this.history.length - 1] = { role: "assistant", content: `${last.content}\n${text}` };
      } else if (last?.role === "user") {
        this.history.push({ role: "assistant", content: text });
      } else {
        console.warn(`[3stage ${this.sessionId}] 自动 terminal 无可配对 history → 仅保留转写,不构造伪 user`);
      }
    } else if (!isKickoff) {
      // 包括“用户抢先消费 terminal pending”的轮:真实 userText 必须保留,不能只写 assistant。
      this.history.push({ role: "user", content: userText }, { role: "assistant", content: text });
    }
    // 交替 history 始终按偶数上限裁剪,避免 terminal 后续用户轮把首条截成 assistant。
    if (this.history.length > ThreeStageEngine.MAX_HISTORY) {
      this.history = this.history.slice(-ThreeStageEngine.MAX_HISTORY);
    }
  }

  private normalizedVerbatim(text: string): string {
    return (text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }

  private markQuestionVerbatimVoiced(turn: SpeechTurn): boolean {
    if (turn.questionIndexSnapshot === undefined || turn.questionIndexSnapshot !== this.cursor) return false;
    const question = String(
      (this.questions[turn.questionIndexSnapshot] as { text?: unknown } | undefined)?.text ?? "",
    );
    const normalizedQuestion = this.normalizedVerbatim(question);
    if (!normalizedQuestion || !this.normalizedVerbatim(turn.dispatchedText).includes(normalizedQuestion)) return false;
    this.cursorVoiced = true;
    // 短题完整播出也足以通过 voiced-gate，但不作为后续逐字重问抑制依据，避免短片段误删正常回复。
    if (normalizedQuestion.length >= MIN_VERBATIM_QUESTION_CHARS) {
      if (this.cursorQuestionPlaybackInterrupted) return false;
      this.cursorQuestionVerbatimVoiced = true;
      return true;
    }
    return false;
  }

  /** 题干服务端已 drain、客户端估算仍在播放时收到 speech：撤销“完整听到题干”的证据。 */
  private noteQuestionPlaybackInterrupted(): void {
    const active = this.activeTurn;
    if (
      active?.isDirectAutoNext &&
      !active.aiDoneFired &&
      active.questionIndexSnapshot === this.cursor
    ) {
      this.cursorQuestionVerbatimVoiced = false;
      this.cursorQuestionPlaybackEndMs = 0;
      this.cursorQuestionPlaybackInterrupted = true;
      console.log(
        `[3stage ${this.sessionId}] 当前题 direct TTS 服务端排水前收到用户 speech` +
        "→ 标记客户端播放中断，短输入将在排水后重播本题",
      );
      return;
    }
    if (
      !this.cursorQuestionVerbatimVoiced ||
      this.cursorQuestionPlaybackEndMs <= 0 ||
      Date.now() >= this.cursorQuestionPlaybackEndMs
    ) return;
    this.cursorQuestionVerbatimVoiced = false;
    this.cursorQuestionPlaybackEndMs = 0;
    this.cursorQuestionPlaybackInterrupted = true;
    console.log(
      `[3stage ${this.sessionId}] 当前题在客户端估算播放结束前收到用户 speech` +
      "→ 撤销完整念题证据，后续短输入直接重播本题",
    );
  }

  private shouldReplayInterruptedQuestion(text: string): boolean {
    const normalized = this.normalizedVerbatim(text);
    const replayIntent =
      /^(?:是(?:的)?|对(?:的)?|嗯+|好(?:的|啊|吧)?|继续(?:啊|吧)?|请继续|重说|再说一遍|再问一遍|没听清|没听到)$/.test(
        normalized,
      );
    return (
      this.cursorQuestionPlaybackInterrupted &&
      this.questions.length > 0 &&
      this.cursor < this.questions.length &&
      replayIntent
    );
  }

  /** 已完整念过当前题后,只删除再次逐字重念的题干跨度,保留同句中的正常回应。 */
  private suppressRepeatedQuestion(turn: SpeechTurn, text: string): string {
    if (!turn.questionAlreadyVoicedAtStart || turn.questionIndexSnapshot === undefined || !text) return text;
    const question = String(
      (this.questions[turn.questionIndexSnapshot] as { text?: unknown } | undefined)?.text ?? "",
    );
    const normalizedQuestion = this.normalizedVerbatim(question);
    if (normalizedQuestion.length < MIN_VERBATIM_QUESTION_CHARS) return text;

    const normalizedWithSourceRanges = (value: string): {
      normalized: string;
      ranges: Array<{ start: number; end: number }>;
    } => {
      let normalized = "";
      const ranges: Array<{ start: number; end: number }> = [];
      let sourceOffset = 0;
      for (const sourceChar of value) {
        const normalizedChar = this.normalizedVerbatim(sourceChar);
        for (let i = 0; i < normalizedChar.length; i++) {
          normalized += normalizedChar[i];
          ranges.push({ start: sourceOffset, end: sourceOffset + sourceChar.length });
        }
        sourceOffset += sourceChar.length;
      }
      return { normalized, ranges };
    };

    let visible = text;
    let suppressed = false;
    while (visible) {
      const mapped = normalizedWithSourceRanges(visible);
      const matchAt = mapped.normalized.indexOf(normalizedQuestion);
      if (matchAt < 0) break;
      const first = mapped.ranges[matchAt];
      const last = mapped.ranges[matchAt + normalizedQuestion.length - 1];
      if (!first || !last) break;
      visible = `${visible.slice(0, first.start)}${visible.slice(last.end)}`;
      suppressed = true;
    }
    if (!suppressed) return text;
    if (!turn.repeatedQuestionSuppressed) {
      turn.repeatedQuestionSuppressed = true;
      console.warn(
        `[3stage ${this.sessionId}] repeated_current_question_suppressed=true cursor=${turn.questionIndexSnapshot}`,
      );
    }
    return visible.trim();
  }

  /** 下发一句 TTS:轮级记账 +1、metrics 句计数、首句武装引擎级 TTS 超时看门狗(P0.4)。
   *  评审纠偏 1.1:仅当 turn 仍是当前活跃轮才下发——被 cancel 抢占的旧轮(activeTurn 已换走)即使 await 边界后
   *  sentencizer 仍吐残句,也 MUST NOT 下发(否则 armTtsWatchdog 等引擎级副作用污染新轮)。 */
  private dispatchTtsText(turn: SpeechTurn, spoken: string): void {
    if (this.activeTurn !== turn) return; // 已被抢占:不下发残句、不动引擎级看门狗
    spoken = this.suppressRepeatedQuestion(turn, spoken);
    if (!spoken) return;
    const segment = turn.declareSegment(spoken);
    if (turn.sentenceReadyAt === 0) turn.sentenceReadyAt = Date.now();
    this.responseSegmentDeclaredCb(segment);
    turn.ttsPending += 1; // 轮级 TTS 记账:每发一句 +1(tts_done 时 -1)
    turn.sentenceCount += 1;
    // 打断后上下文对齐(design contract):累加**已下发**文本(≈ 用户实际听到的);barge_in 打断时写这部分 + 截断标记
    //   进 history/转写,而非 LLM 完整 fullText。句已 strip 哨兵,逐句直接拼接(与 TTS 下发同粒度)。
    turn.dispatchedText += spoken;
    this.armTtsWatchdog(); // 首句即武装(已收信号/已 armed 则 no-op)
    this.gpu.sendTtsText(spoken, segment);
  }

  /** 游标推进后的下一题由服务端直接按原文下发 TTS，避免再等一次跨境 LLM TTFT。 */
  private startDirectAutoNext(): void {
    this.startDirectCurrentQuestion(true);
  }

  /** 当前游标题干由服务端直接下发；auto-next 与播放中断后的重播共用同一轮生命周期。 */
  private startDirectCurrentQuestion(autoNext = false): void {
    if (this.activeTurn !== null || !this.params || this.cursor >= this.questions.length) return;
    const question = String((this.questions[this.cursor] as { text?: unknown } | undefined)?.text ?? "").trim();
    if (!question) return;

    this.sentencizer.reset();
    const turn = new SpeechTurn(this.nextTurnIndex(), Date.now());
    this.rememberTurn(turn);
    turn.userText = KICKOFF_WAKE_TEXT;
    turn.isKickoff = true;
    turn.isDirectAutoNext = true;
    turn.cursorAdvanceEligible = false;
    turn.questionIndexSnapshot = this.snapshotQuestionIndex();
    // 每次 direct 出题/重播都是一次新的完整交付尝试；本次若再被开口截断，noteQuestionPlaybackInterrupted 会重置。
    this.cursorQuestionVerbatimVoiced = false;
    this.cursorQuestionPlaybackEndMs = 0;
    this.cursorQuestionPlaybackInterrupted = false;
    this.activeTurn = turn;
    this.responseStartedCb(this.responseIdentity(turn));
    this.ttsSignalSeen = false;
    this.clearTtsWatchdog();

    const language = String(this.params.language ?? "zh-CN").toLowerCase();
    const reply = language.startsWith("zh")
      ? `${autoNext ? "接下来，" : "刚才被打断了，我们重新来。"}${question}`
      : `${autoNext ? "Next, " : "That was interrupted. Let me ask again. "}${question}`;
    this.dispatchTtsText(turn, reply);
    turn.pendingReply = reply;
    turn.llmStreamComplete = true;
    turn.llmReturned = true;
    this.maybeFireAiDone(turn);
  }

  /**
   * 起一轮 Bedrock LLM 流,token 分句后逐句下发 GPU TTS。可被 cancel abort。
   *
   * 用 **SpeechTurn 对象身份**(而非 epoch 计数)标识"谁是当前轮":
   *  - 进入时仅在不 busy 时被调用(见 turn_end:busy 则忽略,不抢占);
   *  - 自己的 turn.signal.aborted = 被 cancel 打断;
   *  - finally 用 `this.activeTurn === turn` 判断"我仍是当前持有者",据此置 turn.llmReturned 释放 busy 守门。
   * 这样无论"连续 turn_end""cancel 后新轮"都不会让活跃轮卡死(修连续 turn_end 死锁)。
   *
   * 生命周期分层(design contract):
   *  - **LLM 执行子周期**:runLlmTurn 进入 → finally(置 llmReturned,释放 busy 守门);
   *  - **播报生命周期**:turn 起 → onAiDone(整轮 tts_done 收齐 / 打断 / 异常 / TTS 超时),activeTurn 存活至此。
   *    TTS drain(tts_done)在 finally **之后**才到,故 finally 不 null activeTurn —— 由 maybeFireAiDone /
   *    cancel / onTtsTimeout 终结。下一轮起 runLlmTurn 时新建 turn 替换 activeTurn(等价旧实现入口重置共享计数)。
   */
  private async runLlmTurn(
    userText: string,
    isKickoff = false,
    cursorAdvanceEligible = true,
    requestTerminalCompletion = false,
  ): Promise<void> {
    if (!isKickoff && userText) {
      this.abandonPlaybackSettlementForUserSpeech();
    }
    if (!userText || this.llmBusy || !this.params) {
      console.log(`[3stage] runLlmTurn skip: hasText=${!!userText} llmBusy=${this.llmBusy} kickoff=${isKickoff}`);
      return;
    }
    // 拒垃圾输入门槛(design contract):门控解除后漏网的单字残识(IVR 尾音 / 残碎字)去标点后 < 阈值 → 跳过本轮,
    // 不触发 LLM(治幻觉开场)。**kickoff 主动开场豁免**(它本就是空/极短唤醒,见 KICKOFF_WAKE_TEXT)。
    // 真人短开场(「你好」「在吗」均 2 字)≥ 阈值 → 正常触发,不误伤。记结构化日志(可观测,design contract)。
    //
    // ★ 出题游标模式豁免(design contract(a)):**有当前待问题时**(questions 非空且游标未越界),口算类**单字答案**
    //   (「8」「9」)有效字符仅 1,会被默认门槛 2 挡在 LLM 外 → 产不出 [[NEXT]] → 游标卡死要用户催。故游标模式
    //   把有效门槛降到 1(单字进 LLM,纯 0 字符仍跳过)。无题的纯人设对话 / kickoff 仍用 MIN_INPUT_CHARS(治幻觉
    //   开场,不误伤)。信 [[NEXT]]:LLM 只在真判定问答收尾才发,单字噪声残识不会触发推进(见 maybeAdvanceCursor)。
    // 游标模式**固定 1**(review):design contract(a) 契约数字即 1(单字答案进 LLM、纯 0 字符跳过),
    //   MUST NOT 跟随 MIN_INPUT_CHARS —— 否则运维设 AIM_MIN_INPUT_CHARS=0 时 `min(1,0)=0` 会让纯静默也进 LLM,
    //   破坏 R3(a)「纯 0 字符仍跳过」的硬保证。无题/kickoff 路径仍用 MIN_INPUT_CHARS(治幻觉开场)。
    // design contract:门槛来源改用 meaningfulInputThreshold 单一事实源(与 fireAiDone 排水共用);inQuestionMode
    //   布尔用于下方日志 label(不能从 minChars===1 反推,MIN_INPUT_CHARS 也可能配成 1)。
    const { inQuestionMode, minChars } = this.meaningfulInputThreshold();
    if (!isKickoff && minChars > 0) {
      const chars = meaningfulCharCount(userText);
      if (chars < minChars) {
        console.log(
          `[3stage ${this.sessionId}] 拒垃圾输入:有效字符 ${chars} < 门槛 ${minChars}(${inQuestionMode ? "游标模式" : "默认"};去标点后)→ 跳过本轮、不触发 LLM`,
        );
        return;
      }
    }
    // design contract:预算读取点固定在有效输入门之后、composePrompt 之前。已答过当前题时短确认("是的")也应收口;
    // 首次作答则仍须达到 minAnswerChars。max=0 完全跳过追问/漏 NEXT retry 路径。
    const forceQuestionClosure =
      !isKickoff &&
      this.questions.length > 0 &&
      this.cursor < this.questions.length &&
      this.followUpCountForCursor >= QUESTION_PROGRESSION.maxFollowUpsPerQuestion &&
      (this.answerSeenForCursor_ || meaningfulCharCount(userText) >= QUESTION_PROGRESSION.minAnswerChars);
    const consumeTerminalPending =
      this.questions.length > 0 &&
      this.cursor >= this.questions.length &&
      this.terminalCompletionState === "pending";
    const postTerminalFollowup =
      !isKickoff &&
      this.questions.length > 0 &&
      this.cursor >= this.questions.length &&
      this.terminalCompletionState === "delivered";
    if (requestTerminalCompletion && !consumeTerminalPending) return;
    // 用户抢先输入可替代自动问下一题；terminal pending 则把该用户轮标成收尾身份，防随后重复总结。
    if (!isKickoff) this.pendingAutoNext = false;
    // ★ design contract:**用户驱动的新轮**被接受(过 busy + meaningful-input 门,非 kickoff/nudge/系统主动轮)→ 通知 media
    //   下发 playback_superseded 清客户端 ring(根治「换轮旧音频续播」:tts_done 后旧轮音频仍在客户端播,用户提新问题
    //   → 清旧音频)。**权威事实**(engine 起了新用户轮),非客户端凭 transcript 误判(不踩 design contract);清 ring 安全
    //   由阶段1 tombstone 隔离保证不新旧混播。isKickoff(开场/nudge/违规通知/系统指示轮)豁免——它们不是用户换话题,
    //   不清旧尾巴(与 design contract 触发边界一致)。auto-next 走 startDirectAutoNext 独立路径,不经 runLlmTurn,天然豁免。
    //   media 无条件下发该单向帧；旧客户端按 v1 未知帧规则忽略。
    if (!isKickoff) this.userTurnStartCb();
    console.log(`[3stage] runLlmTurn start chars=${userText.length} kickoff=${isKickoff}`);
    this.sentencizer.reset();
    // 评审纠偏(Medium-2):若上一轮 activeTurn 仍滞留(busy 守门已因 llmReturned 释放,但 onAiDone 未触发——
    // 如「首句出过音频、第 N 句 GPU 黑洞」,该场景按 spec 由媒体面 aiSpeaking 看门狗恢复收听,但引擎侧该轮 metric
    // 会随 activeTurn 被本轮替换而丢失)→ 先补报其 partial metrics,不静默丢轮数据(纯旁路,不影响通话)。
    const stale = this.activeTurn;
    if (stale && !stale.aiDoneFired && !stale.metricsReported) {
      this.reportMetrics(stale, "partial");
    }
    // ★ design contract(候选 A):上一轮 LLM 已流完(pendingReply 已暂存)但尚未 fireAiDone 就被本轮替换
    //   (如快速连续轮:上轮 turn_end 后 llmReturned 释放 busy,tts_done 还没收齐,新轮 turn_end 已到)——
    //   该轮是**正常完成**被抢占(非 barge_in 打断),其完整 reply MUST 落库,否则 history 丢整轮上文
    //   (回归:多轮对话下一轮 LLM 拿不到上一轮 assistant)。
    //   ★ 关键不变量(评审:为何"有 pendingReply + !historyWritten ⇒ 一定是正常完成、不会是本该截断的轮"):
    //     pendingReply **仅在 LLM 流正常跑完时**设置(runLlmTurn 流末,见下方 `turn.pendingReply = reply`);
    //     若该轮后来被 cancel 打断,cancel 的 design contract 截断分支会先写截断版并置 historyWritten=true,
    //     本分支 `!stale.historyWritten` 守卫即挡下(不覆盖截断版)。故走到此处 = 流完 + 未被截断 = 正常完成。
    //     被打断/异常终结的轮 pendingReply 为 undefined(没走到流末暂存),不进此支。此处用 stale 自身 isKickoff/userText。
    if (stale && stale.pendingReply !== undefined && !stale.historyWritten) {
      this.commitAiText(stale, stale.pendingReply, stale.isKickoff, stale.userText);
    }
    // 起新 SpeechTurn(引擎权威 turn_index)。新建即替换 activeTurn —— 等价旧实现入口「this.ttsPending=0 /
    // llmStreamComplete=false」重置共享记账(B4:上一轮异常残留不污染本轮)。重置 TTS 超时看门狗状态。
    const turn = new SpeechTurn(this.nextTurnIndex(), Date.now());
    this.rememberTurn(turn);
    // 出题游标推进上下文(design contract):存本轮触发输入 + 是否 kickoff,供正常完成路径(maybeFireAiDone)评估推进。
    turn.userText = userText;
    turn.isKickoff = isKickoff;
    turn.cursorAdvanceEligible = cursorAdvanceEligible; // design contract:排水陈货轮为 false → maybeAdvanceCursor 顶部不推进
    turn.forceQuestionClosure = forceQuestionClosure;
    turn.isTerminalCompletion = consumeTerminalPending;
    turn.isPostTerminalFollowup = postTerminalFollowup;
    if (consumeTerminalPending) this.terminalCompletionState = "in_flight";
    // ★ design contract:AI 题号**事件快照**——turn 创建这一刻捕获(= AI 本轮所问的题的游标);commitAiText 落库 speaker=ai
    //   转写时用它,**不用** commitAiText 执行时的全局 cursor(AI 念完当前题后先推进游标再 fireAiDone→commitAiText,
    //   彼时全局 cursor 已 +1 → 会把本题 AI 文本误标下一题,双评审 Blocker)。越界/无题 → undefined(不落字段)。
    turn.questionIndexSnapshot = this.snapshotQuestionIndex();
    const answerChars = meaningfulCharCount(userText);
    const interruptedQuestion = this.cursorQuestionPlaybackInterrupted;
    turn.questionPlaybackInterruptedAtStart = interruptedQuestion;
    turn.questionAlreadyVoicedAtStart =
      this.cursorQuestionVerbatimVoiced ||
      (interruptedQuestion && answerChars >= QUESTION_PROGRESSION.minAnswerChars);
    // 实质用户输入已进入 LLM 即消费播放中断；本轮仍用上面的快照构造 prompt，后续短确认不得重播已回答的旧题。
    if (interruptedQuestion && !isKickoff) this.cursorQuestionPlaybackInterrupted = false;
    this.activeTurn = turn;
    this.responseStartedCb(this.responseIdentity(turn));
    this.ttsSignalSeen = false;
    this.clearTtsWatchdog();
    const signal = turn.signal;
    let fullText = ""; // 累积本轮 AI 完整文本(供 speaker=ai 转写,review)
    // LLM 首 token 超时(P2-9):超窗无首 token → 主动 abort 流 + 标记 ttftTimedOut(catch 走降级本轮失败)。
    let ttftTimer: ReturnType<typeof setTimeout> | null =
      LLM_TTFT_TIMEOUT_MS > 0
        ? setTimeout(() => {
            if (turn.firstTokenAt === 0 && !turn.signal.aborted) {
              turn.ttftTimedOut = true;
              turn.abort.abort();
            }
          }, LLM_TTFT_TIMEOUT_MS)
        : null;
    const clearTtft = () => {
      if (ttftTimer != null) { clearTimeout(ttftTimer); ttftTimer = null; }
    };
    let bufferedStreamTimer: ReturnType<typeof setTimeout> | null = null;
    const armBufferedStreamTimeout = () => {
      if (
        (
          !turn.forceQuestionClosure &&
          !turn.isTerminalCompletion &&
          !turn.isPostTerminalFollowup
        ) ||
        bufferedStreamTimer != null
      ) return;
      bufferedStreamTimer = setTimeout(() => {
        if (!turn.signal.aborted && !turn.llmStreamComplete) {
          turn.bufferedStreamTimedOut = true;
          turn.abort.abort();
        }
      }, QUESTION_PROGRESSION.forceClosureStreamTimeoutMs);
      (bufferedStreamTimer as unknown as { unref?: () => void }).unref?.();
    };
    const clearBufferedStreamTimeout = () => {
      if (bufferedStreamTimer != null) {
        clearTimeout(bufferedStreamTimer);
        bufferedStreamTimer = null;
      }
    };
    try {
      const llmTurn = {
        // 出题游标(design contract):有题时按 cursor 逐题注入(当前题干 + 已问摘要 + 进度;参考答案/未问题不可见);
        // 无题(纯人设对话)→ composePrompt 退回纯人设。this.systemPrompt 已含人设 + END_CALL_DIRECTIVE。
        systemPrompt: composePrompt(this.systemPrompt, this.questions, this.cursor, {
          forceQuestionClosure,
          questionAlreadyVoiced: turn.questionAlreadyVoicedAtStart,
          questionPlaybackInterrupted: turn.questionPlaybackInterruptedAtStart,
          terminalAlreadyDelivered: postTerminalFollowup,
        }),
        userText,
        modelId: this.params.llmModelId ?? DEFAULT_LLM_MODEL_ID,
        // temperature 不再从 Profile 配置;LLM 内部固定默认(bedrock-llm.ts: ?? 0.3)。
        history: [...this.history], // 注入此前轮次(后端维护),AI 才记得上文
      };
      for await (const token of this.llm.stream(llmTurn, signal)) {
        if (signal.aborted) break;
        // metrics:首 token 时延(本轮起 LLM → 第一个 token 到达)。
        if (turn.firstTokenAt === 0) {
          turn.firstTokenAt = Date.now();
          clearTtft();
          armBufferedStreamTimeout();
        }
        fullText += token;
        if (
          !turn.forceQuestionClosure &&
          !turn.isTerminalCompletion &&
          !turn.isPostTerminalFollowup
        ) {
          for (const sentence of this.sentencizer.push(token)) {
            if (signal.aborted) break;
            // 剥离语义哨兵([[END_CALL]] 挂断 + [[NEXT]] 出题推进),不让任何残形进 TTS 被念出来。
            const spoken = this.stripSentinels(sentence);
            if (!spoken) continue; // 整句就是标记 → 不下发空句
            this.dispatchTtsText(turn, spoken);
          }
        }
      }
      if (!signal.aborted) {
        let reply: string;
        if (turn.forceQuestionClosure) {
          // 强制收口的控制哨兵策略不受 AIM_SEMANTIC_END 开关影响:[[END_CALL]] 在此永远非法且不可见。
          const hasForbiddenEndCall = hasSentinel(END_CALL_RE, fullText);
          const visible = this.stripSentinels(fullText).replace(END_CALL_RE, "").trim();
          reply = this.forcedQuestionClosureText();
          if (visible !== reply || !hasSentinel(NEXT_RE, fullText) || hasForbiddenEndCall) {
            console.warn(
              `[3stage ${this.sessionId}] forced_question_closure_canonicalized=true cursor=${this.cursor}` +
              ` follow_up_count=${this.followUpCountForCursor}`,
            );
          }
          // 模型原文始终丢弃；固定文本是 TTS/transcript/history 唯一事实源。
          this.nextSignaled = true;
          this.endCallSignaled = false;
          if (reply) this.dispatchTtsText(turn, reply);
        } else if (turn.isTerminalCompletion) {
          const visible = this.stripSentinels(fullText);
          const hasControlSentinel =
            hasSentinel(NEXT_RE, fullText) ||
            (SEMANTIC_END && hasSentinel(END_CALL_RE, fullText));
          reply = this.terminalCompletionText();
          if (hasControlSentinel || visible !== reply) {
            console.warn(
              `[3stage ${this.sessionId}] terminal_completion_canonicalized=true reason=` +
              `${hasControlSentinel ? "control_sentinel" : "fixed_closure"}`,
            );
          }
          // 自动收尾只负责总结/询问补充,不得借模型输出推进或绕过两步挂断确认。
          this.nextSignaled = false;
          this.endCallSignaled = false;
          if (reply) this.dispatchTtsText(turn, reply);
        } else if (turn.isPostTerminalFollowup) {
          const visible = this.stripSentinels(fullText);
          if (!visible || this.hasWholeSessionClosure(visible)) {
            reply = this.postTerminalFollowupText();
            console.warn(
              `[3stage ${this.sessionId}] post_terminal_followup_replaced=true reason=` +
              `${!visible ? "empty" : "duplicate_closure"}`,
            );
          } else {
            reply = visible;
          }
          this.nextSignaled = false;
          this.endCallSignaled = SEMANTIC_END && hasSentinel(END_CALL_RE, fullText);
          if (reply) this.dispatchTtsText(turn, reply);
        } else {
          for (const tail of this.sentencizer.flush()) {
            const spoken = this.stripSentinels(tail);
            if (!spoken) continue;
            this.dispatchTtsText(turn, spoken);
          }
          // 语义挂断:全文含结束哨兵 → 标记本轮结束(media-session 在 onAiDone 后主动收尾);从落库/历史文本剥离。
          if (SEMANTIC_END && hasSentinel(END_CALL_RE, fullText)) this.endCallSignaled = true;
          if (this.questions.length > 0 && hasSentinel(NEXT_RE, fullText)) this.nextSignaled = true;
          reply = this.suppressRepeatedQuestion(turn, this.stripSentinels(fullText));
        }
        // ★ design contract 信号①:本轮 AI 完整输出(dispatchedText,= 实际下发/念出的文本)是否把**当前 cursor 题**
        //   独立念出 → 置 cursorVoiced。**置位落点 = 此处(runLlmTurn 流末),MUST 早于本轮 maybeFireAiDone**。
        //   真实调用链(勿误读,评审 曾按错误行号判此为 Blocker,实证顺序正确):
        //     runLlmTurn 流末【此处置 cursorVoiced】→ maybeFireAiDone()【内 maybeAdvanceCursor 读 cursorVoiced 决定推进】
        //     → 之后才 fireAiDone()【内 commitAiText】。故 maybeAdvanceCursor 读取时 cursorVoiced 已置位;
        //     若改到 commitAiText 里置位会晚于 maybeAdvanceCursor 一步、本轮推进读不到(实测 stall)——勿挪。
        //   用 dispatchedText 而非 fullText:被打断只念半句时 signal.aborted 已跳过本块 → 不置位(R4 不变量2:念到一半≠已念出)。
        //   一旦置 true 同题保持(!cursorVoiced 幂等),不因追问轮短回复回退。仅闭环开启时维护;
        //   防重复题干另用逐字完整匹配的 cursorQuestionVerbatimVoiced,不得复用本 30% 关键词近似。
        if (CURSOR_VOICED_GATE && this.questions.length > 0 && this.cursor < this.questions.length && !this.cursorVoiced) {
          const curText = String((this.questions[this.cursor] as { text?: unknown })?.text ?? "");
          if (questionVoiced(curText, this.stripSentinels(turn.dispatchedText))) this.cursorVoiced = true;
        }
        // ★ design contract(候选 A):LLM 流完**不立即** commit 完整 reply —— 而是暂存到 turn.pendingReply,待
        //   本轮真正终结(fireAiDone 内、aiDoneCb 之前)才落库。根因:流末即 commit 会置 historyWritten=true,
        //   若此刻音频还没播完(GPU 合成队列 / 客户端缓冲 / tentative-pause 的 pausedAudioBuffer)、随后被确认
        //   打断,cancel 的 design contract 截断分支(`!historyWritten` 守卫)会被抢先置真挡掉 → history 留完整
        //   reply(含用户没听到的后半段)、且无 [被打断] 标记,误导下一轮 LLM。推迟到 fireAiDone 后:正常播完
        //   走 fireAiDone commit 完整版;被打断走 cancel commit 截断版(彼时 historyWritten 仍 false),二者互斥。
        //   落点 MUST 在 fireAiDone 的 aiDoneCb() 之前:media-session onLlmText(转写+设告别旗)须先于 onAiDone
        //   告别决策(评审/review)。isKickoff/userText 随暂存,commit 时透传(kickoff 开场白仍不进 history)。
        turn.pendingReply = reply;
        // metrics:LLM 流出完时刻(算 llm_duration)。
        turn.streamCompleteAt = Date.now();
        // B3:LLM 流已出完,所有句已下发 → 解锁整轮结束门。若 GPU 已把全部 tts_done 发回(ttsPending 已
        // 归零),此刻补触发 onAiDone(否则那些 tts_done 早于 llmStreamComplete 到达,会被门挡住永不恢复)。
        // 注:LLM 出完但 0 句下发(纯哨兵/空回复)→ ttsPending=0 → maybeFireAiDone 即上报 full 收尾,
        //    引擎级 TTS 超时此时未武装(无 tts_text)亦无碍。
        turn.llmStreamComplete = true;
        this.maybeFireAiDone(turn);
      } else if (turn.ttftTimedOut || turn.bufferedStreamTimedOut) {
        // TTFT 超时 abort 后,若 LLM stream **优雅返回不抛错**(不进 catch)→ signal.aborted=true 跳过正常收尾。
        // (注:真实 undici 路径 abort 会**抛** "This operation was aborted" → 走下面 catch 的 ttftTimedOut 分支;
        //  此分支覆盖 fake-timer 单测 / 未来优雅返回的 streamer。两路同口径降级,勿删。)
        const timeoutReason = turn.bufferedStreamTimedOut
          ? `${turn.isTerminalCompletion ? "terminal-completion" : turn.isPostTerminalFollowup ? "post-terminal" : "强制收口"}` +
            `流完成超时 ${QUESTION_PROGRESSION.forceClosureStreamTimeoutMs}ms`
          : `LLM 首 token 超时 ${LLM_TTFT_TIMEOUT_MS}ms`;
        console.warn(`[3stage ${this.sessionId}] 轮${turn.index} ${timeoutReason} → 本轮失败(会话继续,不拆机)`);
        turn.llmFailed = true;
        turn.terminalStatus = "failed";
        turn.terminalReason = turn.bufferedStreamTimedOut ? "llm_stream_timeout" : "llm_ttft_timeout";
        turn.retireSegments();
        turn.ttsPending = 0;
        turn.llmStreamComplete = true;
        this.clearTtsWatchdog();
        this.reportMetrics(turn, "partial");
        this.fireAiDone(turn, false); // LLM 首 token 超时 → 本轮未把话说完(design contract)
      }
    } catch (err) {
      // #2:即发即弃的 LLM 流必须自己兜底,否则 unhandledRejection 杀进程。
      // AbortError(用户打断)是正常路径不降级;但 **TTFT 超时主动 abort**(ttftTimedOut)虽也抛 AbortError,
      // 属真实失败,须走降级(否则超时被当正常打断静默,本轮永久哑)。
      const name = (err as { name?: string })?.name;
      const isRealError =
        (name !== "AbortError" && !signal.aborted) ||
        turn.ttftTimedOut ||
        turn.bufferedStreamTimedOut;
      if (isRealError) {
        // ★ 可靠性(P2-9):LLM 流异常(跨境抖动/429/超时/连接 reset)**降级为本轮失败,会话继续**——
        //   而非 errorCb 拆机(此前一次跨境抖动即毁掉整场口试)。类比 onTtsTimeout 的"本轮失败不拆机"。
        //   跨境 LLM 是全链路最抖的一段,其失败不应是致命的。已发首句(llmReturnedText)则保留已说的;
        //   一句未出则本轮 AI 静默一轮,用户可继续说、下一轮重试。清残留记账避免卡死。
        // ★ 区分两因:TTFT 超时(我方 abort;undici 抛 "This operation was aborted",非真流错)vs 真流错。
        //   日志分开,否则超时被误记成"流异常"掩盖真因(deployment validation 排障即被此误导)。
        //   TTFT 超时附**实际等待时长**(elapsed):失败轮 metric 无 llm_ttft_ms(首 token 没到),
        //   elapsed 是唯一能量化"跨境慢到多少"的根因数据——以后再抖动可据此判断是否需再调阈值/换模型。
        const elapsedMs = Date.now() - turn.startedAt;
        const reason = turn.ttftTimedOut
          ? `LLM 首 token 超时 ${LLM_TTFT_TIMEOUT_MS}ms(实际等待 ${elapsedMs}ms 未出首 token)`
          : turn.bufferedStreamTimedOut
            ? `${turn.isTerminalCompletion ? "terminal-completion" : turn.isPostTerminalFollowup ? "post-terminal" : "强制收口"}` +
              `流完成超时 ${QUESTION_PROGRESSION.forceClosureStreamTimeoutMs}ms` +
              `(首 token 后未完成,实际轮耗时 ${elapsedMs}ms)`
            : `LLM 流异常: ${String((err as Error)?.message ?? err)}`;
        console.warn(`[3stage ${this.sessionId}] 轮${turn.index} ${reason} → 本轮失败(会话继续,不拆机)`);
        turn.llmFailed = true; // metrics 标志(可观测;非致命,不走 errorCb 拆机路径)
        turn.terminalStatus = "failed";
        turn.terminalReason = turn.bufferedStreamTimedOut
          ? "llm_stream_timeout"
          : turn.ttftTimedOut
            ? "llm_ttft_timeout"
            : "llm_stream_error";
        turn.retireSegments();
        turn.ttsPending = 0;
        turn.llmStreamComplete = true;
        this.clearTtsWatchdog(); // 本轮已异常终结,撤销 TTS 超时看门狗
        this.reportMetrics(turn, "partial"); // metrics:LLM 异常 → 合成未完成
        this.fireAiDone(turn, false); // LLM 流异常 → 本轮未把话说完(design contract);会话继续(不 errorCb 拆机)
      }
    } finally {
      clearTtft(); // 撤销 TTFT 超时定时器(正常出首 token 已清,此处兜底异常/打断路径)
      clearBufferedStreamTimeout();
      // LLM 执行子周期结束:置 llmReturned 释放 busy 守门(可起新轮)。**仅当"我仍是当前持有者"时**——
      // 被 cancel 抢占时 activeTurn 已被换走(this.activeTurn !== turn),其 busy 状态由抢占方负责,此处不动。
      // 注:此处**不** null activeTurn —— 正常路径本轮 TTS 还在 drain(tts_done 在 finally 之后到),
      //     activeTurn 须存活到 onAiDone;下一轮 turn_end 起新 turn 时自然替换。
      if (this.activeTurn === turn) {
        turn.llmReturned = true;
      }
    }
  }

  private responseIdentity(turn: SpeechTurn): ResponseIdentity {
    return {
      responseGeneration: turn.index,
      turnSeq: turn.index,
    };
  }

  private segmentIdentity(
    segment: Pick<ResponseSegmentIdentity, "responseGeneration" | "turnSeq" | "segmentId">,
  ): ResponseSegmentIdentity {
    return {
      responseGeneration: segment.responseGeneration,
      turnSeq: segment.turnSeq,
      segmentId: segment.segmentId,
    };
  }

  private gpuTtsIdentity(control: GpuControl): GpuTtsSegmentIdentity | undefined {
    const identity = control.ttsIdentity;
    if (
      !identity ||
      !Number.isInteger(identity.responseGeneration) ||
      !Number.isInteger(identity.turnSeq) ||
      !Number.isInteger(identity.segmentId)
    ) {
      return undefined;
    }
    return identity;
  }

  private onGpuTtsMetrics(control: GpuControl): void {
    const identity = this.gpuTtsIdentity(control);
    if (!identity) return;
    const turn = this.recentTurns.get(identity.turnSeq);
    if (!turn || identity.responseGeneration !== turn.index) return;

    const provider = typeof control.tts_provider === "string"
      ? control.tts_provider.trim()
      : "";
    const cacheState = control.cache_state;
    const generationWallTimeMs = this.nonNegativeNumber(control.generation_wall_time_ms);
    const generatedAudioDurationMs = this.nonNegativeNumber(control.generated_audio_duration_ms);
    const concurrency = this.nonNegativeNumber(control.concurrency);
    if (
      !provider ||
      generationWallTimeMs === undefined ||
      generatedAudioDurationMs === undefined ||
      concurrency === undefined ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      !this.isTtsCacheState(cacheState)
    ) {
      return;
    }

    const segmentMetric: GpuTtsSegmentMetrics = {
      segmentId: identity.segmentId,
      ttsProvider: provider,
      generationWallTimeMs,
      generatedAudioDurationMs,
      cacheState,
      concurrency,
      providerStartToFirstSendMs: this.nonNegativeNumber(
        control.provider_start_to_first_send_ms,
      ),
      rtf: this.nonNegativeNumber(control.rtf),
      modelFirstChunkUnavailableReason:
        typeof control.model_first_chunk_unavailable_reason === "string"
          ? control.model_first_chunk_unavailable_reason
          : undefined,
      cancelToLastModelComputeMs: this.nonNegativeNumber(
        control.cancel_to_last_model_compute_ms,
      ),
      cancelToLastGpuSendMs: this.nonNegativeNumber(
        control.cancel_to_last_gpu_send_ms,
      ),
    };
    if (!turn.noteGpuMetrics(segmentMetric)) return;

    const record = this.metricRecordsByTurn.get(turn.index);
    const segments = turn.gpuMetrics();
    const hasCancelTail =
      segmentMetric.cancelToLastModelComputeMs !== undefined ||
      segmentMetric.cancelToLastGpuSendMs !== undefined;
    if (record && (segments.length >= turn.sentenceCount || hasCancelTail)) {
      if (segments.length >= turn.sentenceCount) {
        this.applyGpuMetrics(record, segments);
      } else {
        // Cancel drops queued segments, so partial turns may never receive one
        // telemetry frame per declared sentence. Keep the measured tail while
        // withholding an incomplete steady-state RTF.
        this.applyPartialGpuMetrics(record, segments);
      }
      this.metricsCb(record);
    }
  }

  private applyPartialGpuMetrics(
    metric: EngineTurnMetrics,
    segments: GpuTtsSegmentMetrics[],
  ): void {
    if (segments.length === 0) return;
    const ordered = [...segments].sort((a, b) => a.segmentId - b.segmentId);
    const providers = new Set(ordered.map((segment) => segment.ttsProvider));
    metric.ttsProvider = providers.size === 1 ? ordered[0].ttsProvider : "mixed";
    metric.providerStartToFirstSendMs =
      ordered.find((segment) => segment.segmentId === 1)
        ?.providerStartToFirstSendMs;
    metric.modelFirstChunkUnavailableReason =
      ordered.find((segment) => segment.modelFirstChunkUnavailableReason)
        ?.modelFirstChunkUnavailableReason;
    const states = ordered.map((segment) => segment.cacheState);
    metric.ttsCacheState = states.includes("cold")
      ? "cold"
      : states.includes("warm")
        ? "warm"
        : states.every((state) => state === "not_applicable")
          ? "not_applicable"
          : "unknown";
    metric.ttsConcurrency = Math.max(
      ...ordered.map((segment) => segment.concurrency),
    );
    metric.concurrencyBucket = metric.ttsConcurrency === 1
      ? "1"
      : metric.ttsConcurrency <= 4
        ? "2-4"
        : "5+";
    metric.cancelToLastModelComputeMs = this.maxDefined(
      ordered.map((segment) => segment.cancelToLastModelComputeMs),
    );
    metric.cancelToLastGpuSendMs = this.maxDefined(
      ordered.map((segment) => segment.cancelToLastGpuSendMs),
    );
  }

  private applyGpuMetrics(
    metric: EngineTurnMetrics,
    segments: GpuTtsSegmentMetrics[],
  ): void {
    if (segments.length === 0) return;
    const ordered = [...segments].sort((a, b) => a.segmentId - b.segmentId);
    this.applyPartialGpuMetrics(metric, ordered);
    metric.ttsGenerationWallTimeMs = ordered.reduce(
      (sum, segment) => sum + segment.generationWallTimeMs,
      0,
    );
    metric.generatedAudioDurationMs = ordered.reduce(
      (sum, segment) => sum + segment.generatedAudioDurationMs,
      0,
    );
    metric.ttsRtf = metric.generatedAudioDurationMs > 0
      ? metric.ttsGenerationWallTimeMs / metric.generatedAudioDurationMs
      : undefined;
  }

  private rememberTurn(turn: SpeechTurn): void {
    this.recentTurns.set(turn.index, turn);
    this.trimMetricCaches();
  }

  private nextTurnIndex(): number {
    if (this.turnSeq >= this.maxTurnSeq) {
      throw new Error("ai_turn_id range exhausted for this connection");
    }
    this.turnSeq += 1;
    return this.turnSeq;
  }

  private trimMetricCaches(): void {
    while (this.recentTurns.size > 16) {
      const oldest = this.recentTurns.keys().next().value;
      if (oldest === undefined) break;
      this.recentTurns.delete(oldest);
      this.metricRecordsByTurn.delete(oldest);
    }
  }

  private nonNegativeNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  }

  private isTtsCacheState(value: unknown): value is TtsCacheState {
    return value === "cold" ||
      value === "warm" ||
      value === "not_applicable" ||
      value === "unknown";
  }

  private maxDefined(values: Array<number | undefined>): number | undefined {
    const present = values.filter((value): value is number => value !== undefined);
    return present.length > 0 ? Math.max(...present) : undefined;
  }

  private forcedQuestionClosureText(): string {
    const language = String(this.params?.language ?? "zh-CN").toLowerCase();
    return language.startsWith("zh")
      ? "好的,这个问题我们先到这里。"
      : "Okay, we'll leave this question here.";
  }

  private terminalCompletionText(): string {
    const language = String(this.params?.language ?? "zh-CN").toLowerCase();
    return language.startsWith("zh")
      ? "预设的问题都聊完了。你还有什么需要补充的吗？如果没有,我们就到这里结束。"
      : "We have finished the planned questions. Is there anything else you would like to add before we wrap up?";
  }

  private postTerminalFollowupText(): string {
    const language = String(this.params?.language ?? "zh-CN").toLowerCase();
    return language.startsWith("zh")
      ? "好的,你的补充我记下了。"
      : "Okay, I have noted your additional comment.";
  }

  private hasWholeSessionClosure(text: string): boolean {
    const language = String(this.params?.language ?? "zh-CN").toLowerCase();
    return language.startsWith("zh")
      ? /(?:(?:全部|所有|预设|这(?:几|些)个?).{0,12}(?:问题|题目)|(?:问题|题目).{0,12}(?:全部|所有|预设|这(?:几|些)个?)).{0,12}(?:聊(?:完|过)|完成|结束)/.test(
          text,
        )
      : /(?:(?:(?:all|planned)\s+(?:questions?|topics?)|(?:questions?|topics?).{0,16}(?:all|planned)).{0,24}(?:done|finished|completed)|(?:done|finished|completed).{0,24}(?:(?:all|planned)\s+(?:questions?|topics?)|(?:questions?|topics?).{0,16}(?:all|planned)))\b/i.test(
          text,
        );
  }

  private isPiggybackTerminalCompletion(turn: SpeechTurn): boolean {
    if (
      turn.forceQuestionClosure ||
      turn.isTerminalCompletion ||
      turn.questionIndexSnapshot !== this.questions.length - 1 ||
      turn.pendingReply === undefined
    ) {
      return false;
    }
    const visible = this.stripSentinels(turn.pendingReply).trim();
    return this.hasWholeSessionClosure(visible);
  }
}
