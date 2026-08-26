/**
 * design contract —— 部署清单(deployment manifest)单测。
 *
 * 三条硬要求:
 *  ① **只含非密项** —— 任何 Secret/密钥/token 值 MUST NOT 进清单(本页会展示给 admin)
 *  ② **值与 constants.ts 一致** —— 清单是机械生成而非手抄(手抄实测 46% 出错)
 *  ③ **入选标准消除自指** —— 每项 `consumer` 非空且**不是**「被清单注入」本身
 */
import {
  MANIFEST_SCHEMA_VERSION,
  buildDeploymentManifest,
  serializeDeploymentManifest,
} from '../lib/common/deployment-manifest';
import * as constants from '../lib/common/constants';

const M = buildDeploymentManifest({ region: 'cn-north-1', stackName: 'Voce' });

describe('design contract 部署清单 —— 结构与溯源', () => {
  it('带 schema_version / region / stackName / 生成标记(可溯源)', () => {
    expect(M.schema_version).toBe(MANIFEST_SCHEMA_VERSION);
    expect(M.region).toBe('cn-north-1');
    expect(M.stack_name).toBe('Voce');
    expect(M.generated_by).toMatch(/cdk-synth/);
  });

  it('每项都有非空 consumer(入选证据),且不得自指「清单注入」', () => {
    for (const e of M.entries) {
      expect(e.consumer.trim().length).toBeGreaterThan(0);
      // 自指检测:consumer 不能是「因为要展示才注入」
      expect(e.consumer).not.toMatch(/AIM_DEPLOYMENT_MANIFEST/);
      expect(e.consumer).not.toMatch(/deployment-manifest\.ts/);
    }
  });

  it('每项都有中文名 / 分组(前端可直接渲染)', () => {
    for (const e of M.entries) {
      expect(e.name_zh.trim().length).toBeGreaterThan(0);
      expect(e.group.trim().length).toBeGreaterThan(0);
    }
  });

  it('key 无重复', () => {
    const keys = M.entries.map((e) => e.key);
    expect(keys.length).toBe(new Set(keys).size);
  });
});

describe('design contract 部署清单 —— 值与 constants.ts 一致(机械生成非手抄)', () => {
  /**
   * 逐项断言清单值 === `constants.ts` 导出值。
   *
   * ⚠ 右值一律引用 `constants.*`,**不写字面量** —— 若写字面量,本测试就退化成
   * 「清单手抄 vs 测试手抄」的自我印证(媒体面 805 绿 + 23 项错的成因)。
   */
  const EXPECT: Record<string, string | number | boolean> = {
    BACKEND_PORT: constants.BACKEND_PORT,
    RT_SESSION_PORT: constants.RT_SESSION_PORT,
    GPU_INFERENCE_PORT: constants.GPU_INFERENCE_PORT,
    GPU_HARD_MAX: constants.GPU_HARD_MAX,
    GPU_SESSIONS_PER_INSTANCE: constants.GPU_SESSIONS_PER_INSTANCE,
    GPU_TARGET_UTIL: constants.GPU_TARGET_UTIL,
    GPU_MAX_DRAIN_MIN: constants.GPU_MAX_DRAIN_MIN,
    GPU_INSTANCE_TYPE: constants.GPU_INSTANCE_TYPE,
    DEFAULT_MAX_CONCURRENCY: constants.DEFAULT_MAX_CONCURRENCY,
    BACKEND_MIN_TASKS: constants.BACKEND_MIN_TASKS,
    BACKEND_MAX_TASKS: constants.BACKEND_MAX_TASKS,
    WAF_RATE_LIMIT_PER_5MIN: constants.WAF_RATE_LIMIT_PER_5MIN,
    MCP_REFRESH_TOKEN_VALIDITY_DAYS: constants.MCP_REFRESH_TOKEN_VALIDITY_DAYS,
    VAD_ENERGY_THRESHOLD: constants.resolveVadEnergyThreshold(),
    ENDPOINT_RMS_THRESHOLD: constants.ENDPOINT_RMS_THRESHOLD,
    VAD_HANGOVER_MS: constants.VAD_HANGOVER_MS,
    ENDPOINT_SILENCE_GAP_MS: constants.ENDPOINT_SILENCE_GAP_MS,
  };

  it('期望表覆盖清单全部项(漏一个即红,防新增项无守门)', () => {
    expect(M.entries.map((e) => e.key).sort()).toEqual(Object.keys(EXPECT).sort());
  });

  for (const [key, expected] of Object.entries(EXPECT)) {
    it(`${key} 值与 constants.ts 一致`, () => {
      const entry = M.entries.find((e) => e.key === key);
      expect(entry).toBeDefined();
      expect(entry!.value).toBe(expected);
    });
  }
});

describe('design contract 部署清单 —— 安全:只含非密项', () => {
  const serialized = serializeDeploymentManifest(M);

  it('key 名不含任何凭据类后缀', () => {
    const deny = /(_SECRET|_TOKEN|_API_KEY|_KEY|_PASSWORD|_CREDENTIALS?|_SIGNING)$/i;
    const bad = M.entries.filter((e) => deny.test(e.key));
    expect(bad.map((e) => e.key)).toEqual([]);
  });

  it('序列化文本不含 Secret ARN / 常见凭据前缀 / user:pass@host', () => {
    expect(serialized).not.toMatch(/arn:aws[a-z-]*:secretsmanager:/i);
    expect(serialized).not.toMatch(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/);
    expect(serialized).not.toMatch(/\bAKIA[0-9A-Z]{12,}/);
    expect(serialized).not.toMatch(/\bghp_[A-Za-z0-9]{20,}/);
    expect(serialized).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/);
  });

  it('值只允许 string/number/boolean(不塞对象/函数,防夹带)', () => {
    for (const e of M.entries) {
      expect(['string', 'number', 'boolean']).toContain(typeof e.value);
    }
  });
});

describe('design contract 部署清单 —— 未被 IaC 消费的源码默认 MUST NOT 入清单', () => {
  /**
   * spec 明确要求:未被 IaC 消费的常量不得出现在本页(否则会把源码默认冒充部署值)。
   * 实测这几项在 `infrastructure/lib` 里**零消费**。
   */
  it.each(['AUDIT_TTL_DAYS', 'DEFAULT_HANGUP_REMINDER_MIN', 'DEFAULT_FORCE_HANGUP'])(
    '%s 不在清单里(零 IaC 消费)',
    (key) => {
      expect(M.entries.find((e) => e.key === key)).toBeUndefined();
    },
  );
});

describe('design contract 部署清单 —— synth 确定性', () => {
  it('同输入两次生成完全相同(无时间戳/随机;否则每次 synth 都产生无意义 diff)', () => {
    const a = serializeDeploymentManifest(
      buildDeploymentManifest({ region: 'us-east-1', stackName: 'Voce' }),
    );
    const b = serializeDeploymentManifest(
      buildDeploymentManifest({ region: 'us-east-1', stackName: 'Voce' }),
    );
    expect(a).toBe(b);
  });

  it('两分区各自生成且 region 如实反映', () => {
    for (const region of ['us-east-1', 'cn-north-1']) {
      const m = buildDeploymentManifest({ region, stackName: 'Voce' });
      expect(m.region).toBe(region);
      expect(m.entries.length).toBeGreaterThan(0);
    }
  });

  it('体积远小于 Fargate task definition 上限(64KB)', () => {
    expect(serialized_len()).toBeLessThan(16 * 1024);
  });
});

function serialized_len(): number {
  return Buffer.byteLength(serializeDeploymentManifest(M), 'utf8');
}
