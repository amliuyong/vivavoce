// design contract:Waveform 波形组件测试。
//
// 本仓前端测试用原生 node --test(无 jsdom/jest/tsx),React 组件 + 无扩展名 TS import 跑不起来。
// 沿用 api-refresh / report-polling 同策略,分两层:
//   (1) 行为层:复刻 waveform-core.ts 的纯函数(与源逐行对应),验证频谱→bar 映射 / bar 数 / 模式判定 / 待机高度;
//   (2) 源码守门层:文本断言 Waveform.tsx / waveform-core.ts 确实实现了 rAF 生命周期红线
//       (依赖数组 / cancelAnimationFrame / visibilitychange / reduced-motion 不启 rAF / try-catch 不冒泡 / aria-hidden),
//       防重构悄悄丢掉评审收敛的阻断项(review)。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── (1) 行为层:复刻 waveform-core.ts(逐行对应,便于回读校对)──
const BAR_PITCH = 5;
const MIN_BAR_RATIO = 0.06;
const IDLE_BAR_RATIO = 0.1;

function barCount(cssWidth) {
  const w = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 240;
  return Math.max(12, Math.floor(w / BAR_PITCH));
}
function spectrumToBars(freq, n, active) {
  const bins = freq.length;
  const heights = new Array(n);
  if (!active) {
    heights.fill(IDLE_BAR_RATIO * 0.6);
    return heights;
  }
  if (bins === 0) {
    heights.fill(IDLE_BAR_RATIO * 0.5);
    return heights;
  }
  const step = Math.max(1, Math.floor(bins / n));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    const start = i * step;
    for (let k = start; k < start + step && k < bins; k++) {
      sum += freq[k];
      cnt++;
    }
    const avg = cnt ? sum / cnt / 255 : 0;
    heights[i] = Math.max(IDLE_BAR_RATIO * 0.5, avg);
  }
  return heights;
}
function resolveMode(hasAnalyser, reducedMotion) {
  if (reducedMotion) return 'reduced';
  if (!hasAnalyser) return 'fallback';
  return 'live';
}
function staticRatio(active) {
  return active ? IDLE_BAR_RATIO : MIN_BAR_RATIO;
}

// ── barCount ──
test('barCount:按 5px 间距算根数,下限 12', () => {
  assert.equal(barCount(240), 48); // 桌面典型
  assert.equal(barCount(160), 32); // 移动典型
  assert.equal(barCount(10), 12); // 极窄容器 → 下限
  assert.equal(barCount(0), 48); // 非法/未布局 → 回退 240
  assert.equal(barCount(NaN), 48);
});

// ── spectrumToBars ──
test('spectrumToBars:active 时反映真实能量(满能量→高 bar,静音→仍有下限基线)', () => {
  const loud = new Uint8Array(64).fill(255);
  const hLoud = spectrumToBars(loud, 32, true);
  assert.equal(hLoud.length, 32);
  assert.ok(hLoud.every((h) => h === 1)); // 255/255 = 1

  const quiet = new Uint8Array(64).fill(0);
  const hQuiet = spectrumToBars(quiet, 32, true);
  assert.ok(hQuiet.every((h) => h === IDLE_BAR_RATIO * 0.5)); // 0 能量被抬到下限,不全塌
});

test('spectrumToBars:!active 时压到低幅待机,与能量无关', () => {
  const loud = new Uint8Array(64).fill(255);
  const h = spectrumToBars(loud, 20, false); // 即便满能量
  assert.ok(h.every((v) => v === IDLE_BAR_RATIO * 0.6));
});

test('spectrumToBars:空频谱不崩,给待机高度', () => {
  const h = spectrumToBars(new Uint8Array(0), 16, true);
  assert.equal(h.length, 16);
  assert.ok(h.every((v) => v === IDLE_BAR_RATIO * 0.5));
});

test('spectrumToBars:bins 多于 bar 数时降采样取段均值', () => {
  // 128 bins → 前半 255、后半 0;降到 2 根 bar:第 0 根应高、第 1 根应低。
  const freq = new Uint8Array(128);
  for (let i = 0; i < 64; i++) freq[i] = 255;
  const h = spectrumToBars(freq, 2, true);
  assert.ok(h[0] > h[1]);
  assert.ok(h[0] > 0.9); // 前段全满
});

// ── resolveMode(评审收敛的降级/reduced-motion 分支)──
test('resolveMode:reduced-motion 优先级最高', () => {
  assert.equal(resolveMode(true, true), 'reduced'); // 有 analyser 也让位 reduced
  assert.equal(resolveMode(false, true), 'reduced');
});
test('resolveMode:无 analyser → fallback(装饰脉动),有 → live', () => {
  assert.equal(resolveMode(false, false), 'fallback');
  assert.equal(resolveMode(true, false), 'live');
});
test('staticRatio:active 待机高 / 否则最小基线', () => {
  assert.equal(staticRatio(true), IDLE_BAR_RATIO);
  assert.equal(staticRatio(false), MIN_BAR_RATIO);
});

