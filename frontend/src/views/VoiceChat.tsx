'use client';
import React, { useEffect, useState } from 'react';
import { t, type StringKey } from '@/lib/i18n';
import { useLang, useSession } from '@/lib/appState';
import { api, type Agent, type QuestionStrategy, ApiError } from '@/lib/api';
import {
  credentialWarning,
  loadLlmCredentialStatus,
  type LlmCredentialStatusView,
} from '@/lib/llm-credential-expiry';
import { ErrorBanner } from '@/lib/ui';
import { navigate, replaceHash } from '@/lib/router';
import { Exam } from '@/views/Exam';

// 出题策略 → i18n label(展示所选 Agent 的出题方式)。
const STRATEGY_LABEL: Record<QuestionStrategy, StringKey> = {
  sequential: 'ed_strategy_sequential',
  random_n: 'ed_strategy_random_n',
  easy_to_hard: 'ed_strategy_easy_to_hard',
  random_n_easy_to_hard: 'ed_strategy_random_n_easy',
};

/**
 * 语音 Chat —— 登录后默认 home(所有登录用户),产品第一入口。
 * 选一个场景(Agent)→「开始对话」→ 即时创建正式 Session → **页内内联** Exam 实时语音对话
 * (不跳转,像原 VoiceTest 那样就地录音/显示对话;但走正式 Session 链路,有记录 + rubric 评分报告)。
 * staff 只见 self_bookable 的 Agent(后端强制 + 前端双保险);admin 见全部。
 */
