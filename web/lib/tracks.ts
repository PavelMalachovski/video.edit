// Дорожки редактора по черновику монтажа: edit.json сессии (времена — по исходнику) → куски видео, вырезанное,
// субтитры, тексты, вставки, ч/б, музыка, переходы и звуки во времени ролика — на шкале монтажа (края кусков на целых
// кадрах, renderTimeline) и по правилам движка (перенос build_overlay_events, build_sub_events, look_windows,
// transitions.marks): блок на дорожке — ровно там, где его нарисует ролик. Правки Павла руками (timeline.json) —
// поверх черновика, как их положит движок. И файлы редактора от vm prepare (editor.json): прокси, лента кадров, волна.
import { snapEdit } from './beats.ts';
import {
  applyKeep, applyPicture, applyPlaces, applyText, SLIVER, type At, type HandEdits, type LookFix, type LookRef, type PlaceFix, type PlaceRef, type TextEdits,
  type TransitionFix, type TransitionRef, type WordFix,
} from './edits.ts';
import type { StyleSpec } from './jobfiles.ts';
import { FPS, frameOf, hookEnd, insertSpans, layerBlocks, renderTimeline, type AccentSpec, type InsertSpec, type OverlayEdit } from './overlay.ts';
import { roundHalfEven } from './pyround.ts';
import { DEFAULT_MUSIC_DB } from './sound.ts';
import { subBlocks } from './subs.ts';
import type { Timeline } from './timeline.ts';
import { lookWindows, TEAR, tearsOf, transitionMarks, transitionSoundStarts, transitionWindow } from './zoom.ts';

type Span = { t0: number; t1: number };
export type DraftWord = Span & { text: string };
export type DraftInsert = Span & {
  kind: string; src?: string; question?: string; id?: string; text?: string; title?: string; x?: number; y?: number; w?: number; sfx?: string | null;
  params?: Record<string, unknown>; off?: boolean;
  from?: number; layout?: 'full' | 'pip' | 'window'; audio?: boolean; // перебивка (fullscreen): с какой секунды клипа, вид, звук клипа
  caption?: string; // перебивка: подпись (пока видна — субтитров нет)
};
/** Финальная карточка: сколько длится, звук появления, призыв, ник и логотип (путь от папки задачи). */
export type DraftEnd = { seconds: number; sfx?: string | null; lines: string[]; handle?: string | null; logo?: string | null };
/** То из edit.json, что показывает редактор. */
export type Draft = {
  speed: number;
  keep: [number, number][];
  words: DraftWord[];
  hook: { text: string; until: number } | null;
  cta: (Span & { lines: string[]; word: string }) | null;
  inserts: DraftInsert[];
  accents?: AccentSpec[];
  subPlaces?: { t0: number; t1: number; y: number }[]; // свои места субтитров (формат разбора): блок — на высоте y фразы
  looks?: (Span & { look: string; off?: boolean })[]; // off — Павел убрал в редакторе (applyPicture)
  zooms: { t: number; level: number; over?: number }[];
  face?: { x: number; y: number } | null; // лицо — доли кадра: зум приближает к нему
  music: { file: string; gainDb: number; at?: number; from?: number; fadeIn?: number; fadeOut?: number; beats?: boolean } | null;
  teaser?: (Span & { sfx?: string | null }) | null;
  transitions?: { t: number; kind: string; sfx?: string | null; off?: boolean }[];
  hold?: number;
  end?: DraftEnd | null;
  style?: StyleSpec | null; // стиль смонтированного ролика (vm style и правки текстом) — им его нарисует монтаж
  dim?: number | null; // затемнение фона (доля) — в превью не видно: маску человека считает монтаж
};

/** editor.json: длина исходника, прокси (из релиза), лента кадров и волна (base64 байтов 0–255, perS в секунду). */
export type EditorMedia = {
  duration: number;
  proxy: { file: string; width: number; height: number; key: number } | null; // null — исходник длинный, прокси нет
  film: { file: string; step: number; w: number; h: number; n: number };
  peaks: { perS: number; data: string };
  videos?: { name: string; t0: number; t1: number }[]; // из каких видео задачи склеен исходник, по порядку (vm prepare)
};

/** Блок текста или вставки на дорожке — что это в черновике (для выбора и правки руками): хук; титр, акцент, вставка — по
 *  месту в речи `at` ([t0, t1], как его записала сессия; `occurrence` — какой по счёту с тем же местом) и номеру в
 *  edit.json; группа субтитров — её слова (время — как в edit.words, `text` — как у сессии). */
export type BlockRef =
  | { kind: 'hook' }
  | { kind: 'cta'; at: At }
  | { kind: 'accent'; n: number; at: At; occurrence: number }
  | { kind: 'insert'; n: number; at: At; occurrence: number }
  | { kind: 'sub'; words: { t0: number; t1: number; text: string }[] };

