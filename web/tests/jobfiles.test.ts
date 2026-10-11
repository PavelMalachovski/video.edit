import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  abLabels, answersFile, appendFix, appendRestyle, buildJobFile, coverName, errorStatus, finalNames, isFinalName, parseAnswersBody, parseNote, parseResult, parseStatus, parseStyles,
  QUESTION_TYPES, queuedStatus, STATES, wantedVersion, type Manifest, type Question,
  AB_KINDS, CHECK_IDS, parseReview, REVIEW_IDS, SAMPLE_INSERT_KINDS,
} from '../lib/jobfiles.ts';
import { STEPS } from '../lib/routine.ts';

const schema = (name: string) => JSON.parse(readFileSync(new URL(`../../engine/vm/schemas/${name}`, import.meta.url), 'utf8'));
const NOW = new Date(Date.UTC(2026, 9, 10, 7, 5, 9));

test('states and question types match the engine schemas', () => {
  assert.deepEqual([...STATES], schema('status.json').properties.state.enum);
  assert.deepEqual([...QUESTION_TYPES], schema('questions.json').properties.questions.items.properties.type.enum);
  assert.deepEqual([...SAMPLE_INSERT_KINDS], schema('styles.json').properties.sample.properties.inserts.items.properties.kind.enum);
  assert.deepEqual(schema('answers.json').required, ['answers', 'style']);
});

test('queuedStatus is valid for every step', () => {
  const at = new RegExp(schema('status.json').properties.at.pattern);
  for (const step of STEPS) {
    const s = queuedStatus(step, NOW);
    assert.equal(s.state, 'queued');
    assert.equal(s.phase, 'Запускаю сессию');
    assert.ok(at.test(s.at), s.at);
    assert.ok(s.message.startsWith('Claude '), s.message);
    assert.deepEqual(parseStatus(s), s);
  }
  const e = errorStatus('Рутина не найдена: проверьте ROUTINE_ID', 'RoutineError 404', NOW);
  assert.equal(e.state, 'error');
  assert.equal(e.phase, 'Не запустилось');
  assert.ok(parseStatus(e));
});

test('parseStatus rejects the spike status and junk', () => {
  assert.equal(parseStatus({ phase: 'boot', at: '2026-10-10T07:05:09Z' }), null);
  assert.equal(parseStatus({ state: 'flying', phase: 'x', message: 'y', at: '2026-10-10T07:05:09Z' }), null);
  assert.equal(parseStatus({ state: 'queued', phase: 'x', message: 'y', at: 'вчера' }), null);
  assert.equal(parseStatus(null), null);
  assert.equal(parseStatus('queued'), null);
});

test('buildJobFile takes brief, duration and uploads from the manifest', () => {
  const m: Manifest = {
    job: '261010-070509-abcd', name: 'IMG_1.MOV', size: 100, type: 'video/quicktime', lastModified: 1, parts: 1, chunkSize: 4,
    brief: 'ХУК: как я монтирую', duration: 75.5,
    uploads: [{ asset: 'upload-i1.mov', name: 'демо.MOV', size: 5, type: 'video/quicktime', parts: 1 },
              { asset: 'upload-i2.png', name: 'logo.png', size: 3, type: 'image/png', parts: 1 }],
  };
  const job = buildJobFile(m, NOW);
  assert.equal(job.id, '261010-070509-abcd');
  assert.equal(job.brief, 'ХУК: как я монтирую');
  assert.equal(job.duration, 75.5);
  assert.equal(job.uploads[0].file, 'in/uploads/upload-i1.mov');
  assert.equal(job.uploads[0].kind, 'video');
  assert.equal(job.uploads[1].kind, 'image');
  assert.deepEqual(job.runs, []);
  assert.equal(job.createdAt, NOW.toISOString());
  assert.equal(buildJobFile({ ...m, brief: undefined, duration: undefined, uploads: undefined }, NOW).duration, null);
});

test('a voiceover goes into job.json uploads as audio', () => {
  const job = buildJobFile({
    job: '261010-070509-abcd', name: 'IMG_1.MOV', size: 100, type: 'video/quicktime', lastModified: 1, parts: 1, chunkSize: 4,
    uploads: [{ asset: 'upload-i1.png', name: 'logo.png', size: 3, type: 'image/png', parts: 1 },
              { asset: 'upload-voice.m4a', name: 'Запись.m4a', size: 9, type: '', parts: 1 }],
  }, NOW);
  assert.deepEqual(job.uploads.map((u) => [u.file, u.kind]), [['in/uploads/upload-i1.png', 'image'], ['in/uploads/upload-voice.m4a', 'audio']]);
});

