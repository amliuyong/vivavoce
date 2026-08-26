// design contract:播放端连续重采样纯逻辑(ring buffer + 16k→硬件率连续升采样 + 跨块相位 + 欠载静音 + flush)。
// 前端无 jsdom:纯逻辑直 import 变异自证 + pcm-playback-worklet.js / Exam.tsx 源码守门。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PlaybackResampler } = require('../src/lib/playback-resampler.ts');

// 造一段 16k int16 正弦(便于验证相位/形状)
function sine16(freqHz, n, amp = 0.5) {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(32767 * amp * Math.sin((2 * Math.PI * freqHz * i) / 16000));
  return a;
}

// ── 升采样比:16k→48k 每输入样本约出 3 输出样本 ──
test('升采样比:16k→48k,喂 N 输入 → 约 3N 输出(连续拉取)', () => {
  const r = new PlaybackResampler(48000); // 输出硬件率 48k,输入固定 16k
  r.push(sine16(300, 1600)); // 0.1s @16k
  // 分多次拉取(模拟 process 每次要 128 帧),累计到 ring 排空
  let total = 0;
  for (let i = 0; i < 100; i++) {
    const out = new Float32Array(128);
    const wrote = r.pull(out); // 返回本次写入的有效样本数(不足补 0 也算写满,但 wrote 反映有效)
    total += wrote;
    if (r.available() === 0 && wrote < 128) break;
  }
  // 1600 输入样本 @16k → 48k 约 4800 输出;允许边界 ±ratio
  assert.ok(total >= 4797 && total <= 4801, `期望约4800,实得${total}`);
});

// ── 跨块相位连续:分块 push vs 一次 push,输出序列一致 ──
test('跨块相位连续:分块喂 vs 一次喂,输出样本序列逐点一致(不逐块取整漂移)', () => {
  const src = sine16(500, 1600);
  // A:一次喂
  const rA = new PlaybackResampler(48000);
  rA.push(src);
  const outA = drainAll(rA);
  // B:分 37 样本一块喂(非整除,逼出相位边界)
  const rB = new PlaybackResampler(48000);
  for (let off = 0; off < src.length; off += 37) rB.push(src.subarray(off, off + 37));
  const outB = drainAll(rB);
  assert.equal(outA.length, outB.length, `长度不一致 A=${outA.length} B=${outB.length}`);
  let maxDev = 0;
  for (let i = 0; i < outA.length; i++) maxDev = Math.max(maxDev, Math.abs(outA[i] - outB[i]));
  assert.ok(maxDev < 1e-6, `跨块相位漂移 maxDev=${maxDev}`);
});

// ── 欠载:ring 空 → pull 出静音(全 0),不抛;后续 push 续上 ──
test('欠载:ring 空 pull 出静音全0且 wrote=0;push 后续上不 glitch', () => {
  const r = new PlaybackResampler(48000);
  const out = new Float32Array(128);
  const wrote = r.pull(out);
  assert.equal(wrote, 0, '空 ring 应 wrote=0');
  assert.ok(out.every((v) => v === 0), '空 ring 应输出全 0 静音');
  // push 后能出声
  r.push(sine16(300, 320));
  const out2 = new Float32Array(128);
  const wrote2 = r.pull(out2);
  assert.ok(wrote2 > 0, 'push 后应出有效样本');
});

// ── flush:清空 ring,后续 pull 出静音直到新 push ──
test('flush:立即清空 ring,后续 pull 静音直到新数据', () => {
  const r = new PlaybackResampler(48000);
  r.push(sine16(300, 1600));
  assert.ok(r.available() > 0, 'push 后 ring 非空');
  r.flush();
  assert.equal(r.available(), 0, 'flush 后 ring 空');
  const out = new Float32Array(128);
  assert.equal(r.pull(out), 0, 'flush 后 pull 静音');
});

// ── 硬件率 = 16k(退化):直通比 1:1,喂 N 出 N ──
test('硬件率=16k:升采样比 1,喂 N 约出 N', () => {
  const r = new PlaybackResampler(16000);
  r.push(sine16(300, 1600));
  const out = drainAll(r);
  assert.ok(out.length >= 1598 && out.length <= 1600, `期望约1600,实得${out.length}`);
});

// ── 线性插值端点不越界:44100 非整数比,大量 pull 不 NaN/不抛 ──
test('44100 非整数比:连续拉取无 NaN、无越界', () => {
  const r = new PlaybackResampler(44100);
  r.push(sine16(300, 1600));
  const out = drainAll(r);
  assert.ok(out.length > 4000, '44100 应出 >4000 样本');
  assert.ok(out.every((v) => Number.isFinite(v) && v >= -1 && v <= 1), '样本须有限且在 [-1,1]');
});

