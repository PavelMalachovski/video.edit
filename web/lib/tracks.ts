// Дорожки редактора по черновику монтажа: edit.json сессии (времена — по исходнику) → куски видео, вырезанное,
// субтитры, тексты, вставки, ч/б, музыка, переходы и звуки во времени ролика — на шкале монтажа (края кусков на целых
// кадрах, renderTimeline) и по правилам движка (перенос build_overlay_events, build_sub_events, look_windows,
// transitions.marks): блок на дорожке — ровно там, где его нарисует ролик. Правки Павла руками (timeline.json) —
// поверх черновика, как их положит движок. И файлы редактора от vm prepare (editor.json): прокси, лента кадров, волна.
import { snapEdit } from './beats.ts';
import { applyKeep, applyText, SLIVER, type At, type HandEdits, type TextEdits, type WordFix } from './edits.ts';
import type { StyleSpec } from './jobfiles.ts';
import { FPS, frameOf, hookEnd, insertSpans, layerBlocks, renderTimeline, type AccentSpec, type InsertSpec, type OverlayEdit } from './overlay.ts';
import { roundHalfEven } from './pyround.ts';
import { subBlocks } from './subs.ts';
import type { Timeline } from './timeline.ts';
import { HALF, lookWindows, transitionMarks } from './zoom.ts';

type Span = { t0: number; t1: number };
export type DraftWord = Span & { text: string };
export type DraftInsert = Span & {
  kind: string; src?: string; question?: string; id?: string; text?: string; title?: string; x?: number; y?: number; w?: number; sfx?: string | null;
  params?: Record<string, unknown>; off?: boolean;
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
  looks?: (Span & { look: string })[];
  zooms: { t: number; level: number; over?: number }[];
  face?: { x: number; y: number } | null; // лицо — доли кадра: зум приближает к нему
  music: { file: string; gainDb: number; at?: number; from?: number; fadeIn?: number; fadeOut?: number; beats?: boolean } | null;
  teaser?: (Span & { sfx?: string | null }) | null;
  transitions?: { t: number; kind: string; sfx?: string | null }[];
  hold?: number;
  end?: DraftEnd | null;
  style?: StyleSpec | null; // стиль смонтированного ролика (vm style и правки текстом) — им его нарисует монтаж
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
  ref?: BlockRef; ghost?: boolean; drawn?: boolean;
  // у блока текста и вставки — его место в речи (время ролика): ручки и перенос двигают его; на кадре блок бывает
  // дольше (акцент держится после своих слов, вставка — не меньше 1,5 с) — этот хвост в правку не идёт
  core?: [number, number];
};
/** Из чего слой строит события (как его увидит монтаж) и его шкала: и кадр редактора, и дорожки — из них. */
export type Layer = { edit: OverlayEdit & { zooms: Draft['zooms'] }; tl: Timeline };
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
  looks: Clip[]; // ч/б куски
  music: { label: string; gainDb: number; at?: number; from?: number; fadeIn?: number; fadeOut?: number } | null;
  transitions: { t: number; kind: string }[];
  sounds: Clip[]; // звуки: появления вставок, стык тизера, переходы, карточка
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
    words: d.words, style, hook: d.hook, cta: d.cta, accents: d.accents ?? [], inserts: timed.inserts as InsertSpec[], hold: d.hold ?? 0,
    end: d.end ?? null, zooms: timed.zooms,
  };
}

/** Дорожки черновика во времени ролика. `style` — режим субтитров и хука, каким его нарисует монтаж; `sourceDuration` —
 *  длина исходника: вырезанный хвост и последний кадр; `splits` — разрезы Павла (с исходника, на монтаж не влияют);
 *  `videos` — из каких видео склеен исходник; `fixes` — правки текста и слов (timeline.json): дорожки показывают блоки с
 *  ними, убранное — тенью; `beats` — доли музыки во времени ролика (вставки и зум встают на них). */
