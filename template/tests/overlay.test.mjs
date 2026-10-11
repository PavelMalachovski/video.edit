// Слой текста в настоящем Chromium: субтитры, хук, титр с кодовым словом, шкала.
// Фон прозрачный; пиксели читаются со скриншота (1 px страницы = 1 px кадра 1080×1920).
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readFile } from 'node:fs/promises';

import { framePage, launch } from '../browser.mjs';
import { serve } from '../serve.mjs';
import { cmapCovers, contains, drawnBox } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAFE = { x0: 60, x1: 890, y0: 120, y1: 1530 };

const SPEC = {
  font: 'montserrat',
  hand: 'caveat',
  colors: { text: '#FFFFFF', accent: '#FF2D55', bar: '#FFD23F', plate: '#111111', outline: '#000000' },
  subtitles: { mode: 'karaoke', words: 3, size: 64, y: 1300 },
  hook: { mode: 'plate', size: 72 },
  bar: { pos: 'bottom', height: 14 },
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

/** Копия SPEC с заменой полей субтитров / хука / цветов. */
function spec({ sub = {}, hook = {}, colors = {}, ...rest } = {}) {
  return {
    ...structuredClone(SPEC),
    ...rest,
    subtitles: { ...SPEC.subtitles, ...sub },
    hook: { ...SPEC.hook, ...hook },
    colors: { ...SPEC.colors, ...colors },
  };
}

function render(s, state, opts) {
  return page.evaluate(([a, b, c]) => window.renderState(a, b, c), [s, state, opts]);
}

function boxes() {
  return page.evaluate(() => window.layoutBoxes());
}

/** Рамки слов субтитров (по `data-i`) и видимы ли они. */
function wordRects() {
  return page.evaluate(() =>
    [...document.querySelectorAll('#sub [data-i]')].map((e) => {
      const r = e.getBoundingClientRect();
      return { i: Number(e.dataset.i), x: r.x, y: r.y, w: r.width, h: r.height, shown: getComputedStyle(e).visibility !== 'hidden' };
    }),
  );
}

/** RGBA всех пикселей прямоугольника кадра (скриншот без фона, разбор — в соседней вкладке). */
async function pixels(clip) {
  const png = await page.screenshot({ clip, omitBackground: true });
  return scratch.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
  }, png.toString('base64'));
}

function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** Доля непрозрачных пикселей, совпадающих с цветом с точностью ±10 по каналу. */
function share(data, hex) {
  const [r, g, b] = rgb(hex);
  let hit = 0;
  for (let k = 0; k < data.length; k += 4) {
    if (data[k + 3] > 200 && Math.abs(data[k] - r) <= 10 && Math.abs(data[k + 1] - g) <= 10 && Math.abs(data[k + 2] - b) <= 10) hit++;
  }
  return hit / (data.length / 4);
}

function clipOf(r) {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.w)), height: Math.max(1, Math.round(r.h)) };
}

function insideSafe(b) {
  return b.x >= SAFE.x0 && b.x + b.w <= SAFE.x1 && b.y >= SAFE.y0 && b.y + b.h <= SAFE.y1;
}

test('subtitle box inside safe zone for 6 long words', async () => {
  const words = Array(6).fill('достопримечательности');
  for (const mode of ['accumulate', 'karaoke', 'plate']) {
    await render(spec({ sub: { mode, size: 72, y: 1480 } }), { sub: { words, active: 2, visible: mode === 'accumulate' ? 3 : 6 } });
    const b = (await boxes()).sub;
    assert.ok(b, mode);
    assert.ok(insideSafe(b), `${mode}: ${JSON.stringify(b)}`);
  }
});

test('subtitles stay centred on the safe zone, not on the frame', async () => {
  await render(spec(), { sub: { words: ['вот', 'так'], active: 0, visible: 2 } });
  const b = (await boxes()).sub;
  assert.ok(Math.abs(b.x + b.w / 2 - (SAFE.x0 + SAFE.x1) / 2) <= 1, JSON.stringify(b));
  assert.ok(Math.abs(b.y + b.h / 2 - 1300) <= 1, JSON.stringify(b));
});

