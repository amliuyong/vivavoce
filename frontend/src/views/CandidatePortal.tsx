'use client';
// 候选人对外自助预约门户(design contract)。**公开页 / 无 Cognito 登录** —— 凭 URL `#/candidate/<一次性 token>` 鉴权
// (token 在 hash 路径段,不进 query/Referer/CloudFront log;调 API 时经 X-Candidate-Token 头传)。
// 流程:看可选时段 → 勾知情同意 + 选时段预约 → 看状态(已约/进行中/已完成)→ 改约 / 取消。
// 自包含(不依赖 Sidebar/ToastProvider/会话):page.tsx 在登录守卫**之前**就渲染本页。
import React, { useCallback, useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { useLang } from '@/lib/appState';
import { fmtDateTime } from '@/lib/format';
import { candidateApi, CandidateApiError, type CandidateSlot, type CandidateStatus } from '@/lib/candidateApi';
import { Exam } from './Exam';

/** 到窗判定(体验优化):meeting_start-15min ~ meeting_end 内可连入(与后端 join 窗口口径一致)。 */
function canJoinNow(st: CandidateStatus): boolean {
  const now = Date.now();
  const start = st.meeting_start ? Date.parse(st.meeting_start) : NaN;
  const end = st.meeting_end ? Date.parse(st.meeting_end) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return now >= start - 15 * 60 * 1000 && now < end;
}

/** 按 HTTP 状态分级的候选人友好错误文案(review):token 失效→联系 HR;时段被抢→重选;否则原始 detail。 */
function candErr(e: unknown): string {
  if (e instanceof CandidateApiError) {
    if (e.status === 401 || e.status === 403) return t('cp_err_token');
    if (e.status === 409) return e.detail || t('cp_err_conflict');
    if (e.status >= 500) return t('cp_err_server');
    return e.detail;
  }
  return e instanceof Error ? e.message : String(e);
}

export function CandidatePortal({ token }: { token: string }) {
  useLang();
  const [status, setStatus] = useState<CandidateStatus | null>(null);
  const [slots, setSlots] = useState<CandidateSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  // 进入实时面试(design contract-C):点"进入面试"后内嵌 Exam(候选人模式,凭 token 连入)。
  const [entering, setEntering] = useState(false);

  const reload = useCallback(async () => {
    setErr('');
    setLoading(true);
    try {
      const st = await candidateApi.status(token);
      setStatus(st);
      // 未预约 或 改约中 → 拉可选时段
      if (!st.booked) {
        setSlots(await candidateApi.openSlots(token));
      }
    } catch (e) {
      setErr(candErr(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function loadSlotsForReschedule() {
    setErr('');
    setConsent(false); // 改约不重签知情同意,但清掉残留勾选,避免取消改约回到预约界面时误显已勾(review)
    try {
      setSlots(await candidateApi.openSlots(token));
      setRescheduling(true);
    } catch (e) {
      setErr(candErr(e));
    }
  }

  async function doBook(slotId: string) {
    setErr('');
    if (!consent) {
      setErr(t('cp_consent_required'));
      return;
    }
    setBusy(true);
    try {
      await candidateApi.book(token, slotId, true);
      setNotice(t('cp_booked_ok'));
      await reload();
    } catch (e) {
      setErr(candErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function doReschedule(slotId: string) {
    setErr('');
    setBusy(true);
    try {
      await candidateApi.reschedule(token, slotId);
      setNotice(t('cp_rescheduled_ok'));
      setRescheduling(false);
      await reload();
    } catch (e) {
      setErr(candErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function doCancel() {
    setErr('');
    setBusy(true);
    try {
      await candidateApi.cancel(token);
      setNotice(t('cp_cancelled_ok'));
      setRescheduling(false);
      await reload();
    } catch (e) {
      setErr(candErr(e));
    } finally {
      setBusy(false);
    }
  }

  const stageLabel = (s: string) =>
    ({ not_booked: t('cp_stage_not_booked'), booked: t('cp_stage_booked'),
       in_progress: t('cp_stage_in_progress'), finished: t('cp_stage_finished') } as Record<string, string>)[s] || s;

  // 进入面试:内嵌 Exam(候选人模式,凭 token 连入;id 空占位——后端凭 token 权威定位会话)。
  if (entering) {
    return <Exam id="" candidateToken={token} />;
  }

  return (
    <div className="cand-portal">
      <div className="cand-card">
        <div className="cand-head">
          <div className="cand-logo">VivaVoce</div>
          <h1 className="cand-title">{t('cp_title')}</h1>
          <p className="cand-sub">{t('cp_sub')}</p>
        </div>

        {err && <div className="login-err">{err}</div>}
        {notice && <div className="cand-notice">{notice}</div>}

        {loading ? (
          <div className="empty-state">{t('loading')}</div>
        ) : status?.booked && !rescheduling ? (
          // ── 已预约:状态卡 ──
          <div className="cand-booked">
            <div className={'cand-stage cand-stage-' + status.stage}>{stageLabel(status.stage)}</div>
            <div className="cand-slot-time">
              {fmtDateTime(status.meeting_start)} ~ {fmtDateTime(status.meeting_end)}
            </div>
            <p className="cand-hint">{t('cp_booked_hint')}</p>
            {/* 进入面试 CTA(design contract-C 收口):到窗(canJoinNow)或进行中 → 可连入实时对话。
                后端 /candidate/join 权威校验窗口,前端只做"到窗才亮按钮"的体验优化(未到窗也可点但会 409)。 */}
            {(status.stage === 'in_progress' || canJoinNow(status)) && (
              <div className="cand-actions">
                <button className="btn btn-primary" onClick={() => setEntering(true)}>
                  🎤 {t('cp_enter_interview')}
                </button>
              </div>
            )}
            {/* 仅未开始(booked)可改约/取消;进行中/已完成不可 */}
            {status.stage === 'booked' && (
              <div className="cand-actions">
                <button className="btn" disabled={busy} onClick={loadSlotsForReschedule}>
                  {t('cp_reschedule')}
                </button>
                <button className="btn btn-danger" disabled={busy} onClick={doCancel}>
                  {t('cp_cancel_booking')}
                </button>
              </div>
            )}
          </div>
        ) : (
          // ── 未预约 / 改约中:时段列表 ──
          <div className="cand-booking">
            {rescheduling && (
              <div className="cand-reschedule-bar">
                {t('cp_reschedule_pick')}
                <button className="btn btn-sm" disabled={busy} onClick={() => setRescheduling(false)}>
                  {t('cancel')}
                </button>
              </div>
            )}
            {!rescheduling && (
              <label className="cand-consent">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>{t('cp_consent_label')}</span>
              </label>
            )}
            {slots.length === 0 ? (
              <div className="empty-state">{t('cp_no_slots')}</div>
            ) : (
              <ul className="cand-slots">
                {slots.map((s) => (
                  <li key={s.slot_id} className="cand-slot">
                    <span className="cand-slot-time">
                      {fmtDateTime(s.meeting_start)} ~ {fmtDateTime(s.meeting_end)}
                    </span>
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => (rescheduling ? doReschedule(s.slot_id) : doBook(s.slot_id))}
                    >
                      {rescheduling ? t('cp_pick') : t('cp_book')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
