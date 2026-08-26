/**
 * TurnHandling 配置(design contract)—— 把散落的 turn-taking/打断/兜底参数收口为**单一对象**,
 * 一处表达整套策略。各 env 仅作该对象字段的覆盖入口,默认值与既有真机标定一致(本要求是「表达方式收口」,
 * MUST NOT 改变默认值或已标定行为)。
 *
 * 分组:
 *  - endpointing:服务侧端点看门狗(GPU VAD 不出 turn_end 时兜底)
 *  - interruption:barge-in 声学门槛 + 内容门槛占位
 *  - meaningfulInput:拒垃圾输入门槛(design contract,三段式触发 LLM 前的有效字符数门槛,治幻觉开场漏网)
 *  - proactiveOpening:会话建立后主动开场(design contract,可关)
 *  - aiDoneWatchdog:aiSpeaking 安全看门狗(MiniMax 慢/丢 tts_done 不永久哑)
 * (电话版的 joinGating 入会门控已随 Teams IVR 删除,VISION §1。)
 *
 * 跨栈单一事实源不变式(MUST 守):`endpointing.rmsThreshold` == `constants.ts::ENDPOINT_RMS_THRESHOLD`
 * == GPU `vad.py::_DEF_ENERGY`,且 endpoint ≥ vad(三处同 int16 RMS 量纲)。CDK synth 期 `assertEndpointAboveVad`
 * 守门;此处 `loadTurnHandling()` 再在运行时校验 endpoint ≥ GPU VAD 阈值(env `AIM_VAD_ENERGY_THRESHOLD`),
 * 违背即 fail-fast(把守门下沉到运行时,避免 env 漂移)。端点延迟 MUST 为 fixed(静态可调),不引 dynamic/EMA。
 */

// design contract:L3 关联窗 ≥ 判定超时 的守门需要判定超时的**权威值** —— 从纯叶子取,消除本文件原先另抄的
//   `2_000` 默认与 `[500,8000]` 钳制(design contract 遗留的第二份可写副本)。
//   ★ 不成环:`bypass-llm-config` 是零本地 import 的纯叶子;且它**不是**会被 jest.mock() 的行为模块
//     (design contract 血教训:registry 曾从 `moderation-verdict` 取配置,partial mock 致加载期崩、炸 5 suite)。
import { BYPASS_LLM_TIMEOUT_DEFAULTS, eouVerdictTimeoutMs } from "./bypass-llm-config";

/** L3 关联窗相对判定超时的**余量**(ms)。关联窗 = 判定超时 + 此值。
 *
 *  为什么要余量而不取等号:取等号意味着「judge 恰在超时边界返回」必被丢弃(窗口零容错)。
 *  为什么是**派生**而非固定值:见 `TURN_HANDLING_DEFAULTS.eouCorrection.correlationMs` 注释 ——
 *  固定值会让「单边调大判定超时」破坏不变式并 fail-fast 崩启动。 */
export const EOU_CORRELATION_MARGIN_MS = 1_000;

export interface EndpointingConfig {
  /** 入向 RMS ≥ 此算「在说话」(int16 RMS 量纲);MUST == GPU VAD 阈值且 ≥ 之。 */
  rmsThreshold: number;
  /** 说完后静默多久判一轮结束(ms)。 */
  silenceGapMs: number;
  /** 至少说这么久才算有效一轮(ms),压短促底噪。 */
  minSpeechMs: number;
}

