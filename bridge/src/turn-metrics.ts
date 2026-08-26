/**
 * 每轮交互的结构化实时性 metrics(design contract)。**旁路**采集:失败只告警,绝不阻塞通话主链路。
 *
 * 落库隔离(design contract / 评审定稿):与转写**同表** `SessionEvents`,但 SK 用 `metric#<ai_turn_id>` 前缀,
 * 与转写的 `event#<ISO ts>` 隔离 —— evaluator query 显式 `begins_with("event#")`(handler.py),Stream 仅认
 * `sk=="meta"`,故 `metric#` 记录**零污染** evaluator 打分输入。媒体面 ec2Role 已有 SessionEvents 写权,
 * **零新增 IAM**。
 *
 * 两路数据源按 `ai_turn_id` 合并成一条(合并点在 MediaSession,它同时见两端):
 *  - **engine 段**(LLM/TTS):ThreeStageEngine 经可选 `onMetrics?` 上报(Nova 不实现即不报);
 *  - **MediaSession 段**(端点):`asr_final_delay`/`eou_delay`/`turn_end_source` —— 这些依赖「对方停说」
 *    时刻,只有持有真实入向 RMS 的 MediaSession 知道;`turn_end` 帧不带来源字段(protocol.py),也只有
 *    MediaSession 知道本次 turn_end 是否由自己的 watchdog flush 触发。
 *
 * `played` 语义边界(评审):`full`=本轮所有句已合成完成(收齐 tts_done);`partial`=被 cancel(barge_in)
 * 截断未收齐。它表达**合成完成度**,**不**表达「用户实际听到多少」(系统不追踪客户端播放 drain)。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const TTL_SECONDS = 365 * 24 * 3600;
const MAX_EMF_TURN_KEYS = 4096;

/** 引擎下行 TTS PCM 采样率(三段式 GPU + Nova 均 24k s16le)。用于由回灌字节数推算合成音频时长。 */
export const TTS_SAMPLE_RATE_HZ = 24000;

export type TtsCacheState = "cold" | "warm" | "not_applicable" | "unknown";

/** GPU 单句 telemetry。所有时延都在 GPU monotonic clock 内计算，Bridge 不做跨时钟绝对值相减。 */
export interface GpuTtsSegmentMetrics {
  segmentId: number;
  ttsProvider: string;
  providerStartToFirstSendMs?: number;
  generationWallTimeMs: number;
  generatedAudioDurationMs: number;
  rtf?: number;
  cacheState: TtsCacheState;
  concurrency: number;
  modelFirstChunkUnavailableReason?: string;
  cancelToLastModelComputeMs?: number;
  cancelToLastGpuSendMs?: number;
}

/** engine 段:LLM/TTS 实时性(由 ThreeStageEngine 在每轮结束时经 onMetrics 上报)。
 *  engine 同时给出本地 `turnIndex` 和跨链路 `aiTurnId`;MediaSession 用后者作合并 key。 */
