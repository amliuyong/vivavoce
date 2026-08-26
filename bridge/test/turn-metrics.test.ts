/**
 * MetricsStore 单测(design contract)—— 旁路落库:
 *  - SK 用 metric# 前缀(与转写 event# 隔离,不污染 evaluator)
 *  - undefined 字段不写入(留空不编造)
 *  - 写失败只告警,不抛出(绝不阻塞通话)
 */
import { MetricsStore, TurnMetrics } from "../src/turn-metrics";

function mkDdb() {
  const puts: Array<Record<string, unknown>> = [];
  return {
    puts,
    send: async (cmd: unknown) => {
      const input = (cmd as { input: { Item: Record<string, unknown> } }).input;
      puts.push(input.Item);
      return {};
    },
  };
}

const base: TurnMetrics = {
  sessionId: "sess_x",
  turnIndex: 3,
  tsIso: "2026-06-27T00:00:00.000Z",
  engineType: "three_stage",
  bargeIn: false,
  played: "full",
};

test("落库 SK 用 metric# 前缀(与转写 event# 隔离,不污染 evaluator)", async () => {
  const ddb = mkDdb();
  const store = new MetricsStore({ ddb, table: "T", now: () => 1_000_000 });
  await store.put({ ...base, llmTtftMs: 123.7, sentenceCount: 2, ttsProvider: "minimax" });
  expect(ddb.puts).toHaveLength(1);
  const item = ddb.puts[0];
  expect(item.session_id).toBe("sess_x");
  expect(item.sk).toBe("metric#0000000000000003"); // metric# + zero-pad,不是 event#
  expect(String(item.sk).startsWith("event#")).toBe(false);
  expect(item.turn_index).toBe(3);
  expect(item.engine_type).toBe("three_stage");
  expect(item.llm_ttft_ms).toBe(124); // 四舍五入
  expect(item.sentence_count).toBe(2);
  expect(item.tts_provider).toBe("minimax");
  expect(item.expires_at).toBe(1000 + 365 * 24 * 3600); // now/1000 + TTL
});

test("undefined 字段不写入 DDB(留空不编造)", async () => {
  const ddb = mkDdb();
  const store = new MetricsStore({ ddb, table: "T" });
  await store.put(base); // 大量字段缺省
  const item = ddb.puts[0];
  expect("llm_ttft_ms" in item).toBe(false);
  expect("tts_provider" in item).toBe(false);
  expect("eou_delay_ms" in item).toBe(false);
  expect("cancel_ack_timeout" in item).toBe(false);
  // 必填字段在
  expect(item.engine_type).toBe("three_stage");
  expect(item.barge_in).toBe(false);
  expect(item.played).toBe("full");
});

test("端点段字段落库(turn_end_source/eou/asr_final_delay)", async () => {
  const ddb = mkDdb();
  const store = new MetricsStore({ ddb, table: "T" });
  await store.put({ ...base, turnEndSource: "bridge_watchdog", eouDelayMs: 950, asrFinalDelayMs: 800 });
  const item = ddb.puts[0];
  expect(item.turn_end_source).toBe("bridge_watchdog");
  expect(item.eou_delay_ms).toBe(950);
  expect(item.asr_final_delay_ms).toBe(800);
});

test("e2e_latency 落库(design contract;defined 才写,undefined 留空)", async () => {
  const ddb = mkDdb();
  const store = new MetricsStore({ ddb, table: "T" });
  await store.put({ ...base, e2eLatencyMs: 1834.6 });
  expect(ddb.puts[0].e2e_latency_ms).toBe(1835); // round
  // 缺省不写
  const ddb2 = mkDdb();
  await new MetricsStore({ ddb: ddb2, table: "T" }).put(base);
  expect("e2e_latency_ms" in ddb2.puts[0]).toBe(false);
});

