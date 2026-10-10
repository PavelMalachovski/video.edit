// Слой ролика по спецификации стиля (StyleSpec, engine/vm/schemas/styles.json): субтитры, хук,
// титр с кодовым словом, шкала времени. Один и тот же файл рисует превью на странице и кадры финала
// (Chromium через Playwright) — поэтому превью совпадает с роликом по шрифту, размеру, цвету и месту.
//
//   await window.renderState(spec, state, {bar: {progress}, background})
//     state = {sub?: {words, active, visible}, hook?: {text}, cta?: {lines, word}, inserts?}
//   window.layoutBoxes() → {sub?, hook?, cta?, inserts: [...]} — рамки {x, y, w, h} в px кадра 1080×1920,
//     вместе с обводкой, тенью и плашкой. Вставки рисует inserts.js.
//
// Шрифты — из fonts.json рядом с этим файлом. Свои шрифты Павла (assets/fonts) дописывает в fonts.json
// тот, кто отдаёт шаблон. Шрифта нет в списке — ошибка: подменять его другим нельзя, иначе превью
// разойдётся с финалом.

import { drawInserts } from './inserts.js';

const FRAME = { w: 1080, h: 1920 };
const SAFE = { x0: 60, x1: 890, y0: 120, y1: 1530 }; // безопасная зона: всё, кроме шкалы, — внутри
const CX = (SAFE.x0 + SAFE.x1) / 2; // центр безопасной зоны (справа — кнопки соцсетей)
const WIDTH = SAFE.x1 - SAFE.x0;
const HOOK_Y = 400; // центр хука по высоте, если в стиле не задан hook.y
const HAND = 1.65; // рукописное слово крупнее капса
const SUB_LINE = 1.12; // межстрочный интервал субтитров
const CAPS_LINE = 1.04;
const SHRINK = 0.94; // шаг ужатия шрифта, когда текст не влезает
const MIN_SCALE = 0.3; // мельче этого шрифт не ужимается

// ---------- шрифты ----------

const FONTS_URL = new URL('fonts.json', import.meta.url);
let fontList = null;
const faces = new Map();

function fontsJson() {
  fontList ??= fetch(FONTS_URL).then(
    (r) => {
      if (!r.ok) throw new Error(`fonts.json: HTTP ${r.status}`);
      return r.json();
    },
  );
  fontList.catch(() => {
    fontList = null;
  });
  return fontList;
}

/** Шрифт по id из fonts.json → `{family, weight}`; файл грузится один раз. */
function font(id) {
  if (!faces.has(id)) {
    const loading = (async () => {
      const entry = (await fontsJson()).find((f) => f.id === id);
      if (!entry) throw new Error(`шрифт «${id}» не найден в fonts.json`);
      const family = `vm-${id}`;
      const face = new FontFace(family, `url("${new URL(entry.file, FONTS_URL).href}")`, { weight: '1 1000' });
      await face.load();
      document.fonts.add(face);
      return { family, weight: entry.weight ?? 400 };
    })();
    loading.catch(() => faces.delete(id));
    faces.set(id, loading);
  }
  return faces.get(id);
}

const measure = document.createElement('canvas').getContext('2d');

/** Настоящие границы букв текста относительно базовой линии (а не высота строки шрифта). */
function ink(f, size, text) {
  measure.font = `${f.weight} ${size}px "${f.family}"`;
  const m = measure.measureText(text);
  return { ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent };
}

// ---------- мелочи ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function layer(id) {
  const root = document.getElementById(id);
  root.replaceChildren();
  root.hidden = true;
  return root;
}

function upper(text) {
  return String(text).toLocaleUpperCase('ru-RU');
}

/** Короткие слова (предлоги, союзы: «в», «и», «на») не остаются в конце строки — держатся за следующее. */
function glue(text) {
  let out = String(text);
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/(^|[\s\u00A0])([А-Яа-яЁёA-Za-z]{1,2}) +(?=\S)/gu, '$1$2\u00A0');
  }
  return out;
}

/** Маркер базовой линии в конце (или начале) узла: его верх — базовая линия строки. */
function baseline(node, atStart = false) {
  const mark = el('span', 'bl');
  if (atStart) node.prepend(mark);
  else node.append(mark);
  return mark;
}

