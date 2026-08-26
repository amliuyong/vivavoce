/**
 * 声纹锁定纯逻辑 UT(design contract)—— cosine / 三态裁决 / 配置 / 注册状态机 / GpuEmbedder(stub).
 * 不触网:GpuEmbedder 的 request 路径由 media-session 集成测试 + 真机覆盖;此处只测注入式纯逻辑。
 */
import {
  cosine,
  classifyVerdict,
  loadSpeakerLockConfig,
  EnrollmentTracker,
  type SpeakerLockConfig,
} from "../src/speaker-lock";
import { SPEAKER_EMBEDDING_DIM } from "../src/gpu-embedding-dim";

function cfg(over: Partial<SpeakerLockConfig> = {}): SpeakerLockConfig {
  return {
    enabled: true,
    thresholdHigh: 0.35,
    thresholdLow: 0.2,
    enrollMs: 4000,
    enrollGapMs: 600,
    enrollConsistency: 0.6,
    timeoutMs: 200,
    ema: 0,
    minVerifyMs: 400,
    verifyWindowMs: 1000,
    embeddingUrl: "http://gpu:8080/embedding",
    embeddingSecret: "s",
    valid: true,
    ...over,
  };
}

/** DIM 维向量:base 方向 + 少量按 seed 的扰动(用于造不同/相似说话人)。 */
function vec(seed: number, tilt = 0): number[] {
  const v = new Array<number>(SPEAKER_EMBEDDING_DIM);
  for (let i = 0; i < SPEAKER_EMBEDDING_DIM; i++) {
    v[i] = Math.sin((i + 1) * (seed + 1) * 0.1) + tilt * Math.cos(i * 0.3);
  }
  return v;
}

describe("cosine", () => {
  it("同向量 = 1", () => {
    const v = vec(1);
    expect(cosine(v, v)).toBeCloseTo(1, 6);
  });
  it("维度不符 → NaN", () => {
    expect(Number.isNaN(cosine([1, 2, 3], [1, 2]))).toBe(true);
  });
  it("零向量 → NaN(上层 fail-open)", () => {
    expect(Number.isNaN(cosine([0, 0], [1, 1]))).toBe(true);
  });
});

describe("classifyVerdict 三态(D5)", () => {
  const c = cfg();
  it(">= τ_high → TARGET", () => {
    expect(classifyVerdict(0.5, c)).toBe("TARGET");
    expect(classifyVerdict(0.35, c)).toBe("TARGET");
  });
  it("<= τ_low → NONTARGET", () => {
    expect(classifyVerdict(0.1, c)).toBe("NONTARGET");
    expect(classifyVerdict(0.2, c)).toBe("NONTARGET");
  });
  it("临界带 → UNCERTAIN(fail-open,倾向放行目标人)", () => {
    expect(classifyVerdict(0.3, c)).toBe("UNCERTAIN");
  });
  it("NaN(无 refEmb/维度错/零向量)→ UNCERTAIN(fail-open)", () => {
    expect(classifyVerdict(NaN, c)).toBe("UNCERTAIN");
  });
});

