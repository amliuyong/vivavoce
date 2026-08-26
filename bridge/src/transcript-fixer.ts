/**
 * ASR 字幕 LLM 修正(design contract)—— **旁路**纠正 user ASR final 文本里的错字(同音字/数字/口语残字),
 * 用于**客户端字幕更新 + 转写落库**;**MUST NOT 碰对话路径、MUST NOT 加首声延迟**。
 *
 * 编排在 media-session(seq/占位落库/覆盖/abort),本模块只管「一次修正」的纯逻辑:
 *   建修正 prompt(结合上下文,只纠错字不改写)→ 经 mantle 非流式单次调用 → 校验输出 → fail-open 原文。
 *
 * 设计要点(评审收敛):
 *  - 上下文只给「最近几轮对话 + 当前题干」,**不给参考答案**(engine.correctionContext 已把关):防 LLM
 *    顺着答案把用户答错的改对(那是篡改作答,非修字幕)。
 *  - 输出校验:空 / 多行(疑似解释)/ 明显超长(>2× 原文,疑似改写补全)→ **fail-open 落原文**(宁可不修不乱改)。
 *  - 超时(默认 8s,env 可调,上限 15s)/ 报错 / abort → fail-open 原文。
 *  - 纯静默空句(text 去空白后为空)由调用方跳过(不进本模块)。
 */
import { MantleConfig, mantleCompleteOnce } from "./mantle-llm";

export interface CorrectionContext {
  history?: { role: "user" | "assistant"; content: string }[];
  question?: string;
}

/** 修正超时:默认 8s,env AIM_TRANSCRIPT_FIXER_TIMEOUT_MS 可调(下限 1s,上限 15s;旁路慢不拖垮体感)。 */
// design contract:同 eou-verdict —— 配置下沉到 `bypass-llm-config`,此处 re-export 保 API。
import { fixerTimeoutMs } from "./bypass-llm-config";
export { fixerTimeoutMs };

/** 建修正 prompt 的 system 段。硬约束:只纠错字、不改写/不补全/不解释/不答题,只回修正后的那一句。 */
export function buildFixerSystemPrompt(ctx: CorrectionContext): string {
  const lines: string[] = [
    "你是语音识别(ASR)转写纠错助手。下面这句话是用户说话经 ASR 转成的文字,几乎总有识别错误,常见:",
    "- 同音/近音字:如「俩个」→「两个」、「闰年」→「软件」、「期终」→「期中」、「树叶」→「书页」;",
    "- 音节切分错误:把一个词拆错或粘连,如「那道题」→「那到底」、「一起」→「一起来」;",
    "- 数字识别错误:如「62」被听成「42」、「一百」→「100」的混淆;",
    "- 漏字、口语残字、标点缺失。",
    "你的任务:**结合上下文语义,把这句话还原成用户最可能实际说的那句通顺的话**。",
    "判断依据:若某处读起来**不通顺、不合逻辑、或与上下文对不上**,极可能是 ASR 识别错,应据上下文改成合理的词。",
    "但严格保持克制:**只纠错字/音节/数字,不改写措辞语气、不补全没说完的话、不替用户回答问题、不增删语义内容**。",
    "只输出修正后的那一句话本身(长度与原句基本一致),不要输出任何解释、说明或引号。若通读确实无误,才原样返回。",
  ];
  const hist = (ctx.history ?? []).filter((m) => m && typeof m.content === "string" && m.content.trim());
  if (hist.length > 0) {
    const rendered = hist
      .map((m) => `${m.role === "assistant" ? "AI" : "用户"}:${m.content.trim()}`)
      .join("\n");
    lines.push("\n【最近对话(仅供你判断错字,不要据此改写用户的话)】\n" + rendered);
  }
  if (ctx.question && ctx.question.trim()) {
    lines.push("\n【当前所问的题目(仅供判断专有名词/数字,切勿据此替用户作答)】\n" + ctx.question.trim());
  }
  return lines.join("\n");
}

/** 校验修正输出是否可信:不可信 → 返回 null(调用方 fail-open 落原文)。
 *  - 空 → null;
 *  - 多行(含换行,疑似解释/列点)→ null;
 *  - 明显超长(> 2× 原文长度 + 8 余量,疑似改写/补全/带解释)→ null。 */
export function validateFixerOutput(original: string, out: string): string | null {
  const fixed = (out ?? "").trim();
  if (!fixed) return null;
  if (/[\r\n]/.test(fixed)) return null; // 多行 = 疑似解释,不信
  if (fixed.length > original.trim().length * 2 + 8) return null; // 明显超长 = 疑似改写/补全,不信
  return fixed;
}

/**
 * 修正一句 ASR final。返回修正后文本;任何失败/超时/输出不可信 → 返回**原文**(fail-open,绝不抛)。
 * 调用方(media-session)据「返回 !== 原文」决定是否下行 transcript_corrected + 覆盖落库。
 */
export async function correctTranscript(
  original: string,
  modelId: string,
  mantle: MantleConfig,
  ctx: CorrectionContext,
  deps: {
    /** 单次补全的**已绑定上游**闭包(design contract:media-session 按 call_method 传 mantle 或 converse 的 complete)。
     *  缺省 = mantle(`mantleCompleteOnce` 绑定传入的 `mantle` cfg),向后兼容 design contract。 */
    complete?: (prompt: string, userText: string, signal: AbortSignal) => Promise<string>;
    timeoutMs?: number;
    onError?: (reason: string) => void; // 记 metric/日志(旁路,不拖垮)
    /** 外部中止信号(design contract:会话结束 media-session 据此 abort 所有飞行中修正,不等待)。 */
    externalSignal?: AbortSignal;
  } = {},
): Promise<string> {
  const text = (original ?? "").trim();
  if (!text) return original; // 空句不修(调用方通常已跳过,双保险)
  // 缺省 complete = mantle 非流式(绑定传入的 mantle cfg + modelId),向后兼容 design contract。
  const complete =
    deps.complete ??
    ((prompt: string, userText: string, signal: AbortSignal) =>
      mantleCompleteOnce(mantle, { modelId, systemPrompt: prompt, userText }, signal));
  const timeoutMs = deps.timeoutMs ?? fixerTimeoutMs();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  // 外部信号(会话结束)→ 一并 abort 本次修正(旁路,不拖会话收尾)。已 aborted 则立即 abort。
  const onExternalAbort = () => ac.abort();
  if (deps.externalSignal) {
    if (deps.externalSignal.aborted) ac.abort();
    else deps.externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const raw = await complete(buildFixerSystemPrompt(ctx), text, ac.signal);
    const valid = validateFixerOutput(text, raw);
    if (valid == null) {
      deps.onError?.("invalid_output");
      return original; // 输出不可信 → 原文
    }
    return valid;
  } catch (e) {
    // 区分「本次超时」与「会话结束外部 abort」(externalSignal 触发)——都 fail-open 原文,但 metric 原因不同。
    const reason = deps.externalSignal?.aborted ? "session_ended" : ac.signal.aborted ? "timeout" : `error:${(e as Error).message}`;
    deps.onError?.(reason);
    return original; // 超时/报错/abort → 原文
  } finally {
    clearTimeout(timer);
    if (deps.externalSignal) deps.externalSignal.removeEventListener("abort", onExternalAbort);
  }
}
