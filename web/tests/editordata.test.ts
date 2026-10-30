import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { abilitiesOf, coverUrl, editorFix, editorGates, ENGINE_SCHEMA, isUploadPicture, layerUrl, loadEditor, MEDIA_NAMES, mediaAsset, pictureType, refusedBy, saveTimeline, timelineOf, uploadParts } from '../lib/editordata.ts';
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

test('the editor gets the brand look the job was started with — before the montage the style starts from it', () => withFake(async ({ fake, gh }) => {
  const style = { variant: 'B', font: 'rubik', hand: 'caveat', colors: { text: '#FFFFFF', accent: '#FF5C8A', bar: '#FFD23F' }, subY: 1300 };
  const look = { style, dim: 30, music: null, from: { job: '261013-101010-abcd', title: 'IMG_1.MOV', at: '2026-10-13T10:10:10.000Z' } };
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  fake.commit(`claude/job-${ID}`, {
    [`${DIR}/job.json`]: JSON.stringify({ ...JOB, brand: { handle: '@pavel', look } }), [`${DIR}/status.json`]: JSON.stringify(STATUS),
    [`${DIR}/edit.json`]: JSON.stringify(EDIT),
  });
  assert.deepEqual((await loadEditor(gh, ID))?.brandLook, look);
  fake.commit(`claude/job-${ID}`, { [`${DIR}/job.json`]: JSON.stringify(JOB) });
  assert.equal((await loadEditor(gh, ID))?.brandLook, null, 'без «Мой стиль» — null');
}));

test('only the proxy and the proxies of B-roll clips are served as editor media', () => {
  const files = { released: JSON.parse(released('final.mp4', 'proxy.mp4', 'broll-b2.mp4', 'upload-b2.mov.part-00000')) };
  assert.equal(mediaAsset(files, 'proxy.mp4')?.id, 501);
  assert.equal(mediaAsset(files, 'broll-b2.mp4')?.id, 502);
  assert.equal(mediaAsset(files, 'upload-b2.mov.part-00000'), null, 'клип целиком — нет: только его прокси');
  assert.equal(mediaAsset(files, 'broll-b3.mp4'), null);
  assert.equal(mediaAsset(files, 'final.mp4'), null, 'ролик — через download');
  assert.equal(mediaAsset({ released: null }, 'proxy.mp4'), null);
});

