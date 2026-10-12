// Превью = финал и в Safari: на iPhone Павла превью рисует этот шаблон в WebKit, а финал — Chromium (рендер движка).
// Одни и те же кадры в обоих: рамки всего нарисованного (layoutBoxes) совпадают с точностью до нескольких пикселей —
// шрифты те же файлы, разница только в сглаживании. WebKit нет (локально его не ставим) — тест пропускается; в CI он
// стоит, а REQUIRE_WEBKIT=1 не даёт пропустить молча.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { framePage, launch, launchWebkit } from '../browser.mjs';
import { serve } from '../serve.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SPEC = {
  font: 'montserrat',
  hand: 'caveat',
  colors: { text: '#FFFFFF', accent: '#FF2D55', bar: '#FFD23F', plate: '#111111', outline: '#000000' },
  subtitles: { mode: 'karaoke', words: 3, size: 64, y: 1300 },
  hook: { mode: 'plate', size: 72 },
  bar: { pos: 'bottom', height: 14 },
};
const SOFT = {
  ...SPEC, font: 'forum', subtitles: { mode: 'soft', words: 3, size: 64, y: 1440 }, hook: { mode: 'accent', size: 100, y: 420 },
  colors: { ...SPEC.colors, accent: '#EDE4C1', bar: '#EDE4C1' },
};
const with_ = (base, sub = {}, hook = {}) => ({ ...base, subtitles: { ...base.subtitles, ...sub }, hook: { ...base.hook, ...hook } });

/** Кадры: каждый вид субтитров, хук, титр, акцент, стикеры, эмодзи и финальная карточка. */
const CASES = [
  ['karaoke', SPEC, { sub: { words: ['Сегодня', 'покажу', 'как'], active: 1, visible: 3 } }],
  ['plate, two lines', with_(SPEC, { mode: 'plate' }), { sub: { words: ['Учу', 'чешский', 'по', 'пятнадцать', 'минут', 'утром'], active: 3, visible: 6 } }],
  ['word', with_(SPEC, { mode: 'word' }), { sub: { words: ['монтаж'], active: 0, visible: 1 } }],
  ['accumulate', with_(SPEC, { mode: 'accumulate' }), { sub: { words: ['вот', 'так', 'я', 'снимаю'], active: 2, visible: 3 } }],
  ['hook with a handwritten word', SPEC, { hook: { text: 'Как я учу чешский' } }],
  ['outline hook and cta', with_(SPEC, {}, { mode: 'outline' }), { cta: { lines: ['Пиши в директ', 'слово'], word: 'монтаж' } }],
  ['soft subtitles and accent title', SOFT, {
    sub: { words: ['вещи', 'это', 'обычно'], active: 0, visible: 3, lines: [3], t: 1 },
    hook: { text: 'я покупаю вещи чтобы выглядеть плохо', t: 1 },
    accent: { lines: [{ text: 'я скажу' }, { text: 'что-то' }, { text: 'важное', size: 'big' }], x: 450, y: 900, ages: [1, 1, 1] },
  }],
  ['stickers and emoji', SPEC, {
    sub: { words: ['огонь', '🔥', 'точно'], active: 1, visible: 3 },
    inserts: [
      { kind: 'badge', text: 'Чешский с нуля 🇨🇿', x: 100, y: 300, w: 600, anim: 1, t: 0 },
      { kind: 'sticker', title: 'Совет', text: 'Учите по 15 минут в день, а не по три часа раз в неделю', x: 100, y: 700, w: 520, anim: 1, t: 0 },
    ],
  }],
  ['end card', SPEC, { end: { lines: ['Подпишись, чтобы не пропустить 👇'], handle: '@pavel.malakhouski', logo: 'emoji/1f4f7.png', t: 1 } }],
];

/** Можно ли здесь запустить WebKit; в CI (REQUIRE_WEBKIT) — обязан. */
async function webkitAvailable() {
  try {
    const b = await launchWebkit();
    await b.close();
    return true;
  } catch (e) {
    if (process.env.REQUIRE_WEBKIT) throw e;
    return false;
  }
}
const SKIP = (await webkitAvailable()) ? false : 'WebKit не установлен (в CI он ставится)';

let server;
const engines = {};

before(async () => {
  if (SKIP) return;
  server = await serve(ROOT);
  for (const [name, start] of [['chromium', launch], ['webkit', launchWebkit]]) {
    const browser = await start();
    const page = await framePage(browser);
    await page.goto(`${server.url}/overlay.html`);
    engines[name] = { browser, page };
  }
});

after(async () => {
  for (const e of Object.values(engines)) await e.browser.close();
  await server?.close();
});

async function boxesIn(name, spec, state) {
  const { page } = engines[name];
  await page.evaluate(([s, st]) => window.renderState(s, st), [spec, state]);
  return page.evaluate(() => window.layoutBoxes());
}

/** Расхождения рамок: числа x/y/w/h — не дальше max(4 px, 3 %), остальное — как есть; пусто — совпали. */
function differences(a, b, where = '') {
  if (typeof a === 'number' && typeof b === 'number') {
    const tol = Math.max(4, 0.03 * Math.max(Math.abs(a), Math.abs(b)));
    return Math.abs(a - b) <= tol ? [] : [`${where}: ${a} ≠ ${b}`];
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [`${where}: ${a.length} ≠ ${b.length} шт.`];
    return a.flatMap((x, i) => differences(x, b[i], `${where}[${i}]`));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => (k in a && k in b ? differences(a[k], b[k], where ? `${where}.${k}` : k) : [`${where}.${k}: есть только в одном`]));
  }
  return a === b ? [] : [`${where}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`];
}

for (const [name, spec, state] of CASES) {
  test(`Safari draws «${name}» where the render does`, { skip: SKIP }, async () => {
    const chromium = await boxesIn('chromium', spec, state);
    const webkit = await boxesIn('webkit', spec, state);
    assert.ok(Object.keys(chromium).length > 1 || chromium.inserts.length, `${name}: ничего не нарисовано`);
    assert.deepEqual(differences(chromium, webkit), [], `${name}\nChromium: ${JSON.stringify(chromium)}\nWebKit:   ${JSON.stringify(webkit)}`);
  });
}
