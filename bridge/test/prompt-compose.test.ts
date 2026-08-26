/**
 * composePrompt 单测(review)—— Profile 题库合进有效 system prompt。
 */
import { composePrompt, languageDirective, toneDirective, nowContextLine, asrAwarenessDirective, questionVoiced, examCompletionDirective, interactionStyleDirective, openChatDirective, composeSessionPrompt } from "../src/prompt-compose";

// ── design contract F1:questionVoiced 判「AI 输出文本是否已把当前题独立念出」──
//   用部署回归 地面真值验证区分度:被吞的 Q8(Space)判 false,真念出的题判 true。
describe("questionVoiced(design contract F1 信号①)", () => {
  test("真念出:AI 复述题干 → true(命中题干判别 token)", () => {
    expect(questionVoiced("Amazon Quick Sight 这个功能是做什么的？",
      "好的,来看第三题。Amazon Quick Sight 这个功能是做什么的?")).toBe(true);
  });

  test("★被吞(本例 Q8 Space):AI 从没念该题、只在确认上一题后跳过 → false", () => {
    // 第 7 题确认 + 直接跳"第九题"的实际 AI 文本里,不含 Space/空间/汇聚/资源 等 Q8 判别 token。
    expect(questionVoiced("什么是 Space（空间）？它的作用是什么？",
      "听起来可能有点识别问题,你说的第三类是tool,也就是工具或动作连接器吗?好的,我们来看第九题。")).toBe(false);
  });

  test("揉合一句带过但含题干关键词 → true(诚实:此情形本判据放行,靠独立念出根治)", () => {
    expect(questionVoiced("接入 Amazon Quick 有哪两种方式？",
      "好,接入 Amazon Quick 有哪两种方式呢?")).toBe(true);
  });

  test("英文专有名词命中(大小写不敏感)", () => {
    expect(questionVoiced("动作连接器（Action connectors）可以基于哪两种开放标准来创建？",
      "现在是最后一题。动作连接器 action connectors 可以基于哪两种开放标准来创建?")).toBe(true);
  });

  test("题干无判别 token(极端:无 ≥2 字中文片段、无英文词)→ 保守放行 true(不误锁)", () => {
    // 全单字 + 标点,抽不出 2-gram/英文词 → toks 空 → 保守 true(宁放行不误锁推进)。
    expect(questionVoiced("好？", "随便说点别的")).toBe(true);
  });

  test("空 AI 文本 → false(什么都没念)", () => {
    expect(questionVoiced("Amazon Quick Sight 这个功能是做什么的？", "")).toBe(false);
  });
});

test("languageDirective:zh-CN → 强制简体中文(真机 AI 说英/日的修复)", () => {
  const d = languageDirective("zh-CN");
  expect(d).toContain("简体中文");
  expect(d).toContain("不要使用英文或日文");
});

test("languageDirective:缺省/未知也按中文兜底;en/ja 各自语言", () => {
  expect(languageDirective(undefined)).toContain("简体中文"); // 默认中文
  expect(languageDirective("en-US")).toContain("English");
  expect(languageDirective("ja-JP")).toContain("日本語");
});

test("languageDirective:auto → 跟随题目语言(软指令,不硬钉死中文)", () => {
  const d = languageDirective("auto");
  expect(d).toContain("题目本身所使用的语言");
  expect(d).toContain("不要擅自翻译题目");
  expect(d).toContain("跟随对方说话的语言"); // 无题目降级
  // 反向:auto 不得退化成中文硬钉死(否则英文口语练习白配)
  expect(d).not.toContain("必须始终用简体中文");
});

test("toneDirective:默认开 → 平稳语气硬约束(不用感叹号/emoji/少语气词)", () => {
  const saved = process.env.AIM_CALM_TONE;
  delete process.env.AIM_CALM_TONE;
  try {
    const d = toneDirective();
    expect(d).toContain("语气");
    expect(d).toContain("不要使用感叹号");
    expect(d).toContain("emoji");
  } finally {
    if (saved === undefined) delete process.env.AIM_CALM_TONE;
    else process.env.AIM_CALM_TONE = saved;
  }
});

