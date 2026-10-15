// Данные редактора (бета): черновик монтажа (edit.json), файлы редактора от vm prepare (editor.json), ссылки на прокси
// (ассет черновика релиза — через /media) и ленту кадров (картинка ветки — через /file), стили и выбор Павла. Правки
// руками — timeline.json: сохранение с ревизией (без force, гонка вкладок — конфликт) и «Монтировать» из редактора.
import { parseLook, type BrandLook } from './brand.ts';
import { commitFiles, listDir, readText } from './branch.ts';
import { badSymbols, hasEmoji, MUSIC_FILE, parseTimeline, typedTexts, type HandEdits, type TimelineFile } from './edits.ts';
import { sameJson } from './equal.ts';
import type { GH } from './github.ts';
import { appendFix, parseStyle, type AnswersFile, type FixFile, type Released, type StyleChoice, type Styles } from './jobfiles.ts';
import { jobBranch, jobDir } from './jobs.ts';
import { loadJob, readJobText, type Screen } from './jobview.ts';
import type { BeatsFile } from './beats.ts';
import { parseDraft, parseMedia, type Draft, type EditorMedia } from './tracks.ts';

/** Что редактор отдаёт плееру из релиза: только прокси (готовый ролик — через download). */
export const MEDIA_NAMES = ['proxy.mp4'] as const;
export type MediaName = (typeof MEDIA_NAMES)[number];
export const isMediaName = (x: string): x is MediaName => (MEDIA_NAMES as readonly string[]).includes(x);

/** Что из правок руками примет движок задачи: ветка задачи создаётся из master один раз, и сессия монтирует её движком
 *  своей поры — новых полей timeline.json старый движок не примет (схема без лишних полей). По схеме в ветке: `edits` —
 *  правки руками вообще (схемы нет — задача до редактора: её движок timeline.json не читает), `move` — перестановка
 *  кусков (фаза 4), `text` — текст и вставки, слова субтитров (фаза 5), `picture` — сила зума, ч/б-куски, переходы и
 *  затемнение фона, `track` — другой трек музыки, `card` — текст финальной карточки, `video` — скорость ролика и тизер,
 *  `place` — место вставок и акцентов на кадре (фаза 5в), `looks` — свои куски ч/б и фильтров Павла, края и фильтр
 *  кусков сессии. */
export type Abilities = {
  edits: boolean; move: boolean; text: boolean; picture: boolean; track: boolean; card: boolean; video: boolean; place: boolean;
  looks: boolean; // свои куски ч/б и фильтров, края и фильтр кусков сессии
};
export const ENGINE_SCHEMA = 'engine/vm/schemas/timeline.json';
const ALL: Abilities = { edits: true, move: true, text: true, picture: true, track: true, card: true, video: true, place: true, looks: true };
const NONE: Abilities = { edits: false, move: false, text: false, picture: false, track: false, card: false, video: false, place: false, looks: false };

/**
 * Что Павел правит в редакторе. `editable` — правки сохраняются (у задачи есть черновик, сессия не работает, её движок
 * правки знает); `mounted` — монтаж уже был (есть answers.json); `a` — что примет движок задачи. До монтажа — только то,
 * чего не выбирают «Превью» и вопросы: куски, сила зума (ложится на любой зум монтажа), громкости, куски с фильтром
 * (`looks`: свои куски Павла и правки кусков сессии держатся за их место). Скорость, затемнение фона, трек, тизер,
 * переходы (`marks`), текст, карточка и места на кадре — после него: до монтажа их выбирают ответы, и правка руками
 * молча перебила бы ответ или потеряла бы своё место.
 */
export function editorGates(editable: boolean, mounted: boolean, a: Abilities = ALL) {
  const after = editable && mounted;
  return {
    move: editable && a.move, zoom: editable && a.picture, marks: after && a.picture, track: after && a.track,
    // старый движок кусков руками не знает — только убрать и вернуть кусок сессии, после монтажа
    looks: editable && (a.looks || (mounted && a.picture)), lookHand: editable && a.looks,
    speed: after && a.video, teaser: after && a.video, text: after && a.text, card: after && a.card, place: after && a.text && a.place,
  };
}