export interface InterruptionConfig {
  /** barge-in 声学阈值(远高于回声;int16 RMS)。固定阈值兜底/DTD 关时用。 */
  rmsThreshold: number;
  /** 连续高能量持续这么久才确认打断(ms)。 */
  confirmMs: number;
  /** 确认窗 hangover(ms):低于门槛的帧容忍这么久才把累计清零(0=关,单帧掉线即清零)。
   *  真人语音浊/清音交替,20ms 清音帧 RMS 常跌破门槛——旧「单帧掉线即清零」要求每一帧连续超阈,
   *  对真实语音过苛(真机识别率 ~36% 的贡献因素,部署验证:22 次重叠只触发 8 次)。
   *  hangover 内的低能量帧不累计也不清零(计时暂停);超过 hangover 才判定「插话已停」清零。 */
  hangoverMs: number;
  /** 打断内容门槛(design contract,**占位默认 0=关**):>0 需先补 barge-in 音频 buffer 或独立 AEC,
   *  否则 AI 播报期回声抑制喂静音、常规 ASR 窗内拿不到插话内容,无法实现。0 时纯声学门槛。 */
  minWords: number;
  // ── 误打断恢复(design contract,借鉴 LiveKit false_interruption_timeout,**默认关**)──:疑似 barge-in
  //   确认后**先暂停出声(tentative-pause)而非立即硬切**——服务端缓存后续 TTS 帧不下发(不 abort LLM/不
  //   reset sentencizer/不 gpu.cancel,活跃轮存活),启动恢复计时。窗内出现**有效接管信号**(无 AEC/buffer
  //   前只能声学近似:同一恢复 episode 内泄漏累计的高能量证据超 takeoverMs)→ 转确认打断走 engine.cancel 销毁;
  //   窗内无接管(一声「嗯」)→
  //   下行 resume 续发缓存音频、AI 照常说完,记 false_interruption。关闭时回退 design contract 保守硬切(现状)。
  /** 误打断恢复开关(默认关)。env AIM_FALSE_INTERRUPTION_RECOVERY=1 开。开时打断判定统一由服务端做
   *  (客户端禁用本地销毁性 barge_in,凭 ready 帧的 false_interruption_recovery 标志感知模式)。 */
  recoveryEnabled: boolean;
  /** 恢复计时窗上限(ms):tentative-pause 后窗内无确认接管即 resume(默认 2000,= LiveKit 2.0s)。 */
  recoveryWindowMs: number;
  /** 确认接管的声学门槛(ms):tentative-pause 所属 recovery episode 内泄漏累计的接管证据超此 = 真接管
   *  (高能量 +1ms/ms、低能量按 recoveryTakeoverDecay 线性衰减;无 AEC/buffer 前为声学近似、非内容判定)。
   *  须 > confirmMs(初判)、< recoveryWindowMs。默认 700。 */
  recoveryTakeoverMs: number;
  /** tentative-pause 低能量帧的线性衰减系数:每 1ms 低能量移除 recoveryTakeoverDecay ms 接管证据。
   *  默认 0.5:300ms 连续静默移除 150ms,短词间停顿仍可由密集高能量净累计追回。
   *  合法范围 [0.1,2.0]。env AIM_RECOVERY_TAKEOVER_DECAY。 */
  recoveryTakeoverDecay: number;
  /** design contract:恢复窗**能量域顺延**总时长硬上限(ms):tentative-pause 期每帧高能量重置恢复窗计时(把
   *  resume 推迟到"最后一次高能量后 recoveryWindowMs 静默"),但从暂停起点算超过此上限即强制 resume(防
   *  断续噪声无限 hold)。它与 recoveryTakeoverDecay 正交:顺延决定何时 resume,衰减区分密集语音与稀疏尖峰。
   *  0=关(退回现状固定 wall-clock,不顺延)。须 > recoveryWindowMs。env AIM_FALSE_INTERRUPTION_MAX_HOLD_MS。 */
  recoveryMaxHoldMs: number;
  // ── reference-aware 双讲检测 DTD(design contract)──:固定高阈值在「真人插话与 AI 回声能量重叠」下是死局
  //   (调高漏真人/调低自打断)。DTD 用 AI 回灌参考能量自适应阈值:AI 当前响 → 容忍回声、要求入向更高才算插话;
  //   AI 当前轻/静 → 低阈值即判插话。判据 = 入向 RMS ≥ max(dtdFloor, echoGain × 近端 AI 参考 RMS)。
  /** DTD 开关(默认开)。关 → 回退固定 rmsThreshold(design contract 行为)。 */
  dtdEnabled: boolean;
  /** DTD 地板阈值(int16 RMS):AI 静默时入向超此即算人声;远低于固定 rmsThreshold(可识别被回声重叠的真人)。 */
  dtdFloor: number;
  /** 回声增益估计:入向回声 ≈ echoGain × AI 参考 RMS。入向须超 echoGain×参考 才判「真人(双讲)」而非纯回声。 */
  dtdEchoGain: number;
  // ── 动态噪声地板(诊断 validation rationale;review 双 review 收敛)──
  //   真机根因:高底噪环境(会议室持续环境音,入向 p50≈1500 恒 > 固定 dtdFloor 700)→ AI 一开口就被环境
  //   噪声误判为打断、几乎说不出完整句(300 轮 metrics + 5 通录音双声道实证)。治法**不是**加第二道 AND 门
  //   (review 一致否决:DTD 已漏判多,AND 致召回雪崩),而是把**入向噪声基线喂进 DTD 的 floor 项**(单门
  //   自适应):effectiveFloor = max(dtdFloor, p20(近 windowMs 内 AI 静默帧入向 RMS) × k)。AI 静默时门槛随
  //   环境底噪抬高(治高底噪误打断),安静环境退回 dtdFloor(不伤真打断)。仍取 max(effectiveFloor, echoGain×
  //   AI参考)叠 DTD 回声项。**不根治结构化背景音/DTMF/瞬态**(纯能量域天花板,留 design contract 内容门槛)。
  /** 动态噪声地板开关(默认开)。关 → 固定 dtdFloor(design contract 行为)。env AIM_BARGE_DYN_FLOOR=0 关。 */
  dynFloorEnabled: boolean;
  /** 噪声基线统计窗(ms):取近此窗内 AI 静默帧入向 RMS 的 p20 分位作底噪估计(p20 天然抗语音尖峰污染)。 */
  dynFloorWindowMs: number;
  /** 噪声基线放大系数 k:effectiveFloor = max(dtdFloor, baseline×k)。k 越大越保守(高底噪压更狠、漏判风险升)。
   *  真机标定起点 1.5(模拟:正常通不伤、高底噪通误触发降 ~25%);env AIM_BARGE_DYN_FLOOR_K 可调。 */
  dynFloorK: number;
  // ── AI 开口冷却窗(design contract,借鉴 LiveKit start_cooldown,**默认关**)──:AI 刚开口瞬间 recentRefPeak
  //   基于滚动窗近空 → refPeak≈0 → bargeThreshold 塌到 effectiveFloor,叠加恒定 confirmMs,使开口 0~300ms 成
  //   最敏感期,用户顺口「嗯」易触发 tentative-pause 产生可闻停顿。冷却窗内对 bargeThreshold 结果乘系数抬门槛
  //   压制(**MUST NOT 抬 confirmMs**,守 design contract confirmMs<takeover<window 不变量;tentative-pause 期不应用)。
  /** 开口冷却窗时长(ms):AI 开口(aiSpeaking false→true)起这么久内抬高 barge 门槛。**默认 0=关**(遵循
   *  design contract recoveryEnabled 保守先例,部署验证标定后再定默认)。env AIM_BARGE_OPEN_COOLDOWN_MS。 */
  openCooldownMs: number;
  /** 冷却窗内 bargeThreshold 乘数(> 1 抬门槛)。默认 1.5;仅 openCooldownMs>0 时生效。env AIM_BARGE_OPEN_COOLDOWN_MULT。 */
  openCooldownMult: number;
}

