// Картинка ролика в превью редактора — перенос формул движка: зум по смыслу и смены крупности (engine/vm/zoom.py:
// zoom_at), переходы на стыках (transitions.marks: толчок зума, вспышка, смаз; вспышка и смаз по кадрам — flash_alpha,
// blur_sigma) и ч/б-куски (render.look_windows). Кадр финала рисует ffmpeg; страница повторяет то же CSS-преобразованием
// <video> (слой с текстом — поверх, его не трогают).
// Общая фикстура engine/tests/fixtures/overlay-events.json (look); меняются только вместе.
import { frameOf, insertSpans, type OverlayEdit } from './overlay.ts';
import { pyRound } from './pyround.ts';
import type { Timeline } from './timeline.ts';

const FPS = 30;
export const TRANS = 0.45; // с — длина перехода ступени по умолчанию
export const MIN_LEVEL = 1.0;
export const MAX_LEVEL = 1.16; // зум по смыслу
export const MAX_SHOT = 1.3; // смена крупности и наезд (ступень со своим over)
export const HALF = 0.12; // с — половина перехода на стыке
export const PUNCH = 0.25; // толчок зума: на стыке картинка крупнее в 1,25 раза
export const BLUR: readonly [number, number][] = [[8, 1.0], [14, 2 / 3], [24, 1 / 3]]; // смаз: sigma по x, px; доля полуокна
export const TEAR = 9; // кадров рваной бумаги до стыка (vm/tear.py FRAMES)
// глитч: полосы [y0, y1, сдвиг по x], px кадра 1080×1920 — на кадре до стыка, на стыке и после (transitions.GLITCH)
export const GLITCH: readonly (readonly (readonly [number, number, number])[])[] = [
  [[620, 700, 50], [1180, 1230, -40]],
  [[300, 420, -70], [760, 900, 60], [1400, 1460, 30]],
  [[980, 1060, -40]],
];
const TO_CUT = 0.25; // с исходника — край ч/б-куска так близко к краю отрезка встаёт на склейку

export type Zoom = { t: number; level: number; over?: number };
export type TransitionSpec = { t: number; kind: string; sfx?: string | null; off?: boolean };
type Step = [number, number, number, number]; // начало в финале, уровень на старте, целевой, длина перехода

/** Кадр финала, с которого видно то, что начинается в момент `t` (склейка, ч/б, резкая смена плана): media.cut_frame. */
export const cutFrame = (t: number): number => Math.ceil(t * FPS - 0.5 - 1e-6) + 0; // + 0: −0 → 0, как int Python

const smooth = (x: number) => 3 * x * x - 2 * x * x * x;

function stepStart(z: Zoom, tl: Timeline): number {
  const t = Number(z.t);
  if ('over' in z && Number(z.over) === 0) return (cutFrame(tl.toCut(t)) - 0.5) / FPS;
  return tl.toFinalSnap(t);
}

function stepTarget(z: Zoom): number {
  const top = 'over' in z ? MAX_SHOT : MAX_LEVEL;
  return Math.min(top, Math.max(MIN_LEVEL, Number(z.level)));
}

type Mark = [number, number, number, number, number]; // начало, вид (0 — серия, 1 — ступень), t, цель, переход

function steps(zooms: readonly Zoom[], tl: Timeline, trans: number): Step[] {
  if (!(trans > 0)) throw new Error(`trans must be positive, got ${trans}`);
  // в один момент финала могут попасть несколько ступеней: действует та, что позже в исходнике
  const marks: Mark[] = zooms.map((z) => [stepStart(z, tl), 1, Number(z.t), stepTarget(z), Math.max(0, 'over' in z ? Number(z.over) : trans)]);
  marks.push(...runMarks(zooms, tl, trans));
  marks.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const out: Step[] = [];
  for (const [start, , , target, over] of marks) out.push([start, levelAt(out, start), target, over]);
  return out;
}

