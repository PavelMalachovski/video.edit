// Вставки в слое: картинки (прямоугольные и PNG без фона), бейдж, стикер, анимация.
// Картинки для тестов рисует сам Chromium и кладёт во временную папку, которую отдаёт тот же сервер.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { framePage, launch } from '../browser.mjs';
import { serve } from '../serve.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SPEC = {
  font: 'montserrat',
  hand: 'caveat',
  colors: { text: '#FFFFFF', accent: '#FFD23F', bar: '#FFD23F', plate: '#111111', outline: '#000000' },
  subtitles: { mode: 'karaoke', words: 3, size: 64, y: 1300 },
  hook: { mode: 'plate', size: 72 },
  bar: { pos: 'bottom', height: 14 },
};

let dir;
let server;
let browser;
let page;
let scratch;

/** PNG из скрипта рисования на холсте `w×h` (рисует Chromium, сохраняем во временную папку). */
async function makePng(name, w, h, paint) {
  const b64 = await scratch.evaluate(
    ([cw, ch, code]) => {
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      new Function('ctx', code)(c.getContext('2d'));
      return c.toDataURL('image/png').split(',')[1];
    },
    [w, h, paint],
  );
  await writeFile(path.join(dir, name), Buffer.from(b64, 'base64'));
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vm-inserts-'));
  browser = await launch();
  scratch = await browser.newPage();
  await makePng('photo.png', 400, 300, "ctx.fillStyle = '#3366FF'; ctx.fillRect(0, 0, 400, 300);");
  await makePng('cutout.png', 400, 400, "ctx.fillStyle = '#FF8800'; ctx.beginPath(); ctx.arc(200, 200, 150, 0, 7); ctx.fill();");
  server = await serve([ROOT, dir]);
  page = await framePage(browser);
  await page.goto(`${server.url}/overlay.html`);
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function render(inserts) {
  return page.evaluate(([s, ins]) => window.renderState(s, { inserts: ins }), [SPEC, inserts]);
}

function boxes() {
  return page.evaluate(() => window.layoutBoxes());
}

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

function look(i = 0) {
  return page.evaluate((k) => {
    const e = document.querySelector(`#inserts .ins[data-i="${k}"]`);
    const m = new DOMMatrix(getComputedStyle(e).transform);
    return { opacity: Number(getComputedStyle(e).opacity), scale: m.a };
  }, i);
}

const photo = (extra = {}) => ({ kind: 'image', src: 'photo.png', x: 100, y: 300, w: 400, anim: 1, t: 0, ...extra });

test('image appears with ease-out', async () => {
  await render([photo({ anim: 0 })]);
  assert.deepEqual(await look(), { opacity: 0, scale: 0.965 });
  await render([photo({ anim: 0.5 })]);
  const half = await look();
  assert.ok(Math.abs(half.opacity - 0.875) < 1e-3, JSON.stringify(half)); // 1 − (1 − 0.5)³
  assert.ok(half.scale > 0.965 && half.scale < 1, JSON.stringify(half));
  assert.ok(Math.abs(half.scale - (0.965 + 0.035 * 0.875)) < 1e-4, JSON.stringify(half));
  await render([photo({ anim: 1 })]);
  assert.deepEqual(await look(), { opacity: 1, scale: 1 });
});

test('rectangular image gets a rounded 1 px #111 frame and keeps its aspect', async () => {
  await render([photo()]);
  const st = await page.evaluate(() => {
    const img = document.querySelector('#inserts .ins img');
    const s = getComputedStyle(img);
    const r = img.getBoundingClientRect();
    return { radius: s.borderTopLeftRadius, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`, shadow: s.boxShadow, w: r.width, h: r.height };
  });
  assert.equal(st.radius, '10px');
  assert.equal(st.border, '1px solid rgb(17, 17, 17)');
  assert.match(st.shadow, /rgba\(0, 0, 0, 0\.08\) 0px 2px 10px/);
  assert.deepEqual([st.w, st.h], [400, 300]);
  const edge = await pixels({ x: 100, y: 450, width: 1, height: 1 });
  assert.deepEqual(edge.slice(0, 3), [17, 17, 17]);
  const corner = await pixels({ x: 100, y: 300, width: 1, height: 1 });
  assert.ok(corner[3] < 128, 'rounded corner is cut off');
});

test('cutout png gets silhouette outline, not a frame', async () => {
  await render([{ kind: 'image', src: 'cutout.png', x: 100, y: 300, w: 400, anim: 1, t: 0, params: { cutout: true } }]);
  const corner = await pixels({ x: 104, y: 304, width: 4, height: 4 });
  assert.ok(corner.every((v, k) => k % 4 !== 3 || v === 0), 'transparent corner stays transparent');
  const rim = await pixels({ x: 100 + 50 - 1, y: 300 + 200, width: 1, height: 1 }); // слева от круга
  assert.ok(rim[3] > 100 && rim[0] < 80 && rim[1] < 80 && rim[2] < 80, `outline along the silhouette: ${rim}`);
  const st = await page.evaluate(() => getComputedStyle(document.querySelector('#inserts .ins img')).borderTopStyle);
  assert.equal(st, 'none');
});

test('insert box is reported in layoutBoxes', async () => {
  await render([photo(), { kind: 'image', src: 'cutout.png', x: 560, y: 900, w: 300, anim: 0.3, t: 0, params: { cutout: true } }]);
  const { inserts } = await boxes();
  assert.equal(inserts.length, 2);
  const [a, b] = inserts;
  assert.ok(a.x <= 100 && a.y <= 300 && a.x + a.w >= 500 && a.y + a.h >= 600, JSON.stringify(a));
  assert.ok(a.x >= 84 && a.y >= 284 && a.x + a.w <= 516 && a.y + a.h <= 616, `shadow only: ${JSON.stringify(a)}`);
  // во время появления рамка — как у показанной целиком вставки
  assert.ok(b.x <= 560 && b.y <= 900 && b.x + b.w >= 860 && b.y + b.h >= 1200, JSON.stringify(b));
});

test('anim kind draws non-empty canvas that moves with t', async () => {
  const dance = (t) => [{ kind: 'anim', x: 100, y: 300, w: 384, anim: 1, t, params: { name: 'bachata' } }];
  await render(dance(0.2));
  const [box] = (await boxes()).inserts;
  const clip = { x: box.x, y: box.y, width: box.w, height: box.h };
  const early = await pixels(clip);
  assert.ok(early.filter((v, k) => k % 4 === 3 && v > 0).length > 20000, 'something is drawn');
  await render(dance(0.6));
  const late = await pixels(clip);
  let diff = 0;
  for (let k = 0; k < early.length; k += 4) if (Math.abs(early[k] - late[k]) + Math.abs(early[k + 1] - late[k + 1]) > 60) diff++;
  assert.ok(diff > 500, `the couple dances: ${diff} pixels changed`);
});

test('badge and sticker draw inside their boxes', async () => {
  await render([
    { kind: 'badge', text: 'Чешский с нуля', x: 100, y: 300, w: 600, anim: 1, t: 0 },
    { kind: 'sticker', title: 'Совет', text: 'Учите по 15 минут в день, а не по три часа раз в неделю', x: 100, y: 700, w: 520, anim: 1, t: 0 },
  ]);
  const [badge, sticker] = (await boxes()).inserts;
  for (const [name, b, w] of [['badge', badge, 600], ['sticker', sticker, 520]]) {
    assert.ok(b.w <= w + 60 && b.w >= w * 0.5, `${name}: ${JSON.stringify(b)}`);
    const px = await pixels({ x: b.x, y: b.y, width: b.w, height: b.h });
    assert.ok(px.filter((v, k) => k % 4 === 3 && v > 200).length > 5000, `${name} is drawn`);
  }
  assert.ok(sticker.h > 200, 'sticker grows with its text');
});

test('a missing picture or an unknown kind is an error, not a silent gap', async () => {
  await assert.rejects(render([photo({ src: 'nope.png' })]), /nope\.png/);
  await assert.rejects(render([{ kind: 'fullscreen', src: 'photo.png', x: 0, y: 0, w: 1080, anim: 1, t: 0 }]), /fullscreen/);
  await assert.rejects(render([{ kind: 'anim', x: 0, y: 0, w: 300, anim: 1, t: 0, params: { name: 'salsa' } }]), /salsa/);
});

test('inserts sit under subtitles and the hook', async () => {
  const order = await page.evaluate(() => [...document.querySelectorAll('#frame > div')].map((e) => e.id));
  assert.ok(order.indexOf('inserts') < order.indexOf('sub') && order.indexOf('inserts') < order.indexOf('hook'), order.join(','));
});
