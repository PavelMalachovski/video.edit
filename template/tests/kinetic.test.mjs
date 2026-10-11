// Тексты стиля эталона в настоящем Chromium: тонкие субтитры (soft), акцентные фразы лесенкой с анимацией появления
// и ухода, хук и титр в режиме accent. 1 px страницы = 1 px кадра 1080×1920.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { framePage, launch } from '../browser.mjs';
import { serve } from '../serve.mjs';
import { pixels } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAFE = { x0: 60, x1: 890, y0: 120, y1: 1530 };

// стиль A — эталон
const SPEC = {
  font: 'forum',
  hand: 'caveat',
  colors: { text: '#FFFFFF', accent: '#EDE4C1', bar: '#EDE4C1', plate: '#111111', outline: '#000000' },
  subtitles: { mode: 'soft', words: 3, size: 64, y: 1440 },
  hook: { mode: 'accent', size: 100, y: 420 },
  bar: { pos: 'bottom', height: 6 },
};

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

function spec({ sub = {}, hook = {}, colors = {}, ...rest } = {}) {
  return {
    ...structuredClone(SPEC),
    ...rest,
    subtitles: { ...SPEC.subtitles, ...sub },
    hook: { ...SPEC.hook, ...hook },
    colors: { ...SPEC.colors, ...colors },
  };
}

function render(s, state) {
  return page.evaluate(([a, b]) => window.renderState(a, b), [s, state]);
}

function boxes() {
  return page.evaluate(() => window.layoutBoxes());
}

function insideSafe(b) {
  return b.x >= SAFE.x0 && b.x + b.w <= SAFE.x1 && b.y >= SAFE.y0 && b.y + b.h <= SAFE.y1;
}

/** Слова субтитров: текст на экране, рамка, видимость, межбуквенный интервал и прозрачность строки. */
function subWords() {
  return page.evaluate(() =>
    [...document.querySelectorAll('#sub [data-i]')].map((e) => {
      const r = e.getBoundingClientRect();
      const line = e.closest('.sline');
      const cs = getComputedStyle(line);
      return {
        i: Number(e.dataset.i),
        text: e.textContent,
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        shown: getComputedStyle(e).visibility !== 'hidden' && Number(cs.opacity) > 0,
        line: [...line.parentNode.children].indexOf(line),
        spacing: parseFloat(cs.letterSpacing) || 0,
        opacity: Number(cs.opacity),
      };
    }),
  );
}

/** Строки блока (`#accent`, `#hook`, `#cta`): текст, рамка, кегль, цвет, прозрачность, фильтр. */
function blockLines(id) {
  return page.evaluate((sel) =>
    [...document.querySelectorAll(`${sel} .aline`)].map((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return {
        text: e.dataset.text,
        shownText: [...e.querySelectorAll('.ch, .shown')].filter((c) => getComputedStyle(c).visibility !== 'hidden' && Number(getComputedStyle(c).opacity) > 0.5).map((c) => c.textContent).join(''),
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        cx: r.x + r.width / 2,
        size: parseFloat(cs.fontSize),
        color: cs.color,
        opacity: Number(cs.opacity),
        visible: cs.visibility !== 'hidden',
        filter: cs.filter,
        spacing: parseFloat(cs.letterSpacing) || 0,
        cursor: Boolean(e.querySelector('.cursor')),
      };
    }), `#${id}`);
}

function rootStyle(id) {
  return page.evaluate((sel) => {
    const cs = getComputedStyle(document.querySelector(sel));
    return { opacity: Number(cs.opacity), transform: cs.transform };
  }, `#${id}`);
}

const WORDS = ['Я', 'покупаю', 'вещи,', 'чтобы', 'выглядеть', 'плохо.'];

// ---------- субтитры soft ----------

