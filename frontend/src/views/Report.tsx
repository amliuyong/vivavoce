'use client';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { t } from '@/lib/i18n';
import { useLang, useSession } from '@/lib/appState';
import { api, type Result, type TranscriptLine, ApiError } from '@/lib/api';
import { Loading, ErrorBanner, useToast } from '@/lib/ui';
import { navigate } from '@/lib/router';
import { scoreBand, scoreTotals } from '@/lib/score';

// design contract:报告页评测进行中轮询。结果未就绪(404)时并行看 session.status 区分状态,轮询到就绪自动显示。
const POLL_INTERVAL_MS = 4000; // 3–5s(带 jitter)
const POLL_MAX_MS = 180_000; // 上限 3min:覆盖 99% 正常+轻抖动;极端失败被拦住,不无限空转
type EvalPhase = 'loading' | 'ready' | 'evaluating' | 'not_finished' | 'no_result' | 'error';

// design contract:逐题分数三色档 + 逐题分制合计 —— 纯逻辑抽到 @/lib/score(与 test/score-band.test.js 共用同一实现,
//   消除测试复刻漂移,review)。scoreBand:<0.6 红 / [0.6,0.8] 黄 / >0.8 绿(严格大于才绿)。
//   scoreTotals:总分/满分 + 答对率(得分率),仅**每一题都有合法分**才 hasScore=true(否则回退,不给失真口径,review)。

/** 报告结果加载 + 评测进行中轮询(design contract)。返回 {result, phase, error, reload}。
 *  - result 200 → ready;
 *  - result 404 + session.status=completed → evaluating(轮询到就绪 / 超时);
 *  - result 404 + session.status=failed → no_result(不轮询);
 *  - result 404 + session.status=in_progress/scheduled → not_finished(不轮询)。 */
function useReportResult(id: string): { result: Result | null; phase: EvalPhase; errMsg: string; reload: () => void } {
  const [result, setResult] = useState<Result | null>(null);
  const [phase, setPhase] = useState<EvalPhase>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const r = await api.getResult(id);
        if (cancelled) return;
        setResult(r);
        // design contract:打分失败标记(evaluator 跨境 LLM 失败)→ 显示「评测失败」而非空报告(不轮询)。
        if (r.evaluation_error) {
          setErrMsg(t('rp_eval_failed'));
          setPhase('error');
          return;
        }
        setPhase('ready'); // 就绪 → 停轮询(不再排下一次)
        return;
      } catch (e) {
        if (cancelled) return;
        const status = e instanceof ApiError ? e.status : 0;
        if (status !== 404) {
          setErrMsg(e instanceof Error ? e.message : String(e));
          setPhase('error');
          return;
        }
        // 404:并行看 session 状态区分「评测中 / 未结束 / 失败」
        let sessStatus = '';
        try {
          const s = await api.getSession(id);
          sessStatus = s.status || '';
        } catch { /* session 也取不到 → 当评测中兜底轮询 */ }
        if (cancelled) return;
        if (sessStatus === 'failed') { setPhase('no_result'); return; } // 不轮询
        if (sessStatus === 'in_progress' || sessStatus === 'scheduled') { setPhase('not_finished'); return; }
        // completed(或未知)+ 404 → 评测中,轮询到就绪 / 超时
        setPhase('evaluating');
        if (Date.now() - startedAt >= POLL_MAX_MS) return; // 超时:停在 evaluating,提示稍后刷新
        const jitter = Math.floor(POLL_INTERVAL_MS * (0.8 + Math.random() * 0.4));
        timer = setTimeout(poll, jitter);
      }
    }
    setPhase('loading');
    setResult(null);
    setErrMsg('');
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [id, tick]);

  return { result, phase, errMsg, reload };
}

