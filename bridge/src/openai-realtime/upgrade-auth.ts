import { verifyRealtimeClientSecret } from "./client-secret";

const SDK_PROTOCOL = "openai-agents-sdk.0.14.2";
const SECRET_PROTOCOL_PREFIX = "openai-insecure-api-key.";
const QUERY_SECRET_NAMES = new Set([
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "key",
  "token",
]);
const ALLOWED_QUERY_NAMES = new Set(["model", "session_id"]);

export interface RealtimeUpgradeRequest {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders?: readonly string[];
}

export interface RealtimeUpgradeAuthOptions {
  signingKey: string;
  isContextReady: (sessionId: string) => boolean;
  nowMs?: number;
}

export type RealtimeUpgradeAuthResult =
  | {
      ok: true;
      sessionId: string;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 503;
      code:
        | "auth_failed"
        | "credential_binding_mismatch"
        | "invalid_request"
        | "not_ready"
        | "unsupported_sdk_version";
      retryAfter?: 1;
    };

function header(
  headers: RealtimeUpgradeRequest["headers"],
  name: string,
): string | string[] | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function singleHeader(
  headers: RealtimeUpgradeRequest["headers"],
  name: string,
): string | null {
  const value = header(headers, name);
  return typeof value === "string" ? value : null;
}

function rawHeaderCount(
  request: RealtimeUpgradeRequest,
  name: string,
): number {
  const wanted = name.toLowerCase();
  let count = 0;
  for (let i = 0; i < (request.rawHeaders?.length ?? 0); i += 2) {
    if (request.rawHeaders![i].toLowerCase() === wanted) count += 1;
  }
  return count;
}

function reject(
  status: 400 | 401 | 403,
  code: Exclude<RealtimeUpgradeAuthResult, { ok: true }>["code"],
): RealtimeUpgradeAuthResult {
  return { ok: false, status, code };
}

export function authenticateRealtimeUpgrade(
  request: RealtimeUpgradeRequest,
  options: RealtimeUpgradeAuthOptions,
): RealtimeUpgradeAuthResult {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://localhost");
  } catch {
    return reject(400, "invalid_request");
  }
  if (url.pathname !== "/v1/realtime") return reject(400, "invalid_request");

  const sessionIds = url.searchParams.getAll("session_id");
  if (sessionIds.length !== 1 || !sessionIds[0]) return reject(400, "invalid_request");
  for (const [name, value] of url.searchParams) {
    if (QUERY_SECRET_NAMES.has(name.toLowerCase()) || value.includes("ek_")) {
      return reject(401, "auth_failed");
    }
    if (!ALLOWED_QUERY_NAMES.has(name)) {
      return reject(400, "invalid_request");
    }
  }
  const models = url.searchParams.getAll("model");
  if (models.length > 1 || models.some((model) => !model)) {
    return reject(400, "invalid_request");
  }

  if (rawHeaderCount(request, "sec-websocket-protocol") > 1) {
    return reject(400, "invalid_request");
  }
  const protocolHeader = singleHeader(request.headers, "sec-websocket-protocol");
  if (
    header(request.headers, "sec-websocket-protocol") !== undefined &&
    protocolHeader === null
  ) {
    return reject(400, "invalid_request");
  }
  const protocols = protocolHeader
    ? protocolHeader.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const secretProtocols = protocols.filter((value) =>
    value.startsWith(SECRET_PROTOCOL_PREFIX),
  );
  if (secretProtocols.length > 1) return reject(401, "auth_failed");
  const protocolCredential =
    secretProtocols.length === 1
      ? secretProtocols[0].slice(SECRET_PROTOCOL_PREFIX.length)
      : null;
  if (protocolCredential) {
    if (!protocols.includes("realtime")) return reject(400, "invalid_request");
    const sdkProtocols = protocols.filter((value) =>
      value.startsWith("openai-agents-sdk."),
    );
    if (sdkProtocols.length !== 1 || sdkProtocols[0] !== SDK_PROTOCOL) {
      return reject(403, "unsupported_sdk_version");
    }
  }

  if (rawHeaderCount(request, "authorization") > 1) {
    return reject(401, "auth_failed");
  }
  const authorization = singleHeader(request.headers, "authorization");
  if (
    header(request.headers, "authorization") !== undefined &&
    authorization === null
  ) {
    return reject(401, "auth_failed");
  }
  const bearerMatch = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (authorization && !bearerMatch) return reject(401, "auth_failed");
  const bearerCredential = bearerMatch?.[1] ?? null;
  if (
    bearerCredential &&
    protocolCredential &&
    bearerCredential !== protocolCredential
  ) {
    return reject(401, "auth_failed");
  }
  const credential = bearerCredential ?? protocolCredential;
  if (!credential) return reject(401, "auth_failed");

  const verified = verifyRealtimeClientSecret(
    credential,
    options.signingKey,
    options.nowMs,
  );
  if (!verified) return reject(401, "auth_failed");
  if (verified.sessionId !== sessionIds[0]) {
    return reject(403, "credential_binding_mismatch");
  }
  if (!options.isContextReady(verified.sessionId)) {
    return {
      ok: false,
      status: 503,
      code: "not_ready",
      retryAfter: 1,
    };
  }
  return {
    ok: true,
    sessionId: verified.sessionId,
  };
}