test('soft subtitles: two lines of the block, whole lines appear, text without punctuation', async () => {
  await render(spec(), { sub: { words: WORDS, active: 2, visible: 3, lines: [3, 3], t: 1 } });
  const w = await subWords();
  assert.equal(w.length, 6);
  assert.deepEqual(w.map((x) => x.text), ['я', 'покупаю', 'вещи', 'чтобы', 'выглядеть', 'плохо']);
  assert.deepEqual(w.map((x) => x.line), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(w.map((x) => x.shown), [true, true, true, false, false, false]);
  assert.ok(w[3].y > w[0].y + 30, 'вторая строка ниже первой');
  const first = (await boxes()).sub;
  assert.ok(first && insideSafe(first), JSON.stringify(first));
  await render(spec(), { sub: { words: WORDS, active: 3, visible: 6, lines: [3, 3], t: 1 } });
  const both = await subWords();
  assert.ok(both.every((x) => x.shown));
  assert.deepEqual((await boxes()).sub, first, 'блок стоит на месте, когда появляется вторая строка');
  assert.deepEqual(both.map((x) => Math.round(x.y)), w.map((x) => Math.round(x.y)));
});

test('soft subtitles: the block is centred on y, the size is the size of the style', async () => {
  await render(spec(), { sub: { words: ['вещи', 'это', 'обычно'], active: 0, visible: 3, lines: [3], t: 1 } });
  const b = (await boxes()).sub;
  const mid = b.y + b.h / 2;
  assert.ok(Math.abs(mid - 1440) < 12, `центр ${mid}`);
  const size = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#sub .sline')).fontSize));
  assert.equal(size, 64);
});

test('soft subtitles: white letters with a soft shadow, no outline and no plate', async () => {
  await render(spec(), { sub: { words: ['ТЕСТ', 'ТЕСТ', 'ТЕСТ'], active: 0, visible: 3, lines: [3], t: 1 } });
  const b = (await boxes()).sub;
  const d = await pixels(page, scratch, { x: b.x, y: b.y, width: b.w, height: b.h });
  let white = 0;
  let darkOpaque = 0;
  let shadow = 0;
  for (let k = 0; k < d.length; k += 4) {
    if (d[k + 3] > 240 && d[k] > 240 && d[k + 1] > 240 && d[k + 2] > 240) white++;
    if (d[k + 3] > 200 && d[k] < 60 && d[k + 1] < 60 && d[k + 2] < 60) darkOpaque++;
    if (d[k + 3] > 10 && d[k + 3] < 200 && d[k] < 60) shadow++;
  }
  assert.ok(white > 300, `белых пикселей ${white}`);
  assert.equal(darkOpaque, 0, 'обводки нет: тёмных непрозрачных пикселей быть не должно');
  assert.ok(shadow > 300, `тени ${shadow}`);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#sub .plate:not([hidden])').length), 0);
});

test('soft subtitles: the newest line slides in, the earlier line stays still', async () => {
  const state = (t) => ({ sub: { words: WORDS, active: 3, visible: 6, lines: [3, 3], t } });
  await render(spec(), state(0));
  const start = await subWords();
  assert.ok(start[3].spacing > 5, `буквы новой строки разъехались: ${start[3].spacing}`);
  assert.ok(start[3].opacity < 0.5, `новая строка проявляется: ${start[3].opacity}`);
  assert.equal(start[0].spacing, 0);
  assert.equal(start[0].opacity, 1);
  await render(spec(), state(1));
  const end = await subWords();
  assert.equal(end[3].spacing, 0);
  assert.equal(end[3].opacity, 1);
});

test('soft subtitles: a sentence starts in lower case, names and abbreviations keep their capitals', async () => {
  await render(spec(), { sub: { words: ['Я', 'и', 'Олеся.', 'Это', 'США', '—'], active: 0, visible: 6, lines: [3, 3], t: 1 } });
  const w = await subWords();
  assert.deepEqual(w.map((x) => x.text), ['я', 'и', 'Олеся', 'это', 'США', '']);
});

test('soft subtitles: without lines the block is split by the words of the style', async () => {
  await render(spec(), { sub: { words: ['раз', 'два', 'три', 'четыре', 'пять'], active: 0, visible: 5 } });
  const w = await subWords();
  assert.deepEqual(w.map((x) => x.line), [0, 0, 1, 1, 1]);
});

test('soft subtitles: a long block shrinks to fit the safe zone', async () => {
  const words = Array(6).fill('достопримечательности');
  await render(spec({ sub: { size: 90, y: 1500 } }), { sub: { words, active: 0, visible: 6, lines: [3, 3], t: 1 } });
  const b = (await boxes()).sub;
  assert.ok(insideSafe(b), JSON.stringify(b));
});

// ---------- акцентные фразы ----------

const ACCENT = {
  lines: [{ text: 'это 5 всадник' }, { text: 'апокалипсиса', size: 'small', color: 'accent' }],
  x: 470,
  y: 1100,
  anim: 'blur',
  ages: [1, 1],
};

test('accent: lines stack as a staggered cascade, sizes and colours by line, centred on x, y', async () => {
  await render(spec(), { accent: ACCENT });
  const [a, b] = await blockLines('accent');
  assert.equal(a.text, 'это 5 всадник');
  assert.equal(a.size, 100);
  assert.equal(b.size, 72);
  assert.equal(a.color, 'rgb(255, 255, 255)');
  assert.equal(b.color, 'rgb(237, 228, 193)');
  assert.ok(b.y > a.y, 'вторая строка ниже');
  assert.ok(b.cx - a.cx > 30, `лесенка: вторая строка правее (${a.cx} → ${b.cx})`);
  const box = (await boxes()).accent;
  assert.ok(box && insideSafe(box), JSON.stringify(box));
  assert.ok(Math.abs(box.x + box.w / 2 - 470) < 12 && Math.abs(box.y + box.h / 2 - 1100) < 12, JSON.stringify(box));
  // межстрочный — тесный: строки почти касаются
  assert.ok(b.y - (a.y + a.h) < 0, `строки ${JSON.stringify([a, b])}`);
});

test('accent: big lines are larger, three lines zig-zag', async () => {
  await render(spec(), {
    accent: { lines: [{ text: 'я скажу' }, { text: 'что-то' }, { text: 'важное', size: 'big' }], x: 450, y: 900, ages: [1, 1, 1] },
  });
  const [a, b, c] = await blockLines('accent');
  assert.equal(c.size, 138);
  assert.ok(b.cx > a.cx && b.cx > c.cx, `зигзаг ${[a.cx, b.cx, c.cx]}`);
});

test('accent: a line waits for its word; the box is the whole block', async () => {
  await render(spec(), { accent: ACCENT });
  const full = (await boxes()).accent;
  await render(spec(), { accent: { ...ACCENT, ages: [0.5, null] } });
  const [a, b] = await blockLines('accent');
  assert.ok(a.visible && a.opacity === 1);
  assert.ok(!b.visible || b.opacity === 0, JSON.stringify(b));
  assert.deepEqual((await boxes()).accent, full);
});

test('accent: appears out of blur', async () => {
  await render(spec(), { accent: { ...ACCENT, anim: 'blur', ages: [0, null] } });
  const [start] = await blockLines('accent');
  assert.ok(start.opacity < 0.3, `opacity ${start.opacity}`);
  assert.match(start.filter, /blur\((\d*[1-9]\d*|\d+\.\d*[1-9]\d*)px\)/);
  await render(spec(), { accent: { ...ACCENT, anim: 'blur', ages: [1, null] } });
  const [end] = await blockLines('accent');
  assert.equal(end.opacity, 1);
  assert.ok(end.filter === 'none' || /blur\(0px\)/.test(end.filter), end.filter);
});

test('accent: the typewriter prints letters with a cursor, then the cursor goes', async () => {
  await render(spec(), { accent: { ...ACCENT, anim: 'type', ages: [0.1, null] } });
  const [typing] = await blockLines('accent');
  assert.ok(typing.shownText.length >= 2 && typing.shownText.length <= 4, `напечатано «${typing.shownText}»`);
  assert.ok('это 5 всадник'.startsWith(typing.shownText));
  assert.ok(typing.cursor, 'курсор во время печати');
  const before = await blockLines('accent');
  await render(spec(), { accent: { ...ACCENT, anim: 'type', ages: [2, 2] } });
  const done = await blockLines('accent');
  assert.equal(done[0].shownText, 'это 5 всадник');
  assert.ok(!done[0].cursor, 'курсора после печати нет');
  assert.equal(Math.round(done[0].x), Math.round(before[0].x), 'строка не едет, пока печатается');
});

test('accent: letters appear one by one in a mixed order', async () => {
  await render(spec(), { accent: { lines: [{ text: 'самосаботаж', size: 'big' }], x: 480, y: 900, anim: 'letters', ages: [0.12] } });
  const [mid] = await blockLines('accent');
  assert.ok(mid.shownText.length > 0 && mid.shownText.length < 'самосаботаж'.length, `видно «${mid.shownText}»`);
  assert.ok(!'самосаботаж'.startsWith(mid.shownText) || mid.shownText.length === 0, 'не по порядку слева направо');
  await render(spec(), { accent: { lines: [{ text: 'самосаботаж', size: 'big' }], x: 480, y: 900, anim: 'letters', ages: [1] } });
  assert.equal((await blockLines('accent'))[0].shownText, 'самосаботаж');
});

test('accent: letters slide together', async () => {
  await render(spec(), { accent: { ...ACCENT, anim: 'track', ages: [0, null] } });
  const [start] = await blockLines('accent');
  assert.ok(start.spacing > 10, `spacing ${start.spacing}`);
  await render(spec(), { accent: { ...ACCENT, anim: 'track', ages: [1, null] } });
  assert.equal((await blockLines('accent'))[0].spacing, 0);
});

test('accent: leaving — fades, or flies through growing to the whole frame; the box stays', async () => {
  await render(spec(), { accent: ACCENT });
  const full = (await boxes()).accent;
  await render(spec(), { accent: { ...ACCENT, out: 'fade', leave: 0.5 } });
  const fade = await rootStyle('accent');
  assert.ok(Math.abs(fade.opacity - 0.5) < 0.05, JSON.stringify(fade));
  await render(spec(), { accent: { ...ACCENT, out: 'zoom', leave: 0.5 } });
  const zoom = await rootStyle('accent');
  assert.ok(zoom.opacity < 0.6, JSON.stringify(zoom));
  const scale = Number(/matrix\(([\d.]+)/.exec(zoom.transform)?.[1]);
  assert.ok(scale > 2, `масштаб ${zoom.transform}`);
  assert.deepEqual((await boxes()).accent, full, 'рамка для проверок — без пролёта');
});

test('accent: kept inside the safe zone when x, y push it out', async () => {
  for (const [x, y] of [[90, 130], [880, 1520], [500, 60]]) {
    await render(spec(), { accent: { ...ACCENT, x, y } });
    const b = (await boxes()).accent;
    assert.ok(insideSafe(b), `${x},${y}: ${JSON.stringify(b)}`);
  }
});

test('accent: nothing to draw — no box', async () => {
  await render(spec(), { accent: { lines: [], x: 500, y: 900 } });
  assert.equal((await boxes()).accent, undefined);
  await render(spec(), {});
  assert.equal((await boxes()).accent, undefined);
});

// ---------- хук и титр accent ----------

test('hook accent: lines of up to three words, the punch word on its own line, big and in the accent colour, no plate', async () => {
  await render(spec(), { hook: { text: 'я покупаю вещи чтобы выглядеть плохо' } });
  const lines = await blockLines('hook');
  assert.deepEqual(lines.map((l) => l.text), ['я покупаю вещи', 'чтобы выглядеть', 'плохо']);
  assert.deepEqual(lines.map((l) => l.size), [100, 100, 138]);
  assert.equal(lines[0].color, 'rgb(255, 255, 255)');
  assert.equal(lines[2].color, 'rgb(237, 228, 193)');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#hook .plate, #hook .caps, #hook .hand')].filter((e) => !e.hidden).length), 0);
  const b = (await boxes()).hook;
  assert.ok(insideSafe(b), JSON.stringify(b));
  assert.ok(Math.abs(b.y + b.h / 2 - 420) < 15, JSON.stringify(b));
});

test('hook accent: one word is one big line; an emoji stays with the punch word', async () => {
  await render(spec(), { hook: { text: 'самосаботаж' } });
  assert.deepEqual((await blockLines('hook')).map((l) => [l.text, l.size]), [['самосаботаж', 138]]);
  await render(spec(), { hook: { text: 'шесть вещей 🔥' } });
  assert.deepEqual((await blockLines('hook')).map((l) => [l.text, l.size]), [['шесть', 100], ['вещей 🔥', 138]]);
});

test('hook accent: comes out of blur in the first frames', async () => {
  await render(spec(), { hook: { text: 'я покупаю вещи чтобы выглядеть плохо', t: 0 } });
  const [first] = await blockLines('hook');
  assert.ok(first.opacity < 0.3, JSON.stringify(first));
  await render(spec(), { hook: { text: 'я покупаю вещи чтобы выглядеть плохо', t: 1 } });
  assert.equal((await blockLines('hook'))[0].opacity, 1);
});

test('cta accent: call lines, then the code word big in the accent colour', async () => {
  await render(spec(), { cta: { lines: ['пиши в комментариях'], word: 'план' } });
  const lines = await blockLines('cta');
  assert.deepEqual(lines.map((l) => l.text), ['пиши в комментариях', 'план']);
  assert.ok(lines[1].size > lines[0].size);
  assert.equal(lines[1].color, 'rgb(237, 228, 193)');
  const b = (await boxes()).cta;
  assert.ok(insideSafe(b), JSON.stringify(b));
});