/** Куски переставлены руками: в начале каждой серии — крупность её первого момента по порядку исходника (_run_marks). */
function runMarks(zooms: readonly Zoom[], tl: Timeline, trans: number): Mark[] {
  const starts: [number, number][] = [];
  let last: number | null | undefined;
  for (const [src0, src1, t0] of tl.segments.slice(tl.teaser ? 1 : 0)) {
    const run = tl.runOf((src0 + src1) / 2);
    if (run !== last) starts.push([t0, src0]);
    last = run;
  }
  if (starts.length < 2 || !zooms.length) return [];
  const plain = tl.inSourceOrder();
  const levels = steps(zooms, plain, trans);
  return starts.map(([t0, src0]): Mark => [t0, 0, src0, levelAt(levels, plain.toFinalSnap(src0)), 0]);
}

function levelAt(list: readonly Step[], t: number): number {
  let level = 1.0;
  for (const [start, source, target, over] of list) {
    if (t < start) break;
    const x = over > 0 ? (t - start) / over : 1.0;
    level = x >= 1 ? target : source + (target - source) * smooth(x);
  }
  return level;
}

function punch(t: number, punches: readonly number[]): number {
  let sum = 0;
  for (const p of punches) if (Math.abs(t - p) < HALF) sum += PUNCH * (1 - Math.abs(t - p) / HALF) ** 2;
  return 1 + sum;
}

/** Приближение картинки в момент `t` финала: ступени зума и толчки переходов zoom на стыках `punches` (zoom_at). */
export function zoomAt(zooms: readonly Zoom[], tl: Timeline, t: number, trans = TRANS, punches: readonly number[] = []): number {
  return levelAt(steps(zooms, tl, trans), t) * punch(t, punches);
}

/** Зум на весь ролик сразу: ступени считаются один раз, дальше — уровень в любой момент (для плеера). */
export function zoomLevels(zooms: readonly Zoom[], tl: Timeline, punches: readonly number[] = [], trans = TRANS): (t: number) => number {
  const list = steps(zooms, tl, trans);
  return (t) => levelAt(list, t) * punch(t, punches);
}

/** Переход на стыке во времени финала: `t` — стык, `source` — его t из edit.json. */
export type TransitionMark = { t: number; kind: string; source: number };

/** Сколько секунд переход идёт до стыка: с этого места — и его звук (transitions.lead). */
export const transitionLead = (kind: string): number => (kind === 'tear' ? TEAR / FPS : kind === 'glitch' ? 1 / FPS : HALF);
const transitionTail = (kind: string): number => (kind === 'tear' ? 0 : kind === 'glitch' ? (GLITCH.length - 1) / FPS : HALF);

/** Переходы edit.json во времени финала по порядку; у самого начала и конца ролика их нет (transitions.marks). */
export function transitionMarks(transitions: readonly TransitionSpec[], tl: Timeline): TransitionMark[] {
  return transitions
    .filter((x) => !x.off) // убранный Павлом в редакторе — не в ролике
    .map((x) => ({ t: tl.toFinalSnap(Number(x.t)), kind: x.kind, source: Number(x.t) }))
    .sort((a, b) => a.t - b.t || a.source - b.source)
    .filter((m) => transitionLead(m.kind) <= m.t && m.t <= tl.duration - transitionTail(m.kind));
}

/** Рваная бумага: переход, перебивка (номер в edit.inserts), в которую он открывается, и её первый кадр — стык. */
export type TearMark = { mark: TransitionMark; insert: number; join: number };

/** Разрывы, у которых перебивка на весь кадр начинается ближе TEAR кадров к стыку: стык — её первый кадр; ближайшая,
 *  при равенстве — раньше по номеру (transitions.tears). */
