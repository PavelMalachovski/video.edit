import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIdle, nextDelay } from '../lib/poll.ts';

test('polls every 5 s, waits retryAfter after 429, 15 s after other failures', () => {
  assert.equal(nextDelay({ ok: true }), 5000);
  assert.equal(nextDelay({ ok: false, status: 429, retryAfter: 90 }), 90_000);
  assert.equal(nextDelay({ ok: false, status: 429, retryAfter: 5 }), 30_000); // не чаще раза в 30 с
  assert.equal(nextDelay({ ok: false, status: 429 }), 60_000);
  assert.equal(nextDelay({ ok: false, status: 502 }), 15_000);
  assert.equal(nextDelay({ ok: false, status: 0 }), 15_000); // нет сети
});

test('nothing is running — once in 30 s: the job changes only when Pavel acts (that polls at once) or a step starts', () => {
  assert.equal(nextDelay({ ok: true, idle: true }), 30_000);
  assert.equal(nextDelay({ ok: true, idle: false }), 5000);
  assert.equal(nextDelay({ ok: false, status: 502 }), 15_000);
});

test('for a minute after Pavel acts the page asks every 5 s: GitHub may show his commit a little later', () => {
  assert.equal(isIdle('questions', 120_000, 0), true, 'давно ничего не запускал — раз в 30 с');
  assert.equal(isIdle('questions', 30_000, 0), false, 'только что нажал — каждые 5 с');
  assert.equal(isIdle('result', 59_999, 0), false);
  assert.equal(isIdle('result', 60_000, 0), true);
  assert.equal(isIdle('working', 120_000, 0), false, 'шаг идёт — каждые 5 с');
  assert.equal(isIdle('uploading', 120_000, 0), false);
});
