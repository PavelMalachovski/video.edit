// Дорожки редактора (бета) по черновику монтажа: edit.json сессии (времена — по исходнику) → куски видео, вырезанное,
// субтитры, тексты, вставки, ч/б, музыка и переходы во времени финала (Timeline — как у движка). Только показ: правки
// на дорожках — следующая фаза. И файлы редактора от vm prepare (editor.json): прокси, лента кадров, волна.
import { Timeline } from './timeline.ts';

type Span = { t0: number; t1: number };
export type DraftWord = Span & { text: string };
export type DraftInsert = Partial<Span> & { kind: string; src?: string; question?: string; id?: string; text?: string; x?: number; y?: number; w?: number };
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
  music: { file: string; gainDb: number } | null;
  teaser?: Span | null;
  transitions?: { t: number; kind: string }[];
};

/** editor.json: длина исходника, прокси (из релиза), лента кадров и волна (base64 байтов 0–255, perS в секунду). */
export type EditorMedia = {
  duration: number;
  proxy: { file: string; width: number; height: number; key: number };
  film: { file: string; step: number; w: number; h: number; n: number };
  peaks: { perS: number; data: string };
};

export type Clip = Span & { kind: string; label: string; src0?: number; src1?: number };
export type Tracks = {
  duration: number; // длина финала, с
  video: Clip[]; // куски по порядку (тизер — первым): t0–t1 финала, src0–src1 исходника
  cuts: { at: number; src0: number; src1: number }[]; // вырезанное исходника — на стыке финала
  subtitles: Clip[];
  text: Clip[]; // хук, акцентные фразы, титр
  inserts: Clip[];
  looks: Clip[]; // ч/б куски
  music: { label: string; gainDb: number } | null;
  transitions: { t: number; kind: string }[];
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
  const music = isObj(raw.music) && isStr(raw.music.file) && isNum(raw.music.gainDb) ? { file: raw.music.file, gainDb: raw.music.gainDb } : null;
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
    teaser: isSpan(raw.teaser) ? { t0: raw.teaser.t0, t1: raw.teaser.t1 } : null,
    transitions: list(raw.transitions, (x) => isObj(x) && isNum(x.t) && isStr(x.kind)),
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
  if (!isObj(proxy) || !isStr(proxy.file) || !isNum(proxy.width) || !isNum(proxy.height) || !isNum(proxy.key)) return null;
  if (!isObj(film) || !isStr(film.file) || !isNum(film.step) || film.step <= 0 || !isNum(film.w) || !isNum(film.h) || !isNum(film.n) || film.n < 1) return null;
  if (!isObj(peaks) || !isNum(peaks.perS) || peaks.perS <= 0 || !isStr(peaks.data)) return null;
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

/** Имя файла без папки и расширения. */
const stem = (path: string): string => path.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? path;

/** Дорожки черновика во времени финала. `perGroup` — слов в группе субтитров (как `subtitles.words` стиля);
 *  `sourceDuration` — длина исходника: вырезанный хвост после последнего куска. */
export function draftTracks(d: Draft, { perGroup = 3, sourceDuration }: { perGroup?: number; sourceDuration?: number } = {}): Tracks {
  const tl = timelineOf(d);
  const at = (t: number) => tl.toFinalSnap(t);
  const span = (s: Span) => ({ t0: at(s.t0), t1: Math.max(at(s.t0), at(s.t1)) });

  const video: Clip[] = tl.segments.map(([src0, src1, t0], i) => ({
    kind: d.teaser && i === 0 ? 'teaser' : 'piece', label: '', src0, src1, t0, t1: t0 + (src1 - src0) / d.speed,
  }));
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
  const pieceOf = (t: number) => pieces.findIndex((c) => t >= (c.src0 as number) && t <= (c.src1 as number));
  const subtitles: Clip[] = [];
  let group: { words: DraftWord[]; piece: number } | null = null;
  const close = () => {
    if (!group) return;
    const first = group.words[0];
    const last = group.words.at(-1) as DraftWord;
    subtitles.push({ kind: 'sub', label: group.words.map((w) => w.text).join(' '), t0: tl.toFinal(first.t0) ?? at(first.t0), t1: tl.toFinal(last.t1) ?? at(last.t1) });
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

  const text: Clip[] = [];
  if (d.hook) text.push({ kind: 'hook', label: d.hook.text, t0: 0, t1: at(d.hook.until) });
  for (const a of d.accents ?? []) text.push({ kind: 'accent', label: a.lines.map((l) => l.text).join(' '), ...span(a) });
  if (d.cta) text.push({ kind: 'cta', label: [...d.cta.lines, d.cta.word].join(' '), ...span(d.cta) });

  const inserts: Clip[] = d.inserts.filter(isSpan).map((i) => ({
    kind: i.kind, label: i.kind === 'text' ? (i.text ?? i.id ?? '') : (i.question ?? (i.src ? stem(i.src) : i.id ?? '')), ...span(i as Span),
  }));
  const looks: Clip[] = (d.looks ?? []).map((l) => ({ kind: l.look, label: l.look, ...span(l) }));
  const transitions = (d.transitions ?? []).flatMap((x) => {
    const t = tl.toFinal(x.t);
    return t === null ? [] : [{ t, kind: x.kind }];
  });
  return {
    duration: tl.duration, video, cuts, subtitles, text, inserts, looks, transitions,
    music: d.music ? { label: stem(d.music.file), gainDb: d.music.gainDb } : null,
  };
}
