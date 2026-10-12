// Картинка ролика в плеере редактора — как её соберёт ffmpeg (render._picture), по формулам движка: зум и толчки
// переходов (zoom_at, якорь — лицо), ч/б-куски (look_windows: кадр k — в окне [a, b); цвет — BW_FILTER), вспышка и смаз —
// по кадру на экране, как ffmpeg рисует каждый кадр (transitions.flash_alpha: белизна кадра от fade альфы;
// blur_sigma: sigma ступеней gblur по x — здесь размытие во все стороны: CSS иначе не умеет), перебивка на весь кадр
// (fullscreen). Слой с текстом — поверх, его это не трогает.
import type { Layer } from './tracks.ts';
import { FPS, insertSpans } from './overlay.ts';
import { blurSigma, flashAlpha, lookWindows, transitionMarks, zoomLevels } from './zoom.ts';

// ч/б-кадр: прокси не проходит цветокор финала, и фильтр <video> на ч/б-кадрах повторяет COLOR и BW движка сразу
// (render.BW_CSS_BRIGHTNESS, BW_CSS_CONTRAST: по рампе серого и цвета — до 1/255; общая фикстура, bwFilter)
const BW_BRIGHTNESS = 0.808;
const BW_CONTRAST = 1.274;
export const BW_FILTER = `grayscale(1) brightness(${BW_BRIGHTNESS}) contrast(${BW_CONTRAST})`;

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
  const frame = Math.floor(t * FPS + 1e-6); // кадр на экране в момент t
  // вспышки рядом — белое поверх белого (overlay подряд): 1 − (1 − a)(1 − b); смазы — gblur подряд: корень из суммы квадратов
  const flash = m.flashes.reduce((sum, join) => {
    const a = flashAlpha(join, frame);
    return sum + a - sum * a;
  }, 0);
  return {
    zoom: m.level(t), face: m.face, bw: m.looks.some(([a, b]) => frame >= a && frame < b), flash,
    blur: Math.hypot(...m.blurs.map((join) => blurSigma(join, frame))),
    cover: m.covers.find((c) => t >= c.t0 && t < c.t1) ?? null,
  };
}
