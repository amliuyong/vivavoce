'use client';
import React, { useMemo, useState } from 'react';
import { t } from '@/lib/i18n';
import { useAsync, useLang } from '@/lib/appState';
import { api, type SystemSettingsState, type SettingItem, type SubsystemState } from '@/lib/api';
import { Loading, ErrorBanner } from '@/lib/ui';

/**
 * 运行时诊断配置只读总览(design contract,admin)。
 *
 * **纯只读页,无任何修改入口** —— 聚合控制面 / 媒体面 bridge / GPU / 部署清单四段来源,
 * 显示每项的**实际生效值** + 中文解释 + 默认值 + 来源。
 *
 * 设计约束(与后端契约对应):
 *  - **不轮询**(手动刷新按钮):诊断数据不是实况看板,轮询只会给子系统添无谓负载。
 *  - 子系统降级按**固定状态枚举**呈现,401 显示「鉴权失败」而非「停机」(掩盖事故是本页大忌)。
 *  - GPU 段标「采样单实例」——GPU 可 0–8 实例,只命中其中一台,不冒充集群一致值。
 *  - 逐项中文说明**全部来自后端** `SETTINGS_META`,本文件只承载页面框架文案(i18n)。
 *
 * 样式约定(deployment validation 修「页面像没 CSS」):class 名 MUST 取自 `app/globals.css` **已定义**的
 * 词汇表或本页专属 `.ss-*` 前缀。首版照抄了别处的 `card-title`/`muted`/`chip`/`table`/`badge`,
 * 而这些在 globals.css 里**根本不存在**(真名是 `tbl`,且 `card` 必须配 `card-pad` 才有内边距)
 * → 元素全部无样式。新增 `.ss-*` 只用 CSS 变量、不写死颜色(深色模式靠重定义变量生效)。
 */
export function SystemSettings() {
  useLang();
  const { data, error, loading, reload } = useAsync<SystemSettingsState>(
    () => api.getSystemSettings(),
    [],
  );
  const [onlyDiffs, setOnlyDiffs] = useState(false);

  if (loading && !data) return <Loading label={t('loading')} />;
  if (error) return <ErrorBanner message={error} />;
  const state = data!;

  const total = state.groups.reduce((n, g) => n + g.items.length, 0);
  const diffs = state.groups.reduce(
    (n, g) => n + g.items.filter((i) => i.differs_from_default).length,
    0,
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('nav_system_settings')}</h1>
          <div className="page-sub">{t('ss_sub')}</div>
        </div>
        <div className="ss-tools">
          <label className="ss-check">
            <input
              type="checkbox"
              checked={onlyDiffs}
              onChange={(e) => setOnlyDiffs(e.target.checked)}
            />
            {t('ss_only_diffs')}
            <span className="badge-pill">{diffs}</span>
          </label>
          <button className="btn btn-sm" onClick={reload} disabled={loading}>
            {loading ? t('loading') : t('ss_refresh')}
          </button>
        </div>
      </div>

      <SourceStatusBar sources={state.sources} gpuScope={state.gpu_scope} total={total} />

      {state.groups.map((g) => (
        <GroupCard key={g.group} group={g} onlyDiffs={onlyDiffs} />
      ))}
    </div>
  );
}

/** status 枚举 → 三色档(ok 绿 / 已知降级琥珀 / 故障红)。 */
function statusTone(status: string): 'ss-ok' | 'ss-warn' | 'ss-bad' {
  if (status === 'ok') return 'ss-ok';
  // 「计划内停机」「端点未启用」「未配置」是**预期状态**,不是事故 → 琥珀而非红
  if (status === 'planned_stopped' || status === 'endpoint_disabled' || status === 'not_configured') {
    return 'ss-warn';
  }
  return 'ss-bad';
}

