# Product vision

VivaVoce provides real-time, voice-first assessments without requiring a phone
call or an external meeting. A participant opens a supported client, joins an
authorized session, speaks naturally with an AI agent, and receives a
structured result.

## Product principles

### General domain model

The product is not hard-coded for interviews, examinations, or training. An
Agent and an optional Question Bank define the use case. New use cases should
normally be expressed as data and policy rather than a new application branch.

### Thin clients, authoritative server

Clients capture and play audio, render state, and exchange versioned protocol
messages. Endpoint detection, turn-taking, interruption handling, question
progression, session authorization, and scoring remain server-side so that
different clients behave consistently.

### Explicit trust boundaries

The public entry point terminates TLS and exposes only documented routes.
Control-plane, real-time, GPU, and event-processing components use separate
roles and network boundaries. Every credential and privileged operation must
have an explicit owner and a minimal scope.

### Portable deployment

Environment-specific values are configuration, not source code. The same
source tree should synthesize for supported AWS regions without embedding
account IDs, domains, hosted-zone IDs, identity-provider IDs, or active
resource names.

### Observable real-time behavior

Latency, interruption, playback, capacity, and evaluation state should be
measurable without recording credentials or unnecessarily exposing
conversation content.

## Scope

The current implementation focuses on:

- a browser client;
- real-time WebSocket audio and signalling;
- self-hosted GPU ASR/TTS with an optional external TTS provider;
- configurable LLM access;
- AWS CDK deployment;
- OIDC/Cognito authentication;
- API key, delegated, and short-lived real-time client credentials;
- asynchronous rubric evaluation and result reporting.

Native mobile clients and a WebRTC transport can be added without changing the
Agent, Question Bank, Session, or Result domain model.
