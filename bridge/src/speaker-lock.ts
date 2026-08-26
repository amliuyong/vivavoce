/**
 * 声纹锁定说话人(design contract)—— 会话内自动注册 + 异步打断声纹门。
 *
 * 治「旁边有人说话 AI 被误打断」:现有 barge-in 全是纯能量、不认「谁在说」。开场用**首个稳定说话者 +
 * 多段一致性校验**自动注册参考声纹(GPU CAM++ embedding),之后打断候选成立时异步验证「这段是不是目标人」,
 * 仅**高置信非目标(NONTARGET)**才抑制打断。一切不确定(短窗/临界分/超时/故障)→ UNCERTAIN → fail-open
 * (退回纯能量判定,等价现状)——红线「宁漏判旁人,不误判目标人」。
 *
 * 本模块只做**会话状态 + 纯判定 + GPU embedding I/O**;与 media-session 的接线(注册累计触发点、
 * detectBargeIn 命中后发起验证、NONTARGET 抑制/tentative-pause 联动)在 media-session.ts。
 *
 * 分层(便于单测):
 *  - cosine / loadSpeakerLockConfig / classifyVerdict / EnrollmentTracker:**纯逻辑**,不触网。
 *  - GpuEmbedder:唯一 I/O(POST /embedding),注入式(测试传 stub)。
 *  - SpeakerLock:组合以上 + 单飞验证状态机;GPU embedder 注入,可脱离网络单测。
 */
import { request } from "undici";

import { SPEAKER_EMBEDDING_DIM } from "./gpu-embedding-dim";

// ── 配置(env;初值须部署验证标定,见 design contract §配置)──
export interface SpeakerLockConfig {
  /** 全局 kill-switch:false → 声纹门全局不介入(一键回滚,盖过 Agent 配置)。 */
  enabled: boolean;
  /** τ_high:cosine ≥ 此判 TARGET(高置信目标人)。 */
  thresholdHigh: number;
  /** τ_low:cosine ≤ 此判 NONTARGET(高置信非目标)。(τ_low, τ_high) 之间 = UNCERTAIN fail-open。 */
  thresholdLow: number;
  /** 单段累计有效目标语音时长门槛(ms,注册用)。 */
  enrollMs: number;
  /** 注册段内静音容忍(ms):超此判段结束(真段边界)——防跨长静音拼假连续段(review)。 */
  enrollGapMs: number;
  /** 多段一致性阈:段间 embedding cosine ≥ 此才认同一说话者(防旁人污染)。 */
  enrollConsistency: number;
  /** /embedding 请求超时(ms);超时 → UNCERTAIN fail-open。 */
  timeoutMs: number;
  /** ENROLLED 后对高置信 TARGET 帧 EMA 更新 refEmb 的系数(0=不更新)。 */
  ema: number;
  /** 打断验证的**最小候选窗时长**(ms):短于此的窗 → 强制 UNCERTAIN(fail-open),不下 NONTARGET 判定
   *  (review:短音频 EER 退化,design contract §关键风险 3 要求短窗 UNCERTAIN)。 */
  minVerifyMs: number;
  /** 打断候选窗音频上限(ms):tentative-pause 期取最近这段高能量 PCM 送 GPU 验证;有界 ring(超此丢最早帧)。 */
  verifyWindowMs: number;
  /** GPU /embedding 端点(内网 HTTP);空 → 声纹门不可用(fail-open)。 */
  embeddingUrl: string;
  /** GPU /embedding 鉴权 secret(X-Embedding-Secret);空 → 端点禁用(fail-open)。 */
  embeddingSecret: string;
  /** 配置是否合法(阈值满足 -1<=low<high<=1)。非法 → 声纹门**禁用 fail-open**(review:
   *  否则错配阈值如 high=2/low=1 会把 cosine=1 的目标人判 NONTARGET,违背 D1)。 */
  valid: boolean;
}

