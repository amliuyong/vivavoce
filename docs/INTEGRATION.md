# Integration

The generated OpenAPI document at `backend/openapi.json` is the authoritative
REST contract. This guide explains credential ownership and the typical flow;
it does not contain deployment-specific endpoints or IDs.

## Credential choices

| Credential | Intended holder | Scope |
|---|---|---|
| User access token | Browser or trusted user client | Authenticated user permissions |
| API key | Integration server only | Explicit machine scopes |
| Delegated token | User-authorized agent | The delegating user's allowed actions |
| Join token | Voice client | One session for a short period |
| Realtime client secret | Supported realtime SDK client | One session for a short period |

Long-lived API keys must never be shipped in a browser bundle, mobile
application, desktop package, or public example.

## Machine integration

An administrator creates an integration client and selects the minimum
required scopes. The plaintext API key is returned once and should be stored in
the integration's secret manager.

Example request shape:

```http
POST https://voice.example.com/api/integration/sessions
X-Api-Key: <server-side-api-key>
Idempotency-Key: <caller-generated-unique-value>
Content-Type: application/json

{
  "agent_id": "agent_example",
  "question_bank_id": "question_bank_example"
}
```

Use an idempotency key for retried create operations. A machine client may only
read or join resources allowed by its scopes and ownership rules.

## Voice client flow

1. A trusted backend creates or selects a Session.
2. The trusted backend requests a short-lived join credential.
3. The backend sends only that short-lived credential and the WebSocket URL to
   the voice client over TLS.
4. The voice client connects and follows
   [the realtime protocol](REALTIME-WS-PROTOCOL.md).
5. The trusted backend reads results or receives an authenticated webhook.

Join credentials are bearer credentials. Do not place them in analytics,
crash reports, screenshots, URLs that third parties receive, or persistent
client storage.

## Webhooks

Webhook endpoints must use HTTPS. Receivers should:

- verify the message signature over the raw request body;
- compare signatures in constant time;
- deduplicate by event ID;
- return quickly and process asynchronously;
- tolerate repeated delivery;
- rotate webhook secrets without logging them.

## Realtime SDK compatibility

Compatibility is limited to the version and transport documented by the
realtime contract and example under `examples/openai-realtime-sdk/`. A
VivaVoce-issued short-lived secret is not an OpenAI API key and must only be
sent to the URL returned by the VivaVoce deployment.

## Public examples

All examples use reserved domains such as `example.com` and synthetic
identifiers. Replace them only in local `.env` or `.env.region` files. Do not
submit documentation changes containing values copied from a live deployment.
