import { createHmac, randomBytes } from "node:crypto";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import {
  dropSessionContext,
  getSessionContext,
  putSessionContext,
} from "../src/session-context";
import { reportEvent } from "../src/callback";
import { createEngine } from "../src/engine-factory";
import { server } from "../src/index";

const mockHangingRecorderSessions = new Set<string>();
const mockDelayedRecorderStops = new Map<string, Promise<void>>();
const mockRecorderStopCalls = new Map<string, number>();

jest.mock("../src/engine-factory", () => ({
  createEngine: jest.fn(() => ({
    start: async () => undefined,
    pushAudio: () => undefined,
    resetInput: async () => undefined,
    endTurn: () => undefined,
    cancel: () => undefined,
    onAudioOut: () => undefined,
    onResponseStarted: () => undefined,
    onResponseSegmentDeclared: () => undefined,
    onResponseSegmentCompleted: () => undefined,
    onResponseCoreTerminal: () => undefined,
    onTranscript: () => undefined,
    onTurnEvent: () => undefined,
    onError: () => undefined,
    hasQuestions: () => false,
    stop: async () => undefined,
  })),
}));

jest.mock("../src/stereo-recorder", () => ({
  StereoRecorder: class {
    constructor(private readonly sessionId: string) {}
    async start(): Promise<void> {}
    pushCaller(): void {}
    pushAi(): void {}
    async stopAndUpload(): Promise<null> {
      const calls = (mockRecorderStopCalls.get(this.sessionId) ?? 0) + 1;
      mockRecorderStopCalls.set(this.sessionId, calls);
      const delayed = mockDelayedRecorderStops.get(this.sessionId);
      if (calls === 1 && delayed) await delayed;
      if (calls === 1 && mockHangingRecorderSessions.has(this.sessionId)) {
        await new Promise<void>(() => undefined);
      }
      return null;
    }
  },
}));

jest.mock("../src/callback", () => ({
  reportEvent: jest.fn(async () => undefined),
}));

const REALTIME_SIGNING_KEY =
  "design contract-index-signing-key-at-least-32-bytes";

function signRealtimeToken(sessionId: string): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const payload = {
    aud: "viva-realtime",
    exp: issuedAt + 600,
    iat: issuedAt,
    jti: randomBytes(16).toString("base64url"),
    sid: sessionId,
    tr: "websocket",
    v: 1,
  };
  const payloadSegment = Buffer.from(JSON.stringify(payload), "ascii").toString(
    "base64url",
  );
  const tag = createHmac("sha256", REALTIME_SIGNING_KEY)
    .update(`viva-realtime-v1.${payloadSegment}`, "ascii")
    .digest("base64url");
  return `ek_${payloadSegment}.${tag}`;
}

function signJoinToken(sessionId: string, secret: string): string {
  const exp = Math.floor(Date.now() / 1_000) + 300;
  const message = `v1.${sessionId}.${exp}`;
  return `${message}.${createHmac("sha256", secret)
    .update(message)
    .digest("base64url")}`;
}

function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(message));
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
}

function rawUpgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => {
      socket.destroy(new Error("raw upgrade response timeout"));
    });
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("close", () => resolve(response));
    socket.on("error", reject);
  });
}

