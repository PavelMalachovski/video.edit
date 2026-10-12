// Блоки текста и вставок на дорожках редактора: перетащили или растянули блок (время финала) — где он во времени
// исходника, как его хранят правки руками (timeline.json) и как его прочтёт движок (Timeline.span: событие тянется от
// своего начала и не дальше конца своей серии кусков; хук — до момента по порядку исходника).
import type { Timeline } from './timeline.ts';

const EPS = 1e-9;
// момент ближе этого к стыку отрезков — на стыке (края слов и блоков приходят округлёнными до миллионных): стык — следующему
const JOIN = 1e-6;

/** Отрезок финала, где лежит момент `t` финала: номер в `tl.segments`, начало и конец в финале (стык — следующему). */
function segmentAt(tl: Timeline, t: number): { k: number; f0: number; f1: number } | null {
  const segs = tl.segments;
  const speed = tl.speed;
  for (let k = 0; k < segs.length; k++) {
    const [s0, s1, f0] = segs[k];
    const f1 = f0 + (s1 - s0) / speed;
    if (t >= f0 - JOIN && (t < f1 - JOIN || k === segs.length - 1)) return { k, f0, f1 };
  }
  return null;
}

/** Серия отрезка `k` (тизер — своя): соседние в финале отрезки, что и в исходнике идут подряд. */
function sameRun(tl: Timeline, k: number, j: number): boolean {
  const segs = tl.segments;
  const teaser = tl.teaser ? 1 : 0;
  if (k < teaser || j < teaser) return k === j;
  const run = (i: number) => tl.runOf((segs[i][0] + segs[i][1]) / 2);
  return run(k) === run(j);
}

/** Промежуток финала [a, b] (блок на дорожке) → промежуток исходника [t0, t1] для edit.json: начало — момент исходника
 *  под началом блока; конец — не дальше конца серии кусков, где блок начался (дальше движок его всё равно не потянет).
 *  В тизере блок не начинается (там копия фразы — время у неё то же, что на своём месте): начало в тизере — null. */
export function sourceSpan(tl: Timeline, a: number, b: number): { t0: number; t1: number } | null {
  const start = segmentAt(tl, Math.max(0, a));
  if (!start || (tl.teaser && start.k === 0)) return null;
  const segs = tl.segments;
  const speed = tl.speed;
  const at = (k: number, t: number) => segs[k][0] + (t - segs[k][2]) * speed;
  const t0 = at(start.k, Math.max(a, start.f0));
  let k = start.k;
  // конец: по отрезкам той же серии вправо, пока он не попадёт внутрь (конец отрезка — его конец, а не начало следующего)
  while (k + 1 < segs.length && sameRun(tl, k, k + 1) && b > segs[k + 1][2] + JOIN) k++;
  const f1 = segs[k][2] + (segs[k][1] - segs[k][0]) / speed;
  const t1 = at(k, Math.min(b, f1));
  return { t0: round3(t0), t1: round3(Math.max(t0, t1)) };
}

/** Конец хука на дорожке (время финала `b`) → `hook.until`: момент исходника по порядку исходника — так его считает
 *  движок (_hook_end: переставленный в начало кусок хук не удлиняет). */
export function hookUntil(tl: Timeline, b: number): number {
  return round3(tl.inSourceOrder().toSource(Math.max(0, b)));
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Строки дорожки для блоков, что идут одновременно (акцент поверх титра, две вставки сразу): каждому — первая строка,
 *  где предыдущий блок уже кончился (стык — не перекрытие). → строка каждого блока (по порядку списка) и сколько строк. */
export function stackRows(clips: readonly { t0: number; t1: number }[]): { row: number[]; count: number } {
  const ends: number[] = [];
  const row = new Array<number>(clips.length).fill(0);
  const order = clips.map((c, i) => i).sort((a, b) => clips[a].t0 - clips[b].t0 || a - b);
  for (const i of order) {
    let r = ends.findIndex((end) => end <= clips[i].t0 + EPS);
    if (r < 0) r = ends.push(0) - 1;
    ends[r] = clips[i].t1;
    row[i] = r;
  }
  return { row, count: Math.max(1, ends.length) };
}

/** Границы слов во времени ролика — к ним липнут края блоков: начало и конец каждого слова, что есть в ролике (середина
 *  не вырезана — как его берёт build_sub_events), по шкале монтажа (не дальше своей серии кусков). Значения — точные
 *  (край на стыке переставленного куска — ровно стык, и блок начнётся в следующем куске), повторы — один раз. */
export function finalEdges(tl: Timeline, words: readonly { t0: number; t1: number }[]): number[] {
  const out = new Map<number, number>();
  for (const w of words) {
    const t1 = Math.max(w.t0, w.t1);
    if (tl.toFinal((w.t0 + t1) / 2) === null) continue;
    for (const x of tl.span(w.t0, t1)) {
      const key = Math.round(x * 1e6);
      if (!out.has(key)) out.set(key, x);
    }
  }
  return [...out.values()].sort((a, b) => a - b);
}

/** Куда можно поставить блок текста или вставку (время ролика): не раньше конца хука (`hookFrame` — его кадр, hookEnd) и
 *  конца тизера — так их ставит движок; не дальше конца ролика. */
export function blockRoom(tl: Timeline, hookFrame: number): { floor: number; max: number } {
  return { floor: Math.max(hookFrame / 30, tl.teaserDuration), max: tl.duration };
}
