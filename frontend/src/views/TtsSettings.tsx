'use client';
import React, { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { useAsync, useLang } from '@/lib/appState';
import { api, type MiniMaxConfigView, type MiniMaxReloadResult, type MiniMaxVoice, type LlmConfigView, type LlmModel, ApiError } from '@/lib/api';
import { isFutureLocalExpiry, localExpiryToUtc, utcExpiryToLocalInput } from '@/lib/llm-credential-expiry';
import { Loading, ErrorBanner, useToast } from '@/lib/ui';

/**
 * MiniMax TTS provider 配置(design contract,admin):enabled/base_url/model/voice_map/key。
 * key 写后只显示脱敏态(has_key + 末4位);保存后据热加载回执即时显示"已生效 / key 无效"(免重启)。
 */
export function TtsSettings() {
  useLang();
  const { toast } = useToast();
  const { data, error, loading, reload } = useAsync<{ config: MiniMaxConfigView }>(
    () => api.getTtsConfig(),
    [],
  );

  if (loading && !data) return <Loading label={t('loading')} />;
  if (error) {
    // 503 = 未部署 019(无 Secret);给明确提示而非泛化错误
    return <ErrorBanner message={t('tts_not_enabled')} />;
  }
  const cfg = data!.config;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('nav_tts_settings')}</h1>
          <div className="page-sub">{t('tts_sub')}</div>
        </div>
      </div>
      <LlmSettings />
      <TtsForm cfg={cfg} onSaved={reload} toast={toast} />
    </div>
  );
}

/**
 * 三段式对话 LLM 配置(design contract,admin):mantle host + 模型清单(增删)+ 默认模型 + Bearer token。
 * token 写后只显示脱敏态(has_key + 末4);模型清单数据驱动(Agent 编辑处下拉来自此)。复用 TTS 页,同页并列。
 */
export function LlmSettings() {
  useLang();
  const { toast } = useToast();
  const { data, error, loading, reload } = useAsync<{ config: LlmConfigView; recommended: LlmModel[] }>(
    () => api.getLlmConfig(),
    [],
  );
  if (loading && !data) return <Loading label={t('loading')} />;
  if (error) return <ErrorBanner message={t('llm_not_enabled')} />;
  return <LlmForm cfg={data!.config} recommended={data!.recommended} onSaved={reload} toast={toast} />;
}

