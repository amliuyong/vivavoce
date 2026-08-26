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

Synthesis may use placeholder domain values when the local regional file is
absent; deployment does not.

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

## Exact-commit remote deployment

For environments where images must be built inside the target region, keep the
remote host and paths in the ignored `.env.region` file:

```dotenv
VIVA_REMOTE_HOST=regional-builder
VIVA_REMOTE_BASE_DIR=/srv/vivavoce/releases
VIVA_REMOTE_ACTIVE_LINK=/srv/vivavoce/current
VIVA_REMOTE_CONFIG_DIR=/srv/vivavoce/current
VIVA_REMOTE_E2E_WAV=/srv/vivavoce/test-audio.wav
VIVA_REMOTE_REQUIRE_CI=1
```

The remote configuration directory must already contain private, mode-`600`
`.env` and `.env.region` files. Each release copies those files into a new
exact-commit directory; configuration is never added to the Git archive.
Remote updates require the stack to exist already and require a pinned
`VIVA_GPU_IMAGE_TAG`, so a plan cannot silently become a new stack or select a
different image between planning and deployment.

Generate a real account-bound CloudFormation plan without deploying:

```bash
./scripts/viva remote-deploy
```

After reviewing the plan, execute it explicitly:

```bash
./scripts/viva remote-deploy --yes
```

The command:

1. requires a clean worktree and, by default, successful CI for `origin/main`;
2. transfers a checksum-verified `git archive` to a new remote release;
3. checks the AWS account, GPU availability, and in-progress sessions;
4. blocks resource deletion, non-ECS replacement, IAM changes, and security
   group changes unless separately authorized;
5. runs the normal test and deployment gates on the remote host;
6. waits for CloudFormation, ECS, target health, and old-target draining;
7. verifies `/health`, the deployed playback worklet, runtime flags, and an
   optional real audio session;
8. writes `.deployment-evidence.json`, then atomically updates the active
   symlink only after all checks pass.

CDK plan artifacts are written to a private sibling directory outside the
release source tree. This prevents Docker asset contexts from recursively
copying the plan into themselves.

Use `--allow-security-changes` or `--allow-destructive` only after reviewing the
generated plan. Use `--skip-e2e` only when a controlled environment cannot
provide a non-sensitive test WAV and scoped server-side E2E key.

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
image versions. Review the CloudFormation change set before any rollback, and
back up retained data first.

Resource destruction is intentionally not exposed through `scripts/viva`.
Destroying a stack and deleting retained S3, ECR, or model data are separate,
explicit operational decisions.
