'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { t } from '@/lib/i18n';
import { useAsync, useLang } from '@/lib/appState';
import { api } from '@/lib/api';
import { Loading, ErrorBanner } from '@/lib/ui';
import { navigate } from '@/lib/router';
import {
  statusClass,
  statusLabel,
  fmtDateTime,
  fmtDuration,
} from '@/lib/format';

const STATUSES = ['scheduled', 'in_progress', 'completed', 'failed'];
const PAGE_SIZE = 20; // 会话列表分页:一页 20 条(客户端切片,筛选/搜索后再分页)

/** 会话实际时长(ended - started,mm:ss);未开始/未结束 → 「—」。 */
function sessionDuration(startedAt?: string | null, endedAt?: string | null): string {
  if (!startedAt || !endedAt) return '—';
  const a = new Date(startedAt).getTime();
  const b = new Date(endedAt).getTime();
  if (isNaN(a) || isNaN(b) || b < a) return '—';
  return fmtDuration((b - a) / 1000);
}

/**
 * 会话历史(只读)—— 发起对话归「语音 Chat」home;本页只列历史记录 + 筛选/搜索 + 下钻详情/报告。
 * 行操作仅「看详情」(进行中/待连入)/「看报告」(已完成);无发起/进入/取消/收尾(那些在对话页/home)。
 * 即时开始 + 语音 Chat 统一入口后,「来源(origin)」对用户无意义(都是自己开始),不再展示/筛选(字段仍留后端)。
 */
export function Sessions() {
  useLang();
  const { data, error, loading } = useAsync(() => api.listSessions(), []);
  const [fStatus, setFStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1); // 当前页(1-based)

  const rows = useMemo(() => {
    let list = data || [];
    if (fStatus) list = list.filter((s) => s.status === fStatus);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (s) =>
          (s.agent_id || '').toLowerCase().includes(q) ||
          (s.booked_by || '').toLowerCase().includes(q) ||
          (s.target_id || '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [data, fStatus, search]);

  // 分页:一页 20 条,对**筛选/搜索后**的结果切片(先筛后分,符合直觉)。
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // 筛选/搜索变化或数据刷新致行数变化时,把越界的页码钳回有效范围(如从第 5 页筛到只剩 1 页)。
  // 依赖 [rows.length, page](直接感知行数变化,不依赖派生值 totalPages);渲染层已由 curPage 钳制,
  // 此 effect 只让 page state 收敛回稳态(review:更清晰、无中间态抖动)。
  useEffect(() => {
    const tp = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (page > tp) setPage(tp);
  }, [rows.length, page]);
  const curPage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => rows.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE),
    [rows, curPage],
  );

  // 筛选/搜索变更 → 回第 1 页(避免停在旧页码看不到结果)。
  const onFilter = (v: string) => { setFStatus(v); setPage(1); };
  const onSearch = (v: string) => { setSearch(v); setPage(1); };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('nav_sessions')}</h1>
          <div className="page-sub">{t('se_sub')}</div>
        </div>
      </div>

      <div className="toolbar">
        <select className="input" value={fStatus} onChange={(e) => onFilter(e.target.value)}>
          <option value="">{t('f_status_all')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <div className="search-wrap">
          <span className="ico" aria-hidden="true">🔍</span>
          <input
            className="input"
            value={search}
            placeholder={t('se_search_ph')}
            aria-label={t('se_search_ph')}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
      </div>

      <ErrorBanner message={error} />

      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('th_scenario')}</th>
              <th>{t('th_starter')}</th>
              <th>{t('th_created')}</th>
              <th>{t('th_duration')}</th>
              <th>{t('th_status')}</th>
              <th style={{ textAlign: 'right' }}>{t('th_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6}>
                  <Loading label={t('loading')} />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">{t('empty_list')}</div>
                </td>
              </tr>
            ) : (
              pageRows.map((s) => (
                <tr key={s.session_id}>
                  <td>
                    <div className="obj-name">{s.agent_name || s.agent_id}</div>
                  </td>
                  <td>{s.booked_by || '—'}</td>
                  <td className="obj-sub">{fmtDateTime(s.created_at)}</td>
                  <td className="obj-sub">{sessionDuration(s.started_at, s.ended_at)}</td>
                  <td>
                    <span className={'status ' + statusClass(s.status, s.fail_reason)}>
                      <span className="dot" />
                      {statusLabel(s.status, s.fail_reason)}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      {s.status === 'completed' ? (
                        <button className="btn btn-sm" onClick={() => navigate(`#/sessions/${s.session_id}/report`)}>
                          {t('see_result')}
                        </button>
                      ) : (
                        <button className="btn btn-sm" onClick={() => navigate(`#/sessions/${s.session_id}`)}>
                          {t('see_status')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 分页器:仅有多于一页时显示(≤20 条不打扰)。筛选/搜索后按结果集分页。 */}
      {!loading && rows.length > PAGE_SIZE && (
        <div className="pager">
          <button
            className="btn btn-sm"
            disabled={curPage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t('pg_prev')}
          </button>
          <span className="pager-info">
            {t('pg_info')
              .replace('{cur}', String(curPage))
              .replace('{total}', String(totalPages))
              .replace('{count}', String(rows.length))}
          </span>
          <button
            className="btn btn-sm"
            disabled={curPage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            {t('pg_next')}
          </button>
        </div>
      )}
    </div>
  );
}