test("toneDirective:AIM_CALM_TONE=0 → 关(回退原生风格,空串)", () => {
  const saved = process.env.AIM_CALM_TONE;
  process.env.AIM_CALM_TONE = "0";
  try {
    expect(toneDirective()).toBe("");
  } finally {
    if (saved === undefined) delete process.env.AIM_CALM_TONE;
    else process.env.AIM_CALM_TONE = saved;
  }
});

test("无题库:原样返回人设", () => {
  expect(composePrompt("你是面试官", [])).toBe("你是面试官");
});

test("asrAwarenessDirective:告知 LLM 输入来自 ASR、据上下文推断意图", () => {
  const d = asrAwarenessDirective();
  expect(d).toContain("语音识别");
  expect(d).toContain("推断"); // 据上下文推断真实意思
  expect(d).toContain("重说"); // 整句听不懂才请对方重说
});

test("nowContextLine 注入北京时间 + 中文星期(UTC→UTC+8)", () => {
  // 2026-06-20T05:00Z = 北京时间 deployment validation 13:00,周六
  const line = nowContextLine(new Date("2026-06-20T05:00:00Z"));
  expect(line).toContain("北京时间 2026年06月20日");
  expect(line).toContain("星期六");
  expect(line).toContain("13:00");
  expect(line).toContain("不要编造");
});

test("nowContextLine 跨日:UTC 23:00 → 北京时间次日 07:00", () => {
  const line = nowContextLine(new Date("2026-06-20T23:00:00Z"));
  expect(line).toContain("2026年06月21日"); // +8h 跨到 21 日
  expect(line).toContain("07:00");
});

// ── 出题游标逐题注入(design contract「出题游标由服务端强推进」)──
// design contract:题目级 follow_up 已废弃——fixture 不再带 follow_up。
const QS = [
  { text: "什么是最小权限原则?" },
  { text: "如何防钓鱼?" },
  { text: "什么是零信任?", reference_answer: "永不信任、始终验证" },
];

test("cursor=0:只注入当前题(第1题),未问的第2/3题不可见(顺序由代码保证)", () => {
  const out = composePrompt("你是安全培训考官", QS, 0);
  expect(out).toContain("你是安全培训考官");
  // design contract:进度以「第 X/N 题」内部编号承载(/3 即总数),不再单列「共 N 题」机械话术
  expect(out).toContain("第 1/3 题");
  expect(out).toContain("1. 什么是最小权限原则?");
  // ★ 未问的题 MUST NOT 泄漏给 LLM(源头杜绝跳题/并问)
  expect(out).not.toContain("如何防钓鱼");
  expect(out).not.toContain("什么是零信任");
});

test("cursor=1:注入当前题(第2题)+ 已问题干摘要(第1题),但不含参考答案/未来题", () => {
  const out = composePrompt("你是考官", QS, 1);
  expect(out).toContain("第 2/3 题");
  expect(out).toContain("2. 如何防钓鱼?");
  // 已问摘要(承上启下;design contract 措辞「已聊过的问题」)
  expect(out).toContain("已聊过的问题");
  expect(out).toContain("1. 什么是最小权限原则?");
  // 未来题仍不可见
  expect(out).not.toContain("什么是零信任");
});

test("design contract:所有题统一只允许可辨认性澄清(不再有 follow_up 二分)+ [[NEXT]] 推进说明", () => {
  // 任意题都注入统一澄清边界,不再有 follow_up=true/false 两套。
  for (const cursor of [0, 1, 2]) {
    const out = composePrompt("你是面试官", QS, cursor);
    expect(out).toContain("ASR");
    expect(out).toContain("不得判断");
    expect(out).toContain("[[NEXT]]");
    expect(out).not.toContain("不必额外追问");
  }
});

