# Three-stage speech pipeline

VivaVoce's real-time voice path separates speech recognition, language
generation, and speech synthesis:

```text
client PCM
   → streaming ASR and endpoint detection
   → finalized participant text
   → streaming LLM response
   → sentence-level TTS
   → client PCM playback
```

This separation keeps the public session protocol independent of a particular
model provider.

## ASR and endpoint detection

The private GPU service accepts 16 kHz mono signed 16-bit PCM. Streaming ASR
produces partial text for responsiveness. At a turn boundary, final ASR runs on
the buffered utterance and produces the text used by the LLM.

Energy-based VAD provides the normal turn boundary. The real-time service also
maintains a bounded endpoint watchdog so a missing GPU boundary cannot leave a
session permanently silent. Thresholds and silence windows have guarded
relationships; changing one requires running both GPU and real-time tests.

Implementation:

- `gpu/gpu_service/vad.py`
- `gpu/gpu_service/funasr_backend.py`
- `bridge/src/media-session.ts`
- `bridge/src/turn-handling.ts`

## LLM generation

The real-time service calls the configured LLM. Provider host, method, model
catalog, and credentials are deployment/runtime configuration. Credentials
are injected into the active session path, are not persisted with transcripts,
and must not be logged.

Generated text is streamed into sentence-sized TTS requests. Terminal and
question-progression signals are removed before user-visible text or audio is
emitted.

Implementation:

- `bridge/src/mantle-llm.ts`
- `bridge/src/bedrock-converse-llm.ts`
- `bridge/src/three-stage-engine.ts`
- `bridge/src/prompt-compose.ts`

## TTS

The GPU service synthesizes speech with a configured voice key. Audio is
converted to the public 16 kHz PCM contract before it is sent to the client.
Reference-voice assets are local deployment inputs and are not part of the Git
source distribution. Operators must provide audio and matching transcripts
that they are authorized to use.

An optional external TTS provider is configured through the administrative
control plane and a managed secret. Provider failure must end the affected
output cleanly rather than leave the session in a permanent speaking state.

Implementation:

- `gpu/gpu_service/funasr_backend.py`
- `gpu/gpu_service/minimax_tts.py`
- `gpu/gpu_service/engines.py`

## Interruption and stale-output control

Participant speech may interrupt active output. Cancellation is propagated to
the current LLM/TTS generation, queued client audio is flushed, and late
messages from the cancelled generation are discarded by generation identity.

The key invariant is that an older turn cannot emit text, PCM, completion, or
playback state into a newer turn.

## Capacity

Each GPU instance has an explicitly configured session limit derived from
measurement on that exact model and instance combination. A different GPU
type requires new latency, real-time-factor, memory, and concurrency
measurements; copying another environment's value is unsafe.

The control-plane admission limit uses serviceable capacity. Desired instance
count alone is not proof that models are loaded or that an instance is ready.

## Model weights

Weights are not stored in Git. `./scripts/viva models` uploads a licensed local
bundle or a short-lived archive from `.env` to the deployment's private model
bucket. `./scripts/viva gpu-image -t <tag>` then builds a versioned image.

See [Deployment](DEPLOYMENT.md) and [Architecture](HLD.md).
