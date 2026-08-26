/**
 * GpuClient 握手期 CAPACITY_FULL 退避重连(D-2;design contract)。
 * 覆盖:重连换实例重发 start;重连成功后 ready 正常;重连耗尽上报 CAPACITY_FULL 拆机;
 *      未启用重连时行为不变(CAPACITY_FULL 直接 controlCb 上报)。
 */
import { GpuClient, WsLike } from "../src/gpu-client";

class FakeWs implements WsLike {
  sent: Array<string | Buffer> = [];
  private msgCb: (d: Buffer, b: boolean) => void = () => {};
  closed = false;
  send(data: string | Buffer): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  on(event: "message" | "open" | "close" | "error", cb: (...a: never[]) => void): void {
    if (event === "message") this.msgCb = cb as never;
  }
  emitControl(obj: Record<string, unknown>): void {
    this.msgCb(Buffer.from(JSON.stringify(obj), "utf-8"), false);
  }
  texts(): Record<string, unknown>[] {
    return this.sent.filter((s) => typeof s === "string").map((s) => JSON.parse(s as string));
  }
}

const noSleep = () => Promise.resolve();
const noJitter = () => 0;

test("握手期 CAPACITY_FULL → 退避重连换实例重发 start,重连后 ready 正常", async () => {
  const ws0 = new FakeWs();
  const ws1 = new FakeWs();
  const created: FakeWs[] = [];
  const gpu = new GpuClient(ws0, "s1", 0); // handshakeTimeoutMs=0 关看门狗(专测重连)
  const controls: string[] = [];
  gpu.onControl((m) => controls.push(String(m.type)));
  gpu.enableReconnect({
    connect: () => { created.push(ws1); return ws1; },
    maxAttempts: 4, baseDelayMs: 10, sleep: noSleep, jitter: noJitter,
  });
  gpu.start({ system_prompt: "hi" });
  expect(ws0.texts()[0].type).toBe("start"); // 首连发了 start

  // 首连回 CAPACITY_FULL → 触发重连(不 controlCb 上报)
  ws0.emitControl({ type: "error", code: "CAPACITY_FULL", message: "满" });
  await new Promise((r) => setTimeout(r, 5)); // 让 async 重连跑完(noSleep)
  expect(controls).not.toContain("error"); // 重连接管,未上报
  expect(created).toHaveLength(1);          // 换了新实例
  expect(ws1.texts().some((m) => m.type === "start")).toBe(true); // 重连后重发 start
  expect(ws0.closed).toBe(true);            // 旧连接被关

  // 新连接回 ready → 正常
  ws1.emitControl({ type: "ready" });
  expect(controls).toContain("ready");
});

test("重连耗尽 → 上报 CAPACITY_FULL 拆机(不无限重连)", async () => {
  const wss: FakeWs[] = [new FakeWs()];
  const gpu = new GpuClient(wss[0], "s1", 0);
  let capacityFullReported = 0;
  gpu.onControl((m) => { if (m.type === "error" && m.code === "CAPACITY_FULL") capacityFullReported++; });
  gpu.enableReconnect({
    connect: () => { const w = new FakeWs(); wss.push(w); return w; },
    maxAttempts: 2, baseDelayMs: 1, sleep: noSleep, jitter: noJitter,
  });
  gpu.start({ system_prompt: "hi" });
  // 每条连接都回 CAPACITY_FULL:首连 + 2 次重连 = 3 次,第 3 次超 maxAttempts=2 → 上报拆机
  wss[0].emitControl({ type: "error", code: "CAPACITY_FULL" });
  await new Promise((r) => setTimeout(r, 5));
  wss[1].emitControl({ type: "error", code: "CAPACITY_FULL" });
  await new Promise((r) => setTimeout(r, 5));
  wss[2].emitControl({ type: "error", code: "CAPACITY_FULL" });
  await new Promise((r) => setTimeout(r, 5));
  expect(capacityFullReported).toBe(1); // 耗尽后上报一次拆机
});

test("未启用重连 → CAPACITY_FULL 直接 controlCb 上报(行为不变)", async () => {
  const ws = new FakeWs();
  const gpu = new GpuClient(ws, "s1", 0); // 不 enableReconnect
  const codes: string[] = [];
  gpu.onControl((m) => { if (m.type === "error") codes.push(String(m.code)); });
  gpu.start({ system_prompt: "hi" });
  ws.emitControl({ type: "error", code: "CAPACITY_FULL" });
  expect(codes).toEqual(["CAPACITY_FULL"]); // 立即上报,不重连
});

