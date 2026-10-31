// Слой ролика по спецификации стиля (StyleSpec, engine/vm/schemas/styles.json): субтитры, хук,
// титр с кодовым словом, акцентные фразы, шкала времени. Один и тот же файл рисует превью на странице и кадры
// финала (Chromium через Playwright) — поэтому превью совпадает с роликом по шрифту, размеру, цвету и месту.
//
//   await window.renderState(spec, state, {bar: {progress}, background})
//     state = {sub?: {words, active, visible, lines?, t?}, hook?: {text, t?}, cta?: {lines, word}, accent?, inserts?,
//              end?: {lines, handle?, logo?, t}}  — end: финальная карточка, t — секунды от её начала
//     sub.lines и sub.t — у режима soft: сколько слов в каждой строке блока и секунды с появления последней видимой
//     строки; hook.t — секунды с начала показа хука в режиме accent (появление из размытия); нет t — без анимации.
//     accent = {lines: [{text, size?: "small"|"normal"|"big", color?: "accent"}], x, y, anim?, ages, out?, leave?} —
//     акцентная фраза: центр блока x, y; ages — секунды с появления каждой строки (null — её слово ещё не звучит);
//     anim — blur (по умолчанию), type, letters, track; out — fade (по умолчанию), zoom; leave — 0..1 ухода.
//   window.layoutBoxes() → {sub?, hook?, cta?, accent?, end?, inserts: [...]} — рамки {x, y, w, h} в px кадра 1080×1920,
//     вместе с обводкой, тенью и плашкой (у карточки — без затемнения кадра; у акцента — весь блок, без анимации; у
//     субтитров — без пятна под ними, spec.subtitles.shade: это фон, а не текст). Вставки рисует inserts.js.
//
// Шрифты — из fonts.json рядом с этим файлом. Свои шрифты Павла (assets/fonts) дописывает в fonts.json
// тот, кто отдаёт шаблон. Шрифта нет в списке — ошибка: подменять его другим нельзя, иначе превью
// разойдётся с финалом. Эмодзи в хуке, титре и вставках — картинки (emoji.js), а не буквы шрифта.

import { appendText, emojiImages, emojiOnly, glueEmoji, loadEmoji, stripEmoji } from './emoji.js';
import { drawInserts, ease } from './inserts.js';

const FRAME = { w: 1080, h: 1920 };
// безопасная зона: всё, кроме шкалы, — внутри. Для рекламы Reels (state.zone = "ads") снизу 35 % и сверху 14 % заняты
// кнопкой CTA, подписью и шапкой — та же ширина, меньше по высоте. Субтитры Павел может опустить ниже — до `subsY1`,
// над шкалой времени: там их может закрыть подпись Reels, но это его выбор; в зоне рекламы они — как всё остальное
const ORGANIC = { x0: 60, x1: 890, y0: 120, y1: 1530, subsY1: 1820 };
const ADS = { x0: 60, x1: 890, y0: 270, y1: 1250 };
let SAFE = ORGANIC;
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
      const url = new URL(entry.file, FONTS_URL).href;
      const face = new FontFace(family, `url("${url}")`, { weight: '1 1000' });
      try {
        await face.load();
      } catch (err) {
        throw new Error(`шрифт «${id}» не загрузился (${entry.file}): ${err?.message ?? err}`);
      }
      document.fonts.add(face);
      return { family, weight: entry.weight ?? 400 };
    })();
    loading.catch(() => faces.delete(id));
    faces.set(id, loading);
  }
  return faces.get(id);
}

const measure = document.createElement('canvas').getContext('2d');

/** Настоящие границы букв текста относительно базовой линии (а не высота строки шрифта): подъём, спуск,
свесы влево и вправо за ширину набора (у рукописных шрифтов — заметные) и подъём шрифта по метрикам. Эмодзи —
картинки, их рамки считаются отдельно (`emojiRects`). */
function ink(f, size, text) {
  measure.font = `${f.weight} ${size}px "${f.family}"`;
  const m = measure.measureText(stripEmoji(text));
  return {
    ascent: m.actualBoundingBoxAscent,
    descent: m.actualBoundingBoxDescent,
    left: Math.max(0, m.actualBoundingBoxLeft),
    right: Math.max(0, m.actualBoundingBoxRight - m.width),
    fontAscent: m.fontBoundingBoxAscent,
  };
}

