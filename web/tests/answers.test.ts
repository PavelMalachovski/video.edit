import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswers, initialDraft, loadDraft, pick, pictureAsset, previewHook, saveDraft, type LocalUpload } from '../lib/answers.ts';
import type { Question } from '../lib/jobfiles.ts';
import { blockedStorage, memoryStorage } from './helpers.ts';

const QS: Question[] = [
  { id: 'cut', type: 'choice', title: 'Резать паузы?', options: [{ id: 'all', label: 'Всё' }, { id: 'edges', label: 'Только края' }], default: 'all' },
  { id: 'hook', type: 'choice', title: 'Хук', options: [{ id: 'h1', label: 'Как я учу чешский' }, { id: 'own', label: 'Свой' }, { id: 'none', label: 'Без хука' }], default: 'h1' },
  { id: 'brand', type: 'word', title: 'Как пишется?', options: [{ id: 'coplanly', label: 'CoPlanly' }, { id: 'copilot', label: 'Copilot' }, { id: 'own', label: 'Напишу сам' }] },
  { id: 'logo', type: 'insert', title: 'Вставка', image: 'q-logo.jpg', options: [{ id: 'logo-a', label: 'Логотип', image: '../../assets/logos/logo.png' }, { id: 'upload', label: 'Загрузить свою' }, { id: 'none', label: 'Не надо' }] },
  { id: 'stars', type: 'multi', title: 'Звёздочки', options: [{ id: 'r', label: 'р*бли' }, { id: 'b', label: 'беспл*тно' }, { id: 'p', label: 'подп*ска' }], default: ['r', 'b', 'p'] },
  { id: 'note', type: 'text', title: 'Кодовое слово', default: 'ПЛАН' },
];
const q = (id: string) => QS.find((x) => x.id === id)!;
const done: LocalUpload = { asset: 'upload-q-logo.png', name: 'мой.png', size: 70, type: 'image/png', parts: 1, done: true };

test('defaults are preselected', () => {
  const d = initialDraft(QS);
  assert.deepEqual(d.picks.cut, ['all']);
  assert.deepEqual(d.picks.stars, ['r', 'b', 'p']);
  assert.equal(d.texts.note, 'ПЛАН');
  const built = buildAnswers(QS, d);
  assert.deepEqual(built.missing, ['brand', 'logo']);
  assert.equal(built.answers.cut, 'all');
  assert.equal(built.answers.hook, 'h1');
});

test('own needs text and writes <qid>.own', () => {
  let d = pick(initialDraft(QS), q('hook'), 'own');
  assert.ok(buildAnswers(QS, d).missing.includes('hook'));
  d = { ...d, texts: { ...d.texts, hook: '  Как я снимаю reels ' } };
  const { answers, missing } = buildAnswers(QS, d);
  assert.equal(answers.hook, 'own');
  assert.equal(answers['hook.own'], 'Как я снимаю reels');
  assert.ok(!missing.includes('hook'));
});

test('upload needs a finished upload', () => {
  const d = pick(initialDraft(QS), q('logo'), 'upload');
  assert.ok(buildAnswers(QS, d).missing.includes('logo'));
  const half = { ...d, uploads: { logo: { ...done, done: false } } };
  assert.ok(buildAnswers(QS, half).missing.includes('logo'));
  const ok = buildAnswers(QS, { ...d, uploads: { logo: done } });
  assert.equal(ok.answers.logo, 'upload');
  assert.deepEqual(ok.uploads, { logo: done });
  assert.ok(!ok.missing.includes('logo'));
  const other = buildAnswers(QS, { ...pick(d, q('logo'), 'logo-a'), uploads: { logo: done } });
  assert.deepEqual(other.uploads, {}, 'a picture of an answer that is not «upload» is not sent');
});

test('multi toggles and may be empty', () => {
  let d = pick(initialDraft(QS), q('stars'), 'b');
  assert.deepEqual(buildAnswers(QS, d).answers.stars, ['r', 'p']);
  d = pick(d, q('stars'), 'b');
  assert.deepEqual(buildAnswers(QS, d).answers.stars, ['r', 'b', 'p'], 'option order, not click order');
  d = pick(pick(pick(d, q('stars'), 'r'), q('stars'), 'b'), q('stars'), 'p');
  const built = buildAnswers(QS, d);
  assert.deepEqual(built.answers.stars, []);
  assert.ok(!built.missing.includes('stars'));
  assert.deepEqual(pick(pick(initialDraft(QS), q('cut'), 'edges'), q('cut'), 'all').picks.cut, ['all'], 'choice keeps one');
});

