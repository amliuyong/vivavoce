import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { issueRealtimeClientSecret } from "./shared.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(root, "public");
const sdkBundle = resolve(
  root,
  "node_modules/@openai/agents-realtime/dist/bundle/openai-realtime-agents.umd.js",
);
const port = Number(process.env.PORT ?? "4173");

const assets = new Map([
  ["/", [resolve(publicRoot, "index.html"), "text/html; charset=utf-8"]],
  ["/app.js", [resolve(publicRoot, "app.js"), "text/javascript; charset=utf-8"]],
  [
    "/mic-worklet.js",
    [resolve(publicRoot, "mic-worklet.js"), "text/javascript; charset=utf-8"],
  ],
  ["/shared.mjs", [resolve(root, "shared.mjs"), "text/javascript; charset=utf-8"]],
]);

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "POST" && url.pathname === "/realtime-bootstrap") {
      const credentials = await issueRealtimeClientSecret({
        apiBase: process.env.VIVA_API_BASE,
        apiKey: process.env.VIVA_API_KEY,
        sessionId: process.env.VIVA_SESSION_ID,
      });
      send(response, 200, JSON.stringify(credentials), "application/json");
      return;
    }
    if (request.method === "GET" && url.pathname === "/sdk.js") {
      send(
        response,
        200,
        await readFile(sdkBundle),
        "text/javascript; charset=utf-8",
      );
      return;
    }
    const asset = assets.get(url.pathname);
    if (request.method !== "GET" || !asset) {
      send(response, 404, "not found");
      return;
    }
    send(response, 200, await readFile(asset[0]), asset[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(response, 502, message);
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`browser example: http://127.0.0.1:${port}\n`);
});
