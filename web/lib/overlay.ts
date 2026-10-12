// События слоя — перенос build_overlay_events и insert_spans из engine/vm/overlay.py (там — правила целиком): что
// рисует шаблон (template/overlay.js) в каждый промежуток финала. Редактор берёт состояние в момент плейхеда — и текст
// на кадре такой же, как в ролике: субтитры, хук, титр, акцентные фразы, вставки, финальная карточка, кадр в кадр.
// Общая фикстура engine/tests/fixtures/overlay-events.json (пишет engine/tests/shared_events.py); меняются только вместе.
import { sameJson } from './equal.ts';
import { roundHalfEven } from './pyround.ts';
import { buildSubEvents, type Word } from './subs.ts';
import { Timeline } from './timeline.ts';

export const FPS = 30;
const APPEAR = 3; // кадров появления вставки
const MIN_SHOW = 1.5; // с — вставка показывается не короче
const DRAWN = ['image', 'badge', 'sticker', 'text', 'anim']; // что рисует шаблон; fullscreen — ffmpeg
const INSERT_FIELDS = ['kind', 'src', 'text', 'title', 'x', 'y', 'w', 'params'] as const;
// анимации стиля эталона рисует шаблон (overlay.js: SOFT, ACC); здесь — сколько кадров давать им время
const SUB_APPEAR = 4;
const HOOK_APPEAR = 8;
const ACCENT_ANIM: Record<string, number> = { blur: 0.25, track: 0.17, letters: 0.33 };
const TYPE_CPS = 30;
const TYPE_CURSOR = 0.28;
const ACCENT_LINGER = 0.3;
const ACCENT_LEAVE = 4;
const DONE = 99.0; // возраст строки, анимация которой кончилась
const WORD_SLACK = 0.05;

export type AccentLine = { text: string; size?: string; color?: string };
export type AccentSpec = { t0: number; t1: number; x: number; y: number; lines: AccentLine[]; anim?: string | null; out?: string | null };
export type InsertSpec = {
  kind: string; t0: number; t1: number; src?: string; text?: string; title?: string; x?: number | null; y?: number | null; w?: number | null;
  params?: Record<string, unknown>;
  off?: boolean; // выключил Павел в редакторе: в ролике её нет, номер остаётся
};
/** То из edit.json (уже с правками руками), из чего строится слой; `style` — стиль, который увидит ролик. */
export type OverlayEdit = {
  words?: Word[] | null;
  style: { subtitles: { mode: string; words: number }; hook?: { mode: string } };
  hook?: { text: string; until: number } | null;
  cta?: { t0: number; t1: number; lines: string[]; word: string } | null;
  accents?: AccentSpec[] | null;
  inserts?: InsertSpec[] | null;
  hold?: number | null;
  end?: { seconds: number; lines: string[]; handle?: string | null; logo?: string | null } | null;
  zone?: string | null;
};
/** Промежуток финала и что в нём рисует шаблон (`window.renderState`). */
export type LayerEvent = { t0: number; t1: number; state: Record<string, unknown> };

type AccentInfo = { frames: number[]; ends: number[]; leave: number; moving: [number, number][] };
/** Что-то видимое на кадрах [start, stop). */
type Piece = {
  start: number; stop: number; key: string; value: Record<string, unknown>;
  insert?: boolean; everyFrame?: boolean; timed?: boolean; appear?: number; accent?: AccentInfo;
  n?: number; // номер акцента или вставки в edit.json — для блоков на дорожках редактора
};

/** Кадр момента финала: round() Python — ровно половина кадра к чётному. */
export const frameOf = (t: number): number => roundHalfEven(t * FPS);
export { pyRound } from './pyround.ts';

const TEASER = [1.0, 5.0] as const; // с — длина фразы тизера (TEASER движка, render.py)

/** Шкала, на которой монтаж режет ролик и строит слой (render.timeline): края кусков и тизера — на целых кадрах исходника
 *  (30 к/с), не дальше его последнего кадра (`limit` — длина исходника); кусок короче кадра пропадает. Тизер не той
 *  длины или за концом исходника — Error, как RenderError движка. */
