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

test('insert box carries the edit index the state gives it', async () => {
  await render([{ ...photo(), n: 3 }, { kind: 'image', src: 'cutout.png', x: 560, y: 900, w: 300, anim: 1, t: 0, params: {} }]);
  const [given, plain] = (await boxes()).inserts;
  assert.equal(given.n, 3);
  assert.equal('n' in plain, false);
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

/** Рамка всех пикселей кадра с прозрачностью ≥ 4/255 (что реально нарисовано); считает соседняя вкладка. */
async function drawnBox() {
  const png = await page.screenshot({ omitBackground: true });
  return scratch.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 3, i = 0; k < d.length; k += 4, i++) {
      if (d[k] < 4) continue;
      const x = i % c.width;
      const y = (i / c.width) | 0;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x + 1 > x1) x1 = x + 1;
      if (y + 1 > y1) y1 = y + 1;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, png.toString('base64'));
}

test('everything drawn stays inside the reported box, at any appearance step', async () => {
  const kinds = [
    photo(),
    { kind: 'image', src: 'cutout.png', x: 100, y: 300, w: 400, t: 0, params: { cutout: true } },
    { kind: 'badge', text: 'Чешский с нуля', src: 'cutout.png', x: 100, y: 300, w: 600, t: 0 },
    { kind: 'sticker', title: 'Главная ошибка', text: 'Учите по 15 минут в день', x: 100, y: 300, w: 420, t: 0 },
    { kind: 'sticker', title: 'Очень длинный заголовок вставки', text: 'текст', x: 100, y: 300, w: 420, t: 0 },
    { kind: 'anim', title: 'Важный совет', x: 100, y: 300, w: 300, t: 0.4, params: { name: 'bachata' } },
    { kind: 'text', text: '3 ошибки новичка 🔥', x: 100, y: 300, w: 420, t: 0 },
    { kind: 'text', text: '1. Свет', x: 100, y: 300, w: 300, t: 0, params: { tone: 'light' } },
  ];
  for (const ins of kinds) {
    for (const anim of [0.3, 1]) {
      await render([{ ...ins, anim }]);
      const [box] = (await boxes()).inserts;
      const seen = await drawnBox();
      const name = `${ins.kind} ${ins.title ?? ''} anim=${anim}`;
      assert.ok(seen.x >= box.x && seen.y >= box.y && seen.x + seen.w <= box.x + box.w && seen.y + seen.h <= box.y + box.h, `${name}: drawn ${JSON.stringify(seen)} outside ${JSON.stringify(box)}`);
      // у PNG без фона рамка — весь прямоугольник картинки, а нарисован силуэт внутри: тесноту не проверяем
      if (anim === 1 && !ins.params?.cutout) assert.ok(box.w * box.h <= 1.6 * seen.w * seen.h, `${name}: box ${JSON.stringify(box)} far larger than drawn ${JSON.stringify(seen)}`);
    }
  }
});

test('a long sticker title shrinks to fit its card', async () => {
  await render([{ kind: 'sticker', title: 'Очень длинный заголовок вставки', text: 'текст', x: 100, y: 300, w: 420, anim: 1, t: 0 }]);
  const seen = await drawnBox();
  assert.ok(seen.x >= 100 - 30 && seen.x + seen.w <= 520 + 30, `title kept to the card: ${JSON.stringify(seen)}`);
});

test('the latest renderState call wins even when an earlier one is slower', async () => {
  const final = await page.evaluate(async ([s, slow]) => {
    const a = window.renderState(s, { sub: { words: ['А'], active: 0, visible: 1 }, inserts: [slow] });
    const b = window.renderState(s, { sub: { words: ['Б'], active: 0, visible: 1 } });
    await Promise.all([a, b]);
    return { sub: document.querySelector('#sub .w')?.textContent, inserts: document.querySelectorAll('#inserts .ins').length, boxes: window.layoutBoxes().inserts.length };
  }, [SPEC, photo({ src: `photo.png?slow=${Date.now()}` })]);
  assert.deepEqual(final, { sub: 'Б', inserts: 0, boxes: 0 });
});