/** 结果报告(admin 可复核;staff 只读自己的简版,staffMode=true)。 */
export function Report({ id, staffMode = false }: { id: string; staffMode?: boolean }) {
  useLang();
  const session = useSession();
  const { toast } = useToast();
  const { result: data, phase, errMsg, reload } = useReportResult(id);
  const [busy, setBusy] = useState(false);
  // 复核备注(P1-3):override/approve 时随附理由,后端 review_note 落库,供审计与二次复核追溯。
  const [reviewNote, setReviewNote] = useState('');
  // 内联转写(P2-12):展开后就地阅读完整对话,复核者核对 AI 打分证据无需下载 txt 另开。
  const [transcript, setTranscript] = useState<TranscriptLine[] | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  // ★ id 变化时重置报告本地 state(review 在同一组件位置渲染不同报告,React 复用实例 →
  //   否则从报告 A 切到 B 会显示 A 缓存的转写、甚至把 A 的复核备注误提交给 B。数据串号,必须重置)。
  useEffect(() => {
    setReviewNote('');
    setTranscript(null);
    setTranscriptOpen(false);
    setTranscriptBusy(false);
  }, [id]);
  // 录音回放(design contract):<audio> 引用,关键摘录点击按 audio_offset_s 跳点播放。
  const audioRef = useRef<HTMLAudioElement>(null);

  // 跳点回放:把录音定位到摘录的偏移秒并播放(无录音 URL 时无操作)。
  function seekTo(offsetS: number) {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = offsetS;
    void a.play().catch(() => {/* 自动播放被拦截:用户可手动点播放器 */});
  }

  // 转写下载(design contract):取整场转写,拼成纯文本下载(浏览器端,带鉴权经 api 客户端)。
  async function downloadTranscript() {
    setBusy(true);
    try {
      const tr = await api.getTranscript(id);
      const text = (tr.lines || [])
        .map((l) => `[${l.ts || ''}] ${l.speaker === 'ai' ? 'AI' : (l.speaker || '?')}: ${l.text || ''}`)
        .join('\n');
      const blob = new Blob([text || ''], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = `transcript-${id}.txt`;
        a.click();
      } finally {
        URL.revokeObjectURL(url); // 错误路径也释放,避免 blob URL 泄漏
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : t('error_generic'));
    } finally {
      setBusy(false);
    }
  }

  // 内联转写(P2-12):首次展开时懒加载,就地阅读完整对话核对证据。
  async function toggleTranscript() {
    if (transcriptOpen) {
      setTranscriptOpen(false);
      return;
    }
    setTranscriptOpen(true);
    if (transcript !== null) return; // 已加载,直接展开
    setTranscriptBusy(true);
    try {
      const tr = await api.getTranscript(id);
      setTranscript(tr.lines || []);
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : t('error_generic'));
      setTranscriptOpen(false);
    } finally {
      setTranscriptBusy(false);
    }
  }

  const backHash = staffMode ? '#/my-meetings' : '#/sessions';

  if (phase === 'loading') return <Loading label={t('loading')} />;
  // design contract:非就绪各态就地显示(评测中显示轮询提示,不需用户手动刷新)。
  if (phase !== 'ready' || !data) {
    const msg =
      phase === 'evaluating' ? t('rp_evaluating')
      : phase === 'not_finished' ? t('rp_not_finished')
      : phase === 'no_result' ? t('rp_no_result')
      : phase === 'error' ? (errMsg || t('rp_not_ready'))
      : t('rp_not_ready');
    return (
      <div className="page">
        <span className="btn btn-ghost btn-sm" onClick={() => navigate(backHash)}>
          {t('rp_back')}
        </span>
        <div className="card card-pad" style={{ marginTop: 12 }}>
          <div className="empty-state">{msg}</div>
        </div>
      </div>
    );
  }
  const r = data as Result;

  const isCheck = (r.rubric_mode || (r.question_checks ? 'per_question_check' : 'dimension_score')) === 'per_question_check';
  // dimension_score 模式的通过线(0~1);AI 不产出 passed,按分数 vs 阈值判定。
  // ★ 与 design contract per_question 三色档的 0.6 数值巧合但**语义独立**(review):DIM_PASS 是 dimension
  //   模式整场通过线(判 verdict),三色档 0.6 是 per_question 单题显示分档;二者互不影响,勿混用。
  const DIM_PASS = 0.6;
  // 综合判定:人工改判优先,否则 AI 判定。按 rubric 形态分流(design contract review):
  //   check 模式看 passed;dimension 模式根本没有 passed,看 overall_score vs 阈值(否则维度结果永远「待定」)。
  const effScore = r.review_overall_score != null ? r.review_overall_score : r.overall_score;
  const effectivePassed = isCheck
    ? (r.review_passed != null ? r.review_passed : r.passed)
    : (effScore != null ? effScore >= DIM_PASS : null);
  // design contract 逐题分制:总分/满分 + 答对率(得分率)。仅 check 模式且有合法逐题分时展示(dimension 模式看 overall_score)。
  const totals = isCheck ? scoreTotals(r.question_checks) : { hasScore: false as const };

  async function review(action: 'approve' | 'override', passed?: boolean) {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { action };
      if (action === 'override' && passed != null) {
        // check 模式发 passed;dimension 模式发 overall_score(通过/不通过映射到阈值上下,
        // 否则后端写 review_passed 对维度结果无效,刷新仍显示 AI 原分,design contract review)。
        if (isCheck) body.passed = passed;
        else body.overall_score = passed ? Math.max(DIM_PASS, 0.8) : Math.min(DIM_PASS - 0.01, 0.4);
      }
      // 复核备注(可选):后端 review_note 落库(P1-3,审计追溯)。
      const note = reviewNote.trim();
      if (note) body.note = note;
      await api.reviewResult(id, body);
      toast(t('rp_review_done'));
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : t('error_generic'));
    } finally {
      setBusy(false);
    }
  }

  let verdictCls = 'verdict-pass';
  let verdictTxt = t('rp_verdict_pending');
  if (effectivePassed === true) {
    verdictTxt = t('rp_verdict_pass');
    verdictCls = 'verdict-pass';
  } else if (effectivePassed === false) {
    verdictTxt = t('rp_verdict_fail');
    verdictCls = 'pp-bad';
  }

  return (
    <div className="page">
      <span className="btn btn-ghost btn-sm" onClick={() => navigate(backHash)}>
        {staffMode ? t('mr_back') : t('rp_back')}
      </span>
      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="result-head">
          <div>
            <h1 className="page-title" style={{ fontSize: 19 }}>
              {staffMode ? t('mr_title') : t('rp_title_prefix')}: {r.session_id}
            </h1>
            <div className="verdict-meta">
              {r.agent_id} {r.agent_version ? `· ${r.agent_version}` : ''}
              {r.review_status && r.review_status !== 'pending' ? ` · ${r.review_status}` : ''}
            </div>
            {/* 复核信息回显(P1-3):谁在何时改判 + 备注,供二次复核/审计追溯 */}
            {r.review_status && r.review_status !== 'pending' && (r.reviewer || r.reviewed_at || r.review_note) && (
              <div className="review">
                {r.reviewer && <span>{t('rp_reviewed_by')}: {r.reviewer}</span>}
                {r.reviewed_at && <span> · {r.reviewed_at}</span>}
                {r.review_note && <div className="review">“{r.review_note}”</div>}
              </div>
            )}
          </div>
          <span className="verdict" style={verdictCls === 'pp-bad' ? { background: 'var(--red-bg)', color: 'var(--red)' } : { background: 'var(--green-bg)', color: 'var(--green)' }}>
            {verdictTxt}
            {/* 徽章百分比:check 模式优先显**答对率(得分率 Σscore/Σmax)**——即用户要的「38/50」口径;
                无逐题分(旧结果)回退 pass_ratio(题通过率);dimension 模式显 overall_score。 */}
            {isCheck
              ? (totals.hasScore
                  ? ` · ${Math.round(totals.ratio * 100)}%`
                  : (r.pass_ratio != null ? ` · ${Math.round(r.pass_ratio * 100)}%` : ''))
              : (effScore != null ? ` · ${Math.round(effScore * 100)}%` : '')}
          </span>
        </div>

        {/* design contract:逐题分制总览——总分 X/Y + 答对率(得分率)。仅 check 模式有合法逐题分时显示;
            与徽章的题通过率(pass_ratio)是不同口径,这里给的是「得分/满分」。 */}
        {isCheck && totals.hasScore && (
          <div className="score-summary">
            <div className="ss-item">
              <span className="ss-k">{t('rp_total_score')}</span>
              <span className="ss-v">{+totals.sum.toFixed(1)}<span className="ss-max"> / {+totals.max.toFixed(1)}</span></span>
            </div>
            <div className="ss-item">
              <span className="ss-k">{t('rp_correct_rate')}</span>
              <span className="ss-v">{Math.round(totals.ratio * 100)}%</span>
            </div>
          </div>
        )}

        {/* 各题得分柱状图(design contract):每题一根柱,高度 = score/max_score,三色档同徽章配色;纯 SVG/CSS 无依赖。 */}
        {isCheck && totals.hasScore && (
          <div className="score-chart">
            <p className="sec-title">{t('rp_score_chart')}</p>
            <div className="sc-bars">
              {(r.question_checks || []).map((q, i) => {
                const band = scoreBand(q.score, q.max_score);
                const pct = band.hasScore ? Math.round(band.ratio * 100) : 0;
                const qn = q.index ?? i + 1;
                const label = t('rp_chart_qn').replace('{n}', String(qn));
                const title = band.hasScore ? `${label}: ${q.score}/${q.max_score}` : label;
                return (
                  <div className="sc-col" key={q.index ?? i} title={title}>
                    <div className="sc-track">
                      <div
                        className={'sc-fill ' + (band.hasScore ? 'sb-' + band.color : 'sb-na')}
                        style={{ height: pct + '%' }}
                        aria-label={title}
                      />
                    </div>
                    <div className="sc-val">{band.hasScore ? +(q.score as number).toFixed(1) : '—'}</div>
                    <div className="sc-x">{qn}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="result-grid">
          <div>
            {isCheck ? (
              <>
                <p className="sec-title">{t('rp_checklist')}</p>
                {(r.question_checks || []).map((q, i) => {
                  // design contract:有合法 score → 分数三色档徽章;无 score(旧结果/LLM 漏返/非法值)→ 回退 ✓/✗(不 NaN)。
                  const band = scoreBand(q.score, q.max_score);
                  return (
                  <div className="check-item" key={i}>
                    {band.hasScore ? (
                      <div className={'score-badge sb-' + band.color} title={t('rp_q_score')}>
                        {q.score}<span className="sb-max">/{q.max_score}</span>
                      </div>
                    ) : (
                      <div className={'check-mark ' + (q.passed ? 'cm-pass' : 'cm-fail')}>{q.passed ? '✓' : '✗'}</div>
                    )}
                    <div>
                      <div className="check-q">{q.question}</div>
                      {/* design contract:逐题补考生回答 + 点评(旧结果无则不显示) */}
                      {q.user_answer && <div className="check-ans"><b>{t('rp_user_answer')}</b>{q.user_answer}</div>}
                      {q.comment && <div className="check-ans"><b>{t('rp_comment')}</b>{q.comment}</div>}
                      {q.evidence && <div className="check-ans">{q.evidence}</div>}
                    </div>
                  </div>
                  );
                })}
                {(r.question_checks || []).length === 0 && <div className="empty-state">{t('empty_list')}</div>}
              </>
            ) : (
              <>
                <p className="sec-title">{t('rp_dims')}</p>
                {(r.dimension_scores || []).map((d, i) => {
                  const pct = d.max_score ? Math.round((d.score / d.max_score) * 100) : 0;
                  return (
                    <div className="dim-row" key={i}>
                      <div className="dim-top">
                        <span>{d.name}</span>
                        <b>
                          {d.score} / {d.max_score}
                        </b>
                      </div>
                      <div className="dim-bar">
                        <span style={{ width: pct + '%', background: pct < 60 ? 'var(--amber)' : undefined }} />
                      </div>
                      {d.comment && <div className="check-ans">{d.comment}</div>}
                    </div>
                  );
                })}
                {(r.dimension_scores || []).length === 0 && <div className="empty-state">{t('empty_list')}</div>}
                {/* design contract:dimension 模式并列逐题分析(与维度分独立;缺项/旧结果无则不显示本区块) */}
                {(r.question_analyses || []).length > 0 && (
                  <>
                    <p className="sec-title" style={{ marginTop: 16 }}>{t('rp_per_question')}</p>
                    {(r.question_analyses || []).map((q, i) => (
                      <div className="check-item" key={i}>
                        <div className="check-mark">{q.index ?? i + 1}</div>
                        <div>
                          {q.question && <div className="check-q">{q.question}</div>}
                          {q.user_answer && <div className="check-ans"><b>{t('rp_user_answer')}</b>{q.user_answer}</div>}
                          {q.comment && <div className="check-ans"><b>{t('rp_comment')}</b>{q.comment}</div>}
                          {q.score != null && (
                            <div className="check-ans"><b>{t('rp_q_score')}</b>{q.score}{q.max_score != null ? ` / ${q.max_score}` : ''}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          <div>
            <p className="sec-title">{t('rp_ai_summary')}</p>
            <div className="summary-text">{r.summary || '—'}</div>
            {(r.excerpts || []).length > 0 && (
              <>
                <p className="sec-title" style={{ marginTop: 18 }}>
                  {t('rp_key_excerpts')}
                </p>
                {(r.excerpts || []).map((ex, i) => (
                  <div className="excerpt" key={i}>
                    <div className="ea">{ex.text}</div>
                    {ex.audio_offset_s != null &&
                      // 有录音才可点跳点;无录音 URL 时仍显示偏移但不可点(empty-link)
                      (r.recording_url ? (
                        <span
                          className="ejump"
                          role="button"
                          title={t('rp_jump_play')}
                          onClick={() => seekTo(ex.audio_offset_s as number)}
                        >
                          ▶ {Math.floor(ex.audio_offset_s)}s
                        </span>
                      ) : (
                        <span className="ejump empty-link">▶ {Math.floor(ex.audio_offset_s)}s</span>
                      ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* 录音播放器(design contract):有限时预签名 URL 才渲染;摘录跳点经 seekTo 控制此元素 */}
        {r.recording_url && (
          <audio ref={audioRef} src={r.recording_url} controls preload="none" style={{ width: '100%', marginTop: 12 }} />
        )}

        <div className="result-foot">
          {r.recording_url ? (
            <a className="btn" href={r.recording_url} target="_blank" rel="noopener noreferrer">
              {t('rp_play_rec')}
            </a>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-mute)' }}>{t('rp_no_recording')}</span>
          )}
          <button className="btn btn-sm" disabled={transcriptBusy} onClick={toggleTranscript}>
            {transcriptOpen ? t('rp_hide_transcript') : t('rp_view_transcript')}
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={downloadTranscript}>
            {t('rp_download_transcript')}
          </button>
        </div>

        {/* 内联转写(P2-12):就地阅读完整对话,复核者核对 AI 打分证据无需下载 txt 另开 */}
        {transcriptOpen && (
          <div className="transcript-static" style={{ marginTop: 8 }}>
            {transcriptBusy ? (
              <Loading label={t('loading')} />
            ) : (transcript && transcript.length > 0) ? (
              transcript.map((l, i) => (
                <div key={i} className={'bubble ' + (l.speaker === 'ai' ? 'b-ai' : 'b-human')}>
                  <div className="who">{l.speaker === 'ai' ? t('exam_speaker_ai') : t('exam_speaker_me')}</div>
                  {l.text}
                </div>
              ))
            ) : (
              <div className="empty-state">{t('empty_list')}</div>
            )}
          </div>
        )}

        {/* 人工复核(仅 admin,非 staff)。三个动作语义对齐后端 approve/override(design contract):
            ✓通过 = 人工改判为通过(override true);补训/不通过 = 改判不通过(override false);
            采纳AI = approve(认可 AI 原判,不改判)。此前「通过」误接 approve、「待复核」误接 override-pass(标签与动作错位)。 */}
        {!staffMode && session?.isAdmin && (
          <div className="review">
            <label className="review" htmlFor="review">{t('rp_review_note')}</label>
            <textarea
              id="review"
              className="input"
              rows={2}
              value={reviewNote}
              placeholder={t('rp_review_note_ph')}
              onChange={(e) => setReviewNote(e.target.value)}
              style={{ width: '100%', resize: 'vertical', marginBottom: 10 }}
            />
            <div className="mark-group" style={{ marginLeft: 0 }}>
              <span className="ml">{t('rp_review_mark')}</span>
              <button className="btn btn-sm" disabled={busy} onClick={() => review('override', true)}>
                {t('verdict_pass')}
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => review('override', false)}>
                {t('verdict_retrain')}
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => review('approve')}>
                {t('verdict_approve_ai')}
              </button>
            </div>
          </div>
        )}
        <ErrorBanner message={''} />
      </div>
    </div>
  );
}
