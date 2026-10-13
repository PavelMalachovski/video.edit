import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAUSED } from '../lib/client.ts';
import {
  clearPending, FATAL, loadPending, matchPending, planChunks, resumeDone, runUpload, sameSelection, savePending, UploadStopped, type Pending, type PutResult,
} from '../lib/uploader.ts';
import { blockedStorage, memoryStorage } from './helpers.ts';

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

test('stops at once on an answer no retry can fix: Vercel paused the site (402), signed out (401), a bad or too big part', async () => {
  assert.deepEqual([...FATAL].sort((a, b) => a - b), [400, 401, 402, 404, 413]);
  for (const status of FATAL) {
    const c = clock();
    let puts = 0;
    await assert.rejects(
      runUpload({ parts: 6, put: async () => { puts += 1; return { ok: false, status }; }, concurrency: 2, minGapMs: 0, ...c }),
      (e: unknown) => e instanceof UploadStopped && e.status === status, String(status));
    assert.ok(puts <= 2, `${status}: ${puts} запросов — без повторов и без новых кусков`);
    assert.equal(c.now(), 0, `${status}: без пауз перед повторами`);
  }
});

test('after a fatal answer no new part starts; the parts already sent stay done for «Продолжить загрузку»', async () => {
  const c = clock();
  const started: number[] = [];
  const progress: number[] = [];
  await assert.rejects(runUpload({
    parts: 10, put: async (i) => { started.push(i); return i === 1 ? { ok: false, status: 402 } : { ok: true }; },
    concurrency: 2, minGapMs: 0, onProgress: (n) => progress.push(n), ...c,
  }), UploadStopped);
  assert.ok(started.length <= 3, started.join(', '));
  assert.ok(progress.length >= 1, 'кусок 0 загрузился до остановки');
});

test('a stopped upload says why in words: the paused site — as everywhere on the page; signed out — sign in and go on', () => {
  assert.equal(new UploadStopped(402).message, PAUSED);
  assert.match(new UploadStopped(401).message, /[Вв]ход/);
  assert.match(new UploadStopped(413).message, /413/);
  assert.ok(new UploadStopped(400) instanceof Error);
});

test('server errors and a lost connection are still retried', async () => {
  for (const status of [0, 429, 500, 502, 503, 504]) {
    const c = clock();
    let calls = 0;
    const r = await runUpload({ parts: 1, put: async () => (++calls === 1 ? { ok: false, status } : { ok: true }), concurrency: 1, minGapMs: 0, rateLimitWaitMs: 10, ...c });
    assert.equal(r.retries, 1, String(status));
  }
});

// ---------- куски, продолжение после перезагрузки ----------

const MB = 1024 * 1024;
const file = (name: string, size: number, lastModified: number, type = '') => new File([new Uint8Array(size)], name, { lastModified, type });
const pending: Pending = {
  jobId: '261010-120000-ab12', releaseId: 7, source: { name: 'clip.mov', size: 10, lastModified: 111 }, brief: 'ХУК: Как я учу чешский', duration: 61,
  inserts: [
    { asset: 'upload-i1.png', name: 'a.png', size: 3, type: 'image/png', lastModified: 5 },
    { asset: 'upload-i2.mov', name: 'b.mov', size: 4, type: 'video/quicktime', lastModified: 6 },
  ],
};

test('planChunks puts the source first, then inserts, with byte ranges', () => {
  const chunks = planChunks([{ asset: 'source', size: 10 * MB }, { asset: 'upload-i1.png', size: 5 * MB }], 4 * MB);
  assert.deepEqual(chunks.map((c) => [c.file, c.index, c.start, c.end, c.src]), [
    ['source', 0, 0, 4 * MB, 0],
    ['source', 1, 4 * MB, 8 * MB, 0],
    ['source', 2, 8 * MB, 10 * MB, 0],
    ['upload-i1.png', 0, 0, 4 * MB, 1],
    ['upload-i1.png', 1, 4 * MB, 5 * MB, 1],
  ]);
});