/** Рамка слова (span) вместе с настоящими буквами: Й и Ё выше строки, свесы букв за ширину набора. */
function wordRect(span, f, size) {
  const r = span.getBoundingClientRect();
  const m = ink(f, size, span.textContent);
  const base = r.top + m.fontAscent;
  return union([r, { left: r.left - m.left, right: r.right + m.right, top: base - m.ascent, bottom: base + m.descent }]);
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

/** Строка текста в узел: слово из одних эмодзи держится за слово перед ним — оба в одном куске без переноса
(неразрывного пробела мало: Chromium переносит строку между ним и картинкой), строка с эмодзи не начинается. */
function appendWords(node, text) {
  glueEmoji(String(text).split(/ +/).filter(Boolean)).forEach((word, i) => {
    if (i) node.append(' ');
    if (word.includes(' ')) node.append(appendText(el('span', 'nobr'), word));
    else appendText(node, word);
  });
  return node;
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

/** Рамка на доле `p` пути от `a` к `b` (каждый край). */
function lerpRect(a, b, p) {
  const at = (k) => a[k] + (b[k] - a[k]) * p;
  return { left: at('left'), top: at('top'), right: at('right'), bottom: at('bottom') };
}

function shift(r, dy) {
  return { left: r.left, top: r.top + dy, right: r.right, bottom: r.bottom + dy };
}

/** Целый сдвиг по высоте, после которого рамка `r` стоит внутри безопасной зоны — с тем же округлением
наружу, что и у `box`, чтобы отчётная рамка тоже не вышла за зону ни на пиксель. */
function keepInside(r, dy, bottom = SAFE.y1) {
  let d = Math.round(dy);
  if (Math.ceil(r.bottom) + d > bottom) d = bottom - Math.ceil(r.bottom);
  if (Math.floor(r.top) + d < SAFE.y0) d = SAFE.y0 - Math.floor(r.top);
  return d;
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

/** Рамки кусков текста узла по строкам — только буквы, без картинок эмодзи и рамок блочных детей. */
function letterRects(node) {
  const rects = [];
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(t);
    rects.push(...[...range.getClientRects()].filter((r) => r.width > 0));
  }
  return rects;
}

/** Рамки всего, что нарисовано в узле: буквы и картинки эмодзи (для границ). */
function textRects(node) {
  return [...letterRects(node), ...emojiRects(node)];
}

/** Строки текста узла: по буквам; картинка эмодзи — своя строка, только если рядом с ней букв нет (у картинки верх
не там, где у букв, — по нему она считалась бы лишней строкой). */
function textLines(node) {
  const letters = letterRects(node);
  const tops = new Set(letters.map((r) => Math.round(r.top)));
  for (const r of emojiRects(node)) {
    const mid = (r.top + r.bottom) / 2;
    if (!letters.some((q) => q.top <= mid && q.bottom >= mid)) tops.add(Math.round(r.top));
  }
  return tops.size;
}

/** Рамки картинок эмодзи в узле. */
function emojiRects(node) {
  return emojiImages(node).map((img) => img.getBoundingClientRect());
}

function stroke(node, width, color) {
  node.style.setProperty('-webkit-text-stroke', width > 0 ? `${2 * width}px ${color}` : '0');
  node.style.setProperty('paint-order', 'stroke fill');
}

// ---------- субтитры ----------

const MITER = 2; // px — острые углы обводки выходят чуть дальше её толщины

function subExtent(mode, size) {
  if (mode === 'plate') return { x: Math.round(0.4 * size), y: Math.round(0.22 * size), stroke: 0 };
  const w = Math.max(2, Math.round(0.06 * size));
  return { x: w + MITER, y: w + MITER, stroke: w };
}

// Мягкое пятно под субтитрами (spec.subtitles.shade, решение Павла 12.10.2026): размытый тёмный прямоугольник под
// видимыми строками, чтобы их было видно на светлом фоне. shade — насколько темнее фон в середине пятна (0..0,8);
// поля, скругление и размытие — доли кегля. Раскладку не меняет и в рамку для проверок не входит. Слой #shade — под
// вставками: его мягкий край не затемняет логотип или стикер рядом с субтитрами.
const SHADE = { x: 0.55, y: 0.45, radius: 0.8, blur: 0.38 };

function drawShade(shade, rect, px) {
  const amount = Number(shade);
  if (!rect || !(amount > 0)) return;
  const root = document.getElementById('shade');
  const spot = el('div', 'shade');
  place(spot, grow(rect, SHADE.x * px, SHADE.y * px), {
    background: `rgba(0, 0, 0, ${Math.min(amount, 1)})`,
    borderRadius: `${SHADE.radius * px}px`,
    filter: `blur(${SHADE.blur * px}px)`,
  });
  root.append(spot);
  root.hidden = false;
}

function drawSub({ spec, main }, sub) {
  layer('shade');
  const root = layer('sub');
  if (!sub || !Array.isArray(sub.words) || sub.words.length === 0) return null;
  root.hidden = false;
  if (spec.subtitles.mode === 'soft') return drawSoftSub(root, { spec, main }, sub);
  const { mode, size } = spec.subtitles;
  const y = sub.y ?? spec.subtitles.y; // своё место блока (формат разбора: над головой) — иначе высота стиля
  const c = spec.colors;
  const single = mode === 'word';
  const words = single ? [String(sub.words[sub.active] ?? sub.words[0])] : sub.words.map(String);
  const active = single ? 0 : sub.active;
  const visible = mode === 'accumulate' ? sub.visible : words.length;

  const plate = el('div', 'plate');
  plate.hidden = mode !== 'plate';
  const lines = el('div', `lines mode-${mode}`);
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
      const all = union(spans.map((s) => wordRect(s, main, px)));
      const inside = all.left >= SAFE.x0 + ext.x - 0.5 && all.right <= SAFE.x1 - ext.x + 0.5;
      if (lineCount(spans.map((s) => s.getBoundingClientRect())) <= maxLines && inside && all.right - all.left <= width + 0.5) break fit;
      if (scale <= floor) break;
    }
  }

  const words0 = union(spans.map((s) => wordRect(s, main, px)));
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
  const dy = keepInside(outer, Math.round(y - (words0.top + words0.bottom) / 2), SAFE.subsY1 ?? SAFE.y1);
  lines.style.top = `${dy}px`;
  if (mode === 'plate') place(plate, shift(grow(words0, ext.x, ext.y), dy), { background: c.plate, borderRadius: `${Math.round(0.28 * px)}px` });
  if (bar) place(underline, shift(bar, dy), { background: c.accent, borderRadius: `${(bar.bottom - bar.top) / 2}px` });
  const said = spans.filter((_, i) => i < visible).map((s) => wordRect(s, main, px)); // блок уже на месте
  drawShade(spec.subtitles.shade, said.length ? union([...said, bar && shift(bar, dy)]) : null, px);
  return box(shift(outer, dy));
}

