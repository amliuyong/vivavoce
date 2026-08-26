/**
 * 全局可调参数 —— 与 HLD §6.3「可配置属性与默认值」单一来源对齐。
 * 改这里 = 改默认值;Campaign 级覆盖走运行时配置(DynamoDB),不在 IaC。
 */

// ── 控制面 ECS Fargate(Orchestrator API,FastAPI) ──
export const BACKEND_CPU = 1024; // 1 vCPU
export const BACKEND_MEMORY = 2048; // 2 GB
export const BACKEND_MIN_TASKS = 1;
export const BACKEND_MAX_TASKS = 4;
export const BACKEND_PORT = 8000;

// ── 实时会话服务 ECS Fargate(bridge,M1:客户端 WS ↔ VoiceEngine 编排) ──
// ★ M1 min=max=1:session-context(预创建暂存)与活动会话表在进程内存,多任务需 sticky/外置
//   (MIGRATION-PLAN 风险 #6,放量前解决)。CPU/内存:纯编排+重采样,无模型推理,1 vCPU 起步。
export const RT_SESSION_CPU = 1024;
export const RT_SESSION_MEMORY = 2048;
export const RT_SESSION_MIN_TASKS = 1;
export const RT_SESSION_PORT = 3001; // 与 bridge BRIDGE_HEALTH_PORT 默认一致(/health /ws /sessions)

// ── 容器 CPU 架构(env AIM_CONTAINER_ARCH:arm64 默认 | amd64)──
// backend/rt/lambda 镜像的构建+运行架构。默认 arm64(Graviton,本机 ARM 原生构建、省成本);
// Set amd64 on an x86 builder to avoid qemu cross-architecture emulation.
// Fargate task runtimePlatform 与 Lambda architecture 都随它,构建与运行架构一致。
export type ContainerArch = 'arm64' | 'amd64';
export const CONTAINER_ARCH: ContainerArch =
  (process.env.AIM_CONTAINER_ARCH?.trim() === 'amd64') ? 'amd64' : 'arm64';

// ── GPU 推理服务(自建 **ASR+TTS**,ECS on EC2 G6E GPU,默认引擎的语音段) ──
// LLM 不在此:三段式的 LLM 走 Bedrock(默认 Haiku),由媒体面 Bridge 调(design contract)。
// G6E = NVIDIA L40S GPU 实例。g6e.xlarge 起步(1×L40S 48GB,只需常驻轻量 ASR+TTS,显存宽松);
// 因不含 LLM,可评估降档省成本;视模型可升档。MVP 容量小起步,全局闸门须与之匹配(design contract)。
// GPU 实例类型:默认 g6e.xlarge(L40S 48GB,美东已验);部署期 env AIM_GPU_INSTANCE_TYPE 可覆盖
// ——中国区无 g6e,候选 g4dn.2xlarge(T4 16GB;OmniVoice/FunASR 显存与 RTF 需真机实测,VISION §5.3)。
export const GPU_INSTANCE_TYPE = process.env.AIM_GPU_INSTANCE_TYPE?.trim() || 'g6e.xlarge';
export const GPU_MIN = 1;
// 全局会话闸门的**默认因子**(× GPU_SESSIONS_PER_INSTANCE = 未配容量时的 fallback 并发,见 session-scheduler)。
// 注:**不是** ASG min/max —— ASG 是 min=0 / max=GPU_HARD_MAX(design contract 运行时 autoscaling),见 gpu-inference.ts。
export const GPU_MAX_MVP = 1;
export const GPU_INFERENCE_PORT = 8080; // 服务统一 WS 接入端点(Bridge 单 WS 串 ASR/TTS;LLM 不经此)
// 单 GPU 实例可稳定承载的并发会话数(仅 ASR+TTS,LLM 走 Bedrock 不占 GPU)。
// ★ design contract 容量基准 **实测回填**(deployment validation,g6e.xlarge / L40S 46GB,真 FunASR + 真 OmniVoice):
//   - 显存:模型常驻 8.5GB(进程级含 CUDA ctx);每路增量仅 ~159MB → 显存上界 ~236 路(**非瓶颈**)。
//   - 算力(真实瓶颈):单路 TTS RTF N=1:0.16 / N=2:0.19 / N=4:0.65 / N=8:1.72。RTF≥1 即 TTS 跟不上
//     实时播放(AI 卡顿/断续)。**但 TTS 不是全部**:ASR(FunASR,RTF~0.3)与 TTS 共享算力,barge-in 时
//     ASR+TTS 短暂并发 → 单路总 RTF≈0.65+0.3=0.95 逼近临界(review)。故从纯 TTS 的 4 再降一档,
//     取 **3**(ASR+TTS 并发峰值留 ~20% buffer)。放量:换更强 GPU / 多实例线性扩(闸门 = 实例数 × 本值)。
// env 可覆盖(AIM_GPU_SESSIONS_PER_INSTANCE):3 是 **g6e.xlarge 标定值**;换弱卡(中国区
// g4dn.2xlarge/T4)须保守设(建议 ≤2,真机 RTF/显存实测后调)——否则超派 RTF>1 卡顿。
export const GPU_SESSIONS_PER_INSTANCE = (() => {
  const raw = process.env.AIM_GPU_SESSIONS_PER_INSTANCE?.trim();
  if (!raw) return 3;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`AIM_GPU_SESSIONS_PER_INSTANCE="${raw}" 非法(须为 ≥1 整数)`);
  }
  return v;
})();