/** Клип дорожки во времени ролика. У кусков видео: `src0`–`src1` исходника (как в keep — по ним правки), `piece` — номер
 *  куска монтажа (`keep`), `edgeStart`/`edgeEnd` — край куска (его можно тянуть), а не разрез Павла. У субтитров `words` —
 *  слова группы (время ролика), у звуков `key` — ключ правки громкости (insert:<n>, teaser, transition:<n>, end). У
 *  текста и вставок `ref` — что это в черновике; `ghost` — Павел убрал блок: на дорожке — тенью, его можно вернуть;
 *  `drawn: false` — на кадре его не рисует слой (fullscreen монтирует ffmpeg; вставка ждёт ответа на вопрос). */
export type Clip = Span & {
  kind: string; label: string; src0?: number; src1?: number; words?: DraftWord[]; piece?: number; edgeStart?: boolean; edgeEnd?: boolean; key?: string;
  file?: string; // у звуков — файл (как в edit.json)
  videoNo?: number; // у кусков — из какого видео задачи (номер в EditorMedia.videos), если их список есть
  play0?: number; play1?: number; // у кусков — края в исходнике на целых кадрах, как их режет монтаж: по ним играет плеер
  ref?: BlockRef; ghost?: boolean; drawn?: boolean;
  // у блока текста и вставки — его место в речи (время ролика): ручки и перенос двигают его; на кадре блок бывает
  // дольше (акцент держится после своих слов, вставка — не меньше 1,5 с) — этот хвост в правку не идёт
  core?: [number, number];
};
/** Из чего слой строит события (как его увидит монтаж) и его шкала: и кадр редактора, и дорожки — из них; ч/б-куски и
 *  переходы (с правками Павла) — для картинки плеера. */
export type Layer = { edit: OverlayEdit & { zooms: Draft['zooms']; looks?: Draft['looks']; transitions?: Draft['transitions'] }; tl: Timeline };
/** Кусок с фильтром на дорожке «Картинка» (время ролика): `ref` — какой кусок правят (кусок сессии — по месту `at`, его
 *  [t0, t1] в edit.looks; свой кусок Павла — по номеру среди своих, `own`); `look` — фильтр сейчас, `was` — у сессии
 *  (у своего — тот же); `src` — где он в исходнике сейчас (с краями Павла); `off` — Павел его убрал (тень на своём месте);
 *  `teaser` — окно его копии в тизере (у куска с копией — два окна с тем же `ref`). */
export type LookMark = Span & { ref: LookRef; at?: At; look: string; was: string; src: [number, number]; off: boolean; teaser: boolean };
/** Переход на дорожке «Картинка» (у разбора — «Эффекты»): стык в ролике `t`, вид сейчас и у сессии (`was`; у своего —
 *  тот же), `ref` — какой переход правят (сессии — по его t в edit.transitions, свой Павла — по номеру среди своих),
 *  `src` — его момент в исходнике сейчас, `off` — Павел его убрал. */
export type TransitionItem = { t: number; kind: string; was: string; ref: TransitionRef; src: number; off: boolean; t0: number; t1: number }; // t0–t1 — где он идёт
/** Поднятые субтитры на дорожке «Эффекты» (время ролика): `ref` — какое место правят (сессии — по месту в edit.subPlaces,
 *  своё Павла — по номеру среди своих), `was` — место сессии (у своего — null), `src` и `y` — где оно сейчас, `off` —
 *  Павел его убрал (тень на месте сессии). */
export type PlaceItem = Span & { ref: PlaceRef; was: { t0: number; t1: number; y: number } | null; src: [number, number]; y: number; off: boolean;
  core: [number, number] }; // core — где фраза в ролике (блок на дорожке — не короче 0,3 с, чтобы его было видно)
