/**
 * 一场实时语音会话(客户端 WS 的服务端处置)—— design contract / VISION §3。
 *
 * 客户端连到服务 WS(?session_id=),上行 16k mono s16le PCM(binary)+ JSON 控制帧(text)。本类:
 *   - 把入向 PCM 喂 VoiceEngine(pushAudio);AI 播报期间做回声抑制
 *   - engine.onAudioOut → 回发 WS(客户端播放)
 *   - engine.onTranscript(FINAL)→ 双声道录音器记 + 转写落库
 *   - engine.onTurnEvent / onError → 记录;cancel(barge_in) 由上层 VAD 触发(此处提供钩子)
 *   - WS 关闭 / 引擎 error → 收尾:停录音上传 S3、停引擎、关连接
 *
 * join key = session_id 来自 ?session_id(backend 预创建 → 客户端凭 id 连入)——无反查、无 orphan。
 * 引擎/录音/转写全部依赖注入,便于单测(无需真实 GPU/Bedrock/S3/DDB/网络)。
 * 电话链路遗留(Teams IVR 门控/FS 播放尾窗/uuid_break 停声)已删(VISION §1)。
 */
import { Resampler } from "./resample";
import { StereoRecorder } from "./stereo-recorder";
import { TranscriptStore } from "./transcript-store";
import {
  MetricsStore,
  EndpointTurnMetrics,
  TurnMetrics,
} from "./turn-metrics";
import { loadTurnHandling } from "./turn-handling";
import { CancelReason, EngineParams, VoiceEngine } from "./voice-engine";
import { correctTranscript } from "./transcript-fixer";
import { judgeEou } from "./eou-verdict";
import { judgeModeration } from "./moderation-verdict";
import { bedrockConverseCompleteOnce } from "./bedrock-converse-llm";
// design contract:业务从 registry 的**冻结快照**读配置(与 /config 端点共读同一份,不各自解析 env)。
//   依赖方向 media-session → runtime-config → media-config(叶子),单向不成环。
import { RC } from "./runtime-config";
import { QUESTION_CUE_RE } from "./question-cue";
import { SpeakerLock, createSpeakerLock, loadSpeakerLockConfig, type Verdict } from "./speaker-lock";
import {
  PlaybackSettlementCoordinator,
  type AckTimeoutConfig,
  type Settlement,
} from "./playback-settlement";
import {
  type MediaSessionCommand,
  type MediaSessionOutputEvent,
  type MediaSessionResponseOutputEvent,
  type MediaSessionTransport,
  type UxTelemetryMetrics,
  MEDIA_SESSION_OUTPUT_LIMITS,
  UX_TELEMETRY_LIMITS,
} from "./media-session-port";
import {
  V1MediaSessionTransport,
  type WsConn,
} from "./media-session-v1-adapter";
export type { WsConn } from "./media-session-v1-adapter";

// 引擎下行 TTS 采样率(三段式 GPU + Nova 均 24k);FreeSWITCH audio_fork 与录音均吃 16k。
const ENGINE_TTS_RATE = 24000;
const FS_RATE = 16000;

// ── TurnHandling 配置收口(design contract)──:端点/打断/兜底参数收为单一对象(`turn-handling.ts`),
//    各 env 仅作覆盖入口,默认值与既有真机标定一致。模块加载即解析 + 守单一事实源不变式(endpoint ≥ GPU VAD),
//    违背 fail-fast(把 CDK assertEndpointAboveVad 守门下沉到运行时)。各分组语义见 turn-handling.ts:
//      - endpointing:端点看门狗(GPU VAD 不出 turn_end 时兜底,真机根因 deployment validation)
//      - interruption:barge-in 声学门槛 + minWords 内容门槛占位(默认 0)
//      - aiDoneWatchdog:aiSpeaking 安全看门狗(MiniMax 慢/丢 tts_done 不永久哑,design contract 真机根因)
const TH = loadTurnHandling();
const WATCHDOG_TICK_MS = 250; // 看门狗检查周期(固定,非策略参数)
const AI_SPEAKING_MAX_IDLE_MS = TH.aiDoneWatchdog.maxIdleMs;
const ENDPOINT_SILENCE_GAP_MS = TH.endpointing.silenceGapMs;
const ENDPOINT_RMS_THRESHOLD = TH.endpointing.rmsThreshold;
const ENDPOINT_MIN_SPEECH_MS = TH.endpointing.minSpeechMs;
// ── 会话开始后主动开场(design contract,P1,可关)──:客户端连入后持续静默达 silenceMs
//    无人先开口 → 经 engine.kickoff() 驱动 AI 据 system_prompt 人设主动开场一次(开场话术由人设生成,
//    不注入指令性长文本)。让位真人:静默期真人有效语音(达 minSpeechMs)即取消、本场不再主动开场。
//    「已开场」以 AI 出过开场音频为准(被打断/故障不算,有界重试)。关闭则回退被动等真人先开口(design contract)。
const PROACTIVE_OPENING = TH.proactiveOpening.enabled;
const PROACTIVE_OPENING_SILENCE_MS = TH.proactiveOpening.silenceMs;
// ── design contract:播放后推进时钟以「客户端估算播完」为起点(治 tts_done≠客户端播完的早推进,缺陷1)──
//   MAX_PLAYBACK_LEAD:超前量上限(clamp,防队尾虚高时长时间不推进);LEAD_MARGIN:播完余量(独立于 farewell TAIL)。
const MAX_PLAYBACK_LEAD_MS = TH.playbackClock.maxLeadMs;
const PLAYBACK_LEAD_MARGIN_MS = TH.playbackClock.leadMarginMs;
// ── 配置(design contract):默认值 + 解析器已下沉到叶子模块 `media-config.ts` ──
//   为什么不留在本文件:本文件既是「默认值的家」又要消费 registry(`runtime-config.ts`),
//   registry 直接 import 本文件会成真循环(加载顺序决定 RC 是否为 undefined,实证过)。
//   语义逐字未变(含 `?? D` 的空串得 0、`!== "0"` 默认开等口径差异),见 media-config.ts 头注释。

// RMS 诊断日志(真机标定端点阈值用):AIM_RMS_DIAG=1 开启,周期打印入向 RMS 分布,定位「底噪顶住 VAD」。
// 默认关(生产不刷屏);标定完可关。打印周期(帧)避免每 20ms 一条爆量。诊断开关非 turn-taking 策略,留 env。
const RMS_DIAG = RC.media.rmsDiag;
const RMS_DIAG_EVERY = RC.media.rmsDiagEvery; // 每 N 帧打一次(~25×20ms=0.5s)

// 语义挂断(真机:用户/AI 互道「拜拜」后会话仍 in_progress 空挂到 meeting_end)。检测到告别语义后,
// 待 AI 把告别话说完(onAiDone)再延迟 HANGUP_DELAY 主动收尾。env AIM_FAREWELL_HANGUP=0 可关。
const FAREWELL_HANGUP = RC.media.farewellHangup;
const FAREWELL_HANGUP_DELAY_MS = RC.media.farewellHangupDelayMs;
// design contract:收尾挂断按**已下发音频时长**推算「客户端播放完成时刻」再切,治「跨境告别句尾音被固定 1.5s 延迟切断」。
//   WS 单向下发无播放回执 → 不追求「真播完」,用服务端可精确观测的量(onAudioOut 按帧 N/2/16000 累计的本轮
//   已下发音频总时长 + 首帧时刻)推算:waitMs = min(max(0,(t_firstAudio+T_audio)−now)+TAIL, DRAIN_MAX)。默认关。
// 网络传输 + 客户端 jitter/播放缓冲余量(推算播完之上再等一小段,覆盖固定量级的传输/缓冲)。默认 1000ms。
const FAREWELL_TAIL_MS = RC.media.farewellTailMs;
// drain 硬上限:防 tts_done 丢失 / T_audio 异常 / 音频黑洞致推算值过大而永久不挂;到点强制收尾。
// 部署验证 8s 会截断仍在浏览器队列中的正常告别,默认提高到 20s;真播放完成仍由 design contract ACK 闭合。
const FAREWELL_DRAIN_MAX_MS = RC.media.farewellDrainMaxMs;
// LLM 语义挂断(两步确认,与 three-stage END_CALL_DIRECTIVE 同源):开时挂断**只**由 LLM 的 wantsEndCall
// (= [[END_CALL]],已两步确认门控)驱动,正则 aiSaidFarewellThisTurn **不**单独触发挂断——后者是「AI 一说
// 拜拜就挂」的粗判,真机误挂根源(ASR 误识→AI 误说再见→挂),且与「挂前先确认」相悖。仅 SEMANTIC_END=0
// (无 LLM 信号)时,正则告别才作兜底挂断。env AIM_SEMANTIC_END=0 关 LLM 语义端(与 three-stage 对称)。
const SEMANTIC_END = RC.media.semanticEnd;
// 告别词(中英)。匹配整段**以告别词收尾**(去尾部标点/空白后),避免「不拜拜了」「拜拜糖」「再见面」误命中。
// 注:ASR finalize 带标点(use_itn),告别句几乎总以句号结尾(「拜拜。」),故必须先剥尾部标点再判收尾。
const FAREWELL_PATTERNS: RegExp[] = [
  /(拜拜|再见|再會|回头见|下次聊|先这样|就这样吧|挂了|挂电话|结束(吧|通话))$/,
  /\b(bye|goodbye|bye-?bye|see\s+you|talk\s+later)$/i,
];
// 尾部标点/空白(中英标点都算):剥掉后再判是否以告别词收尾。含波浪号 ~/～(AI/聊天常以「拜拜~」收尾,
// 不剥则 `$` 锚定的告别词匹配不到 → 真告别漏判、空挂到 meeting_end,review 实测)。
const _TRAILING_PUNCT = /[\s.!?。!?,，、…~～]+$/;
// 否定/意愿保护(review:防误挂「我不是要拜拜」「先不要挂电话」「不想结束吧」)——含明确否定/反义意愿时
// 句尾告别词是反义,一票否决。收窄到**明确否定搭配**:不/别/甭/无需/不用 + 不想/不要/没想 + 还没/还不 +
// don't/won't/can't/not/never;**不**用裸「没」(否则误杀「没有了,拜拜」这类真告别——review 真机原话)。
// 原则:宁可漏挂(用户再说一次 / 超时收尾)也不误挂正在通话的人。
const FAREWELL_NEGATION = /(不要|不想|不是|别|甭|无需|不用|没想|还没|还不|先不|先别)|(\b(do\s*n.?t|don|won.?t|can.?t|not|never)\b)/i;
// 继续意愿保护(review:句尾告别词把「挽留+客套收尾」误判告别)——AI 礼貌收尾常以「拜拜~」结尾却
// 同句表达继续(「我们继续聊吧,接着说说…」)。出现**明确继续对话**语义即一票否决句尾告别,防误挂。
// 与 FAREWELL_NEGATION 并列(否定 = 不想走;继续 = 还要聊),二者任一命中都不算告别。
// ★ 收窄(review)——**剔除** 另外/稍等/等一下/等等 等
//   填充/连接词:它们高频出现于**真告别**客套中(「祝顺利,另外有问题随时联系,拜拜~」「就这样吧,再见」),
//   裸子串命中会误否决真告别 → 空挂到 meeting_end(正是本模块要防的)。只保留**无歧义的「继续当前对话」**短语。
// ★ 二次收窄(review)——「继续」后缀**必填**(去掉 `?`):
//   裸「继续」仍是高频告别客套子串(「继续保持联系,拜拜」「继续推进这个事,下次再聊,拜拜」),
//   只有「继续聊/说/讲/说说」才无歧义指向「继续当前对话」。
const FAREWELL_CONTINUE = /(继续(聊|说|讲|说说)|接着说|接着聊|我们再(聊|说)|再聊聊|还有(个|些|点)?(问题|事|事儿|疑问))/;

function isFarewell(text: string): boolean {
  const t = (text || "").trim().replace(_TRAILING_PUNCT, "");
  if (!t) return false;
  if (FAREWELL_NEGATION.test(t)) return false; // 明确否定/反义意愿 → 非告别(防误挂)
  if (FAREWELL_CONTINUE.test(t)) return false; // 明确继续意愿 → 非告别(挽留/客套收尾,防误挂)
  return FAREWELL_PATTERNS.some((re) => re.test(t));
}

// ── design contract:用户「离开意图」检测(自由聊天挂断放行判据,专用契约,不复用 isFarewell)──
//   根因(review):isFarewell 的 FAREWELL_PATTERNS 是 `$` **后缀锚定**——只认"句尾以告别词结束",
//   认不出「我要走了 / 我得走了 / 不聊了 / 我要去忙了」这类**非句尾**离开意图,而它们正是 design contract 放行场景。
//   引擎另有更宽的 FAREWELL_INTENT_RE,但**无 NEGATION/CONTINUE 保护**(易误判)。故此处定义**独立契约**:
//   覆盖后缀告别 + 非句尾离开意图,并复用 isFarewell 的 NEGATION/CONTINUE 防误挂资产。
//   与引擎 FAREWELL_INTENT_RE 语义不同(那份服务 design contract「有题告别→放弃当前题强制推进」),不合并、各自演进。
// 离开意图短语(不锚定句尾,可出现在句中):明确的"要走/要结束/不聊了"。收窄避免误伤——要求明确措辞。
const USER_LEAVE_INTENT_RE =
  /(我?(要|得|想)(走|走了|离开|下线|下了)|我(先)?走了|不聊了|不想聊了?|结束(吧|通话|对话|聊天)|到此为止|就(先)?这样吧|先这样|要去忙|去忙了|下次(再)?(聊|说)|拜拜|再见|回头见|挂了|挂断|\bbye\b|goodbye)/i;
// 引述保护(review):「他让我跟你说拜拜 / 帮我转告…再见」是转述他人,非本人离开意图 → 不算。
const LEAVE_INTENT_QUOTED = /(让我(跟|对|向)你?说|帮我(跟|对|向)|转告|带(个|句)话|他说|她说|他们说)/;
// 离开意图否定/疑问保护(review 误挂风险):
//   ①「(算了)我不走了 / 不走 / 别走」= 明确不走(FAREWELL_NEGATION 不含"不走",故独立补一条);
//   ②疑问/反问句(以 吗/呢/吧? 收尾或含"是不是…了吗")= 用户在问、不是在宣告离开 →「我要走了吗?」不置 latch。
//   宁漏挂不误挂:这两类一票否决离开意图(判不准偏"不放行")。
const LEAVE_INTENT_NEGATION = /(不走了?|别走|甭走|不(用|想|需要)(走|离开|结束|挂))/;
// 注意:「吧」不入疑问尾——它是**建议/祈使**语气助词(「结束吧/再见吧」是明确离开意图,非疑问),
//   只认无歧义的疑问尾「吗/呢」+ 问号,及「是不是…了」结构。否则会把「结束吧」误判成疑问漏放行。
const INTERROGATIVE_TAIL = /(吗|呢)\s*[?？]?$|[?？]$|是不是.*了/;

/** design contract:用户本轮文本是否表达**明确的离开意图**(要走/结束/不聊了/告别)。
 *  复用 isFarewell 的 NEGATION(「我不是要走」)/ CONTINUE(「还有个事/继续聊」)一票否决 + 引述 + 离开否定 + 疑问保护。
 *  用于自由聊天挂断放行的 latch 触发(design contract):命中 → 进 LEAVE_PENDING;判不准偏保守(不命中=不放行,宁漏挂不误挂)。 */
export function isUserLeaveIntent(text: string): boolean {
  const t = (text || "").trim().replace(_TRAILING_PUNCT, "");
  if (!t) return false;
  if (FAREWELL_NEGATION.test(t)) return false;   // 「我不是要走 / 先别挂」→ 非离开意图
  if (FAREWELL_CONTINUE.test(t)) return false;   // 「继续聊 / 还有个事」→ 非离开意图(想继续)
  if (LEAVE_INTENT_QUOTED.test(t)) return false; // 「他让我跟你说拜拜」→ 转述,非本人离开
  if (LEAVE_INTENT_NEGATION.test(t)) return false; // 「算了我不走了 / 别走」→ 明确不走(review)
  // 疑问保护:原文(未剥尾标点)判——「我要走了吗?」是问不是宣告。用原始 text 保尾部 ?。
  if (INTERROGATIVE_TAIL.test((text || "").trim())) return false; // 疑问/反问 → 不置 latch(review)
  return USER_LEAVE_INTENT_RE.test(t);
}

// ── barge-in(design contract):AI 播报期间用户插话 → 打断 AI。难点:入向可能含 AI 自己的回声
//    (客户端扬声器外放回传;浏览器 AEC 会压掉大半,但不保证),故用**更高阈值 + 多帧连续确认**:
//    只有显著高于回声、且持续 ≥ 确认时长的语音才判定为真插话。阈值/确认时长 env 可调(真机标定)。
const BARGE_RMS_THRESHOLD = TH.interruption.rmsThreshold; // 固定阈值(DTD 关时用):远高于端点阈值(压回声)
const BARGE_CONFIRM_MS = TH.interruption.confirmMs; // 连续高能量持续这么久才确认打断
const BARGE_HANGOVER_MS = TH.interruption.hangoverMs; // 低于门槛容忍窗:真人浊/清音交替的短暂跌落不清零累计
// reference-aware 双讲检测 DTD(design contract):用 AI 回发参考能量自适应阈值,治「真人插话与 AI 回声能量重叠」死局。
const BARGE_DTD_ENABLED = TH.interruption.dtdEnabled;
const BARGE_DTD_FLOOR = TH.interruption.dtdFloor; // AI 静默时的地板阈值(低于固定阈值,可识别被回声重叠的真人)
const BARGE_DTD_ECHO_GAIN = TH.interruption.dtdEchoGain; // 入向回声 ≈ echoGain × AI 参考 RMS;超此才算双讲(真人)
// ── 动态噪声地板(诊断 021-metrics-diagnosis-deployment validation;review 双 review 收敛)──:高底噪环境(入向
//   p50≈1500 恒 > 固定 floor 700)致 AI 一开口就被环境噪声误判打断。把入向噪声基线(近窗 AI 静默帧 p20)
//   喂进 DTD 的 floor 项:effectiveFloor = max(dtdFloor, baseline×k)。**单门自适应**,非加第二道 AND 门
//   (review 否决 AND:致召回雪崩)。仍叠 echoGain×AI参考。关 → 回退固定 dtdFloor。
const BARGE_DYN_FLOOR_ENABLED = TH.interruption.dynFloorEnabled;
const BARGE_DYN_FLOOR_WINDOW_MS = TH.interruption.dynFloorWindowMs;
const BARGE_DYN_FLOOR_K = TH.interruption.dynFloorK;
// AI 开口冷却窗(design contract):开口首 openCooldownMs 内 bargeThreshold ×mult 抬门槛,压开口期塌陷误触发。默认 0=关。
const BARGE_OPEN_COOLDOWN_MS = TH.interruption.openCooldownMs;
const BARGE_OPEN_COOLDOWN_MULT = TH.interruption.openCooldownMult;
// design contract:恢复窗能量域顺延硬上限(0=关,退回固定 wall-clock)。
const RECOVERY_MAX_HOLD_MS = TH.interruption.recoveryMaxHoldMs;
// ── 误打断恢复(design contract,借鉴 LiveKit false_interruption_timeout,默认关)──:开启时打断确认后
//   先 tentative-pause(engine.pause,不销毁),恢复 episode 内泄漏累计证据超 takeover = 真接管 → engine.cancel 销毁;
//   窗满无接管 → engine.resume 续播 + 记 false_interruption。默认关时行为回退 design contract(确认即 engine.cancel 硬切)。
const RECOVERY_ENABLED = TH.interruption.recoveryEnabled;
const RECOVERY_WINDOW_MS = TH.interruption.recoveryWindowMs;
const RECOVERY_TAKEOVER_MS = TH.interruption.recoveryTakeoverMs;
// takeover 泄漏累计:高能量 +1ms/ms,低能量 -recoveryTakeoverDecay ms/ms。默认 0.5 时 300ms 静默
// 移除 150ms 证据;密集真人语音仍净增长,稀疏背景尖峰不会跨长静默误累计。
const RECOVERY_TAKEOVER_DECAY = TH.interruption.recoveryTakeoverDecay;
// 声纹锁定(design contract)可调参数**单一事实源 = speaker-lock.ts::loadSpeakerLockConfig**(评审二审 Major-2:
//   不再在此重复解析同一 env)。media-session 经 `this.speakerLock.config.{enrollMs,enrollGapMs,minVerifyMs,
//   verifyWindowMs}` 读取,与 verify() 内层用的 cfg 同一份,消除双解析漂移。
// design contract:旁路 EOU 纠偏(默认关)。判 incomplete 后 correlationMs 内对该轮 barge 门槛乘 subThresholdMult
//   (< 1,降门槛),让考生亚常规阈重新出声也触发 tentative-pause 让位。
const EOU_CORRECTION_ENABLED = TH.eouCorrection.enabled;
// ★ design contract:关联窗与降门槛窗**解耦为两个独立参数**(此前共用 correlationMs —— review
//   发现的真缺陷:为跨境把超时/关联窗调到 6000,会顺带把考生「反悔接话」的宽容期从 2500 拉长到 6000,
//   即 2.4 倍的**行为改变**而非超时调整)。两者语义互不相干:
//     - EOU_CORRELATION_MS(默认 7000):judge 回来还算不算数 —— 由跨境 TTFT 决定。
//     - EOU_SUB_THRESHOLD_WINDOW_MS(默认 2500):考生宽容期 —— 与网络无关,由「思考停顿多久还算没说完」决定。
const EOU_CORRELATION_MS = TH.eouCorrection.correlationMs;
const EOU_SUB_THRESHOLD_WINDOW_MS = TH.eouCorrection.subThresholdWindowMs;
const EOU_SUB_THRESHOLD_MULT = TH.eouCorrection.subThresholdMult;
// design contract:旁路违规裁判(仅当控制面下发 llmModerationModelId 才跑,同 fixer 靠 model 存在门控,无独立 enable)。
//   R2 阶段 **shadow only**:只 log 分类+耗时,不产生任何用户可感知动作(计数/警告/挂断在 R1/R4/R3,由
//   AIM_VIOLATION_ENFORCEMENT 门控)。裁判本身默认运行以观察准确率(evaluator_model 恒下发),但 shadow 不改行为。
const MODERATION_CONFIDENCE_THRESHOLD = RC.media.moderationConfidenceThreshold; // 高置信才判违规(宁漏勿误);夹 (0,1]
// 注:R4(review)把 idle 裁判改为**串行**(idleChatterInFlight 门,保 verdict 按轮序 → streak 连续语义正确)。
//   原并发上限 AIM_MODERATION_MAX_INFLIGHT 随之移除(串行下至多 1 个在飞行,并发已无意义)。裁判是 shadow/best-effort
//   旁路,串行的采样率对真机 FP 标定足够(跨境 ~1-2s < 一轮问答 ~5-15s,大部分轮裁判在下一轮前完成)。
// design contract:沉默防作弊(服务端计时,不走 LLM)。全部**仅在 AIM_VIOLATION_ENFORCEMENT 开时**产生用户可感知
//   动作(警告/挂断);关时只 log 计数(shadow)。默认关(真机验证误判率前不启用)。
const VIOLATION_ENFORCEMENT = RC.media.violationEnforcement;
const SILENCE_VIOLATION_MS = RC.media.silenceViolationMs; // 沉默阈值(等待作答期连续无有效语音超此 → 计一次)
const SILENCE_WARN_MAX = RC.media.silenceWarnMax; // 前 N 次警告,第 N+1 次 fail 挂断
const NO_FRAME_MS = RC.media.noFrameMs; // 入向无帧超此 = 断流(物理断连,不计沉默)
// ── design contract:静默超时先问再推兜底(解 review 死锁:AI 收尾漏发 [[NEXT]] 且考生不再开口)──
//   仅在**当前题已判有效作答**(engine.answerSeenForCursor()=true)时启;未作答的静默归 design contract 防作弊轨(互斥分流)。
//   两级:静默达 ADVANCE_NUDGE_MS → nudge 问「还有补充吗」;nudge 播完后再静默 ADVANCE_AFTER_NUDGE_MS → 服务端主动推进。
//   ★ 全环境自洽(review):**默认值派生自 SILENCE_VIOLATION_MS**(nudge=40%、after=40%,总和 80% < violation),
//     保证不同环境(测试小值 / 北京 20s override / 默认 10s)下 R3 兜底总时长恒 < 沉默违规阈值——不靠硬编码 5000/4000。
//     显式 env 覆盖仍走 fail-fast 校验(见下)防人为倒挂。
const ADVANCE_NUDGE_MS = RC.media.advanceNudgeMs; // 默认 = violation 40%
const ADVANCE_AFTER_NUDGE_MS = RC.media.advanceAfterNudgeMs; // 默认 = violation 40%
// ★ design contract 全环境自洽 fail-fast(review):R3 兜底总时长 MUST < design contract 沉默违规阈值,否则「答完的善意
//   静默」在 R3 推进前先被 049 当消极对抗误判。派生默认(80% < 100%)天然满足;仅当**显式 env 覆盖**破坏此不变式 → 启动即抛
//   (不留「本地/测试环境 049 抢跑」隐患)。R3 关(AIM_R3_SILENCE_ADVANCE=0)时不校验(无 R3 语境)。
const _r3EnvOverridden = RC.media.r3EnvOverridden;
if (RC.media.r3SilenceAdvance && _r3EnvOverridden
    && ADVANCE_NUDGE_MS + ADVANCE_AFTER_NUDGE_MS >= SILENCE_VIOLATION_MS) {
  throw new Error(
    `[design contract] 配置非法:AIM_ADVANCE_NUDGE_MS(${ADVANCE_NUDGE_MS}) + AIM_ADVANCE_AFTER_NUDGE_MS(${ADVANCE_AFTER_NUDGE_MS}) ` +
      `MUST < AIM_SILENCE_VIOLATION_MS(${SILENCE_VIOLATION_MS})——否则答完的善意静默会先被 design contract 沉默违规误判。`,
  );
}
// design contract:R3 兜底默认开(不同于 design contract enforcement 默认关)——它是「防死锁」非「防作弊」,漏发 [[NEXT]] 卡死
//   是真实体验灾难(部署回归)。env AIM_R3_SILENCE_ADVANCE=0 关(回退:无兜底,漏发 [[NEXT]] 靠 retry 上限,
//   考生不再开口则卡到 max_duration——即修复前行为)。
const R3_SILENCE_ADVANCE = RC.media.r3SilenceAdvance;
// design contract:离题三分接裁判分类。`unrelated_chatter`(高置信)**连续跨 ≥N 轮重复**才计一次消极对抗(与沉默
//   合并进 negativeCount 同一警告阶梯)——单轮偶发离题不算(防误伤;on_topic/decline/uncertain 从不计违规)。
const IDLE_CHATTER_MIN_TURNS = RC.media.idleChatterMinTurns; // 默认跨 2 轮重复(可配)
// design contract:违规强制结束前「先说明原因再挂」的硬超时兜底。forcedEndAfterNotice 注入原因句后等该轮 onAiDone
//   (原因句播完)才真 end();若原因句卡住(LLM/TTS 故障 onAiDone 永不来)→ 到此上限强制 end,防永不结束。
const FORCED_END_MAX_WAIT_MS = RC.media.forcedEndMaxWaitMs;
// design contract:严重违规(色情/暴力/威胁定向辱骂)硬结束阈值——severeViolationCount < 此值 → AI 警告一次;
//   >= 此值 → 违规强制结束。默认 2(第 1 次警告、第 2 次结束)。与消极对抗轨(沉默/idle)计数**独立**。
const SEVERE_VIOLATION_MAX = RC.media.severeViolationMax;
// 注:R4(4.2)裁判 answer_complete **辅助推进票已砍**(见 design contract「4.2 决策:砍掉」)。原设计跨 media/engine
//   边界绑轮身份本质困难(裁判在 asr_final 起、SpeechTurn 在 turn_end 才建,引擎 busy 时票错配到别的答案,review 两轮
//   实证竞态);且用户明确它只是「泛泛建议、游标保持不动」。故不做——游标推进逐字节保持现状(design contract)。
// 注:电话版的「FS 播放尾窗」(BARGE_DRAIN_TAIL_MS)与「uuid_break 清缓冲」(BARGE_CLEAR_PLAYBACK)
// 已随 FreeSWITCH 删除:打断的即时停声 = 停发帧(engine.cancel 切源)+ 信令 barge_in 帧通知客户端
// 清本地播放队列(修复电话版「打断不即时停声」缺陷,MIGRATION-PLAN §2.2)。

