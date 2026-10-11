// Стиль на экране превью: итоговый StyleSpec по выбору Павла (то же правило, что final_style движка), образец
// состояния слоя на кадре (субтитры — по правилу build_sub_events), вставки по ответам и запомненный выбор.
import { chosen, type Draft } from './answers.ts';
import { AB_KINDS, ADJUST, COVER, type CoverChoice, ADJUSTABLE, HOOK_SIZE, HOOK_Y, INSERT_W, INSERT_ZONE, inRange, isInsertBox, RESERVED, SUB_SIZE, SUB_Y, type AbKind, type Adjustable, type InsertBox, type Question, type SampleInsert, type StyleChoice, type StyleSpec, type Styles } from './jobfiles.ts';

export { HOOK_SIZE, HOOK_Y, INSERT_W, SUB_SIZE, SUB_Y };
export type { InsertBox };

/** Состояние слоя для window.renderState шаблона (template/overlay.js, inserts.js). */
export type SubState = { words: string[]; active: number; visible: number };
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
  for (const key of ADJUSTABLE) {
    const x = c[key];
    if (x === undefined) continue;
    const { part, field } = ADJUST[key];
    (spec[part] as Record<string, unknown>)[field] = x;
  }
  return spec;
}

/** Значение, которое Павел тянет на превью, — внутри пределов ADJUST, с его шагом (10 px места, 2 px размера). */
export function clampTo(key: Adjustable, x: number): number {
  const { range, step } = ADJUST[key];
  return Math.min(range.max, Math.max(range.min, Math.round(x / step) * step));
}
export const clampSubY = (y: number): number => clampTo('subY', y);
/** Субтитры ниже безопасной зоны Reels (низ рамки ниже 1530): там их может закрыть подпись к ролику — страница скажет. */
export const underCaption = (b: { y: number; h: number } | null | undefined): boolean => !!b && b.y + b.h > INSERT_ZONE.y1;
export const clampHookY = (y: number): number => clampTo('hookY', y);
export const clampSubSize = (size: number): number => clampTo('subSize', size);
export const clampHookSize = (size: number): number => clampTo('hookSize', size);

/** Выбор «как у варианта»: его шрифты и цвета (смена варианта сбрасывает выбор к ним). */
export function choiceFor(styles: Styles, variant: Variant): StyleChoice {
  const spec = (styles.variants.find((v) => v.id === variant) ?? styles.variants[0]).spec;
  return { variant, font: spec.font, hand: spec.hand, colors: { text: spec.colors.text, accent: spec.colors.accent, bar: spec.colors.bar } };
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
    { color: '#FFD23F', name: 'Жёлтый' }, { color: '#7CF2B0', name: 'Мятный' }, { color: '#FF5C8A', name: 'Розовый' },
    { color: '#5CC8FF', name: 'Голубой' }, { color: '#B892FF', name: 'Сиреневый' },
  ],
  text: [{ color: '#FFFFFF', name: 'Белый' }, { color: '#FFF1C2', name: 'Кремовый' }, { color: '#DDF7FF', name: 'Холодный белый' }],
  bar: [{ color: '#FFD23F', name: 'Жёлтый' }, { color: '#FFFFFF', name: 'Белый' }, { color: '#7CF2B0', name: 'Мятный' }, { color: '#FF5C8A', name: 'Розовый' }],
} as const;

// ---------- образец слоя на кадре ----------

const PHRASE_ENDS = ['.', '?', '!', '…'];
const CLOSING = /[»"')\]]+$/;
const ACCUMULATE_BLOCK = 6;

const endsPhrase = (word: string): boolean => PHRASE_ENDS.some((end) => word.replace(CLOSING, '').endsWith(end));

/**
 * Состояние слоя для кадра превью. Субтитры — как build_sub_events движка: слова образца делятся на фразы по
 * `.?!…` (пауз в образце нет), фраза — на `n = ceil(L/N)` ровных кусков; берётся кусок со словом `spoken`.
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
    const size = mode === 'accumulate' ? ACCUMULATE_BLOCK : mode === 'word' ? 1 : Math.max(1, Math.trunc(spec.subtitles.words) || 1);
    const total = phrase.length;
    const count = Math.ceil(total / size);
    for (let k = 0; k < count; k++) {
      const chunk = phrase.slice(Math.floor((k * total) / count), Math.floor(((k + 1) * total) / count));
      if (!chunk.includes(spoken)) continue;
      const active = chunk.indexOf(spoken);
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

/** Новая ширина вставки (шагом 10 px, в пределах INSERT_W): центр по горизонтали и верх остаются, рамка — в безопасной
 *  зоне. `h` — нынешняя высота вставки, px кадра (по ней — высота после растяжения). */
export function resizeBox(b: InsertBox, width: number, h: number): InsertBox {
  const w = Math.min(INSERT_W.max, Math.max(INSERT_W.min, Math.round(width / 10) * 10));
  const tall = b.w > 0 ? (h * w) / b.w : h;
  return {
    x: within(b.x + (b.w - w) / 2, INSERT_ZONE.x0, INSERT_ZONE.x1 - w),
    y: within(b.y, INSERT_ZONE.y0, INSERT_ZONE.y1 - tall),
    w,
  };
}

/** Рамка, перетащенная в (x, y): в безопасной зоне целиком; `h` — высота вставки, px кадра. */
export function moveBox(b: InsertBox, x: number, y: number, h: number): InsertBox {
  return { x: within(x, INSERT_ZONE.x0, INSERT_ZONE.x1 - b.w), y: within(y, INSERT_ZONE.y0, INSERT_ZONE.y1 - h), w: b.w };
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

export function loadSpeed(storage: Storage | null, jobId: string): number {
  try {
    const value = Number(storage?.getItem(speedKey(jobId)));
    return SPEEDS.includes(value) ? value : DEFAULT_SPEED;
  } catch {
    return DEFAULT_SPEED;
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
    && ADJUSTABLE.every((key) => c[key] === undefined || inRange(key, c[key]))
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
export function loadChoice(storage: Storage | null, jobId: string, styles: Styles): StyleChoice {
  const fallback = choiceFor(styles, 'A');
  try {
    const raw = JSON.parse(storage?.getItem(choiceKey(jobId)) ?? 'null') as { sig?: unknown; choice?: unknown } | null;
    return raw?.sig === signature(styles) && isChoice(raw.choice, styles) ? raw.choice : fallback;
  } catch {
    return fallback;
  }
}
