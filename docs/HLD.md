# Architecture

## System context

VivaVoce separates four concerns:

1. **Client** — captures and plays audio, renders state, and uses documented
   REST/WebSocket contracts.
2. **Control plane** — owns users, Agents, Question Banks, Sessions, Results,
   authorization, and integrations.
3. **Real-time plane** — owns active session state, turn-taking, LLM
   orchestration, interruption, and audio routing.
4. **Speech and event plane** — performs GPU ASR/TTS and asynchronous result
   evaluation.

![Architecture overview](architecture-overview.svg)

## Component ownership

### Frontend

`frontend/` is a static Next.js application served behind the public entry
point. It does not hold long-lived machine credentials. Runtime configuration
contains only browser-safe values.

### Control plane

`backend/` is a FastAPI service. It owns the durable domain model, validates
authorization, creates frozen session inputs, issues short-lived join
credentials, receives session events, and exposes results.

### Real-time service

`bridge/` is a Node.js service. A connection is associated with one authorized
Session. The service coordinates ASR, LLM output, TTS, playback settlement,
barge-in, transcript events, and terminal state. It does not own durable user
or configuration records.

### GPU speech service

`gpu/` exposes private health, readiness, control, and streaming speech
interfaces. Model loading and readiness are distinct from process liveness.
The service is not internet-facing and has no reason to hold broad data-plane
or control-plane permissions.

### Event processing

Handlers under `infrastructure/lambda/` process durable events such as session
completion and evaluation. Event consumers are idempotent because delivery may
be repeated.

### Infrastructure

`infrastructure/` defines network boundaries, TLS entry, compute, storage,
identity, observability, and event wiring in AWS CDK.

## Main data flow

1. An authorized caller creates a Session through the control plane.
2. The control plane freezes the Agent, question, and policy inputs.
3. The client obtains a short-lived credential and connects to the real-time
   service.
4. The real-time service sends participant audio to the private speech service.
5. Finalized text is sent to the configured LLM; generated text is synthesized
   and streamed back to the client.
6. Terminal session events and transcripts are stored through the control
   plane.
7. Completion triggers asynchronous evaluation and result creation.

## Trust boundaries

| Boundary | Rule |
|---|---|
| Internet to public entry | TLS; documented routes only; WAF and application authorization |
| Client to control plane | User token, integration key, or delegated credential |
| Client to real-time plane | Short-lived, session-scoped credential |
| Control plane to real-time plane | Private service discovery and shared-service authentication |
| Real-time plane to GPU | Private network and service authentication |
| Services to AWS | Separate least-privilege IAM roles |
| Services to model providers | Credentials loaded from managed secrets and never logged |

## Persistence

Durable records use DynamoDB and S3. Model weights, generated build artifacts,
local environment files, test evidence, recordings, and reports do not belong
in Git. Retention policies for recordings and transcripts are deployment
decisions and must be configured before production use.

## Deployment portability

No AWS account ID, hosted-zone ID, user-pool ID, client ID, production domain,
active image tag, or credential is a source-code default. Local deployment
configuration is loaded from `.env` and `.env.region`; CDK context is assembled
by `scripts/viva` and `scripts/deploy-aws.sh`.

The current deployment guard supports the regions listed by the deployment
script and CDK entry point. Adding another region requires verifying service
availability, GPU capacity, model-provider access, identity behavior, and data
residency rather than only extending an allow-list.