test('accumulate keeps word positions when visible grows', async () => {
  const s = spec({ sub: { mode: 'accumulate' } });
  const words = ['Сегодня', 'я', 'покажу', 'как', 'монтировать', 'ролики'];
  await render(s, { sub: { words, active: 1, visible: 2 } });
  const early = await wordRects();
  await render(s, { sub: { words, active: 4, visible: 5 } });
  const late = await wordRects();
  assert.deepEqual(early.map((r) => [r.x, r.y]), late.map((r) => [r.x, r.y]));
  assert.deepEqual(early.map((r) => r.shown), [true, true, false, false, false, false]);
  assert.deepEqual(late.map((r) => r.shown), [true, true, true, true, true, false]);
});

test('accumulate block takes at most three lines', async () => {
  const words = ['раз', 'два', 'три', 'четыре', 'пять', 'шесть'].map((w) => `${w}-${w}-${w}`);
  await render(spec({ sub: { mode: 'accumulate', size: 96 } }), { sub: { words, active: 0, visible: 1 } });
  const lines = new Set((await wordRects()).map((r) => Math.round(r.y)));
  assert.ok(lines.size <= 3, `${lines.size} lines`);
});

test('active word uses accent color', async () => {
  await render(spec(), { sub: { words: ['ЖЖЖ', 'ЖЖЖ', 'ЖЖЖ'], active: 1, visible: 3 } });
  const [first, active] = await wordRects();
  assert.ok(share(await pixels(clipOf(active)), SPEC.colors.accent) > 0.1);
  assert.equal(share(await pixels(clipOf(first)), SPEC.colors.accent), 0);
  assert.ok(share(await pixels(clipOf(first)), SPEC.colors.text) > 0.1);
});

test('plate mode puts the active word on an accent background', async () => {
  await render(spec({ sub: { mode: 'plate' } }), { sub: { words: ['раз', 'два', 'три'], active: 2, visible: 3 } });
  const rects = await wordRects();
  assert.ok(share(await pixels(clipOf(rects[2])), SPEC.colors.accent) > 0.4);
  assert.ok(share(await pixels(clipOf(rects[0])), SPEC.colors.plate) > 0.4);
});

test('word mode shows one word with an accent bar under it', async () => {
  await render(spec({ sub: { mode: 'word', size: 110 } }), { sub: { words: ['монтаж'], active: 0, visible: 1 } });
  const [word] = await wordRects();
  const bar = await page.evaluate(() => document.querySelector('#sub .uline').getBoundingClientRect().toJSON());
  assert.ok(bar.y > word.y + word.h / 2, 'bar sits under the word');
  assert.ok(Math.abs(bar.x - word.x) <= 1 && Math.abs(bar.width - word.w) <= 1, 'bar is as wide as the word');
  assert.ok(share(await pixels(clipOf({ x: bar.x, y: bar.y, w: bar.width, h: bar.height })), SPEC.colors.accent) > 0.8);
  const b = (await boxes()).sub;
  assert.ok(b.y + b.h >= bar.y + bar.height, 'bar is inside the reported box');
});

test('hook handwritten word uses hand font and sits below caps line', async () => {
  await render(spec(), { hook: { text: 'Как я учу чешский' } });
  const hook = await page.evaluate(() => {
    const caps = document.querySelector('#hook .caps');
    const hand = document.querySelector('#hook .hand');
    const face = [...document.fonts].find((f) => f.family === 'vm-caveat');
    return {
      caps: caps.getBoundingClientRect().toJSON(),
      hand: hand.getBoundingClientRect().toJSON(),
      capsText: caps.textContent.replace(/\u00A0/g, ' '),
      handText: hand.textContent,
      handFont: getComputedStyle(hand).fontFamily,
      capsSize: parseFloat(getComputedStyle(caps).fontSize),
      handSize: parseFloat(getComputedStyle(hand).fontSize),
      handColor: getComputedStyle(hand).color,
      loaded: face?.status,
    };
  });
  assert.equal(hook.capsText, 'КАК Я УЧУ');
  assert.equal(hook.handText, 'чешский');
  assert.match(hook.handFont, /vm-caveat/);
  assert.equal(hook.loaded, 'loaded');
  assert.ok(hook.hand.y > hook.caps.y, JSON.stringify(hook));
  assert.ok(Math.abs(hook.handSize / hook.capsSize - 1.65) < 0.01);
  assert.equal(hook.handColor, 'rgb(255, 45, 85)');
  const b = (await boxes()).hook;
  assert.ok(insideSafe(b), JSON.stringify(b));
  assert.ok(Math.abs(b.y + b.h / 2 - 400) < 120, 'hook sits around the default height');
});

