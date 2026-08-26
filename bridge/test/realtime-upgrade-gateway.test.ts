import { createHmac } from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { RealtimeUpgradeGateway } from "../src/openai-realtime/upgrade-gateway";

const SIGNING_KEY = "0123456789abcdef0123456789abcdef";
const NOW_SECONDS = 1_785_685_860;

function signToken(sessionId: string, issuedAt = NOW_SECONDS): string {
  const payload = {
    aud: "viva-realtime",
    exp: issuedAt + 600,
    iat: issuedAt,
    jti: "AAECAwQFBgcICQoLDA0ODw",
    sid: sessionId,
    tr: "websocket",
    v: 1,
  };
  const payloadSegment = Buffer.from(JSON.stringify(payload), "ascii").toString(
    "base64url",
  );
  const tag = createHmac("sha256", SIGNING_KEY)
    .update(`viva-realtime-v1.${payloadSegment}`, "ascii")
    .digest("base64url");
  return `ek_${payloadSegment}.${tag}`;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close(1000);
  });
}

describe("/v1/realtime upgrade gateway", () => {
  const readySessions = new Set<string>();
  const hangingRevokers = new Set<string>();
  const delayedRevokers = new Map<string, Promise<void>>();
  const hangingSupersedeWriters = new Set<string>();
  const failingSupersedeWriters = new Set<string>();
  const ownerTrace: string[] = [];
  let ownerSequence = 0;
  let acceptedConnections = 0;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const gateway = new RealtimeUpgradeGateway({
      getSigningKey: () => SIGNING_KEY,
      isContextReady: (sessionId) => readySessions.has(sessionId),
      nowMs: () => NOW_SECONDS * 1000,
      onConnection: (sessionId, socket, lease) => {
        acceptedConnections += 1;
        ownerSequence += 1;
        const ownerId = ownerSequence;
        ownerTrace.push(`start:${sessionId}:${ownerId}`);
        let closeRequested = false;
        let closeRequestResolve!: () => void;
        const closeRequest = new Promise<void>((resolve) => {
          closeRequestResolve = resolve;
        });
        expect(
          lease.setSupersedeController({
            waitForCloseRequest: () =>
              failingSupersedeWriters.has(sessionId)
                ? Promise.reject(new Error("writer failed"))
                : closeRequest,
            fail: () => {
              if (closeRequested) return;
              closeRequested = true;
              closeRequestResolve();
              socket.close(1011, "connection takeover failed");
            },
          }),
        ).toBe(true);
        expect(
          lease.setCoreRevoker(async () => {
            ownerTrace.push(`revoke:${sessionId}:${ownerId}`);
            const delayed = delayedRevokers.get(sessionId);
            if (delayed) await delayed;
            if (hangingRevokers.has(sessionId)) {
              await new Promise<void>(() => undefined);
            }
            if (closeRequested || socket.readyState !== socket.OPEN) {
              closeRequestResolve();
              return;
            }
            if (
              hangingSupersedeWriters.has(sessionId) ||
              failingSupersedeWriters.has(sessionId)
            ) {
              return;
            }
            closeRequested = true;
            void Promise.all(
              [
                {
                  type: "viva.playback.clear",
                  viva_version: "1",
                  reason: "superseded",
                },
                {
                  type: "viva.connection.superseded",
                  viva_version: "1",
                },
              ].map(
                (frame) =>
                  new Promise<void>((resolve) => {
                    socket.send(JSON.stringify(frame), () => resolve());
                  }),
              ),
            ).then(() => {
              closeRequestResolve();
              socket.close(1000, "superseded");
            });
          }),
        ).toBe(true);
      },
    });
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (req, socket, head) => {
      gateway.handleUpgrade(req, socket, head);
    });
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

  function rawUpgrade(
    path: string,
    headers:
      | Record<string, string>
      | Array<readonly [name: string, value: string]>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      let response = "";
      socket.setEncoding("utf8");
      socket.setTimeout(2_000, () => {
        socket.destroy(new Error("raw upgrade response timeout"));
      });
      socket.on("connect", () => {
        const requestHeaders: Array<readonly [string, string]> = [
          ["Host", `127.0.0.1:${port}`],
          ["Connection", "Upgrade"],
          ["Upgrade", "websocket"],
          ["Sec-WebSocket-Key", "MDEyMzQ1Njc4OWFiY2RlZg=="],
          ["Sec-WebSocket-Version", "13"],
          ...(Array.isArray(headers) ? headers : Object.entries(headers)),
        ];
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            ...requestHeaders.map(
              ([name, value]) => `${name}: ${value}`,
            ),
            "",
            "",
          ].join("\r\n"),
        );
      });
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.on("end", () => resolve(response));
      socket.on("error", reject);
    });
  }

  test("context 未恢复时返回精确 503/Retry-After/body 且不激活 owner", async () => {
    const sessionId = "sess_not_ready";
    const before = acceptedConnections;
    const response = await rawUpgrade(
      `/v1/realtime?session_id=${sessionId}`,
      { Authorization: `Bearer ${signToken(sessionId)}` },
    );

    expect(response).toContain("HTTP/1.1 503 Service Unavailable\r\n");
    expect(response).toContain("Retry-After: 1\r\n");
    expect(response).toContain("Content-Type: application/json\r\n");
    expect(response.split("\r\n\r\n")[1]).toBe('{"error":"not_ready"}');
    expect(acceptedConnections).toBe(before);
  });

  test("鉴权失败 body 不回显 secret", async () => {
    const token = signToken("sess_bad_auth");
    const response = await rawUpgrade(
      "/v1/realtime?session_id=sess_bad_auth",
      { Authorization: `Bearer ${token.slice(0, -1)}A` },
    );

    expect(response).toContain("HTTP/1.1 401 Unauthorized\r\n");
    expect(response).not.toContain(token);
    expect(response.split("\r\n\r\n")[1]).toBe('{"error":"auth_failed"}');
  });

  test("Bearer 与 browser protocol 凭据冲突时 raw upgrade 401", async () => {
    const sessionId = "sess_conflict";
    const token = signToken(sessionId);
    const other = signToken("sess_other");
    const response = await rawUpgrade(
      `/v1/realtime?session_id=${sessionId}`,
      {
        Authorization: `Bearer ${token}`,
        "Sec-WebSocket-Protocol": [
          "realtime",
          `openai-insecure-api-key.${other}`,
          "openai-agents-sdk.0.14.2",
        ].join(", "),
      },
    );

    expect(response).toContain("HTTP/1.1 401 Unauthorized\r\n");
  });

  test("Node 折叠重复 Authorization 时仍据 rawHeaders fail-closed", async () => {
    const sessionId = "sess_duplicate_authorization";
    readySessions.add(sessionId);
    const before = acceptedConnections;
    const response = await rawUpgrade(
      `/v1/realtime?session_id=${sessionId}`,
      [
        ["Authorization", `Bearer ${signToken(sessionId)}`],
        ["Authorization", `Bearer ${signToken("sess_other")}`],
      ],
    );

    expect(response).toContain("HTTP/1.1 401 Unauthorized\r\n");
    expect(acceptedConnections).toBe(before);
  });

  test("pinned browser protocols upgrade 且响应只选择公开 realtime", async () => {
    const sessionId = "sess_browser";
    const token = signToken(sessionId);
    readySessions.add(sessionId);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`,
      [
        "realtime",
        `openai-insecure-api-key.${token}`,
        "openai-agents-sdk.0.14.2",
      ],
    );
    let responseProtocols: string | string[] | undefined;
    socket.once("upgrade", (response) => {
      responseProtocols = response.headers["sec-websocket-protocol"];
    });

    await waitForOpen(socket);
    expect(socket.protocol).toBe("realtime");
    expect(responseProtocols).toBe("realtime");
    expect(String(responseProtocols)).not.toContain(token);
    await closeSocket(socket);
  });

  test("pinned Node Bearer upgrade 不需要 subprotocol", async () => {
    const sessionId = "sess_node";
    readySessions.add(sessionId);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${signToken(sessionId)}`,
        },
      },
    );

    await waitForOpen(socket);
    expect(socket.protocol).toBe("");
    await closeSocket(socket);
  });

  test("同 session 新连接先撤销旧 owner，再有序发 supersede 终态并以 1000 关闭", async () => {
    const sessionId = "sess_takeover";
    readySessions.add(sessionId);
    const url = `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`;
    const options = {
      headers: { Authorization: `Bearer ${signToken(sessionId)}` },
    };
    const oldSocket = new WebSocket(url, options);
    const oldFrames: Record<string, unknown>[] = [];
    oldSocket.on("message", (data) => {
      oldFrames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await waitForOpen(oldSocket);
    const oldClose = new Promise<{ code: number; reason: string }>((resolve) => {
      oldSocket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    const newSocket = new WebSocket(url, options);
    await waitForOpen(newSocket);
    await expect(oldClose).resolves.toEqual({
      code: 1000,
      reason: "superseded",
    });
    expect(oldFrames).toEqual([
      {
        type: "viva.playback.clear",
        viva_version: "1",
        reason: "superseded",
      },
      {
        type: "viva.connection.superseded",
        viva_version: "1",
      },
    ]);

    const trace = ownerTrace.filter((entry) => entry.includes(sessionId));
    expect(trace).toHaveLength(3);
    expect(trace[0]).toMatch(/^start:/);
    expect(trace[1]).toMatch(/^revoke:/);
    expect(trace[2]).toMatch(/^start:/);
    expect(trace[0].split(":")[2]).toBe(trace[1].split(":")[2]);
    expect(trace[2].split(":")[2]).not.toBe(trace[0].split(":")[2]);
    await closeSocket(newSocket);
  });

  test("旧 core revoker 悬挂时有界关闭旧连接并拒绝激活新 owner", async () => {
    const sessionId = "sess_hanging_revoker";
    readySessions.add(sessionId);
    hangingRevokers.add(sessionId);
    const url = `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`;
    const options = {
      headers: { Authorization: `Bearer ${signToken(sessionId)}` },
    };
    const oldSocket = new WebSocket(url, options);
    await waitForOpen(oldSocket);
    const oldClose = new Promise<number>((resolve) => {
      oldSocket.once("close", (code) => resolve(code));
    });

    const newSocket = new WebSocket(url, options);
    const newFailure = new Promise<void>((resolve, reject) => {
      newSocket.once("open", () =>
        reject(new Error("replacement must not open after revoke timeout")),
      );
      newSocket.once("error", () => resolve());
    });

    await expect(newFailure).resolves.toBeUndefined();
    await expect(oldClose).resolves.toBe(1011);
    expect(
      ownerTrace.filter((entry) => entry.includes(sessionId)),
    ).toEqual([
      expect.stringMatching(/^start:/),
      expect.stringMatching(/^revoke:/),
    ]);

    const thirdSocket = new WebSocket(url, options);
    const thirdFailure = new Promise<void>((resolve, reject) => {
      thirdSocket.once("open", () =>
        reject(new Error("quarantined owner must reject later replacements")),
      );
      thirdSocket.once("error", () => resolve());
    });
    await expect(thirdFailure).resolves.toBeUndefined();
    expect(
      ownerTrace.filter((entry) => entry.includes(sessionId)),
    ).toEqual([
      expect.stringMatching(/^start:/),
      expect.stringMatching(/^revoke:/),
    ]);
    hangingRevokers.delete(sessionId);
  });

  test.each([
    ["timeout", hangingSupersedeWriters],
    ["failure", failingSupersedeWriters],
  ])("旧协议 writer %s 时以 1011 关闭，但已撤权的新 owner 可激活", async (_mode, failures) => {
    const sessionId = `sess_writer_${_mode}`;
    readySessions.add(sessionId);
    failures.add(sessionId);
    const url = `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`;
    const options = {
      headers: { Authorization: `Bearer ${signToken(sessionId)}` },
    };
    const oldSocket = new WebSocket(url, options);
    await waitForOpen(oldSocket);
    const oldClose = new Promise<number>((resolve) => {
      oldSocket.once("close", (code) => resolve(code));
    });

    const replacement = new WebSocket(url, options);
    await waitForOpen(replacement);
    await expect(oldClose).resolves.toBe(1011);
    expect(
      ownerTrace.filter((entry) => entry.includes(sessionId)),
    ).toEqual([
      expect.stringMatching(/^start:/),
      expect.stringMatching(/^revoke:/),
      expect.stringMatching(/^start:/),
    ]);

    failures.delete(sessionId);
    await closeSocket(replacement);
  });

  test("等待旧 owner 撤权期间 context 消失时返回 503 且不激活新 core", async () => {
    const sessionId = "sess_context_lost_during_takeover";
    readySessions.add(sessionId);
    let finishRevocation!: () => void;
    delayedRevokers.set(
      sessionId,
      new Promise<void>((resolve) => {
        finishRevocation = resolve;
      }),
    );
    const url = `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`;
    const options = {
      headers: { Authorization: `Bearer ${signToken(sessionId)}` },
    };
    const oldSocket = new WebSocket(url, options);
    await waitForOpen(oldSocket);
    const before = acceptedConnections;

    const responsePromise = rawUpgrade(
      `/v1/realtime?session_id=${sessionId}`,
      options.headers,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    readySessions.delete(sessionId);
    finishRevocation();
    delayedRevokers.delete(sessionId);

    const response = await responsePromise;
    expect(response).toContain("HTTP/1.1 503 Service Unavailable\r\n");
    expect(response).toContain("Retry-After: 1\r\n");
    expect(response.split("\r\n\r\n")[1]).toBe('{"error":"not_ready"}');
    expect(acceptedConnections).toBe(before);
    await closeSocket(oldSocket);
  });

  test("socket close 后 core 撤销悬挂时保留 quarantine 并拒绝新 owner", async () => {
    const sessionId = "sess_close_hanging_revoker";
    readySessions.add(sessionId);
    const url = `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`;
    const options = {
      headers: { Authorization: `Bearer ${signToken(sessionId)}` },
    };
    const oldSocket = new WebSocket(url, options);
    await waitForOpen(oldSocket);
    hangingRevokers.add(sessionId);
    await closeSocket(oldSocket);

    const replacement = new WebSocket(url, options);
    const replacementFailure = new Promise<void>((resolve, reject) => {
      replacement.once("open", () =>
        reject(new Error("close-time revoke timeout must quarantine session")),
      );
      replacement.once("error", () => resolve());
    });
    await expect(replacementFailure).resolves.toBeUndefined();
    expect(
      ownerTrace.filter((entry) => entry.includes(sessionId)),
    ).toEqual([
      expect.stringMatching(/^start:/),
      expect.stringMatching(/^revoke:/),
    ]);
    hangingRevokers.delete(sessionId);
  });

  test("超时 revoker 最终完成后才释放 quarantine", async () => {
    const sessionId = "sess_delayed_revoker";
    readySessions.add(sessionId);
    const url = `ws://127.0.0.1:${port}/v1/realtime?session_id=${sessionId}`;
    const options = {
      headers: { Authorization: `Bearer ${signToken(sessionId)}` },
    };
    let finishRevocation!: () => void;
    delayedRevokers.set(
      sessionId,
      new Promise<void>((resolve) => {
        finishRevocation = resolve;
      }),
    );

    const oldSocket = new WebSocket(url, options);
    await waitForOpen(oldSocket);
    const blockedReplacement = new WebSocket(url, options);
    const blockedFailure = new Promise<void>((resolve, reject) => {
      blockedReplacement.once("open", () =>
        reject(new Error("replacement must wait for delayed revocation")),
      );
      blockedReplacement.once("error", () => resolve());
    });
    await expect(blockedFailure).resolves.toBeUndefined();

    finishRevocation();
    delayedRevokers.delete(sessionId);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const recovered = new WebSocket(url, options);
    await waitForOpen(recovered);
    expect(
      ownerTrace.filter((entry) => entry.includes(sessionId)),
    ).toEqual([
      expect.stringMatching(/^start:/),
      expect.stringMatching(/^revoke:/),
      expect.stringMatching(/^start:/),
    ]);
    await closeSocket(recovered);
  });
});
