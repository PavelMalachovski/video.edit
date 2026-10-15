// Фильтры кусков в редакторе (ч/б и фильтры руками: сепия, тёплый, холодный, плёнка) — CSS filter на <video> прокси;
// движок считает те же функции по Filter Effects (на значениях sRGB, после каждой — в [0, 1]: engine/vm/looks.py,
// test_looks.py). Здесь — что браузеры рисуют их именно так: Chromium (редактор на компьютере) — как движок, WebKit
// (Safari на iPhone Павла) — так же, но с округлением до 8 бит после каждой функции (на холодном фильтре это до 2,3/255
// от финала: тёмно-серый 32 — 14,15,21 вместо 13,1, 14,3, 18,7). Фильтры — из общей фикстуры (bwFilter, lookFilters).
// WebKit нет — его часть пропускается; в CI он стоит, а REQUIRE_WEBKIT=1 не даёт пропустить молча.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';

import { launch, launchWebkit } from '../browser.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/overlay-events.json', import.meta.url), 'utf8'));
const { brightness, contrast } = FIXTURE.bwFilter;
const FILTERS = { bw: `grayscale(1) brightness(${brightness}) contrast(${contrast})`, ...FIXTURE.lookFilters };
const COLOURS = [
  ...[0, 32, 64, 96, 128, 160, 192, 224, 255].map((g) => [g, g, g]),
  [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 128, 0], [224, 172, 140], [120, 80, 60], [30, 60, 140],
];
const SIDE = 20;

/** Матрицы функций CSS filter (Filter Effects 1) — как css_matrix движка. */
function matrix(name, v) {
  if (name === 'grayscale' || name === 'sepia') {
    const a = 1 - v;
    return name === 'grayscale'
      ? [[0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a], [0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a],
        [0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a]]
      : [[0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a], [0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a],
        [0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a]];
  }
  if (name === 'saturate') {
    return [[0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v], [0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v],
      [0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v]];
  }
  const c = Math.cos((v * Math.PI) / 180);
  const s = Math.sin((v * Math.PI) / 180);
  return [[0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]];
}

/** Цвет 0..255 через CSS filter `css` по модели движка; `bytes` — после каждой функции до 8 бит, как рисует WebKit. */
function model(rgb, css, bytes = false) {
  let x = rgb.map((c) => c / 255);
  for (const [, name, num] of css.matchAll(/([a-z-]+)\(([-\d.]+)(?:deg)?\)/g)) {
    const v = Number(num);
    if (name === 'brightness') x = x.map((c) => c * v);
    else if (name === 'contrast') x = x.map((c) => (c - 0.5) * v + 0.5);
    else x = matrix(name, v).map((row) => row[0] * x[0] + row[1] * x[1] + row[2] * x[2]);
    x = x.map((c) => Math.min(1, Math.max(0, c)));
    if (bytes) x = x.map((c) => Math.round(c * 255) / 255);
  }
  return x.map((c) => c * 255);
}

test('rounding to 8 bits after each function (WebKit) keeps the preview within 2.5/255 of the final', () => {
  for (const [look, css] of Object.entries(FILTERS)) {
    for (const colour of COLOURS) {
      const exact = model(colour, css);
      const error = Math.max(...model(colour, css, true).map((b, k) => Math.abs(b - exact[k])));
      assert.ok(error <= 2.5, `${look}, rgb(${colour}): ${error.toFixed(2)}`);
    }
  }
});

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
const engines = { chromium: launch, webkit: (await webkitAvailable()) ? launchWebkit : null };
const browsers = {};

before(async () => {
  for (const [name, start] of Object.entries(engines)) if (start) browsers[name] = await start();
});
after(async () => {
  for (const b of Object.values(browsers)) await b.close();
});

/** Центры квадратов: строка на фильтр, столбец на цвет — RGB, что нарисовал браузер. */
async function drawn(name) {
  const page = await browsers[name].newPage({ viewport: { width: SIDE * COLOURS.length, height: SIDE * Object.keys(FILTERS).length } });
  const rows = Object.values(FILTERS).map((f) => `<div style="display:flex;filter:${f}">${
    COLOURS.map((c) => `<div style="width:${SIDE}px;height:${SIDE}px;background:rgb(${c.join(',')})"></div>`).join('')}</div>`).join('');
  await page.setContent(`<html><body style="margin:0;background:#000">${rows}</body></html>`);
  const png = await page.screenshot({ type: 'png' });
  const pixels = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, img.width, img.height).data);
  }, png.toString('base64'));
  await page.close();
  const width = SIDE * COLOURS.length;
  return Object.keys(FILTERS).map((_, r) => COLOURS.map((_, c) => {
    const at = ((r * SIDE + SIDE / 2) * width + c * SIDE + SIDE / 2) * 4;
    return pixels.slice(at, at + 3);
  }));
}

for (const name of Object.keys(engines)) {
  test(`${name} draws the b/w and filter pieces as the engine counts them`, { skip: engines[name] ? false : 'WebKit не установлен (в CI он ставится)' }, async () => {
    const got = await drawn(name);
    Object.entries(FILTERS).forEach(([look, css], r) => {
      COLOURS.forEach((colour, c) => {
        const want = model(colour, css, name === 'webkit');
        const error = Math.max(...want.map((w, k) => Math.abs(w - got[r][c][k])));
        const most = name === 'webkit' ? 1 : 2;
        assert.ok(error <= most, `${name}, ${look} (${css}), rgb(${colour}): ${got[r][c]} вместо ${want.map((w) => w.toFixed(1))}`);
      });
    });
  });
}