export function renderTimeline(edit: { keep: readonly (readonly number[])[]; speed: number; teaser?: { t0: number; t1: number } | null },
  limit?: number | null): Timeline {
  const last = limit === undefined || limit === null ? null : Math.floor(limit * FPS + 0.01);
  const frames = (a: number, b: number): [number, number] | null => {
    const fa = roundHalfEven(a * FPS);
    const fb = last === null ? roundHalfEven(b * FPS) : Math.min(roundHalfEven(b * FPS), last);
    return fb > fa ? [fa / FPS, fb / FPS] : null;
  };
  const keep = edit.keep.flatMap(([a, b]) => {
    const span = frames(a, b);
    return span ? [span] : [];
  });
  let teaser: [number, number] | null = null;
  if (edit.teaser) { // тизер не пропадает молча: ошибка называет, что с ним не так
    const t0 = Number(edit.teaser.t0);
    const t1 = Number(edit.teaser.t1);
    if (t1 <= t0) throw new Error(`edit.json: teaser — t1 (${t1}) должен быть больше t0 (${t0})`);
    if (!(TEASER[0] <= t1 - t0 && t1 - t0 <= TEASER[1])) throw new Error(`edit.json: teaser — ${(t1 - t0).toFixed(1)} с, нужна фраза на ${TEASER[0]}–${TEASER[1]} с`);
    teaser = frames(t0, t1);
    if (!teaser) throw new Error(`edit.json: teaser ${t0}–${t1} с — за концом исходника`);
  }
  return new Timeline(keep, edit.speed, teaser);
}

/** Промежутки финала `{t0, t1, state}` по возрастанию, встык, от 0 до конца ролика со стоп-кадром и карточкой. Вставке,
 *  которую рисует шаблон, без места на кадре — Error (как ValueError движка). */
export function buildOverlayEvents(edit: OverlayEdit, tl: Timeline): LayerEvent[] {
  const { pieces, last, end } = layerPieces(edit, tl);
  const borders = new Set<number>([0, last]);
  const add = (from: number, to: number) => { // range(from, to)
    for (let f = from; f < to; f++) borders.add(f);
  };
  for (const p of pieces) {
    if (p.stop <= p.start) continue;
    borders.add(p.start);
    borders.add(p.stop);
    if (p.insert) add(p.start + 1, Math.min(p.start + APPEAR, p.stop));
    if (p.everyFrame || p.timed) add(p.start, p.stop);
    add(p.start, Math.min(p.stop, p.start + (p.appear ?? 0) + 1));
    for (const [a, b] of p.accent?.moving ?? []) add(Math.max(a, p.start), Math.min(b, p.stop) + 1);
  }
  const marks = [...borders].filter((b) => b >= 0 && b <= last).sort((a, b) => a - b);

  const framed: LayerEvent[] = [];
  for (let i = 0; i + 1 < marks.length; i++) {
    const state = stateOf(pieces, marks[i]);
    const prev = framed.at(-1);
    if (prev && sameJson(prev.state, state)) prev.t1 = marks[i + 1];
    else framed.push({ t0: marks[i], t1: marks[i + 1], state });
  }
  const events = framed.length
    ? framed.map((e) => ({ t0: e.t0 / FPS, t1: e.t1 === last ? end : e.t1 / FPS, state: e.state }))
    : [{ t0: 0, t1: end, state: {} }];
  if (edit.zone === 'ads') for (const e of events) e.state.zone = 'ads'; // версия для рекламы: всё выше кнопки и подписи
  return events;
}

/** Всё видимое на кадрах ролика: субтитры, хук, титр, акценты, вставки (что видно в последний кадр — до конца стоп-кадра),
 *  финальная карточка; `last` — кадров во всём ролике, `end` — его конец, с. */
