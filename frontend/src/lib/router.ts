// Hash 路由(design contract):每页/下钻可 Bookmark/分享/刷新保持。
// 报告是会话内下钻(#/sessions/<id>/report)。语言/角色绝不进 hash。
'use client';

export interface Route {
  view: string;
  params: Record<string, string>;
}

export function parseHash(): Route {
  // 先剥掉查询串(如 #/sessions?origin=staff),否则 seg[0] 会变成 "sessions?origin=staff"
  // 而匹配不到 case 'sessions',错落到 default。查询参数由调用方(page.tsx hashQuery)单独解析。
  const raw = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '').trim();
  const h = raw.split('?')[0];
  if (!h) return { view: 'voice-chat', params: {} };  // 默认 home = 语音 Chat(产品第一入口)
  const seg = h.split('/').filter(Boolean);
  switch (seg[0]) {
    case 'login':
      return { view: 'login', params: {} };
    case 'candidate': {
      // 候选人对外自助门户(design contract):公开页,无 Cognito 登录。token 作 **hash 路径段** `#/candidate/<token>`
      // (在 hash 内,不进 query/Referer/CloudFront access log —— 对外一次性 token 零泄漏面,review)。
      // token 由 HR 侧签发拼 URL 时 encodeURIComponent,这里解码还原。
      let token = '';
      try {
        token = decodeURIComponent(seg.slice(1).join('/'));
      } catch {
        token = seg.slice(1).join('/');
      }
      return { view: 'candidate', params: { token } };
    }
    case 'overview':
      return { view: 'overview', params: {} };
    case 'agents':
      if (seg[1] === 'new') return { view: 'agent-editor', params: { isNew: '1' } };
      if (seg[1] === 'edit') return { view: 'agent-editor', params: { id: seg[2] || '' } };
      return { view: 'agents', params: {} };
    case 'question-banks':
      if (seg[1] === 'new') return { view: 'qb-editor', params: { isNew: '1' } };
      if (seg[1] === 'edit') return { view: 'qb-editor', params: { id: seg[2] || '' } };
      return { view: 'question-banks', params: {} };
    case 'sessions':
      if (seg[1] && seg[2] === 'report') return { view: 'report', params: { id: seg[1] } };
      if (seg[1]) return { view: 'monitor', params: { id: seg[1] } };
      return { view: 'sessions', params: {} };
    case 'voice-chat':
      return { view: 'voice-chat', params: {} };
    case 'integration':
      return { view: 'integration', params: {} };
    case 'api-docs':
      return { view: 'api-docs', params: {} };
    case 'gpu-capacity':
      return { view: 'gpu-capacity', params: {} };
    case 'system-settings':
      return { view: 'system-settings', params: {} };
    case 'tts-settings':
      return { view: 'tts-settings', params: {} };
    case 'exam':
      // 考试页(M1-C):登录用户(staff 本人 / admin 代考测试)浏览器直连实时语音口试。
      // 不进 Sidebar,从「我的考试」/会话列表进入。staff/admin 都可达(不进 ADMIN/STAFF_VIEWS 守卫表)。
      return { view: 'exam', params: { id: seg[1] || '' } };
    case 'my-meetings':
      if (seg[1] && seg[2] === 'report') return { view: 'my-report', params: { id: seg[1] } };
      return { view: 'my-meetings', params: {} };
    default:
      return { view: 'voice-chat', params: {} };  // 默认 home = 语音 Chat(含旧 #/book 深链)
  }
}

export function navigate(hash: string): void {
  if (location.hash === hash) {
    // 同 hash 不触发 hashchange,手动重渲染
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}

export function replaceHash(hash: string): void {
  location.replace('#' + (hash.startsWith('#') ? hash.slice(1) : hash).replace(/^#/, ''));
}

// admin 专属视图 / staff 专属视图(路由守卫用)。
// voice-chat 面向**所有登录用户**(admin+staff),故不进任一专属表(与 exam 同,守卫放行两角色)。
export const ADMIN_VIEWS = [
  'overview',
  'sessions',
  'monitor',
  'report',
  'agents',
  'agent-editor',
  'question-banks',
  'qb-editor',
  'integration',
  'api-docs',
  'gpu-capacity',
  'system-settings',
  'tts-settings',
];
export const STAFF_VIEWS = ['my-meetings', 'my-report'];

// 登录后默认落地:两角色都到语音 Chat(产品第一入口)。
export const ROLE_HOME = { admin: '#/voice-chat', staff: '#/voice-chat' } as const;
