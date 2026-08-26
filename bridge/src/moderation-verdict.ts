/**
 * design contract:旁路**违规裁判** —— 每轮考生 ASR final 后异步问 LLM「这句在正常答题 / 明说不会 / 扯无关闲话 /
 * 严重不当内容(色情暴力威胁)/ 拿不准」,并顺带判「这题答充分没(answer_complete)」。
 *
 * **MUST NOT 阻塞主对话 / 游标推进关键路径**(跨境 LLM 0.8~9s,比对话节奏慢):只异步 fire-and-forget,
 * 编排在 media-session(userTurnId 去重 / inflight 背压 / fail-open / 会话结束 abort);本模块只管「一次裁判」纯逻辑。
 *
 * 与 design contract eou-verdict / design contract transcript-fixer 同构(复用旁路骨架:非流式单次 mantle/converse 调用 +
 * fail-open + abort),但:
 *  - 输出 = 结构化 JSON(分类 + confidence + answer_complete),非单词。
 *  - **分类是可观察事实**(review + review:"故意逃避"意图不能靠单条文本可靠判,故只判可观察类别,
 *    是否算违规/消极对抗由 media-session 据跨轮证据 + 阈值决定):
 *      on_topic_attempt   = 在答这道题(含答错、答得不完整)—— **不违规**(核心保护:答错不会绝不罚)
 *      explicit_decline   = 明说不会/跳过/不知道 —— **不违规**
 *      unrelated_chatter  = 说与题无关的闲话(单轮只标,需跨多轮重复才算消极对抗)
 *      severe_directed_abuse = 色情/暴力/威胁等严重不当内容
 *      uncertain          = 拿不准 —— **不违规**(宁漏勿误)
 *  - 超时默认 **8000ms**(裁判 prompt 比 EOU 重、复用打分模型更慢;跨境须足够大,见 design contract 教训)。
 *  - 任何失败(超时/报错/abort/非法输出)→ **null**(判不了);media-session 见 null 视作「本轮不判违规、不给推进票」
 *    (fail-open,绝不误罚/误挂)。
 */
import { MantleConfig, mantleCompleteOnce } from "./mantle-llm";

/** 可观察事实分类(见文件头)。非违规:on_topic_attempt/explicit_decline/uncertain;违规候选:unrelated_chatter(需跨轮)/severe_directed_abuse。 */
export type ModerationClass =
  | "on_topic_attempt"
  | "explicit_decline"
  | "unrelated_chatter"
  | "severe_directed_abuse"
  | "uncertain";

export interface ModerationVerdict {
  klass: ModerationClass;
  confidence: number; // 0~1;媒体面据 AIM_MODERATION_CONFIDENCE_THRESHOLD(默认 0.8)判是否高置信
  answerComplete: boolean; // 这道题答充分没(作 [[NEXT]] 之外的辅助推进票,不主导游标)
}

export interface ModerationContext {
  history?: { role: "user" | "assistant"; content: string }[];
  question?: string;
}

/** 裁判超时:默认 8000ms(裁判比 EOU 重;跨境 TTFT 1.2~9.3s,须足够大,见 design contract memory)。env
 *  AIM_MODERATION_TIMEOUT_MS 可调,夹在 [1000ms, 20000ms](上限宽:打分模型 + 结构化输出可能很慢)。 */
// design contract:同 eou-verdict —— 配置下沉到 `bypass-llm-config`,此处 re-export 保 API。
import { moderationTimeoutMs } from "./bypass-llm-config";
export { moderationTimeoutMs };

/** 建裁判 prompt 的 system 段。硬约束:只判可观察类别 + confidence + answer_complete,不替考生答题、不评价对错。
 *  ★ prompt 严调(design contract / review + review):答错/不会/拿不准一律**不违规**;confidence 校准;举边缘例。 */
export function buildModerationSystemPrompt(ctx: ModerationContext): string {
  const lines: string[] = [
    "你是口试的「发言合规」旁路裁判。下面是考生刚说的一句话(经语音识别转文字,可能有错字)。",
    "请只做**客观分类**(不替考生答题、不评价答案对错),把这句话归入下列**唯一**一类:",
    "- on_topic_attempt:在尝试回答当前这道题(**哪怕答错了、答得不完整、跑偏但仍在谈这个话题**);",
    "- explicit_decline:明确表示不会/不知道/想跳过这题(如「这个我不会」「不知道」「跳过吧」);",
    "- unrelated_chatter:说与本题**完全无关**的闲话(如「今天天气真好」「你叫什么名字」),明显不在答题;",
    "- severe_directed_abuse:**针对考官/他人/系统的定向**辱骂、威胁、性骚扰(如辱骂考官、威胁施暴、性挑逗)。" +
      "**注意**:正常回答里**引用/分析/讨论**暴力、安全、色情、法律等题目主题(如答「如何防范网络暴力」「DDoS 攻击原理」)" +
      "**不算** severe——那是 on_topic_attempt;只有把攻击**指向人**才算 severe;",
    "- uncertain:你拿不准归哪类。",
    "**关键原则(务必遵守)**:",
    "1. 答错、答得烂、坦白不会、拿不准——**都不是违规**,分别归 on_topic_attempt / explicit_decline / uncertain,",
    "   **绝不要**因为答得差就归 unrelated_chatter 或 severe。考试允许答错。",
    "2. 只有**明显、无歧义**地在扯无关闲话才归 unrelated_chatter;只有**明确**的严重不当内容才归 severe_directed_abuse。",
    "3. 有半点犹豫就归 uncertain(宁可漏判,不可误伤正常考生)。",
    "同时判断两个附加信号:",
    "- confidence:你对上面分类的把握(0~1)。校准:**0.9 以上**=证据明确无歧义;0.7~0.8=有倾向但存模糊;**0.7 以下**=拿不准。",
    "- answer_complete:考生对当前题是否已**答充分、可以进入下一题**(true/false;仅供参考,判不准填 false)。",
    "**只输出一个 JSON 对象**,形如 " +
      '{"klass":"on_topic_attempt","confidence":0.9,"answer_complete":true},不要输出任何解释或多余文字。',
    "边缘例:考生说「Lambda 冷启动大概是…代码太大?」→ on_topic_attempt(在答,哪怕错);",
    "「这个真没学过」→ explicit_decline;「哎你们这系统挺好玩的,不聊题了」→ unrelated_chatter;",
    "答了个不太相关的概念但仍试图关联本题 → on_topic_attempt(不确定就别往 unrelated 判)。",
  ];
  const hist = (ctx.history ?? []).filter((m) => m && typeof m.content === "string" && m.content.trim());
  if (hist.length > 0) {
    const rendered = hist
      .map((m) => `${m.role === "assistant" ? "AI" : "考生"}:${m.content.trim()}`)
      .join("\n");
    lines.push("\n【最近对话(仅供判断语境,不要据此改写考生的话)】\n" + rendered);
  }
  if (ctx.question && ctx.question.trim()) {
    lines.push("\n【当前所问的题目(仅供判断语境,切勿据此替考生作答)】\n" + ctx.question.trim());
  }
  return lines.join("\n");
}