const QS: Question[] = [
  { id: 'hook', type: 'choice', title: 'Хук', options: [{ id: 'h1', label: 'A' }, { id: 'own', label: 'Свой' }, { id: 'none', label: 'Без' }] },
  { id: 'logo', type: 'insert', title: 'Лого', options: [{ id: 'a', label: 'A' }, { id: 'upload', label: 'Своя' }] },
  { id: 'stars', type: 'multi', title: 'Звёзды', options: [{ id: 's1', label: 'р*бли' }] },
];
const STYLE = { variant: 'B', font: 'rubik', hand: 'marck-script', colors: { text: '#FFFFFF', accent: '#00AAFF', bar: '#00aaff' } };
const UPLOAD = { asset: 'upload-q-logo.png', name: 'logo.png', size: 3, type: 'image/png', parts: 1 };

test('parseAnswersBody rejects unknown keys, bad colors and variants', () => {
  const good = parseAnswersBody({ answers: { hook: 'own', 'hook.own': 'Свой хук', logo: 'upload', stars: ['s1'] }, style: STYLE, uploads: { logo: UPLOAD } }, QS);
  assert.ok(!('error' in good), JSON.stringify(good));
  const bad = [
    { answers: { nope: 'x' }, style: STYLE },
    { answers: { 'nope.own': 'x' }, style: STYLE },
    { answers: { hook: 'h1' }, style: { ...STYLE, variant: 'D' } },
    { answers: { hook: 'h1' }, style: { ...STYLE, colors: { ...STYLE.colors, accent: 'blue' } } },
    { answers: { hook: 'h1' }, style: { ...STYLE, font: '../x' } },
    { answers: { hook: 'h1' }, style: STYLE, uploads: { hook: UPLOAD } },  // загрузка без ответа upload
    { answers: { logo: 'upload' }, style: STYLE },  // ответ upload без загрузки
    { answers: { logo: 'upload' }, style: STYLE, uploads: { logo: { ...UPLOAD, asset: '../x.png' } } },
    { answers: { hook: 3 }, style: STYLE },
    'junk',
  ];
  for (const b of bad) assert.ok('error' in parseAnswersBody(b, QS), JSON.stringify(b));
});

test('answersFile maps uploads to in/uploads and copies the brief', () => {
  const p = parseAnswersBody({ answers: { logo: 'upload' }, style: STYLE, uploads: { logo: UPLOAD } }, QS);
  assert.ok(!('error' in p));
  const job = buildJobFile({ job: '261010-070509-abcd', name: 'a', size: 1, type: 'video/mp4', lastModified: 1, parts: 1, chunkSize: 4, brief: 'ТЗ' }, NOW);
  const file = answersFile(p, job);
  assert.deepEqual(file.uploads, { logo: 'in/uploads/upload-q-logo.png' });
  assert.equal(file.brief, 'ТЗ');
  assert.deepEqual(file.answers, { logo: 'upload' });
  assert.equal(file.style.variant, 'B');
});

test('fix versions: final.mp4, then final-v2.mp4', () => {
  const first = appendFix(null, 'убери логотип', NOW);
  assert.equal(first.fixes[0].version, 2);
  assert.equal(appendFix(first, 'и музыку', NOW).fixes[1].version, 3);
  assert.equal(wantedVersion(null), 1);
  assert.equal(wantedVersion(first), 2);
  assert.deepEqual(finalNames(1), { mp4: 'final.mp4', srt: 'final.srt' });
  assert.equal(finalNames(3).mp4, 'final-v3.mp4');
  const r = appendRestyle(appendRestyle(null, 'ярче', NOW), 'крупнее', NOW);
  assert.deepEqual(r.requests.map((n) => n.text), ['ярче', 'крупнее']);
});

