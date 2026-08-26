'use client';
import React, { useMemo } from 'react';
import { t } from '@/lib/i18n';
import { useAsync, useLang } from '@/lib/appState';
import { api, type Session } from '@/lib/api';
import { Loading, ErrorBanner } from '@/lib/ui';
import { navigate } from '@/lib/router';
import { statusClass, statusLabel, fmtDateTime } from '@/lib/format';

function isToday(iso?: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

export function Overview() {
  useLang();
  const { data, error, loading } = useAsync(
    async () => {
      // 总览全局口径:会话 + Agent + 按场景(Agent)聚合统计(通过率)。
      const [sessions, agents, stats] = await Promise.all([
        api.listSessions(),
        api.listAgents(),
        api.listSessionStats(),
      ]);
      return { sessions, agents, stats };
    },
    [],
  );

  const stats = useMemo(() => {
    const s: Session[] = data?.sessions || [];
    return {
      live: s.filter((x) => x.status === 'in_progress').length,
      doneToday: s.filter((x) => x.status === 'completed' && isToday(x.ended_at)).length,
      pending: s.filter((x) => x.status === 'scheduled').length,
      staffBooked: s.filter((x) => x.origin === 'staff').length,
      agents: (data?.agents || []).length,
    };
  }, [data]);

  const recent = useMemo(() => {
    const s = [...(data?.sessions || [])];
    s.sort((a, b) => (b.started_at || b.meeting_start || '').localeCompare(a.started_at || a.meeting_start || ''));
    return s.slice(0, 8);
  }, [data]);

  // 按场景(Agent)聚合(后端已按 total 倒序 + 算好 pass_rate)。总览只显会话数最多的前 N 个
  // (避免 e2e/一次性 Agent 拖出超长表,总览应一屏可读);全部场景在「会话」页可查。
  const SCENARIO_TOP_N = 15;
  const allScenarios = useMemo(() => data?.stats?.agents || [], [data]);
  const scenarios = allScenarios.slice(0, SCENARIO_TOP_N);
  const scenarioOverflow = allScenarios.length - scenarios.length;

  if (loading) return <Loading label={t('loading')} />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('ov_title')}</h1>
          <div className="page-sub">{t('ov_sub')}</div>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('#/voice-chat')}>
          {t('start_meeting')}
        </button>
      </div>

      <ErrorBanner message={error} />

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>
        <div className="card stat">
          <div className="k">{t('ov_stat_live')}</div>
          <div className="v t-green">
            {stats.live} <small>{t('unit_session')}</small>
          </div>
        </div>
        <div className="card stat">
          <div className="k">{t('ov_stat_donetoday')}</div>
          <div className="v t-blue">
            {stats.doneToday} <small>{t('unit_session')}</small>
          </div>
        </div>
        <div className="card stat">
          <div className="k">{t('ov_stat_pending')}</div>
          <div className="v t-amber">
            {stats.pending} <small>{t('unit_session')}</small>
          </div>
        </div>
        <div
          className="card stat"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('#/sessions')}
          title={t('ov_stat_staff')}
        >
          <div className="k">{t('ov_stat_staff')}</div>
          <div className="v" style={{ color: 'var(--indigo-600)' }}>
            {stats.staffBooked} <small>{t('unit_session')}</small>
          </div>
        </div>
        <div className="card stat">
          <div className="k">{t('ov_stat_agents')}</div>
          <div className="v">
            {stats.agents} <small>{t('unit_count')}</small>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-mute)', margin: '-14px 0 24px' }}>{t('ov_scope_note')}</div>

      {/* 按场景(Agent)分 + 通过率(spec:总览按场景统计)。通过率 = passed/evaluated(有评测结果的会话)。 */}
      <div className="card card-pad" style={{ marginBottom: 24 }}>
        <p className="sec-title">{t('ov_by_scenario')}</p>
        {scenarios.length === 0 ? (
          <div className="empty-state">{t('empty_list')}</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('ov_sc_scenario')}</th>
                <th style={{ textAlign: 'right' }}>{t('ov_sc_total')}</th>
                <th style={{ textAlign: 'right' }}>{t('ov_sc_evaluated')}</th>
                <th style={{ width: 200 }}>{t('ov_sc_pass_rate')}</th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((a) => {
                const pct = a.pass_rate != null ? Math.round(a.pass_rate * 100) : null;
                const barColor = pct == null ? 'var(--border)' : pct >= 80 ? 'var(--green)' : pct >= 60 ? 'var(--amber)' : 'var(--red)';
                return (
                  <tr key={a.agent_id}>
                    <td><div className="obj-name">{a.agent_name || a.agent_id}</div></td>
                    <td style={{ textAlign: 'right' }} className="obj-sub">{a.total}</td>
                    <td style={{ textAlign: 'right' }} className="obj-sub">{a.evaluated}</td>
                    <td>
                      {pct == null ? (
                        <span className="obj-sub" title={t('ov_sc_no_eval')}>—</span>
                      ) : (
                        <div className="pass-rate-cell">
                          <div className="pr-bar"><span style={{ width: pct + '%', background: barColor }} /></div>
                          <span className="pr-num">{pct}% <small>({a.passed}/{a.evaluated})</small></span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {scenarioOverflow > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-mute)', marginTop: 10 }}>
            {t('ov_sc_more').replace('{n}', String(scenarioOverflow))}
          </div>
        )}
      </div>

      <div className="card card-pad">
        <p className="sec-title">{t('ov_recent')}</p>
        {recent.length === 0 ? (
          <div className="empty-state">{t('empty_list')}</div>
        ) : (
          <table className="tbl">
            <tbody>
              {recent.map((s) => (
                <tr key={s.session_id}>
                  <td style={{ width: 170, color: 'var(--text-mute)' }}>
                    {fmtDateTime(s.started_at || s.meeting_start)}
                  </td>
                  <td>
                    {s.agent_id}{' '}
                    <span className={'status ' + statusClass(s.status, s.fail_reason)}>
                      <span className="dot" />
                      {statusLabel(s.status, s.fail_reason)}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {s.status === 'completed' ? (
                      <button className="btn btn-sm" onClick={() => navigate(`#/sessions/${s.session_id}/report`)}>
                        {t('see_result')}
                      </button>
                    ) : (
                      <button className="btn btn-sm" onClick={() => navigate(`#/sessions/${s.session_id}`)}>
                        {t('see_status')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
