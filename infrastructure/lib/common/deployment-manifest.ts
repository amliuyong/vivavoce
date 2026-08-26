/**
 * 部署清单(deployment manifest)生成 —— design contract。
 *
 * ## 为什么要它
 *
 * `constants.ts` 的编译期常量**运行时进程读不到**(它们被烘进 CloudFormation 模板,不是 env)。
 * 若让 backend 用 Python 手抄这些数值,就又造出「第二份可写副本」—— 而那正是本 spec 立项的根因
 * (媒体面实测手抄默认值 46% 出错,最严重差 75 倍)。故由 CDK synth 时**机械生成**本清单、
 * 经 env 注入 backend,backend 只读不抄。
 *
 * ## 入选标准(MUST 消除自指)
 *
 * 某常量入选的条件是:**在本清单之外**,被生产 IaC 独立用于资源属性 / env 注入 / 守门计算。
 * **清单注入本身 MUST NOT 算作消费证据** —— 否则「为展示而注入」即自证合格,标准形同虚设
 * (评审/review 一致)。故每项都记 `consumer` 字段说明它**在别处**被谁用。
 *
 * 实测筛查结果(`grep` 计数,排除 constants.ts 自身):
 * ```
 * 10  GPU_HARD_MAX          9  GPU_INFERENCE_PORT   9  BACKEND_PORT
 *  7  RT_SESSION_PORT       2  WAF_RATE_LIMIT_*     2  MCP_REFRESH_TOKEN_VALIDITY_DAYS
 *  2  GPU_MAX_DRAIN_MIN     2  DEFAULT_MAX_CONCURRENCY
 *  0  VAD_ENERGY_THRESHOLD  0  ENDPOINT_RMS_THRESHOLD   ← 经函数间接消费,见下
 *  0  AUDIT_TTL_DAYS        0  DEFAULT_HANGUP_REMINDER_MIN / DEFAULT_FORCE_HANGUP  ← **不入清单**
 * ```
 * `AUDIT_TTL_DAYS` / `DEFAULT_HANGUP_REMINDER_MIN` / `DEFAULT_FORCE_HANGUP` 零消费 —— 它们是
 * **未被 IaC 消费的源码默认**,spec 明确要求 MUST NOT 出现在本页(否则会把源码默认冒充部署值)。
 *
 * ## vivavoce 特有(勿照抄 AIM 项目集)
 *
 * 电话链路整条已删 → **无** Chime CIDR / RTP 端口段 / 外呼 SIP 端口;
 * CloudFront 已下线 → 限速项归 **REGIONAL WAF 挂公网 ALB**。
 *
 * ## 安全
 *
 * 清单**只含非密项**。任何 Secret / 密钥 / token MUST NOT 进入(CDK UT 断言)。
 */
import {
  BACKEND_MAX_TASKS,
  BACKEND_MIN_TASKS,
  BACKEND_PORT,
  DEFAULT_MAX_CONCURRENCY,
  GPU_HARD_MAX,
  GPU_INFERENCE_PORT,
  GPU_INSTANCE_TYPE,
  GPU_MAX_DRAIN_MIN,
  GPU_SESSIONS_PER_INSTANCE,
  GPU_TARGET_UTIL,
  MCP_REFRESH_TOKEN_VALIDITY_DAYS,
  RT_SESSION_PORT,
  WAF_RATE_LIMIT_PER_5MIN,
  resolveVadEnergyThreshold,
  ENDPOINT_RMS_THRESHOLD,
  ENDPOINT_SILENCE_GAP_MS,
  VAD_HANGOVER_MS,
} from './constants';

/** 清单单项。`consumer` 是**入选证据**:该常量在清单之外被谁消费。 */
export interface ManifestEntry {
  key: string;
  value: string | number | boolean;
  /** 中文名(前端直接展示;控制面 SETTINGS_META 亦可覆盖)。 */
  name_zh: string;
  /** 分组。 */
  group: string;
  /** 单位。 */
  unit: string;
  /**
   * **独立** consumer(清单之外的真实消费点)。MUST 非空 —— 空即说明该项不该入清单。
   */
  consumer: string;
}

export interface DeploymentManifest {
  schema_version: number;
  region: string;
  stack_name: string;
  /** 生成标记:标明这是 synth 期产物,改需重新部署。 */
  generated_by: string;
  entries: ManifestEntry[];
}

export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * 生成清单。
 *
 * ⚠ **不含时间戳**:CDK synth 产物须**确定性**(同输入同输出),否则每次 synth 都产生 diff、
 * 触发无意义的 Fargate 滚动替换。生成信息只标"由谁生成",不标"何时"。
 */
