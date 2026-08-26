/**
 * LLM 跨 provider 主备 fallback(design contract,借鉴 LiveKit `llm/fallback_adapter.py`)。
 *
 * 装饰一个**模型无关**的底层 streamer(MantleStreamer:同一 mantle host + Bearer token,模型由
 * 每轮 `turn.modelId` 决定,路径按前缀推断)。按「主 → 备…」序尝试:某模型在**吐出首个 token 之前**
 * 失败(HTTP 429/5xx、连接错、流早断)或**首 token 超时**(attempt_timeout)→ 切下一模型重跑本轮;
 * 备用也耗尽 → 抛最后一次错误(引擎按 design contract 降级本轮失败,不拆机)。
 *
 * 关键契约(与 LiveKit `retry_on_chunk_sent=False` 同款,亦印证 GPU FallbackTts「已出帧不回退」):
 *  - **已出 token 不回退**:任一模型已 yield ≥1 token 后再抛错 → **MUST NOT** 切备(避免「半句 A + 整句 B」
 *    重复/拼接),直接向上抛,交引擎按现有 LLM 流异常兜底本轮(design contract)。**将来引入 tool call 后,已发出
 *    的 tool call 亦须视作已出内容、同等不回退**(design contract 前瞻约束;当前无 tools)。
 *  - **caller abort(barge-in)不触发 fallback**:调用方 signal(引擎 barge-in / TTFT 硬 backstop)一旦 abort,
 *    立即停,绝不切备(用户想打断,不是要换模型)。attempt_timeout 用**内部独立 AbortController**,只中止
 *    当前尝试、不动 caller signal —— 据此区分「我方 attempt 超时(可 fallback)」与「调用方 abort(不 fallback)」。
 *  - **design contract 铁律**:所有候选模型的清单校验 + TOCTOU 闸门在**控制面** `_resolve_llm_config` 完成(此处只
 *    消费已校验的备用序);token 逐通注入、不缓存;中国区无 IAM 回退(主备须均为已配 token 的 mantle 模型)。
 *
 * attempt_timeout 与引擎 `AIM_LLM_TTFT_TIMEOUT_MS`(25s 硬 backstop)正交:attempt 更短(默认 12s,> 跨境
 * GLM TTFB 极限 ~9.3s 留余量、< 25s),让「主模型真卡死」在引擎 backstop 前先切备;引擎 backstop 仍兜整轮。
 * 主备为空(未配 fallback)时 engine-factory 不构造本类 → 行为回退单模型(design contract「默认可关」)。
 */
import { LlmStreamer, LlmTurn } from "./bedrock-llm";

/** 一次 fallback 切换事件(供引擎写 metrics 降级率;design contract)。 */
export interface LlmFallbackEvent {
  fromModel: string;
  toModel: string;
  reason: "attempt_timeout" | "error" | "empty_stream";
}

/** 每次尝试的首 token 超时(ms);超此仍无首 token → 中止本尝试切备。env 可调;0=禁用(只按错误切)。 */
/** 单次尝试首 token 超时默认值(design contract:单一事实源)。
 *  ⚠ `?? ` 口径:空串**非** nullish,故 `X=""` 得 0(非默认),刻意保留。 */
export const LLM_FALLBACK_ATTEMPT_DEFAULT_MS = 12000;
export const llmFallbackAttemptMs = (): number =>
  Number(process.env.AIM_LLM_FALLBACK_ATTEMPT_MS ?? LLM_FALLBACK_ATTEMPT_DEFAULT_MS);
const FALLBACK_ATTEMPT_MS = llmFallbackAttemptMs();

export class FallbackLlmStreamer implements LlmStreamer {
  private fallbackCb: (ev: LlmFallbackEvent) => void = () => {};

  /**
   * @param inner  模型无关的底层 streamer(MantleStreamer);每轮 modelId 由传入的 turn 决定。
   * @param fallbackModelIds  已由控制面校验(∈ 清单、中国区非 anthropic)的备用模型序。
   * @param attemptTimeoutMs  单次尝试首 token 超时(默认 env FALLBACK_ATTEMPT_MS)。
   */
  constructor(
    private inner: LlmStreamer,
    private fallbackModelIds: string[],
    private attemptTimeoutMs: number = FALLBACK_ATTEMPT_MS,
  ) {}

  /** 注册 fallback 切换回调(引擎据此把降级写进本轮 metrics)。 */
  onFallback(cb: (ev: LlmFallbackEvent) => void): void {
    this.fallbackCb = cb;
  }

  async *stream(turn: LlmTurn, signal: AbortSignal): AsyncIterable<string> {
    // 主模型 = turn.modelId;备用序去重、剔除与主同名(避免自我重试)。
    const models = [turn.modelId, ...this.fallbackModelIds.filter((m) => m && m !== turn.modelId)];
    let lastErr: unknown = null;
    for (let i = 0; i < models.length; i++) {
      const modelId = models[i];
      const isLast = i === models.length - 1;
      let pushed = false;
      let attemptTimedOut = false;
      const ac = new AbortController();
      // caller abort(barge-in / 引擎 backstop)联动中止本次尝试;标记以便 catch 区分「不 fallback」。
      const onCallerAbort = () => ac.abort();
      signal.addEventListener("abort", onCallerAbort);
      const timer =
        this.attemptTimeoutMs > 0
          ? setTimeout(() => {
              if (!pushed) {
                attemptTimedOut = true;
                ac.abort(); // 只中止本尝试(内部 controller),不动 caller signal
              }
            }, this.attemptTimeoutMs)
          : null;
      (timer as unknown as { unref?: () => void })?.unref?.();
      try {
        const attemptTurn = i === 0 ? turn : { ...turn, modelId };
        for await (const tok of this.inner.stream(attemptTurn, ac.signal)) {
          if (signal.aborted) return; // caller barge-in 中途:整体停,不切备
          if (!pushed) {
            pushed = true;
            if (timer) clearTimeout(timer); // 出首 token → 撤销 attempt 超时(后续慢不再切)
          }
          yield tok;
        }
        // 流正常结束
        if (pushed) return; // 成功(出过 token)
        if (signal.aborted) return; // caller abort 致空流 → 不 fallback
        if (isLast) return; // 备用耗尽仍空流:交引擎按空轮处理(不抛)
        this.emitFallback(modelId, models[i + 1], attemptTimedOut ? "attempt_timeout" : "empty_stream");
      } catch (err) {
        lastErr = err;
        if (signal.aborted) throw err; // caller barge-in:向上抛(正常打断路径),不 fallback
        if (pushed) throw err; // 已出 token 不回退:抛,交引擎降级本轮(design contract)
        if (isLast) throw err; // 最后一个模型也失败:抛,引擎降级本轮
        this.emitFallback(modelId, models[i + 1], attemptTimedOut ? "attempt_timeout" : "error");
        // 继续 for 循环:切下一模型重跑本轮
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onCallerAbort);
      }
    }
    // 理论不可达(isLast 分支已 return/throw);防御性抛最后错误。
    if (lastErr) throw lastErr;
  }

  private emitFallback(from: string, to: string, reason: LlmFallbackEvent["reason"]): void {
    console.warn(`[llm-fallback] ${from} → ${to}(${reason}):主模型未出首 token,切备用重跑本轮`);
    try {
      this.fallbackCb({ fromModel: from, toModel: to, reason });
    } catch {
      /* 回调是旁路,失败不影响主链路 */
    }
  }
}
