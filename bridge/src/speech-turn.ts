/**
 * SpeechTurn —— 一轮 AI 发言的生命周期对象(design contract)。
 *
 * 把此前散落在 `ThreeStageEngine` 实例字段上的轮级状态(`llmBusy` / `ttsPending` / `llmStreamComplete` /
 * `abort` + metrics 累加器)收敛为单一对象,并把隐性不变量显式化。**纯状态容器 + 同步方法**,无 async、
 * 无锁(延续单线程模型);不引调度器/优先级队列(AIM 是 1:1 单人严格一轮一轮)。
 * **例外**:语义挂断信号 `endCallSignaled` **故意**留在引擎级(`ThreeStageEngine.endCallSignaled`,非本类)——
 * media-session 在 onAiDone **之后**才查询 `wantsEndCall()`,彼时 `activeTurn` 可能已被 cancel 清空,
 * 故须引擎级持有、跨轮对象生命周期可读(design contract 删除了本类曾遗留的同名死字段)。
 *
 * 不变量(由 ThreeStageEngine 编排保证,见其注释):
 *  - **至多一个活跃 SpeechTurn**:引擎持有 `activeTurn: SpeechTurn | null`;null = 空闲(等价旧 `llmBusy=false`)。
 *    新 turn_end 到达时若已有活跃轮则忽略,不抢占、不改写其状态(防连续 turn_end 死锁)。
 *  - **谁创建谁负责清理**(身份守尾):`runLlmTurn` 的 finally 用**对象身份**(`this.activeTurn === turn`)判断
 *    「我仍是当前持有者」才清空 activeTurn;被 cancel 抢占方(activeTurn 已被换走/置空)不重复清理。
 *    这等价于旧实现的 `this.abort === abort` 身份判断,但更直观(对象本身即身份)。
 *  - **onAiDone 恰好一次且必然触发**:整轮播完 / 被打断 / 异常 / TTS 超时,任一路径都经引擎触发恰好一次;
 *    SpeechTurn 用 `aiDoneFired` 守「恰好一次」,`metricsReported` 守 metrics「恰好一次」。
 */
import {
  ResponseCoreTerminalStatus,
  ResponseSegmentDeclared,
} from "./voice-engine";
import { GpuTtsSegmentMetrics } from "./turn-metrics";

export class SpeechTurn {
  /** 取消句柄(沿用 AbortController);停 Bedrock 流。 */
  readonly abort = new AbortController();
  /** 本轮未完成的 tts_text 句数:每发一句 +1,每收一个 tts_done -1。归零 + 流出完 = 整轮播完。 */
  ttsPending = 0;
  /** 本轮 LLM 流是否已出完(B3 门:LLM 慢、GPU 快时句间空窗不能误触发 onAiDone)。 */
  llmStreamComplete = false;
  /** runLlmTurn 是否已返回(= 旧 `llmBusy` 清零时机):**注意区别于 llmStreamComplete**。
   *  llmReturned 标记「LLM 执行已结束、可起新轮」(旧 llmBusy=false),但本轮 TTS 可能仍在 drain
   *  (tts_done 在 finally 之后才到)。busy 守门读 `!llmReturned`;对象本身存活到 onAiDone(playback 终点)。 */
  llmReturned = false;
  /** onAiDone 是否已触发(守「恰好一次」)。 */
  aiDoneFired = false;
  /** design contract:本轮唯一 core terminal；fireAiDone 在 observer 回调前固定其最终值。 */
  terminalStatus?: ResponseCoreTerminalStatus;
  terminalReason?: string;
  /** 本轮 metrics 是否已上报(守「恰好一次」)。 */
  metricsReported = false;
  /** 本轮是否因引擎级 TTS 超时(GPU「只收不回」)被自终结(metrics 可观测标志;非致命,不拆机)。 */
  ttsTimedOut = false;
  /** 本轮是否因 LLM 流异常(跨境抖动/超时/429)降级为本轮失败(metrics 可观测;非致命,不拆机,会话继续)。 */
  llmFailed = false;
  /** 本轮是否因 LLM 首 token 超时被主动 abort(区别于用户打断的 AbortError:此标志下 catch 仍走降级)。 */
  ttftTimedOut = false;
  /** design contract:整轮缓冲的强制收口/terminal 轮首 token 后未在硬上限内结束流,被主动 abort。 */
  bufferedStreamTimedOut = false;
  /** 本轮 LLM 是否发生了主备 fallback 切换(design contract;供 metrics 分析主 provider 降级率)。 */
  llmFallback = false;
  /** 本轮 LLM 实际出声的模型 id(fallback 后 = 备用;无 fallback 时留空,metrics 落 llmModelId)。 */
  llmModelUsed?: string;

