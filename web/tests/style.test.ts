import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initialDraft, pick } from '../lib/answers.ts';
import type { Question, StyleChoice, Styles } from '../lib/jobfiles.ts';
import { allowedFonts, choiceFor, clampHookSize, insertKey, INSERT_W, loadInsertBoxes, moveBox, placedInserts, resizeBox, saveInsertBoxes, clampHookY, clampSubSize, clampSubY, finalStyle, HOOK_SIZE, HOOK_Y, SUB_SIZE, loadChoice, loadSpeed, resolveInserts, sampleState, saveChoice, saveSpeed, SPEEDS, SUB_Y, SWATCHES } from '../lib/style.ts';
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
    { kind: 'image', src: '/file?path=in/uploads/upload-i1.png', x: 600, y: 700, w: 300, anim: 1, t: 0, key: 'in/uploads/upload-i1.png' },
    { kind: 'sticker', title: 'Важно', text: 'каждый день', x: 600, y: 900, w: 380, anim: 1, t: 0 },
  ];
  assert.deepEqual(at('none'), fixed);
  assert.deepEqual(at(null), fixed, 'nothing picked — no insert yet');
  assert.deepEqual(at('sticker'), fixed, 'a variant without a picture is decided at render');
  assert.deepEqual(at('logo-a')[0], { kind: 'image', src: '/file?path=../../assets/logos/logo.png', x: 70, y: 500, w: 250, anim: 1, t: 0, key: 'logo' });
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

test('only fonts with every letter of the video are offered', () => {
  const list = [
    { id: 'montserrat', kind: 'main' as const }, { id: 'russo-one', kind: 'main' as const },
    { id: 'caveat', kind: 'hand' as const }, { id: 'bad-script', kind: 'hand' as const },
  ];
  assert.deepEqual(allowedFonts(list, STYLES), list, 'no fonts in styles.json — every font');
  const romanian = { ...STYLES, fonts: { main: ['montserrat'], hand: ['caveat', 'bad-script'] } };
  assert.deepEqual(allowedFonts(list, romanian).map((f) => f.id), ['montserrat', 'caveat', 'bad-script']);
  assert.deepEqual(allowedFonts(list, { ...STYLES, fonts: { main: ['montserrat'], hand: [] } }).map((f) => f.id), ['montserrat', 'caveat', 'bad-script'], 'an empty list hides nothing: Pavel keeps buttons');
});

test('a saved font without the letters of the video is not taken back', () => {
  const store = memoryStorage();
  const id = '261010-120000-cd34';
  const fonts = { main: ['montserrat', 'rubik'], hand: [STYLES.variants[0].spec.hand] };
  const styles = { ...STYLES, fonts };
  saveChoice(store, id, styles, { ...choiceFor(styles, 'A'), font: 'rubik' });
  assert.equal(loadChoice(store, id, styles).font, 'rubik');
  saveChoice(store, id, styles, { ...choiceFor(styles, 'A'), font: 'russo-one' });
  assert.deepEqual(loadChoice(store, id, styles), choiceFor(styles, 'A'));
});

test('speed buttons: 1.0 to 1.5 by 0.1, the rule 1.1 by default, remembered per job', () => {
  assert.deepEqual(SPEEDS, [1, 1.1, 1.2, 1.3, 1.4, 1.5]);
  const store = memoryStorage();
  const id = '261010-120000-ef56';
  assert.equal(loadSpeed(store, id), 1.1);
  saveSpeed(store, id, 1.3);
  assert.equal(loadSpeed(store, id), 1.3);
  store.setItem(`vm:speed:${id}`, '7');
  assert.equal(loadSpeed(store, id), 1.1, 'not one of the buttons — the rule');
  assert.equal(loadSpeed(blockedStorage, id), 1.1);
  saveSpeed(blockedStorage, id, 1.2); // не бросает
});

test('subtitles: Pavel moves them up or down, inside the safe zone, by 10 px', () => {
  const plain = choiceFor(STYLES, 'B');
  assert.equal(finalStyle(STYLES, plain).subtitles.y, STYLES.variants[1].spec.subtitles.y, 'not moved — as in the variant');
  assert.equal(finalStyle(STYLES, { ...plain, subY: 900 }).subtitles.y, 900);
  assert.equal(clampSubY(1234), 1230);
  assert.equal(clampSubY(10), SUB_Y.min);
  assert.equal(clampSubY(5000), SUB_Y.max);
  const store = memoryStorage();
  const id = '261010-120000-ab99';
  saveChoice(store, id, STYLES, { ...plain, subY: 900 });
  assert.equal(loadChoice(store, id, STYLES).subY, 900);
  saveChoice(store, id, STYLES, { ...plain, subY: 50 });
  assert.deepEqual(loadChoice(store, id, STYLES), choiceFor(STYLES, 'A'), 'a place outside the zone is not taken back');
});