function numEnv(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 内建默认值(design contract:**单一事实源**)——初值 = design contract §配置表;真机标定覆盖。
 *
 * ⚠ 这些值曾被 registry 手抄一份且 8 项抄错(最严重 `timeoutMs` 200 → 15000,**差 75 倍**)。
 * 故此后 registry / `/config` 端点 MUST import 本导出,MUST NOT 另写字面量。
 */
export const SPEAKER_LOCK_DEFAULTS = {
  thresholdHigh: 0.35,
  thresholdLow: 0.2,
  enabled: true,
  enrollMs: 4000,
  enrollGapMs: 600,
  enrollConsistency: 0.6,
  timeoutMs: 200,
  ema: 0,
  minVerifyMs: 400,
  verifyWindowMs: 1000,
} as const;

/**
 * 全局 kill-switch 解析(design contract):唯 `"0"` 关(默认开、上线即生效,设计决策 D3)。
 *
 * 单独导出是因为 `index.ts` 也要判它(effective_speaker_lock = Agent 请求 && 此开关 && recovery 开),
 * 原为两处独立 `!== "0"` 字面量 —— design contract 要求收敛到一处,防将来一处改另一处漏。
 */
export function speakerLockEnabled(): boolean {
  return process.env.AIM_SPEAKER_LOCK_ENABLED !== "0";
}

/** 从 env 载入配置(初值 = design contract §配置表;真机标定覆盖)。 */
export function loadSpeakerLockConfig(): SpeakerLockConfig {
  const thresholdHigh = numEnv("AIM_SPEAKER_LOCK_THRESHOLD_HIGH", SPEAKER_LOCK_DEFAULTS.thresholdHigh);
  const thresholdLow = numEnv("AIM_SPEAKER_LOCK_THRESHOLD_LOW", SPEAKER_LOCK_DEFAULTS.thresholdLow);
  // 阈值安全校验(review):cosine ∈ [-1,1],须 -1<=low<high<=1。非法(如 high=2/low=1,或 low>=high)
  //   → valid=false → 声纹门禁用 fail-open(绝不用错配阈值把目标人判 NONTARGET,守 D1)。
  const valid =
    thresholdLow >= -1 && thresholdHigh <= 1 && thresholdLow < thresholdHigh;
  if (!valid) {
    console.warn(
      `[speaker-lock] 阈值非法(low=${thresholdLow} high=${thresholdHigh},须 -1<=low<high<=1)→ 声纹门禁用 fail-open`,
    );
  }
  return {
    // 唯 "0" 关(默认开、上线即生效,设计决策 D3);其余任意值(含未设)→ 开。
    enabled: speakerLockEnabled(),
    thresholdHigh,
    thresholdLow,
    enrollMs: numEnv("AIM_SPEAKER_LOCK_ENROLL_MS", SPEAKER_LOCK_DEFAULTS.enrollMs),
    enrollGapMs: numEnv("AIM_SPEAKER_LOCK_ENROLL_GAP_MS", SPEAKER_LOCK_DEFAULTS.enrollGapMs),
    enrollConsistency: numEnv("AIM_SPEAKER_LOCK_ENROLL_CONSISTENCY", SPEAKER_LOCK_DEFAULTS.enrollConsistency),
    timeoutMs: numEnv("AIM_SPEAKER_LOCK_TIMEOUT_MS", SPEAKER_LOCK_DEFAULTS.timeoutMs),
    ema: numEnv("AIM_SPEAKER_LOCK_EMA", SPEAKER_LOCK_DEFAULTS.ema),
    minVerifyMs: numEnv("AIM_SPEAKER_LOCK_MIN_VERIFY_MS", SPEAKER_LOCK_DEFAULTS.minVerifyMs),
    verifyWindowMs: numEnv("AIM_SPEAKER_LOCK_VERIFY_WINDOW_MS", SPEAKER_LOCK_DEFAULTS.verifyWindowMs),
    embeddingUrl: process.env.AIM_GPU_EMBEDDING_URL ?? "",
    embeddingSecret: process.env.AIM_EMBEDDING_SECRET ?? "",
    valid,
  };
}

// ── 纯逻辑:cosine ──
/** 两向量余弦相似度;维度不符 / 任一零向量 → NaN(上层据 NaN 判 UNCERTAIN fail-open)。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── 纯逻辑:三态裁决(design contract D5)──
export type Verdict = "TARGET" | "UNCERTAIN" | "NONTARGET";

/** cosine + 双阈 → 三态。NaN(维度错/零向量/无 refEmb)→ UNCERTAIN(fail-open)。
 *  ≥ τ_high → TARGET;≤ τ_low → NONTARGET;之间 → UNCERTAIN(临界不确定,倾向放行目标人)。 */
export function classifyVerdict(cos: number, cfg: SpeakerLockConfig): Verdict {
  if (!Number.isFinite(cos)) return "UNCERTAIN";
  if (cos >= cfg.thresholdHigh) return "TARGET";
  if (cos <= cfg.thresholdLow) return "NONTARGET";
  return "UNCERTAIN";
}

// ── GPU embedding I/O(唯一触网;注入式,测试传 stub)──
export interface Embedder {
  /** 一段 16k mono s16le PCM → embedding 向量;失败/超时 → null(上层 UNCERTAIN fail-open)。 */
  embed(pcm: Buffer): Promise<number[] | null>;
}

/** 真 GPU embedder:POST /embedding(带超时 + X-Embedding-Secret)。任何失败返 null(不抛,让上层 fail-open)。 */
export class GpuEmbedder implements Embedder {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly timeoutMs: number,
  ) {}

  async embed(pcm: Buffer): Promise<number[] | null> {
    if (!this.url || !this.secret) return null; // 未配 → 声纹门不可用,fail-open
    try {
      const { statusCode, body } = await request(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-embedding-secret": this.secret,
        },
        body: JSON.stringify({ pcm_base64: pcm.toString("base64"), sample_rate: 16000 }),
        // 全请求 deadline(review 不覆盖 DNS/连接/连接池排队/总时长 →
        //   验证可能长期停在 VERIFYING)。AbortSignal.timeout 是端到端硬 deadline;超时 → 抛 → catch → null → UNCERTAIN。
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (statusCode !== 200) {
        // 读掉 body 防连接泄漏
        await body.text().catch(() => undefined);
        return null;
      }
      const json = (await body.json()) as { embedding?: unknown };
      const emb = json?.embedding;
      if (!Array.isArray(emb) || emb.length !== SPEAKER_EMBEDDING_DIM) return null;
      const vec = emb.map((x) => Number(x));
      if (vec.some((x) => !Number.isFinite(x))) return null;
      return vec;
    } catch {
      return null; // 超时/网络/解析失败 → null(UNCERTAIN fail-open,不误聋目标人)
    }
  }
}

