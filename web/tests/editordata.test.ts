import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { abilitiesOf, editorFix, ENGINE_SCHEMA, isUploadPicture, layerUrl, loadEditor, MEDIA_NAMES, mediaAsset, refusedBy, saveTimeline, timelineOf } from '../lib/editordata.ts';
import type { AnswersFile } from '../lib/jobfiles.ts';
import { withFake } from './helpers.ts';

const ID = '261010-070509-abcd';
const DIR = `jobs/${ID}`;
const EDIT = {
  speed: 1.1, keep: [[0.5, 3]], words: [{ t0: 0.6, t1: 0.9, text: 'Привет' }], hook: { text: 'Хук', until: 1.5 }, cta: null, inserts: [],
  zooms: [], face: { x: 0.5, y: 0.4 }, music: null, hold: 0, style: {},
};
const MEDIA = {
  duration: 3, proxy: { file: 'out/proxy.mp4', width: 540, height: 960, key: 0.5 }, film: { file: 'film.jpg', step: 0.5, w: 54, h: 96, n: 6 },
  peaks: { perS: 50, data: 'AAAA' },
};
const JOB = { id: ID, name: 'IMG_1.MOV', size: 1, type: 'video/quicktime', duration: 3, createdAt: '2026-10-10T07:05:09Z', brief: '', uploads: [], runs: [{ step: 'analyze', attempt: 1, at: '2026-10-10T07:06:00Z' }] };
const STATUS = { state: 'waiting_answers', phase: 'Ждёт ответов', message: '…', at: '2026-10-10T07:20:00Z', needs: 'answers' };
const released = (...names: string[]) => JSON.stringify({ release_id: 1, assets: names.map((name, i) => ({ name, id: 500 + i, size: 1 })), at: '2026-10-10T07:21:00Z' });

test('the editor gets the draft, the editor files and links to the proxy and the film strip', () => withFake(async ({ fake, gh }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  const head = fake.commit(`claude/job-${ID}`, {
    [`${DIR}/job.json`]: JSON.stringify(JOB), [`${DIR}/status.json`]: JSON.stringify(STATUS), [`${DIR}/edit.json`]: JSON.stringify(EDIT),
    [`${DIR}/editor.json`]: JSON.stringify(MEDIA), [`${DIR}/out/released.json`]: released('proxy.mp4'),
  });
  const e = await loadEditor(gh, ID);
  assert.ok(e);
  assert.equal(e.title, 'IMG_1.MOV');
  assert.equal(e.draft?.hook?.text, 'Хук');
  assert.equal(e.media?.film.n, 6);
  assert.equal(e.proxyUrl, `/api/jobs/${ID}/media?name=proxy.mp4`);
  assert.equal(e.filmUrl, `/api/jobs/${ID}/file?path=film.jpg&v=${head}`);
  assert.equal(e.head, head);
}));

test('no proxy in the release yet, no editor files, no draft — each is null, the rest still comes', () => withFake(async ({ fake, gh }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  fake.commit(`claude/job-${ID}`, { [`${DIR}/job.json`]: JSON.stringify(JOB), [`${DIR}/status.json`]: JSON.stringify(STATUS), [`${DIR}/editor.json`]: JSON.stringify(MEDIA) });
  const e = await loadEditor(gh, ID);
  assert.ok(e && e.media && e.proxyUrl === null && e.draft === null);
  fake.commit(`claude/job-${ID}`, { [`${DIR}/editor.json`]: '{"duration": "x"}', [`${DIR}/edit.json`]: JSON.stringify({ ...EDIT, keep: [[3, 1]] }) });
  const broken = await loadEditor(gh, ID);
  assert.ok(broken && broken.media === null && broken.draft === null && broken.filmUrl === null);
  assert.equal(await loadEditor(gh, '261010-070509-none'), null);
}));

