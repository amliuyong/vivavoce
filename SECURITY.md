# Security policy

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, personal
data, or deployment identifiers.

Use GitHub private vulnerability reporting when it is enabled for the public
repository. Include:

- the affected component and version or commit;
- reproduction steps with synthetic data;
- expected and observed impact;
- suggested mitigations, if known.

Do not test against a deployment you do not own or have explicit permission to
assess.

## Credentials

If a credential or presigned URL is exposed, revoke or rotate it immediately.
Deleting it from the current file is not sufficient because it may exist in
Git objects, CI logs, caches, artifacts, forks, or notifications.

Local configuration belongs in `.env` and `.env.region`, both ignored by Git
and restricted to the current user.

## Secret-scanner suppressions

Scanner exceptions must be narrow, documented, and independently reviewed.
`.gitleaks.toml` permits only specific synthetic test/signing lines and an RFC
WebSocket nonce. `.trufflehog-exclude-paths` excludes one test module whose
purpose is to exercise credential-shaped-value redaction; Gitleaks and the
repository's public scan still inspect that module.

## Supported versions

Security fixes are applied to the current default branch. A formal release
support matrix will be added when versioned public releases begin.