// ── 注册状态机(design contract D8:首个稳定说话者 + 多段一致性)──
export type EnrollState = "UNENROLLED" | "ENROLLING" | "ENROLLED";

/**
 * 注册累计器(纯逻辑,不触网):喂「已取好的段 embedding」,判是否达成「≥2 段一致 → 合成 refEmb」。
 * 段的**采集**(累计 enrollMs 干净语音后取 embedding)在 media-session;本类只管一致性判定 + refEmb 合成 + EMA。
 *
 * 状态:UNENROLLED(段不足)→(内部 ENROLLING 由 media-session 侧的 embedding 飞行表达)→ ENROLLED。
 * 一致性:新段与已收集段**逐一** cosine ≥ enrollConsistency 才纳入;满 2 段一致 → 合成(均值)refEmb → ENROLLED。
 * 不一致(开场旁人插入 / 多人交替)→ 丢弃最早段、以新段续攒(不轻率锁到污染声纹)。
 */
export class EnrollmentTracker {
  private segments: number[][] = []; // 已确认「同一说话者」的段 embedding
  private ref: number[] | null = null;

  constructor(private readonly cfg: SpeakerLockConfig) {}

  get state(): EnrollState {
    return this.ref ? "ENROLLED" : "UNENROLLED";
  }

  get refEmb(): number[] | null {
    return this.ref;
  }

