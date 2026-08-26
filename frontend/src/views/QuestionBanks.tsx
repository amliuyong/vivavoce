'use client';
import React from 'react';
import { t } from '@/lib/i18n';
import { useAsync, useLang } from '@/lib/appState';
import { api, type QuestionBank, ApiError } from '@/lib/api';
import { Loading, ErrorBanner, useToast } from '@/lib/ui';
import { navigate } from '@/lib/router';

// 题库列表(design contract,admin-only)。结构仿 Agents.tsx。
export function QuestionBanks() {
  useLang();
  const { toast, confirm } = useToast();
  const { data, error, loading, reload } = useAsync(() => api.listQuestionBanks(), []);

  async function doDelete(b: QuestionBank) {
    const ok = await confirm({
      title: t('qb_delete'),
      message: `${t('qb_delete_confirm')}(${b.name} ${b.version || ''})`,
      confirmLabel: t('delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteQuestionBank(b.question_bank_id);
      toast(t('qb_deleted'));
      reload();
    } catch (e) {
      // 409:被 Agent 默认题库 / 活动会话 / 时段池引用 → 展示后端可读原因
      toast(e instanceof ApiError ? e.detail : t('error_generic'));
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('nav_question_banks')}</h1>
          <div className="page-sub">{t('qb_sub')}</div>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('#/question-banks/new')}>
          {t('qb_new')}
        </button>
      </div>

      <ErrorBanner message={error} />

      {loading ? (
        <Loading label={t('loading')} />
      ) : (
        <div className="prof-grid">
          {(data || []).map((b: QuestionBank) => {
            const qn = b.questions?.length || 0;
            return (
              <div
                className="card prof-card"
                key={b.question_bank_id}
                onClick={() => navigate(`#/question-banks/edit/${b.question_bank_id}`)}
              >
                <div className="pc-name">{b.name}</div>
                <div className="pc-tags">
                  {b.version && <span className="tag">{b.version}</span>}
                  {(b.labels || []).map((l) => (
                    <span className="tag" key={l}>
                      {l}
                    </span>
                  ))}
                </div>
                <div className="pc-meta">
                  <span>
                    📋 {qn} {t('qb_questions_n')}
                  </span>
                </div>
                <div className="pc-foot" style={{ gap: 6 }}>
                  <button
                    className="btn btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`#/question-banks/edit/${b.question_bank_id}`);
                    }}
                  >
                    {t('edit')}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      doDelete(b);
                    }}
                  >
                    {t('delete')}
                  </button>
                </div>
              </div>
            );
          })}
          <div className="card prof-card new-card" onClick={() => navigate('#/question-banks/new')}>
            {t('qb_new')}
          </div>
        </div>
      )}
    </div>
  );
}
