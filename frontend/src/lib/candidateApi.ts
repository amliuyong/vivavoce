// 候选人对外自助 API 客户端(design contract)。与常规 api.ts 区别:
//  - 鉴权用**一次性候选人 token**(URL ?token= 解析,经 X-Candidate-Token 头传),**不是** Cognito Bearer。
//  - 不触发「401→跳登录」(候选人无公司账号,无登录页可跳);错误统一抛 CandidateApiError 由页面展示。
// 所有 /api/candidate/* 经 CloudFront 回源私有 ALB(同 D9:唯一公网入口)。
import { getConfig } from './config';

export class CandidateApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`API ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

export interface CandidateSlot {
  slot_id: string;
  meeting_start?: string | null;
  meeting_end?: string | null;
}

export interface CandidateStatus {
  engagement_id: string;
  booked: boolean;
  slot_id?: string | null;
  meeting_start?: string | null;
  meeting_end?: string | null;
  // not_booked | booked | in_progress | finished
  stage: string;
}

async function call<T>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const cfg = getConfig();
  const headers: Record<string, string> = { 'X-Candidate-Token': token };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${cfg.apiBase}/candidate${path}`, { method, headers, body: payload });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = (data && (data.detail || data.message)) || detail;
      if (Array.isArray(detail))
        detail = detail.map((d: Record<string, unknown>) => d.msg || JSON.stringify(d)).join('; ');
    } catch {
      /* 非 JSON 错误体,保留 statusText */
    }
    throw new CandidateApiError(res.status, String(detail));
  }
  return (await res.json()) as T;
}

/** 候选人连入实时对话的凭据(design contract-C):后端定位候选人预约的会话并签发。 */
export interface CandidateJoin {
  join_token: string;
  ws_path: string;
  expires_at: string;
}

export const candidateApi = {
  openSlots: (token: string) => call<CandidateSlot[]>(token, '/slots'),
  status: (token: string) => call<CandidateStatus>(token, '/status'),
  book: (token: string, slot_id: string, consent: boolean) =>
    call<Record<string, unknown>>(token, '/book', 'POST', { slot_id, consent }),
  reschedule: (token: string, new_slot_id: string) =>
    call<Record<string, unknown>>(token, '/reschedule', 'POST', { new_slot_id }),
  cancel: (token: string) => call<Record<string, unknown>>(token, '/cancel', 'POST'),
  // 候选人连入:定位自己预约的会话 → join_token(不传 session_id,后端凭 token 权威定位)。
  join: (token: string) => call<CandidateJoin>(token, '/join'),
};
