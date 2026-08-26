/**
 * 服务端播放结算协调器(design contract/R5/R7)——把 ACK 的乱序/重复/timeout/input-drain/mode 差异收敛到
 * **一个轮级结算模块**。外部只消费 `complete|aborted|timed_out` 结果,不让 media-session/three-stage-engine/
 * farewell timer 各自解析 ACK。身份 = `(连接内, ai_turn_id)`(连接级单调,重连重置)。
 *
 * ★ **design contract A 类:`AIM_PLAYBACK_ACK_MODE` 三态开关已删**(deployment validation)。
 *   历史上有 `off | observe | enforce` 三态用于分阶段上线(R7):off 不实例化、observe 只采 shadow 数据不夺
 *   控制权、enforce 驱动真 continuation。**现在恒等于旧 enforce 语义**,协调器一旦建立即拥有结算控制权。
 *
 *   为什么删:三态里唯一的生产正确值就是 enforce —— `off`/`observe` 意味着「换轮旧音频继续播」这个已知
 *   缺陷。留着开关 = 留一条能静默回退到该 bug 的路径。observe 的 shadow 采集价值属
 *   **开发期**;将来若需再采,用开发分支临时加回,不留生产开关。
 *
 *   ⚠ **MUST NOT 加回 mode 开关**。回滚靠 git revert + 重新部署。
 *
 * 状态机(每个有音频的协商轮):`streaming → awaiting_ack → complete | aborted | timed_out`(终态单调,至多结算一次)。
 * timeout 带 fallback 子类(`estimated_complete` / `user_takeover_abort`),不用无语义布尔(R4)。
 *
 * ★ 本模块**不设定时器**(测试确定性 + 无泄漏):timeout 由外部(media-session 的既有 tick/看门狗或显式调用)
 *   驱动 `checkTimeouts(nowMs)`。
 */

// design contract:playbackClock 默认值的权威事实源(消除本文件原先另抄的 20000,见 loadAckTimeoutConfig 注释)。
// turn-handling 是纯叶子模块(零本地 import),此 import 不成环。
import { PLAYBACK_LEAD_BOUNDS, TURN_HANDLING_DEFAULTS } from "./turn-handling";

export type SettlementOutcome = "complete" | "aborted" | "timed_out";
export type TimeoutFallback = "estimated_complete" | "user_takeover_abort";
export type TurnPhase = "streaming" | "awaiting_ack" | "complete" | "aborted" | "timed_out";

/** 结算结果(外部消费,驱动 continuation)。 */
export interface Settlement {
  aiTurnId: number;
  outcome: SettlementOutcome;
  fallback?: TimeoutFallback; // 仅 timed_out
  abortReason?: string; // 仅 aborted(客户端提供,仅诊断,非控制依据)
  latencyMs: number; // ai_audio_end 到 ACK/timeout
  estimateErrorMs?: number; // complete 接收时刻 − design contract 估算边界(仅观测,非物理出声真值)
}

interface TurnRec {
  aiTurnId: number;
  phase: TurnPhase;
  endAtMs: number; // ai_audio_end(server_drained)时刻;0 = 尚未 end(streaming)
  estimatedEndMs: number; // end 时的 design contract 估算播完边界(算 estimate-error 用)
  deadlineMs: number; // 硬 deadline(awaiting_ack 后计算);0 = 未 armed
  settled: boolean;
}

export interface AckTimeoutConfig {
  graceMs: number; // 估算播完后额外等 ACK 的余量(默认 3000,[0,15000])
  maxWaitMs: number; // 从 ai_audio_end 起等 ACK 的硬上限(默认 45000,[1000,180000])
  inputGraceMs: number; // awaiting_ack 时收到用户实质输入后等 aborted ACK 的宽限(默认 1000,[100,5000])
  maxPlaybackLeadMs: number; // design contract 合法播放估算边界(跨参数不变量校验用)
}

/**
 * ACK timeout 默认值(design contract:**单一事实源**;registry 与 `/config` MUST 复用,勿另抄)。
 */
export const ACK_TIMEOUT_DEFAULTS = {
  graceMs: 3000,
  maxWaitMs: 45000,
  inputGraceMs: 1000,
} as const;

