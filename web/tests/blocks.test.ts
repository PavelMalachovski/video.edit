import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockRoom, finalEdges, hookUntil, sourceSpan, stackRows } from '../lib/blocks.ts';
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

test('blocks that overlap in time go on separate rows of the lane; the rest share the first row', () => {
  const rows = stackRows([{ t0: 0, t1: 2 }, { t0: 1, t1: 3 }, { t0: 2, t1: 4 }, { t0: 2.5, t1: 2.8 }, { t0: 5, t1: 6 }]);
  assert.deepEqual(rows.row, [0, 1, 0, 2, 0], 'стык — не перекрытие; третий слой — когда заняты оба');
  assert.equal(rows.count, 3);
  assert.deepEqual(stackRows([]), { row: [], count: 1 }, 'пустая дорожка — одна строка');
});

test('word edges in final time: where each kept word starts and ends in the video, once, in order', () => {
  const tl = new Timeline([[0, 2], [3, 5]], 1.25);
  const words = [{ t0: 0.5, t1: 1.0, text: 'а' }, { t0: 2.2, t1: 2.6, text: 'вырезано' }, { t0: 3.0, t1: 3.5, text: 'б' }, { t0: 3.5, t1: 4.0, text: 'в' }];
  assert.deepEqual(finalEdges(tl, words).map((x) => Math.round(x * 1000) / 1000), [0.4, 0.8, 1.6, 2, 2.4], 'вырезанное слово — без краёв');
});

test('where a text block may go: not before the hook ends (or the teaser), not past the video', () => {
  const tl = new Timeline([[0, 6]], 1, [4, 5]);
  assert.deepEqual(blockRoom(tl, 30), { floor: 1, max: 7 }, 'с тизером: не раньше его конца (хук — на тизере)');
  assert.deepEqual(blockRoom(new Timeline([[0, 6]], 1), 45), { floor: 1.5, max: 6 }, 'без тизера — с конца хука');
  assert.deepEqual(blockRoom(new Timeline([[0, 6]], 1), 0), { floor: 0, max: 6 }, 'хука нет — с начала');
});

test('a block snapped to the first word after a moved piece starts in that piece, not at the end of the one before', () => {
  // кусок 10–13 переставлен в начало, ×1,3: стык — 2,3076923… с; край слова 0,4 — ровно на стыке
  const tl = new Timeline([[10, 13], [0.4, 5]], 1.3);
  const [edge] = finalEdges(tl, [{ t0: 0.4, t1: 0.8 }]);
  assert.equal(edge, 3 / 1.3, 'край слова — точный, без округления');
  assert.deepEqual(sourceSpan(tl, 2.307692, 2.7), { t0: 0.4, t1: 0.91 }, 'и чуть раньше стыка (округлённый край) — уже следующий кусок');
});