export function buildDeploymentManifest(opts: {
  region: string;
  stackName: string;
}): DeploymentManifest {
  const entries: ManifestEntry[] = [
    // ── 端口(资源属性:容器端口 / TargetGroup / SG 规则)──
    {
      key: 'BACKEND_PORT', value: BACKEND_PORT, unit: '', group: '部署 · 端口',
      name_zh: '控制面 API 端口',
      consumer: 'ecs-backend.ts:容器 portMappings + TargetGroup + SG 入站',
    },
    {
      key: 'RT_SESSION_PORT', value: RT_SESSION_PORT, unit: '', group: '部署 · 端口',
      name_zh: '实时会话服务端口',
      consumer: 'realtime-session.ts:容器端口 + ALB TargetGroup + SG 入站',
    },
    {
      key: 'GPU_INFERENCE_PORT', value: GPU_INFERENCE_PORT, unit: '', group: '部署 · 端口',
      name_zh: 'GPU 推理端口',
      consumer: 'gpu-inference.ts:容器端口 + SG;capacity-reconciler Lambda env',
    },
    // ── 容量护栏(守门计算 / Lambda env)──
    {
      key: 'GPU_HARD_MAX', value: GPU_HARD_MAX, unit: '台', group: '部署 · 容量护栏',
      name_zh: 'GPU 实例硬上限',
      consumer: 'gpu-inference.ts:ASG maxCapacity;capacity-reconciler 校验 admin 配置上限',
    },
    {
      key: 'GPU_SESSIONS_PER_INSTANCE', value: GPU_SESSIONS_PER_INSTANCE, unit: '路',
      group: '部署 · 容量护栏', name_zh: '单实例可服务并发',
      consumer: 'gpu-inference.ts:GPU 容器 AIM_GPU_MAX_SESSIONS env;闸门容量换算',
    },
    {
      key: 'GPU_TARGET_UTIL', value: GPU_TARGET_UTIL, unit: '', group: '部署 · 容量护栏',
      name_zh: 'auto 模式目标利用率',
      consumer: 'capacity-reconciler:desired 实例数换算',
    },
    {
      key: 'GPU_MAX_DRAIN_MIN', value: GPU_MAX_DRAIN_MIN, unit: '分钟',
      group: '部署 · 容量护栏', name_zh: '缩容排空上限',
      consumer: 'gpu-inference.ts:GPU 容器 AIM_GPU_MAX_DRAIN_MIN env(= task protection 上限)',
    },
    {
      key: 'GPU_INSTANCE_TYPE', value: GPU_INSTANCE_TYPE, unit: '', group: '部署 · 容量护栏',
      name_zh: 'GPU 机型',
      consumer: 'gpu-inference.ts:ASG launch template instanceType',
    },
    {
      key: 'DEFAULT_MAX_CONCURRENCY', value: DEFAULT_MAX_CONCURRENCY, unit: '路',
      group: '部署 · 容量护栏', name_zh: '默认全局会话闸门',
      // 实测消费点(勿凭印象写):env 名是 MAX_CONCURRENCY(**无** AIM_ 前缀)
      consumer: 'session-scheduler.ts:87 MAX_CONCURRENCY env 的 fallback 默认'
        + '(线上实际值由 aim-stack.ts:289 按 GPU 容量换算,admin 可经容量页覆盖)',
    },
    {
      key: 'BACKEND_MIN_TASKS', value: BACKEND_MIN_TASKS, unit: '个',
      group: '部署 · 容量护栏', name_zh: '控制面最小任务数',
      consumer: 'ecs-backend.ts:Fargate service desiredCount / 自动伸缩下限',
    },
    {
      key: 'BACKEND_MAX_TASKS', value: BACKEND_MAX_TASKS, unit: '个',
      group: '部署 · 容量护栏', name_zh: '控制面最大任务数',
      consumer: 'ecs-backend.ts:自动伸缩上限',
    },
    // ── 安全 / 边界(WAF 挂公网 ALB;去 CloudFront 后无 CDN 限速)──
    {
      key: 'WAF_RATE_LIMIT_PER_5MIN', value: WAF_RATE_LIMIT_PER_5MIN, unit: '次/5分钟',
      group: '部署 · 安全', name_zh: 'WAF 限速阈值',
      consumer: 'public-entry.ts:REGIONAL WAF RateBasedStatement(两分区都建)',
    },
    {
      key: 'MCP_REFRESH_TOKEN_VALIDITY_DAYS', value: MCP_REFRESH_TOKEN_VALIDITY_DAYS,
      unit: '天', group: '部署 · 安全', name_zh: 'MCP refresh token 有效期',
      consumer: 'cognito.ts:UserPoolClient refreshTokenValidity',
    },
    // ── 跨面阈值不变式(经函数间接消费:synth 期守门 + GPU env 注入)──
    {
      key: 'VAD_ENERGY_THRESHOLD', value: resolveVadEnergyThreshold(), unit: 'RMS',
      group: '部署 · 阈值不变式', name_zh: 'GPU VAD 能量阈值(部署期固化)',
      consumer: 'gpu-inference.ts:GPU 容器 AIM_VAD_ENERGY_THRESHOLD env;'
        + 'assertEndpointAboveVad() synth 期守门',
    },
    {
      key: 'ENDPOINT_RMS_THRESHOLD', value: ENDPOINT_RMS_THRESHOLD, unit: 'RMS',
      group: '部署 · 阈值不变式', name_zh: '媒体面端点阈值(部署期默认)',
      consumer: 'aim-stack.ts:assertEndpointAboveVad() synth 期守门(endpoint ≥ vad 不变式)',
    },
    {
      key: 'VAD_HANGOVER_MS', value: VAD_HANGOVER_MS, unit: 'ms',
      group: '部署 · 阈值不变式', name_zh: 'GPU VAD 尾静音(部署期固化)',
      consumer: 'assertSilenceGapAboveHangover() synth 期守门',
    },
    {
      key: 'ENDPOINT_SILENCE_GAP_MS', value: ENDPOINT_SILENCE_GAP_MS, unit: 'ms',
      group: '部署 · 阈值不变式', name_zh: '媒体面静音间隔(部署期默认)',
      consumer: 'assertSilenceGapAboveHangover() synth 期守门(gap ≥ hangover 不变式)',
    },
  ];

  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    region: opts.region,
    stack_name: opts.stackName,
    generated_by: 'cdk-synth(infrastructure/lib/common/deployment-manifest.ts)',
    entries,
  };
}

/**
 * 序列化为可注入 env 的紧凑 JSON。
 *
 * Fargate env 值有大小限制(整个 task definition ≤ 64KB),故不留缩进。当前 ~17 项远未触顶。
 */
export function serializeDeploymentManifest(m: DeploymentManifest): string {
  return JSON.stringify(m);
}