test('inserts sit under subtitles and the hook', async () => {
  const order = await page.evaluate(() => [...document.querySelectorAll('#frame > div')].map((e) => e.id));
  assert.ok(order.indexOf('inserts') < order.indexOf('sub') && order.indexOf('inserts') < order.indexOf('hook'), order.join(','));
});

test('emoji in sticker and badge texts are pictures from emoji/, not a system font', async () => {
  await page.evaluate(() => {
    window.__drawn = [];
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (img, ...rest) {
      if (img?.src) window.__drawn.push(img.src.split('/').pop());
      return draw.call(this, img, ...rest);
    };
  });
  try {
    await render([
      { kind: 'sticker', title: 'Свет 💡', text: 'Ставь лампу 💙 сбоку', x: 100, y: 300, w: 420, anim: 1 },
      { kind: 'badge', text: 'Скидка 🔥', x: 100, y: 900, w: 600, anim: 1 },
    ]);
    const drawn = await page.evaluate(() => window.__drawn);
    for (const file of ['1f4a1.png', '1f499.png', '1f525.png']) assert.ok(drawn.includes(file), `${file}: ${drawn}`);
    const [sticker, badge] = (await boxes()).inserts;
    assert.ok(sticker.w > 0 && badge.w > 0);
  } finally {
    await page.evaluate(() => {
      delete window.__drawn;
    });
    await page.reload();
  }
});

// ---------- стикер-тезис ----------

/** Доля пикселей цвета `hex` (±12 по каналу) среди непрозрачных в прямоугольнике. */
async function shareOf(clip, hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const px = await pixels(clip);
  let hit = 0;
  let solid = 0;
  for (let k = 0; k < px.length; k += 4) {
    if (px[k + 3] < 250) continue;
    solid++;
    if (Math.abs(px[k] - r) <= 12 && Math.abs(px[k + 1] - g) <= 12 && Math.abs(px[k + 2] - b) <= 12) hit++;
  }
  return solid ? hit / solid : 0;
}

/** Ширина и высота плашки — по непрозрачным пикселям цвета `hex`. */
async function plate(box, hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const px = await pixels({ x: box.x, y: box.y, width: box.w, height: box.h });
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let k = 0, i = 0; k < px.length; k += 4, i++) {
    if (px[k + 3] < 250 || Math.abs(px[k] - r) > 12 || Math.abs(px[k + 1] - g) > 12 || Math.abs(px[k + 2] - b) > 12) continue;
    const x = i % box.w;
    const y = Math.floor(i / box.w);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x + 1);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y + 1);
  }
  return { x: box.x + x0, y: box.y + y0, w: x1 - x0, h: y1 - y0 };
}

test('a thesis sticker is an accent plate exactly w wide, and its size follows w', async () => {
  await render([{ kind: 'text', text: '3 ошибки новичка', x: 120, y: 700, w: 420, anim: 1, t: 0 }]);
  const [box] = (await boxes()).inserts;
  const p = await plate(box, SPEC.colors.accent);
  assert.ok(Math.abs(p.x - 120) <= 1 && Math.abs(p.w - 420) <= 2 && Math.abs(p.y - 700) <= 1, `plate ${JSON.stringify(p)}`);
  assert.ok((await shareOf({ x: p.x, y: p.y, width: p.w, height: p.h }, SPEC.colors.accent)) > 0.5, 'плашка цвета подсветки');
  await render([{ kind: 'text', text: '3 ошибки новичка', x: 120, y: 700, w: 630, anim: 1, t: 0 }]);
  const [wide] = (await boxes()).inserts;
  const q = await plate(wide, SPEC.colors.accent);
  assert.ok(Math.abs(q.w - 630) <= 2, `wide plate ${JSON.stringify(q)}`);
  assert.ok(Math.abs(q.h / p.h - 1.5) < 0.06, `те же строки, крупнее: ${p.h} → ${q.h}`);
});

