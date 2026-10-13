import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Saver, type PutResult } from '../lib/saver.ts';

/** Поддельный PUT: каждый вызов ждёт, пока тест его отпустит. */
function fakePut() {
  const calls: { base: number; value: string; done: (r: PutResult) => void }[] = [];
  const put = (base: number, value: string) => new Promise<PutResult>((done) => calls.push({ base, value, done }));
  return { calls, put };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('saver: «Монтировать» during an autosave waits for it — no second PUT of the same edits, no false conflict', async () => {
  const { calls, put } = fakePut();
  const s = new Saver<string>(put, 'v0', 0);
  const auto = s.save('v1');
  const mount = s.save('v1');
  await tick();
  assert.equal(calls.length, 1, 'то же самое — один раз');
  calls[0].done({ ok: true, rev: 1 });
  assert.deepEqual(await auto, { ok: true, rev: 1 });
  assert.deepEqual(await mount, { ok: true, rev: 1 });
  assert.equal(s.rev, 1);
  assert.equal(s.saved, 'v1');
});

test('saver: a newer edit waits for the running save and goes from its revision', async () => {
  const { calls, put } = fakePut();
  const s = new Saver<string>(put, 'v0', 3);
  const a = s.save('v1');
  const b = s.save('v2');
  await tick();
  assert.deepEqual(calls.map((c) => [c.base, c.value]), [[3, 'v1']]);
  calls[0].done({ ok: true, rev: 4 });
  await a;
  await tick();
  assert.deepEqual(calls.map((c) => [c.base, c.value]), [[3, 'v1'], [4, 'v2']]);
  calls[1].done({ ok: true, rev: 5 });
  assert.deepEqual(await b, { ok: true, rev: 5 });
});

test('saver: a failure leaves the revision as it was; a thrown PUT is a failure, not a rejection', async () => {
  const s = new Saver<string>(async () => {
    throw new Error('сеть');
  }, 'v0', 2);
  const r = await s.save('v1');
  assert.ok(!r.ok && !r.conflict && /сеть/.test(r.error));
  assert.equal(s.rev, 2);
  assert.equal(s.saved, 'v0');
});

test('saver: after «Load them» (reset) a late answer of the old save changes nothing', async () => {
  const { calls, put } = fakePut();
  const s = new Saver<string>(put, 'v0', 0);
  const old = s.save('mine');
  await tick();
  s.reset('theirs', 7);
  calls[0].done({ ok: true, rev: 1 });
  await old;
  assert.equal(s.rev, 7);
  assert.equal(s.saved, 'theirs');
});