test('text falls back to default, otherwise missing', () => {
  const d = initialDraft(QS);
  assert.equal(buildAnswers(QS, { ...d, texts: { ...d.texts, note: '   ' } }).answers.note, 'ПЛАН');
  const bare: Question[] = [{ id: 'word', type: 'text', title: 'Слово' }];
  assert.deepEqual(buildAnswers(bare, initialDraft(bare)).missing, ['word']);
  assert.equal(buildAnswers(bare, { ...initialDraft(bare), texts: { word: 'чешский' } }).answers.word, 'чешский');
});

test('previewHook follows the hook question, else the sample hook', () => {
  const d = initialDraft(QS);
  assert.equal(previewHook(QS, d, 'из styles'), 'Как я учу чешский');
  const own = { ...pick(d, q('hook'), 'own'), texts: { ...d.texts, hook: 'Как я снимаю reels' } };
  assert.equal(previewHook(QS, own), 'Как я снимаю reels');
  assert.equal(previewHook(QS, pick(d, q('hook'), 'none'), 'из styles'), null);
  const text: Question[] = [{ id: 'hook', type: 'text', title: 'Хук', default: 'Мой хук' }];
  assert.equal(previewHook(text, initialDraft(text)), 'Мой хук');
  const quoted: Question[] = [{ id: 'hook', type: 'choice', title: 'Хук', options: [{ id: 'h1', label: '«Как я учу чешский»' }], default: 'h1' }];
  assert.equal(previewHook(quoted, initialDraft(quoted)), 'Как я учу чешский', 'кавычки подписи — не часть хука');
  const noHook = QS.filter((x) => x.id !== 'hook');
  assert.equal(previewHook(noHook, initialDraft(noHook), 'из styles'), 'из styles');
  assert.equal(previewHook(noHook, initialDraft(noHook)), null);
});

test('saved draft survives reload and drops unknown options; corrupt storage gives defaults', () => {
  const store = memoryStorage();
  const id = '261010-120000-ab12';
  const d = { ...pick(pick(initialDraft(QS), q('brand'), 'copilot'), q('stars'), 'b'), uploads: { logo: done } };
  saveDraft(store, id, d);
  assert.deepEqual(loadDraft(store, id, QS), d);
  assert.deepEqual(loadDraft(store, '261010-120000-zz99', QS), initialDraft(QS), 'another job has its own draft');
  const raw = JSON.parse(store.getItem(`vm:draft:${id}`)!);
  raw.picks.gone = ['x'];
  raw.picks.cut = ['zzz'];
  store.setItem(`vm:draft:${id}`, JSON.stringify(raw));
  const loaded = loadDraft(store, id, QS);
  assert.equal(loaded.picks.gone, undefined);
  assert.deepEqual(loaded.picks.cut, ['all'], 'an unknown option falls back to the default');
  assert.deepEqual(loaded.picks.brand, ['copilot']);
  store.setItem(`vm:draft:${id}`, '{bad');
  assert.deepEqual(loadDraft(store, id, QS), initialDraft(QS));
  assert.deepEqual(loadDraft(blockedStorage, id, QS), initialDraft(QS));
  assert.deepEqual(loadDraft(null, id, QS), initialDraft(QS));
  saveDraft(blockedStorage, id, d); // не бросает
});

test('a re-picked answer picture never reuses an asset that has parts in the draft', () => {
  assert.deepEqual(pictureAsset('logo', 'мой.png', 'image/png', new Set()), { asset: 'upload-q-logo.png', n: 1 });
  assert.deepEqual(pictureAsset('logo', 'мой.png', 'image/png', new Set(['upload-q-logo.png'])), { asset: 'upload-q-logo-2.png', n: 2 });
  assert.deepEqual(pictureAsset('logo', 'b.jpg', 'image/jpeg', new Set(['upload-q-logo-2.jpg']), 2), { asset: 'upload-q-logo-3.jpg', n: 3 });
});
