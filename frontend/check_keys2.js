const fs = require('fs');
const { execSync } = require('child_process');

const i18nSrc = fs.readFileSync('src/lib/i18n.ts', 'utf8');
const m = i18nSrc.match(/zh:\s*\{([\s\S]*?)\n {2}\},\n {2}en:/);
const definedKeys = new Set([...m[1].matchAll(/^\s{4}([a-zA-Z_0-9]+):/gm)].map(x => x[1]));

const files = execSync("find src -name '*.tsx'", { encoding: 'utf8' }).trim().split('\n');
const usedKeys = new Set();
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  // Use \b for word boundary to avoid false matches
  for (const m of content.matchAll(/\bt\('([a-z_][a-z_0-9]*)'\)/g)) {
    usedKeys.add(m[1]);
  }
}

const missing = [...usedKeys].filter(k => !definedKeys.has(k));
if (missing.length > 0) {
  console.log('FAIL: Missing keys:', missing);
  process.exit(1);
}
console.log(`PASS: All ${usedKeys.size} used t() keys are defined`);
