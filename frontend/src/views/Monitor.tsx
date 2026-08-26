'use client';
import React from 'react';
import { t } from '@/lib/i18n';
import { useAsync, useLang, useSession } from '@/lib/appState';
import { api, type Session, ApiError } from '@/lib/api';
import { Loading, ErrorBanner, useToast } from '@/lib/ui';
import { navigate } from '@/lib/router';
import {
  statusClass,
  statusLabel,
  fmtDateTime,
  originLabel,
} from '@/lib/format';

// 顶层 Session 状态时间线步骤
const STEPS: { key: string; label: () => string }[] = [
  { key: 'scheduled', label: () => t('tl_scheduled') },
  { key: 'in_progress', label: () => t('tl_in_progress') },
  { key: 'completed', label: () => t('tl_completed') },
];
const ORDER: Record<string, number> = { scheduled: 0, in_progress: 1, completed: 2, failed: 99 };

export function Monitor({ id }: { id: string }) {
  useLang();
  const session = useSession();
  const { toast } = useToast();
  const { data, error, loading, reload } = useAsync(() => api.getSession(id), [id]);

  if (loading) return <Loading label={t('loading')} />;
  if (error || !data)
    return (
      <div className="page">
        <span className="btn btn-ghost btn-sm" onClick={() => navigate('#/sessions')}>
          {t('mo_back')}
        </span>
        <ErrorBanner message={error || t('error_generic')} />
      </div>
    );

  const s: Session = data;
  const curOrder = ORDER[s.status] ?? 0;
  const isFailed = s.status === 'failed';

  async function doHangup() {
    try {
      await api.hangupSession(id);
      toast(t('rp_review_done'));
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : t('error_generic'));
    }
  }

  return (
    <div className="page">
      <div className="monitor-head">
        <div>
          <span className="btn btn-ghost btn-sm" onClick={() => navigate('#/sessions')}>
            {t('mo_back')}
          </span>
          <div className="mt" style={{ marginTop: 6 }}>
            {s.agent_id}
          </div>
        </div>
        <span className={'status ' + statusClass(s.status, s.fail_reason)} style={{ fontSize: 13 }}>
          <span className="dot" />
          {statusLabel(s.status, s.fail_reason)}
        </span>
      </div>

      <div className="monitor-grid">
        <div>
          <div className="card card-pad">
            <p className="sec-title">{t('mo_timeline')}</p>
            <div className="timeline">
              {STEPS.map((step, i) => {
                const stepOrder = ORDER[step.key];
                let cls = 'todo';
                if (isFailed && step.key === 'in_progress') cls = 'fail';
                else if (stepOrder < curOrder) cls = 'done';
                else if (stepOrder === curOrder) cls = 'current';
                return (
                  <div key={step.key} className={'tl-step ' + cls}>
                    <div className="tl-line" />
                    <div className="tl-mark">{cls === 'done' ? '✓' : cls === 'fail' ? '✕' : i + 1}</div>
                    <div className="tl-body">
                      <div className="tl-name">
                        {step.label()}
                        {cls === 'current' && ' ' + t('timeline_current')}
                      </div>
                    </div>
                  </div>
                );
              })}
              {isFailed && (
                <div className="tl-failreason">
                  {t('mo_fail_reason')}: {s.fail_reason || '—'}
                </div>
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="card card-pad info-card">
            <p className="sec-title">{t('mo_basic')}</p>
            <div className="ir">
              <span className="ik">{t('mo_window')}</span>
              <span className="iv">{fmtDateTime(s.started_at)} ~ {fmtDateTime(s.ended_at)}</span>
            </div>
            <div className="ir">
              <span className="ik">{t('th_origin')}</span>
              <span className="iv">{originLabel(s.origin)}</span>
            </div>
            <div className="ir">
              <span className="ik">{t('th_target')}</span>
              {/* 可读优先:对象名(target_name)→ 发起人 email → 真实 target_id(tgt_);
                  **不回退 booked_by**(那是 Cognito sub UUID,不可读)。都无 → 「—」。 */}
              <span className="iv">{s.target_name || s.booked_by_email || s.target_id || '—'}</span>
            </div>
            <div className="ir">
              <span className="ik">{t('th_created')}</span>
              <span className="iv">{fmtDateTime(s.created_at)}</span>
            </div>
            <div className="ir">
              <span className="ik">{t('mo_starttime')}</span>
              <span className="iv">{fmtDateTime(s.started_at)}</span>
            </div>
          </div>

          <div className="monitor-foot">
            <button className="btn btn-sm" onClick={reload}>
              ↻ {t('refresh')}
            </button>
            {s.status === 'in_progress' && session?.isAdmin && (
              <button className="btn btn-sm btn-danger" onClick={doHangup}>
                {t('mo_end_early')}
              </button>
            )}
            {/* 会话级「重约」已删:即时开始、无预约,失败会话不重跑(重新发起 = 语音 Chat 里再起一场)。 */}
            {s.status === 'completed' && (
              <button className="btn btn-sm btn-primary" onClick={() => navigate(`#/sessions/${id}/report`)}>
                {t('see_result')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