test('resumeDone counts only parts with the exact size', () => {
  const chunks = planChunks([{ asset: 'source', size: 10 * MB }, { asset: 'upload-i1.png', size: 1 * MB }], 4 * MB);
  const done = resumeDone(chunks, [
    { name: 'source.part-00000', size: 4 * MB },
    { name: 'source.part-00001', size: 3 * MB }, // обрезан — не готов
    { name: 'source.part-00002', size: 2 * MB }, // короткий последний кусок верного размера — готов
    { name: 'upload-i1.png.part-00000', size: 4 * MB }, // размер не тот
    { name: 'upload-i9.png.part-00000', size: 1 * MB }, // чужой файл
  ]);
  assert.deepEqual([...done].sort(), [0, 2]);
});

test('matchPending resumes re-picked files and drops the rest', () => {
  const a = file('a.png', 3, 5);
  const m = matchPending(pending, file('clip.mov', 10, 111), [file('c.png', 2, 9), a]);
  assert.equal(m.ok, true);
  assert.deepEqual([...m.inserts.entries()], [['upload-i1.png', a]]);
  assert.deepEqual(m.dropped, ['b.mov']);
  // iPhone отдаёт свежую копию из «Фото»: время изменения — момент выбора; совпадают имя и размер до байта
  const again = matchPending(pending, file('clip.mov', 10, 999), [file('a.png', 3, 777)]);
  assert.equal(again.ok, true);
  assert.deepEqual([...again.inserts.keys()], ['upload-i1.png']);
  assert.equal(matchPending(pending, file('clip.mov', 11, 111), [a]).ok, false);
  assert.equal(matchPending(pending, file('other.mov', 10, 111), [a]).ok, false);
});

test('a voiceover resumes when picked again; another file or none is not the pending one', () => {
  const p: Pending = { ...pending, voice: { asset: 'upload-voice.m4a', name: 'take.m4a', size: 7, type: 'audio/mp4', lastModified: 1 } };
  const v = file('take.m4a', 7, 42);
  assert.equal(matchPending(p, file('clip.mov', 10, 111), [], v).voice, v);
  const none = matchPending(p, file('clip.mov', 10, 111), [], null);
  assert.equal(none.voice, null);
  assert.ok(none.dropped.includes('take.m4a'), 'озвучку не выбрали заново — её не будет');
  assert.equal(matchPending(p, file('clip.mov', 10, 111), [], file('new.m4a', 9, 1)).voice, null);
  assert.equal(matchPending(pending, file('clip.mov', 10, 111), [], v).voice, null, 'в прошлой загрузке озвучки не было');
  const store = memoryStorage();
  savePending(store, p);
  assert.deepEqual(loadPending(store), p);
  store.setItem('vm:pending', JSON.stringify({ ...p, voice: { ...p.voice, asset: 'upload-i1.png' } }));
  assert.equal(loadPending(store), null);
});

test('a stopped upload goes on as it was only with the same inserts and voiceover', () => {
  const [src, a, v] = [file('clip.mov', 10, 1), file('a.png', 3, 2), file('take.m4a', 7, 3)];
  const files = new Map<string, File>([['source', src], ['upload-i1.png', a], ['upload-voice.m4a', v]]);
  assert.equal(sameSelection(files, [a], v), true);
  assert.equal(sameSelection(files, [a], null), false, 'озвучку убрали');
  assert.equal(sameSelection(files, [a], file('take2.m4a', 9, 4)), false, 'другая запись');
  assert.equal(sameSelection(files, [], v), false, 'вставку убрали');
  assert.equal(sameSelection(files, [a, file('b.png', 4, 5)], v), false, 'вставку добавили');
  assert.equal(sameSelection(new Map([['source', src]]), [], null), true);
});

