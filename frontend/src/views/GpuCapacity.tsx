'use client';
import React, { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { useAsync, useLang } from '@/lib/appState';
import { api, type GpuCapacityState, ApiError } from '@/lib/api';
import { Loading, ErrorBanner, useToast } from '@/lib/ui';
import { fmtDateTime } from '@/lib/format';

/** GPU 容量管理(design contract,admin):配置 fixed N / auto / 0 停机 + 实况看板(近实时轮询)。 */
export function GpuCapacity() {
  useLang();
  const { toast, confirm } = useToast();
  const { data, error, loading, reload } = useAsync<GpuCapacityState>(() => api.getGpuCapacity(), []);

  // 实况近实时轮询(15s + 抖动,避免多 admin 同开打爆 backend)
  useEffect(() => {
    const jitter = 1000 + Math.floor(Math.random() * 4000);
    const id = setInterval(() => reload(), 15000 + jitter);
    return () => clearInterval(id);
  }, [reload]);

  if (loading && !data) return <Loading label={t('loading')} />;
  if (error) return <ErrorBanner message={error} />;
  const state = data!;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('nav_gpu_capacity')}</h1>
          <div className="page-sub">{t('gc_sub')}</div>
        </div>
      </div>
      <CapacityForm state={state} onSaved={reload} toast={toast} confirm={confirm} />
      <LiveBoard state={state} />
    </div>
  );
}

function CapacityForm({
  state,
  onSaved,
  toast,
  confirm,
}: {
  state: GpuCapacityState;
  onSaved: () => void;
  toast: (m: string) => void;
  confirm: (o: { title: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
}) {
  const cfg = state.config;
  const [mode, setMode] = useState<'fixed' | 'auto'>(cfg?.mode ?? 'fixed');
  const [fixedCount, setFixedCount] = useState<number>(cfg?.fixed_count ?? 1);
  const [autoMin, setAutoMin] = useState<number>(cfg?.auto_min ?? 0);
  const [autoMax, setAutoMax] = useState<number>(cfg?.auto_max ?? 5);
  const [util, setUtil] = useState<number>(cfg?.target_util ?? 0.7);
  const [saving, setSaving] = useState(false);

  // 配置变化(他人改了)时同步表单
  useEffect(() => {
    if (!cfg) return;
    setMode(cfg.mode);
    if (cfg.mode === 'fixed') setFixedCount(cfg.fixed_count ?? 1);
    else {
      setAutoMin(cfg.auto_min ?? 0);
      setAutoMax(cfg.auto_max ?? 5);
      setUtil(cfg.target_util ?? 0.7);
    }
  }, [cfg]);

  async function save() {
    // 停机(fixed=0)且有在途 → 二次确认(诚实告知:计费等 drain 完才停)
    const liveActive = state.live?.active_sessions_total ?? 0;
    if (mode === 'fixed' && fixedCount === 0 && liveActive > 0) {
      const ok = await confirm({
        title: t('gc_stop_title'),
        message: t('gc_stop_confirm').replace('{n}', String(liveActive)),
        confirmLabel: t('gc_stop_title'),
        danger: true,
      });
      if (!ok) return;
    }
    const body: Record<string, unknown> =
      mode === 'fixed'
        ? { mode, fixed_count: fixedCount }
        : { mode, auto_min: autoMin, auto_max: autoMax, target_util: util };
    if (cfg) body.expected_version = cfg.config_version; // 乐观锁
    setSaving(true);
    try {
      await api.setGpuCapacity(body);
      toast(t('gc_saved'));
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast(t('gc_conflict'));
      else toast(e instanceof ApiError ? e.detail : t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <h2 className="page-title" style={{ fontSize: 16, marginBottom: 18 }}>{t('gc_config_title')}</h2>
      <div className="field">
        <label>{t('gc_mode')}</label>
        <select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'fixed' | 'auto')}>
          <option value="fixed">{t('gc_mode_fixed')}</option>
          <option value="auto">{t('gc_mode_auto')}</option>
        </select>
      </div>
      {mode === 'fixed' ? (
        <div className="field">
          <label>{t('gc_fixed_count')}</label>
          <input className="input" type="number" min={0} max={state.hard_max} value={fixedCount}
                 onChange={(e) => setFixedCount(Number(e.target.value))} />
          <div className="hint">{t('gc_fixed_hint').replace('{max}', String(state.hard_max))}</div>
        </div>
      ) : (
        <>
          <div className="field">
            <label>{t('gc_auto_min')}</label>
            <input className="input" type="number" min={0} max={state.hard_max} value={autoMin}
                   onChange={(e) => setAutoMin(Number(e.target.value))} />
            <div className="hint">{t('gc_auto_min_hint')}</div>
          </div>
          <div className="field">
            <label>{t('gc_auto_max')}</label>
            <input className="input" type="number" min={1} max={state.hard_max} value={autoMax}
                   onChange={(e) => setAutoMax(Number(e.target.value))} />
            <div className="hint">{t('gc_auto_max_hint').replace('{max}', String(state.hard_max))}</div>
          </div>
          <div className="field">
            <label>{t('gc_target_util')}</label>
            <input className="input" type="number" min={0.1} max={1} step={0.05} value={util}
                   onChange={(e) => setUtil(Number(e.target.value))} />
          </div>
        </>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? t('saving') : t('gc_save')}
        </button>
        {cfg?.updated_by && (
          <span className="hint">
            {t('gc_updated_by')}: {cfg.updated_by} · v{cfg.config_version}
          </span>
        )}
      </div>
    </div>
  );
}

function LiveBoard({ state }: { state: GpuCapacityState }) {
  const live = state.live;
  if (!live) return <div className="card card-pad"><div className="hint">{t('gc_live_pending')}</div></div>;

  // 实况陈旧判定(>5min reconciler 未更新)→ 横幅提示
  const stale = (() => {
    if (!live.reconciler_heartbeat_at) return true;
    const hb = Date.parse(live.reconciler_heartbeat_at);
    return Number.isNaN(hb) || Date.now() - hb > 5 * 60 * 1000;
  })();

  return (
    <div className="card card-pad">
      <h2 className="page-title" style={{ fontSize: 16, marginBottom: 12 }}>{t('gc_live_title')}</h2>
      {stale && <div className="warn-box"><span className="em">⚠</span><span>{t('gc_stale_warn')}</span></div>}
      <div className="metric-grid">
        <Metric label={t('gc_m_desired')} value={live.desired_instances ?? '—'} />
        <Metric label={t('gc_m_running')} value={live.running_instances ?? '—'} />
        <Metric label={t('gc_m_healthy')} value={live.healthy_instances ?? '—'} />
        <Metric label={t('gc_m_draining')} value={live.draining_instances ?? 0} />
        <Metric label={t('gc_m_serviceable')} value={live.serviceable_concurrency ?? '—'} />
        <Metric label={t('gc_m_active')} value={live.active_sessions_total ?? 0} />
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        {t('gc_last_action')}: {live.last_action ?? '—'}
        {live.observed_at && ` · ${t('gc_observed_at')}: ${fmtDateTime(live.observed_at)}`}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="metric">
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}
