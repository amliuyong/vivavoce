// design contract:transcript 分支**不得** stopPlayback(防回归到"下一句冲掉上一句")。
//
// 历史:design contract 曾在 user final transcript 到达时 stopPlayback(防"服务端以为播完、客户端旧音频还在播"
// 的时差窗打断残留)。**该逻辑与 design contract ring 架构根本冲突**:旧架构 nextPlayTime 只排"有限已排程音频"且
// 假设"收到 user final 时新回复尚未产生";新架构 ring **缓冲整段 AI 回复的多句**(跨境下发快于播放)。全双工下
// ASR 把 AI 回声/用户环境噪声识别成 final → stopPlayback flush → **清掉 ring 里还没播的后续句 = "下一句冲掉
// 上一句"**(真机实证:圣诞节长回复句句互冲)。
//
// R5 根除:删除 transcript 分支的 stopPlayback。清旧音频只由**真打断**触发(本地 detectBargeIn / 服务端
// barge_in 下行,均走 stopPlayback);user transcript 到达不再销毁性 flush(与 design contract 误打断恢复精神一致)。
//
// Web Audio 副作用 node --test 无法真跑,沿用本仓源码守门模式(见 exam-waveform-tap.test.js)。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../src/views/Exam.tsx'), 'utf8');

// 抽出 transcript 分支体(从 `m.type === 'transcript'` 到下一个 else if)供精确断言。
// **剥掉注释行**(// 开头)后再匹配 —— 注释里会提到 stopPlayback 这个词(解释为何删),不该被当作调用。
function transcriptBranch() {
  const start = src.indexOf("m.type === 'transcript'");
  assert.ok(start > 0, '必须有 transcript 分支');
  const rest = src.slice(start);
  const end = rest.indexOf('} else if');
  const raw = rest.slice(0, end > 0 ? end : 2000);
  // 去掉纯注释行(行首可有空白 + //),只留实际代码,避免注释里的 "stopPlayback" 字样误判。
  return raw
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

test('R5 防回归:transcript 分支不得调 stopPlayback(否则 ring 缓冲的后续句被误清=下一句冲上一句)', () => {
  const branch = transcriptBranch(); // 已剥注释
  assert.ok(
    !/stopPlayback\s*\(/.test(branch),
    'transcript 分支不得调 stopPlayback() —— ring 架构下会清掉缓冲的 AI 后续句(真机"下一句冲掉上一句")。' +
      '清旧音频只应由真打断(detectBargeIn / 服务端 barge_in)触发。',
  );
});

test('R5 打断链路仍在:barge_in case 下行仍 stopPlayback(真打断清旧音频不受影响)', () => {
  // 服务端 barge_in 下行帧 → stopPlayback(即时停声闭环)。这是删 transcript flush 后清旧音频的正道之一。
  const bargeStart = src.indexOf("m.type === 'barge_in'");
  assert.ok(bargeStart > 0, '必须有 barge_in 分支');
  const bargeBranch = src.slice(bargeStart, bargeStart + 400); // 400:design contract 加了 flushWithReason 前置行
  assert.ok(/stopPlayback\(true\)/.test(bargeBranch), 'barge_in 下行仍须 confirmed stopPlayback(真打断清旧音频)');
});

test('R5 本地打断仍在:detectBargeIn 确认后 stopPlayback(零往返即时停声)', () => {
  // 本地 detectBargeIn 连续高能量达确认 → stopPlayback + 发 barge_in。删 transcript flush 不影响这条。
  const detectStart = src.indexOf('function detectBargeIn');
  const detectEnd = src.indexOf('function ensureAudio');
  const detectBody = src.slice(detectStart, detectEnd > detectStart ? detectEnd : detectStart + 2000);
  assert.ok(/stopPlayback\(true\)/.test(detectBody), 'detectBargeIn 确认打断后须 confirmed stopPlayback(本地即时停声)');
});
