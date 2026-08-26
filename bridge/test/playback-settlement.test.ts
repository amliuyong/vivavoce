/**
 * design contract/R5/R7:服务端 PlaybackSettlementCoordinator 单测(乱序/重复/timeout/input-grace/指标)。
 * ★ design contract:`AIM_PLAYBACK_ACK_MODE` 三态(off/observe/enforce)已删 —— 相关 parseAckMode /
 *   isEnforce / observe-vs-enforce 测试随之移除,并加「开关真的没了」的变异测试(见文件末)。
 * 用注入的 now() 做确定性时间(不依赖 fake-timer,本模块无内部定时器)。
 */
import {
  PlaybackSettlementCoordinator,
  loadAckTimeoutConfig,
  type AckMetric,
  type Settlement,
  type AckTimeoutConfig,
} from "../src/playback-settlement";
// design contract:断言默认值时引用权威事实源,不写字面量(防将来改 turn-handling 默认时本测试假绿)
import { PLAYBACK_LEAD_BOUNDS, TURN_HANDLING_DEFAULTS } from "../src/turn-handling";

const CFG: AckTimeoutConfig = { graceMs: 3000, maxWaitMs: 45000, inputGraceMs: 1000, maxPlaybackLeadMs: 20000 };

function mk(startNow = 1000) {
  let t = startNow;
  const metrics: AckMetric[] = [];
  const settlements: Settlement[] = [];
  const co = new PlaybackSettlementCoordinator({
    cfg: CFG,
    onSettle: (s) => settlements.push(s),
    onMetric: (m) => metrics.push(m),
    now: () => t,
  });
  return { co, metrics, settlements, setNow: (v: number) => (t = v), getNow: () => t };
}

describe("design contract loadAckTimeoutConfig", () => {
  it("loadAckTimeoutConfig:默认值 + 跨参数不变量 fail-fast", () => {
    // ★ design contract 修真实缺陷:maxPlaybackLeadMs 默认**不再另抄 20000**,而是复用推进时钟的权威
    //   默认 TURN_HANDLING_DEFAULTS.playbackClock.maxLeadMs(35000)。断言用该导出而非字面量,
    //   否则将来改 turn-handling 默认时本测试会假绿(这正是 design contract 要消灭的「第二份可写副本」)。
    expect(loadAckTimeoutConfig({})).toEqual({
      graceMs: 3000,
      maxWaitMs: 45000,
      inputGraceMs: 1000,
      maxPlaybackLeadMs: TURN_HANDLING_DEFAULTS.playbackClock.maxLeadMs,
    });
    // 违反 maxWait >= maxLead + grace
    expect(() => loadAckTimeoutConfig({ AIM_PLAYBACK_ACK_MAX_WAIT_MS: "5000", AIM_MAX_PLAYBACK_LEAD_MS: "20000" })).toThrow(/跨参数不变量/);
    // 越界 fail-fast
    expect(() => loadAckTimeoutConfig({ AIM_PLAYBACK_ACK_GRACE_MS: "99999" })).toThrow(/非法/);
  });

  /**
   * ★ design contract 回归:双默认值缺陷的**漏判窗口**。
   *
   * 修复前 `playback-settlement` 另抄 lead=20000,而推进时钟真实用 35000 → 守门拿错的 lead 去判,
   * 使 `maxWait ∈ [23000, 38000)` 的配置**能通过**守门,却仍会把 35s 合法长音频截短成提前推进
   * (= 该守门本要防的故障)。修复后这些配置 MUST 被拦下。
   */
  it("漏判窗口回归:maxWait 落在 [lead+grace) 之下 MUST 拦截(修复前会放行)", () => {
    const lead = TURN_HANDLING_DEFAULTS.playbackClock.maxLeadMs; // 35000
    const grace = 3000;
    // 30000 < 35000+3000 → 必须抛(修复前:30000 >= 20000+3000 故放行,漏判)
    expect(() => loadAckTimeoutConfig({ AIM_PLAYBACK_ACK_MAX_WAIT_MS: "30000" })).toThrow(/跨参数不变量/);
    expect(() => loadAckTimeoutConfig({ AIM_PLAYBACK_ACK_MAX_WAIT_MS: "23000" })).toThrow(/跨参数不变量/);
    // 恰好等于边界 → 放行(不过度拦截)
    expect(loadAckTimeoutConfig({ AIM_PLAYBACK_ACK_MAX_WAIT_MS: String(lead + grace) }).maxWaitMs)
      .toBe(lead + grace);
  });
});

