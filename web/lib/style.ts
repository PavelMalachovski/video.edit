// Стиль на экране превью: итоговый StyleSpec по выбору Павла (то же правило, что final_style движка), образец
// состояния слоя на кадре (субтитры — по правилу build_sub_events), вставки по ответам и запомненный выбор.
import { chosen, type Draft } from './answers.ts';
import { sameJson } from './equal.ts';
import { AB_KINDS, ADJUST, COVER, type CoverChoice, ADJUSTABLE, HOOK_SIZE, HOOK_Y, INSERT_W, INSERT_ZONE, inRange, isBarPos, isHookMode, isInsertBox, isShadeKind, isSubMode, RESERVED, SUB_SHADE, SUB_SIZE, SUB_Y, type AbKind, type Adjustable, type InsertBox, type Question, type SampleInsert, type ShadeKind, type StyleChoice, type StyleSpec, type Styles } from './jobfiles.ts';

export { HOOK_SIZE, HOOK_Y, INSERT_W, SUB_SHADE, SUB_SIZE, SUB_Y };
export type { InsertBox };

/** Состояние слоя для window.renderState шаблона (template/overlay.js, inserts.js). */
// у soft: lines — слов в строках блока, opens — блок начинает предложение (его первое слово шаблон пишет со строчной)
export type SubState = { words: string[]; active: number; visible: number; lines?: number[]; opens?: boolean; t?: number }; // t — с от появления новой строки soft
export type InsertState = {
  kind: SampleInsert['kind']; src?: string; text?: string; title?: string; x: number; y: number; w: number; anim: number; t: number;
  params?: Record<string, unknown>;
  key?: string; // ключ для рамки Павла (insertKey); шаблон его не читает
};
export type EndState = { lines: string[]; handle?: string; logo?: string; t: number }; // финальная карточка (t — с от её начала)
export type OverlayState = {
  sub?: SubState; hook?: { text: string }; cta?: { lines: string[]; word: string }; inserts: InsertState[]; end?: EndState;
  cover?: { text: string }; // обложка: хук крупно по центру кадра
  zone?: 'ads'; // версия для рекламы: текст и вставки выше кнопки и подписи рекламы
};

type Variant = StyleChoice['variant'];

/** spec выбранного варианта, в нём — шрифт, рукописный, три цвета Павла, высота и размер субтитров и хука, если он их менял;
 *  остальное — как у варианта. */
export function finalStyle(styles: Styles, c: StyleChoice): StyleSpec {
  const variant = styles.variants.find((v) => v.id === c.variant);
  if (!variant) throw new Error(`styles.json: нет варианта ${c.variant}`);
  const spec = structuredClone(variant.spec);
  spec.font = c.font;
  spec.hand = c.hand;
  spec.colors = { ...spec.colors, text: c.colors.text, accent: c.colors.accent, bar: c.colors.bar };
  if (c.subMode) spec.subtitles.mode = c.subMode;
  if (c.hookMode) spec.hook.mode = c.hookMode;
  if (c.barPos) spec.bar.pos = c.barPos;
  if (c.subShadeKind) spec.subtitles.shadeKind = c.subShadeKind;
  for (const key of ADJUSTABLE) {
    const x = c[key];
    if (x === undefined) continue;
    const { part, field } = ADJUST[key];
    (spec[part] as Record<string, unknown>)[field] = x;
  }
  return spec;
}

/** Сила затемнения, когда Павел выбирает его вид, а затемнение ещё выключено. */
export const SHADE_DEFAULT = 0.6;

/** Вид затемнения в стиле (нет поля — пятно). */
export const shadeKindOf = (spec: StyleSpec): ShadeKind => spec.subtitles.shadeKind ?? 'spot';

/** Выбор с видом затемнения `kind`: сила — та, что уже есть, а если затемнение выключено — SHADE_DEFAULT. */
export function withShadeKind(c: StyleChoice, kind: ShadeKind): StyleChoice {
  return { ...c, subShadeKind: kind, subShade: c.subShade && c.subShade > 0 ? c.subShade : SHADE_DEFAULT };
}

