/**
 * 实时会话服务 → 控制面状态回报。客户端连入/会话结束时 POST 到
 * 控制面 `POST /api/sessions/{id}/events`(带 X-Bridge-Secret),驱动会话状态机
 * `scheduled → in_progress → completed`。
 *
 * 事件集(VISION §3 减法后):
 *   - connected  客户端连入,会话开始(控制面置 in_progress)
 *   - completed  会话正常收尾(带时长/录音)
 *   - peer_hangup 对端异常断开
 *   - no_show    超时未连入(由控制面调度器判定为主;服务侧保留枚举备用)
 * 拨号类事件(no_answer/dial_failed/no_media/setup_error)随电话链路删除。
 *
 * 寻址:env AIM_CONTROL_CALLBACK_URL = 控制面基址(如 http://internal-alb/api),拼 /sessions/{id}/events。
 * 密钥:env AIM_BRIDGE_CALLBACK_SECRET(与控制面同值)。任一缺失 → 回报降级为 no-op(只打日志),
 *      不阻断会话主流程(回报是状态同步,失败不应让服务崩)。
 */

export type MediaEvent =
  | "connected"
  | "completed"
  | "peer_hangup"
  | "no_show"
  | "violation_end"; // design contract:违规/物理断连强制结束 → 控制面写 status=failed + fail_reason

export interface MediaEventBody {
  event: MediaEvent;
  end_trigger?: string;
  duration_s?: number;
  has_recording?: boolean;
  // design contract:violation_end 携带失败原因(peer_hangup/silence_violation/severe_violation)→ backend fail_reason。
  fail_reason?: string;
  // design contract:三次坚持逃生阀放行的提前结束标记(backend 不认则忽略,向后兼容)。
  early_exit?: boolean;
}

const CALLBACK_BASE = (process.env.AIM_CONTROL_CALLBACK_URL ?? "").replace(/\/$/, "");
const CALLBACK_SECRET = process.env.AIM_BRIDGE_CALLBACK_SECRET ?? "";

/** 向控制面回报一次会话事件。best-effort:网络/配置缺失只打日志,不抛。 */
export async function reportEvent(sessionId: string, body: MediaEventBody): Promise<void> {
  if (!CALLBACK_BASE || !CALLBACK_SECRET) {
    console.warn(`[callback] 未配置 AIM_CONTROL_CALLBACK_URL / AIM_BRIDGE_CALLBACK_SECRET,跳过回报 ${body.event} (${sessionId})`);
    return;
  }
  const url = `${CALLBACK_BASE}/sessions/${encodeURIComponent(sessionId)}/events`;
  try {
    // Node 18+ 全局 fetch;AbortSignal.timeout 防控制面无响应时卡住服务
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Secret": CALLBACK_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      console.error(`[callback] ${body.event} ${sessionId} → HTTP ${resp.status}`);
    } else {
      console.log(`[callback] ${body.event} ${sessionId} → ok`);
    }
  } catch (e) {
    console.error(`[callback] ${body.event} ${sessionId} 回报失败:`, (e as Error)?.message ?? e);
  }
}
