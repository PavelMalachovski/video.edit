// Правки Павла руками в редакторе — timeline.json (схема engine/vm/schemas/timeline.json). Движок кладёт их поверх
// edit.json сессии при каждом монтаже (engine/vm/edits.py); правило кусков то же — applyKeep, общая фикстура
// engine/tests/fixtures/edits.json; текст и вставки — applyText (apply_text движка), общая фикстура
// overlay-events.json (text). Времена — секунды исходника, кроме music.at (секунда ролика).

/** Правка кусков (секунды исходника): вырезать; вернуть (к куску перед ним в исходнике, `next` — к куску после него);
 *  переставить оставленное в [t0, t1] перед моментом `before` (null — в конец); разрез — только граница на экране. */
export type Edit =
  | { op: 'cut'; t0: number; t1: number }
  | { op: 'restore'; t0: number; t1: number; next?: boolean }
  | { op: 'move'; t0: number; t1: number; before: number | null }
  | { op: 'split'; t: number };
export type Level = { gainDb?: number; muted?: boolean };
export type MusicAdjust = Level & { at?: number; from?: number; fadeIn?: number; fadeOut?: number };
/** Место блока в речи — `[t0, t1]`, как его записала сессия: правка держится за блок по нему, а не по номеру. */
export type At = [number, number];
/** Хук: конец (по исходнику) и текст; off — хука нет. */
export type HookFix = { until?: number; text?: string; off?: true };
export type CtaFix = { at: At; t0?: number; t1?: number; lines?: string[]; word?: string; off?: true };
export type AccentFix = { at: At; t0?: number; t1?: number; lines?: string[]; off?: true };
export type InsertFix = { at: At; t0?: number; t1?: number; text?: string; off?: true };
/** Текст и вставки (фаза 5): хук, титр, акценты, вставки. */
export type TextEdits = { hook?: HookFix; cta?: CtaFix; accents?: AccentFix[]; inserts?: InsertFix[] };
/** Слово субтитров с ровно этими t0, t1 получает текст Павла; пустой — слова нет в субтитрах. */
export type WordFix = { t0: number; t1: number; text: string };
/** Что правит Павел: куски, голос, музыка, звуки, текст и вставки, слова субтитров. */
export type HandEdits = {
  edits: Edit[]; voice?: Level; music?: MusicAdjust; sounds?: Record<string, Level>; text?: TextEdits; words?: WordFix[];
};
/** timeline.json в ветке задачи: правки и ревизия (страница прибавляет 1 на каждое сохранение). */
export type TimelineFile = HandEdits & { rev: number; at?: string };

export const SLIVER = 0.04; // с — кусок короче (около кадра) после вырезки не остаётся (SLIVER движка)
/** Пределы — как в схеме timeline.json. */
export const LIMITS = {
  gain: { min: -40, max: 12 }, // дБ к громкости, что дал монтаж (голос, звук)
  musicGain: { min: -40, max: 0 }, // дБ от громкости голоса (как music.gainDb в edit.json)
  fade: { min: 0, max: 10 }, // с — нарастание и затухание музыки
  edits: 2000,
  line: 120, // знаков в строке хука, титра, акцента, текстовой вставки
  lines: 3, // строк у титра и акцента
  blocks: 200, // правок акцентов и вставок
  word: 60, // знаков в слове субтитров
  words: 5000, // исправленных слов
} as const;
export const EMPTY: HandEdits = { edits: [] };
const SOUND_KEY = /^(insert:\d+|transition:\d+|teaser|end)$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, x));

// ---------- куски ----------

type Span = [number, number];
const EPS = 1e-9;

