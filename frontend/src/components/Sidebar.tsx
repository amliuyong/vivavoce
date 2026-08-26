'use client';
import React from 'react';
import { t, setLang, getLang } from '@/lib/i18n';
import { useSession, useLang, doLogout } from '@/lib/appState';
import { navigate } from '@/lib/router';

interface NavItem {
  nav: string;
  hash: string;
  ico: string;
  label: () => string;
  preview?: boolean;
}

const ADMIN_NAV: NavItem[] = [
  { nav: 'voice-chat', hash: '#/voice-chat', ico: '🎤', label: () => t('nav_voice_chat') },
  { nav: 'agents', hash: '#/agents', ico: '📋', label: () => t('nav_agents') },
  { nav: 'sessions', hash: '#/sessions', ico: '🎙', label: () => t('nav_sessions') },
  { nav: 'overview', hash: '#/overview', ico: '▦', label: () => t('nav_overview') },
  { nav: 'question-banks', hash: '#/question-banks', ico: '📚', label: () => t('nav_question_banks') },
  { nav: 'integration', hash: '#/integration', ico: '🔌', label: () => t('nav_integration') },
  { nav: 'api-docs', hash: '#/api-docs', ico: '📖', label: () => t('nav_api_docs') },
  { nav: 'gpu-capacity', hash: '#/gpu-capacity', ico: '🖥', label: () => t('nav_gpu_capacity') },
  { nav: 'tts-settings', hash: '#/tts-settings', ico: '🗣', label: () => t('nav_tts_settings') },
  { nav: 'system-settings', hash: '#/system-settings', ico: '⚙', label: () => t('nav_system_settings') },
];
const STAFF_NAV: NavItem[] = [
  { nav: 'voice-chat', hash: '#/voice-chat', ico: '🎤', label: () => t('nav_voice_chat') },
  { nav: 'my-meetings', hash: '#/my-meetings', ico: '🗓', label: () => t('nav_my_meetings') },
];

// view → 高亮的 nav key
const NAV_OF_VIEW: Record<string, string> = {
  'voice-chat': 'voice-chat',
  overview: 'overview',
  sessions: 'sessions',
  monitor: 'sessions',
  report: 'sessions',
  agents: 'agents',
  'agent-editor': 'agents',
  'question-banks': 'question-banks',
  'qb-editor': 'question-banks',
  integration: 'integration',
  'api-docs': 'api-docs',
  'gpu-capacity': 'gpu-capacity',
  'tts-settings': 'tts-settings',
  'system-settings': 'system-settings',
  'my-meetings': 'my-meetings',
  'my-report': 'my-meetings',
};

export function Sidebar({ view }: { view: string }) {
  const session = useSession();
  useLang(); // 订阅语言变化
  const lang = getLang();
  if (!session) return null;
  const items = session.isAdmin ? ADMIN_NAV : STAFF_NAV;
  const activeNav = NAV_OF_VIEW[view] || view;
  const initials = session.isAdmin ? 'AD' : 'ST';
  const roleLabel = session.isAdmin ? t('role_admin') : t('role_staff');

  // 点 brand:回到裸根路径(清掉 hash,URL 干净 https://<host>/)。空 hash 由 router 默认落到语音 Chat home。
  // 若已在裸根(无 hash),手动触发 hashchange 重渲染(navigate 同 hash 已处理,这里空 hash 特判)。
  const goHome = () => {
    if (location.hash) {
      history.pushState('', '', location.pathname + location.search);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  };

  return (
    <div className="sidebar" id="sidebar">
      <div
        className="brand"
        style={{ cursor: 'pointer' }}
        onClick={goHome}
      >
        <span className="logo">🎙</span> <span>{t('app_name')}</span>
      </div>
      <div className="nav-group">
        {items.map((it) => (
          <div
            key={it.nav}
            className={'navlink' + (it.nav === activeNav ? ' active' : '')}
            data-nav={it.nav}
            onClick={() => navigate(it.hash)}
          >
            <span className="nav-ico">{it.ico}</span>
            <span>{it.label()}</span>
            {it.preview && <span className="preview-pill">{t('coming_soon')}</span>}
          </div>
        ))}
      </div>
      <div className="nav-bottom">
        <div className="lang-switch" id="nav-lang-switch">
          <button className={lang === 'zh' ? 'active' : ''} onClick={() => setLang('zh')}>
            {t('lang_zh')}
          </button>
          <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>
            {t('lang_en')}
          </button>
        </div>
        <div className="nav-user">
          <span className="avatar">{initials}</span>
          <span title={session.email}>{session.email || session.username}</span>
          <span className="badge-pill">{roleLabel}</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => { doLogout(); navigate('#/login'); }}>
          {t('logout')}
        </button>
      </div>
    </div>
  );
}
