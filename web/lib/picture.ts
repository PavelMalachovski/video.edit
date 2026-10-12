// Картинка ролика в плеере редактора — как её соберёт ffmpeg (render._picture), по формулам движка: зум и толчки
// переходов (zoom_at, якорь — лицо), ч/б-куски (look_windows: кадр k — в окне [a, b)), вспышка (белый кадр: прозрачность
// 0 → 1 к стыку и обратно за 0,12 с — fade альфы), смаз (gblur по x ступенями — здесь размытие во все стороны: CSS
// иначе не умеет), перебивка на весь кадр (fullscreen). Слой с текстом — поверх, его это не трогает.
import type { Layer } from './tracks.ts';
import { FPS, insertSpans } from './overlay.ts';
import { BLUR, HALF, lookWindows, transitionMarks, zoomLevels } from './zoom.ts';

export type Cover = { t0: number; t1: number; src: string; video: boolean };
/** Что нужно плееру, чтобы в любой момент знать картинку: считается один раз на черновик. */
export type PictureModel = {
  level: (t: number) => number; face: { x: number; y: number }; looks: [number, number][];
  flashes: number[]; blurs: number[]; covers: Cover[];
};
/** Картинка в момент: приближение (якорь — лицо, доли кадра), ч/б, белый кадр поверх (0..1), размытие (px кадра 1080),
 *  перебивка на весь кадр. */
export type Picture = { zoom: number; face: { x: number; y: number }; bw: boolean; flash: number; blur: number; cover: Cover | null };

const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;

/** Модель картинки по слою черновика (зум и вставки — уже на долях музыки), лицу, переходам и ч/б-кускам edit.json. */
export function pictureModel(layer: Layer, { face, transitions = [], looks = [] }: {
  face?: { x: number; y: number } | null; transitions?: readonly { t: number; kind: string }[]; looks?: readonly { t0: number; t1: number }[];
}): PictureModel {
  const { edit, tl } = layer;
  const marks = transitionMarks(transitions, tl);
  const video = Math.round(tl.duration * FPS);
  const covers: Cover[] = insertSpans(edit, tl).flatMap(([n, start, stop]) => {
    const ins = (edit.inserts ?? [])[n];
    if (ins.kind !== 'fullscreen' || !ins.src || start >= video) return [];
    return [{ t0: start / FPS, t1: Math.min(stop, video) / FPS, src: ins.src, video: VIDEO.test(ins.src) }];
  });
  return {
    level: zoomLevels(edit.zooms ?? [], tl, marks.filter((m) => m.kind === 'zoom').map((m) => m.t)),
    face: { x: Math.min(1, Math.max(0, face?.x ?? 0.5)), y: Math.min(1, Math.max(0, face?.y ?? 0.5)) },
    looks: lookWindows(looks, tl),
    flashes: marks.filter((m) => m.kind === 'flash').map((m) => m.t),
    blurs: marks.filter((m) => m.kind === 'blur').map((m) => m.t),
    covers,
  };
}

export function pictureAt(m: PictureModel, t: number): Picture {
  const frame = Math.floor(t * FPS + 1e-6);
  let flash = 0;
  for (const s of m.flashes) {
    if (t >= s - HALF && t <= s) flash = Math.max(flash, (t - (s - HALF)) / HALF);
    else if (t > s && t <= s + HALF) flash = Math.max(flash, 1 - (t - s) / HALF);
  }
  let sigma2 = 0;
  for (const s of m.blurs) for (const [sigma, share] of BLUR) if (Math.abs(t - s) <= HALF * share) sigma2 += sigma * sigma;
  return {
    zoom: m.level(t), face: m.face, bw: m.looks.some(([a, b]) => frame >= a && frame < b), flash: Math.min(1, flash), blur: Math.sqrt(sigma2),
    cover: m.covers.find((c) => t >= c.t0 && t < c.t1) ?? null,
  };
}
