# Deployment

VivaVoce is deployed with AWS CDK through `scripts/viva`. The public workflow
keeps account-specific settings outside Git and performs synthesis before
deployment.

## Prerequisites

- Python 3.12+
- Node.js 20.19+, 22.13+, or 24+
- npm
- AWS CLI
- Docker for local image work
- an AWS profile or IAM Identity Center session with the required permissions
- a Route 53 hosted zone and a domain for HTTPS
- sufficient GPU quota and a supported GPU instance type
- model weights that you are legally permitted to use and distribute

Do not use long-lived AWS access keys in `.env` or `.env.region`.

## Configuration

Create the two ignored local files:

```bash
cp .env.example .env
cp .env.region.example .env.region
chmod 600 .env .env.region
```

`.env` contains:

- stack name and initial administrator email;
- deployment controls;
- optional provider credentials;
- an optional model bootstrap URL.

`.env.region` contains:

- AWS profile, region, and expected account ID;
- domain and hosted-zone identifiers;
- optional external identity-provider identifiers;
- GPU image, instance, architecture, and package-mirror settings.

The real files must not be committed. `scripts/viva` rejects files readable by
group or other users and never prints their values.

Use an expected account ID:

```dotenv
VIVA_EXPECT_ACCOUNT=123456789012
```

The deployment script compares it with the active AWS identity before making
changes. The example above is documentation only; use your own account ID
locally.

## Workstation preparation

```bash
./scripts/viva doctor
./scripts/viva bootstrap
./scripts/viva test
```

`doctor` reports tool versions and whether configuration keys are set, but
redacts all values.

## Model weights and GPU image

Model weights are not part of this repository. Obtain them from their official
sources under terms that permit your use, place them in the deployment's model
bucket, and build a versioned GPU image:

```bash
./scripts/prepare-model-weights.sh
./scripts/build-gpu-image.sh -t <version>
```

If a presigned URL is used for bootstrap, put it in `VIVA_MODEL_WEIGHTS_URL`.
Treat that URL as a credential: keep it in `.env`, do not paste it into an
issue, log, command transcript, or commit, and allow it to expire.

Pin `VIVA_GPU_IMAGE_TAG` for reproducible deployment and rollback. Do not copy a
tag from another environment.

## Reference voices

Reference-voice audio is not distributed in Git. Before building a GPU image
that uses local OmniVoice synthesis, provide authorized matching pairs under:

```text
gpu/gpu_service/assets/voices/<voice-key>.wav
gpu/gpu_service/assets/voices/<voice-key>.txt
gpu/gpu_service/assets/voices/<voice-key>.<language>.wav
gpu/gpu_service/assets/voices/<voice-key>.<language>.txt
```

The text file must be an accurate transcript of its WAV file. These paths are
ignored by Git but are copied into a locally built GPU image. Review the voice,
provider, consent, and redistribution terms before building or publishing that
image.

## Synthesis

Run an offline CDK synthesis before deployment:

```bash
./scripts/viva synth
```

review
placeholder domain values when the local regional file is absent; deployment
does not.

## Deploy

Verify the active identity:

```bash
aws sts get-caller-identity --profile <profile> --region <region>
```

Then deploy:

```bash
./scripts/viva deploy
```

By default, deployment runs its test gate and requires interactive approval for
security-sensitive changes. Set `VIVA_AUTO_APPROVE=1` or
`VIVA_SKIP_TESTS=1` only for a deliberately controlled automation context.

## Post-deployment checks

At minimum:

1. confirm the CloudFormation stack reaches a complete state;
2. open the HTTPS entry point and verify authentication;
3. verify backend and real-time health routes;
4. verify GPU readiness with the intended non-stub model image;
5. create a test Agent, Question Bank, and Session;
6. complete one real microphone conversation;
7. verify transcript, recording policy, evaluation, and result authorization;
8. verify logs and metrics contain no credentials.

Store environment-specific evidence outside Git.

## Rollback

Prefer a forward deployment that pins the last known-good application and GPU
image versions. review
rollback. Back up retained data first.

Resource destruction is intentionally not exposed through `scripts/viva`.
Destroying a stack and deleting retained S3, ECR, or model data are separate,
explicit operational decisions.