function union(rects) {
  let r = null;
  for (const q of rects) {
    if (!q) continue;
    r = r
      ? { left: Math.min(r.left, q.left), top: Math.min(r.top, q.top), right: Math.max(r.right, q.right), bottom: Math.max(r.bottom, q.bottom) }
      : { left: q.left, top: q.top, right: q.right, bottom: q.bottom };
  }
  return r;
}

function grow(r, x, y = x, down = y) {
  return { left: r.left - x, top: r.top - y, right: r.right + x, bottom: r.bottom + down };
}

function shift(r, dy) {
  return { left: r.left, top: r.top + dy, right: r.right, bottom: r.bottom + dy };
}

/** Сдвиг по высоте, после которого рамка `r` (уже со сдвигом `dy`) стоит внутри безопасной зоны. */
function keepInside(r, dy) {
  let d = dy;
  if (r.bottom + d > SAFE.y1) d = SAFE.y1 - r.bottom;
  if (r.top + d < SAFE.y0) d = SAFE.y0 - r.top;
  return Math.round(d);
}

function place(node, r, style = {}) {
  Object.assign(node.style, {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.right - r.left}px`,
    height: `${r.bottom - r.top}px`,
    ...style,
  });
}

function box(r) {
  const x = Math.floor(r.left);
  const y = Math.floor(r.top);
  return { x, y, w: Math.ceil(r.right) - x, h: Math.ceil(r.bottom) - y };
}

/** Число строк, на которые разложились слова (`.w`) или куски текста узла. */
function lineCount(rects) {
  return new Set(rects.map((r) => Math.round(r.top))).size;
}

/** Рамки кусков текста узла по строкам — только текст, без рамок блочных детей. */
function textRects(node) {
  const rects = [];
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(t);
    rects.push(...[...range.getClientRects()].filter((r) => r.width > 0));
  }
  return rects;
}

function stroke(node, width, color) {
  node.style.setProperty('-webkit-text-stroke', width > 0 ? `${2 * width}px ${color}` : '0');
  node.style.setProperty('paint-order', 'stroke fill');
}

// ---------- субтитры ----------

function subExtent(mode, size) {
  if (mode === 'plate') return { x: Math.round(0.4 * size), y: Math.round(0.22 * size), stroke: 0 };
  const w = Math.max(2, Math.round(0.06 * size));
  return { x: w, y: w, stroke: w };
}

function drawSub({ spec, main }, sub) {
  const root = layer('sub');
  if (!sub || !Array.isArray(sub.words) || sub.words.length === 0) return null;
  root.hidden = false;
  const { mode, size, y } = spec.subtitles;
  const c = spec.colors;
  const single = mode === 'word';
  const words = single ? [String(sub.words[sub.active] ?? sub.words[0])] : sub.words.map(String);
  const active = single ? 0 : sub.active;
  const visible = mode === 'accumulate' ? sub.visible : words.length;

  const plate = el('div', 'plate');
  plate.hidden = mode !== 'plate';
  const lines = el('div', `lines ${mode}`);
  const underline = el('div', 'uline');
  underline.hidden = !single;
  root.append(plate, lines, underline);
  words.forEach((w, i) => {
    if (i) lines.append(' ');
    const span = el('span', 'w', w);
    span.dataset.i = String(i);
    if (i === active) span.classList.add('on');
    if (i >= visible) span.style.visibility = 'hidden';
    lines.append(span);
  });
  const mark = single ? baseline(lines) : null;
  Object.assign(lines.style, { fontFamily: `"${main.family}"`, fontWeight: String(main.weight), color: c.text, lineHeight: String(SUB_LINE) });
  lines.style.setProperty('--on-fg', mode === 'plate' ? c.plate : single ? c.text : c.accent);
  lines.style.setProperty('--on-bg', c.accent);
  const spans = [...lines.querySelectorAll('.w')];

  // Крупно, сколько влезает: «по слову» — одна строка, обводка и плашка — две, накопление — две,
  // а если для двух шрифт пришлось бы ужать больше чем на 20 % — три.
  const tries = mode === 'accumulate' ? [[2, 0.8], [3, MIN_SCALE]] : [[single ? 1 : 2, MIN_SCALE]];
  let px = size;
  let ext = subExtent(mode, px);
  const setSize = (s) => {
    px = s;
    ext = subExtent(mode, s);
    const width = WIDTH - 2 * ext.x;
    Object.assign(lines.style, { fontSize: `${s}px`, left: `${CX - width / 2}px`, width: `${width}px`, top: '0px' });
    stroke(lines, ext.stroke, c.outline);
    return width;
  };
  fit: for (const [maxLines, floor] of tries) {
    for (let scale = 1; ; scale *= SHRINK) {
      const width = setSize(size * Math.max(scale, floor));
      const rects = spans.map((s) => s.getBoundingClientRect());
      if (lineCount(rects) <= maxLines && Math.max(...rects.map((r) => r.width)) <= width + 0.5) break fit;
      if (scale <= floor) break;
    }
  }

  const words0 = union(spans.map((s) => s.getBoundingClientRect()));
  let below = 0;
  let bar = null;
  if (single) {
    // полоса цвета подсветки под словом: от настоящего низа букв, толщина ~0,12 кегля
    const gap = Math.round(0.08 * px);
    const height = Math.max(6, Math.round(0.12 * px));
    const top = mark.getBoundingClientRect().top + ink(main, px, words[0]).descent + gap;
    bar = { left: words0.left, top, right: words0.right, bottom: top + height };
    below = Math.max(0, bar.bottom - (words0.bottom + ext.y));
  }
  const outer = grow(words0, ext.x, ext.y, ext.y + below);
  const dy = keepInside(outer, Math.round(y - (words0.top + words0.bottom) / 2));
  lines.style.top = `${dy}px`;
  if (mode === 'plate') place(plate, shift(grow(words0, ext.x, ext.y), dy), { background: c.plate, borderRadius: `${Math.round(0.28 * px)}px` });
  if (bar) place(underline, shift(bar, dy), { background: c.accent, borderRadius: `${(bar.bottom - bar.top) / 2}px` });
  return box(shift(outer, dy));
}

// ---------- хук и титр с кодовым словом ----------

/** Хук: все слова, кроме последнего, — строка капсом; последнее — рукописное. */
function hookTitle(hook) {
  if (!hook || typeof hook.text !== 'string') return null;
  const words = hook.text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const word = words.pop();
  return { lines: words.length ? [words.join(' ')] : [], word, wrap: 2 };
}

function ctaTitle(cta) {
  if (!cta) return null;
  const lines = (cta.lines ?? []).map(String).filter((l) => l.trim());
  const word = String(cta.word ?? '').trim();
  if (lines.length === 0 && !word) return null;
  return { lines, word, wrap: 1 };
}

function titleLook(mode, size) {
  if (mode === 'plate') return { pad: { x: Math.round(0.42 * size), y: Math.round(0.26 * size) }, caps: 0, hand: 13, shadow: true };
  if (mode === 'outline') return { pad: { x: 3, y: 3 }, caps: 3, hand: 3, outline: 3 };
  return { pad: { x: 20, y: 20 }, caps: 20, hand: 20, shadow: true };
}

function drawTitle(id, { spec, main, hand }, title) {
  const root = layer(id);
  if (!title) return null;
  root.hidden = false;
  const { mode, size } = spec.hook;
  const y = spec.hook.y ?? HOOK_Y;
  const c = spec.colors;

  const plate = el('div', 'plate');
  plate.hidden = mode !== 'plate' || title.lines.length === 0;
  const caps = el('div', 'caps');
  for (const text of title.lines) caps.append(el('div', 'line', upper(glue(text))));
  const handBox = el('div', 'hand');
  handBox.hidden = !title.word;
  const handText = el('span', null, title.word);
  handBox.append(handText);
  root.append(plate, caps, handBox);
  const first = caps.firstElementChild;
  const last = caps.lastElementChild;
  const capsTop = first ? baseline(first, true) : null;
  const capsBottom = last ? baseline(last) : null;
  const handMark = baseline(handBox);

  const softShadow = mode === 'plate' ? '0 3px 10px rgba(0, 0, 0, 0.5)' : '0 4px 16px rgba(0, 0, 0, 0.65)';
  Object.assign(caps.style, { fontFamily: `"${main.family}"`, fontWeight: String(main.weight), color: c.text, lineHeight: String(CAPS_LINE) });
  Object.assign(handBox.style, { fontFamily: `"${hand.family}"`, fontWeight: String(hand.weight), color: c.accent, lineHeight: '1' });
  if (mode === 'shadow') caps.style.textShadow = softShadow;
  if (mode !== 'outline') handBox.style.textShadow = softShadow;

  let px = size;
  let look = titleLook(mode, px);
  const setSize = (s) => {
    px = s;
    look = titleLook(mode, s);
    const capsWidth = WIDTH - 2 * look.pad.x;
    const handWidth = WIDTH - 2 * look.hand;
    Object.assign(caps.style, { fontSize: `${s}px`, left: `${CX - capsWidth / 2}px`, width: `${capsWidth}px`, top: '0px' });
    Object.assign(handBox.style, { fontSize: `${s * HAND}px`, left: `${CX - handWidth / 2}px`, width: `${handWidth}px`, top: '0px' });
    stroke(caps, look.outline ?? 0, c.outline);
    stroke(handBox, look.outline ?? 0, c.outline);
    return { capsWidth, handWidth };
  };
  for (let scale = 1; ; scale *= SHRINK) {
    const { capsWidth, handWidth } = setSize(size * Math.max(scale, MIN_SCALE));
    const capsFit = [...caps.children].every((line) => line.scrollWidth <= capsWidth + 0.5 && lineCount(textRects(line)) <= title.wrap);
    const handFit = !title.word || handText.getBoundingClientRect().width <= handWidth + 0.5;
    if ((capsFit && handFit) || scale <= MIN_SCALE) break;
  }

  // Границы по настоящим буквам: строка капсом — от верха первой строки до низа последней,
  // рукописное слово «свисает» сразу под ней.
  const handPx = px * HAND;
  let capsInk = null;
  if (first) {
    const m = ink(main, px, upper(title.lines.join(' ')));
    const sides = union(textRects(caps));
    capsInk = { left: sides.left, right: sides.right, top: capsTop.getBoundingClientRect().top - m.ascent, bottom: capsBottom.getBoundingClientRect().top + m.descent };
  }
  let handInk = null;
  if (title.word) {
    const m = ink(hand, handPx, title.word);
    const r = handText.getBoundingClientRect();
    const base = handMark.getBoundingClientRect().top;
    handInk = { left: r.left, right: r.right, top: base - m.ascent, bottom: base + m.descent };
  }

  let capsDy = 0;
  let handDy = 0;
  if (capsInk) {
    capsDy = Math.round(y - (capsInk.top + capsInk.bottom) / 2);
    if (handInk) handDy = Math.round(capsInk.bottom + capsDy + Math.round(0.06 * px) - handInk.top);
  } else if (handInk) {
    handDy = Math.round(y - (handInk.top + handInk.bottom) / 2);
  }
  const capsOuter = capsInk && shift(grow(capsInk, look.pad.x, look.pad.y), capsDy);
  const handOuter = handInk && shift(grow(handInk, look.hand), handDy);
  const outer = union([capsOuter, handOuter]);
  const dy = keepInside(outer, 0);

  caps.style.top = `${capsDy + dy}px`;
  handBox.style.top = `${handDy + dy}px`;
  if (!plate.hidden) place(plate, shift(capsOuter, dy), { background: c.plate, borderRadius: `${Math.round(0.2 * px)}px` });
  return box(shift(outer, dy));
}

// ---------- шкала времени ----------

function drawBar(spec, bar) {
  const node = document.getElementById('bar');
  const progress = bar ? Math.min(1, Math.max(0, Number(bar.progress) || 0)) : 0;
  node.hidden = !bar || progress === 0;
  if (node.hidden) return;
  const height = spec.bar.height;
  place(node, { left: 0, top: spec.bar.pos === 'top' ? 0 : FRAME.h - height, right: Math.round(FRAME.w * progress), bottom: (spec.bar.pos === 'top' ? 0 : FRAME.h - height) + height }, { background: spec.colors.bar });
}

// ---------- вход ----------

let lastBoxes = { inserts: [] };

window.renderState = async function renderState(spec, state = {}, opts = {}) {
  const [main, hand] = await Promise.all([font(spec.font), font(spec.hand)]);
  await document.fonts.ready;
  const look = { spec, main, hand };
  const s = state ?? {};
  document.getElementById('frame').style.background = opts?.background ?? 'transparent';
  const boxes = { inserts: await drawInserts(document.getElementById('inserts'), s.inserts ?? [], look) };
  const sub = drawSub(look, s.sub);
  if (sub) boxes.sub = sub;
  const hook = drawTitle('hook', look, hookTitle(s.hook));
  if (hook) boxes.hook = hook;
  const cta = drawTitle('cta', look, ctaTitle(s.cta));
  if (cta) boxes.cta = cta;
  drawBar(spec, opts?.bar);
  lastBoxes = boxes;
};

window.layoutBoxes = function layoutBoxes() {
  return structuredClone(lastBoxes);
};