/** Схема timeline.json из ветки задачи → что примет её движок. Схемы нет — ничего (задача до редактора); есть, но не
 *  читается — движок нынешний. */
export function abilitiesOf(schema: string | null): Abilities {
  if (schema === null) return NONE;
  try {
    const parsed = JSON.parse(schema) as { properties: Record<string, unknown>; $defs?: { Music?: { properties?: object } } };
    const props = parsed.properties;
    const text = (props.text as { properties?: Record<string, { items?: { properties?: object } }> } | undefined)?.properties ?? {};
    const ops = ((props.edits as { items: { oneOf: { properties: { op: { const: string } } }[] } }).items.oneOf).map((o) => o.properties.op.const);
    return {
      edits: true, move: ops.includes('move'), text: 'text' in props && 'words' in props, picture: ['zoom', 'looks', 'transitions', 'dim'].every((k) => k in props),
      track: 'file' in (parsed.$defs?.Music?.properties ?? {}), card: 'end' in text, video: 'teaser' in props && 'speed' in props,
      place: 'x' in (text.inserts?.items?.properties ?? {}),
      looks: 't0' in ((props.looks as { items?: { properties?: object } } | undefined)?.items?.properties ?? {}),
    };
  } catch {
    return ALL;
  }
}

/** Чего из правок `hand` движок задачи не примет — текст ошибки; всё примет — null. */
export function refusedBy(a: Abilities, hand: HandEdits): string | null {
  if (!a.edits) return 'Эта задача создана до редактора: её движок правок руками не знает — ролик здесь правится через «Поправить»';
  if (!a.move && hand.edits.some((e) => e.op === 'move')) return 'Эта задача создана до перестановки кусков: её движок их не примет — куски переставляются в новых задачах';
  if (!a.text && (hand.text || hand.words)) return 'Эта задача создана до правок текста в редакторе: её движок их не примет — текст здесь правится через «Поправить»';
  if (!a.picture && (hand.zoom !== undefined || hand.looks || hand.transitions || hand.dim !== undefined)) {
    return 'Эта задача создана до правок картинки в редакторе: её движок их не примет — зум, ч/б, переходы и фон здесь правятся через «Поправить»';
  }
  if (!a.looks && hand.looks?.some((f) => f.at === undefined || f.t0 !== undefined || f.look !== undefined)) {
    return 'Эта задача создана до своих кусков ч/б и фильтров: её движок их не примет — в ней куски только убираются и возвращаются';
  }
  if (!a.track && hand.music?.file !== undefined) return 'Эта задача создана до выбора трека в редакторе: её движок его не примет — трек здесь меняется через «Поправить»';
  if (!a.card && hand.text?.end) return 'Эта задача создана до правок финальной карточки в редакторе: её движок их не примет — карточка здесь правится через «Поправить»';
  if (!a.video && (hand.teaser !== undefined || hand.speed !== undefined)) {
    return 'Эта задача создана до правок скорости и тизера в редакторе: её движок их не примет — они здесь меняются через «Поправить»';
  }
  const placed = [...(hand.text?.accents ?? []), ...(hand.text?.inserts ?? [])].some((f) => f.x !== undefined || f.y !== undefined || ('w' in f && f.w !== undefined));
  if (!a.place && placed) {
    return 'Эта задача создана до перетаскивания вставок и акцентов в редакторе: её движок их места не примет — место здесь меняется через «Поправить»';
  }
  return null;
}

export type EditorData = {
  id: string;
  abilities: Abilities; // что из правок руками примет движок задачи
  title: string;
  screen: Screen;
  head: string | null;
  draft: Draft | null;
  media: EditorMedia | null;
  proxyUrl: string | null; // прокси уже в релизе (Action перенёс)
  filmUrl: string | null;
  styles: Styles | null;
  answers: AnswersFile | null;
  timeline: TimelineFile | null; // правки руками (нет или кривой файл — null)
  beats: BeatsFile | null; // доли музыки (beats.json от vm render): вставки и зум встают на них, как в ролике
  library: string[]; // треки библиотеки в ветке задачи (assets/music/…): другой трек — из них
  rev: number; // ревизия timeline.json в ветке (нет — 0): от неё сохраняется следующая
  brandLook: BrandLook | null; // «Мой стиль» из копии бренда задачи: до монтажа стиль начинается с него, как на «Превью»
  // пока Claude монтирует новый стиль из редактора (или этот монтаж сорвался) — прошлый выбор (fix.json, styleFrom): ролик
  // ещё в нём, и новый ляжет поверх него (vm style --onto); иначе — null
  styleFrom: StyleChoice | null;
};

