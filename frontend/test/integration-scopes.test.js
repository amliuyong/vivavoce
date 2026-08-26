// integrationScopes 完整性守门(design contract):public/openapi.json 里每个 tag=integration-api 的
// 端点,都必须在 src/lib/integrationScopes.ts 的 ENDPOINT_SCOPES 里有一条映射 —— 否则下载的
// Agent 手册标不出「所需 scope」。纯文本解析(避免 TS 运行时),供统一测试入口与 npm test 使用。
const fs = require('fs');
const path = require('path');

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'];

// 1. 从 integrationScopes.ts 抽出映射表的 key 集合
const tsSrc = fs.readFileSync(path.join(__dirname, '../src/lib/integrationScopes.ts'), 'utf8');
const bodyM = tsSrc.match(/ENDPOINT_SCOPES[^{]*\{([\s\S]*?)\n\};/);
if (!bodyM) {
  console.error('FAIL: 未找到 ENDPOINT_SCOPES 定义');
  process.exit(1);
}
const mapped = new Set();
for (const m of bodyM[1].matchAll(/'([^']+)':\s*'([^']+)'/g)) mapped.add(m[1]);

// 2. 从 openapi.json 收集所有 integration-api 端点
const specPath = path.join(__dirname, '../public/openapi.json');
if (!fs.existsSync(specPath)) {
  console.error('FAIL: public/openapi.json 不存在(先跑 npm run sync-openapi)');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const endpoints = [];
for (const [p, ops] of Object.entries(spec.paths || {})) {
  for (const method of METHOD_ORDER) {
    const op = ops[method];
    if (op && Array.isArray(op.tags) && op.tags[0] === 'integration-api') {
      endpoints.push(`${method.toUpperCase()} ${p}`);
    }
  }
}

// 3. 断言:每个端点都在映射表里;映射表也不该有已删的多余项(双向)
const missing = endpoints.filter((e) => !mapped.has(e));
const stale = [...mapped].filter((e) => !endpoints.includes(e));

if (missing.length) {
  console.error('FAIL: 以下 integration-api 端点缺少 scope 映射(补 src/lib/integrationScopes.ts):');
  missing.forEach((e) => console.error('  - ' + e));
}
if (stale.length) {
  console.error('FAIL: ENDPOINT_SCOPES 有已不存在于契约的多余项(端点已删?):');
  stale.forEach((e) => console.error('  - ' + e));
}
if (missing.length || stale.length) process.exit(1);

console.log(`PASS integration-scopes: ${endpoints.length} 个 integration-api 端点均有 scope 映射`);