/** То, что Павел выбрал сам (места, размеры, затемнение и его вид, вид субтитров и слов в группе), — при смене варианта
 *  остаётся. */
export function ownAdjustments(c: StyleChoice): Partial<StyleChoice> {
  return {
    ...Object.fromEntries(ADJUSTABLE.filter((k) => c[k] !== undefined).map((k) => [k, c[k]])),
    ...(c.subShadeKind ? { subShadeKind: c.subShadeKind } : {}),
    ...(c.subMode ? { subMode: c.subMode } : {}),
    ...(c.hookMode ? { hookMode: c.hookMode } : {}),
    ...(c.barPos ? { barPos: c.barPos } : {}),
  };
}

/** Центр хука по высоте, если в стиле не задан (HOOK_Y шаблона, template/overlay.js). */
export const HOOK_Y_DEFAULT = 400;

/** Новый стиль из редактора поверх стиля ролика — как его сложит монтаж (merge_style движка, `vm style --onto`): `base` —
 *  стиль по прошлому выбору Павла, `ours` — стиль ролика (edit.json: тот выбор и правки текстом), `theirs` — по новому
 *  выбору. Что Павел поменял (base ≠ theirs) — из theirs, остальное — как в ours. Общая фикстура style-merge.json (merge). */
export function mergeStyle<T>(base: T, ours: T, theirs: T): T {
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (!isObj(base) || !isObj(ours) || !isObj(theirs)) return structuredClone(theirs);
  const out: Record<string, unknown> = structuredClone(ours);
  for (const key of new Set([...Object.keys(base), ...Object.keys(theirs)])) {
    const b = base[key];
    const o = ours[key];
    const t = theirs[key];
    if (isObj(b) && isObj(o) && isObj(t)) out[key] = mergeStyle(b, o, t);
    else if (!sameJson(b, t)) {
      if (!(key in theirs)) delete out[key];
      else out[key] = structuredClone(t);
    }
  }
  return out as T;
}

/** Значение, которое Павел тянет на превью, — внутри пределов ADJUST, с его шагом (10 px места, 2 px размера, 5 %
 *  пятна); дробный шаг — без хвоста двоичных дробей (0.6, а не 0.6000000000000001). */
export function clampTo(key: Adjustable, x: number): number {
  const { range, step } = ADJUST[key];
  return Math.min(range.max, Math.max(range.min, Number((Math.round(x / step) * step).toFixed(6))));
}
/** Субтитры или хук — что тянут на кадре (ручкой на «Превью» и в редакторе). */
export type TextPart = 'sub' | 'hook';
/** Место и размер субтитров или хука в стиле — от них тянет ручка (центр блока субтитров, центр строки хука капсом — так
 *  их ставит шаблон; у хука без места — HOOK_Y_DEFAULT) и их пределы (ADJUST). */
export function textPlace(spec: StyleSpec, part: TextPart) {
  return part === 'sub' ? { y: spec.subtitles.y, size: spec.subtitles.size, range: SUB_Y, sizes: SUB_SIZE }
    : { y: spec.hook.y ?? HOOK_Y_DEFAULT, size: spec.hook.size, range: HOOK_Y, sizes: HOOK_SIZE };
}
/** Выбор с новым местом и/или размером субтитров или хука — с шагом и в пределах ADJUST (как ползунки «Стиля»). */
export function placeText(c: StyleChoice, part: TextPart, to: { y?: number; size?: number }): StyleChoice {
  const [yk, sk] = part === 'sub' ? (['subY', 'subSize'] as const) : (['hookY', 'hookSize'] as const);
  return { ...c, ...(to.y !== undefined ? { [yk]: clampTo(yk, to.y) } : {}), ...(to.size !== undefined ? { [sk]: clampTo(sk, to.size) } : {}) };
}
export const clampSubY = (y: number): number => clampTo('subY', y);
/** Субтитры ниже безопасной зоны Reels (низ рамки ниже 1530): там их может закрыть подпись к ролику — страница скажет. */
export const underCaption = (b: { y: number; h: number } | null | undefined): boolean => !!b && b.y + b.h > INSERT_ZONE.y1;
export const clampHookY = (y: number): number => clampTo('hookY', y);
export const clampSubSize = (size: number): number => clampTo('subSize', size);
export const clampHookSize = (size: number): number => clampTo('hookSize', size);
export const clampSubShade = (shade: number): number => clampTo('subShade', shade);