  /** 纳入一段新 embedding;返回是否**本次**达成 ENROLLED。 */
  addSegment(emb: number[]): boolean {
    if (this.ref) return false; // 已注册,后续跟踪走 updateEma
    if (emb.length !== SPEAKER_EMBEDDING_DIM) return false;
    if (this.segments.length === 0) {
      this.segments.push(emb);
      return false;
    }
    // 与已有段逐一比:全一致 → 纳入;否则视为「换人了」,丢最早段、以新段重起(保最新连续段)。
    const allConsistent = this.segments.every((s) => cosine(s, emb) >= this.cfg.enrollConsistency);
    if (allConsistent) {
      this.segments.push(emb);
    } else {
      this.segments = [emb];
      return false;
    }
    if (this.segments.length >= 2) {
      this.ref = meanVector(this.segments);
      return true;
    }
    return false;
  }

  /** ENROLLED 后对高置信 TARGET 帧 EMA 更新 refEmb(cfg.ema>0 时;跟随目标人当场声学漂移)。 */
  updateEma(emb: number[]): void {
    if (!this.ref || this.cfg.ema <= 0 || emb.length !== this.ref.length) return;
    const a = this.cfg.ema;
    this.ref = this.ref.map((v, i) => a * emb[i] + (1 - a) * v);
  }
}

