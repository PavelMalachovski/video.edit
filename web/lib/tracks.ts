// Дорожки редактора (бета) по черновику монтажа: edit.json сессии (времена — по исходнику) → куски видео, вырезанное,
// субтитры, тексты, вставки, ч/б, музыка и переходы во времени финала (Timeline — как у движка); правки Павла руками
// (timeline.json) — поверх черновика, как их положит движок. И файлы редактора от vm prepare (editor.json): прокси,
// лента кадров, волна.
import { applyKeep, SLIVER, type HandEdits } from './edits.ts';
import { Timeline } from './timeline.ts';

type Span = { t0: number; t1: number };
export type DraftWord = Span & { text: string };
export type DraftInsert = Partial<Span> & {
  kind: string; src?: string; question?: string; id?: string; text?: string; x?: number; y?: number; w?: number; sfx?: string | null;
};
/** То из edit.json, что показывает редактор. */
export type Draft = {
  speed: number;
  keep: [number, number][];
  words: DraftWord[];
  hook: { text: string; until: number } | null;
  cta: (Span & { lines: string[]; word: string }) | null;
  inserts: DraftInsert[];
  accents?: (Span & { lines: { text: string }[] })[];
  looks?: (Span & { look: string })[];
  zooms: { t: number; level: number; over?: number }[];
  music: { file: string; gainDb: number; at?: number; from?: number; fadeIn?: number; fadeOut?: number } | null;
  teaser?: (Span & { sfx?: string | null }) | null;
  transitions?: { t: number; kind: string; sfx?: string | null }[];
  hold?: number;
  end?: { seconds: number; sfx?: string | null } | null;
};

/** editor.json: длина исходника, прокси (из релиза), лента кадров и волна (base64 байтов 0–255, perS в секунду). */
export type EditorMedia = {
  duration: number;
  proxy: { file: string; width: number; height: number; key: number } | null; // null — исходник длинный, прокси нет
  film: { file: string; step: number; w: number; h: number; n: number };
  peaks: { perS: number; data: string };
};

/** Клип дорожки во времени финала. У кусков видео: `src0`–`src1` исходника, `piece` — номер куска монтажа (`keep`),
 *  `edgeStart`/`edgeEnd` — край куска (его можно тянуть), а не разрез Павла. У субтитров `words` — слова группы
 *  (время финала), у звуков `key` — ключ правки громкости (insert:<n>, teaser, transition:<n>, end). */
