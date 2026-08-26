import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TOKEN_BYTES = 432;
const CLOCK_SKEW_SECONDS = 30;
const TTL_SECONDS = 600;
const ENVELOPE = /^ek_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;
const JTI = /^[A-Za-z0-9_-]{22}$/;
const PAYLOAD_KEYS = ["aud", "exp", "iat", "jti", "sid", "tr", "v"];

interface WirePayload {
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  sid: string;
  tr: string;
  v: number;
}

export interface VerifiedRealtimeClientSecret {
  audience: "viva-realtime";
  expiresAt: number;
  issuedAt: number;
  sessionId: string;
  transport: "websocket";
  version: 1;
}

export function verifyRealtimeClientSecret(
  token: string,
  signingKey: string,
  nowMs: number = Date.now(),
): VerifiedRealtimeClientSecret | null {
  if (Buffer.byteLength(signingKey, "utf8") < 32) return null;
  if (Buffer.byteLength(token, "ascii") > MAX_TOKEN_BYTES) return null;
  const match = ENVELOPE.exec(token);
  if (!match) return null;
  const [, payloadSegment, tagSegment] = match;

  const expectedTag = createHmac("sha256", signingKey)
    .update(`viva-realtime-v1.${payloadSegment}`, "ascii")
    .digest();
  const actualTag = Buffer.from(tagSegment, "base64url");
  if (
    actualTag.toString("base64url") !== tagSegment ||
    actualTag.length !== expectedTag.length ||
    !timingSafeEqual(actualTag, expectedTag)
  ) {
    return null;
  }

  let payload: WirePayload;
  let canonical: string;
  try {
    const decoded = Buffer.from(payloadSegment, "base64url");
    if (decoded.toString("base64url") !== payloadSegment) return null;
    canonical = decoded.toString("ascii");
    payload = JSON.parse(canonical) as WirePayload;
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null) return null;
  if (Object.keys(payload).sort().join(",") !== PAYLOAD_KEYS.join(",")) return null;
  if (
    payload.aud !== "viva-realtime" ||
    payload.tr !== "websocket" ||
    payload.v !== 1 ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp - payload.iat !== TTL_SECONDS ||
    typeof payload.sid !== "string" ||
    payload.sid.length === 0 ||
    typeof payload.jti !== "string" ||
    !JTI.test(payload.jti) ||
    Buffer.from(payload.jti, "base64url").length !== 16 ||
    Buffer.from(payload.jti, "base64url").toString("base64url") !== payload.jti
  ) {
    return null;
  }

  const expectedCanonical = JSON.stringify({
    aud: payload.aud,
    exp: payload.exp,
    iat: payload.iat,
    jti: payload.jti,
    sid: payload.sid,
    tr: payload.tr,
    v: payload.v,
  });
  if (canonical !== expectedCanonical) return null;
  if (payload.iat * 1000 > nowMs + CLOCK_SKEW_SECONDS * 1000) return null;
  if (nowMs >= payload.exp * 1000) return null;

  return {
    audience: payload.aud,
    expiresAt: payload.exp,
    issuedAt: payload.iat,
    sessionId: payload.sid,
    transport: payload.tr,
    version: payload.v,
  };
}
