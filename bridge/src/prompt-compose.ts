/**
 * 把 Profile 的人设(system_prompt)+ 题库(questions[])合成引擎用的有效 system prompt(review)。
 *
 * AIM 内核是「人设 + 题库 + rubric」;媒体面引擎只吃一段 system_prompt,故把题库附到人设后,指示 LLM 提问。
 * 控制面下发 questions,此处统一注入 —— 引擎不感知题库结构、不感知题目来自哪个题库/什么策略。
 *
 * **出题游标(design contract)**:composePrompt 现按**服务端游标** cursor **逐题注入**(见下),取代旧「一次性
 * 铺全部题」——顺序由代码保证、LLM 看不到未问的题。引擎每轮据当前游标调用一次(动态渲染),而非在会话
 * 预创建时烘死一份静态 prompt。游标推进判据(何时 +1)在 ThreeStageEngine(design contract 判据 a–e)。
 */
export interface QuestionLike {
  text?: string;
  reference_answer?: string;
  // design contract:题目级 follow_up 已废弃。历史固化题残留该键 → 落入下方索引签名、被忽略。
  [k: string]: unknown;
}

/**
 * 三个提示词注入开关的**布尔解析**(design contract:单一事实源)。
 *
 * 都是「唯 `"0"` 关、默认开」口径 —— 首轮移植曾把这三项的默认值抄成**默认关**(口径反转),
 * 故此后 registry / `/config` MUST 复用这些函数,MUST NOT 另写 `!== "0"` 或字面量默认。
 *
 * ⚠ 注意这些只是**总开关**;`interactionStyleDirective` / `openChatDirective` 另有
 * 「按 questionCount 有题/无题分流」的门控(见各函数),不在这里表达。
 */
export const CALM_TONE_DEFAULT = true;
export const INTERACTION_STYLE_DEFAULT = true;
export const OPEN_CHAT_DIRECTIVE_DEFAULT = true;

/** 语气克制注入总开关:默认开,`AIM_CALM_TONE=0` 关。 */
export function calmToneEnabled(): boolean {
  return process.env.AIM_CALM_TONE !== "0";
}
/** 应答方式注入总开关(仅有题时注入):默认开,`AIM_INTERACTION_STYLE=0` 关。 */
export function interactionStyleEnabled(): boolean {
  return process.env.AIM_INTERACTION_STYLE !== "0";
}
/** 自由交流注入总开关(仅无题时注入):默认开,`AIM_OPEN_CHAT_DIRECTIVE=0` 关。 */
export function openChatDirectiveEnabled(): boolean {
  return process.env.AIM_OPEN_CHAT_DIRECTIVE !== "0";
}

/**
 * 语言硬约束(真机根因 deployment validation:AI 说英文/日文)。三段式 LLM 只吃 Profile.system_prompt;若 Profile
 * 提示词弱(甚至是测试残留 "v2"),没有任何东西强制输出语言 → Claude 随机用英/日。engine.language 此前
 * 只存不用(dead config)。这里据 language 生成**置顶的硬指令**,无条件钉死输出语言,压过弱 Profile 提示词。
 */
export function languageDirective(language?: string): string {
  const lang = (language || "zh-CN").toLowerCase();
  // auto(跟随题目语言):不硬钉死,用题目本身所用语言对话(英文题库→全程英文,中文题库→全程中文;
  // 题库不设语言字段,题目原文的语言即语言)。题目原文拼在本指令之后(composePrompt),LLM 看得到,靠指令
  // 驱动、不做代码语种检测。无题目时降级跟随对方语言。文案 MUST 与 backend prompt_directives 逐字等价。
  if (lang.startsWith("auto")) {
    return "【语言】请用题目本身所使用的语言与对方对话:题目是中文就用简体中文,题目是英文就用英文," +
      "全程保持与题目一致的语言,不要擅自翻译题目。若本场没有题目,则自然跟随对方说话的语言" +
      "(对方说中文用中文、说英文用英文)。同一句话内不要中英文混杂。\n\n";
  }
  if (lang.startsWith("zh")) {
    return "【语言】你必须始终用简体中文与对方对话,无论对方用什么语言,都只用中文回答。不要使用英文或日文等其它语言。\n\n";
  }
  if (lang.startsWith("en")) {
    return "【Language】Always respond in English regardless of the language the other party uses.\n\n";
  }
  if (lang.startsWith("ja")) {
    return "【言語】相手が何語を話しても、常に日本語で応答してください。\n\n";
  }
  return "";
}