/** Выбор «как у варианта»: его шрифты и цвета (смена варианта сбрасывает выбор к ним). */
export function choiceFor(styles: Styles, variant: Variant): StyleChoice {
  const spec = (styles.variants.find((v) => v.id === variant) ?? styles.variants[0]).spec;
  return { variant, font: spec.font, hand: spec.hand, colors: { text: spec.colors.text, accent: spec.colors.accent, bar: spec.colors.bar } };
}

/** «Мой стиль» бренда на этой задаче: его вариант (нет такого — A), шрифты — если в них есть все буквы ролика
 *  (`styles.fonts`), иначе — шрифты варианта; цвета, места, размеры и вид — его. */
export function brandChoice(styles: Styles, mine: StyleChoice): StyleChoice {
  const variant = styles.variants.some((v) => v.id === mine.variant) ? mine.variant : 'A';
  const base = choiceFor(styles, variant);
  const fits = (id: string, kind: 'main' | 'hand') => !styles.fonts?.[kind]?.length || styles.fonts[kind].includes(id);
  return { ...mine, variant, font: fits(mine.font, 'main') ? mine.font : base.font, hand: fits(mine.hand, 'hand') ? mine.hand : base.hand };
}

/** Шрифты, которые можно предложить Павлу: те, где есть все буквы ролика (`styles.fonts`); поля нет или список
 *  пуст — все этого вида (без кнопок Павлу нечего выбрать). */
export function allowedFonts<T extends { id: string; kind: 'main' | 'hand' }>(list: T[], styles: Styles): T[] {
  const ok = styles.fonts;
  const ids = (kind: 'main' | 'hand') => (ok && ok[kind].length ? ok[kind] : null);
  return list.filter((f) => ids(f.kind)?.includes(f.id) ?? true);
}

/** Цвета из макета «3 · Три превью»; плюс «Свой» — выбор любого цвета. */
export const SWATCHES = {
  accent: [
    { color: '#EDE4C1', name: 'Шампань' }, { color: '#FFD23F', name: 'Жёлтый' }, { color: '#7CF2B0', name: 'Мятный' }, { color: '#FF5C8A', name: 'Розовый' },
    { color: '#5CC8FF', name: 'Голубой' }, { color: '#B892FF', name: 'Сиреневый' },
  ],
  text: [{ color: '#FFFFFF', name: 'Белый' }, { color: '#FFF1C2', name: 'Кремовый' }, { color: '#DDF7FF', name: 'Холодный белый' }],
  bar: [{ color: '#EDE4C1', name: 'Шампань' }, { color: '#FFD23F', name: 'Жёлтый' }, { color: '#FFFFFF', name: 'Белый' }, { color: '#7CF2B0', name: 'Мятный' }, { color: '#FF5C8A', name: 'Розовый' }],
} as const;

// ---------- образец слоя на кадре ----------