export function VoiceChat() {
  useLang();
  const session = useSession();
  const isAdmin = !!session?.isAdmin;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [llmCredentialStatus, setLlmCredentialStatus] = useState<LlmCredentialStatusView | null>(null);
  // 已开始的会话 id:非空则页内内联渲染 <Exam>(就地对话,不跳转)。
  const [activeSessionId, setActiveSessionId] = useState('');

  useEffect(() => {
    // 深链一键对话:`#/voice-chat?agent=<id>`(来自 Agent 卡片/详情页的「对话」入口)——
    // 载入后自动选中该 Agent 并直接开始,免用户再选场景。解析后清掉 query 防刷新重复发起。
    const rawHash = typeof location !== 'undefined' ? location.hash : '';
    const qi = rawHash.indexOf('?');
    const wantAgent = qi >= 0 ? new URLSearchParams(rawHash.slice(qi + 1)).get('agent') || '' : '';
    api
      .listAgents()
      .then((list) => {
        // 非 admin 只保留可自助预约的 Agent(后端已过滤,前端再兜一道);仅 active。
        const usable = (list || [])
          .filter((a) => (a.status ?? 'active') === 'active')
          .filter((a) => isAdmin || a.self_bookable);
        setAgents(usable);
        if (usable[0]) setAgentId(usable[0].agent_id);
        // 深链指定的 Agent 在可用列表里 → 选中并一键开始(不在则忽略,退回正常选择态)。
        if (wantAgent && usable.some((a) => a.agent_id === wantAgent)) {
          setAgentId(wantAgent);
          if (qi >= 0) replaceHash('#/voice-chat'); // 清 query:刷新不再重复自动开始
          void start(wantAgent);
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    loadLlmCredentialStatus(api.getLlmCredentialStatus)
      .then((status) => {
        if (!cancelled) setLlmCredentialStatus(status);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = agents.find((a) => a.agent_id === agentId);
  // 预置「自由对话」Agent(DefaultAgentsSeed,固定 id);在则显示一键入口。
  const freechat = agents.find((a) => a.agent_id === 'agent_freechat_default');

  async function start(useAgentId?: string) {
    const aid = useAgentId || agentId;
    if (!aid) {
      setErr(t('vc_no_agent'));
      return;
    }
    setErr('');
    setBusy(true);
    try {
      // 即时开始:只传 agent_id(+ booked_by_email 供「发起人」可读展示,归属仍按 sub)。
      // 后端创建 scheduled 会话即刻可连入(无预约窗)。
      const body: Record<string, unknown> = { agent_id: aid };
      if (session?.email) body.booked_by_email = session.email;
      const s = await api.createSession(body);
      setActiveSessionId(s.session_id); // 页内内联 Exam(不跳转)
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // 已开始:页内内联真实对话(Exam 连 /rt/ws)。顶部给「再来一场」入口回到选择态。
  if (activeSessionId) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t('nav_voice_chat')}</h1>
            <div className="page-sub">{selected?.name || ''}</div>
          </div>
          <button className="btn" onClick={() => setActiveSessionId('')}>
            {t('vc_new_chat')}
          </button>
        </div>
        <LlmCredentialWarningBanner state={llmCredentialStatus} isAdmin={isAdmin} />
        {/* key=session_id 强制换会话时 remount:确保上一场 Exam 的 WS/麦克风经卸载 cleanup 彻底释放,
            不复用实例导致旧 WS/mic 泄漏(review)。autoStart:一挂载即进对话,免二次点击。 */}
        <Exam key={activeSessionId} id={activeSessionId} autoStart embedded />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('nav_voice_chat')}</h1>
          <div className="page-sub">{t('vc_sub')}</div>
        </div>
      </div>

      <LlmCredentialWarningBanner state={llmCredentialStatus} isAdmin={isAdmin} />
      <ErrorBanner message={err} />

      {/* 一键「自由对话」:直接用预置的「自由对话」Agent 开聊,无需先选场景(用户常见诉求)。
          仅当该 Agent 在可用列表里(已 seed 且当前角色可用)才显示。 */}
      {freechat && (
        <div className="card card-pad" style={{ maxWidth: 560, marginBottom: 14 }}>
          <button
            className="btn btn-primary btn-lg"
            onClick={() => start(freechat.agent_id)}
            disabled={busy || loading}
            style={{ width: '100%' }}
          >
            {busy ? t('vc_starting') : `💬 ${t('vc_freechat')}`}
          </button>
          <div className="hint" style={{ marginTop: 8 }}>{t('vc_freechat_hint')}</div>
        </div>
      )}

      <div className="card card-pad" style={{ maxWidth: 560 }}>
        <div className="field">
          <label>{t('vc_pick_agent')}</label>
          <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={busy}>
            {loading && <option value="">{t('loading')}</option>}
            {!loading && agents.length === 0 && <option value="">{t('vc_no_agent_avail')}</option>}
            {agents.map((a) => (
              <option key={a.agent_id} value={a.agent_id}>
                {a.name} {a.version ? `(${a.version})` : ''}
              </option>
            ))}
          </select>
          {selected && (
            <div className="profile-summary">
              {t(STRATEGY_LABEL[selected.question_strategy || 'sequential'])} ·{' '}
              {selected.rubric?.mode === 'per_question_check'
                ? `${t('pf_pass_line')} ${Math.round((selected.rubric.pass_threshold ?? 0.8) * 100)}%`
                : t('ed_mode_rubric')}
            </div>
          )}
        </div>

        <button
          className="btn btn-primary btn-lg"
          onClick={() => start()}
          disabled={busy || loading || !agentId}
          style={{ width: '100%', marginTop: 8 }}
        >
          {busy ? t('vc_starting') : `🎤 ${t('vc_start')}`}
        </button>
        <div className="hint" style={{ marginTop: 10 }}>{t('vc_hint')}</div>
      </div>
    </div>
  );
}

function LlmCredentialWarningBanner({
  state,
  isAdmin,
}: {
  state: LlmCredentialStatusView | null;
  isAdmin: boolean;
}) {
  const warning = credentialWarning(state, isAdmin);
  if (!warning) return null;
  const expires = warning.expiresAt
    ? new Date(warning.expiresAt).toLocaleString()
    : '';
  const message = t(warning.messageKey).replace('{expires}', expires);
  return (
    <div className={`credential-warning ${warning.tone}`} role="alert">
      <span className="credential-warning-mark" aria-hidden="true">!</span>
      <span className="credential-warning-text">{message}</span>
      {warning.showManage && (
        <button className="btn btn-sm" type="button" onClick={() => navigate('#/tts-settings')}>
          {t('vc_llm_manage')}
        </button>
      )}
    </div>
  );
}