test('only the proxy is served as editor media', () => {
  const files = { released: JSON.parse(released('final.mp4', 'proxy.mp4')) };
  assert.equal(mediaAsset(files, 'proxy.mp4')?.id, 501);
  assert.equal(mediaAsset(files, 'final.mp4'), null, 'ролик — через download');
  assert.equal(mediaAsset({ released: null }, 'proxy.mp4'), null);
});

test('the proxy the player takes from the release is the one the engine writes', () => {
  const schema = JSON.parse(readFileSync(new URL('../../engine/vm/schemas/editor.json', import.meta.url), 'utf8'));
  const file = schema.properties.proxy.properties.file.const as string;
  assert.equal(file, 'out/proxy.mp4');
  assert.deepEqual([...MEDIA_NAMES], [file.replace(/^out\//, '')], 'в релиз Action кладёт файл out/ под его именем');
});

// ---------- правки руками (фаза 3) ----------

const NOW = new Date(Date.UTC(2026, 9, 12, 15, 0, 0));
const HAND = { edits: [{ op: 'cut', t0: 1, t1: 1.5 }], music: { muted: true } };
const start = (fake: Parameters<Parameters<typeof withFake>[0]>[0]['fake'], status = STATUS, more: Record<string, string> = {}) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  return fake.commit(`claude/job-${ID}`, {
    [`${DIR}/job.json`]: JSON.stringify(JOB), [`${DIR}/status.json`]: JSON.stringify(status), [`${DIR}/edit.json`]: JSON.stringify(EDIT), ...more,
  });
};
const timelineFile = (fake: Parameters<Parameters<typeof withFake>[0]>[0]['fake']) => JSON.parse(fake.read(`claude/job-${ID}`, `${DIR}/timeline.json`) ?? 'null');

test('timeline.json: its revision even when the rest is broken; no file — revision 0', () => {
  assert.deepEqual(timelineOf(null), { rev: 0, timeline: null });
  assert.deepEqual(timelineOf(JSON.stringify({ rev: 2, edits: [] })), { rev: 2, timeline: { rev: 2, edits: [] } });
  assert.deepEqual(timelineOf(JSON.stringify({ rev: 4, edits: 'x' })), { rev: 4, timeline: null }, 'кривой файл — страница его перезапишет');
  assert.deepEqual(timelineOf('{'), { rev: 0, timeline: null });
});

test('saving hand edits: revision 1, then 2; a stale base is a conflict with what is in the branch', () => withFake(async ({ fake, gh }) => {
  start(fake);
  const first = await saveTimeline(gh, ID, { base: 0, ...HAND }, NOW);
  assert.ok(first.ok);
  assert.deepEqual(timelineFile(fake), { rev: 1, at: NOW.toISOString(), ...HAND });
  assert.match(fake.history(`claude/job-${ID}`)[0].message, /правки в редакторе/);
  const second = await saveTimeline(gh, ID, { base: 1, edits: [], voice: { gainDb: -3 } }, NOW);
  assert.ok(second.ok && second.timeline.rev === 2);
  assert.deepEqual(timelineFile(fake), { rev: 2, at: NOW.toISOString(), edits: [], voice: { gainDb: -3 } });
  const stale = await saveTimeline(gh, ID, { base: 1, ...HAND }, NOW);
  assert.ok(!stale.ok && stale.status === 409 && stale.rev === 2 && stale.timeline?.voice?.gainDb === -3, JSON.stringify(stale));
  assert.equal(timelineFile(fake).rev, 2, 'старая вкладка не затёрла новые правки');
  const loaded = await loadEditor(gh, ID);
  assert.equal(loaded?.rev, 2);
  assert.deepEqual(loaded?.timeline?.voice, { gainDb: -3 });
}));

test('saving hand edits: another tab saving in between is a conflict too (checked on the head it commits to)', () => withFake(async ({ fake, gh }) => {
  start(fake);
  fake.onBeforePatch = (branch: string) => {
    fake.onBeforePatch = null;
    fake.commit(branch, { [`${DIR}/timeline.json`]: JSON.stringify({ rev: 1, edits: [{ op: 'split', t: 2 }] }) }, 'other tab');
  };
  const r = await saveTimeline(gh, ID, { base: 0, ...HAND }, NOW);
  assert.ok(!r.ok && r.status === 409 && r.rev === 1, JSON.stringify(r));
  assert.deepEqual(timelineFile(fake).edits, [{ op: 'split', t: 2 }]);
}));

test('saving hand edits: a bad body, a job Claude is mounting right now, a job not found', () => withFake(async ({ fake, gh }) => {
  start(fake, { ...STATUS, state: 'rendering', phase: 'Монтирую', needs: undefined } as unknown as typeof STATUS);
  for (const bad of [null, { base: 0 }, { base: -1, edits: [] }, { base: 0, edits: [{ op: 'jump', t: 1 }] }, { base: 0, edits: [], voice: { gainDb: 99 } }, { base: 0, edits: [], rev: 5 },
    { base: 0, edits: [], words: [{ t0: 1, t1: 1.3, text: 'огонь🔥' }] }]) { // эмодзи в субтитрах не пропустит проверка шрифтов
    const r = await saveTimeline(gh, ID, bad, NOW);
    assert.ok(!r.ok && r.status === 400, JSON.stringify(bad));
  }
  const busy = await saveTimeline(gh, ID, { base: 0, ...HAND }, NOW);
  assert.ok(!busy.ok && busy.status === 409 && /монтирует/.test(busy.error), JSON.stringify(busy));
  assert.equal(timelineFile(fake), null);
  const none = await saveTimeline(gh, '261010-070509-none', { base: 0, ...HAND }, NOW);
  assert.ok(!none.ok && none.status === 404);
}));

const ANSWERS: AnswersFile = { answers: {}, style: { variant: 'A', font: 'montserrat', hand: 'caveat', colors: { text: '#FFFFFF', accent: '#FFD400', bar: '#FFD400' } } };

test('«Монтировать» from the editor: a fix with the saved revision and, if Pavel changed it, the new style', () => {
  const ok = editorFix({ editor: { timeline: 3 } }, { rev: 3, answers: ANSWERS, fix: null }, NOW);
  assert.ok('files' in ok);
  assert.deepEqual(JSON.parse(ok.files['fix.json']).fixes, [{ text: 'Правки в редакторе', at: NOW.toISOString(), version: 2, timeline: 3 }]);
  assert.equal(ok.files['answers.json'], undefined, 'стиль тот же — answers.json не трогаем');

  const style = { ...ANSWERS.style, variant: 'B' as const, colors: { ...ANSWERS.style.colors, accent: '#FF3B30' } };
  const restyled = editorFix({ editor: { timeline: 3, style } }, { rev: 3, answers: ANSWERS, fix: null }, NOW);
  assert.ok('files' in restyled);
  assert.deepEqual(JSON.parse(restyled.files['fix.json']).fixes[0],
    { text: 'Правки в редакторе', at: NOW.toISOString(), version: 2, timeline: 3, style: true, styleFrom: ANSWERS.style }, 'с прошлым стилем — для vm style --onto и «Вернуть»');
  assert.deepEqual(JSON.parse(restyled.files['answers.json'] ?? '{}'), { ...ANSWERS, style });

  const onlyStyle = editorFix({ editor: { style } }, { rev: 0, answers: ANSWERS, fix: null }, NOW);
  assert.ok('files' in onlyStyle && JSON.parse(onlyStyle.files['fix.json']).fixes[0].timeline === undefined);

  const behind = editorFix({ editor: { timeline: 2 } }, { rev: 3, answers: ANSWERS, fix: null }, NOW);
  assert.ok('error' in behind && behind.status === 409, 'правки ещё сохраняются');
  const nothing = editorFix({ editor: { style: ANSWERS.style } }, { rev: 0, answers: ANSWERS, fix: null }, NOW);
  assert.ok('error' in nothing && nothing.status === 400, 'монтировать нечего');
  const badStyle = editorFix({ editor: { timeline: 3, style: { variant: 'Z' } } }, { rev: 3, answers: ANSWERS, fix: null }, NOW);
  assert.ok('error' in badStyle && badStyle.status === 400);
  const unmounted = editorFix({ editor: { style } }, { rev: 0, answers: null, fix: null }, NOW);
  assert.ok('error' in unmounted && unmounted.status === 409, 'стиль меняется у смонтированного ролика');
});

// ---------- что примет движок задачи ----------

const SCHEMA_NOW = readFileSync(new URL('../../engine/vm/schemas/timeline.json', import.meta.url), 'utf8');
/** Схема timeline.json, как она была до фазы `phase` (4 — без перестановки, 5 — без текста). */
function olderSchema(phase: 4 | 5): string {
  const s = JSON.parse(SCHEMA_NOW);
  delete s.properties.text;
  delete s.properties.words;
  if (phase === 4) s.properties.edits.items.oneOf = s.properties.edits.items.oneOf.filter((o: { properties: { op: { const: string } } }) => o.properties.op.const !== 'move');
  return JSON.stringify(s);
}

test('what the job\'s engine takes is read from its own schema in the job branch', () => {
  assert.deepEqual(abilitiesOf(SCHEMA_NOW), { move: true, text: true });
  assert.deepEqual(abilitiesOf(olderSchema(5)), { move: true, text: false });
  assert.deepEqual(abilitiesOf(olderSchema(4)), { move: false, text: false });
  assert.deepEqual(abilitiesOf(null), { move: true, text: true }, 'схемы нет — движок нынешний');
  const text = { edits: [], words: [{ t0: 1, t1: 2, text: 'это' }] };
  assert.match(refusedBy({ move: true, text: false }, text) ?? '', /до правок текста/);
  assert.match(refusedBy({ move: false, text: true }, { edits: [{ op: 'move', t0: 1, t1: 2, before: null }] }) ?? '', /до перестановки/);
  assert.equal(refusedBy({ move: true, text: true }, text), null);
});

test('a job made before text edits: the editor knows it, and the server does not save what its engine would refuse', () => withFake(async ({ fake, gh }) => {
  start(fake);
  fake.commit(`claude/job-${ID}`, { [ENGINE_SCHEMA]: olderSchema(5) }, 'old engine');
  assert.deepEqual((await loadEditor(gh, ID))?.abilities, { move: true, text: false });
  const r = await saveTimeline(gh, ID, { base: 0, edits: [], text: { hook: { until: 2 } } }, NOW);
  assert.ok(!r.ok && r.status === 409 && /до правок текста/.test(r.error), JSON.stringify(r));
  assert.equal(timelineFile(fake), null, 'ничего не записано');
  assert.ok((await saveTimeline(gh, ID, { base: 0, ...HAND }, NOW)).ok, 'куски — как всегда');
}));

test('pictures of the layer in the editor: Pavel\'s uploads from the release, the rest from the branch as the engine finds them', () => {
  assert.equal(layerUrl(ID, 'abc', 'in/uploads/upload-i2.png'), `/api/jobs/${ID}/upload?name=upload-i2.png`);
  assert.equal(layerUrl(ID, 'abc', 'in/uploads/upload-q-logo.jpg'), `/api/jobs/${ID}/upload?name=upload-q-logo.jpg`);
  assert.equal(layerUrl(ID, 'abc', 'assets/library/arrow.png'), `/api/jobs/${ID}/file?path=assets%2Flibrary%2Farrow.png&v=abc`);
  assert.equal(layerUrl(ID, null, 'in/brand/logo.png'), `/api/jobs/${ID}/file?path=in%2Fbrand%2Flogo.png`);
  assert.ok(isUploadPicture('upload-i12.webp') && isUploadPicture('upload-q-x1a2b3c4d.png'));
  for (const bad of ['upload-i2.mov', 'source.mp4', '../upload-i2.png', 'upload-voice.m4a', 'upload-i2.png.part-00001']) assert.ok(!isUploadPicture(bad), bad);
});
