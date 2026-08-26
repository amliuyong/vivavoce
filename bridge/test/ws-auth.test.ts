/**
 * index 层 WS 鉴权流单测(M1-B,D9 fail-closed)—— fake conn 直接驱动 handleWsConnection:
 *  - 无 auth 超时(10s)→ 关连接,不建会话
 *  - 坏 token / 首帧非 auth / 未配 secret → error(auth_failed)后关
 *  - 正确 token → ready 帧 → 建会话(注入 fake start)
 *  - 验签通过但无暂存上下文 → error(not_ready)后关
 *  - ?session_id 与 token 内 session_id 交叉校验,不一致拒
 *  - AIM_RT_INSECURE=1 → 跳过鉴权(旧直连行为)
 */
import { createHmac } from "node:crypto";
import { handleWsConnection, stripRtPrefix, AuthWsConn } from "../src/index";
import { putSessionContext, dropSessionContext } from "../src/session-context";

const SECRET = "ws-auth-test-secret";

function mkToken(sessionId: string, expUnix: number, secret: string = SECRET): string {
  const msg = `v1.${sessionId}.${expUnix}`;
  return `${msg}.${createHmac("sha256", secret).update(msg).digest("base64url")}`;
}

/** 未过期 token(exp = 5min 后)。 */
function freshToken(sessionId: string, secret: string = SECRET): string {
  return mkToken(sessionId, Math.floor(Date.now() / 1000) + 300, secret);
}

/** fake WS 连接:记录 send/close;支持多 message 监听 + off(auth 阶段临时监听的摘除)。 */
class FakeConn implements AuthWsConn {
  sent: (string | Buffer)[] = [];
  closed = false;
  private msgCbs: Array<(d: Buffer, b: boolean) => void> = [];
  private closeCbs: Array<() => void> = [];
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    for (const cb of this.closeCbs.slice()) cb();
  }
  on(event: "message" | "close", cb: never) {
    if (event === "message") this.msgCbs.push(cb as unknown as (d: Buffer, b: boolean) => void);
    else this.closeCbs.push(cb as unknown as () => void);
  }
  off(event: "message", cb: (d: Buffer, b: boolean) => void) {
    if (event === "message") this.msgCbs = this.msgCbs.filter((c) => c !== cb);
  }
  rxText(obj: unknown) {
    const raw = Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
    for (const cb of this.msgCbs.slice()) cb(raw, false);
  }
  rxBinary(pcm: Buffer) {
    for (const cb of this.msgCbs.slice()) cb(pcm, true);
  }
  /** 已发的 text 帧(JSON 解析)。 */
  textFrames(): Record<string, unknown>[] {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  messageListenerCount(): number {
    return this.msgCbs.length;
  }
}

/** 注入的 fake 建会话动作(不碰真实引擎/录音/S3)。 */
function mkStart() {
  const calls: { sessionId: string; conn: AuthWsConn }[] = [];
  const start = async (sessionId: string, conn: AuthWsConn) => {
    calls.push({ sessionId, conn });
  };
  return { calls, start };
}

const envBackup: Record<string, string | undefined> = {};
beforeEach(() => {
  envBackup.secret = process.env.AIM_BRIDGE_CALLBACK_SECRET;
  envBackup.insecure = process.env.AIM_RT_INSECURE;
  process.env.AIM_BRIDGE_CALLBACK_SECRET = SECRET;
  delete process.env.AIM_RT_INSECURE; // 默认强制鉴权分支
});
afterEach(() => {
  if (envBackup.secret === undefined) delete process.env.AIM_BRIDGE_CALLBACK_SECRET;
  else process.env.AIM_BRIDGE_CALLBACK_SECRET = envBackup.secret;
  if (envBackup.insecure === undefined) delete process.env.AIM_RT_INSECURE;
  else process.env.AIM_RT_INSECURE = envBackup.insecure;
  jest.useRealTimers();
});

