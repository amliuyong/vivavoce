import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyRealtimeClientSecret } from "../src/openai-realtime/client-secret";

interface GoldenFixture {
  signing_key: string;
  session_id: string;
  issued_at: number;
  expires_at: number;
  token: string;
}

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../contracts/realtime-client-secret-v1.json"), "utf8"),
) as GoldenFixture;

function signedToken(
  overrides: Partial<{
    aud: string;
    exp: number;
    iat: number;
    jti: string;
    sid: string;
    tr: string;
    v: number;
  }> = {},
): string {
  const payload = {
    aud: "viva-realtime",
    exp: fixture.expires_at,
    iat: fixture.issued_at,
    jti: "AAECAwQFBgcICQoLDA0ODw",
    sid: fixture.session_id,
    tr: "websocket",
    v: 1,
    ...overrides,
  };
  const payloadSegment = Buffer.from(JSON.stringify(payload), "ascii").toString("base64url");
  const tag = createHmac("sha256", fixture.signing_key)
    .update(`viva-realtime-v1.${payloadSegment}`, "ascii")
    .digest("base64url");
  return `ek_${payloadSegment}.${tag}`;
}

test("Python signer 与 TypeScript verifier 共用同一 v1 golden", () => {
  expect(
    verifyRealtimeClientSecret(
      fixture.token,
      fixture.signing_key,
      fixture.issued_at * 1000,
    ),
  ).toEqual({
    audience: "viva-realtime",
    expiresAt: fixture.expires_at,
    issuedAt: fixture.issued_at,
    sessionId: fixture.session_id,
    transport: "websocket",
    version: 1,
  });
});

test.each([
  ["wrong audience", signedToken({ aud: "api.openai.com" })],
  ["wrong transport", signedToken({ tr: "webrtc" })],
  ["wrong version", signedToken({ v: 2 })],
  ["wrong ttl", signedToken({ exp: fixture.expires_at + 1 })],
])("已正确签名但绑定无效(%s)仍 fail-closed", (_case, token) => {
  expect(
    verifyRealtimeClientSecret(token, fixture.signing_key, fixture.issued_at * 1000),
  ).toBeNull();
});

test("过期边界与 future skew fail-closed", () => {
  expect(
    verifyRealtimeClientSecret(
      fixture.token,
      fixture.signing_key,
      fixture.expires_at * 1000,
    ),
  ).toBeNull();
  expect(
    verifyRealtimeClientSecret(
      signedToken({
        iat: fixture.issued_at + 31,
        exp: fixture.expires_at + 31,
      }),
      fixture.signing_key,
      fixture.issued_at * 1000,
    ),
  ).toBeNull();
});

test("坏 key、坏 tag、超长 envelope 与短 key 均拒绝", () => {
  expect(
    verifyRealtimeClientSecret(
      fixture.token,
      "fedcba9876543210fedcba9876543210",
      fixture.issued_at * 1000,
    ),
  ).toBeNull();
  expect(
    verifyRealtimeClientSecret(
      `${fixture.token.slice(0, -1)}A`,
      fixture.signing_key,
      fixture.issued_at * 1000,
    ),
  ).toBeNull();
  expect(
    verifyRealtimeClientSecret(
      `ek_${"a".repeat(500)}.${"b".repeat(43)}`,
      fixture.signing_key,
      fixture.issued_at * 1000,
    ),
  ).toBeNull();
  expect(
    verifyRealtimeClientSecret(fixture.token, "short", fixture.issued_at * 1000),
  ).toBeNull();
});

test("tag 与 jti 的非 canonical base64url 别名均拒绝", () => {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const canonicalLast = fixture.token.at(-1)!;
  const aliasLast = alphabet[alphabet.indexOf(canonicalLast) + 1];
  const tagAlias = `${fixture.token.slice(0, -1)}${aliasLast}`;
  expect(
    Buffer.from(tagAlias.split(".")[1], "base64url"),
  ).toEqual(Buffer.from(fixture.token.split(".")[1], "base64url"));
  expect(
    verifyRealtimeClientSecret(
      tagAlias,
      fixture.signing_key,
      fixture.issued_at * 1000,
    ),
  ).toBeNull();

  expect(
    verifyRealtimeClientSecret(
      signedToken({ jti: "AAECAwQFBgcICQoLDA0ODx" }),
      fixture.signing_key,
      fixture.issued_at * 1000,
    ),
  ).toBeNull();
});
