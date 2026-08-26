'use client';
import React from 'react';
import { t, type StringKey } from '@/lib/i18n';
import { useAsync, useLang } from '@/lib/appState';
import { api, type Agent, type QuestionStrategy, ApiError } from '@/lib/api';
import { Loading, ErrorBanner, useToast } from '@/lib/ui';
import { navigate } from '@/lib/router';

// 出题策略 → i18n label key(design contract)。
const STRATEGY_LABEL: Record<QuestionStrategy, StringKey> = {
  sequential: 'ed_strategy_sequential',
  random_n: 'ed_strategy_random_n',
  easy_to_hard: 'ed_strategy_easy_to_hard',
  random_n_easy_to_hard: 'ed_strategy_random_n_easy',
};

export function Agents() {
  useLang();
  const { toast, confirm } = useToast();
  const { data, error, loading, reload } = useAsync(() => api.listAgents(), []);

  async function doDelete(a: Agent) {
    const ok = await confirm({
      title: t('pf_delete'),
      message: `${t('pf_delete_confirm')}(${a.name} ${a.version || ''})`,
      confirmLabel: t('delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteAgent(a.agent_id);
      toast(t('pf_deleted'));
      reload();
    } catch (e) {
      // 409:仍被进行中会话引用 → 展示后端可读原因
      toast(e instanceof ApiError ? e.detail : t('error_generic'));
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('nav_agents')}</h1>
          <div className="page-sub">{t('pf_sub')}</div>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('#/agents/new')}>
          {t('pf_new')}
        </button>
      </div>

      <ErrorBanner message={error} />

      {loading ? (
        <Loading label={t('loading')} />
      ) : (
        <div className="prof-grid">
          {(data || []).map((a: Agent) => {
            // 题目不再属于 Agent(改挂题库),改展示「出题策略」+ rubric 通过线信息。
            const strategy = a.question_strategy || 'sequential';
            const pass =
              a.rubric?.mode === 'per_question_check' && a.rubric.pass_threshold != null
                ? `${t('pf_pass_line')} ${Math.round(a.rubric.pass_threshold * 100)}%`
                : t('pf_no_pass');
            return (
              <div
                className="card prof-card"
                key={a.agent_id}
                onClick={() => navigate(`#/agents/edit/${a.agent_id}`)}
              >
                <div className="pc-name">{a.name}</div>
                <div className="pc-tags">
                  {a.version && <span className="tag">{a.version}</span>}
                  {a.self_bookable && (
                    <span
                      className="tag"
                      style={{ background: 'var(--indigo-50)', color: 'var(--indigo-600)' }}
                    >
                      {t('pf_self_bookable')}
                    </span>
                  )}
                  {(a.labels || []).map((l) => (
                    <span className="tag" key={l}>
                      {l}
                    </span>
                  ))}
                </div>
                <div className="pc-meta">
                  <span>🎲 {t(STRATEGY_LABEL[strategy])}</span>
                  <span>🎯 {pass}</span>
                </div>
                <div className="pc-foot" style={{ gap: 6 }}>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      // 一键语音对话:深链到语音 Chat 并自动用该 Agent 开始(发起逻辑收口在 VoiceChat)。
                      navigate(`#/voice-chat?agent=${a.agent_id}`);
                    }}
                  >
                    {t('pf_start_chat')}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`#/agents/edit/${a.agent_id}`);
                    }}
                  >
                    {t('edit')}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      doDelete(a);
                    }}
                  >
                    {t('delete')}
                  </button>
                </div>
              </div>
            );
          })}
          <div className="card prof-card new-card" onClick={() => navigate('#/agents/new')}>
            {t('pf_new')}
          </div>
        </div>
      )}
    </div>
  );
}