/**
 * 语气平稳硬约束(真机根因 deployment validation:AI 语气起伏大/不平稳)。真根源在**文本层**——LLM(Claude)回复
 * 自带强情绪标记:感叹号、emoji(😊)、语气词(呀/啦/呢/哦/~),TTS 忠实合成 → 听感忽扬忽顿。
 * (曾试调 TTS 韵律温度 position_temperature 5→3,真机录音 CV 未降、无效,证实问题不在 TTS 段。)
 * 故在文本层置顶硬约束:语气平稳克制、零标点情绪化。与 languageDirective 同处置顶,压过弱 Profile 提示词。
 * 默认开;env AIM_CALM_TONE=0 关(回退 LLM 原生风格,便于 A/B 对比听感)。语音通话才需要(文字渠道无所谓)。
 */
export function toneDirective(): string {
  if (!calmToneEnabled()) return "";
  return (
    "\n\n【语气】这是语音通话,你的话会被朗读出来。请保持语气平稳、自然而克制,像专业且温和的真人:" +
    "不要使用感叹号,不要使用任何 emoji 或颜文字,尽量少用语气词(如「呀、啦、呢、哦、嘛」和波浪号「~」);" +
    "用平实的陈述句和适度的停顿表达,避免夸张、卖萌或情绪化的腔调。"
  );
}

/**
 * 当前日期时间注入(LLM 无实时时钟,问「今天几号」会瞎编)。AI 与参会者说中文,用北京时间(UTC+8)+
 * 中文星期。每次会话预创建时实时生成(非进程启动时),保证多日运行的实例也拿到当下日期。
 */
