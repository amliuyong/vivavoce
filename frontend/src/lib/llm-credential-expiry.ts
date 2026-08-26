export type LlmCredentialStatus =
  | 'ok'
  | 'expiring'
  | 'expired'
  | 'not_configured'
  | 'not_applicable';

export interface LlmCredentialStatusView {
  status: LlmCredentialStatus;
  expires_at: string | null;
}

export interface CredentialWarning {
  tone: 'warning' | 'error';
  messageKey:
    | 'vc_llm_expiring_admin'
    | 'vc_llm_expiring_staff'
    | 'vc_llm_expired_admin'
    | 'vc_llm_expired_staff'
    | 'vc_llm_not_configured_admin'
    | 'vc_llm_not_configured_staff';
  expiresAt: string | null;
  showManage: boolean;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function utcExpiryToLocalInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
  ].join('');
}

export function localExpiryToUtc(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function isFutureLocalExpiry(value: string, nowMs = Date.now()): boolean {
  const utc = localExpiryToUtc(value);
  return utc !== null && Date.parse(utc) > nowMs;
}

export async function loadLlmCredentialStatus(
  loader: () => Promise<LlmCredentialStatusView>,
): Promise<LlmCredentialStatusView | null> {
  try {
    return await loader();
  } catch {
    return null;
  }
}

export function credentialWarning(
  state: LlmCredentialStatusView | null,
  isAdmin: boolean,
): CredentialWarning | null {
  if (!state || state.status === 'ok' || state.status === 'not_applicable') return null;
  if (state.status === 'expiring') {
    return {
      tone: 'warning',
      messageKey: isAdmin ? 'vc_llm_expiring_admin' : 'vc_llm_expiring_staff',
      expiresAt: state.expires_at,
      showManage: isAdmin,
    };
  }
  if (state.status === 'expired') {
    return {
      tone: 'error',
      messageKey: isAdmin ? 'vc_llm_expired_admin' : 'vc_llm_expired_staff',
      expiresAt: state.expires_at,
      showManage: isAdmin,
    };
  }
  return {
    tone: 'error',
    messageKey: isAdmin ? 'vc_llm_not_configured_admin' : 'vc_llm_not_configured_staff',
    expiresAt: state.expires_at,
    showManage: isAdmin,
  };
}
