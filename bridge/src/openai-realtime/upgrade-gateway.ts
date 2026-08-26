import * as http from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  authenticateRealtimeUpgrade,
  type RealtimeUpgradeAuthResult,
} from "./upgrade-auth";
import {
  RealtimeConnectionOwners,
  type RealtimeConnectionLease,
} from "./connection-owner";

interface RealtimeUpgradeGatewayOptions {
  getSigningKey: () => string;
  isContextReady: (sessionId: string) => boolean;
  owners?: RealtimeConnectionOwners;
  onConnection?: (
    sessionId: string,
    socket: WebSocket,
    lease: RealtimeConnectionLease,
  ) => void | Promise<void>;
  nowMs?: () => number;
}

type RejectedUpgrade = Exclude<RealtimeUpgradeAuthResult, { ok: true }>;

const ERROR_BODY: Record<RejectedUpgrade["code"], string> = {
  auth_failed: JSON.stringify({ error: "auth_failed" }),
  credential_binding_mismatch: JSON.stringify({
    error: "credential_binding_mismatch",
  }),
  invalid_request: JSON.stringify({ error: "invalid_request" }),
  not_ready: JSON.stringify({ error: "not_ready" }),
  unsupported_sdk_version: JSON.stringify({
    error: "unsupported_sdk_version",
  }),
};

const WEBSOCKET_KEY = /^[+/0-9A-Za-z]{22}==$/;
const SUBPROTOCOL = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;

function validWebSocketHandshake(req: http.IncomingMessage): boolean {
  if (req.method !== "GET") return false;
  if (req.headers.upgrade?.toLowerCase() !== "websocket") return false;
  if (
    typeof req.headers["sec-websocket-key"] !== "string" ||
    !WEBSOCKET_KEY.test(req.headers["sec-websocket-key"])
  ) {
    return false;
  }
  if (req.headers["sec-websocket-version"] !== "13") return false;

  const protocolHeader = req.headers["sec-websocket-protocol"];
  if (protocolHeader === undefined) return true;
  if (typeof protocolHeader !== "string") return false;
  const protocols = protocolHeader.split(",").map((value) => value.trim());
  return (
    protocols.length > 0 &&
    protocols.every((protocol) => SUBPROTOCOL.test(protocol)) &&
    new Set(protocols).size === protocols.length
  );
}

function rejectUpgrade(socket: Duplex, rejection: RejectedUpgrade): void {
  const body = ERROR_BODY[rejection.code];
  const headers = [
    `HTTP/1.1 ${rejection.status} ${http.STATUS_CODES[rejection.status]}`,
    "Connection: close",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
    ...(rejection.retryAfter
      ? [`Retry-After: ${rejection.retryAfter}`]
      : []),
    "",
    body,
  ];
  socket.end(headers.join("\r\n"));
}

export class RealtimeUpgradeGateway {
  private readonly owners: RealtimeConnectionOwners;
  private readonly wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1_048_576,
    handleProtocols: (protocols) =>
      protocols.has("realtime") ? "realtime" : false,
  });

  constructor(private readonly options: RealtimeUpgradeGatewayOptions) {
    this.owners = options.owners ?? new RealtimeConnectionOwners();
  }

  handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const auth = authenticateRealtimeUpgrade(req, {
      signingKey: this.options.getSigningKey(),
      isContextReady: this.options.isContextReady,
      nowMs: this.options.nowMs?.(),
    });
    if (!auth.ok) {
      rejectUpgrade(socket, auth);
      return;
    }
    if (!validWebSocketHandshake(req)) {
      rejectUpgrade(socket, {
        ok: false,
        status: 400,
        code: "invalid_request",
      });
      return;
    }

    socket.on("error", () => undefined);
    let upgraded = false;
    let rejected = false;
    void this.owners
      .replace(auth.sessionId, (lease) => {
        // Ownership replacement can await an old writer. Recheck readiness
        // inside that serialized interval so context loss cannot silently fall
        // through to environment defaults after the initial auth admission.
        if (!this.options.isContextReady(auth.sessionId)) {
          rejected = true;
          rejectUpgrade(socket, {
            ok: false,
            status: 503,
            code: "not_ready",
            retryAfter: 1,
          });
          throw new Error("Realtime session context is no longer ready");
        }
        let websocket: WebSocket | null = null;
        this.wss.handleUpgrade(req, socket, head, (accepted) => {
          accepted.on("error", () => undefined);
          websocket = accepted;
          upgraded = true;
        });
        if (!websocket) throw new Error("WebSocket upgrade did not complete");
        return {
          socket: websocket,
          activate: () =>
            this.options.onConnection?.(auth.sessionId, websocket!, lease),
        };
      })
      .catch(() => {
        if (!upgraded && !rejected && !socket.destroyed) socket.destroy();
      });
  }
}