export type Clip = Span & {
  kind: string; label: string; src0?: number; src1?: number; words?: DraftWord[]; piece?: number; edgeStart?: boolean; edgeEnd?: boolean; key?: string;
  file?: string; // у звуков — файл (как в edit.json)
};
export type Tracks = {
  duration: number; // длина финала без хвоста (кусков), с
  tail: number; // после кусков — стоп-кадр (hold) и финальная карточка, с
  video: Clip[]; // куски по порядку (тизер — первым): t0–t1 финала, src0–src1 исходника
  cuts: { at: number; src0: number; src1: number }[]; // вырезанное исходника — на стыке финала
  subtitles: Clip[];
  text: Clip[]; // хук, акцентные фразы, титр
  inserts: Clip[];
  looks: Clip[]; // ч/б куски
  music: { label: string; gainDb: number; at?: number; from?: number; fadeIn?: number; fadeOut?: number } | null;
  transitions: { t: number; kind: string }[];
  sounds: Clip[]; // звуки: появления вставок, стык тизера, переходы, карточка
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isSpan = (x: unknown): x is Span & Record<string, unknown> => isObj(x) && isNum(x.t0) && isNum(x.t1);

/** edit.json → черновик для показа; не та форма (или Timeline его не примет) — null. */
export function parseDraft(raw: unknown): Draft | null {
  if (!isObj(raw) || !isNum(raw.speed) || raw.speed <= 0 || !Array.isArray(raw.keep) || !Array.isArray(raw.words)) return null;
  if (!raw.keep.every((k) => Array.isArray(k) && k.length === 2 && isNum(k[0]) && isNum(k[1]))) return null;
  if (!raw.words.every((w) => isSpan(w) && isStr(w.text))) return null;
  const list = <T>(x: unknown, ok: (y: unknown) => boolean): T[] => (Array.isArray(x) ? (x.filter(ok) as T[]) : []);
  const hook = isObj(raw.hook) && isStr(raw.hook.text) && isNum(raw.hook.until) ? { text: raw.hook.text, until: raw.hook.until } : null;
  const cta = isSpan(raw.cta) && Array.isArray(raw.cta.lines) && isStr(raw.cta.word) ? (raw.cta as Draft['cta']) : null;
  const place = (m: Record<string, unknown>) => Object.fromEntries(MUSIC_PLACE.filter((k) => isNum(m[k])).map((k) => [k, m[k] as number]));
  const music = isObj(raw.music) && isStr(raw.music.file) && isNum(raw.music.gainDb)
    ? { file: raw.music.file, gainDb: raw.music.gainDb, ...place(raw.music) } : null;
  const sfx = (x: unknown) => (isStr(x) ? x : null);
  const draft: Draft = {
    speed: raw.speed,
    keep: raw.keep as [number, number][],
    words: raw.words as DraftWord[],
    hook,
    cta,
    inserts: list(raw.inserts, (i) => isObj(i) && isStr(i.kind)),
    accents: list(raw.accents, (a) => isSpan(a) && Array.isArray(a.lines)),
    looks: list(raw.looks, (l) => isSpan(l) && isStr(l.look)),
    zooms: list(raw.zooms, (z) => isObj(z) && isNum(z.t) && isNum(z.level)),
    music,
    teaser: isSpan(raw.teaser) ? { t0: raw.teaser.t0, t1: raw.teaser.t1, sfx: sfx(raw.teaser.sfx) } : null,
    transitions: list(raw.transitions, (x) => isObj(x) && isNum(x.t) && isStr(x.kind)),
    hold: isNum(raw.hold) ? raw.hold : 0,
    end: isObj(raw.end) && isNum(raw.end.seconds) ? { seconds: raw.end.seconds, sfx: sfx(raw.end.sfx) } : null,
  };
  try {
    timelineOf(draft);
  } catch {
    return null;
  }
  return draft;
}

/** editor.json → данные; не та форма — null. */
export function parseMedia(raw: unknown): EditorMedia | null {
  if (!isObj(raw) || !isNum(raw.duration) || raw.duration <= 0) return null;
  const { proxy, film, peaks } = raw;
  if (proxy !== null && !(isObj(proxy) && isStr(proxy.file) && isNum(proxy.width) && isNum(proxy.height) && isNum(proxy.key))) return null;
  const int = (x: unknown, max: number) => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= max;
  if (!isObj(film) || !isStr(film.file) || !isNum(film.step) || film.step <= 0 || !int(film.w, 1080) || !int(film.h, 1920) || !int(film.n, FILM_MAX)) return null;
  if (!isObj(peaks) || !int(peaks.perS, 1000) || !isStr(peaks.data)) return null;
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

export const timelineOf = (d: Draft): Timeline => new Timeline(d.keep, d.speed, d.teaser ? [d.teaser.t0, d.teaser.t1] : null);

const GROUP_GAP = 0.6; // с финала: пауза длиннее — новая группа субтитров
const MUSIC_PLACE = ['at', 'from', 'fadeIn', 'fadeOut'] as const; // где звучит музыка — правка Павла в редакторе
const HALF = 0.12; // с — половина перехода; переход у самого начала или конца ролика пропадает (transitions.py)
const SOUND_SHOW = 0.4; // с — ширина метки звука на дорожке
const MIN_SHOW = 1.5; // с — вставка показывается не короче (MIN_SHOW движка, overlay.py)
const FILM_MAX = 1000; // кадров в ленте — не больше (FILM['max'] движка, editor.py)

/** Имя файла без папки и расширения. */
const stem = (path: string): string => path.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? path;

/** Дорожки черновика во времени финала. `perGroup` — слов в группе субтитров (как `subtitles.words` стиля);
 *  `sourceDuration` — длина исходника: вырезанный хвост после последнего куска; `splits` — разрезы Павла (с исходника):
 *  делят куски видео на экране (на монтаж не влияют). */
export function draftTracks(d: Draft, { perGroup = 3, sourceDuration, splits = [] }: { perGroup?: number; sourceDuration?: number; splits?: number[] } = {}): Tracks {
  const tl = timelineOf(d);
  const at = (t: number) => tl.toFinalSnap(t);
  const span = (s: Span) => ({ t0: at(s.t0), t1: Math.max(at(s.t0), at(s.t1)) });

  const cutsAt = [...splits].sort((x, y) => x - y);
  let pieceNo = 0;
  const video: Clip[] = tl.segments.flatMap(([src0, src1, t0], i): Clip[] => {
    if (d.teaser && i === 0) return [{ kind: 'teaser', label: '', src0, src1, t0, t1: t0 + (src1 - src0) / d.speed }];
    const piece = pieceNo++;
    const edges = [src0, ...cutsAt.filter((t) => t > src0 + SLIVER && t < src1 - SLIVER), src1];
    return edges.slice(1).map((b, k) => ({
      kind: 'piece', label: '', src0: edges[k], src1: b, t0: t0 + (edges[k] - src0) / d.speed, t1: t0 + (b - src0) / d.speed,
      piece, edgeStart: k === 0, edgeEnd: k === edges.length - 2,
    }));
  });
  const pieces = video.filter((c) => c.kind === 'piece');
  const cuts: Tracks['cuts'] = [];
  let prev = 0;
  for (const c of pieces) {
    if ((c.src0 as number) > prev + 1e-6) cuts.push({ at: c.t0, src0: prev, src1: c.src0 as number });
    prev = c.src1 as number;
  }
  if (sourceDuration !== undefined && sourceDuration > prev + 1e-6) cuts.push({ at: tl.duration, src0: prev, src1: sourceDuration });

  // субтитры: слова, что остались (середина слова — в куске), без слов акцентов; группы — не через склейку
  const inAccent = (t: number) => (d.accents ?? []).some((a) => t >= a.t0 && t <= a.t1);
  const pieceOf = (t: number) => pieces.find((c) => t >= (c.src0 as number) && t <= (c.src1 as number))?.piece ?? -1;
  const subtitles: Clip[] = [];
  let group: { words: DraftWord[]; piece: number } | null = null;
  const close = () => {
    if (!group) return;
    const words = group.words.map((w) => ({ text: w.text, t0: tl.toFinal(w.t0) ?? at(w.t0), t1: tl.toFinal(w.t1) ?? at(w.t1) }));
    subtitles.push({ kind: 'sub', label: group.words.map((w) => w.text).join(' '), t0: words[0].t0, t1: (words.at(-1) as DraftWord).t1, words });
    group = null;
  };
  for (const w of d.words) {
    const mid = (w.t0 + w.t1) / 2;
    const piece = pieceOf(mid);
    if (piece < 0 || inAccent(mid)) continue;
    const prevWord = group?.words.at(-1);
    const gap = prevWord ? at(w.t0) - at(prevWord.t1) : 0;
    if (group && (group.piece !== piece || group.words.length >= perGroup || gap > GROUP_GAP)) close();
    if (!group) group = { words: [], piece };
    group.words.push(w);
  }
  close();

  // хук — до hook.until на его месте в ролике, а с тизером — на весь тизер (_hook_end движка)
  const hookEnd = d.hook ? (d.teaser ? tl.teaserDuration : at(d.hook.until)) : 0;
  const text: Clip[] = [];
  if (d.hook) text.push({ kind: 'hook', label: d.hook.text, t0: 0, t1: hookEnd });
  for (const a of d.accents ?? []) text.push({ kind: 'accent', label: a.lines.map((l) => l.text).join(' '), ...span(a) });
  if (d.cta) text.push({ kind: 'cta', label: [...d.cta.lines, d.cta.word].join(' '), ...span(d.cta) });

  // вставки — не раньше конца хука и не короче MIN_SHOW (insert_spans движка)
  const inserts: (Clip & { index: number })[] = d.inserts.flatMap((i, index) => {
    if (!isSpan(i)) return [];
    const t0 = Math.max(at(i.t0), hookEnd);
    return [{
      kind: i.kind, label: i.kind === 'text' ? (i.text ?? i.id ?? '') : (i.question ?? (i.src ? stem(i.src) : i.id ?? '')),
      t0, t1: Math.max(at(i.t1), t0 + MIN_SHOW), index,
    }];
  });
  const looks: Clip[] = (d.looks ?? []).map((l) => ({ kind: l.look, label: l.look, ...span(l) }));
  // переходы — на стыке (to_final_snap), у самого начала и конца ролика их нет (marks движка)
  const fits = (t: number) => t >= HALF && t <= tl.duration - HALF;
  const transitions = (d.transitions ?? []).map((x) => ({ t: at(x.t), kind: x.kind })).filter((x) => fits(x.t));

  // звуки — где их ставит движок (_sounds): вставка — с её появлением, тизер — на стыке, переход — с его началом,
  // карточка — в конце ролика
  const sounds: Clip[] = [];
  const sound = (key: string, t: number, file: string) => sounds.push({ kind: 'sound', key, file, label: stem(file), t0: t, t1: t + SOUND_SHOW });
  d.inserts.forEach((ins, i) => {
    const shown = inserts.find((c) => c.index === i);
    if (ins.sfx && shown) sound(`insert:${i}`, shown.t0, ins.sfx);
  });
  if (d.teaser?.sfx) sound('teaser', tl.teaserDuration, d.teaser.sfx);
  (d.transitions ?? []).forEach((x, i) => {
    const t = at(x.t);
    if (x.sfx && fits(t)) sound(`transition:${i}`, Math.max(0, t - HALF), x.sfx);
  });
  if (d.end?.sfx) sound('end', tl.duration + (d.hold ?? 0), d.end.sfx); // карточка — после стоп-кадра (render._sounds)
  sounds.sort((a, b) => a.t0 - b.t0);

  return {
    duration: tl.duration, tail: (d.hold ?? 0) + (d.end?.seconds ?? 0), video, cuts, subtitles, text, inserts, looks, transitions, sounds,
    music: d.music ? { label: stem(d.music.file), gainDb: d.music.gainDb, ...Object.fromEntries(MUSIC_PLACE.filter((k) => d.music?.[k] !== undefined).map((k) => [k, d.music?.[k]])) } : null,
  };
}

// ---------- правки руками ----------

/** Черновик с правками Павла (timeline.json): куски — как их вырежет движок (applyKeep — apply_keep), музыка — с его
 *  местом и громкостью («без звука» дорожка показывает отдельно); `splits` — его разрезы для draftTracks. Правок нет —
 *  тот же черновик. */
export function withHandEdits(d: Draft, h: HandEdits, sourceDuration?: number): { draft: Draft; splits: number[] } {
  const splits = h.edits.flatMap((e) => (e.op === 'split' ? [e.t] : []));
  const keep = h.edits.length ? applyKeep(d.keep, h.edits, sourceDuration) : d.keep;
  const { muted: _muted, ...place } = h.music ?? {};
  const music = d.music && h.music ? { ...d.music, ...place } : d.music;
  return { draft: keep === d.keep && music === d.music ? d : { ...d, keep, music }, splits };
}

/** Где разрезать по плейхеду `at` (время финала): момент исходника внутри куска (не у самого края); в тизере, у края
 *  или мимо кусков — null. */
export function splitTarget(t: Tracks, at: number): number | null {
  const c = t.video.find((x) => x.kind === 'piece' && at > x.t0 && at < x.t1);
  if (!c || c.src0 === undefined || c.src1 === undefined) return null;
  const src = c.src0 + ((at - c.t0) * (c.src1 - c.src0)) / (c.t1 - c.t0);
  return src > c.src0 + SLIVER && src < c.src1 - SLIVER ? src : null;
}

/** Границы слов (с исходника) по порядку — к ним липнут края кусков. */
export const wordEdges = (d: Draft): number[] => [...new Set(d.words.flatMap((w) => [w.t0, w.t1]))].sort((a, b) => a - b);

/** Ключ кусков дорожки «Видео»: меняется, только когда меняются куски (вырезать, вернуть, разрезать), — тогда плеер
 *  встаёт на тот же момент ролика на новых кусках; громкость и музыка его не трогают. */
export const videoKey = (t: Tracks): string => t.video.map((c) => `${c.src0}-${c.src1}@${c.t0.toFixed(4)}`).join('|');
