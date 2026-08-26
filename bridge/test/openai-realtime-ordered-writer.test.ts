import { OrderedRealtimeWriter } from "../src/openai-realtime/ordered-writer";

class FakeSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  private readonly callbacks: Array<(error?: Error) => void> = [];

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    this.bufferedAmount += Buffer.byteLength(data);
    this.callbacks.push(callback);
  }

  release(error?: Error): void {
    const data = this.sent[this.sent.length - this.callbacks.length];
    this.bufferedAmount -= Buffer.byteLength(data);
    const callback = this.callbacks.shift();
    if (!callback) throw new Error("no pending send callback");
    callback(error);
  }
}

describe("OrderedRealtimeWriter", () => {
  it("hands off frames and their callbacks in strict enqueue order", () => {
    const socket = new FakeSocket();
    const handedOff: string[] = [];
    const writer = new OrderedRealtimeWriter(socket, {
      onFailure: (error) => {
        throw error;
      },
    });

    writer.enqueue("one", { onHandoff: () => handedOff.push("one") });
    writer.enqueue("two", { onHandoff: () => handedOff.push("two") });
    writer.enqueue("three", { onHandoff: () => handedOff.push("three") });
    expect(socket.sent).toEqual(["one"]);
    expect(handedOff).toEqual([]);

    socket.release();
    expect(socket.sent).toEqual(["one", "two"]);
    expect(handedOff).toEqual(["one"]);
    socket.release();
    socket.release();
    expect(socket.sent).toEqual(["one", "two", "three"]);
    expect(handedOff).toEqual(["one", "two", "three"]);
    expect(writer.residentBytes).toBe(0);
  });

  it("pauses at high water and resumes only after resident bytes reach low water", () => {
    const socket = new FakeSocket();
    const flow: Array<{ paused: boolean; residentBytes: number }> = [];
    const writer = new OrderedRealtimeWriter(socket, {
      limits: {
        highWaterBytes: 100,
        lowWaterBytes: 20,
        hardLimitBytes: 1_000,
        maxQueueAgeMs: 1_000,
      },
      onFlowChange: (paused, residentBytes) => flow.push({ paused, residentBytes }),
      onFailure: (error) => {
        throw error;
      },
    });

    writer.enqueue("a".repeat(60));
    writer.enqueue("b".repeat(60));
    writer.enqueue("c".repeat(60));
    expect(flow).toEqual([{ paused: true, residentBytes: 120 }]);
    expect(writer.isPaused).toBe(true);

    socket.release();
    socket.release();
    expect(flow).toHaveLength(1);
    socket.release();
    expect(flow).toEqual([
      { paused: true, residentBytes: 120 },
      { paused: false, residentBytes: 0 },
    ]);
    expect(writer.isPaused).toBe(false);
  });

  it("fails closed on callback error, hard limit, or a stalled oldest frame", () => {
    jest.useFakeTimers();
    try {
      const callbackSocket = new FakeSocket();
      const callbackFailures: string[] = [];
      const callbackWriter = new OrderedRealtimeWriter(callbackSocket, {
        onFailure: (error) => callbackFailures.push(error.message),
      });
      callbackWriter.enqueue("frame");
      callbackSocket.release(new Error("write failed"));
      expect(callbackFailures).toEqual(["write failed"]);

      const hardSocket = new FakeSocket();
      const hardFailures: string[] = [];
      const hardWriter = new OrderedRealtimeWriter(hardSocket, {
        limits: {
          highWaterBytes: 50,
          lowWaterBytes: 10,
          hardLimitBytes: 80,
          maxQueueAgeMs: 1_000,
        },
        onFailure: (error) => hardFailures.push(error.message),
      });
      hardWriter.enqueue("x".repeat(81));
      expect(hardFailures).toEqual(["realtime writer hard limit exceeded"]);

      const stalledSocket = new FakeSocket();
      const stallFailures: string[] = [];
      const stalledWriter = new OrderedRealtimeWriter(stalledSocket, {
        limits: {
          highWaterBytes: 100,
          lowWaterBytes: 20,
          hardLimitBytes: 1_000,
          maxQueueAgeMs: 25,
        },
        onFailure: (error) => stallFailures.push(error.message),
      });
      stalledWriter.enqueue("never-callbacks");
      jest.advanceTimersByTime(26);
      expect(stallFailures).toEqual(["realtime writer queue stalled"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("contains observer exceptions and still fails the complete queue exactly once", () => {
    const socket = new FakeSocket();
    const deliveryFailures: string[] = [];
    const writerFailures: string[] = [];
    const writer = new OrderedRealtimeWriter(socket, {
      onFailure: (error) => {
        writerFailures.push(error.message);
        throw new Error("failure observer must be isolated");
      },
    });

    writer.enqueue("first", {
      onHandoff: () => {
        throw new Error("handoff observer failed");
      },
    });
    writer.enqueue("second", {
      onFailure: () => {
        throw new Error("delivery failure observer must be isolated");
      },
    });
    writer.enqueue("third", {
      onFailure: (error) => deliveryFailures.push(error.message),
    });

    expect(() => socket.release()).not.toThrow();
    expect(writerFailures).toEqual(["handoff observer failed"]);
    expect(deliveryFailures).toEqual(["handoff observer failed"]);
    expect(writer.residentBytes).toBe(0);

    expect(() =>
      writer.enqueue("after-failure", {
        onFailure: () => {
          throw new Error("closed observer must also be isolated");
        },
      }),
    ).not.toThrow();
    expect(writerFailures).toHaveLength(1);
  });

  it("turns a flow observer exception into one contained writer failure", () => {
    const socket = new FakeSocket();
    const writerFailures: string[] = [];
    const deliveryFailures: string[] = [];
    const writer = new OrderedRealtimeWriter(socket, {
      limits: {
        highWaterBytes: 2,
        lowWaterBytes: 1,
        hardLimitBytes: 100,
        maxQueueAgeMs: 1_000,
      },
      onFlowChange: () => {
        throw new Error("flow observer failed");
      },
      onFailure: (error) => writerFailures.push(error.message),
    });

    expect(() =>
      writer.enqueue("frame", {
        onFailure: (error) => deliveryFailures.push(error.message),
      }),
    ).not.toThrow();
    expect(writerFailures).toEqual(["flow observer failed"]);
    expect(deliveryFailures).toEqual(["flow observer failed"]);
    expect(() => socket.release()).not.toThrow();
    expect(writerFailures).toHaveLength(1);
  });
});