test("design contract:含「不提前引入后面题目概念」硬指令(缓解问题③提前泄题)", () => {
  const out = composePrompt("你是考官", QS, 0);
  // 题目级指令须约束「不在当前题之前引入后面题会考的具体概念/术语」(不误伤人设背景描述)
  expect(out).toContain("不要提前");
});

test("当前题含 reference_answer:实时对话 prompt 只给题干,不暴露参考答案正文", () => {
  const out = composePrompt("你是考官", QS, 2); // 第3题带 reference_answer
  expect(out).toContain("3. 什么是零信任?");
  expect(out).not.toContain("参考答案");
  expect(out).not.toContain("永不信任");
});

test("reference_answer 隔离覆盖已问、当前和未来题", () => {
  const questions = [
    { text: "已问题干", reference_answer: "PRIVATE_ASKED_ANSWER" },
    { text: "当前题干", reference_answer: "PRIVATE_CURRENT_ANSWER" },
    { text: "未来题干", reference_answer: "PRIVATE_FUTURE_ANSWER" },
  ];
  const out = composePrompt("你是考官", questions, 1);
  expect(out).toContain("已问题干");
  expect(out).toContain("当前题干");
  expect(out).not.toContain("未来题干");
  for (const question of questions) expect(out).not.toContain(question.reference_answer);
});

test("当前题已经完整念出:后续回答轮禁止再次要求逐字重念题干", () => {
  const progression = {
    questionAlreadyVoiced: true,
  } as unknown as Parameters<typeof composePrompt>[3];
  const out = composePrompt("你是考官", QS, 0, progression);
  expect(out).toContain("1. 什么是最小权限原则?"); // 题干仍作为判断上下文
  expect(out).toContain("已经完整问过");
  expect(out).toContain("不要重复题干");
  expect(out).not.toContain("问题本身要原文逐字念出");
  expect(out).not.toContain("照原文念出即可");
});

test("当前题客户端播放中被打断:实质回答不重念,短确认必须完整重问当前题", () => {
  const out = composePrompt("你是考官", QS, 0, {
    questionPlaybackInterrupted: true,
  });
  expect(out).toContain("客户端播放完前被对方开口打断");
  expect(out).toContain("若最新发言已经实质回答当前题");
  expect(out).toContain("必须把当前问题原文完整重问一遍");
  expect(out).not.toContain("当前题已经完整问过");
});

test("cursor 越界(全部问完):不再注入新题,转入收尾", () => {
  const out = composePrompt("你是考官", QS, 3); // 3 题已问完
  expect(out).toContain("你是考官");
  expect(out).toContain("都聊完了"); // design contract:收尾语义(去「N 道题目已全部问完」机械话术)
  expect(out).toContain("准备结束");
  // 不再出现任何题干
  expect(out).not.toContain("什么是最小权限原则");
});

test("空人设 + 题库:只返回当前题块(trim)", () => {
  const out = composePrompt("", [{ text: "Q1" }], 0);
  expect(out.startsWith("【当前要聊的问题")).toBe(true); // design contract 措辞
  expect(out).toContain("1. Q1");
});

test("脏数据(非对象/空 text)被过滤后再定位游标", () => {
  // 过滤后有效题 = [有效题A, 有效题B];cursor=1 应指向 B
  const out = composePrompt("人设", ["bad", { text: "" }, { text: "有效题A" }, { text: "有效题B" }] as unknown[], 1);
  expect(out).toContain("第 2/2 题"); // /2 承载总数(design contract:去单列「共 N 题」)
  expect(out).toContain("2. 有效题B");
});

test("cursor 缺省=0(向后兼容:不传游标即从第1题起)", () => {
  const out = composePrompt("人设", QS);
  expect(out).toContain("第 1/3 题");
  expect(out).toContain("1. 什么是最小权限原则?");
});

