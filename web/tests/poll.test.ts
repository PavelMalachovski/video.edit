import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelay } from '../lib/poll.ts';

test('polls every 5 s, waits retryAfter after 429, 15 s after other failures', () => {
  assert.equal(nextDelay({ ok: true }), 5000);
  assert.equal(nextDelay({ ok: false, status: 429, retryAfter: 90 }), 90_000);
  assert.equal(nextDelay({ ok: false, status: 429, retryAfter: 5 }), 30_000); // не чаще раза в 30 с
  assert.equal(nextDelay({ ok: false, status: 429 }), 60_000);
  assert.equal(nextDelay({ ok: false, status: 502 }), 15_000);
  assert.equal(nextDelay({ ok: false, status: 0 }), 15_000); // нет сети
});