test("work item 全链路字段落库并保留关联维度", async () => {
  const ddb = mkDdb();
  const store = new MetricsStore({ ddb, table: "T" });
  await store.put({
    ...base,
    aiTurnId: 33,
    sentenceReadyMs: 100.4,
    bridgeFirstReceiveMs: 450.6,
    ttsProvider: "gpu_omnivoice",
    providerStartToFirstSendMs: 220.3,
    modelFirstChunkUnavailableReason: "provider_does_not_expose_model_first_chunk",
    ttsGenerationWallTimeMs: 800.2,
    generatedAudioDurationMs: 2000,
    ttsRtf: 0.4001,
    ttsCacheState: "cold",
    ttsConcurrency: 3,
    concurrencyBucket: "2-4",
    cancelToLastModelComputeMs: 31.6,
    cancelToLastGpuSendMs: 4.2,
    bargeEvidenceToPauseMs: 201,
    pauseToConfirmMs: 498,
    markerToFirstBinaryMs: 20,
    firstBinaryToFirstRenderMs: 140,
    markerToFirstRenderMs: 160,
    coldPrerollMs: 120,
    underrunsBeforeFirstRender: 2,
    pauseToFirstSilentRenderMs: 2.7,
    confirmToWorkletFlushMs: 3,
    browserRingDepthAtConfirmMs: 180,
    browserRingDepthBeforeFlushMs: 120,
    browserRingDepthAfterFlushMs: 0,
  });

  expect(ddb.puts[0]).toMatchObject({
    session_id: "sess_x",
    turn_index: 3,
    ai_turn_id: 33,
    tts_provider: "gpu_omnivoice",
    sentence_ready_ms: 100,
    bridge_first_receive_ms: 451,
    provider_start_to_first_send_ms: 220,
    model_first_chunk_unavailable_reason:
      "provider_does_not_expose_model_first_chunk",
    tts_generation_wall_time_ms: 800,
    generated_audio_duration_ms: 2000,
    tts_rtf: 0.4001,
    tts_cache_state: "cold",
    tts_concurrency: 3,
    concurrency_bucket: "2-4",
    cancel_to_last_model_compute_ms: 32,
    cancel_to_last_gpu_send_ms: 4,
    barge_evidence_to_pause_ms: 201,
    pause_to_confirm_ms: 498,
    marker_to_first_binary_ms: 20,
    first_binary_to_first_render_ms: 140,
    marker_to_first_render_ms: 160,
    cold_preroll_ms: 120,
    underruns_before_first_render: 2,
    pause_to_first_silent_render_ms: 3,
    confirm_to_worklet_flush_ms: 3,
    browser_ring_depth_at_confirm_ms: 180,
    browser_ring_depth_before_flush_ms: 120,
    browser_ring_depth_after_flush_ms: 0,
  });
});

test("写失败只告警,不抛出(旁路,不阻塞通话)", async () => {
  const store = new MetricsStore({
    ddb: { send: async () => { throw new Error("DDB down"); } },
    table: "T",
  });
  await expect(store.put(base)).resolves.toBeUndefined(); // 不抛
});

test("无表名(未配置)→ 直接跳过,不调用 DDB", async () => {
  const ddb = mkDdb();
  const store = new MetricsStore({ ddb, table: "" });
  await store.put(base);
  expect(ddb.puts).toHaveLength(0);
});