// ── L3 旁路 LLM 文本 EOU 事后纠偏(design contract,**默认关**)──:静音到点 AI 乐观开口的**同刻**,异步问旁路
//   LLM「考生刚那句 asr_final 说完没」;判 incomplete 期间对该轮**降 barge 门槛**——让考生**亚常规阈**(不够触发
//   常规 barge-in 的)重新出声也能触发 tentative-pause 让位(复用 design contract 状态机,不新造暂停路径)。
//   MUST NOT 门控开口决策(判定比它要门控的开口还慢);只事后纠偏。任何失败/超时/stale → fail-open 不纠偏。
export interface EouCorrectionConfig {
  /** L3 开关。**默认开**(design contract B 类,由关改开;env `AIM_EOU_CORRECTION_ENABLED=0` 可作 kill switch 关)。
   *  ⚠ 前置门 = `interruption.recoveryEnabled`(design contract:L3 靠 tentative-pause 落地,recovery 关则无处纠偏)。
   *  两者同为 B 类默认开;若运维只关 recovery,`loadTurnHandling` 会**告警**(不静默保持 L3 开)。 */
  enabled: boolean;
  /** 纠偏**关联窗**(ms):旁路判定返回时刻距「该 user turn 的静音端点/AI 开口」超此则丢弃(判定已过时)。
   *  **默认 7000**(design contract:判定超时 6000 + 1000 余量)。env AIM_EOU_CORRELATION_MS。
   *
   *  ★ 与另两个时限的分工(design contract 解耦后,**三者语义互不相干,勿再共用一个值**):
   *    - 判定**请求超时** `AIM_EOU_VERDICT_TIMEOUT_MS`(默认 6000):等 judge 多久 —— 受跨境 TTFT 支配。
   *    - 本**关联窗**(默认 7000):judge 回来还算不算数 —— MUST ≥ 请求超时,**且留余量**
   *      (取等号则「judge 卡在超时边界返回」必被丢弃,窗口零容错)。`loadTurnHandling` fail-fast 守门。
   *    - **降门槛窗** `subThresholdWindowMs`(默认 2500):考生「反悔接话」的宽容期 —— **与跨境延迟无关**。 */
  correlationMs: number;
  /** L3 **降门槛窗**时长(ms):判 incomplete 后,在此窗内对该轮降低 barge 门槛,让考生亚阈续说也能让位。
   *  **默认 2500**(design contract 新增独立参数;设计决策取代码原意值,非线上实跑的 6000)。
   *
   *  ★ 为什么必须独立于 `correlationMs`(design contract,review 发现的真缺陷):
   *  原实现 `media-session.ts` 用 `EOU_CORRELATION_MS` 同时充当两者 —— 于是「为跨境把超时/关联窗调到 6000」
   *  会**顺带**把考生宽容期从 2500 拉长到 6000(2.4 倍),那是**行为改变**而非超时调整。两者语义毫不相干:
   *  关联窗由网络延迟决定,宽容期由「人思考停顿多久还算没说完」决定。停 6 秒已属「不会答」而非「话没说完」,
   *  超出 design contract「思考停顿」的定位。2500 与 `subThresholdMult=0.6`、下限 `ENDPOINT_RMS_THRESHOLD` 同批标定。
   *  env AIM_EOU_SUB_THRESHOLD_WINDOW_MS。 */
  subThresholdWindowMs: number;
  /** L3 专用「亚阈」barge 门槛系数(< 1,乘常规 barge 阈):判 incomplete 期间,考生重新出声只需达
   *  `常规阈 × subThresholdMult` 即可触发纠偏(比常规更敏感,但 ≥ 此低阈防纯噪声)。默认 0.6。
   *  env AIM_EOU_SUB_THRESHOLD_MULT(夹在 (0,1])。 */
  subThresholdMult: number;
}

export interface MeaningfulInputConfig {
  /** 触发一轮 LLM 前,本轮识别文本去标点/空白后的**最小有效字符数**(design contract)。不达标(空/纯标点/
   *  单残字)MUST NOT 触发 LLM(跳过本轮,记日志)。默认 2:足够低不误伤真人短开场(「你好」「在吗」均 2 字),
   *  又能挡门控解除后漏网的单字残识(治幻觉开场兜底)。env AIM_MIN_INPUT_CHARS 可调;0=关(不门槛)。 */
  minChars: number;
}

export interface ProactiveOpeningConfig {
  /** 主动开场开关(design contract)。开 → 会话建立后持续静默达 silenceMs 时 AI 主动开场一次;
   *  关 → 回退「被动等真人先开口」(design contract 现状)。env AIM_PROACTIVE_OPENING=0 关。 */
  enabled: boolean;
  /** 会话建立后,持续静默(无人先开口)多久即主动开场(ms)。太短抢真人话、太长冷场。env AIM_PROACTIVE_OPENING_SILENCE_MS。 */
  silenceMs: number;
}

export interface AiDoneWatchdogConfig {
  /** aiSpeaking=true 但已超过此 ms 无任何 AI 音频帧流出 → 强制恢复收听(覆盖「出过音频中途停」)。 */
  maxIdleMs: number;
}

export interface PlaybackClockConfig {
  /** design contract:播放后推进时钟以「客户端估算播完」为起点时的**超前量上限**(ms)。会话级队尾
   *  `estimatedClientPlaybackEndMs` 可能因「旧音频已被前端 R4 清但服务端未重置」虚高 → 推进被无限延迟;
   *  clamp 使超上限即按上限推进(有界保护:不无限等,也不因超上限退回 tts_done 起算失去保护)。默认 35000
   *  (覆盖真机最长 29.92s 追问音频 + 余量)。范围 [0,120000],守门 finite/非负/≤上限(非法钳到默认)。 */
  maxLeadMs: number;
  /** design contract:估算播完之上再加的**播完余量**(ms,网络传输 + 客户端 jitter/播放缓冲)。**独立参数**,
   *  不复用 farewell TAIL(语义不同:一个是挂断尾音、一个是推进宽限,避免耦合互扰)。默认 1000。
   *  范围 [0,5000],守门 finite/非负/≤上限(非法钳到默认)。 */
  leadMarginMs: number;
}

export interface AnswerGraceConfig {
  /** 从用户轮开始计的保守补充窗。0=关闭延迟推进。 */
  defaultMs: number;
  /** direct auto-next 在上一句估算播完后仍保留的最小补充窗。 */
  autoNextMs: number;
}

export interface QuestionProgressionConfig {
  /** 出题游标推进判据 (b)(design contract):判「本题已获有效作答」的对方输入**最小有效字符数**(去标点/空白后)。
   *  对方本轮有效字数 < 此(空轮/噪声/答非所问但字数不足)→ MUST NOT 推进游标。默认 4(略高于 meaningfulInput
   *  的 minChars=2 拒垃圾门槛——「作答」比「非垃圾输入」要求更实)。env AIM_QUESTION_MIN_ANSWER_CHARS 可调。
   *  **两分区单一事实源**:两区可覆盖数值但语义一致(不出现一区推进、一区不推进,design contract)。 */
  minAnswerChars: number;
  /** 出题游标推进判据 (d)(design contract):同一题因输入无效/澄清未完成而重问的次数达此上限后**强制推进**
   *  (防死循环卡到 max_duration)。默认 3。env AIM_QUESTION_MAX_RETRY 可调(须 ≥ 1)。 */
  maxRetryPerQuestion: number;
  /** design contract:每题正常完整播出的 AI 追问上限。与无效输入 retry 分离;0=有效作答后直接收口。
   *  env AIM_QUESTION_MAX_FOLLOW_UPS,合法整数 [0,5],默认 2。 */
  maxFollowUpsPerQuestion: number;
  /** design contract:强制收口/末题/terminal/post-terminal 整轮缓冲轮收到首 token 后等待 LLM 流完整结束的硬上限(ms)。
   *  流结束前不发 TTS,因而不能依赖 TTS/media watchdog。沿用 env AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS,
   *  范围 [1000,60000]。 */
  forceClosureStreamTimeoutMs: number;
}