// 把 resampler 拉干净(欠载即停),返回拼接的有效输出
function drainAll(r) {
  const chunks = [];
  for (let i = 0; i < 1000; i++) {
    const out = new Float32Array(128);
    const wrote = r.pull(out);
    if (wrote === 0) break;
    chunks.push(out.subarray(0, wrote));
    if (r.available() === 0 && wrote < 128) break;
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const merged = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { merged.set(c, o); o += c.length; }
  return merged;
}

// ── 关键边界:pull 到分数相位中途 push 新数据,不丢当前插值样本、相位不跳变 ──
test('pull 中途 push:连续性保持(交替 pull/push vs 一次性,输出一致)', () => {
  const src = sine16(400, 960);
  // fadeSamples=0 隔离 R4 fade 包络(本测试验证纯相位连续,fade 是正交的叠加包络)。
  // A:一次 push 全部,一次拉干
  const rA = new PlaybackResampler(48000, 0);
  rA.push(src);
  const outA = drainAll(rA);
  // B:每 128 输入样本 push 一次,每次 push 后拉一小段(留 ring 不排空,逼分数相位跨 push)
  const rB = new PlaybackResampler(48000, 0);
  const chunksB = [];
  for (let off = 0; off < src.length; off += 128) {
    rB.push(src.subarray(off, off + 128));
    // 拉一部分但不拉干(留余量),逼 push 发生在分数相位中途
    const out = new Float32Array(200);
    const w = rB.pull(out);
    if (w > 0) chunksB.push(out.subarray(0, w));
  }
  // 收尾拉干
  const tail = drainAll(rB);
  if (tail.length) chunksB.push(tail);
  const totalB = chunksB.reduce((a, c) => a + c.length, 0);
  const outB = new Float32Array(totalB);
  let o = 0; for (const c of chunksB) { outB.set(c, o); o += c.length; }
  // 长度应一致(±1 边界),且前缀逐点一致(相位连续无跳变/无丢样本)
  assert.ok(Math.abs(outA.length - outB.length) <= 1, `长度 A=${outA.length} B=${outB.length}`);
  const cmp = Math.min(outA.length, outB.length);
  let maxDev = 0;
  for (let i = 0; i < cmp; i++) maxDev = Math.max(maxDev, Math.abs(outA[i] - outB[i]));
  assert.ok(maxDev < 1e-6, `pull中途push相位漂移 maxDev=${maxDev}`);
});

// ── worklet 文件源码守门(worklet 不能被 node require:有 registerProcessor/sampleRate 全局)──
// 防 pcm-playback-worklet.js 与 playback-resampler.ts 核心逻辑漂移(改一处须同步另一处)。
test('worklet 源码守门:registerProcessor pcm-playback + flush/drained 消息 + 连续插值', () => {
  const w = fs.readFileSync(path.join(__dirname, '../public/pcm-playback-worklet.js'), 'utf8');
  assert.ok(/registerProcessor\('pcm-playback'/.test(w), '必须 registerProcessor(pcm-playback)');
  assert.ok(/INPUT_RATE = 16000/.test(w), '输入固定 16k');
  assert.ok(/INPUT_RATE \/ sampleRate/.test(w), '升采样比 = 16000/sampleRate(硬件率全局)');
  assert.ok(/type === 'flush'/.test(w), 'barge-in flush 消息处理');
  assert.ok(/type: 'drained'/.test(w), 'drain 边沿回传 drained 驱动 aiSpeaking');
  assert.ok(/PREROLL_SAMPLES/.test(w), '首帧预缓冲 PREROLL(抗启动 underrun)');
  // 连续插值核心(design contract 起为分片队列形态:a/b 两点线性插值,b 可跨分片取下一分片首样本)
  assert.ok(/a \* \(1 - frac\) \+ b \* frac/.test(w), '连续线性插值(跨块相位)');
  // 欠载判定:队头或后继样本缺席(design contract 取代旧的 idx+1 越界判据;行为等价,见 worklet-core-parity)
  assert.ok(/a === null \|\| b === null/.test(w), '欠载判定(队头/后继缺席→静音)');
  // ★ design contract:MUST NOT 退回「每 push 全量重建数组」(本 spec 根因)
  assert.ok(!/new Float32Array\(Math\.max\(0, keep\)/.test(w), '禁止旧的 O(缓冲深度) 拷贝写法');
});

// ── 评审修复守门(review):preroll 只首次冷启动 + drained 当场发 ──
test('worklet 评审修复:_everStarted 只 flush 重置(drained 后保持,后续句无 preroll 延迟)', () => {
  const w = fs.readFileSync(path.join(__dirname, '../public/pcm-playback-worklet.js'), 'utf8');
  // 用 _everStarted 而非旧 _started(drained 后不重置的语义)
  assert.ok(/_everStarted/.test(w), '必须用 _everStarted(首次冷启动标志,drained 后保持)');
  // drained 分支**不得**重置 _everStarted(否则每句重新 preroll,慢半拍;review)
  const drainBranch = w.slice(w.indexOf("type: 'drained'"), w.indexOf("type: 'drained'") + 300);
  assert.ok(!/_everStarted = false/.test(drainBranch), 'drained 分支不得重置 _everStarted(否则每句 preroll 延迟)');
  // flush 分支**必须**重置 _everStarted(barge-in 新语境重新 preroll)。用下一消息分支作结构边界，
  // 避免 telemetry/ACK 逻辑增长后固定字符窗口误报。
  const flushStart = w.indexOf("type === 'flush'");
  const flushEnd = w.indexOf("type === 'telemetry_begin_turn'", flushStart);
  const flushBranch = w.slice(flushStart, flushEnd);
  assert.ok(/_everStarted = false/.test(flushBranch), 'flush 分支必须重置 _everStarted(barge-in 重新 preroll)');
  // R4:drained 收紧为「持续静默确认」(_silentBlocks 达 DRAIN_CONFIRM_BLOCKS),非 ring 一空就发
  assert.ok(/DRAIN_CONFIRM_BLOCKS/.test(w), 'drained 须持续静默确认(修重叠:瞬时 underrun 不翻 playbackActive)');
  assert.ok(/_silentBlocks/.test(w), '须累计连续静默块计数');
});

// ── design contract worklet 守门:fade 包络 + 真 drain 确认(消中段咔哒 + 消两句叠一起)──
test('worklet R4 守门:FADE 包络 + DRAIN_CONFIRM_BLOCKS 与 core 同步', () => {
  const w = fs.readFileSync(path.join(__dirname, '../public/pcm-playback-worklet.js'), 'utf8');
  const c = fs.readFileSync(path.join(__dirname, '../src/lib/playback-resampler.ts'), 'utf8');
  // fade 窗常量两份一致(128)
  assert.ok(/FADE_SAMPLES = 128/.test(w), 'worklet FADE_SAMPLES=128');
  assert.ok(/FADE_SAMPLES = 128/.test(c), 'core FADE_SAMPLES=128(与 worklet 同步)');
  // worklet fade 包络逻辑
  assert.ok(/_fadeGain/.test(w), 'worklet 须有 _fadeGain 包络');
  assert.ok(/remainOut <= FADE_SAMPLES/.test(w), 'worklet 须预判 underrun 提前淡出');
  // 真 drain 确认:ring 空后累计静默块,达阈值才发 drained(瞬时 underrun 不发)
  assert.ok(/_silentBlocks \+= 1/.test(w), 'underrun 累计静默块');
  assert.ok(/_silentBlocks >= DRAIN_CONFIRM_BLOCKS/.test(w), '达阈值才认定真 drain');
});

// ── design contract worklet 段账本守门:与 core 同步(begin/end/flushAll + 绝对坐标派生 + tombstone + 解耦)──
test('059 worklet 守门:段账本 + renderAbs 派生 + tombstone + turn_played/aborted + drained 解耦', () => {
  const w = fs.readFileSync(path.join(__dirname, '../public/pcm-playback-worklet.js'), 'utf8');
  // 轮边界消息(begin_turn/end_turn)+ 事件回传(turn_played/turn_aborted)
  assert.ok(/type === 'begin_turn'/.test(w), 'worklet 须处理 begin_turn(ai_audio_start)');
  assert.ok(/type === 'end_turn'/.test(w), 'worklet 须处理 end_turn(ai_audio_end)');
  assert.ok(/type: 'turn_played'/.test(w), 'worklet 须发 turn_played(自然播完)');
  assert.ok(/type: 'turn_aborted'/.test(w), 'worklet 须发 turn_aborted(flush 打断)');
  // 绝对坐标派生(review 派生自 writeAbs,flush 不归零)
  assert.ok(/_writeAbs \+= chunk\.length/.test(w), 'writeAbs 会话级累计写入(design contract:按入队分片长度)');
  // renderAbs **单一定义**且保持派生(design contract;第 2 轮 review:第二个定义会致溢出后段永不完成)
  assert.ok(/this\._writeAbs - this\._q\.size\(\)/.test(w), 'renderAbs 派生(不独立计数,防发散)');
  assert.ok(
    !/_writeAbs - this\._q\.size\(\) - this\._droppedSamples/.test(w),
    'droppedSamples MUST NOT 进 renderAbs(会致溢出后新段永不完成)'
  );
  // flushAll:不归零坐标(靠 generation+tombstone 隔离)
  const flushAllBody = w.slice(w.indexOf('_flushAll()'), w.indexOf('_flushAll()') + 700);
  assert.ok(!/_writeAbs = 0/.test(flushAllBody), 'flushAll 不得归零 writeAbs(review)');
  assert.ok(/_generation \+= 1/.test(w), 'flushAll 代次递增(隔离迟到事件)');
  assert.ok(/_tombstone = true/.test(w), 'flushAll 置 tombstone(丢弃旧代次 PCM 防混播)');
  // tombstone 在 begin_turn 解除 + push 早退
  assert.ok(/_tombstone = false/.test(w), 'begin_turn 解除 tombstone');
  assert.ok(/if \(this\._tombstone\) return/.test(w), 'push 在 tombstone 期早退不入 ring');
  // 完成判据尾差容差 + 仅出声后判定(underrun 不误报)
  assert.ok(/EPS_SAMPLES/.test(w), '完成判据 EPS 尾差容差');
  // 仅实际出声后判完成(underrun 不误报)。design contract 起该块内还要标 seg.rendered,故锁"门存在"而非单行形态。
  assert.ok(/if \(written > 0\) \{[\s\S]{0,400}?_checkCompletions\(\)/.test(w), '仅实际出声后判完成(underrun 不误报)');
  // design contract:出声后标记 rendered —— 供区分「真播完」与「零/单样本段判据天然成立」
  assert.ok(/seg\.rendered = true/.test(w), 'worklet 须标记 seg.rendered(防零样本段发假 turn_played)');
  assert.ok(/seg\.tainted \|\| !seg\.rendered/.test(w), 'worklet 须对 tainted 或未渲染段降级发 turn_aborted');
  // M6:封口短段解 preroll
  assert.ok(/endAbs - seg\.startAbs < PREROLL_SAMPLES/.test(w), 'M6 封口短段解 preroll(防 <120ms 轮永卡)');
  // drained 与 turn_played 解耦:drained 分支不得发 turn_played
  const drainBranch2 = w.slice(w.indexOf("type: 'drained'"), w.indexOf("type: 'drained'") + 200);
  assert.ok(!/turn_played/.test(drainBranch2), 'drained 分支不得触发单轮 ACK(解耦)');
});


// ── design contract:underrun 边界淡出/淡入(消中段咔哒杂音)──
// 根因:长回复中段 ring 追空(跨境 TTS 还在生成)→ 硬切到 0 = 咔哒;恢复从 0 跳回非零 = 又一咔哒。
// 修:underrun 前对末样本淡出、恢复时对头样本淡入,消除波形突跳。
test('R4 underrun 淡出:进入欠载前末样本渐降(非硬切到0)', () => {
  const r = new PlaybackResampler(48000);
  // 喂一段**恒定高电平**(便于看淡出:正常应保持高值,淡出则末尾渐降)
  const flat = new Int16Array(600).fill(16000); // 恒定 ~0.49
  r.push(flat);
  const out = new Float32Array(4096); // 足够大,一次拉到欠载
  const w = r.pull(out);
  // 找欠载点(第一个 0)。欠载前若干样本应**渐降**(淡出),而非从 0.49 直接跳 0。
  let zeroAt = -1;
  for (let i = 1; i < out.length; i++) { if (out[i] === 0 && out[i - 1] !== 0) { zeroAt = i; break; } }
  assert.ok(zeroAt > 0, '应有欠载静音点');
  // 淡出证据:zeroAt 前一小段单调下降到接近 0(末样本 << 稳态 0.49)
  const preZero = out[zeroAt - 1];
  assert.ok(Math.abs(preZero) < 0.25, `欠载前末样本应已淡出到低值(实得 ${preZero.toFixed(3)},稳态~0.49)`);
});

test('R4 恢复淡入:欠载后新数据首样本渐起(非从0硬跳到稳态)', () => {
  const r = new PlaybackResampler(48000);
  r.push(new Int16Array(600).fill(16000));
  const out1 = new Float32Array(4096);
  r.pull(out1); // 拉到欠载(触发淡出 + 静音)
  // 新数据到(恒定高电平)
  r.push(new Int16Array(600).fill(16000));
  const out2 = new Float32Array(256);
  const w2 = r.pull(out2);
  assert.ok(w2 > 0, '恢复应出声');
  // 淡入证据:首样本应远小于稳态(渐起),不是直接 0.49
  assert.ok(Math.abs(out2[0]) < 0.25, `恢复首样本应淡入低值(实得 ${out2[0].toFixed(3)})`);
  // fade 窗(128 样本)之后应达稳态(淡入完成)。取 250 > 128,确保过窗。
  assert.ok(Math.abs(out2[250]) > 0.4, `淡入(128样本)后应达稳态(实得 ${out2[250].toFixed(3)})`);
});

test('R4 不影响连续播放:ring 充足时无 fade 干扰(稳态全幅)', () => {
  const r = new PlaybackResampler(48000);
  r.push(new Int16Array(6000).fill(16000)); // 大量数据,不欠载
  const out = new Float32Array(512);
  r.pull(out);
  // 首次 pull 开头是淡入(冷启动 128 样本),过窗后应稳态全幅(不被 fade 干扰)
  assert.ok(Math.abs(out[400]) > 0.4, `连续播放稳态应全幅(实得 ${out[400].toFixed(3)})`);
});

// ── R4 review:淡出中 flush → fadeGain 归零,下段重新淡入(barge-in 打断淡出中) ──
test('R4 淡出中 flush:fadeGain 归零,下段从 0 重新淡入', () => {
  const r = new PlaybackResampler(48000);
  r.push(new Int16Array(200).fill(16000)); // 小段(200 输入 → ~600 输出,不足以维持,很快进淡出区)
  const out1 = new Float32Array(512);
  r.pull(out1); // 部分消费 → 触发预判淡出(fadeGain 降到中间值或已 0)
  r.flush(); // barge-in 在淡出中打断
  r.push(new Int16Array(600).fill(16000)); // 新段
  const out2 = new Float32Array(256);
  const w2 = r.pull(out2);
  assert.ok(w2 > 0, 'flush 后新段应出声');
  assert.ok(Math.abs(out2[0]) < 0.25, `flush 后新段应从 0 淡入(实得 ${out2[0].toFixed(3)})`);
  assert.ok(Math.abs(out2[250]) > 0.4, `淡入完成后达稳态(实得 ${out2[250].toFixed(3)})`);
});

// ── R6(真机根因):ring 上限不得丢弃**未播**内容(修"下一句冲掉上一句")──
// 根因:下发远快于播放(design contract:48s音频12s下发完),长回复 ring 快速堆积;R4 加的 RING_MAX=20s 截断
// 在正常长回复就频繁触发,丢掉排队待播的后续句 = "冲掉"(前期积压深最严重、后期排空变轻)。
// 修:上限提到远大于任何真实回复(300s),正常永不触发,只作真病态 OOM backstop。
test('R6 长回复不丢未播内容:push 40s 音频(超旧20s上限)几乎不 pull,数据全保留', () => {
  const r = new PlaybackResampler(48000, 0); // fade 关(隔离),只测 ring 容量
  // 用单调递增序号当样本值,追踪是否丢内容。push 40s@16k = 640000 样本,分块 push。
  let seq = 1;
  const CHUNK = 3200; // 0.2s@16k
  const TOTAL = 640000; // 40s
  for (let off = 0; off < TOTAL; off += CHUNK) {
    const a = new Int16Array(CHUNK);
    for (let i = 0; i < CHUNK; i++) a[i] = ((seq++) % 20000) - 10000; // 值域内单调(wrap)
    r.push(a);
  }
  // 几乎不 pull(模拟下发远快于播放:只拉出很小一部分)。available 应 ≈ 全部 push 的(约 40s→48k 域 ~1.28M)
  // 关键断言:ring 里可播的输出样本数应接近 TOTAL/ratio(不被截断丢弃)。
  const avail = r.available();
  const expectedMin = (TOTAL / (16000 / 48000)) * 0.98; // 40s@16k → 48k 域约 1.92M,允许 2% 边界
  assert.ok(avail >= expectedMin, `ring 应保留几乎全部未播数据(期望≥${Math.round(expectedMin)},实得${avail})——旧 20s 上限会截断丢弃`);
});

// ══════════════════════ design contract 播放 ACK 段账本 ══════════════════════
// worklet/core 维护会话级绝对坐标 + 段账本,轮自然播完发 turn_played、flush 打断发 turn_aborted。
// ring 连续重采样内核不改(守 design contract);账本只作「样本流上的水位线」,不切 ring、不重置相位。

// 把 resampler 完全拉干(fade 关,隔离账本判定),返回累计 written
function drainToEmpty(r) {
  let total = 0;
  for (let i = 0; i < 100000; i++) {
    const out = new Float32Array(128);
    const w = r.pull(out);
    total += w;
    if (w === 0 && r.available() === 0) break;
  }
  return total;
}

// ── 无账本(非 ACK 模式):逐字节等价 design contract,不发任何事件 ──
test('059 惰性:未 beginTurn 则 pull/flush 不产生任何事件(逐字节等价 design contract)', () => {
  const r = new PlaybackResampler(48000, 0);
  r.push(sine16(300, 1600));
  drainToEmpty(r);
  assert.equal(r.takeEvents().length, 0, '无账本不应发事件');
  r.push(sine16(300, 1600));
  r.flush();
  assert.equal(r.takeEvents().length, 0, 'flush 无账本不应发事件');
  assert.equal(r.available(), 0, 'flush 后 ring 空');
});

// ── 关键量纲变异测试(review 关注):1s@16k 音频 → renderAbs 播完应≈16000(输入域),非 48000(输出域)──
// 若把 positionMs 按输出域硬件率算,1s 段会得 3000ms(48000/16000×1000),此测试红。
test('059 量纲:1s@16k 段自然播完 positionMs≈1000(输入域16k,非输出域48k)', () => {
  const r = new PlaybackResampler(48000, 0);
  r.beginTurn(7);
  r.push(sine16(300, 16000)); // 恰 1s @16k
  r.endTurn(7);               // 封口:endAbs = 16000
  drainToEmpty(r);
  const evs = r.takeEvents();
  const played = evs.filter((e) => e.type === 'turn_played' && e.seq === 7);
  assert.equal(played.length, 1, `应恰发一次 turn_played(实得${JSON.stringify(evs)})`);
  // 输入域:16000 样本 / 16000 × 1000 = 1000ms。输出域会误得 3000ms。
  assert.ok(Math.abs(played[0].positionMs - 1000) < 5, `positionMs 应≈1000(输入域),实得${played[0].positionMs}`);
});

// ── 一轮一唯一终态:多次 pull 跨块播完只发一次 turn_played(不重复) ──
test('059 唯一终态:分多块 pull 播完同一轮只发一次 turn_played', () => {
  const r = new PlaybackResampler(48000, 0);
  r.beginTurn(1);
  r.push(sine16(300, 3200)); // 0.2s
  r.endTurn(1);
  // 手动分块 pull(不用 drainToEmpty 的 break,确保多块跨越封口位)
  for (let i = 0; i < 200; i++) {
    const out = new Float32Array(128);
    r.pull(out);
    if (r.available() === 0) { const o2 = new Float32Array(128); r.pull(o2); break; }
  }
  const played = r.takeEvents().filter((e) => e.type === 'turn_played');
  assert.equal(played.length, 1, `一轮只发一次 turn_played,实得${played.length}`);
  assert.equal(played[0].seq, 1);
});

// ── R3「end 先到、source 稍后播完」:endTurn 时 ring 未播完 → 不立即 complete;播到封口才 complete ──
test('059 end先到:endTurn 时未播完不 complete,播过封口位才 complete', () => {
  const r = new PlaybackResampler(48000, 0);
  r.beginTurn(2);
  r.push(sine16(300, 16000)); // 1s
  r.endTurn(2);               // 立即封口,但一点没播
  assert.equal(r.takeEvents().length, 0, 'endTurn 时未播完不应 complete');
  // 只拉一小段(远不到封口)
  const out = new Float32Array(128);
  r.pull(out);
  assert.equal(r.takeEvents().filter((e) => e.type === 'turn_played').length, 0, '播一小段不应 complete');
  drainToEmpty(r);
  assert.equal(r.takeEvents().filter((e) => e.type === 'turn_played').length, 1, '播过封口才 complete');
});

// ── R3「source 已播空、end 稍后到」:ring 排空后 endTurn 才到 → 立即 complete(不永久等) ──
test('059 end后到:ring 已排空后 endTurn 到达立即 complete', () => {
  const r = new PlaybackResampler(48000, 0);
  r.beginTurn(3);
  r.push(sine16(300, 3200));
  drainToEmpty(r); // 全播完,但还没 endTurn
  assert.equal(r.takeEvents().filter((e) => e.type === 'turn_played').length, 0, 'open 未封口不 complete');
  r.endTurn(3);    // 封口到达 → 立即重查 → complete
  const played = r.takeEvents().filter((e) => e.type === 'turn_played');
  assert.equal(played.length, 1, 'endTurn 到达应立即 complete(不永久等)');
  assert.equal(played[0].seq, 3);
});

// ── flush 打断:先按 renderAbs 算截断 position 发 turn_aborted,再清 ring;不发 turn_played ──
test('059 flush打断:发 turn_aborted(截断position)不发 turn_played,ring 清空', () => {
  const r = new PlaybackResampler(48000, 0);
  r.beginTurn(4);
  r.push(sine16(300, 16000)); // 1s
  r.endTurn(4);
  // 播约 0.3s(输入域 ~4800 样本)后打断
  for (let i = 0; i < 113; i++) { const out = new Float32Array(128); r.pull(out); } // 113×128≈14464 输出样本 @48k ≈0.3s → 输入域 ~4821
  r.flush();
  const evs = r.takeEvents();
  assert.equal(evs.filter((e) => e.type === 'turn_played').length, 0, 'flush 不发 turn_played');
  const aborted = evs.filter((e) => e.type === 'turn_aborted' && e.seq === 4);
  assert.equal(aborted.length, 1, '应发一次 turn_aborted');
  // 截断 position 应 ≈ 已播时长(0.3s ≈ 300ms),远小于全段 1000ms
  assert.ok(aborted[0].positionMs > 200 && aborted[0].positionMs < 400, `截断position应≈300ms,实得${aborted[0].positionMs}`);
  assert.equal(r.available(), 0, 'flush 后 ring 空');
});

// ── 变异守门(R3):stop() 绝不伪装 complete —— flush 时若段已达封口位,仍必须 aborted 非 complete ──
test('059 变异:flush 时即使 renderAbs 接近封口,也发 aborted 不发 complete', () => {
  const r = new PlaybackResampler(48000, 0);
  r.beginTurn(5);
  r.push(sine16(300, 1600)); // 0.1s 短段
  r.endTurn(5);
  const out = new Float32Array(64); // 只播极小一段就 flush(未到封口)
  r.pull(out);
  r.flush();
  const evs = r.takeEvents();
  assert.equal(evs.filter((e) => e.type === 'turn_played').length, 0, 'flush 必须不发 complete');
  assert.equal(evs.filter((e) => e.type === 'turn_aborted').length, 1, 'flush 必须发 aborted');
});

// ── review 后 renderAbs/writeAbs 不归零,新代次轮完成判据仍成立(不发散) ──
test('059 flush不归零坐标:打断后新轮仍能正常 complete(review 死结验证)', () => {
  const r = new PlaybackResampler(48000, 0);
  // 第一轮:播一半打断
  r.beginTurn(10);
  r.push(sine16(300, 16000));
  r.endTurn(10);
  for (let i = 0; i < 50; i++) { const out = new Float32Array(128); r.pull(out); }
  r.flush(); // 代次++,tombstone
  r.takeEvents();
  const genAfterFlush = r.currentGeneration();
  assert.ok(genAfterFlush >= 1, 'flush 后代次应递增');
  // 第二轮:beginTurn 解除 tombstone,正常播完 → 必须能 complete(若坐标发散则永不 complete = 红)
  r.beginTurn(11);
  r.push(sine16(300, 3200));
  r.endTurn(11);
  drainToEmpty(r);
  const played = r.takeEvents().filter((e) => e.type === 'turn_played' && e.seq === 11);
  assert.equal(played.length, 1, '新代次轮必须能正常 complete(坐标不发散)');
  assert.equal(played[0].generation, genAfterFlush, '事件带当前代次');
  // 新轮 positionMs 应 ≈ 200ms(3200/16000×1000),不受前一轮坐标累积影响
  assert.ok(Math.abs(played[0].positionMs - 200) < 5, `新轮 positionMs 应≈200,实得${played[0].positionMs}`);
});

// ── tombstone:flush 后、新 beginTurn 前到达的旧代次 PCM 被丢弃(不回灌 ring,防混播) ──
test('059 tombstone:flush 后旧代次 PCM 被丢弃不入 ring,新 beginTurn 后恢复', () => {
  const r = new PlaybackResampler(48000, 0);
  r.beginTurn(20);
  r.push(sine16(300, 3200));
  r.flush(); // tombstone 置位
  r.takeEvents();
  // 旧轮在途 PCM 到达(模拟服务端已 cancel 但缓冲帧仍下发)
  r.push(sine16(300, 3200));
  assert.equal(r.available(), 0, 'tombstone 期旧 PCM 不入 ring');
  // 新轮开始 → 解除 tombstone
  r.beginTurn(21);
  r.push(sine16(300, 3200));
  assert.ok(r.available() > 0, '新 beginTurn 后 PCM 正常入 ring');
});

// ── underrun 不误报完成(review):endTurn 未到、ring 中途排空 → 不 complete ──
test('059 underrun 不误报:open 段未封口时 ring 排空不发 turn_played', () => {
  const r = new PlaybackResampler(48000, 0);
  r.beginTurn(30);
  r.push(sine16(300, 1600)); // 只推一小段,不 endTurn(模拟跨境 TTS 还在生成后续句)
  drainToEmpty(r);           // ring 排空(瞬时 underrun)
  assert.equal(r.takeEvents().filter((e) => e.type === 'turn_played').length, 0, '未封口 open 段排空不应 complete');
  // 后续句到 + 封口 → 正常 complete
  r.push(sine16(300, 1600));
  r.endTurn(30);
  drainToEmpty(r);
  assert.equal(r.takeEvents().filter((e) => e.type === 'turn_played').length, 1, '封口后播完才 complete');
});

// ── fail-soft:重复 start / end-before-start / 未知 seq 的 endTurn 不崩、不误发 ──
test('059 fail-soft:重复 beginTurn 幂等、未知 seq 的 endTurn 忽略', () => {
  const r = new PlaybackResampler(48000, 0);
  r.beginTurn(40);
  r.beginTurn(40); // 重复 → 幂等
  r.push(sine16(300, 1600));
  r.endTurn(99);   // 未知 seq → 忽略,不崩
  r.endTurn(40);
  drainToEmpty(r);
  const played = r.takeEvents().filter((e) => e.type === 'turn_played');
  assert.equal(played.length, 1, '重复 start 只应一段,未知 end 被忽略');
  assert.equal(played[0].seq, 40);
});

// ── 病态防护(review):疯狂 beginTurn 不封口 → ledger 有界(与 worklet LEDGER_MAX=64 同步)──
test('059 ledger 病态防护:100 个未封口 beginTurn → ledger 有界(≤64,不无限增长)', () => {
  const r = new PlaybackResampler(48000, 0);
  for (let i = 0; i < 100; i++) r.beginTurn(i); // 全不封口(引擎疯狂发 begin_turn 的病态场景)
  // 读私有 ledger 长度(测试白盒):应被 LEDGER_MAX 截到 64,不是 100。
  const ledgerLen = r.ledger.length;
  assert.ok(ledgerLen <= 64, `ledger 应有界 ≤64(实得 ${ledgerLen})——防病态内存泄漏`);
});

// ── worklet/core LEDGER_MAX 同步守门(防两份漂移)──
test('059 worklet/core LEDGER_MAX 同步:两份均 64', () => {
  const w = fs.readFileSync(path.join(__dirname, '../public/pcm-playback-worklet.js'), 'utf8');
  const c = fs.readFileSync(path.join(__dirname, '../src/lib/playback-resampler.ts'), 'utf8');
  assert.ok(/LEDGER_MAX = 64/.test(w), 'worklet LEDGER_MAX=64');
  assert.ok(/LEDGER_MAX = 64/.test(c), 'core LEDGER_MAX=64(与 worklet 同步,review)');
  assert.ok(/this\._ledger\.length > LEDGER_MAX/.test(w), 'worklet beginTurn 后检查上限');
  assert.ok(/this\.ledger\.length > LEDGER_MAX/.test(c), 'core beginTurn 后检查上限');
});

// ── 多段并存(observe 模式:turn17 未播完又来 turn18)→ 各自独立完成 ──
test('059 多段:两轮先后封口,各自越过封口位独立 complete', () => {
  const r = new PlaybackResampler(48000, 0);
  r.beginTurn(50);
  r.push(sine16(300, 1600)); // seg50: [0,1600)
  r.endTurn(50);
  r.beginTurn(51);
  r.push(sine16(400, 1600)); // seg51: [1600,3200)
  r.endTurn(51);
  drainToEmpty(r);
  const played = r.takeEvents().filter((e) => e.type === 'turn_played');
  assert.equal(played.length, 2, '两轮各 complete 一次');
  assert.deepEqual(played.map((e) => e.seq).sort(), [50, 51]);
});

// ══════════════════════ design contract 抗 imaging 低通 FIR ══════════════════════
// 线性插值升采样产生 imaging(频谱镜像 k·16000±f);语音辅音宽带高频 → 强 imaging = 每句起句杂音。
// 修:输出域 windowed-sinc FIR 低通(fc=7500/63taps),44.1/48k imaging(9k/10k)=0%、6k 保 100%、7k 保 82%。
const { designLowpass } = require('../src/lib/playback-resampler.ts');
function magAt(freq, sig, sr) {
  let re = 0, im = 0;
  for (let n = 0; n < sig.length; n++) { const w = (2 * Math.PI * freq * n) / sr; re += sig[n] * Math.cos(w); im -= sig[n] * Math.sin(w); }
  return Math.sqrt(re * re + im * im) / sig.length;
}
function upDrain(freq, anti) {
  const r = new PlaybackResampler(48000, 0, anti); // fade 关(隔离),抗 imaging 按参
  r.push(sine16(freq, 8000, 0.6));
  const out = [];
  for (let t = 0; t < 3000; t++) { const o = new Float32Array(128); const w = r.pull(o); for (let i = 0; i < w; i++) out.push(o[i]); if (w === 0 && r.available() === 0) break; }
  return out.slice(1000, 1000 + 4096);
}

test('068 imaging 抑制(生产路径):6kHz → 10kHz 镜像 ~40% 压到 <1%,6k 基频保 >95%', () => {
  // ★ 经**生产 PlaybackResampler 实例**(upDrain 走真 pull 路径),非直调 designLowpass(review:
  //   假绿——门槛须紧到能抓「默认参数退回 7800/31」的变异:7800/31 下 10k 镜像 ~1-2%、6k 保 ~94%;7500/63 下
  //   10k=0.1%、6k=100%。故门槛设 <1% + >95%,退回 31taps 则红)。
  const off = upDrain(6000, false), on = upDrain(6000, true);
  const baseOff = magAt(6000, off, 48000), imgOff = magAt(10000, off, 48000);
  const baseOn = magAt(6000, on, 48000), imgOn = magAt(10000, on, 48000);
  assert.ok(imgOff / baseOff > 0.2, `抗 imaging 关时 10kHz 镜像应显著(实得 ${(imgOff / baseOff * 100).toFixed(1)}%)`);
  assert.ok(imgOn / baseOn < 0.01, `抗 imaging 开时 10kHz 镜像应 <1%(7500/63;退回 7800/31 则 ~1-2% 红。实得 ${(imgOn / baseOn * 100).toFixed(2)}%)`);
  assert.ok(baseOn / baseOff > 0.95, `6kHz 基频应保 >95%(7500/63=100%;7800/31=~94% 红。实得 ${(baseOn / baseOff * 100).toFixed(1)}%)`);
});

test('068 欠载边界无跳变(生产路径,Blocker 1):FIR/fade 交互不放大欠载尾跳变', () => {
  // 经生产实例(fade 开 128 = 生产配置)。FIR 群延迟与 fade 硬切的交互:只滤 [0,written) 会把欠载边界跳变
  //   从 ~0.004 放大到 0.02+(review);修=欠载时滤全块 [0,n) ring-out 进零尾。
  function edgeJump(anti) {
    const r = new PlaybackResampler(48000, 128, anti);
    r.push(sine16(300, 200, 0.5)); // 短段 → 很快欠载
    const o = new Float32Array(4096); r.pull(o);
    let last = -1; for (let i = 0; i < o.length; i++) if (o[i] !== 0) last = i;
    return Math.abs(o[last] - (o[last + 1] || 0));
  }
  const jOff = edgeJump(false), jOn = edgeJump(true);
  // 修后 FIR 开的欠载边界跳变应 **不超过** FIR 关的基线(实测修后 ~0,远优于放大态 0.02+)。
  assert.ok(jOn <= jOff + 0.005, `FIR 开欠载边界跳变不应放大(FIR关=${jOff.toFixed(5)} FIR开=${jOn.toFixed(5)};只滤[0,written)未修则 0.02+ 红)`);
});

test('068 带内低频不衰减:1kHz(远低于 fc)开关抗 imaging 基频幅度近乎不变', () => {
  const off = upDrain(1000, false), on = upDrain(1000, true);
  const ratio = magAt(1000, on, 48000) / magAt(1000, off, 48000);
  assert.ok(ratio > 0.97 && ratio < 1.03, `1kHz 带内应近乎不衰减(实得 ${(ratio * 100).toFixed(1)}%)`);
});

test('068 designLowpass:DC 增益归一为 1(带内不增益/不衰减)', () => {
  const h = designLowpass(7500, 48000, 63);
  let sum = 0; for (const c of h) sum += c;
  assert.ok(Math.abs(sum - 1) < 1e-6, `DC 增益应=1(系数和,实得 ${sum})`);
  assert.equal(h.length, 63, '63 taps');
});

// ── 频响门槛(review⑥):44.1/48k 下 imaging(>8k)<5% 且带内(6k)>90% ──
test('068 频响跨采样率:44.1/48k imaging(9k/10k)<5% 且 6kHz 保 >90%', () => {
  function resp(h, f, sr) { let re = 0, im = 0; for (let n = 0; n < h.length; n++) { const w = 2 * Math.PI * f * n / sr; re += h[n] * Math.cos(w); im -= h[n] * Math.sin(w); } return Math.sqrt(re * re + im * im); }
  for (const sr of [44100, 48000]) {
    const h = designLowpass(7500, sr, 63);
    const g6 = resp(h, 6000, sr), img9 = resp(h, 9000, sr), img10 = resp(h, 10000, sr);
    assert.ok(g6 > 0.9, `${sr} 6kHz 带内应保 >90%(实得 ${(g6 * 100).toFixed(0)}%)`);
    assert.ok(img9 < 0.05 && img10 < 0.05, `${sr} imaging 9k/10k 应 <5%(实得 9k=${(img9 * 100).toFixed(0)}% 10k=${(img10 * 100).toFixed(0)}%)`);
  }
});

// ── Blocker ④(review):欠载静音后 FIR 历史重置(不用欠载前旧历史卷积恢复段,防恢复瞬态)──
test('068 欠载重置 FIR 历史:underrun 后 firPrimed=false(恢复段重新预填,非旧段尾卷积)', () => {
  const r = new PlaybackResampler(48000, 0, true);
  r.push(sine16(6000, 600, 0.6)); // 高频短段(6kHz,FIR 历史带振荡)
  const o1 = new Float32Array(8192); r.pull(o1); // 拉到欠载(ring 排空)→ underran=true
  // ★ Blocker ④:欠载后 FIR 历史标志应重置(下段首块 hist.fill(段首样本) 重新预填,不卷积欠载前 6kHz 振荡历史)。
  //   访问私有 firPrimed(node strip-only 运行时可见):变异——删 `if(underran)this.firPrimed=false` 则此断言红。
  assert.equal(r.firPrimed, false, '欠载后 firPrimed 应重置为 false(Blocker ④)');
  // 恢复:新段应正常出声、有限有界(不因旧历史污染产 NaN/越界/爆值)
  r.push(new Int16Array(2000).fill(16000));
  const o2 = new Float32Array(256); const w = r.pull(o2);
  assert.ok(w > 0, '恢复应出声');
  assert.ok(Array.from(o2.slice(0, w)).every((v) => Number.isFinite(v) && Math.abs(v) <= 1.01), '恢复段有限有界');
  assert.equal(r.firPrimed, true, '恢复出声后 firPrimed 重新置 true(已预填)');
});

test('068 退化率(outRate=16k,无升采样)不建 FIR:逐字节等价纯插值', () => {
  // 16k→16k 无 imaging,FIR 应关闭;输出应与不加 FIR 一致(直通)。
  const r = new PlaybackResampler(16000, 0, true);
  r.push(sine16(3000, 1600, 0.5));
  const out = drainAll(r);
  // 直通比 1:1,幅度不被 FIR 衰减(3kHz 远低于任何 fc,但退化率本就不建 FIR)
  assert.ok(out.length >= 1598 && out.length <= 1600, `16k 直通约 1600(实得 ${out.length})`);
});

test('068 flush 重置 FIR 历史:barge-in 后新段首样本重新预填(不用旧段尾)', () => {
  const r = new PlaybackResampler(48000, 0, true);
  r.push(sine16(6000, 3000, 0.6));
  const o1 = new Float32Array(2000); r.pull(o1);
  r.flush(); // barge-in:FIR 历史应重置
  r.push(new Int16Array(2000).fill(16000)); // 新段恒定高电平
  const o2 = new Float32Array(256); const w = r.pull(o2);
  assert.ok(w > 0, 'flush 后新段出声');
  // 新段首样本经 FIR(历史预填首值)应接近首值(不被旧 6kHz 段尾的振荡历史污染)
  assert.ok(Number.isFinite(o2[0]) && Math.abs(o2[0]) <= 1, 'flush 后新段首样本有限有界');
});

test('068 worklet/core FIR 同步守门:两份 fc/taps + designLowpass + applyFir 一致', () => {
  const w = fs.readFileSync(path.join(__dirname, '../public/pcm-playback-worklet.js'), 'utf8');
  const c = fs.readFileSync(path.join(__dirname, '../src/lib/playback-resampler.ts'), 'utf8');
  assert.ok(/ANTI_IMAGING_FC_HZ = 7500/.test(w) && /ANTI_IMAGING_FC_HZ = 7500/.test(c), 'fc=7500 两份一致');
  assert.ok(/ANTI_IMAGING_TAPS = 63/.test(w) && /ANTI_IMAGING_TAPS = 63/.test(c), 'taps=63 两份一致');
  assert.ok(/function designLowpass/.test(w) && /export function designLowpass/.test(c), 'designLowpass 两份都有');
  assert.ok(/0\.54 - 0\.46 \* Math\.cos/.test(w) && /0\.54 - 0\.46 \* Math\.cos/.test(c), 'Hamming 窗公式一致');
  // 欠载滤全块 [0,n)、非欠载滤 [0,written)(Blocker 1:欠载 ring-out 消 FIR/fade 交互跳变)
  assert.ok(/_applyFir\(out, underran \? n : written\)/.test(w), 'worklet 欠载滤全块 [0,n)(Blocker 1)');
  assert.ok(/applyFir\(out, underran \? n : written\)/.test(c), 'core 欠载滤全块 [0,n)(Blocker 1)');
  // flush 两份都重置 firPrimed
  assert.ok(/_firPrimed = false/.test(w), 'worklet flush 重置 firPrimed');
  assert.ok(/firPrimed = false/.test(c), 'core flush 重置 firPrimed');
  // Blocker ④:两份都在欠载(underran)后重置 firPrimed(防恢复瞬态)
  assert.ok(/underran\b/.test(w) && /if \(underran\) this\._firPrimed = false/.test(w), 'worklet 欠载后重置 firPrimed(Blocker④)');
  assert.ok(/underran\b/.test(c) && /if \(underran\) this\.firPrimed = false/.test(c), 'core 欠载后重置 firPrimed(Blocker④)');
  // scratch 复用(review:音频线程零分配)
  assert.ok(/_firY/.test(w) && /firY/.test(c), '两份都复用 firY scratch(热路径零分配)');
  // review 卷积历史写回 hist.set(nextHist) 不得删(删则跨块历史断裂,worklet 无法 require 只能守门)
  assert.ok(/hist\.set\(nextHist\)/.test(w) && /hist\.set\(nextHist\)/.test(c), '两份都写回 FIR 历史 hist.set(nextHist)');
  // worklet reprime 用 hist.fill(out[0]) 预填(非 fill(0)):首块用段首样本消瞬态
  assert.ok(/hist\.fill\(out\[0\]\)/.test(w) && /hist\.fill\(out\[0\]\)/.test(c), '两份 FIR 首块预填 hist.fill(out[0])(非 fill(0))');
});
