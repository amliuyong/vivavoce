/**
 * session-context 单测 —— 控制面预创建下发的 prompt/引擎暂存,WS 连上时取用(修「AI 退化默认 prompt」缺陷)。
 */
import {
  putSessionContext,
  getSessionContext,
  dropSessionContext,
  sessionContextSize,
} from "../src/session-context";

test("put → get 取回 prompt + 引擎参数", () => {
  putSessionContext("sess_ctx1", "你是安全培训考官", {
    engineType: "three_stage",
    language: "zh-CN",
    llmModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  });
  const ctx = getSessionContext("sess_ctx1");
  expect(ctx?.systemPrompt).toBe("你是安全培训考官");
  expect(ctx?.engineParams.engineType).toBe("three_stage");
  expect(ctx?.engineParams.llmModelId).toContain("haiku");
  dropSessionContext("sess_ctx1");
  expect(getSessionContext("sess_ctx1")).toBeNull();
});

test("无暂存返回 null(调用方回落默认)", () => {
  expect(getSessionContext("sess_none")).toBeNull();
});

test("超 TTL 的暂存被清理(防预创建后没连入泄漏)", () => {
  const t0 = 1_000_000_000_000;
  putSessionContext("sess_old", "p", { engineType: "three_stage", language: "zh-CN" }, t0);
  // 再放一个「现在」的,触发 sweep(now 远超 TTL)
  const tNow = t0 + 31 * 60 * 1000;
  putSessionContext("sess_new", "p2", { engineType: "three_stage", language: "zh-CN" }, tNow);
  // get 用同一时基(N5:get 也校验过期,默认 Date.now();测试显式传 nowMs 保持确定性)
  expect(getSessionContext("sess_old", tNow)).toBeNull(); // 旧的被扫掉
  expect(getSessionContext("sess_new", tNow)).not.toBeNull();
  dropSessionContext("sess_new");
  expect(sessionContextSize()).toBe(0);
});

test("N5:get 也校验过期 —— 长期无新 put 触发 sweep 时,陈旧暂存不会被取回", () => {
  const t0 = 2_000_000_000_000;
  putSessionContext("sess_stale", "p", { engineType: "three_stage", language: "zh-CN" }, t0);
  // 没有新的 put 触发 sweep,但 get 在 TTL 之后 → 必须返回 null 并清掉(否则拿到陈旧 prompt)
  expect(getSessionContext("sess_stale", t0 + 31 * 60 * 1000)).toBeNull();
  expect(sessionContextSize()).toBe(0); // get 时即清除
});

test("connect_deadline:晚于硬截止的连入被拒(review:防旧 token 在会话已判死后连入)", () => {
  const t0 = 3_000_000_000_000;
  const deadline = t0 + 30 * 60 * 1000; // 创建后 30min 硬截止(即时会话)
  putSessionContext("sess_dl", "p", { engineType: "three_stage", language: "zh-CN" }, t0, deadline);
  // 截止前:可取(TTL 未过、未过 deadline)
  expect(getSessionContext("sess_dl", deadline - 1000)).not.toBeNull();
  // 截止后 1s(仍在 TTL 内,但过了硬截止)→ 拒绝并清掉(会话已可能被调度器判 failed)
  putSessionContext("sess_dl2", "p", { engineType: "three_stage", language: "zh-CN" }, t0, deadline);
  expect(getSessionContext("sess_dl2", deadline + 1000)).toBeNull();
  expect(getSessionContext("sess_dl2", deadline + 1000)).toBeNull(); // 已清
});

test("connect_deadline 未设 → 仅 TTL 兜底(deadline 缺省不误拒)", () => {
  const t0 = 3_100_000_000_000;
  putSessionContext("sess_nodl", "p", { engineType: "three_stage", language: "zh-CN" }, t0);
  // 无 deadline:TTL 内正常取回(29min < 30min TTL)
  expect(getSessionContext("sess_nodl", t0 + 29 * 60 * 1000)).not.toBeNull();
  dropSessionContext("sess_nodl");
});

test("design contract:showSubtitles 独立呈现字段 put → get 保真(false/true/缺省)", () => {
  // 显式 false(关字幕)
  putSessionContext("sess_ss_false", "p", { engineType: "three_stage", language: "zh-CN" }, Date.now(), undefined, false);
  expect(getSessionContext("sess_ss_false")?.showSubtitles).toBe(false);
  // 显式 true(开字幕)
  putSessionContext("sess_ss_true", "p", { engineType: "three_stage", language: "zh-CN" }, Date.now(), undefined, true);
  expect(getSessionContext("sess_ss_true")?.showSubtitles).toBe(true);
  // 缺省(旧 backend 未下发):字段为 undefined(调用方 `?? true` 兜底默认开),且不污染 engineParams
  putSessionContext("sess_ss_missing", "p", { engineType: "three_stage", language: "zh-CN" });
  const ctx = getSessionContext("sess_ss_missing");
  expect(ctx?.showSubtitles).toBeUndefined();
  expect("showSubtitles" in (ctx?.engineParams ?? {})).toBe(false); // 独立字段,不塞进引擎参数
  dropSessionContext("sess_ss_false");
  dropSessionContext("sess_ss_true");
  dropSessionContext("sess_ss_missing");
});

test("design contract:speakerLock 独立行为字段 put → get 保真(false/true/缺省)", () => {
  const ep = { engineType: "three_stage" as const, language: "zh-CN" };
  // 位置参数:...(nowMs, connectDeadlineMs, showSubtitles, avatarStyle, speakerLock)
  putSessionContext("sess_sl_false", "p", ep, Date.now(), undefined, undefined, undefined, false);
  expect(getSessionContext("sess_sl_false")?.speakerLock).toBe(false);
  putSessionContext("sess_sl_true", "p", ep, Date.now(), undefined, undefined, undefined, true);
  expect(getSessionContext("sess_sl_true")?.speakerLock).toBe(true);
  // 缺省(旧 backend 未下发):undefined(调用方 `?? true` 兜底默认锁),不污染 engineParams
  putSessionContext("sess_sl_missing", "p", ep);
  const ctx = getSessionContext("sess_sl_missing");
  expect(ctx?.speakerLock).toBeUndefined();
  expect("speakerLock" in (ctx?.engineParams ?? {})).toBe(false); // 独立字段,不塞进引擎参数
  dropSessionContext("sess_sl_false");
  dropSessionContext("sess_sl_true");
  dropSessionContext("sess_sl_missing");
});
