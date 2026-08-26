'use client';
import React, { useState } from 'react';
import { t } from '@/lib/i18n';
import { useAsync, useLang } from '@/lib/appState';
import { api, type ApiClient, VALID_SCOPES, ApiError } from '@/lib/api';
import { Loading, ErrorBanner, useToast } from '@/lib/ui';
import { Modal } from '@/components/Modal';
import { fmtDateTime } from '@/lib/format';
import { DownloadHandbookButton } from '@/views/ApiDocs';

/** admin API Key 管理(design contract):建/列/吊销集成商 client;api_key 明文仅创建时返回一次。 */
export function Integration() {
  useLang();
  const { toast, confirm } = useToast();
  const { data, error, loading, reload } = useAsync(() => api.listApiClients(), []);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<ApiClient | null>(null);

  async function revoke(c: ApiClient) {
    const ok = await confirm({
      title: t('ik_revoke'),
      message: `${t('ik_revoke_confirm')}(${c.name})`,
      confirmLabel: t('ik_revoke'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokeApiClient(c.client_id);
      toast(t('ik_revoked'));
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : t('error_generic'));
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('nav_integration')}</h1>
          <div className="page-sub">{t('ik_sub')}</div>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          {t('ik_new')}
        </button>
      </div>

      <ErrorBanner message={error} />

      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('ik_th_name')}</th>
              <th>{t('ik_th_client_id')}</th>
              <th>{t('ik_th_scopes')}</th>
              <th>{t('ik_th_created')}</th>
              <th style={{ textAlign: 'right' }}>{t('th_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5}>
                  <Loading label={t('loading')} />
                </td>
              </tr>
            ) : (data || []).length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">{t('empty_list')}</div>
                </td>
              </tr>
            ) : (
              (data || []).map((c) => (
                <tr key={c.client_id}>
                  <td className="obj-name">{c.name}</td>
                  <td>
                    <span className="sip-code">{c.client_id}</span>
                  </td>
                  <td>
                    <div className="tagchips">
                      {(c.scopes || []).map((s) => (
                        <span className="tag" key={s}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ color: 'var(--text-mute)' }}>{fmtDateTime(c.created_at)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-sm btn-danger" onClick={() => revoke(c)}>
                      {t('ik_revoke')}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="hint" style={{ marginTop: 14, display: 'flex', gap: 7 }}>
        <span className="info-i">ⓘ</span>
        <span>{t('ik_doc_note')}</span>
      </div>
      <div className="hint" style={{ marginTop: 8, display: 'flex', gap: 7 }}>
        <span className="info-i">ⓘ</span>
        <span>{t('ik_oauth_note')}</span>
      </div>

      <div className="card card-pad" style={{ marginTop: 14 }}>
        <h2 className="sec-title">{t('ik_handbook_title')}</h2>
        <DownloadHandbookButton />
      </div>

      {creating && (
        <CreateClientModal
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setNewKey(c);
            reload();
          }}
        />
      )}
      {newKey && <RevealKeyModal client={newKey} onClose={() => setNewKey(null)} />}
    </div>
  );
}

function CreateClientModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: ApiClient) => void }) {
  const [name, setName] = useState('');
  // 默认全选(单租户模型:API Key = admin 机器分身,通常需要全部能力;可按需取消勾选收窄)。
  const [scopes, setScopes] = useState<string[]>([...VALID_SCOPES]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  function toggle(s: string) {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  async function create() {
    setErr('');
    if (!name.trim() || scopes.length === 0) {
      setErr(t('error_generic'));
      return;
    }
    setBusy(true);
    try {
      const c = await api.createApiClient({ name: name.trim(), scopes });
      onCreated(c);
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('ik_new')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" onClick={create} disabled={busy}>
            {busy ? t('loading') : t('create')}
          </button>
        </>
      }
    >
      {err && <div className="login-err" style={{ marginTop: 0, marginBottom: 14 }}>{err}</div>}
      <div className="field">
        <label>{t('ik_th_name')}</label>
        <input className="input" value={name} placeholder="招聘系统-ATS" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>{t('ik_th_scopes')}</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          {VALID_SCOPES.map((s) => (
            <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
              <span className="sip-code">{s}</span>
            </label>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 8, fontSize: 12 }}>{t('ik_scope_hint')}</p>
      </div>
    </Modal>
  );
}

function RevealKeyModal({ client, onClose }: { client: ApiClient; onClose: () => void }) {
  const { toast } = useToast();
  return (
    <Modal
      title={t('ik_created')}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t('confirm')}
        </button>
      }
    >
      <div className="warn-box">
        <span>⚠</span>
        <div>{t('ik_once_warn')}</div>
      </div>
      <div className="field">
        <label>{t('ik_api_key')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" readOnly value={client.api_key || ''} style={{ flex: 1, fontFamily: 'ui-monospace,Menlo,monospace' }} />
          <button
            className="btn btn-sm"
            onClick={() => {
              navigator.clipboard?.writeText(client.api_key || '');
              toast(t('ik_copied'));
            }}
          >
            {t('copy')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