export interface TurnHandling {
  endpointing: EndpointingConfig;
  interruption: InterruptionConfig;
  eouCorrection: EouCorrectionConfig;
  meaningfulInput: MeaningfulInputConfig;
  proactiveOpening: ProactiveOpeningConfig;
  aiDoneWatchdog: AiDoneWatchdogConfig;
  playbackClock: PlaybackClockConfig;
  answerGrace: AnswerGraceConfig;
  questionProgression: QuestionProgressionConfig;
}

// ── 默认值(MUST 与既有真机标定一致;改这里 = 改全栈行为)──
// rmsThreshold 默认 500:== constants.ts::ENDPOINT_RMS_THRESHOLD == GPU vad.py::_DEF_ENERGY(守 endpoint ≥ vad)。
/**
 * `AIM_MAX_PLAYBACK_LEAD_MS` 的合法钳制区间(design contract:**单一事实源**)。
 *
 * ⚠ 曾与 `playback-settlement.ts` 的 ACK 跨参数校验各写一套上界(此处 120000 / 那边 600000),
 * 致 env 落在 `[120000, 600000)` 时:推进时钟**静默回退默认 35000**(只 warn),而 ACK 校验
 * 却接受 200000 并因跨参数不变量**抛错崩启动** —— 同一个 env 两套判断、失败方式还不一样
 * (review)。两处 MUST 复用本常量。
 */
export const PLAYBACK_LEAD_BOUNDS = { min: 0, max: 120_000 } as const;

export const TURN_HANDLING_DEFAULTS: TurnHandling = {
  // endpointing.silenceGapMs = **1500**(design contract B 类,deployment validation 由 900 改):design contract 端点静音容忍,
  //   治「口试考生思考停顿被判说完 → AI 抢话」。部署验证 实跑 1500 且验通。
  //   ⚠ 不变量 `silenceGapMs ≥ GPU AIM_VAD_HANGOVER_MS`(GPU 代码默认 800)—— 1500 ≥ 800 ✓;
  //   CDK synth 期 `assertSilenceGapAboveHangover()` 守门(看门狗 MUST NOT 抢在 GPU VAD 自然端点前 flush)。
  endpointing: { rmsThreshold: 500, silenceGapMs: 1500, minSpeechMs: 300 },
  // DTD 默认开,值为 deployment validation Teams 真机经 SSM 标定后固化(原 confirmMs=400/floor=800/echoGain=0.7 在真机漏判,
  //   插话从不触发——AI 参考峰值 4500-6648,0.7×参考=3000-4600 门槛高于用户插话 RMS 2000-2600 → 死局):
  //   - confirmMs 400→200:确认窗减半,插话更快被认定(配合 P0 stop_play 即时停声,不怕短促误判)。
  //   - dtdFloor 800→700:AI 静默时入向超 700 即判人声(> 端点 500 噪声,可识别被回声重叠的真人)。
  //   - dtdEchoGain 0.7→0.3:会议桥回传的 AI 回声经混音/衰减/AGC,实测远 < 参考(混音后回声占比低,~30%);
  //     入向须超 0.3×参考才判双讲——压到用户插话 RMS 之下,插话才进得来。真机标定(barge-diag 日志校准)。
  // dynFloor(诊断 021-metrics-diagnosis-deployment validation):默认开,3s 窗 p20 × 1.5 抬高 dtdFloor 治高底噪误打断;
  //   k=1.5 为模拟起点(正常通触发 20→19 不伤、高底噪通 80→61 降误触发),**待真机标定固化**;env 可关回退固定 floor。
  // hangoverMs=60(3 帧 @20ms):容忍浊/清音交替的短暂 RMS 跌落,不再单帧掉线即清零(治确认窗
  //   对真实语音过苛致漏判);60ms 远短于「插话真停止」的静默(端点 gap 900ms),不引入误判。
  interruption: {
    rmsThreshold: 1500, confirmMs: 200, minWords: 0, hangoverMs: 60,
    dtdEnabled: true, dtdFloor: 700, dtdEchoGain: 0.3,
    dynFloorEnabled: true, dynFloorWindowMs: 3000, dynFloorK: 1.5,
    // 误打断恢复(design contract):**默认开**(design contract B 类,deployment validation 由关改开)。window=2s(= LiveKit)、
    // takeover=700ms(> confirmMs 200 初判、< window 2000),decay=0.5:高能量按 1:1 累加,低能量按
    // 0.5:1 衰减。300ms 静默移除 150ms 证据,短停顿可由密集语音追回,稀疏背景尖峰则无法跨静默累积。
    //
    // ★ 为什么改默认开:`infrastructure/lib/aim-stack.ts` 此前**硬编码** `AIM_FALSE_INTERRUPTION_RECOVERY: '1'`
    //   —— 线上**事实上早已恒开**,代码默认关只是个不生效的摆设(且是 design contract 要消灭的「第二份可写副本」)。
    //   本次把 CDK 硬编码删掉、默认值搬回此处,**行为等价重构**。它也是 L3 EOU 纠偏的前置门(design contract)。
    recoveryEnabled: true, recoveryWindowMs: 2000, recoveryTakeoverMs: 700, recoveryTakeoverDecay: 0.5,
    // design contract:恢复窗能量域顺延硬上限。**默认 5000**(design contract B 类,由 0=关 改为真机上线值)。
    //   断续插话可 hold 到「最后高能量后 window 静默」,但总不超此上限(防无限 hold)。
    //   5000 = 2.5× recoveryWindowMs,部署验证 实跑值。0 仍可经 env 设回(退固定 wall-clock)。
    recoveryMaxHoldMs: 5000,
    // AI 开口冷却窗(design contract):默认关(openCooldownMs=0)——遵循 recoveryEnabled 保守先例,北京区标定后再定。
    openCooldownMs: 0, openCooldownMult: 1.5,
  },
  // L3 旁路 EOU 纠偏(design contract):**默认开**(design contract B 类)。三个时限**各自独立**(design contract 解耦):
  //   关联窗 7000(= 判定超时 6000 + 1000 余量)/ 降门槛窗 2500(考生宽容期,与跨境延迟无关)/ 亚阈系数 0.6。
  //   前置门 = interruption.recoveryEnabled(亦已默认开);只关 recovery 会触发告警而非静默失效。
  eouCorrection: {
    enabled: true,
    // ★ **派生默认**(非字面量):判定超时 + 余量。**这是不变式的结构性保证** ——
    //   若写死 7000,则「只把 AIM_EOU_VERDICT_TIMEOUT_MS 调到合法上限 8000」(一个看起来完全合理的
    //   单边调参)会让 7000 < 8000 触发 fail-fast → **整个 rt 进程起不来**(实测复现)。
    //   派生后关联窗随超时自动上移,单边调超时不可能破坏不变式;仍可经 env 显式覆盖。
    correlationMs: EOU_CORRELATION_MARGIN_MS + BYPASS_LLM_TIMEOUT_DEFAULTS.eouVerdictMs,
    subThresholdWindowMs: 2500,
    subThresholdMult: 0.6,
  },
  // meaningfulInput.minChars=2(design contract):挡单字残识(空/纯标点/单残字不触发 LLM)。
  meaningfulInput: { minChars: 2 },
  // proactiveOpening(design contract):默认开,会话建立后静默 3s 无人开口即 AI 主动开场一次。
  proactiveOpening: { enabled: true, silenceMs: 3000 },
  aiDoneWatchdog: { maxIdleMs: 8000 },
  // playbackClock(design contract):播放后推进时钟超前量上限 35000(覆盖真机最长 29.92s 追问音频 + 余量),
  //   播完余量 1000(独立于 farewell TAIL)。参数在 spec 内定死,非实现细节。
  playbackClock: { maxLeadMs: 35000, leadMarginMs: 1000 },
  // 用户轮开始后至少保留 4s；direct auto-next 同时保证上一句估算播完后仍留 800ms。
  answerGrace: { defaultMs: 4000, autoNextMs: 800 },
  // questionProgression(design contract 出题游标):minAnswerChars=4(> 拒垃圾门槛 2:「作答」比「非垃圾」严);
  //   maxRetryPerQuestion=3(同一题至多重问 3 次后强制推进,防死循环卡到 max_duration)。
  questionProgression: {
    minAnswerChars: 4,
    maxRetryPerQuestion: 3,
    maxFollowUpsPerQuestion: 2,
    forceClosureStreamTimeoutMs: 15_000,
  },
};

