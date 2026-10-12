import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../lib/clock.ts';

test('the clock tells its listeners only when the moment changes, and forgets those who left', () => {
  const clock = createClock(1);
  let calls = 0;
  const leave = clock.subscribe(() => calls++);
  clock.set(1);
  assert.equal(calls, 0, 'тот же момент — никого не будит');
  clock.set(1.5);
  assert.equal(clock.get(), 1.5);
  assert.equal(calls, 1);
  leave();
  clock.set(2);
  assert.equal(calls, 1);
});
