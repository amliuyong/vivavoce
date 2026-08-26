'use client';
import React from 'react';
import { t } from '@/lib/i18n';
import { useAsync, useLang } from '@/lib/appState';
import { api } from '@/lib/api';
import { Loading, ErrorBanner } from '@/lib/ui';
import { navigate } from '@/lib/router';
import {
  statusClass,
  statusLabel,
  fmtDateTime,
  isJoinableNow,
} from '@/lib/format';

/** 我的会话 —— **只读历史**(即时开始转向后无预约概念):发起入口统一在语音 Chat。
 *  仅保留:进行中可「进入」回到对话、completed 可「看我的结果」。 */
export function MyMeetings() {
  useLang();
  const { data, error, loading } = useAsync(() => api.listSessions(), []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('mm_title')}</h1>
          <div className="page-sub">{t('mm_sub')}</div>
        </div>
      </div>

      <ErrorBanner message={error} />

      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('nav_agents')}</th>
              <th>{t('mm_th_window')}</th>
              <th>{t('th_status')}</th>
              <th style={{ textAlign: 'right' }}>{t('th_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4}>
                  <Loading label={t('loading')} />
                </td>
              </tr>
            ) : (data || []).length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <div className="empty-state">{t('empty_list')}</div>
                </td>
              </tr>
            ) : (
              (data || []).map((s) => {
                return (
                  <tr key={s.session_id}>
                    <td className="obj-name">{s.agent_id}</td>
                    <td>{fmtDateTime(s.created_at)}</td>
                    <td>
                      <span className={'status ' + statusClass(s.status, s.fail_reason)}>
                        <span className="dot" />
                        {statusLabel(s.status, s.fail_reason)}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        {/* 进行中/刚创建仍可回到对话;历史(completed)看结果。无发起/取消(只读)。 */}
                        {isJoinableNow(s) && (
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => navigate(`#/exam/${s.session_id}`)}
                          >
                            {t('exam_enter')}
                          </button>
                        )}
                        {s.status === 'completed' && (
                          <button className="btn btn-sm" onClick={() => navigate(`#/my-meetings/${s.session_id}/report`)}>
                            {t('mm_see_result')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