/** 「kill switch」型布尔:默认开,**宽松识别关闭意图**(`0`/`false`/`off`/`no`,大小写与空白不敏感)。
 *
 *  ★ 为什么不用裸 `!== "0"`(design contract,review 实证):裸口径只认字面 `"0"`,于是运维写
 *  `AIM_FALSE_INTERRUPTION_RECOVERY=false` 想关掉时**实际反而开着** —— kill switch 静默失效。
 *  这两个 flag 都是「出问题时救命」用的(recovery 还是声纹锁定与 EOU 的前置门),拧不动最危险。
 *
 *  ⚠ 仍**不**把空串/空白当关闭:`X=""` 多是脚本失误(变量存在未赋值),当成「关掉保护」比
 *  「保持默认开」更危险。与 `media-config.ts::boolKillSwitch` 同一口径(两处刻意一致)。 */
function boolKillSwitch(envKey: string): boolean {
  const raw = (process.env[envKey] ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** 数字 env 解析:未设/空串 → 默认;非法(NaN)→ 默认(不静默变 0,沿用既有 `Number(env ?? d)` 容错口径)。 */
function num(envKey: string, def: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}

/** 带范围的数字 env 解析(design contract):未设/空串/非法(NaN/超范围 [min,max])→ 默认(不静默放行脏值)。
 *  与 num() 的区别:num 只挡 NaN,此额外挡「有限但越界」——超前量/余量的上限是硬保护,越界值必须钳到默认。 */
function numBounded(envKey: string, def: number, min: number, max: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    console.warn(`[turn-handling] ${envKey}=${raw} 非法(须 finite 且 ∈ [${min},${max}])→ 回退默认 ${def}。`);
    return def;
  }
  return v;
}

/** 有界整数 env:未设/非法/小数/越界均回退默认。 */
function intBounded(envKey: string, def: number, min: number, max: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    console.warn(`[turn-handling] ${envKey}=${raw} 非法(须为整数且 ∈ [${min},${max}])→ 回退默认 ${def}。`);
    return def;
  }
  return v;
}

/**
 * 加载 TurnHandling 配置(env 覆盖默认)。运行时守单一事实源不变式:endpoint.rmsThreshold ≥ GPU VAD 阈值。
 * 违背即抛(fail-fast)——350-500 错配区致空 turn_end / AI 不回话(真机根因),不可静默放行。
 */