function LlmForm({
  cfg,
  recommended,
  onSaved,
  toast,
}: {
  cfg: LlmConfigView;
  recommended: LlmModel[];
  onSaved: () => void;
  toast: (m: string) => void;
}) {
  const [enabled, setEnabled] = useState<boolean>(cfg.enabled);
  const [host, setHost] = useState<string>(cfg.host);
  const [models, setModels] = useState<LlmModel[]>(cfg.models.length ? cfg.models : recommended);
  const [defaultModel, setDefaultModel] = useState<string>(cfg.default_model);
  const [evaluatorModel, setEvaluatorModel] = useState<string>(cfg.evaluator_model);
  const [fallbackModels, setFallbackModels] = useState<string[]>(cfg.fallback_models ?? []);
  // design contract:ASR 字幕修正模型(空=不修)。
  const [fixerModel, setFixerModel] = useState<string>(cfg.transcript_fixer_model ?? '');
  // design contract:调用方式(全局单选)+ converse 上游 region + Bedrock API Key。
  const [callMethod, setCallMethod] = useState<'mantle' | 'bedrock_converse'>(cfg.call_method ?? 'mantle');
  const [bedrockRegion, setBedrockRegion] = useState<string>(cfg.bedrock_region ?? 'us-east-1');
  const [editingBedrockKey, setEditingBedrockKey] = useState<boolean>(false);
  const [newBedrockKey, setNewBedrockKey] = useState<string>('');
  const [bedrockExpiry, setBedrockExpiry] = useState<string>(
    utcExpiryToLocalInput(cfg.bedrock_api_key_expires_at),
  );
  const [editingKey, setEditingKey] = useState<boolean>(false);
  const [newKey, setNewKey] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const isConverse = callMethod === 'bedrock_converse';

  useEffect(() => {
    setEnabled(cfg.enabled);
    setHost(cfg.host);
    setModels(cfg.models.length ? cfg.models : recommended);
    setDefaultModel(cfg.default_model);
    setEvaluatorModel(cfg.evaluator_model);
    setFallbackModels(cfg.fallback_models ?? []);
    setFixerModel(cfg.transcript_fixer_model ?? '');
    setCallMethod(cfg.call_method ?? 'mantle');
    setBedrockRegion(cfg.bedrock_region ?? 'us-east-1');
    setEditingKey(false);
    setNewKey('');
    setEditingBedrockKey(false);
    setNewBedrockKey('');
    setBedrockExpiry(utcExpiryToLocalInput(cfg.bedrock_api_key_expires_at));
  }, [cfg, recommended]);

  const keyChanged = editingKey && newKey.trim().length > 0;
  const bedrockKeyChanged = editingBedrockKey && newBedrockKey.trim().length > 0;
  const bedrockExpiryChanged = bedrockExpiry !== utcExpiryToLocalInput(cfg.bedrock_api_key_expires_at);
  const bedrockExpiryShouldSubmit = bedrockKeyChanged || bedrockExpiryChanged;
  const needsBedrockExpiry = bedrockExpiryShouldSubmit && !bedrockExpiry;
  const invalidBedrockExpiry = bedrockExpiryShouldSubmit
    && !!bedrockExpiry
    && !isFutureLocalExpiry(bedrockExpiry);

  function beginBedrockKeyEdit() {
    setEditingBedrockKey(true);
    setNewBedrockKey('');
    setBedrockExpiry('');
  }

  function cancelBedrockKeyEdit() {
    setEditingBedrockKey(false);
    setNewBedrockKey('');
    setBedrockExpiry(utcExpiryToLocalInput(cfg.bedrock_api_key_expires_at));
  }

  // 仅「启用自定义」时才要求凭据(现存或新填);关闭时走默认 Haiku,无需凭据。
  // design contract:按 call_method 要对应凭据——mantle 看 mantle token(has_key)、converse 看 Bedrock API Key(has_bedrock_key)。
  const needsKey = enabled && !isConverse && !cfg.has_key && !keyChanged;
  const needsBedrockKey = enabled && isConverse && !cfg.has_bedrock_key && !bedrockKeyChanged;
  const ids = models.map((m) => m.id);
  const defaultInModels = !defaultModel || ids.includes(defaultModel);

  function updateModel(i: number, patch: Partial<LlmModel>) {
    setModels((ms) => ms.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }
  function removeModel(i: number) {
    setModels((ms) => ms.filter((_, idx) => idx !== i));
  }
  function addModel() {
    setModels((ms) => [...ms, { id: '', label: '' }]);
  }

  async function save() {
    if (needsKey) { toast(t('llm_key_required')); return; }
    if (needsBedrockKey) { toast(t('llm_bedrock_key_required')); return; }
    if (needsBedrockExpiry) { toast(t('llm_bedrock_expiry_required')); return; }
    if (invalidBedrockExpiry) { toast(t('llm_bedrock_expiry_future')); return; }
    const cleanModels = models.filter((m) => m.id.trim()).map((m) => ({ id: m.id.trim(), label: (m.label || '').trim() || m.id.trim() }));
    if (cleanModels.length === 0) { toast(t('llm_models_required')); return; }
    if (defaultModel && !cleanModels.some((m) => m.id === defaultModel)) { toast(t('llm_default_in_models')); return; }
    if (evaluatorModel && !cleanModels.some((m) => m.id === evaluatorModel)) { toast(t('llm_eval_in_models')); return; }
    // design contract:修字幕模型**可空=不修**;非空时才要求 ∈ 清单(与 default/evaluator 不同,空不校验)。
    if (fixerModel && !cleanModels.some((m) => m.id === fixerModel)) { toast(t('llm_fixer_in_models')); return; }
    // design contract:备用序只保留仍在清单内的(清单删模型后自动剔除)+ 剔除与默认模型同名(避免自我重试)。
    const effectiveDefault = defaultModel || cleanModels[0].id;
    const cleanFallback = fallbackModels.filter((id) => cleanModels.some((m) => m.id === id) && id !== effectiveDefault);
    const body: Record<string, unknown> = {
      enabled, host, models: cleanModels,
      default_model: effectiveDefault,
      evaluator_model: evaluatorModel || cleanModels[0].id,
      fallback_models: cleanFallback,
      // design contract:修字幕模型(空=不修;清单删了该模型则自动回退不修)。
      transcript_fixer_model: fixerModel && cleanModels.some((m) => m.id === fixerModel) ? fixerModel : '',
      // design contract:调用方式(全局单选)+ converse 上游 region。
      call_method: callMethod,
      bedrock_region: bedrockRegion.trim() || 'us-east-1',
    };
    if (keyChanged) body.api_key = newKey.trim();
    if (bedrockKeyChanged) body.bedrock_api_key = newBedrockKey.trim();
    if (bedrockExpiryShouldSubmit) {
      const expiresAt = localExpiryToUtc(bedrockExpiry);
      if (!expiresAt) { toast(t('llm_bedrock_expiry_required')); return; }
      body.bedrock_api_key_expires_at = expiresAt;
    }
    setSaving(true);
    try {
      await api.setLlmConfig(body);
      toast(t('llm_saved'));
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <h2 className="page-title" style={{ fontSize: 16, marginBottom: 6 }}>{t('llm_config_title')}</h2>
      <div className="hint" style={{ marginBottom: 18 }}>{t('llm_config_sub')}</div>

      {/* 启用自定义开关:开 → 配 mantle token/模型;关 → 用默认 Haiku(IAM),下方字段不生效 */}
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('llm_enabled')}
        </label>
        <div className="hint">{t('llm_enabled_hint')}</div>
      </div>

      {/* mantle 字段:仅「启用自定义」时生效;关闭时整体置灰不可交互(视觉表达「用默认 Haiku」) */}
      <div style={enabled ? undefined : { opacity: 0.45, pointerEvents: 'none' }} aria-disabled={!enabled}>
      {/* design contract:调用方式(全局单选,先选)——mantle(现状)/ 传统 Bedrock Converse(拿 mantle 没有的模型如 Sonnet 4.6) */}
      <div className="field">
        <label>{t('llm_call_method')}</label>
        <select className="input" style={{ maxWidth: 480 }} value={callMethod}
          onChange={(e) => setCallMethod(e.target.value as 'mantle' | 'bedrock_converse')}>
          <option value="mantle">{t('llm_call_method_mantle')}</option>
          <option value="bedrock_converse">{t('llm_call_method_converse')}</option>
        </select>
        <div className="hint">{t('llm_call_method_hint')}</div>
      </div>

      {/* 凭据:按 call_method 显示——mantle 用 mantle Bearer token;converse 用 Bedrock API Key */}
      {!isConverse ? (
      <div className="field">
        <label>{t('llm_api_key')}</label>
        {!editingKey && cfg.has_key ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 480 }}>
            <input className="input" readOnly tabIndex={-1} value={`••••••••••••••••${cfg.last4 ?? ''}`}
              style={{ flex: 1, color: 'var(--text-mute)', letterSpacing: '1px' }} />
            <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={() => setEditingKey(true)}>
              {t('tts_key_change')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 480 }}>
            <input className="input" type="password" style={{ flex: 1 }}
              placeholder={cfg.has_key ? t('tts_key_placeholder_set') : t('tts_key_placeholder_unset')}
              value={newKey} onChange={(e) => setNewKey(e.target.value)} autoComplete="new-password" />
            {cfg.has_key && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
                onClick={() => { setEditingKey(false); setNewKey(''); }}>
                {t('tts_key_cancel')}
              </button>
            )}
          </div>
        )}
        <div className="hint">{t('llm_key_hint')}</div>
        {needsKey && <div className="form-err">{t('llm_key_required')}</div>}
      </div>
      ) : (
      <div className="field">
        <label>{t('llm_bedrock_key')}</label>
        {!editingBedrockKey && cfg.has_bedrock_key ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 480 }}>
            <input className="input" readOnly tabIndex={-1} value={`••••••••••••••••${cfg.bedrock_last4 ?? ''}`}
              style={{ flex: 1, color: 'var(--text-mute)', letterSpacing: '1px' }} />
            <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={beginBedrockKeyEdit}>
              {t('tts_key_change')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 480 }}>
            <input className="input" type="password" style={{ flex: 1 }}
              placeholder={cfg.has_bedrock_key ? t('tts_key_placeholder_set') : t('tts_key_placeholder_unset')}
              value={newBedrockKey} onChange={(e) => setNewBedrockKey(e.target.value)} autoComplete="new-password" />
            {cfg.has_bedrock_key && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
                onClick={cancelBedrockKeyEdit}>
                {t('tts_key_cancel')}
              </button>
            )}
          </div>
        )}
        <div className="hint">{t('llm_bedrock_key_hint')}</div>
        {needsBedrockKey && <div className="form-err">{t('llm_bedrock_key_required')}</div>}
      </div>
      )}

      {isConverse && (
      <div className="field">
        <label>{t('llm_bedrock_expiry')}</label>
        <input
          className="input"
          type="datetime-local"
          step="1"
          value={bedrockExpiry}
          onChange={(e) => setBedrockExpiry(e.target.value)}
          required={bedrockKeyChanged}
          aria-invalid={needsBedrockExpiry || invalidBedrockExpiry}
          style={{ maxWidth: 480 }}
        />
        <div className="hint">{t('llm_bedrock_expiry_hint')}</div>
        {needsBedrockExpiry && <div className="form-err">{t('llm_bedrock_expiry_required')}</div>}
        {invalidBedrockExpiry && <div className="form-err">{t('llm_bedrock_expiry_future')}</div>}
      </div>
      )}

      {/* host:两方式共用(mantle host 或 converse 代理域名) */}
      <div className="field">
        <label>{t('llm_host')}</label>
        <input className="input" value={host} onChange={(e) => setHost(e.target.value)} style={{ maxWidth: 480 }} />
        <div className="hint">{isConverse ? t('llm_host_converse_hint') : t('llm_host_hint')}</div>
      </div>

      {/* design contract:converse 上游 Bedrock region(?region=);仅 converse 显示 */}
      {isConverse && (
      <div className="field">
        <label>{t('llm_bedrock_region')}</label>
        <input className="input" value={bedrockRegion} onChange={(e) => setBedrockRegion(e.target.value)}
          placeholder="us-east-1" style={{ maxWidth: 480 }} />
        <div className="hint">{t('llm_bedrock_region_hint')}</div>
      </div>
      )}

      {/* 模型清单(增删) */}
      <div className="field">
        <label>{t('llm_models')}</label>
        {models.map((m, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, maxWidth: 640 }}>
            <input className="input" style={{ flex: 2 }}
              placeholder={isConverse ? 'global.anthropic.claude-sonnet-4-6' : 'anthropic.claude-haiku-4-5'}
              value={m.id} onChange={(e) => updateModel(i, { id: e.target.value })} />
            <input className="input" style={{ flex: 3 }} placeholder={t('llm_model_label_ph')}
              value={m.label ?? ''} onChange={(e) => updateModel(i, { label: e.target.value })} />
            <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={() => removeModel(i)}>
              {t('llm_model_remove')}
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={addModel}>{t('llm_model_add')}</button>
        <div className="hint">{isConverse ? t('llm_models_converse_hint') : t('llm_models_hint')}</div>
      </div>

      {/* 默认模型(实时对话) */}
      <div className="field">
        <label>{t('llm_default_model')}</label>
        <select className="input" style={{ maxWidth: 480 }} value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
          {ids.filter((id) => id).map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        {!defaultInModels && <div className="form-err">{t('llm_default_in_models')}</div>}
      </div>

      {/* 打分模型(evaluator):复用同 mantle host+token 跨境调美东。可与对话模型不同(打分常用更强/更省)。 */}
      <div className="field">
        <label>{t('llm_evaluator_model')}</label>
        <select className="input" style={{ maxWidth: 480 }} value={evaluatorModel} onChange={(e) => setEvaluatorModel(e.target.value)}>
          {ids.filter((id) => id).map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <div className="hint">{t('llm_evaluator_model_hint')}</div>
      </div>

      {/* ASR 字幕修正模型(design contract):旁路修字幕/转写错字,不碰对话。首项「不修」(空)= 关闭修正,字幕走 ASR 原文。 */}
      <div className="field">
        <label>{t('llm_fixer_model')}</label>
        <select className="input" style={{ maxWidth: 480 }} value={fixerModel} onChange={(e) => setFixerModel(e.target.value)}>
          <option value="">{t('llm_fixer_none')}</option>
          {ids.filter((id) => id).map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <div className="hint">{t('llm_fixer_model_hint')}</div>
      </div>

      {/* 主备 fallback 备用模型序(design contract):主模型出首 token 前失败/超时 → 依次切勾选的备用重跑本轮。
          勾选顺序即尝试顺序;默认模型不可作为自己的备用(已出 token 不回退)。空 = 关闭 fallback(单模型)。 */}
      <div className="field">
        <label>{t('llm_fallback_models')}</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 480 }}>
          {ids.filter((id) => id && id !== (defaultModel || (ids[0] ?? ''))).map((id) => (
            <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={fallbackModels.includes(id)}
                onChange={(e) =>
                  setFallbackModels((prev) =>
                    e.target.checked ? [...prev.filter((m) => m !== id), id] : prev.filter((m) => m !== id),
                  )
                }
              />
              {id}
              {fallbackModels.includes(id) && (
                <span className="hint" style={{ marginLeft: 4 }}>#{fallbackModels.indexOf(id) + 1}</span>
              )}
            </label>
          ))}
        </div>
        <div className="hint">{t('llm_fallback_models_hint')}</div>
      </div>
      </div>{/* /mantle 字段容器 */}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
        <button
          className="btn btn-primary"
          disabled={saving || needsKey || needsBedrockKey || needsBedrockExpiry || invalidBedrockExpiry || !defaultInModels}
          onClick={save}
        >
          {saving ? t('saving') : t('llm_save')}
        </button>
      </div>
    </div>
  );
}