export interface EngineTurnMetrics {
  /** 引擎本地轮序(每起一轮 LLM +1)，保留用于诊断。 */
  turnIndex: number;
  /** 与浏览器 marker/GPU identity 共用的轮 id；生产 adapter 用随机命名空间避免重连复用。 */
  aiTurnId?: number;
  engineType: "three_stage" | "s2s";
  llmModelId?: string;
  /** 首 token 时延(本轮起 LLM → 首 token 到达)。 */
  llmTtftMs?: number;
  /** LLM 整流时长(本轮起 LLM → 流出完)。 */
  llmDurationMs?: number;
  /** Bridge 本地：LLM turn start → 首句进入 TTS 队列。 */
  sentenceReadyMs?: number;
  /** 首句首音频帧时延(本轮起 LLM → 首个回灌 PCM 帧)。 */
  ttsTtfbMs?: number;
  /** `tts_ttfb_ms` 的显式边界别名：LLM turn start → Bridge 收到首个 PCM。 */
  bridgeFirstReceiveMs?: number;
  /** 本轮合成音频总时长(累加各回灌帧的样本时长)。 */
  ttsAudioDurationMs?: number;
  /** 本轮下发的 tts_text 句数。 */
  sentenceCount?: number;
  /** gpu_omnivoice | minimax(design contract);缺省 undefined = GPU 默认。 */
  ttsProvider?: string;
  /** GPU 本地：provider 调用开始 → 首个 PCM 发出。 */
  providerStartToFirstSendMs?: number;
  /** provider 不暴露 model-first-chunk 时明确记录原因，不以首个 PCM 伪造。 */
  modelFirstChunkUnavailableReason?: string;
  /** 各 segment 生成 wall time 之和。 */
  ttsGenerationWallTimeMs?: number;
  /** GPU 报告的生成音频时长之和。 */
  generatedAudioDurationMs?: number;
  /** 稳态 RTF = sum(generation wall time) / sum(generated audio duration)。 */
  ttsRtf?: number;
  ttsCacheState?: TtsCacheState;
  ttsConcurrency?: number;
  concurrencyBucket?: "1" | "2-4" | "5+";
  cancelToLastModelComputeMs?: number;
  cancelToLastGpuSendMs?: number;
  /** 本轮是否被 barge-in 打断。 */
  bargeIn: boolean;
  /** 合成完成度(非「用户听到」,见文件头)。 */
  played: "full" | "partial";
  /** 打断后有界超时内未收到 GPU cancel_ack(旁路核对,见 design contract / P0.2)。 */
  cancelAckTimeout?: boolean;
  /** 本轮因引擎级 TTS 超时(GPU「只收不回」一帧未出)被自终结(非致命,会话继续;见 design contract / P0.4)。 */
  ttsTimeout?: boolean;
  /** 本轮因 LLM 流异常/首token超时降级为本轮失败(非致命,会话继续,不拆机;P2-9)。供分析跨境 LLM 降级率。 */
  llmFailed?: boolean;
  /** 本轮 LLM 发生了主备 fallback 切换(design contract):主模型出首 token 前失败/超时,切到备用模型重跑本轮。
   *  用于分析主 provider 降级率(与 llmFailed 区别:fallback 后备用成功出声 = 本轮不 failed)。 */
  llmFallback?: boolean;
  /** 本轮 LLM 实际出声的模型 id(fallback 后 = 备用模型;无 fallback = 主模型 = llmModelId)。 */
  llmModelUsed?: string;
}

/** MediaSession 段:端点实时性。 */
export interface EndpointTurnMetrics {
  /** 「对方停说」(或首个 asr_partial)→ asr_final 到达的时延。 */
  asrFinalDelayMs?: number;
  /** 「对方停说」→ 本轮 turn_end 到达的时延。 */
  eouDelayMs?: number;
  /** 本轮 turn_end 来源:GPU VAD 自然命中 vs Bridge 端点看门狗 flush。 */
  turnEndSource?: "gpu_vad" | "bridge_watchdog";
  /** 端到端体感延迟(design contract,借鉴 LiveKit MetricsReport.e2e_latency):
   *  = 「AI 首音频帧流出的绝对时刻」−「参会者停说的绝对时刻」,整段 round-trip,运维一眼读体感延迟。
   *  ⚠ **MUST NOT** 由 `eou_delay + llm_ttft + tts_ttfb` 累加得到(`tts_ttfb` 已含整个 LLM→首音频段、会
   *  双算 LLM);此字段由 MediaSession 据两个绝对时刻直接相减采集(与 eou_delay 的「参会者停说」同源)。
   *  仅正常一问一答轮采集(kickoff 主动开场无「参会者停说」锚点,不采);被打断/失败轮无首帧则留空。 */
  e2eLatencyMs?: number;
  // ── barge-in 可观测性(诊断 021-metrics-diagnosis-deployment validation;让「误打断 vs 真打断 / 噪声 vs 回声」可由
  //    metrics 直接区分,不必每次靠离线录音双声道)。仅本轮**被 barge_in 打断**时由 MediaSession 填,否则留空。──
  /** 触发 barge-in 时的入向 RMS(int16)。与 noiseBaseline/refPeak 对比可判「真人插话 vs 环境底噪/AI 回声」。 */
  bargeInboundRms?: number;
  /** 触发时的入向噪声基线(动态 floor 的 p20 估计;高 = 高底噪环境,误打断高发场景)。 */
  bargeNoiseBaseline?: number;
  /** 触发时的近端 AI 回灌参考峰值 RMS(高 = AI 当时在大声,入向高能量可能是回声而非真人)。 */
  bargeRefPeak?: number;
  /** 触发时实际生效的动态门槛(= max(dynFloor, echoGain×refPeak));便于复核判据是否合理。 */
  bargeThreshold?: number;
  /** 误打断恢复(design contract):本轮发生了一次「疑似打断 → tentative-pause → 窗内无接管 → resume」的误打断
   *  (AI 没被真打断、续播完成)。用于验证误打断率收益 vs 真打断率(design contract 落地前 metrics 验证)。 */
  falseInterruption?: boolean;
  /** Bridge 本地 clock：首个打断证据 → tentative pause。 */
  bargeEvidenceToPauseMs?: number;
  /** Bridge 本地 clock：tentative pause → confirmed barge-in。 */
  pauseToConfirmMs?: number;
  /** Browser AudioContext clock 内的首声分段。 */
  markerToFirstBinaryMs?: number;
  firstBinaryToFirstRenderMs?: number;
  markerToFirstRenderMs?: number;
  coldPrerollMs?: number;
  underrunsBeforeFirstRender?: number;
  /** Browser AudioContext clock 内的 tentative pause → 首个全静音 render quantum。 */
  pauseToFirstSilentRenderMs?: number;
  /** Browser AudioContext clock 内的 confirmed barge-in → worklet flush。 */
  confirmToWorkletFlushMs?: number;
  browserRingDepthAtConfirmMs?: number;
  browserRingDepthBeforeFlushMs?: number;
  browserRingDepthAfterFlushMs?: number;
}

