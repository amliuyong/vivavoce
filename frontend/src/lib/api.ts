// API 客户端:统一带 Authorization: Bearer <access token>,所有 /api/* 经 CloudFront 回源私有 ALB。
// 字段全 snake_case(与后端 openapi.json 对齐)。401 抛 ApiError,由上层触发重新登录。
import { getConfig } from './config';
import type { LlmCredentialStatusView } from './llm-credential-expiry';

export class ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`API ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

let _tokenGetter: () => string | null = () => null;
/** 注入「取当前 access token」的回调(由 app 状态提供)。 */
export function setTokenGetter(fn: () => string | null): void {
  _tokenGetter = fn;
}

let _onUnauthorized: () => void = () => {};
/** 注入 401 处理回调(由 appState 提供:清会话 → 跳登录页)。 */
export function setUnauthorizedHandler(fn: () => void): void {
  _onUnauthorized = fn;
}

// 静默续期回调(design contract):access token(默认 1h)过期 → REST 遇 401 先用 refresh token 换新 token,
// 成功返回新 token(供重放),失败返回 null(→ 登出)。由 appState 注入(内部走 currentSession 单飞续期,
// 见 appState.freshAccessToken)。未注入(如骨架/测试)→ 恒 null,401 直接走 _onUnauthorized(现状行为)。
let _tokenRefresher: () => Promise<string | null> = async () => null;
export function setTokenRefresher(fn: () => Promise<string | null>): void {
  _tokenRefresher = fn;
}

type Json = Record<string, unknown>;

interface RequestOpts {
  method?: string;
  body?: unknown;
  /** 原始文本 body(CSV 上传)+ content-type */
  rawBody?: string;
  contentType?: string;
  /** 期望非 JSON 文本响应(CSV 导出) */
  expectText?: boolean;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  // retryAuth=true(首次尝试):401 时先静默续期 + 重放一次;重放(retryAuth=false)仍 401 → 登出。
  // 这构成**一次性 guard**(design contract),杜绝「401→refresh→replay→401→refresh…」无限递归。
  return requestOnce<T>(path, opts, true);
}

async function requestOnce<T>(path: string, opts: RequestOpts, retryAuth: boolean): Promise<T> {
  const cfg = getConfig();
  const headers: Record<string, string> = {};
  const token = _tokenGetter();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers['Content-Type'] = opts.contentType || 'text/csv';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${cfg.apiBase}${path}`, {
    method: opts.method || 'GET',
    headers,
    body,
  });

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    // 401 静默续期(design contract):access token 过期 → 用 refresh token 换新 token 重放一次,而非直接登出。
    // 仅首次尝试(retryAuth)走续期;续期成功(拿到新 token)→ 重放一次(retryAuth=false,不再续期);
    // 续期失败(null)或重放仍 401 → 登出跳登录。401 由后端在业务处理**前**返回(鉴权中间件),故重放
    // 同一 body 无双重副作用,无需 Idempotency-Key。
    if (res.status === 401 && retryAuth) {
      const fresh = await _tokenRefresher(); // 内部单飞:并发 401 共享一次续期(见 appState)
      if (fresh) return requestOnce<T>(path, opts, false); // 用新 token 重放一次(_tokenGetter 已被 setSession 更新)
      _onUnauthorized(); // 续期失败(refresh 逾期/被吊销/网络错)→ 登出
      throw new ApiError(401, await extractDetail(res));
    }

    // 重放仍 401(retryAuth=false)或其它错误状态。
    if (res.status === 401) _onUnauthorized(); // 重放后仍 401 → 登出(MUST NOT 再续期,防递归)
    throw new ApiError(res.status, await extractDetail(res));
  }

  if (opts.expectText) return (await res.text()) as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** 从错误响应体提取 detail(JSON detail/message,数组 msg 拼接,回退 statusText/text)。 */
