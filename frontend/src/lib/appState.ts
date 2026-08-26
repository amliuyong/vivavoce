// 应用级状态:登录会话 + 语言响应式刷新。token 注入 API 客户端。
'use client';
import { useEffect, useState, useCallback } from 'react';
import { type Session, currentSession, logout as cognitoLogout } from './auth';
import { setTokenGetter, setUnauthorizedHandler, setTokenRefresher } from './api';
import { getLang, onLangChange, type Lang } from './i18n';

let _session: Session | null = null;
setTokenGetter(() => _session?.accessToken || null);
// 401:清会话 + 跳登录页(token 失效不让用户卡在半登录态)。
function handleUnauthorized(): void {
  cognitoLogout();
  setSession(null);
  if (typeof location !== 'undefined' && location.hash !== '#/login') {
    location.replace('#/login');
  }
}
setUnauthorizedHandler(handleUnauthorized);
// 静默续期回调(design contract):REST 遇 401 → api.ts 调此,用 refresh token 换新 access token 重放。
// 复用 freshAccessToken(内部 currentSession → Cognito getSession 用缓存 refresh token 续期 + 同步内存
// session)。**单飞**:并发多请求同时 401 时只发起一次续期,全部共享同一 in-flight promise(防 N 次并发
// 续期 token race)。成功返回新 token,失败返回 null(api.ts 据此登出)。
setTokenRefresher(() => refreshAccessTokenSingleFlight());

// 续期单飞(design contract):并发多路(REST 401 + WS 刷新)同时要新 token 时,只发起**一次** currentSession
// (内部 Cognito getSession 用缓存 refresh token 续期),全部共享同一 in-flight promise,避免并发续期
// token race。promise 结束(成功/失败)即清空,下次过期重新单飞。
let _refreshInFlight: Promise<string | null> | null = null;

/** 单飞续期核心:续期成功 → 更新内存 session 返回新 token;失败 → 返回 null(**不**登出,登出由调用方决定)。 */
export function refreshAccessTokenSingleFlight(): Promise<string | null> {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    const s = await currentSession();
    if (s) {
      setSession(s);
      return s.accessToken;
    }
    return null;
  })()
    .catch((err) => {
      // 续期抛错(网络异常等)= 视作续期失败,返回 null 交调用方处置(不吞成 undefined)。
      // 记原始错误(review):否则真机只见"登出"、看不到真因(网络/Cognito 5xx/代码 bug),无从排障。
      console.error('[appState] 静默续期失败(将登出):', err);
      return null;
    })
    .finally(() => {
      _refreshInFlight = null;
    });
  return _refreshInFlight;
}

/**
 * 取**新鲜** access token,供 WS 等不经 api.ts(无 401 自动续期/登出)的路径调用。
 *
 * 内存里的 `_session.accessToken` 是登录那一刻的快照,access token 默认 60min 过期后**不会自动变**
 * —— Cognito 的 refresh token 缓存在 localStorage,但只有经 `currentSession()`(内部 `user.getSession`)
 * 取才会用它续期。voice-test 之类的 WS 路径若直接用旧快照,超 60min 后端 verify 失败 → 「未授权」
 * (而 REST 路径会在 401 时由 api.ts 静默续期 + 重放兜底,所以不明显)。
 *
 * 续期成功 → 同步更新内存 session 并返回新 token;refresh token 也失效(>7天/被吊销/网络异常)→ 走登出跳
 * 登录并返回 null。走单飞(与 REST 401 续期共享一次),此路径额外在失败时登出(WS 无 api.ts 的登出兜底)。
 */
export async function freshAccessToken(): Promise<string | null> {
  const token = await refreshAccessTokenSingleFlight();
  if (token) return token;
  handleUnauthorized();
  return null;
}

const sessionListeners = new Set<() => void>();
export function setSession(s: Session | null): void {
  _session = s;
  sessionListeners.forEach((fn) => fn());
}
export function getSession(): Session | null {
  return _session;
}

export function useSession(): Session | null {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    sessionListeners.add(fn);
    return () => {
      sessionListeners.delete(fn);
    };
  }, []);
  return _session;
}

/** 启动时尝试恢复登录态(SRP refresh token 仍有效则免登录)。 */
export function useRestoreSession(ready: boolean): boolean {
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    currentSession()
      .then((s) => {
        if (!cancelled) {
          if (s) setSession(s);
          setRestored(true);
        }
      })
      .catch(() => {
        if (!cancelled) setRestored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [ready]);
  return restored;
}

export function doLogout(): void {
  cognitoLogout();
  setSession(null);
}

/** 语言响应式:组件订阅,切换语言时重渲染。返回当前语言。 */
export function useLang(): Lang {
  const [lang, setL] = useState<Lang>(getLang());
  useEffect(() => onLangChange(() => setL(getLang())), []);
  return lang;
}

/** hash 路由响应式:返回当前 hash(去 # 前缀)。 */
export function useHash(): string {
  const [hash, setHash] = useState(typeof location !== 'undefined' ? location.hash : '');
  useEffect(() => {
    const fn = () => setHash(location.hash);
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  return hash;
}

/** 通用数据加载 hook:返回 {data, error, loading, reload}。 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | null;
  error: string;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fn()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload };
}
