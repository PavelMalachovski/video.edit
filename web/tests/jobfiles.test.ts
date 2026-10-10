import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  answersFile, appendFix, appendRestyle, buildJobFile, errorStatus, finalNames, parseAnswersBody, parseNote, parseStatus,
  QUESTION_TYPES, queuedStatus, STATES, wantedVersion, type Manifest, type Question,
} from '../lib/jobfiles.ts';
import { STEPS } from '../lib/routine.ts';

const schema = (name: string) => JSON.parse(readFileSync(new URL(`../../engine/vm/schemas/${name}`, import.meta.url), 'utf8'));
const NOW = new Date(Date.UTC(2026, 9, 10, 7, 5, 9));

test('states and question types match the engine schemas', () => {
  assert.deepEqual([...STATES], schema('status.json').properties.state.enum);
  assert.deepEqual([...QUESTION_TYPES], schema('questions.json').properties.questions.items.properties.type.enum);
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
