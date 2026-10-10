import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepScreenOn } from '../lib/wakelock.ts';

/** Страница с видимостью и событием visibilitychange; блокировки экрана считаются. */
function fakePage(supported = true) {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  const locks = { requested: 0, released: 0 };
  const nav = supported ? { wakeLock: { request: async () => { locks.requested += 1; return { release: async () => { locks.released += 1; } }; } } } : {};
  const show = async (state: DocumentVisibilityState) => {
    doc.visibilityState = state;
    for (const fn of [...listeners]) fn();
    await new Promise((r) => setImmediate(r));
  };
  return { doc, nav, locks, listeners, show };
}

test('the screen lock comes back after the page was hidden', async () => {
  const p = fakePage();
  const release = keepScreenOn(p.nav, p.doc);
  await new Promise((r) => setImmediate(r));
  assert.equal(p.locks.requested, 1);
  await p.show('hidden'); // iOS снимает блокировку сам
  await p.show('visible');
  assert.equal(p.locks.requested, 2, 'asked again when the page is back');
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(p.listeners.size, 0);
  assert.ok(p.locks.released >= 1);
  await p.show('visible');
  assert.equal(p.locks.requested, 2, 'nothing after release');
});

test('no wake lock in the browser — nothing breaks', async () => {
  const p = fakePage(false);
  const release = keepScreenOn(p.nav, p.doc);
  await p.show('visible');
  release();
  assert.equal(p.locks.requested, 0);
});
