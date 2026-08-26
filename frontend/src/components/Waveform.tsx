'use client';
import React, { useEffect, useRef } from 'react';
import { barCount, spectrumToBars, resolveMode, staticRatio, MIN_BAR_RATIO } from './waveform-core';

/**
 * Waveform(design contract)—— 中央舞台的实时线性声波带,**纯呈现组件、无 Exam 内部耦合**。
 * 纯计算(频谱→bar 高度 / bar 数 / 模式判定)在 `waveform-core.ts`(可独立单测);本文件只做 rAF/canvas/DOM 副作用。
 *
 * 入参:
 *  - `analyser`:只读 AnalyserNode(Exam 旁挂在播放/麦克风链路上的 tap;pass-through 不改音频)。
 *    为 `null` → 降级为纯 CSS 装饰脉动(不接真实音频),对话链路绝不受影响(design contract 降级契约)。
 *  - `active`:当前是否正在说话(驱动波形跳动 / 装饰脉动的 play-state)。
 *  - `variant`:'ai' | 'user' —— 语义标注(class),配色实际由 `color` 决定。
 *  - `color`:bar 颜色(由 Exam 用 getComputedStyle 从 CSS 变量读出后透传,避免 canvas 硬编码色值
 *    与设计 token 漂移;design contract 评审 m1)。缺省回退 currentColor。
 *
 * 生命周期红线(design contract review):
 *  - rAF 由 useEffect 管理,依赖数组含 `analyser`+`active`(变化时重启循环);cleanup 必 cancel。
 *  - `next.config.js` 已 `reactStrictMode:true` → dev 双挂载,remount 必须正确重启 rAF。
 *  - 监听 `document.visibilityState`:hidden 停绘制(保留 analyser 连接),visible 恢复 —— 长会话切 tab 不空耗 CPU。
 *  - `prefers-reduced-motion: reduce` → 不启 rAF,只绘一帧静态中线(节能 + a11y)。
 *  - rAF 回调 / analyser 读取 / canvas 操作各自 try/catch,catch → warn + 停循环 + 静态中线,**不向上抛**
 *    (Exam 无需为本组件加 Error Boundary)。
 *
 * canvas 是纯装饰,`aria-hidden="true"`;「谁在说」的可访问信息由 Exam 的控制条/舞台状态文字(aria-live)承载。
 */
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function Waveform({
  analyser,
  active,
  variant,
  color,
}: {
  analyser: AnalyserNode | null;
  active: boolean;
  variant: 'ai' | 'user';
  color?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  // 频谱缓冲复用(避免每帧分配)。显式 ArrayBuffer 泛型:TS 5.7 起 getByteFrequencyData 要 Uint8Array<ArrayBuffer>。
  const freqBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resolvedColor = color || 'currentColor';

    // canvas 像素尺寸按 CSS 尺寸 × dpr(HiDPI 清晰);返回 CSS 像素尺寸 + 已 setTransform 的 ctx。
    function fitCanvas(): { cssW: number; cssH: number; ctx: CanvasRenderingContext2D | null } {
      const c = canvasRef.current!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = Math.max(1, c.clientWidth);
      const cssH = Math.max(1, c.clientHeight);
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssH * dpr);
      if (c.width !== pxW) c.width = pxW;
      if (c.height !== pxH) c.height = pxH;
      let ctx: CanvasRenderingContext2D | null = null;
      try {
        ctx = c.getContext('2d');
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      } catch {
        ctx = null;
      }
      return { cssW, cssH, ctx };
    }

    // 绘一帧:heights 为 [0,1] 的 bar 高度占比数组。返回是否成功(false = canvas 不可用/绘制异常)——
    // 供 frame() 判断:持续失败则停 rAF 降级,不无限空转(review)。
    function paint(heights: number[]): boolean {
      try {
        const { cssW, cssH, ctx } = fitCanvas();
        if (!ctx) return false;
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.fillStyle = resolvedColor;
        const n = heights.length;
        const slot = cssW / n;
        const barW = Math.max(1, slot * 0.6); // 60% 填充、40% 间隙
        const mid = cssH / 2;
        for (let i = 0; i < n; i++) {
          const h = Math.max(MIN_BAR_RATIO, heights[i]) * cssH;
          const x = (i + 0.5) * slot - barW / 2;
          const y = mid - h / 2;
          if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(x, y, barW, h, barW / 2);
            ctx.fill();
          } else {
            ctx.fillRect(x, y, barW, h);
          }
        }
        return true;
      } catch {
        return false; // canvas 环境/绘制异常:本帧失败,不冒泡
      }
    }

    function currentBarCount(): number {
      const c = canvasRef.current;
      return barCount(c ? c.clientWidth : 240);
    }

    function paintStatic(ratio: number) {
      paint(new Array(currentBarCount()).fill(ratio));
    }

    const mode = resolveMode(!!analyser, prefersReducedMotion());

    // reduced-motion / fallback:不启 rAF,只绘一帧(fallback 的跳动交给 CSS keyframes,由 wf-active class 控制)。
    if (mode === 'reduced') {
      paintStatic(MIN_BAR_RATIO);
      return;
    }
    if (mode === 'fallback') {
      paintStatic(staticRatio(active));
      return;
    }

    // live:rAF 读频谱绘 bar。
    let stopped = false;

    function frame() {
      if (stopped) return;
      let ok = false;
      try {
        const a = analyser!;
        const bins = a.frequencyBinCount;
        if (!freqBufRef.current || freqBufRef.current.length !== bins) {
          freqBufRef.current = new Uint8Array(bins);
        }
        const buf = freqBufRef.current;
        a.getByteFrequencyData(buf);
        ok = paint(spectrumToBars(buf, currentBarCount(), active));
      } catch {
        ok = false; // analyser 读取异常
      }
      if (!ok) {
        // canvas/analyser 失败:停循环(不无限空转)+ 尽力画一帧静态中线降级,不冒泡(review)
        stopped = true;
        try {
          console.warn('[Waveform] draw failed, falling back to static line');
        } catch {
          /* ignore */
        }
        paintStatic(MIN_BAR_RATIO);
        return;
      }
      rafRef.current = window.requestAnimationFrame(frame);
    }

    function start() {
      if (stopped || rafRef.current != null) return;
      rafRef.current = window.requestAnimationFrame(frame);
    }
    function stop() {
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }

    // tab 可见性:hidden 停绘制(保留 analyser 连接),visible 恢复(design contract review)。
    function onVisibility() {
      if (document.visibilityState === 'hidden') stop();
      else if (!stopped) start();
    }
    document.addEventListener('visibilitychange', onVisibility);

    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') paintStatic(MIN_BAR_RATIO);
    else start();

    return () => {
      stopped = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [analyser, active, variant, color]);

  return (
    <div
      className={`waveform wf-${variant}${analyser ? '' : ' wf-fallback'}${active ? ' wf-active' : ''}`}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="waveform-canvas" />
    </div>
  );
}
