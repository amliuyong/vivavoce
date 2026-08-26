'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { loadConfig } from '@/lib/config';
import { initLang, assertKeysAligned, t } from '@/lib/i18n';
import { ToastProvider, Loading } from '@/lib/ui';
import { useSession, useRestoreSession, useHash } from '@/lib/appState';
import { parseHash, replaceHash, ADMIN_VIEWS, STAFF_VIEWS, ROLE_HOME } from '@/lib/router';
import { Sidebar } from '@/components/Sidebar';
import { Login } from '@/components/Login';

import { Overview } from '@/views/Overview';
import { Sessions } from '@/views/Sessions';
import { Monitor } from '@/views/Monitor';
import { Report } from '@/views/Report';
import { Agents } from '@/views/Agents';
import { AgentEditor } from '@/views/AgentEditor';
import { QuestionBanks } from '@/views/QuestionBanks';
import { QuestionBankEditor } from '@/views/QuestionBankEditor';
import { VoiceChat } from '@/views/VoiceChat';
import { Integration } from '@/views/Integration';
import { ApiDocs } from '@/views/ApiDocs';
import { GpuCapacity } from '@/views/GpuCapacity';
import { SystemSettings } from '@/views/SystemSettings';
import { TtsSettings } from '@/views/TtsSettings';
import { MyMeetings } from '@/views/MyMeetings';
import { Exam } from '@/views/Exam';
import { CandidatePortal } from '@/views/CandidatePortal';

// 把查询串(如 #/sessions?origin=staff)的参数解析出来
function hashQuery(hash: string): Record<string, string> {
  const qi = hash.indexOf('?');
  if (qi < 0) return {};
  const out: Record<string, string> = {};
  new URLSearchParams(hash.slice(qi + 1)).forEach((v, k) => (out[k] = v));
  return out;
}

function Shell() {
  const session = useSession();
  const hash = useHash();

  const route = useMemo(() => parseHash(), [hash]);
  const query = useMemo(() => hashQuery(hash), [hash]);

  // ── 候选人对外门户(design contract):公开页,**在登录守卫之前**渲染,凭 ?token= 鉴权,不需 Cognito 会话。
  //    无 token 显示提示(链接无效)。无 Sidebar、不跳登录。
  const isCandidate = route.view === 'candidate';

  // 路由守卫 + 登录守卫(在 effect 里做重定向,避免渲染期 setState)。候选人页豁免。
  useEffect(() => {
    if (isCandidate || route.view === 'login') return;
    if (!session) {
      if (hash !== '#/login') replaceHash('#/login');
      return;
    }
    if (session.isAdmin && STAFF_VIEWS.includes(route.view)) {
      replaceHash(ROLE_HOME.admin);
      return;
    }
    if (!session.isAdmin && ADMIN_VIEWS.includes(route.view)) {
      replaceHash(ROLE_HOME.staff);
      return;
    }
  }, [route.view, session, hash, isCandidate]);

  // 候选人对外门户(公开,优先于登录守卫):token 在 hash 路径段(#/candidate/<token>,不进 query/Referer/log,
  // review)。有 token 渲染门户,无 token 提示链接无效。
  if (isCandidate) {
    return route.params.token ? <CandidatePortal token={route.params.token} /> : <CandidateInvalid />;
  }

  // 未登录:登录页
  if (!session || route.view === 'login') {
    return <Login />;
  }

  // 守卫期间(将被重定向)先不渲染错误页
  if (session.isAdmin && STAFF_VIEWS.includes(route.view)) return null;
  if (!session.isAdmin && ADMIN_VIEWS.includes(route.view)) return null;

  let view: React.ReactNode = null;
  switch (route.view) {
    case 'voice-chat':
      view = <VoiceChat />;
      break;
    case 'overview':
      view = <Overview />;
      break;
    case 'sessions':
      view = <Sessions />;
      break;
    case 'monitor':
      view = <Monitor id={route.params.id} />;
      break;
    case 'report':
      view = <Report id={route.params.id} />;
      break;
    case 'agents':
      view = <Agents />;
      break;
    case 'agent-editor':
      view = <AgentEditor id={route.params.id} isNew={route.params.isNew === '1'} />;
      break;
    case 'question-banks':
      view = <QuestionBanks />;
      break;
    case 'qb-editor':
      view = <QuestionBankEditor id={route.params.id} isNew={route.params.isNew === '1'} />;
      break;
    case 'integration':
      view = <Integration />;
      break;
    case 'api-docs':
      view = <ApiDocs />;
      break;
    case 'gpu-capacity':
      view = <GpuCapacity />;
      break;
    case 'tts-settings':
      view = <TtsSettings />;
      break;
    case 'system-settings':
      view = <SystemSettings />;
      break;
    case 'my-meetings':
      view = <MyMeetings />;
      break;
    case 'my-report':
      view = <Report id={route.params.id} staffMode />;
      break;
    case 'exam':
      // 考试页(M1-C):staff 本人 / admin 代考测试均可达(不在 ADMIN/STAFF_VIEWS 守卫表;
      // 归属校验在后端 /join,staff 只能连自己的会话)。
      view = <Exam id={route.params.id} />;
      break;
    default:
      view = <VoiceChat />;
  }

  return (
    <>
      <Sidebar view={route.view} />
      <div className="views">
        <div className="active">{view}</div>
      </div>
    </>
  );
}

/** 候选人链接缺 token(无效/被截断):不跳登录,只给可读提示。 */
function CandidateInvalid() {
  return (
    <div className="cand-portal">
      <div className="cand-card">
        <div className="cand-head">
          <div className="cand-logo">VivaVoce</div>
          <h1 className="cand-title">{t('cp_title')}</h1>
        </div>
        <div className="login-err">{t('cp_invalid_link')}</div>
      </div>
    </div>
  );
}

export default function Page() {
  const [ready, setReady] = useState(false);
  const restored = useRestoreSession(ready);

  useEffect(() => {
    // 开发期校验 i18n key 对齐(缺孤儿即抛,早暴露)
    if (process.env.NODE_ENV !== 'production') {
      try {
        assertKeysAligned();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
      }
    }
    initLang();
    loadConfig().then(() => setReady(true));
  }, []);

  if (!ready || !restored) {
    return (
      <div className="views" style={{ marginLeft: 0 }}>
        <Loading label="加载中…" />
      </div>
    );
  }

  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