test('hook height follows spec.hook.y', async () => {
  await render(spec({ hook: { y: 900 } }), { hook: { text: 'Три ошибки новичка' } });
  const b = (await boxes()).hook;
  assert.ok(b.y > 700 && b.y + b.h < 1150, JSON.stringify(b));
});

test('hook modes: plate behind caps, outline and shadow add no plate', async () => {
  for (const mode of ['plate', 'outline', 'shadow']) {
    await render(spec({ hook: { mode } }), { hook: { text: 'Как я монтирую' } });
    const plate = await page.evaluate(() => {
      const e = document.querySelector('#hook .plate');
      return e && !e.hidden ? e.getBoundingClientRect().toJSON() : null;
    });
    if (mode === 'plate') {
      assert.ok(plate, mode);
      const caps = await page.evaluate(() => {
        const walk = document.createTreeWalker(document.querySelector('#hook .caps'), NodeFilter.SHOW_TEXT);
        const r = document.createRange();
        let box = null;
        for (let t = walk.nextNode(); t; t = walk.nextNode()) {
          r.selectNodeContents(t);
          const q = r.getBoundingClientRect();
          box = box
            ? { x: Math.min(box.x, q.x), y: Math.min(box.y, q.y), right: Math.max(box.right, q.right), bottom: Math.max(box.bottom, q.bottom) }
            : { x: q.x, y: q.y, right: q.right, bottom: q.bottom };
        }
        return { ...box, height: box.bottom - box.y };
      });
      const mid = caps.y + caps.height / 2;
      assert.ok(plate.x <= caps.x && plate.right >= caps.right, 'plate covers the caps across');
      assert.ok(plate.y < mid && plate.bottom > mid, 'plate covers the caps line');
      const edge = { x: plate.x + 3, y: mid - 3, w: 6, h: 6 };
      assert.ok(share(await pixels(clipOf(edge)), SPEC.colors.plate) > 0.9);
    } else {
      assert.equal(plate, null, mode);
    }
    assert.ok(insideSafe((await boxes()).hook), mode);
  }
});

test('short words stay with the next word in caps', async () => {
  await render(spec({ font: 'unbounded', hook: { size: 66 } }), { hook: { text: 'Три ошибки в монтаже reels' } });
  const lines = await page.evaluate(() => {
    const caps = document.querySelector('#hook .caps');
    const walk = document.createTreeWalker(caps, NodeFilter.SHOW_TEXT);
    const rows = new Map();
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      for (let i = 0; i < t.length; i++) {
        const r = document.createRange();
        r.setStart(t, i);
        r.setEnd(t, i + 1);
        const top = Math.round(r.getBoundingClientRect().top);
        rows.set(top, (rows.get(top) ?? '') + t.data[i]);
      }
    }
    return [...rows.values()].map((row) => row.replace(/\u00A0/g, ' ').trim());
  });
  assert.ok(lines.length >= 2, JSON.stringify(lines));
  assert.ok(lines.every((row) => !/(^|\s)В$/.test(row)), JSON.stringify(lines));
});

test('a one-word hook is all handwritten', async () => {
  await render(spec(), { hook: { text: 'Привет' } });
  const t = await page.evaluate(() => ({
    caps: document.querySelector('#hook .caps')?.textContent ?? '',
    hand: document.querySelector('#hook .hand').textContent,
  }));
  assert.deepEqual(t, { caps: '', hand: 'Привет' });
});

test('cta keeps its lines in caps and the code word handwritten', async () => {
  await render(spec(), { cta: { lines: ['Пиши в директ', 'слово'], word: 'монтаж' } });
  const t = await page.evaluate(() => ({
    lines: [...document.querySelectorAll('#cta .caps .line')].map((e) => e.textContent.replace(/\u00A0/g, ' ')),
    hand: document.querySelector('#cta .hand').textContent,
  }));
  assert.deepEqual(t, { lines: ['ПИШИ В ДИРЕКТ', 'СЛОВО'], hand: 'монтаж' });
  const all = await boxes();
  assert.ok(insideSafe(all.cta), JSON.stringify(all.cta));
  assert.equal(all.hook, undefined);
});

