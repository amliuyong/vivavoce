#!/usr/bin/env node
/**
 * design contract 坐标系正解验证 —— 解 review。
 *
 * **Blocker 1(已实测成立)**:第 2 版 R4 定义 `renderAbs = writeAbs − queuedSamples` 与
 * R5 定义 `writeAbs − queuedSamples − droppedSamples` 互相矛盾:
 *   - 用 R5 定义:溢出丢 500 后,新段写 800 全部播完 → renderAbs=1800,但完成判据要求
 *     ≥ endAbs−EPS=2299 → **永久差 499 → 新段永不完成**;
 *   - 用 R4 定义:被丢弃的 500 样本被计入「已渲染」→ **正是 R5 要禁止的伪造**。
 *   两定义各修一个 bug 又各引入另一个 → 坐标系矛盾。
 *
 * **正解(本脚本验证)**:「播放进度」与「段是否完成」是两个问题,不该塞进同一个标量。
 *   - `renderAbs = writeAbs − queuedSamples` 保持**单一定义**,语义订正为
 *     「读游标已推进到的源流位置」—— 丢弃使游标跳过那段,这是**事实**(游标真的到了那里)。
 *   - 「丢弃的样本没被听到」改用**段级污点(tainted)**表达:溢出时把与丢弃区间
 *     `[renderAbs, renderAbs+D)` 相交的 open 段标 tainted 并累加 `taintedSamples`;
 *     tainted 段完成时发 `turn_aborted`(而非 `turn_played`),`positionMs` = 段长 − taintedSamples。
 *   - **副产品**:污点判定只用段账本已有的 `startAbs`/`endAbs` 与丢弃区间求交,
 *     **无需给分片附加段元数据**(review 同时指出的「分片不带 segment 元数据」问题一并解决)。
 *
 * 三场景:A 溢出后新段正常完成 / B 全被丢的段判 aborted 且 positionMs=0 /
 * C 部分丢弃判 aborted 且 positionMs 只计真实播出量。
 *
 * 跑法:node tools/verify-overflow-coordinate-fix.mjs
 */

// 洞察:「播放进度」与「段是否完成」是两个问题,不该塞进同一个标量。
//   - renderAbs = writeAbs - queuedSamples  (唯一定义,不减 dropped)
//     语义订正为「读游标已推进到的源流位置」—— 丢弃使游标跳过那段,这是**事实**(游标真的到了那里)
//   - 「丢弃的样本未被听到」用**段级污点(tainted)**表达:溢出时把与丢弃区间相交的段标 tainted,
//     tainted 段完成时发 turn_aborted(而非 turn_played),positionMs 取真实播出量
// 这样:① 新段不受历史丢弃影响(坐标连续)② 被丢段不会伪造 played
const SR = 16000,
  EPS = 1;
