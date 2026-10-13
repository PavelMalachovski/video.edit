import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initialDraft, pick } from '../lib/answers.ts';
import type { Question, StyleChoice, Styles } from '../lib/jobfiles.ts';
import { brandChoice, loadAb, saveAb, loadAd, saveAd, loadCover, saveCover, coverOf, underCaption, allowedFonts, choiceFor, clampHookSize, insertKey, INSERT_W, loadInsertBoxes, moveBox, moveCentre, ownAdjustments, placedInserts, placeText, resizeBox, saveInsertBoxes, clampHookY, clampSubShade, clampSubSize, clampSubY, finalStyle, mergeStyle, SHADE_DEFAULT, shadeKindOf, shadeKindOk, withShadeKind, HOOK_SIZE, HOOK_Y, HOOK_Y_DEFAULT, SUB_SHADE, SUB_SIZE, loadChoice, loadSpeed, resolveInserts, sampleState, saveChoice, saveSpeed, SPEEDS, SUB_Y, SWATCHES, textPlace } from '../lib/style.ts';
import { blockedStorage, memoryStorage } from './helpers.ts';

// Общая с движком фикстура: final_style в engine/vm/style.py обязан давать то же самое.
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/style-merge.json', import.meta.url), 'utf8')) as {
  styles: Styles; answers: { style: StyleChoice }; expected: unknown;
};
const STYLES = FIXTURE.styles;

test('finalStyle matches the shared engine fixture', () => {
  assert.deepEqual(finalStyle(STYLES, FIXTURE.answers.style), FIXTURE.expected);
});