// ── GPU 容量管理与自动伸缩(design contract)──
// admin 运行时配置容量(fixed N / auto / 0 停机),capacity-reconciler Lambda 据期望对账收敛。
// 这些是默认值/护栏;运行时配置存 DynamoDB SystemConfig(非 IaC),见 design contract。
export const GPU_HARD_MAX = 8; // auto_max 的系统硬上限(成本护栏:admin 配的 auto_max ≤ 此值)
export const GPU_TARGET_UTIL = 0.7; // auto 目标利用率(留 buffer 不打满;desired=ceil(需求/(G×util)))
export const GPU_SCALE_IN_COOLDOWN_MIN = 5; // 缩容冷却:需求持续低于阈值达此分钟数才缩(防抖)
export const GPU_PREWARM_WINDOW_MIN = 10; // 预扩窗口:提前拉起未来此分钟内 meeting_start 的会话所需实例。
// ⚠ 真实冷启动(EC2+拉镜像+模型上显存+/readyz 300s)≫ 名义值,MUST 镜像加速 + 按实测 p95 标定(design contract / Task 4.0)
export const GPU_MAX_SCALE_OUT_STEP = 3; // 单轮 reactive 扩容增量上限(只限当前在途 A 突增;预扩 P+积压 Q 不限速)
export const GPU_CAPACITY_FRESHNESS_MIN = 5; // 闸门容量实况新鲜窗:超此分钟数 reconciler 未更新视作过期(=5× 周期)
export const GPU_MAX_DRAIN_MIN = 60; // 缩容/停机 drain 上限 = task protection expiresInMinutes;超此的超长会议可能被中断

