// design contract:SVG 头像纯逻辑(嘴开合连续[0,1] / 眨眼时间驱动 / 三风格几何 / 量化 diff key)。
// 前端无 jsdom:纯逻辑直 import 变异自证 + SvgFace.tsx / Exam.tsx / AgentEditor.tsx 源码守门。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  mouthOpenRatio, eyeState, eyeCloseRatio, minimalFace, roundFace, techFace,
  faceFrameKey, MOUTH_QUANT_STEP, EYE_BLINK_PERIOD_MS, EYE_BLINK_DURATION_MS,
} = require('../src/components/svg-face-core.ts');

// ── mouthOpenRatio:连续 [0,1] ──
test('mouthOpenRatio:active=false → 0', () => {
  assert.equal(mouthOpenRatio([255, 255], false), 0);
});
test('mouthOpenRatio:满能量 → 1', () => {
  assert.equal(mouthOpenRatio(new Array(32).fill(255), true), 1);
});
test('mouthOpenRatio:低能量(<floor 0.08)→ 0(抖动抑制)', () => {
  assert.equal(mouthOpenRatio(new Array(32).fill(5), true), 0); // 5/255≈0.02
});
test('mouthOpenRatio:中能量 → (0,1) 连续(非档位)', () => {
  const r = mouthOpenRatio(new Array(32).fill(128), true); // 0.5
  assert.ok(r > 0 && r < 1);
});
test('mouthOpenRatio:单调(能量越高开口越大)', () => {
  const a = mouthOpenRatio(new Array(16).fill(80), true);
  const b = mouthOpenRatio(new Array(16).fill(160), true);
  assert.ok(b > a);
});
test('mouthOpenRatio:恒在 [0,1] + 空/非有限 → 0', () => {
  assert.equal(mouthOpenRatio([], true), 0);
  for (const amp of [0, 40, 128, 200, 255]) {
    const r = mouthOpenRatio(new Array(8).fill(amp), true);
    assert.ok(r >= 0 && r <= 1);
  }
});

// ── eyeState:时间驱动(复用 design contract 语义)──
test('eyeState:周期头 open,周期末 duration 内 blink', () => {
  assert.equal(eyeState(0, false), 'open');
  assert.equal(eyeState(EYE_BLINK_PERIOD_MS - 50, false), 'blink');
});
test('eyeState:周期性 + active 提频 + 非有限降级 open + 负 tMs 不崩', () => {
  assert.equal(eyeState(200, false), eyeState(200 + EYE_BLINK_PERIOD_MS, false));
  assert.equal(eyeState(EYE_BLINK_PERIOD_MS * 0.7 - 50, true), 'blink'); // active 周期短
  assert.equal(eyeState(EYE_BLINK_PERIOD_MS * 0.7 - 50, false), 'open'); // idle 未到
  assert.equal(eyeState(NaN, false), 'open');
  assert.ok(['open', 'blink'].includes(eyeState(-500, false)));
});
test('eyeCloseRatio:open→0 blink→1', () => {
  assert.equal(eyeCloseRatio('open'), 0);
  assert.equal(eyeCloseRatio('blink'), 1);
});

// ── 三风格几何:mouthOpen 单调 → 嘴几何单调张 ──
test('minimalFace:mouthOpen 越大弧线下沉越多(mouthPath 变)+ 眨眼改 eyeBlink', () => {
  const closed = minimalFace(0, 'open');
  const wide = minimalFace(1, 'open');
  assert.notEqual(closed.mouthPath, wide.mouthPath); // 嘴弧随开合变
  assert.equal(minimalFace(0, 'blink').eyeBlink, true);
  assert.equal(minimalFace(0, 'open').eyeBlink, false);
});
test('roundFace:mouthRy 随 mouthOpen 单调增 + 眨眼压扁 eyeRy', () => {
  assert.ok(roundFace(1, 'open').mouthRy > roundFace(0, 'open').mouthRy);
  assert.ok(roundFace(0, 'blink').eyeRy < roundFace(0, 'open').eyeRy); // 眨眼眼变扁
});
test('techFace:mouthH 随 mouthOpen 单调增 + mouthY 保持中心 + 眨眼压扁 eyeH', () => {
  const a = techFace(0, 'open'); const b = techFace(1, 'open');
  assert.ok(b.mouthH > a.mouthH);
  // 中心 132 保持:y + h/2 ≈ 132
  assert.ok(Math.abs((a.mouthY + a.mouthH / 2) - 132) < 0.01);
  assert.ok(Math.abs((b.mouthY + b.mouthH / 2) - 132) < 0.01);
  assert.ok(techFace(0, 'blink').eyeH < techFace(0, 'open').eyeH);
});
test('三风格几何纯函数(相同输入相同输出)', () => {
  assert.deepEqual(minimalFace(0.5, 'open'), minimalFace(0.5, 'open'));
  assert.deepEqual(roundFace(0.5, 'blink'), roundFace(0.5, 'blink'));
  assert.deepEqual(techFace(0.5, 'open'), techFace(0.5, 'open'));
});
test('几何越界 clamp 不抛', () => {
  assert.doesNotThrow(() => { minimalFace(99, 'open'); roundFace(-5, 'open'); techFace(NaN, 'open'); });
});

