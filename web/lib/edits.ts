// Правки Павла руками в редакторе — timeline.json (схема engine/vm/schemas/timeline.json). Движок кладёт их поверх
// edit.json сессии при каждом монтаже (engine/vm/edits.py); правило кусков то же — applyKeep, общая фикстура
// engine/tests/fixtures/edits.json; текст и вставки — applyText (apply_text движка), общая фикстура
// overlay-events.json (text). Времена — секунды исходника, кроме music.at (секунда ролика).

import { pyRound } from './pyround.ts';
import { TO_CUT } from './timeline.ts';
import { MAX_LEVEL, MAX_SHOT, MIN_LEVEL } from './zoom.ts';

/** Правка кусков (секунды исходника): вырезать; вернуть (к куску перед ним в исходнике, `next` — к куску после него);
 *  переставить оставленное в [t0, t1] перед моментом `before` (null — в конец); разрез — только граница на экране. */
export type Edit =
  | { op: 'cut'; t0: number; t1: number }
  | { op: 'restore'; t0: number; t1: number; next?: boolean }
  | { op: 'move'; t0: number; t1: number; before: number | null }
  | { op: 'split'; t: number };
export type Level = { gainDb?: number; muted?: boolean };
/** Музыка руками: где звучит, с какого места трека, нарастание и затухание; `file` — другой трек библиотеки. */
export type MusicAdjust = Level & { file?: string; at?: number; from?: number; fadeIn?: number; fadeOut?: number };
/** Место блока в речи — `[t0, t1]`, как его записала сессия: правка держится за блок по нему, а не по номеру. */
export type At = [number, number];
/** Хук: конец (по исходнику) и текст; off — хука нет. */
export type HookFix = { until?: number; text?: string; off?: true };
export type CtaFix = { at: At; t0?: number; t1?: number; lines?: string[]; word?: string; off?: true };
export type AccentFix = { at: At; t0?: number; t1?: number; lines?: string[]; x?: number; y?: number; off?: true };
export type InsertFix = {
  at: At; t0?: number; t1?: number; text?: string; x?: number; y?: number; w?: number; off?: true;
  src?: string; from?: number; layout?: BrollLayout; audio?: boolean; // перебивка (fullscreen): клип, момент, вид, звук клипа
};
/** Вид перебивки: клип на весь кадр или клип с лицом окошком. */
export type BrollLayout = 'full' | 'pip';
/** Клип перебивки руками — из перебивок Павла (как образец src вставки в схеме timeline.json). */
export const BROLL_SRC = /^in\/uploads\/upload-b\d{1,2}\.[a-z0-9]{1,5}$/;
const BROLL_FIELDS = ['src', 'from', 'layout', 'audio'] as const; // edits.BROLL_FIELDS движка
/** Место блока на кадре руками, px кадра: у акцента — центр блока, у вставки — левый верхний угол и ширина. */
export type Place = { x: number; y: number; w?: number };
/** Финальная карточка: строки (1–2) и ник ('' — без ника); off — карточки нет. */
export type EndFix = { lines?: string[]; handle?: string; off?: true };
/** Текст и вставки (фаза 5): хук, титр, акценты, вставки, финальная карточка. */
export type TextEdits = { hook?: HookFix; cta?: CtaFix; accents?: AccentFix[]; inserts?: InsertFix[]; end?: EndFix };
/** Слово субтитров с ровно этими t0, t1 получает текст Павла; пустой — слова нет в субтитрах. */
export type WordFix = { t0: number; t1: number; text: string };
/** Фильтры кусков (edit.json looks.look): ч/б эталона и фильтры руками — сепия, тёплый, холодный, плёнка (KINDS движка,
 *  vm/looks.py; порядок кнопок в редакторе). */
export const LOOK_KINDS = ['bw', 'sepia', 'warm', 'cold', 'film'] as const;
export type LookKind = (typeof LOOK_KINDS)[number];
/** Кусок с фильтром руками: кусок сессии по месту `at` — убран (`off`), с другими краями (`t0`, `t1` — время исходника)
 *  или другим фильтром (`look`); без `at` — свой кусок Павла (`t0`, `t1`, `look`). Переход по своему `t` (`at`) —
 *  другого вида или убран. */