function layerPieces(edit: OverlayEdit, tl: Timeline): { pieces: Piece[]; last: number; end: number } {
  const hold = Number(edit.hold || 0);
  const card = edit.end || null;
  const end = tl.duration + hold + (card ? Number(card.seconds) : 0);
  const last = frameOf(end);
  const still = frameOf(tl.duration + hold);
  const video = frameOf(tl.duration);
  // что начинается не раньше конца ролика, в ролике не видно — на стоп-кадре тоже не появляется
  const subtitles = subtitlePieces(edit, tl);
  const accents = accentPieces(edit, tl, subtitles.map((p) => p.start));
  const pieces = [...subtitles, ...titlePieces(edit, tl), ...accents, ...insertPieces(edit, tl)].filter((p) => p.start < video);
  for (const piece of pieces) {
    if (piece.stop < video) continue; // видно в последний кадр — остаётся на стоп-кадре, но не на карточке
    piece.stop = still;
    if (piece.accent) { // акцент не уходит: на стоп-кадре он такой, каким был в последний кадр
      piece.accent.leave = piece.stop;
      piece.accent.moving = piece.accent.moving.slice(0, piece.accent.frames.length);
    }
  }
  if (card) {
    const shown: Record<string, unknown> = {};
    for (const k of ['handle', 'logo'] as const) if (card[k]) shown[k] = card[k];
    pieces.push({ start: still, stop: last, key: 'end', value: { lines: [...card.lines], ...shown }, timed: true });
  }
  return { pieces, last, end };
}

/** Блок на дорожке редактора — время финала, когда это видно на кадре (ровно по кадрам слоя); `n` — номер в edit.json. */
export type LayerBlock = { t0: number; t1: number; n: number };
/** Где на дорожках хук, титр, акценты и вставки — те же кадры, что рисует слой (вставка — не раньше конца хука и не
 *  короче 1,5 с; что видно в последний кадр — до конца стоп-кадра). Не видно в ролике (начинается после его конца,
 *  fullscreen — её монтирует ffmpeg) — блока нет. */
export function layerBlocks(edit: OverlayEdit, tl: Timeline): { hook: LayerBlock | null; cta: LayerBlock | null; accents: LayerBlock[]; inserts: LayerBlock[] } {
  const { pieces, last, end } = layerPieces(edit, tl);
  const block = (p: Piece): LayerBlock => ({ t0: p.start / FPS, t1: p.stop === last ? end : p.stop / FPS, n: p.n ?? 0 }); // как у событий
  const one = (key: string) => {
    const p = pieces.find((x) => x.key === key && x.stop > x.start);
    return p ? block(p) : null;
  };
  const shown = (p: Piece) => p.stop > p.start;
  return {
    hook: one('hook'),
    cta: one('cta'),
    accents: pieces.filter((p) => p.key === 'accent' && shown(p)).map(block).sort((a, b) => a.n - b.n),
    inserts: pieces.filter((p) => p.insert && shown(p)).map(block),
  };
}

