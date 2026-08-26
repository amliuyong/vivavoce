'use client';
/**
 * Waveform 纯逻辑(design contract)—— 与 React/DOM 解耦,便于原生 node --test 直接单测
 * (本仓前端测试无 jsdom/jest,策略见 test/api-refresh.test.js:行为层复刻纯函数 + 源码守门)。
 *
 * 这里只放「频谱 → bar 高度」「bar 数计算」「降级/待机高度」的纯计算;所有 rAF/canvas/DOM/可见性
 * 副作用留在 Waveform.tsx。改这两个文件时保持契约同步(源码守门测试会断言组件仍调用这些)。
 */

export const BAR_PITCH = 5; // 每根 bar 占位像素(3px bar + 2px gap)
export const MIN_BAR_RATIO = 0.06; // 静默/中线最小高度占比(留可见基线,不为 0)
export const IDLE_BAR_RATIO = 0.1; // analyser 存在但 !active 的低幅待机高度占比

/** bar 数 = floor(cssWidth / BAR_PITCH),下限 12(极窄容器不至于空)。桌面~48 / 移动~32。 */
export function barCount(cssWidth: number): number {
  const w = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 240;
  return Math.max(12, Math.floor(w / BAR_PITCH));
}

/**
 * 把 analyser 频谱字节(0..255)降采样成 n 根 bar 的高度占比([0,1])。
 *  - active=false:压到低幅待机(与音量无关的呼吸感),不随真实能量跳动。
 *  - active=true:每段取均值归一化;并施加下限,避免瞬时静音段 bar 全塌。
 */
export function spectrumToBars(freq: Uint8Array | number[], n: number, active: boolean): number[] {
  const bins = freq.length;
  const heights = new Array<number>(n);
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
    const avg = cnt ? sum / cnt / 255 : 0; // [0,1]
    heights[i] = Math.max(IDLE_BAR_RATIO * 0.5, avg);
  }
  return heights;
}

/**
 * 决定绘制模式(消除组件里散落的分支,便于测试):
 *  - 'reduced':prefers-reduced-motion → 只绘一帧静态中线,不启 rAF。
 *  - 'fallback':analyser 为 null → CSS 装饰脉动,canvas 只画待机中线(active 决定高度),不启 rAF。
 *  - 'live':真实音频驱动,启 rAF 读频谱。
 */
export type WaveMode = 'reduced' | 'fallback' | 'live';
export function resolveMode(hasAnalyser: boolean, reducedMotion: boolean): WaveMode {
  if (reducedMotion) return 'reduced';
  if (!hasAnalyser) return 'fallback';
  return 'live';
}

/** fallback/静态时的中线高度:active 用待机高度,否则最小基线。 */
export function staticRatio(active: boolean): number {
  return active ? IDLE_BAR_RATIO : MIN_BAR_RATIO;
}
