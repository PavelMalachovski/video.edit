// Мягкое пятно под субтитрами (`spec.subtitles.shade`, решение Павла 12.10.2026): размытый тёмный прямоугольник под
// видимыми строками — чтобы субтитры читались на светлом фоне. 1 px страницы = 1 px кадра 1080×1920.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { framePage, launch } from '../browser.mjs';
import { serve } from '../serve.mjs';
import { contains, darkenedAmong, drawnBox, pixels, whitePixels } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SPEC = {
  font: 'forum',
  hand: 'caveat',
  colors: { text: '#FFFFFF', accent: '#EDE4C1', bar: '#EDE4C1', plate: '#111111', outline: '#000000' },
  subtitles: { mode: 'soft', words: 3, size: 64, y: 1300 },
  hook: { mode: 'accent', size: 100, y: 420 },
  bar: { pos: 'bottom', height: 6 },
};
const WORDS = ['Я', 'покупаю', 'вещи,', 'чтобы', 'выглядеть', 'плохо.'];

let server;
let browser;
let page;
let scratch;

before(async () => {
  server = await serve(ROOT);
  browser = await launch();
  page = await framePage(browser);
  await page.goto(`${server.url}/overlay.html`);
  scratch = await browser.newPage();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const spec = (sub = {}) => ({ ...structuredClone(SPEC), subtitles: { ...SPEC.subtitles, ...sub } });

function render(s, state) {
  return page.evaluate(([a, b]) => window.renderState(a, b), [s, state]);
}

/** Строки субтитров: рамка букв каждой строки (по словам). */
function rows() {
  return page.evaluate(() => [...document.querySelectorAll('#sub .sline, #sub .lines')].map((row) => {
    const rs = [...row.querySelectorAll('.w')].map((w) => w.getBoundingClientRect());
    return { left: Math.min(...rs.map((r) => r.left)), right: Math.max(...rs.map((r) => r.right)), top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)) };
  }));
}

/** Непрозрачность слоя в точке (0..255): пятно — чёрное, его сила — альфа. */
async function alphaAt(x, y) {
  const d = await pixels(page, scratch, { x: Math.round(x), y: Math.round(y), width: 1, height: 1 });
  return d[3];
}

/** Точка слева от строки: на полпути по высоте, на `em` кеглей левее букв — там нет ни букв, ни их тени. */
const leftOf = (r, em = 0.3) => [r.left - em * 64, (r.top + r.bottom) / 2];

test('no shade by default: beside the line the frame stays clear', async () => {
  await render(spec(), { sub: { words: WORDS, active: 0, visible: 6, lines: [3, 3], t: 1 } });
  const [first] = await rows();
  assert.ok((await alphaAt(...leftOf(first))) < 8);
  await render(spec({ shade: 0 }), { sub: { words: WORDS, active: 0, visible: 6, lines: [3, 3], t: 1 } });
  assert.ok((await alphaAt(...leftOf(first))) < 8, 'shade 0 — выключено');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#shade .shade').length), 0);
});

test('shade: the background under the lines is darker by the amount, the edge dissolves, far away is clear', async () => {
  await render(spec({ shade: 0.6 }), { sub: { words: WORDS, active: 0, visible: 6, lines: [3, 3], t: 1 } });
  const [first, second] = await rows();
  assert.ok(second.left < first.left - 64 && second.right > first.right + 64, 'вторая строка шире первой');
  const inside = await alphaAt(...leftOf(first));
  assert.ok(Math.abs(inside - 0.6 * 255) <= 15, `в глубине пятна фон темнее на 60 %: ${inside}`);
  const near = await alphaAt(...leftOf(second));
  assert.ok(near > 0.4 * 255, `у края букв — тоже заметно: ${near}`);
  const edge = await alphaAt(...leftOf(second, 1.0));
  assert.ok(edge > 8 && edge < near - 30, `край растворяется: ${edge}`);
  assert.ok((await alphaAt(...leftOf(second, 2.2))) < 8, 'дальше — кадр как есть');
  const below = await alphaAt((second.left + second.right) / 2, second.bottom + 2.2 * 64);
  assert.ok(below < 8, `под блоком — кадр как есть: ${below}`);
});

test('shade: its strength follows the amount', async () => {
  const state = { sub: { words: WORDS, active: 0, visible: 6, lines: [3, 3], t: 1 } };
  await render(spec({ shade: 0.3 }), state);
  const [first] = await rows();
  const weak = await alphaAt(...leftOf(first));
  await render(spec({ shade: 0.8 }), state);
  const strong = await alphaAt(...leftOf(first));
  assert.ok(Math.abs(weak - 0.3 * 255) <= 15 && Math.abs(strong - 0.8 * 255) <= 25, `${weak}, ${strong}`);
});