  // ── 出题游标推进上下文(design contract)──:正常完成路径(maybeFireAiDone)据此评估游标是否 +1。
  /** 本轮触发输入(= 对方说的话);判据 (b) 据其有效字数判「本题是否已作答」。kickoff 轮为唤醒文本。 */
  userText = "";
  /** 本轮是否是主动开场(kickoff):对方未作答,MUST NOT 据此推进游标。 */
  isKickoff = false;
  /** 游标推进后由题库原文直接下发的 TTS 轮。无 LLM，但播放完成前仍须阻止 turn_end 替换 activeTurn。 */
  isDirectAutoNext = false;
  /** design contract:本轮 AI 所问题号的**事件快照**(SpeechTurn 创建=runLlmTurn 建 turn 时捕获的 0-based 游标)。
   *  commitAiText 落库 speaker=ai 转写时用此、**不用** commitAiText 执行时的全局 cursor——AI 念完当前题后
   *  会先推进游标再 fireAiDone→commitAiText,那时读全局 cursor 会把本题 AI 文本误标下一题(design contract Blocker)。
   *  越界(cursor>=len)/ 无题(len===0)→ undefined(不落 question_index 字段,稀疏)。 */
  questionIndexSnapshot?: number;
  /** 本轮创建时当前题是否已逐字完整下发且前轮正常完成。用于切换 prompt 并抑制违约逐字重问。 */
  questionAlreadyVoicedAtStart = false;
  /** 当前题此前在客户端估算播放结束前被用户开口打断。允许 LLM 在非实质回答时重新完整问当前题。 */
  questionPlaybackInterruptedAtStart = false;
  /** 同轮重复题干抑制日志至多一次。 */
  repeatedQuestionSuppressed = false;
  /** 出题游标推进后需在本轮 onAiDone 后**直接下发下一题 TTS 轮**(design contract(b))。仅正常完成路径(maybeFireAiDone)
   *  在「真推进 + 未到末题 + 无语义挂断」时置;fireAiDone 在触发 onAiDone(activeTurn 已 null)后消费。
   *  被打断轮(cancel 路径)不置;maybeAutoAskNext 再以 interrupted/activeTurn 守门,双保险不误发。 */
  autoNextAfterDone = false;
  /** design contract:本轮在追问预算耗尽后必须缓冲校验并确定性收口。 */
  forceQuestionClosure = false;
  /** design contract:本轮消费了 terminal-completion pending；仅此身份可交付/重试 terminal latch。 */
  isTerminalCompletion = false;
  /** design contract:terminal 已交付后的真实用户补充轮；整轮缓冲以阻止重复整场总结。 */
  isPostTerminalFollowup = false;
  /** 本轮是否**有资格驱动游标推进**(design contract)。默认 true(正常轮)。**仅** design contract 排水消费到**跨题界/念出前
   *  陈货**(捕获时游标身份/voiced 快照与消费时不符)起的 verify 轮置 false —— 该轮照常回应考生(不丢输入),
   *  但其完成 MUST NOT 驱动 maybeAdvanceCursor 推进(否则「答上一题的续说」会把当前题跳过,考生拿不到答当前题
   *  的窗口,部署回归)。maybeAdvanceCursor 顶部据此早返回,早于任何 advance/retry/decline/farewell
   *  副作用(review:门 MUST NOT 只加在 advanceIfVoiced,否则 decline/retry 直推分支绕过)。 */
  cursorAdvanceEligible = true;

