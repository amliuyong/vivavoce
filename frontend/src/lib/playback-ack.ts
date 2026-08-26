/**
 * 客户端播放 ACK 追踪器(design contract/R3,单 worklet ring 版)——与 DOM/AudioWorklet 解耦,便于 node --test。
 *
 * 职责(薄适配层,重逻辑在 worklet 段账本 playback-resampler.ts):
 *  1. **capability 协商**:auth 声明 `playback_ack_v1`,仅当服务端 ready 回显该 capability 才启用(negotiate)。
 *     未协商 = inert,不打轮边界、不发 ACK(逐字节等价 design contract 现状)。
 *  2. **轮边界下发 worklet**:收 `ai_audio_start(id)`→worklet `begin_turn`;`ai_audio_end(id)`→worklet `end_turn`。
 *  3. **ACK 上行**:worklet 回 `turn_played`→WS `playback_complete`;`turn_aborted`→WS `playback_aborted(reason)`。
 *  4. **单调终态 + 去重(R3)**:每个 (generation, ai_turn_id) 至多上行一次 terminal ACK(worklet 已单发,此处双保险)。
 *  5. **abort reason 归属**:flush 由主线程发起(barge_in/ended/teardown/superseded/session_end),reason 主线程知;
 *     worklet 不知 → flushWithReason 记 pendingReason,turn_aborted 到达时取用。
 *
 * ★ Phase 2 单独上线安全:服务端 Phase 4 前不回显 capability → negotiate 判 false → 全程 inert,
 *   auth 多带的 capabilities 字段服务端忽略未知字段(design contract 兼容),逐字节等价现状。
 */

// 上行 ACK 帧(经 WS text 发服务端)
export type PlaybackAckFrame =
  | { type: 'playback_complete'; ai_turn_id: number }
  | { type: 'playback_aborted'; ai_turn_id: number; reason: string };

// worklet → 主线程回执(与 playback-resampler.ts PlaybackEvent 对齐)
export type WorkletPlaybackEvent =
  | { type: 'turn_played'; generation: number; seq: number; positionMs: number }
  | { type: 'turn_aborted'; generation: number; seq: number; positionMs: number };

// 发给 worklet 的轮边界消息
export type WorkletTurnMsg =
  | { type: 'begin_turn'; seq: number }
  | { type: 'end_turn'; seq: number };

// design contract abort reason 枚举
export type PlaybackAbortReason =
  | 'barge_in'
  | 'user_transcript'
  | 'session_end'
  | 'superseded'
  | 'client_teardown'
  | 'playback_error';

export const PLAYBACK_ACK_CAPABILITY = 'playback_ack_v1';

/** 从 ready 帧的 capabilities 字段(任意类型)判断服务端是否启用了 playback_ack_v1(fail-soft:非数组→false)。 */
export function negotiatedAck(readyCapabilities: unknown): boolean {
  return Array.isArray(readyCapabilities) && readyCapabilities.includes(PLAYBACK_ACK_CAPABILITY);
}

export class PlaybackAckTracker {
  private enabled = false;
  private pendingReason: PlaybackAbortReason = 'barge_in'; // flushWithReason 更新;turn_aborted 到达取用
  private readonly acked = new Set<string>();               // `${generation}:${seq}` 已上行 terminal 的键(去重)
  private readonly sendUplink: (frame: PlaybackAckFrame) => void;
  private readonly postWorklet: (msg: WorkletTurnMsg) => void;

  /** @param sendUplink 发 WS text 上行(JSON.stringify 在此层做,调用方给原始 send)
   *  @param postWorklet 给播放 worklet postMessage(轮边界消息) */
  constructor(
    sendUplink: (frame: PlaybackAckFrame) => void,
    postWorklet: (msg: WorkletTurnMsg) => void,
  ) {
    this.sendUplink = sendUplink;
    this.postWorklet = postWorklet;
  }

  /** ready 到达:按 capabilities 决定是否启用。返回是否启用(供调用方记日志)。 */
  negotiate(readyCapabilities: unknown): boolean {
    this.enabled = negotiatedAck(readyCapabilities);
    return this.enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 收下行 ai_audio_start:令 worklet 开该轮段(未启用则忽略)。 */
  onAudioStart(aiTurnId: number): void {
    if (!this.enabled || !Number.isInteger(aiTurnId) || aiTurnId < 0) return;
    this.postWorklet({ type: 'begin_turn', seq: aiTurnId });
  }

  /** 收下行 ai_audio_end:令 worklet 封口该轮(未启用则忽略)。 */
  onAudioEnd(aiTurnId: number): void {
    if (!this.enabled || !Number.isInteger(aiTurnId) || aiTurnId < 0) return;
    this.postWorklet({ type: 'end_turn', seq: aiTurnId });
  }

  /** 主线程发起停播前调用,记录本次打断原因(供随后 worklet turn_aborted 归属 reason)。 */
  flushWithReason(reason: PlaybackAbortReason): void {
    this.pendingReason = reason;
  }

  /** worklet 回执 → 上行 terminal ACK(去重:每 (generation,seq) 至多一次)。未启用则忽略。 */
  onWorkletEvent(e: WorkletPlaybackEvent): void {
    if (!this.enabled || !e || typeof e.seq !== 'number') return;
    const key = `${e.generation}:${e.seq}`;
    if (this.acked.has(key)) return; // 去重(worklet 已单发,此处双保险防重复上行)
    if (e.type === 'turn_played') {
      this.acked.add(key);
      this.sendUplink({ type: 'playback_complete', ai_turn_id: e.seq });
    } else if (e.type === 'turn_aborted') {
      this.acked.add(key);
      this.sendUplink({ type: 'playback_aborted', ai_turn_id: e.seq, reason: this.pendingReason });
    }
  }

  /** 连接重置(重连/teardown):清去重表 + 复位(新连接 ai_turn_id 从头,旧连接 ACK 不影响新连接,R2)。 */
  reset(): void {
    this.acked.clear();
    this.enabled = false;
    this.pendingReason = 'barge_in';
  }
}