/** 四段来源的健康状态条 —— 结构化降级在此如实呈现(区分停机/鉴权失败/超时)。 */
function SourceStatusBar({
  sources,
  gpuScope,
  total,
}: {
  sources: Record<string, SubsystemState>;
  gpuScope: string;
  total: number;
}) {
  const order = ['control', 'media', 'gpu', 'iac_manifest'];
  const degraded = order.filter((k) => sources[k] && sources[k].status !== 'ok' && sources[k].reason);
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div className="ss-group-head">
        <h2 className="ss-group-title">{t('ss_sources')}</h2>
        <span className="ss-group-count">{t('ss_total').replace('{n}', String(total))}</span>
      </div>
      <div className="ss-sources">
        {order.map((key) => {
          const s = sources[key];
          if (!s) return null;
          const tone = statusTone(s.status);
          return (
            <div key={key} className={`ss-src ${tone}`}>
              <div className="ss-src-name">{t(`ss_source_${key}` as never) || key}</div>
              <div className="ss-src-state">
                <span className="dot" />
                {t(`ss_status_${s.status}` as never) || s.status}
              </div>
              {/* 401/503 时服务**是可达的** —— 故 HTTP 码与「采样单实例」都作为补充事实列出 */}
              {s.http_status || (key === 'gpu' && gpuScope === 'sampled_instance') ? (
                <div className="ss-src-meta">
                  {s.http_status ? `HTTP ${s.http_status}` : null}
                  {s.http_status && key === 'gpu' && gpuScope === 'sampled_instance' ? ' · ' : null}
                  {key === 'gpu' && gpuScope === 'sampled_instance' ? t('ss_sampled_instance') : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {/* 不可达/异常时给出结构化原因,便于运维直接定位(而非「反正就是连不上」) */}
      {degraded.map((k) => (
        <div key={k} className="ss-reason">
          <b>{t(`ss_source_${k}` as never) || k}</b>: {sources[k].reason}
        </div>
      ))}
    </div>
  );
}

function GroupCard({ group, onlyDiffs }: { group: SystemSettingsState['groups'][0]; onlyDiffs: boolean }) {
  const items = useMemo(
    () => (onlyDiffs ? group.items.filter((i) => i.differs_from_default) : group.items),
    [group.items, onlyDiffs],
  );
  if (items.length === 0) return null;
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div className="ss-group-head">
        <h2 className="ss-group-title">{group.group}</h2>
        <span className="ss-group-count">
          {items.length}
          {items.length !== group.items.length ? ` / ${group.items.length}` : ''}
          {' · '}
          {group.sources.map((s) => t(`ss_source_${s}` as never) || s).join(' · ')}
        </span>
      </div>
      <table className="ss-tbl">
        <thead>
          <tr>
            <th>{t('ss_col_name')}</th>
            <th>{t('ss_col_value')}</th>
            <th>{t('ss_col_default')}</th>
            <th>{t('ss_col_origin')}</th>
            <th>{t('ss_col_desc')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <SettingRow key={`${item.source}:${item.key}`} item={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 值的呈现:布尔→开/关;null→按脱敏原因显示;其余原样 + 单位。 */
function renderValue(item: SettingItem): React.ReactNode {
  if (item.metadata_missing) {
    return <span className="ss-dim">{t('ss_unregistered')}</span>;
  }
  if (item.effective_value === null || item.effective_value === undefined) {
    return <span className="ss-dim">{item.redacted_reason || t('ss_hidden')}</span>;
  }
  if (typeof item.effective_value === 'boolean') {
    // 语义由后端**显式**给出(value_semantics),前端不从 redacted_reason 反推 ——
    // 反推虽当前能 work,但一旦将来给正常项也填 reason(如「已钳制到上限」),
    // 真开关就会被误渲染成「已配置」。
    if (item.value_semantics === 'configured') {
      return item.effective_value ? t('ss_configured') : t('ss_not_configured');
    }
    return item.effective_value ? t('ss_on') : t('ss_off');
  }
  return (
    <>
      <span className={item.differs_from_default ? 'ss-val ss-val-strong' : 'ss-val'}>
        {String(item.effective_value)}
      </span>
      {item.unit ? <span className="ss-unit">{item.unit}</span> : null}
    </>
  );
}

function SettingRow({ item }: { item: SettingItem }) {
  return (
    <tr>
      <td>
        <div className="ss-name">{item.name_zh}</div>
        <code className="ss-key">{item.key}</code>
      </td>
      <td>
        {renderValue(item)}
        {/* design contract:二维语义 —— 「异于默认」只用于**已标定项被覆盖**(真异常);
            确实未标定的项(C 类)显示「待标定」,因为它与默认值不同是**预期状态**。
            事故前二者混在一个标签里,导致线上正确配置被渲染成「偏离标准」。 */}
        {item.differs_from_default ? (
          <span className="ss-tag ss-tag-diff">{t('ss_differs')}</span>
        ) : item.calibration_status === 'pending' ? (
          <span className="ss-tag ss-tag-pending">{t('ss_calibration_pending')}</span>
        ) : null}
        {/* 设了 env 但被解析器丢弃 —— 运维最需看见的错配信号 */}
        {item.override_state === 'ignored_invalid' ? (
          <span className="ss-tag ss-tag-bad">{t('ss_ignored_invalid')}</span>
        ) : null}
      </td>
      <td>
        {item.default === null || item.default === undefined ? (
          <span className="ss-dim">—</span>
        ) : typeof item.default === 'boolean' ? (
          <span className="ss-dim">{item.default ? t('ss_on') : t('ss_off')}</span>
        ) : (
          <span className="ss-val ss-dim">{String(item.default)}</span>
        )}
        {item.default_kind === 'derived' ? (
          <div className="ss-note">
            {t('ss_derived')}
            {item.derived_from?.length
              ? `(${item.derived_from.map((d) => d.key).join(', ')})`
              : ''}
          </div>
        ) : null}
      </td>
      <td>
        <div className="ss-origin">
          {t(`ss_origin_${item.origin}` as never) || item.origin}
        </div>
        {item.origin === 'iac_manifest' ? <div className="ss-note">{t('ss_iac_note')}</div> : null}
      </td>
      <td className="ss-desc">{item.desc_zh}</td>
    </tr>
  );
}