/** 16k s16le PCM 帧 RMS(int16 量纲),用于服务侧端点检测。 */
function pcmRms(buf: Buffer): number {
  const n = Math.floor(buf.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export interface MediaSessionConfig {
  sessionId: string;
  systemPrompt: string;
  engineParams: EngineParams;
  /** 声纹锁定说话人(design contract):effective_speaker_lock(index.ts 已裁定 = Agent 请求 && kill-switch && recovery)。
   *  true 才启用注册 + 打断声纹门;缺省/false → 不启用(打断逐字节等价现状)。 */
  effectiveSpeakerLock?: boolean;
  /** 播放 ACK(design contract):**客户端**声明 `playback_ack_v1` capability 才传(index.ts 协商)。
   *  缺省/undefined → 无 ACK 上行(不发 ai_audio_start/end、不建 coordinator)。
   *  ★ design contract:服务端 mode 三态已删,结算恒生效;且 **undefined 不影响 `playback_superseded` 下发**
   *  (清 ring 是单向通知,见 constructor 内 onUserTurnStart 挂载点)。 */
  playbackAck?: { cfg: AckTimeoutConfig };
}

export interface MediaSessionDeps {
  engine: VoiceEngine;
  recorder?: StereoRecorder | null;
  transcripts?: TranscriptStore | null;
  /** 每轮实时性 metrics 落库(design contract,旁路);默认不接(测试/无 DDB 时)。 */
  metrics?: MetricsStore | null;
  /** 会话正常收尾(对端断开/会话结束)时回报控制面(completed,带时长/录音)。默认不接。 */
  onEnded?: (info: { durationS: number; hasRecording: boolean; reason: CancelReason; earlyExit?: boolean }) => void;
  /** 声纹锁(design contract):注入式,供测试传 stub embedder 的实例;缺省时 begin() 据 effectiveSpeakerLock 自建真实实例。 */
  speakerLock?: SpeakerLock | null;
}

function isMediaSessionTransport(
  value: WsConn | MediaSessionTransport,
): value is MediaSessionTransport {
  return (
    "protocolNeutral" in value &&
    value.protocolNeutral === true &&
    typeof value.onCommand === "function"
  );
}

export class MediaSession {
  private aiSpeaking = false;
  private lastAiAudioAtMs = 0; // 最近一帧 AI 音频流出时刻(aiSpeaking 安全看门狗用,判「播报早停但没收到 onAiDone」)
  private aiSpeakingSinceMs = 0; // AI 本轮开口时刻(aiSpeaking false→true 的**跃变**帧;design contract 开口冷却窗用)。0=未在说
  // design contract:本 AI 轮已下发音频统计(收尾挂断按此推算客户端播放完成时刻)。首帧流出时刻 + 累计时长(ms)。
  //   新 AI 轮(aiSpeaking false→true 跃变)重置。按最终下发的 16k s16le 帧字节精确算(N/2/16000 秒),非估字数。
  private aiTurnFirstAudioAtMs = 0; // 本轮首帧 AI 音频流出时刻;0=本轮尚无音频
  private aiTurnAudioMs = 0; // 本轮已下发 AI 音频累计时长(ms)
  // ── design contract:会话级客户端播放边界估算(**红线:会话级队尾,非单轮**)──:多轮音频可能排在同一浏览器
  //   时间轴上,单轮 firstAudioAt+audioMs 会低估。维护会话级队尾:每帧 onAudioOut `= max(now, end) + frameMs`;
  //   服务端确定客户端已清队列(barge-in:onBargeIn 下行 barge_in 帧 / 客户端上行 barge_in)才**显式**重置 = now。
  //   **独立于单轮 aiTurn* 统计**,不受 markAiDonePlaying 清零影响(这正是选会话级而非单轮快照的原因,R3 实现陷阱)。0=尚无音频。
  //   **正常播完无独立重置信号**(review):由累加式 `max(now,tail)+frameMs` 隐式处理——下一轮出音频时
  //   若前轮已播完(now>tail)自然从 now 起算;残余虚高由 MAX_PLAYBACK_LEAD clamp 兜住。真「客户端已播完/已中止」的
  //   显式回执属 P1 ACK(本 spec 无 ended 下行信令)。**user final 不重置**(review 前端 stopPlayback 无版本
  //   协商,旧客户端不清队列 → 归零会低估真实播放时间)。
  private estimatedClientPlaybackEndMs = 0;
  private closed = false;
  private teardownInProgress = false;
  private started = false;
  // 语义挂断状态机(review 收敛):挂断的**充分条件 = 本轮 AI 自己也说了告别**(双方互道再见)
  // 或 LLM 语义判定结束(wantsEndCall)。单凭用户说「拜拜」**不**挂断 —— 否则 AI 因 LLM 报错没回话(onLlmText
  // 不触发)/ AI 挽留 / 用户改主意,都可能空挂。userSaidFarewell 仅作「用户已表达告别」的上下文,不单独触发挂断。
  private userSaidFarewell = false; // 本轮对方说了告别(上下文;不单独触发挂断)
  // ── design contract:自由聊天(无题)两步确认 latch(**非 lifetime sticky**,会清除)──
  //   初稿的 lifetime sticky 被双评审否决(review):一旦置真永不复位 → 用户早期一次被误判 /
  //   说完告别又改主意聊很久,latch 仍真 → 后续任一轮 LLM 误输出 [[END_CALL]] 即被放行**误挂**,违背"宁漏挂不误挂"。
  //   改 latch:用户表达离开意图 → 置真(进 LEAVE_PENDING);出现"继续对话"信号(FAREWELL_CONTINUE / 实质新内容 /
  //   barge-in / N 轮未收尾)→ 清回 false。误判窗被限定为**单轮**(继续对话即清)。仅无题(!hasQuestions)时参与挂断判据。
  private leaveIntentPending = false; // latch:用户已表达离开意图、正走两步确认流程(仅自由聊天用)
  private leavePendingTurns = 0;      // 进入 LEAVE_PENDING 后经过的 AI 轮数(达上限自动放弃,防陈旧悬挂)
  private static readonly LEAVE_PENDING_MAX_TURNS = 2; // N 轮未挂未确认 → 清 latch(design contract (d) 放弃防御)
  private aiSaidFarewellThisTurn = false; // 本轮 AI 的回复本身是告别(onLlmText 判定;onAiDone 据此挂断)
  private hangupTimer: ReturnType<typeof setTimeout> | null = null; // 语义挂断延迟 timer;新语音/新轮到来时取消
  private startedAtMs = 0; // begin() 时刻,用于算会话时长回报控制面
  // 回声抑制静音 buffer 缓存(design contract):AI 播报期每帧喂全零给引擎压回声,原每帧 Buffer.alloc(~50帧/s)
  //   放大 GC 压力。改缓存一个**只读**零 buffer,按帧长 subarray 复用(≤ 缓存切片,> 则扩容)。
  //   ★ 别名安全前提:此 buffer **从不被写**(它是静音,gpu-client.emitAudio 只 ws.send 读它,ws@8.x Buffer
  //     入参 read-only;sendAudio ready 前入队持有引用,但持有的也是不可变静音 → 复用切片不改旧内容)。
  //   ★ 不变式(review):回声抑制期 detectBargeIn(data) 用**真实音频** data、pushAudio 用**静音切片**,
  //     两者不可混淆;detectBargeIn 及下游(noteNoiseRms/noteRefRms)MUST NOT 持有入参 buffer 引用(只提取 RMS)。
  private silenceBuf: Buffer = Buffer.alloc(0);
  // 下行 24k → 16k 重采样(B1/B2):有状态、跨 chunk 连续,回发客户端 + 录音前统一降采样。
  private downsampler = new Resampler(ENGINE_TTS_RATE, FS_RATE);
  // ── 端点看门狗状态 ──
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private speechMsSinceTurn = 0; // 本轮累计「在说话」的毫秒(达 MIN_SPEECH 才算有效一轮)
  private lastSpeechAtMs = 0; // 最近一次检测到说话的时刻
  private turnPending = false; // 本轮已有有效语音、等待端点(turn_end)
  private lastFlushAtMs = 0; // 最近一次看门狗 flush 时刻(gap 节流 + 有界重试,等自然 turn_end)
  private bargeMs = 0; // AI 播报期插话证据(ms);初判按 hangover,暂停后按高能量增加/低能量缓降
  private bargeDipMs = 0; // 确认窗内低于门槛的连续毫秒(hangover 计时;超 BARGE_HANGOVER_MS 才清零 bargeMs)
  // ── 误打断恢复(design contract):tentative-pause 状态机 ──:RECOVERY_ENABLED 开时,疑似打断确认(bargeMs≥
  //   confirmMs)→ engine.pause + 进入 tentativePausing(不销毁)。此后用泄漏累计器维护接管证据:
  //   高能量 +1ms/ms、低能量按 recoveryTakeoverDecay 线性缓降;达 takeoverMs → 真接管 → engine.cancel 销毁(走 onBargeIn);
  //   恢复窗满无接管 → engine.resume + false_interruption。短自然跌落不会清零,长静默会消掉稀疏尖峰证据。
  private tentativePausing = false; // 已进入 tentative-pause(等接管确认 / 窗满 resume)
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null; // 恢复窗计时器(窗满 → resume)
  private tentativePauseStartMs = 0; // design contract:tentative-pause 起点(能量域顺延的硬上限从此算)
  private bargeEvidenceStartedAtMs = 0; // 本次声学 episode 首个过阈帧(Bridge clock)
  private activeAudioTurnId: number | null = null; // 最近已下发 ai_audio_start 的轮;pause 身份源
  private pauseSequence = 0; // 会话内单调 tentative-pause episode id
  private tentativePauseIdentity: { aiTurnId: number; pauseId: number } | null = null;
  // 注:误打断(false_interruption)标记写进本轮 pendingEndpoint(见 onRecoveryWindowElapsed),
  //     不用 session 级旗,天然绑定正确 turn(避免跨轮误附;review)。
  // ── 声纹锁定说话人(design contract)──:effectiveSpeakerLock 开时启用。注册累计(AI 未在说的干净连续说话段
  //   ≥ enrollMs → 取 embedding + 多段一致性 → refEmb)+ 异步单飞打断声纹门(detectBargeIn 命中 confirmMs
  //   且已 ENROLLED → beginTentativePause 占位 + 异步 verify → TARGET 确认接管 / NONTARGET resume+cooldown /
  //   UNCERTAIN 交现有能量证据决定 = fail-open)。null = 不启用(打断逐字节等价现状)。
  private speakerLock: SpeakerLock | null = null;
  // 播放 ACK(design contract):协商成功才建(cfg.playbackAck)。observe/enforce 均建;null = 未协商(逐字节等价现状,
  //   不发 ai_audio_start/end)。observe 下只记指标不驱动推进;enforce(Phase 5)由其驱动播放依赖副作用。
  private playbackCoordinator: PlaybackSettlementCoordinator | null = null;
  private enrollAccumMs = 0; // 当前注册候选段已累计的干净目标语音时长(ms;AI 未在说 + 连续 + 能量在区间)
  private speakerVerifyEpisode = 0; // 打断 episode 序号:验证回调按发起时快照比对,防 stale 跨 episode 误裁
  private speakerVerifyPending = false; // 本 episode 已发起异步验证(避免 tentative-pause 内重复发起)
  // 声纹门旁人压制(评审/review 二审:**scoped 到当前 tentative-pause**,非跨 episode sticky——后者若旁人→
  //   目标人间隙 < hangover 会永久压制目标人=fail-CLOSED 破 D1)。NONTARGET 在**本 pause 内**置 true → 阻断本 pause
  //   的能量 takeover(旁人不得接管)+ 立即 resume;**每次 beginTentativePause 重置**,故绝不泄漏到目标人的新 pause。
  private pauseBystanderConfirmed = false; // 本 tentative-pause 已判旁人 → 阻断本 pause takeover(pause 结束即失效)
  private pauseVerifyDone = false; // 本 tentative-pause 已发起过一次声纹验证(每 pause 至多一次,防 UNCERTAIN 后逐帧重发)
  private enrollSegChunks: Buffer[] = []; // 当前注册候选段累积的 PCM 帧(复制,不持入参引用);达 enrollMs 拼接送 GPU
  private enrollAwaitingBoundary = false; // review:一段已提交后,须等长静音/turn 边界才允许攒下一段(防同一长句伪装两段)
  private enrollGapMs = 0; // 当前注册段内的连续静默(超阈判「段结束」丢弃未满段,防跨长静音拼成假连续段)
  private bargeWindowChunks: Buffer[] = []; // 当前打断候选窗的高能量 PCM 帧(复制);confirmMs 命中时拼接送 GPU 验证
  private bargeWindowMs = 0; // bargeWindowChunks 已累计时长(ms;有界,超 config.verifyWindowMs 丢最早帧)
  private suppressedBystanderCount = 0; // 声纹门拦下的旁人误打断次数(结构化日志,供真机量化核心收益)
  // ── DTD 参考能量(design contract)──:AI 回发参考 RMS 的近端滚动峰值。回声相对回发有
  //   ~100-300ms 时延,故 detectBargeIn 比对「最近一段时间内 AI 参考的峰值 RMS」(覆盖回声时延),而非当前瞬时。
  private refRmsWindow: { rms: number; atMs: number }[] = []; // 最近回发帧的 (RMS, 时刻);老的按 REF_WINDOW_MS 淘汰
  // ── 动态噪声地板(诊断 021-metrics:治高底噪误打断)──:近 DYN_FLOOR_WINDOW_MS 内**AI 静默帧**的入向 RMS
  //   滚动样本,取 p20 作底噪基线。**只收 AI 静默帧**(aiSpeaking/尾窗外的 trackEndpoint 路径)——AI 播报期
  //   入向含回声,纳入会污染基线(虽 p20 抗污染,显式排除更稳,review 共识)。circular buffer 思路:
  //   定长数组(覆盖窗 / 帧长,~150 帧 @20ms/3s),满则覆盖最老,O(1) 入样;p20 取样时一次性拷贝排序(每帧不算)。
  private noiseRmsWindow: { rms: number; atMs: number }[] = [];
  private noiseBaselineCache = 0; // 最近一次算出的噪声基线(barge 检测每帧用,避免每帧排序;入样时按需重算)
  private noiseBaselineDirty = true; // 有新样本进窗/淘汰 → 下次取用前重算
  // barge-in 触发时刻的能量四元组(诊断 021-metrics):随本轮 metric 落库,让误打断 vs 真打断可由 metrics 直接区分。
  private pendingBargeMetrics: EndpointTurnMetrics | null = null;
  // ── 每轮 metrics 端点段采集(design contract)。MediaSession 持有真实入向 RMS(知「对方停说」时刻)+ 知本次
  //    turn_end 是否自己 watchdog flush 触发(turn_end 帧无来源字段,protocol.py)。engine 段经 onMetrics
  //    带 ai_turn_id 上报时,合并当前 pendingEndpoint 落库(一轮一活跃,producer/consumer 1:1)。
  private lastAsrFinalAtMs = 0; // 本轮 asr_final 到达时刻(asr_final 在 turn_end 前到)
  private pendingEndpoint: EndpointTurnMetrics | null = null; // 待合并的端点段(turn_end 时建,engine 首次上报时消费)
  // ── 端到端延迟采集(design contract,借鉴 LiveKit e2e_latency)──:本轮「参会者停说」的**绝对时刻**(turn_end
  //   时锚定,= lastSpeechAtMs)。AI 首个音频帧流出(onAudioOut)时用 `now − 此刻` 直接算 e2e_latency,写进
  //   pendingEndpoint 随本轮 metric 落库。MUST NOT 由 eou_delay+llm_ttft+tts_ttfb 累加(tts_ttfb 已含 LLM 段、
  //   会双算)。仅正常一问一答轮有值:kickoff 无此锚点(不经 turn_end 设置)、被打断/失败轮无首帧则不写。
  private turnStopSpeakingAtMs = 0;
  // engine 段可能多次上报同 ai_turn_id(barge_in 的 cancel_ack 核对随后重发)→ 缓存已合并的
  // endpoint 段,重发时复用(engine 不持有 endpoint)。LRU 留最近 8 轮(重发紧随首报,够用)。
  private endpointByTurn = new Map<number, EndpointTurnMetrics>();
  private uxByTurn = new Map<number, UxTelemetryMetrics>();
  private uxIssuedTurns = new Set<number>();
  private completeMetricsByTurn = new Map<number, TurnMetrics>();
  // ── 主动开场状态机(design contract,P1,可关)──:会话建立后启静默计时,到点经
  //    engine.kickoff() 驱动 AI 据人设主动开场;真人先开口(达 minSpeechMs)立即取消、本场不再主动开场;
  //    「已开场」以 AI 出过开场音频为准(被打断/故障未出声不算 → 有界重试)。仅开关开 + 引擎实现 kickoff() 时生效。
  private meetingRoomEntered = false; // 会话已建立(首帧到达)——首次到达即启计时(只启一次)
  private kickoffTimer: ReturnType<typeof setTimeout> | null = null; // 主动开场静默计时器
  private kickoffPending = false; // 已触发 kickoff、等 onAiDone 确认是否出过开场音频
  private kickoffGotAudio = false; // 本次 kickoff 轮是否已出过 AI 音频(onAudioOut 置位;onAiDone 据此判「已开场」)
  private opened = false; // 本通是否已成功主动开场(出过开场音频)——可观测/日志用
  private proactiveOpeningSettled = false; // 主动开场已了结(成功开场 或 真人先开口)→ 不再 arm
  private kickoffAttempts = 0; // 主动开场尝试次数(有界重试,防被打断/故障无限重试)
  private static readonly KICKOFF_MAX_ATTEMPTS = 3; // 有界重试上限(被打断/故障不算成功,至多再试几次)
  // ★ design contract(review 永不触发)——turnPending 因**持续高能量底噪**(非脉冲)反复置 true 时,
  //   fireKickoff 每次都 rearm 却永不开场(等不到 turnPending 清)。加 rearm 计数上限:连续因 turnPending 暂缓达此值 →
  //   **强制开场**(持续底噪下真人 turn_end 本就不可靠,不能无限等;真人真开口仍由 onTranscript 真 ASR 让位)。
  private kickoffRearmOnPending = 0;
  private static readonly KICKOFF_MAX_REARM_ON_PENDING = 3; // 连续 turnPending 暂缓上限 → 强制开场(约 3×silenceMs)
  // ── ASR 字幕 LLM 修正(design contract,旁路)──:每条下行 transcript 帧带会话内单调 seq(user+ai 都算),
  //    供客户端稳定定位气泡(修正帧带同 seq 更新对应气泡,快说/重复/乱序不串号)。修正是 fire-and-forget:
  //    不阻塞对话/首声;并发上限防用户快说时堆积;会话结束 abort 飞行中修正、丢弃迟到结果。
  private transcriptSeq = 0; // 会话内单调递增,每下行一条 transcript 帧 +1(user final / ai)
  private fixerInFlight = 0; // 当前飞行中修正数(并发背压;超上限的轮跳过不修)
  private static readonly FIXER_MAX_INFLIGHT = 4; // per-session 飞行中修正并发上限(评审 B/review)
  private fixerAbort = new AbortController(); // 会话结束时 abort 所有飞行中修正(不等待,不再下行/覆盖)

  // ── design contract:旁路违规裁判状态 ──(仅当下发 llmModerationModelId 才跑;R2 shadow only)
  // 每逻辑轮最多裁判/计一次(review + M1 修正):**不能**用「每条 asr_final 自增 id」——ASR 分段/重发会让
  //   同一轮的多条 final 拿到不同 id、去重失效。改用**布尔 + turn_end 清**:本轮已判则 moderatedThisTurn=true,
  //   同轮后续 final 跳过;resetTurn(turn_end)清 false,下一逻辑轮可再判。userTurnId 仅作日志标识(单调,标轮次)。
  private userTurnId = 0;
  private moderatedThisTurn = false; // 本逻辑轮是否已裁判(turn_end/resetTurn 清;防同轮重复/分段 final 多次判)
  // design contract(评审 终审 Blocker):idleChatterStreak 是**有状态累积器**,判「连续轮」要求裁判 verdict
  //   **严格按轮序**应用。并发裁判(乱序完成)+ 到达序 mutate 会让「较晚 unrelated 越过较早断链轮」误凑连续
  //   (顺序门是 latest-completion-wins 补丁,堵不住)。**收敛点:idle 裁判串行**——专用门 idleChatterInFlight。
  //   串行 → 至多 1 个 idle 裁判在飞行 →
  //   verdict 严格按轮序到达 → streak mutate 天然串行。**+ 作废在途裁判**:被背压跳过的轮清 streak 时,
  //   把导致背压的那个在途裁判 gen++ 作废(否则它晚返回会重建 streak,跨越被跳过的轮 —— review 反例)。
  private idleChatterInFlight = false; // idle 裁判串行门(至多 1 个在飞行,保 verdict 按轮序)
  private idleModerationGen = 0; // idle 裁判「代」:发起时快照,跳过/新轮时 ++ 作废在途裁判(返回时比对,变了则丢弃)

  // ── design contract:沉默防作弊计数(服务端计时,不走 LLM;仅 VIOLATION_ENFORCEMENT 开时产生动作)──
  private waitingSinceMs = 0; // 进入「等待考生作答」的时刻(AI 说完置;收到有效语音清)。沉默时长=now-此值。0=非等待态
  private lastInboundFrameAtMs = 0; // 最近收到任意入向音频帧的时刻(区分真沉默[有帧低能量] vs 断流[无帧])
  private silenceCountedThisWait = false; // 本次等待窗内是否已计过沉默(防 watchdog 周期 tick 把一次长沉默计多次)
  private negativeCount = 0; // 消极对抗计数(沉默事件 + R4 的 idle_chatter 合并计;达 SILENCE_WARN_MAX 后再一次 → fail)
  // design contract:连续 unrelated_chatter 轮数(裁判高置信判 unrelated_chatter 累加;任何**非** unrelated 的高置信
  //   分类[on_topic/decline]或本轮判不了[null/低置信]都清零——防跨越正常作答的"离题"被误累计成连续逃避)。
  //   达 IDLE_CHATTER_MIN_TURNS → 计一次消极对抗(handleNegativeViolation("idle"))并清零重新计下一轮扯闲篇。
  private idleChatterStreak = 0;

  // ── design contract:静默超时先问再推兜底状态机(解 review 死锁;与 design contract 沉默违规按 answerSeen 互斥分流)──
  //   仅当 engine.answerSeenForCursor()=true(当前题已作答)时启;共用 waitingSinceMs 锚点但**同一 tick 只走一条**。
  //   阶段:'idle'(未启/已推进)→ 'waiting'(已作答等补充,静默达 ADVANCE_NUDGE_MS 起 nudge)→ 'nudge_pending'
  //   (已发 nudge 等 engine 接受)→ 'nudge_playing'(nudge 播报中,不计静默)→ 'after_nudge'(nudge 播完等第二窗)。
  private r3Phase: "idle" | "waiting" | "nudge_pending" | "nudge_playing" | "after_nudge" = "idle";
  private r3PhaseSinceMs = 0;       // 进入当前 r3 阶段的时刻(after_nudge 第二窗计时锚点)
  private r3NudgeCursorEpoch = -1;  // 发起 nudge 时的游标快照(推进前比对防 TOCTOU;-1=无)
  private r3PendingSinceMs = 0;     // nudge_pending 起始时刻(busy 反复拒绝的 pending 超时兜底锚点)
  // ★ design contract(review 跨层清理)——media 侧观察到的 engine 游标快照。
  //   engine 经**非 R3 路径**推进游标(design contract 宽限窗到期 / retry 上限 / 拒答/告别强推)时,engine 重置 answerSeen
  //   但 media 的 waitingSinceMs 仍是**旧题**积累的值。若不清:新轮 AI 出声(→enterWaitingForAnswer 刷新)前的窗口内,
  //   watchdogTick 查 answerSeen=false → 归 design contract → 用陈旧 waitingSinceMs **立即误判沉默违规**(北京 enforcement 开
  //   → 误杀会话)。修:watchdogTick 分流前检测 cursor 变化 → 重置 waitingSinceMs(新题从 AI 出声起算,不背旧题静默)。
  private lastSeenCursor = -1;

  // ── design contract:违规强制结束(先说明原因再挂 + 严重违规状态机;仅 VIOLATION_ENFORCEMENT 开时动作)──
  // forcedEndReason:非 null = 已进入「说明原因后强制结束」态。触发时注入原因句(nudge)+ 设此 reason + 起硬超时;
  //   该原因句轮 onAiDone(播完)→ 以此 reason 调 end();硬超时兜底防原因句卡住永不结束。**幂等**:已置则不重复触发。
  //   ★ 违规强制结束**不走 design contract 两步确认**([[ai-hangup-needs-user-confirm]] 铁律白名单例外,设计决策 deployment validation)
  //   ——它是系统据服务端计数/裁判**主动终止**,非「AI 想挂」;正常告别的两步确认路径(onAiDone shouldHangup)不受影响。
  private forcedEndReason: CancelReason | null = null;
  private forcedEndTimer: ReturnType<typeof setTimeout> | null = null;
  // design contract(review):违规原因句的送达状态。armForcedEndAfterNotice 时 nudge 可能因引擎 busy 被拒
  //   → 原因句**没送达**,此时 forcedEndNoticePlaying=false。onAiDone 据此区分:
  //     - true(原因句轮已起)→ 本次 onAiDone = 原因句播完 → end(reason);
  //     - false(原因句被 busy 拒、在等)→ 本次 onAiDone = 无关活跃轮结束、引擎转空闲 → **重试 nudge**(不 end,
  //       否则「没送达就挂」+ 误把无关轮当通知播完)。硬超时仍兜底(重试始终失败也不永久卡)。
  private forcedEndNotice = ""; // 待送达的原因句(busy 时暂存,onAiDone 空闲时重试 nudge)
  private forcedEndNoticePlaying = false; // 原因句轮是否已起(true=下次 onAiDone 即播完点)
  // ★ design contract(review 复核 Blocker):原因句已完整下发、进入 drain 延迟(等客户端播完再 end)态。
  //   置 true 后 forcedEndTimer 独占 end——**drain 期任何后续 onAiDone(含用户 drain 期说话触发的新轮)一律不再重入
  //   forced-end 分支**(否则新轮 completed 重排 drain timer → 无限延期,或落 else 重注入原因句 → drain 期又说一遍)。
  //   drain 期 violationNoticeGuard 保持 true(抑制打断,防客户端播放尾被截断)。teardown/end 清。
  private forcedEndDraining = false;
  // ★ design contract:违规发言(警告句 + 挂断原因句)播报期**不可被打断**——它们是必须让对方听清的关键信息
  //   (「请回到问题作答否则结束」/「因持续未作答本次结束」),不能因对方继续说话被 barge-in 切掉(真机
  //   sess_example:原因句被反复打断 → onAiDone 不来 → 撞硬超时被硬切)。true = 当前 AI 轮是**受保护的
  //   违规发言轮**:置位于违规 nudge(警告/原因)被引擎接受时,清除于该轮 onAiDone(无论 completed 与否,轮结束
  //   即解保护)。为真时 detectBargeIn 早退(不累计 bargeMs/不 tentative-pause/不 onBargeIn)+ 客户端上行 barge_in
  //   忽略。仅此窗口为真,绝不泄漏到普通对话轮(普通轮打断现状完全不变)。硬超时退化为 LLM/TTS 真故障兜底。
  private violationNoticeGuard = false;
  // 严重违规计数(会话级,与消极对抗轨 negativeCount **独立**,spec:两轨分开)。裁判高置信 severe_directed_abuse → +1;
  //   < SEVERE_VIOLATION_MAX → 警告一次(nudge);>= → 触发违规强制结束(severe_violation)。
  private severeViolationCount = 0;

  // ── design contract:旁路 EOU 纠偏状态 ──(默认关;开启需 AIM_EOU_CORRECTION_ENABLED=1 + recovery 开)
  private eouInFlight = 0; // 飞行中判定数(并发背压,复用 fixer 上限)
  // 判 incomplete 后「降门槛有效期」截止时刻(epoch ms):判定返回校验通过后设 now+correlationMs;
  //   detectBargeIn 在 now < 此值时对该轮用亚阈门槛(让考生亚常规阈重新出声也触发 tentative-pause)。0=无。
  private eouIncompleteUntilMs = 0;
  // 降门槛期绑定的游标快照(fire 判定时的游标):detectBargeIn 触发前比对——游标已推进则失效(stale,防
  //   「判 QK 未完」的降门槛误用到 QK+1)。-1=无 L3 语境。
  private eouIncompleteCursor = -1;

  private readonly transport: MediaSessionTransport;
  private readonly observedInputTurns = new Set<string>();
  private readonly finalizedInputTurns = new Set<string>();
  private readonly discardedInputTurns = new Set<string>();
  private activeResponseGeneration: number | null = null;
  private outputFlowGeneration: number | null = null;
  private outputFlowPaused = false;
  private outputFlowPausedByGeneration: number | null = null;
  private pendingResponseOutput: Array<{
    event: MediaSessionOutputEvent;
    queuedAtMs: number;
  }> = [];
  private pendingResponseOutputBytes = 0;
  private pendingResponseOutputTimer: ReturnType<typeof setTimeout> | null = null;
  private retiredResponseGenerationHighWater = -1;
  private readonly responseIdentityByGeneration = new Map<
    number,
    { turnSeq: number }
  >();
  private readonly outputWireFeedback = new Map<
    number,
    {
      nextDeltaSeq: number;
      declaredSegments: Set<number>;
      drained: boolean;
      failed: boolean;
    }
  >();
  private readonly responsePlaybackSnapshots = new Map<
    number,
    {
      farewellNotBeforeMs: number;
      playbackNotBeforeMs: number;
    }
  >();

  constructor(
    connOrTransport: WsConn | MediaSessionTransport,
    private cfg: MediaSessionConfig,
    private deps: MediaSessionDeps,
  ) {
    this.transport = isMediaSessionTransport(connOrTransport)
      ? connOrTransport
      : new V1MediaSessionTransport(connOrTransport);
  }

  /** 接线引擎回调 + 启动引擎 + 起录音;然后开始消费 WS。 */
  async begin(): Promise<void> {
    const { engine, recorder, transcripts } = this.deps;

    // 声纹锁定(design contract):effective(index.ts 已裁定 = Agent 请求 && kill-switch && recovery)时启用。
    //   GPU embedder 未配端点/secret 时 embed 恒返 null → 全程 fail-open(不误聋)。注入式:测试经 deps 注入 stub。
    //   **配置非法(阈值越界,review)→ 不创建 SpeakerLock**(声纹门禁用 fail-open,绝不用错配阈值误判目标人)。
    if (this.cfg.effectiveSpeakerLock) {
      if (this.deps.speakerLock) {
        this.speakerLock = this.deps.speakerLock; // 测试注入(cfg 由注入方保证合法)
      } else {
        const slCfg = loadSpeakerLockConfig();
        this.speakerLock = slCfg.valid
          ? createSpeakerLock(slCfg, (m) => console.log(`[media ${this.cfg.sessionId}] ${m}`))
          : null; // 阈值非法 → 禁用声纹门(fail-open,已在 loadSpeakerLockConfig 打 warn)
      }
    }
    engine.setResponseWireDrainRequired?.(
      this.transport.outputDelivery === "callback_confirmed",
    );

    // ★ design contract + design contract:引擎起用户驱动新轮 → 下发 playback_superseded 清客户端 ring
    //   (根治「换轮旧音频续播」:tts_done 领先客户端真播完数秒,用户在轮间提新问题时旧音频仍在播)。
    //
    //   ★★ **MUST 挂在 `if (this.cfg.playbackAck)` 之外**(design contract,review):
    //   v1 曾把它挂在 coordinator 块内并加 `isEnforce()` 门 —— 那让「清 ring」这件事**双重依赖**
    //   ①服务端 mode=enforce ②客户端声明 capability。前者已随 design contract 删除,但后者仍在:前端是
    //   `output: 'export'` 静态导出,浏览器**可能缓存旧 JS 而不声明 capability** → coordinator 不建 →
    //   supersede 一帧不发 → **已知的 bug 原样复现**。
    //
    //   清 ring 是**纯单向通知**:客户端 `stopPlayback()` 自 design contract 起即存在(`Exam.tsx` 的
    //   `playback_superseded` handler 早于服务端能力上线,注释自述「observe 期收不到 = 无副作用」),
    //   且 handler 位于 `else if` 链末端 —— 更老的客户端收到未知帧类型自然落空、不崩。故**无需任何协商**。
    //
    //   由服务端权威「起新用户轮」触发(非 user-transcript,不踩 design contract「误识别 final 冲掉后续句」)。
    //   违规发言保护轮不清(design contract:警告/原因句不可被打断)。
    engine.onUserTurnStart?.(() => {
      if (this.closed) return;
      if (this.violationNoticeGuard) return; // 受保护违规发言轮不可被 supersede(design contract)
      this.emitTransport({ type: "playback_clear", reason: "new_user_turn" });
      this.estimatedClientPlaybackEndMs = Date.now(); // 重置播放队尾(客户端已清 ring)
    });

    engine.onResponseStarted?.((event) => {
      if (this.closed) return;
      if (this.isResponseGenerationRetired(event.responseGeneration)) return;
      if (this.transport.outputDelivery === "callback_confirmed") {
        this.downsampler = new Resampler(ENGINE_TTS_RATE, FS_RATE);
      }
      this.responseIdentityByGeneration.set(event.responseGeneration, {
        turnSeq: event.turnSeq,
      });
      this.activeResponseGeneration = event.responseGeneration;
      this.outputWireFeedback.set(event.responseGeneration, {
        nextDeltaSeq: 0,
        declaredSegments: new Set(),
        drained: false,
        failed: false,
      });
      this.emitResponseOutput({ type: "response_started", ...event });
    });
    engine.onResponseSegmentDeclared?.((event) => {
      if (this.closed) return;
      this.outputWireFeedback
        .get(event.responseGeneration)
        ?.declaredSegments.add(event.segmentId);
      this.emitResponseOutput({ type: "response_segment_declared", ...event });
    });
    engine.onResponseSegmentCompleted?.((event) => {
      if (this.closed) return;
      this.emitResponseOutput({ type: "response_segment_completed", ...event });
    });
    engine.onResponseCoreTerminal?.((event) => {
      if (this.closed && !this.teardownInProgress) return;
      this.emitResponseOutput({ type: "response_core_terminal", ...event });
    });
    engine.onResponseServerDrained?.((responseGeneration) => {
      if (this.closed) return Date.now();
      const drainedAtMs = Date.now();
      const snapshot = {
        farewellNotBeforeMs:
          drainedAtMs + this.computeFarewellDelayMs(),
        playbackNotBeforeMs: this.computePlaybackNotBeforeMs(),
      };
      this.responsePlaybackSnapshots.set(responseGeneration, snapshot);
      // Restore input listening at server drain. Cursor, answer-grace, and
      // hangup decisions remain deferred until the estimated playback boundary.
      this.markAiDonePlaying(snapshot.playbackNotBeforeMs);
      return snapshot.playbackNotBeforeMs;
    });

    // 播放 ACK(design contract):**客户端**声明 capability(cfg.playbackAck)时才建 coordinator。
    // ai_audio_start/end 同时也是 UX telemetry marker，必须无条件下发；旧客户端忽略未知帧。
    if (this.cfg.playbackAck) {
      const { cfg } = this.cfg.playbackAck;
      this.playbackCoordinator = new PlaybackSettlementCoordinator({
        cfg,
        onSettle: (s) => this.onPlaybackSettled(s),
        onMetric: (m) =>
          console.log(
            `[media ${this.cfg.sessionId}] playback_ack turn=${m.aiTurnId} outcome=${m.outcome}` +
              `${m.fallback ? ` fallback=${m.fallback}` : ""} latency=${m.latencyMs}ms` +
              `${m.estimateErrorMs !== undefined ? ` estErr=${m.estimateErrorMs}ms` : ""}` +
              `${m.abortReason ? ` reason=${m.abortReason}` : ""}` +
              `${m.duplicate ? " duplicate" : ""}${m.stale ? " stale" : ""}${m.unknown ? " unknown" : ""}`,
          ),
      });
    }
    // Marker 与 binary 走同一 transport writer，start 在引擎同步回调中严格先于首帧。
    engine.onTurnAudioBegin?.((aiTurnId) => {
      if (this.closed) return;
      this.activeAudioTurnId = aiTurnId;
      this.uxIssuedTurns.add(aiTurnId);
      while (this.uxIssuedTurns.size > 32) {
        const oldest = this.uxIssuedTurns.values().next().value;
        if (oldest === undefined) break;
        this.uxIssuedTurns.delete(oldest);
      }
      this.playbackCoordinator?.beginTurn(aiTurnId);
      this.emitTransport({ type: "turn_audio_started", aiTurnId });
    });
    engine.onTurnAudioEnd?.((aiTurnId) => {
      if (this.closed) return;
      this.playbackCoordinator?.endTurn(aiTurnId, this.estimatedClientPlaybackEndMs);
      this.emitTransport({ type: "turn_audio_ended", aiTurnId });
    });

    engine.onAudioOut((pcm, identity) => {
      if (
        this.transport.outputDelivery === "callback_confirmed" &&
        identity &&
        (identity.responseGeneration !== this.activeResponseGeneration ||
          this.isResponseGenerationRetired(identity.responseGeneration))
      ) {
        return;
      }
      // e2e_latency(design contract):本轮首个 AI 音频帧流出 → `now − 参会者停说绝对时刻` = 整段体感延迟,
      // 写进本轮待合并端点段(engine onMetrics 稍后消费)。仅正常一问一答轮有锚点(turnStopSpeakingAtMs>0);
      // 首帧后清锚点,本轮后续帧不重算。pendingEndpoint 为空(极端:已被消费)则只清锚点、不写(不编造)。
      if (this.turnStopSpeakingAtMs > 0) {
        if (this.pendingEndpoint) {
          this.pendingEndpoint.e2eLatencyMs = Math.max(0, Date.now() - this.turnStopSpeakingAtMs);
        }
        this.turnStopSpeakingAtMs = 0;
      }
      // design contract:记 AI 开口跃变时刻(仅 false→true 那一帧),供开口冷却窗计时;后续帧不重置。
      // design contract:同一跃变点重置本轮音频统计(新 AI 轮的已下发时长/首帧从头算,收尾挂断据此推算播完时刻)。
      if (!this.aiSpeaking) {
        this.aiSpeakingSinceMs = Date.now();
        this.aiTurnFirstAudioAtMs = Date.now();
        this.aiTurnAudioMs = 0;
      }
      this.aiSpeaking = true;
      // 主动开场(design contract):本次 kickoff 轮出过 AI 音频 → 标记(onAiDone 据此认定「已开场」)。
      if (this.kickoffPending) this.kickoffGotAudio = true;
      this.lastAiAudioAtMs = Date.now(); // 安全看门狗:有音频流出即续期,据此判「播报已停多久」
      // 引擎出 24k → 降到 16k 再回发/录音(B1/B2:否则把 24k 当 16k 播放 = 1.5× 变速变调,
      // 录音也失真且双声道时基越积越漂)。一次降采样,conn 与 recorder 共用同一 16k 时基。
      const pcm16 = this.downsampler.process(pcm);
      if (pcm16.length === 0) return;
      // design contract:累计本轮已下发音频时长(按最终下发的 16k s16le 帧:字节/2 采样 /16000 Hz = 秒)。
      const frameMs = (pcm16.length / 2 / FS_RATE) * 1000;
      this.aiTurnAudioMs += frameMs;
      // ★ design contract:会话级客户端播放队尾累加 —— max(now, 队尾) + frameMs。多轮排同一时间轴时不低估
      //   (队尾 > now 说明前一轮还在播,新帧排其后);久未出音频(队尾 < now)则从 now 起算(前面已播完)。
      if (this.transport.outputDelivery === "immediate") {
        this.estimatedClientPlaybackEndMs =
          Math.max(Date.now(), this.estimatedClientPlaybackEndMs) + frameMs;
      }
      recorder?.pushAi(pcm16);
      // DTD 参考(design contract):记本回发帧 RMS + 时刻,供 detectBargeIn 估当前 AI 回声能量水平(自适应阈值)。
      if (BARGE_DTD_ENABLED) this.noteRefRms(pcmRms(pcm16));
      // 回发**即时**(不限速,不卡顿)。打断的即时停声 = engine.cancel 切源停发帧
      //(客户端本地播放队列由 M1 信令 barge_in 帧清;电话版 FS 缓冲尾窗问题不复存在)。
      if (identity) {
        this.emitResponseOutput({
          type: "response_audio",
          ...identity,
          pcm16k: pcm16,
        });
      } else {
        this.emitTransport({ type: "audio", pcm16k: pcm16 });
      }
    });
    engine.onTranscript((t) => {
      // ★ design contract(review 复核 Blocker 2):**AI 独占发言窗口的最小抑制 —— 只拦「下发字幕帧」**。
      //   截断原因句客户端播放尾的**唯一**服务端可控源 = 下发 user `transcript` 帧 → 前端 Exam.tsx `stopPlayback()`
      //   (user final + 仍在播 → 清队列)。故 violationNoticeGuard 期间**不下发 transcript / transcript_partial 帧**
      //   即可从源头堵住截断(detectBargeIn 在 drain 期 aiSpeaking=false 本就不跑;新 LLM 轮由 forcedEndDraining no-op
      //   + turn_end 期引擎侧处理,不在此拦)。**其余副作用照常**(putFinal 落库 / 违规裁判 maybeJudgeModeration—— severe
      //   连续升级依赖它 / 修正 / latch):它们不影响客户端播放,拦了反而破坏违规升级(评审实测:拦 moderation 致 severe
      //   escalation 断)。用 `suppressTranscriptFrame` 局部标志在下面两处发帧点门控,不整体早退。
      const suppressTranscriptFrame = this.violationNoticeGuard;
      // ★ design contract(开场抗底噪):**真人真开口的唯一权威信号 = 非空 ASR 文本**(partial 或 final)。收到即永久取消
      //   主动开场(让位真人)。连接初期底噪脉冲不会出 ASR 文本 → 不误让位(见 trackEndpoint 能量门的说明)。
      //   放在 partial 分支之前:partial 比 final 更早到,让位更及时(真人一开口 ASR 出字即让位,不等说完)。
      if (t.text && t.text.trim()) this.cancelKickoff();
      const inputIdentity =
        t.inputEpoch !== undefined && t.inputTurnId !== undefined
          ? { inputEpoch: t.inputEpoch, inputTurnId: t.inputTurnId }
          : undefined;
      if (inputIdentity && t.text.trim() && !suppressTranscriptFrame) {
        this.emitInputSpeechStarted(inputIdentity);
      }
      if (inputIdentity && t.isFinal && t.text.trim()) {
        const key = this.inputIdentityKey(inputIdentity);
        if (suppressTranscriptFrame) {
          this.discardedInputTurns.add(key);
        } else {
          this.finalizedInputTurns.add(key);
        }
      }
      if (!t.isFinal) {
        // 实时字幕(P1-7):partial(识别中)下行,客户端显示"识别中…"临时气泡,消除说话时的静默焦虑。
        // best-effort、不落库(只 final 落库);空 partial 跳过。与 final 用不同帧类型,客户端据此区分临时/定稿。
        // ★ design contract:AI 独占窗口内不下发 partial(与 final 一致,防前端据此起播放/停播联动)。
        if (t.text && t.text.trim() && !suppressTranscriptFrame) {
          this.emitTransport(
            inputIdentity
              ? {
                  type: "user_transcript_partial",
                  text: t.text,
                  ...inputIdentity,
                }
              : {
                  type: "transcript_partial",
                  speaker: "user",
                  text: t.text,
                },
          );
        }
        return;
      }
      // metrics:本轮 asr_final 到达时刻(在 turn_end 前到),用于算 asr_final_delay。
      this.lastAsrFinalAtMs = Date.now();
      // ASR 字幕修正(design contract):为本条 user final 分配稳定 seq + 固定落库排序键(final 到达时刻)。
      // seq 让客户端稳定定位气泡(修正帧带同 seq 更新);tsMs 让转写顺序恒定(修正覆盖同 sk,不受修正快慢影响)。
      const seq = this.transcriptSeq++;
      const tsMs = Date.now();
      // ★ design contract:用回调带来的**事件快照** questionIndex(该句 asr_final 到达那一刻捕获的游标),**不读**落库时刻
      //   engine.questionCursor()——尾音 FINAL 迟到、游标已推进后重查会误标下一题(双评审 Blocker)。undefined 不落。
      const questionIndex = t.questionIndex;
      // 先落原文占位(定 tsMs):修正未回/失败即停在原文(fail-open,绝不丢转写)。**落库不受 AI 独占窗口影响**
      //   (evaluator 须看到完整转写,含违规发言期用户说的话)。
      void transcripts?.putFinal(this.cfg.sessionId, "user", t.text, tsMs, questionIndex);
      // M1 信令:实时转写下行 text 帧(与落库**并行**,best-effort,带 seq)→ 客户端字幕(先显原文)。
      //   ★ design contract:字幕帧**不含** question_index(题号用户不可见不可听,只进 DDB 转写行供 evaluator)。
      //   ★ design contract:AI 独占窗口(违规发言/原因句 drain 期)**不下发**——前端收不到 user transcript → 不
      //   stopPlayback → 原因句客户端播放尾不被截断。落库已在上面完成(evaluator 无损)。
      if (!suppressTranscriptFrame) {
        this.emitTransport(
          inputIdentity
            ? {
                type: "user_transcript_final",
                seq,
                text: t.text,
                ...inputIdentity,
              }
            : {
                type: "transcript_final",
                speaker: "user",
                seq,
                text: t.text,
              },
        );
        // 旁路 LLM 修正(fire-and-forget,不阻塞对话/首声;engine.lastFinalText 喂对话 LLM 走原文不受影响)。
        //   ★ design contract:把原文 asr_final 捕获的 questionIndex 一起带进修正管线——修正异步返回时游标可能已推进,
        //   修正覆盖 putFinal 时**沿用此原捕获值**,绝不用返回时刻游标(否则回答被标错题,双评审 Blocker)。
        //   ★ design contract:未下发原帧则不修正(修正帧 transcript_corrected 按 seq 定位一个前端从没收到的气泡=无意义)。
        this.maybeCorrectTranscript(t.text, seq, tsMs, questionIndex);
      }
      // design contract:旁路 EOU 判定(fire-and-forget)。asr_final ≈ 静音端点(AI 即将/已乐观开口),此刻 fire
      //   最能争取判定时间窗;判 incomplete + 关联窗内考生亚阈重新出声 → detectBargeIn 降门槛纠偏。默认关。
      this.maybeJudgeEou(t.text);
      // design contract:旁路违规裁判(fire-and-forget,shadow only)。**每逻辑轮最多判一次**(M1 修:moderatedThisTurn
      //   布尔,turn_end 清)——ASR 同轮分段/重发的多条 final 只判首次。R2 阶段只 log;计数/警告/挂断在 R1/R4/R3。
      this.maybeJudgeModeration(t.text);
      // 语义挂断:对方道别**仅记上下文**,不单独触发挂断(C17 对称性 + C9:用户说拜拜但 AI 因 LLM 报错没回话
      // 不应空挂)。每条 user final 都重判(对称 onLlmText 的 set+clear)—— 改主意说「等等还有事」即清掉。
      // 真正挂断由 onAiDone 在「本轮 AI 也告别 / wantsEndCall」时触发。
      if (FAREWELL_HANGUP) this.userSaidFarewell = isFarewell(t.text);
      // ── design contract:自由聊天两步确认 latch 驱动(仅无题会话有意义;有题走 blockedByExam)──
      //   本轮用户 final 更新 latch。**先判清除**(继续意愿 / 实质新内容),**再判置位**(离开意图)——
      //   顺序保证:同一句里"继续"优先于误命中的离开词(FAREWELL_CONTINUE 已在 isUserLeaveIntent 内一票否决,
      //   此处 clearLeaveLatch 再兜一层"实质新内容")。纯确认无新需求的"没有了/嗯/好的"两者都不命中 → latch 原样保持
      //   (这正是两步确认第二步能放行的关键:不因"本轮不含告别词"误清)。
      if (FAREWELL_HANGUP) this.updateLeaveLatch(t.text);
    });
    // AI 本轮完整文本 → 落库 speaker=ai(review:此前只记 user 侧,evaluator 缺 AI 提问上下文)
    engine.onLlmText?.((text, questionIndex) => {
      // ★ design contract:questionIndex = 引擎在 **SpeechTurn 创建时**捕获的题号快照(AI 本轮所问题号),**不读**落库时刻
      //   engine.questionCursor()——AI 念完当前题后先推进游标再触发本回调,重查会误标下一题(双评审 Blocker)。undefined 不落。
      void transcripts?.putFinal(this.cfg.sessionId, "ai", text, undefined, questionIndex);
      // M1 信令:AI 侧转写下行 text 帧(与落库并行,best-effort;带 seq 让客户端稳定定位气泡,design contract)。
      // AI 文本是 LLM 原文,无需修正,故只发 transcript(不 maybeCorrect)。★ design contract:字幕帧**不含** question_index。
      this.emitTransport({
        type: "transcript_final",
        speaker: "ai",
        seq: this.transcriptSeq++,
        text,
      });
      // 本轮 AI 回复是否告别(LlmTextCb 一轮一次、整段文本)= 挂断的主信号。AI 礼貌挽留/客套继续
      // (FAREWELL_CONTINUE / NEGATION 命中)→ false,不挂。LLM 报错路径**不触发本回调**(C9),
      // 故 aiSaidFarewellThisTurn 保持 false → onAiDone 不挂(AI 没真回话就不空挂)。
      if (FAREWELL_HANGUP) this.aiSaidFarewellThisTurn = isFarewell(text);
    });
    engine.onTurnEvent((_event, identity) => {
      if (identity) {
        const key = this.inputIdentityKey(identity);
        const observedSpeech = this.observedInputTurns.delete(key);
        const finalizedTranscript = this.finalizedInputTurns.delete(key);
        const discarded = this.discardedInputTurns.delete(key);
        if (discarded) {
          this.emitTransport({
            type: "input_rejected",
            reason: "session_ending",
            ...identity,
          });
        } else if (observedSpeech && finalizedTranscript) {
          this.emitTransport({ type: "input_committed", ...identity });
        } else {
          // GPU ordering guarantees asr_final precedes turn_end. Close this
          // identity explicitly so a no-speech commit cannot pin later input.
          this.emitTransport({
            type: "input_rejected",
            reason: "no_speech",
            ...identity,
          });
        }
      }
      // metrics:turn_end 端点段采集(design contract)。「对方停说」= 最近一次检测到说话的时刻(lastSpeechAtMs);
      // turn_end 来源:本轮 watchdog 已 flush(lastFlushAtMs>0)→ bridge_watchdog,否则 GPU VAD 自然命中。
      // turn_end 帧本身不带来源字段(protocol.py),故只能由 MediaSession 据自身 flush 状态判定。
      // ★ 评审纠偏(Medium-3):**仅当 turnPending**(本轮检测到 ≥ MIN_SPEECH 的真实新语音)才采集端点段。
      //   turnCb 在 engine 决定 busy-drop **之前**触发,重复/busy 期的 turn_end(无对应新 engine 轮)若也采集,
      //   会用陈旧 lastSpeechAtMs 覆盖在飞行轮的 pendingEndpoint → 错配给下一条 metric。turnPending 在首个
      //   turn_end 的 resetTurn 后即 false,故重复 turn_end 不再采集(无新语音 = 无新端点)。
      if (this.turnPending && this.lastSpeechAtMs > 0) {
        const now = Date.now();
        this.pendingEndpoint = {
          eouDelayMs: Math.max(0, now - this.lastSpeechAtMs),
          asrFinalDelayMs:
            this.lastAsrFinalAtMs > 0 ? Math.max(0, this.lastAsrFinalAtMs - this.lastSpeechAtMs) : undefined,
          turnEndSource: this.lastFlushAtMs > 0 ? "bridge_watchdog" : "gpu_vad",
        };
        // e2e_latency(design contract):锚定「参会者停说」绝对时刻(= lastSpeechAtMs,与 eou_delay 同源),
        // AI 首帧流出时(onAudioOut)据此算整段 round-trip。仅此真实新语音轮设锚点(kickoff 不经此)。
        this.turnStopSpeakingAtMs = this.lastSpeechAtMs;
      }
      // 一轮结束:对方说完,AI 将开口。回声抑制窗在 onAudioOut 打开,turn_end 仅作标记。
      // 自然 turn_end 到达 → 清端点看门狗本轮累计(避免看门狗重复 flush 已结束的轮)。
      this.resetTurn();
    });
    // AI 本轮播报结束(GPU tts_done)→ 关回声抑制窗,恢复对入向音频的正常监听。
    // 修真机回归:此前 aiSpeaking 置 true 后永不复位 → AI 说完第一轮后用户讲话被静音送进 ASR,
    // 表现为「AI 后面听不到人说话」。markAiDonePlaying 此前定义了却从未被调用(review)。
    engine.onAiDone?.((
      completed?: boolean,
      responseGeneration?: number,
    ): number | void => {
      const drainedSnapshot =
        responseGeneration === undefined
          ? undefined
          : this.responsePlaybackSnapshots.get(responseGeneration);
      if (responseGeneration !== undefined) {
        this.responsePlaybackSnapshots.delete(responseGeneration);
      }
      // ★ design contract:先按**本轮**已下发音频统计算挂断延迟快照,**再** markAiDonePlaying(它会清本轮统计,为下一轮
      //   干净——防「下轮无音频拿上轮残留」的 fail-safe 污染,review)。顺序:算快照 → 清统计。
      //   非告别轮此快照不被用(下方 shouldHangup=false),无副作用。
      const farewellDelayMs =
        drainedSnapshot === undefined
          ? this.computeFarewellDelayMs()
          : Math.max(0, drainedSnapshot.farewellNotBeforeMs - Date.now());
      // ★ design contract:算「客户端估算播完」推进时钟起点快照(engine armAnswerGrace 用其返回值延后宽限窗)。
      //   读**会话级队尾**(独立于单轮统计),不受下面 markAiDonePlaying 清单轮统计影响;但语义上仍在清前算(与 farewell 同序)。
      const playbackNotBeforeMs =
        drainedSnapshot?.playbackNotBeforeMs ??
        this.computePlaybackNotBeforeMs();
      // ★ design contract(review二审):进等待作答态**只在 AI 本轮正常完整播完**才成立。
      //   onAiDone 是多路径入口——正常播完 与 cancel(打断)/超时/流错/一字没说的引擎自终结都触发它。
      //   判据 MUST 是引擎权威的 `completed`(= LLM 流出完 && 全部句 tts_done,仅 maybeFireAiDone/fullyPlayed 路径为 true),
      //   **不能**用 media-session 侧的 `aiSpeaking` 近似——它只表「本轮出过音频」,LLM 流出半句音频后中途失败
      //   (partial + fireAiDone)时 aiSpeaking 仍 true 会误判「说完了」→ 题没念完就起沉默钟(review 二审 Blocker)。
      //   completed 缺省(引擎未实现该参数)→ undefined,按下方 `!== false` 退化为进等待态(向后兼容现状)。
      const aiCompleted = completed !== false;
      if (!drainedSnapshot) {
        this.markAiDonePlaying(playbackNotBeforeMs); // design contract:nudge 轮 → after_nudge 第二窗用同一估算播完快照
      }
      // ★ design contract / R2.5(review 复核 Blocker 1):违规发言保护(violationNoticeGuard)的解除**分支化**,不在此统一清。
      //   语义 = 「AI 独占发言窗口」(违规警告/原因句必须让用户听全):窗口内 onTranscript 抑制 user 副作用(不下发帧
      //   防前端 stopPlayback 截断)。窗口边界:
      //   - **警告句轮 onAiDone**(未进 drain)→ 该轮结束、AI 让出发言权 → **清 guard**(用户可正常应答,不吞);
      //   - **原因句 completed → 进 drain** → **不清 guard**(原因句正等客户端播完,窗口须保持到 end→teardown);
      //   - **原因句 !completed / 重试** → 清 guard(该轮结束;重试成功会重新置 guard,是新窗口);
      //   - **普通轮**(无 forcedEndReason)→ 清 guard(防泄漏,普通轮本不该有 guard)。
      //   统一清除已移除(原在此):它在「completed→drain」前先清,使 drain 以 guard=false 开始(Blocker 1)。
      // ★ design contract:违规强制结束「说明原因后挂」。onAiDone 分三种(review+ 复审 Blocker):
      //   - forcedEndNoticePlaying=true 且 **aiCompleted=true**:原因句轮**完整播完** → 现在真 end(违规 reason)。
      //     优先于下面所有分支(kickoff 结算/告别挂断/进等待态)。硬超时 timer 一并清。
      //   - forcedEndNoticePlaying=true 但 **aiCompleted=false**(原因句被 barge-in 打断 / LLM·TTS 失败,复审 Blocker):
      //     原因句**没完整送达** → **不 end**(spec:播完原因句再挂)。清 playing、**保留硬超时**,等空闲重试或超时兜底。
      //     不无限缠斗:考生反复打断 → 硬超时 FORCED_END_MAX_WAIT_MS 到点强制 end(不永久卡)。
      //   - forcedEndNoticePlaying=false:原因句此前被 busy 拒、没送达;本次是**无关活跃轮**结束、引擎转空闲 →
      //     **重试注入原因句**(不 end!否则「没送达就挂」+ 误把无关轮当通知播完)。重试成功 → 置 playing=true 等其
      //     onAiDone;仍失败(极端)→ 留待下次 onAiDone / 硬超时兜底。
      // ★ design contract(review):本块三处 early return MUST **返回 playbackNotBeforeMs**(而非隐式
      //   undefined)——否则「正常作答轮 completed=true 已置 pendingAdvance,同会话恰有 forcedEndReason 重试注入」
      //   的窄缝下,engine armAnswerGrace 收到 undefined → leadMs=0 → 宽限窗按 tts_done 后 grace 而非估算播完后,
      //   破坏「三处同快照」不变式。实践中此路径本通即将违规收尾(推进随后被 end 冲掉)、无实害,但保持返回值契约
      //   在所有路径成立、零成本消除未来 forced-end 逻辑演进的陷阱。
      if (this.forcedEndReason && !this.closed) {
        const reason = this.forcedEndReason;
        // ★ design contract(review 复核 Blocker):已进 drain(原因句下发完、forcedEndTimer 正倒计时 end)→ 本块**整体 no-op**。
        //   drain 期任何 onAiDone(用户 drain 期说话触发的新普通轮完成等)MUST NOT 重入:否则 completed 分支重排 drain
        //   timer(无限延期)、或 else 分支重注入原因句(drain 期 AI 又说一遍)。drain 由 forcedEndTimer 独占收口。
        if (this.forcedEndDraining) return playbackNotBeforeMs;
        if (this.forcedEndNoticePlaying && aiCompleted) {
          // ★ design contract(review):onAiDone(completed) = 原因句**服务端下发完**(tts_done),但**客户端仍在播**
          //   队列里的尾音。若此刻立即 end(),前端收 `ended` 帧清空播放队列 → 原因句尾被截断,用户听不全挂断原因
          //   (与 design contract farewell 同源:tts_done ≠ 客户端播完)。故 end MUST 经 **drain 延迟**(复用 farewellDelayMs
          //   快照:drain 开=按估算客户端播完时刻;关=回退固定 FAREWELL_HANGUP_DELAY_MS),等客户端播完原因句再挂。
          //   ★ 复用 forcedEndTimer 承载 drain(不新起 hangupTimer):forcedEndTimer **不受 cancelPendingHangup 影响**
          //   (违规结束不可被用户"继续说话"挽留——违规 end 是系统主动终止,非告别);硬超时语义并入(delay 已 clamp
          //   到 FAREWELL_DRAIN_MAX_MS 有界,不永久卡)。清旧硬超时 timer,重排为 drain 延迟 end。
          if (this.forcedEndTimer) { clearTimeout(this.forcedEndTimer); this.forcedEndTimer = null; }
          const drainMs = farewellDelayMs; // 清音频统计前算好的本轮快照(见 :616,与 farewell 同序)
          this.forcedEndDraining = true; // ★ R2.4:进 drain 态 —— 后续 onAiDone 全 no-op(上方守卫),drain timer 独占 end
          // ★ design contract(review 收敛):drain 期禁引擎自主起新轮——否则 drain 期用户说话触发引擎 turn_end→
          //   runLlmTurn→新 AI 音频打断正在播的原因句尾(bridge onTranscript 帧抑制管不到引擎内部起轮)。仅原因句
          //   drain 置(警告句不置:它要继续对话)。drain 完(timer 回调)/teardown 清,不永久禁言。
          if (this.deps.engine.suppressNewTurns !== undefined) this.deps.engine.suppressNewTurns = true;
          console.warn(`[media ${this.cfg.sessionId}] 违规原因句已完整下发(onAiDone completed)→ drain ${drainMs}ms 待客户端播完 → end("${reason}")`);
          this.forcedEndTimer = setTimeout(() => {
            this.forcedEndTimer = null;
            if (!this.closed && this.forcedEndReason) {
              console.warn(`[media ${this.cfg.sessionId}] 违规原因句 drain 完成 → 违规强制结束 end("${reason}")`);
              void this.end(reason);
            }
          }, drainMs);
          this.forcedEndTimer.unref?.();
          return playbackNotBeforeMs;
        }
        if (this.forcedEndNoticePlaying && !aiCompleted) {
          // 原因句被打断/异常,没完整播完(复审 Blocker):不 end(spec 要求播完再挂)。清 playing → 后续 onAiDone
          //   重试注入,硬超时兜底(考生反复打断也不永久卡)。timer **不清**(继续兜底)。
          // ★ R2.5:该原因句轮已结束(未进 drain)→ 清 guard(AI 独占窗口关);重试注入成功会重新置 guard(新窗口)。
          this.clearViolationNoticeGuard();
          this.forcedEndNoticePlaying = false;
          console.warn(`[media ${this.cfg.sessionId}] 违规原因句未完整播完(打断/失败,completed=false)→ 不 end,清 playing 等重试/硬超时兜底(reason="${reason}")`);
          return playbackNotBeforeMs;
        }
        // 原因句还没送达(此前 busy):引擎现在空闲了 → 重试注入(该 notice 轮的 onAiDone 才是真播完点)。
        //   design contract:本次是**无关活跃轮**结束 → 先清旧 guard(该无关轮的窗口关),再经 nudgeViolationNotice 重试;
        //   重试接受 → 为**重试轮**重新置 guard(新的 AI 独占窗口)。
        this.clearViolationNoticeGuard();
        this.forcedEndNoticePlaying = this.nudgeViolationNotice(this.forcedEndNotice);
        console.warn(`[media ${this.cfg.sessionId}] 违规原因句重试注入${this.forcedEndNoticePlaying ? "成功(等其 onAiDone)" : "仍被拒(留待下次/硬超时兜底)"}(reason="${reason}")`);
        return playbackNotBeforeMs; // 无论重试成功与否,本次(无关轮)都不 end
      }
      // ★ design contract:普通轮(无 forcedEndReason)onAiDone → 清 guard(警告句轮走这里:警告播完 AI 让出发言权,
      //   用户可正常应答不被吞;也防 guard 意外泄漏到普通对话轮)。有 forcedEndReason 的分支已在各自分支内按需处理。
      this.clearViolationNoticeGuard();
      // 主动开场了结(design contract):本轮是 kickoff 轮 → 据「是否出过开场音频」判定。出过 = 成功开场
      // (本通不再主动开场);未出过(被 barge-in 打断 / GPU 故障)= 不算开场 → 有界重试(防无限)。
      if (this.kickoffPending) this.settleKickoff();
      // 语义挂断**充分条件**(收敛后):本轮 AI 自己也告别(aiSaidFarewellThisTurn,= 互道再见)
      // **或** LLM 语义判定结束(engine.wantsEndCall,比正则鲁棒——懂「没有了拜拜」=结束、「我还不想挂」=挽留)。
      // ★ 单凭用户说「拜拜」**不**挂(C9:AI 因 LLM 报错没触发 onLlmText → aiSaidFarewellThisTurn=false → 不空挂;
      //   C17:AI 挽留/客套继续 → isFarewell=false → 不挂)。userSaidFarewell 只是上下文,不进此判定。
      const wantsEnd = engine.wantsEndCall?.() ?? false;
      // 挂断驱动(评审/真机纠偏):**仅当引擎提供 LLM 语义信号**(实现了 wantsEndCall = three-stage)**且** SEMANTIC_END 开时,
      // 才**只**认 LLM 的 wantsEnd([[END_CALL]],已两步确认门控)——正则 aiSaidFarewellThisTurn 不单独挂(它是误挂根源:
      // ASR 误识→AI 误说拜拜→挂)。否则(引擎无 wantsEnd,或 SEMANTIC_END=0)回退正则告别兜底。
      // 无论哪条,挂前 AI 都已(LLM 两步)口头确认过 /(正则兜底)双方互道再见。
      const hasLlmEndSignal = SEMANTIC_END && typeof engine.wantsEndCall === "function";
      const endByLlm = hasLlmEndSignal ? wantsEnd : this.aiSaidFarewellThisTurn;
      // 考试完成强制(design contract):有未问完题时不许提前挂断。LLM 语义路径(three_stage)已在引擎 maybeFireAiDone
      //   压制 [[END_CALL]](含三次坚持逃生阀),故 wantsEnd 在未放行时已是 false;此门主要兜住**FAREWELL 正则**
      //   路径(SEMANTIC_END=0 / 非 three_stage,不经引擎压制)。逃生阀放行时 engine.wantsEarlyExit() 为真 → 不拦。
      const pending = engine.hasPendingQuestions?.() ?? false;
      const earlyExit = engine.wantsEarlyExit?.() ?? false;
      const blockedByExam = pending && !earlyExit; // 有未问完题且未触发逃生阀 → 拦挂断
      // design contract:自由聊天(无题)AI 主动挂硬闸门——**无题 + 未走完离开确认(latch 非 LEAVE_PENDING)**→ 压制挂断。
      //   与 blockedByExam **互斥**(由 hasQuestions 单一维度分流:有题 hasQuestions=true→本条恒 false 只 exam 起作用;
      //   无题 hasQuestions=false→pending 必 false→exam 恒 false)。放行(latch=LEAVE_PENDING)= 用户已表达离开意图 +
      //   AI 走两步确认(END_CALL_DIRECTIVE 无题变体门控)→ 允许挂。守住铁律「宁漏挂不误挂」:latch 用完即清、误判限单轮。
      const hasQuestions = engine.hasQuestions();
      const blockedByOpenChat = !hasQuestions && !this.leaveIntentPending;
      // design contract 互斥不变式(review):二者由 hasQuestions 单维分流,**不可能同时为 true**
      //   (有题→blockedByOpenChat 恒 false;无题→pending 必 false→blockedByExam 恒 false)。二者**同为 false 是合法的**
      //   (有题已问完=测评正常收尾)。此处只对"同时 true"这个理论上不可能的违例告警——**fail-soft(不 throw)**:实时通话
      //   路径绝不因防御检查崩掉整通(宁记日志人工排查,也不拆机)。若真触发说明 hasQuestions/hasPendingQuestions 口径被改坏。
      if (blockedByExam && blockedByOpenChat) {
        console.error(`[media ${this.cfg.sessionId}] design contract 互斥不变式违例:blockedByExam 与 blockedByOpenChat 同时 true(hasQ=${hasQuestions} pending=${pending} earlyExit=${earlyExit} leaveIntent=${this.leaveIntentPending})——口径可能被改坏`);
      }
      const shouldHangup = FAREWELL_HANGUP && !this.closed && endByLlm && !blockedByExam && !blockedByOpenChat;
      // 本轮告别旗在 onAiDone(本轮终点)消费后复位,下一轮重新判定(不跨轮残留)。
      this.aiSaidFarewellThisTurn = false;
      this.userSaidFarewell = false;
      if (shouldHangup) {
        // AI 把告别话说完了 → 延迟一小段(让尾音播完/录音落盘)再主动收尾,避免空挂到 meeting_end
        //(review 真机:互道拜拜后 session 仍 in_progress)。
        // timer 存成员变量:延迟窗内若用户又开口(有效入向语音 / 新 turn)→ cancelPendingHangup 取消,
        // 不挂(用户改主意继续聊)。比仅靠标志更稳——标志在挂断已排程后失效,需能撤销 timer。
        // ★ design contract:延迟改为**按已下发音频时长推算客户端播放完成时刻**——治「跨境告别句尾音被固定 1.5s 切断」。
        //   onAiDone 此刻(tts_done=GPU 合成完)音频帧已全经 onAudioOut 下发,aiTurnAudioMs 含完整告别句时长。
        //   waitMs = 距「推算播完时刻(首帧+已下发时长)」的剩余 + 网络/缓冲余量,clamp 到硬上限(防黑洞永久不挂)。
        //   drain 关 / fail-safe(本轮无音频帧)→ 回退固定 FAREWELL_HANGUP_DELAY_MS(逐字节等价现状)。
        const delayMs = farewellDelayMs; // design contract:用 markAiDonePlaying 清统计前算好的本轮快照(见上)
        if (delayMs >= FAREWELL_DRAIN_MAX_MS) {
          console.warn(
            `[media ${this.cfg.sessionId}] farewell drain 命中硬上限`
            + `(delay=${delayMs}ms cap=${FAREWELL_DRAIN_MAX_MS}ms)`,
          );
        }
        if (this.hangupTimer) clearTimeout(this.hangupTimer);
        this.hangupTimer = setTimeout(() => {
          this.hangupTimer = null;
          if (!this.closed) {
            console.log(`[media ${this.cfg.sessionId}] 检测到双方告别/语义结束,AI 已说完 → 主动收尾(语义挂断,delay=${delayMs}ms)`);
            void this.end("session_end");
          }
        }, delayMs);
        this.hangupTimer.unref?.();
      } else {
        // design contract 条件(d):本轮 AI 完成但**未挂断**——若离开意图 latch 仍 pending,累计 AI 轮放弃计数(达上限清 latch,
        //   防"用户表达离开意图后 AI 已过 N 轮仍未收尾"的陈旧悬挂成误挂定时炸弹)。放行挂断的轮走上面 if 分支,不计。
        this.noteAiTurnForLeaveLatch();
      }
      // ★ design contract:AI 本轮**正常完整播完**(引擎权威 completed=true,非打断/超时/流错/空轮)且未在收尾 →
      //   进「等待考生作答」态,起沉默计时。未完整播完(aiCompleted=false)不进——那时 AI 没把话/题说完,
      //   不该让考生的沉默背锅。shouldHangup 已排程收尾时也不进(本通即将结束,不再等作答)。
      // ★ design contract:进等待态的沉默起算锚点用 playbackNotBeforeMs(客户端估算播完)而非 now(=tts_done 后)——
      //   waiting/after_nudge 两处静默起点(checkR3SilenceAdvance / checkSilenceViolation 的 silenceSince)据此后移。
      if (aiCompleted && !shouldHangup && !this.closed) this.enterWaitingForAnswer(playbackNotBeforeMs);
      // ★ design contract:返回 playbackNotBeforeMs 给 engine —— armAnswerGrace 用它把宽限窗延后到估算播完后
      //   (answerGrace 是第三条播放后推进时钟,与 waiting/after_nudge 用**同一快照**,三处同步)。
      return playbackNotBeforeMs;
    });
    // 每轮 metrics(design contract,旁路):engine 段(LLM/TTS,带权威 turn_index)+ MediaSession 端点段合并落库。
    // 合并点在此(MediaSession 同时见两端);写失败由 MetricsStore 吞掉只告警,绝不阻塞通话。
    // 同一 ai_turn_id 可能被上报**多次**(barge_in 的 cancel_ack 核对结果随后到达,重发同记录仅改
    // cancel_ack_timeout)——按 ai_turn_id 缓存首次合并的 endpoint 段,重发时复用(engine 不持有 endpoint,
    // 否则重发会丢端点段)。同 SK(metric#<ai_turn_id>)覆盖落库,幂等。
    engine.onMetrics?.((em) => {
      const aiTurnId = em.aiTurnId ?? em.turnIndex;
      let ep = this.endpointByTurn.get(aiTurnId);
      if (!ep) {
        ep = this.pendingEndpoint ?? {};
        // barge-in 触发能量四元组(诊断 021-metrics):本轮被打断时由 detectBargeIn 暂存,合并进端点段随本轮落库。
        // **仅当 engine 也报 bargeIn=true 才附**(detectBargeIn→onBargeIn→engine.cancel(barge_in)→上报 bargeIn=true,
        // 同步链路;此 guard 防陈旧 pendingBargeMetrics 误附到非打断轮)。无论是否消费都清,避免跨轮残留。
        if (this.pendingBargeMetrics) {
          if (em.bargeIn) ep = { ...ep, ...this.pendingBargeMetrics };
          this.pendingBargeMetrics = null;
        }
        this.pendingEndpoint = null; // 消费当前轮端点段
        this.endpointByTurn.set(aiTurnId, ep);
        // 仅留最近若干轮的 endpoint 缓存(防长会话无界增长);重发总在首报后极短时间内,够用。
        if (this.endpointByTurn.size > 8) {
          const oldest = this.endpointByTurn.keys().next().value;
          if (oldest !== undefined) this.endpointByTurn.delete(oldest);
        }
      }
      const previous = this.completeMetricsByTurn.get(aiTurnId);
      const complete: TurnMetrics = {
        ...previous,
        ...em,
        ...ep,
        ...(this.uxByTurn.get(aiTurnId) ?? {}),
        sessionId: this.cfg.sessionId,
        aiTurnId,
        tsIso: previous?.tsIso ?? new Date().toISOString(),
      };
      this.completeMetricsByTurn.set(aiTurnId, complete);
      this.trimMetricsCaches();
      void this.deps.metrics?.put(complete);
    });
    // design contract(修 design contract 现存 bug):WS 裸 close = 对端物理断连,走 `peer_hangup`(**非** session_end)。
    //   旧值 session_end 会被 design contract「未问完题不许挂」游标门拦住 → 物理断连却挂不掉;peer_hangup 在游标门白名单。
    // ★ 启动窗终止的**根治**(评审 三~六审逐个揪入口后收敛到正确抽象):任何终止入口——WS close、
    //   engine.onError、外部 manual_hangup(index.ts DELETE)、detach(重复 session_id)——最终都经 end()/detach()
    //   → teardown,teardown 幂等且**按资源存在与否清理**(recorder.stopAndUpload / engine.stop 无条件调、
    //   engine.cancel 由 started 守),故在启动任意阶段调用都安全。**唯一逃逸** = teardown 跑完后 begin() 继续
    //   物化**新**资源。堵法:begin() **每步 await 后复查 `this.closed`**——已收尾则不再物化后续、不启 watchdog、
    //   直接返回(此前 teardown 已按当时资源状态清理;偏序失败如 recorder 成功/engine reject 亦覆盖)。
    this.transport.onClose(() => void this.end("peer_hangup"));
    engine.onError((code, message) => {
      console.error(`[media ${this.cfg.sessionId}] engine error ${code}: ${message}`);
      void this.end("error");
    });
    if (this.closed) return; // 注册 handler 前已被 detach/close 收尾
    try {
      await recorder?.start();
      if (this.closed) { await this.deps.recorder?.stopAndUpload().catch(() => null); return; } // 录音起后被收尾:清它
      await engine.start(this.cfg.sessionId, this.cfg.systemPrompt, this.cfg.engineParams);
      if (this.closed) { await this.deps.engine.stop().catch(() => undefined); return; } // 引擎起后被收尾:清它(录音已由 teardown 清)
    } catch (e) {
      // ★ 偏序失败兜底(评审 七审):start() 契约允许**延迟 reject**——若 teardown 已先跑(this.closed),
      //   reject 会跳过上面的 closed 复查分支,而调用方(index.ts)恢复的 end("error")被 teardown 幂等守挡下 →
      //   reject 前刚物化的 recorder/engine 逃逸泄漏。此处**无论 closed 与否**都 best-effort 停两资源(幂等,重复停无害),
      //   再 re-throw 交调用方按 error 收尾/回报。当前 ThreeStageEngine.start 无内部 await 不延迟 reject,此为契约级防御。
      await this.deps.recorder?.stopAndUpload().catch(() => null);
      await this.deps.engine.stop().catch(() => undefined);
      throw e;
    }
    this.started = true;
    this.startedAtMs = Date.now();

    this.transport.onCommand((command) => this.onCommand(command));
    // 端点看门狗:周期检查「说完→静默」端点,GPU VAD 因底噪不出 turn_end 时兜底触发 AI 回复。
    // unref:看门狗定时器不应阻止进程退出(否则单测/收尾时 event loop 挂住)。
    this.watchdog = setInterval(() => this.watchdogTick(), WATCHDOG_TICK_MS);
    this.watchdog.unref?.();
  }

  private async onCommand(command: MediaSessionCommand): Promise<void> {
    if (this.closed) return;
    if (command.type === "input_audio") {
      const data = command.pcm16k;
      // 入向 PCM(对端语音)
      this.lastInboundFrameAtMs = Date.now(); // design contract:任意入向帧到达 → 更新(区分真沉默[有帧] vs 断流[无帧])
      this.deps.recorder?.pushCaller(data);
      // 会话建立(design contract):首帧到达即启「主动开场静默计时」。只启一次(meetingRoomEntered 守);
      // 若真人已在说(turnPending)则 enterMeetingRoom 不 arm(让位)。
      // (电话版的 Teams IVR 入会门控/缓存回放已删:客户端直连无 IVR,首句直进 ASR。)
      this.enterMeetingRoom();
      if (this.aiSpeaking) {
        // 回声抑制:AI 播报期间喂静音给引擎,压制客户端外放回传的 AI 自身回声
        // 不整段静音入向,保留可打断;真实 barge-in 见 onBargeIn。
        // design contract:复用只读零 buffer(见 silenceBuf),不再每帧 Buffer.alloc。
        this.deps.engine.pushAudio(
          this.silenceFrame(data.length),
          command.inputEpoch,
          command.sourceBytes,
        );
        // barge-in 检测(DTD):连续高能量(经回发参考自适应门槛)达 BARGE_CONFIRM_MS → 打断。
        // ★ 注意(design contract 别名不变式):此处用**真实音频** data,与上面 pushAudio 的静音切片是两个独立
        //   来源;detectBargeIn 及下游只提取 RMS 数值、MUST NOT 持有 data buffer 引用(否则与静音复用错位)。
        this.detectBargeIn(data);
      } else {
        this.deps.engine.pushAudio(
          data,
          command.inputEpoch,
          command.sourceBytes,
        );
        // 端点看门狗:AI 没在播报时,统计用户的说话/静默(服务侧兜底端点,见文件头注释)。
        this.trackEndpoint(data);
        // 声纹注册累计(design contract):**只在此路径**(AI 未在说)累计干净目标语音——避免把 AI 回声采进注册素材。
        //   纯被动观测(只读 RMS,复制窗口给 GPU),绝不碰游标/违规/开场状态机(review)。
        this.updateEnrollment(data);
      }
      return;
    }

    if (command.type === "commit_input") {
      if (this.deps.engine.commitInput) {
        this.deps.engine.commitInput(
          command.inputEpoch,
          command.inputTurnId,
        );
      } else if (command.inputTurnId !== undefined) {
        this.deps.engine.endTurn?.({
          inputEpoch: command.inputEpoch,
          inputTurnId: command.inputTurnId,
        });
      } else {
        throw new Error(
          "voice engine cannot commit input without a stable turn identity",
        );
      }
      return;
    }
    if (command.type === "reset_input") {
      const resetInput = this.deps.engine.resetInput;
      if (!resetInput) throw new Error("voice engine input reset is unavailable");
      // Clear local uncommitted endpoint state before waiting for the engine
      // fence so the watchdog cannot flush retired audio into the next epoch.
      this.resetUncommittedInputEndpoint();
      await resetInput.call(
        this.deps.engine,
        command.fromInputEpoch,
        command.nextInputEpoch,
      );
      for (const key of this.observedInputTurns) {
        if (key.startsWith(`${command.fromInputEpoch}:`)) {
          this.observedInputTurns.delete(key);
        }
      }
      for (const key of this.finalizedInputTurns) {
        if (key.startsWith(`${command.fromInputEpoch}:`)) {
          this.finalizedInputTurns.delete(key);
        }
      }
      for (const key of this.discardedInputTurns) {
        if (key.startsWith(`${command.fromInputEpoch}:`)) {
          this.discardedInputTurns.delete(key);
        }
      }
      return;
    }
    if (command.type === "cancel_response") {
      if (command.responseGeneration !== this.activeResponseGeneration) return;
      if (this.aiSpeaking) {
        this.onBargeIn();
      } else {
        this.emitTransport({
          type: "playback_clear",
          responseGeneration: command.responseGeneration,
          reason: "barge_in",
        });
        this.estimatedClientPlaybackEndMs = Date.now();
        this.deps.engine.cancel("barge_in");
      }
      return;
    }
    if (command.type === "set_output_flow") {
      if (command.paused) {
        if (command.responseGeneration !== this.outputFlowGeneration) return;
        this.outputFlowPaused = true;
        this.outputFlowPausedByGeneration = command.responseGeneration;
      } else {
        if (command.responseGeneration !== this.outputFlowPausedByGeneration) return;
        this.outputFlowPaused = false;
        this.outputFlowPausedByGeneration = null;
        this.flushPendingResponseOutput();
      }
      return;
    }
    if (command.type === "note_output_handoff") {
      const feedback = this.outputWireFeedback.get(command.responseGeneration);
      if (!feedback || feedback.failed || feedback.drained) return;
      if (
        !Number.isInteger(command.deltaSeq) ||
        command.deltaSeq !== feedback.nextDeltaSeq ||
        !feedback.declaredSegments.has(command.segmentId) ||
        !Number.isInteger(command.samples24k) ||
        command.samples24k <= 0 ||
        !Number.isFinite(command.handedOffAtMs)
      ) {
        throw new Error("invalid or out-of-order realtime output handoff");
      }
      feedback.nextDeltaSeq += 1;
      const frameMs = (command.samples24k / 24_000) * 1_000;
      this.estimatedClientPlaybackEndMs =
        Math.max(command.handedOffAtMs, this.estimatedClientPlaybackEndMs) + frameMs;
      return;
    }
    if (command.type === "note_response_wire_drained") {
      const feedback = this.outputWireFeedback.get(command.responseGeneration);
      if (!feedback || feedback.failed || feedback.drained) return;
      feedback.drained = true;
      this.deps.engine.noteResponseWireDrained?.(command.responseGeneration);
      this.trimOutputWireFeedback();
      return;
    }
    if (command.type === "note_output_wire_failure") {
      if (command.responseGeneration !== undefined) {
        const feedback = this.outputWireFeedback.get(command.responseGeneration);
        if (feedback) feedback.failed = true;
      }
      void this.end("error");
      return;
    }

    if (
      command.type === "playback_complete" ||
      command.type === "playback_aborted"
    ) {
      this.playbackCoordinator?.onAck(
        command.aiTurnId,
        command.type === "playback_complete" ? "complete" : "aborted",
        command.reason,
      );
      return;
    }
    if (command.type === "ux_telemetry") {
      this.noteUxTelemetry(command.aiTurnId, command.metrics);
      return;
    }
    if (command.type === "request_end") {
          // 考试完成强制(design contract):有未问完题时忽略客户端 end 请求,记一次逃生阀计数;累计达阈值才放行。
          // 无题(纯人设)/ 已问完 → hasPendingQuestions 为 false,照常结束。**只拦 session_end(用户软请求),
          // manual_hangup(max_duration)走独立 HTTP 路径,不经此**。
          const pending = this.deps.engine.hasPendingQuestions?.() ?? false;
          if (pending) {
            const allow = this.deps.engine.noteEndRequest?.() ?? true; // 记一次;达阈值放行
            if (!allow) {
              console.log(`[media ${this.cfg.sessionId}] 客户端 end 帧但考试未问完 → 忽略(坚持继续);下发提示`);
              this.emitTransport({ type: "exam_incomplete" });
              return;
            }
            console.log(`[media ${this.cfg.sessionId}] 客户端 end 帧达三次坚持逃生阀 → 放行结束(early_exit)`);
          }
          console.log(`[media ${this.cfg.sessionId}] 客户端上行 end 帧 → 主动收尾(考生结束)`);
          void this.end("session_end");
    } else if (command.type === "interrupt") {
          // ★ design contract:受保护违规发言轮(警告/原因句)忽略客户端上行 barge_in——服务端不切源、不清账、不重置
          //   播放队尾,违规发言以服务端播完为准(客户端本地虽已停播,违规发言短,体感差异可接受)。
          if (this.violationNoticeGuard) {
            console.log(`[media ${this.cfg.sessionId}] 客户端上行 barge_in 但处于违规发言保护轮 → 忽略(违规发言不可打断,design contract)`);
            return;
          }
          // 客户端主动打断:仅当 AI 在说才切源(避免空打断)。走同一 onBargeIn 路径(切源 + 清账 + 下行确认)。
          if (this.aiSpeaking) {
            console.log(`[media ${this.cfg.sessionId}] 客户端上行 barge_in → 服务端切源(engine.cancel)`);
            this.onBargeIn();
          } else {
            // ★ design contract(review):客户端上行 barge_in 是**客户端确定已 stopPlayback 清队列**的
            //   权威证据(Exam.tsx detectBargeIn:aiPlaying=now<nextPlayTime 才发)。但 tts_done 已到 → 服务端
            //   markAiDonePlaying 令 aiSpeaking=false,而客户端仍在播 tts_done 后排队的长音频(正是本 spec 治的
            //   tts_done≠客户端播完窗口)→ 此帧落入 `!aiSpeaking` 分支。onBargeIn 因 `!aiSpeaking` 提前返回,
            //   **会话级播放队尾不被重置** → 下一轮 onAudioOut 从虚假旧队尾继续累加 → waiting/after_nudge/answerGrace
            //   最多额外延迟 MAX_PLAYBACK_LEAD_MS(缺陷:「早推进」被换成「长时间不推进」)。故此处**无条件**重置
            //   播放队尾 + 清 waiting/R3 + 撤挂断意图(客户端已清队列 = 这些估算/等待态的依据已作废)。
            //   MUST NOT 碰 aiSpeaking(spec R3 红线);无 activeTurn 可切(engine 侧本轮已 tts_done 收尾),不调 engine.cancel。
            console.log(`[media ${this.cfg.sessionId}] 客户端上行 barge_in 但 aiSpeaking=false(tts_done 后客户端仍在播)→ 重置播放队尾估算 + 清 waiting/R3(不切源,本轮已收尾)`);
            this.estimatedClientPlaybackEndMs = Date.now();
            this.waitingSinceMs = 0;
            this.silenceCountedThisWait = false;
            this.resetR3Phase();
            this.cancelPendingHangup();
            this.clearLeaveLatch();
          }
    }
  }

  private inputIdentityKey(identity: {
    inputEpoch: number;
    inputTurnId: number;
  }): string {
    return `${identity.inputEpoch}:${identity.inputTurnId}`;
  }

  private emitInputSpeechStarted(identity: {
    inputEpoch: number;
    inputTurnId: number;
  }): void {
    const key = this.inputIdentityKey(identity);
    if (this.observedInputTurns.has(key)) return;
    this.observedInputTurns.add(key);
    this.emitTransport({ type: "input_speech_started", ...identity });
  }

  private isResponseOutputEvent(
    event: MediaSessionOutputEvent,
  ): event is MediaSessionResponseOutputEvent {
    return (
      event.type === "response_started" ||
      event.type === "response_segment_declared" ||
      event.type === "response_audio" ||
      event.type === "response_segment_completed" ||
      event.type === "response_core_terminal" ||
      event.type === "response_output_delivery_failed"
    );
  }

  private emitResponseOutput(event: MediaSessionOutputEvent): void {
    if (!this.isResponseOutputEvent(event)) {
      this.emitTransport(event);
      return;
    }
    const generation = event.responseGeneration;
    if (this.isResponseGenerationRetired(generation)) return;

    if (event.type === "response_output_delivery_failed") {
      this.dropPendingResponseGeneration(generation);
      this.retireResponseGeneration(generation);
      if (this.outputFlowGeneration === generation) {
        this.outputFlowGeneration = null;
      }
      this.emitTransport(event);
      return;
    }

    if (this.outputFlowGeneration === null) {
      if (event.type !== "response_started") {
        this.failPendingResponseOutput(generation, "core_pending_output_timeout");
        return;
      }
      this.outputFlowGeneration = generation;
    }

    const isTerminal = event.type === "response_core_terminal";
    const destructiveTerminal =
      isTerminal && event.status !== "completed";
    if (
      generation !== this.outputFlowGeneration ||
      (this.outputFlowPaused && !destructiveTerminal)
    ) {
      this.queueResponseOutput(event);
      return;
    }

    if (destructiveTerminal) {
      this.dropPendingResponseGeneration(generation);
      this.retireResponseGeneration(generation);
    }
    this.deliverResponseOutput(event);
  }

  private flushPendingResponseOutput(): void {
    while (!this.outputFlowPaused && this.pendingResponseOutput.length > 0) {
      const next = this.pendingResponseOutput[0];
      const event = next.event;
      if (!this.isResponseOutputEvent(event)) {
        this.shiftPendingResponseOutput();
        this.emitTransport(event);
        continue;
      }
      if (this.isResponseGenerationRetired(event.responseGeneration)) {
        this.shiftPendingResponseOutput();
        continue;
      }
      if (this.outputFlowGeneration === null) {
        if (event.type !== "response_started") {
          this.failPendingResponseOutput(
            event.responseGeneration,
            "core_pending_output_timeout",
          );
          return;
        }
        this.outputFlowGeneration = event.responseGeneration;
      }
      if (event.responseGeneration !== this.outputFlowGeneration) return;
      this.shiftPendingResponseOutput();
      this.deliverResponseOutput(event);
    }
    this.updatePendingResponseOutputTimer();
  }

  private deliverResponseOutput(event: MediaSessionOutputEvent): void {
    this.emitTransport(event);
    if (event.type === "response_core_terminal") {
      this.retireResponseGeneration(event.responseGeneration);
      if (this.activeResponseGeneration === event.responseGeneration) {
        this.activeResponseGeneration = null;
      }
      this.outputFlowGeneration = null;
      this.flushPendingResponseOutput();
    }
  }

  private queueResponseOutput(event: MediaSessionOutputEvent): void {
    const bytes = event.type === "response_audio" ? event.pcm16k.length : 0;
    if (
      this.pendingResponseOutputBytes + bytes >
      MEDIA_SESSION_OUTPUT_LIMITS.MAX_PENDING_BYTES
    ) {
      const generation =
        this.isResponseOutputEvent(event) ? event.responseGeneration : -1;
      this.failPendingResponseOutput(generation, "core_pending_output_limit");
      return;
    }
    this.pendingResponseOutput.push({ event, queuedAtMs: Date.now() });
    this.pendingResponseOutputBytes += bytes;
    this.updatePendingResponseOutputTimer();
  }

  private shiftPendingResponseOutput(): MediaSessionOutputEvent | undefined {
    const shifted = this.pendingResponseOutput.shift();
    if (!shifted) return undefined;
    if (shifted.event.type === "response_audio") {
      this.pendingResponseOutputBytes -= shifted.event.pcm16k.length;
    }
    return shifted.event;
  }

  private dropPendingResponseGeneration(responseGeneration: number): void {
    this.pendingResponseOutput = this.pendingResponseOutput.filter(({ event }) => {
      if (
        this.isResponseOutputEvent(event) &&
        event.responseGeneration === responseGeneration
      ) {
        if (event.type === "response_audio") {
          this.pendingResponseOutputBytes -= event.pcm16k.length;
        }
        return false;
      }
      return true;
    });
    this.updatePendingResponseOutputTimer();
  }

  private failPendingResponseOutput(
    responseGeneration: number,
    reason: "core_pending_output_limit" | "core_pending_output_timeout",
  ): void {
    this.pendingResponseOutput = [];
    this.pendingResponseOutputBytes = 0;
    this.responsePlaybackSnapshots.clear();
    this.outputFlowPaused = false;
    this.outputFlowPausedByGeneration = null;
    this.outputFlowGeneration = null;
    this.clearPendingResponseOutputTimer();
    if (responseGeneration >= 0) {
      this.retireResponseGeneration(responseGeneration);
    }
    this.emitTransport({
      type: "response_output_delivery_failed",
      responseGeneration,
      reason,
    });
  }

  private updatePendingResponseOutputTimer(): void {
    this.clearPendingResponseOutputTimer();
    const oldest = this.pendingResponseOutput[0];
    if (!oldest) return;
    const ageMs = Date.now() - oldest.queuedAtMs;
    const delayMs = Math.max(
      1,
      MEDIA_SESSION_OUTPUT_LIMITS.MAX_QUEUE_AGE_MS - ageMs,
    );
    this.pendingResponseOutputTimer = setTimeout(() => {
      this.pendingResponseOutputTimer = null;
      const currentOldest = this.pendingResponseOutput[0];
      if (!currentOldest) return;
      if (
        Date.now() - currentOldest.queuedAtMs >=
        MEDIA_SESSION_OUTPUT_LIMITS.MAX_QUEUE_AGE_MS
      ) {
        const event = currentOldest.event;
        const generation =
          this.isResponseOutputEvent(event) ? event.responseGeneration : -1;
        this.failPendingResponseOutput(
          generation,
          "core_pending_output_timeout",
        );
        return;
      }
      this.updatePendingResponseOutputTimer();
    }, delayMs);
    this.pendingResponseOutputTimer.unref?.();
  }

  private clearPendingResponseOutputTimer(): void {
    if (!this.pendingResponseOutputTimer) return;
    clearTimeout(this.pendingResponseOutputTimer);
    this.pendingResponseOutputTimer = null;
  }

  private trimOutputWireFeedback(): void {
    while (this.outputWireFeedback.size > 8) {
      const oldest = this.outputWireFeedback.keys().next().value;
      if (oldest === undefined) break;
      this.outputWireFeedback.delete(oldest);
    }
  }

  private isResponseGenerationRetired(responseGeneration: number): boolean {
    return responseGeneration <= this.retiredResponseGenerationHighWater;
  }

  private retireResponseGeneration(responseGeneration: number): void {
    this.retiredResponseGenerationHighWater = Math.max(
      this.retiredResponseGenerationHighWater,
      responseGeneration,
    );
    for (const generation of this.responseIdentityByGeneration.keys()) {
      if (generation <= this.retiredResponseGenerationHighWater) {
        this.responseIdentityByGeneration.delete(generation);
      }
    }
  }

  /** ASR 字幕 LLM 修正(design contract,旁路 fire-and-forget)。**MUST NOT await**——与对话/首声解耦。
   *  未配 fixer model / 无 token / 超并发上限 / 空句 → 跳过(字幕/转写留原文,回退现状)。
   *  成功且文本有变且会话未结束 → 下行 transcript_corrected(同 seq)+ 覆盖落库(同 tsMs sk)。
   *  失败/超时/输出不可信/会话已结束 → fail-open(留原文占位,不下行、不覆盖)。 */
  private maybeCorrectTranscript(original: string, seq: number, tsMs: number, questionIndex?: number): void {
    const p = this.cfg.engineParams;
    const modelId = p.llmTranscriptFixerModelId;
    const isConverse = p.llmCallMethod === "bedrock_converse";
    // design contract:按 call_method 取修正凭据——converse 用 Bedrock API Key、mantle 用 mantle token。
    const cred = isConverse ? p.llmBedrockApiKey : p.llmBearerToken;
    // 未配修正模型 / 无对应凭据 → 不修。
    if (!modelId || !cred) {
      // 可观测(诊断 + review):区分「未配 model」与「无凭据」两种不修因,便于真机排障。
      console.log(`[fixer ${this.cfg.sessionId}] 跳过 seq=${seq}:${!modelId ? "未配 fixer model" : "无凭据"}(不修)`);
      return;
    }
    const text = (original ?? "").trim();
    if (!text) return; // 空句不修
    // 并发背压:飞行中修正达上限 → 跳过本轮(fail-open,记日志),不排队堆积(防快说雪崩)。
    if (this.fixerInFlight >= MediaSession.FIXER_MAX_INFLIGHT) {
      console.warn(`[fixer ${this.cfg.sessionId}] 飞行中修正达上限 ${MediaSession.FIXER_MAX_INFLIGHT} → 跳过 seq=${seq}(留原文)`);
      return;
    }
    this.fixerInFlight++;
    const ctx: ReturnType<NonNullable<VoiceEngine["correctionContext"]>> =
      this.deps.engine.correctionContext?.() ?? { history: [] };
    // design contract:按 call_method 绑定单次补全上游。converse → bedrockConverseCompleteOnce;mantle → 缺省(mantleCompleteOnce)。
    const complete = isConverse
      ? (prompt: string, userText: string, signal: AbortSignal) =>
          bedrockConverseCompleteOnce(
            { apiKey: p.llmBedrockApiKey ?? "", host: p.llmMantleHost ?? "", bedrockRegion: p.llmBedrockRegion ?? "us-east-1" },
            { modelId, systemPrompt: prompt, userText },
            signal,
          )
      : undefined; // undefined → correctTranscript 用缺省 mantleCompleteOnce
    void correctTranscript(
      text,
      modelId,
      { token: p.llmBearerToken ?? "", host: p.llmMantleHost },
      { history: ctx.history, question: ctx.question },
      {
        complete,
        externalSignal: this.fixerAbort.signal, // 会话结束一并 abort
        onError: (reason) => {
          if (reason !== "session_ended") {
            console.warn(`[fixer ${this.cfg.sessionId}] 修正 seq=${seq} 未生效(${reason})→ 留原文`);
          }
        },
      },
    )
      .then((fixed) => {
        // 会话已结束 → 丢弃迟到结果(不下行、不覆盖;该行停在原文占位)。
        if (this.closed || this.fixerAbort.signal.aborted) return;
        // 文本无变化(原句无错 / fail-open 返回原文)→ 不下行、不覆盖(省流量,字幕已是原文)。
        if (fixed.trim() === text) {
          console.log(`[fixer ${this.cfg.sessionId}] seq=${seq} 修正后无变化(原文即正确)→ 不下行`);
          return;
        }
        // 下行修正帧(同 seq → 客户端更新对应 user 气泡)+ 覆盖落库(同 tsMs → 顺序不变,内容更新)。
        //   ★ design contract:覆盖落库**沿用原文 asr_final 捕获的 questionIndex**(修正是异步旁路,返回时游标可能已推进 →
        //   重查会把回答标错题;双评审 Blocker)。修正帧同 user transcript 帧一样**不含** question_index。
        console.log(`[fixer ${this.cfg.sessionId}] seq=${seq} 修正生效:"${text.slice(0, 20)}" → "${fixed.slice(0, 20)}"`);
        this.emitTransport({
          type: "transcript_corrected",
          speaker: "user",
          seq,
          text: fixed,
        });
        void this.deps.transcripts?.putFinal(this.cfg.sessionId, "user", fixed, tsMs, questionIndex);
      })
      .catch(() => {
        /* correctTranscript 内部已 fail-open 不抛;此 catch 仅防御,吞掉不拖垮 */
      })
      .finally(() => {
        this.fixerInFlight--;
      });
  }

  /** design contract:旁路「判句子完整性」EOU 判定(fire-and-forget,不阻塞对话/首声)。
   *  未开 L3 / 未配 model / 无凭据 / 超并发 / 空句 → 跳过(无判定、无纠偏,逐字节等价现状)。
   *  判 incomplete + 返回时校验通过(关联窗内 + 游标未变 + AI 仍在播)→ 开「降门槛窗」(设 eouIncompleteUntilMs),
   *  detectBargeIn 在窗内对该轮用亚阈门槛(考生亚常规阈重新出声即触发 tentative-pause 让位)。
   *  任何失败/超时/stale/complete → 不开窗(fail-open,绝不误暂停)。 */
  private maybeJudgeEou(original: string): void {
    if (!EOU_CORRECTION_ENABLED) return; // 默认关:逐字节等价现状
    const p = this.cfg.engineParams;
    // 复用 fixer 的判定模型 + 凭据(同一旁路模型即可;L3 只需短判定)。未配则不判。
    const modelId = p.llmTranscriptFixerModelId;
    const isConverse = p.llmCallMethod === "bedrock_converse";
    const cred = isConverse ? p.llmBedrockApiKey : p.llmBearerToken;
    if (!modelId || !cred) return; // 未配旁路 model / 无凭据 → 不判(同 fixer)
    const text = (original ?? "").trim();
    if (!text) return; // 空句不判
    if (this.eouInFlight >= MediaSession.FIXER_MAX_INFLIGHT) {
      console.warn(`[eou ${this.cfg.sessionId}] 飞行中判定达上限 → 跳过(不纠偏)`);
      return;
    }
    // 绑定 fire 时的游标身份(判 stale「游标未变」):判定返回时比对,已推进则丢弃。
    const fireCursor = this.deps.engine.questionCursor?.() ?? -1;
    const fireAtMs = Date.now(); // 关联窗基准 ≈ 静音端点/AI 开口时刻(asr_final)
    this.eouInFlight++;
    const ctx: ReturnType<NonNullable<VoiceEngine["correctionContext"]>> =
      this.deps.engine.correctionContext?.() ?? { history: [] };
    const complete = isConverse
      ? (prompt: string, userText: string, signal: AbortSignal) =>
          bedrockConverseCompleteOnce(
            { apiKey: p.llmBedrockApiKey ?? "", host: p.llmMantleHost ?? "", bedrockRegion: p.llmBedrockRegion ?? "us-east-1" },
            { modelId, systemPrompt: prompt, userText },
            signal,
          )
      : undefined; // undefined → judgeEou 用缺省 mantleCompleteOnce
    void judgeEou(
      text,
      modelId,
      { token: p.llmBearerToken ?? "", host: p.llmMantleHost },
      { history: ctx.history, question: ctx.question },
      {
        complete,
        externalSignal: this.fixerAbort.signal, // 复用会话结束 abort(与 fixer 同信号)
        onError: (reason) => {
          if (reason !== "session_ended") console.warn(`[eou ${this.cfg.sessionId}] 判定未生效(${reason})→ 不纠偏`);
        },
      },
    )
      .then((verdict) => {
        if (this.closed || this.fixerAbort.signal.aborted) return; // 会话结束丢弃迟到结果
        if (verdict !== "incomplete") return; // complete / null(判不了)→ 不纠偏
        // ── 返回校验(design contract:防错轮误暂停)──
        // (a) 关联窗:返回距 fire(≈静音端点)超 correlationMs → 判定过时,丢弃。
        const age = Date.now() - fireAtMs;
        if (age > EOU_CORRELATION_MS) {
          console.log(`[eou ${this.cfg.sessionId}] 判 incomplete 但已超关联窗(${age}ms>${EOU_CORRELATION_MS}ms)→ 丢弃(stale)`);
          return;
        }
        // (b) 游标未变:返回时游标已推进(该轮已被后续题取代)→ 丢弃(防判 QK 未完误用到 QK+1)。
        const nowCursor = this.deps.engine.questionCursor?.() ?? -1;
        if (fireCursor >= 0 && nowCursor !== fireCursor) {
          console.log(`[eou ${this.cfg.sessionId}] 判 incomplete 但游标已推进(${fireCursor}→${nowCursor})→ 丢弃(stale)`);
          return;
        }
        // (c) AI 轮仍在 + turn-state 守卫:必须 AI 正在播报(有可暂停的音频)才纠偏;否则无处暂停,丢弃
        //     (覆盖 detectBargeIn 到不了的态:kickoff 首音频前 / aiDoneFired 后 / defer 期——此处以 aiSpeaking 统一判)。
        if (!this.aiSpeaking) {
          console.log(`[eou ${this.cfg.sessionId}] 判 incomplete 但 AI 未在播报 → 丢弃(无处暂停)`);
          return;
        }
        // (d) 已在 tentative-pause → 常规 barge 已接管,L3 幂等不重复(读 tentativePausing 守卫)。
        if (this.tentativePausing) return;
        // ── 校验通过:开「降门槛窗」──。不直接 beginTentativePause(spec R3-b:L3 不新造暂停触发,
        //   而是降门槛让考生**重新出声**才触发)——设窗,detectBargeIn 在窗内用亚阈判考生是否真的续说。
        this.eouIncompleteUntilMs = Date.now() + EOU_SUB_THRESHOLD_WINDOW_MS;
        this.eouIncompleteCursor = fireCursor;
        console.log(`[eou ${this.cfg.sessionId}] 判 incomplete(校验通过)→ 开降门槛窗 ${EOU_SUB_THRESHOLD_WINDOW_MS}ms(考生亚阈续说即让位;cursor=${fireCursor})`);
      })
      .catch(() => {
        /* judgeEou 内部已 fail-open 不抛;此 catch 仅防御 */
      })
      .finally(() => {
        this.eouInFlight--;
      });
  }

  /** design contract:旁路违规裁判(fire-and-forget,不阻塞对话/首声)。**R2 阶段 shadow only**——只裁判 + log
   *  分类/置信/耗时,不计数、不警告、不挂断(那些在 R1/R4/R3,由 AIM_VIOLATION_ENFORCEMENT 门控)。
   *  未下发 llmModerationModelId / 无凭据 / **idle 裁判串行忙(有在飞行)** / 空句 / **本轮已判** → 跳过(逐字节等价
   *  现状)。fail-open:裁判 null(判不了)不产生任何动作。**每逻辑轮最多判一次**(M1:moderatedThisTurn 布尔,
   *  turn_end/resetTurn 清);**idle 裁判串行**(review:保 verdict 按轮序 → streak 连续语义正确)。 */
  private maybeJudgeModeration(original: string): void {
    // design contract 修复(部署验证 sess_example / sess_example):自由聊天(无题)**完全不跑违规裁判**——
    //   与 checkSilenceViolation 的无题豁免对称。无题里「离题/未作答」概念不成立:裁判拿「当前题」判用户是否在答题,
    //   无题时任何正常闲聊都会被判 unrelated_chatter → idleChatterStreak 累计 → 强制结束,违背「AI 永不主动挂」铁律。
    //   设计决策:无题连 severe_directed_abuse 也不判(自由聊天完全不介入违规裁判)。有题路径逻辑完全不变。
    if (!this.deps.engine.hasQuestions()) return;
    const p = this.cfg.engineParams;
    const modelId = p.llmModerationModelId;
    const isConverse = p.llmCallMethod === "bedrock_converse";
    const cred = isConverse ? p.llmBedrockApiKey : p.llmBearerToken;
    if (!modelId || !cred) return; // 未下发裁判 model / 无凭据 → 不跑(逐字节等价现状)
    const text = (original ?? "").trim();
    if (!text) return; // 空句不判
    if (this.moderatedThisTurn) return; // 本逻辑轮已判(同轮分段/重发 final)→ 去重(M1 修:不用每 final 自增 id)
    // ★ design contract(review):idle 裁判**串行**——已有 idle 裁判在飞行 → 本轮**背压跳过** +
    //   **断连续链**(跳过轮拿不到证据,不能让它前后两轮 unrelated 凑连续)+ **作废在途裁判**(gen++:导致背压的
    //   那个在途裁判晚返回时会因 gen 变了被丢弃,否则它重建 streak 跨越被跳过的轮 —— review 反例)。
    if (this.idleChatterInFlight) {
      this.idleModerationGen++; // 作废当前在飞行的 idle 裁判(它的 verdict 返回时 gen 已变 → 丢弃)
      if (this.idleChatterStreak > 0) {
        console.warn(`[moderation ${this.cfg.sessionId}] idle 裁判串行忙(有在飞行)→ 本轮跳过 + 清 idleChatterStreak(${this.idleChatterStreak}→0,断连续)+ 作废在途裁判(gen→${this.idleModerationGen})`);
        this.idleChatterStreak = 0;
      } else {
        console.warn(`[moderation ${this.cfg.sessionId}] idle 裁判串行忙(有在飞行)→ 本轮跳过 + 作废在途裁判(gen→${this.idleModerationGen})`);
      }
      return;
    }
    this.moderatedThisTurn = true; // 本轮已判(resetTurn 清)
    const turnId = ++this.userTurnId; // 单调轮次号(仅日志)
    const gen = this.idleModerationGen; // 本裁判的「代」快照:返回时 !== 现 gen → 已被跳过作废,丢弃不 mutate streak
    this.idleChatterInFlight = true;
    const startMs = Date.now();
    const ctx: ReturnType<NonNullable<VoiceEngine["correctionContext"]>> =
      this.deps.engine.correctionContext?.() ?? { history: [] };
    const complete = isConverse
      ? (prompt: string, userText: string, signal: AbortSignal) =>
          bedrockConverseCompleteOnce(
            { apiKey: p.llmBedrockApiKey ?? "", host: p.llmMantleHost ?? "", bedrockRegion: p.llmBedrockRegion ?? "us-east-1" },
            // maxTokens:64(review)——裁判 JSON 输出实测 <64 token,不传则兜底 512 浪费/慢。与 mantle 路径对齐。
            { modelId, systemPrompt: prompt, userText, maxTokens: 64 },
            signal,
          )
      : undefined; // undefined → judgeModeration 用缺省 mantleCompleteOnce(maxTokens 64)
    void judgeModeration(
      text,
      modelId,
      { token: p.llmBearerToken ?? "", host: p.llmMantleHost },
      { history: ctx.history, question: ctx.question },
      {
        complete,
        externalSignal: this.fixerAbort.signal, // 复用会话结束 abort
        onError: (reason) => {
          if (reason !== "session_ended") console.warn(`[moderation ${this.cfg.sessionId}] 裁判未生效(${reason})`);
        },
      },
    )
      .then((verdict) => {
        if (this.closed || this.fixerAbort.signal.aborted) return; // 会话结束丢弃迟到结果
        const elapsedMs = Date.now() - startMs;
        // ★ 作废检查(review):本裁判被后续背压跳过作废(gen 变了)→ 丢弃,**不 mutate streak**。
        //   否则「导致背压的在途裁判晚返回重建 streak,跨越被跳过的轮」凑假连续。串行下 gen 变 = 本裁判已过期。
        if (gen !== this.idleModerationGen) {
          console.log(`[moderation ${this.cfg.sessionId}] turn=${turnId} 裁判已被跳过作废(gen ${gen}→${this.idleModerationGen})→ 丢弃(不更新 streak)elapsed=${elapsedMs}ms`);
          return;
        }
        // shadow log 恒打(观察准确率),不受 enforcement 门控。
        if (verdict == null) {
          // 判不了(fail-open):**清 idleChatterStreak**——「连续高置信 unrelated」是严格连续,本轮拿不到证据
          //   (系统失败)即断链,更宁漏勿误(不让「高 unrelated → 判不了 → 高 unrelated」凑成连续)。
          if (this.idleChatterStreak > 0) {
            console.log(`[moderation ${this.cfg.sessionId}] turn=${turnId} 判不了(fail-open)→ 清 idleChatterStreak(${this.idleChatterStreak}→0,断连续)elapsed=${elapsedMs}ms`);
            this.idleChatterStreak = 0;
          } else {
            console.log(`[moderation ${this.cfg.sessionId}] turn=${turnId} 判不了(fail-open)elapsed=${elapsedMs}ms`);
          }
          return;
        }
        const highConf = verdict.confidence >= MODERATION_CONFIDENCE_THRESHOLD;
        console.log(
          `[moderation ${this.cfg.sessionId}] turn=${turnId} klass=${verdict.klass} ` +
          `conf=${verdict.confidence.toFixed(2)}(highConf=${highConf}) answerComplete=${verdict.answerComplete} elapsed=${elapsedMs}ms`,
        );
        // design contract:据裁判分类接违规轨(仅高置信才动作,宁漏勿误)。辅助推进票(4.2)已砍(见 spec 决策),不再注入。
        this.applyModerationVerdict(verdict.klass, highConf, turnId);
      })
      .catch(() => {
        /* judgeModeration 内部已 fail-open 不抛;此 catch 仅防御 */
      })
      .finally(() => {
        this.idleChatterInFlight = false; // idle 裁判串行门释放(下一轮 asr_final 可再发起)
      });
  }

  /** design contract:据裁判可观察事实分类接违规轨。**离题三分**(设计决策,宁漏勿误):
   *   - `on_topic_attempt`/`explicit_decline`(高置信,在答/坦白不会)→ **不违规**,清 idleChatterStreak(回到正题,断链);
   *   - `unrelated_chatter`(高置信,扯闲篇)→ streak++;连续达 IDLE_CHATTER_MIN_TURNS → 计一次消极对抗
   *     (与沉默合并进 negativeCount 同阶梯)并清零 streak(重新计下一段);单轮不罚(防偶发离题误伤);
   *   - `severe_directed_abuse`(高置信,定向辱骂/威胁)→ **R3** 处置(severeViolationCount,本模块尚未接;此处仅 log);
   *   - `uncertain` / **低置信**任何类 → **清 idleChatterStreak**(review + review:严格「连续
   *     高置信 unrelated」语义——一轮「拿不准」即断链,更宁漏勿误,贴合用户保守取向)。**不给推进票**。
   *  (**判不了 null / 背压跳过**也断链——在 .then / maybeJudgeModeration 里清 streak,review:连续证据链
   *   要求**每轮都拿到高置信 unrelated 证据**,任何一轮「没证据」即断。)
   *  **仅 VIOLATION_ENFORCEMENT 开时**产生动作(handleNegativeViolation 内部再次门控 nudge/end);关时仅上面的
   *  shadow log 观察(不改行为)。severe 的 R3 接入前,enforcement 开也只 log(不误伤,不半吊子硬结束)。
   *  注:R4(4.2)辅助推进票**已砍**(见 design contract「4.2 决策:砍掉」)——本方法不再给引擎注入任何游标提示,
   *  游标推进逐字节保持现状(design contract)。 */
  private applyModerationVerdict(
    klass: string,
    highConf: boolean,
    turnId: number,
  ): void {
    if (!highConf) {
      // 低置信/uncertain verdict(判不准)→ 断「连续高置信 unrelated」链(review,更宁漏勿误)。
      if (this.idleChatterStreak > 0) {
        console.log(`[violation ${this.cfg.sessionId}] turn=${turnId} 低置信/uncertain(判不准)→ 清 idleChatterStreak(${this.idleChatterStreak}→0,断连续)`);
      }
      this.idleChatterStreak = 0;
      return;
    }
    if (klass === "on_topic_attempt" || klass === "explicit_decline") {
      // 回到正题作答(含坦白不会)→ 断「连续扯闲篇」链。非 enforcement 也清(纯状态,shadow 下也维护 streak 观察)。
      if (this.idleChatterStreak > 0) {
        console.log(`[violation ${this.cfg.sessionId}] turn=${turnId} 高置信 ${klass}(在答/坦白)→ 清 idleChatterStreak(${this.idleChatterStreak}→0)`);
      }
      this.idleChatterStreak = 0;
      return;
    }
    if (klass === "unrelated_chatter") {
      this.idleChatterStreak += 1;
      console.log(`[violation ${this.cfg.sessionId}] turn=${turnId} 高置信 unrelated_chatter → idleChatterStreak=${this.idleChatterStreak}/${IDLE_CHATTER_MIN_TURNS}`);
      if (this.idleChatterStreak >= IDLE_CHATTER_MIN_TURNS) {
        this.idleChatterStreak = 0; // 计一次后清零,重新计下一段连续扯闲篇(避免每轮都 +1 触发)
        this.handleNegativeViolation("idle"); // 与沉默合并阶梯(内部 VIOLATION_ENFORCEMENT 门控 + 计数升级)
      }
      return;
    }
    if (klass === "severe_directed_abuse") {
      // design contract:严重违规**独立轨**(与消极对抗轨 negativeCount 分开,spec),故**不**动 idleChatterStreak。
      //   语义:警告(达 SEVERE_VIOLATION_MAX-1 次已送达警告)后再犯 → 强制结束。
      if (!VIOLATION_ENFORCEMENT) {
        // shadow:仅计数观察(不 nudge/不 end)。此处才 ++(观察真实 severe 频次)。
        this.severeViolationCount += 1;
        console.log(`[violation ${this.cfg.sessionId}] turn=${turnId} shadow severe_directed_abuse 计数=${this.severeViolationCount}/${SEVERE_VIOLATION_MAX}(enforcement 关,不警告/不结束)`);
        return;
      }
      // enforcement 开:此次是「终局」还是「警告」看**已计次数**(= 已送达的警告数)。
      if (this.severeViolationCount + 1 >= SEVERE_VIOLATION_MAX) {
        // 终局:计一次 + 违规强制结束(armForcedEndAfterNotice 保证原因句送达/硬超时兜底)。
        this.severeViolationCount += 1;
        console.warn(`[violation ${this.cfg.sessionId}] turn=${turnId} severe_directed_abuse 达终局(计数将 ${this.severeViolationCount}>=${SEVERE_VIOLATION_MAX})→ 违规强制结束(severe_violation,先说明原因)`);
        this.armForcedEndAfterNotice("severe_violation", "对方再次说出严重不当的话。请严肃、简短地向对方说明:因严重不当言行,本次测评到此结束。");
        return;
      }
      // 警告:**仅当警告真送达(nudge 接受)才 ++**(评审 复审 Major:busy 丢弃的警告 MUST NOT 推进计数,
      //   否则「从没听到警告就因再犯被结束」)。busy 被拒 → 不 ++、log 丢弃,下次 severe 重新尝试警告(考生必先听到
      //   足够警告才会到终局)。
      const warned = this.nudgeViolationNotice("对方说了严重不当的话(如辱骂/威胁/性骚扰)。请严肃、简短地提醒对方:请注意言辞,若再次出现本次测评将立即结束。"); // design contract:severe 警告句受保护
      if (warned) {
        this.severeViolationCount += 1;
        console.warn(`[violation ${this.cfg.sessionId}] turn=${turnId} severe_directed_abuse 警告已送达(计数=${this.severeViolationCount}/${SEVERE_VIOLATION_MAX})`);
      } else {
        console.warn(`[violation ${this.cfg.sessionId}] turn=${turnId} severe_directed_abuse 警告 busy 被拒(未送达)→ 不推进计数(下次 severe 重试警告,防「没警告就结束」)`);
      }
      return;
    }
    // 兜底(review):落到此处 = 高置信 `uncertain`(拿不准),或未来新增的其它非 unrelated/severe 类。
    //   uncertain **不是**「在答」也**不是**「扯闲篇」——是「没有可观察的扯闲篇证据」→ MUST **清 streak 断链**
    //   (否则「高 unrelated → 高 uncertain → 高 unrelated」误凑连续 2 轮)。用**兜底清零**而非只加 uncertain case:
    //   任何非 unrelated_chatter/severe 的类(含未来扩展)都无「连续扯闲篇」语义 → 断链才是 fail-safe 的正确默认。
    if (this.idleChatterStreak > 0) {
      console.log(`[violation ${this.cfg.sessionId}] turn=${turnId} 高置信 ${klass}(非扯闲篇/无连续证据)→ 清 idleChatterStreak(${this.idleChatterStreak}→0,断链)`);
    }
    this.idleChatterStreak = 0;
  }

  /** Protocol-neutral observer output. Transport implementations own wire encoding. */
  private emitTransport(event: MediaSessionOutputEvent): void {
    if (
      this.closed &&
      !(this.teardownInProgress && event.type === "response_core_terminal")
    ) {
      return;
    }
    try {
      this.transport.emit(event);
    } catch {
      /* observer output is best-effort on the legacy v1 path */
    }
  }

  /** Browser AudioContext-domain telemetry. Each field is first-observation-wins;
   *  a late event rewrites the same complete metric record instead of emitting a
   *  sparse second row. */
  private noteUxTelemetry(aiTurnId: number, incoming: UxTelemetryMetrics): void {
    if (
      !Number.isSafeInteger(aiTurnId) ||
      aiTurnId < 0 ||
      !this.uxIssuedTurns.has(aiTurnId)
    ) {
      return;
    }
    const current = this.uxByTurn.get(aiTurnId) ?? {};
    let changed = false;
    const next: UxTelemetryMetrics = { ...current };
    const keys: Array<keyof UxTelemetryMetrics> = [
      "markerToFirstBinaryMs",
      "firstBinaryToFirstRenderMs",
      "markerToFirstRenderMs",
      "coldPrerollMs",
      "underrunsBeforeFirstRender",
      "pauseToFirstSilentRenderMs",
      "confirmToWorkletFlushMs",
      "browserRingDepthAtConfirmMs",
      "browserRingDepthBeforeFlushMs",
      "browserRingDepthAfterFlushMs",
    ];
    for (const key of keys) {
      const value = incoming[key];
      if (
        next[key] === undefined &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= (
          key === "underrunsBeforeFirstRender"
            ? UX_TELEMETRY_LIMITS.MAX_UNDERRUNS
            : key === "browserRingDepthAtConfirmMs" ||
                key === "browserRingDepthBeforeFlushMs" ||
                key === "browserRingDepthAfterFlushMs"
              ? UX_TELEMETRY_LIMITS.MAX_RING_DEPTH_MS
              : UX_TELEMETRY_LIMITS.MAX_DURATION_MS
        ) &&
        (key !== "underrunsBeforeFirstRender" || Number.isInteger(value))
      ) {
        next[key] = value;
        changed = true;
      }
    }
    if (!changed) return;
    this.uxByTurn.set(aiTurnId, next);

    const record = this.completeMetricsByTurn.get(aiTurnId);
    if (record) {
      const complete = { ...record, ...next };
      this.completeMetricsByTurn.set(aiTurnId, complete);
      void this.deps.metrics?.put(complete);
    }
    this.trimMetricsCaches();
  }

  private trimMetricsCaches(): void {
    while (this.completeMetricsByTurn.size > 16) {
      const oldest = this.completeMetricsByTurn.keys().next().value;
      if (oldest === undefined) break;
      this.completeMetricsByTurn.delete(oldest);
      this.uxByTurn.delete(oldest);
    }
    while (this.uxByTurn.size > 16) {
      const oldest = this.uxByTurn.keys().next().value;
      if (oldest === undefined) break;
      this.uxByTurn.delete(oldest);
    }
  }

  /** 播放 ACK 结算回调(design contract)。
   *
   *  ★ design contract:原先此处有 `isEnforce()` 早退门(observe 只记账)——mode 三态已删,门随之移除。
   *  **推进面迁移仍未实施**(design contract 阶段 5 范围裁决:只做 R5 supersede,推进面收益仅 ~220ms 而深改风险高),
   *  故推进/auto-next/waiting/answerGrace/farewell **当前仍由 design contract 估算控制**,此回调只记日志。
   *  这不是「被开关关掉」,而是**该迁移尚未立项** —— 将来接入时替换本函数体即可,无需恢复任何 env。 */
  private onPlaybackSettled(s: Settlement): void {
    console.log(`[media ${this.cfg.sessionId}] (推进面迁移未实施)playback settled turn=${s.aiTurnId} outcome=${s.outcome}`);
  }

  /** 端点看门狗:按帧累计说话/静默时长(假设帧约 20ms;真实 audio_fork 帧长可变,用帧采样数算更准)。 */
  private trackEndpoint(pcm: Buffer): void {
    const frameMs = (pcm.length / 2 / FS_RATE) * 1000; // s16le mono 16k → ms
    const rms = pcmRms(pcm);
    // 动态噪声地板基线采样(诊断 021-metrics):此路径 = AI 没在播报/尾窗(onMessage 的 else 分支),入向不含
    //   AI 回声 → 是干净的环境底噪。喂进噪声基线窗,供 barge-in 动态 floor 估当前环境底噪(治高底噪误打断)。
    this.noteNoiseRms(rms);
    // RMS 诊断(AIM_RMS_DIAG=1):周期打印真实入向 RMS vs 阈值,标定「底噪是否顶住 VAD」。
    if (RMS_DIAG && ++this.rmsDiagCount % RMS_DIAG_EVERY === 0) {
      console.log(
        `[media ${this.cfg.sessionId}] rms inbound=${Math.round(rms)} thr=${ENDPOINT_RMS_THRESHOLD} ` +
          `${rms >= ENDPOINT_RMS_THRESHOLD ? "SPEECH" : "silence"} speechMs=${Math.round(this.speechMsSinceTurn)} ` +
          `turnPending=${this.turnPending} sinceSpeech=${Date.now() - this.lastSpeechAtMs}ms`,
      );
    }
    if (rms >= ENDPOINT_RMS_THRESHOLD) {
      this.speechMsSinceTurn += frameMs;
      this.lastSpeechAtMs = Date.now();
      // 挂断已排程(AI 说完告别、1.5s 延迟窗内)而用户又开口 → **一帧**超阈值即撤销:否则 1.3s 才开口、到
      // 1.5s 才累计 200ms<300ms,timer 仍执行=「刚开口又被挂」。挂断迫在眉睫,要最敏感(收敛后只剩这一处撤销:
      // 告别判定已在 onAiDone 原子消费,无「timer 未排程的中间态」需分档了)。
      if (this.hangupTimer) this.cancelPendingHangup();
      if (this.speechMsSinceTurn >= ENDPOINT_MIN_SPEECH_MS) {
        this.turnPending = true;
        // ★ design contract(开场抗底噪):**不再**在此能量门永久取消主动开场——连接初期的启动底噪/爆音脉冲(真机
        //   sess_example:0~3s RMS 峰值 614 > 阈值)会累计过 minSpeechMs 误判「真人先开口」,把主动开场永久
        //   settle,AI 再不主动开场、考生干等 ~34s。改为:**永久让位只认真 ASR 文本**(onTranscript 收非空 asr →
        //   cancelKickoff);纯能量脉冲无后续 ASR → kickoff 计时器照常到期开场(天然 rearm)。turnPending/端点
        //   看门狗逻辑不变(它用 turnPending 兜底 flush,与开场让位正交)。
        // design contract:考生有效开口 → 退出「等待作答」态(沉默计时归零),本窗沉默不再累计;下段沉默由下一次
        //   markAiDonePlaying(AI 说完)重新起窗。silenceCountedThisWait 一并复位,使下段新沉默能再触发一次。
        this.waitingSinceMs = 0;
        this.silenceCountedThisWait = false;
        // design contract(review):考生有效开口 → 退出 R3 兜底态(当本题续答,AI 下一轮再判 [[NEXT]])。
        //   亚阈开口(不足 300ms)由 checkR3SilenceAdvance 的 max(waitingSince,lastSpeechAtMs) 静默起点后移天然不误推;
        //   此处真开口显式复位阶段机,防 after_nudge 残留跨越到下轮。
        this.resetR3Phase();
      }
    }
  }
  private rmsDiagCount = 0;
  private bargeDiagCount = 0; // barge-in 诊断打印节流计数(AIM_RMS_DIAG)

  /** 声纹注册累计(design contract,**纯被动观测**,只在 AI 未在说的入向路径调用)。
   *  累计**连续单一说话段**的干净目标语音(RMS 在合理区间);段内长静默 → 判段结束、丢弃未满段(防跨静音
   *  拼假连续)。达 enrollMs → 拼接该段 PCM 送 GPU 取 embedding(异步,飞行期视同未就绪 fail-open),
   *  经多段一致性(≥2 段一致)才 ENROLLED。
   *  **段间边界(review)**:一段提交后置 enrollAwaitingBoundary,须先见 ≥ gap 的长静音(真段边界)才允许
   *  攒下一段——否则同一条连续长句会满 enrollMs → 提交 → 立刻接着攒又满 → 伪装成"两段独立一致",绕过防污染。
   *  **绝不**读/写游标/违规/开场状态机(review)。 */
  private updateEnrollment(pcm: Buffer): void {
    const sl = this.speakerLock;
    if (!sl || !sl.canAccumulateEnrollment) return; // 未启用 / 已注册 / 注册飞行中 → 不累计
    const frameMs = (pcm.length / 2 / FS_RATE) * 1000;
    const rms = pcmRms(pcm);
    // 能量区间:≥ 端点人声阈(在说话)且未削顶(< 32000 近满幅视为异常/削顶,不采)。
    const speaking = rms >= ENDPOINT_RMS_THRESHOLD && rms < 30000;
    if (speaking) {
      // 段间边界未过(上段刚提交、还没见长静音)→ 不攒(review:防同一长句伪装两段)。等静音累计过 gap 才解除。
      if (this.enrollAwaitingBoundary) return;
      this.enrollGapMs = 0;
      // 复制帧(不持入参 buffer 引用:入参 data 是共享/复用缓冲,守 media-session 别名不变式)。
      this.enrollSegChunks.push(Buffer.from(pcm));
      this.enrollAccumMs += frameMs;
      if (this.enrollAccumMs >= sl.config.enrollMs) {
        const seg = Buffer.concat(this.enrollSegChunks);
        this.enrollSegChunks = [];
        this.enrollAccumMs = 0;
        this.enrollGapMs = 0;
        this.enrollAwaitingBoundary = true; // 提交后须等真段边界(长静音)再攒下一段
        void sl.submitEnrollmentSegment(seg); // 异步:飞行期 enrollmentPending=true(下次进本方法早退)
      }
    } else {
      // 段内/段间静默:短停顿容忍(不清),长静默(> gap)= 真段边界 → 丢弃未满段(防跨静音拼假连续)+ 解除段间边界锁。
      this.enrollGapMs += frameMs;
      if (this.enrollGapMs >= sl.config.enrollGapMs) {
        this.enrollSegChunks = [];
        this.enrollAccumMs = 0;
        this.enrollGapMs = 0;
        this.enrollAwaitingBoundary = false; // 见到长静音 = 真段边界 → 允许攒下一段(review)
      }
    }
  }

  /** 声纹锁(design contract):累积打断候选窗高能量 PCM 到有界 ring(复制,不持入参引用);超 verifyWindowMs 丢最早帧。 */
  private captureBargeWindow(pcm: Buffer, frameMs: number): void {
    // 仅在 `if (this.speakerLock)` 守卫下被调用(见 detectBargeIn),故 speakerLock 必非空;直接读 config
    //   (评审 M-1:去掉 `?? 1000` 魔数,避免与 loadSpeakerLockConfig 默认值双写漂移)。
    const cap = this.speakerLock!.config.verifyWindowMs;
    this.bargeWindowChunks.push(Buffer.from(pcm));
    this.bargeWindowMs += frameMs;
    while (this.bargeWindowMs > cap && this.bargeWindowChunks.length > 1) {
      const dropped = this.bargeWindowChunks.shift()!;
      this.bargeWindowMs -= (dropped.length / 2 / FS_RATE) * 1000;
    }
  }

  /** 清打断候选窗(episode 结束:证据清零 / onBargeIn / resume)。 */
  private clearBargeWindow(): void {
    this.bargeWindowChunks = [];
    this.bargeWindowMs = 0;
  }

  /** 声纹门(design contract)验证 episode 结束统一收口(review):清打断候选窗 PCM(防旁人残音混入下一
   *  验证窗)+ 递增 episode 序号(使迟到验证回调 stale 作废)+ 清 pending。**pause-scoped 旁人标志不在此清**
   *  (它随 beginTentativePause 重置),故本函数专注「验证飞行/窗」的收口,与「本 pause 是否旁人」正交。
   *  调用点:①能量跌破 hangover(episode 自然结束)②onBargeIn(真接管终结)③resetTurn(轮切)。 */
  private endSpeakerEpisode(): void {
    this.speakerVerifyEpisode += 1;
    this.speakerVerifyPending = false;
    this.clearBargeWindow();
  }

  /** 声纹锁(design contract 二审):**tentative-pause 期**窗够 minVerifyMs 时发起**异步单飞**验证(每 pause 至多一次,
   *  pauseVerifyDone 守)。不阻塞打断判定;回调裁决 TARGET/NONTARGET/UNCERTAIN(见 onSpeakerVerdict)。 */
  private maybeVerifySpeaker(): void {
    const sl = this.speakerLock;
    if (!sl || this.speakerVerifyPending) return;
    if (this.bargeWindowChunks.length === 0) return; // 无候选窗音频(极端)→ 交现状 fail-open
    const seg = Buffer.concat(this.bargeWindowChunks);
    const windowMs = this.bargeWindowMs;
    const episode = this.speakerVerifyEpisode; // 快照:回调按此比对,防 stale 跨 episode 误裁
    const started = sl.verify(seg, windowMs, (v, emb) => this.onSpeakerVerdict(v, episode, emb));
    if (started) this.pauseVerifyDone = true; // 本 pause 已发起验证(即便回调未回,也不重发——防 UNCERTAIN 后逐帧重试)
    if (started) this.speakerVerifyPending = true;
  }

  /** 声纹验证裁决回调(异步)。stale(episode 已变/已收尾/已非 tentative)→ 丢弃。
   *  TARGET→确认接管销毁(+ EMA commit,review:此刻才确认非 stale + 真接管);NONTARGET→标记本 episode 旁人 +
   *  撤销 tentative-pause 续播(抑制打断);UNCERTAIN→不动(交能量证据 takeover/resume = fail-open,不误聋)。 */
  private onSpeakerVerdict(verdict: Verdict, episode: number, emb: number[] | null): void {
    if (this.closed) return;
    if (episode !== this.speakerVerifyEpisode) return; // stale:该 episode 已结束(游标推进/轮切/resume),丢弃
    if (!this.tentativePausing) return; // 已非暂停态(能量证据已自行 takeover/resume)→ 不重复操作
    if (verdict === "TARGET") {
      console.log(`[media ${this.cfg.sessionId}] 声纹验证 TARGET → 确认目标人打断,接管销毁本轮`);
      // EMA(review):stale 校验已过 + 即将真接管 → 此刻才把 TARGET 帧并入 refEmb(跟随目标人当场声学漂移)。
      if (emb) this.speakerLock?.commitEma(emb);
      this.confirmTakeover();
    } else if (verdict === "NONTARGET") {
      // 结构化日志(供真机量化核心收益「旁人误打断被拦」;不塞进 per-turn TurnMetrics schema——那是逐轮实时性字段)。
      this.suppressedBystanderCount += 1;
      console.log(
        `[media ${this.cfg.sessionId}] 声纹验证 NONTARGET → 判旁人,抑制打断(resume 续播);suppressed_bystander_bargein=${this.suppressedBystanderCount}`,
      );
      // 标记**本 tentative-pause** 为旁人(二审重构):本 pause 内后续高能量帧不再触发 takeover(见 detectBargeIn
      //   tentativePausing 分支的 pauseBystanderConfirmed 早退),旁人靠能量证据也接管不了;等恢复窗满自然 resume。
      //   **scoped 到本 pause**(下次 beginTentativePause 重置)→ 目标人的新 pause 绝不被此标志误压(修二审 D1 泄漏)。
      this.pauseBystanderConfirmed = true;
      // 立即 resume 续播(旁人不该让 AI 一直暂停):resumeFromTentativePause 清 timer/证据/窗 + 记 false_interruption +
      //   engine.resume + 下行 resume 帧 + 递增 episode(使迟到回调作废)。resume 后 tentativePausing=false,pause 结束
      //   → pauseBystanderConfirmed 自然失效(下个 pause 重置);旁人续说会进新 pause 重新验证(单飞,每 pause 一次)。
      this.resumeFromTentativePause();
      return;
    }
    // UNCERTAIN:不动(fail-open)——tentative-pause 的能量证据 takeover/resume 逻辑照常裁决。
    //   仅清 pending(但 pauseVerifyDone 保持 true,本 pause 不重验);tentative-pause 内后续高能量帧走泄漏累计到
    //   takeover(能量证据),或恢复窗满 resume。UNCERTAIN 不抑制,目标人靠能量证据仍能接管(不误聋)。
    this.speakerVerifyPending = false;
  }

  /** 看门狗 tick:本轮有过有效语音、随后静默超过 gap、且 AI 没在播报 → 主动 flush 触发 AI 回复。
   *  这是 turn_end 的兜底来源(GPU VAD 因底噪不出 turn_end 时)。自然 turn_end 先到会 resetTurn,
   *  使 turnPending=false,看门狗不会重复触发。 */
  private watchdogTick(): void {
    if (this.closed) return;
    // ★ aiSpeaking 安全看门狗(design contract:MiniMax 慢/超时致 onAiDone 不来 → aiSpeaking 卡 true → 永久哑)。
    //   aiSpeaking=true 但已超过 MAX_IDLE 没有任何 AI 音频流出 → 本轮 TTS 早停、只是没收到 onAiDone →
    //   强制关回声抑制窗恢复收听(不漏轮、不永久哑)。这是兜底,正常 onAiDone 路径不受影响。
    //   ★ design contract:tentative-pause(误打断恢复,design contract)期间引擎缓存音频不下发 → lastAiAudioAtMs
    //     **冻结**在暂停前时刻。看门狗 MUST 跳过——暂停是**受控**状态(由 recoveryTimer 窗满 resume /
    //     confirmTakeover 销毁收敛),不是"莫名早停"。若不跳过,暂停+恢复窗逼近 MAX_IDLE 时会误触发
    //     markAiDonePlaying(aiSpeaking=false),而 engine 仍 paused → onMessage 入向路由切到正常收听分支、
    //     detectBargeIn 不再被调用,暂停轮**彻底失去 barge-in 检测**(真接管也测不到)。绑定 media-session
    //     层权威状态 tentativePausing(不跨层查 engine.paused,避免状态不同步耦合);tentativePausing 变 false
    //     后(resume 续发刷新 lastAiAudioAtMs / confirmTakeover 走 markAiDonePlaying)看门狗职责立即恢复。
    if (this.aiSpeaking && !this.tentativePausing && this.lastAiAudioAtMs > 0
        && Date.now() - this.lastAiAudioAtMs > AI_SPEAKING_MAX_IDLE_MS) {
      console.warn(`[media ${this.cfg.sessionId}] aiSpeaking 卡 true 超 ${AI_SPEAKING_MAX_IDLE_MS}ms 无音频 → 强制恢复收听(MiniMax 慢/丢 tts_done 兜底)`);
      this.markAiDonePlaying();
    }
    // ★ design contract(review 跨层清理)——分流前先检测 engine 游标是否已被**非 R3 路径**
    //   推进(design contract 宽限窗到期 / retry 上限 / 拒答强推)。若变了且当前正处等待态:该 waitingSinceMs 是**旧题**的,
    //   新题尚未由新轮 AI 出声刷新 → 立即清零(避免归 design contract 时用陈旧锚点误判沉默违规)。新轮 AI 出声后
    //   enterWaitingForAnswer 会重新起窗。cursor 未变则不动(正常等待计时不受影响)。
    const curCursor = this.deps.engine.questionCursor?.() ?? -1;
    if (curCursor !== this.lastSeenCursor) {
      if (this.lastSeenCursor >= 0 && this.waitingSinceMs > 0) {
        this.waitingSinceMs = 0; // 游标已推进到新题但新轮未起窗 → 清旧题静默锚点(防 design contract 陈旧误判)
        this.silenceCountedThisWait = false;
        this.resetR3Phase();
      }
      this.lastSeenCursor = curCursor;
    }
    // ── design contract(D4:沉默豁免):自由聊天(无题)**不计沉默违规、不 R3 兜底**——聊天本就可能长静默,不该被强制收尾
    //   (违背「AI 永不主动挂」)。在**计数/nudge 之前**门控(review),而非最终 end 拦。
    //   ★ 严重违规仍保留(违规是内容安全、另一条 handleSevereViolation 路径,不在此豁免)。有题路径逻辑完全不变。
    if (!this.deps.engine.hasQuestions()) {
      this.resetR3Phase(); // 无题:退出 R3 态,且不进沉默计数(自由聊天沉默豁免)
    } else {
    // ── design contract × design contract:静默态**互斥分流**(同一 tick 只走一条)──
    //   当前题「已作答」(engine.answerSeenForCursor()=true)→ R3 善意兜底(nudge 问补充、再推进),design contract 不计;
    //   「从未作答」(false)→ design contract 防作弊沉默计数,R3 不启。这消除了二者共用 waitingSinceMs 的并发竞态
    //   (review:不靠「14s<20s 时序先后」而靠状态二分)。
    const answerSeen = R3_SILENCE_ADVANCE && (this.deps.engine.answerSeenForCursor?.() ?? false);
    if (answerSeen) {
      this.checkR3SilenceAdvance(); // 已作答:R3 善意兜底轨(design contract 沉默计数在此状态暂停)
    } else {
      this.resetR3Phase();          // 未作答:退出 R3 态,归 design contract
      this.checkSilenceViolation(); // design contract 防作弊(独立于下方 turn_end 兜底 flush)
    }
    }
    if (this.aiSpeaking || !this.turnPending) return;
    const now = Date.now();
    if (now - this.lastSpeechAtMs < ENDPOINT_SILENCE_GAP_MS) return; // 还在说/静默不够久
    // 距上次 flush 不足一个 gap → 不重复发(等自然 turn_end;它先到会 resetTurn 停掉重试)。
    if (this.lastFlushAtMs && now - this.lastFlushAtMs < ENDPOINT_SILENCE_GAP_MS) return;
    // ★ 不在此乐观清 turnPending(否则 endTurn/GPU flush 没真出 turn_end 时这一轮永远丢失,无重试)。
    //   只发 flush + 记 flush 时刻;真正的清账交给自然 turn_end(onTurnEvent→resetTurn)。flush 后仍迟迟
    //   收不到 turn_end → 下个 gap 周期再 flush(有界重试,gap 节流),不会把用户这轮话吞掉、也不会刷屏。
    this.lastFlushAtMs = now;
    if (RMS_DIAG) {
      console.log(`[media ${this.cfg.sessionId}] rms watchdog → endTurn(flush)触发 turn_end 兜底`);
    }
    this.deps.engine.endTurn?.(); // → GPU flush → asr_final + turn_end → LLM → TTS
  }

  /** design contract:沉默防作弊检测(watchdog 每 tick 调)。等待作答期考生连续无有效语音超阈值 → 计一次消极对抗事件。
   *  真沉默(有帧低能量)才计;断流(无帧超 NO_FRAME_MS)不计(物理断连,走 peer_hangup)。同一等待窗只计一次
   *  (silenceCountedThisWait 门,防 250ms tick 把一次长沉默计多次)。计数后走 handleNegativeViolation(警告升级)。 */
  private checkSilenceViolation(): void {
    // design contract(review 门控):自由聊天(无题)沉默豁免——即使调用点漏了外层门控,方法本身也早退,
    //   不计沉默违规(聊天可长静默,不该被强制收尾;违背「AI 永不主动挂」)。严重违规走独立路径不受此影响。
    if (!this.deps.engine.hasQuestions()) return;
    if (this.aiSpeaking || this.tentativePausing) return; // AI 在说 / 暂停中,不算考生沉默
    if (this.waitingSinceMs <= 0) return; // 非等待作答态(尚未轮到考生)
    if (this.silenceCountedThisWait) return; // 本等待窗已计过 → 不重复(核心防重复 tick)
    const now = Date.now();
    // 沉默基线 = max(进等待时刻, 考生最近说话时刻)。考生**任何**超阈能量帧都刷新 lastSpeechAtMs(见 trackEndpoint,
    //   先于 300ms 有效语音门),故考生一出声沉默钟即复位——治「亚阈开口(不足 300ms、未清 waitingSinceMs)时被计沉默
    //   /nudge 抢话」(review)。lastSpeechAtMs=0(从未说话)或早于 waitingSinceMs(上轮说的)→ 取 waitingSinceMs。
    const silenceSince = Math.max(this.waitingSinceMs, this.lastSpeechAtMs);
    if (now - silenceSince < SILENCE_VIOLATION_MS) return; // 沉默未达阈值
    // 断流判定:入向长时间无帧 = 物理断连(非真沉默)→ 不计(WS close 会走 peer_hangup;此处防「帧断了但 close
    //   事件还没到」的延迟窗误计)。lastInboundFrameAtMs=0(从未收帧)亦视作无帧不计。
    if (this.lastInboundFrameAtMs <= 0 || now - this.lastInboundFrameAtMs > NO_FRAME_MS) return;
    this.silenceCountedThisWait = true; // 本窗已计(考生开口/新题会复位)
    this.handleNegativeViolation("silence");
  }

  /** design contract:静默超时先问再推兜底状态机(watchdog tick 在「当前题已作答」时调,与 design contract 互斥)。
   *  解 review 死锁:AI 收尾漏发 [[NEXT]] 且考生不再开口 → retry 停 1 永不达上限 → 卡 max_duration。
   *  两级 + nudge 阶段机(review 在途/失败不误推、开口即取消、每题至多 nudge 一次)。 */
  private checkR3SilenceAdvance(): void {
    if (this.aiSpeaking || this.tentativePausing) return; // AI 在说 / 暂停:nudge_playing 由 aiSpeaking 自然覆盖
    if (this.waitingSinceMs <= 0) return;                 // 非等待作答态
    const now = Date.now();
    // 静默起点 = max(进等待时刻, 考生最近说话时刻):考生任何超阈帧刷新 lastSpeechAtMs → 一出声即复位(同 design contract)。
    const silenceSince = Math.max(this.waitingSinceMs, this.lastSpeechAtMs);
    if (this.lastInboundFrameAtMs <= 0 || now - this.lastInboundFrameAtMs > NO_FRAME_MS) return; // 断流不兜底(走 peer_hangup)

    switch (this.r3Phase) {
      case "idle":
      case "waiting": {
        // 静默达 ADVANCE_NUDGE_MS → 尝试 nudge 问补充。
        if (now - silenceSince < ADVANCE_NUDGE_MS) { this.r3Phase = "waiting"; return; }
        this.r3NudgeCursorEpoch = this.deps.engine.questionCursor?.() ?? -1;
        const accepted = this.deps.engine.nudge?.("关于这个问题还有要补充的吗?没有的话我们就继续。") === true;
        if (accepted) {
          // 接受 → 进 nudge_playing(aiSpeaking 将转 true,该阶段不计静默);第二窗从 nudge 播完(onAiDone)才起。
          this.r3Phase = "nudge_playing";
          this.r3PhaseSinceMs = now;
        } else {
          // 被拒(engine busy)→ nudge_pending 有界重试(下个 tick 或 onAiDone 空闲重试)。
          this.r3Phase = "nudge_pending";
          this.r3PendingSinceMs = now;
        }
        return;
      }
      case "nudge_pending": {
        // busy 反复拒绝:pending 超总阈值兜底直接推进(review + review:防 engine 长期 busy 时间空转卡死)。
        if (now - this.r3PendingSinceMs >= ADVANCE_NUDGE_MS + ADVANCE_AFTER_NUDGE_MS) {
          this.fireR3Advance();
          return;
        }
        const accepted = this.deps.engine.nudge?.("关于这个问题还有要补充的吗?没有的话我们就继续。") === true;
        if (accepted) { this.r3Phase = "nudge_playing"; this.r3PhaseSinceMs = now; }
        return;
      }
      case "nudge_playing":
        // nudge 播报中:由 markAiDonePlaying(nudge 轮播完)驱动 → after_nudge(不在 tick 里转)。此处不计静默。
        return;
      case "after_nudge": {
        // nudge 已播完、第二窗:静默达 ADVANCE_AFTER_NUDGE_MS(从考生最近说话/nudge 播完起)→ 服务端推进。
        const sinceAfter = Math.max(this.r3PhaseSinceMs, this.lastSpeechAtMs);
        if (now - sinceAfter < ADVANCE_AFTER_NUDGE_MS) return;
        this.fireR3Advance();
        return;
      }
    }
  }

  /** design contract:兜底到期 → 请 engine 服务端推进游标 + autoNext(经 cursor epoch 防 TOCTOU + questionVoiced 门)。
   *  推进后 engine 起自动问下一题轮(aiSpeaking 转 true)→ waitingSinceMs 由新轮 markAiDonePlaying 刷新;此处复位 R3 态。 */
  private fireR3Advance(): void {
    const advanced = this.deps.engine.advanceOnSilenceTimeout?.(this.r3NudgeCursorEpoch) ?? false;
    console.log(`[media ${this.cfg.sessionId}] R3 静默兜底到期 → 请 engine 推进(epoch=${this.r3NudgeCursorEpoch} advanced=${advanced})`);
    this.resetR3Phase();
    if (advanced) {
      // 推进已发起新轮:清等待态,避免用旧 waitingSinceMs 立即又触发(新轮 AI 出声后 markAiDonePlaying 重置)。
      this.waitingSinceMs = 0;
      this.silenceCountedThisWait = false;
    }
  }

  /** 复位 R3 阶段机(退出 R3 态:考生开口 / 分流到 design contract / 推进后)。 */
  private resetR3Phase(): void {
    if (this.r3Phase !== "idle") this.r3Phase = "idle";
    this.r3NudgeCursorEpoch = -1;
  }

  /** design contract(+R4 复用):消极对抗事件计数 + 警告升级。前 SILENCE_WARN_MAX 次 → AI 警告(nudge 让其说一句);
   *  第 SILENCE_WARN_MAX+1 次 → fail 挂断(end("silence_violation"),走 R0 违规结束路径)。
   *  **仅 VIOLATION_ENFORCEMENT 开时产生动作**;关时只 log 计数(shadow 观察误判率)。source: silence(沉默)/idle(R4 扯闲篇)。 */
  private handleNegativeViolation(source: "silence" | "idle"): void {
    this.negativeCount++;
    const n = this.negativeCount;
    if (!VIOLATION_ENFORCEMENT) {
      console.log(`[violation ${this.cfg.sessionId}] shadow 消极对抗计数(${source})=${n}/${SILENCE_WARN_MAX}(enforcement 关,不警告/不挂断)`);
      return;
    }
    if (n <= SILENCE_WARN_MAX) {
      // 前 N 次:AI 明确警告(经主对话 LLM 说出;nudge 不写 history/不推进游标)。不阻塞。
      const warn = source === "silence"
        ? "对方已经很久没有回应了。请用一句话提醒对方:请及时作答,若持续没有回应本次测评将会结束。"
        : "对方连续在说与题目无关的话。请用一句话提醒对方:请回到当前问题作答,否则本次测评将会结束。";
      console.warn(`[violation ${this.cfg.sessionId}] 消极对抗(${source})第 ${n} 次 → AI 警告(≤${SILENCE_WARN_MAX} 次警告阶梯)`);
      this.nudgeViolationNotice(warn); // design contract:警告句也受不可打断保护(播完再继续对话)
    } else {
      // 第 N+1 次:违规强制结束(记 failed + silence_violation reason)。★ R3:先说明原因再挂(forcedEndAfterNotice),
      //   不直接 end(否则切断正在合成/播报的原因句,重蹈 design contract 尾音被切)。
      console.warn(`[violation ${this.cfg.sessionId}] 消极对抗(${source})第 ${n} 次 > ${SILENCE_WARN_MAX} → 违规强制结束(silence_violation,先说明原因)`);
      const notice = source === "silence"
        ? "对方长时间没有回应。请用一句话向对方说明:由于长时间没有作答,本次测评到此结束。"
        : "对方持续在说与题目无关的话、未作答。请用一句话向对方说明:由于持续未作答,本次测评到此结束。";
      this.armForcedEndAfterNotice("silence_violation", notice);
    }
  }

  /** design contract:注入**违规发言**(警告句 / 挂断原因句)并在被引擎接受时置「不可打断」保护。返回 nudge 是否被接受。
   *  违规发言是必须让对方听清的关键信息 → 起播后 detectBargeIn / 客户端 barge_in 抑制,直到该轮 onAiDone 解保护
   *  (clearViolationNoticeGuard)。nudge 被 busy 拒(返回 false)→ 不置保护(没有真正起播的受保护轮),等空闲重试再置。 */
  private nudgeViolationNotice(notice: string): boolean {
    const accepted = this.deps.engine.nudge?.(notice) === true;
    if (accepted) this.violationNoticeGuard = true; // 起播成功 → 进入不可打断保护(onAiDone 时清)
    return accepted;
  }

  /** design contract:解除违规发言保护(该受保护轮 onAiDone 时调,无论 completed 与否——轮结束即解保护)。幂等。 */
  private clearViolationNoticeGuard(): void {
    this.violationNoticeGuard = false;
  }

  /** design contract:违规强制结束——**先让 AI 说明原因(nudge),等该原因句轮 onAiDone(播完)才以违规 reason 调 end()**。
   *  幂等(已在 forcedEndAfterNotice 态则忽略,防多个违规源重复触发)。硬超时 FORCED_END_MAX_WAIT_MS 兜底:原因句
   *  卡住 / 始终 busy → 到点强制 end,防永不结束。★ 违规强制结束**不走两步确认**(铁律白名单例外,见 forcedEndReason
   *  字段注释);正常告别路径(onAiDone shouldHangup)完全不受影响。
   *  ★ review 可能因引擎 busy 被拒(原因句没送达)。若被拒 → **不**就地绑 onAiDone(否则无关活跃轮
   *    的 onAiDone 会被误当「通知已播完」→ 没送达就挂),而是暂存原因句、等 onAiDone(引擎转空闲)重试 nudge。 */
  private armForcedEndAfterNotice(reason: CancelReason, notice: string): void {
    if (this.forcedEndReason || this.closed) return; // 幂等:已在强制结束态 / 已收尾 → 不重复
    this.forcedEndReason = reason;
    this.forcedEndNotice = notice;
    // 尝试注入原因句;busy 被拒 → forcedEndNoticePlaying 保持 false(onAiDone 空闲时重试,见 onAiDone 分支)。
    //   design contract:经 nudgeViolationNotice 注入 → 接受即置「不可打断」保护(原因句必须完整播完再挂)。
    this.forcedEndNoticePlaying = this.nudgeViolationNotice(notice);
    console.warn(`[violation ${this.cfg.sessionId}] 违规强制结束:注入原因句${this.forcedEndNoticePlaying ? "(已起 notice 轮 → 等其 onAiDone)" : "(引擎 busy 被拒 → 等空闲重试)"};硬超时 ${FORCED_END_MAX_WAIT_MS}ms 兜底 → end("${reason}")`);
    this.forcedEndTimer = setTimeout(() => {
      this.forcedEndTimer = null;
      if (!this.closed && this.forcedEndReason) {
        console.warn(`[violation ${this.cfg.sessionId}] 违规强制结束硬超时 ${FORCED_END_MAX_WAIT_MS}ms(原因句未播完/始终 busy)→ 强制 end("${this.forcedEndReason}")`);
        void this.end(this.forcedEndReason);
      }
    }, FORCED_END_MAX_WAIT_MS);
    this.forcedEndTimer.unref?.();
  }

  // ── 会话建立后主动开场(design contract,P1,可关)──
  /** 会话建立(首帧到达):启主动开场静默计时。只启一次(meetingRoomEntered 守)。
   *  开关关 / 引擎不实现 kickoff / 已了结(开场过或真人先开口)→ 不启,回退被动等真人先开口(design contract 现状)。
   *  真人已在说(turnPending)→ 不 arm(让位)。(电话版的入会门控/尾段回放已随 IVR 删除。) */
  private enterMeetingRoom(): void {
    if (this.meetingRoomEntered) return;
    this.meetingRoomEntered = true;
    console.log(
      `[media ${this.cfg.sessionId}] 会话建立(首帧到达)proactiveOpening=${PROACTIVE_OPENING}`,
    );
    this.armKickoff();
  }

  /** 武装主动开场静默计时:到点(无人开口)经 engine.kickoff() 驱动 AI 主动开场。
   *  关 / 引擎不实现 kickoff / 已了结 / 真人已在说 / 已 closed / 超重试上限 → 不 arm。 */
  private armKickoff(ignoreTurnPending = false): void {
    if (
      !PROACTIVE_OPENING ||
      typeof this.deps.engine.kickoff !== "function" ||
      this.proactiveOpeningSettled ||
      // ★ design contract(review):正常 arm 让位真人(turnPending)不 arm;但**疑似底噪 rearm**(ignoreTurnPending=true)
      //   MUST 无视 turnPending 重设计时——否则持续底噪令 turnPending 恒 true,armKickoff 被此守卫挡住、rearm 形同虚设、
      //   永不开场(fireKickoff 的强制开场分支也永远等不到再次触发)。真人真开口仍由 onTranscript 真 ASR 让位(settled)。
      (this.turnPending && !ignoreTurnPending) ||
      this.closed ||
      this.kickoffAttempts >= MediaSession.KICKOFF_MAX_ATTEMPTS
    ) {
      return;
    }
    if (this.kickoffTimer) clearTimeout(this.kickoffTimer);
    this.kickoffTimer = setTimeout(() => this.fireKickoff(), PROACTIVE_OPENING_SILENCE_MS);
    this.kickoffTimer.unref?.();
  }

  /** 静默到点 → 主动开场一次:经 engine.kickoff() 让 AI 据人设自然开场(唤醒输入不写 history)。
   *  到点临界仍可能真人刚开口(turnPending),此时让位、不 kickoff(重 arm 让位逻辑由 trackEndpoint 的取消兜底)。 */
  private fireKickoff(): void {
    this.kickoffTimer = null;
    if (this.closed || this.proactiveOpeningSettled || this.aiSpeaking) return;
    // ★ design contract(疑似能量误判可 rearm):turnPending=true 可能是连接初期底噪脉冲触发的(能量门置 turnPending 但
    //   **无真 ASR**——真人没真开口,proactiveOpeningSettled 仍 false)。此时不能永久放弃开场:重新 arm,待端点看门狗
    //   flush→turn_end→resetTurn 清掉 turnPending 后再试。真人真开口会经 onTranscript 的非空 ASR → cancelKickoff
    //   永久 settle(上面 proactiveOpeningSettled 守卫拦住),故这里 rearm 不会与真人让位冲突。
    if (this.turnPending) {
      // ★ design contract(review 永不触发)——连续因 turnPending 暂缓达上限 → **强制开场**(不再 rearm)。
      //   持续高能量底噪会让 turnPending 反复置 true、真人 turn_end 不可靠,不能无限等(否则底噪环境永不开场)。
      //   真人真开口已由 onTranscript 真 ASR → cancelKickoff 永久 settle(上面守卫拦住),故强制开场不会抢真人话。
      if (this.kickoffRearmOnPending >= MediaSession.KICKOFF_MAX_REARM_ON_PENDING) {
        console.warn(`[media ${this.cfg.sessionId}] 主动开场连续 ${this.kickoffRearmOnPending} 次因 turnPending 暂缓(疑似持续底噪)→ 强制开场(不再等 turn_end;真人真开口已由 ASR 让位)`);
        // 落下去走正常 kickoff(不 return)。
      } else {
        this.kickoffRearmOnPending += 1;
        console.log(`[media ${this.cfg.sessionId}] 主动开场到点但 turnPending(疑似底噪脉冲/端点未清,第 ${this.kickoffRearmOnPending} 次)→ 暂缓 + 重 arm(等 turnPending 清;真人真开口已由 ASR 让位)`);
        this.armKickoff(true); // ignoreTurnPending:疑似底噪 rearm 无视 turnPending 重设计时(否则被守卫挡住永不开场)
        return;
      }
    }
    this.kickoffRearmOnPending = 0; // 真正开场 → 复位暂缓计数
    if (typeof this.deps.engine.kickoff !== "function") return;
    this.kickoffAttempts += 1;
    this.kickoffPending = true;
    this.kickoffGotAudio = false;
    console.log(
      `[media ${this.cfg.sessionId}] 主动开场触发(静默 ${PROACTIVE_OPENING_SILENCE_MS}ms 无人开口,第 ${this.kickoffAttempts} 次)→ engine.kickoff()`,
    );
    this.deps.engine.kickoff();
  }

  /** kickoff 轮结束(onAiDone)了结:出过开场音频 = 成功开场(本通不再主动开场);未出过(被打断/故障)= 有界重试。 */
  private settleKickoff(): void {
    this.kickoffPending = false;
    if (this.kickoffGotAudio) {
      this.opened = true;
      this.proactiveOpeningSettled = true; // 成功开场:本通不再主动开场(每通至多成功一次)
      console.log(`[media ${this.cfg.sessionId}] 主动开场成功(已出开场音频)→ 本通不再主动开场`);
    } else {
      // 未出声(被 barge-in 打断 / GPU TTS 故障)→ 不算开场,有界重试(再 arm 一个静默窗)。
      console.warn(
        `[media ${this.cfg.sessionId}] 主动开场未出声(被打断/故障,第 ${this.kickoffAttempts}/${MediaSession.KICKOFF_MAX_ATTEMPTS} 次)→ 不标记已开场,有界重试`,
      );
      this.kickoffGotAudio = false;
      this.armKickoff();
    }
  }

  /** 真人在主动开场计时期间先开口(达 minSpeechMs)→ 立即取消主动开场,本通不再主动开场(让位真人,design contract)。 */
  private cancelKickoff(): void {
    if (this.proactiveOpeningSettled && !this.kickoffTimer && !this.kickoffPending) return;
    if (this.kickoffTimer) {
      clearTimeout(this.kickoffTimer);
      this.kickoffTimer = null;
    }
    if (!this.proactiveOpeningSettled) {
      this.proactiveOpeningSettled = true;
      console.log(`[media ${this.cfg.sessionId}] 真人先开口 → 取消主动开场(让位),走正常对话`);
    }
  }

  /** 一轮结束(自然 turn_end 或看门狗触发):清本轮端点累计,开始下一轮干净计数。 */
  private resetUncommittedInputEndpoint(): void {
    this.speechMsSinceTurn = 0;
    this.lastSpeechAtMs = 0;
    this.turnPending = false;
    this.lastFlushAtMs = 0;
  }

  private resetTurn(): void {
    this.speechMsSinceTurn = 0;
    this.turnPending = false;
    this.lastFlushAtMs = 0;
    // DTD 参考窗跨轮清空(评审/review 共识):否则上轮 AI 高峰值会在新轮开场 ~窗口内拉高门槛 →
    // 真人抢话被误压制。新轮 AI 回发会重新填充;时间淘汰本也会清,显式清更洁、避免快速连续轮(轮间 <窗口)污染。
    this.refRmsWindow = [];
    // barge 确认累计跨轮清空:上轮检测窗尾部的高能量累计不带进新轮(hangover 使累计比旧「单帧掉线即
    // 清零」更持久,跨轮残留会让新轮 AI 一开口就带着半满的确认窗,凑几帧即误触发)。
    this.bargeMs = 0;
    this.bargeDipMs = 0;
    this.bargeEvidenceStartedAtMs = 0;
    this.tentativePauseStartMs = 0;
    // 误打断恢复(design contract):轮边界清 tentative 状态 + 恢复窗计时(下一轮干净开始)。正常路径
    // resume/confirmTakeover 已清;此处兜底(如恢复窗跨到新 turn_end 的极端)。false_interruption 标记
    // 已随本轮 pendingEndpoint 走(非 session 级旗),turn 边界自然隔离,无需在此清。
    this.clearRecoveryTimer();
    this.tentativePausing = false;
    // 声纹门(design contract review):轮边界 = 声纹 episode 结束 → 统一收口(递增 episode 使迟到验证回调 stale
    //   作废 + 清 pending + 清旁人标记 + 清候选窗)。否则 late/重复 turn_end 清了 tentativePausing 但未递增 episode/
    //   清 pending → speakerVerifyPending 持续 true,下一 episode 的 maybeVerifySpeaker 被单飞门永久挡住不再验证。
    if (this.speakerLock) this.endSpeakerEpisode();
    // design contract:新轮开始 → 清 L3 降门槛窗(旧轮的「判 incomplete」不带进新轮,防跨轮残留误降门槛)。
    this.eouIncompleteUntilMs = 0;
    this.eouIncompleteCursor = -1;
    // barge 能量四元组跨轮清空(review 必修):正常路径 detectBargeIn 写 → engine.cancel(barge_in) →
    // reportMetrics 同步 onMetrics 当场消费(ttsPending>0)。若 barge 后 cancel 不再 reportMetrics,
    // 四元组不被同步消费、残留。turn 边界必清:两次 barge 之间必有 turn_end→resetTurn,故陈旧四元组
    // 绝不会跨轮误附给下一 barge 轮(turn 边界清是与 pendingEndpoint 单槽对称、最小且足够的修法)。
    this.pendingBargeMetrics = null;
    // design contract(M1):新逻辑轮开始 → 清「本轮已裁判」标志,使下一轮的 user final 可再裁判一次。
    this.moderatedThisTurn = false;
  }

  // DTD 参考窗时长:覆盖回声相对回发的时延(~100-300ms),取峰值估当前回声水平。
  // env AIM_BARGE_DTD_WINDOW_MS 可调(真机若遇高时延回路误判可调大);默认 400。
  private static readonly REF_WINDOW_MS = RC.media.bargeDtdWindowMs;
  // 兜底硬限长(防御:系统时钟回拨等极端下时间淘汰失效致无界):窗口最多帧数(覆盖 2s,远超默认 400ms 需要)。
  private static readonly REF_WINDOW_MAX_FRAMES = 100;

  /** 记一帧 AI 回发参考 RMS(供 DTD 估回声水平);淘汰超 REF_WINDOW_MS 的老帧 + 兜底硬限长。 */
  private noteRefRms(rms: number): void {
    const now = Date.now();
    this.refRmsWindow.push({ rms, atMs: now });
    const cutoff = now - MediaSession.REF_WINDOW_MS;
    while (this.refRmsWindow.length && this.refRmsWindow[0].atMs < cutoff) this.refRmsWindow.shift();
    // 兜底(防时钟回拨致时间淘汰失效→无界):硬限长丢最老(评审 防御式)。
    while (this.refRmsWindow.length > MediaSession.REF_WINDOW_MAX_FRAMES) this.refRmsWindow.shift();
  }

  /** 近端 AI 参考的峰值 RMS(REF_WINDOW_MS 内);无则 0(AI 当前没在回发 → 回声水平≈0)。 */
  private recentRefPeak(): number {
    const cutoff = Date.now() - MediaSession.REF_WINDOW_MS;
    let peak = 0;
    for (const e of this.refRmsWindow) if (e.atMs >= cutoff && e.rms > peak) peak = e.rms;
    return peak;
  }

  // 噪声基线窗兜底硬限长(防时钟回拨致时间淘汰失效→无界):覆盖默认 3s 窗 @20ms ≈ 150 帧,留余量。
  private static readonly NOISE_WINDOW_MAX_FRAMES = 400;

  /** 记一帧**AI 静默期**入向 RMS 作噪声基线样本(动态 floor 用)。只在 trackEndpoint(非 barge 检测)路径调,
   *  即 AI 没在播报/尾窗 → 入向不含 AI 回声 → 是干净的环境底噪。淘汰超窗老帧 + 兜底硬限长。 */
  private noteNoiseRms(rms: number): void {
    if (!BARGE_DYN_FLOOR_ENABLED) return;
    const now = Date.now();
    this.noiseRmsWindow.push({ rms, atMs: now });
    const cutoff = now - BARGE_DYN_FLOOR_WINDOW_MS;
    while (this.noiseRmsWindow.length && this.noiseRmsWindow[0].atMs < cutoff) this.noiseRmsWindow.shift();
    while (this.noiseRmsWindow.length > MediaSession.NOISE_WINDOW_MAX_FRAMES) this.noiseRmsWindow.shift();
    this.noiseBaselineDirty = true;
  }

  /** 入向噪声基线 = 近窗内 AI 静默帧入向 RMS 的 p20 分位(p20 天然在语音/回声高能量之下,抗污染)。
   *  样本不足(< 10 帧,如开场)→ 0(退回固定 dtdFloor,不贸然抬门槛)。结果缓存,仅 dirty 时重算(避免每帧排序)。 */
  private noiseBaseline(): number {
    if (!BARGE_DYN_FLOOR_ENABLED) return 0;
    if (!this.noiseBaselineDirty) return this.noiseBaselineCache;
    this.noiseBaselineDirty = false;
    const n = this.noiseRmsWindow.length;
    if (n < 10) return (this.noiseBaselineCache = 0);
    const sorted = this.noiseRmsWindow.map((e) => e.rms).sort((a, b) => a - b);
    // 取 sorted[floor(n×0.2)] 作底噪估计。语义说明(review):这是**略偏高于严格 p20** 的分位
    //   (n=10→sorted[2] 偏 p30,n≈150 稳态时→sorted[30] 即 p20),偏高方向**保守**(门槛略高、压误打断),
    //   与离线录音模拟标定(88→52 那组,同此公式)一致——**故意不改 floor((n-1)×0.2)**:改了会偏离已验证标定,
    //   且差异仅在冷启动 n≈10 的低置信阶段(此时本就靠 k=1.5 余量),稳态 n≈150 两者同值。
    return (this.noiseBaselineCache = sorted[Math.floor(n * 0.2)]);
  }

  /** barge-in 动态门槛(诊断 021-metrics + DTD,design contract):
   *   effectiveFloor = dynFloor 开 ? max(dtdFloor, baseline×k) : dtdFloor    —— 高底噪环境抬高地板(治误打断)
   *   threshold      = DTD 开 ? max(effectiveFloor, echoGain×AI参考峰值) : 固定 rmsThreshold  —— 再叠 DTD 回声项
   *  返回门槛 + 中间量(refPeak/baseline)供诊断日志与 metrics 落库。 */
  private bargeThreshold(): { threshold: number; refPeak: number; baseline: number } {
    const refPeak = BARGE_DTD_ENABLED ? this.recentRefPeak() : 0;
    const baseline = this.noiseBaseline();
    const effectiveFloor = BARGE_DYN_FLOOR_ENABLED
      ? Math.max(BARGE_DTD_FLOOR, baseline * BARGE_DYN_FLOOR_K)
      : BARGE_DTD_FLOOR;
    const threshold = BARGE_DTD_ENABLED
      ? Math.max(effectiveFloor, BARGE_DTD_ECHO_GAIN * refPeak)
      : BARGE_RMS_THRESHOLD;
    return { threshold, refPeak, baseline };
  }

  /** AI 播报期间检测参会者插话(spec §3.4 + design contract DTD + 021-metrics 动态噪声地板)。命中即打断。
   *
   * DTD(reference-aware 双讲检测):入向含「真人 + AI 回声」,固定高阈值在二者能量重叠时是死局(调高漏真人、
   * 调低自打断)。改用自适应门槛(见 bargeThreshold()):
   *  - **动态噪声地板**(诊断 021-metrics):effectiveFloor = max(dtdFloor, 近窗 AI 静默帧 p20 × k)。高底噪
   *    环境(会议室持续环境音)地板随底噪抬高 → AI 一开口不再被环境噪声误打断(治真机「说一句就被切」根因)。
   *  - **DTD 回声项**:再取 max(effectiveFloor, echoGain × 近端 AI 参考峰值)。AI 当前响 → 门槛抬高容忍回声;
   *    AI 轻/静 → 退到 effectiveFloor。
   * 仍要连续多帧确认(压单帧尖峰)。DTD 关回退固定 BARGE_RMS_THRESHOLD;动态地板关回退固定 dtdFloor(均 env 可关)。 */
  private detectBargeIn(pcm: Buffer): void {
    // ★ design contract:受保护违规发言轮(警告/原因句)播报期**抑制打断**——不累计 bargeMs、不 tentative-pause、
    //   不 onBargeIn。违规发言必须完整播完(其 onAiDone 才是收尾/挂断点)。仅此轮为真,普通轮打断现状不变。
    if (this.violationNoticeGuard) return;
    const frameMs = (pcm.length / 2 / FS_RATE) * 1000;
    const rms = pcmRms(pcm);
    const { threshold: baseThreshold, refPeak, baseline } = this.bargeThreshold();
    // ★ design contract 开口冷却窗:AI 开口首 openCooldownMs 内、且**尚未进 tentative-pause** 时,对门槛乘系数抬高
    //   (治开口瞬间 refPeak≈0 门槛塌陷 + confirmMs 恒定 → 开口期最敏感、顺口「嗯」误触发 tentative-pause 停顿)。
    //   **MUST NOT 抬 confirmMs**(守 design contract confirmMs<takeover<window 不变量);**tentative-pause 期用原门槛**
    //   (否则推迟 takeover 真接管确认)。默认 openCooldownMs=0 关 → mult=1 完全等价现状。
    const inOpenCooldown =
      BARGE_OPEN_COOLDOWN_MS > 0 &&
      !this.tentativePausing &&
      this.aiSpeakingSinceMs > 0 &&
      Date.now() - this.aiSpeakingSinceMs < BARGE_OPEN_COOLDOWN_MS;
    // ★ design contract 降门槛纠偏:旁路判 incomplete 且在关联窗内(eouIncompleteUntilMs 未过)+ 游标未变 +
    //   未在 tentative-pause 时,对该轮 barge 门槛乘 subThresholdMult(< 1 降门槛)——让考生**亚常规阈**重新
    //   出声也累计到 confirmMs 触发 tentative-pause 让位(乐观开口后事后纠偏)。与开口冷却(抬门槛)互斥:L3
    //   窗内以纠偏为先(考生判了没说完,理应更容易让位),覆盖冷却抬高。窗过/游标变即失效(自然退回常规门槛)。
    const inEouCorrection =
      EOU_CORRECTION_ENABLED &&
      !this.tentativePausing &&
      this.eouIncompleteUntilMs > 0 &&
      Date.now() < this.eouIncompleteUntilMs &&
      // 游标未变(stale 防护):降门槛窗绑定 fire 时游标,已推进则该窗对当前题无效(防判 QK 未完降 QK+1 的门槛)。
      (this.eouIncompleteCursor < 0 || (this.deps.engine.questionCursor?.() ?? -1) === this.eouIncompleteCursor);
    // ★ design contract(review):L3 降门槛 MUST 有**绝对下限**防噪声/回声冤杀——纯乘数
    //   (baseThreshold×0.6)在高 AI 音量(baseThreshold 含 echoGain×refPeak,回声大时 base 高)或高底噪时会
    //   塌到很低,把 AI 自身回声/环境噪声误判为考生续说 → 误暂停。下限 = 端点级人声阈 ENDPOINT_RMS_THRESHOLD
    //   (区分「人声 vs 噪声」的基本门槛,默认 500):降门槛只把「常规 barge 阈」降到「基本人声阈」,不低于它。
    //   即 L3 让「够得上人声、但不够常规 barge 确认」的亚阈续说也能触发,而非放行任何低能量噪声。
    const eouThreshold = Math.max(baseThreshold * EOU_SUB_THRESHOLD_MULT, ENDPOINT_RMS_THRESHOLD);
    const threshold = inEouCorrection
      ? eouThreshold
      : inOpenCooldown
        ? baseThreshold * BARGE_OPEN_COOLDOWN_MULT
        : baseThreshold;
    // 诊断(AIM_RMS_DIAG=1,真机标定打断):AI 播报期入向 RMS vs 动态门槛——定位「插话没触发」是 rms 不够
    // 还是门槛太高/根本没进 detectBargeIn(aiSpeaking 早退)。周期打印避免刷屏。
    if (RMS_DIAG && ++this.bargeDiagCount % RMS_DIAG_EVERY === 0) {
      console.log(
        `[media ${this.cfg.sessionId}] barge-diag inbound=${Math.round(rms)} 门槛=${Math.round(threshold)} ` +
          `AI参考峰值=${Math.round(refPeak)} 噪声基线=${Math.round(baseline)} bargeMs=${Math.round(this.bargeMs)}` +
          (inEouCorrection ? ` [L3降门槛×${EOU_SUB_THRESHOLD_MULT}]` : inOpenCooldown ? ` [开口冷却×${BARGE_OPEN_COOLDOWN_MULT}]` : ""),
      );
    }
    if (rms >= threshold) {
      if (this.bargeMs === 0 && this.bargeEvidenceStartedAtMs === 0) {
        this.bargeEvidenceStartedAtMs = Date.now();
      }
      this.bargeMs += frameMs;
      this.bargeDipMs = 0; // 回到高能量:hangover 计时清零
      // 声纹锁(design contract):累积打断候选窗高能量 PCM(有界 ring,复制不持引用),供 confirmMs 命中时验证「是不是目标人」。
      if (this.speakerLock) this.captureBargeWindow(pcm, frameMs);
      // 误打断恢复(design contract):已 tentative-pause 中 → 泄漏累计的接管证据达 takeover = 真接管 → 确认销毁。
      if (this.tentativePausing) {
        // ★ 声纹门(design contract 二审重构):验证在 **tentative-pause 期**发起——此时候选窗随高能量帧增长,能凑够
        //   minVerifyMs(confirmMs=200 首命中时窗太短,故不在那里验;这里 200→takeover 700 有 ~500ms 可验)。
        //   每 pause 至多一次(pauseVerifyDone),窗够长且未 pending 才发。旁人已判(pauseBystanderConfirmed)则不重验。
        if (
          this.speakerLock &&
          this.speakerLock.enrolled &&
          !this.pauseVerifyDone &&
          !this.pauseBystanderConfirmed &&
          !this.speakerVerifyPending &&
          this.bargeWindowMs >= this.speakerLock.config.minVerifyMs
        ) {
          this.maybeVerifySpeaker();
        }
        // ★ 声纹门:本 pause 已判旁人 → **阻断能量 takeover**(旁人不得靠能量证据接管);等恢复窗满自然 resume。
        //   scoped 到本 pause(beginTentativePause 重置),故目标人的新 pause 绝不被误压(修二审 D1 泄漏)。
        if (this.pauseBystanderConfirmed) {
          return; // 旁人:不接管、不顺延恢复窗(让它到点 resume);证据继续累计但不触发 takeover
        }
        if (this.bargeMs >= RECOVERY_TAKEOVER_MS) {
          console.log(`[media ${this.cfg.sessionId}] tentative-pause 内泄漏累计证据 ${Math.round(this.bargeMs)}ms ≥ takeover ${RECOVERY_TAKEOVER_MS}ms → 确认真接管,销毁本轮`);
          this.confirmTakeover();
          return;
        }
        // ★ design contract:能量域顺延——每帧高能量把恢复窗计时**重置**(resume 推迟到"最后一次高能量后
        //   recoveryWindowMs 静默"),给断续插话继续累计到 takeover 的机会;但从暂停起点算超 recoveryMaxHoldMs
        //   即不再顺延(防无限 hold)。默认 RECOVERY_MAX_HOLD_MS=0 关 → 不顺延、退回现状固定 wall-clock。
        if (RECOVERY_MAX_HOLD_MS > 0 && this.recoveryTimer) {
          const elapsed = Date.now() - this.tentativePauseStartMs;
          if (elapsed < RECOVERY_MAX_HOLD_MS) {
            clearTimeout(this.recoveryTimer);
            // ★ review:硬上限须真硬——顺延 delay clamp 到「距硬上限剩余时长」,使 resume 绝不晚于
            //   tentativePauseStartMs + recoveryMaxHoldMs(否则边界前一帧高能量可把 resume 排到超上限近一个
            //   recoveryWindowMs)。到点即 resume(误打断),不再无限顺延。
            const delay = Math.min(RECOVERY_WINDOW_MS, RECOVERY_MAX_HOLD_MS - elapsed);
            this.recoveryTimer = setTimeout(() => this.onRecoveryWindowElapsed(), delay);
            this.recoveryTimer.unref?.();
          }
        }
        return;
      }
      if (this.bargeMs >= BARGE_CONFIRM_MS) {
        // 诊断(真机标定误打断/漏打断根因,评审 建议):记触发时的能量四元组。
        console.log(
          `[media ${this.cfg.sessionId}] barge-in 触发:rms=${Math.round(rms)} 门槛=${Math.round(threshold)} ` +
            `AI参考峰值=${Math.round(refPeak)} 噪声基线=${Math.round(baseline)} dtd=${BARGE_DTD_ENABLED}`,
        );
        // 触发时能量四元组随本轮 metric 落库(让「误打断 vs 真打断 / 噪声 vs 回声」可由 metrics 直接区分)。
        this.pendingBargeMetrics = {
          bargeInboundRms: rms,
          bargeNoiseBaseline: baseline,
          bargeRefPeak: refPeak,
          bargeThreshold: threshold,
        };
        // 误打断恢复开:先 tentative-pause(不销毁),等接管确认 / 窗满 resume;关:直接销毁(design contract 现状)。
        // ★ 声纹门(design contract 二审重构):**不在此(confirmMs 首命中)验证**——此刻候选窗仅 ~confirmMs(200ms)< minVerifyMs
        //   会短窗 fail-open;改到 tentative-pause 期(上方 tentativePausing 分支)窗增长够 minVerifyMs 时发起一次验证。
        //   TARGET→confirmTakeover / NONTARGET→本 pause 内阻断 takeover + resume / UNCERTAIN→交能量证据 = fail-open。
        //   recovery 关(声纹门 effective 前提之一,D7)时直接销毁——此时不启用声纹门,行为等价现状。
        if (RECOVERY_ENABLED) this.beginTentativePause();
        else {
          const now = Date.now();
          if (this.pendingBargeMetrics && this.bargeEvidenceStartedAtMs > 0) {
            this.pendingBargeMetrics.bargeEvidenceToPauseMs =
              Math.max(0, now - this.bargeEvidenceStartedAtMs);
            this.pendingBargeMetrics.pauseToConfirmMs = 0;
          }
          this.onBargeIn();
        }
      }
    } else {
      // hangover(治确认窗对真实语音过苛致漏判):真人浊/清音交替,20ms 清音帧 RMS 常跌破门槛,
      // 旧「单帧掉线即清零」要求每一帧连续超阈 → 真插话凑不满 confirmMs。低于门槛的帧在 hangover 窗内
      // **不累计也不清零**(计时暂停);连续低能量超过 hangover 才判「插话已停」清零。仍压单帧尖峰:
      // 尖峰(1-2 帧)累计 ≤40ms 远低于 confirmMs,且其后静默超 hangover 即清。
      // tentative-pause 后不复用初判 hangover 的整段清零语义,改用泄漏累计:真人短停顿只缓降,
      // 可继续攒到 takeover;背景尖峰后的长静默会把证据降到 0,不会跨 burst 误累计。
      if (this.tentativePausing) {
        this.bargeMs = Math.max(0, this.bargeMs - frameMs * RECOVERY_TAKEOVER_DECAY);
        // 证据归零不提前 resume:恢复窗/能量域顺延仍是 episode 的唯一结束门,确保状态和 false_interruption
        // metrics 都统一经 onRecoveryWindowElapsed 收口。
        return;
      }
      this.bargeDipMs += frameMs;
      if (this.bargeDipMs >= BARGE_HANGOVER_MS || BARGE_HANGOVER_MS <= 0) {
        this.bargeMs = 0;
        this.bargeDipMs = 0;
        this.bargeEvidenceStartedAtMs = 0;
        // 声纹门(design contract review):非 tentative-pause 的打断候选(未攒到 confirmMs 就跌破 hangover)结束 →
        //   收口清候选窗 PCM(防这段残音混入下一验证窗)+ 递增 episode 使迟到回调作废。仅在攒过窗/有飞行验证时收口,
        //   免每静音帧空跑。(旁人压制是 pause-scoped,不涉此处;此分支本就非 tentative-pause 态。)
        if (this.speakerLock && (this.bargeWindowChunks.length > 0 || this.speakerVerifyPending)) {
          this.endSpeakerEpisode();
        }
      }
    }
  }

  /** 撤销待执行的语义挂断(用户在延迟窗内又开口=想继续):清挂断 timer + 本轮告别旗。
   *  新有效语音/新轮/barge-in 到来即调用,闭合误挂竞态。 */
  private cancelPendingHangup(): void {
    if (this.hangupTimer) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = null;
    }
    this.aiSaidFarewellThisTurn = false;
    this.userSaidFarewell = false;
  }

  // ── design contract:自由聊天两步确认 latch 状态转移(非 lifetime sticky)──
  /** 据本轮用户 final 更新离开意图 latch。**先判置位(离开意图),再判清除(继续/实质新内容),中性纯确认保持**。
   *  - 明确离开意图(isUserLeaveIntent)→ 进/续 LEAVE_PENDING,重置放弃计数(AI 轮计数);
   *  - 已 pending 且本轮明确继续(FAREWELL_CONTINUE)/ 实质新内容 → 用户改主意,清 latch(条件 a/b,防陈旧误挂);
   *  - 已 pending 且本轮是中性纯确认(「没有了/嗯/好的」既不离开也不继续)→ latch **保持不动**(这是两步确认第二步能
   *    放行的关键:不因"本轮不含告别词"误清)。★ review:**放弃计数不在此累计**——本方法在**用户轮**
   *    (asr_final)触发,若在此累计会把"用户多句碎碎念"错当"AI 多轮未挂";放弃计数按 **AI 轮**在 onAiDone 累计(见下)。
   *  仅无题(自由聊天)会话据此参与挂断判据;有题会话该 latch 不进入 blockedByOpenChat(hasQuestions=true 时恒 false)。 */
  private updateLeaveLatch(userText: string): void {
    const t = (userText || "").trim();
    if (!t) return;
    if (isUserLeaveIntent(t)) { // 明确离开意图 → 进/续 LEAVE_PENDING
      this.leaveIntentPending = true;
      this.leavePendingTurns = 0; // 新的离开意图 → 放弃计数归零(AI 轮重新计)
      return;
    }
    if (!this.leaveIntentPending) return; // 未在 pending:非离开意图无需处理
    if (FAREWELL_CONTINUE.test(t) || this.isSubstantiveTurn(t)) {
      this.clearLeaveLatch(); // 明确继续 / 实质新内容 → 改主意,清 latch(条件 a/b)
    }
    // 中性纯确认(没有了/嗯/好的…)→ latch **保持不动**(计数按 AI 轮在 onAiDone 累计,此处不动)。
  }

  /** design contract 条件(d,review:按 **AI 轮**放弃防御):AI 每完成一轮(onAiDone)且 latch 仍 pending、
   *  本轮**未挂断**时累计一次;达 LEAVE_PENDING_MAX_TURNS(2)→ 清 latch(用户表达离开意图后 AI 已过 N 轮仍未收尾=
   *  陈旧悬挂,放弃防御防定时炸弹)。放行挂断的那一轮不会走到这里(shouldHangup 时已进挂断分支)。 */
  private noteAiTurnForLeaveLatch(): void {
    if (!this.leaveIntentPending) return;
    this.leavePendingTurns += 1;
    if (this.leavePendingTurns >= MediaSession.LEAVE_PENDING_MAX_TURNS) this.clearLeaveLatch();
  }

  /** 清离开意图 latch(用户改主意继续对话 / barge-in / 放弃防御)。宁漏挂不误挂:清 = 更保守(不放行 AI 主动挂)。 */
  private clearLeaveLatch(): void {
    this.leaveIntentPending = false;
    this.leavePendingTurns = 0;
  }

  /** 本轮是否"实质新内容"(用户在继续对话,非纯确认/告别)→ 用于清 latch(条件 b)。
   *  ★ review:先排除**纯确认/客套/告别**(显式词表,即便字数多也不算实质,治「没有了谢谢你辛苦了」9 字
   *    被 length>=8 误判成实质新内容 → 两步确认第二步清 latch 挂不掉)。再判"实质":明确疑问/继续话头,或**去掉确认/客套/
   *    标点后仍较长**(真的引入了新内容)。宁挂不误:判不准偏"非实质"(保 latch,靠 AI 轮放弃计数兜底,不激进清)。 */
  private isSubstantiveTurn(text: string): boolean {
    const s = (text || "").trim();
    if (!s) return false;
    // 纯确认/客套/告别词(两步确认第二步的典型回复)——命中且**无**明确新话头 → 不算实质新内容。
    const NEUTRAL_OR_POLITE = /(没有了?|没有别的|没别的|没了|嗯+|好的?|行(吧|的)?|可以|知道了|明白了|了解|收到|谢谢|辛苦了?|不用了|就这样|没事了?|拜拜|再见|挂了)/g;
    // design contract:疑问/新话头 pattern 抽到 question-cue.ts 单一事实源(与 engine aiIsAsking 同源)。
    if (QUESTION_CUE_RE.test(s)) return true; // 明确疑问/新话头 → 实质
    // 去掉确认/客套/告别词 + 标点后的剩余(真正的"新内容")长度:仍 ≥5 → 实质(纯客套堆砌不算)。
    const residual = s.replace(NEUTRAL_OR_POLITE, "").replace(/[\s,，。、!!?？…~～的了吧啦呀啊哦嗯]/g, "");
    return residual.length >= 5;
  }

  /** design contract:算语义挂断延迟——按**会话级播放队尾估算**客户端播放完成时刻,治「跨境告别句尾音被固定延迟切断」。
   *  waitMs = clamp( max(0, 推算播完时刻 − now) + 网络/缓冲余量 , 硬上限 )。
   *  推算播完时刻 = max(本轮首帧 + 本轮音频时长,会话级客户端播放队尾)。会话级队尾能覆盖前序音频仍排队、
   *  下发帧有间隔等单轮连续播放假设会低估的情况。
   *  fail-safe(本轮无音频帧,极端:一帧没出就要挂)→ 回退固定 FAREWELL_HANGUP_DELAY_MS。 */
  private computeFarewellDelayMs(): number {
    // fail-safe:本轮未出过音频(拿不到 T_audio/首帧,极端:一帧没出就要挂)→ 回退固定延迟,
    //   绝不因推算失败乱挂。★ design contract:原先此处还有 `!FAREWELL_TTS_DRAIN_ENABLED ||`——开关已删,
    //   条件随之化简(review:恒真的开关留在条件里是死代码,会让人以为还能关)。
    if (this.aiTurnFirstAudioAtMs === 0 || this.aiTurnAudioMs <= 0) {
      return FAREWELL_HANGUP_DELAY_MS;
    }
    // 单轮估算保留为 fail-soft 下界;正常使用 design contract 的会话级队尾,避免前序音频仍在排队时低估。
    const turnPlayDoneAtMs = this.aiTurnFirstAudioAtMs + this.aiTurnAudioMs;
    const sessionPlaybackEndMs = Number.isFinite(this.estimatedClientPlaybackEndMs)
      ? this.estimatedClientPlaybackEndMs
      : 0;
    const playDoneAtMs = Math.max(turnPlayDoneAtMs, sessionPlaybackEndMs);
    const remainMs = Math.max(0, playDoneAtMs - Date.now());
    // + 网络/缓冲余量;clamp 到硬上限(防 T_audio 异常/黑洞致永久不挂)。
    return Math.min(remainMs + FAREWELL_TAIL_MS, FAREWELL_DRAIN_MAX_MS);
  }

  /** design contract:计算「客户端估算播完」推进时钟起点(唯一同步快照,三处推进时钟共用同一返回值)。
   *  **风险降低,非正确性闭环**——只把现有推进窗口(waiting/nudge/answerGrace)的最早起算点从 tts_done 后移到
   *  「会话级队尾 + 余量」,推进仍须满足原有 grace/静默/epoch 条件。真「客户端已播放/已中止」由 P1 ACK 闭合。
   *  fail-safe(评审 Major2 统一,二者不可混):
   *    - 无音频 / NaN / lead 负 → 退回 `now`(短队尾直接失去保护、重回 tts_done 起算是缺陷1,但无估算只能退 now);
   *    - 有限但超 MAX_PLAYBACK_LEAD_MS → clamp 到 `now + MAX`(**不退回 now**;超上限按上限,有界保护)。
   *  ★ 快照时机:MUST 在清音频统计之前调用(markAiDonePlaying 清单轮统计;但本函数读**会话级队尾**,独立于
   *  单轮统计,不受清零影响——故实际对时机不敏感,注释保留以示意语义)。 */
  private computePlaybackNotBeforeMs(): number {
    const now = Date.now();
    // fail-safe①:无音频 / 队尾无效 → now(无估算依据)。
    if (this.estimatedClientPlaybackEndMs <= 0 || !Number.isFinite(this.estimatedClientPlaybackEndMs)) return now;
    const rawEnd = this.estimatedClientPlaybackEndMs + PLAYBACK_LEAD_MARGIN_MS; // 队尾 + 独立余量
    const lead = rawEnd - now;
    // fail-safe②:NaN / 负(队尾早已过去,客户端应已播完)→ now。
    if (!Number.isFinite(lead) || lead < 0) return now;
    // ★ 有限但超上限 → clamp 到 now+MAX(不退回 now:退回会让长队尾失去保护、重回 tts_done 起算=缺陷1)。
    return now + Math.min(lead, MAX_PLAYBACK_LEAD_MS);
  }

  /** VAD 高阈值 + 多帧确认命中后打断 AI 播报(barge-in)。也可由上层信令(M1 客户端 barge_in 帧)直接调用。 */
  onBargeIn(): void {
    // ★ 语义挂断竞态(review):用户插话(打断 AI 说「拜拜」、或在挂断延迟窗内直呼本方法)说明他想
    //   **继续** → 撤销本轮告别挂断意图。**置于 aiSpeaking 早退之前**:onAiDone 排程挂断 timer 时已
    //   markAiDonePlaying(aiSpeaking=false);若 cancel 在早退之后,timer 排程后的 barge-in
    //   走不到 cancel 分支。前置后两条路径都闭合。
    //   engine 侧 endCallSignaled 在 engine.cancel 内清;media-session 侧告别旗 + 已排程 timer 由此一并撤销。
    this.cancelPendingHangup();
    // design contract 条件(c):barge-in = 用户还在积极参与对话 → 清离开意图 latch(防陈旧悬挂成误挂)。
    this.clearLeaveLatch();
    // 误打断恢复(design contract):任何确认打断路径(含客户端上行 barge_in / 服务端 takeover)都清 tentative 状态 +
    //   恢复窗计时(engine.cancel 会清引擎侧 paused;此处清媒体面侧,避免残留计时误触发 resume)。
    const confirmedAtMs = Date.now();
    const interruptionIdentity = this.tentativePauseIdentity;
    if (this.pendingBargeMetrics && this.tentativePauseStartMs > 0) {
      this.pendingBargeMetrics.pauseToConfirmMs =
        Math.max(0, confirmedAtMs - this.tentativePauseStartMs);
    }
    this.clearRecoveryTimer();
    this.tentativePausing = false;
    console.log(
      `[media ${this.cfg.sessionId}] onBargeIn aiSpeaking=${this.aiSpeaking} refPeak=${Math.round(this.recentRefPeak())}`,
    );
    // 没在播报 → 无可打断(防重复/误调);但上面的撤销挂断已先生效。
    if (!this.aiSpeaking) return;
    // ★ design contract(review=false 只挡新 waiting,不清已有状态):确认打断/takeover MUST **同步清
    //   waitingSinceMs + 复位 R3 阶段,且在 markAiDonePlaying 之前**。致命时序:已在 waiting → 静默 nudge → nudge_playing
    //   → 用户打断 nudge → onBargeIn → 若先 markAiDonePlaying,它把 nudge_playing 翻成 after_nudge(:1938),随后引擎
    //   fireAiDone(false) 不进新 waiting,但旧 waitingSinceMs + after_nudge 残留 → watchdog(checkR3SilenceAdvance)仍
    //   可强推。故此处先清:清后 markAiDonePlaying 的 nudge_playing 判据落空(不再误转 after_nudge)。用户接管 = 该题
    //   由新一轮 AI 出声后 enterWaitingForAnswer 重新起窗,不背旧题静默。
    this.waitingSinceMs = 0;
    this.silenceCountedThisWait = false;
    this.resetR3Phase();
    // 走 markAiDonePlaying 而非裸置 aiSpeaking=false:它同时复位 lastAiAudioAtMs(否则打断后残留旧时戳,
    // 下轮 AI 卡住时安全看门狗可能据陈旧时戳误判恢复时机,code-review)。
    this.markAiDonePlaying();
    this.bargeMs = 0;
    this.bargeDipMs = 0;
    this.bargeEvidenceStartedAtMs = 0;
    this.tentativePauseStartMs = 0;
    // 声纹锁(design contract):打断确认(真接管)= 本 episode 结束 → 统一收口(递增 episode 使迟到回调作废 + 清候选窗 +
    //   清旁人标记:目标人接管了,下轮从头判)。
    if (this.speakerLock) this.endSpeakerEpisode();
    // M1 信令:barge_in 下行帧 → 客户端清本地播放队列(即时停声闭环:服务端停发帧 + 客户端清已缓冲音频)。
    this.emitTransport({
      type: "interruption_confirmed",
      ...(this.activeAudioTurnId !== null
        ? { aiTurnId: this.activeAudioTurnId }
        : {}),
      ...(interruptionIdentity
        ? { pauseId: interruptionIdentity.pauseId }
        : {}),
    });
    this.tentativePauseIdentity = null;
    this.activeAudioTurnId = null;
    // ★ design contract:barge_in 下行 = 服务端**确定**客户端清了播放队列 → 会话级队尾重置为 now(此后不背旧音频)。
    //   与 user final 不重置(review:那条无版本协商)区分——barge_in 帧是本服务发出、客户端必清的确定路径。
    this.estimatedClientPlaybackEndMs = Date.now();
    // 打断时 engine.cancel 切源(同步置 interrupted=true → three-stage onAudio 守卫**立即丢弃**
    //   GPU 在途残音,不再经 onAudioOut→conn.send 发新 AI 音频;+ 停 LLM 流 + GPU cancel)。
    //   停声 = 停发帧 + 清发送队列;客户端本地播放队列由 M1 信令 barge_in 帧清
    //  (修复电话版「打断不即时停声」缺陷:FS 缓冲已不存在,uuid_break 补丁群随之删除)。
    this.deps.engine.cancel("barge_in"); // 停 LLM 流 + 丢未播句 + GPU cancel + 置 interrupted(同步,先切源)
  }

  // ── 误打断恢复(design contract,借鉴 LiveKit false_interruption_timeout)──
  /** 疑似打断确认 → tentative-pause:暂停出声(engine.pause,不销毁)+ 下行 pause 帧(客户端暂停播放,不清队列)
   *  + 启动恢复窗计时。此后 detectBargeIn 用泄漏累计器维护接管证据(高能量增加、低能量缓降):
   *  达 takeover → confirmTakeover 销毁;窗满 → onRecoveryWindowElapsed resume。
   *  engine 未实现 pause(非 three_stage)→ 回退直接销毁(不假装暂停)。 */
  private beginTentativePause(): void {
    if (this.tentativePausing) return; // 幂等:已在暂停中不重启计时
    if (typeof this.deps.engine.pause !== "function" || typeof this.deps.engine.resume !== "function") {
      this.onBargeIn(); // 引擎不支持可恢复暂停 → 回退销毁(不假装)
      return;
    }
    if (this.activeAudioTurnId === null) {
      console.warn(
        `[media ${this.cfg.sessionId}] tentative-pause 缺少 ai_turn_id → 回退确认打断`,
      );
      this.onBargeIn();
      return;
    }
    this.pauseSequence += 1;
    this.tentativePauseIdentity = {
      aiTurnId: this.activeAudioTurnId,
      pauseId: this.pauseSequence,
    };
    this.tentativePausing = true;
    this.tentativePauseStartMs = Date.now(); // design contract:顺延硬上限从此起算
    if (this.pendingBargeMetrics && this.bargeEvidenceStartedAtMs > 0) {
      this.pendingBargeMetrics.bargeEvidenceToPauseMs = Math.max(
        0,
        this.tentativePauseStartMs - this.bargeEvidenceStartedAtMs,
      );
    }
    // 声纹门(design contract 二审):pause-scoped 旁人压制 + 验证已发起标志**每次进 pause 重置**——保证旁人判定绝不
    //   泄漏到目标人的新 pause(修二审 D1 fail-closed 泄漏),且每个 pause 至多验证一次。
    this.pauseBystanderConfirmed = false;
    this.pauseVerifyDone = false;
    // bargeMs **不清零**:pause 后继续累计,达 takeover 判真接管(初判已耗 confirmMs,续到 takeover)。
    console.log(`[media ${this.cfg.sessionId}] tentative-pause 开始(疑似打断,暂停不销毁;窗 ${RECOVERY_WINDOW_MS}ms 内无接管则续播)`);
    this.deps.engine.pause?.();
    // 下行 pause 帧:客户端暂停播放但**不清队列**(可恢复);与销毁性 barge_in 帧语义互斥。
    this.emitTransport({
      type: "interruption_paused",
      aiTurnId: this.tentativePauseIdentity.aiTurnId,
      pauseId: this.tentativePauseIdentity.pauseId,
    });
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => this.onRecoveryWindowElapsed(), RECOVERY_WINDOW_MS);
    this.recoveryTimer.unref?.();
  }

  /** 恢复窗满仍无接管(一声「嗯」/噪声,定时器回调):resume 续播,记 false_interruption(误打断)。 */
  private onRecoveryWindowElapsed(): void {
    this.recoveryTimer = null; // timer 已触发,置空(下面收口不再重复 clear)
    if (!this.tentativePausing || this.closed) return;
    console.log(`[media ${this.cfg.sessionId}] 恢复窗 ${RECOVERY_WINDOW_MS}ms 内无有效接管 → resume 续播(误打断,不丢本轮)`);
    this.resumeFromTentativePause();
  }

  /** tentative-pause → resume 续播的统一收口(review)。两个调用点:①恢复窗满(定时器)②声纹门 NONTARGET
   *  (旁人)。**幂等 + episode 单次递增**:清恢复窗计时器(NONTARGET 直调时原 timer 仍挂,须清防迟到重跑)、
   *  声纹 episode 序号递增一次(使迟到验证回调作废)、清打断证据/候选窗、记 false_interruption(误打断/非目标人,
   *  语义相符)、engine.resume + 下行 resume 帧。守 tentativePausing=true 才动(否则幂等 no-op)。 */
  private resumeFromTentativePause(): void {
    if (!this.tentativePausing || this.closed) return;
    const identity = this.tentativePauseIdentity;
    this.clearRecoveryTimer(); // NONTARGET 直调时原 2s timer 仍挂 → 显式清(定时器路径已 null,clear 幂等)
    this.tentativePausing = false;
    this.tentativePauseStartMs = 0;
    this.bargeEvidenceStartedAtMs = 0;
    this.bargeMs = 0;
    this.bargeDipMs = 0;
    // 声纹锁(design contract):resume = 本 episode 结束 → episode 序号**递增一次**(使迟到验证回调 stale 作废)+ 清候选窗。
    this.speakerVerifyEpisode += 1;
    this.speakerVerifyPending = false;
    this.clearBargeWindow();
    this.pendingBargeMetrics = null; // 没真打断:不附能量四元组(那是打断诊断字段)
    // 误打断标记写进**本轮 pendingEndpoint**(而非 session 级旗)——tentative-pause 发生在本轮 AI 播报期,
    // 其 turn_end 早已建好 pendingEndpoint 且尚未被 engine onMetrics 消费(本轮还在说)。写这里天然绑定正确的
    // turn(与 e2eLatency 同机制),避免「session 级旗跨轮误附给下一轮」(review)。pendingEndpoint 为空
    // (极端:kickoff 无端点段)则记不上,不编造。
    if (this.pendingEndpoint) this.pendingEndpoint.falseInterruption = true;
    this.deps.engine.resume?.();
    // 下行 resume 帧:客户端恢复播放队列(与 pause 成对)。
    if (identity) {
      this.emitTransport({
        type: "interruption_resumed",
        aiTurnId: identity.aiTurnId,
        pauseId: identity.pauseId,
      });
    }
    this.tentativePauseIdentity = null;
  }

  /** tentative-pause 内确认真接管(高能量续到 takeover):转确认打断,走 onBargeIn 销毁路径。 */
  private confirmTakeover(): void {
    this.clearRecoveryTimer();
    this.tentativePausing = false;
    // onBargeIn 内会 engine.cancel(barge_in)——engine.cancel 先清 paused 再销毁(pause 与 cancel 互斥)。
    this.onBargeIn();
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /** 主动结束当前一轮(VAD 兜底逃生口):请引擎 finalize → 触发 AI 回复。
   *
   * 正常会话靠自然尾静音出 turn_end 即可;边缘 case(持续底噪 > VAD 阈值 / 对方长时间不停顿)
   * VAD 不命中 → AI 哑掉。M1 客户端信令可加「结束发言」按钮直呼本方法。
   * 机制已就位(engine.endTurn → gpu.flush)。 */
  forceEndTurn(): void {
    this.deps.engine.endTurn?.();
  }

  /** 回声抑制静音帧(design contract):返回长度 = len 的全零 buffer 切片,复用缓存 silenceBuf(不每帧 alloc)。
   *  帧长通常恒定(16k mono s16le 20ms = 640B),但防御变长:len > 缓存则扩容(打 warn,异常帧长可观测)。
   *  返回的是 silenceBuf 的 subarray(只读别名,调用链只读不写 → 安全);单向增长,不缩容(单帧浪费有限)。 */
  private silenceFrame(len: number): Buffer {
    if (len > this.silenceBuf.length) {
      if (this.silenceBuf.length > 0) {
        console.warn(`[media ${this.cfg.sessionId}] 回声抑制静音帧扩容:${this.silenceBuf.length} → ${len}B(异常帧长?通常恒 640B,请查客户端)`);
      }
      this.silenceBuf = Buffer.alloc(len); // 全零;扩容后旧切片引用仍指向旧 buffer(不影响,静音内容一致)
    }
    return this.silenceBuf.subarray(0, len);
  }

  /** 标记 AI 播报结束(GPU tts_done 后),关回声抑制窗,恢复正常入向。
   *  ★ design contract:`playbackNotBeforeMs`(可选,onAiDone 路径传)= nudge 轮的客户端估算播完起点——转 after_nudge 时
   *  用它作第二窗计时锚点(第三条播放后推进时钟,与 waiting/answerGrace 用同一快照);其它调用点(watchdog 兜底 /
   *  已被 onBargeIn 复位 R3)不传 → 退回 now(逐字节等价)。 */
  markAiDonePlaying(playbackNotBeforeMs?: number | void): void {
    // ★ design contract(review 轮完成信号区分):若正处 nudge_playing,则本次播完 = **R3 nudge 轮**播完
    //   → 进 after_nudge 起第二窗。普通轮的 markAiDonePlaying 不会命中(r3Phase 只在发 nudge 后置 nudge_playing),
    //   故不会把普通轮误判为 nudge 播完、也不会让 nudge 轮信号被普通轮抢走。第二窗计时从此刻(nudge 播完)起。
    if (this.r3Phase === "nudge_playing") {
      this.r3Phase = "after_nudge";
      // design contract:第二窗从 nudge 音频**客户端估算播完**起(而非 tts_done 后 now),与三处同快照。
      const now = Date.now();
      this.r3PhaseSinceMs =
        typeof playbackNotBeforeMs === "number" && Number.isFinite(playbackNotBeforeMs)
          ? Math.max(now, playbackNotBeforeMs)
          : now;
    }
    this.aiSpeaking = false;
    this.lastAiAudioAtMs = 0; // 复位:下轮 aiSpeaking 由新音频帧重新置位+续期,不被上轮陈旧时戳误判
    this.aiSpeakingSinceMs = 0; // design contract:开口时刻复位,下轮开口重新计冷却窗
    // ★ design contract(review):清本轮音频统计——否则「上一轮有音频→本轮告别轮无音频(TTS 空/失败)→
    //   onAiDone」时,aiTurnAudioMs 残留上一轮的值使 computeFarewellDelayMs 的 fail-safe(aiTurnAudioMs<=0)不命中,
    //   拿上一轮过时 first/audioMs 推算挂断延迟(错值)。此处清零 → 无音频告别轮正确回退固定延迟。
    this.aiTurnFirstAudioAtMs = 0;
    this.aiTurnAudioMs = 0;
  }

  /** design contract(review):进入「等待考生作答」态 —— **仅 onAiDone 且引擎权威 completed=true
   *  (本轮正常完整播完)才调**。判据来自引擎(fireAiDone 携带),非 media-session 侧 aiSpeaking 近似——后者只表
   *  「本轮出过音频」,LLM 流出半句后失败(partial)时仍为 true 会误判说完(review 二审 Blocker)。打断/超时/流错
   *  (completed=false)不进(题没念完不该让考生沉默背锅)。新等待窗清「已计沉默」标志。 */
  private enterWaitingForAnswer(playbackNotBeforeMs?: number | void): void {
    // ★ design contract:沉默起算锚点 = 客户端估算播完时刻(playbackNotBeforeMs),而非 now(=tts_done 后)。治缺陷1:
    //   AI 长追问音频还在客户端播,沉默钟就从 tts_done 起算 → 只给 ~0.8s 就 nudge/推进。用估算播完后移起点,
    //   waiting(design contract)/ after_nudge(R3)两处 silenceSince=max(waitingSinceMs,lastSpeechAtMs) 据此天然后移。
    //   fail-safe:playbackNotBeforeMs 非 finite/未来更早(< now 罕见)→ 退回 now(computePlaybackNotBeforeMs 已保证
    //   返回值 ≥ now,此处 max(now, ...) 双保险,绝不早于 now 使沉默窗反而变短)。void(引擎未接)→ now(现状等价)。
    const now = Date.now();
    this.waitingSinceMs =
      typeof playbackNotBeforeMs === "number" && Number.isFinite(playbackNotBeforeMs)
        ? Math.max(now, playbackNotBeforeMs)
        : now;
    this.silenceCountedThisWait = false;
  }

  /** 收尾:幂等。停引擎 + 上传录音 + 关连接(下发 `ended` 帧)+ 回报 completed。teardown 本身按资源存在与否清理,
   *  可在会话任意阶段安全调用(含启动窗)。启动窗断连的「teardown 后 begin 继续物化」逃逸由 begin() 每步 await 后的
   *  `this.closed` 复查兜底(见 begin;design contract)。 */
  async end(reason: CancelReason): Promise<{ recordingKey: string | null }> {
    return this.teardown(reason, true, {
      type: "session_ended",
      reason,
    });
  }

  /** 仅清理本 media session 资源(停引擎/录音/关本 WS),**不回报 completed**(N4 重复 session_id:
   *  客户端 reconnect / duplicate 连接时,替换旧会话不是会话结束)。
   *  design contract「新挤旧」:关旧 WS 前下发 `{type:"error",code:"superseded"}`,让旧客户端区分
   *  「被新连接取代」与「裸断连」(不当作错误重试)。 */
  async detach(): Promise<{ recordingKey: string | null }> {
    return this.teardown("session_end", false, {
      type: "connection_superseded",
    });
  }

  private async teardown(
    reason: CancelReason,
    reportCompleted: boolean,
    closeEvent: import("./media-session-port").MediaSessionCloseEvent,
  ): Promise<{ recordingKey: string | null }> {
    if (this.closed) return { recordingKey: null };
    this.closed = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.clearPendingResponseOutputTimer();
    this.pendingResponseOutput = [];
    this.pendingResponseOutputBytes = 0;
    this.responsePlaybackSnapshots.clear();
    this.endpointByTurn.clear();
    this.uxByTurn.clear();
    this.uxIssuedTurns.clear();
    this.completeMetricsByTurn.clear();
    const wireResponseGeneration = this.outputFlowGeneration;
    const wireResponseIdentity =
      wireResponseGeneration === null
        ? undefined
        : this.responseIdentityByGeneration.get(wireResponseGeneration);
    if (this.hangupTimer) {
      clearTimeout(this.hangupTimer); // 收尾时清待挂断 timer(防悬挂;closed 后回调也有守卫,双保险)
      this.hangupTimer = null;
    }
    if (this.kickoffTimer) {
      clearTimeout(this.kickoffTimer); // 收尾时清主动开场计时器(design contract;防悬挂)
      this.kickoffTimer = null;
    }
    if (this.forcedEndTimer) {
      clearTimeout(this.forcedEndTimer); // design contract:收尾清违规强制结束硬超时 timer(防悬挂;end 幂等)
      this.forcedEndTimer = null;
    }
    // ★ design contract:收尾清 suppressNewTurns(防 flag 悬挂到引擎——引擎虽随会话销毁,显式清是防御一致性)。
    if (this.deps.engine.suppressNewTurns !== undefined) this.deps.engine.suppressNewTurns = false;
    this.clearRecoveryTimer(); // 误打断恢复(design contract):收尾清恢复窗计时器(防悬挂)
    this.speakerLock?.dispose(); // 声纹锁(design contract):使飞行中的注册/验证回调作废(不回调已销毁的轮)
    this.fixerAbort.abort(); // ASR 字幕修正(design contract):abort 所有飞行中修正,不等待;迟到结果被 closed 守卫丢弃
    this.teardownInProgress = true;
    let cancelFailed = false;
    try {
      if (this.started) this.deps.engine.cancel(reason);
    } catch {
      cancelFailed = true;
    } finally {
      if (
        wireResponseGeneration !== null &&
        wireResponseIdentity &&
        !this.isResponseGenerationRetired(wireResponseGeneration)
      ) {
        this.emitResponseOutput({
          type: "response_core_terminal",
          responseGeneration: wireResponseGeneration,
          turnSeq: wireResponseIdentity.turnSeq,
          status: cancelFailed || reason === "error" ? "failed" : "cancelled",
          reason: cancelFailed ? "engine_cancel_failed" : reason,
        });
      }
      this.teardownInProgress = false;
    }
    let transportClosed = false;
    const closeTransport = (): void => {
      if (transportClosed) return;
      transportClosed = true;
      try {
        this.transport.close(closeEvent);
      } catch {
        /* ignore */
      }
    };
    // Takeover must revoke the old writer before slow recording upload or
    // engine shutdown. Normal business end keeps the historical cleanup order.
    if (!reportCompleted) closeTransport();
    const recordingKey = (await this.deps.recorder?.stopAndUpload().catch(() => null)) ?? null;
    try {
      await this.deps.engine.stop();
    } catch {
      /* ignore */
    }
    if (reportCompleted) closeTransport();
    // 会话收尾(end 路径,非 detach 替换)→ 回报控制面,带时长/录音。
    // detach(reportCompleted=false,重复 session_id 替换旧会话)不回报:那不是会话结束。
    // ★ design contract(评审:启动窗断连的终态回报):回报条件**去掉 `this.started` 门**——connected 在 begin()
    //   前已发(index.ts),启动窗内(started 尚未置)被 close/onError/manual_hangup 收尾的会话**也 MUST 回报**终态,
    //   否则 backend 停在 in_progress 只能等 max_duration reaper。resource 清理由 teardown 幂等 + begin 每步 closed 复查保证。
    if (reportCompleted && this.deps.onEnded) {
      const durationS = this.startedAtMs ? (Date.now() - this.startedAtMs) / 1000 : 0;
      try {
        // design contract:带上三次坚持逃生阀是否放行(early_exit),供控制面/evaluator 知晓「考生主动提前放弃」。
        const earlyExit = this.deps.engine.wantsEarlyExit?.() ?? false;
        this.deps.onEnded({ durationS, hasRecording: recordingKey != null, reason, earlyExit });
      } catch {
        /* 回报失败不影响收尾 */
      }
    }
    return { recordingKey };
  }
}
