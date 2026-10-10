import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession } from '../lib/auth.ts';

const SECRET = 'test-secret';

test('signed session verifies with the same secret', async () => {
  const t = await signSession(SECRET, 1_000_000);
  assert.equal(await verifySession(t, SECRET, 1_000_000 + 1000), true);
});

test('session fails with another secret', async () => {
  const t = await signSession(SECRET, 1_000_000);
  assert.equal(await verifySession(t, 'other', 1_000_000), false);
});

test('tampered expiry is rejected', async () => {
  const t = await signSession(SECRET, 1_000_000);
  const [exp, sig] = t.split('.');
  assert.equal(await verifySession(`${Number(exp) + 1}.${sig}`, SECRET, 1_000_000), false);
});

test('session expires after 30 days', async () => {
  const t = await signSession(SECRET, 0);
  assert.equal(await verifySession(t, SECRET, 30 * 24 * 3600 * 1000 + 1), false);
});

test('missing or malformed token is rejected', async () => {
  assert.equal(await verifySession(undefined, SECRET), false);
  assert.equal(await verifySession('garbage', SECRET), false);
});