// ── (2) 源码守门层:断言实现确实保留评审收敛的阻断/重要项 ──
const coreSrc = fs.readFileSync(path.join(__dirname, '../src/components/waveform-core.ts'), 'utf8');
const wfSrc = fs.readFileSync(path.join(__dirname, '../src/components/Waveform.tsx'), 'utf8');

test('源码守门:waveform-core 导出被组件复用的纯函数(逐行对应校对锚点)', () => {
  for (const fn of ['barCount', 'spectrumToBars', 'resolveMode', 'staticRatio']) {
    assert.ok(new RegExp(`export function ${fn}`).test(coreSrc), `core 缺 ${fn}`);
  }
});

test('源码守门:Waveform rAF 生命周期红线(review)', () => {
  // useEffect 依赖数组含 analyser + active(变化重启循环)
  assert.ok(/\}, \[analyser, active, variant, color\]\);/.test(wfSrc), '依赖数组必须含 analyser+active(+variant/color)');
  // cleanup 取消 rAF
  assert.ok(/cancelAnimationFrame/.test(wfSrc), '必须 cancelAnimationFrame');
  assert.ok(/return \(\) => \{[\s\S]*stopped = true;[\s\S]*stop\(\);/.test(wfSrc), 'cleanup 必须停循环');
  // tab 可见性暂停/恢复
  assert.ok(/visibilitychange/.test(wfSrc), '必须监听 visibilitychange');
  assert.ok(/removeEventListener\('visibilitychange'/.test(wfSrc), 'cleanup 必须移除 visibilitychange 监听');
});

test('源码守门:reduced-motion 不启 rAF,只绘静态(review)', () => {
  // reduced 分支 paintStatic 后直接 return(不进入 start()/rAF)
  assert.ok(/mode === 'reduced'[\s\S]{0,80}paintStatic\(MIN_BAR_RATIO\);\s*return;/.test(wfSrc), 'reduced 必须画一帧后 return');
  assert.ok(/prefers-reduced-motion: reduce/.test(wfSrc), '必须检测 prefers-reduced-motion');
});

test('源码守门:analyser 为 null → fallback 不启 rAF(降级契约)', () => {
  assert.ok(/mode === 'fallback'[\s\S]{0,80}paintStatic\(staticRatio\(active\)\);\s*return;/.test(wfSrc), 'fallback 必须画一帧后 return(交 CSS)');
  assert.ok(/wf-fallback/.test(wfSrc), 'fallback 必须挂 wf-fallback class(CSS keyframes 装饰脉动)');
});

test('源码守门:异常 try/catch 不冒泡(review)', () => {
  // frame() 的 catch 不冒泡
  assert.ok(/getByteFrequencyData[\s\S]{0,120}catch/.test(wfSrc), 'frame 必须 try/catch analyser 读取');
  // paint 自身 catch(canvas 异常静默)
  assert.ok(/roundRect[\s\S]{0,200}catch/.test(wfSrc) || /clearRect[\s\S]{0,400}catch/.test(wfSrc), 'paint 必须 try/catch');
});

test('源码守门:canvas 失败停 rAF 不空转(review)', () => {
  // paint 返回 boolean(成功/失败)
  assert.ok(/function paint\(heights: number\[\]\): boolean/.test(wfSrc), 'paint 必须返回 boolean');
  assert.ok(/return false;/.test(wfSrc) && /return true;/.test(wfSrc), 'paint 必须有 true/false 两种返回');
  // frame 据返回值停循环(!ok → stopped)
  assert.ok(/if \(!ok\) \{[\s\S]{0,200}stopped = true;/.test(wfSrc), 'frame 必须在 paint 失败(!ok)时停循环降级');
  assert.ok(/console\.warn/.test(wfSrc), '失败降级必须 warn(可观测)');
});

test('源码守门:canvas aria-hidden(a11y:装饰不进无障碍树)', () => {
  assert.ok(/aria-hidden="true"/.test(wfSrc), 'waveform 容器必须 aria-hidden');
});

test('源码守门:配色由 color prop 透传(getComputedStyle,不硬编码;评审 m1)', () => {
  assert.ok(/color \|\| 'currentColor'/.test(wfSrc), '必须用透传 color(回退 currentColor),不硬编码色值');
  assert.ok(/color\?: string/.test(wfSrc), '入参必须含可选 color');
});
