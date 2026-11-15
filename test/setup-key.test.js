import assert from 'node:assert/strict';
import test from 'node:test';
import { collectWorkerSecrets, missingProviderKey } from '../scripts/setup.ts';

const opencode = { needsKey: true };
const cloudflare = { needsKey: false };

test('a key-requiring provider is missing its key when the line is empty or absent', () => {
  for (const vars of [
    new Map(),
    new Map([['OPENCODE_API_KEY', '']]),
    new Map([['AI_API_KEY', '   ']]),
    new Map([['OPENCODE_API_KEY', 'replace-with-your-key']]),
  ]) {
    assert.deepEqual(missingProviderKey(opencode, vars), ['AI_API_KEY', 'OPENCODE_API_KEY']);
  }
});

test('one non-empty key, including the legacy alias, satisfies the provider', () => {
  assert.deepEqual(missingProviderKey(opencode, new Map([['AI_API_KEY', 'k']])), []);
  assert.deepEqual(missingProviderKey(opencode, new Map([['OPENCODE_API_KEY', 'legacy']])), []);
});

test('the binding provider needs no key', () => {
  assert.deepEqual(missingProviderKey(cloudflare, new Map()), []);
});

test('blank and placeholder secret values are not uploaded', () => {
  const secrets = collectWorkerSecrets(
    new Map([
      ['APP_PASSWORD', 'pw'],
      ['APP_SECRET', ''],
      ['SHARE_TOKEN', '   '],
      ['AI_API_KEY', 'replace-with-your-key'],
      ['OPENCODE_API_KEY', 'real-key'],
    ]),
  );
  assert.deepEqual(secrets, { APP_PASSWORD: 'pw', OPENCODE_API_KEY: 'real-key' });
});