test("无 auth 帧:连接后 10s 超时 → 关连接,不建会话", () => {
  jest.useFakeTimers();
  const conn = new FakeConn();
  const { calls, start } = mkStart();
  handleWsConnection(conn, "", start);
  expect(conn.closed).toBe(false);
  jest.advanceTimersByTime(10_100);
  expect(conn.closed).toBe(true);
  expect(calls).toHaveLength(0);
});

test("坏 token(签名不符)→ error(auth_failed)后关,不建会话", () => {
  const conn = new FakeConn();
  const { calls, start } = mkStart();
  handleWsConnection(conn, "", start);
  conn.rxText({ type: "auth", token: freshToken("sess_a", "wrong-secret") });
  expect(conn.textFrames()).toEqual([{ type: "error", code: "auth_failed" }]);
  expect(conn.closed).toBe(true);
  expect(calls).toHaveLength(0);
});

test("过期 token → auth_failed 后关", () => {
  const conn = new FakeConn();
  const { calls, start } = mkStart();
  handleWsConnection(conn, "", start);
  conn.rxText({ type: "auth", token: mkToken("sess_a", Math.floor(Date.now() / 1000) - 60) });
  expect(conn.textFrames()).toEqual([{ type: "error", code: "auth_failed" }]);
  expect(conn.closed).toBe(true);
  expect(calls).toHaveLength(0);
});

test("首条 text 帧非 auth(其它类型/非 JSON)→ auth_failed 后关", () => {
  for (const first of [{ type: "end" }, "not-json{{"]) {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxText(first);
    expect(conn.textFrames()).toEqual([{ type: "error", code: "auth_failed" }]);
    expect(conn.closed).toBe(true);
    expect(calls).toHaveLength(0);
  }
});

test("fail-closed:未配 AIM_BRIDGE_CALLBACK_SECRET → 一切连接被拒(即使 token 自洽)", () => {
  delete process.env.AIM_BRIDGE_CALLBACK_SECRET;
  const conn = new FakeConn();
  const { calls, start } = mkStart();
  handleWsConnection(conn, "", start);
  conn.rxText({ type: "auth", token: freshToken("sess_a", "") }); // 空密钥自签也不行
  expect(conn.textFrames()).toEqual([{ type: "error", code: "auth_failed" }]);
  expect(conn.closed).toBe(true);
  expect(calls).toHaveLength(0);
});

test("正确 token + 有暂存上下文 → ready 帧 → 建会话(auth 临时监听已摘除)", () => {
  jest.useFakeTimers();
  putSessionContext("sess_ok", "你是考官", { engineType: "three_stage", language: "zh-CN" });
  try {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxText({ type: "auth", token: freshToken("sess_ok") });
    // ★ design contract B 类连带效应(**预期,非意外**):
    //   ① false_interruption_recovery 默认由关改开 → ready 回显 true。
    //   ② effective_speaker_lock 随之变 true —— design contract D7 规定声纹门以 recovery 开为前提
    //      (recovery 关时客户端本地打断会绕过服务端声纹门,故必须降级不启用)。recovery 转默认开
    //      **解除了这层门控**,声纹锁定(Agent 默认开)因此真正生效。这正是「默认值即最佳值」要的结果:
    //      design contract 的能力此前被一个本该默认开的前置门挡着。
    expect(conn.textFrames()).toEqual([
      { type: "ready", protocol_version: "1", false_interruption_recovery: true, show_subtitles: true, effective_speaker_lock: true },
    ]); // 先 ready
    expect(calls).toHaveLength(1); // 后建会话
    expect(calls[0].sessionId).toBe("sess_ok");
    expect(conn.closed).toBe(false);
    // auth 阶段临时监听已摘除(防与 MediaSession 的 message handler 双收)
    expect(conn.messageListenerCount()).toBe(0);
    // 鉴权已了结:原 10s 超时 timer 不再误关连接
    jest.advanceTimersByTime(11_000);
    expect(conn.closed).toBe(false);
  } finally {
    dropSessionContext("sess_ok");
  }
});