const MUSIC_DIR = 'assets/music';
/** Треки библиотеки в ветке задачи на `head` (пути от корня, по алфавиту); папки нет — пусто. */
async function musicLibrary(gh: GH, head: string): Promise<string[]> {
  const entries = (await listDir(gh, head, MUSIC_DIR)) ?? [];
  return entries.filter((e) => e.type === 'file').map((e) => `${MUSIC_DIR}/${e.name}`).filter((p) => MUSIC_FILE.test(p)).sort();
}

/** Картинка загрузки Павла (вставка к ролику `upload-i<n>`, картинка к ответу `upload-q-…`) — её отдаёт /upload. */
export const isUploadPicture = (name: string): boolean => /^upload-(i\d{1,3}|q-[a-z0-9_-]{1,41})\.(png|jpe?g|webp|gif)$/.test(name);

/** Ассеты картинки загрузки `name` по порядку: целый ассет или куски `<name>.part-NNNNN` (так их кладёт загрузка — и из
 *  одного куска); нет первого куска или пропуск в середине — null. */
export function uploadParts<T extends { name: string }>(assets: readonly T[], name: string): T[] | null {
  const whole = assets.find((a) => a.name === name);
  if (whole) return [whole];
  const parts = new Map<number, T>();
  for (const a of assets) {
    const m = a.name.startsWith(`${name}.part-`) ? /\.part-(\d{5})$/.exec(a.name) : null;
    if (m) parts.set(Number(m[1]), a);
  }
  if (!parts.size) return null;
  const out: T[] = [];
  for (let i = 0; i < parts.size; i++) {
    const p = parts.get(i);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

const PICTURE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
/** Тип картинки загрузки по расширению — для склеенных кусков (у ассета GitHub его нет). */
export const pictureType = (name: string): string => PICTURE_TYPES[/\.([a-z]+)$/.exec(name)?.[1] ?? ''] ?? 'application/octet-stream';

/** Адрес картинки слоя (вставка, логотип карточки — путь от папки задачи или от корня репозитория, как в edit.json) для
 *  шаблона в редакторе: загрузки Павла (in/uploads/…) — из черновика релиза, остальное — из ветки (как render._resolve). */
export function layerUrl(id: string, head: string | null, path: string): string {
  const upload = /^in\/uploads\/([^/]+)$/.exec(path)?.[1];
  if (upload && isUploadPicture(upload)) return `/api/jobs/${id}/upload?name=${encodeURIComponent(upload)}`;
  return `/api/jobs/${id}/file?path=${encodeURIComponent(path)}${head ? `&v=${head}` : ''}`;
}

/** Ассет `name` из out/released.json ветки; не файл редактора или его нет — null. */
export function mediaAsset(files: { released: Released | null } | null, name: string): { id: number; name: string } | null {
  if (!isMediaName(name)) return null;
  return files?.released?.assets.find((a) => a.name === name) ?? null;
}

const json = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export async function loadEditor(gh: GH, id: string): Promise<EditorData | null> {
  const loaded = await loadJob(gh, id, 'all');
  if (!loaded) return null;
  const f = loaded.files;
  const head = f?.head ?? null;
  const [edit, editor, timeline, beats, schema] = head
    ? await Promise.all([...['edit.json', 'editor.json', TIMELINE, 'beats.json'].map((name) => readJobText(gh, id, head, name)), readText(gh, head, ENGINE_SCHEMA)])
    : [null, null, null, null, null];
  const library = head ? await musicLibrary(gh, head) : [];
  const media = parseMedia(json(editor));
  return {
    id,
    abilities: abilitiesOf(schema),
    title: loaded.view.title,
    screen: loaded.view.screen,
    head,
    draft: parseDraft(json(edit)),
    media,
    proxyUrl: media?.proxy && mediaAsset(f, 'proxy.mp4') ? `/api/jobs/${id}/media?name=proxy.mp4` : null,
    filmUrl: media && head ? `/api/jobs/${id}/file?path=${encodeURIComponent(media.film.file)}&v=${head}` : null,
    styles: f?.styles ?? null,
    answers: f?.answers ?? null,
    beats: parseBeats(json(beats)),
    library,
    ...timelineOf(timeline),
    brandLook: parseLook(f?.job?.brand?.look),
    // монтирует правку или она сорвалась — ролик ещё в прошлом стиле; вышла новая версия (result) — уже в новом
    styleFrom: loaded.view.screen === 'working' || (loaded.view.screen === 'error' && loaded.view.step === 'fix')
      ? f?.fix?.fixes.at(-1)?.styleFrom ?? null : null,
  };
}

/** beats.json → доли; не та форма — null (вставки — без долей, как будто музыки нет). */
export function parseBeats(raw: unknown): BeatsFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (typeof b.file !== 'string' || !b.file || !num(b.length) || !num(b.bpm) || !Array.isArray(b.times) || !b.times.every(num)) return null;
  return { file: b.file, length: b.length as number, bpm: b.bpm as number, times: b.times as number[] };
}

// ---------- правки руками: timeline.json ----------

export const TIMELINE = 'timeline.json';

/** Текст timeline.json → ревизия и правки. Кривой файл — правок нет (null), но его ревизия (если есть) остаётся: от неё
 *  страница сохранит новый и так его заменит. Файла нет — ревизия 0. */
export function timelineOf(text: string | null): { rev: number; timeline: TimelineFile | null } {
  const raw = json(text);
  const rev = typeof raw === 'object' && raw !== null && Number.isInteger((raw as { rev?: unknown }).rev) ? Math.max(0, (raw as { rev: number }).rev) : 0;
  return { rev, timeline: parseTimeline(raw) };
}

export type SaveResult =
  | { ok: true; timeline: TimelineFile }
  | { ok: false; status: 400 | 404 | 409; error: string; rev?: number; timeline?: TimelineFile | null };

/** Где правки руками можно сохранять: вопросы (до монтажа), готовый ролик и ошибка — сессия не работает. */
const EDITABLE: readonly Screen[] = ['questions', 'result', 'error'];

class Refused extends Error {}

class Stale extends Error {
  readonly current: { rev: number; timeline: TimelineFile | null };
  constructor(current: { rev: number; timeline: TimelineFile | null }) {
    super('stale');
    this.current = current;
  }
}

/** Тело PUT от редактора: `base` — ревизия, от которой правил, и правки. Не так — что не так. */
function parseSave(body: unknown): { base: number; hand: HandEdits } | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'нужен объект';
  const { base, ...hand } = body as Record<string, unknown>;
  if (!Number.isInteger(base) || (base as number) < 0) return 'base: ревизия, от которой правки';
  const parsed = parseTimeline({ rev: 1, ...hand });
  if (!parsed || 'rev' in hand || 'at' in hand) return 'правки не той формы';
  if (parsed.words?.some((w) => hasEmoji(w.text))) return 'в субтитрах эмодзи нельзя — только слова, как сказаны';
  // знаки, которых шрифт ролика не нарисует, — проверка шрифтов движка не пустила бы монтаж (сессия правки Павла не меняет)
  const odd = [...(parsed.words ?? []).map((w) => w.text), ...typedTexts(parsed)].map(badSymbols).join('');
  if (odd) return `знаки ${[...new Set(odd)].join(' ')} шрифт ролика не нарисует — уберите их или замените эмодзи`;
  const { rev: _rev, ...edits } = parsed;
  return { base: base as number, hand: edits };
}

