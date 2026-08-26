'use client';
/**
 * SVG 头像纯逻辑(design contract)—— 与 React/DOM 解耦,便于原生 node --test 直接单测
 * (本仓前端无 jsdom/jest,策略见 waveform-core.ts / ascii-face-core 前身)。
 *
 * 这里只放「频谱 → 嘴开合比 [0,1] 连续」「时间 → 眨眼态」「(嘴开合, 眼态) → 各风格 SVG 几何属性」纯计算;
 * 所有 rAF/DOM/analyser 副作用留在 SvgFace.tsx。三风格(minimal/round/tech)共用 mouthOpenRatio + eyeState,
 * 只几何不同。取代 design contract ASCII(平滑连续变形,非四档跳变)。
 */

export type FaceVariant = 'minimal' | 'round' | 'tech';

/** 嘴开合抖动抑制下限:能量归一化后须超此才判「开口」(防静音瞬段底噪让嘴乱跳)。 */
const MOUTH_ENERGY_FLOOR = 0.08;
/** 眨眼(复用 design contract 时间驱动语义)。 */
export const EYE_BLINK_PERIOD_MS = 4000;
export const EYE_BLINK_DURATION_MS = 140;
const ACTIVE_BLINK_FACTOR = 0.7;

/**
 * 频谱能量 → 嘴开合比 **连续** [0,1](非档位,SVG 平滑变形用)。
 *  - active=false → 0(闭嘴)。
 *  - active=true → 频谱均值归一化 [0,1];< FLOOR 判 0(抖动抑制);超过 FLOOR 线性映射到 (0,1]。
 * 纯函数;freq 空/非有限 → 0。
 */
export function mouthOpenRatio(freq: Uint8Array | number[], active: boolean): number {
  if (!active) return 0;
  const bins = freq.length;
  if (bins === 0) return 0;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < bins; i++) {
    const v = freq[i];
    if (Number.isFinite(v)) { sum += v; cnt++; }
  }
  if (cnt === 0) return 0;
  const avg = sum / cnt / 255; // [0,1]
  if (!Number.isFinite(avg) || avg < MOUTH_ENERGY_FLOOR) return 0;
  const norm = (avg - MOUTH_ENERGY_FLOOR) / (1 - MOUTH_ENERGY_FLOOR);
  return Math.max(0, Math.min(1, norm));
}

/** 时间 → 眨眼态(时间驱动,不依赖能量;tMs 外部传入不调 Date.now,保可测/可复现)。 */
export function eyeState(tMs: number, active: boolean): 'open' | 'blink' {
  if (!Number.isFinite(tMs)) return 'open';
  const period = active ? EYE_BLINK_PERIOD_MS * ACTIVE_BLINK_FACTOR : EYE_BLINK_PERIOD_MS;
  const phase = ((tMs % period) + period) % period;
  return phase >= period - EYE_BLINK_DURATION_MS ? 'blink' : 'open';
}

/** 眼睑闭合比(0=全睁,1=全闭)。用于眼几何插值(blink 时闭)。 */
export function eyeCloseRatio(eye: 'open' | 'blink'): number {
  return eye === 'blink' ? 1 : 0;
}

// ── 几何计算(viewBox 200×200,居中脸)。各风格返回「用于渲染的几何量」纯对象,组件据此改 SVG 属性。 ──

/** 眼几何:睁→半径 openR,眨→压扁到 blinkRy。返回椭圆 ry(rx 恒定)。 */
function eyeRy(eye: 'open' | 'blink', openRy: number, blinkRy: number): number {
  return eye === 'blink' ? blinkRy : openRy;
}

export interface MinimalGeom {
  eyeR: number;            // 圆点眼半径(睁);眨眼用 lidY 表线
  eyeBlink: boolean;
  mouthPath: string;       // 弧线嘴 path d(随 mouthOpen 从平线弯成张口)
}
/** minimal:细圆圈 + 圆点眼(眨→短横线)+ 弧线嘴(mouthOpen 越大越张)。 */
export function minimalFace(mouthOpen: number, eye: 'open' | 'blink'): MinimalGeom {
  const mo = clamp01(mouthOpen);
  // 嘴:上唇固定线 y=128;下唇随 mouthOpen 下沉(0=平线微笑,1=张大)。二次贝塞尔。
  const dip = 6 + mo * 26; // 下沉 6..32
  const mouthPath = `M 72 126 Q 100 ${126 + dip} 128 126`;
  return { eyeR: 6, eyeBlink: eye === 'blink', mouthPath };
}

export interface RoundGeom {
  eyeRy: number;           // 眼椭圆 ry(睁 9 / 眨 1.5)
  mouthRy: number;         // 嘴椭圆 ry(随 mouthOpen 张开 3..26)
}
/** round:圆脸 + 椭圆眼(眨→压扁)+ 椭圆嘴(mouthOpen 越大 ry 越大)。 */
export function roundFace(mouthOpen: number, eye: 'open' | 'blink'): RoundGeom {
  const mo = clamp01(mouthOpen);
  return { eyeRy: eyeRy(eye, 9, 1.5), mouthRy: 3 + mo * 23 };
}

export interface TechGeom {
  eyeH: number;            // 方眼高(睁 16 / 眨 2)
  mouthH: number;          // 圆角矩形嘴高(随 mouthOpen 3..23)
  mouthY: number;          // 嘴矩形 y(高度变化时保持中心 132)
}
/** tech:方脸机器人 + 方眼(眨→压扁)+ 圆角矩形嘴(mouthOpen 越大越高)。 */
export function techFace(mouthOpen: number, eye: 'open' | 'blink'): TechGeom {
  const mo = clamp01(mouthOpen);
  const mouthH = 3 + mo * 20;
  return { eyeH: eye === 'blink' ? 2 : 16, mouthH, mouthY: 132 - mouthH / 2 };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

/** 跳过无变化帧的 diff key(review):量化 mouthOpen 到 0.05 步长(20 档)+ 眼态。
 *  与上帧同 key → SvgFace 跳过 DOM 属性写入(20 档视觉仍平滑,静默 mouthOpen=0 连续多帧同 key 大幅省写入)。 */
export const MOUTH_QUANT_STEP = 0.05;
export function faceFrameKey(mouthOpen: number, eye: 'open' | 'blink'): string {
  const q = Math.round(clamp01(mouthOpen) / MOUTH_QUANT_STEP) * MOUTH_QUANT_STEP;
  return `${q.toFixed(2)}-${eye}`;
}