test("验签通过但无暂存上下文 → error(not_ready)后关(客户端重试,backend /join 先预创建)", () => {
  const conn = new FakeConn();
  const { calls, start } = mkStart();
  handleWsConnection(conn, "", start);
  conn.rxText({ type: "auth", token: freshToken("sess_noctx") });
  expect(conn.textFrames()).toEqual([{ type: "error", code: "not_ready" }]);
  expect(conn.closed).toBe(true);
  expect(calls).toHaveLength(0);
});

test("?session_id 与 token 内 session_id 不一致 → auth_failed(交叉校验)", () => {
  putSessionContext("sess_q1", "p", { engineType: "three_stage", language: "zh-CN" });
  try {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "sess_other", start); // query 与 token 不符
    conn.rxText({ type: "auth", token: freshToken("sess_q1") });
    expect(conn.textFrames()).toEqual([{ type: "error", code: "auth_failed" }]);
    expect(calls).toHaveLength(0);
  } finally {
    dropSessionContext("sess_q1");
  }
});

test("?session_id 与 token 一致 → 通过(query 可选,给了就校验)", () => {
  putSessionContext("sess_q2", "p", { engineType: "three_stage", language: "zh-CN" });
  try {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "sess_q2", start);
    conn.rxText({ type: "auth", token: freshToken("sess_q2") });
    expect(conn.textFrames()).toEqual([
      { type: "ready", protocol_version: "1", false_interruption_recovery: true, show_subtitles: true, effective_speaker_lock: true },
    ]);
    expect(calls).toHaveLength(1);
  } finally {
    dropSessionContext("sess_q2");
  }
});

test("鉴权前的 binary 帧(音频)被丢弃,不影响随后的合法 auth", () => {
  putSessionContext("sess_bin", "p", { engineType: "three_stage", language: "zh-CN" });
  try {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxBinary(Buffer.alloc(640)); // 未鉴权音频 → 丢弃(不算「首帧」)
    expect(conn.closed).toBe(false);
    conn.rxText({ type: "auth", token: freshToken("sess_bin") });
    expect(conn.textFrames()).toEqual([
      { type: "ready", protocol_version: "1", false_interruption_recovery: true, show_subtitles: true, effective_speaker_lock: true },
    ]);
    expect(calls).toHaveLength(1);
  } finally {
    dropSessionContext("sess_bin");
  }
});

test("对端在鉴权前断开 → 超时 timer 清理,不重复关/不建会话", () => {
  jest.useFakeTimers();
  const conn = new FakeConn();
  const { calls, start } = mkStart();
  handleWsConnection(conn, "", start);
  conn.close(); // 对端断开(触发 close 监听)
  jest.advanceTimersByTime(11_000); // 超时到点:settled 已置,无二次处理
  expect(calls).toHaveLength(0);
  expect(conn.textFrames()).toEqual([]); // 无 error 帧(对端已走)
});

// ── 协议版本协商(design contract)──
test("auth 帧显式带 protocol_version:'1' → ready 回显 '1',正常建会话", () => {
  putSessionContext("sess_v1", "p", { engineType: "three_stage", language: "zh-CN" });
  try {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxText({ type: "auth", token: freshToken("sess_v1"), protocol_version: "1" });
    expect(conn.textFrames()).toEqual([
      { type: "ready", protocol_version: "1", false_interruption_recovery: true, show_subtitles: true, effective_speaker_lock: true },
    ]);
    expect(calls).toHaveLength(1);
    expect(conn.closed).toBe(false);
  } finally {
    dropSessionContext("sess_v1");
  }
});

