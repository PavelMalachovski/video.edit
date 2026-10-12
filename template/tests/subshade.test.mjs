// Мягкое пятно под субтитрами (`spec.subtitles.shade`, решение Павла 12.10.2026): размытый тёмный прямоугольник под
// видимыми строками — чтобы субтитры читались на светлом фоне. 1 px страницы = 1 px кадра 1080×1920.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { framePage, launch } from '../browser.mjs';
import { serve } from '../serve.mjs';
import { pixels } from './helpers.mjs';

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

test('shade: only under the lines already shown, and it grows with the new line', async () => {
  const at = (visible, t) => ({ sub: { words: WORDS, active: 0, visible, lines: [3, 3], t } });
  await render(spec({ shade: 0.6 }), at(6, 1));
  const [first, second] = await rows();
  const under2 = leftOf(second);
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
