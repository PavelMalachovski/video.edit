// Стиль на экране превью: итоговый StyleSpec по выбору Павла (то же правило, что final_style движка), образец
// состояния слоя на кадре (субтитры — по правилу build_sub_events), вставки по ответам и запомненный выбор.
import { chosen, type Draft } from './answers.ts';
import { HOOK_Y, RESERVED, SUB_Y, type Question, type SampleInsert, type StyleChoice, type StyleSpec, type Styles } from './jobfiles.ts';

export { HOOK_Y, SUB_Y };

/** Состояние слоя для window.renderState шаблона (template/overlay.js, inserts.js). */
export type SubState = { words: string[]; active: number; visible: number };
export type InsertState = {
  kind: SampleInsert['kind']; src?: string; text?: string; title?: string; x: number; y: number; w: number; anim: number; t: number;
  params?: Record<string, unknown>;
};
export type OverlayState = { sub?: SubState; hook?: { text: string }; cta?: { lines: string[]; word: string }; inserts: InsertState[] };

type Variant = StyleChoice['variant'];

/** spec выбранного варианта, в нём — шрифт, рукописный, три цвета Павла и высота субтитров и хука, если он их перетащил;
 *  остальное — как у варианта. */
export function finalStyle(styles: Styles, c: StyleChoice): StyleSpec {
  const variant = styles.variants.find((v) => v.id === c.variant);
  if (!variant) throw new Error(`styles.json: нет варианта ${c.variant}`);
  const spec = structuredClone(variant.spec);
  spec.font = c.font;
  spec.hand = c.hand;
  spec.colors = { ...spec.colors, text: c.colors.text, accent: c.colors.accent, bar: c.colors.bar };
  if (c.subY !== undefined) spec.subtitles.y = c.subY;
  if (c.hookY !== undefined) spec.hook.y = c.hookY;
  return spec;
}

const clamp = (range: { min: number; max: number }, y: number) => Math.min(range.max, Math.max(range.min, Math.round(y / 10) * 10));

/** Высота субтитров при перетаскивании: внутри SUB_Y, шагом 10 px. */
export const clampSubY = (y: number): number => clamp(SUB_Y, y);

/** Высота хука при перетаскивании: внутри HOOK_Y, шагом 10 px. */
export const clampHookY = (y: number): number => clamp(HOOK_Y, y);

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
  localUrl: (qid: string) => string | null): InsertState[] {
  const out: InsertState[] = [];
  for (const s of sample.inserts ?? []) {
    const base: InsertState = { kind: s.kind, x: s.x, y: s.y, w: s.w, anim: 1, t: 0 };
    if (s.text !== undefined) base.text = s.text;
    if (s.title !== undefined) base.title = s.title;
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

// ---------- запомненный выбор (localStorage['vm:style:<id>']) ----------

const choiceKey = (jobId: string): string => `vm:style:${jobId}`;
const signature = (styles: Styles): string => JSON.stringify(styles.variants);
const COLOR = /^#[0-9A-Fa-f]{6}$/;

function isChoice(x: unknown, styles: Styles): x is StyleChoice {
  const c = x as StyleChoice;
  return typeof c === 'object' && c !== null && styles.variants.some((v) => v.id === c.variant) && typeof c.font === 'string' && c.font !== ''
    && typeof c.hand === 'string' && c.hand !== '' && typeof c.colors === 'object' && c.colors !== null
    && ['text', 'accent', 'bar'].every((k) => COLOR.test(String((c.colors as Record<string, unknown>)[k])))
    && (c.subY === undefined || (typeof c.subY === 'number' && c.subY >= SUB_Y.min && c.subY <= SUB_Y.max))
    && (c.hookY === undefined || (typeof c.hookY === 'number' && c.hookY >= HOOK_Y.min && c.hookY <= HOOK_Y.max))
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
