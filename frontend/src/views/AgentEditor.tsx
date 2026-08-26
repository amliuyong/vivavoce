'use client';
import React, { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { useLang } from '@/lib/appState';
import {
  api,
  type Agent,
  type QuestionBank,
  type QuestionStrategy,
  type RubricDimension,
  ApiError,
} from '@/lib/api';
import { Loading, ErrorBanner, useToast } from '@/lib/ui';
import { navigate } from '@/lib/router';

// design contract:Agent 不再内嵌题目,删 kb tab,保留 persona/rubric/engine 三 tab。
type Tab = 'persona' | 'rubric' | 'engine';

// random 类策略才需要 strategy_n(抽题数)。
const RANDOM_STRATEGIES: QuestionStrategy[] = ['random_n', 'random_n_easy_to_hard'];

// 剔除对象里值为 null/undefined 的键 —— 合并进带默认值的基对象时,不让 null 覆盖默认(见 engine 合并)。
function stripNullish<T extends object>(obj: T | null | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v != null),
  ) as Partial<T>;
}

const EMPTY: Agent = {
  agent_id: '',
  name: '',
  labels: [],
  system_prompt: '',
  rubric: { mode: 'per_question_check', pass_threshold: 0.8 },
  engine: { engine_type: 'three_stage', language: 'zh-CN', voice: 'male_std', max_duration_s: 1800, max_turns: 9999 },
  question_strategy: 'sequential',
  strategy_n: null,
  default_question_bank_id: null,
  self_bookable: false,
  // 实时字幕显示开关(design contract):Agent **顶层**呈现字段(非 engine 嵌套)。新建默认开(勾选)= 现状 design contract。
  show_subtitles: true,
  // 头像风格(design contract):舞台中央视觉主体。新建默认 minimal(极简线条)。
  avatar_style: 'minimal',
  // 声纹锁定说话人(design contract):抗旁人打断。新建默认锁定(勾选)= 设计决策默认开。
  speaker_lock: true,
};

