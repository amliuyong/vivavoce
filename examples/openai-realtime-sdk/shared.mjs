const RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000];

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function issueRealtimeClientSecret({
  apiBase,
  apiKey,
  sessionId,
  fetchImpl = fetch,
}) {
  const base = requireString(apiBase, "VIVA_API_BASE").replace(/\/+$/, "");
  const response = await fetchImpl(
    `${base}/api/integration/sessions/${encodeURIComponent(
      requireString(sessionId, "VIVA_SESSION_ID"),
    )}/realtime-client-secret`,
    {
      method: "POST",
      headers: {
        "X-Api-Key": requireString(apiKey, "VIVA_API_KEY"),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`client-secret request failed with HTTP ${response.status}`);
  }
  const credentials = await response.json();
  if (
    typeof credentials?.value !== "string" ||
    !credentials.value.startsWith("ek_") ||
    typeof credentials?.expires_at !== "number" ||
    typeof credentials?.url !== "string"
  ) {
    throw new Error("client-secret response has an invalid shape");
  }
  const endpoint = new URL(credentials.url);
  if (!["ws:", "wss:"].includes(endpoint.protocol)) {
    throw new Error("client-secret response URL must use ws or wss");
  }
  if (endpoint.searchParams.has("api_key") || endpoint.searchParams.has("client_secret")) {
    throw new Error("client-secret response URL must not contain credentials");
  }
  return credentials;
}

export async function connectWithFreshSecret({
  createSession,
  issueCredentials,
  onRetry = () => undefined,
}) {
  let lastError;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    const delayMs = RETRY_DELAYS_MS[attempt];
    if (delayMs > 0) {
      onRetry({ attempt, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    let session;
    try {
      const credentials = await issueCredentials();
      session = createSession();
      await session.connect({
        apiKey: credentials.value,
        url: credentials.url,
        model: "gpt-realtime-2.1",
      });
      return session;
    } catch (error) {
      lastError = error;
      session?.close();
    }
  }
  throw lastError ?? new Error("Realtime connection failed before open");
}