const PHRASE_ENDS = ['.', '?', '!', '…'];
const CLOSING = /[»"')\]]+$/;
const ACCUMULATE_BLOCK = 6;
const SOFT_LINES = 2; // строк в блоке soft

const endsPhrase = (word: string): boolean => PHRASE_ENDS.some((end) => word.replace(CLOSING, '').endsWith(end));

/** `total` слов — в `ceil(total / per)` ровных кусков: сколько слов в каждом (как _balanced и _line_counts движка). */
const evenCounts = (total: number, per: number): number[] => {
  const n = Math.ceil(total / per);
  return Array.from({ length: n }, (_, k) => Math.floor(((k + 1) * total) / n) - Math.floor((k * total) / n));
};

/** Слов в группе субтитров на экране: накопление — блок, «по слову» — одно, soft — две строки, остальные — строка. */
export function subGroupSize(spec: StyleSpec): number {
  const mode = spec.subtitles.mode;
  const perLine = Math.max(1, Math.trunc(spec.subtitles.words) || 1);
  return mode === 'accumulate' ? ACCUMULATE_BLOCK : mode === 'word' ? 1 : mode === 'soft' ? SOFT_LINES * perLine : perLine;
}

/**
 * Состояние слоя для кадра превью. Субтитры — как build_sub_events движка: слова образца делятся на фразы по
 * `.?!…` (пауз в образце нет), фраза — на `n = ceil(L/N)` ровных кусков; берётся кусок со словом `spoken`. У soft кусок
 * — блок до 2·N слов, его строки — ровные куски не длиннее N слов; на превью виден весь блок.
 */
export function sampleState(spec: StyleSpec, sample: Styles['sample'], hook: string | null, inserts: InsertState[]): OverlayState {
  const state: OverlayState = { inserts };
  const words = sample.words ?? [];
  if (words.length) {
    const phrases: number[][] = [];
    words.forEach((_, i) => {
      if (i === 0 || endsPhrase(words[i - 1])) phrases.push([i]);
      else phrases[phrases.length - 1].push(i);
    });
    const spoken = Math.min(Math.max(0, Math.trunc(sample.spoken) || 0), words.length - 1);
    const phrase = phrases.find((p) => p.includes(spoken)) ?? [spoken];
    const mode = spec.subtitles.mode;
    const perLine = Math.max(1, Math.trunc(spec.subtitles.words) || 1);
    const size = subGroupSize(spec);
    const total = phrase.length;
    const count = Math.ceil(total / size);
    for (let k = 0; k < count; k++) {
      const chunk = phrase.slice(Math.floor((k * total) / count), Math.floor(((k + 1) * total) / count));
      if (!chunk.includes(spoken)) continue;
      const active = chunk.indexOf(spoken);
      if (mode === 'soft') {
        const opens = chunk[0] === 0 || endsPhrase(words[chunk[0] - 1]);
        state.sub = { words: chunk.map((i) => words[i]), active: 0, visible: chunk.length, lines: evenCounts(chunk.length, perLine), opens };
        break;
      }
      state.sub = { words: chunk.map((i) => words[i]), active, visible: mode === 'accumulate' ? active + 1 : chunk.length };
      break;
    }
  }
  if (hook) state.hook = { text: hook };
  return state;
}

/**
 * Вставки образца по ответам: вставка вопроса — по выбранному варианту (`none` или нет выбора — нет; своя картинка —
 * локальный адрес файла, пока страница его помнит; вариант с картинкой — она; без картинки — решит монтаж);
 * вставка без вопроса — как есть. Все — уже появились (`anim` 1).
 */
export function resolveInserts(sample: Styles['sample'], qs: Question[], d: Draft, urlFor: (path: string) => string,
  localUrl: (qid: string) => string | null, boxes: Record<string, InsertBox> = {}): InsertState[] {
  const out: InsertState[] = [];
  for (const s of placedInserts(sample.inserts ?? [], boxes)) {
    if (s.id && unticked(s.id, qs, d)) continue;
    const key = insertKey(s);
    const base: InsertState = { kind: s.kind, x: s.x, y: s.y, w: s.w, anim: 1, t: 0, ...(key ? { key } : {}) };
    if (s.text !== undefined) base.text = s.text;
    if (s.title !== undefined) base.title = s.title;
    if (s.params !== undefined) base.params = s.params;
    if (!s.question) {
      out.push(s.src ? { ...base, src: urlFor(s.src) } : base);
      continue;
    }
    const q = qs.find((x) => x.id === s.question);
    const id = q ? chosen(q, d) : undefined;
    if (!q || !id || id === RESERVED.none) continue;
    if (id === RESERVED.upload) {
      const url = localUrl(q.id);
      if (url) out.push({ ...base, src: url });
      continue;
    }
    const image = q.options?.find((o) => o.id === id)?.image;
    if (image) out.push({ ...base, src: urlFor(image) });
  }
  return out;
}

/** Стикер `id` снят в вопросе `stickers` (как его читает шаг render; варианты других вопросов могут иметь те же id). */
function unticked(id: string, qs: Question[], d: Draft): boolean {
  const q = qs.find((x) => x.id === 'stickers' && x.type === 'multi');
  if (!q || !(q.options ?? []).some((o) => o.id === id)) return false;
  const picked = d.picks[q.id] ?? (Array.isArray(q.default) ? q.default : q.default === undefined ? [] : [q.default]);
  return !picked.includes(id);
}

// ---------- место и размер вставок (localStorage['vm:inserts:<id>']) ----------

/** Ключ вставки для рамки Павла: её question («добавь сюда»), иначе src, иначе id (стикер-тезис); ничего — null. */
export function insertKey(s: { question?: string; src?: string; id?: string }): string | null {
  return s.question || s.src || s.id || null;
}

/** Вставки с рамками, которые выбрал Павел (как есть). То же правило — placed_inserts в engine/vm/style.py
 *  (общая фикстура engine/tests/fixtures/insert-boxes.json). */
export function placedInserts<T extends { x?: number; y?: number; w?: number; question?: string; src?: string; id?: string }>(
  list: T[], boxes: Record<string, InsertBox>): T[] {
  return list.map((s) => {
    const key = insertKey(s);
    const box = key ? boxes[key] : undefined;
    return box && s.x !== undefined && s.w !== undefined ? { ...s, x: box.x, y: box.y, w: box.w } : { ...s };
  });
}

const within = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), Math.max(lo, hi)));