test('bar drawn only when opts.bar given', async () => {
  const at = (x) => pixels({ x, y: 1912, width: 1, height: 1 });
  await render(spec(), {});
  assert.equal((await at(100))[3], 0);
  await render(spec(), {}, { bar: { progress: 0.5 } });
  assert.deepEqual((await at(100)).slice(0, 3), rgb(SPEC.colors.bar));
  assert.equal((await at(530))[3], 255);
  assert.equal((await at(560))[3], 0);
  await render(spec({ bar: { pos: 'top', height: 10 } }), {}, { bar: { progress: 1 } });
  assert.equal((await pixels({ x: 1070, y: 5, width: 1, height: 1 }))[3], 255);
  assert.equal((await at(100))[3], 0);
});

test('empty state clears the layer', async () => {
  await render(spec(), { sub: { words: ['раз'], active: 0, visible: 1 }, hook: { text: 'Как я монтирую' } });
  await render(spec(), {});
  assert.deepEqual(await boxes(), { inserts: [] });
  const all = await pixels({ x: 0, y: 0, width: 1080, height: 1920 });
  assert.ok(all.every((v, k) => k % 4 !== 3 || v === 0), 'nothing drawn');
});

test('unknown font id is refused, not replaced', async () => {
  await assert.rejects(render(spec({ font: 'comic-sans' }), { sub: { words: ['раз'], active: 0, visible: 1 } }), /comic-sans/);
  await assert.rejects(render(spec({ hand: 'nope-hand' }), {}), /nope-hand/);
});

test('plate subtitles keep their size and layout whatever word is active', async () => {
  const words = ['Покажу', 'как', 'монтировать', 'ролики', 'быстро'];
  const looks = [];
  for (let active = 0; active < words.length; active++) {
    await render(spec({ sub: { mode: 'plate', size: 72 } }), { sub: { words, active, visible: words.length } });
    looks.push(
      await page.evaluate(() => ({
        size: getComputedStyle(document.querySelector('#sub .lines')).fontSize,
        plate: document.querySelector('#sub .plate').getBoundingClientRect().toJSON(),
        words: [...document.querySelectorAll('#sub [data-i]')].map((e) => [e.getBoundingClientRect().x, e.getBoundingClientRect().y]),
        box: window.layoutBoxes().sub,
      })),
    );
  }
  for (const l of looks.slice(1)) assert.deepEqual(l, looks[0]);
  assert.equal(new Set(looks[0].words.map(([, y]) => Math.round(y))).size, 2, 'the group takes two lines at full size');
});

test('subtitle box never crosses the safe zone, wherever y points', async () => {
  const words = Array(6).fill('достопримечательности');
  for (const mode of ['karaoke', 'plate', 'accumulate']) {
    for (const y of [130, 160, 200, 1400, 1430, 1460, 1491, 1500, 1520, 1530]) {
      await render(spec({ sub: { mode, size: 72, y } }), { sub: { words, active: 1, visible: 6 } });
      const b = (await boxes()).sub;
      assert.ok(insideSafe(b), `${mode} y=${y}: ${JSON.stringify(b)}`);
    }
  }
});

test('everything drawn is inside the reported boxes (subtitles)', async () => {
  for (const font of ['montserrat', 'comfortaa', 'russo-one', 'unbounded']) {
    for (const mode of ['karaoke', 'plate', 'word', 'accumulate']) {
      await render(spec({ font, sub: { mode, size: 72 } }), { sub: { words: ['ЙЁЖ', 'Ёлка', 'ящик'], active: 1, visible: 3 } });
      const seen = await drawnBox(page, scratch, 32);
      const b = (await boxes()).sub;
      assert.ok(contains(b, seen), `${font} ${mode}: drawn ${JSON.stringify(seen)} outside ${JSON.stringify(b)}`);
    }
  }
});

