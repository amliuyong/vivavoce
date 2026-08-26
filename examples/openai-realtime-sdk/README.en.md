# Viva OpenAI Realtime SDK WebSocket Example

[中文](README.md)

This example uses the unmodified official `@openai/agents-realtime@0.14.2`
built-in WebSocket transport. Its compatibility claim is intentionally limited
to:

> **OpenAI Realtime SDK WebSocket-compatible subset**

It is not full OpenAI Realtime API compatibility or a drop-in replacement.

## Install

```bash
npm install
export VIVA_API_BASE=https://voice.example.com
export VIVA_API_KEY=aimk_...
export VIVA_SESSION_ID=sess_...
```

The API key needs `sessions:write` and must remain on a trusted backend. The
browser example's Node server exchanges it for a fresh 600-second Viva `ek_`
client secret; the browser never receives the long-lived API key. The client
secret is sent only to the Viva WebSocket URL, never in the query string or to
`api.openai.com`.

## Node PCM Pipeline

The Node example reads mono PCM16 little-endian 24 kHz from stdin and writes the
same format to stdout. Logs go to stderr.

```bash
arecord -q -f S16_LE -r 24000 -c 1 -d 5 |
  npm run node |
  aplay -q -f S16_LE -r 24000 -c 1
```

It waits for both `response.done` and its application playback sink to drain
before requesting `viva.session.end`. Neither `response.output_audio.done` nor
`response.done` is a user-heard boundary.

## Browser Microphone And Playback

```bash
npm run browser
```

Open `http://127.0.0.1:4173`. The page defaults to Chinese and provides a manual
Chinese/English switch. It captures a mono microphone stream, converts it to
PCM16 little-endian 24 kHz in an AudioWorklet, and sends it with
`RealtimeSession.sendAudio()`. It schedules received 24 kHz PCM in a Web Audio
sink and immediately stops and clears scheduled sources on
`viva.playback.clear`.

“End session” sends `viva.session.end` and waits for `viva.session.ended`.
“Disconnect” calls SDK `close()` and only tears down the transport.

## Unsupported In R1

WebRTC, tools/function calling, handoff, hosted MCP, image, non-PCM codecs,
OOB/concurrent responses, arbitrary conversation history mutation, and client
overrides of the Viva Agent, questions, rubric, model, voice, or turn detection.