/** 合并后落库的一条完整记录(engine 段 + 端点段 + 落库标识)。 */
export interface TurnMetrics extends EngineTurnMetrics, EndpointTurnMetrics {
  sessionId: string;
  tsIso: string;
}

export interface MetricsDeps {
  ddb?: { send: (cmd: unknown) => Promise<unknown> };
  table?: string;
  now?: () => number;
}

/** undefined 字段不写入 DDB(DocumentClient 不接受 undefined 值;留空 = 不编造,见 design contract)。 */
function putIfDefined(item: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) item[key] = value;
}

export class MetricsStore {
  private readonly ddb: { send: (cmd: unknown) => Promise<unknown> };
  private readonly table: string;
  private readonly now: () => number;
  /** EMF is append-only, unlike the DDB row. De-duplicate independently per
   * dimension schema so late provider/cache metadata can create drill-down
   * series without sampling the dimensionless aggregate twice. */
  private readonly emittedEmfFieldsByTurn =
    new Map<string, Map<string, Set<string>>>();
  /** Full-row PutItem rewrites must complete in observation order per turn.
   *  Otherwise an older sparse write can finish after a richer late update and
   *  erase browser/GPU fields from the durable row. */
  private readonly pendingWritesByTurn = new Map<string, Promise<void>>();

  constructor(deps: MetricsDeps = {}) {
    this.ddb =
      deps.ddb ??
      (DynamoDBDocumentClient.from(new DynamoDBClient({})) as unknown as {
        send: (cmd: unknown) => Promise<unknown>;
      });
    this.table = deps.table ?? process.env.SESSION_EVENTS_TABLE_NAME ?? "";
    this.now = deps.now ?? (() => Date.now());
  }

  /** 写一条每轮 metrics。best-effort:落库失败只告警,绝不拖垮通话(旁路语义,design contract)。 */
  async put(m: TurnMetrics): Promise<void> {
    const storageTurnId = m.aiTurnId ?? m.turnIndex;
    const turnKey = `${m.sessionId}\u0000${storageTurnId}`;
    const previous = this.pendingWritesByTurn.get(turnKey) ?? Promise.resolve();
    const write = previous.then(
      () => this.writeSnapshot(m, storageTurnId),
      () => this.writeSnapshot(m, storageTurnId),
    );
    this.pendingWritesByTurn.set(turnKey, write);
    try {
      await write;
    } finally {
      if (this.pendingWritesByTurn.get(turnKey) === write) {
        this.pendingWritesByTurn.delete(turnKey);
      }
    }
  }

