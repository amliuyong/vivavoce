/**
 * design contract:旁路「判句子完整性」EOU 判定 —— 异步问 LLM「考生刚那句说完没」,用于**事后纠偏**
 * (乐观开口后,判 incomplete + 考生亚阈重新出声 → tentative-pause 让位)。
 *
 * **MUST NOT 门控开口决策**(延迟约束,见 design contract Purpose):判定慢(旁路 LLM 0.8~1.4s、抖动到数秒),
 * 比它要门控的开口决策(~800ms 尾静音)还慢,故只能异步 + 事后纠偏。编排在 media-session(turn 关联 /
 * 关联窗 / stale 丢弃 / 双条件降门槛),本模块只管「一次判定」的纯逻辑。
 *
 * 与 design contract transcript-fixer 同构(复用旁路骨架:非流式单次 mantle/converse 调用 + fail-open + abort),
 * 但语义不同:
 *  - fixer 输出 = 修正文本(fail-open 落原文);L3 输出 = complete/incomplete 判定(fail-open → **null=判不了**)。
 *  - 独立超时 `AIM_EOU_VERDICT_TIMEOUT_MS` 默认 **2000ms**(远短于 fixer 8s;超 2s 的判定对纠偏已无意义)。
 *  - 独立「判完整性」prompt(不改文本、不补全、不替用户答题、不给参考答案)。
 *  - 任何失败(超时/报错/abort/非法输出)→ **null**;media-session 见 null 视作「判不了」→ 不纠偏(fail-open,
 *    绝不误暂停 AI)。
 */
import { MantleConfig, mantleCompleteOnce } from "./mantle-llm";

export type EouVerdict = "complete" | "incomplete";

export interface EouContext {
  history?: { role: "user" | "assistant"; content: string }[];
  question?: string;
}

/** EOU 判定超时:默认 2000ms,env AIM_EOU_VERDICT_TIMEOUT_MS 可调(夹在 [500ms, 8s])。
 *  **上限 8s(部署验证标定 deployment validation)**:初稿定 5s 上限、理由「超 2s 对纠偏无意义」,但真机实证——跨境旁路 LLM
 *  TTFT 1.2~9.3s(memory cn-crossborder-glm-ttft),2s 超时几乎必超 → L3 一直 fail-open 从不真纠偏(同模型 fixer
 *  8s 超时内能成功返回)。跨境部署须把超时放到能让 judge 返回(如 6000ms)+ 相应调长关联窗(judge 回来还要在窗内)。
 *  低延迟区(如本区推理)可保持 2s。上限与 fixer(15s)一致量级但更紧(EOU 判定应比字幕修正更快)。 */
// design contract:超时默认值/钳制已下沉到纯叶子 `bypass-llm-config`(本模块是行为模块、常被 jest.mock,
//   配置留在此处会让 registry 依赖 mock 而在加载期崩)。此处 re-export 保持既有 API 不变。
import { eouVerdictTimeoutMs } from "./bypass-llm-config";
export { eouVerdictTimeoutMs };

/** 建「判句子完整性」prompt 的 system 段。硬约束:只判说完没(输出 complete/incomplete),不改写/不补全/不答题。 */
export function buildEouSystemPrompt(ctx: EouContext): string {
  const lines: string[] = [
    "你是口语对话的「话轮完整性」判定助手。下面这句话是考生在口试中说的(经语音识别转成文字),",
    "可能是完整的一句话(说完了),也可能是还没说完就停顿了(边想边说、在组织语言)。",
    "你的**唯一任务**:判断考生这句话**说完了没有**——",
    "- 若语义完整、是一个说完的表述(哪怕简短)→ 判 **complete**;",
    "- 若明显话没说完(以连词/介词/悬垂结构结尾,如「因为」「它需要」「第一类是」「然后」,或明显被停顿截断)",
    "  → 判 **incomplete**。",
    "严格约束:**只判完整性,不要改写、不要补全没说完的话、不要替考生回答问题、不要评价内容对错**。",
    "考生答得对不对**与本判定无关**——哪怕答错了,只要话说完了就是 complete。",
    "**只输出一个词:complete 或 incomplete**,不要输出任何解释、理由或标点。拿不准时判 incomplete(宁可多等,不抢话)。",
  ];
  const hist = (ctx.history ?? []).filter((m) => m && typeof m.content === "string" && m.content.trim());
  if (hist.length > 0) {
    const rendered = hist
      .map((m) => `${m.role === "assistant" ? "AI" : "考生"}:${m.content.trim()}`)
      .join("\n");
    lines.push("\n【最近对话(仅供你判断语境,不要据此改写考生的话)】\n" + rendered);
  }
  if (ctx.question && ctx.question.trim()) {
    lines.push("\n【当前所问的题目(仅供判断语境,切勿据此替考生作答或评价对错)】\n" + ctx.question.trim());
  }
  return lines.join("\n");
}