describe("design contract 结算:complete/aborted 单调终态", () => {
  it("正常:begin→end→complete,结算一次 complete,带 latency + estimate-error", () => {
    const { co, metrics, settlements, setNow } = mk();
    co.beginTurn(17);
    setNow(2000);
    co.endTurn(17, 2500); // 估算 2500 播完
    setNow(2600);
    co.onAck(17, "complete");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ aiTurnId: 17, outcome: "complete", latencyMs: 600 });
    expect(settlements[0].estimateErrorMs).toBe(100); // 2600 − 2500
    expect(metrics[0].outcome).toBe("complete");
  });

  it("aborted:结算一次 aborted,reason 仅诊断", () => {
    const { co, settlements } = mk();
    co.beginTurn(5);
    co.endTurn(5, 1500);
    co.onAck(5, "aborted", "superseded");
    expect(settlements).toEqual([expect.objectContaining({ aiTurnId: 5, outcome: "aborted", abortReason: "superseded" })]);
  });

  it("重复 ACK:第二次只记 duplicate,不二次结算", () => {
    const { co, metrics, settlements } = mk();
    co.beginTurn(1);
    co.endTurn(1, 1000);
    co.onAck(1, "complete");
    co.onAck(1, "complete");
    expect(settlements).toHaveLength(1); // 只结算一次
    expect(metrics.some((m) => m.duplicate)).toBe(true);
  });

  it("未知/未协商轮 ACK:忽略,记 unknown,不结算", () => {
    const { co, metrics, settlements } = mk();
    co.onAck(999, "complete");
    expect(settlements).toHaveLength(0);
    expect(metrics[0]).toMatchObject({ aiTurnId: 999, unknown: true });
  });

  it("非法 id(负数/非整数)fail-soft", () => {
    const { co, settlements } = mk();
    co.onAck(-1, "complete");
    co.onAck(1.5, "aborted");
    expect(settlements).toHaveLength(0);
  });
});

describe("design contract timeout / input-grace", () => {
  it("deadline 到期无 ACK → timed_out(estimated_complete)", () => {
    const { co, settlements, setNow } = mk();
    co.beginTurn(7);
    setNow(2000);
    co.endTurn(7, 2200); // deadline = min(2200+3000, 2000+45000) = 5200
    setNow(5199);
    co.checkTimeouts();
    expect(settlements).toHaveLength(0); // 未到
    setNow(5200);
    co.checkTimeouts();
    expect(settlements).toEqual([expect.objectContaining({ outcome: "timed_out", fallback: "estimated_complete" })]);
  });

  it("late ACK(已 timed_out 后到)只记 stale,不二次结算", () => {
    const { co, metrics, settlements, setNow } = mk();
    co.beginTurn(7);
    co.endTurn(7, 1500);
    setNow(100000);
    co.checkTimeouts(); // timed_out
    co.onAck(7, "complete"); // late
    expect(settlements).toHaveLength(1);
    expect(settlements[0].outcome).toBe("timed_out");
    expect(metrics.some((m) => m.stale)).toBe(true);
  });

  it("input-grace:awaiting 期用户输入 → grace 到期 timed_out(user_takeover_abort)", () => {
    const { co, settlements, setNow } = mk();
    co.beginTurn(3);
    setNow(2000);
    co.endTurn(3, 2200);
    setNow(2100);
    co.noteUserInputDuringAwait(3); // grace 起点 2100
    setNow(3099);
    co.checkInputGrace();
    expect(settlements).toHaveLength(0); // 未到 1000ms grace
    setNow(3100);
    co.checkInputGrace();
    expect(settlements).toEqual([expect.objectContaining({ outcome: "timed_out", fallback: "user_takeover_abort" })]);
  });

  it("上行 barge_in 立即 aborted,随后 playback_aborted 幂等", () => {
    const { co, metrics, settlements } = mk();
    co.beginTurn(9);
    co.endTurn(9, 1500);
    co.onUplinkBargeIn(9);
    expect(settlements).toEqual([expect.objectContaining({ outcome: "aborted", abortReason: "barge_in" })]);
    co.onAck(9, "aborted", "barge_in"); // 幂等确认
    expect(settlements).toHaveLength(1);
    expect(metrics.some((m) => m.duplicate)).toBe(true);
  });
});

describe("design contract 多轮独立(多轮待结算)", () => {
  it("turn17 未 ACK 又来 turn18,各自独立结算不串轮", () => {
    const { co, settlements } = mk();
    co.beginTurn(17);
    co.endTurn(17, 1500);
    co.beginTurn(18);
    co.endTurn(18, 1600);
    expect(co.pendingCount()).toBe(2);
    co.onAck(18, "complete");
    co.onAck(17, "aborted", "superseded");
    expect(settlements.map((s) => [s.aiTurnId, s.outcome])).toEqual([
      [18, "complete"],
      [17, "aborted"],
    ]);
  });
});