test('hook: Pavel moves it up or down, inside the safe zone, by 10 px', () => {
  const plain = choiceFor(STYLES, 'B');
  assert.equal(finalStyle(STYLES, plain).hook.y, STYLES.variants[1].spec.hook.y, 'not moved — as in the variant');
  assert.equal(finalStyle(STYLES, { ...plain, hookY: 700 }).hook.y, 700);
  assert.equal(clampHookY(456), 460);
  assert.equal(clampHookY(0), HOOK_Y.min);
  assert.equal(clampHookY(1900), HOOK_Y.max);
  const store = memoryStorage();
  const id = '261010-120000-ab98';
  saveChoice(store, id, STYLES, { ...plain, hookY: 700 });
  assert.equal(loadChoice(store, id, STYLES).hookY, 700);
  saveChoice(store, id, STYLES, { ...plain, hookY: 1500 });
  assert.deepEqual(loadChoice(store, id, STYLES), choiceFor(STYLES, 'A'), 'a place outside the zone is not taken back');
});

test('sizes: Pavel makes the hook and subtitles bigger or smaller, within limits, by 2 px', () => {
  const plain = choiceFor(STYLES, 'B');
  const b = STYLES.variants[1].spec;
  assert.deepEqual([finalStyle(STYLES, plain).subtitles.size, finalStyle(STYLES, plain).hook.size], [b.subtitles.size, b.hook.size]);
  const big = finalStyle(STYLES, { ...plain, subSize: 80, hookSize: 100 });
  assert.deepEqual([big.subtitles.size, big.hook.size], [80, 100]);
  assert.equal(clampSubSize(71), 72);
  assert.equal(clampSubSize(5), SUB_SIZE.min);
  assert.equal(clampHookSize(500), HOOK_SIZE.max);
  const store = memoryStorage();
  const id = '261010-120000-ab97';
  saveChoice(store, id, STYLES, { ...plain, subSize: 80, hookSize: 100 });
  assert.deepEqual([loadChoice(store, id, STYLES).subSize, loadChoice(store, id, STYLES).hookSize], [80, 100]);
  saveChoice(store, id, STYLES, { ...plain, hookSize: 300 });
  assert.deepEqual(loadChoice(store, id, STYLES), choiceFor(STYLES, 'A'), 'a size out of range is not taken back');
});

test('insert boxes follow the shared engine fixture', () => {
  const fx = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/insert-boxes.json', import.meta.url), 'utf8'));
  assert.deepEqual(placedInserts(fx.inserts, fx.boxes), fx.expected);
  assert.deepEqual(placedInserts(fx.inserts, {}), fx.inserts);
  assert.equal(insertKey({ question: 'insert-1', src: 'x.png' }), 'insert-1');
  assert.equal(insertKey({ src: 'x.png' }), 'x.png');
  assert.equal(insertKey({}), null, 'a sticker without question or src has no key: it is not moved');
});

test('resizing keeps the centre and the top; moving follows the finger; both stay inside the safe zone', () => {
  assert.deepEqual(resizeBox({ x: 400, y: 300, w: 200 }, 160, 200), { x: 420, y: 300, w: 160 });
  assert.deepEqual(resizeBox({ x: 70, y: 500, w: 250 }, 330, 250), { x: 60, y: 500, w: 330 }, 'the left edge of the zone');
  assert.deepEqual(resizeBox({ x: 600, y: 900, w: 280 }, 400, 280), { x: 490, y: 900, w: 400 }, 'the right edge of the zone');
  assert.deepEqual(resizeBox({ x: 400, y: 1300, w: 200 }, 400, 200), { x: 300, y: 1130, w: 400 }, 'taller now — pushed up from the bottom');
  assert.equal(resizeBox({ x: 400, y: 300, w: 200 }, 5, 200).w, INSERT_W.min);
  assert.deepEqual(moveBox({ x: 400, y: 300, w: 200 }, 455.4, 610.6, 200), { x: 455, y: 611, w: 200 });
  assert.deepEqual(moveBox({ x: 400, y: 300, w: 200 }, -50, 5000, 200), { x: 60, y: 1330, w: 200 });
});

test('preview inserts are drawn where Pavel put them', () => {
  const sample = { words: [], spoken: 0, inserts: [{ kind: 'image' as const, src: 'a.png', x: 600, y: 900, w: 280 }] };
  const [ins] = resolveInserts(sample, [], initialDraft([]), (p) => `/f/${p}`, () => null, { 'a.png': { x: 490, y: 700, w: 400 } });
  assert.deepEqual([ins.x, ins.y, ins.w, ins.key], [490, 700, 400, 'a.png']);
});

test('insert boxes are remembered per job; junk is dropped', () => {
  const store = memoryStorage();
  const id = '261010-120000-ab96';
  assert.deepEqual(loadInsertBoxes(store, id), {});
  saveInsertBoxes(store, id, { 'insert-1': { x: 60, y: 420, w: 330 } });
  assert.deepEqual(loadInsertBoxes(store, id), { 'insert-1': { x: 60, y: 420, w: 330 } });
  store.setItem(`vm:inserts:${id}`, JSON.stringify({ old: 330, big: { x: 60, y: 420, w: 5000 }, ok: { x: 100, y: 200, w: 200 } }));
  assert.deepEqual(loadInsertBoxes(store, id), { ok: { x: 100, y: 200, w: 200 } });
  assert.deepEqual(loadInsertBoxes(blockedStorage, id), {});
});
