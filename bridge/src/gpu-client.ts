/**
 * GPU WS 客户端(design contract 协议)。封装与 GPU ASR/TTS 服务的单条 WS:
 *   上行:start / audio_meta(+PCM) / input_reset / tts_text / cancel / flush / end
 *   下行:ready / asr_partial / asr_final / turn_end / tts_audio_meta(+PCM) / tts_metrics /
 *          tts_done / cancel_ack / input_reset_ack / error / bye
 * framing:meta text 帧 + 紧跟 binary 帧、同 seq。LLM token 不经此 WS。
 *
 * socket 抽象成 WsLike 便于单测(无需真实网络)。
 */

import { VOICE_INPUT_PENDING_LIMIT_ERROR } from "./voice-engine";

// ready 前音频入队上限(约 10s @ 50 帧/s):防 GPU 迟 ready 时无界堆积 OOM(review)。
const MAX_QUEUED_AUDIO_FRAMES = 500;

export class GpuQueuedAudioLimitError extends Error {
  readonly code = VOICE_INPUT_PENDING_LIMIT_ERROR;

  constructor(readonly limitBytes: number) {
    super(`GPU pending input exceeds ${limitBytes} bytes`);
    this.name = "GpuQueuedAudioLimitError";
  }
}

export interface WsLike {
  send(data: string | Buffer): void;
  close(): void;
  on(event: "message", cb: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "open", cb: () => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export interface GpuControl {
  type: string;
  session_id?: string;
  seq?: number;
  ts?: number;
  ttsIdentity?: GpuTtsSegmentIdentity;
  [k: string]: unknown;
}

export interface GpuTtsSegmentIdentity {
  responseGeneration: number;
  turnSeq: number;
  segmentId: number;
}

type ControlHandler = (msg: GpuControl) => void;
type AudioHandler = (meta: GpuControl, pcm: Buffer) => void;
type ConnErrHandler = (code: string, message: string) => void;
interface QueuedAudio {
  pcm: Buffer;
  inputEpoch: number;
  sourceBytes: number;
}
interface PendingInputReset {
  fromEpoch: number;
  nextEpoch: number;
  timeoutMs: number;
  sent: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}
interface PendingTtsSegment {
  cancelEpoch: number;
  identity?: GpuTtsSegmentIdentity;
}

/** 握手期 CAPACITY_FULL 退避重连配置(design contract;D-2)。不传 = 不重连(行为不变)。 */
export interface ReconnectConfig {
  /** 重建一条 GPU WS(换实例):返回新的 WsLike。 */
  connect: () => WsLike;
  /** 最大重连次数(超过则上报 connErr 拆机)。默认 4。 */
  maxAttempts?: number;
  /** 退避基数 ms(第 n 次 sleep = base * 2^(n-1) + jitter)。默认 500。 */
  baseDelayMs?: number;
  /** 注入 sleep(单测用,免真等)。默认真 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /** 注入 jitter [0,1)(单测用确定性)。默认 Math.random()。 */
  jitter?: () => number;
}

export class GpuClient {
  private seq = 0;
  private pendingMeta: GpuControl | null = null;
  private controlCb: ControlHandler = () => {};
  private audioCb: AudioHandler = () => {};
  private connErrCb: ConnErrHandler = () => {};
  private closed = false;
  // ── ready 握手门(design contract)──
  // GPU 收 start 后回 ready 才真正建好会话;在 ready 之前推音频,GPU 会以「未 start」拒绝(且若此连接
  // 会被 CAPACITY_FULL 拒,音频也是白发)。故 ready 前的 sendAudio **入队**,ready 到达后按序冲刷;
  // 之后直发。握手超时(默认 5s 未见 ready/error)→ 上报连接级错误,交上层退避换实例重连。
  private ready = false;
  private audioQueue: QueuedAudio[] = [];
  private queuedAudioBytes = 0;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingInputReset: PendingInputReset | null = null;
  // Synced only from the GPU's ordered turn_end/reset ACK stream. An explicit
  // commit may use this fence before the adapter has seen its first ASR event;
  // a server-VAD turn that already ended makes the fence stale and therefore
  // harmless instead of letting an unqualified flush close the next turn.
  private currentInputEpoch = 0;
  private currentInputTurnId = 0;
  // New GPU versions echo segment identity on the wire. The FIFO remains only
  // as a compatibility fallback for older GPU deployments.
  private ttsCancelEpoch = 0;
  private pendingTtsSegments: PendingTtsSegment[] = [];
  // D-2:握手期 CAPACITY_FULL 退避重连状态。startParams 保存以便重连时重发 start;reconnecting 防重入。
  private reconnect: ReconnectConfig | null = null;
  private startParams: Record<string, unknown> | null = null;
  private reconnectAttempts = 0;
  private reconnecting = false;

  constructor(
    private ws: WsLike,
    private sessionId: string,
    private handshakeTimeoutMs = 5000,
    private readonly maxQueuedAudioBytes?: number,
  ) {
    this.bindWs(this.ws);
  }

  /** 绑定一条 ws 的事件(构造 + 重连换 ws 时都用)。
   *  ws 身份守卫(review):闭包捕获本次绑定的 `ws`,每个 handler 先比对 `ws === this.ws`。
   *  重连换实例后,旧 socket 的迟到帧(delayed ready/tts_audio/CAPACITY_FULL)/迟到 close/error 都会
   *  因 `ws !== this.ws` 被丢弃 —— 否则旧连接会污染新连接(误置 ready、投递陈旧 TTS、或迟到 close 误报拆机)。 */
  private bindWs(ws: WsLike): void {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (ws !== this.ws) return; // 重连后旧连接的迟到帧:丢弃(防污染新连接)
      this.onMessage(data, isBinary);
    });
    // N2:真实 GPU 连接拒绝/断开/TTS 中途断流必须上报,否则 MediaSession 收不到 engine.onError →
    // 电话挂着但 AI 永远没声(静默死)。WS error / 非正常 close 都转成连接级错误。
    ws.on("error", (err: Error) => {
      if (this.closed || this.reconnecting || ws !== this.ws) return; // 收尾/重连中/旧实例的 error 忽略
      this.failInputReset(new Error(`GPU WS error during input reset: ${String(err?.message ?? err)}`));
      this.connErrCb("GPU_WS_ERROR", String(err?.message ?? err));
    });
    ws.on("close", () => {
      if (this.closed || this.reconnecting || ws !== this.ws) return; // 主动 end()/重连关的旧 ws 不算错误
      this.failInputReset(new Error("GPU WS closed during input reset"));
      this.connErrCb("GPU_WS_CLOSED", "GPU WS 意外断开");
    });
  }