  // ── 打断后上下文对齐(design contract)──:本轮**已下发给 TTS**(dispatchTtsText)的句子累加(已 strip 哨兵)。
  //   被 barge_in 打断时,写进 history / 转写的 assistant 内容取此(≈ 用户实际听到的部分)+ 截断标记,
  //   而非 LLM 完整 fullText(可能远多于播出)也非整轮丢弃。正常播完的轮不用它(仍写完整 reply)。
  //   注:「已下发」略多于「真听到」(GPU 合成队列 + 客户端播放缓冲的在途量);精确听到位置需客户端回报播放
  //   进度,当前协议无此字段(design contract 明示不做),取「已下发」为可实现的对齐基准。
  dispatchedText = "";
  /** 本轮 AI 文本是否已写入 history / 转写(守「至多一次」):正常路径在流末写,barge_in 打断路径在 cancel 写,
   *  二者互斥——先发生的置位,后发生的不重复写(避免同轮 assistant 内容双写污染 history)。 */
  historyWritten = false;
  /** design contract:本轮是否已发过「轮媒体起点」信号(onTurnAudioBegin,= 首个下行 binary 之前)。守「每轮一次」,
   *  且据此决定 fireAiDone 是否发「轮媒体终点」(onTurnAudioEnd):没产生过音频的轮不发 start/end(R2)。
   *  暂停期音频被缓存不下发 → begin 不提前发,resume 续发首帧才发(begin MUST 紧前于真实首个下行 binary)。 */
  audioBeginSent = false;
  /** LLM 流完的完整 reply 暂存(design contract,候选 A):`runLlmTurn` 流完时**不立即** commit,而是暂存到此;
   *  待该轮真正终结(`fireAiDone` 内、`aiDoneCb()` 之前)才 commit。这样"LLM 已完成、音频未播完时被确认
   *  打断"的窗口里,cancel 的 design contract 截断分支(`!historyWritten` 守卫)仍可写截断版——不再被"流末即
   *  写完整 history"抢先置 historyWritten 挡掉。undefined = 尚未流完 / 无待落库(流式中被打断、异常终结)。 */
  pendingReply?: string;

  // ── design contract TTS segment identity ──
  private nextSegmentId = 1;
  private readonly pendingSegments: ResponseSegmentDeclared[] = [];

  /** 按 GPU 单消费者顺序声明一个 TTS segment。 */
  declareSegment(text: string): ResponseSegmentDeclared {
    const segment = {
      responseGeneration: this.index,
      turnSeq: this.index,
      segmentId: this.nextSegmentId,
      text,
    };
    this.nextSegmentId += 1;
    this.pendingSegments.push(segment);
    return segment;
  }

  /** GPU audio 始终归属尚未收到 tts_done 的队首 segment。 */
  currentSegment(): ResponseSegmentDeclared | undefined {
    return this.pendingSegments[0];
  }

  /** 一个 tts_done 只完成并移除队首 segment。 */
  completeSegment(): ResponseSegmentDeclared | undefined {
    return this.pendingSegments.shift();
  }

  /** cancelled/failed generation 不再保留尚未交付的 segment boundary。 */
  retireSegments(): void {
    this.pendingSegments.length = 0;
  }

  // ── 实时性 metrics 累加器(design contract,旁路)──
  readonly startedAt: number;
  firstTokenAt = 0; // 0=未到
  sentenceReadyAt = 0; // 首句可下发 TTS 的 Bridge 本地时刻
  firstAudioAt = 0; // 0=未到
  streamCompleteAt = 0; // 0=未完
  sentenceCount = 0;
  ttsAudioBytes = 0;
  private readonly gpuMetricsBySegment = new Map<number, GpuTtsSegmentMetrics>();

  /** 同一 segment 的 GPU telemetry 只接受首份，重复/乱序不重复计数。 */
  noteGpuMetrics(metric: GpuTtsSegmentMetrics): boolean {
    if (this.gpuMetricsBySegment.has(metric.segmentId)) return false;
    this.gpuMetricsBySegment.set(metric.segmentId, metric);
    return true;
  }

  gpuMetrics(): GpuTtsSegmentMetrics[] {
    return [...this.gpuMetricsBySegment.values()];
  }

  constructor(
    /** 引擎权威轮序(每起一轮 +1);随 metrics 上报供 MediaSession 合并端点段。 */
    readonly index: number,
    now: number,
  ) {
    this.startedAt = now;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** 整轮 AI 播报是否真正结束(LLM 流已出完 && 已下发句全部 tts_done)。 */
  get fullyPlayed(): boolean {
    return this.ttsPending === 0 && this.llmStreamComplete;
  }
}
