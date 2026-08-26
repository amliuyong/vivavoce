# Infrastructure

The AWS CDK application defines the VivaVoce network, public TLS entry point,
identity resources, control plane, real-time service, private GPU speech
service, durable storage, evaluation handlers, and observability.

The root command is the supported entry point:

```bash
./scripts/viva synth
./scripts/viva deploy
```

Do not call CDK with copied values from another environment. Put common local
configuration in `.env` and account/region-specific configuration in
`.env.region`.

Useful module-level checks:

```bash
cd infrastructure
npm ci
npm run build
npm test
```

The CDK entry point validates the supported region and engine configuration.
The deployment wrapper additionally validates the AWS identity, domain inputs,
GPU capacity prerequisites, and external identity-provider tuple.

Security expectations:

- public routes terminate TLS and use explicit authorization;
- GPU and service-control routes remain private;
- services use separate least-privilege roles;
- secrets come from managed secret stores, not CDK context or source files;
- account IDs, domains, user-pool IDs, and image tags are local configuration;
- a synth and test review
