import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookUntil, sourceSpan } from '../lib/blocks.ts';
import { Timeline } from '../lib/timeline.ts';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test('a block on the track is where it starts in the recording and does not reach past its run', () => {
  // куски по порядку исходника — одна серия: блок тянется и через вырезку
  const plain = new Timeline([[0, 2], [3, 5]], 1);
  assert.deepEqual(sourceSpan(plain, 1, 2.5), { t0: 1, t1: 3.5 }, 'через вырезку 2–3: конец — в следующем куске той же серии');
  assert.deepEqual(sourceSpan(plain, 1, 2), { t0: 1, t1: 2 }, 'ровно на стыке — конец своего куска, а не начало следующего');
  // кусок 6–8 переставлен в начало: серия 6–8 кончается в 2 с финала — блок дальше не тянется
  const moved = new Timeline([[6, 8], [0, 2], [3, 5]], 1);
  assert.deepEqual(sourceSpan(moved, 1, 3), { t0: 7, t1: 8 });
  assert.deepEqual(sourceSpan(moved, 2.5, 4.5), { t0: 0.5, t1: 3.5 }, 'во второй серии — 0–2 и 3–5');
  const fast = new Timeline([[0, 4]], 2);
  assert.deepEqual(sourceSpan(fast, 0.5, 1), { t0: 1, t1: 2 }, 'с ускорением ×2');
});

test('a block cannot start inside the teaser (it is a copy of a phrase from its own place)', () => {
  const teased = new Timeline([[0, 5]], 1, [3, 4]);
  assert.equal(sourceSpan(teased, 0.5, 2), null);
  assert.deepEqual(sourceSpan(teased, 1.5, 2), { t0: 0.5, t1: 1 });
});

test('the hook end on the track is its moment in source order (pieces moved by hand do not stretch it)', () => {
  const moved = new Timeline([[6, 8], [0, 2], [3, 5]], 1.25);
  assert.ok(near(hookUntil(moved, 1.2), 1.5), 'по порядку исходника 1,2 с финала — 1,5 с записи');
  assert.ok(near(new Timeline([[6, 8], [0, 2], [3, 5]], 1.25).inSourceOrder().toFinalSnap(hookUntil(moved, 1.2)), 1.2));
});
