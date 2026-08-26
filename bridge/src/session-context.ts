/**
 * 会话内核暂存(session_id → system_prompt + 引擎参数)。
 *
 * 控制面预创建会话时携带「这场 AI 是谁、用什么引擎」(Agent 解析结果);但音频路径是客户端
 * **稍后**才连上服务的 WS(?session_id=)。两者异步,故把预创建时的会话内核暂存在此,
 * WS 连上时按 session_id 取用 —— 否则 AI 会退化成默认 prompt(缺陷)。
 *
 * 单进程内存表;设过期清理防预创建后始终没连入的泄漏。
 */
import { EngineParams } from "./voice-engine";

export interface SessionContext {
  systemPrompt: string;
  engineParams: EngineParams;
  storedAtMs: number;
  /** 硬连接截止(review):控制面下发的 connect_deadline(ms epoch)。晚于此刻的 WS 连入一律
   *  拒绝(视作不存在)——即便 join token(4h TTL)仍有效。防「取 token 后、调度器判 failed、再连入」竞态。
   *  与 backend scheduler 过期判定同锚(即时=created_at+N;候选人=meeting_end)。undefined = 不设硬截止,
   *  仅靠 TTL 兜底。 */
  connectDeadlineMs?: number;
  /** 实时字幕显示开关(design contract):会话级**呈现层**配置,经 ready 帧回显给前端(前端据此选有字幕 Teams 舞台
   *  vs 无字幕纯声波布局)。**独立呈现字段,不塞进 engineParams**(engineParams 是引擎运行时接口,
   *  show_subtitles 不流向引擎/GPU)。undefined/缺省语义 = true(默认开,向后兼容:旧 backend 未下发时仍显示字幕)。 */
  showSubtitles?: boolean;
  /** 头像风格(design contract):会话级呈现层配置,经 ready 帧回显给前端(前端据此选 minimal/round/tech SVG 头像
   *  或 waveform 纯波形)。**独立呈现字段,不塞 engineParams**。**只存合法四枚举**(index.ts 校验后存),非法/缺省 =
   *  undefined → 前端兜底 minimal(fail-safe;字符串枚举需显式校验,不同 bool 的 showSubtitles)。 */
  avatarStyle?: string;
  /** 声纹锁定说话人(design contract):会话级**行为**配置——控制面下发的 Agent.speaker_lock。**独立行为字段,
   *  不塞 engineParams**(engineParams 是引擎运行时接口,声纹注册/门控是 bridge 会话行为)。undefined/缺省语义
   *  = true(默认锁定,向后兼容:旧 backend 未下发时按开)。**注**:这只是「Agent 请求开锁」;实际是否启用
   *  声纹门由 media-session 用 effective_speaker_lock 裁定(还需 recovery 开 + 全局 kill-switch,见 design contract D7)。 */
  speakerLock?: boolean;
}

const TTL_MS = 30 * 60 * 1000; // 30min:预创建后仍没连上 WS 即视为过期(对齐 backend AIM_SESSION_JOIN_EXPIRE_MIN)

const store = new Map<string, SessionContext>();

export function putSessionContext(
  sessionId: string,
  systemPrompt: string,
  engineParams: EngineParams,
  nowMs: number = Date.now(),
  connectDeadlineMs?: number,
  showSubtitles?: boolean,
  avatarStyle?: string,
  speakerLock?: boolean,
): void {
  store.set(sessionId, { systemPrompt, engineParams, storedAtMs: nowMs, connectDeadlineMs, showSubtitles, avatarStyle, speakerLock });
  sweep(nowMs);
}

/** 取并保留(WS 可能重连);返回 null 表示无暂存(用调用方默认)。
 *  N5:get 也校验过期 —— 否则预创建失败后很久才来的同 session_id WS(或长期无新 put 触发 sweep)
 *  会拿到陈旧的 prompt/engine params。过期即视为不存在并清掉。
 *  connect_deadline(review):晚于控制面下发硬截止的连入也视作不存在 —— 会话可能已被调度器判 failed,
 *  不能靠 join token 4h TTL 放行。TTL 与 deadline 取先到者。 */
export function getSessionContext(
  sessionId: string,
  nowMs: number = Date.now(),
): SessionContext | null {
  const ctx = store.get(sessionId);
  if (!ctx) return null;
  if (nowMs - ctx.storedAtMs > TTL_MS) {
    store.delete(sessionId);
    return null;
  }
  if (ctx.connectDeadlineMs !== undefined && nowMs > ctx.connectDeadlineMs) {
    store.delete(sessionId);
    return null;
  }
  return ctx;
}

export function dropSessionContext(sessionId: string): void {
  store.delete(sessionId);
}

export function sessionContextSize(): number {
  return store.size;
}

function sweep(nowMs: number): void {
  for (const [id, ctx] of store) {
    if (nowMs - ctx.storedAtMs > TTL_MS) store.delete(id);
  }
}
