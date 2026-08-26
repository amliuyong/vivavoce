import { RealtimeAgent, RealtimeSession } from "@openai/agents-realtime";
import {
  connectWithFreshSecret,
  issueRealtimeClientSecret,
} from "./shared.mjs";

const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;

class Pcm24kPlaybackSink {
  #queue = [];
  #active = false;
  #timer;
  #idleWaiters = [];

  enqueue(arrayBuffer) {
    const chunk = Buffer.from(arrayBuffer);
    if (chunk.length === 0 || chunk.length % BYTES_PER_SAMPLE !== 0) {
      throw new Error("server audio must be non-empty 24 kHz PCM16 little-endian");
    }
    this.#queue.push(chunk);
    this.#pump();
  }

  clear() {
    this.#queue = [];
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#active = false;
    this.#notifyIdle();
  }

  waitForIdle() {
    if (!this.#active && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #pump() {
    if (this.#active) return;
    const chunk = this.#queue.shift();
    if (!chunk) {
      this.#notifyIdle();
      return;
    }
    this.#active = true;
    process.stdout.write(chunk, (error) => {
      if (error) {
        process.stderr.write(`playback sink failed: ${error.message}\n`);
        this.clear();
        return;
      }
      const durationMs =
        (chunk.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1_000;
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#active = false;
        this.#pump();
      }, durationMs);
    });
  }

  #notifyIdle() {
    if (this.#active || this.#queue.length > 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

const sink = new Pcm24kPlaybackSink();
let responseWireDone;
let resolveResponseWireDone;
let businessResult;
let resolveBusinessResult;

function resetTurnPromises() {
  responseWireDone = new Promise((resolve) => {
    resolveResponseWireDone = resolve;
  });
  businessResult = new Promise((resolve) => {
    resolveBusinessResult = resolve;
  });
}

function createSession() {
  const agent = new RealtimeAgent({
    name: "Viva SDK client",
    instructions: "Viva server configuration is authoritative.",
  });
  const session = new RealtimeSession(agent, {
    transport: "websocket",
    model: "gpt-realtime-2.1",
    tracingDisabled: true,
  });
  session.on("audio", (event) => sink.enqueue(event.data));
  session.on("transport_event", (event) => {
    if (event.type === "viva.playback.clear") sink.clear();
    if (event.type === "response.done") resolveResponseWireDone();
    if (event.type === "viva.exam.incomplete") {
      process.stderr.write("Viva reports that the session is not complete.\n");
      resolveBusinessResult({
        type: "incomplete",
        reason: event.reason ?? "questions_remaining",
      });
    }
    if (event.type === "viva.session.ended") {
      resolveBusinessResult({ type: "ended", reason: event.reason });
    }
  });
  session.on("audio_interrupted", () => sink.clear());
  session.on("error", () => {
    process.stderr.write("Realtime protocol error; inspect server diagnostics.\n");
  });
  return session;
}

async function main() {
  resetTurnPromises();
  const apiBase = process.env.VIVA_API_BASE;
  const apiKey = process.env.VIVA_API_KEY;
  const sessionId = process.env.VIVA_SESSION_ID;
  const session = await connectWithFreshSecret({
    createSession,
    issueCredentials: () =>
      issueRealtimeClientSecret({ apiBase, apiKey, sessionId }),
    onRetry: ({ attempt, delayMs }) => {
      process.stderr.write(
        `pre-open failure; signing a fresh secret for retry ${attempt} in ${delayMs} ms\n`,
      );
    },
  });

  let carry = Buffer.alloc(0);
  for await (const value of process.stdin) {
    const bytes = Buffer.concat([carry, Buffer.from(value)]);
    const alignedLength = bytes.length - (bytes.length % BYTES_PER_SAMPLE);
    if (alignedLength > 0) {
      const chunk = bytes.subarray(0, alignedLength);
      session.sendAudio(
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
      );
    }
    carry = bytes.subarray(alignedLength);
  }
  if (carry.length !== 0) {
    throw new Error("stdin ended with an incomplete PCM16 sample");
  }

  // Commit the audio already sent. For a live stream, server VAD may already
  // have committed the same turn; the adapter converges both paths.
  session.transport.sendEvent({ type: "input_audio_buffer.commit" });
  await responseWireDone;
  await sink.waitForIdle();

  // response.done is only a wire boundary. Business completion is requested
  // after this application's playback sink has drained.
  session.transport.sendEvent({ type: "viva.session.end" });
  const result = await businessResult;
  session.close();
  if (result.type === "incomplete") {
    throw new Error(`Viva did not end the business session: ${result.reason}`);
  }
}

main().catch((error) => {
  sink.clear();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