describe("design contract:playback lead 钳制上界两处收敛(review 回归)", () => {
  /**
   * 曾经:turn-handling 上界 120000、ACK 校验上界 600000 —— env 落在两者之间时,
   * 推进时钟**静默回退默认**(只 warn),而 ACK 校验**接受**该值再因跨参数不变量**抛错崩启动**。
   * 同一个 env、两套判断、失败方式还不同。现两处复用 `PLAYBACK_LEAD_BOUNDS`。
   */
  it("ACK 校验的 lead 上界 === turn-handling 的权威上界", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ACK_TIMEOUT_BOUNDS } = require("../src/playback-settlement");
    expect(ACK_TIMEOUT_BOUNDS.maxPlaybackLeadMs).toEqual(PLAYBACK_LEAD_BOUNDS);
  });

  it("越过共同上界的 env,两处都判非法(不再一处静默一处抛)", () => {
    const over = String(PLAYBACK_LEAD_BOUNDS.max + 1);
    // ACK 侧:抛(fail-fast)
    expect(() => loadAckTimeoutConfig({ AIM_MAX_PLAYBACK_LEAD_MS: over })).toThrow(/非法值/);
    // turn-handling 侧:回退默认(既有 numBounded 语义,不改)
    const prev = process.env.AIM_MAX_PLAYBACK_LEAD_MS;
    process.env.AIM_MAX_PLAYBACK_LEAD_MS = over;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { loadTurnHandling } = require("../src/turn-handling");
      expect(loadTurnHandling().playbackClock.maxLeadMs)
        .toBe(TURN_HANDLING_DEFAULTS.playbackClock.maxLeadMs);
    } finally {
      if (prev === undefined) delete process.env.AIM_MAX_PLAYBACK_LEAD_MS;
      else process.env.AIM_MAX_PLAYBACK_LEAD_MS = prev;
    }
  });
});

// ── design contract A 类:「开关真的没了」变异测试 ──────────────────────────────────
//
// 这些测试的价值不在于「功能正常」,而在于**证明旧 env 名已无任何影响力**。
// 先前的部署回归的形状是:env 丢失 → 功能静默失效、测试全绿。若只把默认值改成开而保留 env
// 读取,同样的事故会以「env 被误设为关」的形式重演。故此处用变异法钉死:把旧 env 设成
// 「最恶意的关值」,断言行为不变。
describe("design contract:AIM_PLAYBACK_ACK_MODE 已删(变异测试)", () => {
  const OLD_ENV = "AIM_PLAYBACK_ACK_MODE";

  it("旧 env 设为 off/observe/任意非法值,均不影响协调器构造与结算(不再解析该 env)", () => {
    const prev = process.env[OLD_ENV];
    for (const mutant of ["off", "observe", "bogus", ""]) {
      process.env[OLD_ENV] = mutant;
      try {
        // 构造 + 完整结算一轮:旧 env 的任何取值都不该改变结果,也不该抛(旧实现对 "bogus" 会 fail-fast)。
        const { co, settlements } = mk();
        co.beginTurn(1);
        co.endTurn(1, 1500);
        co.onAck(1, "complete");
        expect(settlements).toHaveLength(1);
        expect(settlements[0].outcome).toBe("complete");
      } finally {
        if (prev === undefined) delete process.env[OLD_ENV];
        else process.env[OLD_ENV] = prev;
      }
    }
  });

  it("模块不再导出 parseAckMode / AckMode(防将来悄悄加回)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../src/playback-settlement");
    expect(mod.parseAckMode).toBeUndefined();
    expect(mod.ACK_MODE_DEFAULT).toBeUndefined();
  });

  it("协调器不再暴露 isEnforce(结算恒生效,无模式概念)", () => {
    const { co } = mk();
    expect((co as unknown as Record<string, unknown>).isEnforce).toBeUndefined();
  });
});


// ── design contract A 类:两个开关的**整条配置链**都不存在(review)────────────
//
// 「恒 true 的解析器」只是半删 —— 它仍会出现在 registry / 只读页,并让人以为还能关。
// 这里直接断言模块不导出它:任何人想「加回开关」都会先撞到这条测试。
describe("design contract:A 类配置链已整条删除", () => {
  it("media-config 不再导出 farewellTtsDrainEnabled(连恒 true 的版本都不留)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mc = require("../src/media-config");
    expect(mc.farewellTtsDrainEnabled).toBeUndefined();
    expect(mc.MEDIA_DEFAULTS).not.toHaveProperty("farewellTtsDrainEnabled");
  });

  it("registry 快照不含 A 类字段(RC.media 无 farewellTtsDrainEnabled)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RC } = require("../src/runtime-config");
    expect(RC.media).not.toHaveProperty("farewellTtsDrainEnabled");
  });

  it("registry 序列化不含两个 A 类 key(只读页不出幽灵项)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadRuntimeConfig } = require("../src/runtime-config");
    const keys = loadRuntimeConfig().map((e: { key: string }) => e.key);
    expect(keys).not.toContain("AIM_PLAYBACK_ACK_MODE");
    expect(keys).not.toContain("AIM_FAREWELL_TTS_DRAIN_ENABLED");
  });
});