test("auth 帧未知 protocol_version → fail-closed:error(unsupported_protocol_version)+server_supports,不建会话", () => {
  putSessionContext("sess_v99", "p", { engineType: "three_stage", language: "zh-CN" });
  try {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxText({ type: "auth", token: freshToken("sess_v99"), protocol_version: "99" });
    expect(conn.textFrames()).toEqual([
      { type: "error", code: "unsupported_protocol_version", server_supports: ["1"] },
    ]);
    expect(conn.closed).toBe(true);
    expect(calls).toHaveLength(0); // 未知版本不建会话(不静默降级)
  } finally {
    dropSessionContext("sess_v99");
  }
});

test("protocol_version 非字符串(如数字 1)→ 也 fail-closed(契约要求字符串)", () => {
  putSessionContext("sess_vnum", "p", { engineType: "three_stage", language: "zh-CN" });
  try {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxText({ type: "auth", token: freshToken("sess_vnum"), protocol_version: 1 });
    expect(conn.textFrames()).toEqual([
      { type: "error", code: "unsupported_protocol_version", server_supports: ["1"] },
    ]);
    expect(calls).toHaveLength(0);
  } finally {
    dropSessionContext("sess_vnum");
  }
});

// ── design contract:show_subtitles 经 ready 帧回显(会话级呈现开关)──
test("show_subtitles=false → ready 帧回显 false(无字幕会话)", () => {
  // 第 6 位参数 = showSubtitles;显式 false → 关字幕。
  putSessionContext("sess_nosub", "p", { engineType: "three_stage", language: "zh-CN" }, Date.now(), undefined, false);
  try {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxText({ type: "auth", token: freshToken("sess_nosub") });
    expect(conn.textFrames()).toEqual([
      { type: "ready", protocol_version: "1", false_interruption_recovery: true, show_subtitles: false, effective_speaker_lock: true },
    ]);
    expect(calls).toHaveLength(1);
  } finally {
    dropSessionContext("sess_nosub");
  }
});

test("show_subtitles=true(显式) → ready 帧回显 true", () => {
  putSessionContext("sess_sub_true", "p", { engineType: "three_stage", language: "zh-CN" }, Date.now(), undefined, true);
  try {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxText({ type: "auth", token: freshToken("sess_sub_true") });
    expect(conn.textFrames()).toEqual([
      { type: "ready", protocol_version: "1", false_interruption_recovery: true, show_subtitles: true, effective_speaker_lock: true },
    ]);
  } finally {
    dropSessionContext("sess_sub_true");
  }
});

