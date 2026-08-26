// 轻量 UI 原语:toast、应用内确认框(替代浏览器原生 confirm)、加载/错误。无第三方组件库。
'use client';
import React, { createContext, useCallback, useContext, useState } from 'react';
import { t } from './i18n';

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface UICtx {
  toast: (msg: string) => void;
  /** 应用内确认框:返回 Promise<boolean>(确认=true / 取消=false)。 */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<UICtx>({ toast: () => {}, confirm: async () => false });

interface ConfirmState extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState('');
  const [show, setShow] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const toast = useCallback((m: string) => {
    setMsg(m);
    setShow(true);
    window.setTimeout(() => setShow(false), 2600);
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ ...opts, resolve });
    });
  }, []);

  const finish = (v: boolean) => {
    if (confirmState) confirmState.resolve(v);
    setConfirmState(null);
  };

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div id="toast" className={show ? 'show' : ''}>
        {msg}
      </div>
      {confirmState && (
        <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) finish(false); }}>
          <div className="modal" style={{ width: 420 }} role="alertdialog" aria-modal="true">
            <div className="modal-head">
              <h3>{confirmState.title}</h3>
              <button className="close-x" onClick={() => finish(false)} aria-label="close">
                ✕
              </button>
            </div>
            {confirmState.message && (
              <div className="modal-body" style={{ fontSize: 13.5, color: 'var(--text-soft)' }}>
                {confirmState.message}
              </div>
            )}
            <div className="modal-foot">
              <button className="btn" onClick={() => finish(false)}>
                {confirmState.cancelLabel || t('cancel')}
              </button>
              <button
                className={'btn ' + (confirmState.danger ? 'btn-danger' : 'btn-primary')}
                onClick={() => finish(true)}
                autoFocus
              >
                {confirmState.confirmLabel || t('confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useToast(): UICtx {
  return useContext(Ctx);
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="center-load">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="err-banner" role="alert">
      <span>⚠</span>
      <span>{message}</span>
    </div>
  );
}