test('parseNote trims and limits to 2000 chars', () => {
  assert.equal(parseNote({ text: '  сделай ярче  ' }), 'сделай ярче');
  assert.ok(typeof parseNote({ text: '   ' }) === 'object');
  assert.ok(typeof parseNote({ text: 'я'.repeat(2001) }) === 'object');
  assert.equal(parseNote({ text: 'я'.repeat(2000) }), 'я'.repeat(2000));
  assert.ok(typeof parseNote(null) === 'object');
});

test('own font ids from assets/fonts pass: Cyrillic, spaces, -hand', () => {
  const body = (font: string, hand: string) => ({ answers: {}, style: { variant: 'A', font, hand, colors: { text: '#FFFFFF', accent: '#FFD23F', bar: '#FFD23F' } } });
  const ok = parseAnswersBody(body('Pacifico Regular', 'Мой почерк-hand'), []);
  assert.ok(!('error' in ok), JSON.stringify(ok));
  if (!('error' in ok)) assert.deepEqual([ok.style.font, ok.style.hand], ['Pacifico Regular', 'Мой почерк-hand']);
  for (const bad of ['', '   ', 'a\nb', 'x'.repeat(201), 'шрифты/свой']) {
    assert.ok('error' in parseAnswersBody(body(bad, 'caveat'), []), JSON.stringify(bad));
  }
});

test('parseStyles takes the fonts that have every letter of the video, or none', () => {
  const styles = JSON.parse(readFileSync(new URL('../../engine/tests/fixtures/style-merge.json', import.meta.url), 'utf8')).styles;
  assert.ok(parseStyles(styles), 'without fonts — all fonts');
  const fonts = { main: ['montserrat', 'comfortaa'], hand: ['bad-script'] };
  assert.deepEqual(parseStyles({ ...styles, fonts })?.fonts, fonts);
  for (const bad of [{ main: ['montserrat'] }, { main: 'montserrat', hand: [] }, { main: ['montserrat'], hand: [7] }, { main: [''], hand: [] }, []]) {
    assert.equal(parseStyles({ ...styles, fonts: bad }), null, JSON.stringify(bad));
  }
});

test('speed from 1.0 to 1.5 goes into answers.json; without it — the rule (1.1)', () => {
  const job = buildJobFile({ job: '261010-070509-abcd', name: 'a', size: 1, type: 'video/mp4', lastModified: 1, parts: 1, chunkSize: 4, brief: '' }, NOW);
  for (const speed of [1, 1.2, 1.5]) {
    const p = parseAnswersBody({ answers: { hook: 'h1' }, style: STYLE, speed }, QS);
    assert.ok(!('error' in p), JSON.stringify(p));
    assert.equal(answersFile(p, job).speed, speed);
  }
  const none = parseAnswersBody({ answers: { hook: 'h1' }, style: STYLE }, QS);
  assert.ok(!('error' in none) && !('speed' in answersFile(none, job)), 'no choice — no speed in the file');
  for (const speed of [0.9, 1.6, '1.2', Number.NaN, null]) {
    assert.ok('error' in parseAnswersBody({ answers: { hook: 'h1' }, style: STYLE, speed }, QS), String(speed));
  }
  const { properties } = schema('answers.json');
  assert.deepEqual([properties.speed.minimum, properties.speed.maximum], [1, 1.5]);
});

test('answers keep where Pavel dragged the subtitles; outside the safe zone — refused', () => {
  const p = parseAnswersBody({ answers: { hook: 'h1' }, style: { ...STYLE, subY: 1100 } }, QS);
  assert.ok(!('error' in p) && p.style.subY === 1100, JSON.stringify(p));
  const plain = parseAnswersBody({ answers: { hook: 'h1' }, style: STYLE }, QS);
  assert.ok(!('error' in plain) && !('subY' in plain.style));
  const low = parseAnswersBody({ answers: { hook: 'h1' }, style: { ...STYLE, subY: 1760 } }, QS);
  assert.ok(!('error' in low) && low.style.subY === 1760, 'субтитры можно опустить почти до низа кадра');
  for (const subY of [100, 1780, '1100', Number.NaN]) {
    assert.ok('error' in parseAnswersBody({ answers: { hook: 'h1' }, style: { ...STYLE, subY } }, QS), String(subY));
  }
  const { properties } = schema('answers.json').properties.style;
  assert.deepEqual([properties.subY.minimum, properties.subY.maximum], [240, 1760]);
});