/** Поля рамки от шаблона вокруг вставки — тень или обводка, px кадра: на сколько нарисованное выходит за её x, y, w. */
export type BoxExt = { left: number; top: number; right: number };
const NO_EXT: BoxExt = { left: 0, top: 0, right: 0 };

/** Новая ширина вставки (шагом 10 px, в пределах INSERT_W): центр по горизонтали и верх остаются, рамка — в безопасной
 *  зоне. `h` — нынешняя высота вставки, px кадра (по ней — высота после растяжения); `ext` — поля её тени: в зоне тогда
 *  вся нарисованная рамка, как её проверяет монтаж. */
export function resizeBox(b: InsertBox, width: number, h: number, ext: BoxExt = NO_EXT): InsertBox {
  const w = Math.min(INSERT_W.max, Math.max(INSERT_W.min, Math.round(width / 10) * 10));
  const tall = b.w > 0 ? (h * w) / b.w : h;
  return {
    x: within(b.x + (b.w - w) / 2, INSERT_ZONE.x0 + ext.left, INSERT_ZONE.x1 - w - ext.right),
    y: within(b.y, INSERT_ZONE.y0 + ext.top, INSERT_ZONE.y1 - tall + ext.top),
    w,
  };
}

/** Рамка, перетащенная в (x, y): в безопасной зоне целиком; `h` — высота вставки, px кадра; `ext` — поля её тени. */
export function moveBox(b: InsertBox, x: number, y: number, h: number, ext: BoxExt = NO_EXT): InsertBox {
  return {
    x: within(x, INSERT_ZONE.x0 + ext.left, INSERT_ZONE.x1 - b.w - ext.right), y: within(y, INSERT_ZONE.y0 + ext.top, INSERT_ZONE.y1 - h + ext.top), w: b.w,
  };
}

/** Центр акцента, перетащенный в (x, y): его блок (рамка от шаблона размером `box` — вокруг центра) — в безопасной зоне,
 *  той же, что у вставок; блок шире или выше зоны — посередине неё (шаблон сам впишет его в зону). Центр — целые px, в
 *  пределах схемы timeline.json (LIMITS.accentAt). */
