// Эмодзи картинками. Шрифты ролика эмодзи не рисуют, а цветные шрифты эмодзи Safari понимает не все (COLRv1 и CBDT
// у Noto — нет), поэтому вместо эмодзи ставится PNG из emoji/ (глифы шрифта Noto Color Emoji, SIL OFL 1.1) — одни и те
// же пиксели на превью и в финале. Собирает картинки `python3 -m vm.emoji` (engine/vm/emoji.py).
//
// Текст делится на куски «текст / эмодзи» тем же правилом, что в движке (общая фикстура
// engine/tests/fixtures/emoji-runs.json): в каждом месте — самая длинная последовательность из списка, U+FE0F внутри
// и сразу после неё не важен; знак, который по умолчанию текст (©, ®, ™, ❤, цифры, #, *), — эмодзи только с U+FE0F.
//
// Картинка стоит как глиф шрифта эмодзи в Chromium: 136×128 при кегле 109 — ширина 1,248 кегля, высота 1,174, низ на
// 0,248 кегля ниже базовой линии.
//
//   await loadEmoji(texts)        — список и картинки эмодзи этих текстов (нет эмодзи — ничего не грузит)
//   emojiRuns(text, table?)       — [['text', s] | ['emoji', имя, исходный текст]]
//   appendText(node, text)        — текст в узел: куски-текст — текстом, эмодзи — <img class="emo">
//   measureText / fillText(ctx…)  — то же на холсте

const VS16 = 0xfe0f;
export const EMOJI = { w: 136 / 109, h: 128 / 109, below: 27 / 109 }; // в долях кегля

const FOLDER = new URL('emoji/', import.meta.url);
let table = null; // загруженный список
let loading = null;
const pictures = new Map(); // имя → Promise<HTMLImageElement>
const loaded = new Map(); // имя → HTMLImageElement, уже готовая к рисованию

/**
 * Может ли в тексте быть эмодзи (без списка): знак, который по умолчанию картинка, или FE0F, ZWJ, кейкап — в любой
 * последовательности эмодзи есть что-то из этого. «№», «€», «→» и прочие знаки-текст список не грузят.
 */
export function mayHaveEmoji(text) {
  return /\p{Emoji_Presentation}|[\u200D\uFE0F\u20E3]/u.test(String(text ?? ''));
}

/** Список (index.json) → дерево последовательностей: код → узел, у конца — имя картинки под ключом `name`. */
export function emojiTable(index) {
  const trie = new Map();
  for (const name of index.emoji) {
    let node = trie;
    for (const part of name.split('-')) {
      const cp = parseInt(part, 16);
      if (!node.has(cp)) node.set(cp, new Map());
      node = node.get(cp);
    }
    node.name = name;
  }
  return { trie, plain: new Set(index.text.map((h) => parseInt(h, 16))) };
}

/** Текст → куски `['text', s]` и `['emoji', имя, исходный текст]`; без списка — весь текст одним куском. */
export function emojiRuns(text, t = table) {
  const s = String(text ?? '');
  if (!s) return [];
  if (!t) return [['text', s]];
  const cps = [...s].map((c) => c.codePointAt(0));
  const out = [];
  let buf = '';
  for (let i = 0; i < cps.length; ) {
    let node = t.trie;
    let j = i;
    let depth = 0;
    let best = null; // [конец, имя, кодов в последовательности]
    while (j < cps.length) {
      if (cps[j] === VS16 && j > i) {
        j += 1;
        if (node.name) best = [j, node.name, depth];
        continue;
      }
      node = node.get(cps[j]);
      if (!node) break;
      j += 1;
      depth += 1;
      if (node.name) best = [j, node.name, depth];
    }
    if (best && best[2] === 1 && t.plain.has(cps[i]) && cps[i + 1] !== VS16) best = null; // знак-текст без FE0F — буква
    if (!best) {
      buf += String.fromCodePoint(cps[i]);
      i += 1;
      continue;
    }
    if (buf) out.push(['text', buf]);
    buf = '';
    out.push(['emoji', best[1], String.fromCodePoint(...cps.slice(i, best[0]))]);
    i = best[0];
  }
  if (buf) out.push(['text', buf]);
  return out;
}

/** Текст без эмодзи. */
export function stripEmoji(text) {
  return emojiRuns(text).filter(([kind]) => kind === 'text').map(([, s]) => s).join('');
}

/** В тексте есть эмодзи и нет ничего, кроме эмодзи и пробелов. */
export function emojiOnly(text) {
  const runs = emojiRuns(text);
  return runs.some(([kind]) => kind === 'emoji') && runs.every(([kind, s]) => kind === 'emoji' || !s.trim());
}