/**
 * Сохранить правки руками: новая ревизия = `base` + 1, коммит без force. В ветке уже другая ревизия (правили в другой
 * вкладке) — конфликт с тем, что там лежит; проверка — на той голове, поверх которой коммит, на каждой попытке.
 */
export async function saveTimeline(gh: GH, id: string, body: unknown, now: Date): Promise<SaveResult> {
  const parsed = parseSave(body);
  if (typeof parsed === 'string') return { ok: false, status: 400, error: `Правки не сохранились: ${parsed}` };
  const loaded = await loadJob(gh, id, 'list');
  if (!loaded?.files) return { ok: false, status: 404, error: 'Задача не найдена' };
  const screen = loaded.view.screen;
  if (!EDITABLE.includes(screen)) {
    return { ok: false, status: 409, error: screen === 'working' ? 'Claude сейчас монтирует — править можно, когда он закончит' : 'Черновика монтажа ещё нет' };
  }
  const file: TimelineFile = { rev: parsed.base + 1, at: now.toISOString(), ...parsed.hand };
  try {
    await commitFiles(gh, jobBranch(id), async (head) => {
      const refused = refusedBy(abilitiesOf(await readText(gh, head, ENGINE_SCHEMA)), parsed.hand);
      if (refused) throw new Refused(refused);
      const track = parsed.hand.music?.file;
      if (track && !(await musicLibrary(gh, head)).includes(track)) throw new Refused(`Трека ${track.slice(MUSIC_DIR.length + 1)} нет в библиотеке`);
      const current = timelineOf(await readJobText(gh, id, head, TIMELINE));
      if (current.rev !== parsed.base) throw new Stale(current);
      return { [`${jobDir(id)}/${TIMELINE}`]: `${JSON.stringify(file, null, 2)}\n` };
    }, `web(${id}): правки в редакторе, ревизия ${file.rev}`);
  } catch (e) {
    if (e instanceof Stale) return { ok: false, status: 409, error: 'Правки поменялись в другой вкладке', ...e.current };
    if (e instanceof Refused) return { ok: false, status: 409, error: e.message };
    throw e;
  }
  return { ok: true, timeline: file };
}