// ── turn_end 端点阈值(GPU VAD + 实时会话服务端点看门狗,同为 int16 RMS 量纲,design contract)──
// Deployment defaults are centralized here. Runtime modules keep guarded
// copies only where cross-language imports are not possible. GPU 默认写在 vad.py(500)、
// Bridge 默认写在 media-session.ts(350),两套散在运行时代码、不可 CFN diff(review)。
// ★ 不变式:**Bridge 端点阈值 MUST ≥ GPU VAD 阈值**。否则 350-500 错配区:bridge 误判「在说话」flush 但
//   GPU 无 ASR 内容 → 空 turn_end;且若低于会议底噪则两层都被顶住、永不出 turn_end(AI 不回话,真机根因)。
//   gpu-inference / outbound-voice 都从这里取默认 + 部署期 env 覆盖;assertEndpointAboveVad() 在 synth 时守门。
export const VAD_ENERGY_THRESHOLD = 500; // GPU VAD energy(RMS over int16),= vad.py _DEF_ENERGY
export const ENDPOINT_RMS_THRESHOLD = 500; // Bridge 端点看门狗 RMS(默认对齐 GPU,守不变式 ≥)
// design contract:端点静音容忍时长默认(ms)。GPU VAD hangover(尾静音判轮)= vad.py _DEF_HANGOVER;
//   Bridge 看门狗 silenceGap = turn-handling DEFAULTS.endpointing.silenceGapMs。不变式 silenceGap ≥ hangover
//   (看门狗 MUST NOT 抢在 GPU VAD 自然端点前 flush)。口试抗抢话调长时两处 MUST 同向(见 assertSilenceGapAboveHangover)。
// ★ design contract:**1400**(deployment validation 由 800 改)—— 与 `gpu/gpu_service/vad.py::VAD_DEFAULTS["hangover_ms"]`
//   同值。原先 1400 只活在 legacy deployment script 的 export 里、代码默认是 800,换部署路径就静默退回 800
//   (不变式仍成立故守门不报警,但 VAD 判轮从 1.4s 缩到 0.8s = 更容易抢话)。现值只有代码一份。
//   ⚠ 这是 GPU 侧默认值的**第二份副本**(CDK 不能 import Python),MUST 与 vad.py 同向;
//   守门测试 `vad-threshold.test.ts` 读 vad.py 源文件比对,漂移即在 CI 红。
export const VAD_HANGOVER_MS = 1400;
// ★ design contract B 类:**1500**(deployment validation 由 900 改)。
//
//   ⚠⚠ 这是 bridge `turn-handling.ts::TURN_HANDLING_DEFAULTS.endpointing.silenceGapMs` 的**第二份副本**
//   —— 正是本 spec 要消灭的东西,但它无法简单消除:CDK 是 TS 独立子系统,**不能** import bridge 源码
//   (跨子系统依赖 + 构建期不可用)。故两份必须**同向手工维护**。
//
//   实证代价(deployment validation 部署即撞):design contract 只改了 bridge 默认到 1500 而漏了此处,`cdk synth` 直接
//   fail-fast 报「silenceGap(900) < hangover(1400)」—— 部署起不来。**这次是好事**:守门响亮地炸,
//   而不是静默让看门狗抢跑。但它证明「第二份副本」的成本是真的。
//
//   MUST:改 bridge 侧 `endpointing.silenceGapMs` 默认时**同步改这里**。
//   守门:`assertSilenceGapAboveHangover()`(synth 期)+ bridge `loadTurnHandling()`(运行时)。
export const ENDPOINT_SILENCE_GAP_MS = 1500;

/** 解析阈值 env:**空串/纯空白视作未设**(回退默认),否则须为有限正数。
 *  ★ 不能直接 `Number(env ?? default)`:env 设为空串时 `??` 不回退(空串非 null),且 `Number("")===0`
 *    过 `Number.isFinite` → 阈值 0(everything=speech、永不出 turn_end),正是守门本应防的 bug。 */
function _parseThresholdEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback; // 未设 / 空串 → 默认
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`${name}="${raw}" 非法(须为正数);留空用默认 ${fallback}。`);
  }
  return v;
}

/** GPU VAD energy 阈值(解析部署期 env,空串/未设→默认,非法/≤0 fail-fast)。gpu-inference 下发 GPU 用。
 *  与 assertEndpointAboveVad 共用同一解析,避免 `String(env ?? default)` 把空串原样发给 GPU → vad.py float("") 崩。 */
export function resolveVadEnergyThreshold(): number {
  return _parseThresholdEnv('AIM_VAD_ENERGY_THRESHOLD', VAD_ENERGY_THRESHOLD);
}

/** synth-time 守门:校验 endpoint(Bridge)≥ vad(GPU),违反即 fail-fast(防误配重现「空 turn_end / 不回话」)。
 *  取部署期 env 覆盖值(空串/未设回退默认,非法/≤0 fail-fast);两值都是 int16 RMS,可直接比较。 */
export function assertEndpointAboveVad(): { vad: number; endpoint: number } {
  const vad = resolveVadEnergyThreshold();
  const endpoint = _parseThresholdEnv('AIM_ENDPOINT_RMS_THRESHOLD', ENDPOINT_RMS_THRESHOLD);
  if (endpoint < vad) {
    throw new Error(
      `Bridge 端点阈值(${endpoint})< GPU VAD 阈值(${vad}),违反不变式 endpoint ≥ vad。` +
        `350-500 错配区会致空 turn_end / AI 不回话(真机根因)。调高 AIM_ENDPOINT_RMS_THRESHOLD ` +
        `或调低 AIM_VAD_ENERGY_THRESHOLD,使 endpoint ≥ vad。`,
    );
  }
  return { vad, endpoint };
}

