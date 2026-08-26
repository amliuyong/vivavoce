'use client';
import React, { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { useLang } from '@/lib/appState';
import { api, type QuestionBank, type Question, type QuestionBankUploadResult, ApiError } from '@/lib/api';
import { Loading, ErrorBanner, useToast } from '@/lib/ui';
import { navigate } from '@/lib/router';

// difficulty 契约(design contract):整数 [1,5],缺省 3。
const DEFAULT_DIFFICULTY = 3;

// CSV 模板(客户端生成,免鉴权下载):表头 + 一行示例。与 backend question-banks/csv-template 一致。
const CSV_TEMPLATE =
  'text,reference_answer,weight,difficulty\r\n' +
  '请简单介绍一下你自己,期望涵盖经历与技能,1.0,2\r\n';

const EMPTY: QuestionBank = {
  question_bank_id: '',
  name: '',
  labels: [],
  questions: [],
};

export function QuestionBankEditor({ id, isNew }: { id?: string; isNew?: boolean }) {
  useLang();
  const { toast } = useToast();
  const [b, setB] = useState<QuestionBank | null>(isNew ? { ...EMPTY } : null);
  const [loadErr, setLoadErr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // ── CSV 批量上传(免逐题手加)──
  const [csvMode, setCsvMode] = useState<'append' | 'replace'>('append');
  const [csvResult, setCsvResult] = useState<QuestionBankUploadResult | null>(null);

  useEffect(() => {
    if (isNew) {
      setB({ ...EMPTY, questions: [], labels: [] });
      return;
    }
    if (!id) return;
    api
      .getQuestionBank(id)
      .then((data) =>
        setB({
          ...EMPTY,
          ...data,
          questions: data.questions || [],
          labels: data.labels || [],
        }),
      )
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, [id, isNew]);

  if (loadErr)
    return (
      <div className="page">
        <span className="btn btn-ghost btn-sm" onClick={() => navigate('#/question-banks')}>
          {t('qb_back')}
        </span>
        <ErrorBanner message={loadErr} />
      </div>
    );
  if (!b) return <Loading label={t('loading')} />;

  const setField = (patch: Partial<QuestionBank>) => setB({ ...b, ...patch });

  function updateQuestion(i: number, patch: Partial<Question>) {
    const qs = [...(b!.questions || [])];
    qs[i] = { ...qs[i], ...patch };
    setField({ questions: qs });
  }
  function addQuestion() {
    setField({
      questions: [
        ...(b!.questions || []),
        { text: '', reference_answer: '', weight: 1, difficulty: DEFAULT_DIFFICULTY },
      ],
    });
  }
  function removeQuestion(i: number) {
    setField({ questions: (b!.questions || []).filter((_, j) => j !== i) });
  }

  function buildBody(): Record<string, unknown> {
    return {
      name: b!.name,
      labels: b!.labels || [],
      questions: b!.questions || [],
    };
  }

  // 下载 CSV 模板(客户端生成 Blob,免鉴权)。Excel 友好:加 UTF-8 BOM 防中文乱码。
  function downloadCsvTemplate() {
    const blob = new Blob(['﻿' + CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'question-bank-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // 上传 CSV:读文件文本 → 调后端(mode=追加/替换)→ 展示 ✓/✗ 统计 + 错误明细 → 刷新本地题目列表。
  async function uploadCsv(file: File) {
    setErr('');
    setCsvResult(null);
    setBusy(true);
    try {
      const text = await file.text();
      const res = await api.uploadQuestionBankCsv(id!, text, csvMode);
      setCsvResult(res);
      // 后端已写库(改版);重新拉取使本地题目列表反映最新(避免本地 b.questions 与库不一致)。
      const fresh = await api.getQuestionBank(id!);
      setB({ ...b!, questions: fresh.questions || [] });
      toast(t('qb_csv_done'));
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setErr('');
    if (!b!.name.trim()) {
      setErr(t('ed_name'));
      return;
    }
    setBusy(true);
    try {
      if (isNew) {
        const created = await api.createQuestionBank(buildBody());
        toast(t('qb_saved'));
        navigate(`#/question-banks/edit/${created.question_bank_id}`);
      } else {
        await api.updateQuestionBank(id!, buildBody());
        toast(t('qb_saved'));
        navigate('#/question-banks');
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <span className="btn btn-ghost btn-sm" onClick={() => navigate('#/question-banks')}>
        {t('qb_back')}
      </span>
      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="page-head" style={{ marginBottom: 14 }}>
          <h1 className="page-title" style={{ fontSize: 19 }}>
            {isNew ? t('qb_title_new') : `${b.name} ${b.version || ''}`}
          </h1>
        </div>

        <ErrorBanner message={err} />

        <div className="field">
          <label>{t('ed_name')}</label>
          <input className="input" type="text" value={b.name} onChange={(e) => setField({ name: e.target.value })} />
        </div>
        <div className="field">
          <label>{t('ed_labels')}</label>
          <input
            className="input"
            type="text"
            value={(b.labels || []).join(', ')}
            onChange={(e) =>
              setField({ labels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
            }
          />
        </div>

        {/* 题目编辑(复用原 ProfileEditor kb tab 逻辑 + 新增 difficulty) */}
        {(b.questions || []).map((q, i) => (
          <div className="q-item" key={i}>
            <div className="q-head">
              <span className="q-num">{i + 1}</span>
              <input
                className="input q-title"
                type="text"
                placeholder={t('ed_q_text')}
                value={q.text}
                onChange={(e) => updateQuestion(i, { text: e.target.value })}
              />
            </div>
            <textarea
              className="input q-ref"
              style={{ width: '100%', minHeight: 48 }}
              placeholder={t('ed_q_ref')}
              value={q.reference_answer || ''}
              onChange={(e) => updateQuestion(i, { reference_answer: e.target.value })}
            />
            <div className="q-foot">
              {/* design contract:题目级 follow_up 已废弃(追问=Agent 人设行为),移除「允许追问」开关。 */}
              <span className="with-suffix">
                {t('ed_q_weight')}:
                <input
                  className="input"
                  type="number"
                  step="0.1"
                  style={{ width: 70 }}
                  value={q.weight ?? 1}
                  onChange={(e) => updateQuestion(i, { weight: Number(e.target.value) })}
                />
              </span>
              <span className="with-suffix">
                {t('ed_difficulty')}:
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={5}
                  step={1}
                  style={{ width: 70 }}
                  value={q.difficulty ?? DEFAULT_DIFFICULTY}
                  onChange={(e) =>
                    updateQuestion(i, {
                      // 难度 UI 钳到 [1,5]、取整;后端仍会兜底,这里只做友好约束。
                      difficulty: Math.min(5, Math.max(1, Math.floor(Number(e.target.value)) || DEFAULT_DIFFICULTY)),
                    })
                  }
                />
              </span>
              <button className="btn-link" onClick={() => removeQuestion(i)}>
                {t('delete')}
              </button>
            </div>
          </div>
        ))}
        <button className="btn btn-sm" onClick={addQuestion}>
          {t('ed_add_q')}
        </button>

        {/* ── CSV 批量上传(免逐题手加)── 仅已保存题库可用(上传需题库 id) */}
        <div className="card card-pad" style={{ marginTop: 16, background: 'var(--surface-2, #f8f8fb)' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('qb_csv_title')}</div>
          {isNew ? (
            <div style={{ color: 'var(--text-mute)', fontSize: 13 }}>{t('qb_csv_save_first')}</div>
          ) : (
            <>
              <div style={{ fontSize: 13, color: 'var(--text-mute)', marginBottom: 8 }}>{t('qb_csv_hint')}</div>
              <div className="inline-actions" style={{ marginBottom: 8, gap: 16, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 13 }}>
                  <input type="radio" name="csvMode" checked={csvMode === 'append'}
                    onChange={() => setCsvMode('append')} disabled={busy} /> {t('qb_csv_append')}
                </label>
                <label style={{ fontSize: 13 }}>
                  <input type="radio" name="csvMode" checked={csvMode === 'replace'}
                    onChange={() => setCsvMode('replace')} disabled={busy} /> {t('qb_csv_replace')}
                </label>
                <button className="btn-link" onClick={downloadCsvTemplate} type="button">{t('qb_csv_template')}</button>
              </div>
              <input type="file" accept=".csv,text/csv" disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadCsv(f);
                  e.target.value = ''; // 允许重复选同一文件
                }} />
              {csvResult && (
                <div style={{ marginTop: 10, fontSize: 13 }}>
                  <div>
                    {t('qb_csv_imported')}: <b>{csvResult.imported}</b> · {t('qb_csv_rejected')}:{' '}
                    <b style={{ color: csvResult.rejected ? 'var(--danger, #c0392b)' : 'inherit' }}>{csvResult.rejected}</b>
                    {' · '}{t('qb_csv_total')}: <b>{csvResult.total_questions}</b>
                  </div>
                  {!!csvResult.errors?.length && (
                    <ul style={{ marginTop: 6, color: 'var(--danger, #c0392b)', maxHeight: 160, overflow: 'auto' }}>
                      {csvResult.errors.map((er, i) => (
                        <li key={i}>{t('qb_csv_line')} {er.line}: {er.reason}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="editor-foot">
          <button className="btn" onClick={() => navigate('#/question-banks')} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? t('loading') : isNew ? t('ed_save') : t('ed_save_new_version')}
          </button>
        </div>
      </div>
    </div>
  );
}
