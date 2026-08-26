<p align="center">
  <img src="docs/assets/vivavoce-mark.svg" width="128" alt="VivaVoce project icon">
</p>

<h1 align="center">VivaVoce</h1>

<p align="center">
  <strong>Open-source, self-hosted infrastructure for real-time, voice-first assessments.</strong>
</p>

<p align="center">
  Define an agent, attach a question bank, run a natural spoken session, and produce a structured result.
</p>

<p align="center">
  <a href="https://github.com/amliuyong/vivavoce/actions/workflows/ci.yml"><img src="https://github.com/amliuyong/vivavoce/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0b7285.svg" alt="Apache-2.0 license"></a>
  <a href="SECURITY.md"><img src="https://img.shields.io/badge/security-policy-0f172a.svg" alt="Security policy"></a>
</p>

VivaVoce combines a browser client, an authenticated control plane, a
low-latency real-time service, private GPU speech inference, configurable LLM
access, and asynchronous evaluation in one deployable system.

The domain model is deliberately general. Interviews, examinations, training,
coaching, and simulations are expressed through configuration and policy
rather than separate application forks.

> **Project status:** the default branch is the active development line.
> Interfaces may evolve before the first stable, versioned release.

## Why VivaVoce

- **Voice-native interaction** — streaming ASR and TTS, turn-taking,
  interruption handling, and playback settlement are first-class concerns.
- **Reusable assessment model** — Agents, Question Banks, Sessions, and Results
  remain independent of a single assessment use case.
- **Self-hosted trust boundaries** — public, control-plane, real-time, GPU, and
  event-processing responsibilities are separated.
- **Provider flexibility** — model and speech providers are selected through
  deployment configuration instead of browser-shipped credentials.
- **Portable configuration** — account IDs, domains, resource IDs, active image
  tags, and secrets stay outside the source tree.
- **Public-release guardrails** — CI runs the complete test suite plus repository
  and Git-history secret scans.

## Core model

| Concept | Responsibility |
|---|---|
| **Agent** | Persona, instructions, scoring rubric, and voice behavior |
| **Question Bank** | Reusable questions and reference material |
| **Session** | An immutable snapshot of the inputs used for one conversation |
| **Result** | Structured asynchronous evaluation of the completed session |

## Architecture

![VivaVoce architecture overview](docs/architecture-overview.svg)

An authorized client creates a Session through the control plane and receives
a short-lived join credential. The real-time service then coordinates audio,
speech inference, LLM output, synthesized playback, and interruption state.
Terminal events are persisted and evaluated asynchronously.

The browser never receives long-lived machine credentials, and the GPU speech
service is not internet-facing. See the [architecture guide](docs/HLD.md) for
component ownership, data flow, persistence, and trust boundaries.

## Quick start

### Prerequisites

For local development:

- Python 3.12+
- Node.js 20.19+, 22.13+, or 24+
- npm

AWS CLI, an authenticated AWS profile, Docker, a Route 53 domain, and GPU quota
are additionally required for an AWS deployment.

### Install and test

```bash
git clone https://github.com/amliuyong/vivavoce.git
cd vivavoce

cp .env.example .env
cp .env.region.example .env.region
chmod 600 .env .env.region

./scripts/viva doctor
./scripts/viva bootstrap
./scripts/viva test
```

`doctor` verifies the local toolchain, file permissions, and ignored
configuration without printing configuration values.

### Synthesize or deploy

Populate the two local environment files, review the
[deployment guide](docs/DEPLOYMENT.md), and synthesize the AWS CDK application:

```bash
./scripts/viva synth
```

When the synthesized changes and active AWS identity are correct:

```bash
./scripts/viva deploy
```

Do not put AWS access keys in either environment file. Prefer IAM Identity
Center, an assumed role, or a named AWS CLI profile.

## Configuration and secrets

Only the templates are tracked:

| Local file | Purpose | Git status |
|---|---|---|
| `.env` | Common settings and optional provider credentials | Ignored; mode `600` required |
| `.env.region` | AWS account, region, domain, identity, and GPU settings | Ignored; mode `600` required |
| `.env.example` | Safe common configuration template | Tracked |
| `.env.region.example` | Safe regional configuration template | Tracked |

Never commit credentials, presigned URLs, deployment identifiers, recordings,
transcripts, model weights, generated reports, or live test evidence.
Reference-voice files are local deployment assets under
`gpu/gpu_service/assets/voices/` and are ignored by Git.

## Repository map

| Path | Responsibility |
|---|---|
| `backend/` | FastAPI control plane, authorization, Sessions, Results, and integrations |
| `bridge/` | Real-time WebSocket orchestration, LLM coordination, and audio state |
| `frontend/` | Next.js browser client |
| `gpu/` | Private streaming ASR/TTS service and vendored speech components |
| `infrastructure/` | AWS CDK application and event handlers |
| `contracts/` | Public protocol schemas |
| `examples/` | Client integration examples |
| `uat/` | User-acceptance and governed-path tests |
| `docs/` | Architecture, deployment, integration, and protocol documentation |
| `scripts/` | Local setup, testing, image-build, scanning, and deployment tools |

## Documentation

| Guide | Start here when you want to... |
|---|---|
| [Product vision](docs/VISION.md) | Understand the product boundaries and design principles |
| [Architecture](docs/HLD.md) | Review components, ownership, data flow, and trust boundaries |
| [Requirements](docs/REQUIREMENTS.md) | Inspect functional and operational requirements |
| [Deployment](docs/DEPLOYMENT.md) | Prepare configuration and deploy to AWS |
| [Integration](docs/INTEGRATION.md) | Build a trusted client or server integration |
| [Real-time protocol](docs/REALTIME-WS-PROTOCOL.md) | Implement the WebSocket audio and signaling contract |
| [Public release checklist](docs/PUBLIC_RELEASE_CHECKLIST.md) | Audit a fork or release before publishing it |

The generated [OpenAPI document](backend/openapi.json) is the authoritative
REST contract.

## Contributing

Contributions are welcome. Create a focused branch, keep deployment-specific
information out of commits and pull requests, and run:

```bash
./scripts/public-scan.sh
./scripts/viva test
```

`main` is protected: changes are merged through pull requests after the
required public scan and test checks pass. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

## Security and responsible use

Do not open a public issue containing exploit details, credentials, personal
data, recordings, transcripts, or deployment identifiers. Follow the private
reporting process in [SECURITY.md](SECURITY.md).

Before production use, define consent, retention, deletion, access-control,
model-license, and human-review policies appropriate for the assessment
context and jurisdiction.

## License

VivaVoce is licensed under the [Apache License 2.0](LICENSE). Bundled and
runtime third-party components remain subject to their own terms; see
[NOTICE](NOTICE).