export type LookFix = { at?: At; off?: true; t0?: number; t1?: number; look?: LookKind };
/** Какой кусок правят: кусок сессии — по месту `at` в edit.looks, свой — по номеру среди своих (`own`). */
export type LookRef = { at: At } | { own: number };
/** Виды переходов (edit.json, transitions.kind): вспышка, толчок зумом, смаз. */
export const TRANSITION_KINDS = ['flash', 'zoom', 'blur', 'tear', 'glitch'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];
export type TransitionFix = { at: number; kind?: TransitionKind; off?: true };
/** Что правит Павел: куски, голос, музыка, звуки, текст и вставки, слова субтитров, картинка. */
export type HandEdits = {
  edits: Edit[]; voice?: Level; music?: MusicAdjust; sounds?: Record<string, Level>; text?: TextEdits; words?: WordFix[];
  zoom?: number; looks?: LookFix[]; transitions?: TransitionFix[]; // картинка: сила зума (доля от зума монтажа), ч/б, переходы
  dim?: number; // затемнение фона (доля, как edit.json dim; 0 — без него)
  teaser?: false; speed?: number; // ролик: тизер убран; скорость (как edit.json speed)
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
  zoom: { min: 0, max: 1.5 }, // сила зума: доля от зума монтажа
  dim: { min: 0, max: 0.8 }, // затемнение фона: доля
  speed: { min: 0.8, max: 1.5 }, // скорость ролика
  endLines: 2, // строк финальной карточки
  handle: 60, // знаков в нике карточки
  accentAt: { x: { min: 60, max: 890 }, y: { min: 120, max: 1530 } }, // центр акцента на кадре — в безопасной зоне
  insertBox: { x: { min: 60, max: 810 }, y: { min: 120, max: 1490 }, w: { min: 80, max: 830 } }, // рамка вставки — как answers.insertBoxes
  brollFrom: { min: 0, max: 36000 }, // с — с какой секунды клипа перебивка
} as const;
/** Трек музыки из библиотеки (как Music.file в схеме timeline.json). */
export const MUSIC_FILE = /^assets\/music\/[^/]+\.(mp3|wav|m4a|aac|ogg|flac)$/;
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
  end?: { lines: string[]; handle?: string | null } | null;
  hook?: { text: string; until: number } | null;
  cta?: (Span2 & { lines: string[]; word: string }) | null;
  accents?: (Span2 & { lines: { text: string }[]; x?: number; y?: number })[] | null;
  inserts?: (Partial<Span2> & { kind: string; text?: string; x?: number; y?: number; w?: number; off?: boolean; src?: string })[] | null;
  words?: (Span2 & { text: string })[] | null;
};