test("非 CAPACITY_FULL 错误(MODEL_NOT_READY)不重连,直接上报", async () => {
  const ws = new FakeWs();
  const gpu = new GpuClient(ws, "s1", 0);
  const codes: string[] = [];
  gpu.onControl((m) => { if (m.type === "error") codes.push(String(m.code)); });
  gpu.enableReconnect({ connect: () => new FakeWs(), sleep: noSleep, jitter: noJitter });
  gpu.start({ system_prompt: "hi" });
  ws.emitControl({ type: "error", code: "MODEL_NOT_READY" });
  expect(codes).toEqual(["MODEL_NOT_READY"]); // 非容量类不重连,直接上报
});

test("重连在途时旧连接又冒 CAPACITY_FULL → 吞掉,不中途拆机(review)", async () => {
  const ws0 = new FakeWs();
  const ws1 = new FakeWs();
  const gpu = new GpuClient(ws0, "s1", 0);
  const errCodes: string[] = [];
  gpu.onControl((m) => { if (m.type === "error") errCodes.push(String(m.code)); });
  // 可控 sleep:重连 sleep 挂起,让我们在 reconnecting=true 窗口注入第二个 CAPACITY_FULL。
  let releaseSleep: () => void = () => {};
  const gated = new Promise<void>((r) => { releaseSleep = r; });
  gpu.enableReconnect({
    connect: () => ws1, maxAttempts: 4, baseDelayMs: 1,
    sleep: () => gated, jitter: noJitter,
  });
  gpu.start({ system_prompt: "hi" });
  ws0.emitControl({ type: "error", code: "CAPACITY_FULL" }); // 触发重连,卡在 sleep
  // 重连在途(reconnecting=true):旧连接迟到又来一个 CAPACITY_FULL —— 必须被吞,不落 controlCb 拆机
  ws0.emitControl({ type: "error", code: "CAPACITY_FULL" });
  expect(errCodes).toEqual([]); // 未上报任何 error(没被中途拆机)
  releaseSleep();               // 放行重连完成
  await new Promise((r) => setTimeout(r, 5));
  ws1.emitControl({ type: "ready" });
  expect(errCodes).toEqual([]); // 重连成功,全程没拆机
});

test("重连后旧 ws 的迟到帧被身份守卫丢弃,不污染新连接(review)", async () => {
  const ws0 = new FakeWs();
  const ws1 = new FakeWs();
  const gpu = new GpuClient(ws0, "s1", 0);
  const types: string[] = [];
  gpu.onControl((m) => types.push(String(m.type)));
  gpu.enableReconnect({ connect: () => ws1, baseDelayMs: 1, sleep: noSleep, jitter: noJitter });
  gpu.start({ system_prompt: "hi" });
  ws0.emitControl({ type: "error", code: "CAPACITY_FULL" }); // → 重连到 ws1
  await new Promise((r) => setTimeout(r, 5));
  // 旧连接 ws0 迟到帧:ready / error 都应被 `ws !== this.ws` 守卫丢弃(否则误置 ready / 误报)
  ws0.emitControl({ type: "ready" });
  ws0.emitControl({ type: "error", code: "MODEL_NOT_READY" });
  expect(types).toEqual([]); // 旧 ws 的迟到控制帧全被丢弃
  ws1.emitControl({ type: "ready" }); // 新连接的 ready 正常生效
  expect(types).toEqual(["ready"]);
});

test("已 ready 后的 CAPACITY_FULL 不重连(运行中断连仍拆机;只握手期重连)", async () => {
  const ws = new FakeWs();
  const gpu = new GpuClient(ws, "s1", 0);
  const codes: string[] = [];
  gpu.onControl((m) => { if (m.type === "error") codes.push(String(m.code)); });
  gpu.enableReconnect({ connect: () => new FakeWs(), sleep: noSleep, jitter: noJitter });
  gpu.start({ system_prompt: "hi" });
  ws.emitControl({ type: "ready" }); // 先 ready(握手完成)
  ws.emitControl({ type: "error", code: "CAPACITY_FULL" }); // ready 后的错误
  expect(codes).toEqual(["CAPACITY_FULL"]); // 不重连,直接上报(运行中断连语义)
});