describe("index realtime upgrade routing", () => {
  let port: number;
  const createEngineMock = createEngine as jest.MockedFunction<
    typeof createEngine
  >;
  const reportEventMock = reportEvent as jest.MockedFunction<
    typeof reportEvent
  >;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test("精确 /v1/realtime 进入 gateway 并以 raw HTTP 401 拒绝缺失凭据", async () => {
    const response = await rawUpgrade(
      port,
      "/v1/realtime?session_id=sess_missing_auth",
    );
    expect(response).toContain("HTTP/1.1 401 Unauthorized\r\n");
    expect(response.split("\r\n\r\n")[1]).toBe('{"error":"auth_failed"}');
  });

  test("/v1/realtime/* 不进入 gateway", async () => {
    const response = await rawUpgrade(
      port,
      "/v1/realtime/extra?session_id=sess_missing_auth",
    );
    expect(response).toBe("");
  });

  test("成功 upgrade 穿过真实 index 接线且第一事件是 session.created", async () => {
    const previousSecret = process.env.AIM_REALTIME_CLIENT_SECRET;
    process.env.AIM_REALTIME_CLIENT_SECRET = REALTIME_SIGNING_KEY;
    const sessionId = "sess_index_success";
    putSessionContext(sessionId, "server-owned prompt", {
      engineType: "three_stage",
      language: "zh-CN",
      questions: [{ text: "server-owned question" }],
      voice: "server-owned-voice",
    });
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${signRealtimeToken(sessionId)}`,
        },
      },
    );
    try {
      const firstEvent = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          socket.once("message", (data) => {
            resolve(JSON.parse(data.toString()) as Record<string, unknown>);
          });
          socket.once("error", reject);
        },
      );
      expect(firstEvent).toMatchObject({
        type: "session.created",
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
        },
      });
      expect(firstEvent.session).not.toHaveProperty("instructions");
      expect(firstEvent.session).not.toHaveProperty("questions");
      expect(firstEvent.session).not.toHaveProperty("voice");
    } finally {
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.close(1000);
      });
      dropSessionContext(sessionId);
      if (previousSecret === undefined) {
        delete process.env.AIM_REALTIME_CLIENT_SECRET;
      } else {
        process.env.AIM_REALTIME_CLIENT_SECRET = previousSecret;
      }
    }
  });

  test("同 session realtime 接管保留服务端 SessionContext", async () => {
    const previousSecret = process.env.AIM_REALTIME_CLIENT_SECRET;
    process.env.AIM_REALTIME_CLIENT_SECRET = REALTIME_SIGNING_KEY;
    const sessionId = "sess_index_takeover_context";
    const engineParams = {
      engineType: "three_stage" as const,
      language: "zh-CN",
      questions: [{ text: "server-owned takeover question" }],
      voice: "server-owned-takeover-voice",
    };
    putSessionContext(sessionId, "server-owned takeover prompt", engineParams);
    createEngineMock.mockClear();

    const connect = async () => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`,
        {
          headers: {
            Authorization: `Bearer ${signRealtimeToken(sessionId)}`,
          },
        },
      );
      await new Promise<void>((resolve, reject) => {
        socket.once("message", () => resolve());
        socket.once("error", reject);
      });
      return socket;
    };

    const first = await connect();
    let second: WebSocket | null = null;
    try {
      second = await connect();
      expect(createEngineMock).toHaveBeenCalledTimes(2);
      expect(createEngineMock.mock.calls[1]?.[1]).toEqual(engineParams);
      expect(getSessionContext(sessionId)).toMatchObject({
        systemPrompt: "server-owned takeover prompt",
        engineParams,
      });
    } finally {
      for (const socket of [first, second]) {
        if (!socket || socket.readyState === WebSocket.CLOSED) continue;
        await new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.close(1000);
        });
      }
      dropSessionContext(sessionId);
      if (previousSecret === undefined) {
        delete process.env.AIM_REALTIME_CLIENT_SECRET;
      } else {
        process.env.AIM_REALTIME_CLIENT_SECRET = previousSecret;
      }
    }
  });

  test("旧连接慢 peer_hangup 收尾不得终结已重连的新 session incarnation", async () => {
    const previousSecret = process.env.AIM_REALTIME_CLIENT_SECRET;
    process.env.AIM_REALTIME_CLIENT_SECRET = REALTIME_SIGNING_KEY;
    const sessionId = "sess_index_stale_terminal";
    const engineParams = {
      engineType: "three_stage" as const,
      language: "zh-CN",
      questions: [{ text: "server-owned reconnect question" }],
    };
    putSessionContext(sessionId, "server-owned reconnect prompt", engineParams);
    reportEventMock.mockClear();
    mockRecorderStopCalls.delete(sessionId);
    let releaseOldRecorder!: () => void;
    mockDelayedRecorderStops.set(
      sessionId,
      new Promise<void>((resolve) => {
        releaseOldRecorder = resolve;
      }),
    );

    const connect = async () => {
      const frames: Array<Record<string, unknown>> = [];
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`,
        {
          headers: {
            Authorization: `Bearer ${signRealtimeToken(sessionId)}`,
          },
        },
      );
      socket.on("message", (data) => {
        frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      await waitFor(
        () => frames.some((frame) => frame.type === "session.created"),
        "realtime session did not activate",
      );
      return socket;
    };

    const first = await connect();
    let second: WebSocket | null = null;
    try {
      await new Promise<void>((resolve) => {
        first.once("close", () => resolve());
        first.close(1000);
      });
      await waitFor(
        () => mockRecorderStopCalls.get(sessionId) === 1,
        "old recorder cleanup did not start",
      );

      second = await connect();
      releaseOldRecorder();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(getSessionContext(sessionId)).toMatchObject({
        systemPrompt: "server-owned reconnect prompt",
        engineParams,
      });
      expect(
        reportEventMock.mock.calls.filter(
          ([reportedSessionId, event]) =>
            reportedSessionId === sessionId && event.event !== "connected",
        ),
      ).toEqual([]);
    } finally {
      releaseOldRecorder();
      mockDelayedRecorderStops.delete(sessionId);
      if (second && second.readyState !== WebSocket.CLOSED) {
        const socket = second;
        await new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.close(1000);
        });
      }
      dropSessionContext(sessionId);
      if (previousSecret === undefined) {
        delete process.env.AIM_REALTIME_CLIENT_SECRET;
      } else {
        process.env.AIM_REALTIME_CLIENT_SECRET = previousSecret;
      }
    }
  });

  test("重连初始化失败时保留旧 incarnation 的在途 peer_hangup 终态", async () => {
    const previousSecret = process.env.AIM_REALTIME_CLIENT_SECRET;
    process.env.AIM_REALTIME_CLIENT_SECRET = REALTIME_SIGNING_KEY;
    const sessionId = "sess_index_failed_reconnect_terminal";
    putSessionContext(sessionId, "server-owned failed reconnect prompt", {
      engineType: "three_stage",
      language: "zh-CN",
    });
    reportEventMock.mockClear();
    mockRecorderStopCalls.delete(sessionId);
    let releaseOldRecorder!: () => void;
    mockDelayedRecorderStops.set(
      sessionId,
      new Promise<void>((resolve) => {
        releaseOldRecorder = resolve;
      }),
    );

    const firstFrames: Array<Record<string, unknown>> = [];
    const first = new WebSocket(
      `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${signRealtimeToken(sessionId)}`,
        },
      },
    );
    first.on("message", (data) => {
      firstFrames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    try {
      await waitFor(
        () => firstFrames.some((frame) => frame.type === "session.created"),
        "first realtime session did not activate",
      );
      await new Promise<void>((resolve) => {
        first.once("close", () => resolve());
        first.close(1000);
      });
      await waitFor(
        () => mockRecorderStopCalls.get(sessionId) === 1,
        "old recorder cleanup did not start",
      );

      createEngineMock.mockImplementationOnce(() => {
        throw new Error("replacement engine initialization failed");
      });
      const replacement = new WebSocket(
        `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`,
        {
          headers: {
            Authorization: `Bearer ${signRealtimeToken(sessionId)}`,
          },
        },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("failed replacement socket did not close")),
          2_000,
        );
        replacement.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        replacement.once("error", () => undefined);
      });

      releaseOldRecorder();
      await waitFor(
        () =>
          reportEventMock.mock.calls.some(
            ([reportedSessionId, event]) =>
              reportedSessionId === sessionId &&
              event.event === "peer_hangup",
          ),
        "old peer_hangup terminal was not reported after replacement failed",
      );
      expect(getSessionContext(sessionId)).toBeNull();
    } finally {
      releaseOldRecorder();
      mockDelayedRecorderStops.delete(sessionId);
      dropSessionContext(sessionId);
      if (previousSecret === undefined) {
        delete process.env.AIM_REALTIME_CLIENT_SECRET;
      } else {
        process.env.AIM_REALTIME_CLIENT_SECRET = previousSecret;
      }
    }
  });

  test.each([
    ["v1", "realtime"],
    ["realtime", "v1"],
  ] as const)(
    "共享 owner 串行化 %s → %s 接管，慢 recorder 清理不阻塞新 core",
    async (firstProtocol, secondProtocol) => {
      const previousRealtimeSecret = process.env.AIM_REALTIME_CLIENT_SECRET;
      const previousBridgeSecret = process.env.AIM_BRIDGE_CALLBACK_SECRET;
      process.env.AIM_REALTIME_CLIENT_SECRET = REALTIME_SIGNING_KEY;
      process.env.AIM_BRIDGE_CALLBACK_SECRET = REALTIME_SIGNING_KEY;
      const sessionId = `sess_cross_${firstProtocol}_${secondProtocol}`;
      const engineParams = {
        engineType: "three_stage" as const,
        language: "zh-CN",
        questions: [{ text: "server-owned cross-protocol question" }],
      };
      putSessionContext(sessionId, "server-owned cross-protocol prompt", engineParams);
      mockHangingRecorderSessions.add(sessionId);
      mockRecorderStopCalls.delete(sessionId);
      createEngineMock.mockClear();

      const connectRealtime = async () => {
        const frames: Array<Record<string, unknown>> = [];
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`,
          {
            headers: {
              Authorization: `Bearer ${signRealtimeToken(sessionId)}`,
            },
          },
        );
        socket.on("message", (data) => {
          frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
        });
        await waitFor(
          () => frames.some((frame) => frame.type === "session.created"),
          "realtime session did not activate",
        );
        return { socket, frames };
      };
      const connectV1 = async () => {
        const frames: Array<Record<string, unknown>> = [];
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/rt/ws?session_id=${sessionId}`,
        );
        socket.on("message", (data, isBinary) => {
          if (!isBinary) {
            frames.push(
              JSON.parse(data.toString()) as Record<string, unknown>,
            );
          }
        });
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
        socket.send(
          JSON.stringify({
            type: "auth",
            token: signJoinToken(sessionId, REALTIME_SIGNING_KEY),
          }),
        );
        await waitFor(
          () => frames.some((frame) => frame.type === "ready"),
          "v1 session did not authenticate",
        );
        await waitFor(
          () => createEngineMock.mock.calls.length > 0,
          "v1 session did not activate",
        );
        return { socket, frames };
      };
      const connect = (protocol: "v1" | "realtime") =>
        protocol === "v1" ? connectV1() : connectRealtime();

      const first = await connect(firstProtocol);
      const firstClosed = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          first.socket.once("close", (code, reason) => {
            resolve({ code, reason: reason.toString() });
          });
        },
      );
      let second:
        | Awaited<ReturnType<typeof connectRealtime>>
        | Awaited<ReturnType<typeof connectV1>>
        | null = null;
      try {
        second = await Promise.race([
          (async () => {
            const connection = await connect(secondProtocol);
            await waitFor(
              () => createEngineMock.mock.calls.length === 2,
              "replacement core was not created",
            );
            return connection;
          })(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("new core waited for slow recorder cleanup")),
              750,
            );
          }),
        ]);
        await expect(firstClosed).resolves.toEqual({
          code: 1000,
          reason: "superseded",
        });
        if (firstProtocol === "v1") {
          expect(first.frames).toContainEqual({
            type: "error",
            code: "superseded",
          });
        } else {
          expect(first.frames).toContainEqual(expect.objectContaining({
            type: "viva.playback.clear",
            viva_version: "1",
            reason: "superseded",
          }));
          expect(first.frames).toContainEqual(expect.objectContaining({
            type: "viva.connection.superseded",
            viva_version: "1",
          }));
        }
        expect(createEngineMock.mock.calls[1]?.[1]).toEqual(engineParams);
        expect(getSessionContext(sessionId)).toMatchObject({
          systemPrompt: "server-owned cross-protocol prompt",
          engineParams,
        });
      } finally {
        for (const connection of [first, second]) {
          if (
            !connection ||
            connection.socket.readyState === WebSocket.CLOSED
          ) {
            continue;
          }
          await new Promise<void>((resolve) => {
            connection.socket.once("close", () => resolve());
            connection.socket.close(1000);
          });
        }
        mockHangingRecorderSessions.delete(sessionId);
        dropSessionContext(sessionId);
        if (previousRealtimeSecret === undefined) {
          delete process.env.AIM_REALTIME_CLIENT_SECRET;
        } else {
          process.env.AIM_REALTIME_CLIENT_SECRET = previousRealtimeSecret;
        }
        if (previousBridgeSecret === undefined) {
          delete process.env.AIM_BRIDGE_CALLBACK_SECRET;
        } else {
          process.env.AIM_BRIDGE_CALLBACK_SECRET = previousBridgeSecret;
        }
      }
    },
    10_000,
  );
});