// ── design contract:去「考试/第几题/下一题」机器感,题目原文逐字读出 ──
describe("design contract:自然引出题目,题目原文逐字读出", () => {
  test("当前题上下文注入「题号内部信号、不可读给对方 + 题目原文逐字念出、不可改写」硬指令", () => {
    const out = composePrompt("你是安全培训考官", QS, 0);
    // 题号/进度仍作内部上下文保留(供 LLM 感知进度、游标不受影响):以「第 X/N 题」承载(/3 即总数)
    expect(out).toContain("第 1/3 题");
    expect(out).toContain("1. 什么是最小权限原则?");
    // 变异敏感精确断言(review:避免宽松正则删了关键指令仍绿)
    expect(out).toContain("题号是内部编号,不要读给对方"); // 题号不可读出(精确短语)
    expect(out).toContain("原文逐字念出"); // 题目逐字(精确短语,防 design contract questionVoiced 门控失效)
    expect(out).toContain("不要改写/意译/缩写/省略"); // 禁改写(精确短语)
    // 面向对方的机械外壳被禁(精确短语)
    expect(out).toContain("不要说「第几题」「下一题」「上一题」「这是考试/测评」");
  });

  test("禁词仅约束 AI 自己的措辞:题目原文含「考试/下一题」等词时照原文念(原文逐字优先)", () => {
    // 题目原文本身含「考试」——不能因禁词而改写题目(review:禁词 vs 逐字读题冲突)
    const out = composePrompt("你是考官", [{ text: "你如何看待应试考试制度?" }], 0);
    expect(out).toContain("1. 你如何看待应试考试制度?"); // 题目原文保留(含「考试」)
    // 指令明确「原文逐字优先」,禁词只约束 AI 自己的引导话
    expect(out).toContain("原文逐字优先");
    expect(out).toMatch(/只约束你自己的措辞|照原文念/);
  });

  test("出题指令去机械措辞:不再对对方暴露「按顺序提问」外壳,但内部一次一题约束不变", () => {
    const out = composePrompt("你是考官", QS, 0);
    // 内部逻辑约束保留(一次只问当前题 / [[NEXT]] 推进)
    expect(out).toContain("[[NEXT]]");
    // 变异敏感正向断言(review:锁新自然措辞存在,比只断言旧串缺失更能抓回归)
    expect(out).toContain("用自然的引出语把它带出来");
    // 且不再有面向对方的机械「按顺序对对方进行提问」旧文案(注:prompt 会把「第几题/下一题」作为**禁词**
    // 列出,故不能对整串断言这些词缺失——只锁旧的机械引导句被删)
    expect(out).not.toContain("你正在按顺序对对方进行提问");
  });

  test("questionVoiced 保护回归:题目原文照读(加自然引出语)仍判已念出 true", () => {
    // 题干取自 QS[0](与 composePrompt 注入给 LLM 的当前题同源),模拟 AI 遵循「原文逐字念出」指令 +
    // 自然引出语 → questionVoiced 必然命中(判别 token 全含)。这是 design contract 门控的行为锚。
    const questionText = QS[0].text; // "什么是最小权限原则?"(composePrompt cursor=0 注入的当前题)
    const spokenVerbatim = `好,我们接着聊这个:${questionText}`;
    expect(questionVoiced(questionText, spokenVerbatim)).toBe(true);
    // 反例(区分度):意译丢词 → false(证明测试能抓住「改写题目致门控失效」的回归,非恒真)
    const paraphrased = "我们随便聊聊访问控制的一些理念吧";
    expect(questionVoiced(questionText, paraphrased)).toBe(false);
  });

  test("收尾分支(全部问完)自然化:不向对方暴露「N 道题」数量机械感", () => {
    const out = composePrompt("你是考官", QS, 3);
    expect(out).toContain("准备结束"); // 收尾语义保留
    // 不再出现面向对方的「预设的 N 道题目已全部问完」题数暴露话术
    expect(out).not.toMatch(/预设的 \d+ 道题目已全部问完/);
  });
});