export function moveCentre(box: { w: number; h: number }, x: number, y: number): { x: number; y: number } {
  const fit = (v: number, lo: number, hi: number) => Math.round(lo <= hi ? Math.min(Math.max(v, lo), hi) : (lo + hi) / 2);
  return {
    x: fit(x, INSERT_ZONE.x0 + box.w / 2, INSERT_ZONE.x1 - box.w / 2),
    y: fit(y, INSERT_ZONE.y0 + box.h / 2, INSERT_ZONE.y1 - box.h / 2),
  };
}

const insertsKey = (jobId: string): string => `vm:inserts:${jobId}`;

export function loadInsertBoxes(storage: Storage | null, jobId: string): Record<string, InsertBox> {
  try {
    const raw = JSON.parse(storage?.getItem(insertsKey(jobId)) ?? '{}') as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([k, b]) => k !== '' && isInsertBox(b))) as Record<string, InsertBox>;
  } catch {
    return {};
  }
}

export function saveInsertBoxes(storage: Storage | null, jobId: string, boxes: Record<string, InsertBox>): void {
  try {
    storage?.setItem(insertsKey(jobId), JSON.stringify(boxes));
  } catch {
    // нет хранилища — рамки живут до перезагрузки
  }
}

// ---------- скорость ролика (localStorage['vm:speed:<id>']) ----------

/** Кнопки скорости на экране превью: ×1.0–×1.5; по правилам монтажа — ×1.1. */
export const SPEEDS = [1, 1.1, 1.2, 1.3, 1.4, 1.5];
export const DEFAULT_SPEED = 1.1;
const speedKey = (jobId: string): string => `vm:speed:${jobId}`;

/** Скорость с превью; не выбирал — `fallback` («Мой стиль» бренда), иначе ×1,1. */
export function loadSpeed(storage: Storage | null, jobId: string, fallback?: number): number {
  const start = fallback !== undefined && SPEEDS.includes(fallback) ? fallback : DEFAULT_SPEED;
  try {
    const raw = storage?.getItem(speedKey(jobId));
    const value = Number(raw);
    return raw && SPEEDS.includes(value) ? value : start;
  } catch {
    return start;
  }
}

export function saveSpeed(storage: Storage | null, jobId: string, speed: number): void {
  try {
    storage?.setItem(speedKey(jobId), String(speed));
  } catch {
    // нет хранилища — выбор живёт до перезагрузки
  }
}

// ---------- версия для рекламы (localStorage['vm:ad:<id>']) ----------

const adKey = (jobId: string): string => `vm:ad:${jobId}`;

export function loadAd(storage: Storage | null, jobId: string): boolean {
  try {
    return storage?.getItem(adKey(jobId)) === '1';
  } catch {
    return false;
  }
}

export function saveAd(storage: Storage | null, jobId: string, on: boolean): void {
  try {
    if (on) storage?.setItem(adKey(jobId), '1');
    else storage?.removeItem(adKey(jobId));
  } catch {
    // нет хранилища — выбор живёт до перезагрузки
  }
}

// ---------- обложка (localStorage['vm:cover:<id>']) ----------

const coverKey = (jobId: string): string => `vm:cover:${jobId}`;

/** Выбор обложки в браузере: кадр и текст — если Павел его правил (нет поля или пусто — текст идёт за хуком). */
export type CoverPick = { frame: number; text?: string };

function isCoverPick(c: unknown): c is CoverPick {
  if (typeof c !== 'object' || c === null) return false;
  const { frame, text } = c as Record<string, unknown>;
  return Number.isInteger(frame) && (frame as number) >= 0 && (frame as number) < COVER.frames
    && (text === undefined || (typeof text === 'string' && text.length <= COVER.text));
}

export function loadCover(storage: Storage | null, jobId: string): CoverPick | null {
  try {
    const raw = storage?.getItem(coverKey(jobId));
    const value: unknown = raw ? JSON.parse(raw) : null;
    return isCoverPick(value) ? { frame: value.frame, ...(value.text !== undefined ? { text: value.text } : {}) } : null;
  } catch {
    return null;
  }
}

/** Что на обложке: выбранный кадр (такого нет — первый) и текст — свой текст Павла, иначе хук, который он выбрал,
 *  иначе предложение Claude (`styles.cover.text`); длиннее обложки (80 знаков) текст не берётся. Обложки нет — null. */
