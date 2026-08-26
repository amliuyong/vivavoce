'use client';
import React, { useState } from 'react';
import { t, setLang, getLang } from '@/lib/i18n';
import { useLang, setSession } from '@/lib/appState';
import { login, completeNewPassword } from '@/lib/auth';
import { ROLE_HOME, replaceHash } from '@/lib/router';
import { Field } from './Field';
import type { CognitoUser } from 'amazon-cognito-identity-js';

export function Login() {
  useLang();
  const lang = getLang();
  const [email, setEmail] = useState('');
  const [pwd, setPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<{ user: CognitoUser; userAttributes: Record<string, string> } | null>(
    null,
  );

  function finish(role: { isAdmin: boolean }) {
    replaceHash(role.isAdmin ? ROLE_HOME.admin : ROLE_HOME.staff);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const res = await login(email.trim(), pwd);
      if (res.newPasswordRequired) {
        setChallenge(res.newPasswordRequired);
        setBusy(false);
        return;
      }
      if (res.session) {
        setSession(res.session);
        finish(res.session);
      }
    } catch (e2: unknown) {
      setErr((e2 instanceof Error ? e2.message : '') || t('login_failed'));
      setBusy(false);
    }
  }

  async function onSetNewPwd(e: React.FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setErr('');
    setBusy(true);
    try {
      const session = await completeNewPassword(challenge.user, newPwd, challenge.userAttributes);
      setSession(session);
      finish(session);
    } catch (e2: unknown) {
      setErr((e2 instanceof Error ? e2.message : '') || t('login_failed'));
      setBusy(false);
    }
  }

  return (
    <div id="login-screen" className="show">
      <div className="login-card">
        <div className="login-logo">
          <span className="logo">🎙</span> {t('app_name')}
        </div>
        <div className="login-sub">{t('login_sub')}</div>

        {!challenge ? (
          <form onSubmit={onSubmit}>
            <Field label={t('login_email')}>
              <input
                className="input"
                type="text"
                value={email}
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label={t('login_pwd')}>
              <input
                className="input"
                type="password"
                value={pwd}
                autoComplete="current-password"
                onChange={(e) => setPwd(e.target.value)}
              />
            </Field>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {busy ? t('loading') : t('login_btn')}
            </button>
          </form>
        ) : (
          <form onSubmit={onSetNewPwd}>
            <Field label={t('login_new_pwd')}>
              <input
                className="input"
                type="password"
                value={newPwd}
                placeholder={t('login_new_pwd_ph')}
                autoComplete="new-password"
                onChange={(e) => setNewPwd(e.target.value)}
              />
            </Field>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {busy ? t('loading') : t('login_set_pwd_btn')}
            </button>
          </form>
        )}

        {err && <div className="login-err">{err}</div>}

        <div className="login-roles">{t('login_roles_note')}</div>

        <div className="login-lang">
          <div className="lang-switch">
            <button className={lang === 'zh' ? 'active' : ''} onClick={() => setLang('zh')} type="button">
              {t('lang_zh')}
            </button>
            <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')} type="button">
              {t('lang_en')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