async function extractDetail(res: Response): Promise<string> {
  let detail: unknown = res.statusText;
  try {
    const data = await res.json();
    detail = (data && ((data as Json).detail || (data as Json).message)) || detail;
    if (Array.isArray(detail)) detail = detail.map((d: Json) => d.msg || JSON.stringify(d)).join('; ');
  } catch {
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
  }
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

// ── 类型(部分,够前端用;字段与后端 snake_case 对齐) ──
export interface WhoAmI {
  sub: string;
  username: string;
  groups: string[];
  is_admin: boolean;
  is_staff: boolean;
}

export interface Question {
  text: string;
  reference_answer?: string | null;
  weight?: number;
  // 难度档(design contract):整数 [1,5],缺省 3;仅用于 easy_to_hard 策略排序。
  difficulty?: number;
}

// 出题策略(design contract):Agent 决定怎么从所挂题库出题。
export type QuestionStrategy = 'sequential' | 'random_n' | 'easy_to_hard' | 'random_n_easy_to_hard';
export interface RubricDimension {
  name: string;
  description?: string;
  weight?: number;
  max_score?: number;
}
export interface Rubric {
  mode: 'per_question_check' | 'dimension_score';
  pass_threshold?: number;
  dimensions?: RubricDimension[];
}
export interface EngineParams {
  engine_type?: string;
  language?: string;
  llm_model_id?: string | null;
  // 语义音色 key(male_std/female_std…);three_stage→GPU voice clone 参考音、s2s→Nova voiceId。
  voice?: 'male_std' | 'female_std' | null;
  // TTS provider 段级维度(design contract):仅 three_stage 生效。gpu_omnivoice(默认本地 voice clone)| minimax(云端)。
  tts_provider?: 'gpu_omnivoice' | 'minimax' | null;
  max_duration_s?: number;
  max_turns?: number;
  // 注:移除 temperature(LLM 内部固定 0.4),不开放配置。
}
// Agent(design contract,取代 Profile):人设 + rubric + engine + 出题策略 + self_bookable(不再内嵌题目)。
export interface Agent {
  agent_id: string;
  name: string;
  labels?: string[];
  system_prompt?: string;
  rubric?: Rubric;
  engine?: EngineParams;
  question_strategy?: QuestionStrategy;
  strategy_n?: number | null;
  default_question_bank_id?: string | null;
  self_bookable?: boolean;
  // 实时字幕显示开关(design contract):Agent **顶层**呈现字段(非 engine 嵌套)。null/undefined = 默认开(向后兼容)。
  // 只影响实时对话界面是否渲染字幕;经 ready 帧下发前端。
  show_subtitles?: boolean | null;
  // 头像风格(design contract):Agent 顶层呈现字段。舞台中央视觉主体:minimal(默认)/round/tech(SVG 头像)/
  //   waveform(纯波形无头像=回退 design contract)。null/undefined = 前端兜底 minimal;经 ready 帧下发前端。
  avatar_style?: 'minimal' | 'round' | 'tech' | 'waveform' | null;
  // 声纹锁定说话人(design contract):Agent **顶层**行为字段(非 engine 嵌套)。null/undefined = 默认锁定(向后兼容)。
  //   开启时会话开场自动注册目标声纹、只有本人才能打断 AI;实际是否生效由 bridge effective_speaker_lock 裁定。
  speaker_lock?: boolean | null;
  version?: string;
  status?: string;
}

// QuestionBank(design contract):可复用题库,可被多个 Agent / 会议挂载。
export interface QuestionBank {
  question_bank_id: string;
  name: string;
  labels?: string[];
  questions?: Question[];
  version?: string;
  status?: string;
}

export interface Session {
  session_id: string;
  agent_id: string;
  agent_name?: string | null; // Agent 名字快照(会话历史「场景」列可读展示;老数据无则回退 agent_id)
  agent_version?: string | null;
  question_bank_id?: string | null;
  question_bank_version?: string | null;
  status: string;
  trigger: string;
  origin?: string | null;
  effective_tags?: string[];
  booked_by?: string | null;
  booked_by_email?: string | null; // 发起人 email(仅展示;booked_by 是 Cognito sub UUID,不可读)
  target_id?: string | null;
  target_name?: string | null; // 对象可读名(后端解析 target_id → Target.name/external_id;详情「对象」列)
  created_at?: string | null; // HR 发起/创建时刻(列表排序 + 详情展示)
  meeting_start?: string | null;
  meeting_end?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  end_trigger?: string | null;
  fail_reason?: string | null;
  editable?: boolean | null;
}

// 总览「按场景(Agent)分」聚合(GET /api/sessions/stats)。通过率 = passed/evaluated;
// evaluated=0 → pass_rate=null(前端显「—」)。
export interface AgentStat {
  agent_id: string;
  agent_name?: string | null;
  total: number;       // 会话总数(全状态)
  completed: number;   // 已完成会话数
  evaluated: number;   // 有评测结果的会话数(= 通过率分母)
  passed: number;      // 通过的会话数(= 通过率分子)
  pass_rate?: number | null; // passed/evaluated;无评测 → null
}
export interface SessionStats {
  agents: AgentStat[];
}

// GET /api/sessions/{id}/join 响应(M1-B,对照 openapi SessionJoinOut):实时会话连入凭据。
// 客户端拿 join_token → 连 wss://<host>{ws_path}?session_id=<id> → 首帧 {"type":"auth","token":<join_token>}。
export interface SessionJoinOut {
  join_token: string;
  ws_path?: string; // 默认 /rt/ws
  expires_at: string;
}

export interface QuestionCheck {
  index?: number; // 从 1 起的题号(与 backend QuestionCheck.index / openapi 对齐)
  question: string;
  passed: boolean;
  evidence?: string | null;
  // design contract:逐题报告补考生回答摘录 + 点评(可选;旧结果无此字段)
  user_answer?: string | null;
  comment?: string | null;
  // design contract:逐题 0–满分 评分(默认满分 10;可选,旧结果无 → 前端回退 ✓/✗)。三色档按 score/max_score 归一比例。
  score?: number | null;
  max_score?: number | null;
}
// design contract:逐题分析(dimension_score 模式并列产出;全字段可选,缺项容错)
export interface QuestionAnalysis {
  index?: number;
  question?: string | null;
  user_answer?: string | null;
  comment?: string | null;
  score?: number | null;
  max_score?: number | null;
}
export interface DimensionScore {
  name: string;
  score: number;
  max_score: number;
  comment?: string | null;
}
export interface Excerpt {
  text: string;
  audio_offset_s?: number | null;
}
export interface Result {
  session_id: string;
  agent_id?: string | null;
  agent_version?: string | null;
  rubric_mode?: string | null;
  question_checks?: QuestionCheck[];
  passed?: boolean | null;
  pass_ratio?: number | null;
  dimension_scores?: DimensionScore[];
  overall_score?: number | null;
  question_analyses?: QuestionAnalysis[]; // design contract:逐题分析(dimension 模式)
  summary?: string | null;
  excerpts?: Excerpt[];
  evaluation_error?: string | null; // design contract:打分失败标记(evaluator 跨境 LLM 失败),前端显示「评测失败」

  review_status?: string;
  reviewer?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  review_passed?: boolean | null;
  review_overall_score?: number | null;
  recording_url?: string | null;
}
export interface TranscriptLine {
  ts?: string | null;
  speaker?: string | null; // "user" | "ai"
  text?: string | null;
}
export interface TranscriptOut {
  session_id: string;
  lines: TranscriptLine[];
}

// 题库 CSV 批量上传结果(免逐题手加)。
export interface QuestionBankUploadResult {
  question_bank_id: string;
  mode: string; // append | replace
  total_rows: number;
  imported: number;
  rejected: number;
  total_questions: number;
  errors?: Array<{ line: number; reason: string; raw?: Record<string, unknown> }>;
}

// ── 端点封装 ──
export const api = {
  me: () => request<WhoAmI>('/me'),

  // Agents(design contract,取代 Profiles)
  listAgents: () => request<Agent[]>('/agents'),
  getAgent: (id: string) => request<Agent>(`/agents/${encodeURIComponent(id)}`),
  createAgent: (body: Partial<Agent>) => request<Agent>('/agents', { method: 'POST', body }),
  updateAgent: (id: string, body: Partial<Agent>) =>
    request<Agent>(`/agents/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deleteAgent: (id: string) => request<void>(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  agentVersions: (id: string) =>
    request<{ agent_id: string; current_version: string; versions: Agent[] }>(
      `/agents/${encodeURIComponent(id)}/versions`,
    ),

  // QuestionBanks(design contract,admin-only)
  listQuestionBanks: () => request<QuestionBank[]>('/question-banks'),
  getQuestionBank: (id: string) => request<QuestionBank>(`/question-banks/${encodeURIComponent(id)}`),
  createQuestionBank: (body: Partial<QuestionBank>) =>
    request<QuestionBank>('/question-banks', { method: 'POST', body }),
  updateQuestionBank: (id: string, body: Partial<QuestionBank>) =>
    request<QuestionBank>(`/question-banks/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deleteQuestionBank: (id: string) =>
    request<void>(`/question-banks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 题库 CSV 批量上传(免逐题手加):rawBody=CSV 文本,mode=append|replace。
  uploadQuestionBankCsv: (id: string, csv: string, mode: 'append' | 'replace') =>
    request<QuestionBankUploadResult>(
      `/question-banks/${encodeURIComponent(id)}/upload-csv?mode=${mode}`,
      { method: 'POST', rawBody: csv, contentType: 'text/csv' },
    ),
  questionBankVersions: (id: string) =>
    request<{ question_bank_id: string; current_version: string; versions: QuestionBank[] }>(
      `/question-banks/${encodeURIComponent(id)}/versions`,
    ),

  // Sessions
  listSessions: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<Session[]>(`/sessions${qs}`);
  },
  // 总览按场景(Agent)分聚合 + 通过率(staff 只统计自己)。
  listSessionStats: () => request<SessionStats>('/sessions/stats'),
  getSession: (id: string) => request<Session>(`/sessions/${encodeURIComponent(id)}`),
  createSession: (body: Record<string, unknown>) => request<Session>('/sessions', { method: 'POST', body }),
  updateSession: (id: string, body: Record<string, unknown>) =>
    request<Session>(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteSession: (id: string) => request<void>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  hangupSession: (id: string) => request<Session>(`/sessions/${encodeURIComponent(id)}/hangup`, { method: 'POST' }),
  // M1-B/C 实时会话连入:签发 join token(staff 仅本人会话;409=终态/超窗/未到窗,detail 中文可直展)。
  joinSession: (id: string) => request<SessionJoinOut>(`/sessions/${encodeURIComponent(id)}/join`),

  // Results
  getResult: (sessionId: string) => request<Result>(`/results/${encodeURIComponent(sessionId)}`),
  reviewResult: (sessionId: string, body: Record<string, unknown>) =>
    request<Result>(`/results/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body }),
  getTranscript: (sessionId: string) =>
    request<TranscriptOut>(`/results/${encodeURIComponent(sessionId)}/transcript`),

  // staff 委托 token(下载 MCP 助手 / 查看 MCP 配置)
  createDelegation: (body: Record<string, unknown>) =>
    request<DelegationOut>('/me/delegations', { method: 'POST', body }),

  // ── 017 API Key 管理(admin)──
  listApiClients: () => request<ApiClient[]>('/integration/clients'),
  createApiClient: (body: { name: string; scopes: string[] }) =>
    request<ApiClient>('/integration/clients', { method: 'POST', body }),
  revokeApiClient: (id: string) =>
    request<void>(`/integration/clients/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── 016 候选人对外自助(HR 侧:建时段池 + 签发候选人链接)──
  addEngagementSlot: (body: Record<string, unknown>) =>
    request<EngagementSlot>('/engagements/slots', { method: 'POST', body }),
  listEngagementSlots: (engagementId: string) =>
    request<EngagementSlot[]>(`/engagements/${encodeURIComponent(engagementId)}/slots`),
  issueCandidateLink: (body: {
    candidate_id: string;
    engagement_id: string;
    candidate_name?: string;
    ttl_hours?: number;
  }) => request<CandidateLink>('/engagements/links', { method: 'POST', body }),

  // ── 018 GPU 容量管理(admin)──
  getGpuCapacity: () => request<GpuCapacityState>('/admin/gpu-capacity'),
  setGpuCapacity: (body: Record<string, unknown>) =>
    request<GpuCapacityConfig>('/admin/gpu-capacity', { method: 'PUT', body }),

  // ── 069 运行时诊断配置只读总览(admin;**只读**,无写方法)──
  getSystemSettings: () => request<SystemSettingsState>('/admin/system-settings'),

  // ── 019 MiniMax TTS provider 配置(admin)──
  getTtsConfig: () => request<{ config: MiniMaxConfigView }>('/admin/tts-config'),
  setTtsConfig: (body: Record<string, unknown>) =>
    request<{ config: MiniMaxConfigView; reload: MiniMaxReloadResult }>('/admin/tts-config', {
      method: 'PUT',
      body,
    }),
  // 账号可用音色清单(get_voice);available=false 时前端回退手填 voice_id。
  getTtsVoices: () => request<{ voices: MiniMaxVoice[]; available: boolean; reason?: string }>(
    '/admin/tts-config/voices'),

  // ── 025 三段式 LLM 配置(admin)──
  getLlmConfig: () => request<{ config: LlmConfigView; recommended: LlmModel[] }>('/admin/llm-config'),
  setLlmConfig: (body: Record<string, unknown>) =>
    request<{ config: LlmConfigView }>('/admin/llm-config', { method: 'PUT', body }),
  getLlmCredentialStatus: () => request<LlmCredentialStatusView>('/llm-credential-status'),
};

export interface LlmModel {
  id: string;
  label?: string;
}

// LLM 配置对外脱敏视图(design contract:明文 token 绝不回显,仅 has_key + 末4位)。
export interface LlmConfigView {
  enabled: boolean; // 启用自定义(mantle);关=用默认 Haiku/IAM
  host: string;
  models: LlmModel[];
  default_model: string;
  evaluator_model: string; // 打分(evaluator)模型:复用同 mantle host+token,跨境调美东(BUG-1)
  fallback_models: string[]; // design contract:主备 fallback 备用模型序(主出首 token 前失败/超时依次切);空=关
  transcript_fixer_model: string; // design contract:ASR 字幕修正模型(旁路修字幕/转写错字);空=不修
  call_method: 'mantle' | 'bedrock_converse'; // design contract:调用方式(全局单选);缺省 mantle(向后兼容)
  bedrock_region: string; // design contract:converse 上游 Bedrock region(?region=);默认 us-east-1
  bedrock_api_key_expires_at: string | null; // work item:Bedrock Key 到期时间(UTC ISO 8601)
  has_key: boolean;
  last4: string | null;
  has_bedrock_key: boolean; // design contract:Bedrock API Key(converse 凭据)脱敏态
  bedrock_last4: string | null;
}

export interface MiniMaxVoice {
  voice_id: string;
  voice_name: string;
  category: string; // system | cloning | generation
}

// MiniMax 配置对外脱敏视图(design contract:明文 key 绝不回显,仅 has_key + 末4位)。
export interface MiniMaxConfigView {
  enabled: boolean;
  base_url: string;
  model: string;
  voice_map: Record<string, string>;
  has_key: boolean;
  last4: string | null;
}

// 热加载回执(PUT 后):triggered=是否调了 GPU;ok=GPU self-probe 是否通过(null=下发未确认)。
export interface MiniMaxReloadResult {
  triggered: boolean;
  ok?: boolean | null;
  detail?: string;
  per_voice?: Record<string, string>;
}

export interface GpuCapacityConfig {
  mode: 'fixed' | 'auto';
  fixed_count?: number;
  auto_min?: number;
  auto_max?: number;
  target_util?: number;
  intent_zero?: boolean;
  config_version: number;
  updated_by?: string;
  updated_at?: string;
}

export interface GpuCapacityLive {
  observed_at?: string;
  desired_instances?: number;
  running_instances?: number;
  healthy_instances?: number;
  draining_instances?: number;
  serviceable_concurrency?: number;
  active_sessions_total?: number;
  intent_zero?: boolean;
  last_action?: string;
  reconciler_heartbeat_at?: string;
}

export interface GpuCapacityState {
  config: GpuCapacityConfig | null;
  live: GpuCapacityLive | null;
  hard_max: number;
}

// ── 069 运行时诊断配置只读总览(admin)──

/** 子系统健康状态**固定枚举**(与后端 SubsystemStatus 对齐;新增值须两侧同步)。 */
export type SubsystemStatus =
  | 'ok'
  | 'planned_stopped'      // admin 主动停机(据容量意图判定,**非**由「连不上」推断)
  | 'dns_unresolved'
  | 'connect_timeout'
  | 'unauthorized'         // 401 密钥错配 —— **不是**停机,显示成停机会掩盖事故
  | 'endpoint_disabled'    // 503 子系统侧未配密钥
  | 'incompatible_schema'
  | 'upstream_error'
  | 'not_configured';      // 控制面侧没配通路

export interface SubsystemState {
  status: SubsystemStatus;
  /** 仅表**网络层**是否可达:401/503 时服务活着,故为 true。 */
  transport_reachable: boolean;
  reason?: string;
  http_status?: number;
  instance?: Record<string, string>;
  region?: string;
  stack_name?: string;
}

export interface SettingItem {
  source: 'control' | 'media' | 'gpu' | 'iac_manifest';
  key: string;
  name_zh: string;
  desc_zh: string;
  unit: string;
  group: string;
  /** 实际生效值;敏感项为布尔「已配置」,未登记/被脱敏为 null。 */
  effective_value: string | number | boolean | null;
  default: string | number | boolean | null;
  /** `derived` = 默认值派生自其它配置(非固定字面量)。 */
  default_kind: 'literal' | 'derived';
  derived_from?: { source: string; key: string }[];
  origin: 'builtin' | 'deployment_env' | 'secret' | 'runtime_store' | 'iac_manifest' | 'derived';
  /**
   * design contract:仅当「默认值概念成立(`default_comparable`)**且**已标定
   * (`calibration_status === 'stable'`)」时才为真 —— 它表示**真异常**(已定论的默认值被覆盖)。
   * 事故前是裸比较 `effective !== default`,把线上正确配置渲染成「偏离标准」。
   */
  differs_from_default: boolean;
  /** 「默认值」这个概念对本项是否成立(部署形态 / CDK 派生 / 拓扑地址 / 凭据 / 未登记项为 false)。 */
  default_comparable: boolean;
  /** `pending` = 确实未标定,与默认值不同属**预期**(前端显示「待标定」而非「异于默认」)。 */
  calibration_status: 'stable' | 'pending' | 'n/a';
  /** 三态:`ignored_invalid` = 设了 env 但被解析器丢弃(运维最需看见的错配信号)。 */
  override_state: 'absent' | 'valid' | 'ignored_invalid';
  metadata_missing: boolean;
  redacted_reason: string | null;
  /**
   * 布尔值语义(**后端显式给出,前端不反推**):
   * `switch` = 真开关(渲染「开/关」);`configured` = 脱敏后的「已配置/未配置」;`none` = 非布尔。
   */
  value_semantics: 'switch' | 'configured' | 'none';
}

export interface SystemSettingsState {
  schema_version: number;
  sources: Record<string, SubsystemState>;
  /** GPU 是单实例采样,不冒充集群一致值。 */
  gpu_scope: string;
  groups: { group: string; sources: string[]; items: SettingItem[] }[];
}

export interface ApiClient {
  client_id: string;
  name: string;
  scopes: string[];
  created_at?: string;
  created_by?: string;
  disabled?: boolean;
  /** 明文 api_key 仅创建时返回一次 */
  api_key?: string;
}

export interface DelegationOut {
  token: string;
  label?: string;
  staff: string;
  exp_epoch: number;
  mcp_config?: {
    server_name?: string;
    transport?: string;
    endpoint?: string;
    auth_header?: string;
    token?: string;
    tools?: string[];
  } | null;
}

/** 016 候选人时段池(HR 侧,SlotOut) */
export interface EngagementSlot {
  slot_id: string;
  engagement_id: string;
  agent_id: string;
  question_bank_id?: string | null;
  meeting_start?: string | null;
  meeting_end?: string | null;
  status: string; // open | claimed
  claimed_by?: string | null;
  session_id?: string | null;
}

/** 016 候选人一次性链接(CandidateLinkOut;token 仅签发时返回) */
export interface CandidateLink {
  token: string;
  candidate_id: string;
  engagement_id: string;
  exp_epoch: number;
}

/** 017 合法 scope(与后端 models.VALID_SCOPES 对齐) */
export const VALID_SCOPES = [
  'sessions:write',
  'sessions:read',
  'results:read',
  'webhooks:manage',
  'agents:write',
  'agents:read',
  'question-banks:write',
  'question-banks:read',
] as const;