/** Текст и вставки Павла поверх edit — как apply_text движка: хук — конец и текст; титр, акценты, вставки — по месту в
 *  речи (`at`); место на кадре — центр акцента, рамка вставки (у fullscreen её нет — у неё клип, момент клипа, вид и
 *  звук перебивки); вставка с off остаётся в списке
 *  (номера звуков те же); слова — по точному t0, t1, пустое — нет в субтитрах. Правок нет — тот же edit. */
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
      return timed(name, { ...item, ...pick(c, ['t0', 't1', 'x', 'y'] as const), lines });
    }).filter((a) => a !== null);
  }
  if (t.inserts?.length && edit.inserts?.length) {
    out.inserts = anchored(edit.inserts as (Span2 & { kind: string; text?: string; x?: number; w?: number })[], t.inserts, 'text.inserts', (item, c, name) => {
      if (c.off) return { ...item, off: true };
      const changed = { ...item, ...pick(c, ['t0', 't1'] as const) };
      if ('text' in c && 'text' in item) changed.text = c.text; // текст — только у текстовых вставок
      if ('x' in item && 'w' in item) Object.assign(changed, pick(c, ['x', 'y', 'w'] as const)); // рамка — у вставок на кадре (не fullscreen)
      if (item.kind === 'fullscreen') Object.assign(changed, pick(c, BROLL_FIELDS)); // перебивка: клип, момент, вид, звук
      return timed(name, changed);
    }) as T['inserts'];
  }
  if (t.end && edit.end) { // финальная карточка: строки и ник; пустой ник — без ника
    const card = { ...edit.end, ...(t.end.lines ? { lines: [...t.end.lines] } : {}) };
    if (t.end.handle !== undefined) card.handle = t.end.handle || null;
    out.end = t.end.off ? null : card;
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

type PictureBase = {
  dim?: number | null;
  zooms?: readonly { t: number; level: number; over?: number }[] | null;
  looks?: readonly (Span2 & { look: string; off?: boolean })[] | null;
  transitions?: readonly { t: number; kind: string; sfx?: string | null; off?: boolean }[] | null;
};

/** Картинка руками поверх edit — как apply_picture движка: куски с фильтром — кусок сессии по месту `at` убран (`off`,
 *  остаётся в списке), с другими краями или фильтром; свой кусок Павла — в конце списка; на краях своего куска и куска с
 *  другими краями — смена крупности (shotEdges). Сила зума — доля от зума монтажа (1 + (уровень − 1) · zoom, четыре
 *  знака), в том числе у смен крупности кусков; переход по своему `t` — другого вида или выключен; выключенное остаётся в
 *  списке (номера звуков переходов те же); затемнение фона — своё (0 — без него). Правок нет — тот же edit. */
export function applyPicture<T extends PictureBase>(edit: T, zoom?: number, looks?: readonly LookFix[], transitions?: readonly TransitionFix[],
  dim?: number): T {
  if (zoom === undefined && !looks?.length && !transitions?.length && dim === undefined) return edit;
  let out: T = { ...edit };
  if (dim !== undefined) out.dim = dim > 0 ? dim : null;
  if (looks?.length) out = handLooks(out, looks);
  if (zoom !== undefined) out.zooms = (out.zooms ?? []).map((z) => ({ ...z, level: pyRound(1 + (Number(z.level) - 1) * zoom, 4) }));
  if (transitions?.length) {
    const list = [...(edit.transitions ?? [])];
    const used = new Set<number>();
    for (const c of transitions) {
      const k = list.findIndex((x, j) => !used.has(j) && Number(x.t) === Number(c.at));
      if (k < 0) continue;
      used.add(k);
      list[k] = { ...list[k], ...(c.kind ? { kind: c.kind } : {}), ...(c.off ? { off: true } : {}) };
    }
    out.transitions = list;
  }
  return out;
}

type ZoomStep = { t: number; level: number; over?: number };
type LookItem = Span2 & { look: string; off?: boolean };
const SHOTS = [1.25, 1.0, 1.15] as const; // план куска с фильтром руками: крупный, общий, средний (SHOTS движка)
const SHOT_STEP = 0.1; // «видно отличается»: разница планов не меньше

/** Куски с фильтром руками поверх edit (edits._hand_looks): правки кусков сессии по `at`, затем свои куски Павла; у куска
 *  с новыми краями смены крупности сессии на старых краях уходят, на новых — shotEdges. */
function handLooks<T extends PictureBase>(edit: T, looks: readonly LookFix[]): T {
  let zooms: ZoomStep[] = [...(edit.zooms ?? [])];
  const moved: [LookItem, LookItem][] = [];
  const pieces = anchored(edit.looks ?? [], looks.filter((c): c is LookFix & { at: At } => c.at !== undefined), 'looks', (item, c, name) => {
    if (c.off) return { ...item, off: true };
    let next: LookItem = { ...item, ...(c.look !== undefined ? { look: c.look } : {}) };
    if (c.t0 !== undefined) {
      next = timed(name, { ...next, t0: Number(c.t0), t1: Number(c.t1) });
      moved.push([item, next]);
    }
    return next;
  }) as LookItem[];
  for (const [old] of moved) {
    zooms = zooms.filter((z) => !(sharp(z) && [Number(old.t0), Number(old.t1)].some((e) => Math.abs(Number(z.t) - e) <= TO_CUT + EPS)));
  }
  for (const [, next] of moved) zooms = shotEdges(zooms, next.t0, next.t1);
  looks.filter((c) => c.at === undefined).forEach((c, i) => {
    const own = timed(`looks[own ${i}]`, { t0: Number(c.t0), t1: Number(c.t1), look: c.look as string });
    pieces.push(own);
    zooms = shotEdges(zooms, own.t0, own.t1);
  });
  return { ...edit, looks: pieces, zooms } as T;
}

const sharp = (z: ZoomStep): boolean => z.over !== undefined && Number(z.over) === 0;

/** План в момент `t` исходника по ступеням до него (edits._plan_at): уровень последней, в своих пределах; нет — 1.0. */
function planAt(zooms: readonly ZoomStep[], t: number): number {
  let level = MIN_LEVEL;
  for (const z of [...zooms].sort((a, b) => Number(a.t) - Number(b.t))) {
    if (Number(z.t) > t + EPS) break;
    level = Math.min(z.over !== undefined ? MAX_SHOT : MAX_LEVEL, Math.max(MIN_LEVEL, Number(z.level)));
  }
  return level;
}

/** Смена крупности на краях куска [t0, t1], как вторая камера (edits._shot_edges): на его время план один — из SHOTS
 *  первый, что отличается от плана до куска и после него хотя бы на SHOT_STEP (нет такого — самый далёкий от обоих);
 *  ступени внутри и не дальше TO_CUT от краёв уходят; после куска — план, какой был бы без него. */
function shotEdges(zooms: readonly ZoomStep[], t0: number, t1: number): ZoomStep[] {
  const before = planAt(zooms, t0 - TO_CUT);
  const after = planAt(zooms, t1 + TO_CUT);
  const gap = (s: number) => Math.min(Math.abs(s - before), Math.abs(s - after));
  const inside = SHOTS.find((s) => gap(s) >= SHOT_STEP - EPS) ?? SHOTS.reduce((best, s) => (gap(s) > gap(best) ? s : best));
  const rest = zooms.filter((z) => !(t0 - TO_CUT - EPS < Number(z.t) && Number(z.t) < t1 + TO_CUT + EPS));
  const edges: ZoomStep[] = [{ t: t0, level: inside, over: 0 }, { t: t1, level: after, over: 0 }];
  return [...rest, ...edges].sort((a, b) => Number(a.t) - Number(b.t));
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

/** Финальная карточка: правка поверх прежней (строки, ник); `off` — без прочего; null — как у сессии. */
export function setEnd(h: HandEdits, fix: EndFix | null): HandEdits {
  const next = fix === null ? undefined : { ...(fix.off ? {} : h.text?.end), ...fix };
  return withText(h, { ...h.text, end: next && Object.keys(next).length ? next : undefined });
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

/** Место акцента или вставки на кадре руками (`occurrence`-й блок с местом `at`; px кадра — целые): у акцента — центр,
 *  у вставки — ещё и ширина; поверх прочих правок блока (время, текст). null — место как у монтажа, остальное остаётся. */
export function placeBlock(h: HandEdits, kind: 'accents' | 'inserts', at: At, occurrence: number, place: Place | null): HandEdits {
  const now = ((h.text?.[kind] ?? []) as InsertFix[]).filter((f) => sameAt(f.at, at))[occurrence];
  const rest = Object.fromEntries(Object.entries(now ?? {}).filter(([k]) => !['at', 'x', 'y', 'w'].includes(k)));
  const r = kind === 'inserts' ? LIMITS.insertBox : LIMITS.accentAt; // что бы ни насчитали ручки — в пределах схемы
  const fit = (v: number, range: { min: number; max: number }) => Math.round(clamp(v, range));
  const box = place === null ? {} : {
    x: fit(place.x, r.x), y: fit(place.y, r.y), ...(kind === 'inserts' && place.w !== undefined ? { w: fit(place.w, LIMITS.insertBox.w) } : {}),
  };
  const next = { ...rest, ...box };
  return setBlock(setBlock(h, kind, at, occurrence, null), kind, at, occurrence, Object.keys(next).length ? next : null);
}

/** Место блока на кадре, которое поставил Павел (`occurrence`-й акцент или вставка с местом `at`); нет — null. */
export function blockPlace(h: HandEdits, kind: 'accent' | 'insert', at: At, occurrence = 0): Place | null {
  const f = (((kind === 'accent' ? h.text?.accents : h.text?.inserts) ?? []) as InsertFix[]).filter((x) => sameAt(x.at, at))[occurrence];
  if (f?.x === undefined || f.y === undefined) return null;
  return f.w === undefined ? { x: f.x, y: f.y } : { x: f.x, y: f.y, w: f.w };
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

/** Весь текст, что Павел набрал в правках блоков: хук, строки и слово титра, строки акцентов, текст вставок, строки и ник
 *  финальной карточки (её движок рисует основным шрифтом — fonts.texts). */
export function typedTexts(h: HandEdits): string[] {
  const t = h.text ?? {};
  return [t.hook?.text, ...(t.cta?.lines ?? []), t.cta?.word, ...(t.accents ?? []).flatMap((a) => a.lines ?? []), ...(t.inserts ?? []).map((i) => i.text),
    ...(t.end?.lines ?? []), t.end?.handle].filter((x): x is string => typeof x === 'string');
}

/** Трек музыки из библиотеки (`assets/music/…`); null — трек сессии (громкость и место Павла остаются). */
export function setTrack(h: HandEdits, file: string | null): HandEdits {
  const { music, ...rest } = h;
  const { file: _old, ...place } = music ?? {};
  const next: MusicAdjust = file === null ? place : { ...place, file };
  return Object.keys(next).length ? { ...rest, music: next } : rest;
}

// ---------- картинка ----------

/** Тизер в начале ролика: убрать (false в timeline.json) или как у монтажа (поля нет). */
export function setTeaser(h: HandEdits, on: boolean): HandEdits {
  const { teaser: _old, ...rest } = h;
  return on ? rest : { ...rest, teaser: false };
}

/** Скорость ролика (шаг — 0,05); null — как у монтажа (поля нет). */
export function setSpeed(h: HandEdits, speed: number | null): HandEdits {
  const { speed: _old, ...rest } = h;
  return speed === null ? rest : { ...rest, speed: Math.round(clamp(speed, LIMITS.speed) * 100) / 100 };
}

/** Затемнение фона (доля; 0 — без него); null — как у монтажа (поля нет). */
export function setDim(h: HandEdits, dim: number | null): HandEdits {
  const { dim: _old, ...rest } = h;
  return dim === null ? rest : { ...rest, dim: Math.round(clamp(dim, LIMITS.dim) * 100) / 100 };
}

/** Сила зума — доля от зума монтажа (ползунок: шаг — процент); 1 или null — как у монтажа (поля нет). */
export function setZoom(h: HandEdits, zoom: number | null): HandEdits {
  const { zoom: _old, ...rest } = h;
  if (zoom === null) return rest;
  const z = Math.round(clamp(zoom, LIMITS.zoom) * 100) / 100;
  return z === 1 ? rest : { ...rest, zoom: z };
}

const lookAt = (f: LookFix, at: At): boolean => f.at !== undefined && sameAt(f.at, at);

function withLooks(h: HandEdits, looks: LookFix[]): HandEdits {
  const { looks: _old, ...base } = h;
  return looks.length ? { ...base, looks } : base;
}

/** Свои куски Павла по порядку — номер среди своих (`own`); `f` — новая правка этого куска. */
function mapOwn(h: HandEdits, own: number, f: (x: LookFix) => LookFix): LookFix[] {
  let k = -1;
  return (h.looks ?? []).map((x) => (x.at === undefined && ++k === own ? f(x) : x));
}

/** Кусок сессии edit.looks с местом `at` ([t0, t1], как его записала сессия): `off` — убран из ролика; иначе — как у
 *  сессии (его другие края и фильтр тоже уходят). */
export function setLook(h: HandEdits, at: At, off: boolean): HandEdits {
  const rest = (h.looks ?? []).filter((f) => !lookAt(f, at));
  return withLooks(h, off ? [...rest, { at: [at[0], at[1]], off: true }] : rest);
}

/** Свой кусок Павла [t0, t1] (время исходника) с фильтром `look` — в конце списка: его номер среди своих — последний. */
export function addLook(h: HandEdits, t0: number, t1: number, look: LookKind = 'bw'): HandEdits {
  return withLooks(h, [...(h.looks ?? []), { t0: round3(t0), t1: round3(t1), look }]);
}

/** Новые края куска (время исходника): свой — t0, t1; кусок сессии — правка его места (края как у сессии — правки
 *  краёв нет; его фильтр Павла остаётся). */
export function setLookEdges(h: HandEdits, ref: LookRef, t0: number, t1: number): HandEdits {
  const a = round3(t0);
  const b = round3(t1);
  if ('own' in ref) return withLooks(h, mapOwn(h, ref.own, (f) => ({ ...f, t0: a, t1: b })));
  const list = h.looks ?? [];
  const old = list.find((f) => lookAt(f, ref.at) && !f.off);
  const same = a === ref.at[0] && b === ref.at[1];
  const fix: LookFix = { at: [ref.at[0], ref.at[1]], ...(same ? {} : { t0: a, t1: b }), ...(old?.look ? { look: old.look } : {}) };
  const rest = list.filter((f) => !lookAt(f, ref.at));
  return withLooks(h, fix.t0 !== undefined || fix.look !== undefined ? [...rest, fix] : rest);
}

/** Фильтр куска: своего — новый; куска сессии — `look` (тот же, что у сессии, `was`, — правки фильтра нет; его края
 *  Павла остаются). */
export function setLookKind(h: HandEdits, ref: LookRef, look: LookKind, was = 'bw'): HandEdits {
  if ('own' in ref) return withLooks(h, mapOwn(h, ref.own, (f) => ({ ...f, look })));
  const list = h.looks ?? [];
  const old = list.find((f) => lookAt(f, ref.at) && !f.off);
  const fix: LookFix = { at: [ref.at[0], ref.at[1]], ...(old?.t0 !== undefined ? { t0: old.t0, t1: old.t1 } : {}), ...(look !== was ? { look } : {}) };
  const rest = list.filter((f) => !lookAt(f, ref.at));
  return withLooks(h, fix.t0 !== undefined || fix.look !== undefined ? [...rest, fix] : rest);
}

/** Убрать свой кусок Павла (номер среди своих). */
export function removeLook(h: HandEdits, own: number): HandEdits {
  let k = -1;
  return withLooks(h, (h.looks ?? []).filter((f) => f.at !== undefined || ++k !== own));
}

/** Переход edit.transitions с моментом `at` (его t): другого вида (`kind`) и/или убран (`off`); ни того ни другого или
 *  null — как у сессии (правки нет). Вид, как у сессии, страница не пишет (панель передаёт только другой). */
export function setTransition(h: HandEdits, at: number, fix: { kind?: TransitionKind; off?: boolean } | null): HandEdits {
  const rest = (h.transitions ?? []).filter((f) => f.at !== at);
  const next: TransitionFix = { at, ...(fix?.kind ? { kind: fix.kind } : {}), ...(fix?.off ? { off: true as const } : {}) };
  const transitions = Object.keys(next).length > 1 ? [...rest, next] : rest;
  const { transitions: _old, ...base } = h;
  return transitions.length ? { ...base, transitions } : base;
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
  if (!isObj(x) || !onlyKeys(x, ['hook', 'cta', 'accents', 'inserts', 'end'])) return null;
  const { hook, cta, accents, inserts, end } = x;
  if (end !== undefined && !(isObj(end) && onlyKeys(end, ['lines', 'handle', 'off']) && okOff(end)
    && (end.lines === undefined || (Array.isArray(end.lines) && end.lines.length >= 1 && end.lines.length <= LIMITS.endLines && end.lines.every(isLine)))
    && (end.handle === undefined || (typeof end.handle === 'string' && chars(end.handle) <= LIMITS.handle)))) return null;
  if (hook !== undefined && !(isObj(hook) && onlyKeys(hook, ['until', 'text', 'off']) && okOff(hook)
    && (hook.until === undefined || (isNum(hook.until) && hook.until > 0)) && (hook.text === undefined || isLine(hook.text)))) return null;
  if (cta !== undefined && !(isObj(cta) && onlyKeys(cta, ['at', 't0', 't1', 'lines', 'word', 'off']) && isAt(cta.at) && okTime(cta)
    && okOff(cta) && okLines(cta.lines) && (cta.word === undefined || isLine(cta.word)))) return null;
  const list = (v: unknown, keys: string[], more: (o: Record<string, unknown>) => boolean) => v === undefined
    || (Array.isArray(v) && v.length <= LIMITS.blocks && v.every((o) => isObj(o) && onlyKeys(o, keys) && isAt(o.at) && okTime(o) && okOff(o) && more(o)));
  // место на кадре — целиком (у акцента x и y, у вставки x, y и w) и в безопасной зоне, как dependentRequired и пределы схемы
  const whole = (o: Record<string, unknown>, keys: string[]) => keys.every((k) => o[k] === undefined) || keys.every((k) => o[k] !== undefined);
  const inRange = (v: unknown, r: { min: number; max: number }) => v === undefined || (isNum(v) && v >= r.min && v <= r.max);
  const { accentAt: ac, insertBox: ib } = LIMITS;
  if (!list(accents, ['at', 't0', 't1', 'lines', 'x', 'y', 'off'], (o) => okLines(o.lines) && whole(o, ['x', 'y'])
    && inRange(o.x, ac.x) && inRange(o.y, ac.y))) return null;
  if (!list(inserts, ['at', 't0', 't1', 'text', 'x', 'y', 'w', 'off', ...BROLL_FIELDS], (o) => (o.text === undefined || isLine(o.text)) && whole(o, ['x', 'y', 'w'])
    && inRange(o.x, ib.x) && inRange(o.y, ib.y) && inRange(o.w, ib.w)
    && (o.src === undefined || (typeof o.src === 'string' && BROLL_SRC.test(o.src))) && inRange(o.from, LIMITS.brollFrom)
    && (o.layout === undefined || o.layout === 'full' || o.layout === 'pip') && (o.audio === undefined || typeof o.audio === 'boolean'))) return null;
  return x as TextEdits;
}

/** Картинка руками (zoom, looks, transitions, dim), как по схеме. */
function parsePicture({ zoom, looks, transitions, dim }: Record<string, unknown>): boolean {
  if (zoom !== undefined && !(isNum(zoom) && zoom >= LIMITS.zoom.min && zoom <= LIMITS.zoom.max)) return false;
  if (dim !== undefined && !(isNum(dim) && dim >= LIMITS.dim.min && dim <= LIMITS.dim.max)) return false;
  const list = (v: unknown, ok: (o: Record<string, unknown>) => boolean) => v === undefined
    || (Array.isArray(v) && v.length <= LIMITS.blocks && v.every((o) => isObj(o) && ok(o)));
  if (!list(looks, (o) => onlyKeys(o, ['at', 'off', 't0', 't1', 'look']) && (o.at === undefined || isAt(o.at))
    && (o.off === undefined || o.off === true) && (o.t0 === undefined) === (o.t1 === undefined)
    && (o.t0 === undefined || (isNum(o.t0) && o.t0 >= 0 && isNum(o.t1) && o.t1 >= 0))
    && (o.look === undefined || (LOOK_KINDS as readonly unknown[]).includes(o.look))
    && (o.at !== undefined ? o.off === true || o.t0 !== undefined || o.look !== undefined
      : o.t0 !== undefined && o.look !== undefined && o.off === undefined))) return false;
  return list(transitions, (o) => onlyKeys(o, ['at', 'kind', 'off']) && isNum(o.at) && o.at >= 0
    && (o.kind === undefined || (TRANSITION_KINDS as readonly unknown[]).includes(o.kind)) && (o.off === undefined || o.off === true));
}

const parseWords = (x: unknown): boolean => Array.isArray(x) && x.length <= LIMITS.words && x.every((w) => isObj(w)
  && onlyKeys(w, ['t0', 't1', 'text']) && isNum(w.t0) && w.t0 >= 0 && isNum(w.t1) && w.t1 >= 0 && typeof w.text === 'string' && chars(w.text) <= LIMITS.word);

/** timeline.json → правки; не та форма (как по схеме) — null. */
export function parseTimeline(raw: unknown): TimelineFile | null {
  const keys = ['rev', 'at', 'edits', 'voice', 'music', 'sounds', 'text', 'words', 'zoom', 'looks', 'transitions', 'dim', 'teaser', 'speed'];
  if (!isObj(raw) || Object.keys(raw).some((k) => !keys.includes(k))) return null;
  if (raw.text !== undefined && !parseText(raw.text)) return null;
  if (raw.words !== undefined && !parseWords(raw.words)) return null;
  if (!parsePicture(raw)) return null;
  if (raw.teaser !== undefined && raw.teaser !== false) return null;
  if (raw.speed !== undefined && !(isNum(raw.speed) && raw.speed >= LIMITS.speed.min && raw.speed <= LIMITS.speed.max)) return null;
  if (!(Number.isInteger(raw.rev) && (raw.rev as number) >= 1) || (raw.at !== undefined && typeof raw.at !== 'string')) return null;
  if (!Array.isArray(raw.edits) || raw.edits.length > LIMITS.edits || !raw.edits.every((e) => parseEdit(e))) return null;
  if (raw.voice !== undefined && !parseLevel(raw.voice, LIMITS.gain)) return null;
  if (raw.music !== undefined) {
    const m = raw.music;
    if (!isObj(m) || Object.keys(m).some((k) => !['file', 'gainDb', 'muted', 'at', 'from', 'fadeIn', 'fadeOut'].includes(k))) return null;
    const { gainDb, muted, file, ...place } = m;
    if (file !== undefined && !(typeof file === 'string' && MUSIC_FILE.test(file))) return null;
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
