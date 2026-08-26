// design contract:REST 401 静默续期 + 重放一次 guard + 并发单飞。
//
// 本仓前端测试用原生 node --test(无 jest/tsx),而 api.ts / appState.ts 用无扩展名 TS import
// (`./config`)+ react,原生 ESM 解析器跑不起来。故本测试分两层守门:
//   (1) 行为层:复刻 requestOnce 的 401→续期→重放一次状态机(与 api.ts 逐行对应),验证四条不变式;
//   (2) 源码守门层:文本断言 api.ts / appState.ts 确实实现了该 guard(防重构悄悄改回「401 直接登出」)。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── (1) 行为层:复刻 api.ts::requestOnce 的 401 guard(逐行对应,便于回读校对)──
// 依赖注入:fetchImpl(url,{headers})→{status}、tokenGetter、tokenRefresher(→ 新 token|null)、onUnauthorized。
async function requestOnce(state, retryAuth) {
  const token = state.tokenGetter();
  const r = await state.fetchImpl({ Authorization: token ? `Bearer ${token}` : undefined });
  if (r.status === 401 && retryAuth) {
    const fresh = await state.tokenRefresher(); // 单飞在 refresher 内部
    if (fresh) return requestOnce(state, false); // 用新 token 重放一次(不再续期)
    state.onUnauthorized();
    throw Object.assign(new Error('401'), { status: 401 });
  }
  if (r.status === 401) state.onUnauthorized(); // 重放仍 401 → 登出,MUST NOT 再续期
  if (r.status >= 400) throw Object.assign(new Error(String(r.status)), { status: r.status });
  return r.body;
}
const request = (state) => requestOnce(state, true);

test('401 → 续期成功 → 用新 token 重放一次成功(用户无感)', async () => {
  let tok = 'OLD';
  const auths = [];
  let refreshCount = 0, loggedOut = false;
  const out = await request({
    tokenGetter: () => tok,
    tokenRefresher: async () => { refreshCount++; tok = 'NEW'; return 'NEW'; },
    onUnauthorized: () => { loggedOut = true; },
    fetchImpl: async (h) => {
      auths.push(h.Authorization);
      return h.Authorization === 'Bearer OLD' ? { status: 401 } : { status: 200, body: { username: 'u1' } };
    },
  });
  assert.deepEqual(out, { username: 'u1' });
  assert.equal(refreshCount, 1, '续期恰好一次');
  assert.equal(loggedOut, false, '成功续期不登出');
  assert.deepEqual(auths, ['Bearer OLD', 'Bearer NEW'], '首次旧 token 401 → 重放用新 token');
});

test('重放仍 401 → 登出,且 MUST NOT 再续期(防递归)', async () => {
  let refreshCount = 0, loggedOut = false;
  await assert.rejects(() => request({
    tokenGetter: () => 'OLD',
    tokenRefresher: async () => { refreshCount++; return 'NEW'; }, // 续期"成功"但重放仍 401
    onUnauthorized: () => { loggedOut = true; },
    fetchImpl: async () => ({ status: 401 }), // 恒 401
  }), (e) => e.status === 401);
  assert.equal(refreshCount, 1, '只续期一次(重放仍 401 后不再续期,杜绝无限环)');
  assert.equal(loggedOut, true, '重放仍 401 → 登出');
});

test('续期失败(返回 null)→ 登出,不重放', async () => {
  let calls = 0, loggedOut = false;
  await assert.rejects(() => request({
    tokenGetter: () => 'OLD',
    tokenRefresher: async () => null, // refresh 逾期/被吊销/网络错
    onUnauthorized: () => { loggedOut = true; },
    fetchImpl: async () => { calls++; return { status: 401 }; },
  }), (e) => e.status === 401);
  assert.equal(loggedOut, true, '续期失败 → 登出');
  assert.equal(calls, 1, '续期失败不重放(仅首次那一发)');
});

test('并发多请求同时 401 → 单飞只续期一次', async () => {
  let tok = 'OLD', refreshCount = 0, inflight = null;
  // 复刻 appState.refreshAccessTokenSingleFlight 的单飞语义。
  const singleFlight = () => {
    if (inflight) return inflight;
    inflight = (async () => { refreshCount++; await Promise.resolve(); tok = 'NEW'; return 'NEW'; })()
      .finally(() => { inflight = null; });
    return inflight;
  };
  const mk = () => request({
    tokenGetter: () => tok,
    tokenRefresher: singleFlight,
    onUnauthorized: () => {},
    fetchImpl: async (h) => (h.Authorization === 'Bearer OLD' ? { status: 401 } : { status: 200, body: { ok: true } }),
  });
  const rs = await Promise.all([mk(), mk(), mk()]);
  assert.deepEqual(rs, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(refreshCount, 1, '三个并发 401 只触发一次续期(单飞)');
});

// ── (2) 源码守门层:确保真实源码实现了上述 guard(防重构漂移回「401 直接登出」)──
test('源码守门:api.ts 实现 401→续期→重放一次 guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/lib/api.ts'), 'utf8');
  assert.match(src, /setTokenRefresher/, 'api.ts 须暴露 setTokenRefresher 注入点');
  assert.match(src, /requestOnce<T>\(path, opts, false\)/, '续期成功后须以 retryAuth=false 重放一次');
  assert.match(src, /res\.status === 401 && retryAuth/, '须有「首次 401 才续期」的一次性 guard 分支');
  // 重放路径(retryAuth=false)仍 401 时只登出、不再调 refresher(防递归)——确保 _tokenRefresher 只在 retryAuth 分支调。
  const refresherCalls = (src.match(/_tokenRefresher\(/g) || []).length;
  assert.equal(refresherCalls, 1, '_tokenRefresher 只在首次 401 分支调用一次(防重放路径再续期)');
});

test('源码守门:appState.ts 单飞续期 + 注入 refresher', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/lib/appState.ts'), 'utf8');
  assert.match(src, /setTokenRefresher\(/, 'appState 须把续期回调注入 api');
  assert.match(src, /_refreshInFlight/, '须有单飞 in-flight promise(并发 401 共享一次续期)');
  assert.match(src, /refreshAccessTokenSingleFlight/, '须有单飞续期核心函数');
});