// ---------- стиль эталона: субтитры soft, акцентные фразы, хук и титр accent ----------

// Мягкая тень вместо обводки и плашки; её поля — в рамке для проверок.
const SHADOW = '0 2px 12px rgba(0, 0, 0, 0.55), 0 0 3px rgba(0, 0, 0, 0.3)';
const SHADOW_EXT = { x: 14, top: 12, bottom: 16 };
// soft: межстрочный (доли кегля), появление новой строки (с), с какого разлёта букв она съезжается (em)
const SOFT = { line: 0.86, appear: 0.12, track: 0.35 };
const SOFT_NOWRAP = 0.75; // ужатие строки soft без переноса — до этой доли кегля
// акцент: кегль строк — доли hook.size; зазор между строками — доля меньшего кегля; лесенка — сдвиг строк влево и
// вправо (доля кегля); появление (с): из размытия, съезжание букв, буквы вразнобой (за сколько появятся все) и одна
// буква; печать — букв в секунду, курсор держится после печати; пролёт — во сколько раз вырастает блок к концу ухода
const ACC = {
  sizes: { small: 0.72, normal: 1, big: 1.38 },
  gap: 0.14,
  stagger: 0.45,
  blur: { seconds: 0.22, px: 16 },
  track: { seconds: 0.14, em: 0.5 },
  letters: { seconds: 0.3, one: 0.08 },
  type: { cps: 30, cursor: 0.25 },
  zoom: 5,
};
const HOOK_WORDS = 3; // хук в режиме accent — строки до трёх слов
const EDGE_PUNCT = /^[.,!?:;…«»"„“”'()[\]—–-]+|[.,!?:;…«»"„“”'()[\]—–-]+$/gu;
const SENTENCE_END = /[.?!…][»"')\]]*$/u;

/** Слово без знаков препинания по краям (дефис внутри остаётся; слово из одних знаков — пустое). */
function bare(word) {
  return String(word).replace(EDGE_PUNCT, '');
}

/** Первая буква — строчная, если слово написано с заглавной (имя в начале фразы — тоже); аббревиатура (США) — как есть. */
function lowerFirst(word) {
  const [first = '', ...rest] = [...word];
  const tail = rest.join('');
  if (first === first.toLocaleLowerCase() || (/\p{Lu}/u.test(tail) && tail === tail.toLocaleUpperCase())) return word;
  return first.toLocaleLowerCase() + tail;
}

/** Слова блока для экрана: без знаков по краям; начало предложения — со строчной: первое слово блока, если блок его
начинает (`opens` движка; нет поля — начинает), и слово после `.`, `?`, `!`, `…`. Первое слово блока посреди предложения
(имя) — как есть. */
function softWords(words, opens = true) {
  return words.map((w, i) => {
    const text = bare(w);
    return (i === 0 ? opens : SENTENCE_END.test(String(words[i - 1]))) ? lowerFirst(text) : text;
  });
}

/** Сколько слов в каждой строке блока: `lines` от движка или ровные строки не длиннее `per` слов. */
function lineCounts(lines, total, per) {
  if (Array.isArray(lines) && lines.length && lines.every((n) => Number.isInteger(n) && n > 0) && lines.reduce((a, b) => a + b, 0) === total) {
    return lines;
  }
  const n = Math.max(1, Math.ceil(total / Math.max(1, per)));
  return Array.from({ length: n }, (_, k) => Math.floor(((k + 1) * total) / n) - Math.floor((k * total) / n));
}

/** Секунды с появления → доля 0..1 с замедлением; нет времени — появление уже закончилось. */
function progress(age, seconds) {
  return age == null || !Number.isFinite(Number(age)) ? 1 : ease(Number(age) / seconds);
}

function drawSoftSub(root, { spec, main }, sub) {
  const { size } = spec.subtitles;
  const y = sub.y ?? spec.subtitles.y;
  const words = sub.words.map(String);
  const texts = softWords(words, sub.opens !== false);
  const counts = lineCounts(sub.lines, words.length, spec.subtitles.words);
  const visible = Number.isInteger(sub.visible) ? sub.visible : words.length;

  const lines = el('div', 'slines');
  root.append(lines);
  const rows = [];
  let i = 0;
  for (const n of counts) {
    const row = el('div', 'sline');
    const first = i;
    for (let k = 0; k < n; k++, i++) {
      if (k) row.append(' ');
      const span = el('span', 'w', texts[i]);
      span.dataset.i = String(i);
      row.append(span);
    }
    rows.push({ row, shown: first < visible });
    lines.append(row);
  }
  Object.assign(lines.style, {
    fontFamily: `"${main.family}"`, fontWeight: String(main.weight), color: spec.colors.text, lineHeight: String(SOFT.line), textShadow: SHADOW,
  });
  const spans = [...lines.querySelectorAll('.w')];
  const width = WIDTH - 2 * SHADOW_EXT.x;
  // строка блока — без переноса, ужимается до 0,75 кегля; не влезло и так — строки переносятся по словам
  let px = size;
  for (let scale = 1; ; scale *= SHRINK) {
    const wrap = scale < SOFT_NOWRAP;
    px = size * Math.max(scale, MIN_SCALE);
    Object.assign(lines.style, { fontSize: `${px}px`, left: `${CX - width / 2}px`, width: `${width}px`, top: '0px' });
    for (const { row } of rows) row.style.whiteSpace = wrap ? 'normal' : 'nowrap';
    const fits = rows.every(({ row }) => row.scrollWidth <= width + 0.5);
    const all = union(spans.map((s) => wordRect(s, main, px)));
    if ((fits && all.left >= SAFE.x0 + SHADOW_EXT.x - 0.5 && all.right <= SAFE.x1 - SHADOW_EXT.x + 0.5) || scale <= MIN_SCALE) break;
  }
  // место — по всем строкам блока, и тем, что ещё не видны: блок не прыгает, когда появляется вторая строка
  const ink = union(spans.map((s) => wordRect(s, main, px)));
  const outer = grow(ink, SHADOW_EXT.x, SHADOW_EXT.top, SHADOW_EXT.bottom);
  const dy = keepInside(outer, Math.round(y - (ink.top + ink.bottom) / 2), SAFE.subsY1 ?? SAFE.y1);
  lines.style.top = `${dy}px`;
  // видна строка, первое слово которой уже звучит; последняя видимая — съезжается и проявляется
  const newest = rows.findLastIndex((r) => r.shown);
  const p = progress(sub.t, SOFT.appear);
  // пятно — под показанными строками (рамки букв на месте, до анимации); под новой строкой оно дорастает, пока она
  // проявляется
  const inkOf = (k) => union([...rows[k].row.querySelectorAll('.w')].map((s) => wordRect(s, main, px)));
  const shown = rows.map((_, k) => k).filter((k) => rows[k].shown);
  const all = shown.length ? union(shown.map(inkOf)) : null;
  const before = shown.length > 1 ? union(shown.slice(0, -1).map(inkOf)) : null;
  drawShade(spec.subtitles.shade, before && p < 1 ? lerpRect(before, all, p) : all, px);
  rows.forEach(({ row, shown: on }, k) => {
    if (!on) {
      row.style.visibility = 'hidden';
      return;
    }
    if (k !== newest) return;
    row.style.opacity = String(p);
    row.style.letterSpacing = `${(1 - p) * SOFT.track}em`;
  });
  return box(shift(outer, dy));
}

// Подпись перебивки (формат «Разбор персонажа»: имя актёра на его фото) — основным шрифтом, в 1,4 раза крупнее
// субтитров, одной строкой по центру безопасной зоны на высоте субтитров, тень как у soft; не влезает — ужимается,
// а ниже MIN_SCALE переносится по словам.
const CAPTION = 1.4;
function drawCaption({ spec, main }, caption) {
  const root = layer('caption');
  if (!caption?.text) return null;
  root.hidden = false;
  const { size, y } = spec.subtitles;
  const line = el('div', 'lines');
  const words = appendWords(el('span'), caption.text);
  line.append(words);
  root.append(line);
  Object.assign(line.style, {
    fontFamily: `"${main.family}"`, fontWeight: String(main.weight), color: spec.colors.text, lineHeight: String(SOFT.line),
    textShadow: SHADOW,
  });
  const width = WIDTH - 2 * SHADOW_EXT.x;
  let px = size * CAPTION;
  let wrap = false;
  for (let scale = 1; ; scale *= SHRINK) {
    px = size * CAPTION * Math.max(scale, MIN_SCALE);
    wrap = scale <= MIN_SCALE;
    Object.assign(line.style, { fontSize: `${px}px`, left: `${CX - width / 2}px`, width: `${width}px`, top: '0px', whiteSpace: wrap ? 'normal' : 'nowrap' });
    if (line.scrollWidth <= width + 0.5 || wrap) break;
  }
  // одна строка — по настоящим буквам (центр — по ним), перенос — по строкам текста
  const ink = wrap ? union(textRects(line)) : union([wordRect(words, main, px), ...emojiRects(line)]);
  const outer = grow(ink, SHADOW_EXT.x, SHADOW_EXT.top, SHADOW_EXT.bottom);
  const dy = keepInside(outer, Math.round(y - (ink.top + ink.bottom) / 2), SAFE.subsY1 ?? SAFE.y1);
  line.style.top = `${dy}px`;
  return box(shift(outer, dy));
}

/** Псевдослучайное 0..1 по строке и номеру буквы: порядок «вразнобой» одинаков на превью и во всех кадрах. */
function scatter(text, k) {
  let h = 2166136261;
  for (const ch of `${text}#${k}`) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function graphemes(text) {
  return [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);
}

/** Строки лесенкой в узле `root`: `lines` — `[{text, size, color, age}]`, центр блока — `at` ({x, y}); `motion` —
{anim, out, leave, stack} (stack: center — без лесенки); `area` — где блок держится по ширине (по умолчанию безопасная зона; обложка — почти весь кадр).
→ рамка блока для проверок (без анимации). Возраст строки null — её слово ещё не звучит. */
function drawLines(root, { spec, main }, lines, at, motion = {}, area = { x0: SAFE.x0, x1: SAFE.x1 }) {
  const base = spec.hook.size;
  const anim = motion.anim ?? 'blur';
  const perChar = anim === 'type' || anim === 'letters';
  const block = el('div', 'ablock');
  root.append(block);
  const items = lines.map((line) => {
    const node = el('div', 'aline');
    node.dataset.text = line.text;
    const chars = [];
    if (perChar) {
      for (const g of graphemes(line.text)) {
        const ch = appendText(el('span', 'ch'), g);
        chars.push(ch);
        node.append(ch);
      }
    } else {
      node.append(appendText(el('span', 'shown'), line.text));
    }
    const mark = baseline(node);
    Object.assign(node.style, {
      fontFamily: `"${main.family}"`, fontWeight: String(main.weight), lineHeight: '1', textShadow: SHADOW,
      color: line.color === 'accent' ? spec.colors.accent : spec.colors.text,
    });
    block.append(node);
    return { ...line, node, chars, mark, factor: ACC.sizes[line.size] ?? 1 };
  });
  // лесенка — сдвиг строк влево и вправо; у акцента разбора (stack: center) строки по центру друг под другом
  const offsets = items.map((_, k) => (items.length === 1 || motion.stack === 'center' ? 0 : (k % 2 ? 1 : -1) * ((ACC.stagger * base) / 2)));

  // кегль: все строки (со сдвигом лесенки) влезают в безопасную зону
  const room = area.x1 - area.x0 - 2 * SHADOW_EXT.x;
  let scale = 1;
  const size = (it) => base * it.factor * scale;
  for (;;) {
    for (const it of items) it.node.style.fontSize = `${size(it)}px`;
    const fits = items.every((it, k) => it.node.getBoundingClientRect().width + 2 * Math.abs(offsets[k] * scale) <= room + 0.5);
    if (fits || scale <= MIN_SCALE) break;
    scale *= SHRINK;
  }

  // по высоте: базовые линии строк — спуск верхней, зазор, подъём нижней (по настоящим буквам)
  const inks = items.map((it) => ink(main, size(it), it.text));
  const bases = [0];
  for (let k = 1; k < items.length; k++) {
    bases.push(bases[k - 1] + inks[k - 1].descent + ACC.gap * Math.min(size(items[k - 1]), size(items[k])) + inks[k].ascent);
  }
  const rects = items.map((it, k) => {
    it.node.style.left = '0px';
    it.node.style.top = '0px';
    const r = it.node.getBoundingClientRect();
    const markTop = it.mark.getBoundingClientRect().top - r.top; // базовая линия от верха строки
    const cx = offsets[k] * scale;
    it.place = { left: cx - r.width / 2, top: bases[k] - markTop, width: r.width };
    return { left: cx - r.width / 2 - inks[k].left, right: cx + r.width / 2 + inks[k].right, top: bases[k] - inks[k].ascent, bottom: bases[k] + inks[k].descent };
  });
  const inkAll = union(rects);
  let dx = Math.round(at.x - (inkAll.left + inkAll.right) / 2);
  let dy = Math.round(at.y - (inkAll.top + inkAll.bottom) / 2);
  const outer = grow(inkAll, SHADOW_EXT.x, SHADOW_EXT.top, SHADOW_EXT.bottom);
  if (Math.ceil(outer.right) + dx > area.x1) dx = area.x1 - Math.ceil(outer.right);
  if (Math.floor(outer.left) + dx < area.x0) dx = area.x0 - Math.floor(outer.left);
  dy = keepInside(outer, dy);
  for (const it of items) Object.assign(it.node.style, { left: `${it.place.left + dx}px`, top: `${it.place.top + dy}px` });

  // появление строк
  for (const it of items) {
    const age = it.age;
    if (age === null || age === undefined) {
      it.node.style.visibility = 'hidden';
      continue;
    }
    if (anim === 'blur') {
      const p = progress(age, ACC.blur.seconds);
      Object.assign(it.node.style, { opacity: String(p), filter: p < 1 ? `blur(${((1 - p) * ACC.blur.px).toFixed(2)}px)` : 'none' });
    } else if (anim === 'track') {
      const p = progress(age, ACC.track.seconds);
      const before = it.node.getBoundingClientRect().width;
      Object.assign(it.node.style, { opacity: String(p), letterSpacing: `${(1 - p) * ACC.track.em}em` });
      const grown = it.node.getBoundingClientRect().width - before; // разлёт — в обе стороны от центра строки
      it.node.style.left = `${it.place.left + dx - grown / 2}px`;
    } else if (anim === 'letters') {
      const spread = ACC.letters.seconds - ACC.letters.one;
      it.chars.forEach((ch, k) => {
        ch.style.opacity = String(progress(Number(age) - scatter(it.text, k) * spread, ACC.letters.one));
      });
    } else if (anim === 'type') {
      const shown = Math.min(it.chars.length, Math.floor(Number(age) * ACC.type.cps + 1e-9));
      it.chars.forEach((ch, k) => {
        if (k >= shown) ch.style.visibility = 'hidden';
      });
      if (Number(age) < it.chars.length / ACC.type.cps + ACC.type.cursor) {
        const lineBox = it.node.getBoundingClientRect();
        const lastBox = shown ? it.chars[shown - 1].getBoundingClientRect() : null;
        const px = size(it);
        const cursor = el('span', 'cursor');
        Object.assign(cursor.style, {
          left: `${(lastBox ? lastBox.right - lineBox.left : 0) + 0.04 * px}px`,
          top: `${it.mark.getBoundingClientRect().top - lineBox.top - 0.62 * px}px`,
          width: `${Math.max(2, Math.round(0.045 * px))}px`,
          height: `${0.74 * px}px`,
          background: spec.colors.text,
        });
        it.node.append(cursor);
      }
    }
  }

  // уход: растворение или пролёт — блок растёт от своего центра на весь кадр и тает
  const leave = Math.min(1, Math.max(0, Number(motion.leave) || 0));
  if (leave > 0) {
    root.style.opacity = String(1 - leave);
    if (motion.out === 'zoom') {
      const c = shift({ left: inkAll.left + dx, right: inkAll.right + dx, top: inkAll.top, bottom: inkAll.bottom }, dy);
      root.style.transformOrigin = `${(c.left + c.right) / 2}px ${(c.top + c.bottom) / 2}px`;
      root.style.transform = `scale(${1 + ACC.zoom * leave})`;
    }
  }
  return box(shift({ left: outer.left + dx, right: outer.right + dx, top: outer.top, bottom: outer.bottom }, dy));
}

/** Строка акцента из state: текст, размер (small/normal/big) и цвет (accent — цвет подсветки). */
function accentLine(line, age) {
  return { text: String(line?.text ?? ''), size: line?.size, color: line?.color, age };
}

function drawAccent(look, accent) {
  const root = layer('accent');
  Object.assign(root.style, { opacity: '', transform: '', transformOrigin: '' });
  const lines = (accent?.lines ?? []).filter((l) => String(l?.text ?? '').trim());
  if (!accent || lines.length === 0) return null;
  root.hidden = false;
  const ages = Array.isArray(accent.ages) ? accent.ages : [];
  const items = lines.map((l, k) => accentLine(l, k < ages.length ? ages[k] : Infinity));
  const at = { x: Number.isFinite(accent.x) ? accent.x : CX, y: Number.isFinite(accent.y) ? accent.y : FRAME.h / 2 };
  return drawLines(root, look, items, at, { anim: accent.anim, out: accent.out, leave: accent.leave, stack: accent.stack });
}

/** Хук в режиме accent: ударное последнее слово (с эмодзи после него) — своей строкой, крупно и цветом подсветки, как
рукописное слово в других режимах; слова до него — ровные строки до трёх слов, длинная строка сверху. */
function accentHook(hook) {
  const title = hookTitle(hook);
  if (!title) return null;
  const words = title.lines.join(' ').split(/\s+/).filter(Boolean);
  const counts = lineCounts(null, words.length, HOOK_WORDS).reverse();
  const lines = [];
  let i = 0;
  for (const n of words.length ? counts : []) {
    lines.push({ text: words.slice(i, i + n).join(' ') });
    i += n;
  }
  lines.push({ text: title.word, size: 'big', color: 'accent' });
  return lines;
}

/** Титр в режиме accent: строки призыва — обычные, кодовое слово — крупное, цвета подсветки. */
function accentCta(cta) {
  if (!cta) return null;
  const lines = (cta.lines ?? []).map(String).filter((l) => l.trim()).map((text) => ({ text }));
  const word = String(cta.word ?? '').trim();
  if (word) lines.push({ text: word, size: 'big', color: 'accent' });
  return lines.length ? lines : null;
}

function drawAccentTitle(id, look, lines, t, area) {
  const root = layer(id);
  if (!lines) return null;
  root.hidden = false;
  const age = t == null ? Infinity : t;
  const at = { x: area ? (area.x0 + area.x1) / 2 : CX, y: look.spec.hook.y ?? HOOK_Y };
  return drawLines(root, look, lines.map((l) => ({ ...l, age })), at, { anim: 'blur' }, area);
}

// ---------- хук и титр с кодовым словом ----------

/** Хук: все слова, кроме последнего, — строка капсом; последнее — рукописное. Эмодзи в конце идут вместе с ним:
рукописным становится последнее слово с буквами и всё, что после него. */
function hookTitle(hook) {
  if (!hook || typeof hook.text !== 'string') return null;
  const words = hook.text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  let last = words.length - 1;
  while (last > 0 && emojiOnly(words[last])) last -= 1;
  const word = words.splice(last).join(' ');
  return { lines: words.length ? [words.join(' ')] : [], word, wrap: 2 };
}

function ctaTitle(cta) {
  if (!cta) return null;
  const lines = (cta.lines ?? []).map(String).filter((l) => l.trim());
  const word = String(cta.word ?? '').trim();
  if (lines.length === 0 && !word) return null;
  return { lines, word, wrap: 1 };
}

/** Поля вокруг букв: плашка — её поля (у рукописного слова — его мягкая тень), обводка — её толщина с запасом
на острые углы, тень — её размытие. */
function titleLook(mode, size) {
  if (mode === 'plate') return { pad: { x: Math.round(0.42 * size), y: Math.round(0.26 * size) }, hand: 13 };
  if (mode === 'outline') return { pad: { x: 3 + MITER, y: 3 + MITER }, hand: 3 + MITER, outline: 3 };
  return { pad: { x: 20, y: 20 }, hand: 20 };
}

/** Хук или титр; `area` — по чему центровать строки: безопасная зона (по умолчанию) или весь кадр (обложка). */
function drawTitle(id, { spec, main, hand }, title, area = { cx: CX, width: WIDTH }) {
  const root = layer(id);
  if (!title) return null;
  root.hidden = false;
  const { mode, size } = spec.hook;
  const y = spec.hook.y ?? HOOK_Y;
  const c = spec.colors;

  const plate = el('div', 'plate');
  plate.hidden = mode !== 'plate' || title.lines.length === 0;
  const caps = el('div', 'caps');
  for (const text of title.lines) caps.append(appendWords(el('div', 'line'), upper(glue(text))));
  const handBox = el('div', 'hand');
  handBox.hidden = !title.word;
  const handText = appendText(el('span'), title.word);
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
    const capsWidth = area.width - 2 * look.pad.x;
    const handWidth = area.width - 2 * look.hand;
    Object.assign(caps.style, { fontSize: `${s}px`, left: `${area.cx - capsWidth / 2}px`, width: `${capsWidth}px`, top: '0px' });
    Object.assign(handBox.style, { fontSize: `${s * HAND}px`, left: `${area.cx - handWidth / 2}px`, width: `${handWidth}px`, top: '0px' });
    stroke(caps, look.outline ?? 0, c.outline);
    stroke(handBox, look.outline ?? 0, c.outline);
    return { capsWidth, handWidth };
  };
  for (let scale = 1; ; scale *= SHRINK) {
    const { capsWidth, handWidth } = setSize(size * Math.max(scale, MIN_SCALE));
    const capsOver = first ? ink(main, px, upper(title.lines.join(' '))) : null;
    const capsFit = [...caps.children].every((line) => {
      const r = union(textRects(line));
      return line.scrollWidth <= capsWidth + 0.5 && textLines(line) <= title.wrap && (!r || r.right - r.left + capsOver.left + capsOver.right <= capsWidth + 0.5);
    });
    const handOver = title.word ? ink(hand, px * HAND, title.word) : null;
    const handFit = !title.word || handText.getBoundingClientRect().width + handOver.left + handOver.right <= handWidth + 0.5;
    if ((capsFit && handFit) || scale <= MIN_SCALE) break;
  }

  // Границы по настоящим буквам: строка капсом — от верха первой строки до низа последней,
  // рукописное слово «свисает» сразу под ней.
  const handPx = px * HAND;
  let capsInk = null;
  if (first) {
    const m = ink(main, px, upper(title.lines.join(' ')));
    const sides = union(textRects(caps));
    capsInk = union([{
      left: sides.left - m.left,
      right: sides.right + m.right,
      top: capsTop.getBoundingClientRect().top - m.ascent,
      bottom: capsBottom.getBoundingClientRect().top + m.descent,
    }, ...emojiRects(caps)]);
  }
  let handInk = null;
  if (title.word) {
    const m = ink(hand, handPx, title.word);
    const r = handText.getBoundingClientRect();
    const base = handMark.getBoundingClientRect().top;
    handInk = union([{ left: r.left - m.left, right: r.right + m.right, top: base - m.ascent, bottom: base + m.descent }, ...emojiRects(handText)]);
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

// ---------- обложка ----------

// Обложка для сетки профиля: хук крупно (кегль 132, как у хука — капс и рукописное последнее слово) в середине того, что
// видно в сетке, — кадр 3:4 по центру (y 240–1680); строки — по центру всего кадра, справа кнопок на обложке нет.
const COVER = { y: 960, size: 132, cx: FRAME.w / 2, width: FRAME.w - 120 };

function drawCover({ spec, main, hand }, cover) {
  if (!cover?.text) return null;
  const look = { spec: { ...spec, hook: { ...spec.hook, y: COVER.y, size: COVER.size } }, main, hand };
  if (spec.hook.mode === 'accent') { // стиль эталона: обложка — тот же хук лесенкой
    return drawAccentTitle('hook', look, accentHook(cover), null, { x0: COVER.cx - COVER.width / 2, x1: COVER.cx + COVER.width / 2 });
  }
  return drawTitle('hook', look, hookTitle(cover), { cx: COVER.cx, width: COVER.width });
}

// ---------- финальная карточка ----------

// Затемнённый стоп-кадр, по центру безопасной зоны — логотип (не больше 300×300), призыв на плашке цвета подсветки
// (кегль 72, строки переносятся по словам до ширины 700, ужимается, только если не влезает слово; дышит: ±3,5 %
// 1,3 раза в секунду) и ник. Появляется за 0,2 с.
const END = { y: 800, logo: 300, gap: 44, size: 72, wrap: 700, handle: 54, dim: 0.55, fade: 0.2, pulse: 0.035, hz: 1.3 };
const logos = new Map();

/** Логотип карточки, загруженный (src — как у вставок: путь от корня, который отдаёт сервер шаблона). */
function logoImage(src) {
  if (!logos.has(src)) {
    const img = new Image();
    img.src = src;
    const ready = img.decode().then(() => img, () => {
      throw new Error(`логотип карточки не загрузился: ${src}`);
    });
    ready.catch(() => logos.delete(src));
    logos.set(src, ready);
  }
  return logos.get(src);
}

function drawEnd({ spec, main }, end, logo) {
  const root = layer('end');
  const lines = (end?.lines ?? []).map(String).filter((l) => l.trim());
  if (!end || lines.length === 0) return null;
  root.hidden = false;
  const c = spec.colors;
  const t = Math.max(0, Number(end.t) || 0);
  root.style.opacity = String(ease(Math.min(1, (t + 1 / 30) / END.fade)));
  const dim = el('div', 'dim');
  place(dim, { left: 0, top: 0, right: FRAME.w, bottom: FRAME.h }, { background: `rgba(0, 0, 0, ${END.dim})` });
  root.append(dim);

  const parts = []; // [узел, ширина, высота] сверху вниз
  if (logo) {
    const k = Math.min(1, END.logo / logo.naturalWidth, END.logo / logo.naturalHeight);
    const img = el('img', 'logo');
    img.src = logo.src;
    img.alt = '';
    const w = Math.round(logo.naturalWidth * k);
    const h = Math.round(logo.naturalHeight * k);
    Object.assign(img.style, { position: 'absolute', width: `${w}px`, height: `${h}px`, borderRadius: '18px' });
    root.append(img);
    parts.push([img, w, h]);
  }
  const call = el('div', 'call');
  for (const line of lines) call.append(appendWords(el('div', 'line'), line));
  Object.assign(call.style, {
    position: 'absolute', left: '0px', top: '0px', maxWidth: `${END.wrap}px`, boxSizing: 'border-box', textAlign: 'center',
    lineHeight: '1.12', wordBreak: 'keep-all', overflowWrap: 'normal',
    fontFamily: `"${main.family}"`, fontWeight: String(main.weight), color: c.plate, background: c.accent,
  });
  root.append(call);
  let size = END.size;
  for (;;) {
    Object.assign(call.style, { fontSize: `${size}px`, padding: `${0.28 * size}px ${0.5 * size}px`, borderRadius: `${0.34 * size}px` });
    if ([...call.children].every((line) => line.scrollWidth <= line.clientWidth + 0.5) || size <= END.size * MIN_SCALE) break;
    size *= SHRINK;
  }
  const plate = call.getBoundingClientRect();
  parts.push([call, plate.width, plate.height]);
  let handle = null;
  let handleSize = END.handle;
  if (end.handle) {
    handle = el('div', 'handle', String(end.handle));
    Object.assign(handle.style, {
      position: 'absolute', whiteSpace: 'nowrap', fontFamily: `"${main.family}"`, fontWeight: String(main.weight),
      fontSize: `${END.handle}px`, lineHeight: '1', color: c.text, textShadow: '0 3px 12px rgba(0, 0, 0, 0.6)',
    });
    root.append(handle);
    const room = WIDTH - 2 * 14; // тень ника — по 12 px с боков
    const wide = handle.getBoundingClientRect().width;
    if (wide > room) { // длинный ник в широком шрифте — мельче, но в безопасной зоне
      handleSize = Math.floor((END.handle * room) / wide);
      handle.style.fontSize = `${handleSize}px`;
    }
    const r = handle.getBoundingClientRect();
    parts.push([handle, r.width, r.height]);
  }

  const height = parts.reduce((sum, [, , h]) => sum + h, 0) + END.gap * (parts.length - 1);
  let top = Math.round(Math.min(Math.max(END.y - height / 2, SAFE.y0 + 40), SAFE.y1 - 40 - height));
  const rects = [];
  for (const [node, w, h] of parts) {
    const left = Math.round(CX - w / 2);
    Object.assign(node.style, { left: `${left}px`, top: `${top}px` });
    rects.push({ left, top, right: left + w, bottom: top + h });
    top += h + END.gap;
  }
  const scale = 1 + END.pulse * Math.sin(2 * Math.PI * END.hz * t);
  call.style.transform = `scale(${scale})`;
  call.style.transformOrigin = '50% 50%';
  const plateAt = rects[logo ? 1 : 0];
  const breathe = { x: (END.pulse * (plateAt.right - plateAt.left)) / 2 + 2, y: (END.pulse * (plateAt.bottom - plateAt.top)) / 2 + 2 };
  const all = [grow(plateAt, breathe.x, breathe.y)];
  if (logo) all.push(rects[0]);
  if (handle) {
    const r = rects.at(-1);
    const m = ink(main, handleSize, String(end.handle));
    all.push(grow({ left: r.left - m.left, top: r.top, right: r.right + m.right, bottom: r.bottom }, 12, 9, 15)); // тень ника
  }
  return box(union(all));
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

// Вызовы идут по очереди: страница может звать renderState на каждое изменение, не дожидаясь прошлого, —
// на экране всегда остаётся последний вызов, а не тот, что дольше грузил картинку.
let queue = Promise.resolve();

window.renderState = function renderState(spec, state = {}, opts = {}) {
  const run = queue.then(() => draw(spec, state, opts));
  queue = run.catch(() => {});
  return run;
};

/** Тексты состояния, где могут быть эмодзи: хук, титр, акцент, тексты вставок. */
function texts(s) {
  const cta = s.cta ?? {};
  return [
    s.hook?.text, s.cover?.text, s.caption?.text, ...(cta.lines ?? []), cta.word, ...(s.accent?.lines ?? []).map((l) => l?.text),
    ...(s.inserts ?? []).flatMap((i) => [i.text, i.title]), ...(s.end?.lines ?? []),
  ];
}

async function draw(spec, state, opts) {
  const [main, hand] = await Promise.all([font(spec.font), font(spec.hand), loadEmoji(texts(state ?? {}))]);
  await document.fonts.ready;
  const s = state ?? {};
  SAFE = s.zone === 'ads' ? ADS : ORGANIC;
  const look = { spec, main, hand, zone: s.zone === 'ads' ? ADS : null };
  document.getElementById('frame').style.background = opts?.background ?? 'transparent';
  const boxes = { inserts: await drawInserts(document.getElementById('inserts'), s.inserts ?? [], look) };
  const sub = drawSub(look, s.sub);
  if (sub) boxes.sub = sub;
  const accentMode = spec.hook.mode === 'accent';
  let hook = null;
  if (!s.cover) hook = accentMode ? drawAccentTitle('hook', look, accentHook(s.hook), s.hook?.t) : drawTitle('hook', look, hookTitle(s.hook));
  if (hook) boxes.hook = hook;
  const cover = s.cover ? drawCover(look, s.cover) : null;
  if (cover) boxes.cover = cover;
  const cta = accentMode ? drawAccentTitle('cta', look, accentCta(s.cta)) : drawTitle('cta', look, ctaTitle(s.cta));
  if (cta) boxes.cta = cta;
  const accent = drawAccent(look, s.accent);
  if (accent) boxes.accent = accent;
  const caption = drawCaption(look, s.caption);
  if (caption) boxes.caption = caption;
  const card = drawEnd(look, s.end, s.end?.logo ? await logoImage(s.end.logo) : null);
  if (card) boxes.end = card;
  drawBar(spec, opts?.bar);
  // картинки эмодзи на кадре готовы до ответа: кадр финала снимают сразу. Обычно <img> берёт уже загруженную loadEmoji
  // картинку мгновенно, но не всегда (в CI раз попался пустой) — тогда ждём её здесь
  await Promise.all(emojiImages(document.getElementById('frame')).filter((img) => !img.complete || !img.naturalWidth)
    .map((img) => img.decode().catch(() => undefined)));
  lastBoxes = boxes;
}

window.layoutBoxes = function layoutBoxes() {
  return structuredClone(lastBoxes);
};