function TtsForm({
  cfg,
  onSaved,
  toast,
}: {
  cfg: MiniMaxConfigView;
  onSaved: () => void;
  toast: (m: string) => void;
}) {
  const [enabled, setEnabled] = useState<boolean>(cfg.enabled);
  const [baseUrl, setBaseUrl] = useState<string>(cfg.base_url);
  const [model, setModel] = useState<string>(cfg.model);
  const [maleId, setMaleId] = useState<string>(cfg.voice_map?.male_std ?? '');
  const [femaleId, setFemaleId] = useState<string>(cfg.voice_map?.female_std ?? '');
  // 英文标准男/女音(语言维度,修英文口音):voice_map 的 "<key>.en" 键 → GPU 据会话 language=en/auto
  // 逐句选英文母语音色。键名含点(male_std.en),JS 对象按字符串键存取。
  const [maleEnId, setMaleEnId] = useState<string>(cfg.voice_map?.['male_std.en'] ?? '');
  const [femaleEnId, setFemaleEnId] = useState<string>(cfg.voice_map?.['female_std.en'] ?? '');
  // key:editingKey=false 时显示「当前 Key 脱敏 chip」(已配置)/「未配置」,点「更换」才出输入框。
  // newKey 仅在 editingKey 时有意义;保存后回 false(脱敏态从 cfg 重渲)。
  const [editingKey, setEditingKey] = useState<boolean>(false);
  const [newKey, setNewKey] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [reloadInfo, setReloadInfo] = useState<MiniMaxReloadResult | null>(null);
  // 账号可用音色(get_voice):有则下拉选,无(未配 key / 不可达)则回退手填 voice_id。
  // 依赖**稳定基元**(has_key + last4)而非整个 cfg 对象:音色清单只随 key 变,避免 cfg 引用每次刷新
  // (保存/轮询)就重复调 get_voice(code-review:[cfg] 依赖致冗余请求)。
  const [voices, setVoices] = useState<MiniMaxVoice[]>([]);
  useEffect(() => {
    let live = true;
    api.getTtsVoices()
      .then((r) => { if (live) setVoices(r.available ? r.voices : []); })
      .catch(() => { if (live) setVoices([]); /* 回退手填 */ });
    return () => { live = false; };
  }, [cfg.has_key, cfg.last4]); // key 变(配/换)才重拉音色清单

  // cfg 刷新(保存后重拉 / 他人改)→ 同步表单;key 永不回显明文,只重置编辑态。
  useEffect(() => {
    setEnabled(cfg.enabled);
    setBaseUrl(cfg.base_url);
    setModel(cfg.model);
    setMaleId(cfg.voice_map?.male_std ?? '');
    setFemaleId(cfg.voice_map?.female_std ?? '');
    setMaleEnId(cfg.voice_map?.['male_std.en'] ?? '');
    setFemaleEnId(cfg.voice_map?.['female_std.en'] ?? '');
    setEditingKey(false);
    setNewKey('');
  }, [cfg]);

  // 是否有改动(无改动则禁用保存,修「没改也能反复保存」)。
  const keyChanged = editingKey && newKey.trim().length > 0;
  const dirty =
    enabled !== cfg.enabled ||
    baseUrl !== cfg.base_url ||
    model !== cfg.model ||
    maleId !== (cfg.voice_map?.male_std ?? '') ||
    femaleId !== (cfg.voice_map?.female_std ?? '') ||
    maleEnId !== (cfg.voice_map?.['male_std.en'] ?? '') ||
    femaleEnId !== (cfg.voice_map?.['female_std.en'] ?? '') ||
    keyChanged;
  // 启用 MiniMax 但既无现有 key、也没填新 key → 校验拦截(关闭时不要求 key,disable 态允许留空)。
  const needsKey = enabled && !cfg.has_key && !keyChanged;

  async function save() {
    if (needsKey) {
      toast(t('tts_key_required'));
      return;
    }
    const body: Record<string, unknown> = { enabled, base_url: baseUrl, model };
    // voice_map 只带**非空**项(空 = 保留现有映射,后端深合并)。中文裸 key + 英文 "<key>.en" 键。
    const vmap: Record<string, string> = {};
    if (maleId.trim()) vmap.male_std = maleId.trim();
    if (femaleId.trim()) vmap.female_std = femaleId.trim();
    if (maleEnId.trim()) vmap['male_std.en'] = maleEnId.trim();
    if (femaleEnId.trim()) vmap['female_std.en'] = femaleEnId.trim();
    if (Object.keys(vmap).length > 0) body.voice_map = vmap;
    // 仅在「更换 Key」且填了新值时带 api_key(否则保留现有,后端空串=保留)。
    if (keyChanged) body.api_key = newKey.trim();
    setSaving(true);
    setReloadInfo(null);
    try {
      const res = await api.setTtsConfig(body);
      setReloadInfo(res.reload);
      if (res.reload?.triggered && res.reload?.ok === true) toast(t('tts_reload_ok'));
      else if (res.reload?.triggered && res.reload?.ok === false) toast(t('tts_reload_keybad'));
      else toast(t('tts_saved'));
      onSaved(); // 重拉 cfg → useEffect 重置编辑态 + 脱敏 chip 显示新末4位
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <h2 className="page-title" style={{ fontSize: 16, marginBottom: 18 }}>{t('tts_config_title')}</h2>

      {/* 启用开关(整行) */}
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('tts_enabled')}
        </label>
        <div className="hint">{t('tts_enabled_hint')}</div>
      </div>

      {/* API Key(整行):已配置 → 脱敏 chip + 「更换」;未配置/更换中 → 输入框 */}
      <div className="field">
        <label>{t('tts_api_key')}</label>
        {!editingKey && cfg.has_key ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 480 }}>
            {/* 只读 input 显示掩码,视觉与下方 Endpoint/模型 输入框统一,不会像自由文本那样溢出错位 */}
            <input
              className="input"
              readOnly
              tabIndex={-1}
              value={`••••••••••••••••${cfg.last4 ?? ''}`}
              style={{ flex: 1, color: 'var(--text-mute)', letterSpacing: '1px' }}
            />
            <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} onClick={() => setEditingKey(true)}>
              {t('tts_key_change')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 480 }}>
            <input
              className="input"
              type="password"
              style={{ flex: 1 }}
              placeholder={cfg.has_key ? t('tts_key_placeholder_set') : t('tts_key_placeholder_unset')}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              autoComplete="new-password"
            />
            {cfg.has_key && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ flexShrink: 0 }}
                onClick={() => { setEditingKey(false); setNewKey(''); }}
              >
                {t('tts_key_cancel')}
              </button>
            )}
          </div>
        )}
        <div className="hint">{t('tts_key_hint')}</div>
        {needsKey && <div className="form-err">{t('tts_key_required')}</div>}
      </div>

      {/* 其余参数:两列网格(限宽,不再右侧大片空白) */}
      <div className="form-grid" style={{ marginTop: 4 }}>
        <div className="field span-2">
          <label>{t('tts_base_url')}</label>
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <div className="hint">{t('tts_base_url_hint')}</div>
        </div>
        <div className="field">
          <label>{t('tts_model')}</label>
          <input className="input" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <div className="field" />
        {/* 中文标准音色(默认;会话 language=zh 或 auto 判为中文的句子用) */}
        <div className="field span-2" style={{ marginBottom: -8 }}>
          <label style={{ color: 'var(--text-mute)', fontSize: 13 }}>{t('tts_voice_group_zh')}</label>
        </div>
        <VoiceField label={t('tts_voice_female')} value={femaleId} onChange={setFemaleId} voices={voices} />
        <VoiceField label={t('tts_voice_male')} value={maleId} onChange={setMaleId} voices={voices} />
        {/* 英文标准音色(会话 language=en 或 auto 判为英文的句子用英文母语音色,修英文口音) */}
        <div className="field span-2" style={{ marginTop: 4, marginBottom: -8 }}>
          <label style={{ color: 'var(--text-mute)', fontSize: 13 }}>{t('tts_voice_group_en')}</label>
        </div>
        <VoiceField label={t('tts_voice_female_en')} value={femaleEnId} onChange={setFemaleEnId} voices={voices} />
        <VoiceField label={t('tts_voice_male_en')} value={maleEnId} onChange={setMaleEnId} voices={voices} />
        <div className="hint span-2" style={{ marginTop: -8 }}>
          {voices.length > 0 ? t('tts_voice_map_hint') : t('tts_voice_map_hint_manual')}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
        <button className="btn btn-primary" disabled={saving || !dirty || needsKey} onClick={save}>
          {saving ? t('saving') : t('tts_save')}
        </button>
        {!dirty && !saving && <span className="hint">{t('tts_no_changes')}</span>}
        {reloadInfo && dirty === false && (
          <span className="hint">
            {reloadInfo.ok === true && `✓ ${t('tts_reload_ok')}`}
            {reloadInfo.ok === false && `⚠ ${t('tts_reload_keybad')}`}
            {reloadInfo.triggered && reloadInfo.ok == null && t('tts_reload_pending')}
            {!reloadInfo.triggered && t('tts_reload_saved_only')}
          </span>
        )}
      </div>
    </div>
  );
}

/** 音色字段:账号有可用音色清单时下拉选(显示友好名);否则回退手填 voice_id。
 *  下拉里始终包含当前值(即便不在清单,避免已配的值消失)。 */
function VoiceField({
  label,
  value,
  onChange,
  voices,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  voices: MiniMaxVoice[];
}) {
  if (voices.length === 0) {
    // 无清单(未配 key / get_voice 不可达)→ 手填
    return (
      <div className="field">
        <label>{label}</label>
        <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  }
  // 当前值不在清单(历史配置/克隆音色)→ 补一个选项,避免选中态丢失
  const hasCurrent = !value || voices.some((v) => v.voice_id === value);
  return (
    <div className="field">
      <label>{label}</label>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('tts_voice_pick')}</option>
        {!hasCurrent && <option value={value}>{value}(当前)</option>}
        {voices.map((v) => (
          <option key={v.voice_id} value={v.voice_id}>
            {v.voice_name === v.voice_id ? v.voice_id : `${v.voice_name} · ${v.voice_id}`}
          </option>
        ))}
      </select>
    </div>
  );
}
