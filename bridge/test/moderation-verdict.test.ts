/**
 * design contract:旁路违规裁判纯逻辑单测(prompt 构建 / JSON 解析 5 类+confidence+answer_complete / judgeModeration
 * fail-open / 超时 / 外部 abort)。不触网:注入 fake complete。与 eou-verdict.test.ts 同构。
 *
 * 语义关键:任何失败/超时/非法输出/klass 非法 → **null(判不了 → media-session fail-open 不罚)**;答错/不会/拿不准
 * 一律归非违规类(on_topic_attempt/explicit_decline/uncertain)。
 */
import {
  buildModerationSystemPrompt,
  parseModerationVerdict,
  judgeModeration,
  moderationTimeoutMs,
} from "../src/moderation-verdict";

describe("buildModerationSystemPrompt", () => {
  test("含硬约束:5 类可观察分类 + 答错不违规 + confidence 校准 + 只输出 JSON", () => {
    const p = buildModerationSystemPrompt({});
    for (const k of ["on_topic_attempt", "explicit_decline", "unrelated_chatter", "severe_directed_abuse", "uncertain"]) {
      expect(p).toContain(k);
    }
    expect(p).toContain("答错"); // 答错不违规原则
    expect(p).toContain("不是违规");
    expect(p).toContain("confidence");
    expect(p).toContain("answer_complete");
    expect(p.toUpperCase()).toContain("JSON");
  });

  test("带 history 与题干(仅供语境,不替答题)", () => {
    const p = buildModerationSystemPrompt({
      history: [{ role: "assistant", content: "Lambda 冷启动原因?" }, { role: "user", content: "代码太大" }],
      question: "解释 Lambda 冷启动",
    });
    expect(p).toContain("Lambda 冷启动原因?");
    expect(p).toContain("解释 Lambda 冷启动");
    const p2 = buildModerationSystemPrompt({ history: [{ role: "user", content: "  " }] });
    expect(p2).not.toContain("最近对话");
  });
});

describe("parseModerationVerdict", () => {
  test("解析 5 类 klass + confidence + answer_complete", () => {
    const v = parseModerationVerdict('{"klass":"on_topic_attempt","confidence":0.9,"answer_complete":true}');
    expect(v).toEqual({ klass: "on_topic_attempt", confidence: 0.9, answerComplete: true });
    expect(parseModerationVerdict('{"klass":"severe_directed_abuse","confidence":0.95,"answer_complete":false}')?.klass).toBe("severe_directed_abuse");
    expect(parseModerationVerdict('{"klass":"explicit_decline","confidence":0.8}')?.answerComplete).toBe(false); // 缺 answer_complete → false
  });

  test("容忍前后解释文字(抽第一个 {...})", () => {
    const v = parseModerationVerdict('好的,判定如下:{"klass":"unrelated_chatter","confidence":0.85,"answer_complete":false} 完毕');
    expect(v?.klass).toBe("unrelated_chatter");
  });

  test("confidence 越界钳到 [0,1](有限数);完全缺省 → 0", () => {
    expect(parseModerationVerdict('{"klass":"uncertain","confidence":1.7}')?.confidence).toBe(1); // 1.7 有限 → 钳 1
    expect(parseModerationVerdict('{"klass":"uncertain","confidence":-0.5}')?.confidence).toBe(0);
    expect(parseModerationVerdict('{"klass":"uncertain"}')?.confidence).toBe(0); // 完全缺 → 0(安全)
  });

  test("confidence 存在但非有限数(畸形)→ null(review:整条判不了 fail-open)", () => {
    expect(parseModerationVerdict('{"klass":"uncertain","confidence":"high"}')).toBeNull(); // 字符串
    expect(parseModerationVerdict('{"klass":"uncertain","confidence":null}')).toBeNull(); // null(存在但非数)
  });

  test("非法/缺 klass / 坏 JSON / 空 → null(判不了,fail-open)", () => {
    expect(parseModerationVerdict('{"klass":"bogus","confidence":0.9}')).toBeNull(); // 非白名单
    expect(parseModerationVerdict('{"confidence":0.9}')).toBeNull(); // 缺 klass
    expect(parseModerationVerdict("not json at all")).toBeNull();
    expect(parseModerationVerdict('{"klass":')).toBeNull(); // 坏 JSON
    expect(parseModerationVerdict("")).toBeNull();
  });
});