test('pending upload survives in storage; corrupt or blocked storage gives null', () => {
  const store = memoryStorage();
  savePending(store, pending);
  assert.deepEqual(loadPending(store), pending);
  clearPending(store);
  assert.equal(loadPending(store), null);
  store.setItem('vm:pending', '{bad');
  assert.equal(loadPending(store), null);
  store.setItem('vm:pending', JSON.stringify({ ...pending, jobId: '../x' }));
  assert.equal(loadPending(store), null);
  assert.equal(loadPending(blockedStorage), null);
  savePending(blockedStorage, pending);
  clearPending(blockedStorage);
  assert.equal(loadPending(null), null);
});

test('several videos: the upload goes on only when each of them is picked again, in any order', () => {
  const p: Pending = { ...pending, more: [{ asset: 'source-2', name: 'b.mov', size: 20, type: 'video/quicktime', lastModified: 2 }] };
  const [a, b] = [file('clip.mov', 10, 1), file('b.mov', 20, 2)];
  const m = matchPending(p, [b, a], []);
  assert.equal(m.ok, true);
  assert.deepEqual([...m.videos].map(([asset, f]) => [asset, f.name]), [['source', 'clip.mov'], ['source-2', 'b.mov']]);
  assert.equal(matchPending(p, [a], []).ok, false, 'второго видео нет');
  assert.equal(matchPending(p, [a, b, file('c.mov', 5, 3)], []).ok, false, 'лишнее видео — это уже другая загрузка');
  assert.equal(matchPending(pending, [a, b], []).ok, false, 'в прошлой загрузке видео было одно');
  assert.deepEqual([...matchPending(pending, a, []).videos.keys()], ['source'], 'одно видео — как раньше');
  const store = memoryStorage();
  savePending(store, p);
  assert.deepEqual(loadPending(store), p);
  store.setItem('vm:pending', JSON.stringify({ ...p, more: [{ ...p.more![0], asset: 'source' }] }));
  assert.equal(loadPending(store), null, 'ещё видео — source-2 и дальше');
});

test('a stopped upload of several videos goes on as it was only with the same videos', () => {
  const [a, b, i] = [file('clip.mov', 10, 1), file('b.mov', 20, 2), file('a.png', 3, 3)];
  const files = new Map<string, File>([['source', a], ['source-2', b], ['upload-i1.png', i]]);
  assert.equal(sameSelection(files, [i], null, [a, b]), true);
  assert.equal(sameSelection(files, [i], null, [a]), false, 'видео убрали');
  assert.equal(sameSelection(files, [i], null, [a, b, file('c.mov', 5, 4)]), false, 'видео добавили');
  assert.equal(sameSelection(files, [i], null), true, 'без списка видео — как раньше: только вставки и озвучка');
});

test('planChunks: the videos first in their order, then the inserts and the voiceover', () => {
  const c = planChunks([{ asset: 'source', size: 5 }, { asset: 'source-2', size: 3 }, { asset: 'upload-i1.png', size: 2 }], 4);
  assert.deepEqual(c.map((x) => [x.file, x.index, x.start, x.end, x.src]), [['source', 0, 0, 4, 0], ['source', 1, 4, 5, 0], ['source-2', 0, 0, 3, 1], ['upload-i1.png', 0, 0, 2, 2]]);
});

test('a stopped upload of several videos goes on only in the same order: moving a video up starts it anew', () => {
  const [a, b] = [file('clip.mov', 10, 1), file('b.mov', 20, 2)];
  const files = new Map<string, File>([['source', a], ['source-2', b]]);
  assert.equal(sameSelection(files, [], null, [a, b]), true);
  assert.equal(sameSelection(files, [], null, [b, a]), false, 'порядок другой — склеится иначе');
});

test('a pending upload with a broken list of more videos is not resumed', () => {
  const store = memoryStorage();
  const more = { asset: 'source-2', name: 'b.mov', size: 20, type: 'video/quicktime', lastModified: 2 };
  for (const bad of [{ ...more, type: undefined }, { ...more, lastModified: 'x' }, { ...more, size: -1 }]) {
    store.setItem('vm:pending', JSON.stringify({ ...pending, more: [bad] }));
    assert.equal(loadPending(store), null, JSON.stringify(bad));
  }
});
