const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.TZ = 'UTC';

const {
  credentialWarning,
  isFutureLocalExpiry,
  loadLlmCredentialStatus,
  localExpiryToUtc,
  utcExpiryToLocalInput,
} = require('../src/lib/llm-credential-expiry.ts');

test('Bedrock expiry input round-trips between local datetime and UTC ISO', () => {
  assert.equal(
    utcExpiryToLocalInput('2026-11-03T14:12:41Z'),
    '2026-11-03T14:12:41',
  );
  assert.equal(
    localExpiryToUtc('2026-11-03T14:12:41'),
    '2026-11-03T14:12:41.000Z',
  );
  assert.equal(utcExpiryToLocalInput(null), '');
  assert.equal(localExpiryToUtc(''), null);
  assert.equal(localExpiryToUtc('not-a-date'), null);
});

test('Bedrock expiry round-trips in a non-UTC browser timezone', () => {
  process.env.TZ = 'Asia/Shanghai';
  try {
    assert.equal(
      utcExpiryToLocalInput('2026-11-03T14:12:41Z'),
      '2026-11-03T22:12:41',
    );
    assert.equal(
      localExpiryToUtc('2026-11-03T22:12:41'),
      '2026-11-03T14:12:41.000Z',
    );
  } finally {
    process.env.TZ = 'UTC';
  }
});

test('Bedrock expiry input must be strictly in the future', () => {
  const nowMs = Date.parse('2026-08-05T14:00:00Z');
  assert.equal(isFutureLocalExpiry('2026-08-05T14:00:01', nowMs), true);
  assert.equal(isFutureLocalExpiry('2026-08-05T14:00:00', nowMs), false);
  assert.equal(isFutureLocalExpiry('2026-08-05T13:59:59', nowMs), false);
  assert.equal(isFutureLocalExpiry('', nowMs), false);
});

test('credential warning maps expiring, expired, missing, normal and failed status', () => {
  const expiring = { status: 'expiring', expires_at: '2026-08-12T14:00:00Z' };
  assert.deepEqual(credentialWarning(expiring, true), {
    tone: 'warning',
    messageKey: 'vc_llm_expiring_admin',
    expiresAt: '2026-08-12T14:00:00Z',
    showManage: true,
  });
  assert.deepEqual(credentialWarning(expiring, false), {
    tone: 'warning',
    messageKey: 'vc_llm_expiring_staff',
    expiresAt: '2026-08-12T14:00:00Z',
    showManage: false,
  });
  assert.equal(credentialWarning({ status: 'expired', expires_at: '2026-08-05T14:00:00Z' }, true)?.tone, 'error');
  assert.equal(credentialWarning({ status: 'not_configured', expires_at: null }, false)?.tone, 'error');
  assert.equal(credentialWarning({ status: 'ok', expires_at: '2026-11-03T14:12:41Z' }, true), null);
  assert.equal(credentialWarning({ status: 'not_applicable', expires_at: null }, true), null);
  assert.equal(credentialWarning(null, true), null);
});

test('credential status request failure degrades to no warning', async () => {
  const state = await loadLlmCredentialStatus(
    async () => { throw new Error('temporary status failure'); },
  );
  assert.equal(state, null);
  assert.equal(credentialWarning(state, true), null);
});

test('replacing a configured Bedrock key requires re-entering its expiry', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/views/TtsSettings.tsx'),
    'utf8',
  );
  assert.match(
    source,
    /function beginBedrockKeyEdit\(\) \{\s*setEditingBedrockKey\(true\);\s*setNewBedrockKey\(''\);\s*setBedrockExpiry\(''\);\s*\}/,
  );
  assert.match(
    source,
    /function cancelBedrockKeyEdit\(\) \{\s*setEditingBedrockKey\(false\);\s*setNewBedrockKey\(''\);\s*setBedrockExpiry\(utcExpiryToLocalInput\(cfg\.bedrock_api_key_expires_at\)\);\s*\}/,
  );
});