  /** 启用握手期 CAPACITY_FULL 退避重连(D-2;design contract)。engine-factory 注入。 */
  enableReconnect(cfg: ReconnectConfig): void {
    this.reconnect = cfg;
  }

  onControl(cb: ControlHandler): void {
    this.controlCb = cb;
  }
  onAudio(cb: AudioHandler): void {
    this.audioCb = cb;
  }
  /** GPU 连接级错误(WS error / 意外 close);区别于 GPU 下行的 error 控制帧(那个走 onControl)。 */
  onConnError(cb: ConnErrHandler): void {
    this.connErrCb = cb;
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  private sendControl(msg: GpuControl): void {
    this.ws.send(JSON.stringify({ session_id: this.sessionId, ...msg }));
  }

  start(params: Record<string, unknown>): void {
    this.startParams = params; // D-2:保存以便 CAPACITY_FULL 重连时重发 start
    this.currentInputEpoch = 0;
    this.currentInputTurnId = 0;
    this.sendControl({ type: "start", ...params });
    this.armHandshakeWatchdog(false);
  }

  /** 上行一帧入向音频:meta text 帧 + 紧跟 binary,同 seq。ready/reset fence 前入队,之后冲刷+直发。 */
  sendAudio(pcm: Buffer, inputEpoch = 0, sourceBytes = pcm.length): void {
    if (!Number.isInteger(inputEpoch) || inputEpoch < 0) {
      throw new RangeError("inputEpoch must be a non-negative integer");
    }
    if (!Number.isInteger(sourceBytes) || sourceBytes < 0) {
      throw new RangeError("sourceBytes must be a non-negative integer");
    }
    if (!this.ready || this.pendingInputReset) {
      // 队列保险丝(review):ready 迟迟不来(GPU 黑洞且握手超时机制万一失效)时,
      // 电话持续送 16k PCM(50 帧/s)会无界堆积致 OOM。封顶 MAX_QUEUED_AUDIO_FRAMES(约 10s 音频),
      // 超出 FIFO 丢最老帧(保连接;真黑洞由 5s 握手超时兜底报错)—— 丢的是 ready 前的旧音频,无损当前轮。
      this.queueAudio(pcm, inputEpoch, sourceBytes);
      return;
    }
    this.emitAudio(pcm, inputEpoch);
  }

  private queueAudio(
    pcm: Buffer,
    inputEpoch: number,
    sourceBytes: number,
  ): void {
    if (
      this.maxQueuedAudioBytes !== undefined &&
      this.queuedAudioBytes + sourceBytes > this.maxQueuedAudioBytes
    ) {
      throw new GpuQueuedAudioLimitError(this.maxQueuedAudioBytes);
    }
    if (
      this.maxQueuedAudioBytes === undefined &&
      this.audioQueue.length >= MAX_QUEUED_AUDIO_FRAMES
    ) {
      const dropped = this.audioQueue.shift();
      if (dropped) this.queuedAudioBytes -= dropped.sourceBytes;
    }
    this.audioQueue.push({ pcm, inputEpoch, sourceBytes });
    this.queuedAudioBytes += sourceBytes;
  }

  private emitAudio(pcm: Buffer, inputEpoch: number): void {
    const seq = this.nextSeq();
    this.sendControl({ type: "audio_meta", seq, bytes: pcm.length, input_epoch: inputEpoch });
    this.ws.send(pcm);
  }

  private flushAudioQueue(): void {
    if (!this.ready || this.pendingInputReset) return;
    const queuedAudio = this.audioQueue.splice(0);
    this.queuedAudioBytes = 0;
    for (const queued of queuedAudio) {
      this.emitAudio(queued.pcm, queued.inputEpoch);
    }
  }

  resetInput(fromInputEpoch: number, nextInputEpoch: number, timeoutMs = 2_000): Promise<void> {
    if (
      !Number.isInteger(fromInputEpoch) ||
      fromInputEpoch < 0 ||
      nextInputEpoch !== fromInputEpoch + 1
    ) {
      return Promise.reject(new RangeError("input reset must advance one non-negative epoch"));
    }
    if (this.pendingInputReset) {
      return Promise.reject(new Error("an input reset is already pending"));
    }

    // Audio queued before the GPU ready fence has not reached ASR yet. A clear
    // must retire it just like audio already resident in the GPU input buffer.
    this.audioQueue = this.audioQueue.filter(
      (queued) => queued.inputEpoch !== fromInputEpoch,
    );
    this.queuedAudioBytes = this.audioQueue.reduce(
      (total, queued) => total + queued.sourceBytes,
      0,
    );

    return new Promise<void>((resolve, reject) => {
      const pending: PendingInputReset = {
        fromEpoch: fromInputEpoch,
        nextEpoch: nextInputEpoch,
        timeoutMs,
        sent: false,
        resolve,
        reject,
        timer: null,
      };
      this.pendingInputReset = pending;
      this.sendPendingInputReset();
    });
  }

  /** ready 是 reset 的发送栅栏；ACK timeout 只计 GPU 真正收到 reset 后的处理时间。 */
  private sendPendingInputReset(): void {
    const pending = this.pendingInputReset;
    if (!this.ready || !pending || pending.sent) return;
    try {
      this.sendControl({
        type: "input_reset",
        from_input_epoch: pending.fromEpoch,
        next_input_epoch: pending.nextEpoch,
      });
      pending.sent = true;
      if (pending.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pendingInputReset !== pending) return;
          this.failInputReset(
            new Error(`input reset ack timeout for epoch ${pending.nextEpoch}`),
          );
        }, pending.timeoutMs);
        pending.timer.unref?.();
      }
    } catch (error) {
      this.failInputReset(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** 下发一句待合成文本(来自 Bedrock LLM 分句)。 */
  sendTtsText(text: string, identity?: GpuTtsSegmentIdentity): void {
    const pending: PendingTtsSegment = {
      cancelEpoch: this.ttsCancelEpoch,
      identity: identity
        ? {
            responseGeneration: identity.responseGeneration,
            turnSeq: identity.turnSeq,
            segmentId: identity.segmentId,
          }
        : undefined,
    };
    this.pendingTtsSegments.push(pending);
    try {
      this.sendControl({
        type: "tts_text",
        seq: this.nextSeq(),
        text,
        ...(identity
          ? {
              ai_turn_id: identity.turnSeq,
              segment_id: identity.segmentId,
            }
          : {}),
      });
    } catch (error) {
      const index = this.pendingTtsSegments.lastIndexOf(pending);
      if (index >= 0) this.pendingTtsSegments.splice(index, 1);
      throw error;
    }
  }

  cancel(reason: string): void {
    this.ttsCancelEpoch += 1;
    this.sendControl({ type: "cancel", reason });
  }

  /** 主动结束当前一轮。带 identity 时 GPU 只 finalize matching turn，
   *  迟到旧 commit 幂等忽略，不能误封已经开始的下一轮。 */
  flush(identity?: { inputEpoch: number; inputTurnId: number }): void {
    if (
      identity &&
      (!Number.isInteger(identity.inputEpoch) ||
        identity.inputEpoch < 0 ||
        !Number.isInteger(identity.inputTurnId) ||
        identity.inputTurnId < 0)
    ) {
      throw new RangeError("input identity must contain non-negative integers");
    }
    this.sendControl(
      identity
        ? {
            type: "flush",
            input_epoch: identity.inputEpoch,
            input_turn_id: identity.inputTurnId,
          }
        : { type: "flush" },
    );
  }

  flushCurrentInput(inputEpoch: number): void {
    if (!Number.isInteger(inputEpoch) || inputEpoch < 0) {
      throw new RangeError("inputEpoch must be a non-negative integer");
    }
    if (inputEpoch !== this.currentInputEpoch) {
      throw new Error(
        `stale input epoch ${inputEpoch}; GPU client is at ${this.currentInputEpoch}`,
      );
    }
    this.flush({
      inputEpoch: this.currentInputEpoch,
      inputTurnId: this.currentInputTurnId,
    });
  }

  end(): void {
    this.closed = true; // 主动收尾:此后的 close 事件不再当作错误上报
    this.failInputReset(new Error("GPU client ended during input reset"));
    this.pendingTtsSegments = [];
    this.audioQueue = [];
    this.queuedAudioBytes = 0;
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.sendControl({ type: "end" });
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      if (this.pendingMeta && this.pendingMeta.type === "tts_audio_meta") {
        const meta = this.pendingMeta;
        this.pendingMeta = null;
        this.audioCb(meta, data);
      }
      // 没有前置 tts_audio_meta 的 binary:协议违例,忽略(服务侧不应发生)
      return;
    }
    // #7:坏 JSON 不能让 JSON.parse 抛出冒泡成 unhandledRejection 崩进程
    let msg: GpuControl;
    try {
      msg = JSON.parse(data.toString("utf-8")) as GpuControl;
    } catch {
      console.error("[gpu-client] 丢弃无法解析的下行控制帧");
      return;
    }
    if (msg.type === "tts_audio_meta") {
      const identity =
        this.ttsIdentityFromWire(msg) ?? this.pendingTtsSegments[0]?.identity;
      this.pendingMeta = identity ? { ...msg, ttsIdentity: identity } : msg;
      return;
    }
    if (msg.type === "ready") {
      // reset 必须先于新 epoch 音频跨过 ready fence；有 pending 时等 matching ACK 再冲刷。
      this.ready = true;
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.sendPendingInputReset();
      this.flushAudioQueue();
    } else if (msg.type === "error" || msg.type === "bye") {
      // 握手期收到 error(如 CAPACITY_FULL / MODEL_NOT_READY)或 bye:停看门狗(error 走 controlCb,
      // 由 ThreeStageEngine 据 code 决定上报/重试);丢弃尚未发出的排队音频(连接已废)。
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      // D-2:握手期 CAPACITY_FULL(GPU 满/冷启动/缩容窗)+ 启用了重连 → 退避重连换实例,不立即上报拆机。
      // 仅 ready 前(!this.ready)、仅 CAPACITY_FULL(容量类,重连有意义;MODEL_NOT_READY 等不重连)。
      if (!this.ready && msg.code === "CAPACITY_FULL" && this.reconnect) {
        // review:重连在途时又来一个 CAPACITY_FULL(旧连接迟到帧 / 新连接握手又被拒)→ **吞掉**,
        // 绝不落到下面 controlCb(msg) 拆机(那会中途打断正在进行的退避重连)。耗尽只由 tryReconnect 判。
        if (this.reconnecting) return;
        console.log(`[gpu-client] ${this.sessionId}: 握手期 CAPACITY_FULL,启动退避重连`);
        void this.tryReconnect();
        return; // 不 controlCb 上报(重连接管);重连耗尽才在 tryReconnect 里上报
      }
      this.audioQueue = [];
      this.queuedAudioBytes = 0;
      this.failInputReset(
        new Error(`GPU ${msg.type} during input reset: ${String(msg.code ?? "connection_closed")}`),
      );
    }
    if (msg.type === "input_reset_ack") {
      const pending = this.pendingInputReset;
      if (pending?.sent && msg.input_epoch === pending.nextEpoch) {
        this.pendingInputReset = null;
        this.currentInputEpoch = pending.nextEpoch;
        this.currentInputTurnId = 0;
        if (pending.timer) clearTimeout(pending.timer);
        this.flushAudioQueue();
        pending.resolve();
      }
    }
    if (
      msg.type === "turn_end" &&
      msg.input_epoch === this.currentInputEpoch &&
      msg.input_turn_id === this.currentInputTurnId
    ) {
      this.currentInputTurnId += 1;
    }
    if (msg.type === "tts_done") {
      const wireIdentity = this.ttsIdentityFromWire(msg);
      let pending: PendingTtsSegment | undefined;
      if (wireIdentity) {
        // A wire-qualified completion retires only its matching entry. In
        // particular, a stale completion arriving after cancel_ack must not
        // consume the next generation's FIFO head.
        const index = this.pendingTtsSegments.findIndex(
          (candidate) =>
            candidate.identity?.responseGeneration === wireIdentity.responseGeneration &&
            candidate.identity.turnSeq === wireIdentity.turnSeq &&
            candidate.identity.segmentId === wireIdentity.segmentId,
        );
        if (index >= 0) {
          [pending] = this.pendingTtsSegments.splice(index, 1);
        }
      } else {
        // Legacy GPU deployments do not echo identity. Their strictly ordered
        // stream retains the original FIFO association.
        pending = this.pendingTtsSegments.shift();
      }
      const identity = wireIdentity ?? pending?.identity;
      if (identity) msg = { ...msg, ttsIdentity: identity };
    } else if (msg.type === "tts_metrics") {
      const identity =
        this.ttsIdentityFromWire(msg) ?? this.pendingTtsSegments[0]?.identity;
      if (identity) msg = { ...msg, ttsIdentity: identity };
    } else if (msg.type === "cancel_ack") {
      this.pendingTtsSegments = this.pendingTtsSegments.filter(
        (pending) => pending.cancelEpoch >= this.ttsCancelEpoch,
      );
    }
    this.controlCb(msg);
  }

  private ttsIdentityFromWire(
    msg: GpuControl,
  ): GpuTtsSegmentIdentity | undefined {
    if (
      !Number.isInteger(msg.ai_turn_id) ||
      Number(msg.ai_turn_id) < 0 ||
      !Number.isInteger(msg.segment_id) ||
      Number(msg.segment_id) < 0
    ) {
      return undefined;
    }
    const turnSeq = Number(msg.ai_turn_id);
    return {
      responseGeneration: turnSeq,
      turnSeq,
      segmentId: Number(msg.segment_id),
    };
  }

  private failInputReset(error: Error): void {
    const pending = this.pendingInputReset;
    if (!pending) return;
    this.pendingInputReset = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
  }

  private armHandshakeWatchdog(afterReconnect: boolean): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.handshakeTimeoutMs <= 0) {
      this.handshakeTimer = null;
      return;
    }
    this.handshakeTimer = setTimeout(() => {
      if (this.closed || this.ready) return;
      this.handshakeTimer = null;
      const suffix = afterReconnect ? "(重连后)" : "";
      this.failInputReset(
        new Error(`GPU handshake timed out during input reset${suffix}`),
      );
      this.connErrCb(
        "GPU_HANDSHAKE_TIMEOUT",
        `GPU ${this.handshakeTimeoutMs}ms 未回 ready${suffix}`,
      );
    }, this.handshakeTimeoutMs);
    this.handshakeTimer.unref?.();
  }

  /** 握手期 CAPACITY_FULL 退避重连(D-2):jitter 退避、换实例重连重发 start;耗尽则上报 CAPACITY_FULL 拆机。 */
  private async tryReconnect(): Promise<void> {
    const cfg = this.reconnect;
    if (!cfg || this.closed) return;
    const max = cfg.maxAttempts ?? 4;
    const base = cfg.baseDelayMs ?? 500;
    const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const jitter = cfg.jitter ?? Math.random;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > max) {
      // 重连耗尽:上报 CAPACITY_FULL 让上层拆机(诚实告知满载,不无限重连)。
      console.log(`[gpu-client] ${this.sessionId}: 重连耗尽(${max} 次仍满载),上报拆机`);
      this.failInputReset(new Error(`GPU capacity reconnect exhausted during input reset`));
      this.controlCb({ type: "error", code: "CAPACITY_FULL", message: `重连 ${max} 次仍满载` });
      return;
    }
    const delay = base * Math.pow(2, this.reconnectAttempts - 1) + Math.floor(jitter() * base);
    console.log(`[gpu-client] ${this.sessionId}: 重连尝试 ${this.reconnectAttempts}/${max},退避 ${delay}ms`);
    this.reconnecting = true;
    try {
      await sleep(delay);
      if (this.closed) {
        this.reconnecting = false;
        return;
      }
      try { this.ws.close(); } catch { /* 旧连接尽力关 */ }
      // 换实例:重建 ws + 重绑事件 + 重置握手态 + 重发 start(DNS 轮询/NLB 可能落到有空位的实例)。
      this.ws = cfg.connect();
      this.ready = false;
      this.seq = 0;
      this.pendingMeta = null;
      this.currentInputEpoch = 0;
      this.currentInputTurnId = 0;
      if (!this.pendingInputReset) this.audioQueue = [];
      if (this.pendingInputReset) {
        if (this.pendingInputReset.timer) clearTimeout(this.pendingInputReset.timer);
        this.pendingInputReset.timer = null;
        this.pendingInputReset.sent = false;
      }
      this.pendingTtsSegments = [];
      this.ttsCancelEpoch = 0;
      this.bindWs(this.ws);
      this.reconnecting = false;
      console.log(`[gpu-client] ${this.sessionId}: 重连 ${this.reconnectAttempts} 已重发 start,等 ready`);
      if (this.startParams) this.sendControl({ type: "start", ...this.startParams });
      this.armHandshakeWatchdog(true);
    } catch (e) {
      this.reconnecting = false;
      this.failInputReset(
        new Error(`GPU reconnect failed during input reset: ${String((e as Error)?.message ?? e)}`),
      );
      this.connErrCb("GPU_WS_ERROR", `重连失败: ${String((e as Error)?.message ?? e)}`);
    }
  }
}