export function loadTurnHandling(): TurnHandling {
  const cfg: TurnHandling = {
    endpointing: {
      rmsThreshold: num("AIM_ENDPOINT_RMS_THRESHOLD", TURN_HANDLING_DEFAULTS.endpointing.rmsThreshold),
      silenceGapMs: num("AIM_ENDPOINT_SILENCE_GAP_MS", TURN_HANDLING_DEFAULTS.endpointing.silenceGapMs),
      minSpeechMs: num("AIM_ENDPOINT_MIN_SPEECH_MS", TURN_HANDLING_DEFAULTS.endpointing.minSpeechMs),
    },
    interruption: {
      rmsThreshold: num("AIM_BARGE_RMS_THRESHOLD", TURN_HANDLING_DEFAULTS.interruption.rmsThreshold),
      confirmMs: num("AIM_BARGE_CONFIRM_MS", TURN_HANDLING_DEFAULTS.interruption.confirmMs),
      hangoverMs: num("AIM_BARGE_HANGOVER_MS", TURN_HANDLING_DEFAULTS.interruption.hangoverMs),
      minWords: num("AIM_INTERRUPTION_MIN_WORDS", TURN_HANDLING_DEFAULTS.interruption.minWords),
      dtdEnabled: process.env.AIM_BARGE_DTD !== "0", // 默认开;=0 关回退固定阈值
      dtdFloor: num("AIM_BARGE_DTD_FLOOR", TURN_HANDLING_DEFAULTS.interruption.dtdFloor),
      dtdEchoGain: num("AIM_BARGE_DTD_ECHO_GAIN", TURN_HANDLING_DEFAULTS.interruption.dtdEchoGain),
      dynFloorEnabled: process.env.AIM_BARGE_DYN_FLOOR !== "0", // 默认开;=0 关回退固定 dtdFloor
      dynFloorWindowMs: num("AIM_BARGE_DYN_FLOOR_WINDOW_MS", TURN_HANDLING_DEFAULTS.interruption.dynFloorWindowMs),
      dynFloorK: num("AIM_BARGE_DYN_FLOOR_K", TURN_HANDLING_DEFAULTS.interruption.dynFloorK),
      // 误打断恢复(design contract):**默认开**(design contract B 类);`=0` 关作 kill switch。
      // ★ 口径必须随默认值一起翻转:原为 `=== "1"`(默认关口径)—— 若只改 DEFAULTS 而留 `=== "1"`,
      //   未设 env 时恒 false,默认值改了也**永远不生效**(这类「改了默认却被解析口径压掉」是该设计约束
      //   要防的同族陷阱)。现改 `!== "0"`,与 dtdEnabled/dynFloorEnabled 等既有默认开项同口径。
      recoveryEnabled: boolKillSwitch("AIM_FALSE_INTERRUPTION_RECOVERY"),
      recoveryWindowMs: num("AIM_FALSE_INTERRUPTION_WINDOW_MS", TURN_HANDLING_DEFAULTS.interruption.recoveryWindowMs),
      recoveryTakeoverMs: num("AIM_FALSE_INTERRUPTION_TAKEOVER_MS", TURN_HANDLING_DEFAULTS.interruption.recoveryTakeoverMs),
      recoveryTakeoverDecay: num(
        "AIM_RECOVERY_TAKEOVER_DECAY",
        TURN_HANDLING_DEFAULTS.interruption.recoveryTakeoverDecay,
      ),
      // design contract:恢复窗能量域顺延硬上限,默认 5000(design contract);设 0 退回固定 wall-clock 恢复窗。
      recoveryMaxHoldMs: num("AIM_FALSE_INTERRUPTION_MAX_HOLD_MS", TURN_HANDLING_DEFAULTS.interruption.recoveryMaxHoldMs),
      // AI 开口冷却窗(design contract):默认 0=关;env 标定后开。
      openCooldownMs: num("AIM_BARGE_OPEN_COOLDOWN_MS", TURN_HANDLING_DEFAULTS.interruption.openCooldownMs),
      openCooldownMult: num("AIM_BARGE_OPEN_COOLDOWN_MULT", TURN_HANDLING_DEFAULTS.interruption.openCooldownMult),
    },
    meaningfulInput: {
      minChars: num("AIM_MIN_INPUT_CHARS", TURN_HANDLING_DEFAULTS.meaningfulInput.minChars),
    },
    proactiveOpening: {
      enabled: process.env.AIM_PROACTIVE_OPENING !== "0", // 默认开;=0 关回退被动等待
      silenceMs: num("AIM_PROACTIVE_OPENING_SILENCE_MS", TURN_HANDLING_DEFAULTS.proactiveOpening.silenceMs),
    },
    aiDoneWatchdog: {
      maxIdleMs: num("AIM_AI_SPEAKING_MAX_IDLE_MS", TURN_HANDLING_DEFAULTS.aiDoneWatchdog.maxIdleMs),
    },
    playbackClock: {
      // design contract:守门 finite/非负/≤上限(与其它 turn-handling 守门同款,非法钳到默认)。CDK 条件透传。
      maxLeadMs: numBounded("AIM_MAX_PLAYBACK_LEAD_MS", TURN_HANDLING_DEFAULTS.playbackClock.maxLeadMs,
        PLAYBACK_LEAD_BOUNDS.min, PLAYBACK_LEAD_BOUNDS.max),
      leadMarginMs: numBounded("AIM_PLAYBACK_LEAD_MARGIN_MS", TURN_HANDLING_DEFAULTS.playbackClock.leadMarginMs, 0, 5_000),
    },
    answerGrace: {
      defaultMs: numBounded("AIM_ANSWER_GRACE_MS", TURN_HANDLING_DEFAULTS.answerGrace.defaultMs, 0, 10_000),
      autoNextMs: numBounded("AIM_AUTO_NEXT_GRACE_MS", TURN_HANDLING_DEFAULTS.answerGrace.autoNextMs, 0, 10_000),
    },
    questionProgression: {
      minAnswerChars: num("AIM_QUESTION_MIN_ANSWER_CHARS", TURN_HANDLING_DEFAULTS.questionProgression.minAnswerChars),
      maxRetryPerQuestion: num("AIM_QUESTION_MAX_RETRY", TURN_HANDLING_DEFAULTS.questionProgression.maxRetryPerQuestion),
      maxFollowUpsPerQuestion: intBounded(
        "AIM_QUESTION_MAX_FOLLOW_UPS",
        TURN_HANDLING_DEFAULTS.questionProgression.maxFollowUpsPerQuestion,
        0,
        5,
      ),
      forceClosureStreamTimeoutMs: numBounded(
        "AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS",
        TURN_HANDLING_DEFAULTS.questionProgression.forceClosureStreamTimeoutMs,
        1_000,
        60_000,
      ),
    },
    eouCorrection: {
      // **默认开**(design contract B 类);`=0` 关作 kill switch。口径同 recoveryEnabled 一起翻转(见其注释)。
      enabled: boolKillSwitch("AIM_EOU_CORRECTION_ENABLED"),
      // ★ 关联窗默认**跟随生效判定超时**(而非跟随超时的*默认值*):运维只调
      //   `AIM_EOU_VERDICT_TIMEOUT_MS` 时,关联窗自动上移保持不变式;显式设本 env 则以显式值为准
      //   (此时若破坏不变式,fail-fast 是**正确**的 —— 那是运维明确写下的两个互斥数字)。
      correlationMs: num(
        "AIM_EOU_CORRELATION_MS",
        eouVerdictTimeoutMs() + EOU_CORRELATION_MARGIN_MS,
      ),
      // design contract:降门槛窗**独立于**关联窗(此前共用 correlationMs,致「调超时顺带改宽容期」)。
      subThresholdWindowMs: num(
        "AIM_EOU_SUB_THRESHOLD_WINDOW_MS",
        TURN_HANDLING_DEFAULTS.eouCorrection.subThresholdWindowMs,
      ),
      // 亚阈系数夹在 (0,1]:>1 无意义(比常规还高就不叫降门槛)、≤0 会让任何噪声都触发。非法回退默认 0.6。
      subThresholdMult: (() => {
        const v = num("AIM_EOU_SUB_THRESHOLD_MULT", TURN_HANDLING_DEFAULTS.eouCorrection.subThresholdMult);
        return v > 0 && v <= 1 ? v : TURN_HANDLING_DEFAULTS.eouCorrection.subThresholdMult;
      })(),
    },
  };
  // 单一事实源守门(下沉自 CDK assertEndpointAboveVad):Bridge 端点阈值 MUST ≥ GPU VAD 阈值。
  const vad = num("AIM_VAD_ENERGY_THRESHOLD", TURN_HANDLING_DEFAULTS.endpointing.rmsThreshold);
  if (cfg.endpointing.rmsThreshold < vad) {
    throw new Error(
      `[turn-handling] 端点阈值(${cfg.endpointing.rmsThreshold})< GPU VAD 阈值(${vad}),` +
        `违反不变式 endpoint ≥ vad。350-500 错配区致空 turn_end / AI 不回话(真机根因)。` +
        `调高 AIM_ENDPOINT_RMS_THRESHOLD 或调低 AIM_VAD_ENERGY_THRESHOLD。`,
    );
  }
  // 误打断恢复不变式(design contract + design contract):takeover 须 **confirmMs < takeover < window**。仅开启时校验,违背 fail-fast。
  //  - takeover < window:否则永远等不到 takeover 命中即先超窗 resume → 恒不销毁,真接管也被误当误打断;
  //  - takeover > confirmMs:takeover 累计从 confirmMs 起继续(pause 后不清零),≤ confirmMs 则初判命中同刻即
  //    判真接管 = tentative-pause 形同虚设(评审/gp M2:此前只注释未守,env 误配 takeover≤confirmMs 会静默失效)。
  if (cfg.interruption.recoveryEnabled) {
    if (cfg.interruption.recoveryTakeoverMs >= cfg.interruption.recoveryWindowMs) {
      throw new Error(
        `[turn-handling] 误打断恢复 takeover(${cfg.interruption.recoveryTakeoverMs}ms)≥ window` +
          `(${cfg.interruption.recoveryWindowMs}ms),违反不变式 takeover < window(真接管会被误当误打断 resume)。`,
      );
    }
    if (cfg.interruption.recoveryTakeoverMs <= cfg.interruption.confirmMs) {
      throw new Error(
        `[turn-handling] 误打断恢复 takeover(${cfg.interruption.recoveryTakeoverMs}ms)≤ confirmMs` +
          `(${cfg.interruption.confirmMs}ms),违反不变式 takeover > confirmMs(初判命中即判真接管,tentative-pause 形同虚设)。`,
      );
    }
    // 线性衰减须为正,否则 0 会退化回单调累计、负数会让低能量反向增长;上限防短自然停顿过快抹除真人证据。
    if (cfg.interruption.recoveryTakeoverDecay < 0.1 || cfg.interruption.recoveryTakeoverDecay > 2.0) {
      throw new Error(
        `[turn-handling] 误打断恢复 recoveryTakeoverDecay(${cfg.interruption.recoveryTakeoverDecay})` +
          `超出合法范围 [0.1,2.0]。` +
          `负值会让低能量帧反向增加接管证据,0 会退化回稀疏噪声单调累计,过大则会误伤真人短停顿。` +
          `调整 AIM_RECOVERY_TAKEOVER_DECAY。`,
      );
    }
    // design contract:aiSpeaking 安全看门狗兜底窗(maxIdleMs)MUST > 误打断恢复窗(recoveryWindowMs)。
    //   这是**配置合理性守门**(非防竞态充分条件——竞态已由 watchdogTick 在 tentativePausing 期间跳过消除):
    //   看门狗兜底"AI 莫名早停"本就该显著慢于一次正常的误打断恢复窗,否则语义颠倒(兜底比正常恢复还快)。
    //   暂停期 lastAiAudioAtMs 冻结,若 maxIdleMs ≤ recoveryWindowMs,一旦 R1 看门狗跳过因故失效即立刻误触发。
    if (cfg.aiDoneWatchdog.maxIdleMs <= cfg.interruption.recoveryWindowMs) {
      throw new Error(
        `[turn-handling] aiDoneWatchdog.maxIdleMs(${cfg.aiDoneWatchdog.maxIdleMs}ms)≤ 误打断恢复窗 ` +
          `recoveryWindowMs(${cfg.interruption.recoveryWindowMs}ms),违反不变式 maxIdleMs > recoveryWindowMs。` +
          `看门狗兜底窗宜**显著大于**恢复窗(留足缓冲,如至少 2×),否则语义颠倒(早停兜底比正常误打断恢复还快)。` +
          `调高 AIM_AI_SPEAKING_MAX_IDLE_MS 或调低 AIM_FALSE_INTERRUPTION_WINDOW_MS。`,
      );
    }
  }
  // design contract 前置门(评审/review 依赖 design contract tentative-pause):L3 开但误打断恢复关 →
  //   无 tentative-pause 可落纠偏,L3 判 incomplete 也无处暂停 → **降门槛后的重新出声会走常规 barge-in
  //   销毁性硬切**(而非期望的可恢复暂停),语义不符。不 fail-fast(L3 本就 fail-open 设计、不该阻断启动),
  //   但 warn 提示配置很可能是误配(开 L3 却忘开 recovery)。
  // ★ design contract:两者现在**同为默认开**,故此告警的触发场景变了 —— 从「开 L3 却忘开 recovery」
  //   变成「**显式关掉 recovery(kill switch)而 L3 仍开**」。这正是评审关心的组合:不可关的消费者
  //   依赖可关的前置。此处保持 warn 而非 fail-fast(L3 本就 fail-open 设计、不该阻断启动),但措辞
  //   MUST 明确指出 L3 已因前置门关闭而**不生效**,避免运维以为「L3 还开着」。
  if (cfg.eouCorrection.enabled && !cfg.interruption.recoveryEnabled) {
    console.warn(
      `[turn-handling] L3 EOU 纠偏仍开,但误打断恢复(AIM_FALSE_INTERRUPTION_RECOVERY=0)已被显式关闭 —— ` +
        `L3 依赖 tentative-pause 落地(design contract 前置门),recovery 关时**L3 实际不生效**` +
        `(降门槛后的重新出声会走常规销毁性硬切,而非期望的可恢复暂停)。` +
        `若确实要关 recovery,建议同时设 AIM_EOU_CORRECTION_ENABLED=0 以免误以为纠偏仍在工作。`,
    );
  }
  // design contract 超时/关联窗联动守门(部署验证标定 deployment validation):关联窗 MUST ≥ 请求超时,否则 judge 卡到超时
  //   边界才返回时必已超关联窗被丢弃 → L3 恒不生效(真机实证:2s 超时 + 2.5s 关联窗,跨境 judge 3-6s 才回 →
  //   要么先超时 fail-open、要么回来超关联窗丢弃,两头都不纠偏)。
  //
  // ★ design contract 两处修正:
  //   ① **消除第二份硬编码**(原为 `num("AIM_EOU_VERDICT_TIMEOUT_MS", 2_000)` + `Math.min(8_000, Math.max(500,…))`
  //      —— 默认值与钳制范围都在此另写了一份)。现直接调 `bypass-llm-config` 叶子的同一个解析器:
  //      默认值与钳制各只有一份。**不成环**:`bypass-llm-config` 是纯叶子(零本地 import),
  //      且**不是**会被 `jest.mock()` 的行为模块(design contract 血教训:从 `eou-verdict` 取配置会炸 5 suite)。
  //   ② **warn → 自愈钳制**(而非 fail-fast,亦非「只 warn 带病运行」——见下三方权衡)。
  //
  // ★★ 三方权衡(review 指出 fail-fast 的爆炸半径,实证成立但其修法不采纳):
  //
  //   - **只 warn 带病运行**(design contract 前的原状):L3 恒不生效却毫无阻碍地跑 —— 正是该设计约束 要
  //     消灭的失败形状(不报错、测试全绿、功能悄悄没了)。**否决**。
  //   - **fail-fast 抛错**(design contract T3 首版):响亮,但**爆炸半径过大** —— `RC` 在模块加载期求值
  //     (`runtime-config.ts` 顶层 `build()`),故非法组合会让**整个 rt 进程起不来**,连
  //     `/rt/config` 诊断端点一起挂 → 运维失去排障手段(已实证:非法 env 下 `require('./media-session')`
  //     直接抛)。用「起不来」换「配置正确」,在唯一真机环境(北京)代价过高。**否决**。
  //   - **✅ 自愈钳制 + 响亮告警**(本实现):把关联窗抬到合法值(判定超时 + 余量)并 `console.error`。
  //     这与本文件对非法 env 的**既有惯例一致**(`num`/`numBounded`/`intBounded` 皆「warn + 回退默认」,
  //     `minWords>0` 亦「告警并强制回退 0,不假装生效」)。服务照常起、诊断端点可查、L3 **真的生效**
  //     (而非静默失效),且日志里有一条无法忽视的 error。三个目标同时达成,无一牺牲。
  //
  //   ⚠ 注意这**不是**退回「静默」:静默的定义是「行为错了而没有信号」。此处行为被修正到正确值,
  //     且留下 error 级日志 —— 与「warn 完继续用错的值」有本质区别。
  if (cfg.eouCorrection.enabled) {
    const verdictTimeout = eouVerdictTimeoutMs();
    if (cfg.eouCorrection.correlationMs < verdictTimeout) {
      const healed = verdictTimeout + EOU_CORRELATION_MARGIN_MS;
      console.error(
        `[turn-handling] 配置错误(已自愈):L3 关联窗 correlationMs(${cfg.eouCorrection.correlationMs}ms)` +
          `< 判定超时 verdictTimeout(${verdictTimeout}ms),违反不变式 关联窗 ≥ 判定超时 —— ` +
          `judge 卡到超时边界才返回时必已超关联窗被丢弃,L3 会恒不生效。` +
          `**已自动抬到 ${healed}ms**(判定超时 + ${EOU_CORRELATION_MARGIN_MS}ms 余量)以保证 L3 真生效;` +
          `请修正 AIM_EOU_CORRELATION_MS(≥ ${healed})或调小 AIM_EOU_VERDICT_TIMEOUT_MS,勿依赖自愈。`,
      );
      cfg.eouCorrection.correlationMs = healed;
    }
  }
  // minWords 占位守门(design contract):>0 需先补 barge-in 音频 buffer / 独立 AEC(回声抑制喂静音致常规 ASR 拿不到
  // 插话内容)。在那之前若误设 >0,告警并强制回退 0,不假装生效。
  if (cfg.interruption.minWords > 0) {
    console.warn(
      `[turn-handling] interruption.minWords=${cfg.interruption.minWords} 暂未启用(需先补 barge-in 音频 buffer ` +
        `或独立 AEC;AI 播报期回声抑制喂静音,常规 ASR 拿不到插话内容)→ 强制回退 0(纯声学门槛)。`,
    );
    cfg.interruption.minWords = 0;
  }
  // 出题游标(design contract):maxRetryPerQuestion 须 ≥ 1(否则同题 0 次重问即强推 = 从不给对方作答机会);
  //   误设 < 1 或非法 → 钳到 1(fail-safe,不中断会话:游标推进是产品行为,不宜为脏 env 拒服务)。
  if (!Number.isFinite(cfg.questionProgression.maxRetryPerQuestion) || cfg.questionProgression.maxRetryPerQuestion < 1) {
    console.warn(
      `[turn-handling] questionProgression.maxRetryPerQuestion=${cfg.questionProgression.maxRetryPerQuestion} 非法(须 ≥ 1)→ 钳到 1。`,
    );
    cfg.questionProgression.maxRetryPerQuestion = 1;
  }
  return cfg;
}