test('thesis sticker tones: dark plate with light text, light plate', async () => {
  await render([{ kind: 'text', text: 'Свет', x: 120, y: 700, w: 300, anim: 1, t: 0, params: { tone: 'dark' } }]);
  let [box] = (await boxes()).inserts;
  assert.ok(Math.abs((await plate(box, SPEC.colors.plate)).w - 300) <= 2, 'тёмная плашка — цвета plate');
  await render([{ kind: 'text', text: 'Свет', x: 120, y: 700, w: 300, anim: 1, t: 0, params: { tone: 'light' } }]);
  [box] = (await boxes()).inserts;
  assert.ok(Math.abs((await plate(box, '#FFFFFF')).w - 300) <= 2, 'светлая плашка — белая');
});

test('an unknown sticker tone is an error', async () => {
  await assert.rejects(render([{ kind: 'text', text: 'Свет', x: 120, y: 700, w: 300, anim: 1, t: 0, params: { tone: 'neon' } }]), /tone/);
  await page.reload();
});

// ---------- формат разбора: стикеры-картинки влетают сбоку, карточка профиля со свечением ----------

function rectOf(i = 0) {
  return page.evaluate((k) => {
    const r = document.querySelector(`#inserts .ins[data-i="${k}"]`).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, i);
}

test('a picture with params.enter flies in from its side, opaque all the way, and lands on its place', async () => {
  const from = { left: (r) => r.right <= 0, right: (r) => r.left >= 1080, top: (r) => r.bottom <= 0, bottom: (r) => r.top >= 1920 };
  for (const [side, outside] of Object.entries(from)) {
    await render([photo({ anim: 0, params: { enter: side } })]);
    assert.ok(outside(await rectOf()), `${side}: в начале — за краем кадра ${JSON.stringify(await rectOf())}`);
    await render([photo({ anim: 0.4, params: { enter: side } })]);
    assert.equal((await look()).opacity, 1, `${side}: влетает, а не проявляется`);
    await render([photo({ anim: 1, params: { enter: side } })]);
    const r = await rectOf();
    assert.ok(Math.abs(r.left - 100) < 0.5 && Math.abs(r.top - 300) < 0.5, `${side}: на месте ${JSON.stringify(r)}`);
  }
});

test('a tilted or glowing picture stays inside its reported box; the glow is light around the picture', async () => {
  for (const params of [{ tilt: 8 }, { tilt: -12, cutout: true }, { glow: true }, { glow: true, tilt: 6, enter: 'bottom' }]) {
    const ins = params.cutout ? { kind: 'image', src: 'cutout.png', x: 200, y: 400, w: 400, t: 0, anim: 1, params } : photo({ x: 200, y: 400, params });
    await render([ins]);
    const [box] = (await boxes()).inserts;
    const seen = await drawnBox();
    assert.ok(seen.x >= box.x && seen.y >= box.y && seen.x + seen.w <= box.x + box.w && seen.y + seen.h <= box.y + box.h,
      `${JSON.stringify(params)}: drawn ${JSON.stringify(seen)} outside ${JSON.stringify(box)}`);
    if (params.tilt && !params.glow && !params.cutout) assert.ok(seen.w > 400 + 20, `${JSON.stringify(params)}: повёрнута ${JSON.stringify(seen)}`);
  }
  await render([photo({ x: 200, y: 400, params: { glow: true } })]);
  const halo = await pixels({ x: 200 + 160, y: 400 - 14, width: 80, height: 8 }); // над картинкой — свет
  let lit = 0;
  for (let k = 0; k < halo.length; k += 4) if (halo[k + 3] > 40 && halo[k] > 200 && halo[k + 1] > 200 && halo[k + 2] > 200) lit++;
  assert.ok(lit > 100, `свечение над картинкой: ${lit}`);
});

test('in the ads zone a tilted glowing picture is lifted whole above the ad button', async () => {
  const ins = photo({ x: 200, y: 1100, params: { tilt: 12, glow: true } });
  await page.evaluate(([s, i]) => window.renderState(s, { inserts: i, zone: 'ads' }), [SPEC, [ins]]);
  const [box] = (await boxes()).inserts;
  assert.ok(box.y >= 270 && box.y + box.h <= 1250, JSON.stringify(box));
});
