// i18n zh/en key 对齐测试(design contract:中英 key 一一对齐,无孤儿,无重复)。
// 纯文本解析 src/lib/i18n.ts(避免 TS 运行时),供统一测试入口与 npm test 使用。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../src/lib/i18n.ts'), 'utf8');
const m = src.match(/export const STRINGS = \{([\s\S]*?)\n\} as const;/);
if (!m) {
  console.error('FAIL: 未找到 STRINGS 定义');
  process.exit(1);
}
const body = m[1];
const zhM = body.match(/zh:\s*\{([\s\S]*?)\n {2}\},\n {2}en:/);
const enM = body.match(/en:\s*\{([\s\S]*)\n {2}\},?\s*$/);
if (!zhM || !enM) {
  console.error('FAIL: 未能切出 zh / en 块');
  process.exit(1);
}
const keys = (block) => [...block.matchAll(/^\s{4}([a-zA-Z_0-9]+):/gm)].map((x) => x[1]);
const zk = keys(zhM[1]);
const ek = keys(enM[1]);
const zs = new Set(zk);
const es = new Set(ek);
const onlyZh = zk.filter((k) => !es.has(k));
const onlyEn = ek.filter((k) => !zs.has(k));
const dup = (arr) => [...new Set(arr.filter((k, i) => arr.indexOf(k) !== i))];
const dupZh = dup(zk);
const dupEn = dup(ek);

let ok = true;
if (zk.length === 0 || ek.length === 0) {
  console.error('FAIL: 解析到 0 个 key');
  ok = false;
}
if (onlyZh.length || onlyEn.length) {
  console.error('FAIL: key 不对齐 — onlyZh:', onlyZh, ' onlyEn:', onlyEn);
  ok = false;
}
if (dupZh.length || dupEn.length) {
  console.error('FAIL: key 重复 — zh:', dupZh, ' en:', dupEn);
  ok = false;
}
if (ok) {
  console.log(`PASS i18n: zh=${zk.length} en=${ek.length} keys aligned, no orphan/dup`);
  process.exit(0);
}
process.exit(1);
