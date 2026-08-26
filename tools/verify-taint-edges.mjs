#!/usr/bin/env node
/**
 * design contract 段级污点的**边界自审**(实现阶段的对照基线)。
 *
 * 上游:`verify-overflow-coordinate-fix.mjs` 验证了正解的三个主场景;本脚本进一步压边界,
 * 覆盖两轮双评审可能追问、且实现最易漏的 5+2 项:
 *   ① 多次溢出叠加同一段 —— `taintedSamples` 须累加、不重复计;
 *   ② 未封口段(`endAbs == null`)求交 —— `segHi` 取当前 `writeAbs`,污点须保留到封口后;
 *   ③ tainted 段被 `flushAll` 打断 —— 须只发一次终态(不与 `checkCompletions` 双发);
 *      **且 positionMs 须扣除污点**(本脚本的 flushAll 实现即正确写法:
 *      `max(0, (renderAbs − startAbs) − taintedSamples)`;沿用现有 `max(0, rAbs − startAbs)`
 *      会把丢弃样本算作已播 = R5/R7 禁止的 over-report);
 *   ④ `generation`/`tombstone` 交互 —— flush 后旧代次 PCM 被挡、污点不跨代次污染新段;
 *   ⑤ 部分相交 —— `positionMs` 只计真实播出量。
 *
 * 期望:全部 ✅。实现完成后,对应 UT 应覆盖同样这 7 项。
 *
 * 跑法:node tools/verify-taint-edges.mjs
 */
const SR=16000, EPS=1;
class M {
  constructor(){ this.writeAbs=0; this.queued=0; this.gen=0; this.tomb=false; this.ledger=[]; this.ev=[]; }
  renderAbs(){ return this.writeAbs-this.queued; }
  begin(seq){ this.tomb=false; if(this.ledger.some(s=>s.seq===seq&&s.state==='open')) return;
    this.ledger.push({gen:this.gen,seq,startAbs:this.writeAbs,endAbs:null,state:'open',tainted:false,taint:0}); }
  push(n){ if(this.tomb) return; this.writeAbs+=n; this.queued+=n; }
  end(seq){ const s=this.ledger.find(x=>x.seq===seq&&x.state==='open'); if(s){ s.endAbs=this.writeAbs; this.check(); } }
  overflow(D){
    const lo=this.renderAbs(), hi=lo+D;
    for(const s of this.ledger){ if(s.state!=='open') continue;
      const segHi = s.endAbs ?? this.writeAbs;           // 未封口段用当前写位
      const ovl=Math.max(0, Math.min(hi,segHi)-Math.max(lo,s.startAbs));
      if(ovl>0){ s.tainted=true; s.taint+=ovl; } }
    this.queued-=D; this.ev.push({t:'overflow',D});
  }
  consume(n){ this.queued=Math.max(0,this.queued-n); this.check(); }
  check(){ for(const s of this.ledger){ if(s.state!=='open'||s.endAbs==null) continue;
      if(this.renderAbs()>=s.endAbs-EPS){ s.state='done';
        const len=s.endAbs-s.startAbs;
        if(s.tainted) this.ev.push({t:'aborted',seq:s.seq,ms:(len-s.taint)/SR*1000,why:'overflow'});
        else this.ev.push({t:'played',seq:s.seq,ms:len/SR*1000}); } }
    this.ledger=this.ledger.filter(s=>s.state==='open'); }
  flushAll(){ const r=this.renderAbs();
    for(const s of this.ledger){ if(s.state!=='open') continue; s.state='done';
      // ★ tainted 段被 flush 的 positionMs 须做**两处**修正(design contract 第 5 条):
      //   ① 扣污点(否则把丢弃样本算作已播);
      //   ② **夹紧到 endAbs**(第 4 轮 review):丢弃区间可跨越段边界 → renderAbs 可能超过
      //      endAbs,不夹紧会把超出部分算作本段已播。未封口段无上界可夹,退化为不夹。
      const upper = s.endAbs ?? r;
      const real = Math.max(0, Math.min(r, upper) - s.startAbs - s.taint);
      this.ev.push({t:'aborted',seq:s.seq,ms:real/SR*1000,why:s.tainted?'flush+overflow':'flush'}); }
    this.ledger=[]; this.queued=0; this.gen+=1; this.tomb=true; }
}
const fin=(m,seq)=>m.ev.filter(e=>e.seq===seq&&(e.t==='played'||e.t==='aborted'));