const _VALID_CLASSES: ReadonlySet<string> = new Set<ModerationClass>([
  "on_topic_attempt",
  "explicit_decline",
  "unrelated_chatter",
  "severe_directed_abuse",
  "uncertain",
]);

/** 解析裁判 JSON 输出为 ModerationVerdict;无法识别/缺 klass → null(判不了 → fail-open)。
 *  容错:抽第一个 {...} 片段 json.parse;klass 非法 → null;confidence 越界钳到 [0,1]、缺省 0;answer_complete 缺省 false。
 *  **保守兜底**:解析出的 klass 不在白名单 → 归 uncertain?不——直接 null(判不了),让 media-session fail-open 不罚。 */
export function parseModerationVerdict(out: string): ModerationVerdict | null {
  const s = (out ?? "").trim();
  if (!s) return null;
  // 抽第一个花括号片段(容忍模型在 JSON 前后带解释文字)。
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const klass = typeof obj.klass === "string" ? obj.klass.trim() : "";
  if (!_VALID_CLASSES.has(klass)) return null; // 非法/缺 klass → 判不了(fail-open)
  // confidence 严格校验(review):**存在但非有限数** = 输出畸形 → null(整条判不了,fail-open);
  //   **完全缺失** → 视作 0(低置信,永不达违规阈,安全)。避免「畸形响应却产出高置信 verdict」。
  if ("confidence" in obj && !(typeof obj.confidence === "number" && Number.isFinite(obj.confidence))) return null;
  const confidence = Math.min(1, Math.max(0, typeof obj.confidence === "number" ? obj.confidence : 0)); // 钳 [0,1];缺→0
  const answerComplete = obj.answer_complete === true; // 仅显式 true 才 true(缺/非布尔→false,保守)
  return { klass: klass as ModerationClass, confidence, answerComplete };
}

/**
 * 裁判一次。返回 ModerationVerdict;任何失败/超时/abort/非法输出 → **null**(判不了,绝不抛)。
 * 调用方(media-session)据分类 + confidence + 跨轮证据决定是否计违规;据 answerComplete 决定辅助推进票。
 */
export async function judgeModeration(
  text: string,
  modelId: string,
  mantle: MantleConfig,
  ctx: ModerationContext,
  deps: {
    /** 单次补全的**已绑定上游**闭包(design contract:media-session 按 call_method 传 mantle 或 converse 的 complete)。
     *  缺省 = mantle(`mantleCompleteOnce` 绑定传入的 `mantle` cfg)。 */
    complete?: (prompt: string, userText: string, signal: AbortSignal) => Promise<string>;
    timeoutMs?: number;
    onError?: (reason: string) => void;
    externalSignal?: AbortSignal;
  } = {},
): Promise<ModerationVerdict | null> {
  const userText = (text ?? "").trim();
  if (!userText) return null; // 空句不判
  const complete =
    deps.complete ??
    ((prompt: string, ut: string, signal: AbortSignal) =>
      // maxTokens 给足结构化 JSON(klass+confidence+answer_complete);64 够用。
      mantleCompleteOnce(mantle, { modelId, systemPrompt: prompt, userText: ut, maxTokens: 64 }, signal));
  const timeoutMs = deps.timeoutMs ?? moderationTimeoutMs();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onExternalAbort = () => ac.abort();
  if (deps.externalSignal) {
    if (deps.externalSignal.aborted) ac.abort();
    else deps.externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const raw = await complete(buildModerationSystemPrompt(ctx), userText, ac.signal);
    const verdict = parseModerationVerdict(raw);
    if (verdict == null) {
      deps.onError?.("invalid_output");
      return null;
    }
    return verdict;
  } catch (e) {
    const reason = deps.externalSignal?.aborted
      ? "session_ended"
      : ac.signal.aborted
        ? "timeout"
        : `error:${(e as Error).message}`;
    deps.onError?.(reason);
    return null;
  } finally {
    clearTimeout(timer);
    if (deps.externalSignal) deps.externalSignal.removeEventListener("abort", onExternalAbort);
  }
}
