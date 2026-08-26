'use client';
import React, { useEffect, useRef } from 'react';
import {
  mouthOpenRatio, eyeState, faceFrameKey,
  minimalFace, roundFace, techFace, type FaceVariant,
} from './svg-face-core';

/**
 * SvgFace(design contract)—— 舞台中央 SVG 头像,**纯呈现组件、无 Exam 内部耦合**。取代 design contract ASCII:
 * 嘴开合是连续变形(mouthOpenRatio [0,1] 插值 SVG 几何),眼睛周期眨。三风格 minimal/round/tech 共用
 * mouthOpenRatio + eyeState,只 SVG 几何不同。纯计算在 svg-face-core.ts(可单测)。
 *
 * 入参(与 Waveform/AsciiFace 对称):analyser(只读 tap,null→降级)/ active / variant / color。
 * 生命周期红线(同 Waveform design contract review):rAF+cleanup cancel / visibility 停绘 /
 *   prefers-reduced-motion 不启 rAF 只静态脸 / try-catch 降级不冒泡 / 跳过无变化帧(faceFrameKey diff)/
 *   analyser 只读不 connect 下游(design contract 红线)。SVG 改元素属性(不重建 DOM)。aria-hidden 纯视觉。
 */
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function SvgFace({
  analyser,
  active,
  variant,
  color,
}: {
  analyser: AnalyserNode | null;
  active: boolean;
  variant: FaceVariant;
  color?: string;
}) {
  const rootRef = useRef<SVGSVGElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string>('');
  const freqBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const el = (sel: string) => root.querySelector(sel);

    // 按 variant 把几何应用到 SVG 元素属性(不重建 DOM)。返回是否成功。
    function applyGeom(mouthOpen: number, eye: 'open' | 'blink'): boolean {
      try {
        if (variant === 'minimal') {
          const g = minimalFace(mouthOpen, eye);
          (el('.sf-mouth') as SVGPathElement | null)?.setAttribute('d', g.mouthPath);
          // 眼:open 显圆点、blink 显横线(切换 display)
          const dotL = el('.sf-eye-dot-l'), dotR = el('.sf-eye-dot-r');
          const lineL = el('.sf-eye-line-l'), lineR = el('.sf-eye-line-r');
          const showDot = g.eyeBlink ? 'none' : '', showLine = g.eyeBlink ? '' : 'none';
          dotL?.setAttribute('display', showDot); dotR?.setAttribute('display', showDot);
          lineL?.setAttribute('display', showLine); lineR?.setAttribute('display', showLine);
        } else if (variant === 'round') {
          const g = roundFace(mouthOpen, eye);
          (el('.sf-eye-l') as SVGEllipseElement | null)?.setAttribute('ry', String(g.eyeRy));
          (el('.sf-eye-r') as SVGEllipseElement | null)?.setAttribute('ry', String(g.eyeRy));
          (el('.sf-mouth') as SVGEllipseElement | null)?.setAttribute('ry', String(g.mouthRy));
        } else {
          const g = techFace(mouthOpen, eye);
          const eL = el('.sf-eye-l'), eR = el('.sf-eye-r');
          eL?.setAttribute('height', String(g.eyeH)); eL?.setAttribute('y', String(86 - g.eyeH / 2));
          eR?.setAttribute('height', String(g.eyeH)); eR?.setAttribute('y', String(86 - g.eyeH / 2));
          const m = el('.sf-mouth');
          m?.setAttribute('height', String(g.mouthH)); m?.setAttribute('y', String(g.mouthY));
        }
        return true;
      } catch {
        return false;
      }
    }
    function paintStatic() {
      // 闭嘴睁眼(mouthOpen=0, open):静态脸(降级/reduced-motion)。
      applyGeom(0, 'open');
      lastKeyRef.current = faceFrameKey(0, 'open');
    }

    if (prefersReducedMotion() || !analyser) { paintStatic(); return; }

    let stopped = false;
    function frame() {
      if (stopped) return;
      let ok = false;
      try {
        const a = analyser!;
        const bins = a.frequencyBinCount;
        if (!freqBufRef.current || freqBufRef.current.length !== bins) freqBufRef.current = new Uint8Array(bins);
        const buf = freqBufRef.current;
        a.getByteFrequencyData(buf);
        const mouth = mouthOpenRatio(buf, active);
        const eye = eyeState(performance.now(), active);
        const key = faceFrameKey(mouth, eye);
        if (key === lastKeyRef.current) { ok = true; } // 无变化,跳过写入(性能)
        else { lastKeyRef.current = key; ok = applyGeom(mouth, eye); }
      } catch {
        ok = false;
      }
      if (!ok) {
        stopped = true;
        try { console.warn('[SvgFace] draw failed, falling back to static face'); } catch { /* ignore */ }
        paintStatic();
        return;
      }
      rafRef.current = window.requestAnimationFrame(frame);
    }
    function start() { if (!stopped && rafRef.current == null) rafRef.current = window.requestAnimationFrame(frame); }
    function stop() { if (rafRef.current != null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; } }
    function onVisibility() {
      if (document.visibilityState === 'hidden') stop();
      else if (!stopped) start();
    }
    document.addEventListener('visibilitychange', onVisibility);
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') paintStatic();
    else start();
    return () => { stopped = true; stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [analyser, active, variant, color]);

  const c = color || 'currentColor';
  // 各风格初始 SVG 结构(闭嘴睁眼);rAF 只改上面 querySelector 命中的元素属性。
  return (
    <svg
      ref={rootRef}
      className={`svg-face sf-${variant}${analyser ? '' : ' sf-fallback'}${active ? ' sf-active' : ''}`}
      viewBox="0 0 200 200"
      aria-hidden="true"
      style={color ? { color: c } : undefined}
    >
      {variant === 'minimal' && (
        <>
          <circle cx="100" cy="100" r="76" fill="none" stroke={c} strokeWidth="3" strokeOpacity="0.5" />
          <circle className="sf-eye-dot-l" cx="74" cy="86" r="6" fill={c} />
          <circle className="sf-eye-dot-r" cx="126" cy="86" r="6" fill={c} />
          <line className="sf-eye-line-l" x1="66" y1="88" x2="82" y2="88" stroke={c} strokeWidth="5" strokeLinecap="round" display="none" />
          <line className="sf-eye-line-r" x1="118" y1="88" x2="134" y2="88" stroke={c} strokeWidth="5" strokeLinecap="round" display="none" />
          <path className="sf-mouth" d="M 72 126 Q 100 132 128 126" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round" />
        </>
      )}
      {variant === 'round' && (
        <>
          <defs>
            <radialGradient id="sf-rg" cx="50%" cy="38%" r="70%">
              <stop offset="0%" stopColor={c} stopOpacity="0.28" />
              <stop offset="100%" stopColor={c} stopOpacity="0.06" />
            </radialGradient>
          </defs>
          <circle cx="100" cy="100" r="80" fill="url(#sf-rg)" stroke={c} strokeWidth="4" />
          <ellipse className="sf-eye-l" cx="72" cy="86" rx="9" ry="9" fill={c} />
          <ellipse className="sf-eye-r" cx="128" cy="86" rx="9" ry="9" fill={c} />
          <circle cx="62" cy="118" r="7" fill={c} opacity="0.18" />
          <circle cx="138" cy="118" r="7" fill={c} opacity="0.18" />
          <ellipse className="sf-mouth" cx="100" cy="130" rx="20" ry="3" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round" />
        </>
      )}
      {variant === 'tech' && (
        <>
          <rect x="30" y="30" width="140" height="140" rx="34" fill={c} fillOpacity="0.12" stroke={c} strokeWidth="4" />
          <line x1="100" y1="14" x2="100" y2="30" stroke={c} strokeWidth="4" />
          <circle cx="100" cy="10" r="5" fill={c} />
          <rect className="sf-eye-l" x="60" y="78" width="20" height="16" rx="4" fill={c} />
          <rect className="sf-eye-r" x="120" y="78" width="20" height="16" rx="4" fill={c} />
          <rect className="sf-mouth" x="76" y="130.5" width="48" height="3" rx="6" fill="none" stroke={c} strokeWidth="5" />
        </>
      )}
    </svg>
  );
}
