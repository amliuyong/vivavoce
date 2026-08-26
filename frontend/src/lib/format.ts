// 展示用格式化助手。
import { t, type StringKey } from './i18n';

const STATUS_KEY: Record<string, StringKey> = {
  scheduled: 'st_scheduled',
  in_progress: 'st_in_progress',
  completed: 'st_completed',
  failed: 'st_failed',
};
const STATUS_CLS: Record<string, string> = {
  scheduled: 'st-todo',
  in_progress: 'st-live',
  completed: 'st-done',
  failed: 'st-fail',
};

// 会话终态 `failed` 由「用户主动取消(fail_reason=cancelled)」与「真正流程失败/未出席(no_show)」共用。
// 展示层据 fail_reason 区分:cancelled → 「已取消」(中性),其余 failed → 「失败」(告警色)。
export function statusLabel(status: string, failReason?: string | null): string {
  if (status === 'failed' && failReason === 'cancelled') return t('st_cancelled');
  const key = STATUS_KEY[status];
  return key ? t(key) : status;
}
export function statusClass(status: string, failReason?: string | null): string {
  if (status === 'failed' && failReason === 'cancelled') return 'st-cancelled';
  return STATUS_CLS[status] || 'st-todo';
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDuration(seconds?: number | null): string {
  if (seconds == null) return '—';
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 会话可进入判定(即时开始转向:无时间窗,仅看状态)。scheduled/in_progress 即可连入。
// 仅作 UI 展示门槛(按钮显隐);硬校验在后端 /join(终态 409),前端不作为安全边界。
export function isJoinableNow(s: { status: string }): boolean {
  return s.status === 'scheduled' || s.status === 'in_progress';
}

export function originLabel(origin?: string | null): string {
  if (origin === 'hr') return t('origin_hr');
  if (origin === 'staff') return t('origin_staff');
  if (origin === 'api') return 'API';
  if (origin === 'candidate') return 'Candidate';
  return '—';
}