// ── design contract:examCompletionDirective 去考试/题数/下一题外壳,行为不变 ──
describe("design contract:坚持话术去考试字眼(行为约束不变)", () => {
  test("有题时注入:含「未作答完不提前结束 + 继续引导」语义,但不含考试/下一题/还剩 N 题字眼", () => {
    const d = examCompletionDirective(5);
    expect(d.length).toBeGreaterThan(0);
    // 行为约束语义保留
    expect(d).toMatch(/不.*结束|不.*提前结束/);
    expect(d).toMatch(/继续|坚持|引导/);
    // 去机械/考试外壳
    expect(d).not.toContain("考试");
    expect(d).not.toContain("下一题");
    expect(d).not.toMatch(/还剩\s*\d*\s*题|还剩 N 题|还有几道题/);
  });

  test("标题去「考试」但仍具约束力(不弱到像建议)", () => {
    const d = examCompletionDirective(3);
    expect(d).not.toContain("【考试规则】");
    expect(d).toContain("规则"); // 保留「规则」的强制语义
  });

  test("无题(questions=0):不注入(纯人设不受约束)", () => {
    expect(examCompletionDirective(0)).toBe("");
  });
});

// ── design contract:不复述不夸奖 + 最小必要澄清 + 中立追问(交互风格通用指令)──
describe("design contract:interactionStyleDirective", () => {
  test("含「不复述整段 / 不评价夸奖 / 最小必要澄清不总结不评价 / 中立追问」关键语义", () => {
    const d = interactionStyleDirective(5); // 有题
    expect(d.length).toBeGreaterThan(0);
    expect(d).toMatch(/不.*复述|不要复述|不.*重复/);
    expect(d).toMatch(/不.*夸奖|不.*评价|不.*表扬|不.*附和/);
    expect(d).toMatch(/追问|确认/); // 仅允许澄清 ASR/表达歧义
    expect(d).toMatch(/不.*判断.*正确|不.*纠正|不.*引导.*答案/);
    expect(d).not.toContain("答得不充分");
  });

  test("与 toneDirective 协同:不含相互矛盾的「要热情/多用语气词」表述", () => {
    const d = interactionStyleDirective(5);
    // 不应鼓励夸奖/热情(与 toneDirective 平稳克制协同)
    expect(d).not.toContain("热情");
    expect(d).not.toContain("多夸");
  });

  test("无题(questionCount=0):不注入(纯人设不受约束,与 examCompletionDirective 对称;review)", () => {
    expect(interactionStyleDirective(0)).toBe("");
  });

  test("env AIM_INTERACTION_STYLE=0 → 关(回退空串,A/B)", () => {
    const saved = process.env.AIM_INTERACTION_STYLE;
    try {
      process.env.AIM_INTERACTION_STYLE = "0";
      expect(interactionStyleDirective(5)).toBe(""); // 有题但 flag 关 → 仍空
    } finally {
      if (saved === undefined) delete process.env.AIM_INTERACTION_STYLE;
      else process.env.AIM_INTERACTION_STYLE = saved;
    }
  });
});

