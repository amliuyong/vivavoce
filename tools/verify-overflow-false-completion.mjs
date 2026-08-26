#!/usr/bin/env node
/**
 * design contract 支撑证据 —— 坐实「容量溢出伪造播放完成」是**现行实现今天就有的缺陷**。
 *
 * 由 design contract 第 1 轮 review 提出,本脚本独立复现:
 *   现行 push 溢出时 `buf = buf.subarray(buf.length - RING_MAX); pos = 0`,
 *   而 renderAbs 派生 = `writeAbs - buf.length + floor(pos)` → buf 被截断后 renderAbs **前跳**
 *   (把丢弃的样本记作已渲染)→ 只拉 1 个输出样本就发出 turn_played。
 *
 * 期望输出:某轮写入 10 万样本(6.25s)**一个都没播**,却上报 turn_played(positionMs=6250)。
 * 这是比杂音更严重的正确性缺陷(服务端据此推进考试游标)。design contract/R7 定义正确语义:
 * 与丢弃区间相交的段 MUST 判 turn_aborted,MUST NOT 判 turn_played。
 *
 * 跑法:node tools/verify-overflow-false-completion.mjs
 */
const INPUT_RATE=16000, RING_MAX=4800000, EPS=1, FADE=128;
class Cur {
  constructor(outRate){ this.ratio=INPUT_RATE/outRate; this.buf=new Float32Array(0); this.pos=0;
    this.fadeGain=0; this.writeAbs=0; this.generation=0; this.ledger=[]; this.tombstone=false; this.events=[]; }
  push(n){ if(this.tombstone) return;
    const consumed=Math.floor(this.pos), keep=this.buf.length-consumed;
    const m=new Float32Array(Math.max(0,keep)+n);
    if(keep>0) m.set(this.buf.subarray(consumed),0);
    for(let i=0;i<n;i++) m[Math.max(0,keep)+i]=0.5;  // 非零样本
    this.buf=m; this.pos-=consumed; if(this.pos<0)this.pos=0;
    this.writeAbs+=n;
    if(this.buf.length>RING_MAX){ this.buf=this.buf.subarray(this.buf.length-RING_MAX); this.pos=0; }
  }
  renderAbs(){ return this.writeAbs-this.buf.length+Math.floor(this.pos); }
  available(){ const r=this.buf.length-Math.floor(this.pos)-1; return r<=0?0:Math.floor(r/this.ratio); }
  beginTurn(seq){ this.tombstone=false;
    if(this.ledger.some(s=>s.seq===seq&&s.state==='open')) return;
    this.ledger.push({generation:this.generation,seq,startAbs:this.writeAbs,endAbs:null,state:'open'}); }
  endTurn(seq){ const s=this.ledger.find(x=>x.seq===seq&&x.state==='open'); if(!s) return;
    s.endAbs=this.writeAbs; this.check(); }
  check(){ if(!this.ledger.length) return; const r=this.renderAbs(), drained=this.available()===0;
    for(let i=0;i<this.ledger.length;i++){ const s=this.ledger[i];
      if(s.state!=='open'||s.endAbs==null) continue;
      const last=i===this.ledger.length-1;
      if(r>=s.endAbs-EPS || (drained&&last)){ s.state='complete';
        this.events.push({type:'turn_played',seq:s.seq,positionMs:((s.endAbs-s.startAbs)/INPUT_RATE)*1000}); } }
    this.ledger=this.ledger.filter(s=>s.state==='open'); }
  pull(out){ const n=out.length; let pos=this.pos, w=0;
    for(let i=0;i<n;i++){ const idx=Math.floor(pos);
      if(idx+1>=this.buf.length){ this.fadeGain=0; for(let k=i;k<n;k++) out[k]=0; break; }
      const frac=pos-idx; const s=this.buf[idx]*(1-frac)+this.buf[idx+1]*frac;
      const remainOut=(this.buf.length-1-pos)/this.ratio;
      const t=remainOut<=FADE?0:1;
      if(this.fadeGain<t) this.fadeGain=Math.min(t,this.fadeGain+1/FADE);
      else if(this.fadeGain>t) this.fadeGain=Math.max(t,this.fadeGain-1/FADE);
      out[i]=s*this.fadeGain; w++; pos+=this.ratio; }
    this.pos=pos;
    const c=Math.floor(this.pos); if(c>0&&c<=this.buf.length){ this.buf=this.buf.subarray(c); this.pos-=c; }
    if(w>0) this.check(); return w; }
}
const r=new Cur(48000);
r.beginTurn(1);
r.push(100000);            // turn1 写 100k 样本(6.25s),一点没播
r.endTurn(1);              // 封口:endAbs=100000
console.log('封口后: renderAbs=',r.renderAbs(),' endAbs=100000  events=',JSON.stringify(r.events));
r.push(4800000);           // 触发截断:丢最旧
console.log('溢出后: renderAbs=',r.renderAbs(),' buf.len=',r.buf.length,' writeAbs=',r.writeAbs);
const out=new Float32Array(1);
r.pull(out);               // 只拉 1 个输出样本
console.log('拉1样本后 events=',JSON.stringify(r.events));
console.log('\n判定:',r.events.some(e=>e.type==='turn_played'&&e.seq===1)
  ? '❌ 现行实现已伪造 turn_played(review 对现行也成立=既有缺陷,非本 spec 引入)'
  : '✅ 未伪造');
