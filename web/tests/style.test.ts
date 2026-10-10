import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initialDraft, pick } from '../lib/answers.ts';
import type { Question, StyleChoice, Styles } from '../lib/jobfiles.ts';
import { choiceFor, finalStyle, loadChoice, resolveInserts, sampleState, saveChoice, SWATCHES } from '../lib/style.ts';
import { blockedStorage, memoryStorage } from './helpers.ts';

// Общая с движком фикстура: final_style в engine/vm/style.py обязан давать то же самое.
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/style-merge.json', import.meta.url), 'utf8')) as {
  styles: Styles; answers: { style: StyleChoice }; expected: unknown;
};
const STYLES = FIXTURE.styles;

test('finalStyle matches the shared engine fixture', () => {
  assert.deepEqual(finalStyle(STYLES, FIXTURE.answers.style), FIXTURE.expected);
});

test('switching variant resets font, hand and colors', () => {
  const c = STYLES.variants[2].spec;
  assert.deepEqual(choiceFor(STYLES, 'C'), { variant: 'C', font: c.font, hand: c.hand, colors: { text: c.colors.text, accent: c.colors.accent, bar: c.colors.bar } });
  assert.deepEqual(finalStyle(STYLES, choiceFor(STYLES, 'C')), c, 'a variant as it is');
});

test('sampleState groups subtitles like the engine', () => {
  const spec = (mode: 'karaoke' | 'plate' | 'word' | 'accumulate', words = 3) => ({ ...STYLES.variants[0].spec, subtitles: { ...STYLES.variants[0].spec.subtitles, mode, words } });
  const six = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5'];
  assert.deepEqual(sampleState(spec('karaoke'), { words: six, spoken: 4 }, null, []).sub, { words: ['w3', 'w4', 'w5'], active: 1, visible: 3 });
  assert.deepEqual(sampleState(spec('word'), { words: six, spoken: 4 }, null, []).sub, { words: ['w4'], active: 0, visible: 1 });
  assert.deepEqual(sampleState(spec('accumulate', 3), { words: six, spoken: 4 }, null, []).sub, { words: six, active: 4, visible: 5 });
  const five = ['v0', 'v1', 'v2', 'v3', 'v4'];
  assert.deepEqual(sampleState(spec('plate'), { words: five, spoken: 2 }, null, []).sub, { words: ['v2', 'v3', 'v4'], active: 0, visible: 3 });
  assert.deepEqual(sampleState(spec('karaoke'), { words: ['Да.', 'Ну', 'вот', 'так'], spoken: 0 }, null, []).sub, { words: ['Да.'], active: 0, visible: 1 });
  const state = sampleState(spec('karaoke'), { words: six, spoken: 0 }, 'Как я учу чешский', []);
  assert.deepEqual(state.hook, { text: 'Как я учу чешский' });
  assert.equal(sampleState(spec('karaoke'), { words: [], spoken: 0 }, null, []).sub, undefined);
});

test('question inserts follow the answer', () => {
  const qs: Question[] = [{ id: 'logo', type: 'insert', title: 'Вставка', options: [
    { id: 'logo-a', label: 'Логотип', image: '../../assets/logos/logo.png' }, { id: 'sticker', label: 'Стикер' }, { id: 'upload', label: 'Своя' }, { id: 'none', label: 'Не надо' }] }];
  const sample = { words: [], spoken: 0, inserts: [
    { kind: 'image' as const, x: 70, y: 500, w: 250, question: 'logo' },
    { kind: 'image' as const, src: 'in/uploads/upload-i1.png', x: 600, y: 700, w: 300 },
    { kind: 'sticker' as const, title: 'Важно', text: 'каждый день', x: 600, y: 900, w: 380 },
  ] };
  const url = (p: string) => `/file?path=${p}`;
  const q = qs[0];
  const at = (id: string | null, local: string | null = null) =>
    resolveInserts(sample, qs, id ? pick(initialDraft(qs), q, id) : initialDraft(qs), url, () => local);
  const fixed = [
    { kind: 'image', src: '/file?path=in/uploads/upload-i1.png', x: 600, y: 700, w: 300, anim: 1, t: 0 },
    { kind: 'sticker', title: 'Важно', text: 'каждый день', x: 600, y: 900, w: 380, anim: 1, t: 0 },
  ];
  assert.deepEqual(at('none'), fixed);
  assert.deepEqual(at(null), fixed, 'nothing picked — no insert yet');
  assert.deepEqual(at('sticker'), fixed, 'a variant without a picture is decided at render');
  assert.deepEqual(at('logo-a')[0], { kind: 'image', src: '/file?path=../../assets/logos/logo.png', x: 70, y: 500, w: 250, anim: 1, t: 0 });
  assert.deepEqual(at('upload'), fixed, 'after a reload the picked file is gone');
  assert.equal(at('upload', 'blob:mine')[0].src, 'blob:mine');
});

test('saved choice resets after a restyle', () => {
  const store = memoryStorage();
  const id = '261010-120000-ab12';
  const b = { ...choiceFor(STYLES, 'B'), font: 'rubik', colors: { ...choiceFor(STYLES, 'B').colors, accent: '#00AAFF' } };
  assert.deepEqual(loadChoice(store, id, STYLES), choiceFor(STYLES, 'A'), 'nothing saved — A');
  saveChoice(store, id, STYLES, b);
  assert.deepEqual(loadChoice(store, id, STYLES), b);
  const restyled = { ...STYLES, variants: STYLES.variants.map((v) => ({ ...v, label: `${v.label}, без плашки` })) };
  assert.deepEqual(loadChoice(store, id, restyled), choiceFor(restyled, 'A'), 'new variants — the choice starts over');
  store.setItem(`vm:style:${id}`, '{bad');
  assert.deepEqual(loadChoice(store, id, STYLES), choiceFor(STYLES, 'A'));
  assert.deepEqual(loadChoice(blockedStorage, id, STYLES), choiceFor(STYLES, 'A'));
  saveChoice(blockedStorage, id, STYLES, b); // не бросает
});

test('swatches are #RRGGBB', () => {
  assert.deepEqual(SWATCHES.accent.map((s) => s.color), ['#FFD23F', '#7CF2B0', '#FF5C8A', '#5CC8FF', '#B892FF']);
  assert.deepEqual(SWATCHES.text.map((s) => s.color), ['#FFFFFF', '#FFF1C2', '#DDF7FF']);
  assert.deepEqual(SWATCHES.bar.map((s) => s.color), ['#FFD23F', '#FFFFFF', '#7CF2B0', '#FF5C8A']);
  for (const list of Object.values(SWATCHES)) for (const s of list) assert.match(s.color, /^#[0-9A-F]{6}$/), assert.ok(s.name);
});
