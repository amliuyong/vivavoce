# Public release checklist

Do not create or push the public repository until every blocking item is
complete and recorded outside the source tree.

## 1. Authorization and ownership

- [ ] Written authorization exists to publish the source.
- [ ] The copyright holder in `LICENSE` and `NOTICE` is correct.
- [ ] Every bundled source file, model component, voice asset, image, font, and
      generated artifact has a documented redistribution basis.
- [ ] Model weights are excluded from Git and are distributed separately only
      when their terms permit it.
- [ ] Third-party notices match the exact vendored content.

## 2. Clean source snapshot

- [ ] The public repository was initialized independently.
- [ ] No private `.git` directory, commit, tag, branch, reflog, pull-request
      ref, release, or Git LFS object was copied.
- [ ] The first public commit is made from the reviewed source allow-list.
- [ ] No `git push --mirror`, history-filtered clone, or private remote is used
      as the public repository's seed.
- [ ] The public repository contains no remote that points to the private
      repository.

Recommended checks before the first commit:

```bash
git remote -v
git status --short
find . -name .git -type d -print
```

After the first commit:

```bash
git rev-list --all --count
git log --all --decorate --oneline
git fsck --full --no-reflogs
```

## 3. Secrets and environment identifiers

- [ ] `.env` and `.env.region` are ignored and absent from Git.
- [ ] Only placeholder `.env.example` and `.env.region.example` are tracked.
- [ ] No AWS access key, API token, password, private key, certificate, cookie,
      presigned URL, webhook secret, or join credential is present.
- [ ] No production domain, account ID, hosted-zone ID, user-pool ID, client ID,
      resource ARN, IP address, email address, image tag, bucket name, or
      internal repository URL remains.
- [ ] Source, documentation, tests, fixtures, SVG metadata, notebooks, archives,
      and binary strings were scanned.
- [ ] The complete Git object database was scanned after the first commit.
- [ ] Any credential ever exposed during preparation was revoked, not merely
      deleted from a file.

Use at least two independent scanners, including one that scans Git history.
Treat scanner suppressions as reviewed code.

Before the first commit, install Gitleaks and TruffleHog and run:

```bash
./scripts/scan-secrets.sh
```

The script scans only tracked and non-ignored candidate files. It never includes
local `.env` files or ignored deployment assets and never prints a detected
secret value. After the first commit, scan the complete Git history too:

```bash
./scripts/scan-secrets.sh --history
```

## 4. Documentation and examples

- [ ] README describes the current public product, not private project history.
- [ ] Deployment documentation starts from a new account and placeholder
      configuration.
- [ ] Commands use `scripts/viva` and the public `.env` contract.
- [ ] Examples use reserved domains and synthetic identifiers.
- [ ] Internal runbooks, incident notes, live validation evidence, private
      research, and employee-only presentation material are absent.
- [ ] Links resolve within the public tree or to intentional public sources.

## 5. Build and supply chain

- [ ] Lock files are present and installs use locked modes.
- [ ] Unit, integration, build, and CDK synthesis checks pass from a clean
      checkout.
- [ ] Dependency vulnerability and license reports are reviewed.
- [ ] Container base images and external actions are version-pinned.
- [ ] CI runs with read-only default permissions and no production secrets.
- [ ] A dependency update policy and security-reporting path are documented.

## 6. First public push

- [ ] The destination repository starts private or empty while final checks run.
- [ ] Branch protection, required reviews, secret scanning, and push protection
      are enabled before broad collaboration.
- [ ] The reviewed local commit hash is the commit pushed.
- [ ] A fresh clone of the destination passes the release checks.
- [ ] The deployed environment is cut over to artifacts built from the public
      repository.

## 7. Retire the private repository

Only after public CI, deployment, smoke tests, and team cutover succeed:

- [ ] Change all developer remotes and automation to the public repository.
- [ ] Disable private-repository deploy keys, webhooks, runners, and write
      credentials that are no longer needed.
- [ ] Make the private repository read-only and archive it while keeping it
      private.
- [ ] Preserve it only for authorized historical and audit access.
- [ ] Record the public commit and deployment used for the cutover.

Archiving the private repository is the final step, not a substitute for
revoking credentials or verifying the public repository.