export type Tracks = {
  duration: number; // длина ролика без хвоста (кусков), с
  tail: number; // после кусков — стоп-кадр (hold) и финальная карточка, с
  video: Clip[]; // куски по порядку (тизер — первым): t0–t1 ролика, src0–src1 исходника
  // вырезанное исходника — на стыке ролика; `side` — куда оно вернётся: в конец куска перед ним в исходнике (метка — у
  // конца того куска) или, если перед ним кусков нет, в начало первого
  cuts: { at: number; src0: number; src1: number; side: 'end' | 'start' }[];
  subtitles: Clip[]; // группы субтитров, как их покажет ролик (у soft — блок до двух строк)
  text: Clip[]; // хук, акцентные фразы, титр
  inserts: Clip[];
  looks: LookMark[]; // ч/б-куски, и убранные Павлом
  music: { label: string; gainDb: number; at?: number; from?: number; fadeIn?: number; fadeOut?: number } | null;
  transitions: TransitionItem[]; // переходы, и убранные Павлом
  places: PlaceItem[]; // поднятые субтитры (формат разбора), и убранные Павлом
  sounds: Clip[]; // звуки: появления вставок, стык тизера, переходы, карточка
  brollStarts: number[]; // начала перебивок на весь кадр (не в окошке), с ролика: разрыв ведёт только в них (tearsOf)
  layer: Layer;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isSpan = (x: unknown): x is Span & Record<string, unknown> => isObj(x) && isNum(x.t0) && isNum(x.t1);

/** edit.json → черновик для показа; не та форма (или шкала монтажа его не примет) — null. */
export function parseDraft(raw: unknown): Draft | null {
  if (!isObj(raw) || !isNum(raw.speed) || raw.speed <= 0 || !Array.isArray(raw.keep) || !Array.isArray(raw.words)) return null;
  if (!raw.keep.every((k) => Array.isArray(k) && k.length === 2 && isNum(k[0]) && isNum(k[1]) && k[1] > k[0])) return null;
  if (!raw.words.every((w) => isSpan(w) && isStr(w.text))) return null;
  const list = <T>(x: unknown, ok: (y: unknown) => boolean): T[] => (Array.isArray(x) ? (x.filter(ok) as T[]) : []);
  // хук, титр, акценты, вставки, карточка — как в edit.json (правки руками держатся за их место в речи)
  const hook = isObj(raw.hook) && isStr(raw.hook.text) && isNum(raw.hook.until) ? (raw.hook as Draft['hook']) : null;
  const cta = isSpan(raw.cta) && Array.isArray(raw.cta.lines) && isStr(raw.cta.word) ? (raw.cta as Draft['cta']) : null;
  const place = (m: Record<string, unknown>) => Object.fromEntries(MUSIC_PLACE.filter((k) => isNum(m[k])).map((k) => [k, m[k] as number]));
  const music = isObj(raw.music) && isStr(raw.music.file) && isNum(raw.music.gainDb)
    ? { file: raw.music.file, gainDb: raw.music.gainDb, ...place(raw.music), ...(raw.music.beats === false ? { beats: false } : {}) } : null;
  const sfx = (x: unknown) => (isStr(x) ? x : null);
  const draft: Draft = {
    speed: raw.speed,
    keep: raw.keep as [number, number][],
    words: raw.words as DraftWord[],
    hook,
    cta,
    inserts: list(raw.inserts, (i) => isSpan(i) && isStr(i.kind)),
    accents: list(raw.accents, (a) => isSpan(a) && Array.isArray(a.lines) && a.lines.length > 0 && a.lines.every((l) => isObj(l) && isStr(l.text))
      && isNum(a.x) && isNum(a.y)),
    subPlaces: list(raw.subPlaces, (p) => isSpan(p) && isNum(p.y)),
    looks: list(raw.looks, (l) => isSpan(l) && isStr(l.look)),
    zooms: list(raw.zooms, (z) => isObj(z) && isNum(z.t) && isNum(z.level)),
    face: isObj(raw.face) && isNum(raw.face.x) && isNum(raw.face.y) ? { x: raw.face.x, y: raw.face.y } : null,
    music,
    teaser: isSpan(raw.teaser) ? { t0: raw.teaser.t0, t1: raw.teaser.t1, sfx: sfx(raw.teaser.sfx) } : null,
    transitions: list(raw.transitions, (x) => isObj(x) && isNum(x.t) && isStr(x.kind)),
    hold: isNum(raw.hold) ? raw.hold : 0,
    end: isObj(raw.end) && isNum(raw.end.seconds) && Array.isArray(raw.end.lines) && raw.end.lines.every(isStr)
      ? { ...(raw.end as DraftEnd), sfx: sfx(raw.end.sfx) } : null,
    style: isStyle(raw.style) ? raw.style : null,
    dim: isNum(raw.dim) && raw.dim > 0 ? raw.dim : null,
  };
  try {
    timelineOf(draft);
  } catch {
    return null;
  }
  return draft;
}

/** Стиль из edit.json, по которому слой строит события: режим и число слов субтитров, вид хука (остальное читает шаблон). */
function isStyle(x: unknown): x is StyleSpec {
  return isObj(x) && isObj(x.subtitles) && isStr(x.subtitles.mode) && isNum(x.subtitles.words) && isObj(x.hook) && isStr(x.hook.mode);
}

/** editor.json → данные; не та форма — null. */
export function parseMedia(raw: unknown): EditorMedia | null {
  if (!isObj(raw) || !isNum(raw.duration) || raw.duration <= 0) return null;
  const { proxy, film, peaks } = raw;
  if (proxy !== null && !(isObj(proxy) && isStr(proxy.file) && isNum(proxy.width) && isNum(proxy.height) && isNum(proxy.key))) return null;
  const int = (x: unknown, max: number) => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= max;
  if (!isObj(film) || !isStr(film.file) || !isNum(film.step) || film.step <= 0 || !int(film.w, 1080) || !int(film.h, 1920) || !int(film.n, FILM_MAX)) return null;
  if (!isObj(peaks) || !int(peaks.perS, 1000) || !isStr(peaks.data)) return null;
  const { videos } = raw;
  const mark = (v: unknown) => isObj(v) && Object.keys(v).length === 3 && isStr(v.name) && v.name !== '' && isNum(v.t0) && v.t0 >= 0
    && isNum(v.t1) && v.t1 > v.t0;
  if (videos !== undefined && !(Array.isArray(videos) && videos.length >= 1 && videos.length <= 10 && videos.every(mark))) return null;
  return raw as EditorMedia;
}

export function decodePeaks(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Громкость 0..1 в момент исходника `t` (за краями — крайний пик). */
export function peakAt(peaks: Uint8Array, perS: number, t: number): number {
  if (!peaks.length) return 0;
  const i = Math.min(peaks.length - 1, Math.max(0, Math.round(t * perS)));
  return peaks[i] / 255;
}

/** Шкала монтажа черновика (render.timeline): края кусков и тизера — на целых кадрах, не дальше последнего кадра
 *  исходника `limit`. Тизер не той длины — Error. */
export const timelineOf = (d: Draft, limit?: number): Timeline => renderTimeline(d, limit);

const MUSIC_PLACE = ['at', 'from', 'fadeIn', 'fadeOut'] as const; // где звучит музыка — правка Павла в редакторе
const SOUND_SHOW = 0.4; // с — ширина метки звука на дорожке
const FILM_MAX = 1000; // кадров в ленте — не больше (FILM['max'] движка, editor.py)
const DRAWN = ['image', 'badge', 'sticker', 'text', 'anim']; // что рисует слой (overlay.DRAWN)
const TEXTUAL = ['sticker', 'text']; // вставки из одного текста: картинка им не нужна (render.TEXTUAL)
/** Вставка «добавь сюда» ждёт ответа на вопрос: на дорожке она есть, а слой её не рисует — картинки ещё нет. */
export const WAITING = 'waiting';

/** Стиль, по которому слой строит события: режим и слов субтитров, вид хука. */
export type LayerStyle = { subtitles: { mode: string; words: number }; hook: { mode: string } };
const PLAIN: LayerStyle = { subtitles: { mode: 'karaoke', words: 3 }, hook: { mode: 'plate' } };

/** Имя файла без папки и расширения. */
const stem = (path: string): string => path.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? path;

/** Откуда блок в черновике сессии: номер, место в речи и какой по счёту с тем же местом. Символ — в JSON и в состояния
 *  слоя не попадает, а через правки (копии блоков) — проходит. */
const ORIGIN = Symbol('origin');
type Origin = { n: number; at: At; occurrence: number };
function tagged<T extends Span>(items: readonly T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((x, n) => {
    const key = `${x.t0}|${x.t1}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return { ...x, [ORIGIN]: { n, at: [x.t0, x.t1], occurrence } satisfies Origin };
  });
}
const originOf = (x: object): Origin | undefined => (x as { [ORIGIN]?: Origin })[ORIGIN];

/** Черновик с правками → то, из чего слой строит события, как их увидит монтаж: стиль ролика; вставки, ждущие ответа
 *  (картинки ещё нет) или без места на кадре (монтаж такой черновик не примет), — на дорожке есть, а на кадре не
 *  рисуются; доли музыки (`beats`, время ролика) — вставки и зум встают на них, как в render.on_beats. */
export function layerEdit(d: Draft, style: LayerStyle, tl: Timeline, beats: readonly number[] | null = null): Layer['edit'] {
  const unplaced = (i: DraftInsert) => DRAWN.includes(i.kind) && [i.x, i.y, i.w].some((v) => typeof v !== 'number');
  const inserts = d.inserts.map((i) => ((i.question && !i.src && !TEXTUAL.includes(i.kind)) || unplaced(i) ? { ...i, kind: WAITING } : i));
  const timed = beats ? snapEdit({ zooms: d.zooms, inserts }, tl, beats).edit : { zooms: d.zooms, inserts };
  return {
    words: d.words, style, hook: d.hook, cta: d.cta, accents: d.accents ?? [], subPlaces: d.subPlaces ?? [], inserts: timed.inserts as InsertSpec[], hold: d.hold ?? 0,
    end: d.end ?? null, zooms: timed.zooms, looks: d.looks ?? [], transitions: d.transitions ?? [],
  };
}

/** Дорожки черновика во времени ролика. `style` — режим субтитров и хука, каким его нарисует монтаж; `sourceDuration` —
 *  длина исходника: вырезанный хвост и последний кадр; `splits` — разрезы Павла (с исходника, на монтаж не влияют);
 *  `videos` — из каких видео склеен исходник; `fixes` — правки текста, слов и картинки (timeline.json): дорожки
 *  показывают блоки с ними, убранное — тенью; `beats` — доли музыки во времени ролика (вставки и зум встают на них). */
export function draftTracks(d: Draft, { style = PLAIN, sourceDuration, splits = [], videos, fixes, beats = null }: {
  style?: LayerStyle; sourceDuration?: number; splits?: number[]; videos?: EditorMedia['videos'];
  fixes?: { text?: TextEdits; words?: WordFix[]; zoom?: number; looks?: LookFix[]; transitions?: TransitionFix[]; subPlaces?: PlaceFix[] }; beats?: readonly number[] | null;
} = {}): Tracks {
  const tl = timelineOf(d, sourceDuration);
  const last = sourceDuration === undefined ? null : Math.floor(sourceDuration * FPS + 0.01);
  const kept = (a: number, b: number) => (last === null ? roundHalfEven(b * FPS) : Math.min(roundHalfEven(b * FPS), last)) > roundHalfEven(a * FPS);

  // куски: время исходника — как в keep (по нему правки), время ролика — по шкале монтажа (края на целых кадрах)
  const segs = tl.segments;
  let k = d.teaser ? 1 : 0;
  const placed: { src0: number; src1: number; play0: number; play1: number; t0: number; t1: number; keep: number }[] = [];
  d.keep.forEach(([a, b], i) => {
    if (!kept(a, b)) return; // короче кадра — в ролике его нет
    const [s0, s1, f0] = segs[k++];
    placed.push({ src0: a, src1: b, play0: s0, play1: s1, t0: f0, t1: f0 + (s1 - s0) / d.speed, keep: i });
  });

  // на экране куски делятся разрезами Павла и стыками видео задачи (несколько видео склеены в один исходник)
  const cutsAt = [...splits, ...(videos ?? []).slice(1).map((v) => v.t0)].sort((x, y) => x - y);
  const videoOf = (src0: number, src1: number): number | undefined => {
    if (!videos) return undefined;
    const n = videos.findIndex((v) => (src0 + src1) / 2 < v.t1);
    return n < 0 ? videos.length - 1 : n;
  };
  const video: Clip[] = [];
  const teaser = tl.teaser;
  if (d.teaser && teaser) {
    video.push({
      kind: 'teaser', label: '', src0: d.teaser.t0, src1: d.teaser.t1, play0: teaser[0], play1: teaser[1], t0: 0, t1: tl.teaserDuration,
      videoNo: videoOf(d.teaser.t0, d.teaser.t1),
    });
  }
  for (const p of placed) {
    const edges = [p.src0, ...cutsAt.filter((t) => t > p.src0 + SLIVER && t < p.src1 - SLIVER), p.src1];
    const at = (e: number) => (e === p.src1 ? p.t1 : e === p.src0 ? p.t0 : p.t0 + (e - p.play0) / d.speed);
    const last = edges.length - 2;
    edges.slice(1).forEach((b, j) => video.push({
      kind: 'piece', label: '', src0: edges[j], src1: b, t0: at(edges[j]), t1: at(b), piece: p.keep, edgeStart: j === 0, edgeEnd: j === last,
      play0: j === 0 ? p.play0 : edges[j], play1: j === last ? p.play1 : b, videoNo: videoOf(edges[j], b),
    }));
  }
  // вырезанное — по исходнику: «＋» стоит в конце куска, что перед ним в исходнике (где бы тот ни стоял), а вырезанное до
  // первого куска — в начале первого по исходнику
  const cuts: Tracks['cuts'] = [];
  const bySource = [...placed].sort((a, b) => a.src0 - b.src0);
  let prev = 0;
  let before: (typeof placed)[number] | null = null;
  for (const s of bySource) {
    if (s.src0 > prev + 1e-6) cuts.push(before ? { at: before.t1, src0: prev, src1: s.src0, side: 'end' } : { at: s.t0, src0: prev, src1: s.src0, side: 'start' });
    prev = s.src1;
    before = s;
  }
  if (sourceDuration !== undefined && sourceDuration > prev + 1e-6) cuts.push({ at: before ? before.t1 : tl.duration, src0: prev, src1: sourceDuration, side: 'end' });

  // текст и вставки — с правками Павла; каждый блок помнит, откуда он в черновике сессии; картинка — с его силой зума,
  // убранными ч/б-кусками и переходами (applyPicture — apply_picture движка)
  const pic = applyPicture({ zooms: d.zooms, looks: d.looks ?? [], transitions: d.transitions ?? [] }, fixes?.zoom, fixes?.looks, fixes?.transitions);
  const base: Draft = { ...d, accents: tagged(d.accents ?? []), inserts: tagged(d.inserts), ...pic };
  // поднятые субтитры — с правками Павла (edits._hand_places движка)
  const shown = { ...applyText(base, fixes?.text, fixes?.words), subPlaces: applyPlaces(d.subPlaces, fixes?.subPlaces) };
  const layer = layerEdit(shown, style, tl, beats);
  const blocks = layerBlocks(layer, tl);
  const video0 = frameOf(tl.duration);
  const still = frameOf(tl.duration + (d.hold ?? 0));
  const ghost = (s: Span): Span => {
    const [t0, t1] = tl.span(s.t0, s.t1);
    return { t0, t1: Math.max(t1, t0 + 0.3) };
  };

  // субтитры — группы, как их покажет ролик (слова акцентов — не в них); у слова — время из edit.json и текст сессии
  const sessionText = new Map(d.words.map((w) => [`${w.t0}|${w.t1}`, w.text]));
  const hidden = (layer.accents ?? []).map((a) => [Number(a.t0), Number(a.t1)]);
  const subtitles: Clip[] = subBlocks(layer.words ?? [], tl, style.subtitles.mode, style.subtitles.words, hidden).map((b) => {
    const words = b.words.map((w) => (layer.words ?? [])[w.i]);
    return {
      kind: 'sub', label: b.words.map((w) => w.text).join(' '), t0: b.t0, t1: b.t1, words: b.words.map((w) => ({ text: w.text, t0: w.t0, t1: w.t1 })),
      ref: { kind: 'sub', words: words.map((w) => ({ t0: w.t0, t1: w.t1, text: sessionText.get(`${w.t0}|${w.t1}`) ?? w.text })) },
    };
  });

  // хук, титр, акценты — где их рисует слой; убранные Павлом — тенью
  const text: Clip[] = [];
  const place = (s: Span): [number, number] => tl.span(Number(s.t0), Number(s.t1)); // место в речи — время ролика
  const shade = (s: Span) => { // убранное — тенью на своём месте
    const g = ghost(s);
    return { ...g, core: [g.t0, g.t1] as [number, number], ghost: true };
  };
  if (blocks.hook && shown.hook) {
    text.push({ kind: 'hook', label: shown.hook.text, t0: blocks.hook.t0, t1: blocks.hook.t1, ref: { kind: 'hook' }, core: [blocks.hook.t0, blocks.hook.t1] });
  } else if (d.hook && !shown.hook) {
    const t1 = Math.max(0.3, hookEnd(d as OverlayEdit, tl) / FPS);
    text.push({ kind: 'hook', label: d.hook.text, t0: 0, t1, ref: { kind: 'hook' }, core: [0, t1], ghost: true });
  }
  for (const b of blocks.accents) {
    const a = (layer.accents ?? [])[b.n];
    const o = originOf(a);
    if (o) {
      text.push({
        kind: 'accent', label: a.lines.map((l) => l.text).join(' '), t0: b.t0, t1: b.t1, ref: { kind: 'accent', n: o.n, at: o.at, occurrence: o.occurrence },
        core: place(a),
      });
    }
  }
  const left = new Set((shown.accents ?? []).map((a) => originOf(a)?.n));
  for (const a of base.accents ?? []) {
    const o = originOf(a) as Origin;
    if (!left.has(o.n)) text.push({ kind: 'accent', label: a.lines.map((l) => l.text).join(' '), ...shade(a), ref: { kind: 'accent', n: o.n, at: o.at, occurrence: o.occurrence } });
  }
  if (blocks.cta && shown.cta && d.cta) {
    text.push({
      kind: 'cta', label: [...shown.cta.lines, shown.cta.word].join(' '), t0: blocks.cta.t0, t1: blocks.cta.t1, ref: { kind: 'cta', at: [d.cta.t0, d.cta.t1] },
      core: place(shown.cta),
    });
  } else if (d.cta && !shown.cta) {
    text.push({ kind: 'cta', label: [...d.cta.lines, d.cta.word].join(' '), ...shade(d.cta), ref: { kind: 'cta', at: [d.cta.t0, d.cta.t1] } });
  }
  text.sort((a, b) => a.t0 - b.t0);

  // вставки — все, что в ролике (и fullscreen, и ждущие ответа): не раньше конца хука, не короче 1,5 с, в своей серии
  // кусков, на долях музыки; видна в последний кадр — до конца стоп-кадра (кроме fullscreen); убранные — тенью
  const label = (i: DraftInsert) => (i.kind === 'text' || i.kind === 'sticker' ? (i.text ?? i.id ?? '') : (i.question ?? (i.src ? stem(i.src) : i.id ?? '')));
  const inserts: Clip[] = [];
  const spans = insertSpans(layer, tl);
  for (const [n, start, stop] of spans) {
    const ins = (layer.inserts ?? [])[n] as DraftInsert;
    if (start >= video0) continue; // начинается после конца ролика — в ролике её нет
    const end = stop >= video0 ? (ins.kind === 'fullscreen' ? video0 : still) : stop; // fullscreen монтирует ffmpeg — до конца кусков
    const o = originOf(ins) as Origin;
    const own = (shown.inserts as DraftInsert[])[n]; // как в черновике: ждущая ответа на дорожке — своего вида
    inserts.push({
      kind: own.kind, label: label(own), t0: start / FPS, t1: end / FPS, ref: { kind: 'insert', n, at: o.at, occurrence: o.occurrence },
      drawn: DRAWN.includes(ins.kind), core: [start / FPS, Math.max(start / FPS, place(ins)[1])], // начало — где её видно (после хука, на доле)
    });
  }
  for (const ins of (shown.inserts ?? []) as DraftInsert[]) {
    const o = originOf(ins) as Origin;
    if (ins.off) inserts.push({ kind: ins.kind, label: label(ins), ...shade(ins), ref: { kind: 'insert', n: o.n, at: o.at, occurrence: o.occurrence } });
  }
  inserts.sort((a, b) => a.t0 - b.t0);

  // куски с фильтром — их кадры (look_windows: край у склейки — на склейке; копия в тизере); убранные — тенью там же. Куски
  // сессии — первые в списке (applyPicture их не переставляет), свои куски Павла — после них
  const session = d.looks ?? [];
  const teaserEnd = tl.teaser ? (tl.teaser[1] - tl.teaser[0]) / tl.speed : 0;
  const looks: LookMark[] = (pic.looks ?? []).flatMap((l, i) => {
    const mine = i >= session.length;
    const ref: LookRef = mine ? { own: i - session.length } : { at: [Number(session[i].t0), Number(session[i].t1)] };
    return lookWindows([{ ...l, off: false }], tl).map(([a, b]): LookMark => ({
      t0: a / FPS, t1: b / FPS, ref, ...('at' in ref ? { at: ref.at } : {}), look: l.look ?? 'bw', was: mine ? l.look ?? 'bw' : session[i].look ?? 'bw',
      src: [Number(l.t0), Number(l.t1)], off: Boolean(l.off), teaser: teaserEnd > 0 && b / FPS <= teaserEnd + 1e-6,
    }));
  }).sort((a, b) => a.t0 - b.t0);
  // переходы — на стыке, у самого начала и конца ролика их нет (transitions.marks); убранные — тенью там же
  const torn = tearsOf((pic.transitions ?? []).map((x) => ({ ...x, off: false })), layer, tl); // окно разрыва — от его перебивки
  const ours = d.transitions ?? [];
  const transitions: TransitionItem[] = (pic.transitions ?? []).flatMap((x, n) => transitionMarks([{ ...x, off: false }], tl)
    .map((m) => {
      const [t0, t1] = transitionWindow(m, torn.filter((y) => y.mark.source === m.source).map((y) => ({ ...y, mark: m })));
      const ref: TransitionRef = n < ours.length ? { at: Number(ours[n].t) } : { own: n - ours.length };
      return { t: m.t, kind: x.kind, was: ours[n]?.kind ?? x.kind, ref, src: Number(x.t), off: Boolean(x.off), t0, t1 };
    })).sort((a, b) => a.t - b.t);

  // поднятые субтитры: места сессии (убранные — тенью там же), потом свои места Павла — как их сложит applyPlaces
  const sessionPlaces = d.subPlaces ?? [];
  const placeFixes = fixes?.subPlaces ?? [];
  const placeAt = (p: { t0: number; t1: number }): Span & { core: [number, number] } => {
    const [t0, t1] = tl.span(p.t0, p.t1);
    return { t0, t1: Math.max(t1, t0 + 0.3), core: [t0, t1] };
  };
  const places: PlaceItem[] = [
    ...sessionPlaces.map((p): PlaceItem => {
      const f = placeFixes.find((x) => x.at && x.at[0] === p.t0 && x.at[1] === p.t1);
      const now = { t0: f?.t0 ?? p.t0, t1: f?.t1 ?? p.t1, y: f?.y ?? p.y };
      return { ...placeAt(f?.off ? p : now), ref: { at: [p.t0, p.t1] }, was: p, src: [now.t0, now.t1], y: now.y, off: Boolean(f?.off) };
    }),
    ...placeFixes.filter((x) => x.at === undefined).map((x, own): PlaceItem => {
      const now = { t0: Number(x.t0), t1: Number(x.t1), y: Number(x.y) };
      return { ...placeAt(now), ref: { own }, was: null, src: [now.t0, now.t1], y: now.y, off: false };
    }),
  ].sort((a, b) => a.t0 - b.t0);

  // звуки — где их ставит движок (render._sounds): вставка — с её появлением, тизер — на стыке, переход — с его началом,
  // карточка — после стоп-кадра
  const sounds: Clip[] = [];
  const sound = (key: string, t: number, file: string) => sounds.push({ kind: 'sound', key, file, label: stem(file), t0: t, t1: t + SOUND_SHOW });
  for (const [n, start] of spans) {
    const sfx = ((layer.inserts ?? [])[n] as DraftInsert).sfx;
    if (sfx) sound(`insert:${n}`, start / FPS, sfx);
  }
  if (d.teaser?.sfx) sound('teaser', tl.teaserDuration, d.teaser.sfx);
  // номер звука — в списке с правками Павла (render._sounds): сдвинутый переход сессии звучит на новом месте, свои — без звука
  const moments = pic.transitions ?? [];
  const sources = moments.map((x) => Number(x.t));
  for (const [m, start] of transitionSoundStarts(moments, layer, tl)) { // с началом перехода (разрыв — его окна)
    const sfx = moments[sources.indexOf(m.source)]?.sfx;
    if (sfx) sound(`transition:${sources.indexOf(m.source)}`, start, sfx);
  }
  if (shown.end?.sfx) sound('end', tl.duration + (d.hold ?? 0), shown.end.sfx); // карточку Павел мог убрать
  sounds.sort((a, b) => a.t0 - b.t0);

  return {
    duration: tl.duration, tail: (d.hold ?? 0) + (shown.end?.seconds ?? 0), video, cuts, subtitles, text, inserts, looks, transitions, places, sounds,
    brollStarts: spans.filter(([i]) => (layer.inserts ?? [])[i]?.kind === 'fullscreen' && ((layer.inserts ?? [])[i] as DraftInsert).layout !== 'window')
      .map(([, start]) => start / FPS).sort((a, b) => a - b),
    music: d.music ? { label: stem(d.music.file), gainDb: d.music.gainDb, ...Object.fromEntries(MUSIC_PLACE.filter((m) => d.music?.[m] !== undefined).map((m) => [m, d.music?.[m]])) } : null,
    layer: { edit: layer, tl },
  };
}

/** Блок на дорожках «Текст» и «Вставки» по виду и номеру в edit.json (у хука и титра номера нет); убранный — тень. */
export function findBlock(t: Tracks, kind: 'hook' | 'cta' | 'accent' | 'insert', n = 0): Clip | null {
  const list = kind === 'insert' ? t.inserts : t.text;
  return list.find((c) => c.ref?.kind === kind && (kind === 'hook' || kind === 'cta' || ('n' in c.ref && c.ref.n === n))) ?? null;
}

/** Клип, дольше всех идущий в промежутке события слоя [t0, t1): что на кадре сейчас (группа субтитров, акцент) — по нему
 *  касание кадра выбирает блок. Края событий — на целых кадрах, края групп — нет: по перекрытию, а не по началу. Ничего —
 *  null. */
export function clipAt(clips: readonly Clip[], t0: number, t1: number): Clip | null {
  let best: Clip | null = null;
  let most = 0;
  for (const c of clips) {
    const o = Math.min(c.t1, t1) - Math.max(c.t0, t0);
    if (o > most + 1e-9) {
      most = o;
      best = c;
    }
  }
  return best;
}

// ---------- правки руками ----------

/** Черновик с правками Павла (timeline.json): куски — как их вырежет движок (applyKeep — apply_keep), музыка — с его
 *  местом, громкостью и треком («без звука» дорожка показывает отдельно), тизер (убран) и скорость ролика; `splits` —
 *  его разрезы для draftTracks. Правок нет — тот же черновик. Текст и вставки сюда не входят — их кладёт draftTracks
 *  (`fixes`): правка текста не двигает плеер. */
export function withHandEdits(d: Draft, h: HandEdits, sourceDuration?: number): { draft: Draft; splits: number[] } {
  const splits = h.edits.flatMap((e) => (e.op === 'split' ? [e.t] : []));
  const keep = h.edits.length ? applyKeep(d.keep, h.edits, sourceDuration) : d.keep;
  const { muted: _muted, ...place } = h.music ?? {};
  // другой трек — и в ролике без музыки: тогда он звучит с громкостью по умолчанию (edits.apply движка)
  const base = d.music ?? (place.file ? { file: place.file, gainDb: DEFAULT_MUSIC_DB } : null);
  const music = base && h.music ? { ...base, ...place } : d.music;
  // ролик: тизер убран, другая скорость (edits.apply движка)
  const teaser = h.teaser === false ? null : d.teaser;
  const speed = h.speed ?? d.speed;
  const same = keep === d.keep && music === d.music && teaser === d.teaser && speed === d.speed;
  return { draft: same ? d : { ...d, keep, music, teaser, speed }, splits };
}

/** Куда встанет разрыв у момента `t` ролика: на начало ближайшей перебивки на весь кадр не дальше `reach` с (разрыв
 *  открывает перебивку — без неё его нет, transitions.tears); рядом перебивки нет — null. */
export function tearAt(t: Tracks, at: number, reach = TEAR_REACH): number | null {
  const near = t.brollStarts.filter((s) => Math.abs(s - at) <= reach && s >= TEAR / FPS).sort((a, b) => Math.abs(a - at) - Math.abs(b - at));
  return near[0] ?? null;
}
export const TEAR_REACH = 1.5; // с — так далеко от перебивки разрыв ещё прилипает к её началу

/** Где разрезать по плейхеду `at` (время ролика): момент исходника внутри куска (не у самого края); в тизере, у края
 *  или мимо кусков — null. */
export function splitTarget(t: Tracks, at: number): number | null {
  const c = t.video.find((x) => x.kind === 'piece' && at > x.t0 && at < x.t1);
  if (!c || c.src0 === undefined || c.src1 === undefined) return null;
  const src = c.src0 + ((at - c.t0) * (c.src1 - c.src0)) / (c.t1 - c.t0);
  return src > c.src0 + SLIVER && src < c.src1 - SLIVER ? src : null;
}

/** Переставить кусок `index` дорожки «Видео» перед куском `slot` (номер в той же дорожке; дальше последнего — в конец):
 *  правка move — кусок исходника и момент, перед которым он встаёт (null — в конец). Своё же место, тизер — null; перед
 *  тизером — значит, первым после него. */
export function moveTarget(t: Tracks, index: number, slot: number): { t0: number; t1: number; before: number | null } | null {
  const c = t.video[index];
  if (!c || c.kind !== 'piece' || c.src0 === undefined || c.src1 === undefined) return null;
  const first = t.video.findIndex((x) => x.kind === 'piece');
  const at = Math.min(t.video.length, Math.max(first, slot));
  if (at === index || at === index + 1) return null;
  const next = t.video[at];
  return { t0: c.src0, t1: c.src1, before: next?.src0 ?? null };
}

/** Перед каким куском встанет перетаскиваемый, если отпустить его на моменте `tf` ролика: стык, ближайший к `tf` (номер
 *  куска за ним; за серединой последнего — длина дорожки). Перед тизером — не встаёт. */
export function slotAt(t: Tracks, tf: number): number {
  const n = t.video.findIndex((c) => c.kind === 'piece' && tf < (c.t0 + c.t1) / 2);
  return n < 0 ? t.video.length : n;
}

/** Границы слов (с исходника) по порядку — к ним липнут края кусков. */
export const wordEdges = (d: Draft): number[] => [...new Set(d.words.flatMap((w) => [w.t0, w.t1]))].sort((a, b) => a - b);

/** Ключ кусков дорожки «Видео»: меняется, только когда меняются куски (вырезать, вернуть, разрезать), — тогда плеер
 *  встаёт на тот же момент ролика на новых кусках; громкость, музыка и текст его не трогают. */
export const videoKey = (t: Tracks): string => t.video.map((c) => `${c.src0}-${c.src1}@${c.t0.toFixed(4)}`).join('|');