/** Соседние в финале куски, что в исходнике идут вплотную, — один кусок. */
function join(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of spans) {
    const last = out.at(-1);
    if (last && Math.abs(a - last[1]) <= EPS) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

function cut(spans: Span[], a: number, b: number): Span[] {
  const out: Span[] = [];
  for (const [s, e] of spans) {
    if (e <= a || s >= b) {
      out.push([s, e]);
      continue;
    }
    if (s < a) out.push([s, a]);
    if (e > b) out.push([b, e]);
  }
  return out;
}

/** Вернуть [a, b]: каждая непокрытая часть — к куску, что кончается там, где она начинается (`toNext` — сначала к
 *  куску, что начинается там, где она кончается); соседей нет — сразу за куском перед ней в исходнике (нет — перед
 *  тем, что после неё). Как _restore движка. */
function restore(spans: Span[], a: number, b: number, toNext: boolean): Span[] {
  const out: Span[] = spans.map(([s, e]) => [s, e]);
  const gaps: Span[] = [];
  let at = a;
  for (const [s, e] of [...out].sort((x, y) => x[0] - y[0])) {
    if (e <= at || s >= b) continue;
    if (s > at) gaps.push([at, s]);
    at = Math.max(at, e);
  }
  if (at < b) gaps.push([at, b]);
  for (const [ga, gb] of gaps) {
    const left = out.findIndex(([, e]) => Math.abs(e - ga) <= EPS);
    const right = out.findIndex(([s]) => Math.abs(s - gb) <= EPS);
    if ((toNext && right >= 0) || (left < 0 && right >= 0)) out[right] = [ga, out[right][1]];
    else if (left >= 0) out[left] = [out[left][0], gb];
    else {
      const before = out.map((s, i) => [s, i] as const).filter(([[, e]]) => e <= ga);
      const after = out.map((s, i) => [s, i] as const).filter(([[s]]) => s >= gb);
      const k = before.length ? before.reduce((m, x) => (x[0][1] > m[0][1] ? x : m))[1] + 1
        : after.length ? after.reduce((m, x) => (x[0][0] < m[0][0] ? x : m))[1] : out.length;
      out.splice(k, 0, [ga, gb]);
    }
  }
  return out;
}

/** Оставленное в [a, b] (по порядку финала) — перед моментом `before`: внутри куска — кусок делится, в вырезанном —
 *  перед куском, что за ним в исходнике; null или дальше всего — в конец. Ничего не оставлено — как было (_move). */
function move(spans: Span[], a: number, b: number, before: number | null): Span[] {
  const rest: Span[] = [];
  const parts: Span[] = [];
  for (const [s, e] of spans) {
    if (e <= a || s >= b) {
      rest.push([s, e]);
      continue;
    }
    if (s < a) rest.push([s, a]);
    parts.push([Math.max(s, a), Math.min(e, b)]);
    if (e > b) rest.push([b, e]);
  }
  if (!parts.length) return spans;
  if (before === null) return [...rest, ...parts];
  const i = rest.findIndex(([s, e]) => s <= before && before < e);
  if (i >= 0) {
    const [s, e] = rest[i];
    return [...rest.slice(0, i), ...(before > s ? [[s, before] as Span] : []), ...parts, [before, e], ...rest.slice(i + 1)];
  }
  const later = rest.map(([s], k) => [s, k] as const).filter(([s]) => s >= before);
  if (!later.length) return [...rest, ...parts];
  const k = later.reduce((m, x) => (x[0] < m[0] ? x : m))[1];
  return [...rest.slice(0, k), ...parts, ...rest.slice(k)];
}

/** `keep` сессии и правки по порядку → новый `keep` в порядке финала (как apply_keep движка). Кривая правка — Error с
 *  её номером. */
export function applyKeep(keep: readonly (readonly number[])[], edits: readonly Edit[], duration?: number): Span[] {
  let spans: Span[] = keep.map(([a, b]) => [a, b]);
  edits.forEach((e, i) => {
    if (e.op === 'split') return;
    if (e.op !== 'cut' && e.op !== 'restore' && e.op !== 'move') {
      throw new Error(`timeline.json: edits[${i}] — op ${JSON.stringify((e as { op?: unknown }).op)}: cut, restore, move или split`);
    }
    let { t0: a, t1: b } = e;
    if (!(b > a)) throw new Error(`timeline.json: edits[${i}] — конец ${b} не позже начала ${a}`);
    if (e.op === 'cut') spans = cut(spans, a, b);
    else if (e.op === 'move') {
      if (!('before' in e)) throw new Error(`timeline.json: edits[${i}] — move без before (куда: момент исходника или null — в конец)`);
      spans = move(spans, a, b, e.before);
    } else {
      a = Math.max(0, a);
      if (duration !== undefined) b = Math.min(duration, b);
      if (b > a) spans = restore(spans, a, b, Boolean(e.next));
    }
  });
  return join(spans).filter(([a, b]) => b - a >= SLIVER).map(([a, b]) => [round3(a), round3(b)]);
}

/** Куски для редактора: `keep` (уже с правками) с разрезами Павла внутри кусков (разрез в вырезанном — не виден). */
export function pieces(keep: readonly Span[], edits: readonly Edit[]): Span[] {
  const splits = edits.flatMap((e) => (e.op === 'split' ? [e.t] : [])).sort((x, y) => x - y);
  return keep.flatMap(([a, b]) => {
    const inside = splits.filter((t) => t > a + SLIVER && t < b - SLIVER);
    const edges = [a, ...inside, b];
    return edges.slice(1).map((t, k): Span => [edges[k], t]);
  });
}

// ---------- текст и вставки (фаза 5) ----------

type Span2 = { t0: number; t1: number };
const spanOf = (x: Span2): At => [Number(x.t0), Number(x.t1)];
const sameAt = (a: At, b: readonly number[]) => a[0] === Number(b[0]) && a[1] === Number(b[1]);

/** Блок после правки: конец позже начала, иначе — Error с именем правки (как ValueError движка). */
function timed<T extends Span2>(name: string, item: T): T {
  if (!(Number(item.t1) > Number(item.t0))) throw new Error(`timeline.json: ${name} — конец ${item.t1} не позже начала ${item.t0}`);
  return item;
}

/** Правки блоков списка по месту в речи: каждой — первый ещё не занятый блок с [t0, t1] == at; нет — не применяется. */
function anchored<T extends Span2, F extends { at: At }>(items: readonly T[], changes: readonly F[], name: string,
  change: (item: T, c: F, name: string) => T | null): (T | null)[] {
  const out: (T | null)[] = [...items];
  const used = new Set<number>();
  changes.forEach((c, i) => {
    const k = out.findIndex((item, j) => !used.has(j) && item !== null && sameAt(spanOf(item), c.at));
    if (k < 0) return;
    used.add(k);
    out[k] = change(out[k] as T, c, `${name}[${i}]`);
  });
  return out;
}

const pick = <T extends object, K extends string>(from: T, keys: readonly K[]) =>
  Object.fromEntries(keys.filter((k) => k in from).map((k) => [k, (from as Record<string, unknown>)[k]]));

type TextBase = {
  hook?: { text: string; until: number } | null;
  cta?: (Span2 & { lines: string[]; word: string }) | null;
  accents?: (Span2 & { lines: { text: string }[] })[] | null;
  inserts?: (Partial<Span2> & { kind: string; text?: string; off?: boolean })[] | null;
  words?: (Span2 & { text: string })[] | null;
};

/** Текст и вставки Павла поверх edit — как apply_text движка: хук — конец и текст; титр, акценты, вставки — по месту в
 *  речи (`at`); вставка с off остаётся в списке (номера звуков те же); слова — по точному t0, t1, пустое — нет в
 *  субтитрах. Правок нет — тот же edit. */
export function applyText<T extends TextBase>(edit: T, text?: TextEdits, words?: readonly WordFix[]): T {
  if (!text && !words?.length) return edit;
  const out: T = { ...edit };
  const t = text ?? {};
  if (t.hook && edit.hook) out.hook = t.hook.off ? null : { ...edit.hook, ...pick(t.hook, ['until', 'text'] as const) };
  if (t.cta && edit.cta && sameAt(spanOf(edit.cta), t.cta.at)) {
    out.cta = t.cta.off ? null : timed('text.cta', { ...edit.cta, ...pick(t.cta, ['t0', 't1', 'lines', 'word'] as const) });
  }
  if (t.accents?.length && edit.accents?.length) {
    out.accents = anchored(edit.accents, t.accents, 'text.accents', (item, c, name) => {
      if (c.off) return null;
      const lines = c.lines && c.lines.length === item.lines.length ? item.lines.map((line, i) => ({ ...line, text: (c.lines as string[])[i] })) : item.lines;
      return timed(name, { ...item, ...pick(c, ['t0', 't1'] as const), lines });
    }).filter((a) => a !== null);
  }
  if (t.inserts?.length && edit.inserts?.length) {
    out.inserts = anchored(edit.inserts as (Span2 & { kind: string; text?: string })[], t.inserts, 'text.inserts', (item, c, name) => {
      if (c.off) return { ...item, off: true };
      const changed = { ...item, ...pick(c, ['t0', 't1'] as const) };
      if ('text' in c && 'text' in item) changed.text = c.text; // текст — только у текстовых вставок
      return timed(name, changed);
    }) as T['inserts'];
  }
  if (words?.length && edit.words?.length) {
    const fixed = new Map(words.map((w) => [`${Number(w.t0)}|${Number(w.t1)}`, w.text]));
    out.words = edit.words.flatMap((w) => {
      const next = fixed.get(`${Number(w.t0)}|${Number(w.t1)}`);
      if (next === undefined) return [w];
      return next.trim() ? [{ ...w, text: next }] : []; // пустое — слова нет в субтитрах
    });
  }
  return out;
}

// ---------- правки ----------

const push = (h: HandEdits, e: Edit): HandEdits => ({ ...h, edits: [...h.edits, e] });
export const cutSpan = (h: HandEdits, t0: number, t1: number): HandEdits => push(h, { op: 'cut', t0: round3(t0), t1: round3(t1) });
export const restoreSpan = (h: HandEdits, t0: number, t1: number, next = false): HandEdits =>
  push(h, { op: 'restore', t0: round3(t0), t1: round3(t1), ...(next ? { next: true } : {}) });
export const splitAt = (h: HandEdits, t: number): HandEdits => push(h, { op: 'split', t: round3(t) });
/** Переставить кусок [t0, t1] перед моментом исходника `before` (начало куска, перед которым встаёт; null — в конец). */
export const moveSpan = (h: HandEdits, t0: number, t1: number, before: number | null): HandEdits =>
  push(h, { op: 'move', t0: round3(t0), t1: round3(t1), before: before === null ? null : round3(before) });

/** Начало куска `i` (из `keep`, порядок финала) — на `to` с исходника: правее — вырезать, левее — вернуть к этому
 *  куску (не дальше конца того, что перед ним в исходнике). Остаётся меньше кадра — кусок вырезается целиком. */
export function trimStart(h: HandEdits, keep: readonly Span[], i: number, to: number): HandEdits {
  const [a, b] = keep[i];
  if (Math.abs(to - a) < 1e-6) return h;
  if (to > a) return to >= b - SLIVER ? cutSpan(h, a, b) : cutSpan(h, a, to);
  const prev = Math.max(0, ...keep.filter(([, e]) => e <= a).map(([, e]) => e));
  const from = Math.max(to, prev);
  return from < a ? restoreSpan(h, from, a, true) : h;
}

/** Конец куска `i` — на `to`: левее — вырезать, правее — вернуть (не дальше начала того, что после него в исходнике,
 *  и конца исходника). */
export function trimEnd(h: HandEdits, keep: readonly Span[], i: number, to: number, duration?: number): HandEdits {
  const [a, b] = keep[i];
  if (Math.abs(to - b) < 1e-6) return h;
  if (to < b) return to <= a + SLIVER ? cutSpan(h, a, b) : cutSpan(h, to, b);
  const next = Math.min(duration ?? to, ...keep.filter(([s]) => s >= b).map(([s]) => s));
  const until = Math.min(to, next);
  return until > b ? restoreSpan(h, b, until) : h;
}

function level(l: Level, range: { min: number; max: number }): Level {
  return { ...(l.gainDb !== undefined ? { gainDb: round3(clamp(l.gainDb, range)) } : {}), ...(l.muted !== undefined ? { muted: l.muted } : {}) };
}

export const setVoice = (h: HandEdits, l: Level): HandEdits => ({ ...h, voice: { ...h.voice, ...level(l, LIMITS.gain) } });
export const setSound = (h: HandEdits, key: string, l: Level): HandEdits =>
  ({ ...h, sounds: { ...h.sounds, [key]: { ...h.sounds?.[key], ...level(l, LIMITS.gain) } } });

export function setMusic(h: HandEdits, m: MusicAdjust): HandEdits {
  const next: MusicAdjust = { ...h.music, ...level(m, LIMITS.musicGain) };
  if (m.at !== undefined) next.at = round3(Math.max(0, m.at));
  if (m.from !== undefined) next.from = round3(Math.max(0, m.from));
  if (m.fadeIn !== undefined) next.fadeIn = round3(clamp(m.fadeIn, LIMITS.fade));
  if (m.fadeOut !== undefined) next.fadeOut = round3(clamp(m.fadeOut, LIMITS.fade));
  return { ...h, music: next };
}

/** Момент — к ближайшей границе из `edges`, если она не дальше `within`; иначе как есть. */
export function snapTo(t: number, edges: readonly number[], within: number): number {
  let best = t;
  let gap = within;
  for (const e of edges) {
    const d = Math.abs(e - t);
    if (d <= gap) {
      gap = d;
      best = e;
    }
  }
  return best;
}

// ---------- правки текста и вставок ----------

const withText = (h: HandEdits, text: TextEdits): HandEdits => {
  const clean = Object.fromEntries(Object.entries(text).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
  const { text: _old, ...rest } = h;
  return Object.keys(clean).length ? { ...rest, text: clean as TextEdits } : rest;
};
const roundTimes = <T extends { t0?: number; t1?: number; until?: number }>(fix: T): T => ({
  ...fix,
  ...(fix.t0 !== undefined ? { t0: round3(fix.t0) } : {}),
  ...(fix.t1 !== undefined ? { t1: round3(fix.t1) } : {}),
  ...(fix.until !== undefined ? { until: round3(fix.until) } : {}),
});

/** Хук: правка поверх прежней (конец — по исходнику, текст); null — как у сессии. */
export function setHook(h: HandEdits, fix: HookFix | null): HandEdits {
  const next = fix === null ? undefined : roundTimes({ ...(fix.off ? {} : h.text?.hook), ...fix });
  return withText(h, { ...h.text, hook: next && Object.keys(next).length ? next : undefined });
}

/** Титр по месту `at`: правка поверх прежней; null — как у сессии. */
export function setCta(h: HandEdits, at: At, fix: Omit<CtaFix, 'at'> | null): HandEdits {
  const old = h.text?.cta && sameAt(h.text.cta.at, at) ? h.text.cta : { at };
  const next = fix === null ? undefined : roundTimes({ ...(fix.off ? { at } : old), ...fix, at });
  return withText(h, { ...h.text, cta: next });
}

/** Акцент или вставка по месту `at` (`occurrence` — какой по счёту блок с тем же местом): правка поверх прежней; null —
 *  как у сессии. Правки одного места идут по порядку блоков: перед k-м — k правок (пустые — «как есть»). */
export function setBlock<K extends 'accents' | 'inserts'>(h: HandEdits, kind: K, at: At, occurrence: number,
  fix: Omit<NonNullable<TextEdits[K]>[number], 'at'> | null): HandEdits {
  const list = [...(h.text?.[kind] ?? [])] as { at: At; off?: true }[];
  const same = list.map((f, i) => [f, i] as const).filter(([f]) => sameAt(f.at, at)).map(([, i]) => i);
  while (same.length <= occurrence) {
    list.push({ at });
    same.push(list.length - 1);
  }
  const i = same[occurrence];
  list[i] = fix === null ? { at } : roundTimes({ ...(fix.off ? { at } : list[i]), ...fix, at });
  // хвост «как есть» у этого места ничего не меняет — убрать
  const blank = (f: object) => Object.keys(f).length === 1;
  for (let k = list.length - 1; k >= 0; k--) {
    if (!sameAt(list[k].at, at)) continue;
    if (!blank(list[k])) break;
    list.splice(k, 1);
  }
  return withText(h, { ...h.text, [kind]: list });
}

/** Правка руками блока, если она есть: хук; титр по месту `at`; `occurrence`-й акцент или вставка с местом `at` (так их
 *  сопоставляет applyText). Пустая правка («как есть» — только место) — null. */
export function blockFix(h: HandEdits, kind: 'hook' | 'cta' | 'accent' | 'insert', at?: At, occurrence = 0): HookFix | CtaFix | AccentFix | InsertFix | null {
  if (kind === 'hook') return h.text?.hook ?? null;
  if (kind === 'cta') return h.text?.cta && at && sameAt(h.text.cta.at, at) ? h.text.cta : null;
  const list: (AccentFix | InsertFix)[] = (kind === 'accent' ? h.text?.accents : h.text?.inserts) ?? [];
  const f = list.filter((x) => at && sameAt(x.at, at))[occurrence];
  return f && Object.keys(f).length > 1 ? f : null;
}

/** Есть ли в тексте эмодзи — в слове субтитров их не примет проверка шрифтов движка (fonts.check: «субтитры только
 *  слова»). Правило — mayHaveEmoji шаблона (template/emoji.js): знак, который по умолчанию картинка, или FE0F, ZWJ,
 *  кейкап — есть в любой последовательности эмодзи; «№», «€», «→», «♪» — буквы. */
export const hasEmoji = (text: string): boolean => /\p{Emoji_Presentation}|[\u200D\uFE0F\u20E3]/u.test(text);

/** Знаки-символы, которые рисует каждый шрифт шаблона (engine/tests/test_fonts.py): их можно писать в любом тексте. */
export const SYMBOLS_OK = '№°©®™';

/** Знаки-символы текста (категория So), которых шрифт ролика не нарисует (★, ✓, ♪, ❤ без U+FE0F) — их не пропустит
 *  проверка шрифтов движка (fonts.symbols, lacking_symbols); эмодзи — картинки, их можно. → эти знаки по порядку, без
 *  повторов; всё рисуется — ''. */
export function badSymbols(text: string): string {
  const cps = [...text];
  const out = new Set<string>();
  cps.forEach((c, i) => {
    if (!/\p{So}/u.test(c) || SYMBOLS_OK.includes(c)) return;
    const next = cps[i + 1];
    if (/\p{Emoji_Presentation}/u.test(c) || next === '\uFE0F' || next === '\u200D' || cps[i - 1] === '\u200D') return; // эмодзи
    out.add(c);
  });
  return [...out].join('');
}

/** Весь текст, что Павел набрал в правках блоков: хук, строки и слово титра, строки акцентов, текст вставок. */
export function typedTexts(h: HandEdits): string[] {
  const t = h.text ?? {};
  return [t.hook?.text, ...(t.cta?.lines ?? []), t.cta?.word, ...(t.accents ?? []).flatMap((a) => a.lines ?? []), ...(t.inserts ?? []).map((i) => i.text)]
    .filter((x): x is string => typeof x === 'string');
}

/** Слово субтитров (t0, t1 — как в edit.json): текст Павла; '' — слова нет в субтитрах; null — как у сессии. */
export function setWord(h: HandEdits, t0: number, t1: number, text: string | null): HandEdits {
  const rest = (h.words ?? []).filter((w) => !(w.t0 === t0 && w.t1 === t1));
  const words = text === null ? rest : [...rest, { t0, t1, text }];
  const { words: _old, ...base } = h;
  return words.length ? { ...base, words } : base;
}

// ---------- отмена и повтор ----------

/** `key` — чем сделана последняя правка: шаги одного ползунка подряд — одна правка для отмены. */
export type History = { past: HandEdits[]; present: HandEdits; future: HandEdits[]; key?: string };
const DEPTH = 200;
export const initHistory = (present: HandEdits): History => ({ past: [], present, future: [] });
export function commit(h: History, next: HandEdits, key?: string): History {
  if (next === h.present) return h;
  if (key !== undefined && key === h.key) return { ...h, present: next, future: [] };
  return { past: [...h.past, h.present].slice(-DEPTH), present: next, future: [], key };
}
export const undo = (h: History): History => {
  const prev = h.past.at(-1);
  return prev ? { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] } : h;
};
export const redo = (h: History): History => {
  const next = h.future[0];
  return next ? { past: [...h.past, h.present], present: next, future: h.future.slice(1) } : h;
};

// ---------- timeline.json ----------

function parseLevel(x: unknown, range: { min: number; max: number }): Level | null {
  if (!isObj(x) || Object.keys(x).some((k) => k !== 'gainDb' && k !== 'muted')) return null;
  if (x.gainDb !== undefined && !(isNum(x.gainDb) && x.gainDb >= range.min && x.gainDb <= range.max)) return null;
  if (x.muted !== undefined && typeof x.muted !== 'boolean') return null;
  return x as Level;
}

function parseEdit(x: unknown): Edit | null {
  if (!isObj(x)) return null;
  if (x.op === 'split') return Object.keys(x).length === 2 && isNum(x.t) && x.t >= 0 ? (x as Edit) : null;
  // конец позже начала — схема этого не скажет, а applyKeep на такой правке упал бы (движок её отвергает)
  const span = isNum(x.t0) && isNum(x.t1) && x.t0 >= 0 && x.t1 > x.t0;
  const only = (...keys: string[]) => Object.keys(x).every((k) => keys.includes(k));
  if (x.op === 'cut') return span && only('op', 't0', 't1') ? (x as Edit) : null;
  if (x.op === 'restore') return span && only('op', 't0', 't1', 'next') && (x.next === undefined || typeof x.next === 'boolean') ? (x as Edit) : null;
  if (x.op === 'move') {
    const before = x.before === null || (isNum(x.before) && x.before >= 0);
    return span && 'before' in x && before && only('op', 't0', 't1', 'before') ? (x as Edit) : null;
  }
  return null;
}

const chars = (x: string) => [...x].length; // знаки, как maxLength схемы (а не единицы UTF-16)
const isLine = (x: unknown): x is string => typeof x === 'string' && chars(x) >= 1 && chars(x) <= LIMITS.line;
const isAt = (x: unknown): x is At => Array.isArray(x) && x.length === 2 && x.every((v) => isNum(v) && v >= 0);
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const okTime = (o: Record<string, unknown>) => ['t0', 't1'].every((k) => o[k] === undefined || (isNum(o[k]) && (o[k] as number) >= 0));
const okOff = (o: Record<string, unknown>) => o.off === undefined || o.off === true;
const okLines = (x: unknown) => x === undefined || (Array.isArray(x) && x.length >= 1 && x.length <= LIMITS.lines && x.every(isLine));

function parseText(x: unknown): TextEdits | null {
  if (!isObj(x) || !onlyKeys(x, ['hook', 'cta', 'accents', 'inserts'])) return null;
  const { hook, cta, accents, inserts } = x;
  if (hook !== undefined && !(isObj(hook) && onlyKeys(hook, ['until', 'text', 'off']) && okOff(hook)
    && (hook.until === undefined || (isNum(hook.until) && hook.until > 0)) && (hook.text === undefined || isLine(hook.text)))) return null;
  if (cta !== undefined && !(isObj(cta) && onlyKeys(cta, ['at', 't0', 't1', 'lines', 'word', 'off']) && isAt(cta.at) && okTime(cta)
    && okOff(cta) && okLines(cta.lines) && (cta.word === undefined || isLine(cta.word)))) return null;
  const list = (v: unknown, keys: string[], more: (o: Record<string, unknown>) => boolean) => v === undefined
    || (Array.isArray(v) && v.length <= LIMITS.blocks && v.every((o) => isObj(o) && onlyKeys(o, keys) && isAt(o.at) && okTime(o) && okOff(o) && more(o)));
  if (!list(accents, ['at', 't0', 't1', 'lines', 'off'], (o) => okLines(o.lines))) return null;
  if (!list(inserts, ['at', 't0', 't1', 'text', 'off'], (o) => o.text === undefined || isLine(o.text))) return null;
  return x as TextEdits;
}

const parseWords = (x: unknown): boolean => Array.isArray(x) && x.length <= LIMITS.words && x.every((w) => isObj(w)
  && onlyKeys(w, ['t0', 't1', 'text']) && isNum(w.t0) && w.t0 >= 0 && isNum(w.t1) && w.t1 >= 0 && typeof w.text === 'string' && chars(w.text) <= LIMITS.word);

/** timeline.json → правки; не та форма (как по схеме) — null. */
export function parseTimeline(raw: unknown): TimelineFile | null {
  if (!isObj(raw) || Object.keys(raw).some((k) => !['rev', 'at', 'edits', 'voice', 'music', 'sounds', 'text', 'words'].includes(k))) return null;
  if (raw.text !== undefined && !parseText(raw.text)) return null;
  if (raw.words !== undefined && !parseWords(raw.words)) return null;
  if (!(Number.isInteger(raw.rev) && (raw.rev as number) >= 1) || (raw.at !== undefined && typeof raw.at !== 'string')) return null;
  if (!Array.isArray(raw.edits) || raw.edits.length > LIMITS.edits || !raw.edits.every((e) => parseEdit(e))) return null;
  if (raw.voice !== undefined && !parseLevel(raw.voice, LIMITS.gain)) return null;
  if (raw.music !== undefined) {
    const m = raw.music;
    if (!isObj(m) || Object.keys(m).some((k) => !['gainDb', 'muted', 'at', 'from', 'fadeIn', 'fadeOut'].includes(k))) return null;
    const { gainDb, muted, ...place } = m;
    if (!parseLevel({ ...(gainDb !== undefined ? { gainDb } : {}), ...(muted !== undefined ? { muted } : {}) }, LIMITS.musicGain)) return null;
    for (const [k, v] of Object.entries(place)) {
      const max = k === 'fadeIn' || k === 'fadeOut' ? LIMITS.fade.max : Infinity;
      if (!(isNum(v) && v >= 0 && v <= max)) return null;
    }
  }
  if (raw.sounds !== undefined) {
    if (!isObj(raw.sounds) || !Object.entries(raw.sounds).every(([k, v]) => SOUND_KEY.test(k) && parseLevel(v, LIMITS.gain))) return null;
  }
  return raw as TimelineFile;
}
