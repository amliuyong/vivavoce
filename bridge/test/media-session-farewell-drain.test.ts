/**
 * design contract:收尾挂断按**已下发音频时长**推算客户端播放完成再切(治跨境告别句尾音被固定 1.5s 延迟切断)。
 *
 * 配置模块级(media-session import 时读 env)→ 本文件 import 前设 env 开 drain,与默认关的 media-session.test.ts 隔离。
 *   - design contract:drain 已**无条件生效**(开关已删),无需设 env
 *   - AIM_FAREWELL_TAIL_MS=1000(网络/缓冲余量)
 *   - AIM_FAREWELL_DRAIN_MAX_MS=8000(硬上限)
 *   - AIM_FAREWELL_HANGUP_DELAY_MS=1500(drain 关/fail-safe 回退的固定延迟)
 *   - AIM_SEMANTIC_END=0(不走 LLM wantsEndCall,用 FAREWELL 正则告别兜底触发挂断,测试更好控)
 *
 * 用 jest fake timers 精确验挂断延迟(waitMs)= 按已下发音频时长推算,而非固定 1500。
 *
 * 变异测试覆盖(验证 drain 逻辑非死代码,评审 建议显式化):注释掉 media-session.ts 的
 *   `this.aiTurnAudioMs += ...` 累计 → ①② 红(推算退化回 fail-safe 固定 1500,切尾音/硬上限失效),
 *   ③④ 绿(③测 fail-safe 分支本身=无音频回退固定延迟;④测语义取消挂断,不依赖 drain 累计)。
 */
// design contract:本文件测 farewell drain 时序(挂断延迟按 aiTurnAudioMs 推算),feed 合成音频并断言延迟数值。
//   抗混叠低通改变降采样样本值(不改样本数,但本文件的合成音频经低通后值变,且 fake-timer 下多出的卷积同步
//   开销会移动异步回调相对 advanceTimersByTime 的时机)。drain 逻辑与音频质量正交 → 关低通,固定纯线性行为。
process.env.AIM_TTS_ANTIALIAS = "0";
process.env.AIM_FAREWELL_TAIL_MS = "1000";
process.env.AIM_FAREWELL_DRAIN_MAX_MS = "8000";
process.env.AIM_FAREWELL_HANGUP_DELAY_MS = "1500";
process.env.AIM_SEMANTIC_END = "0"; // 用正则告别兜底(AI 说告别词即触发挂断),不依赖 engine.wantsEndCall

import { MediaSession, WsConn } from "../src/media-session";
import {
  AudioOutCb, EngineErrorCb, EngineMetricsCb, LlmTextCb, TranscriptCb, TurnEventCb, VoiceEngine,
} from "../src/voice-engine";

class FakeEngine implements VoiceEngine {
  cancels: string[] = [];
  private audioOutCb: AudioOutCb = () => {};
  private turnCb: TurnEventCb = () => {};
  private llmTextCb: LlmTextCb = () => {};
  private aiDoneCb: () => void = () => {};
  async start() {}
  pushAudio() {}
  cancel(r: string) { this.cancels.push(r); }
  onAudioOut(cb: AudioOutCb) { this.audioOutCb = cb; }
  onTranscript(_cb: TranscriptCb) {}
  onTurnEvent(cb: TurnEventCb) { this.turnCb = cb; }
  onError(_cb: EngineErrorCb) {}
  onLlmText(cb: LlmTextCb) { this.llmTextCb = cb; }
  onAiDone(cb: () => void) { this.aiDoneCb = cb; }
  onMetrics(_cb: EngineMetricsCb) {}
  hasPendingQuestions() { return false; } // 无未问完题(不拦挂断,design contract)
  hasQuestions() { return true; } // design contract:有题语境(blockedByOpenChat 恒 false,不影响本测试的告别 drain 挂断)
  async stop() {}
  emitAudio(pcm: Buffer) { this.audioOutCb(pcm); }
  emitLlmText(text: string) { this.llmTextCb(text); } // AI 本轮文本(含告别词 → aiSaidFarewellThisTurn)
  emitAiDone() { this.aiDoneCb(); }
}

class FakeConn implements WsConn {
  sent: (string | Buffer)[] = [];
  closed = false;
  private msgCb: (d: Buffer, b: boolean) => void = () => {};
  send(d: string | Buffer) { this.sent.push(d); }
  close() { this.closed = true; }
  on(ev: "message" | "close", cb: never) { if (ev === "message") this.msgCb = cb as never; }
  rxBinary(pcm: Buffer) { this.msgCb(pcm, true); }
}

/** 24k s16le 帧(引擎出 24k,media-session 降采样到 16k):durMs 毫秒 → 24000*durMs/1000 采样。
 *  media-session 降到 16k 后按 16k 帧字节算时长,与本帧真实时长一致(降采样保时长)。amp=0 静音(仅计时长用)。 */
function audioFrame(durMs: number, amp = 0): Buffer {
  const n = Math.round(24000 * durMs / 1000);
  const b = Buffer.alloc(n * 2);
  if (amp) for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
}
/** 16k 上行帧(考生入向,20ms=320 sample);amp 决定 RMS(用于触发 cancelPendingHangup 的有效语音)。 */
function inFrame16k(amp: number): Buffer {
  const b = Buffer.alloc(320 * 2);
  for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
}

const _sessions: MediaSession[] = [];
afterEach(async () => {
  for (const s of _sessions.splice(0)) await s.detach().catch(() => undefined);
});