/** 向量均值(L2 不归一——cosine 对模长不敏感,均值方向即可)。 */
function meanVector(vecs: number[][]): number[] {
  const dim = vecs[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

// ── 会话级编排(注册 + 异步单飞验证 + 冷却;GPU embedder 注入,可脱网单测)──
export type VerifyState = "IDLE" | "VERIFYING";

/**
 * 会话级声纹锁编排(design contract)。持有 EnrollmentTracker + Embedder + 单飞验证状态。
 * media-session 用法:
 *  - 注册:AI 未在说的干净连续说话段累计够 enrollMs + **段间须过长静音/turn 边界** → `submitEnrollmentSegment(pcm)`。
 *  - 验证:detectBargeIn 命中 confirmMs 且 ENROLLED + 窗口 ≥ minVerifyMs → `verify(pcm, windowMs)`(异步单飞),回调裁决。
 *  - 抑制:NONTARGET 由 media-session 绑**连续能量 episode** 压制(非 wall-clock 冷却;能量跌破 hangover 即结束 episode,
 *    目标人新 episode 重新验证)——本类不再持 cooldown(review 会跨 episode 误压目标人)。
 *  - teardown:`dispose()` 使飞行中的验证/注册回调作废(stale 丢弃,不误操作已销毁的轮)。
 */
export class SpeakerLock {
  private readonly tracker: EnrollmentTracker;
  private verifyState: VerifyState = "IDLE";
  private disposed = false;
  private enrollInflight = false; // 注册 embedding 飞行中(视同未就绪,打断 fail-open)

  constructor(
    private readonly cfg: SpeakerLockConfig,
    private readonly embedder: Embedder,
    private readonly log?: (msg: string) => void,
  ) {
    this.tracker = new EnrollmentTracker(cfg);
  }

  /** 暴露配置(单一事实源,review 从此读注册/验证窗参数,不再各自重解析同一 env)。 */
  get config(): SpeakerLockConfig {
    return this.cfg;
  }

  get enrolled(): boolean {
    return this.tracker.state === "ENROLLED";
  }

  get state(): EnrollState {
    return this.tracker.state;
  }

  get verifying(): boolean {
    return this.verifyState === "VERIFYING";
  }

  /** 是否处于「注册未就绪」(UNENROLLED 或注册 embedding 飞行中)—— **打断路径** fail-open 判据。 */
  get enrollmentPending(): boolean {
    return !this.enrolled || this.enrollInflight;
  }

  /** **注册累计路径**是否应继续攒段:未注册 且 无飞行中请求(≠ enrollmentPending——那含「未注册」恒真)。 */
  get canAccumulateEnrollment(): boolean {
    return !this.enrolled && !this.enrollInflight;
  }

  /** 提交一段注册候选 PCM:异步取 embedding + 纳入一致性判定。飞行期 enrollInflight=true(视同未就绪)。 */
  async submitEnrollmentSegment(pcm: Buffer): Promise<void> {
    if (this.disposed || this.enrolled || this.enrollInflight) return;
    this.enrollInflight = true;
    let emb: number[] | null = null;
    try {
      emb = await this.embedder.embed(pcm);
    } finally {
      this.enrollInflight = false;
    }
    if (this.disposed || !emb) return; // stale / embedding 失败 → 不注册(继续累计后续段)
    const done = this.tracker.addSegment(emb);
    if (done) this.log?.("speaker-lock 注册完成(≥2 段一致)→ ENROLLED,后续打断走声纹门");
  }

  /**
   * 验证一段打断候选 PCM(异步单飞)。仅当 ENROLLED + 空闲 + 窗口时长 ≥ minVerifyMs 时发起。
   * 回调 onVerdict 在结果回来(且未 dispose)时调用一次;短窗/超时/失败/维度错 → UNCERTAIN(fail-open)。
   * **EMA 不在此更新**(review:回调可能已 stale,须由 media-session 在确认非 stale + takeover 后
   * 经 commitEmaIfTarget 显式提交)——onVerdict 第二参数回传 emb(TARGET 时非空),media-session 决定是否 commit。
   * 返回值:是否**已发起**验证(false = 未发起/窗太短,调用方按现状 fail-open 继续)。
   */
  verify(
    pcm: Buffer,
    windowMs: number,
    onVerdict: (v: Verdict, emb: number[] | null) => void,
  ): boolean {
    if (this.disposed || !this.enrolled) return false;
    if (this.verifyState === "VERIFYING") return false; // 单飞:同 episode 只一个请求
    // 短窗强制不发起(review:短音频 EER 退化,design contract §关键风险 3 短窗须 UNCERTAIN=fail-open)。
    // 未发起 → 调用方按能量证据继续(fail-open);窗随 tentative-pause 高能量帧增长后由再次调用 verify 触发。
    if (windowMs < this.cfg.minVerifyMs) return false;
    const ref = this.tracker.refEmb;
    if (!ref) return false;
    this.verifyState = "VERIFYING";
    void this.embedder
      .embed(pcm)
      .then((emb) => {
        if (this.disposed) return; // teardown:丢弃,不回调已销毁的轮
        this.verifyState = "IDLE";
        const cos = emb ? cosine(emb, ref) : NaN;
        const verdict = classifyVerdict(cos, this.cfg);
        this.log?.(`speaker-lock 验证:cos=${Number.isFinite(cos) ? cos.toFixed(3) : "NaN"} → ${verdict}`);
        onVerdict(verdict, verdict === "TARGET" ? emb : null);
      })
      .catch(() => {
        if (this.disposed) return;
        this.verifyState = "IDLE";
        onVerdict("UNCERTAIN", null); // 异常 → fail-open
      });
    return true;
  }

  /** EMA 提交(review):media-session 在**确认非 stale + 真接管**后显式调用,才把 TARGET 帧并入 refEmb。 */
  commitEma(emb: number[]): void {
    if (this.disposed || this.cfg.ema <= 0) return;
    this.tracker.updateEma(emb);
  }

  /** 会话/轮结束清理:使飞行中的验证/注册回调作废(不回调已销毁的轮)。 */
  dispose(): void {
    this.disposed = true;
  }
}

/** 工厂:据 effective 配置 + GPU 端点构造 SpeakerLock;未配端点/secret 时 embedder 恒返 null(fail-open)。 */
export function createSpeakerLock(
  cfg: SpeakerLockConfig,
  log?: (msg: string) => void,
): SpeakerLock {
  const embedder = new GpuEmbedder(cfg.embeddingUrl, cfg.embeddingSecret, cfg.timeoutMs);
  return new SpeakerLock(cfg, embedder, log);
}
