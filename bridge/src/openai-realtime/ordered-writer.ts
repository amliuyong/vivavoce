import { REALTIME_LIMITS } from "./protocol";

export interface RealtimeWriterSocket {
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
}

export interface RealtimeWriterDelivery {
  onHandoff?: () => void;
  onFailure?: (error: Error) => void;
}

export interface RealtimeWriterLimits {
  highWaterBytes: number;
  lowWaterBytes: number;
  hardLimitBytes: number;
  maxQueueAgeMs: number;
}

export interface OrderedRealtimeWriterOptions {
  limits?: Partial<RealtimeWriterLimits>;
  onFlowChange?: (paused: boolean, residentBytes: number) => void;
  onFailure: (error: Error) => void;
}

interface QueuedFrame {
  data: string;
  bytes: number;
  enqueuedAtMs: number;
  delivery?: RealtimeWriterDelivery;
}

const DEFAULT_LIMITS: RealtimeWriterLimits = {
  highWaterBytes: REALTIME_LIMITS.OUTBOUND_HIGH_WATER_BYTES,
  lowWaterBytes: REALTIME_LIMITS.OUTBOUND_LOW_WATER_BYTES,
  hardLimitBytes: REALTIME_LIMITS.OUTBOUND_HARD_LIMIT_BYTES,
  maxQueueAgeMs: REALTIME_LIMITS.OUTBOUND_MAX_QUEUE_AGE_MS,
};

export class OrderedRealtimeWriter {
  private readonly limits: RealtimeWriterLimits;
  private readonly queue: QueuedFrame[] = [];
  private queuedBytes = 0;
  private inFlight: QueuedFrame | null = null;
  private paused = false;
  private failed = false;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly socket: RealtimeWriterSocket,
    private readonly options: OrderedRealtimeWriterOptions,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (
      this.limits.lowWaterBytes < 0 ||
      this.limits.highWaterBytes <= this.limits.lowWaterBytes ||
      this.limits.hardLimitBytes <= this.limits.highWaterBytes ||
      this.limits.maxQueueAgeMs <= 0
    ) {
      throw new RangeError("invalid realtime writer limits");
    }
  }

  get residentBytes(): number {
    return this.queuedBytes + Math.max(0, this.socket.bufferedAmount);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  enqueue(data: string, delivery?: RealtimeWriterDelivery): void {
    if (this.failed) {
      this.notifyDeliveryFailure(
        delivery,
        new Error("realtime writer is closed"),
      );
      return;
    }
    const frame: QueuedFrame = {
      data,
      bytes: Buffer.byteLength(data, "utf8"),
      enqueuedAtMs: Date.now(),
      delivery,
    };
    this.queue.push(frame);
    this.queuedBytes += frame.bytes;
    if (this.residentBytes > this.limits.hardLimitBytes) {
      this.fail(new Error("realtime writer hard limit exceeded"));
      return;
    }
    this.pump();
    this.updateFlow();
    this.scheduleStallCheck();
  }

  fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    const inFlight = this.inFlight;
    this.inFlight = null;
    this.notifyDeliveryFailure(inFlight?.delivery, error);
    for (const frame of this.queue) {
      this.notifyDeliveryFailure(frame.delivery, error);
    }
    this.queue.length = 0;
    this.queuedBytes = 0;
    try {
      this.options.onFailure(error);
    } catch {
      // A failure observer must not interrupt writer cleanup or escape a ws
      // callback into the process event loop.
    }
  }

  private pump(): void {
    if (this.failed || this.inFlight || this.queue.length === 0) return;
    const frame = this.queue.shift()!;
    this.queuedBytes -= frame.bytes;
    this.inFlight = frame;
    try {
      this.socket.send(frame.data, (error?: Error) => {
        if (this.failed || this.inFlight !== frame) return;
        this.inFlight = null;
        if (error) {
          this.notifyDeliveryFailure(frame.delivery, error);
          this.fail(error);
          return;
        }
        try {
          frame.delivery?.onHandoff?.();
        } catch (callbackError) {
          this.fail(this.asError(callbackError));
          return;
        }
        this.pump();
        this.updateFlow();
        this.scheduleStallCheck();
      });
    } catch (error) {
      this.inFlight = null;
      const typed = this.asError(error);
      this.notifyDeliveryFailure(frame.delivery, typed);
      this.fail(typed);
    }
  }

  private updateFlow(): void {
    const resident = this.residentBytes;
    if (!this.paused && resident >= this.limits.highWaterBytes) {
      this.paused = true;
      this.notifyFlowChange(true, resident);
    } else if (this.paused && resident <= this.limits.lowWaterBytes) {
      this.paused = false;
      this.notifyFlowChange(false, resident);
    }
  }

  private notifyFlowChange(paused: boolean, residentBytes: number): void {
    try {
      this.options.onFlowChange?.(paused, residentBytes);
    } catch (error) {
      this.fail(this.asError(error));
    }
  }

  private notifyDeliveryFailure(
    delivery: RealtimeWriterDelivery | undefined,
    error: Error,
  ): void {
    try {
      delivery?.onFailure?.(error);
    } catch {
      // Delivery observers are cleanup hooks. Continue notifying the remaining
      // queued frames and the adapter-level failure observer.
    }
  }

  private asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private scheduleStallCheck(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.failed) return;
    const oldest = this.inFlight ?? this.queue[0];
    if (!oldest) return;
    const ageMs = Date.now() - oldest.enqueuedAtMs;
    const delayMs = Math.max(1, this.limits.maxQueueAgeMs - ageMs);
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      const currentOldest = this.inFlight ?? this.queue[0];
      if (!currentOldest) return;
      if (Date.now() - currentOldest.enqueuedAtMs >= this.limits.maxQueueAgeMs) {
        this.fail(new Error("realtime writer queue stalled"));
        return;
      }
      this.scheduleStallCheck();
    }, delayMs);
    this.stallTimer.unref?.();
  }
}