test('the proxy the player takes from the release is the one the engine writes', () => {
  const schema = JSON.parse(readFileSync(new URL('../../engine/vm/schemas/editor.json', import.meta.url), 'utf8'));
  const file = schema.properties.proxy.properties.file.const as string;
  assert.equal(file, 'out/proxy.mp4');
  assert.deepEqual([...MEDIA_NAMES], [file.replace(/^out\//, '')], 'в релиз Action кладёт файл out/ под его именем');
});

test('the editor gets the B-roll clips of the job: a video — from its proxy once it is in the release, a picture — from /upload', () => withFake(async ({ fake, gh }) => {
  const up = (n: number, ext: string, name: string, kind: string) => ({ file: `in/uploads/upload-${kind === 'broll' ? 'b' : 'i'}${n}.${ext}`, asset: `upload-b${n}.${ext}`, name, size: 1, type: 'video/mp4', kind });
  const job = { ...JOB, uploads: [up(1, 'mov', 'зал.MOV', 'broll'), up(2, 'jpg', 'кадр.jpg', 'broll'), up(3, 'mp4', 'руки.mp4', 'broll'), up(1, 'png', 'logo.png', 'image')] };
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  fake.commit(`claude/job-${ID}`, {
    [`${DIR}/job.json`]: JSON.stringify(job), [`${DIR}/status.json`]: JSON.stringify(STATUS), [`${DIR}/edit.json`]: JSON.stringify(EDIT),
    [`${DIR}/out/released.json`]: released('proxy.mp4', 'broll-b1.mp4'),
  });
  const e = await loadEditor(gh, ID);
  assert.deepEqual(e?.brolls, [
    { src: 'in/uploads/upload-b1.mov', name: 'зал.MOV', video: true, url: `/api/jobs/${ID}/media?name=broll-b1.mp4` },
    { src: 'in/uploads/upload-b2.jpg', name: 'кадр.jpg', video: false, url: `/api/jobs/${ID}/upload?name=upload-b2.jpg` },
    { src: 'in/uploads/upload-b3.mp4', name: 'руки.mp4', video: true, url: null },
  ], 'прокси третьего ещё нет (vm broll не прошёл) — плеер покажет метку');
  assert.ok(isUploadPicture('upload-b2.jpg') && !isUploadPicture('upload-b2.mov'));
}));

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
    { base: 0, edits: [], words: [{ t0: 1, t1: 1.3, text: 'огонь🔥' }] }, // эмодзи в субтитрах не пропустит проверка шрифтов
    { base: 0, edits: [], text: { hook: { text: 'Лучший ★ кофе' } } }, { base: 0, edits: [], words: [{ t0: 1, t1: 1.3, text: '✓' }] }, // и ★, ✓
    { base: 0, edits: [], text: { end: { lines: ['Подпишись ★'] } } }, { base: 0, edits: [], text: { end: { handle: '@pavel ♪' } } }]) { // и на карточке
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
/** Схема timeline.json, как она была до `what`: перестановки кусков (фаза 4), текста (фаза 5), картинки (фаза 5в). */
function olderSchema(what: 'move' | 'text' | 'picture' | 'looks' | 'broll' | 'tear'): string {
  const s = JSON.parse(SCHEMA_NOW);
  s.properties.transitions.items.properties.kind.enum = ['flash', 'zoom', 'blur']; // до рваной бумаги и глитча
  if (what === 'tear') return JSON.stringify(s);
  for (const f of ['src', 'from', 'layout', 'audio']) delete s.properties.text.properties.inserts.items.properties[f]; // до перебивок
  if (what === 'broll') return JSON.stringify(s);
  if (what === 'looks') { // до своих кусков ч/б и фильтров: куски сессии только убирались
    s.properties.looks.items = { type: 'object', required: ['at', 'off'], additionalProperties: false, properties: { at: { $ref: '#/$defs/At' }, off: { const: true } } };
    return JSON.stringify(s);
  }
  for (const k of ['zoom', 'looks', 'transitions', 'dim', 'teaser', 'speed']) delete s.properties[k];
  delete s.$defs.Music.properties.file;
  delete s.properties.text.properties.end;
  for (const k of ['accents', 'inserts']) {
    const item = s.properties.text.properties[k].items;
    for (const f of ['x', 'y', 'w']) delete item.properties[f];
    delete item.dependentRequired;
  }
  if (what !== 'picture') {
    delete s.properties.text;
    delete s.properties.words;
  }
  if (what === 'move') s.properties.edits.items.oneOf = s.properties.edits.items.oneOf.filter((o: { properties: { op: { const: string } } }) => o.properties.op.const !== 'move');
  return JSON.stringify(s);
}

test('before the montage the editor edits only what «Превью» and the questions do not choose', () => {
  const all = abilitiesOf(SCHEMA_NOW);
  // до монтажа скорость, затемнение фона и трек выбирают «Превью» и вопросы: правка руками молча перебила бы ответ
  assert.deepEqual(editorGates(true, false, all),
    { move: true, zoom: true, marks: false, looks: true, lookHand: true, track: false, speed: false, teaser: false, text: false, card: false, place: false, broll: false },
    'куски с фильтром — и до монтажа: держатся за своё место');
  assert.deepEqual(editorGates(true, true, all),
    { move: true, zoom: true, marks: true, looks: true, lookHand: true, track: true, speed: true, teaser: true, text: true, card: true, place: true, broll: true });
  assert.ok(Object.values(editorGates(false, true, all)).every((on) => !on), 'идёт сессия — ничего не правится');
  assert.deepEqual(editorGates(true, true, { ...all, video: false, track: false }),
    { move: true, zoom: true, marks: true, looks: true, lookHand: true, track: false, speed: false, teaser: false, text: true, card: true, place: true, broll: true }, 'старый движок');
  const older = abilitiesOf(olderSchema('looks'));
  assert.deepEqual([editorGates(true, false, older).looks, editorGates(true, true, older).looks, editorGates(true, true, older).lookHand], [false, true, false],
    'движок до своих кусков: куски сессии убираются и возвращаются после монтажа, своих нет');
});

test('what the job\'s engine takes is read from its own schema in the job branch', () => {
  const none5c = { picture: false, track: false, card: false, video: false, place: false, looks: false, broll: false, tear: false };
  assert.deepEqual(abilitiesOf(SCHEMA_NOW), { edits: true, move: true, text: true, picture: true, track: true, card: true, video: true, place: true, looks: true, broll: true, tear: true });
  assert.deepEqual(abilitiesOf(olderSchema('looks')), { edits: true, move: true, text: true, picture: true, track: true, card: true, video: true, place: true, looks: false, broll: false, tear: false });
  assert.deepEqual(abilitiesOf(olderSchema('broll')), { edits: true, move: true, text: true, picture: true, track: true, card: true, video: true, place: true, looks: true, broll: false, tear: false });
  assert.deepEqual(abilitiesOf(olderSchema('tear')), { edits: true, move: true, text: true, picture: true, track: true, card: true, video: true, place: true, looks: true, broll: true, tear: false });
  for (const kind of ['tear', 'glitch'] as const) {
    assert.match(refusedBy({ ...abilitiesOf(SCHEMA_NOW), tear: false }, { edits: [], transitions: [{ at: 3, kind }] }) ?? '', /до рваной бумаги и глитча/, kind);
  }
  assert.equal(refusedBy({ ...abilitiesOf(SCHEMA_NOW), tear: false }, { edits: [], transitions: [{ at: 3, kind: 'blur' }] }), null, 'прежние виды — как всегда');
  assert.match(refusedBy({ ...abilitiesOf(SCHEMA_NOW), tear: false }, { edits: [], text: { inserts: [{ at: [1, 2], layout: 'window' }] } }) ?? '', /клипа в окошке/);
  assert.match(refusedBy({ ...abilitiesOf(SCHEMA_NOW), broll: false }, { edits: [], text: { inserts: [{ at: [1, 2], layout: 'pip' }] } }) ?? '', /до перебивок/);
  assert.equal(refusedBy({ ...abilitiesOf(SCHEMA_NOW), broll: false }, { edits: [], text: { inserts: [{ at: [1, 2], t0: 1.2 }] } }), null, 'время вставки — как всегда');
  assert.deepEqual(abilitiesOf(olderSchema('picture')), { edits: true, move: true, text: true, ...none5c });
  assert.deepEqual(abilitiesOf(olderSchema('text')), { edits: true, move: true, text: false, ...none5c });
  assert.deepEqual(abilitiesOf(olderSchema('move')), { edits: true, move: false, text: false, ...none5c });
  assert.deepEqual(abilitiesOf(null), { edits: false, move: false, text: false, ...none5c }, 'схемы нет — задача до редактора: её движок правок руками не знает');
  assert.deepEqual(abilitiesOf('{не json'), { edits: true, move: true, text: true, picture: true, track: true, card: true, video: true, place: true, looks: true, broll: true, tear: true }, 'схема есть, но не читается — движок нынешний');
  const all = { edits: true, move: true, text: true, picture: true, track: true, card: true, video: true, place: true, looks: true, broll: true, tear: true };
  for (const looks of [[{ t0: 1, t1: 2, look: 'bw' as const }], [{ at: [1, 2] as [number, number], t0: 0.8, t1: 2 }], [{ at: [1, 2] as [number, number], look: 'sepia' as const }]]) {
    assert.match(refusedBy({ ...all, looks: false }, { edits: [], looks }) ?? '', /до своих кусков ч\/б и фильтров/, JSON.stringify(looks));
    assert.equal(refusedBy(all, { edits: [], looks }), null);
  }
  assert.equal(refusedBy({ ...all, looks: false }, { edits: [], looks: [{ at: [1, 2], off: true }] }), null, 'убрать кусок сессии — как раньше');
  for (const picture of [{ edits: [], zoom: 0.5 }, { edits: [], looks: [{ at: [1, 2] as [number, number], off: true as const }] }, { edits: [], transitions: [{ at: 3, off: true as const }] },
    { edits: [], dim: 0 }]) {
    assert.match(refusedBy({ ...all, picture: false }, picture) ?? '', /до правок картинки/, JSON.stringify(picture));
    assert.equal(refusedBy(all, picture), null);
  }
  assert.match(refusedBy({ ...all, track: false }, { edits: [], music: { file: 'assets/music/b.mp3' } }) ?? '', /до выбора трека/);
  assert.equal(refusedBy({ ...all, track: false }, { edits: [], music: { gainDb: -8 } }), null, 'громкость — как всегда');
  assert.match(refusedBy({ ...all, card: false }, { edits: [], text: { end: { off: true } } }) ?? '', /до правок финальной карточки/);
  for (const video of [{ edits: [], teaser: false as const }, { edits: [], speed: 1.2 }]) {
    assert.match(refusedBy({ ...all, video: false }, video) ?? '', /до правок скорости и тизера/, JSON.stringify(video));
  }
  for (const place of [{ edits: [], text: { inserts: [{ at: [2, 3] as [number, number], x: 200, y: 600, w: 400 }] } },
    { edits: [], text: { accents: [{ at: [3, 4] as [number, number], x: 300, y: 1200 }] } }]) {
    assert.match(refusedBy({ ...all, place: false }, place) ?? '', /до перетаскивания вставок и акцентов/, JSON.stringify(place));
    assert.equal(refusedBy(all, place), null);
  }
  assert.equal(refusedBy({ ...all, place: false }, { edits: [], text: { inserts: [{ at: [2, 3], t0: 2.2 }] } }), null, 'время вставки — как всегда');
  const text = { edits: [], words: [{ t0: 1, t1: 2, text: 'это' }] };
  assert.match(refusedBy({ ...all, text: false, picture: false }, text) ?? '', /до правок текста/);
  assert.match(refusedBy({ ...all, move: false }, { edits: [{ op: 'move', t0: 1, t1: 2, before: null }] }) ?? '', /до перестановки/);
  assert.equal(refusedBy(all, text), null);
  assert.match(refusedBy(abilitiesOf(null), { edits: [{ op: 'cut', t0: 1, t1: 2 }] }) ?? '', /до редактора/, 'старая задача — никакие правки');
});

test('a job made before text edits: the editor knows it, and the server does not save what its engine would refuse', () => withFake(async ({ fake, gh }) => {
  start(fake);
  fake.commit(`claude/job-${ID}`, { [ENGINE_SCHEMA]: olderSchema('text') }, 'old engine');
  assert.deepEqual((await loadEditor(gh, ID))?.abilities, { edits: true, move: true, text: false, picture: false, track: false, card: false, video: false, place: false, looks: false, broll: false, tear: false });
  const r = await saveTimeline(gh, ID, { base: 0, edits: [], text: { hook: { until: 2 } } }, NOW);
  assert.ok(!r.ok && r.status === 409 && /до правок текста/.test(r.error), JSON.stringify(r));
  assert.equal(timelineFile(fake), null, 'ничего не записано');
  assert.ok((await saveTimeline(gh, ID, { base: 0, ...HAND }, NOW)).ok, 'куски — как всегда');
}));

test('the music library of the job\'s branch is offered as tracks; a track that is not there is not saved', () => withFake(async ({ fake, gh }) => {
  start(fake);
  fake.commit(`claude/job-${ID}`, { 'assets/music/b track.mp3': 'mp3', 'assets/music/a.m4a': 'm4a', 'assets/music/notes.txt': 'текст' }, 'library');
  assert.deepEqual((await loadEditor(gh, ID))?.library, ['assets/music/a.m4a', 'assets/music/b track.mp3'], 'по алфавиту, только звук');
  const missing = await saveTimeline(gh, ID, { base: 0, edits: [], music: { file: 'assets/music/нет.mp3' } }, NOW);
  assert.ok(!missing.ok && missing.status === 409 && /нет в библиотеке/.test(missing.error), JSON.stringify(missing));
  assert.ok((await saveTimeline(gh, ID, { base: 0, edits: [], music: { file: 'assets/music/a.m4a' } }, NOW)).ok, 'трек из библиотеки');
}));

test('a job made before the editor (no timeline.json schema in its branch): its engine reads no hand edits — the server saves none', () => withFake(async ({ fake, gh }) => {
  start(fake);
  fake.commit(`claude/job-${ID}`, { [ENGINE_SCHEMA]: null }, 'before the editor');
  assert.deepEqual((await loadEditor(gh, ID))?.abilities, { edits: false, move: false, text: false, picture: false, track: false, card: false, video: false, place: false, looks: false, broll: false, tear: false });
  const r = await saveTimeline(gh, ID, { base: 0, ...HAND }, NOW);
  assert.ok(!r.ok && r.status === 409 && /до редактора/.test(r.error), JSON.stringify(r));
  assert.equal(timelineFile(fake), null, 'ничего не записано');
}));

test('pictures of the layer in the editor: Pavel\'s uploads from the release, the rest from the branch as the engine finds them', () => {
  assert.equal(layerUrl(ID, 'abc', 'in/uploads/upload-i2.png'), `/api/jobs/${ID}/upload?name=upload-i2.png`);
  assert.equal(layerUrl(ID, 'abc', 'in/uploads/upload-q-logo.jpg'), `/api/jobs/${ID}/upload?name=upload-q-logo.jpg`);
  assert.equal(layerUrl(ID, 'abc', 'assets/library/arrow.png'), `/api/jobs/${ID}/file?path=assets%2Flibrary%2Farrow.png&v=abc`);
  assert.equal(layerUrl(ID, null, 'in/brand/logo.png'), `/api/jobs/${ID}/file?path=in%2Fbrand%2Flogo.png`);
  assert.ok(isUploadPicture('upload-i12.webp') && isUploadPicture('upload-q-x1a2b3c4d.png'));
  for (const bad of ['upload-i2.mov', 'source.mp4', '../upload-i2.png', 'upload-voice.m4a', 'upload-i2.png.part-00001']) assert.ok(!isUploadPicture(bad), bad);
});

test('a picture Pavel uploaded is found whole or by its parts, in order (uploads are stored as <file>.part-NNNNN)', () => {
  const a = (name: string, id: number) => ({ name, id, size: 10 });
  const assets = [a('upload-i1.png.part-00001', 2), a('upload-i1.png.part-00000', 1), a('upload-i2.jpg.part-00000', 3), a('upload-q-logo.png', 4),
    a('upload-i3.png.part-00001', 5)];
  assert.deepEqual(uploadParts(assets, 'upload-i1.png')?.map((x) => x.id), [1, 2], 'куски — по порядку');
  assert.deepEqual(uploadParts(assets, 'upload-i2.jpg')?.map((x) => x.id), [3], 'один кусок');
  assert.deepEqual(uploadParts(assets, 'upload-q-logo.png')?.map((x) => x.id), [4], 'целый ассет');
  assert.equal(uploadParts(assets, 'upload-i3.png'), null, 'нет первого куска — картинки нет');
  assert.equal(uploadParts(assets, 'upload-i9.png'), null);
  assert.equal(pictureType('upload-i1.png'), 'image/png');
  assert.equal(pictureType('upload-q-x.jpeg'), 'image/jpeg');
});

test('while Claude mounts a new style from the editor, the editor knows the style the video is still in (the last fix\'s styleFrom)', () => withFake(async ({ fake, gh }) => {
  const was = { variant: 'B', font: 'rubik', hand: 'caveat', colors: { text: '#FFFFFF', accent: '#FF5C8A', bar: '#FFFFFF' }, subY: 1300 };
  const fix = { text: 'Правки в редакторе', at: '2026-10-12T14:59:00Z', version: 2, timeline: 3, style: true, styleFrom: was };
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  fake.commit(`claude/job-${ID}`, {
    [`${DIR}/job.json`]: JSON.stringify({ ...JOB, runs: [...JOB.runs, { step: 'fix', attempt: 1, at: fix.at }] }),
    [`${DIR}/status.json`]: JSON.stringify({ state: 'queued', phase: 'В очереди', message: '…', at: fix.at }),
    [`${DIR}/fix.json`]: JSON.stringify({ fixes: [fix] }), [`${DIR}/answers.json`]: JSON.stringify(ANSWERS), [`${DIR}/edit.json`]: JSON.stringify(EDIT),
    [`${DIR}/out/released.json`]: released('final.mp4'),
  });
  const working = await loadEditor(gh, ID);
  assert.equal(working?.screen, 'working');
  assert.deepEqual(working?.styleFrom, was, 'ролик ещё в прошлом стиле: новый ляжет поверх него (vm style --onto)');
  // монтаж нового стиля сорвался: answers.json — уже новый, edit.json — ещё прошлый; кадр — как в панели «Стиль»
  fake.commit(`claude/job-${ID}`, { [`${DIR}/status.json`]: JSON.stringify({ state: 'error', phase: 'Ошибка', message: 'упал рендер', at: fix.at }) });
  const failed = await loadEditor(gh, ID);
  assert.equal(failed?.screen, 'error');
  assert.deepEqual(failed?.styleFrom, was, 'правка не вышла — ролик всё ещё в прошлом стиле');
  fake.commit(`claude/job-${ID}`, { [`${DIR}/status.json`]: JSON.stringify({ state: 'queued', phase: 'В очереди', message: '…', at: fix.at }) });
  const { style: _style, styleFrom: _from, ...textOnly } = fix;
  fake.commit(`claude/job-${ID}`, { [`${DIR}/fix.json`]: JSON.stringify({ fixes: [textOnly] }) });
  assert.equal((await loadEditor(gh, ID))?.styleFrom, null, 'правка без нового стиля — null');
  fake.commit(`claude/job-${ID}`, { [`${DIR}/fix.json`]: JSON.stringify({ fixes: [fix] }), [`${DIR}/out/released.json`]: released('final.mp4', 'final-v2.mp4') });
  const done = await loadEditor(gh, ID);
  assert.ok(done?.screen === 'result' && done.styleFrom === null, 'новая версия готова — ролик уже в новом стиле');
}));

test('what the player shows for a full-frame cut-in: a B-roll clip — its proxy, other uploaded videos — nothing (a note), the rest — as the layer', () => {
  const brolls = [{ src: 'in/uploads/upload-b1.mov', name: 'зал.MOV', video: true, url: '/api/jobs/x/media?name=broll-b1.mp4' },
    { src: 'in/uploads/upload-b2.mov', name: 'руки.MOV', video: true, url: null }];
  assert.equal(coverUrl(ID, 'h1', brolls, 'in/uploads/upload-b1.mov'), '/api/jobs/x/media?name=broll-b1.mp4');
  assert.equal(coverUrl(ID, 'h1', brolls, 'in/uploads/upload-b2.mov'), null, 'прокси ещё нет');
  assert.equal(coverUrl(ID, 'h1', brolls, 'in/uploads/upload-i1.mp4'), null, 'видео-вставка целиком не отдаётся');
  assert.equal(coverUrl(ID, 'h1', brolls, 'in/uploads/upload-i2.png'), layerUrl(ID, 'h1', 'in/uploads/upload-i2.png'));
  assert.equal(coverUrl(ID, 'h1', brolls, 'assets/library/a.mp4'), layerUrl(ID, 'h1', 'assets/library/a.mp4'));
});