test('answers keep where Pavel dragged the hook; outside the safe zone — refused', () => {
  const p = parseAnswersBody({ answers: { hook: 'h1' }, style: { ...STYLE, hookY: 600 } }, QS);
  assert.ok(!('error' in p) && p.style.hookY === 600, JSON.stringify(p));
  for (const hookY of [150, 1400, '600', Number.NaN]) {
    assert.ok('error' in parseAnswersBody({ answers: { hook: 'h1' }, style: { ...STYLE, hookY } }, QS), String(hookY));
  }
  const { properties } = schema('answers.json').properties.style;
  assert.deepEqual([properties.hookY.minimum, properties.hookY.maximum], [200, 1330]);
});

test('answers keep the sizes Pavel set; out of range — refused', () => {
  const p = parseAnswersBody({ answers: { hook: 'h1' }, style: { ...STYLE, subSize: 80, hookSize: 100 } }, QS);
  assert.ok(!('error' in p) && p.style.subSize === 80 && p.style.hookSize === 100, JSON.stringify(p));
  for (const bad of [{ subSize: 30 }, { subSize: 120 }, { hookSize: 40 }, { hookSize: 130 }, { hookSize: '80' }]) {
    assert.ok('error' in parseAnswersBody({ answers: { hook: 'h1' }, style: { ...STYLE, ...bad } }, QS), JSON.stringify(bad));
  }
  const { properties } = schema('answers.json').properties.style;
  assert.deepEqual([properties.subSize.minimum, properties.subSize.maximum, properties.hookSize.minimum, properties.hookSize.maximum], [40, 110, 48, 120]);
});

test('answers keep insert boxes Pavel set; out of the safe zone or junk — refused', () => {
  const job = buildJobFile({ job: '261010-070509-abcd', name: 'a', size: 1, type: 'video/mp4', lastModified: 1, parts: 1, chunkSize: 4, brief: '' }, NOW);
  const box = { x: 60, y: 420, w: 330 };
  const p = parseAnswersBody({ answers: { hook: 'h1' }, style: STYLE, insertBoxes: { 'insert-1': box } }, QS);
  assert.ok(!('error' in p), JSON.stringify(p));
  assert.deepEqual(answersFile(p, job).insertBoxes, { 'insert-1': box });
  const none = parseAnswersBody({ answers: { hook: 'h1' }, style: STYLE }, QS);
  assert.ok(!('error' in none) && !('insertBoxes' in answersFile(none, job)));
  const bad = [{ a: { x: 60, y: 420 } }, { a: { ...box, x: 20 } }, { a: { ...box, y: 60 } }, { a: { ...box, w: 900 } }, { a: 330 }, { '': box }, [box]];
  for (const insertBoxes of bad) {
    assert.ok('error' in parseAnswersBody({ answers: { hook: 'h1' }, style: STYLE, insertBoxes }, QS), JSON.stringify(insertBoxes));
  }
  const props = schema('answers.json').properties.insertBoxes.additionalProperties.properties;
  assert.deepEqual([props.x.minimum, props.x.maximum, props.y.minimum, props.y.maximum, props.w.minimum, props.w.maximum], [60, 810, 120, 1490, 80, 830]);
});

test('parseStyles takes the end card sample and refuses a broken one', () => {
  const fx = JSON.parse(readFileSync(new URL('../../engine/tests/fixtures/style-merge.json', import.meta.url), 'utf8')).styles;
  const end = { lines: ['Подпишись 👇'], handle: '@pavel', logo: 'in/brand/logo.png' };
  assert.deepEqual(parseStyles({ ...fx, sample: { ...fx.sample, end } })?.sample.end, end);
  assert.equal(parseStyles({ ...fx, sample: { ...fx.sample, end: { lines: [] } } }), null);
  assert.equal(parseStyles({ ...fx, sample: { ...fx.sample, end: { lines: ['a'], logo: 5 } } }), null);
  // ника или логотипа в бренде нет — в job.json.brand это null; тот же null в образце карточки — не поломка стилей
  const bare = { lines: ['Подпишись 👇'], handle: null, logo: null };
  assert.deepEqual(parseStyles({ ...fx, sample: { ...fx.sample, end: bare } })?.sample.end, bare);
});

