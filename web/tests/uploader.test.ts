import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUpload, type PutResult } from '../lib/uploader.ts';

// Поддельные часы: таймеры срабатывают строго по времени, между срабатываниями
// успевают выполниться все микрозадачи (setImmediate) — как с настоящими таймерами.
function clock() {
  let t = 0;
  let running = false;
  const timers: { at: number; res: () => void }[] = [];
  async function drive() {
    if (running) return;
    running = true;
    for (;;) {
      await new Promise((r) => setImmediate(r));
      if (!timers.length) break;
      timers.sort((a, b) => a.at - b.at);
      const x = timers.shift()!;
      t = Math.max(t, x.at);
      x.res();
    }
    running = false;
  }
  return { now: () => t, sleep: (ms: number) => new Promise<void>((res) => { timers.push({ at: t + ms, res }); void drive(); }) };
}

test('uploads every part exactly once', async () => {
  const c = clock(); const seen: number[] = [];
  await runUpload({ parts: 5, put: async (i) => { seen.push(i); return { ok: true }; }, concurrency: 2, minGapMs: 0, ...c });
  assert.deepEqual(seen.sort(), [0, 1, 2, 3, 4]);
});

test('skips parts already done (resume)', async () => {
  const c = clock(); const seen: number[] = [];
  await runUpload({ parts: 4, done: new Set([0, 2]), put: async (i) => { seen.push(i); return { ok: true }; }, concurrency: 1, minGapMs: 0, ...c });
  assert.deepEqual(seen, [1, 3]);
});

test('retries a failed part with backoff and reports retries', async () => {
  const c = clock(); let fails = 2; const progress: number[] = [];
  const r = await runUpload({ parts: 1, put: async (): Promise<PutResult> => (fails-- > 0 ? { ok: false, status: 502 } : { ok: true }),
    concurrency: 1, minGapMs: 0, onProgress: (d) => progress.push(d), ...c });
  assert.equal(r.retries, 2);
  assert.ok(c.now() >= 1000 + 2000, `backoff waited ${c.now()} ms`);
  assert.deepEqual(progress, [1]);
});

test('waits a minute after a rate-limit answer', async () => {
  const c = clock(); let first = true;
  await runUpload({ parts: 1, put: async () => (first ? ((first = false), { ok: false, status: 429 }) : { ok: true }),
    concurrency: 1, minGapMs: 0, rateLimitWaitMs: 60_000, ...c });
  assert.ok(c.now() >= 60_000);
});

test('keeps a minimum gap between request starts', async () => {
  const c = clock(); const starts: number[] = [];
  await runUpload({ parts: 3, put: async () => { starts.push(c.now()); return { ok: true }; }, concurrency: 3, minGapMs: 700, ...c });
  assert.deepEqual(starts, [0, 700, 1400]);
});

test('gives up after maxRetries and names the failed parts', async () => {
  const c = clock();
  await assert.rejects(
    runUpload({ parts: 2, put: async (i) => (i === 1 ? { ok: false, status: 502 } : { ok: true }), concurrency: 1, minGapMs: 0, maxRetries: 3, ...c }),
    /part 1/);
});
