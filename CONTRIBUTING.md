# Contributing

Before submitting a change:

```bash
./scripts/public-scan.sh
./scripts/viva test
```

Keep deployment-specific values out of source, tests, screenshots, fixtures,
issues, and pull requests. Use reserved domains and synthetic identifiers.

Do not commit:

- `.env`, `.env.region`, credentials, certificates, cookies, or presigned URLs;
- model weights, recordings, transcripts, reports, or live test evidence;
- account IDs, hosted-zone IDs, identity-provider IDs, production endpoints,
  resource ARNs, or active image tags from a real environment;
- copied code or assets without a redistribution basis.

Update the owning module's tests and public documentation when behavior or a
contract changes. Run dependency installation in locked mode and avoid adding
an unpinned CI action or container image.