export const EDITOR_FIX = 'Правки в редакторе';

/**
 * «Монтировать» из редактора у готового ролика: правка (fix.json) с ревизией правок руками и, если Павел поменял стиль,
 * новым стилем (answers.json). Тело — `{editor: {timeline?, style?}}`; `rev` — ревизия timeline.json в ветке.
 */
export function editorFix(body: unknown, ctx: { rev: number; answers: AnswersFile | null; fix: FixFile | null }, now: Date):
  { files: Record<string, string> } | { error: string; status: 400 | 409 } {
  const editor = typeof body === 'object' && body !== null ? (body as { editor?: unknown }).editor : undefined;
  if (typeof editor !== 'object' || editor === null) return { error: 'нужен editor', status: 400 };
  const { timeline, style } = editor as { timeline?: unknown; style?: unknown };
  if (timeline !== undefined && !(Number.isInteger(timeline) && (timeline as number) >= 1)) return { error: 'editor.timeline: ревизия правок', status: 400 };
  if (timeline !== undefined && timeline !== ctx.rev) return { error: 'Правки ещё сохраняются — подождите секунду и нажмите снова', status: 409 };
  let next = null;
  if (style !== undefined) {
    const parsed = parseStyle(style);
    if (typeof parsed === 'string') return { error: parsed, status: 400 };
    if (!ctx.answers) return { error: 'Стиль меняется у смонтированного ролика — сначала «Монтировать» на старом экране', status: 409 };
    if (!sameJson(parsed, ctx.answers.style)) next = parsed;
  }
  if (timeline === undefined && !next) return { error: 'Монтировать нечего: правок в редакторе нет', status: 400 };
  const pretty = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
  return {
    files: {
      'fix.json': pretty(appendFix(ctx.fix, EDITOR_FIX, now, { timeline: timeline as number | undefined, ...(next ? { styleFrom: ctx.answers?.style } : {}) })),
      ...(next && ctx.answers ? { 'answers.json': pretty({ ...ctx.answers, style: next }) } : {}),
    },
  };
}