test('a new style from the editor lands on the video’s style as the engine merges it (vm style --onto)', () => {
  const merge = (FIXTURE as unknown as { merge: { name: string; base: unknown; ours: unknown; theirs: unknown; expected: unknown }[] }).merge;
  assert.ok(merge.length >= 4);
  for (const c of merge) assert.deepStrictEqual(mergeStyle(c.base, c.ours, c.theirs), c.expected, c.name);
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

test('sampleState shows a soft block like the engine: up to two lines of N words, the whole block on the frame', () => {
  const base = STYLES.variants[0].spec;
  const soft = (words = 3) => ({ ...base, subtitles: { ...base.subtitles, mode: 'soft' as const, words } });
  const seven = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
  // фраза 7 слов, блок до 6: блоки [3] и [4] → второй блок — две строки по 2
  // opens — блок начинает предложение (как у движка): второй блок фразы — нет, его первое слово шаблон не трогает
  assert.deepEqual(sampleState(soft(), { words: seven, spoken: 5 }, null, []).sub, { words: ['w3', 'w4', 'w5', 'w6'], active: 0, visible: 4, lines: [2, 2], opens: false });
  assert.deepEqual(sampleState(soft(), { words: seven, spoken: 1 }, null, []).sub, { words: ['w0', 'w1', 'w2'], active: 0, visible: 3, lines: [3], opens: true });
  assert.deepEqual(sampleState(soft(2), { words: ['Да.', 'Ну', 'вот', 'так'], spoken: 2 }, null, []).sub, { words: ['Ну', 'вот', 'так'], active: 0, visible: 3, lines: [1, 2], opens: true });
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
  assert.deepEqual(SWATCHES.accent.map((s) => s.color), ['#EDE4C1', '#FFD23F', '#7CF2B0', '#FF5C8A', '#5CC8FF', '#B892FF']);
  assert.deepEqual(SWATCHES.text.map((s) => s.color), ['#FFFFFF', '#FFF1C2', '#DDF7FF']);
  assert.deepEqual(SWATCHES.bar.map((s) => s.color), ['#EDE4C1', '#FFD23F', '#FFFFFF', '#7CF2B0', '#FF5C8A']);
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

test('hook and subtitles dragged on the editor frame: from the drawn place, within ADJUST, by its step', () => {
  const plain = choiceFor(STYLES, 'B');
  const b = finalStyle(STYLES, plain);
  assert.deepEqual(textPlace(b, 'sub'), { y: b.subtitles.y, size: b.subtitles.size, range: SUB_Y, sizes: SUB_SIZE });
  assert.deepEqual(textPlace(b, 'hook'), { y: b.hook.y, size: b.hook.size, range: HOOK_Y, sizes: HOOK_SIZE });
  const { y: _y, ...noY } = b.hook;
  assert.equal(textPlace({ ...b, hook: noY }, 'hook').y, HOOK_Y_DEFAULT, 'хук без места в стиле — где его ставит шаблон');
  assert.equal(placeText(plain, 'sub', { y: 1234.4 }).subY, 1230);
  assert.equal(placeText(plain, 'sub', { size: 71 }).subSize, 72);
  assert.deepEqual(placeText(plain, 'sub', { y: 900 }), { ...plain, subY: 900 }, 'размер не трогает');
  const hook = placeText(plain, 'hook', { y: 5000, size: 10 });
  assert.deepEqual([hook.hookY, hook.hookSize], [HOOK_Y.max, HOOK_SIZE.min]);
  assert.equal(hook.subY, undefined, 'субтитры не трогает');
  assert.equal(finalStyle(STYLES, placeText(plain, 'hook', { y: 747 })).hook.y, 750);
});

test('shade under the subtitles: off unless Pavel turns it on, from none to 80 % by 5 %', () => {
  const plain = choiceFor(STYLES, 'B');
  assert.equal(finalStyle(STYLES, plain).subtitles.shade, undefined, 'по умолчанию — без пятна');
  assert.equal(finalStyle(STYLES, { ...plain, subShade: 0.6 }).subtitles.shade, 0.6);
  assert.deepEqual([SUB_SHADE.min, SUB_SHADE.max], [0, 0.8]);
  assert.equal(clampSubShade(0.63), 0.65);
  assert.equal(clampSubShade(0.15 + 0.05 + 0.4), 0.6, 'без хвоста дробей: 0.6, а не 0.6000000000000001');
  for (let k = 0; k <= 16; k++) assert.equal(clampSubShade(k * 0.05), (k * 5) / 100);
  assert.equal(clampSubShade(-1), 0);
  assert.equal(clampSubShade(2), SUB_SHADE.max);
  const store = memoryStorage();
  const id = '261012-120000-ab96';
  saveChoice(store, id, STYLES, { ...plain, subShade: 0.6 });
  assert.equal(loadChoice(store, id, STYLES).subShade, 0.6);
  saveChoice(store, id, STYLES, { ...plain, subShade: 0.95 });
  assert.deepEqual(loadChoice(store, id, STYLES), choiceFor(STYLES, 'A'), 'a shade out of range is not taken back');
});

test('shade kind: the spot unless Pavel picks the shadow or the plate; kept across variants and reloads', () => {
  const plain = choiceFor(STYLES, 'A');
  assert.equal(finalStyle(STYLES, plain).subtitles.shadeKind, undefined, 'по умолчанию — пятно (поля нет)');
  assert.equal(finalStyle(STYLES, { ...plain, subShade: 0.6, subShadeKind: 'plate' }).subtitles.shadeKind, 'plate');
  // вид без силы включает затемнение на SHADE_DEFAULT, с силой — оставляет её
  const on = withShadeKind(plain, 'shadow', finalStyle(STYLES, plain));
  assert.deepEqual([on.subShade, on.subShadeKind], [SHADE_DEFAULT, 'shadow']);
  const dim = { ...plain, subShade: 0.35 };
  const kept = withShadeKind(dim, 'plate', finalStyle(STYLES, dim));
  assert.deepEqual([kept.subShade, kept.subShadeKind], [0.35, 'plate']);
  assert.equal(shadeKindOf(finalStyle(STYLES, plain)), 'spot');
  assert.equal(shadeKindOf(finalStyle(STYLES, kept)), 'plate');
  // другой вариант (как pickVariant «Превью» и редактора): шрифты и цвета — его, места, размеры и затемнение Павла остаются
  assert.deepEqual({ ...choiceFor(STYLES, 'C'), ...ownAdjustments({ ...plain, subShade: 0.35, subShadeKind: 'plate', subY: 1200 }) },
    { ...choiceFor(STYLES, 'C'), subShade: 0.35, subShadeKind: 'plate', subY: 1200 });
  const store = memoryStorage();
  const id = '261012-120000-ab95';
  saveChoice(store, id, STYLES, { ...plain, subShade: 0.6, subShadeKind: 'shadow' });
  assert.equal(loadChoice(store, id, STYLES).subShadeKind, 'shadow');
  saveChoice(store, id, STYLES, { ...plain, subShade: 0.6, subShadeKind: 'glow' as 'plate' });
  assert.deepEqual(loadChoice(store, id, STYLES), choiceFor(STYLES, 'A'), 'an unknown kind is not taken back');
});

test('shade kind: the strength already on the frame stays — a text fix of the video in the editor, the variant\'s own', () => {
  const plain = choiceFor(STYLES, 'A');
  // у смонтированного ролика затемнение 0,4 — от правки текстом (в выборе Павла его нет): вид его не перебивает
  const base = finalStyle(STYLES, plain);
  const video = { ...base, subtitles: { ...base.subtitles, shade: 0.4 } };
  const fixed = withShadeKind(plain, 'shadow', video);
  assert.deepEqual(fixed, { ...plain, subShadeKind: 'shadow' }, 'сила — как на кадре, выбор силы не появился');
  const shown = mergeStyle(base, video, finalStyle(STYLES, fixed)); // так кадр редактора сложит новый выбор с роликом
  assert.deepEqual([shown.subtitles.shade, shown.subtitles.shadeKind], [0.4, 'shadow']);
  // правка текстом затемнение убрала, а в выборе Павла оно есть: вид включает его заново — на SHADE_DEFAULT
  const chosen = { ...plain, subShade: 0.4 };
  const bare = finalStyle(STYLES, plain);
  const again = withShadeKind(chosen, 'plate', bare);
  assert.equal(again.subShade, SHADE_DEFAULT);
  assert.equal(mergeStyle(finalStyle(STYLES, chosen), bare, finalStyle(STYLES, again)).subtitles.shade, SHADE_DEFAULT, 'на кадре — снова видно');
  // затемнение выключено ползунком — тоже SHADE_DEFAULT; своё затемнение варианта — остаётся
  const off = { ...plain, subShade: 0 };
  assert.equal(withShadeKind(off, 'plate', finalStyle(STYLES, off)).subShade, SHADE_DEFAULT);
  const own = { ...STYLES, variants: STYLES.variants.map((v) => (v.id === 'A' ? { ...v, spec: { ...v.spec, subtitles: { ...v.spec.subtitles, shade: 0.3 } } } : v)) };
  assert.deepEqual(withShadeKind(plain, 'shadow', finalStyle(own, plain)), { ...plain, subShadeKind: 'shadow' }, 'у варианта своё — сила его');
});

test('shade kind buttons: under subtitles on their own plate only the spot', () => {
  const spec = (variant: 'A' | 'B' | 'C', c: Partial<StyleChoice> = {}) => finalStyle(STYLES, { ...choiceFor(STYLES, variant), ...c });
  assert.equal(spec('B').subtitles.mode, 'plate');
  assert.deepEqual((['spot', 'shadow', 'plate'] as const).map((k) => shadeKindOk(spec('B'), k)), [true, false, false]);
  assert.deepEqual((['spot', 'shadow', 'plate'] as const).map((k) => shadeKindOk(spec('A'), k)), [true, true, true]);
  // в редакторе вид субтитров выбирают сами: на плашке — только пятно, без плашки у варианта с ней — все три
  assert.deepEqual((['spot', 'shadow', 'plate'] as const).map((k) => shadeKindOk(spec('A', { subMode: 'plate' }), k)), [true, false, false]);
  assert.deepEqual((['spot', 'shadow', 'plate'] as const).map((k) => shadeKindOk(spec('B', { subMode: 'soft' }), k)), [true, true, true]);
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
  // с тенью (поля рамки от шаблона): в зоне — вся рамка, как её проверяет монтаж (qa: «вставка вне безопасной зоны»)
  const ext = { left: 24, top: 16, right: 24 }; // тень карточки: 24 px по бокам, 16 сверху; рамка — 248 высотой
  assert.deepEqual(moveBox({ x: 400, y: 300, w: 200 }, -50, -50, 248, ext), { x: 84, y: 136, w: 200 });
  assert.deepEqual(moveBox({ x: 400, y: 300, w: 200 }, 5000, 5000, 248, ext), { x: 666, y: 1298, w: 200 });
  assert.deepEqual(resizeBox({ x: 70, y: 500, w: 250 }, 330, 250, ext), { x: 84, y: 500, w: 330 }, 'шире у левого края — от края зоны с тенью');
});

test('an accent dragged on the frame: its whole block (the template\'s box around the centre) stays in the safe zone', () => {
  const box = { w: 300, h: 200 }; // блок вокруг центра: 150 влево и вправо, 100 вверх и вниз
  assert.deepEqual(moveCentre(box, 600.4, 1000.6), { x: 600, y: 1001 });
  assert.deepEqual(moveCentre(box, 0, 0), { x: 210, y: 220 }, 'левый верхний угол зоны');
  assert.deepEqual(moveCentre(box, 5000, 5000), { x: 740, y: 1430 }, 'правый нижний угол зоны');
  assert.deepEqual(moveCentre({ w: 1000, h: 1500 }, 700, 300), { x: 475, y: 825 }, 'шире и выше зоны — посередине неё');
  assert.deepEqual(moveCentre({ w: 10, h: 10 }, -100, 9999), { x: 65, y: 1525 });
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

test('a thesis sticker keeps its text and tone on the preview, moves by its id and hides when Pavel unticks it', () => {
  const sample = {
    words: [], spoken: 0,
    inserts: [
      { kind: 'text' as const, id: 's1', text: '3 ошибки 🔥', x: 120, y: 700, w: 420, params: { tone: 'dark' } },
      { kind: 'text' as const, id: 's2', text: '1. Свет', x: 120, y: 900, w: 300 },
    ],
  };
  const stickers = { id: 'stickers', type: 'multi' as const, title: 'Стикеры', options: [{ id: 's1', label: '0:12 — 3 ошибки' }, { id: 's2', label: '0:20 — Свет' }], default: ['s1', 's2'] };
  const url = (p: string) => `/f/${p}`;
  const all = resolveInserts(sample, [stickers], initialDraft([stickers]), url, () => null, { s1: { x: 200, y: 760, w: 500 } });
  assert.deepEqual(all.map((i) => [i.key, i.kind, i.text, i.x, i.w, i.params?.tone]), [['s1', 'text', '3 ошибки 🔥', 200, 500, 'dark'], ['s2', 'text', '1. Свет', 120, 300, undefined]]);
  const one = resolveInserts(sample, [stickers], pick(initialDraft([stickers]), stickers, 's1'), url, () => null);
  assert.deepEqual(one.map((i) => i.key), ['s2'], 'снятый стикер не рисуется');
  assert.deepEqual(resolveInserts(sample, [], initialDraft([]), url, () => null).map((i) => i.key), ['s1', 's2'], 'без вопроса — все');
  // другой вопрос с несколькими ответами и тем же id варианта (звёздочки «s1») стикеры не трогает — как в ролике
  const stars = { id: 'stars', type: 'multi' as const, title: 'Звёздочки', options: [{ id: 's1', label: 'бл*н' }], default: ['s1'] };
  const qs = [stars, stickers];
  const noStar = pick(initialDraft(qs), stars, 's1');
  assert.deepEqual(resolveInserts(sample, qs, noStar, url, () => null).map((i) => i.key), ['s1', 's2'], 'снятая звёздочка не прячет стикер');
  assert.deepEqual(resolveInserts(sample, qs, pick(initialDraft(qs), stickers, 's1'), url, () => null).map((i) => i.key), ['s2']);
});

test('the A/B choice is remembered per job and junk is dropped', () => {
  const store = memoryStorage();
  const id = '261011-120000-ab95';
  assert.equal(loadAb(store, id), null);
  saveAb(store, id, 'music');
  assert.equal(loadAb(store, id), 'music');
  saveAb(store, id, null);
  assert.equal(loadAb(store, id), null);
  store.setItem(`vm:ab:${id}`, 'colors');
  assert.equal(loadAb(store, id), null);
  assert.equal(loadAb(blockedStorage, id), null);
});

test('the cover choice is remembered per job: the frame alone, or the frame and Pavel\'s own text; junk is dropped', () => {
  const store = memoryStorage();
  const id = '261011-120000-c0ve';
  assert.equal(loadCover(store, id), null);
  saveCover(store, id, { frame: 2, text: 'Как я учу' });
  assert.deepEqual(loadCover(store, id), { frame: 2, text: 'Как я учу' });
  saveCover(store, id, { frame: 1 });
  assert.deepEqual(loadCover(store, id), { frame: 1 });
  saveCover(store, id, { frame: 1, text: '' });
  assert.deepEqual(loadCover(store, id), { frame: 1, text: '' }, 'стёр текст — обложка снова за хуком, кадр остаётся');
  for (const junk of [{ frame: 9, text: 'x' }, { frame: 0, text: 5 }, { frame: 0, text: 'x'.repeat(81) }]) {
    store.setItem(`vm:cover:${id}`, JSON.stringify(junk));
    assert.equal(loadCover(store, id), null, JSON.stringify(junk));
  }
});

test('the cover follows the hook Pavel chose until he types his own text, and keeps his frame', () => {
  const styles = { ...STYLES, cover: { frames: [{ t: 1, image: 'cover-1.jpg' }, { t: 2, image: 'cover-2.jpg' }, { t: 3, image: 'cover-3.jpg' }], text: 'Как я учу чешский' } };
  assert.deepEqual(coverOf(null, styles, 'Как я снимаю reels'), { frame: 0, text: 'Как я снимаю reels' });
  assert.deepEqual(coverOf({ frame: 2 }, styles, null), { frame: 2, text: 'Как я учу чешский' }, 'без хука — текст Claude');
  assert.deepEqual(coverOf({ frame: 2, text: '  ' }, styles, 'Хук Павла'), { frame: 2, text: 'Хук Павла' });
  assert.deepEqual(coverOf({ frame: 1, text: ' Свой текст ' }, styles, 'Хук Павла'), { frame: 1, text: 'Свой текст' });
  assert.equal(coverOf({ frame: 5 }, styles, null)?.frame, 0, 'кадра с таким номером нет — первый');
  assert.equal(coverOf(null, styles, 'x'.repeat(81))?.text, 'Как я учу чешский', 'хук длиннее обложки — текст Claude');
  assert.equal(coverOf({ frame: 1 }, { ...STYLES, cover: undefined }, 'Хук'), null);
});

test('the ads version choice is remembered per job', () => {
  const store = memoryStorage();
  const id = '261011-120000-ad00';
  assert.equal(loadAd(store, id), false);
  saveAd(store, id, true);
  assert.equal(loadAd(store, id), true);
  saveAd(store, id, false);
  assert.equal(loadAd(store, id), false);
});

test('subtitles may go down to just above the time bar; below the Reels safe zone the page says the caption may cover them', () => {
  assert.equal(clampSubY(1900), 1760);
  assert.equal(clampSubY(1757), 1760);
  const high = { x: 200, y: 1400, w: 500, h: 120 };
  const low = { ...high, y: 1450 };
  assert.equal(underCaption(high), false);
  assert.equal(underCaption(low), true, 'низ на 1570 — ниже 1530');
  assert.equal(underCaption(undefined), false);
});

test('Pavel\'s choice lands in the final style as the engine builds it — the subtitle mode and words too (shared fixture)', () => {
  const choices = (FIXTURE as unknown as { choices: { name: string; choice: StyleChoice; expected: unknown }[] }).choices;
  assert.ok(choices.length >= 3);
  for (const c of choices) assert.deepStrictEqual(finalStyle(FIXTURE.styles as Styles, c.choice), c.expected, c.name);
});

test('«Мой стиль» of the brand: a new job starts from it — its variant, fonts the video can show, its speed', () => {
  const mine: StyleChoice = {
    variant: 'B', font: 'rubik', hand: 'caveat', colors: { text: '#FFFFFF', accent: '#FF5C8A', bar: '#FFD23F' }, subY: 1300, subSize: 70, subMode: 'soft', barPos: 'top',
  };
  assert.deepEqual(brandChoice(STYLES, mine), mine);
  assert.equal(brandChoice(STYLES, { ...mine, variant: 'C' as const }).variant, 'C');
  const latin = { ...STYLES, fonts: { main: ['montserrat'], hand: ['caveat'] } }; // в Rubik нет букв этого ролика
  assert.deepEqual(brandChoice(latin, mine), { ...mine, font: STYLES.variants[1].spec.font }, 'шрифт без букв ролика — шрифт варианта');
  const store = memoryStorage();
  assert.deepEqual(loadChoice(store, 'j', STYLES, mine), mine, 'Павел ещё не выбирал — «Мой стиль»');
  assert.deepEqual(loadChoice(store, 'j', STYLES, { ...mine, subSize: 999 }), choiceFor(STYLES, 'A'), 'испорченный — вариант A');
  saveChoice(store, 'j', STYLES, choiceFor(STYLES, 'C'));
  assert.deepEqual(loadChoice(store, 'j', STYLES, mine), choiceFor(STYLES, 'C'), 'выбор Павла на этом ролике важнее');
  assert.equal(loadSpeed(store, 'k', 1.3), 1.3);
  assert.equal(loadSpeed(store, 'k', 2), 1.1, 'не из списка — по умолчанию');
  saveSpeed(store, 'k', 1.2);
  assert.equal(loadSpeed(store, 'k', 1.3), 1.2);
});