function picture(name) {
  if (!pictures.has(name)) {
    const img = new Image();
    img.src = new URL(`${name}.png`, FOLDER).href;
    const ready = img.decode().then(
      () => {
        loaded.set(name, img);
        return img;
      },
      () => {
        throw new Error(`картинка эмодзи не загрузилась: emoji/${name}.png`);
      },
    );
    ready.catch(() => pictures.delete(name));
    pictures.set(name, ready);
  }
  return pictures.get(name);
}

/** Список и картинки эмодзи этих текстов; после этого `emojiRuns`, `appendText` и холст работают сразу. */
export async function loadEmoji(texts) {
  const all = (texts ?? []).map((x) => String(x ?? ''));
  if (!all.some(mayHaveEmoji)) return;
  if (!table) {
    loading ??= fetch(new URL('index.json', FOLDER)).then((r) => {
      if (!r.ok) throw new Error(`emoji/index.json: HTTP ${r.status}`);
      return r.json();
    });
    loading.catch(() => {
      loading = null;
    });
    table = emojiTable(await loading);
  }
  const names = new Set(all.flatMap((x) => emojiRuns(x).filter(([k]) => k === 'emoji').map(([, name]) => name)));
  await Promise.all([...names].map(picture));
}

/** Текст в узел: куски-текст — текстовыми узлами, эмодзи — картинками (уже загруженными `loadEmoji`). */
export function appendText(node, text) {
  for (const [kind, value, raw] of emojiRuns(text)) {
    if (kind === 'text') {
      node.append(value);
      continue;
    }
    const img = document.createElement('img');
    img.className = 'emo';
    img.src = new URL(`${value}.png`, FOLDER).href;
    img.alt = raw;
    img.draggable = false;
    node.append(img);
  }
  return node;
}

/** Картинки эмодзи внутри узла. */
export function emojiImages(node) {
  return [...node.querySelectorAll('img.emo')];
}

/** Ширина текста на холсте с эмодзи-картинками (шрифт и кегль `size` уже стоят в `ctx.font`). */
export function measureText(ctx, text, size) {
  return emojiRuns(text).reduce((w, [kind, value]) => w + (kind === 'text' ? ctx.measureText(value).width : EMOJI.w * size), 0);
}

/**
 * Текст на холсте с эмодзи-картинками: как `ctx.fillText(text, x, y)` при текущих `textAlign` и `textBaseline`;
 * эмодзи стоят на алфавитной базовой линии строки, как в DOM. Картинки должны быть загружены (`loadEmoji`).
 */
export function fillText(ctx, text, x, y, size) {
  draw(ctx, text, x, y, size, true);
}

/** Обводка текста на холсте, как `ctx.strokeText`; эмодзи не обводятся, но место занимают то же, что в `fillText`. */
export function strokeText(ctx, text, x, y, size) {
  draw(ctx, text, x, y, size, false);
}

function draw(ctx, text, x, y, size, fill) {
  const runs = emojiRuns(text);
  if (!runs.some(([kind]) => kind === 'emoji')) {
    if (fill) ctx.fillText(String(text ?? ''), x, y);
    else ctx.strokeText(String(text ?? ''), x, y);
    return;
  }
  const width = measureText(ctx, text, size);
  const align = ctx.textAlign;
  let left = align === 'center' ? x - width / 2 : align === 'right' || align === 'end' ? x - width : x;
  // алфавитная базовая линия: от линии textBaseline до верха шрифта и от неё же при alphabetic
  const atLine = ctx.measureText('Hg').fontBoundingBoxAscent;
  const keep = ctx.textBaseline;
  ctx.textBaseline = 'alphabetic';
  const base = y - atLine + ctx.measureText('Hg').fontBoundingBoxAscent;
  ctx.textAlign = 'left';
  try {
    for (const [kind, value] of runs) {
      if (kind === 'text') {
        if (fill) ctx.fillText(value, left, base);
        else ctx.strokeText(value, left, base);
        left += ctx.measureText(value).width;
        continue;
      }
      if (fill) {
        const img = loaded.get(value);
        if (!img) throw new Error(`эмодзи ${value} не загружено: сначала loadEmoji`);
        ctx.drawImage(img, left, base + EMOJI.below * size - EMOJI.h * size, EMOJI.w * size, EMOJI.h * size);
      }
      left += EMOJI.w * size;
    }
  } finally {
    ctx.textBaseline = keep;
    ctx.textAlign = align;
  }
}