export function AgentEditor({ id, isNew }: { id?: string; isNew?: boolean }) {
  useLang();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('persona');
  const [p, setP] = useState<Agent | null>(isNew ? { ...EMPTY } : null);
  const [banks, setBanks] = useState<QuestionBank[]>([]);
  // 切换出题策略时内存保留旧的 strategy_n(便于改回 random 策略时复用),提交时非 random 不传。
  const [nDraft, setNDraft] = useState<number>(5);
  const [loadErr, setLoadErr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 默认题库下拉数据(design contract)。
    api.listQuestionBanks().then(setBanks).catch(() => {});
  }, []);

  useEffect(() => {
    if (isNew) {
      setP({ ...EMPTY, labels: [] });
      return;
    }
    if (!id) return;
    api
      .getAgent(id)
      .then((data) => {
        setP({
          ...EMPTY,
          ...data,
          rubric: { ...EMPTY.rubric!, ...(data.rubric || {}) },
          // 合并 engine 时剔除后端返回的 null/undefined,否则会**覆盖** EMPTY 的默认值(尤其 voice):
          // 旧 agent 存了 voice:null → 下拉框 `value || 'male_std'` 显示"男音"但 state 是 null,保存回写 null
          // → GPU 回退 female_std(女音),与 UI 显示矛盾。剔除 null 后 voice 回落 'male_std',所见即所存。
          engine: { ...EMPTY.engine!, ...stripNullish(data.engine) },
          labels: data.labels || [],
        });
        if (typeof data.strategy_n === 'number' && data.strategy_n > 0) setNDraft(data.strategy_n);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, [id, isNew]);

  if (loadErr)
    return (
      <div className="page">
        <span className="btn btn-ghost btn-sm" onClick={() => navigate('#/agents')}>
          {t('ed_back')}
        </span>
        <ErrorBanner message={loadErr} />
      </div>
    );
  if (!p) return <Loading label={t('loading')} />;

  const setField = (patch: Partial<Agent>) => setP({ ...p, ...patch });
  const setRubric = (patch: Partial<NonNullable<Agent['rubric']>>) =>
    setP({ ...p, rubric: { ...(p.rubric || { mode: 'per_question_check' }), ...patch } });
  const setEngine = (patch: Partial<NonNullable<Agent['engine']>>) =>
    setP({ ...p, engine: { ...(p.engine || {}), ...patch } });

  const isRandom = RANDOM_STRATEGIES.includes(p.question_strategy || 'sequential');

  function updateDim(i: number, patch: Partial<RubricDimension>) {
    const ds = [...(p!.rubric?.dimensions || [])];
    ds[i] = { ...ds[i], ...patch };
    setRubric({ dimensions: ds });
  }
  function addDim() {
    setRubric({ dimensions: [...(p!.rubric?.dimensions || []), { name: '', weight: 1, max_score: 10, description: '' }] });
  }
  function removeDim(i: number) {
    setRubric({ dimensions: (p!.rubric?.dimensions || []).filter((_, j) => j !== i) });
  }

  function buildBody(): Record<string, unknown> {
    const rubric =
      p!.rubric?.mode === 'dimension_score'
        ? { mode: 'dimension_score', dimensions: p!.rubric.dimensions || [] }
        : { mode: 'per_question_check', pass_threshold: p!.rubric?.pass_threshold ?? 0.8 };
    const strategy = p!.question_strategy || 'sequential';
    // voice 兜底:UI 下拉框恒显示 `voice || 'male_std'`,但 state 里可能因旧数据是 null。提交时
    // 显式补齐成下拉框所示值,保证"所见即所存"——否则回写 null 会让 GPU 回退 female_std(女音)。
    const engine = { ...(p!.engine || {}), voice: p!.engine?.voice || 'male_std' };
    return {
      name: p!.name,
      labels: p!.labels || [],
      system_prompt: p!.system_prompt || '',
      rubric,
      engine,
      question_strategy: strategy,
      // 仅 random 类策略传 strategy_n;其余策略传 undefined(后端忽略)。
      strategy_n: RANDOM_STRATEGIES.includes(strategy) ? nDraft : undefined,
      default_question_bank_id: p!.default_question_bank_id || null,
      self_bookable: !!p!.self_bookable,
      // 实时字幕显示开关(design contract):顶层字段;编辑旧 Agent 缺字段 → `?? true` 兜底默认开(review),
      // 保证提交 boolean(不回写 undefined)。唯用户显式关成 false 才关。
      show_subtitles: p!.show_subtitles ?? true,
      // 头像风格(design contract):编辑旧 Agent 缺字段 → 兜底 minimal(合法四枚举才提交,防脏值)。
      avatar_style: (['minimal', 'round', 'tech', 'waveform'] as const).includes(p!.avatar_style as never)
        ? p!.avatar_style
        : 'minimal',
      // 声纹锁定(design contract):顶层字段;编辑旧 Agent 缺字段 → `?? true` 兜底默认锁(设计决策默认开)。
      // 唯用户显式关成 false 才关。
      speaker_lock: p!.speaker_lock ?? true,
    };
  }

  async function save() {
    setErr('');
    if (!p!.name.trim()) {
      setErr(t('ed_name'));
      setTab('persona');
      return;
    }
    setBusy(true);
    try {
      if (isNew) {
        const created = await api.createAgent(buildBody());
        toast(t('ed_saved'));
        navigate(`#/agents/edit/${created.agent_id}`);
      } else {
        await api.updateAgent(id!, buildBody());
        toast(t('ed_saved'));
        navigate('#/agents');
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const tabs: { k: Tab; label: string }[] = [
    { k: 'persona', label: t('ed_tab_persona') },
    { k: 'rubric', label: t('ed_tab_rubric') },
    { k: 'engine', label: t('ed_tab_engine') },
  ];

  return (
    <div className="page">
      <span className="btn btn-ghost btn-sm" onClick={() => navigate('#/agents')}>
        {t('ed_back')}
      </span>
      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="page-head" style={{ marginBottom: 14 }}>
          <h1 className="page-title" style={{ fontSize: 19 }}>
            {isNew ? t('ed_title_new') : `${p.name} ${p.version || ''}`}
          </h1>
          {!isNew && p.agent_id && (
            // 一键语音对话:深链到语音 Chat 用当前 Agent 自动开始(发起逻辑收口在 VoiceChat)。
            <button
              className="btn btn-primary btn-sm"
              onClick={() => navigate(`#/voice-chat?agent=${p.agent_id}`)}
            >
              {t('ed_start_chat')}
            </button>
          )}
        </div>

        <ErrorBanner message={err} />

        <div className="tabs">
          {tabs.map((tb) => (
            <div key={tb.k} className={'tab' + (tab === tb.k ? ' active' : '')} onClick={() => setTab(tb.k)}>
              {tb.label}
            </div>
          ))}
        </div>

        {tab === 'persona' && (
          <div className="tabpane active">
            <div className="field">
              <label>{t('ed_name')}</label>
              <input className="input" type="text" value={p.name} onChange={(e) => setField({ name: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('ed_labels')}</label>
              <input
                className="input"
                type="text"
                value={(p.labels || []).join(', ')}
                onChange={(e) =>
                  setField({ labels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
                }
              />
            </div>
            <div className="field">
              <label>{t('ed_system_prompt')}</label>
              <textarea
                className="input prompt-area"
                value={p.system_prompt || ''}
                onChange={(e) => setField({ system_prompt: e.target.value })}
              />
              <div className="hint">{t('ed_prompt_hint')}</div>
            </div>

            {/* 出题策略(design contract):决定怎么从所挂题库出题 */}
            <div className="field">
              <label>{t('ed_strategy')}</label>
              <select
                className="input"
                value={p.question_strategy || 'sequential'}
                onChange={(e) => setField({ question_strategy: e.target.value as QuestionStrategy })}
              >
                <option value="sequential">{t('ed_strategy_sequential')}</option>
                <option value="random_n">{t('ed_strategy_random_n')}</option>
                <option value="easy_to_hard">{t('ed_strategy_easy_to_hard')}</option>
                <option value="random_n_easy_to_hard">{t('ed_strategy_random_n_easy')}</option>
              </select>
            </div>
            {/* strategy_n 仅 random 类策略显示;切换策略时 nDraft 内存保留,便于改回 */}
            {isRandom && (
              <div className="field">
                <label>{t('ed_strategy_n')}</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  step={1}
                  style={{ width: 120 }}
                  value={nDraft}
                  onChange={(e) => setNDraft(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                />
                <div className="hint">{t('ed_strategy_n_hint')}</div>
              </div>
            )}

            {/* 默认题库:空选项 = 不设默认(纯人设对话) */}
            <div className="field">
              <label>{t('ed_default_bank')}</label>
              <select
                className="input"
                value={p.default_question_bank_id || ''}
                onChange={(e) => setField({ default_question_bank_id: e.target.value || null })}
              >
                <option value="">{t('ed_default_bank_none')}</option>
                {banks.map((b) => (
                  <option key={b.question_bank_id} value={b.question_bank_id}>
                    {b.name} {b.version ? `(${b.version})` : ''}
                  </option>
                ))}
              </select>
              <div className="hint">{t('ed_default_bank_hint')}</div>
            </div>

            <div className="field">
              <label>{t('ed_self_bookable_label')}</label>
              <div
                className={'switch' + (p.self_bookable ? ' on' : '')}
                onClick={() => setField({ self_bookable: !p.self_bookable })}
              >
                <span className="track" />
                <span>{p.self_bookable ? t('yes') : t('no')}</span>
              </div>
              <div className="hint">{t('ed_self_bookable_hint')}</div>
            </div>

            {/* 实时字幕显示开关(design contract):顶层呈现字段,默认开(勾选)。缺字段(旧 Agent)→ `!== false` 显示为开。
                role="switch" + 键盘可达(review:开关应可键控/读屏可辨,新控件采纳)。 */}
            <div className="field">
              <label>{t('ed_show_subtitles_label')}</label>
              <div
                className={'switch' + (p.show_subtitles !== false ? ' on' : '')}
                role="switch"
                aria-checked={p.show_subtitles !== false}
                tabIndex={0}
                onClick={() => setField({ show_subtitles: !(p.show_subtitles !== false) })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setField({ show_subtitles: !(p.show_subtitles !== false) });
                  }
                }}
              >
                <span className="track" />
                <span>{p.show_subtitles !== false ? t('yes') : t('no')}</span>
              </div>
              <div className="hint">{t('ed_show_subtitles_hint')}</div>
            </div>

            {/* 头像风格(design contract):舞台中央视觉主体。四选一(minimal 默认 / round / tech / waveform 纯波形)。 */}
            <div className="field">
              <label>{t('ed_avatar_style_label')}</label>
              <select
                value={(['minimal', 'round', 'tech', 'waveform'].includes(p.avatar_style as string) ? p.avatar_style : 'minimal') as string}
                onChange={(e) => setField({ avatar_style: e.target.value as 'minimal' | 'round' | 'tech' | 'waveform' })}
              >
                <option value="minimal">{t('ed_avatar_style_minimal')}</option>
                <option value="round">{t('ed_avatar_style_round')}</option>
                <option value="tech">{t('ed_avatar_style_tech')}</option>
                <option value="waveform">{t('ed_avatar_style_waveform')}</option>
              </select>
              <div className="hint">{t('ed_avatar_style_hint')}</div>
            </div>

            {/* 声纹锁定说话人(design contract):抗旁人打断。默认锁定(勾选)。role="switch" + 键盘可达。 */}
            <div className="field">
              <label>{t('ed_speaker_lock_label')}</label>
              <div
                className={'switch' + (p.speaker_lock !== false ? ' on' : '')}
                role="switch"
                aria-checked={p.speaker_lock !== false}
                tabIndex={0}
                onClick={() => setField({ speaker_lock: !(p.speaker_lock !== false) })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setField({ speaker_lock: !(p.speaker_lock !== false) });
                  }
                }}
              >
                <span className="track" />
                <span>{p.speaker_lock !== false ? t('yes') : t('no')}</span>
              </div>
              <div className="hint">{t('ed_speaker_lock_hint')}</div>
            </div>
          </div>
        )}

        {tab === 'rubric' && (
          <div className="tabpane active">
            <div className="field">
              <label>{t('ed_judge_mode')}</label>
              <select
                className="input"
                value={p.rubric?.mode || 'per_question_check'}
                onChange={(e) => setRubric({ mode: e.target.value as 'per_question_check' | 'dimension_score' })}
              >
                <option value="per_question_check">{t('ed_mode_perq')}</option>
                <option value="dimension_score">{t('ed_mode_rubric')}</option>
              </select>
            </div>
            {(p.rubric?.mode || 'per_question_check') === 'per_question_check' ? (
              <div className="field">
                <label>{t('ed_passline_pct')}</label>
                <input
                  className="input"
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  style={{ width: 120 }}
                  value={p.rubric?.pass_threshold ?? 0.8}
                  onChange={(e) => setRubric({ pass_threshold: Number(e.target.value) })}
                />
              </div>
            ) : (
              <div className="field">
                <label>{t('ed_dimensions')}</label>
                {(p.rubric?.dimensions || []).map((d, i) => (
                  <div className="q-item" key={i}>
                    <div className="inline-2">
                      <div className="field" style={{ marginBottom: 8 }}>
                        <label>{t('ed_dim_name')}</label>
                        <input className="input" value={d.name} onChange={(e) => updateDim(i, { name: e.target.value })} />
                      </div>
                      <div className="field" style={{ marginBottom: 8 }}>
                        <label>{t('ed_dim_weight')}</label>
                        <input
                          className="input"
                          type="number"
                          step="0.1"
                          value={d.weight ?? 1}
                          onChange={(e) => updateDim(i, { weight: Number(e.target.value) })}
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 8 }}>
                        <label>{t('ed_dim_max')}</label>
                        <input
                          className="input"
                          type="number"
                          value={d.max_score ?? 10}
                          onChange={(e) => updateDim(i, { max_score: Number(e.target.value) })}
                        />
                      </div>
                    </div>
                    {/* 维度评分口径(P1-4):evaluator 打分 prompt 注入此 description 告诉 AI"这个维度怎么评";
                        此前 UI 无此输入 → AI 只见维度名靠猜,维度打分质量的根因缺口。 */}
                    <div className="field" style={{ marginBottom: 8 }}>
                      <label htmlFor={`dim-desc-${i}`}>{t('ed_dim_desc')}</label>
                      <textarea
                        id={`dim-desc-${i}`}
                        className="input"
                        rows={2}
                        value={d.description || ''}
                        placeholder={t('ed_dim_desc_ph')}
                        onChange={(e) => updateDim(i, { description: e.target.value })}
                        style={{ width: '100%', resize: 'vertical' }}
                      />
                    </div>
                    <button className="btn-link" onClick={() => removeDim(i)}>
                      {t('delete')}
                    </button>
                  </div>
                ))}
                <button className="btn btn-sm" onClick={addDim}>
                  {t('ed_add_dim')}
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'engine' && (
          <div className="tabpane active">
            <div className="engine-grid">
              <div className="field">
                <label>{t('ed_engine_type')}</label>
                <select
                  className="input"
                  value={p.engine?.engine_type || 'three_stage'}
                  onChange={(e) => setEngine({ engine_type: e.target.value })}
                >
                  <option value="three_stage">{t('ed_engine_three')}</option>
                </select>
              </div>
              <div className="field">
                <label>{t('ed_language')}</label>
                <select
                  className="input"
                  value={p.engine?.language || 'zh-CN'}
                  onChange={(e) => setEngine({ language: e.target.value })}
                >
                  <option value="zh-CN">{t('ed_lang_zh')}</option>
                  <option value="en-US">{t('ed_lang_en')}</option>
                  <option value="auto">{t('ed_lang_auto')}</option>
                </select>
              </div>
              <div className="field">
                <label>{t('ed_voice')}</label>
                <select
                  className="input"
                  value={p.engine?.voice || 'male_std'}
                  onChange={(e) => setEngine({ voice: e.target.value as 'male_std' | 'female_std' })}
                >
                  <option value="male_std">{t('ed_voice_male_std')}</option>
                  <option value="female_std">{t('ed_voice_female_std')}</option>
                </select>
                <div className="hint">{t('ed_voice_hint')}</div>
              </div>
              {/* TTS 合成来源(design contract):仅三段式有 TTS 段;Nova(s2s)一体引擎无此概念,隐藏。 */}
              {(p.engine?.engine_type || 'three_stage') === 'three_stage' && (
                <div className="field">
                  <label>{t('ed_tts_provider')}</label>
                  <select
                    className="input"
                    value={p.engine?.tts_provider || 'gpu_omnivoice'}
                    onChange={(e) =>
                      setEngine({ tts_provider: e.target.value as 'gpu_omnivoice' | 'minimax' })
                    }
                  >
                    <option value="gpu_omnivoice">{t('ed_tts_omnivoice')}</option>
                    <option value="minimax">{t('ed_tts_minimax')}</option>
                  </select>
                  <div className="hint">{t('ed_tts_provider_hint')}</div>
                </div>
              )}
              <div className="field">
                <label>{t('ed_max_duration')}</label>
                <input
                  className="input"
                  type="number"
                  value={p.engine?.max_duration_s ?? 3600}
                  onChange={(e) => setEngine({ max_duration_s: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>{t('ed_max_turns')}</label>
                <input
                  className="input"
                  type="number"
                  value={p.engine?.max_turns ?? 9999}
                  onChange={(e) => setEngine({ max_turns: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
        )}

        <div className="editor-foot">
          <button className="btn" onClick={() => navigate('#/agents')} disabled={busy}>
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