/** 各项合法区间(fail-fast 边界;registry 展示与守门测试复用)。 */
export const ACK_TIMEOUT_BOUNDS = {
  graceMs: { min: 0, max: 15000 },
  maxWaitMs: { min: 1000, max: 180000 },
  inputGraceMs: { min: 100, max: 5000 },
  // ★ 复用 turn-handling 的权威边界(design contract 修 review):原先另写 max=600000,与推进时钟的
  //   120000 不一致 → env 落在两者之间时,推进时钟静默回退默认而本校验抛错崩启动。
  maxPlaybackLeadMs: PLAYBACK_LEAD_BOUNDS,
} as const;

/** 从 env 读 timeout 配置 + 跨参数不变量校验(fail-fast)。 */
export function loadAckTimeoutConfig(env: NodeJS.ProcessEnv = process.env): AckTimeoutConfig {
  const num = (raw: string | undefined, def: number, lo: number, hi: number, name: string): number => {
    if (raw === undefined || raw === "") return def;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < lo || v > hi) {
      throw new Error(`${name} 非法值 "${raw}"(需 [${lo},${hi}] 内数字)`);
    }
    return v;
  };
  const B = ACK_TIMEOUT_BOUNDS;
  const graceMs = num(env.AIM_PLAYBACK_ACK_GRACE_MS, ACK_TIMEOUT_DEFAULTS.graceMs,
    B.graceMs.min, B.graceMs.max, "AIM_PLAYBACK_ACK_GRACE_MS");
  const maxWaitMs = num(env.AIM_PLAYBACK_ACK_MAX_WAIT_MS, ACK_TIMEOUT_DEFAULTS.maxWaitMs,
    B.maxWaitMs.min, B.maxWaitMs.max, "AIM_PLAYBACK_ACK_MAX_WAIT_MS");
  const inputGraceMs = num(env.AIM_PLAYBACK_ACK_INPUT_GRACE_MS, ACK_TIMEOUT_DEFAULTS.inputGraceMs,
    B.inputGraceMs.min, B.inputGraceMs.max, "AIM_PLAYBACK_ACK_INPUT_GRACE_MS");
  // design contract 播放估算边界上限 —— **MUST 复用 turn-handling 的权威默认**(design contract 修真实缺陷):
  //   原本此处另抄 20000,而推进时钟实际用的是 TURN_HANDLING_DEFAULTS.playbackClock.maxLeadMs = 35000。
  //   两值不一致使下面的跨参数守门拿错的 lead 去判,漏判窗口 maxWait ∈ [23000, 38000):
  //   该区间配置能通过守门,却仍会把 35s 的合法长音频截短成提前推进 —— 正是本守门要防的故障。
  //   现默认收敛到同一事实源(仅用于跨参数不变量校验,不改 design contract 自身行为)。
  const maxPlaybackLeadMs = num(env.AIM_MAX_PLAYBACK_LEAD_MS,
    TURN_HANDLING_DEFAULTS.playbackClock.maxLeadMs,
    B.maxPlaybackLeadMs.min, B.maxPlaybackLeadMs.max, "AIM_MAX_PLAYBACK_LEAD_MS");
  // 跨参数不变量:硬上限不得早于 design contract 合法播放估算边界 + grace(否则会把合法长音频截短成提前推进)。
  if (maxWaitMs < maxPlaybackLeadMs + graceMs) {
    throw new Error(
      `AIM_PLAYBACK_ACK_MAX_WAIT_MS(${maxWaitMs}) < AIM_MAX_PLAYBACK_LEAD_MS(${maxPlaybackLeadMs}) + AIM_PLAYBACK_ACK_GRACE_MS(${graceMs}) —— 违反跨参数不变量`,
    );
  }
  return { graceMs, maxWaitMs, inputGraceMs, maxPlaybackLeadMs };
}

/** ACK 指标(R7:先 shadow 可观测再取控制权)。每个有音频的协商轮记一条。 */
export interface AckMetric {
  aiTurnId: number;
  outcome: SettlementOutcome;
  fallback?: TimeoutFallback;
  latencyMs: number;
  estimateErrorMs?: number;
  abortReason?: string;
  duplicate?: boolean; // 重复/迟到 ACK(不改状态)
  stale?: boolean; // 已 timed_out 后到的 ACK
  unknown?: boolean; // 未知/未协商轮的 ACK
}