test('A/B: the answers take ab — teaser or music — and version B has its own file names', () => {
  assert.deepEqual(finalNames(1, 'b'), { mp4: 'final-b.mp4', srt: 'final-b.srt' });
  assert.deepEqual(finalNames(3, 'b'), { mp4: 'final-v3-b.mp4', srt: 'final-v3-b.srt' });
  for (const ab of ['teaser', 'music'] as const) {
    const p = parseAnswersBody({ answers: {}, style: STYLE, ab }, QS);
    assert.ok(!('error' in p) && p.ab === ab, JSON.stringify(p));
    if (!('error' in p)) {
      const job = buildJobFile({ job: '261010-070509-abcd', name: 'a', size: 1, type: 'video/mp4', lastModified: 1, parts: 1, chunkSize: 4 }, NOW);
      assert.equal(answersFile(p, job).ab, ab);
    }
  }
  assert.ok('error' in parseAnswersBody({ answers: {}, style: STYLE, ab: 'colors' }, QS));
  const none = parseAnswersBody({ answers: {}, style: STYLE }, QS);
  assert.ok(!('error' in none) && none.ab === undefined);
});

test('A/B: result.json ab — what version B differs in and its check; a broken ab is dropped, the rest stays', () => {
  const result = { durations: { source: 80.2, final: 71 }, done: [], unsure: [], missing: [], qa: { ok: true, problems: [] } };
  const ab = { differs: 'teaser', durations: { source: 80.2, final: 68.5 }, qa: { ok: false, problems: ['хук на лице'] } };
  assert.deepEqual(parseResult({ ...result, ab })?.ab, ab);
  assert.equal(parseResult(result)?.ab, undefined);
  for (const bad of [{ ...ab, differs: 'hook' }, { ...ab, qa: { ok: 'no', problems: [] } }, { ...ab, durations: null }, 'teaser']) {
    const parsed = parseResult({ ...result, ab: bad });
    assert.ok(parsed && parsed.ab === undefined, JSON.stringify(bad));
  }
  assert.deepEqual(schema('result.json').properties.ab.properties.differs.enum, [...AB_KINDS]);
});

test('A/B: labels follow what version B was built without', () => {
  assert.deepEqual(abLabels('teaser'), ['A — с тизером', 'B — без тизера']);
  assert.deepEqual(abLabels('music'), ['A — с музыкой', 'B — без музыки']);
  assert.deepEqual(abLabels(null), ['A', 'B'], 'не знаем, чем отличается, — без догадок');
});

