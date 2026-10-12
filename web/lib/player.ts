// Плеер редактора: куски черновика играются подряд одним <video> — время финала ↔ кусок и время исходника, переход
// на следующий кусок (тизер идёт первым, потом исходник с начала), конец ролика. Чистые функции — под тестом.
import type { Clip } from './tracks.ts';

const EDGE = 1 / 60; // с исходника: так близко к концу куска — уже его конец (кадр 30 к/с — 1/30)

/** Кусок и время исходника для времени финала `t` (до начала — начало, после конца — конец последнего куска). */
export function locate(video: Clip[], speed: number, t: number): { index: number; src: number } {
  if (!video.length) return { index: 0, src: 0 };
  const found = video.findIndex((c) => t >= c.t0 && t < c.t1);
  const index = found >= 0 ? found : t < video[0].t0 ? 0 : video.length - 1;
  const c = video[index];
  const src = (c.src0 as number) + Math.min(Math.max(0, t - c.t0), c.t1 - c.t0) * speed;
  return { index, src: Math.min(src, c.src1 as number) };
}

/** Шаг пуска: видео стоит на `current` секунде исходника в куске `index`. → время финала; `seek` — перемотать на
 *  начало следующего куска (вырезанное пропускается, после тизера — назад к началу); `end` — ролик кончился. */
export function advance(video: Clip[], speed: number, index: number, current: number): { index: number; t: number; seek?: number; end?: boolean } {
  const c = video[index];
  if (current >= (c.src1 as number) - EDGE) {
    const next = video[index + 1];
    if (!next) return { index, t: c.t1, end: true };
    const src0 = next.src0 as number;
    // следующий кусок — сразу за этим в исходнике (разрез Павла): видео играет дальше, без перемотки и подгрузки
    if (Math.abs(src0 - (c.src1 as number)) < EDGE) return { index: index + 1, t: next.t0 + Math.max(0, current - src0) / speed };
    return { index: index + 1, t: next.t0, seek: src0 };
  }
  return { index, t: Math.min(c.t1, c.t0 + Math.max(0, current - (c.src0 as number)) / speed) };
}
