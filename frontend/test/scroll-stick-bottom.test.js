// design contract:字幕面板 stick-to-bottom 自动滚动纯逻辑 + Exam.tsx 源码守门。
//
// bug(真机反馈):右侧 transcript 不总滚到最新,尤其 AI 长气泡需手动下拉。根因:原自动滚 useEffect 在
// 新气泡 commit 后用 `scrollHeight-scrollTop-clientHeight < 80` 判「近底」——AI 长回复(>80px)commit 后把
// scrollHeight 撑大 → 判据被自己撑破 → nearBottom=false → 不滚。
// 修复:stickToBottom 状态在 onScroll(无新内容注入的稳定态)测量,新内容 effect 只读该状态滚到底。
//
// 前端无 jsdom(见 test/exam-waveform-tap.test.js 策略):纯逻辑直 import @/lib/scroll 变异自证 + 源码守门。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { shouldStickToBottom, STICK_BOTTOM_THRESHOLD_PX } = require('../src/lib/scroll.ts');

// ── 纯逻辑 shouldStickToBottom(变异自证:改判据即红)──

test('底部(diff=0)→ 跟随', () => {
  // scrollHeight=1000 scrollTop=800 clientHeight=200 → diff=0
  assert.equal(shouldStickToBottom(1000, 800, 200), true);
});

test('底部附近(diff=50 ≤ 120 阈值)→ 跟随(AI 长气泡 commit 后仍跟随)', () => {
  // scrollHeight=1000 scrollTop=750 clientHeight=200 → diff=50
  assert.equal(shouldStickToBottom(1000, 750, 200), true);
});

test('用户上滚看历史(diff=500 > 阈值)→ 不跟随(不强行拉回)', () => {
  // scrollHeight=1000 scrollTop=300 clientHeight=200 → diff=500
  assert.equal(shouldStickToBottom(1000, 300, 200), false);
});

test('过底/回弹(diff<0)→ 跟随', () => {
  assert.equal(shouldStickToBottom(1000, 900, 200), true); // diff=-100
});

test('阈值边界:diff===threshold 跟随,diff=threshold+1 不跟随', () => {
  const T = STICK_BOTTOM_THRESHOLD_PX;
  // diff = scrollHeight - scrollTop - clientHeight;固定 clientHeight=200,scrollTop=0 → diff=scrollHeight-200
  assert.equal(shouldStickToBottom(200 + T, 0, 200), true); // diff=T
  assert.equal(shouldStickToBottom(200 + T + 1, 0, 200), false); // diff=T+1
});

test('非有限/负输入 → 保守跟随(不误卡)', () => {
  assert.equal(shouldStickToBottom(NaN, 0, 200), true);
  assert.equal(shouldStickToBottom(1000, Infinity, 200), true);
});

// ── Exam.tsx 源码守门:stick 状态在 onScroll 更新 + 自动滚 effect 只读 stick(不再 commit 后算 nearBottom)──

const src = fs.readFileSync(path.join(__dirname, '../src/views/Exam.tsx'), 'utf8');

test('自动滚 effect 用 shouldStickToBottom(不再内联 <80 nearBottom 判据)', () => {
  assert.ok(/shouldStickToBottom/.test(src), 'Exam.tsx 必须用 lib/scroll 的 shouldStickToBottom(不内联判据)');
  // 反向:不应再有旧的 commit 后 `< 80` 内联判据(该判据被 AI 长气泡撑破 = bug 根因)
  assert.ok(!/scrollHeight - .*scrollTop - .*clientHeight < 80/.test(src),
    '不得保留旧 <80 内联近底判据(被长气泡撑破)');
});

test('.transcript 容器绑 onScroll(在稳定滚动态更新 stick 状态)', () => {
  // transcript 滚动容器须有 onScroll 处理(更新 stickToBottom ref)
  const transcriptBlock = src.slice(src.indexOf('className="transcript"') - 50, src.indexOf('className="transcript"') + 300);
  assert.ok(/onScroll/.test(transcriptBlock), '.transcript 容器必须绑 onScroll 更新 stick 状态');
});

test('stickToBottom ref 存在(独立于新内容高度的跟随态)', () => {
  assert.ok(/stickToBottom/i.test(src), '必须有 stickToBottom 状态(ref)承载跟随态');
});