describe("loadSpeakerLockConfig", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("默认开(未设 kill-switch → enabled)", () => {
    delete process.env.AIM_SPEAKER_LOCK_ENABLED;
    expect(loadSpeakerLockConfig().enabled).toBe(true);
  });
  it("kill-switch=0 → 关(一键回滚)", () => {
    process.env.AIM_SPEAKER_LOCK_ENABLED = "0";
    expect(loadSpeakerLockConfig().enabled).toBe(false);
  });
  it("阈值/超时初值(design contract §配置)", () => {
    delete process.env.AIM_SPEAKER_LOCK_THRESHOLD_HIGH;
    delete process.env.AIM_SPEAKER_LOCK_THRESHOLD_LOW;
    delete process.env.AIM_SPEAKER_LOCK_TIMEOUT_MS;
    const c = loadSpeakerLockConfig();
    expect(c.thresholdHigh).toBe(0.35);
    expect(c.thresholdLow).toBe(0.2);
    expect(c.timeoutMs).toBe(200);
  });
  it("坏数值 env → 回落默认(不 NaN 污染)", () => {
    process.env.AIM_SPEAKER_LOCK_THRESHOLD_HIGH = "not-a-number";
    expect(loadSpeakerLockConfig().thresholdHigh).toBe(0.35);
  });
  it("review:合法阈值(-1<=low<high<=1)→ valid=true", () => {
    delete process.env.AIM_SPEAKER_LOCK_THRESHOLD_HIGH;
    delete process.env.AIM_SPEAKER_LOCK_THRESHOLD_LOW;
    expect(loadSpeakerLockConfig().valid).toBe(true);
  });
  it("review:非法阈值(high=2 越界)→ valid=false(声纹门禁用 fail-open,不误判目标人)", () => {
    process.env.AIM_SPEAKER_LOCK_THRESHOLD_HIGH = "2";
    process.env.AIM_SPEAKER_LOCK_THRESHOLD_LOW = "1";
    expect(loadSpeakerLockConfig().valid).toBe(false);
  });
  it("review:非法阈值(low>=high)→ valid=false", () => {
    process.env.AIM_SPEAKER_LOCK_THRESHOLD_HIGH = "0.3";
    process.env.AIM_SPEAKER_LOCK_THRESHOLD_LOW = "0.4";
    expect(loadSpeakerLockConfig().valid).toBe(false);
  });
});

describe("EnrollmentTracker 多段一致性(D8)", () => {
  it("单段不注册(须 ≥2 段一致)", () => {
    const t = new EnrollmentTracker(cfg());
    expect(t.addSegment(vec(1))).toBe(false);
    expect(t.state).toBe("UNENROLLED");
  });
  it("两段一致 → ENROLLED", () => {
    const t = new EnrollmentTracker(cfg());
    t.addSegment(vec(1));
    const done = t.addSegment(vec(1, 0.01)); // 几乎同向(同说话者)
    expect(done).toBe(true);
    expect(t.state).toBe("ENROLLED");
    expect(t.refEmb).not.toBeNull();
  });
  it("首段目标人 + 次段旁人(不一致)→ 不注册,丢早段续攒(防污染)", () => {
    const t = new EnrollmentTracker(cfg({ enrollConsistency: 0.9 }));
    t.addSegment(vec(1)); // 目标人
    const done = t.addSegment(vec(50)); // 旁人(明显不同方向)
    expect(done).toBe(false);
    expect(t.state).toBe("UNENROLLED");
    // 丢早段后以旁人段为起点;若旁人连续两段一致,会锁到旁人——这是"首个稳定说话者"语义(开场谁稳定说谁被锁)
    const done2 = t.addSegment(vec(50, 0.01));
    expect(done2).toBe(true);
  });
  it("ENROLLED 后 addSegment 不再改 ref(跟踪走 updateEma)", () => {
    const t = new EnrollmentTracker(cfg());
    t.addSegment(vec(1));
    t.addSegment(vec(1, 0.01));
    const ref1 = t.refEmb!.slice();
    expect(t.addSegment(vec(9))).toBe(false); // 已 ENROLLED,忽略
    expect(t.refEmb).toEqual(ref1);
  });
  it("EMA 关(默认 0)时 updateEma 不改 ref", () => {
    const t = new EnrollmentTracker(cfg({ ema: 0 }));
    t.addSegment(vec(1));
    t.addSegment(vec(1, 0.01));
    const ref1 = t.refEmb!.slice();
    t.updateEma(vec(9));
    expect(t.refEmb).toEqual(ref1);
  });
  it("EMA 开时 updateEma 向新样本漂移(跟随变声)", () => {
    const t = new EnrollmentTracker(cfg({ ema: 0.3 }));
    t.addSegment(vec(1));
    t.addSegment(vec(1, 0.01));
    const ref1 = t.refEmb!.slice();
    t.updateEma(vec(9));
    expect(t.refEmb).not.toEqual(ref1); // 已漂移
  });
});