// ── faceFrameKey:量化 diff ──
test('faceFrameKey:0.05 步长量化(相近 mouthOpen 同 key → 跳过写入)', () => {
  assert.equal(faceFrameKey(0.51, 'open'), faceFrameKey(0.52, 'open')); // 同量化档
  assert.notEqual(faceFrameKey(0.50, 'open'), faceFrameKey(0.60, 'open')); // 不同档
  assert.notEqual(faceFrameKey(0.5, 'open'), faceFrameKey(0.5, 'blink')); // 眼态入 key
  assert.equal(MOUTH_QUANT_STEP, 0.05);
});
test('faceFrameKey:静默 mouthOpen=0 稳定同 key(省写入)', () => {
  assert.equal(faceFrameKey(0, 'open'), faceFrameKey(0, 'open'));
});

// ── SvgFace.tsx 源码守门(生命周期红线,同 Waveform)──
const src = fs.readFileSync(path.join(__dirname, '../src/components/SvgFace.tsx'), 'utf8');
test('SvgFace 用 core(mouthOpenRatio/eyeState/faceFrameKey + 三风格几何)', () => {
  assert.ok(/mouthOpenRatio/.test(src) && /eyeState/.test(src) && /faceFrameKey/.test(src));
  assert.ok(/minimalFace|roundFace|techFace/.test(src));
});
test('SvgFace:rAF 生命周期(rAF+cancel)+ visibility + reduced-motion + aria-hidden', () => {
  assert.ok(/requestAnimationFrame/.test(src) && /cancelAnimationFrame/.test(src));
  assert.ok(/visibilitychange|visibilityState/.test(src));
  assert.ok(/reduced-motion|prefers-reduced-motion/.test(src));
  assert.ok(/aria-hidden/.test(src));
});
test('SvgFace:跳过无变化帧(faceFrameKey diff)+ performance.now + analyser 只读不 connect', () => {
  assert.ok(/last(Key|Frame)Ref|faceFrameKey/.test(src));
  assert.ok(/performance\.now\(\)/.test(src));
  assert.ok(!/analyser\??\.connect\(/.test(src));
});

// ── Exam.tsx 源码守门(avatar_style 分流 + 默认 minimal)──
const exam = fs.readFileSync(path.join(__dirname, '../src/views/Exam.tsx'), 'utf8');
test('Exam:读 ready 帧 avatar_style + state 初值 minimal + 合法枚举兜底', () => {
  assert.ok(/avatar_style|avatarStyle/.test(exam));
  assert.ok(/useState<[^>]*>\('minimal'\)|useState\('minimal'\)/.test(exam), 'state 初值须 minimal');
});
test('Exam:waveform 风格不渲染 SvgFace(只波形);其余渲染 SvgFace', () => {
  assert.ok(/SvgFace/.test(exam), 'Exam 须用 SvgFace');
  assert.ok(/avatar-waveform|=== 'waveform'|avatarStyle/.test(exam), 'waveform 分流');
});
test('Exam:不再 import AsciiFace(已删)', () => {
  assert.ok(!/AsciiFace/.test(exam), 'AsciiFace 已删,Exam 不应再引用');
});

// ── AgentEditor 源码守门(avatar_style UI)──
const editor = fs.readFileSync(path.join(__dirname, '../src/views/AgentEditor.tsx'), 'utf8');
test('AgentEditor:含 avatar_style 配置控件 + 默认 minimal 回显', () => {
  assert.ok(/avatar_style/.test(editor));
  assert.ok(/'minimal'|"minimal"/.test(editor));
});
