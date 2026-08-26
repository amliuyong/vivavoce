// 逐题分数判定纯逻辑(design contract)—— 抽出为可被单测直接 import 的模块,消除「测试复刻漂移」
// (review:此前测试在 test 文件内复刻 scoreBand/scoreTotals,变异生产源码守门正则仍绿 = 假绿)。
// 无 React/DOM 依赖,Report.tsx 与 test/score-band.test.js 共用同一份实现。

// 三色档:归一比例 ratio = score/max_score:<0.6 红 / [0.6,0.8] 黄 / >0.8 绿(**严格大于** 0.8 才绿)。
//   仅当 score 与 max_score 都是合法有限数、max_score>0、0<=score<=max_score 才算「有分」
//   (否则回退 ✓/✗,不除零/不 NaN)。
export type ScoreBand = { hasScore: false } | { hasScore: true; ratio: number; color: 'green' | 'amber' | 'red' };

export function scoreBand(score?: number | null, maxScore?: number | null): ScoreBand {
  if (score == null || maxScore == null || !Number.isFinite(score) || !Number.isFinite(maxScore)) return { hasScore: false };
  if (maxScore <= 0 || score < 0 || score > maxScore) return { hasScore: false }; // 非法 → 回退,不除零/不越界
  const ratio = score / maxScore;
  const color = ratio > 0.8 ? 'green' : ratio >= 0.6 ? 'amber' : 'red'; // 严格大于 0.8 才绿;[0.6,0.8] 黄
  return { hasScore: true, ratio, color };
}

// 逐题分制合计:总分/满分 + 答对率(得分率 = Σscore / Σmax_score)。
//   注:这与 pass_ratio(题**通过率** = passed 题数/总题数)是不同口径——用户要的「答对率 38/50」是得分率。
//   **口径纪律(review)**:仅当**每一题都有合法分**才算 hasScore=true;只要有一题缺分/非法
//   (旧结果、LLM 漏返个别题)→ hasScore=false,回退纯 ✓/✗ + pass_ratio。否则「部分题有分」时分母只算
//   有分题满分和 → 答对率虚高(如 40/50=80% 实为 40/100=40%),对用户是误导。宁可不显,不给失真口径。
export type ScoreTotals = { hasScore: false } | { hasScore: true; sum: number; max: number; ratio: number };

export function scoreTotals(checks?: { score?: number | null; max_score?: number | null }[] | null): ScoreTotals {
  const list = checks || [];
  if (list.length === 0) return { hasScore: false };
  let sum = 0, max = 0;
  for (const q of list) {
    const b = scoreBand(q.score, q.max_score);
    if (!b.hasScore) return { hasScore: false }; // 任一题缺合法分 → 整体回退(不给「部分题」失真口径)
    sum += q.score as number;
    max += q.max_score as number;
  }
  if (max <= 0) return { hasScore: false };
  return { hasScore: true, sum, max, ratio: sum / max };
}
