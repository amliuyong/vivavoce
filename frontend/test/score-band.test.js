// design contract:逐题分数三色档(<0.6 红 / [0.6,0.8] 黄 / >0.8 绿,严格大于才绿)+ 无 score 回退 ✓/✗
// + 逐题分制合计(总分/答对率)。
//
// **直接 import 生产纯逻辑 @/lib/score**(review:此前在测试文件内复刻 scoreBand/scoreTotals,
//   变异生产源码守门正则仍绿 = 假绿;抽出可 import 的纯模块后,变异生产实现测试即红,消除复刻漂移)。
//   Report.tsx 是 TSX(node 原生 test 跑不了整组件),但纯逻辑已抽到 score.ts,故用 ts→require 加载。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
// 测试命令通过项目锁定的 tsx loader 加载 TypeScript,不依赖特定 Node 小版本的
// 原生 type-stripping。这才是「测生产实现」——变异 score.ts 的累加逻辑,
// 本测试即红(不再是复刻副本假绿)。
const { scoreBand, scoreTotals } = require('../src/lib/score.ts');

test('满分 10:9 分绿、7 分黄、4 分红', () => {
  assert.equal(scoreBand(9, 10).color, 'green');
  assert.equal(scoreBand(7, 10).color, 'amber');
  assert.equal(scoreBand(4, 10).color, 'red');
});

test('边界:6 分黄(≥0.6)、8 分黄(恰好 0.8 不绿)、8.5 分绿(>0.8)', () => {
  assert.equal(scoreBand(6, 10).color, 'amber');
  assert.equal(scoreBand(8, 10).color, 'amber'); // 严格大于 0.8 才绿,8/10=0.8 属黄
  assert.equal(scoreBand(8.5, 10).color, 'green');
});

test('非满分 10:归一恰好 0.8(4/5)与满分 10 的 8 分一致(黄,防 >= 笔误)', () => {
  assert.equal(scoreBand(4, 5).color, 'amber'); // 4/5=0.8 → 黄(不绿)
  assert.equal(scoreBand(4.1, 5).color, 'green'); // 0.82 > 0.8 → 绿
});

test('无 score / 非法值 → hasScore:false(回退 ✓/✗,不除零/不 NaN)', () => {
  assert.equal(scoreBand(null, 10).hasScore, false); // 无 score
  assert.equal(scoreBand(8, null).hasScore, false); // 无 max
  assert.equal(scoreBand(8, 0).hasScore, false); // max=0 除零风险 → 回退
  assert.equal(scoreBand(-1, 10).hasScore, false); // 负分
  assert.equal(scoreBand(99, 10).hasScore, false); // 超 max
  assert.equal(scoreBand(NaN, 10).hasScore, false); // NaN
  assert.equal(scoreBand(8, Infinity).hasScore, false); // Infinity
});

// ── design contract 总分/答对率(得分率):scoreTotals 行为层(直接调生产 @/lib/score::scoreTotals)──
//   用户澄清:报告徽章原显 pass_ratio(题通过率 = passed 题数/总题数),但用户要的「答对率 38/50」
//   是**得分率 = Σscore / Σmax_score**。scoreTotals 仅**每题都有合法分**才 hasScore=true(review:
//   否则「部分题有分」分母只算有分题满分和 → 答对率虚高,误导;宁可回退不给失真口径)。
test('答对率=得分率:5 题各 10 分、得 [10,8,10,10,0]=38 → 38/50=76%(用户例子口径)', () => {
  const tot = scoreTotals([
    { score: 10, max_score: 10 }, { score: 8, max_score: 10 }, { score: 10, max_score: 10 },
    { score: 10, max_score: 10 }, { score: 0, max_score: 10 },
  ]);
  assert.equal(tot.hasScore, true);
  assert.equal(tot.sum, 38);
  assert.equal(tot.max, 50);
  assert.equal(Math.round(tot.ratio * 100), 76);
});

test('得分率 ≠ 题通过率:16/100=16%(而 pass_ratio 是 2/10=20%)', () => {
  // Q1=7,Q2=8 达单题及格(≥0.6)算「通过」→ pass_ratio 20%;但总得分 16/100 → 答对率 16%。
  const checks = [7, 8, 1, 0, 0, 0, 0, 0, 0, 0].map((s) => ({ score: s, max_score: 10 }));
  const tot = scoreTotals(checks);
  assert.equal(tot.sum, 16);
  assert.equal(tot.max, 100);
  assert.equal(Math.round(tot.ratio * 100), 16); // 答对率 16%,不是 pass_ratio 的 20%
});