export function draftTracks(d: Draft, { style = PLAIN, sourceDuration, splits = [], videos, fixes, beats = null }: {
  style?: LayerStyle; sourceDuration?: number; splits?: number[]; videos?: EditorMedia['videos'];
  fixes?: { text?: TextEdits; words?: WordFix[] }; beats?: readonly number[] | null;
} = {}): Tracks {
  const tl = timelineOf(d, sourceDuration);
  const last = sourceDuration === undefined ? null : Math.floor(sourceDuration * FPS + 0.01);
  const kept = (a: number, b: number) => (last === null ? roundHalfEven(b * FPS) : Math.min(roundHalfEven(b * FPS), last)) > roundHalfEven(a * FPS);

  // куски: время исходника — как в keep (по нему правки), время ролика — по шкале монтажа (края на целых кадрах)
  const segs = tl.segments;
  let k = d.teaser ? 1 : 0;
  const placed: { src0: number; src1: number; t0: number; t1: number; keep: number }[] = [];
  d.keep.forEach(([a, b], i) => {
    if (!kept(a, b)) return; // короче кадра — в ролике его нет
    const [s0, s1, f0] = segs[k++];
    placed.push({ src0: a, src1: b, t0: f0, t1: f0 + (s1 - s0) / d.speed, keep: i });
  });

  // на экране куски делятся разрезами Павла и стыками видео задачи (несколько видео склеены в один исходник)
  const cutsAt = [...splits, ...(videos ?? []).slice(1).map((v) => v.t0)].sort((x, y) => x - y);
  const videoOf = (src0: number, src1: number): number | undefined => {
    if (!videos) return undefined;
    const n = videos.findIndex((v) => (src0 + src1) / 2 < v.t1);
    return n < 0 ? videos.length - 1 : n;
  };
  const video: Clip[] = [];
  if (d.teaser) video.push({ kind: 'teaser', label: '', src0: d.teaser.t0, src1: d.teaser.t1, t0: 0, t1: tl.teaserDuration, videoNo: videoOf(d.teaser.t0, d.teaser.t1) });
  for (const p of placed) {
    const edges = [p.src0, ...cutsAt.filter((t) => t > p.src0 + SLIVER && t < p.src1 - SLIVER), p.src1];
    const at = (e: number) => (e === p.src1 ? p.t1 : p.t0 + (e - p.src0) / d.speed);
    edges.slice(1).forEach((b, j) => video.push({
      kind: 'piece', label: '', src0: edges[j], src1: b, t0: at(edges[j]), t1: at(b), piece: p.keep, edgeStart: j === 0, edgeEnd: j === edges.length - 2,
      videoNo: videoOf(edges[j], b),
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

  // текст и вставки — с правками Павла; каждый блок помнит, откуда он в черновике сессии
  const base: Draft = { ...d, accents: tagged(d.accents ?? []), inserts: tagged(d.inserts) };
  const shown = applyText(base, fixes?.text, fixes?.words);
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

  // ч/б — кадры, где ролик чёрно-белый (look_windows: край у склейки — на склейке; копия в тизере)
  const looks: Clip[] = lookWindows(d.looks ?? [], tl).map(([a, b]) => ({ kind: 'bw', label: 'bw', t0: a / FPS, t1: b / FPS }));
  // переходы — на стыке, у самого начала и конца ролика их нет (transitions.marks)
  const marks = transitionMarks(d.transitions ?? [], tl);
  const transitions = marks.map((m) => ({ t: m.t, kind: m.kind }));

  // звуки — где их ставит движок (render._sounds): вставка — с её появлением, тизер — на стыке, переход — с его началом,
  // карточка — после стоп-кадра
  const sounds: Clip[] = [];
  const sound = (key: string, t: number, file: string) => sounds.push({ kind: 'sound', key, file, label: stem(file), t0: t, t1: t + SOUND_SHOW });
  for (const [n, start] of spans) {
    const sfx = ((layer.inserts ?? [])[n] as DraftInsert).sfx;
    if (sfx) sound(`insert:${n}`, start / FPS, sfx);
  }
  if (d.teaser?.sfx) sound('teaser', tl.teaserDuration, d.teaser.sfx);
  const sources = (d.transitions ?? []).map((x) => Number(x.t));
  for (const m of marks) {
    const sfx = (d.transitions ?? [])[sources.indexOf(m.source)]?.sfx;
    if (sfx) sound(`transition:${sources.indexOf(m.source)}`, Math.max(0, m.t - HALF), sfx);
  }
  if (d.end?.sfx) sound('end', tl.duration + (d.hold ?? 0), d.end.sfx);
  sounds.sort((a, b) => a.t0 - b.t0);

  return {
    duration: tl.duration, tail: (d.hold ?? 0) + (d.end?.seconds ?? 0), video, cuts, subtitles, text, inserts, looks, transitions, sounds,
    music: d.music ? { label: stem(d.music.file), gainDb: d.music.gainDb, ...Object.fromEntries(MUSIC_PLACE.filter((m) => d.music?.[m] !== undefined).map((m) => [m, d.music?.[m]])) } : null,
    layer: { edit: layer, tl },
  };
}

/** Блок на дорожках «Текст» и «Вставки» по виду и номеру в edit.json (у хука и титра номера нет); убранный — тень. */
export function findBlock(t: Tracks, kind: 'hook' | 'cta' | 'accent' | 'insert', n = 0): Clip | null {
  const list = kind === 'insert' ? t.inserts : t.text;
  return list.find((c) => c.ref?.kind === kind && (kind === 'hook' || kind === 'cta' || ('n' in c.ref && c.ref.n === n))) ?? null;
}

// ---------- правки руками ----------

/** Черновик с правками Павла (timeline.json): куски — как их вырежет движок (applyKeep — apply_keep), музыка — с его
 *  местом и громкостью («без звука» дорожка показывает отдельно); `splits` — его разрезы для draftTracks. Правок нет —
 *  тот же черновик. Текст и вставки сюда не входят — их кладёт draftTracks (`fixes`): правка текста не двигает плеер. */
export function withHandEdits(d: Draft, h: HandEdits, sourceDuration?: number): { draft: Draft; splits: number[] } {
  const splits = h.edits.flatMap((e) => (e.op === 'split' ? [e.t] : []));
  const keep = h.edits.length ? applyKeep(d.keep, h.edits, sourceDuration) : d.keep;
  const { muted: _muted, ...place } = h.music ?? {};
  const music = d.music && h.music ? { ...d.music, ...place } : d.music;
  return { draft: keep === d.keep && music === d.music ? d : { ...d, keep, music }, splits };
}

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
