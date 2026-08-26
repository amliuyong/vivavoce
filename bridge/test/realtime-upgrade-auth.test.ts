import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { authenticateRealtimeUpgrade } from "../src/openai-realtime/upgrade-auth";

interface GoldenFixture {
  signing_key: string;
  session_id: string;
  issued_at: number;
  token: string;
}

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../contracts/realtime-client-secret-v1.json"), "utf8"),
) as GoldenFixture;

const options = (ready = true) => ({
  signingKey: fixture.signing_key,
  nowMs: fixture.issued_at * 1000,
  isContextReady: () => ready,
});

test("pinned browser subprotocol 形态完成鉴权", () => {
  const result = authenticateRealtimeUpgrade(
    {
      url: `/v1/realtime?session_id=${fixture.session_id}`,
      headers: {
        "sec-websocket-protocol": [
          "realtime",
          `openai-insecure-api-key.${fixture.token}`,
          "openai-agents-sdk.0.14.2",
        ].join(", "),
      },
    },
    options(),
  );

  expect(result).toEqual({
    ok: true,
    sessionId: fixture.session_id,
  });
});

test("pinned Node Bearer 完成鉴权", () => {
  expect(
    authenticateRealtimeUpgrade(
      {
        url: `/v1/realtime?session_id=${fixture.session_id}`,
        headers: { authorization: `Bearer ${fixture.token}` },
      },
      options(),
    ),
  ).toEqual({ ok: true, sessionId: fixture.session_id });
});

test("Bearer 与 browser subprotocol 凭据冲突时 fail-closed", () => {
  const other = `${fixture.token.slice(0, -1)}A`;
  expect(
    authenticateRealtimeUpgrade(
      {
        url: `/v1/realtime?session_id=${fixture.session_id}`,
        headers: {
          authorization: `Bearer ${fixture.token}`,
          "sec-websocket-protocol": [
            "realtime",
            `openai-insecure-api-key.${other}`,
            "openai-agents-sdk.0.14.2",
          ].join(", "),
        },
      },
      options(),
    ),
  ).toEqual({ ok: false, status: 401, code: "auth_failed" });
});

test("token 绑定 session 与 query session 不一致时 403", () => {
  expect(
    authenticateRealtimeUpgrade(
      {
        url: "/v1/realtime?session_id=sess_other",
        headers: { authorization: `Bearer ${fixture.token}` },
      },
      options(),
    ),
  ).toEqual({
    ok: false,
    status: 403,
    code: "credential_binding_mismatch",
  });
});

test("query 中出现 secret 一律拒绝", () => {
  for (const query of [
    `api_key=${fixture.token}`,
    `model=${encodeURIComponent(`Bearer ${fixture.token}`)}`,
    `model=${encodeURIComponent(` ${fixture.token}`)}`,
  ]) {
    expect(
      authenticateRealtimeUpgrade(
        {
          url: `/v1/realtime?session_id=${fixture.session_id}&${query}`,
          headers: { authorization: `Bearer ${fixture.token}` },
        },
        options(),
      ),
    ).toEqual({ ok: false, status: 401, code: "auth_failed" });
  }
});

test("query 只允许单个 session_id 与可选单个非空 model", () => {
  expect(
    authenticateRealtimeUpgrade(
      {
        url: `/v1/realtime?session_id=${fixture.session_id}&model=viva-managed`,
        headers: { authorization: `Bearer ${fixture.token}` },
      },
      options(),
    ),
  ).toEqual({ ok: true, sessionId: fixture.session_id });

  for (const query of [
    "foo=bar",
    "instructions=override",
    "model=",
    "model=first&model=second",
  ]) {
    expect(
      authenticateRealtimeUpgrade(
        {
          url: `/v1/realtime?session_id=${fixture.session_id}&${query}`,
          headers: { authorization: `Bearer ${fixture.token}` },
        },
        options(),
      ),
    ).toEqual({ ok: false, status: 400, code: "invalid_request" });
  }
});

test("凭据有效但 context 未恢复时返回可重试 not_ready", () => {
  expect(
    authenticateRealtimeUpgrade(
      {
        url: `/v1/realtime?session_id=${fixture.session_id}`,
        headers: { authorization: `Bearer ${fixture.token}` },
      },
      options(false),
    ),
  ).toEqual({
    ok: false,
    status: 503,
    code: "not_ready",
    retryAfter: 1,
  });
});

test("重复 Authorization 或 subprotocol header 形态 fail-closed", () => {
  expect(
    authenticateRealtimeUpgrade(
      {
        url: `/v1/realtime?session_id=${fixture.session_id}`,
        headers: {
          authorization: [
            `Bearer ${fixture.token}`,
            `Bearer ${fixture.token}`,
          ],
        },
      },
      options(),
    ),
  ).toEqual({ ok: false, status: 401, code: "auth_failed" });
  expect(
    authenticateRealtimeUpgrade(
      {
        url: `/v1/realtime?session_id=${fixture.session_id}`,
        headers: {
          "sec-websocket-protocol": [
            "realtime",
            `openai-insecure-api-key.${fixture.token}`,
          ],
        },
      },
      options(),
    ),
  ).toEqual({ ok: false, status: 400, code: "invalid_request" });
});