test('shade: the layout and the box for checks do not change', async () => {
  const state = { sub: { words: WORDS, active: 0, visible: 6, lines: [3, 3], t: 1 } };
  await render(spec(), state);
  const plain = [await rows(), await page.evaluate(() => window.layoutBoxes().sub)];
  await render(spec({ shade: 0.6 }), state);
  assert.deepEqual([await rows(), await page.evaluate(() => window.layoutBoxes().sub)], plain);
});

/** Точка под строкой: по её середине, на `em` кегля ниже букв — туда не заходят буквы, разъезжающиеся при появлении. */
const below = (r, em = 0.3) => [(r.left + r.right) / 2, r.bottom + em * 64];

test('shade: only under the lines already shown, and it grows with the new line', async () => {
  const at = (visible, t) => ({ sub: { words: WORDS, active: 0, visible, lines: [3, 3], t } });
  await render(spec({ shade: 0.6 }), at(6, 1));
  const [first, second] = await rows();
  const under2 = below(second);
  const full = await alphaAt(...under2);
  await render(spec({ shade: 0.6 }), at(3, 1));
  const one = await alphaAt(...under2);
  assert.ok(one < full - 60, `вторая строка ещё не видна — под ней светлее: ${one} < ${full}`);
  assert.ok((await alphaAt(...leftOf(first))) > 0.4 * 255, 'под первой — как обычно');
  await render(spec({ shade: 0.6 }), at(6, 0));
  const start = await alphaAt(...under2);
  await render(spec({ shade: 0.6 }), at(6, 0.04));
  const mid = await alphaAt(...under2);
  assert.ok(Math.abs(start - one) <= 6, `строка только появляется — пятно ещё под одной: ${start} ≈ ${one}`);
  assert.ok(mid > start + 10 && mid < full - 10, `растёт вместе с ней: ${start} < ${mid} < ${full}`);
});

test('shade: other subtitle modes get it too', async () => {
  for (const mode of ['karaoke', 'word', 'accumulate', 'plate']) {
    const state = { sub: { words: ['раз', 'два', 'три'], active: 1, visible: 3 } };
    await render(spec({ mode }), state);
    const [line] = await rows();
    const clear = await alphaAt(...leftOf(line, 0.5));
    await render(spec({ mode, shade: 0.6 }), state);
    const dark = await alphaAt(...leftOf(line, 0.5));
    assert.ok(clear < 8 && dark > 0.3 * 255, `${mode}: ${clear} → ${dark}`);
  }
});

test('shade: it lies under the inserts — a sticker right above the subtitles keeps its colour', async () => {
  const sub = { words: WORDS, active: 0, visible: 6, lines: [3, 3], t: 1 };
  const sticker = (y) => ({ kind: 'text', text: 'стикер', x: 330, y, w: 300, anim: 1, t: 0, params: { tone: 'light' } });
  await render(spec(), { sub, inserts: [sticker(1000)] });
  const first = await page.evaluate(() => window.layoutBoxes());
  const y = 1000 + (first.sub.y - 10) - (first.inserts[0].y + first.inserts[0].h); // низ рамки стикера — в 10 px над субтитрами
  const look = async (shade) => {
    await render(spec({ shade }), { sub, inserts: [sticker(y)] });
    const ib = (await page.evaluate(() => window.layoutBoxes())).inserts[0];
    return pixels(page, scratch, { x: ib.x, y: ib.y, width: ib.w, height: ib.h });
  };
  const plain = await look(0);
  const shaded = await look(0.6);
  let solid = 0;
  let worst = 0;
  let reached = 0;
  for (let k = 0; k < plain.length; k += 4) {
    if (plain[k + 3] === 255) { // сам стикер: плашка и буквы
      solid++;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(plain[k + c] - shaded[k + c]));
    } else if (shaded[k + 3] > plain[k + 3] + 20) reached++; // у края стикера пятно видно
  }
  assert.ok(solid > 5000 && reached > 500, `стикер ${solid} px, пятно до него дотянулось на ${reached} px`);
  assert.ok(worst <= 2, `пятно легло на стикер: разница до ${worst}`);
});

// ---------- вид затемнения: тень вокруг букв и плашка (shadeKind) ----------

const boxes = () => page.evaluate(() => window.layoutBoxes());
const spotCount = () => page.evaluate(() => document.querySelectorAll('#shade .shade').length);

