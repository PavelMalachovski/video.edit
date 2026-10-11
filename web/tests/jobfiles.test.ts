import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  abLabels, answersFile, appendFix, appendRestyle, buildJobFile, errorStatus, finalNames, parseAnswersBody, parseNote, parseResult, parseStatus, parseStyles,
  QUESTION_TYPES, queuedStatus, STATES, wantedVersion, type Manifest, type Question,
  AB_KINDS, SAMPLE_INSERT_KINDS,
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
  for (const subY of [100, 1500, '1100', Number.NaN]) {
    assert.ok('error' in parseAnswersBody({ answers: { hook: 'h1' }, style: { ...STYLE, subY } }, QS), String(subY));
  }
  const { properties } = schema('answers.json').properties.style;
  assert.deepEqual([properties.subY.minimum, properties.subY.maximum], [240, 1440]);
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
});