/** design contract synth-time 守门:校验端点静音容忍 silenceGap(Bridge)≥ hangover(GPU VAD),违反即 fail-fast。
 *  口试抗抢话调长静音容忍时,若只调 GPU `AIM_VAD_HANGOVER_MS` 忘了 bridge `AIM_ENDPOINT_SILENCE_GAP_MS`,
 *  看门狗会抢在 GPU VAD 自然端点前 flush(silenceGap<hangover)→ 调长失效。两值都是 ms,可直接比较。
 *  空串/未设回退默认(800/900),非法/≤0 fail-fast(复用 _parseThresholdEnv)。 */
export function assertSilenceGapAboveHangover(): { hangover: number; silenceGap: number } {
  const hangover = _parseThresholdEnv('AIM_VAD_HANGOVER_MS', VAD_HANGOVER_MS);
  const silenceGap = _parseThresholdEnv('AIM_ENDPOINT_SILENCE_GAP_MS', ENDPOINT_SILENCE_GAP_MS);
  if (silenceGap < hangover) {
    throw new Error(
      `Bridge 端点静音容忍 silenceGap(${silenceGap}ms)< GPU VAD hangover(${hangover}ms),违反不变式 ` +
        `silenceGap ≥ hangover。看门狗会抢在 GPU VAD 自然端点前 flush → 调长静音容忍失效。` +
        `调长口试抗抢话时两处 MUST 同向:同时设 AIM_VAD_HANGOVER_MS 与 AIM_ENDPOINT_SILENCE_GAP_MS。`,
    );
  }
  return { hangover, silenceGap };
}

// ── 时间策略默认值(对齐 HLD §6.3) ──
export const DEFAULT_HANGUP_REMINDER_MIN = 5; // 结束前 N 分钟口头提醒;0=关闭(考试临结束提醒)
export const DEFAULT_FORCE_HANGUP = true; // meeting_end 到强制收尾
// 全局 admission 闸门:同时进行的最大 Session 数(design contract)。
// MUST ≤ min(GPU 可服务并发, Bedrock LLM 配额)。MVP:GPU_MAX_MVP(1) × GPU_SESSIONS_PER_INSTANCE(3) = 3
//(实测算力上界含 ASR+TTS 并发,见上;原 8 会让 RTF>1 跟不上实时)。默认 3(不超派);放量随 GPU 实例数 + Bedrock 提额同步调高。
export const DEFAULT_MAX_CONCURRENCY = 3;

// ── DynamoDB ──
export const AUDIT_TTL_DAYS = 365;

// ── CloudFront / WAF ──
export const WAF_RATE_LIMIT_PER_5MIN = 2000;

// ── MCP OAuth 登录(design contract)──
// Cognito 不支持 DCR / 通配回调,故 MCP client 用**预置 public client + 固定 loopback 回调**。
// 回调 URL 必须与 `mcp-remote` 侧一字不差(见 design contract/P4)。Cognito 历史上只豁免字面 `localhost`
// 的 http(曾拒 `127.0.0.1`),故默认走 `localhost`;`mcp-remote` 命令须指定同一端口。
// ⚠ P1/P4 真机实测后如 mcp-remote 用不同端口/host,改这里(前缀不可变,但回调可增补)。
export const MCP_OAUTH_CALLBACK_PORT = 3334; // `npx mcp-remote <url> 3334` 的固定回调端口
export const MCP_OAUTH_CALLBACK_PATH = '/oauth/callback'; // mcp-remote 本地回调 path
export const MCP_OAUTH_CALLBACK_URL = `http://localhost:${MCP_OAUTH_CALLBACK_PORT}${MCP_OAUTH_CALLBACK_PATH}`;
// refresh token rotation grace(秒,0–60):rotated 旧 refresh 在此窗口内仍可用,缓解 mcp-remote
// 并发刷新竞态(design contract)。若实测 rotation 破坏 mcp-remote 静默刷新 → 去掉此 prop 降级为普通 refresh。
export const MCP_REFRESH_ROTATION_GRACE_SEC = 30;
export const MCP_REFRESH_TOKEN_VALIDITY_DAYS = 90; // refresh 有效期(据安全策略可调)