  private async writeSnapshot(
    m: TurnMetrics,
    storageTurnId: number,
  ): Promise<void> {
    const tsMs = this.now();
    // EMF 输出**独立于 DDB table 配置**(CloudWatch 指标是另一条可观测通道):table 未配也照发 EMF,
    // 否则只想要指标不落库、或 table 缺失时 EMF 会被静默吞掉(自查发现:此前在 table 判断之后)。
    this.emitEmf(m, tsMs);
    if (!this.table) return;
    // SK uses the session-unique ai_turn_id. Reconnects receive a fresh
    // high-entropy range, making reconnect collisions with an earlier local
    // ordinal negligible.
    const item: Record<string, unknown> = {
      session_id: m.sessionId,
      sk: `metric#${String(storageTurnId).padStart(16, "0")}`,
      turn_index: m.turnIndex,
      ai_turn_id: storageTurnId,
      ts: m.tsIso,
      engine_type: m.engineType,
      barge_in: m.bargeIn,
      played: m.played,
      expires_at: Math.floor(tsMs / 1000) + TTL_SECONDS,
    };
    putIfDefined(item, "llm_model_id", m.llmModelId);
    putIfDefined(item, "llm_ttft_ms", round(m.llmTtftMs));
    putIfDefined(item, "llm_duration_ms", round(m.llmDurationMs));
    putIfDefined(item, "sentence_ready_ms", round(m.sentenceReadyMs));
    putIfDefined(item, "tts_ttfb_ms", round(m.ttsTtfbMs));
    putIfDefined(item, "bridge_first_receive_ms", round(m.bridgeFirstReceiveMs));
    putIfDefined(item, "tts_audio_duration_ms", round(m.ttsAudioDurationMs));
    putIfDefined(item, "sentence_count", m.sentenceCount);
    putIfDefined(item, "tts_provider", m.ttsProvider);
    putIfDefined(item, "provider_start_to_first_send_ms", round(m.providerStartToFirstSendMs));
    putIfDefined(item, "model_first_chunk_unavailable_reason", m.modelFirstChunkUnavailableReason);
    putIfDefined(item, "tts_generation_wall_time_ms", round(m.ttsGenerationWallTimeMs));
    putIfDefined(item, "generated_audio_duration_ms", round(m.generatedAudioDurationMs));
    putIfDefined(item, "tts_rtf", roundRatio(m.ttsRtf));
    putIfDefined(item, "tts_cache_state", m.ttsCacheState);
    putIfDefined(item, "tts_concurrency", m.ttsConcurrency);
    putIfDefined(item, "concurrency_bucket", m.concurrencyBucket);
    putIfDefined(item, "cancel_to_last_model_compute_ms", round(m.cancelToLastModelComputeMs));
    putIfDefined(item, "cancel_to_last_gpu_send_ms", round(m.cancelToLastGpuSendMs));
    putIfDefined(item, "cancel_ack_timeout", m.cancelAckTimeout);
    putIfDefined(item, "tts_timeout", m.ttsTimeout);
    putIfDefined(item, "llm_failed", m.llmFailed);
    putIfDefined(item, "llm_fallback", m.llmFallback);
    putIfDefined(item, "llm_model_used", m.llmModelUsed);
    putIfDefined(item, "asr_final_delay_ms", round(m.asrFinalDelayMs));
    putIfDefined(item, "eou_delay_ms", round(m.eouDelayMs));
    putIfDefined(item, "e2e_latency_ms", round(m.e2eLatencyMs));
    putIfDefined(item, "turn_end_source", m.turnEndSource);
    putIfDefined(item, "barge_inbound_rms", round(m.bargeInboundRms));
    putIfDefined(item, "barge_noise_baseline", round(m.bargeNoiseBaseline));
    putIfDefined(item, "barge_ref_peak", round(m.bargeRefPeak));
    putIfDefined(item, "barge_threshold", round(m.bargeThreshold));
    putIfDefined(item, "false_interruption", m.falseInterruption);
    putIfDefined(item, "barge_evidence_to_pause_ms", round(m.bargeEvidenceToPauseMs));
    putIfDefined(item, "pause_to_confirm_ms", round(m.pauseToConfirmMs));
    putIfDefined(item, "marker_to_first_binary_ms", round(m.markerToFirstBinaryMs));
    putIfDefined(item, "first_binary_to_first_render_ms", round(m.firstBinaryToFirstRenderMs));
    putIfDefined(item, "marker_to_first_render_ms", round(m.markerToFirstRenderMs));
    putIfDefined(item, "cold_preroll_ms", round(m.coldPrerollMs));
    putIfDefined(item, "underruns_before_first_render", m.underrunsBeforeFirstRender);
    putIfDefined(item, "pause_to_first_silent_render_ms", round(m.pauseToFirstSilentRenderMs));
    putIfDefined(item, "confirm_to_worklet_flush_ms", round(m.confirmToWorkletFlushMs));
    putIfDefined(item, "browser_ring_depth_at_confirm_ms", round(m.browserRingDepthAtConfirmMs));
    putIfDefined(item, "browser_ring_depth_before_flush_ms", round(m.browserRingDepthBeforeFlushMs));
    putIfDefined(item, "browser_ring_depth_after_flush_ms", round(m.browserRingDepthAfterFlushMs));
    try {
      await this.ddb.send(new PutCommand({ TableName: this.table, Item: item }));
    } catch (e) {
      console.warn(`[metrics] put failed for ${m.sessionId} turn ${m.turnIndex}:`, (e as Error).message);
    }
  }