async function setup() {
  const engine = new FakeEngine();
  const conn = new FakeConn();
  const session = new MediaSession(
    conn,
    { sessionId: "sess_fw", systemPrompt: "你是考官", engineParams: { engineType: "three_stage", language: "zh-CN" } },
    { engine, recorder: null, transcripts: null, metrics: null },
  );
  await session.begin();
  _sessions.push(session);
  return { engine, conn, session };
}

test("① drain 开:告别轮已下发 4s 音频 → 挂断延迟按音频时长推算(远大于固定 1500),尾音不被切", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn } = await setup();
    // AI 告别轮:下发 4s 音频(首帧记 t_firstAudio,累计 aiTurnAudioMs=4000)。
    engine.emitAudio(audioFrame(4000)); // 一帧 4s(简化;真机是多帧累加,累计逻辑同)
    engine.emitLlmText("好的,感谢你参加本次口试,再见。"); // AI 说告别 → aiSaidFarewellThisTurn=true
    engine.emitAiDone(); // tts_done → onAiDone → 排挂断 timer(延迟 = 推算)
    // 推算:首帧 now、T_audio=4000 → 播完≈now+4000;waitMs = max(0,4000)+1000 余量 = 5000(< 硬上限 8000)。
    // 固定延迟 1500 时早就挂了(切尾音)。验证 5000ms 前不挂、之后才挂。
    await jest.advanceTimersByTimeAsync(1500); // 过了旧固定延迟点
    expect(conn.closed).toBe(false); // ★ drain:1.5s 还没挂(等音频播完),固定延迟会在此已挂→切尾音
    await jest.advanceTimersByTimeAsync(4000); // 累计 5500 > 5000 推算点
    expect(conn.closed).toBe(true); // 推算播完+余量后才挂,尾音完整
  } finally {
    jest.useRealTimers();
  }
});

test("② 硬上限:音频时长异常大 → 挂断延迟 clamp 到 DRAIN_MAX_MS(8s),不永久挂起", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn } = await setup();
    engine.emitAudio(audioFrame(30000)); // 异常:推算 T_audio=30s(如 tts_done 丢失/黑洞)
    engine.emitLlmText("再见。");
    engine.emitAiDone();
    // waitMs = min(30000+1000, 8000) = 8000 硬上限。
    await jest.advanceTimersByTimeAsync(7999);
    expect(conn.closed).toBe(false); // 8s 前不挂
    await jest.advanceTimersByTimeAsync(2);
    expect(conn.closed).toBe(true); // ★ 硬上限 8s 强制挂,不因推算 31s 永久挂起
  } finally {
    jest.useRealTimers();
  }
});

test("③ fail-safe:本轮无音频帧就要挂 → 回退固定 FAREWELL_HANGUP_DELAY_MS(1500)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn } = await setup();
    // 不 emitAudio(极端:一帧音频没出)→ 推算拿不到 T_audio → fail-safe 回退固定 1500。
    engine.emitLlmText("再见。");
    engine.emitAiDone();
    await jest.advanceTimersByTimeAsync(1499);
    expect(conn.closed).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    expect(conn.closed).toBe(true); // 固定 1500 挂(fail-safe,不因无音频推算失败乱挂/不挂)
  } finally {
    jest.useRealTimers();
  }
});

test("⑤ 跨轮残留 fail-safe:上一轮有音频→本轮告别轮无音频 → 回退固定延迟(不拿上一轮过时数据,review)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn } = await setup();
    // 上一轮:出过 4s 音频,正常结束(onAiDone → markAiDonePlaying 应清 aiTurn 统计)
    engine.emitAudio(audioFrame(4000));
    engine.emitLlmText("好的,这道题答得不错,我们继续。"); // 非告别 → 不挂
    engine.emitAiDone(); // markAiDonePlaying:aiSpeaking=false + 清 aiTurnAudioMs(修复点)
    await jest.advanceTimersByTimeAsync(100);
    expect(conn.closed).toBe(false); // 非告别轮不挂
    // 告别轮:**不出音频**(极端:TTS 空/失败),直接 onAiDone。若 markAiDonePlaying 没清统计,
    //   aiTurnAudioMs 残留上一轮 4000 → computeFarewellDelayMs 不走 fail-safe、拿过时 first(很早)推算。
    engine.emitLlmText("再见。"); // 告别 → 应挂
    engine.emitAiDone();
    // 修复后:本轮无音频 → aiTurnAudioMs=0(已清)→ fail-safe 回退固定 1500。
    await jest.advanceTimersByTimeAsync(1499);
    expect(conn.closed).toBe(false); // 固定 1500 前不挂
    await jest.advanceTimersByTimeAsync(2);
    expect(conn.closed).toBe(true); // ★ 回退固定 1500 挂(不因上一轮残留数据算错延迟)
  } finally {
    jest.useRealTimers();
  }
});

test("④ 等待窗内考生又开口 → 取消挂断(spec 语义保留,drain 下同样生效)", async () => {
  jest.useFakeTimers();
  try {
    const { engine, conn } = await setup();
    engine.emitAudio(audioFrame(4000));
    engine.emitLlmText("好的,再见。");
    engine.emitAiDone(); // 排挂断 timer(waitMs≈5000)
    await jest.advanceTimersByTimeAsync(1000);
    // 考生在等待窗内又开口(高能量入向语音 RMS≈2000 > 端点阈 500)→ cancelPendingHangup 取消挂断
    for (let i = 0; i < 30; i++) conn.rxBinary(inFrame16k(2000)); // 持续有效入向语音
    await jest.advanceTimersByTimeAsync(6000); // 远超推算点
    expect(conn.closed).toBe(false); // ★ 考生改主意继续 → 不挂
  } finally {
    jest.useRealTimers();
  }
});