test('everything drawn is inside the reported boxes (hook and cta)', async () => {
  for (const hand of ['caveat', 'marck-script', 'bad-script']) {
    for (const mode of ['plate', 'outline', 'shadow']) {
      for (const text of ['Деньги рублей', 'Привет', 'Это не работает']) {
        await render(spec({ hand, hook: { mode, size: 100 } }), { hook: { text } });
        const seen = await drawnBox(page, scratch, 64);
        const b = (await boxes()).hook;
        assert.ok(contains(b, seen), `${hand} ${mode} «${text}»: drawn ${JSON.stringify(seen)} outside ${JSON.stringify(b)}`);
      }
    }
  }
  await render(spec({ hand: 'marck-script', hook: { mode: 'outline' } }), { cta: { lines: ['Пиши в директ'], word: 'Деньги' } });
  assert.ok(contains((await boxes()).cta, await drawnBox(page, scratch, 64)), 'cta');
});

test('the handwritten word hangs right under the caps, not far below', async () => {
  for (const hand of ['caveat', 'marck-script', 'bad-script']) {
    await render(spec({ hand }), { hook: { text: 'Как я учу чешский' } });
    const g = await page.evaluate(() => {
      const caps = document.querySelector('#hook .caps').getBoundingClientRect();
      const hand = document.querySelector('#hook .hand').getBoundingClientRect();
      return { gap: hand.y - caps.bottom, handSize: parseFloat(getComputedStyle(document.querySelector('#hook .hand')).fontSize) };
    });
    assert.ok(Math.abs(g.gap) < 0.6 * g.handSize, `${hand}: ${JSON.stringify(g)}`);
  }
});