export class PlaybackSettlementCoordinator {
  private readonly turns = new Map<number, TurnRec>();
  private readonly settledOnce = new Map<number, SettlementOutcome>(); // 已结算轮 id → 终态(防重复 continuation + 分类迟到 ACK)
  private readonly cfg: AckTimeoutConfig;
  private readonly onSettle: (s: Settlement) => void; // 驱动 continuation
  private readonly onMetric: (m: AckMetric) => void; // 指标记录(结构化日志/DDB)
  private readonly now: () => number;

  constructor(opts: {
    cfg: AckTimeoutConfig;
    onSettle?: (s: Settlement) => void;
    onMetric?: (m: AckMetric) => void;
    now?: () => number;
  }) {
    this.cfg = opts.cfg;
    this.onSettle = opts.onSettle ?? (() => {});
    this.onMetric = opts.onMetric ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** ai_audio_start 已下发 → 建轮状态(streaming)。R4:MUST 在发 start 前建状态(此处即调用点)。 */
  beginTurn(aiTurnId: number): void {
    if (this.turns.has(aiTurnId)) return; // 幂等(重复 start,fail-soft)
    this.turns.set(aiTurnId, {
      aiTurnId,
      phase: "streaming",
      endAtMs: 0,
      estimatedEndMs: 0,
      deadlineMs: 0,
      settled: false,
    });
  }

  /** ai_audio_end 已下发(server_drained)→ awaiting_ack + 计算 deadline。estimatedEndMs = design contract 估算播完边界。 */
  endTurn(aiTurnId: number, estimatedEndMs: number): void {
    const rec = this.turns.get(aiTurnId);
    if (!rec || rec.phase !== "streaming") return; // end-before-start / 重复 end:fail-soft
    const now = this.now();
    rec.phase = "awaiting_ack";
    rec.endAtMs = now;
    rec.estimatedEndMs = estimatedEndMs;
    // deadline = min(估算播完 + grace, 硬上限)。合法配置下 hardDeadline 不早于 design contract 最大估算边界(不变量已校验)。
    const estimatedDeadline = Math.max(now, estimatedEndMs) + this.cfg.graceMs;
    const hardDeadline = now + this.cfg.maxWaitMs;
    rec.deadlineMs = Math.min(estimatedDeadline, hardDeadline);
  }

  /** 收客户端上行 ACK(playback_complete / playback_aborted)。乱序/重复/未知/负数 fail-soft(只记指标不改状态)。 */
  onAck(aiTurnId: number, kind: "complete" | "aborted", reason?: string): void {
    if (!Number.isInteger(aiTurnId) || aiTurnId < 0) {
      this.onMetric({ aiTurnId: -1, outcome: kind === "complete" ? "complete" : "aborted", latencyMs: 0, unknown: true });
      return;
    }
    const rec = this.turns.get(aiTurnId);
    if (!rec) {
      // 已结算轮的迟到 ACK:complete/aborted 后到 = duplicate(幂等确认);timed_out 后到 = stale。
      const done = this.settledOnce.get(aiTurnId);
      if (done === "complete" || done === "aborted") {
        this.onMetric({ aiTurnId, outcome: done, latencyMs: 0, duplicate: true });
      } else if (done === "timed_out") {
        this.onMetric({ aiTurnId, outcome: "timed_out", latencyMs: 0, stale: true });
      } else {
        // 未协商/未知轮的 ACK:R2「服务端收到未协商 playback ACK MUST 忽略并记协议诊断」。
        this.onMetric({ aiTurnId, outcome: kind === "complete" ? "complete" : "aborted", latencyMs: 0, unknown: true });
      }
      return;
    }
    if (rec.phase === "complete" || rec.phase === "aborted") {
      this.onMetric({ aiTurnId, outcome: rec.phase, latencyMs: 0, duplicate: true }); // 重复 ACK:幂等不改状态
      return;
    }
    if (rec.phase === "timed_out") {
      this.onMetric({ aiTurnId, outcome: "timed_out", latencyMs: 0, stale: true }); // late ACK:只记 stale
      return;
    }
    // streaming/awaiting_ack → 终态。latency 从 end 起算(streaming 期极早 ACK 理论罕见,latency 记 0)。
    const now = this.now();
    const latencyMs = rec.endAtMs > 0 ? Math.max(0, now - rec.endAtMs) : 0;
    if (kind === "complete") {
      rec.phase = "complete";
      const estimateErrorMs = rec.estimatedEndMs > 0 ? now - rec.estimatedEndMs : undefined;
      this.finish({ aiTurnId, outcome: "complete", latencyMs, estimateErrorMs });
    } else {
      rec.phase = "aborted";
      this.finish({ aiTurnId, outcome: "aborted", latencyMs, abortReason: reason });
    }
  }

  /** 上行 barge_in 已到(客户端已本地 stop 的权威证据,R5)→ 立即把对应 awaiting/streaming 轮结算为 aborted。
   *  随后的 playback_aborted 作幂等确认(上面 onAck 的 duplicate 分支)。 */
  onUplinkBargeIn(aiTurnId: number): void {
    const rec = this.turns.get(aiTurnId);
    if (!rec || rec.phase === "complete" || rec.phase === "aborted" || rec.phase === "timed_out") return;
    rec.phase = "aborted";
    const now = this.now();
    const latencyMs = rec.endAtMs > 0 ? Math.max(0, now - rec.endAtMs) : 0;
    this.finish({ aiTurnId, outcome: "aborted", latencyMs, abortReason: "barge_in" });
  }

  /** 外部驱动的 deadline 检查(无内部定时器):到期未 ACK 的 awaiting 轮 → timed_out(estimated_complete)。
   *  timed_out 经 onSettle 兑现一次估算 continuation(有界 fallback:客户端不回 ACK 不能让推进永久卡住)。 */
  checkTimeouts(nowMs: number = this.now()): void {
    for (const rec of this.turns.values()) {
      if (rec.phase !== "awaiting_ack") continue;
      if (rec.deadlineMs > 0 && nowMs >= rec.deadlineMs) {
        rec.phase = "timed_out";
        const latencyMs = Math.max(0, nowMs - rec.endAtMs);
        this.finish({ aiTurnId: rec.aiTurnId, outcome: "timed_out", fallback: "estimated_complete", latencyMs });
      }
    }
  }

  /** 用户实质输入竞态(R5):awaiting_ack 期收到用户实质输入 → input-grace 到期仍无 ACK 则结算为
   *  timed_out(user_takeover_abort)(不推进旧轮),随后消费用户输入。此处标记 grace 起点;到期由 checkInputGrace 判。 */
  private inputGraceStartMs = new Map<number, number>();
  noteUserInputDuringAwait(aiTurnId: number): void {
    const rec = this.turns.get(aiTurnId);
    if (!rec || rec.phase !== "awaiting_ack") return;
    if (!this.inputGraceStartMs.has(aiTurnId)) this.inputGraceStartMs.set(aiTurnId, this.now());
  }
  checkInputGrace(nowMs: number = this.now()): void {
    for (const [aiTurnId, startMs] of this.inputGraceStartMs) {
      const rec = this.turns.get(aiTurnId);
      if (!rec || rec.phase !== "awaiting_ack") {
        this.inputGraceStartMs.delete(aiTurnId);
        continue;
      }
      if (nowMs - startMs >= this.cfg.inputGraceMs) {
        rec.phase = "timed_out";
        const latencyMs = Math.max(0, nowMs - rec.endAtMs);
        this.finish({ aiTurnId, outcome: "timed_out", fallback: "user_takeover_abort", latencyMs });
        this.inputGraceStartMs.delete(aiTurnId);
      }
    }
  }

  /** 恰好一次结算:记指标 + (enforce)驱动 continuation。终态轮出 map(防泄漏)。 */
  private finish(s: Settlement): void {
    if (this.settledOnce.has(s.aiTurnId)) return;
    this.settledOnce.set(s.aiTurnId, s.outcome);
    this.onMetric({
      aiTurnId: s.aiTurnId,
      outcome: s.outcome,
      fallback: s.fallback,
      latencyMs: s.latencyMs,
      estimateErrorMs: s.estimateErrorMs,
      abortReason: s.abortReason,
    });
    this.onSettle(s); // 驱动真实 continuation(恰好一次)
    this.turns.delete(s.aiTurnId);
    this.inputGraceStartMs.delete(s.aiTurnId);
  }

  /** 当前 awaiting_ack 的轮数(测试/诊断)。 */
  pendingCount(): number {
    let n = 0;
    for (const r of this.turns.values()) if (r.phase === "awaiting_ack") n++;
    return n;
  }

  phaseOf(aiTurnId: number): TurnPhase | "unknown" {
    const live = this.turns.get(aiTurnId);
    if (live) return live.phase;
    return this.settledOnce.get(aiTurnId) ?? "unknown"; // 已结算轮返回其终态,否则 unknown
  }
}