test("EMF:put 额外输出 CloudWatch Embedded Metric Format 到 stdout(D-3)", async () => {
  const ddb = mkDdb();
  const logs: string[] = [];
  const spy = jest.spyOn(console, "log").mockImplementation((s?: unknown) => { logs.push(String(s)); });
  try {
    const store = new MetricsStore({ ddb, table: "T", now: () => 1_700_000_000_000 });
    await store.put({
      ...base,
      llmTtftMs: 420.4,
      ttsTtfbMs: 1100,
      ttsProvider: "minimax",
      ttsCacheState: "not_applicable",
      concurrencyBucket: "1",
      llmModelId: "zai.glm-4.7-flash",
      llmFailed: true,
    });
    const emfs = logs.map((line) => JSON.parse(line));
    const aggregate = emfs.find(
      (emf) => JSON.stringify(emf._aws.CloudWatchMetrics[0].Dimensions) === "[[]]",
    );
    const providerModel = emfs.find(
      (emf) => JSON.stringify(emf._aws.CloudWatchMetrics[0].Dimensions) ===
        '[["tts_provider","llm_model"]]',
    );
    expect(aggregate?._aws.CloudWatchMetrics[0].Namespace).toBe("AIM/Realtime");
    expect(providerModel).toBeTruthy();
    // 数值指标(defined 的入)+ 计数指标(总是入)
    expect(aggregate?.llm_ttft_ms).toBe(420);         // round
    expect(aggregate?.tts_ttfb_ms).toBe(1100);
    expect(aggregate?.turns).toBe(1);
    expect(aggregate?.llm_failed).toBe(1);            // 本轮 llmFailed=true → 1
    expect(providerModel.tts_provider).toBe("minimax");
    expect(providerModel.llm_model).toBe("zai.glm-4.7-flash");
    // 未测到的延迟(如 llm_duration_ms)不入 EMF(避免 0 污染)
    expect(aggregate?.llm_duration_ms).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("EMF:无 provider/model 时仅空维度总量组(不带细分维度)", async () => {
  const ddb = mkDdb();
  const logs: string[] = [];
  const spy = jest.spyOn(console, "log").mockImplementation((s?: unknown) => { logs.push(String(s)); });
  try {
    const store = new MetricsStore({ ddb, table: "T" });
    await store.put(base); // 无 provider/model
    const emf = JSON.parse(logs.find((l) => l.includes("_aws")) as string);
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    expect(emf.turns).toBe(1);
    expect(emf.tts_provider).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("EMF:table 未配也照发(EMF 独立于 DDB 落库通道;自查修复)", async () => {
  const logs: string[] = [];
  const spy = jest.spyOn(console, "log").mockImplementation((s?: unknown) => { logs.push(String(s)); });
  try {
    const store = new MetricsStore({ table: "" }); // 无 table → 跳 DDB,但 EMF 仍应发
    await store.put({ ...base, llmTtftMs: 300 });
    const emf = JSON.parse(logs.find((l) => l.includes("_aws")) as string);
    expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe("AIM/Realtime");
    expect(emf.turns).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

test("EMF:迟到完整记录按各维度只补发新字段，不重复采样已有指标", async () => {
  const logs: string[] = [];
  const spy = jest.spyOn(console, "log").mockImplementation((s?: unknown) => {
    logs.push(String(s));
  });
  try {
    const store = new MetricsStore({ table: "" });
    const first = {
      ...base,
      ttsProvider: "gpu_omnivoice" as const,
      ttsCacheState: "cold" as const,
      concurrencyBucket: "2-4" as const,
      llmModelId: "model-a",
      llmTtftMs: 300,
    };
    await store.put(first);
    await store.put(first);
    await store.put({
      ...first,
      markerToFirstRenderMs: 180,
      cancelAckTimeout: false,
    });

    const emfs = logs.map((line) => JSON.parse(line));
    const aggregate = emfs.filter(
      (emf) => JSON.stringify(emf._aws.CloudWatchMetrics[0].Dimensions) === "[[]]",
    );
    expect(aggregate).toHaveLength(2);
    const [initial, late] = aggregate;
    expect(initial.turns).toBe(1);
    expect(initial.llm_ttft_ms).toBe(300);
    expect(initial.cancel_ack_timeout).toBeUndefined();
    expect(late.marker_to_first_render_ms).toBe(180);
    expect(late.cancel_ack_timeout).toBe(0);
    expect(late.turns).toBeUndefined();
    expect(late.llm_ttft_ms).toBeUndefined();
    expect(late._aws.CloudWatchMetrics[0].Metrics.map(
      (definition: { Name: string }) => definition.Name,
    )).toEqual(["marker_to_first_render_ms", "cancel_ack_timeout"]);
  } finally {
    spy.mockRestore();
  }
});

test("EMF:迟到实际 provider/cache/并发补建三维序列且不重复 aggregate", async () => {
  const logs: string[] = [];
  const spy = jest.spyOn(console, "log").mockImplementation((s?: unknown) => {
    logs.push(String(s));
  });
  try {
    const store = new MetricsStore({ table: "" });
    await store.put({
      ...base,
      ttsProvider: "minimax",
      markerToFirstRenderMs: 180,
    });
    await store.put({
      ...base,
      ttsProvider: "gpu_omnivoice",
      ttsCacheState: "cold",
      concurrencyBucket: "2-4",
      markerToFirstRenderMs: 180,
    });

    const emfs = logs.map((line) => JSON.parse(line));
    const aggregate = emfs.filter(
      (emf) => JSON.stringify(emf._aws.CloudWatchMetrics[0].Dimensions) === "[[]]",
    );
    expect(aggregate).toHaveLength(1);
    expect(emfs.some((emf) => emf.tts_provider === "minimax")).toBe(false);
    const drilldown = emfs.find(
      (emf) => JSON.stringify(emf._aws.CloudWatchMetrics[0].Dimensions) ===
        '[["tts_provider","cache_state","concurrency_bucket"]]',
    );
    expect(drilldown).toMatchObject({
      tts_provider: "gpu_omnivoice",
      cache_state: "cold",
      concurrency_bucket: "2-4",
      marker_to_first_render_ms: 180,
      turns: 1,
    });
  } finally {
    spy.mockRestore();
  }
});

test("DDB:同一轮完整覆盖按调用顺序串行，迟到字段不会被稀疏写反向抹除", async () => {
  let stored: Record<string, unknown> | undefined;
  const pending: Array<{
    item: Record<string, unknown>;
    complete: () => void;
  }> = [];
  const ddb = {
    send: (cmd: unknown) => {
      const item = (cmd as { input: { Item: Record<string, unknown> } }).input.Item;
      return new Promise<unknown>((resolve) => {
        pending.push({
          item,
          complete: () => {
            stored = item;
            resolve({});
          },
        });
      });
    },
  };
  const store = new MetricsStore({ ddb, table: "T" });
  const sparse = store.put({ ...base, aiTurnId: 99, llmTtftMs: 300 });
  await Promise.resolve();
  const rich = store.put({
    ...base,
    aiTurnId: 99,
    llmTtftMs: 300,
    markerToFirstRenderMs: 180,
  });
  await Promise.resolve();

  expect(pending).toHaveLength(1);
  pending[0].complete();
  await sparse;
  await Promise.resolve();
  expect(pending).toHaveLength(2);
  pending[1].complete();
  await rich;

  expect(stored?.marker_to_first_render_ms).toBe(180);
});