/** 解析判定输出为 complete/incomplete;无法识别 → null(判不了 → fail-open 不纠偏)。
 *  - 优先 incomplete(保守:incomplete 含 "complete" 子串,朴素 includes 会双命中;宁可判没说完不冤开口);
 *  - 都不含 → null。 */
export function parseEouVerdict(out: string): EouVerdict | null {
  const s = (out ?? "").trim().toLowerCase();
  if (!s) return null;
  // 保守:先查 incomplete(它包含 "complete" 子串,顺序不能反)。任一形式命中即判 incomplete。
  if (s.includes("incomplete") || s.includes("not complete") || s.includes("未说完") || s.includes("没说完")) {
    return "incomplete";
  }
  if (s.includes("complete") || s.includes("说完了")) return "complete";
  return null;
}

/**
 * 判一次句子完整性。返回 complete/incomplete;任何失败/超时/abort/非法输出 → **null**(判不了,绝不抛)。
 * 调用方(media-session)据 verdict === "incomplete" 决定是否降门槛纠偏(null/complete 均不纠偏)。
 */
export async function judgeEou(
  text: string,
  modelId: string,
  mantle: MantleConfig,
  ctx: EouContext,
  deps: {
    /** 单次补全的**已绑定上游**闭包(design contract:media-session 按 call_method 传 mantle 或 converse 的 complete)。
     *  缺省 = mantle(`mantleCompleteOnce` 绑定传入的 `mantle` cfg)。 */
    complete?: (prompt: string, userText: string, signal: AbortSignal) => Promise<string>;
    timeoutMs?: number;
    onError?: (reason: string) => void; // 记 metric/日志(旁路,不拖垮)
    /** 外部中止信号(会话结束 media-session 据此 abort 所有飞行中判定,不等待)。 */
    externalSignal?: AbortSignal;
  } = {},
): Promise<EouVerdict | null> {
  const userText = (text ?? "").trim();
  if (!userText) return null; // 空句不判(调用方通常已跳过,双保险)
  const complete =
    deps.complete ??
    ((prompt: string, ut: string, signal: AbortSignal) =>
      // maxTokens 小:判定只回一个词,给足余量即可(省延迟/成本)。
      mantleCompleteOnce(mantle, { modelId, systemPrompt: prompt, userText: ut, maxTokens: 16 }, signal));
  const timeoutMs = deps.timeoutMs ?? eouVerdictTimeoutMs();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onExternalAbort = () => ac.abort();
  if (deps.externalSignal) {
    if (deps.externalSignal.aborted) ac.abort();
    else deps.externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const raw = await complete(buildEouSystemPrompt(ctx), userText, ac.signal);
    const verdict = parseEouVerdict(raw);
    if (verdict == null) {
      deps.onError?.("invalid_output");
      return null; // 输出不可信 → 判不了(不纠偏)
    }
    return verdict;
  } catch (e) {
    const reason = deps.externalSignal?.aborted
      ? "session_ended"
      : ac.signal.aborted
        ? "timeout"
        : `error:${(e as Error).message}`;
    deps.onError?.(reason);
    return null; // 超时/报错/abort → 判不了(不纠偏)
  } finally {
    clearTimeout(timer);
    if (deps.externalSignal) deps.externalSignal.removeEventListener("abort", onExternalAbort);
  }
}