class Model {
  constructor() {
    this.writeAbs = 0;
    this.queued = 0;
    this.ledger = [];
    this.events = [];
  }
  renderAbs() {
    return this.writeAbs - this.queued;
  } // ★ 单一定义
  beginTurn(seq) {
    this.ledger.push({ seq, startAbs: this.writeAbs, endAbs: null, state: 'open', tainted: false, taintedSamples: 0 });
  }
  push(n) {
    this.writeAbs += n;
    this.queued += n;
  }
  endTurn(seq) {
    const s = this.ledger.find((x) => x.seq === seq && x.state === 'open');
    if (s) {
      s.endAbs = this.writeAbs;
      this.check();
    }
  }
  // 溢出:丢弃最旧 D 个未播样本。丢弃区间 = [renderAbs, renderAbs+D)
  overflow(D) {
    const lo = this.renderAbs(),
      hi = lo + D;
    for (const s of this.ledger) {
      if (s.state !== 'open') continue;
      const segLo = s.startAbs,
        segHi = s.endAbs ?? this.writeAbs;
      const ovl = Math.max(0, Math.min(hi, segHi) - Math.max(lo, segLo));
      if (ovl > 0) {
        s.tainted = true;
        s.taintedSamples += ovl;
      } // ★ 污点标记,不动坐标
    }
    this.queued -= D; // 未播样本减少
    // 注:renderAbs 因 queued 减少而前跳 = 读游标真的跳过了那段,是事实(writeAbs 是源流累计,不变)
    this.events.push({ type: 'overflow_warn', dropped: D });
  }
  consume(n) {
    const d = Math.min(n, this.queued);
    this.queued -= d;
    this.check();
  }
  check() {
    for (const s of this.ledger) {
      if (s.state !== 'open' || s.endAbs == null) continue;
      if (this.renderAbs() >= s.endAbs - EPS) {
        s.state = 'done';
        if (s.tainted) {
          const realPlayed = s.endAbs - s.startAbs - s.taintedSamples;
          this.events.push({ type: 'turn_aborted', seq: s.seq, positionMs: (realPlayed / SR) * 1000, reason: 'overflow' });
        } else {
          this.events.push({ type: 'turn_played', seq: s.seq, positionMs: ((s.endAbs - s.startAbs) / SR) * 1000 });
        }
      }
    }
    this.ledger = this.ledger.filter((s) => s.state === 'open');
  }
}
console.log('=== 场景 A:review场景(溢出后新段须能完成)===');
const m = new Model();
m.beginTurn(1);
m.push(1000);
m.endTurn(1);
m.consume(1000);
console.log(`  段1 播完: events=${JSON.stringify(m.events.filter((e) => e.seq === 1))}`);
m.push(500);
m.overflow(500); // 写 500 后全丢
console.log(`  溢出500:  renderAbs=${m.renderAbs()} writeAbs=${m.writeAbs} queued=${m.queued}`);
m.beginTurn(2);
m.push(800);
m.endTurn(2);
m.consume(800);
const seg2 = m.events.filter((e) => e.seq === 2);
console.log(`  段2 播完: events=${JSON.stringify(seg2)}`);
console.log(`  ${seg2.some((e) => e.type === 'turn_played') ? '✅ 新段正常完成(Blocker 已解)' : '❌ 新段仍无法完成'}`);

console.log('\n=== 场景 B:被丢弃的段不得伪造 turn_played ===');
const m2 = new Model();
m2.beginTurn(1);
m2.push(100000);
m2.endTurn(1); // 6.25s,一点没播
m2.overflow(100000); // 全被丢
m2.consume(0);
m2.check();
const e1 = m2.events.filter((e) => e.seq === 1);
console.log(`  events=${JSON.stringify(e1)}`);
console.log(`  ${e1.some((e) => e.type === 'turn_played') ? '❌ 伪造了 turn_played' : '✅ 判为 turn_aborted,未伪造'}`);
console.log(`  positionMs=${e1.find((e) => e.type === 'turn_aborted')?.positionMs} (应为 0 = 真的没播)`);

console.log('\n=== 场景 C:部分丢弃(段的一部分被丢)===');
const m3 = new Model();
m3.beginTurn(1);
m3.push(1000);
m3.endTurn(1);
m3.consume(400); // 播了 400
m3.overflow(300); // 丢 300(段内)
m3.consume(300); // 剩 300 播完
const e3 = m3.events.filter((e) => e.seq === 1);
console.log(`  events=${JSON.stringify(e3)}`);
console.log(`  ${e3.some((e) => e.type === 'turn_aborted') ? '✅ 判 aborted' : '❌ 判 played(错)'}`);
console.log(`  positionMs=${e3.find((e) => e.type === 'turn_aborted')?.positionMs} 应=(1000-300)/16000*1000=43.75`);

console.log('\n★ 结论:renderAbs 单一定义 + 段级污点 → 三场景全对。');
console.log('  关键:丢弃不改坐标(游标真的跳过了),而是标记「这段听不全」→ 完成时降级为 aborted。');