/** Состояние слоя в момент `t` финала: событие, в котором он лежит (граница — следующему; после конца — последнее). */
export function stateAt(events: readonly LayerEvent[], t: number): Record<string, unknown> {
  if (!events.length) return {};
  let lo = 0;
  let hi = events.length - 1;
  while (lo < hi) { // последнее событие с t0 <= t
    const mid = (lo + hi + 1) >> 1;
    if (events[mid].t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  return events[lo].state;
}

function subtitlePieces(edit: OverlayEdit, tl: Timeline): Piece[] {
  const style = edit.style.subtitles;
  const hidden = (edit.accents || []).map((a) => [Number(a.t0), Number(a.t1)]);
  const soft = style.mode === 'soft';
  return buildSubEvents(edit.words || [], tl, style.mode, style.words, hidden).map((e) => {
    const sub: Record<string, unknown> = { words: [...e.words], active: e.active, visible: e.visible };
    if (soft) { // opens — блок начинает предложение: иначе шаблон сделал бы строчным и имя посреди фразы
      sub.lines = [...(e.lines as number[])];
      sub.opens = e.opens;
    }
    return { start: frameOf(e.t0), stop: frameOf(e.t1), key: 'sub', value: sub, appear: soft ? SUB_APPEAR : 0 };
  });
}

/** Слово для сравнения: строчные, ё → е, без знаков препинания (_norm движка: [^\w-] Python — буквы, цифры, «_»). */
const norm = (text: string): string => text.toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/^-+|-+$/g, '');

/** Время исходника, когда звучит первое слово каждой строки акцента (_line_times движка). */
function lineTimes(accent: AccentSpec, words: readonly Word[]): number[] {
  const t0 = Number(accent.t0);
  const t1 = Number(accent.t1);
  const phrase = words.filter((w) => t0 - WORD_SLACK <= w.t0 && w.t0 <= t1 + WORD_SLACK).sort((a, b) => a.t0 - b.t0);
  const times = [t0];
  let at = 0;
  for (const line of accent.lines.slice(1)) {
    const first = norm(String(line.text ?? '').trim().split(/\s+/)[0] ?? '');
    let found = -1;
    for (let i = at; i < phrase.length && first; i++) {
      if (norm(phrase[i].text) === first) {
        found = i;
        break;
      }
    }
    const prev = times.at(-1) as number;
    if (found < 0) {
      times.push(prev);
      continue;
    }
    times.push(Math.max(prev, phrase[found].t0));
    at = found + 1;
  }
  return times;
}

/** Сколько кадров строка акцента появляется (печать — по буквам: длина в символах, как len() Python). */
function appearFrames(line: AccentLine, anim: string): number {
  const seconds = anim === 'type' ? [...String(line.text ?? '')].length / TYPE_CPS + TYPE_CURSOR : ACCENT_ANIM[anim] ?? ACCENT_ANIM.blur;
  return Math.ceil(seconds * FPS - 1e-9);
}

function accentPieces(edit: OverlayEdit, tl: Timeline, subStarts: number[]): Piece[] {
  // по месту в ролике (куски могут стоять не по порядку исходника); фраза — до конца своей серии (Timeline.span)
  const key = (a: AccentSpec) => tl.toFinalSnap(Number(a.t0));
  const accents = [...(edit.accents || [])].sort((a, b) => key(a) - key(b) || Number(a.t0) - Number(b.t0));
  const words = edit.words || [];
  const spans = accents.map((a) => tl.span(Number(a.t0), Number(a.t1)));
  const starts = spans.map(([a]) => frameOf(a));
  return accents.map((accent, k) => {
    const start = starts[k];
    const said = frameOf(spans[k][1]);
    let stop = Math.min(frameOf(spans[k][1] + ACCENT_LINGER), ...subStarts.filter((s) => s >= said), ...starts.slice(k + 1).filter((s) => s > start));
    const lines = accent.lines.map((line) => ({ ...line }));
    const frames = lineTimes(accent, words).map((t) => Math.min(Math.max(frameOf(tl.toFinalSnap(t)), start), Math.max(start, stop - 1)));
    stop = Math.max(stop, (frames.at(-1) as number) + 1, start + 1);
    const anim = accent.anim || 'blur';
    const out = accent.out || 'fade';
    if (frames.length !== lines.length) throw new Error('accent: строк и их времён — не поровну');
    const moving: [number, number][] = frames.map((f, i) => [f, f + appearFrames(lines[i], anim)]);
    const leave = out !== 'cut' ? Math.max(stop - ACCENT_LEAVE, start + 1) : stop;
    const ends = moving.slice(0, lines.length).map(([, b]) => b);
    if (leave < stop) moving.push([leave, stop]);
    const value = { lines, x: accent.x, y: accent.y, anim, out };
    return { start, stop, key: 'accent', value, accent: { frames, ends, leave, moving }, n: (edit.accents || []).indexOf(accent) };
  });
}

function accentState(piece: Piece, frame: number): Record<string, unknown> {
  const info = piece.accent as AccentInfo;
  const ages = info.frames.map((f, i) => (frame < f ? null : frame < info.ends[i] ? (frame - f + 1) / FPS : DONE));
  const state: Record<string, unknown> = { ...piece.value, ages };
  if (frame >= info.leave) state.leave = (frame - info.leave + 1) / (piece.stop - info.leave);
  return state;
}

function titlePieces(edit: OverlayEdit, tl: Timeline): Piece[] {
  const pieces: Piece[] = [];
  if (edit.hook) {
    const moving = edit.style.hook?.mode === 'accent' ? HOOK_APPEAR : 0;
    pieces.push({ start: 0, stop: hookEnd(edit, tl), key: 'hook', value: { text: edit.hook.text }, appear: moving });
  }
  if (edit.cta) {
    const [a, b] = tl.span(Number(edit.cta.t0), Number(edit.cta.t1));
    pieces.push({ start: frameOf(a), stop: frameOf(b), key: 'cta', value: { lines: [...edit.cta.lines], word: edit.cta.word } });
  }
  return pieces;
}

/** Кадр, на котором хук уходит: `hook.until` по порядку исходника; есть тизер — хук на нём целиком (_hook_end). */
export function hookEnd(edit: OverlayEdit, tl: Timeline): number {
  if (!edit.hook) return 0;
  return tl.teaser ? frameOf(tl.teaserDuration) : frameOf(tl.inSourceOrder().toFinalSnap(edit.hook.until));
}

/** Кадры показа вставок `[номер в edit.inserts, первый кадр, кадр после последнего]`: не раньше конца хука, не короче
 *  1,5 с, не дальше своей серии кусков. Все виды, и fullscreen; выключенных Павлом (`off`) — нет (insert_spans движка). */
export function insertSpans(edit: OverlayEdit, tl: Timeline): [number, number, number][] {
  const afterHook = hookEnd(edit, tl);
  const minShow = Math.ceil(MIN_SHOW * FPS - 1e-9);
  return (edit.inserts || []).flatMap((ins, i): [number, number, number][] => {
    if (ins.off) return []; // номер остаётся: по нему ключи звуков insert:<n> и рамки в boxes.json
    const [a, b] = tl.span(Number(ins.t0), Number(ins.t1));
    const start = Math.max(frameOf(a), afterHook);
    return [[i, start, Math.max(frameOf(b), start + minShow)]];
  });
}

function insertPieces(edit: OverlayEdit, tl: Timeline): Piece[] {
  const inserts = edit.inserts || [];
  return insertSpans(edit, tl).flatMap(([i, start, stop]): Piece[] => {
    const ins = inserts[i];
    if (!DRAWN.includes(ins.kind)) return [];
    const missing = (['x', 'y', 'w'] as const).filter((k) => ins[k] === undefined || ins[k] === null);
    if (missing.length) throw new Error(`inserts[${i}]: вставке «${ins.kind}» нужно место на кадре — нет ${missing.join(', ')}`);
    const value: Record<string, unknown> = {};
    for (const k of INSERT_FIELDS) if (k in ins) value[k] = ins[k];
    value.n = i; // номер — для рамок в boxes.json и QA
    return [{ start, stop, key: `insert${i}`, value, insert: true, everyFrame: ins.kind === 'anim', n: i }];
  });
}

function stateOf(pieces: Piece[], frame: number): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  const inserts: Record<string, unknown>[] = [];
  for (const p of pieces) {
    if (!(p.start <= frame && frame < p.stop)) continue;
    if (p.insert) {
      const shown = frame - p.start;
      inserts.push({ ...p.value, anim: Math.min(1, (shown + 1) / APPEAR), t: p.everyFrame ? shown / FPS : 0 });
    } else if (p.timed) state[p.key] = { ...p.value, t: (frame - p.start) / FPS };
    else if (p.accent) state[p.key] = accentState(p, frame);
    else if (frame - p.start < (p.appear ?? 0)) state[p.key] = { ...p.value, t: (frame - p.start + 1) / FPS };
    else state[p.key] = p.value;
  }
  if (inserts.length) state.inserts = inserts;
  if ('accent' in state) delete state.sub; // слова акцента — и есть субтитры
  return state;
}
