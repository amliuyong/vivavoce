# Product requirements

This document describes the stable public requirements. Detailed implementation
notes belong close to the owning module and must not contain live environment
data.

## Domain

1. An Agent defines conversation instructions, voice behavior, evaluation
   rubric, and question-selection policy.
2. A Question Bank is reusable and versionable independently of an Agent.
3. A Session freezes the effective Agent and question inputs used for one
   conversation.
4. A Result records machine evaluation and supports authorized human review.
5. A participant, staff user, administrator, and machine integration have
   distinct permissions.

## Real-time session

1. The client authenticates before sending session audio.
2. Audio and signalling use a versioned public contract.
3. The server owns turn-taking, interruption, progression, and completion.
4. A reconnect must not create an unrelated second session.
5. Stale audio, text, or completion events from an older turn must not leak
   into a newer turn.
6. A failure must end in a visible, diagnosable state rather than silent
   success.

## Security

1. Protected REST, WebSocket, and administrative operations fail closed.
2. Long-lived integration keys remain on trusted servers.
3. Browser and device clients receive short-lived, session-scoped credentials.
4. Secrets are stored outside Git and are never written to logs, reports, or
   client configuration.
5. Public deployment identifiers are supplied through local configuration and
   are not copied from a production environment into documentation or tests.
6. GPU inference and internal control endpoints are not directly internet
   accessible.
7. Recorded audio, transcripts, and results follow explicit retention and
   access policies.

## Deployment

1. Infrastructure is declared in AWS CDK.
2. Account and region selection must be explicit and verifiable before deploy.
3. HTTPS and a valid domain are required for browser microphone access.
4. Region-specific values live in `.env.region`; common values live in `.env`.
5. A deployment can be synthesized and tested before making AWS changes.
6. Image and model versions can be pinned for reproducible rollback.

## Operations

1. Health and readiness are separate for services that load models.
2. Capacity admission uses serviceable capacity, not only desired instance
   count.
3. Metrics identify latency stages without including credentials.
4. Deployment and rollback procedures are documented and repeatable.
5. Destructive operations require a deliberate, separate command and are not
   part of the default deployment path.

## Non-goals

- storing AWS access keys in repository-local environment files;
- publishing a deployment's real IDs or endpoints as examples;
- importing the private repository's Git history into the public repository;
- exposing model weights whose distribution rights are not established;
- presenting internal operational evidence as public product documentation.