describe("judgeModeration fail-open", () => {
  test("正常:注入 fake complete 返回 JSON → 解析出 verdict", async () => {
    const complete = async () => '{"klass":"on_topic_attempt","confidence":0.9,"answer_complete":true}';
    const v = await judgeModeration("代码太大", "m", { token: "t" }, {}, { complete });
    expect(v?.klass).toBe("on_topic_attempt");
    expect(v?.answerComplete).toBe(true);
  });

  test("空句 → null(不判)", async () => {
    const v = await judgeModeration("   ", "m", { token: "t" }, {}, { complete: async () => "{}" });
    expect(v).toBeNull();
  });

  test("complete 抛错 → null(fail-open)+ onError(error)", async () => {
    let reason = "";
    const v = await judgeModeration("答案", "m", { token: "t" }, {}, {
      complete: async () => { throw new Error("boom"); },
      onError: (r) => { reason = r; },
    });
    expect(v).toBeNull();
    expect(reason).toContain("error");
  });

  test("超时 → null + onError(timeout)", async () => {
    let reason = "";
    const v = await judgeModeration("答案", "m", { token: "t" }, {}, {
      timeoutMs: 20,
      complete: (_p, _u, signal) => new Promise((_res, rej) => { signal.addEventListener("abort", () => rej(new Error("aborted"))); }),
      onError: (r) => { reason = r; },
    });
    expect(v).toBeNull();
    expect(reason).toBe("timeout");
  });

  test("外部 abort(会话结束)→ null + onError(session_ended)", async () => {
    let reason = "";
    const ext = new AbortController();
    ext.abort(); // 已结束
    const v = await judgeModeration("答案", "m", { token: "t" }, {}, {
      externalSignal: ext.signal,
      // 真实上游会先查 signal.aborted(已中止则立即 reject);fake 同此,避免 abort 先于监听注册时挂住。
      complete: (_p, _u, signal) => new Promise((_res, rej) => {
        if (signal.aborted) return rej(new Error("aborted"));
        signal.addEventListener("abort", () => rej(new Error("aborted")));
      }),
      onError: (r) => { reason = r; },
    });
    expect(v).toBeNull();
    expect(reason).toBe("session_ended");
  });

  test("非法输出(complete 返回坏 JSON)→ null + onError(invalid_output)", async () => {
    let reason = "";
    const v = await judgeModeration("答案", "m", { token: "t" }, {}, {
      complete: async () => "garbage",
      onError: (r) => { reason = r; },
    });
    expect(v).toBeNull();
    expect(reason).toBe("invalid_output");
  });
});

describe("moderationTimeoutMs", () => {
  test("默认 8000;env 可调夹在 [1000,20000]", () => {
    const saved = process.env.AIM_MODERATION_TIMEOUT_MS;
    try {
      delete process.env.AIM_MODERATION_TIMEOUT_MS;
      expect(moderationTimeoutMs()).toBe(8000);
      process.env.AIM_MODERATION_TIMEOUT_MS = "500"; // < 下限
      expect(moderationTimeoutMs()).toBe(1000);
      process.env.AIM_MODERATION_TIMEOUT_MS = "99999"; // > 上限
      expect(moderationTimeoutMs()).toBe(20000);
      process.env.AIM_MODERATION_TIMEOUT_MS = "6000";
      expect(moderationTimeoutMs()).toBe(6000);
    } finally {
      if (saved === undefined) delete process.env.AIM_MODERATION_TIMEOUT_MS;
      else process.env.AIM_MODERATION_TIMEOUT_MS = saved;
    }
  });
});