  /** EMF 输出(CloudWatch Embedded Metric Format):把本轮关键延迟/失败指标打成结构化日志,
   *  CloudWatch Logs 据 _aws.CloudWatchMetrics 元数据自动提取为 AIM/Realtime 命名空间的 Metrics。
   *  维度:tts_provider + llm_model(便于按 provider/模型分析);指标 undefined 的不入(避免 0 污染统计)。
   *  best-effort 旁路:emitEmf 抛错不影响通话(整个 put 已在 try 外无害)。 */
  private emitEmf(m: TurnMetrics, tsMs: number): void {
    // 数值型指标候选(仅 defined 的入 EMF;避免把"未测到"当 0 拉低统计)。
    const numeric: Array<[string, number | undefined, string]> = [
      ["llm_ttft_ms", round(m.llmTtftMs), "Milliseconds"],
      ["llm_duration_ms", round(m.llmDurationMs), "Milliseconds"],
      ["sentence_ready_ms", round(m.sentenceReadyMs), "Milliseconds"],
      ["tts_ttfb_ms", round(m.ttsTtfbMs), "Milliseconds"],
      ["bridge_first_receive_ms", round(m.bridgeFirstReceiveMs), "Milliseconds"],
      ["provider_start_to_first_send_ms", round(m.providerStartToFirstSendMs), "Milliseconds"],
      ["tts_generation_wall_time_ms", round(m.ttsGenerationWallTimeMs), "Milliseconds"],
      ["generated_audio_duration_ms", round(m.generatedAudioDurationMs), "Milliseconds"],
      ["tts_rtf", roundRatio(m.ttsRtf), "None"],
      ["cancel_to_last_model_compute_ms", round(m.cancelToLastModelComputeMs), "Milliseconds"],
      ["cancel_to_last_gpu_send_ms", round(m.cancelToLastGpuSendMs), "Milliseconds"],
      ["asr_final_delay_ms", round(m.asrFinalDelayMs), "Milliseconds"],
      ["eou_delay_ms", round(m.eouDelayMs), "Milliseconds"],
      ["e2e_latency_ms", round(m.e2eLatencyMs), "Milliseconds"],
      ["barge_evidence_to_pause_ms", round(m.bargeEvidenceToPauseMs), "Milliseconds"],
      ["pause_to_confirm_ms", round(m.pauseToConfirmMs), "Milliseconds"],
      ["marker_to_first_binary_ms", round(m.markerToFirstBinaryMs), "Milliseconds"],
      ["first_binary_to_first_render_ms", round(m.firstBinaryToFirstRenderMs), "Milliseconds"],
      ["marker_to_first_render_ms", round(m.markerToFirstRenderMs), "Milliseconds"],
      ["cold_preroll_ms", round(m.coldPrerollMs), "Milliseconds"],
      ["underruns_before_first_render", m.underrunsBeforeFirstRender, "Count"],
      ["pause_to_first_silent_render_ms", round(m.pauseToFirstSilentRenderMs), "Milliseconds"],
      ["confirm_to_worklet_flush_ms", round(m.confirmToWorkletFlushMs), "Milliseconds"],
      ["browser_ring_depth_at_confirm_ms", round(m.browserRingDepthAtConfirmMs), "Milliseconds"],
      ["browser_ring_depth_before_flush_ms", round(m.browserRingDepthBeforeFlushMs), "Milliseconds"],
      ["browser_ring_depth_after_flush_ms", round(m.browserRingDepthAfterFlushMs), "Milliseconds"],
    ];
    // 计数型指标(失败/打断:1=发生;不发生则记 0,以便算发生率)。
    const counts: Array<[string, number | undefined]> = [
      ["turns", 1],
      ["llm_failed", m.llmFailed ? 1 : 0],
      ["llm_fallback", m.llmFallback ? 1 : 0],
      ["tts_timeout", m.ttsTimeout ? 1 : 0],
      // Unresolved on the first barge-in write. Emit only once ACK or timeout
      // determines the final value.
      ["cancel_ack_timeout", m.cancelAckTimeout === undefined
        ? undefined
        : m.cancelAckTimeout ? 1 : 0],
      ["barge_in", m.bargeIn ? 1 : 0],
      ["false_interruption", m.falseInterruption ? 1 : 0],
    ];
    const turnKey = `${m.sessionId}\u0000${m.aiTurnId ?? m.turnIndex}`;
    let emittedByDimensions = this.emittedEmfFieldsByTurn.get(turnKey);
    if (!emittedByDimensions) {
      emittedByDimensions = new Map<string, Set<string>>();
      this.emittedEmfFieldsByTurn.set(turnKey, emittedByDimensions);
      while (this.emittedEmfFieldsByTurn.size > MAX_EMF_TURN_KEYS) {
        const oldest = this.emittedEmfFieldsByTurn.keys().next().value;
        if (oldest === undefined) break;
        this.emittedEmfFieldsByTurn.delete(oldest);
      }
    }
    const allMetricDefs: Array<{ Name: string; Unit: string }> = [];
    const metricValues: Record<string, number> = {};
    for (const [name, val, unit] of numeric) {
      if (val !== undefined) {
        allMetricDefs.push({ Name: name, Unit: unit });
        metricValues[name] = val;
      }
    }
    for (const [name, val] of counts) {
      if (val !== undefined) {
        allMetricDefs.push({ Name: name, Unit: "Count" });
        metricValues[name] = val;
      }
    }
    if (allMetricDefs.length === 0) return;

    // CloudWatch custom metric dimensions are exact schemas. Emit the
    // provider/cache/concurrency combinations used by percentile searches.
    // Each schema gets a separate EMF event because late metadata may make a
    // new schema available after aggregate metrics were already sampled.
    const dimensionValues: Record<string, string> = {};
    const dimensionSets: string[][] = [[]];
    // Requested provider is known before synthesis, but fallback can change the
    // actual provider. Cache/concurrency arrive in the same GPU telemetry frame
    // as the observed provider, so do not create a provider series earlier.
    const providerDimensionsReady =
      Boolean(m.ttsProvider && m.ttsCacheState && m.concurrencyBucket);
    if (providerDimensionsReady) {
      dimensionValues.tts_provider = String(m.ttsProvider);
      dimensionValues.cache_state = String(m.ttsCacheState);
      dimensionValues.concurrency_bucket = String(m.concurrencyBucket);
      dimensionSets.push(["tts_provider"]);
      dimensionSets.push(["tts_provider", "cache_state"]);
      dimensionSets.push([
        "tts_provider",
        "cache_state",
        "concurrency_bucket",
      ]);
    }
    if (m.llmModelId) {
      dimensionValues.llm_model = String(m.llmModelId);
      dimensionSets.push(["llm_model"]);
      if (providerDimensionsReady) {
        // Preserve the legacy provider/model query shape.
        dimensionSets.push(["tts_provider", "llm_model"]);
      }
    }

    for (const dimensions of dimensionSets) {
      const schemaKey = dimensions
        .map((name) => `${name}=${dimensionValues[name]}`)
        .join("\u0000");
      let emitted = emittedByDimensions.get(schemaKey);
      if (!emitted) {
        emitted = new Set<string>();
        emittedByDimensions.set(schemaKey, emitted);
      }
      const metricDefs = allMetricDefs.filter(
        (definition) => !emitted?.has(definition.Name),
      );
      if (metricDefs.length === 0) continue;

      const values: Record<string, unknown> = {};
      for (const dimension of dimensions) {
        values[dimension] = dimensionValues[dimension];
      }
      for (const definition of metricDefs) {
        values[definition.Name] = metricValues[definition.Name];
      }
      const emf = {
        _aws: {
          Timestamp: tsMs,
          CloudWatchMetrics: [{
            Namespace: "AIM/Realtime",
            Dimensions: [dimensions],
            Metrics: metricDefs,
          }],
        },
        session_id: m.sessionId,
        turn_index: m.turnIndex,
        ai_turn_id: m.aiTurnId ?? m.turnIndex,
        ...values,
      };
      try {
        console.log(JSON.stringify(emf));
        for (const definition of metricDefs) emitted.add(definition.Name);
      } catch {
        /* EMF 旁路,序列化失败不影响通话 */
      }
    }
  }
}

/** 时延四舍五入到整数 ms(避免浮点噪声进表;undefined 透传)。 */
function round(v: number | undefined): number | undefined {
  return v === undefined ? undefined : Math.round(v);
}

function roundRatio(v: number | undefined): number | undefined {
  return v === undefined ? undefined : Math.round(v * 10_000) / 10_000;
}