export function coverOf(pick: CoverPick | null, styles: Styles, hook: string | null): CoverChoice | null {
  if (!styles.cover) return null;
  const fits = (t: string | null | undefined): string | null => {
    const x = (t ?? '').trim();
    return x && x.length <= COVER.text ? x : null;
  };
  return { frame: pick && pick.frame < styles.cover.frames.length ? pick.frame : 0, text: fits(pick?.text) ?? fits(hook) ?? styles.cover.text };
}

export function saveCover(storage: Storage | null, jobId: string, cover: CoverPick): void {
  try {
    storage?.setItem(coverKey(jobId), JSON.stringify(cover));
  } catch {
    // нет хранилища — выбор живёт до перезагрузки
  }
}

// ---------- вторая версия для A/B-теста (localStorage['vm:ab:<id>']) ----------

const abKey = (jobId: string): string => `vm:ab:${jobId}`;

export function loadAb(storage: Storage | null, jobId: string): AbKind | null {
  try {
    const value = storage?.getItem(abKey(jobId));
    return (AB_KINDS as readonly (string | null | undefined)[]).includes(value) ? (value as AbKind) : null;
  } catch {
    return null;
  }
}

export function saveAb(storage: Storage | null, jobId: string, ab: AbKind | null): void {
  try {
    if (ab) storage?.setItem(abKey(jobId), ab);
    else storage?.removeItem(abKey(jobId));
  } catch {
    // нет хранилища — выбор живёт до перезагрузки
  }
}

// ---------- запомненный выбор (localStorage['vm:style:<id>']) ----------

const choiceKey = (jobId: string): string => `vm:style:${jobId}`;
const signature = (styles: Styles): string => JSON.stringify(styles.variants);
const COLOR = /^#[0-9A-Fa-f]{6}$/;

function isChoice(x: unknown, styles: Styles): x is StyleChoice {
  const c = x as StyleChoice;
  return typeof c === 'object' && c !== null && styles.variants.some((v) => v.id === c.variant) && typeof c.font === 'string' && c.font !== ''
    && typeof c.hand === 'string' && c.hand !== '' && typeof c.colors === 'object' && c.colors !== null
    && ['text', 'accent', 'bar'].every((k) => COLOR.test(String((c.colors as Record<string, unknown>)[k])))
    && ADJUSTABLE.every((key) => c[key] === undefined || inRange(key, c[key])) && (c.subMode === undefined || isSubMode(c.subMode))
    && (c.hookMode === undefined || isHookMode(c.hookMode)) && (c.barPos === undefined || isBarPos(c.barPos))
    && (c.subShadeKind === undefined || isShadeKind(c.subShadeKind))
    && [['main', c.font], ['hand', c.hand]].every(([kind, id]) => {
      const ids = styles.fonts?.[kind as 'main' | 'hand'];
      return !ids?.length || ids.includes(id);
    });
}

export function saveChoice(storage: Storage | null, jobId: string, styles: Styles, c: StyleChoice): void {
  try {
    storage?.setItem(choiceKey(jobId), JSON.stringify({ sig: signature(styles), choice: c }));
  } catch {
    // нет хранилища — выбор живёт до перезагрузки
  }
}

/** Выбор для этих вариантов; варианты другие («Ещё три варианта»), выбора нет или он битый — вариант A как есть. */
export function loadChoice(storage: Storage | null, jobId: string, styles: Styles, mine?: StyleChoice | null): StyleChoice {
  const own = mine ? brandChoice(styles, mine) : null; // «Мой стиль» бренда — с него и начинать
  const fallback = own && isChoice(own, styles) ? own : choiceFor(styles, 'A');
  try {
    const raw = JSON.parse(storage?.getItem(choiceKey(jobId)) ?? 'null') as { sig?: unknown; choice?: unknown } | null;
    return raw?.sig === signature(styles) && isChoice(raw.choice, styles) ? raw.choice : fallback;
  } catch {
    return fallback;
  }
}
