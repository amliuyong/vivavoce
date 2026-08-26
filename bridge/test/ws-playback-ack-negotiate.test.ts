/**
 * design contract:index 层 playback_ack_v1 capability 协商(ready 回显 + 透传 startMediaSession)。
 * ★ design contract:AIM_PLAYBACK_ACK_MODE 已删 —— 协商现在**只看客户端是否声明 capability**,
 *   服务端无 mode 门。故本文件不再需要在 import 前设 env(那行已删,留着是死代码会误导)。
 */
process.env.AIM_BRIDGE_CALLBACK_SECRET = "ack-negotiate-secret";

import { createHmac } from "node:crypto";
import { handleWsConnection, AuthWsConn } from "../src/index";
import { putSessionContext, dropSessionContext } from "../src/session-context";

const SECRET = "ack-negotiate-secret";
function freshToken(sessionId: string): string {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const msg = `v1.${sessionId}.${exp}`;
  return `${msg}.${createHmac("sha256", SECRET).update(msg).digest("base64url")}`;
}

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
  textFrames(): Record<string, unknown>[] {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function mkStart() {
  const calls: { sessionId: string; playbackAck?: boolean }[] = [];
  const start = async (sessionId: string, _conn: AuthWsConn, playbackAck?: boolean) => {
    calls.push({ sessionId, playbackAck });
  };
  return { calls, start };
}

describe("design contract:capability 协商(mode=observe)", () => {
  it("客户端声明 playback_ack_v1 → ready 回显 capabilities:[playback_ack_v1] + 透传 playbackAck=true", () => {
    putSessionContext("sess_ack", "p", { engineType: "three_stage", language: "zh-CN" });
    try {
      const conn = new FakeConn();
      const { calls, start } = mkStart();
      handleWsConnection(conn, "", start);
      conn.rxText({ type: "auth", token: freshToken("sess_ack"), protocol_version: "1", capabilities: ["playback_ack_v1"] });
      const ready = conn.textFrames()[0];
      expect(ready.type).toBe("ready");
      expect(ready.capabilities).toEqual(["playback_ack_v1"]);
      expect(calls[0].playbackAck).toBe(true);
    } finally {
      dropSessionContext("sess_ack");
    }
  });

  it("客户端声明 playback_pause_v1 → ready 回显该能力,ACK 仍保持独立未启用", () => {
    putSessionContext("sess_pause", "p", { engineType: "three_stage", language: "zh-CN" });
    try {
      const conn = new FakeConn();
      const { calls, start } = mkStart();
      handleWsConnection(conn, "", start);
      conn.rxText({
        type: "auth",
        token: freshToken("sess_pause"),
        protocol_version: "1",
        capabilities: ["playback_pause_v1"],
      });
      const ready = conn.textFrames()[0];
      expect(ready.type).toBe("ready");
      expect(ready.capabilities).toEqual(["playback_pause_v1"]);
      expect(calls[0].playbackAck).toBe(false);
    } finally {
      dropSessionContext("sess_pause");
    }
  });

  it("客户端不声明 capability → ready 不含 capabilities + playbackAck=false(inert)", () => {
    putSessionContext("sess_noack", "p", { engineType: "three_stage", language: "zh-CN" });
    try {
      const conn = new FakeConn();
      const { calls, start } = mkStart();
      handleWsConnection(conn, "", start);
      conn.rxText({ type: "auth", token: freshToken("sess_noack"), protocol_version: "1" });
      const ready = conn.textFrames()[0];
      expect(ready.type).toBe("ready");
      expect("capabilities" in ready).toBe(false); // 未声明 → 不回显
      expect(calls[0].playbackAck).toBe(false);
    } finally {
      dropSessionContext("sess_noack");
    }
  });

  it("客户端声明未知 capability → 鉴权仍成功,ready 不回显该值(不因能力扩展失败)", () => {
    putSessionContext("sess_unk", "p", { engineType: "three_stage", language: "zh-CN" });
    try {
      const conn = new FakeConn();
      const { calls, start } = mkStart();
      handleWsConnection(conn, "", start);
      conn.rxText({ type: "auth", token: freshToken("sess_unk"), protocol_version: "1", capabilities: ["future_feature"] });
      const ready = conn.textFrames()[0];
      expect(ready.type).toBe("ready");
      expect("capabilities" in ready).toBe(false);
      expect(calls[0].playbackAck).toBe(false);
    } finally {
      dropSessionContext("sess_unk");
    }
  });

  it("capabilities 非数组(脏输入)→ fail-soft 视为 [],不崩不回显", () => {
    putSessionContext("sess_dirty", "p", { engineType: "three_stage", language: "zh-CN" });
    try {
      const conn = new FakeConn();
      const { calls, start } = mkStart();
      handleWsConnection(conn, "", start);
      conn.rxText({ type: "auth", token: freshToken("sess_dirty"), protocol_version: "1", capabilities: "playback_ack_v1" });
      const ready = conn.textFrames()[0];
      expect(ready.type).toBe("ready");
      expect("capabilities" in ready).toBe(false);
      expect(calls[0].playbackAck).toBe(false);
    } finally {
      dropSessionContext("sess_dirty");
    }
  });
});
