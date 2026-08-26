// design contract:报告页评测进行中轮询 + 状态区分。
//
// 与 api-refresh.test.js 同策略:Report.tsx 是 TS+React(原生 node test 跑不了),故分两层:
//   (1) 行为层:复刻 useReportResult 的**单次判定**状态机(与 Report.tsx 逐行对应),验证 result/session
//       状态组合 → 正确 phase + 是否继续轮询;
//   (2) 源码守门层:文本断言 Report.tsx / i18n 确实实现了轮询 + 状态区分(防重构漂移回「一次性 404 静态」)。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── (1) 行为层:复刻 useReportResult 的单次 poll 判定(与 Report.tsx::poll 对应)──
// 输入:getResult(→ {status:200,result} | {status:404}),getSession(→ {status:'completed'|'failed'|'in_progress'})、
//      elapsed(已轮询毫秒)、maxMs(上限)。输出:{ phase, willPoll }。
async function decide(state) {
  const r = await state.getResult();
  if (r.status === 200) return { phase: 'ready', willPoll: false };
  if (r.status !== 404) return { phase: 'error', willPoll: false };
  // 404:并行看 session 状态
  let sess = '';
  try { sess = (await state.getSession()).status || ''; } catch { sess = ''; }
  if (sess === 'failed') return { phase: 'no_result', willPoll: false };
  if (sess === 'in_progress' || sess === 'scheduled') return { phase: 'not_finished', willPoll: false };
  // completed(或未知)+ 404 → 评测中;超时则停(willPoll=false),否则继续轮询
  return { phase: 'evaluating', willPoll: state.elapsed < state.maxMs };
}

test('result 200 → ready,不轮询', async () => {
  const d = await decide({ getResult: async () => ({ status: 200, result: {} }), getSession: async () => ({}), elapsed: 0, maxMs: 180000 });
  assert.deepEqual(d, { phase: 'ready', willPoll: false });
});

test('404 + session completed → evaluating,继续轮询', async () => {
  const d = await decide({ getResult: async () => ({ status: 404 }), getSession: async () => ({ status: 'completed' }), elapsed: 4000, maxMs: 180000 });
  assert.equal(d.phase, 'evaluating');
  assert.equal(d.willPoll, true);
});

test('404 + session failed → no_result,不轮询', async () => {
  const d = await decide({ getResult: async () => ({ status: 404 }), getSession: async () => ({ status: 'failed' }), elapsed: 0, maxMs: 180000 });
  assert.deepEqual(d, { phase: 'no_result', willPoll: false });
});

test('404 + session in_progress → not_finished,不轮询', async () => {
  const d = await decide({ getResult: async () => ({ status: 404 }), getSession: async () => ({ status: 'in_progress' }), elapsed: 0, maxMs: 180000 });
  assert.deepEqual(d, { phase: 'not_finished', willPoll: false });
});

test('404 + completed + 超时 → 停轮询(仍 evaluating,提示稍后刷新)', async () => {
  const d = await decide({ getResult: async () => ({ status: 404 }), getSession: async () => ({ status: 'completed' }), elapsed: 200000, maxMs: 180000 });
  assert.equal(d.phase, 'evaluating');
  assert.equal(d.willPoll, false); // 超时:不再排下一次
});

test('非 404 错误 → error,不轮询', async () => {
  const d = await decide({ getResult: async () => ({ status: 500 }), getSession: async () => ({}), elapsed: 0, maxMs: 180000 });
  assert.deepEqual(d, { phase: 'error', willPoll: false });
});

test('404 + session 取不到(异常) → 兜底 evaluating 轮询', async () => {
  const d = await decide({ getResult: async () => ({ status: 404 }), getSession: async () => { throw new Error('net'); }, elapsed: 0, maxMs: 180000 });
  assert.equal(d.phase, 'evaluating');
  assert.equal(d.willPoll, true); // session 未知按评测中兜底
});

// ── (2) 源码守门层 ──
test('源码守门:Report.tsx 实现轮询 + 状态区分', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/Report.tsx'), 'utf8');
  assert.match(src, /useReportResult/, '须有轮询 hook');
  assert.match(src, /POLL_MAX_MS/, '须有轮询上限(防无限空转)');
  assert.match(src, /setTimeout\(poll/, '须定时轮询');
  assert.match(src, /e instanceof ApiError \? e\.status/, '须用 ApiError.status 判 404(非字符串启发式)');
  assert.match(src, /getSession/, '须并行取 session 状态区分评测中/未结束/失败');
  assert.match(src, /'failed'/, '须区分 session failed(不轮询)');
  // 就绪后停轮询:ready 分支 return(不排下一次 setTimeout)
  assert.match(src, /setPhase\('ready'\)/, '须有 ready 终态');
});

test('源码守门:i18n 含评测进行中文案', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/lib/i18n.ts'), 'utf8');
  assert.match(src, /rp_evaluating:/, '须有评测进行中文案');
  assert.match(src, /rp_no_result:/, '须有无结果文案');
  assert.match(src, /rp_not_finished:/, '须有通话未结束文案');
});

test('源码守门:Exam.tsx ended 后有查看报告入口', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/Exam.tsx'), 'utf8');
  assert.match(src, /gotoReport/, '须有进报告页函数');
  assert.match(src, /\/report/, '须导航到 report 路由');
  assert.match(src, /exam_view_report/, '须有查看报告按钮 i18n');
});