export function nowContextLine(now: Date = new Date()): string {
  const cn = new Date(now.getTime() + 8 * 3600 * 1000); // UTC → 北京时间
  const wd = "日一二三四五六"[cn.getUTCDay()];
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${cn.getUTCFullYear()}年${p(cn.getUTCMonth() + 1)}月${p(cn.getUTCDate())}日 星期${wd} ` +
    `${p(cn.getUTCHours())}:${p(cn.getUTCMinutes())}`;
  return (
    `\n\n【当前时间】现在是北京时间 ${stamp}。` +
    "若对方问及今天日期/星期/现在几点,以此为准如实回答,不要编造。"
  );
}

/**
 * ASR 容错指令(仅三段式)。三段式里对方语音先经 ASR 转成文字再喂 LLM,口音/底噪/同音字会让转写
 * 出错(如「闰年」→「软件」、漏字、串字)。默认 LLM 不知道输入来自 ASR,会把错字当原意死磕。这里
 * 明确告诉 LLM:输入是语音转写、可能有误,**据上下文推断真实意图**,不确定时自然澄清而非纠结字面。
 * 仅三段式注入;Nova S2S 直接听音频、无 ASR 文字中介,不需要(也不应误导它"输入是文字")。
 */
export function asrAwarenessDirective(): string {
  return (
    "\n\n【关于对方的话】对方的话是经语音识别(ASR)转成的文字,可能有同音字、漏字或识别错误。" +
    "请结合上下文推断对方的真实意思,不要被个别明显是识别错误的字面绊住;" +
    "若整句确实听不懂或有歧义影响作答,再自然地请对方重说一遍,不要生硬纠错或反复追问。"
  );
}

/**
 * 完成强制硬指令(design contract;design contract 措辞去机器感)。**仅当本场有预设题目时**注入——测评语义:所有
 * 预设问题作答完成前不主动结束,对方要走则温和坚持继续,而非生硬拒绝。硬指令(不靠 Agent system_prompt 自觉)。
 * 与出题游标(引擎强制推进)+ 上层压制 [[END_CALL]] 配合:对方想走 → AI 引导接着聊,聊完才收尾。
 * 无题(纯人设对话)不注入(无「问完」概念,挂断照常)。
 *
 * **design contract**:标题去「考试」字眼(改「本场规则」,保留「规则」的强制语义,不弱到像建议);坚持话术
 * 去「考试 / 第 N 题 / 还剩 N 题 / 下一题」等题数/题号/考试外壳(与 design contract「不向对方暴露机械流程」一致),
 * **行为约束一字不变**(未作答完不提前结束 + 继续引导作答;靠游标推进实现,非复读/无响应)。
 */
export function examCompletionDirective(questionCount: number): string {
  if (!questionCount || questionCount <= 0) return "";
  return (
    "\n\n【本场规则】本场有预设的问题需要对方作答,所有问题聊完之前不要主动结束对话。若对方表示想结束/挂断/" +
    "不想聊了,请**温和地坚持**:用一句话自然地说明「我们把要聊的都聊完再结束比较好,我们接着说」,然后" +
    "**自然地继续引导对方就当前问题作答**;不要生硬拒绝、不要反复说同一句、也不要在还没聊完时说结束或挂断的话。" +
    "等要聊的都聊完了,再自然收尾。"
  );
}

/**
 * 交互风格硬指令(design contract)。**仅在有预设题目时注入**(`questionCount > 0`,与 examCompletionDirective
 * 对称——门控收进函数内,不靠调用点外置三元,防重构误删把闲聊陪伴人设逼成冷淡机械;review)。约束 AI
 * 应答方式,压过弱 Agent 人设,与 toneDirective(语气平稳)协同——语气指令管「怎么说」,本指令管「说什么/不说什么」:
 *  - 不复述/总结对方的整段回答;
 *  - 不评价、夸奖、附和、讨好;
 *  - 仅当 ASR/表达歧义导致没听清对方在说什么时,最小必要地简短确认或请对方重说;
 *  - 不实时判断/纠正答案,不通过追问提示标准答案;对方已明确表达后即中立收口并推进。
 * 默认开;env AIM_INTERACTION_STYLE=0 关(回退不注入,便于 A/B,与 AIM_CALM_TONE 先例一致)。
 */
export function interactionStyleDirective(questionCount: number): string {
  if (!questionCount || questionCount <= 0) return ""; // 无题(纯人设)不注入,与 examCompletionDirective 对称
  if (!interactionStyleEnabled()) return "";
  return (
    "\n\n【应答方式】这是自然的口头交流,请像专业、中立的真人考官那样应答:" +
    "不要复述或总结对方刚说的整段回答(不要说「你刚才说的是…」「你的意思是…」);" +
    "不要评价、夸奖、附和或讨好对方(不要说「很好」「不错」「回答得很棒」「厉害」之类);" +
    "只有当 ASR 或表达歧义导致你没听清对方在说什么时,才用最简短的一句中立确认或请对方重说;" +
    "不要实时判断或公布答案是否正确,不要纠正、补充、暗示标准答案,也不要通过反问或拆小问题引导对方猜答案。" +
    "对方已经明确表达后,即使你认为内容可能错误或有遗漏,也中立收口并自然推进,把评分和纠错留给事后报告。"
  );
}

/**
 * 自由聊天(无题)持续对话硬指令(design contract)。**仅无题(`questionCount <= 0`)时注入**——与
 * `examCompletionDirective` **对称互斥**(有题=测评走完成强制,无题=自由聊天走本指令,由 questionCount 单一维度分流,
 * 恰好注入其一;门控收在函数内,与 examCompletion/interactionStyle 同构,防重构误删)。
 *
 * **根因(design contract)**:无题路径此前两层「不主动结束」保险皆空(examCompletion/interactionStyle 被 !questionCount
 * 门控掉 + composePrompt 无题 return base + 挂断闸门 hasPendingQuestions 无题返 false)→ 自由聊天全凭 LLM 自觉,
 * LLM 聊几轮自然「感觉聊完」→ 输出 [[END_CALL]] → 无闸门 → 挂。本指令是第一层(提示词)修复:明确「持续对话、
 * 不主动收尾、只有对方明确要走才走两步确认」。第二层(程序硬闸门 blockedByOpenChat)在 media-session。
 *
 * 注意:本指令是**软约束**(压过弱人设,但 LLM 仍可能飘)——铁律级「不主动挂」由 media-session 的 blockedByOpenChat
 * 硬闸门兜底(design contract)。与 END_CALL_DIRECTIVE 的 mode-aware 无题变体(three-stage-engine)配合:该变体已删「AI
 * 感觉对话要结束就先确认」的主动性,本指令进一步正向约束「保持对话继续」。
 *
 * **交互风格并入(review)**:`interactionStyleDirective` 仅有题注入,无题时缺「语气克制/不夸奖/不复述」约束,
 * 故在此补一份精简版(语音陪聊也需要平稳克制,不夸张卖萌)。
 * 默认开;env `AIM_OPEN_CHAT_DIRECTIVE=0` 关(回退不注入,便于 A/B,命名对齐 AIM_CALM_TONE/AIM_INTERACTION_STYLE)。
 */
export function openChatDirective(questionCount: number): string {
  if (questionCount && questionCount > 0) return ""; // 有题(纯人设+题库=测评)不注入,与 examCompletionDirective 对称
  if (!openChatDirectiveEnabled()) return "";
  return (
    "\n\n【自由交流】这是一场开放式、持续的对话(陪对方聊天或练习口语),没有预设的问题清单。请像自然聊天一样一直" +
    "接着聊下去:对方停顿时,你可以自然地接话、回应或引出新的相关话题,保持对话继续。" +
    "**不要主动发起结束或告别**——不要因为「感觉聊得差不多了 / 话题告一段落 / 没有更多要问的了」就说要结束或挂断;" +
    "在这种自由交流里,**你不主动判断对话该不该结束**。只有当对方明确表示要走 / 要结束 / 不想聊了 / 主动告别时," +
    "你才按结束确认的方式,先自然地确认一句,对方确实要走了再收尾。" +
    "语气保持自然、平稳、克制,不夸张、不刻意夸奖或复述对方整段话,像一个专注而温和的聊天对象。"
  );
}

/**
 * 会话就绪时组装「置顶指令 + 人设」的有效 system prompt(design contract:抽为单一事实源纯函数,便于单测接线条件——
 * 评审 Major:此前组装散在 index.ts 的 HTTP handler 里,接线条件(有题/无题、flag 开关)零测试覆盖)。
 * 题目**不**在此拼入——引擎按服务端游标逐题注入(composePrompt),这里只组装人设 + 各置顶硬指令。
 *
 * 注入顺序(置顶硬指令压过弱 Agent 人设):语言 → 语气 → 人设 → ASR 容错 → 完成强制(仅有题)→
 * 交互风格(仅有题,design contract)→ 当前时间。examCompletionDirective / interactionStyleDirective 各自
 * **内部**据 questionCount 决定是否注入(门控收在函数里,不在此处外置三元;review:防重构误删)。
 *
 * ★ questionCount 口径(review):调用方 MUST 传**有效题数** `validQuestions(questions).length`,
 *   而非原始下发数组长度——与引擎 composePrompt 的 validQuestions 过滤同口径,避免「全是脏题(空 text)时
 *   注入『本场有题』指令但实际一道不问」的自相矛盾。
 */
export function composeSessionPrompt(opts: {
  language?: string;
  systemPrompt?: string;
  questionCount: number; // 有效题数(validQuestions 过滤后),见上口径说明
  now?: Date;
}): string {
  return (
    languageDirective(opts.language) +
    toneDirective() +
    (opts.systemPrompt ?? "") +
    asrAwarenessDirective() +
    examCompletionDirective(opts.questionCount) + // 门控在函数内(questionCount<=0 返回空)
    interactionStyleDirective(opts.questionCount) + // 同上,与 examCompletion 对称
    openChatDirective(opts.questionCount) + // design contract:无题(自由聊天)注入持续对话/不主动收尾,与 examCompletion 互斥
    nowContextLine(opts.now ?? new Date())
  );
}

/** 归一化题目数组:过滤非对象/空题干,返回**有效题**——仅用于 bridge 侧「问什么/游标推进」。
 *
 *  ★ index 对齐边界(review):evaluator 按**控制面固化的全量 `meta.questions`** 逐题 index 对齐打分,
 *  与 bridge 的游标/过滤**互不影响**(evaluator 读 DDB meta,不读 bridge 的这份)。正常流程下 backend 的
 *  `Question.text: str`(Pydantic 必填)+ resolve_questions 固化 → **不会产出空题干/非对象项**,故此过滤在正常
 *  流程是 no-op、bridge 逐题注入的题号与 evaluator 的 index 天然一致。此处过滤只是**防御 DDB 历史脏数据/直写**
 *  导致的运行时无法提问的坏项(非对象/空 text),避免 composePrompt 渲染出空题号;它不改变 evaluator 打分依据。 */
export function validQuestions(questions: unknown[]): QuestionLike[] {
  return (questions ?? [])
    .filter((q): q is QuestionLike => !!q && typeof q === "object")
    .filter((q) => String(q.text ?? "").trim().length > 0);
}

/**
 * 出题游标逐题注入(design contract「出题游标由服务端强推进」)——修订「一次性铺全部题」的旧做法。
 *
 * 每一轮 LLM 生成时按**服务端游标** cursor 渲染 LLM 可见的题目范围:
 *  - **已问过的题**(index < cursor):仅注入**题干摘要**(承上启下用,MUST NOT 含 reference_answer);
 *  - **当前应问的题**(index == cursor):只注入题干;reference_answer 仅保留在 evaluator 会话快照,
 *    不进入实时对话 LLM(防追问时直接或改写泄露标准答案);
 *  - **未问到的题**(index > cursor):**完全不可见**(LLM 想跳题/并问/乱序在源头即不可能)。
 *
 * 顺序由代码(游标)保证,不再依赖提示词自觉。cursor 越界(≥ 有效题数)= 全部问完,不再注入新题
 * (返回纯人设 base,让 AI 自然收尾)。questions 为空 = 纯人设对话,退化为 base(无游标)。
 */
export interface PromptProgressionContext {
  /** design contract:runLlmTurn 入口按当前 cursor 的追问预算快照决定。 */
  forceQuestionClosure?: boolean;
  /** 当前 cursor 题干是否已完整播出。true 时本轮只处理回答/追问/收口,不得重念题干。 */
  questionAlreadyVoiced?: boolean;
  /** 当前题在客户端估算播放完前被用户开口打断；应按最新输入决定处理答案或重新完整问当前题。 */
  questionPlaybackInterrupted?: boolean;
  /** design contract:整场收尾已交付，当前只回应用户后续补充，不得重复总结。 */
  terminalAlreadyDelivered?: boolean;
}

export function composePrompt(
  systemPrompt: string,
  questions: unknown[],
  cursor = 0,
  progression: PromptProgressionContext = {},
): string {
  const base = (systemPrompt ?? "").trim();
  const qs = validQuestions(questions ?? []);
  if (qs.length === 0) return base; // 纯人设对话(无题):无游标、无逐题注入

  const total = qs.length;
  // cursor 越界(全部问完):不再注入题目,AI 据人设自然转入结语/收尾(design contract 收尾语义)。
  // design contract:进度信息(第几/共几)是**给你(LLM)的内部上下文**,收尾话术不向对方暴露「N 道题」数量机械感。
  if (cursor >= total) {
    const doneNote = progression.terminalAlreadyDelivered
      ? `\n\n【进度(内部信息,不要读给对方)】整场收尾已经完整说过。只回应对方最新的补充或请求,` +
        `不要重复总结、不要再次说「全部问题都聊完了」、不要主动提出新的知识问题。`
      : `\n\n【进度(内部信息,不要读给对方)】预设的问题都聊完了。不要说「继续下一题」或「继续往下看」,` +
        `不要再提出新的知识问题。请主动做一句简短总体收尾,然后询问对方是否还有补充或是否结束,准备结束本次对话。`;
    return base ? base + doneNote : doneNote.trimStart();
  }

  const current = qs[cursor];
  const currentText = String(current.text ?? "").trim();
  const lines: string[] = [];
  // 已问题干摘要(承上启下;不含参考答案)。
  if (cursor > 0) {
    const asked = qs.slice(0, cursor).map((q, i) => `${i + 1}. ${String(q.text ?? "").trim()}`);
    lines.push(`【已聊过的问题(仅供你承上启下,不要重复提问)】\n${asked.join("\n")}`);
  }
  // 当前题只给题干。reference_answer 仍随 resolved_questions 固化供 evaluator,但不进入实时 LLM:
  // prompt 的「切勿读出」不是安全边界,模型仍可能在追问中改写泄露。题号「第 X/N 题」保留为内部进度上下文(design contract:供 LLM
  // 感知进度、避免重复已问题;服务端游标不解析此文本)——design contract 明确它 MUST NOT 读给对方。
  const currentParts = [`【当前要聊的问题(第 ${cursor + 1}/${total} 题,题号是内部编号,不要读给对方)】\n${cursor + 1}. ${currentText}`];
  lines.push(currentParts.join("\n"));
  // 出题指令:一次只问当前这一题;追问仅用于澄清 ASR/表达歧义,不得承担实时纠错或引导答对。
  const followUpNote = progression.forceQuestionClosure
    ? "当前题的追问机会已用完。本轮不得再问问题,不得提示、纠正或透露标准答案。请用一句中立的话结束当前话题,并在末尾另起一行输出 [[NEXT]]。"
    : "只有在 ASR 或表达含糊、你无法确定对方说了什么时,才做一次最小必要的中立澄清。不得判断或公布答案对错,不得纠正、补充、暗示标准答案,不得通过反问、二选一或拆小问题引导对方修改答案。对方已明确表达后,无论内容是否正确或完整,都中立收口并用下面的方式进入下一个。";
  if (progression.forceQuestionClosure) {
    const closureInstruction =
      `\n\n【本轮强制收口】${followUpNote}` +
      `不要再念题干,不要说「下一题/继续往下看」,不要评价对错。除一句中立收口和末尾 [[NEXT]] 外不要添加其他内容。`;
    return base
      ? `${base}\n\n${lines.join("\n\n")}${closureInstruction}`
      : `${lines.join("\n\n")}${closureInstruction}`.trimStart();
  }
  // design contract:去「按顺序对对方进行提问(共 N 题)/第几题/下一题」等**对对方暴露的机械外壳**;
  //   题目本体 MUST **原文逐字念出、不改写**(既是评测公平,也保证 design contract questionVoiced 判别 token 100% 命中、
  //   游标正常推进)——可加自然引出语,但题目一字不改。内部逻辑约束(一次一题/不提前问/[[NEXT]] 推进)一字不变。
  // design contract(缓解问题③提前泄题):补「不在当前题之前引入后面题会正式考查的具体概念/术语」硬指令——题目级、每题重申,
  //   不误伤人设正常背景描述(这是提示词软约束/缓解,非程序级保证;程序级只保证未问题目数组不可见)。
  const deliveryNote = progression.questionPlaybackInterrupted
    ? `当前题刚才在客户端播放完前被对方开口打断。若最新发言已经实质回答当前题,直接处理回答、不要重念;` +
      `若只是「是的」「好的」「继续」等确认词、要求重说或未构成作答,必须把当前问题原文完整重问一遍;`
    : progression.questionAlreadyVoiced
    ? `当前题已经完整问过。只回应对方的最新回答、做最小必要澄清或中立收口;` +
      `**不要重复题干,不要再次逐字念题,也不要把当前题伪装成“下一个问题”再问一遍**;`
    : `用自然的引出语把它带出来、像真人聊天,` +
      `但**问题本身要原文逐字念出、不要改写/意译/缩写/省略**(可以在问题前后加自然的过渡话,但问题原文一字不改);`;
  const verbatimPriorityNote = progression.questionPlaybackInterrupted
    ? `若需重问,题目原文逐字优先。`
    : progression.questionAlreadyVoiced
    ? `这些禁词只约束你自己的措辞;当前题已经问过,即使题干原文含这些词也不要重念。`
    : `但这只约束你自己的措辞,若问题原文本身含这些词,照原文念出即可(原文逐字优先)。`;
  const instruction =
    `\n\n**本轮只围绕上面「当前要聊的问题」这一个**,${deliveryNote}` +
    `一次只问这一个,不要提前问后面的、也不要一次抛多个,也**不要提前提及或引入当前这道题还没涉及、要留到后面才问的具体概念、` +
    `功能名或术语**(后面的题会由系统按顺序给你,轮到再说)。**你自己的引导话里**不要说「第几题」「下一题」「上一题」` +
    `「这是考试/测评」「按顺序提问」之类暴露机械流程的话——${verbatimPriorityNote}${followUpNote}\n` +
    `当你判断这个问题已经聊完、可以进入下一个时,在本轮回复的**最后另起一行只输出** [[NEXT]](该标记是系统信号,不会读给对方,` +
    `也不要在别处提及);系统会据此换到下一个。即使当前是最后一个问题,也只中立收口当前问题,不要在本轮做总体评价、` +
    `总结整场对话或询问是否结束;系统会另起一个收尾轮。只有对方尚未作答或表达无法辨认时才暂不输出 [[NEXT]];` +
    `一旦对方给出明确答案,不要为了纠正或补全而继续追问。`;
  return base ? `${base}\n\n${lines.join("\n\n")}${instruction}` : `${lines.join("\n\n")}${instruction}`.trimStart();
}

// ── design contract F1:questionVoiced —— 判「AI 输出文本是否已把当前题独立念出」──
//   review:游标推进 MUST 以「AI 已念出当前题」为条件,而「播出了音频」证明不了这点
//   (揉合/吞题时照样有音频)→ 走**文本语义校验**:抽题干判别 token(≥2 字中文片段 + 英文词,去通用疑问词),
//   AI 已提交文本命中足够比例(默认 30%)= 已念出。部署回归 验证:被吞 Q8 判 false、真念出题
//   判 true,区分度 10/10(见 prompt-compose.test.ts)。判不准偏保守放行(题干无判别 token → true,不误锁)。

/** 题干里的判别性 token:连续中文 ≥2 字的 2-gram + 英文词(小写)。去掉通用疑问/结构词(不判别哪道题)。 */
const _VOICED_STOPWORDS = new Set([
  "什么", "这个", "做的", "是做", "请用", "一句", "说明", "它的", "哪两", "可以", "基于", "支持",
  "接入", "哪些", "关系", "方式", "作用", "要素", "配置", "一下", "请你", "请举", "例子", "以及", "还是",
  // review:补高频疑问/结构词,防题干大量用它们时被当判别 token → gate 形同虚设。
  "怎么", "如何", "为何", "为什", "是否", "能否", "哪个", "哪种", "多少", "为止", "有没", "会受",
]);

function _voicedTokens(questionText: string): string[] {
  const zh = (questionText.match(/[一-龥]{2,}/g) ?? []).flatMap((s) => {
    const grams: string[] = [];
    for (let i = 0; i + 2 <= s.length; i++) grams.push(s.slice(i, i + 2));
    return grams;
  });
  const en = (questionText.match(/[A-Za-z][A-Za-z0-9]+/g) ?? []).map((s) => s.toLowerCase());
  return [...new Set([...zh.filter((t) => !_VOICED_STOPWORDS.has(t)), ...en])];
}

/** AI 已提交文本 aiText 是否把 questionText 这道题独立念出(命中判别 token ≥ threshold 比例)。
 *  题干无判别 token → 保守 true(不误锁推进);aiText 空 → false(什么都没念)。 */
export function questionVoiced(questionText: string, aiText: string, threshold = 0.3): boolean {
  const toks = _voicedTokens(questionText ?? "");
  if (toks.length === 0) return true; // 无判别 token:保守放行,不误锁
  const ai = (aiText ?? "").toLowerCase();
  if (!ai) return false;
  const hit = toks.filter((t) => ai.includes(t.toLowerCase())).length;
  return hit / toks.length >= threshold;
}