console.log("① 多次溢出叠加同一段");
{ const m=new M(); m.begin(1); m.push(1000); m.end(1);
  m.overflow(300); m.overflow(200); m.consume(500);
  const f=fin(m,1); console.log(`   ${JSON.stringify(f)}`);
  const exp=(1000-500)/SR*1000;
  console.log(`   期望 aborted ms=${exp} → ${f.length===1&&f[0].t==='aborted'&&Math.abs(f[0].ms-exp)<1e-9?'✅':'❌'}`); }

console.log("② 未封口段(endAbs=null)求交");
{ const m=new M(); m.begin(1); m.push(1000);   // 不 end
  m.overflow(400);
  const seg=m.ledger[0];
  console.log(`   tainted=${seg.tainted} taint=${seg.taint} (期望 true/400)`);
  m.push(200); m.end(1); m.consume(800);
  const f=fin(m,1); console.log(`   ${JSON.stringify(f)}`);
  console.log(`   ${f.length===1&&f[0].t==='aborted'?'✅ 未封口段污点保留到封口后':'❌'}`); }

console.log("③ tainted 段被 flushAll 打断:只发一次终态 **且 positionMs 正确**");
// ★ 第 4 轮 review 指出原用例「只查事件计数不查 positionMs」→ 把公式退回 playedFrom 仍打 ✅。
//   本用例现同时断言数值(段全未播 → 应为 0ms)。
{ const m=new M(); m.begin(1); m.push(1000); m.end(1);
  m.overflow(300);
  m.flushAll();
  const f=fin(m,1); console.log(`   ${JSON.stringify(f)}`);
  const okCount = f.length===1;
  const okMs = okCount && Math.abs(f[0].ms - 0) < 1e-9;   // renderAbs=300、startAbs=0、taint=300 → 0
  console.log(`   ${okCount?'✅ 只发一次':'❌ 双发!'} / ${okMs?'✅ positionMs=0 正确(扣污点)':`❌ positionMs=${f[0]?.ms} 应为 0`}`); }

console.log("③b flush 早于 check 且丢弃跨段边界 —— MUST 夹紧到 endAbs(第4轮 review)");
// 段[0,1000) 已播 800;丢弃 [800,1100) 与本段仅相交 200,但 renderAbs 前跳到 1100 **超过 endAbs**。
// 不夹紧会报 (1100-0-200)=900 样本=56.25ms,而实际只听到 800 样本=50ms。
{ const m=new M(); m.begin(1); m.push(1000); m.end(1);
  m.consume(800);                 // 已播 800
  m.push(200);                    // 再入 200(使丢弃区间可跨过 endAbs=1000)
  m.overflow(300);                // 丢 [800,1100):与段1 相交 200
  m.flushAll();
  const f=fin(m,1);
  console.log(`   ${JSON.stringify(f)}`);
  const expMs = 800/SR*1000;      // 真实听到 800 样本
  const naiveMs = 900/SR*1000;    // 不夹紧的错误值
  const ok = f.length===1 && Math.abs(f[0].ms-expMs)<1e-9;
  console.log(`   期望 ${expMs}ms(不夹紧会报 ${naiveMs}ms)→ ${ok?'✅ 已夹紧到 endAbs':`❌ 实得 ${f[0]?.ms}ms`}`); }

console.log("④ generation/tombstone 交互:flush 后旧代次 PCM + 新轮");
{ const m=new M(); m.begin(1); m.push(1000); m.end(1); m.flushAll();
  const wBefore=m.writeAbs;
  m.push(500);   // 旧代次在途 PCM,tombstone 应挡住
  console.log(`   tombstone 挡住旧 PCM? writeAbs ${wBefore}→${m.writeAbs} ${m.writeAbs===wBefore?'✅':'❌'}`);
  m.begin(2); m.push(800); m.end(2); m.consume(800);
  const f=fin(m,2); console.log(`   新段: ${JSON.stringify(f)}`);
  console.log(`   ${f.some(e=>e.t==='played')?'✅ 新代次段正常 played(污点不跨代次污染)':'❌'}`); }

console.log("⑤ 溢出区间完全落在段外(不应误标)");
{ const m=new M(); m.begin(1); m.push(1000); m.end(1); m.consume(1000);  // 段1 播完出队
  m.begin(2); m.push(500); m.end(2);
  // 此时 renderAbs=1000,段2=[1000,1500);构造丢弃区间 [1000,1200) → 与段2 相交 200
  m.overflow(200); m.consume(300);
  const f=fin(m,2); console.log(`   段2: ${JSON.stringify(f)}`);
  console.log(`   ${f[0]?.t==='aborted'&&Math.abs(f[0].ms-(500-200)/SR*1000)<1e-9?'✅ 部分相交计算正确':'❌'}`); }