// ── design contract:openChatDirective —— 自由聊天(无题)持续对话、不主动收尾(与 examCompletionDirective 对称互斥)──
describe("design contract:openChatDirective(仅无题注入)", () => {
  test("无题(questionCount=0):注入「持续对话 / 不主动结束 / 只对方明确要走才收尾」语义", () => {
    const d = openChatDirective(0);
    expect(d.length).toBeGreaterThan(0);
    // 持续对话
    expect(d).toMatch(/持续|接着聊|继续|保持.*对话/);
    // 不主动结束(核心)
    expect(d).toMatch(/不.*主动.*结束|不.*主动.*(挂|收尾|告别)|不要.*(结束|挂断)/);
    // 只有对方明确要走才收尾
    expect(d).toMatch(/明确|对方.*(要走|结束|不想聊|告别)/);
    // 交互风格核心并入(review:无题时 interactionStyleDirective 不注入,openChat 补语气克制/不夸奖)
    expect(d).toMatch(/克制|自然|不.*夸/);
  });

  test("有题(questionCount>0):不注入(与 examCompletionDirective 对称——有题走完成强制,无题走自由交流)", () => {
    expect(openChatDirective(5)).toBe("");
    expect(openChatDirective(1)).toBe("");
  });

  test("env AIM_OPEN_CHAT_DIRECTIVE=0 → 关(回退空串,A/B;命名对齐 AIM_CALM_TONE/AIM_INTERACTION_STYLE)", () => {
    const saved = process.env.AIM_OPEN_CHAT_DIRECTIVE;
    try {
      process.env.AIM_OPEN_CHAT_DIRECTIVE = "0";
      expect(openChatDirective(0)).toBe(""); // 无题但 flag 关 → 仍空
    } finally {
      if (saved === undefined) delete process.env.AIM_OPEN_CHAT_DIRECTIVE;
      else process.env.AIM_OPEN_CHAT_DIRECTIVE = saved;
    }
  });

  test("互斥不变式(feature 开启时):同一 questionCount 下 openChat 与 examCompletion 恰好一个非空", () => {
    // 无题:openChat 非空、examCompletion 空
    expect(openChatDirective(0).length).toBeGreaterThan(0);
    expect(examCompletionDirective(0)).toBe("");
    // 有题:examCompletion 非空、openChat 空
    expect(examCompletionDirective(3).length).toBeGreaterThan(0);
    expect(openChatDirective(3)).toBe("");
  });
});

// ── design contract:composeSessionPrompt 接线条件(review:此前接线在 index.ts handler 里零测试覆盖)──
describe("design contract:composeSessionPrompt 接线(有题/无题 × flag 开/关)", () => {
  const NOW = new Date("2026-07-15T05:00:00Z");
  test("有题(questionCount>0):注入完成强制 + 交互风格 + 各置顶指令 + 人设", () => {
    const out = composeSessionPrompt({ language: "zh-CN", systemPrompt: "你是考官", questionCount: 5, now: NOW });
    expect(out).toContain("你是考官");
    expect(out).toContain("【本场规则】"); // examCompletionDirective 注入(有题)
    expect(out).toContain("【应答方式】"); // interactionStyleDirective 注入(有题)
    expect(out).toContain("【语言】"); // languageDirective(zh)
    expect(out).toContain("北京时间"); // nowContextLine
    expect(out).not.toContain("【自由交流】"); // design contract:有题不注入自由聊天指令(与完成强制互斥)
  });

  test("无题(questionCount=0):完成强制 + 交互风格不注入,但注入自由交流(design contract)", () => {
    const out = composeSessionPrompt({ language: "zh-CN", systemPrompt: "你是聊天助手", questionCount: 0, now: NOW });
    expect(out).toContain("你是聊天助手");
    expect(out).not.toContain("【本场规则】"); // 无题不注入完成强制
    expect(out).not.toContain("【应答方式】"); // 无题不注入交互风格(interactionStyleDirective)
    expect(out).toContain("【自由交流】"); // design contract:无题注入 openChatDirective(持续对话/不主动收尾)
    expect(out).toContain("【语言】"); // 语言/语气/时间等基础指令仍注入
  });

  test("有题但 AIM_INTERACTION_STYLE=0:交互风格不注入,但完成强制仍在(两开关独立)", () => {
    const saved = process.env.AIM_INTERACTION_STYLE;
    try {
      process.env.AIM_INTERACTION_STYLE = "0";
      const out = composeSessionPrompt({ language: "zh-CN", systemPrompt: "你是考官", questionCount: 5, now: NOW });
      expect(out).not.toContain("【应答方式】"); // flag 关 → 交互风格不注入
      expect(out).toContain("【本场规则】"); // 完成强制独立于交互风格 flag,仍注入
    } finally {
      if (saved === undefined) delete process.env.AIM_INTERACTION_STYLE;
      else process.env.AIM_INTERACTION_STYLE = saved;
    }
  });
});