test('scoreTotals:全无合法分(旧结果/空)→ hasScore:false(回退,不显总分)', () => {
  assert.equal(scoreTotals([]).hasScore, false);
  assert.equal(scoreTotals(null).hasScore, false);
  assert.equal(scoreTotals([{ passed: true }, { passed: false }]).hasScore, false); // 无 score 字段
  assert.equal(scoreTotals([{ score: 5, max_score: 0 }]).hasScore, false); // 非法 max=0
});

test('scoreTotals:混合(部分题缺合法分)→ 整体 hasScore:false(review:不给失真分母)', () => {
  // 4/5 题有分但 1 题缺 score → 若只算有分题满分和会得虚高得分率(15/20=75% 而非全场 15/40=37.5%)。
  // 收紧后:任一题缺合法分 → 整体回退,不显总分/答对率(宁可不显,不误导)。
  assert.equal(scoreTotals([
    { score: 6, max_score: 10 },
    { passed: true },              // 缺 score
    { score: 9, max_score: 10 },
  ]).hasScore, false);
  // 含非法负分的题也触发整体回退
  assert.equal(scoreTotals([
    { score: 6, max_score: 10 },
    { score: -1, max_score: 10 },  // 非法
  ]).hasScore, false);
});

// ── 源码守门层:锁住 Report.tsx / score.ts / globals.css / api.ts 的关键实现 ──
const reportSrc = fs.readFileSync(path.join(__dirname, '../src/views/Report.tsx'), 'utf8');
const scoreLibSrc = fs.readFileSync(path.join(__dirname, '../src/lib/score.ts'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '../app/globals.css'), 'utf8');
const apiSrc = fs.readFileSync(path.join(__dirname, '../src/lib/api.ts'), 'utf8');

test('守门:score.ts 有 scoreBand 三色 + scoreTotals 全题合法才 hasScore(不给部分题失真口径)', () => {
  assert.match(scoreLibSrc, /ratio > 0\.8 \? 'green' : ratio >= 0\.6 \? 'amber' : 'red'/); // 严格大于 + 闭区间黄
  assert.match(scoreLibSrc, /!Number\.isFinite\(score\) \|\| !Number\.isFinite\(maxScore\)/); // NaN/Infinity 守卫
  assert.match(scoreLibSrc, /maxScore <= 0 \|\| score < 0 \|\| score > maxScore/); // 除零 + 越界守卫
  assert.match(scoreLibSrc, /if \(!b\.hasScore\) return \{ hasScore: false \}/); // 任一题缺分 → 整体回退
});

test('守门:Report.tsx import 共用 score 逻辑 + 徽章优先显得分率 + 总分/答对率/柱状图 + 回退 ✓/✗', () => {
  assert.match(reportSrc, /import \{ scoreBand, scoreTotals \} from '@\/lib\/score'/); // 用共用纯逻辑(非本地复刻)
  assert.match(reportSrc, /band\.hasScore \?/); // 有分显示徽章
  assert.match(reportSrc, /check-mark.*cm-pass.*cm-fail|cm-pass.*cm-fail/s); // 回退 ✓/✗ 仍在
  // 徽章 check 模式优先 totals.ratio(得分率),回退 pass_ratio
  assert.match(reportSrc, /totals\.hasScore[\s\S]*?totals\.ratio \* 100[\s\S]*?pass_ratio \* 100/);
  assert.match(reportSrc, /rp_total_score/);   // 总分
  assert.match(reportSrc, /rp_correct_rate/);  // 答对率
  assert.match(reportSrc, /score-chart/);      // 柱状图
  assert.match(reportSrc, /sc-fill/);
});

test('守门:globals.css 有三色徽章 + 柱状图 + 总览样式(实心三色柱)', () => {
  assert.match(cssSrc, /\.sb-green\{background:var\(--green-bg\);color:var\(--green\)/);
  assert.match(cssSrc, /\.sb-amber\{background:var\(--amber-bg\);color:var\(--amber\)/);
  assert.match(cssSrc, /\.sb-red\{background:var\(--red-bg\);color:var\(--red\)/);
  assert.match(cssSrc, /\.score-chart/);
  assert.match(cssSrc, /\.score-summary/);
  assert.match(cssSrc, /\.sc-fill\.sb-green\{background:var\(--green\)/); // 实心填充(非徽章浅底)
});

test('守门:api.ts QuestionCheck 有可选 score/max_score', () => {
  assert.match(apiSrc, /score\?: number \| null/);
  assert.match(apiSrc, /max_score\?: number \| null/);
});