export function tearsOf(transitions: readonly TransitionSpec[], edit: OverlayEdit, tl: Timeline): TearMark[] {
  const inserts = edit.inserts ?? [];
  // в клип в окошке разрыв не ведёт: кадр остаётся
  const starts = insertSpans(edit, tl).filter(([i]) => inserts[i].kind === 'fullscreen' && (inserts[i] as { layout?: string }).layout !== 'window')
    .map(([i, start]) => [start, i] as const);
  return transitionMarks(transitions, tl).filter((m) => m.kind === 'tear').flatMap((mark): TearMark[] => {
    const frame = frameOf(mark.t);
    const near = starts.filter(([start]) => Math.abs(start - frame) < TEAR && start >= TEAR)
      .map(([start, i]) => [Math.abs(start - frame), i, start] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return near.length ? [{ mark, insert: near[0][1], join: near[0][2] }] : [];
  });
}

/** Где переход идёт в ролике, с: разрыв — TEAR кадров до своей перебивки (без неё — до стыка: в ролике его не будет),
 *  глитч — кадр до стыка, стык и кадр после, остальные — стык ± HALF. */
export function transitionWindow(m: TransitionMark, tears: readonly TearMark[]): [number, number] {
  if (m.kind === 'tear') {
    const join = tears.find((x) => x.mark === m)?.join;
    return join === undefined ? [m.t - TEAR / FPS, m.t] : [(join - TEAR) / FPS, join / FPS];
  }
  if (m.kind === 'glitch') {
    const join = frameOf(m.t);
    return [(join - 1) / FPS, (join - 1 + GLITCH.length) / FPS];
  }
  return [m.t - HALF, m.t + HALF];
}

/** Переходы ролика и когда начинается каждый — с этого места его звук (transitions.sound_starts): разрыв — за TEAR кадров
 *  до своей перебивки, без перебивки его нет; остальные — за `transitionLead` до стыка. */
export function transitionSoundStarts(transitions: readonly TransitionSpec[], edit: OverlayEdit, tl: Timeline): [TransitionMark, number][] {
  const torn = tearsOf(transitions, edit, tl);
  return transitionMarks(transitions, tl).flatMap((m): [TransitionMark, number][] => {
    if (m.kind !== 'tear') return [[m, Math.max(0, m.t - transitionLead(m.kind))]];
    const x = torn.find((y) => y.mark.t === m.t && y.mark.source === m.source);
    return x ? [[m, (x.join - TEAR) / FPS]] : [];
  });
}

/** Какой кадр рваной бумаги (0..TEAR−1) на кадре n финала со стыком `join`; не в её окне — null (transitions.tear_frame). */
export function tearFrame(join: number, n: number): number | null {
  const k = n - (join - TEAR);
  return k >= 0 && k < TEAR ? k : null;
}

/** Полосы глитча со стыком на кадре `join` на кадре n финала; не в его окне — пусто (transitions.glitch_bands). */
export function glitchBands(join: number, n: number): [number, number, number][] {
  const k = n - join + 1;
  return k >= 0 && k < GLITCH.length ? GLITCH[k].map((b) => [...b] as [number, number, number]) : [];
}

// Вспышку и смаз ffmpeg включает по времени кадра n · (1/30) в double, а края окон читает из шести знаков движка
const sixDigits = (x: number): number => pyRound(x, 6);

/** Альфа (0–255) кадра k белого кадра вспышки после fade in и fade out: ffmpeg переводит 0,12 с в целые кадры (3,6 → 4)
 *  и считает целыми числами — 0, 64, 127, 191, 255, 191, 128, 64, 0 (transitions._white). */
function whiteAlpha(k: number, fps: number): number {
  const frames = Math.round(HALF * fps);
  let alpha = 255;
  for (const [start, rising] of [[0, true], [frames, false]] as const) {
    let factor = k < start ? 0 : k >= start + frames ? 65535 : Math.floor(((k - start) * 65535) / frames);
    if (!rising) factor = 65535 - factor;
    if (factor < 65535) alpha = (alpha * factor + 32768) >> 16;
  }
  return alpha;
}

/** Белизна вспышки со стыком `join` (время финала) на кадре n финала, 0..1 (transitions.flash_alpha): overlay включён,
 *  пока время кадра в окне стык ± HALF (края включительно), и кладёт последний кадр белого с меткой не позже n; метка
 *  кадра k белого — trunc(k + a / TB) (setpts отбрасывает дробь; a — начало окна). */
export function flashAlpha(join: number, n: number, fps = FPS): number {
  const a = sixDigits(join - HALF);
  const b = sixDigits(join + HALF);
  const t = n * (1 / fps);
  if (!(a <= t && t <= b)) return 0;
  const shift = a / (1 / fps);
  let k = -1;
  while (Math.trunc(k + 1 + shift) <= n) k += 1;
  return k >= 0 ? whiteAlpha(k, fps) / 255 : 0;
}

/** Сила смаза со стыком `join` на кадре n финала — sigma по x, px кадра шириной 1080 (transitions.blur_sigma): ступени
 *  gblur, чьё окно захватывает время кадра (края включительно); размытия подряд — корень из суммы квадратов. */
export function blurSigma(join: number, n: number, fps = FPS): number {
  const t = n * (1 / fps);
  let sum = 0;
  for (const [sigma, share] of BLUR) if (sixDigits(join - HALF * share) <= t && t <= sixDigits(join + HALF * share)) sum += sigma * sigma;
  return Math.sqrt(sum);
}

const nearEdge = (x: number, lo: number, hi: number) => (x - lo <= TO_CUT ? lo : hi - x <= TO_CUT ? hi : x);

type LookPiece = { t0: number; t1: number; look?: string; off?: boolean };

/** Кадры финала одного куска [первый, после последнего]: на своём месте и копия в тизере, если фраза туда попала; край у
 *  склейки — на склейке (render._piece_windows). */
function pieceWindows(look: LookPiece, tl: Timeline): [number, number][] {
  const t0 = Number(look.t0);
  const t1 = Number(look.t1);
  if (t1 <= t0) return [];
  const spans: [number, number][] = [tl.span(t0, t1, true)];
  const teaser = tl.teaser;
  if (teaser && Math.max(t0, teaser[0]) < Math.min(t1, teaser[1])) {
    const [lo, hi] = teaser;
    spans.push([tl.teaserFinal(nearEdge(Math.max(t0, lo), lo, hi)) as number, tl.teaserFinal(nearEdge(Math.min(t1, hi), lo, hi)) as number]);
  }
  const windows: [number, number][] = [];
  for (const [a, b] of spans) {
    const first = cutFrame(a);
    const after = cutFrame(b);
    if (after > first) windows.push([first, after]);
  }
  return windows;
}

/** Куски с фильтром (любым) — кадры финала [первый, после последнего] по каждому куску; убранный Павлом — в цвете
 *  (render.look_windows). */
export function lookWindows(looks: readonly LookPiece[], tl: Timeline): [number, number][] {
  return looks.filter((look) => !look.off).flatMap((look) => pieceWindows(look, tl));
}

/** Какой фильтр на каких кадрах финала: [первый, после последнего, фильтр] без перекрытий — кусок, что позже в списке
 *  (свой кусок Павла — после кусков сессии), сильнее на общих кадрах; соседние окна одного фильтра — одно окно
 *  (render.look_spans, looks.paint). */
export function lookSpans(looks: readonly LookPiece[], tl: Timeline): [number, number, string][] {
  let spans: [number, number, string][] = [];
  for (const look of looks) {
    if (look.off) continue;
    for (const [a, b] of pieceWindows(look, tl)) {
      const rest: [number, number, string][] = [];
      for (const [x, y, k] of spans) {
        if (x < a) rest.push([x, Math.min(y, a), k]);
        if (y > b) rest.push([Math.max(x, b), y, k]);
      }
      spans = [...rest.filter(([x, y]) => y > x), [a, b, look.look ?? 'bw']];
    }
  }
  const out: [number, number, string][] = [];
  for (const [x, y, k] of [...spans].sort((p, q) => p[0] - q[0] || p[1] - q[1] || (p[2] < q[2] ? -1 : p[2] > q[2] ? 1 : 0))) {
    const last = out.at(-1);
    if (last && last[1] === x && last[2] === k) last[1] = y;
    else out.push([x, y, k]);
  }
  return out;
}
