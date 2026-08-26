#!/usr/bin/env node
/**
 * design contractb 支撑证据 —— 验证「分片队列 vs 线性数组,同 trace 下逐样本等价」。
 *
 * 为什么需要:design contract 第 1 轮双评审一致质疑「逐样本等价不可达」(review 实测同一输入
 * 整体喂入 vs 分块交替拉取偏差 0.4869;review 指出 underrun 判据 `idx+1 >= buf.length` 与
 * fade 的 `remainOut = (buf.length-1-pos)/ratio` 都依赖线性数组长度)。
 * design contractb 的论证是:**偏差来自不同 trace,同 trace 则等价** —— 本脚本即该论证的可复算证据。
 *
 * 关键等价关系:线性数组的 `buf.length - floor(pos)`(未播样本数) ≡ 分片队列的 `queuedSamples`。
 * 覆盖三个边界:① underrun 临界(两模型 MUST 同时触发)② 跨分片插值(取下一分片首样本 `queue[1][0]`)
 * ③ underrun 后恢复。
 *
 * 跑法:node tools/verify-chunk-queue-equivalence.mjs   (期望:不一致 = 0)
 */

const RATIO = 16000 / 48000; // 输入 16k → 硬件 48k 的读取步长

/** 现行实现模型:线性数组 + 相对分数位(复刻 playback-resampler.ts / pcm-playback-worklet.js)。 */
function linModel(){ return { buf:new Float32Array(0), pos:0,
  push(a){ const c=Math.floor(this.pos), keep=this.buf.length-c;
    const m=new Float32Array(Math.max(0,keep)+a.length);
    if(keep>0) m.set(this.buf.subarray(c),0); m.set(a,Math.max(0,keep));
    this.buf=m; this.pos-=c; if(this.pos<0)this.pos=0; },
  wouldUnderrun(){ return Math.floor(this.pos)+1 >= this.buf.length; },
  remainOut(){ return (this.buf.length-1-this.pos)/RATIO; },
  sample(){ const i=Math.floor(this.pos), f=this.pos-i; return this.buf[i]*(1-f)+this.buf[i+1]*f; },
  advance(){ this.pos+=RATIO; },
  recycle(){ const c=Math.floor(this.pos); if(c>0&&c<=this.buf.length){ this.buf=this.buf.subarray(c); this.pos-=c; } } };
}
function qModel(){ return { queue:[], readIdx:0, frac:0, queued:0,
  push(a){ this.queue.push(a); this.queued+=a.length; },
  wouldUnderrun(){ return this.queued < 2; },
  remainOut(){ return (this.queued-1-this.frac)/RATIO; },
  sample(){ const h=this.queue[0], i=this.readIdx, f=this.frac;
    const a=h[i];
    let b;
    if(i+1<h.length) b=h[i+1];
    else if(this.queue.length>1) b=this.queue[1][0];
    else b=a;
    return a*(1-f)+b*f; },
  advance(){ this.frac+=RATIO;
    while(this.frac>=1){ this.frac-=1; this.readIdx+=1; this.queued-=1; }
    while(this.queue.length>0 && this.readIdx>=this.queue[0].length){ this.readIdx-=this.queue[0].length; this.queue.shift(); } },
  recycle(){} };
}
// trace:只 push 一个 3 样本分片 → 一路 pull 到 underrun → 再 push → 继续
const L=linModel(), Q=qModel();
L.push(new Float32Array([10,20,30])); Q.push(new Float32Array([10,20,30]));
console.log("step  linUR  qUR   linSample   qSample   linRemain  qRemain  一致?");
let mm=0;
for(let s=0; s<16; s++){
  if(s===8){ const nx=new Float32Array([40,50,60]); L.push(nx); Q.push(nx); }
  const lu=L.wouldUnderrun(), qu=Q.wouldUnderrun();
  let ls=NaN, qs=NaN;
  if(!lu) ls=L.sample();
  if(!qu) qs=Q.sample();
  const lr=lu?NaN:L.remainOut(), qr=qu?NaN:Q.remainOut();
  const sameUR = lu===qu;
  const sameS = (isNaN(ls)&&isNaN(qs)) || Math.abs(ls-qs)<1e-9;
  const sameR = (isNaN(lr)&&isNaN(qr)) || Math.abs(lr-qr)<1e-9;
  const ok = sameUR&&sameS&&sameR;
  if(!ok) mm++;
  console.log(`${String(s).padStart(4)}  ${String(lu).padEnd(6)} ${String(qu).padEnd(5)} ${String(isNaN(ls)?'-':ls.toFixed(4)).padStart(10)} ${String(isNaN(qs)?'-':qs.toFixed(4)).padStart(9)} ${String(isNaN(lr)?'-':lr.toFixed(3)).padStart(10)} ${String(isNaN(qr)?'-':qr.toFixed(3)).padStart(8)}  ${ok?'✓':'✗'}`);
  if(!lu){ L.advance(); L.recycle(); }
  if(!qu){ Q.advance(); Q.recycle(); }
}
console.log(`\n不一致 = ${mm}`);
console.log(mm===0 ? "✅ 含 underrun 临界 + 跨分片插值 + 恢复,全程等价 → R2b 成立"
  : "❌ 边界处不等价 → R2b 需改写(这正是评审会问的点)");