test('every font file covers Cyrillic', async () => {
  const fonts = JSON.parse(await readFile(path.join(ROOT, 'fonts.json'), 'utf8'));
  const need = [...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя«»—…'].map((c) => c.codePointAt(0));
  for (const f of fonts) {
    const have = cmapCovers(await readFile(path.join(ROOT, f.file)), need);
    const lost = need.filter((cp) => !have.has(cp)).map((cp) => String.fromCodePoint(cp));
    assert.deepEqual(lost, [], f.id);
  }
});

test('every font in fonts.json loads and has Cyrillic', async () => {
  const fonts = await page.evaluate(async () => (await fetch('fonts.json')).json());
  const main = fonts.filter((f) => f.kind === 'main').map((f) => f.id);
  const hand = fonts.filter((f) => f.kind === 'hand').map((f) => f.id);
  assert.deepEqual(main, ['montserrat', 'unbounded', 'rubik', 'oswald', 'russo-one', 'comfortaa']);
  assert.deepEqual(hand, ['caveat', 'marck-script', 'bad-script']);
  for (const f of fonts) {
    const s = f.kind === 'main' ? spec({ font: f.id }) : spec({ hand: f.id });
    await render(s, { hook: { text: 'Съешь ещё этих мягких булок' } });
    const ok = await page.evaluate((id) => {
      const face = [...document.fonts].find((x) => x.family === `vm-${id}`);
      return face?.status === 'loaded' && document.fonts.check(`40px vm-${id}`, 'Съешь ещё');
    }, f.id);
    assert.ok(ok, f.id);
  }
});

// ---------- эмодзи ----------

/** Картинки эмодзи внутри узла: имя файла, загружена ли и рамка. */
function emojiIn(selector) {
  return page.evaluate((sel) =>
    [...document.querySelectorAll(`${sel} img.emo`)].map((img) => ({
      file: img.src.split('/emoji/')[1],
      natural: [img.naturalWidth, img.naturalHeight],
      done: img.complete,
      alt: img.alt,
      ...img.getBoundingClientRect().toJSON(),
    })), selector);
}

/** Доля «огненных» пикселей (оранжевый и жёлтый, как у 🔥) в прямоугольнике. */
async function fiery(r) {
  const data = await pixels(clipOf({ x: r.x, y: r.y, w: r.width, h: r.height }));
  let hit = 0;
  for (let k = 0; k < data.length; k += 4) {
    if (data[k + 3] > 200 && data[k] > 200 && data[k + 1] > 60 && data[k + 1] < 215 && data[k + 2] < 110) hit++;
  }
  return hit / (data.length / 4);
}

test('emoji in the hook are pictures from emoji/, the trailing one goes with the handwritten word', async () => {
  await render(spec(), { hook: { text: 'Три ошибки 🔥' } });
  const hook = await page.evaluate(() => ({
    caps: document.querySelector('#hook .caps').textContent.replace(/ /g, ' '),
    hand: document.querySelector('#hook .hand').textContent,
  }));
  assert.equal(hook.caps, 'ТРИ');
  assert.equal(hook.hand.trim(), 'ошибки');
  const [fire, ...rest] = await emojiIn('#hook .hand');
  assert.equal(rest.length, 0);
  assert.equal(fire.file, '1f525.png');
  assert.deepEqual(fire.natural, [136, 128]);
  assert.equal(fire.alt, '🔥');
  assert.ok((await fiery(fire)) > 0.1, 'огонь нарисован картинкой');
  const handSize = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#hook .hand')).fontSize));
  assert.ok(Math.abs(fire.height / handSize - 128 / 109) < 0.02, `высота эмодзи — как у глифа шрифта: ${fire.height} при ${handSize}`);
  assert.ok(contains((await boxes()).hook, { x: fire.x, y: fire.y, w: fire.width, h: fire.height }));
});

test('emoji in caps and in the cta stay where the text is', async () => {
  await render(spec(), { hook: { text: '🔥 Как я монтирую' } });
  assert.equal((await emojiIn('#hook .caps')).length, 1);
  assert.equal((await page.evaluate(() => document.querySelector('#hook .caps').textContent)).replace(/ /g, ' ').trim(), 'КАК Я');
  assert.equal((await page.evaluate(() => document.querySelector('#hook .hand').textContent)), 'монтирую');
  await render(spec(), { cta: { lines: ['Пиши в директ 👇'], word: 'План ✅' } });
  assert.deepEqual((await emojiIn('#cta .caps')).map((e) => e.file), ['1f447.png']);
  assert.deepEqual((await emojiIn('#cta .hand')).map((e) => e.file), ['2705.png']);
});

test('everything drawn is inside the reported boxes (emoji)', async () => {
  for (const mode of ['plate', 'outline', 'shadow']) {
    for (const text of ['Три ошибки 🔥', '🔥🔥 Огонь', 'Сердце ❤️', '👨‍👩‍👧 семья 🇨🇿']) {
      await render(spec({ hook: { mode, size: 100 } }), { hook: { text } });
      const seen = await drawnBox(page, scratch, 64);
      const b = (await boxes()).hook;
      assert.ok(contains(b, seen), `${mode} «${text}»: drawn ${JSON.stringify(seen)} outside ${JSON.stringify(b)}`);
      assert.ok(insideSafe(b), `${mode} «${text}»: ${JSON.stringify(b)}`);
    }
  }
});

test('a text-default sign without FE0F stays a letter, not a picture', async () => {
  await render(spec(), { hook: { text: 'Цена 100 € ©' } });
  assert.equal((await emojiIn('#hook')).length, 0);
});

test('an emoji does not count as an extra caps line: the hook keeps its size', async () => {
  const size = async (text) => {
    await render(spec(), { hook: { text } });
    return page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#hook .caps')).fontSize));
  };
  const plain = await size('Как я монтирую ролики на телефоне конец');
  const fire = await size('Как я 🔥 монтирую ролики на телефоне конец');
  assert.ok(fire >= 0.9 * plain, `с эмодзи ${fire}px, без — ${plain}px`);
});

test('a caps line never starts with an emoji: it stays with the word before it', async () => {
  for (const text of ['Мой способ снимать 🔥 видео каждый день конец', 'Три ошибки которые делает 🔥 каждый новичок конец']) {
    await render(spec(), { hook: { text } });
    const alone = await page.evaluate(() => {
      const caps = document.querySelector('#hook .caps');
      const letters = [];
      const walk = document.createTreeWalker(caps, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(t);
        letters.push(...[...range.getClientRects()].filter((q) => q.width > 1));
      }
      return [...caps.querySelectorAll('img.emo')].filter((img) => {
        const r = img.getBoundingClientRect();
        const mid = (r.top + r.bottom) / 2;
        return !letters.some((q) => q.top < mid && q.bottom > mid && q.right <= r.left + 1);
      }).length;
    });
    assert.equal(alone, 0, text);
  }
});

// ---------- финальная карточка ----------

const CARD = { lines: ['Подпишись, чтобы не пропустить 👇'], handle: '@pavel.malakhouski', logo: 'emoji/1f4f7.png' };

test('the end card dims the whole frame and puts the call to action, the handle and the logo in the safe zone', async () => {
  await render(spec(), { end: { ...CARD, t: 1 } });
  const corner = await pixels({ x: 2, y: 2, width: 4, height: 4 });
  assert.ok(corner[3] > 100 && corner[3] < 200 && corner[0] < 10, `кадр затемнён полупрозрачным чёрным: ${corner.slice(0, 4)}`);
  const b = (await boxes()).end;
  assert.ok(b && insideSafe(b), JSON.stringify(b));
  const parts = await page.evaluate(() => ({
    logo: document.querySelector('#end img.logo')?.getBoundingClientRect().toJSON(),
    plate: document.querySelector('#end .call')?.getBoundingClientRect().toJSON(),
    handle: document.querySelector('#end .handle')?.textContent,
    emoji: document.querySelectorAll('#end .call img.emo').length,
  }));
  assert.ok(parts.logo && parts.logo.width > 100, `логотип: ${JSON.stringify(parts.logo)}`);
  assert.equal(parts.handle, '@pavel.malakhouski');
  assert.equal(parts.emoji, 1);
  for (const r of [parts.logo, parts.plate]) assert.ok(contains(b, { x: r.x, y: r.y, w: r.width, h: r.height }), JSON.stringify(r));
  assert.ok((await shareColor(parts.plate, SPEC.colors.accent)) > 0.4, 'плашка призыва — цвета подсветки');
  // всё непрозрачное (кроме затемнения) — внутри рамки
  assert.ok(contains(b, await drawnBox(page, scratch, 230)), 'нарисованное внутри рамки карточки');
});

test('the call to action breathes: bigger and smaller over time, always inside its box', async () => {
  const widths = [];
  for (const t of [0.5, 0.69, 0.88]) {
    await render(spec(), { end: { ...CARD, t } });
    const b = (await boxes()).end;
    const seen = await drawnBox(page, scratch, 230);
    assert.ok(contains(b, seen), `t=${t}: ${JSON.stringify(seen)} вне ${JSON.stringify(b)}`);
    widths.push(await page.evaluate(() => document.querySelector('#end .call').getBoundingClientRect().width));
  }
  assert.ok(Math.max(...widths) - Math.min(...widths) > 8, `призыв не дышит: ${widths}`);
});

test('the end card appears quickly and without the handle and logo it is just the call', async () => {
  await render(spec(), { end: { lines: ['Сохрани ✅'], t: 0 } });
  const first = await page.evaluate(() => Number(getComputedStyle(document.querySelector('#end')).opacity));
  assert.ok(first > 0 && first < 1, `первый кадр — уже видно, но не целиком: ${first}`);
  await render(spec(), { end: { lines: ['Сохрани ✅'], t: 1 } });
  assert.equal(await page.evaluate(() => document.querySelectorAll('#end img.logo, #end .handle').length), 0);
  assert.ok(insideSafe((await boxes()).end));
});

/** Доля пикселей цвета `hex` (±12) в рамке. */
async function shareColor(r, hex) {
  return share(await pixels(clipOf({ x: r.x, y: r.y, w: r.width, h: r.height })), hex);
}

test('a long call to action wraps instead of shrinking', async () => {
  await render(spec(), { end: { lines: ['Подпишись, чтобы не пропустить новые ролики про монтаж 👇'], t: 1 } });
  const call = await page.evaluate(() => {
    const el = document.querySelector('#end .call');
    return { size: parseFloat(getComputedStyle(el).fontSize), width: el.offsetWidth, height: el.offsetHeight }; // без «дыхания»
  });
  assert.ok(call.size >= 0.9 * 72, `кегль ${call.size}`);
  assert.ok(call.width <= 700 + 1, `ширина ${call.width}`);
  assert.ok(call.height > 2 * call.size, `в несколько строк: ${call.height}`);
  assert.ok(insideSafe((await boxes()).end));
});