test("show_subtitles 未存(旧 backend 未下发) → ready 帧缺省回显 true(默认开)", () => {
  // 不传第 6 位参数 → SessionContext.showSubtitles === undefined → ready 帧 `?? true`。
  putSessionContext("sess_sub_missing", "p", { engineType: "three_stage", language: "zh-CN" });
  try {
    const conn = new FakeConn();
    const { calls, start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxText({ type: "auth", token: freshToken("sess_sub_missing") });
    expect(conn.textFrames()).toEqual([
      { type: "ready", protocol_version: "1", false_interruption_recovery: true, show_subtitles: true, effective_speaker_lock: true },
    ]);
  } finally {
    dropSessionContext("sess_sub_missing");
  }
});

// ── design contract:avatar_style 经 ready 帧回显(会话级头像风格)──
test("avatar_style=tech → ready 帧回显 avatar_style:tech", () => {
  // 第 7 位参数 = avatarStyle;合法枚举透传。
  putSessionContext("sess_av_tech", "p", { engineType: "three_stage", language: "zh-CN" }, Date.now(), undefined, true, "tech");
  try {
    const conn = new FakeConn();
    const { start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxText({ type: "auth", token: freshToken("sess_av_tech") });
    expect(conn.textFrames()).toEqual([
      { type: "ready", protocol_version: "1", false_interruption_recovery: true, show_subtitles: true, avatar_style: "tech", effective_speaker_lock: true },
    ]);
  } finally {
    dropSessionContext("sess_av_tech");
  }
});

test("avatar_style 未存(旧 backend 未下发) → ready 帧**省略** avatar_style(前端兜底 minimal)", () => {
  // 不传第 7 位 → avatarStyle undefined → JSON.stringify 省略该键(不回显脏值,review)。
  putSessionContext("sess_av_missing", "p", { engineType: "three_stage", language: "zh-CN" }, Date.now(), undefined, true);
  try {
    const conn = new FakeConn();
    const { start } = mkStart();
    handleWsConnection(conn, "", start);
    conn.rxText({ type: "auth", token: freshToken("sess_av_missing") });
    const ready = conn.textFrames()[0] as Record<string, unknown>;
    expect(ready.type).toBe("ready");
    expect("avatar_style" in ready).toBe(false); // ★ undefined 键省略,不回显脏值
  } finally {
    dropSessionContext("sess_av_missing");
  }
});

test("AIM_RT_INSECURE=1:跳过鉴权(旧直连),?session_id= 直接建会话,无 ready 帧", () => {
  process.env.AIM_RT_INSECURE = "1";
  const conn = new FakeConn();
  const { calls, start } = mkStart();
  handleWsConnection(conn, "sess_legacy", start);
  expect(calls).toHaveLength(1); // 不等 auth,直接建
  expect(calls[0].sessionId).toBe("sess_legacy");
  expect(conn.textFrames()).toEqual([]); // 旧客户端不识 ready 帧,不发
  expect(conn.closed).toBe(false);
});

test("AIM_RT_INSECURE=1 但无 ?session_id → 关连接(旧行为保留)", () => {
  process.env.AIM_RT_INSECURE = "1";
  const conn = new FakeConn();
  const { calls, start } = mkStart();
  handleWsConnection(conn, "", start);
  expect(conn.closed).toBe(true);
  expect(calls).toHaveLength(0);
});

// ── /rt 前缀 strip(CloudFront rt/* 行为经 ALB 原样转发,入口统一剥前缀)──
test("stripRtPrefix:/rt 前缀与不带前缀等价;非段边界(/rtx)不剥", () => {
  expect(stripRtPrefix("/rt/health")).toBe("/health");
  expect(stripRtPrefix("/rt/ws?session_id=s1")).toBe("/ws?session_id=s1");
  expect(stripRtPrefix("/rt/sessions/s1/ready")).toBe("/sessions/s1/ready");
  expect(stripRtPrefix("/rt/sessions/s1/hangup")).toBe("/sessions/s1/hangup");
  expect(stripRtPrefix("/rt")).toBe("/");
  expect(stripRtPrefix("/health")).toBe("/health"); // 不带前缀原样
  expect(stripRtPrefix("/ws?session_id=x")).toBe("/ws?session_id=x");
  expect(stripRtPrefix("/rtx/ws")).toBe("/rtx/ws"); // 非 /rt 段边界不剥
});

// ── D9(review):/sessions/:id/hangup 公网可达 → 必须与 /ready 同口径鉴权 ──
describe("hangup 端点鉴权(fail-closed)", () => {
  const http = require("node:http");
  const request = (port: number, path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path, method: "POST", headers },
        (res: import("node:http").IncomingMessage) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });

  let port: number;
  beforeAll(async () => {
    const { server } = await import("../src/index");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as import("node:net").AddressInfo).port;
  });
  afterAll(async () => {
    const { server } = await import("../src/index");
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("无 X-Bridge-Secret → 401(不终止会话)", async () => {
    expect((await request(port, "/sessions/s1/hangup")).status).toBe(401);
    expect((await request(port, "/rt/sessions/s1/hangup")).status).toBe(401);
  });

  it("错误密钥 → 401;正确密钥 → 200", async () => {
    expect((await request(port, "/sessions/s1/hangup", { "X-Bridge-Secret": "wrong" })).status).toBe(401);
    // 全局 beforeEach 把密钥设为文件级 SECRET(bridge 惰性读 env,每请求生效)
    expect((await request(port, "/sessions/s1/hangup", { "X-Bridge-Secret": SECRET })).status).toBe(200);
  });
});