test('review.json: points of the guide, ok or warn, with a note; a broken file reads as no review', () => {
  const items = [
    { id: 'hook', title: 'Мысль в первые 2 с', status: 'warn', note: 'Мысль звучит на 0:21 — предлагаю начать с неё' },
    ...['face', 'value', 'cta', 'text'].map((id) => ({ id, title: id, status: 'ok', note: 'по гайду' })),
  ];
  assert.deepEqual(parseReview({ items }), { items });
  for (const bad of [{ items: [] }, { items: [{ ...items[0], status: 'bad' }] }, { items: [{ ...items[0], id: 'music' }] },
    { items: [{ ...items[0], note: 5 }] }, null, 'x']) {
    assert.equal(parseReview(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual([...REVIEW_IDS], schema('review.json').properties.items.items.properties.id.enum);
});

test('result.json checklist: lines of the guide check; a broken one is dropped, the rest of the result stays', () => {
  const result = { durations: { source: 80.2, final: 71 }, done: [], unsure: [], missing: [], qa: { ok: true, problems: [] } };
  const checks = [{ id: 'format', title: '9:16, 1080×1920, 30 к/с', ok: true }, { id: 'end', title: 'финальная карточка с призывом', ok: false }];
  assert.deepEqual(parseResult({ ...result, checklist: checks })?.checklist, checks);
  for (const bad of [[{ ...checks[0], ok: 'yes' }], [{ ...checks[0], id: 'fps' }], 'x']) {
    const parsed = parseResult({ ...result, checklist: bad });
    assert.ok(parsed && parsed.checklist === undefined, JSON.stringify(bad));
  }
  assert.deepEqual([...CHECK_IDS], schema('result.json').properties.checklist.items.properties.id.enum);
});

test('download takes every name finalNames gives — version B too — and nothing else', () => {
  for (const v of [1, 2, 13]) {
    for (const variant of [undefined, 'b'] as const) {
      const { mp4, srt } = finalNames(v, variant);
      assert.ok(isFinalName(mp4) && isFinalName(srt), `${mp4}, ${srt}`);
    }
  }
  for (const bad of ['final-c.mp4', 'final-b-v2.mp4', 'final.mov', '../final.mp4', 'final-v1234.mp4', 'released.json', '']) {
    assert.equal(isFinalName(bad), false, bad);
  }
});

test('cover: styles offer up to three frames and a text; the answer picks a frame and may change the text', () => {
  const fx = JSON.parse(readFileSync(new URL('../../engine/tests/fixtures/style-merge.json', import.meta.url), 'utf8')).styles;
  const cover = { frames: [{ t: 1.2, image: 'cover-1.jpg' }, { t: 7.5, image: 'cover-2.jpg' }], text: 'Как я учу чешский' };
  assert.deepEqual(parseStyles({ ...fx, cover })?.cover, cover);
  const broken = parseStyles({ ...fx, cover: { frames: [], text: 'x' } });
  assert.ok(broken && broken.cover === undefined, 'кривая обложка — без обложки, а не без стилей');
  for (const ok of [{ frame: 1, text: '  Как я учу  ' }]) {
    const p = parseAnswersBody({ answers: {}, style: STYLE, cover: ok }, QS);
    assert.ok(!('error' in p) && isDeepStrictEqual(p.cover, { frame: 1, text: 'Как я учу' }), JSON.stringify(p));
    if (!('error' in p)) {
      const job = buildJobFile({ job: '261010-070509-abcd', name: 'a', size: 1, type: 'video/mp4', lastModified: 1, parts: 1, chunkSize: 4 }, NOW);
      assert.deepEqual(answersFile(p, job).cover, { frame: 1, text: 'Как я учу' });
    }
  }
  for (const bad of [{ frame: 3, text: 'x' }, { frame: 0, text: ' ' }, { frame: 0, text: 'x'.repeat(81) }, 'x']) {
    assert.ok('error' in parseAnswersBody({ answers: {}, style: STYLE, cover: bad }, QS), JSON.stringify(bad));
  }
  assert.deepEqual(schema('answers.json').properties.cover.properties.frame.maximum, 2);
  assert.equal(coverName(1), 'final-cover.png');
  assert.equal(coverName(3), 'final-v3-cover.png');
  for (const name of ['final-cover.png', 'final-v3-cover.png']) assert.ok(isFinalName(name), name);
  for (const name of ['final-b-cover.png', 'cover.png', 'final-cover.jpg']) assert.equal(isFinalName(name), false, name);
});

test('ads version: the answers ask for it, it has its own file names and its check in result.json', () => {
  const p = parseAnswersBody({ answers: {}, style: STYLE, ad: true }, QS);
  assert.ok(!('error' in p) && p.ad === true, JSON.stringify(p));
  if (!('error' in p)) {
    const job = buildJobFile({ job: '261010-070509-abcd', name: 'a', size: 1, type: 'video/mp4', lastModified: 1, parts: 1, chunkSize: 4 }, NOW);
    assert.equal(answersFile(p, job).ad, true);
  }
  assert.ok('error' in parseAnswersBody({ answers: {}, style: STYLE, ad: 'yes' }, QS));
  const none = parseAnswersBody({ answers: {}, style: STYLE, ad: false }, QS);
  assert.ok(!('error' in none) && none.ad === undefined, 'false — как нет');
  assert.deepEqual(finalNames(2, 'ad'), { mp4: 'final-v2-ad.mp4', srt: 'final-v2-ad.srt' });
  for (const name of ['final-ad.mp4', 'final-v2-ad.srt']) assert.ok(isFinalName(name), name);
  assert.equal(isFinalName('final-b-ad.mp4'), false);
  const result = { durations: { source: 80.2, final: 71 }, done: [], unsure: [], missing: [], qa: { ok: true, problems: [] } };
  const ad = { durations: { source: 80.2, final: 71 }, qa: { ok: false, problems: ['вставка 1 вне безопасной зоны'] } };
  assert.deepEqual(parseResult({ ...result, ad })?.ad, ad);
  assert.equal(parseResult({ ...result, ad: { qa: 1 } })?.ad, undefined);
});