/** Сколько в рамке тёмных полупрозрачных пикселей — ореол вокруг букв. */
async function darkHalo(b) {
  const d = await pixels(page, scratch, { x: b.x, y: b.y, width: b.w, height: b.h });
  let n = 0;
  for (let k = 0; k < d.length; k += 4) if (d[k + 3] > 60 && d[k + 3] < 250 && d[k] < 70 && d[k + 1] < 70 && d[k + 2] < 70) n++;
  return n;
}

function softPlate() {
  return page.evaluate(() => {
    const p = document.querySelector('#sub .plate:not([hidden])');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, background: getComputedStyle(p).backgroundColor };
  });
}

/** Слова субтитров (без копии строк под ореолом): рамка, строка. */
function subWords() {
  return page.evaluate(() => [...document.querySelectorAll('#sub [data-i]')].map((e) => {
    const r = e.getBoundingClientRect();
    const line = e.closest('.sline');
    return { x: r.x, y: r.y, w: r.width, h: r.height, line: [...line.parentNode.children].indexOf(line) };
  }));
}

test('shade «shadow» in soft: a denser dark halo inside the box, no spot', async () => {
  const state = { sub: { words: WORDS, active: 3, visible: 6, lines: [3, 3], t: 1 } };
  await render(spec(), state);
  const plain = await darkHalo((await boxes()).sub);
  await render(spec({ shade: 0.8, shadeKind: 'shadow' }), state);
  const b = (await boxes()).sub;
  const dark = await darkHalo(b);
  assert.ok(dark > plain * 2, `тень гуще: ${dark} против ${plain}`);
  const seen = await drawnBox(page, scratch, 32);
  assert.ok(contains(b, seen), `drawn ${JSON.stringify(seen)} outside ${JSON.stringify(b)}`);
  assert.equal(await spotCount(), 0);
  assert.equal(await softPlate(), null);
});

test('shade «shadow» in soft: the halo of a new line does not darken the letters of the line above', async () => {
  const words = ['рыбу', 'ружьё', 'друзья', 'Йод', 'Ёлка', 'бык'];
  const s = { ...spec({ size: 80, shade: 0.8, shadeKind: 'shadow' }), font: 'montserrat' };
  await render(s, { sub: { words, active: 0, visible: 3, lines: [3, 3], t: 1 } });
  const white = await whitePixels(page, scratch);
  await render(s, { sub: { words, active: 3, visible: 6, lines: [3, 3], t: 1 } });
  const dark = await darkenedAmong(page, scratch, white);
  assert.ok(white.length > 3000, `белых пикселей ${white.length}`);
  assert.ok(dark <= 20, `буквы первой строки потемнели: ${dark} из ${white.length}`);
});

test('shade «plate» in soft: the plate is under the lines already shown, as dark as the strength; the block does not move', async () => {
  const one = { sub: { words: WORDS, active: 2, visible: 3, lines: [3, 3], t: 1 } };
  const both = { sub: { words: WORDS, active: 3, visible: 6, lines: [3, 3], t: 1 } };
  const s = spec({ shade: 0.7, shadeKind: 'plate' });
  await render(s, one);
  const p1 = await softPlate();
  const box1 = (await boxes()).sub;
  const w = await subWords();
  assert.match(p1.background, /^rgba\(17, 17, 17, 0\.7\)$/, p1.background);
  assert.ok(w.filter((x) => x.line === 0).every((x) => x.x >= p1.x && x.x + x.w <= p1.x + p1.w && x.y >= p1.y && x.y + x.h <= p1.y + p1.h), 'первая строка на плашке');
  assert.ok(w.filter((x) => x.line === 1).every((x) => x.y + x.h / 2 > p1.y + p1.h), 'вторая строка ещё не на плашке');
  await render(s, both);
  const p2 = await softPlate();
  assert.ok(p2.h > p1.h + 30, 'с второй строкой плашка ниже');
  assert.deepEqual((await boxes()).sub, box1, 'блок стоит на месте');
  const seen = await drawnBox(page, scratch, 32);
  assert.ok(contains(box1, seen), `drawn ${JSON.stringify(seen)} outside ${JSON.stringify(box1)}`);
  assert.equal(await spotCount(), 0, 'пятна нет');
});

test('shade kind: no kind is the spot, as before', async () => {
  const state = { sub: { words: WORDS, active: 0, visible: 6, lines: [3, 3], t: 1 } };
  await render(spec({ shade: 0.6 }), state);
  assert.equal(await spotCount(), 1);
  await render(spec({ shade: 0.6, shadeKind: 'spot' }), state);
  assert.equal(await spotCount(), 1);
  assert.equal(await softPlate(), null);
});
