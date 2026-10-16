// Картинка ролика в плеере редактора — как её соберёт ffmpeg (render._picture), по формулам движка: зум и толчки
// переходов (zoom_at, якорь — лицо), куски с фильтром (look_spans: кадр k — в окне [a, b); ч/б — BW_FILTER, остальные —
// LOOK_CSS), вспышка и смаз —
// по кадру на экране, как ffmpeg рисует каждый кадр (transitions.flash_alpha: белизна кадра от fade альфы;
// blur_sigma: sigma ступеней gblur по x — здесь размытие во все стороны: CSS иначе не умеет), перебивка на весь кадр
// (fullscreen). Слой с текстом — поверх, его это не трогает.
import type { Layer } from './tracks.ts';
import { FPS, insertSpans } from './overlay.ts';
import { blurSigma, flashAlpha, lookSpans, transitionMarks, zoomLevels } from './zoom.ts';

// ч/б-кадр: прокси не проходит цветокор финала, и фильтр <video> на ч/б-кадрах повторяет COLOR и BW движка сразу
// (render.BW_CSS_BRIGHTNESS, BW_CSS_CONTRAST: по рампе серого и цвета — до 1/255; общая фикстура, bwFilter)
const BW_BRIGHTNESS = 0.808;
const BW_CONTRAST = 1.274;
export const BW_FILTER = `grayscale(1) brightness(${BW_BRIGHTNESS}) contrast(${BW_CONTRAST})`;
// фильтры руками: те же функции CSS filter, что движок считает в RGB после своего цветокора (vm/looks.py, LOOKS; общая
// фикстура, lookFilters) — на прокси без цветокора, как и кадры без фильтра
export const LOOK_CSS: Readonly<Record<string, string>> = {
  sepia: 'brightness(0.74) sepia(1) contrast(1.1)',
  warm: 'brightness(0.89) sepia(0.35) contrast(1.08)',
  cold: 'brightness(0.74) grayscale(1) sepia(0.55) hue-rotate(190deg) contrast(1.12)',
  film: 'contrast(0.84) saturate(0.72) sepia(0.14) brightness(1.03)',
};
/** CSS filter кадра с фильтром `look` (нет фильтра — пусто). */
export const lookFilter = (look: string | null): string => (look === null ? '' : look === 'bw' ? BW_FILTER : LOOK_CSS[look] ?? '');

export type Cover = { t0: number; t1: number; src: string; video: boolean };
/** Что нужно плееру, чтобы в любой момент знать картинку: считается один раз на черновик. */
export type PictureModel = {
  level: (t: number) => number; face: { x: number; y: number }; looks: [number, number, string][];
  flashes: number[]; blurs: number[]; covers: Cover[];
};
/** Картинка в момент: приближение (якорь — лицо, доли кадра), фильтр куска (bw, sepia, warm, cold, film; нет — null),
 *  белый кадр поверх (0..1), размытие (px кадра 1080), перебивка на весь кадр. */
export type Picture = { zoom: number; face: { x: number; y: number }; look: string | null; flash: number; blur: number; cover: Cover | null };

const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;

/** Модель картинки по слою черновика (зум и вставки — уже на долях музыки; куски с фильтром и переходы — с правками
 *  Павла: убранные он пропускает) и лицу из edit.json. */
export function pictureModel(layer: Layer, { face }: { face?: { x: number; y: number } | null }): PictureModel {
  const { edit, tl } = layer;
  const marks = transitionMarks(edit.transitions ?? [], tl);
  const video = Math.round(tl.duration * FPS);
  const covers: Cover[] = insertSpans(edit, tl).flatMap(([n, start, stop]) => {
    const ins = (edit.inserts ?? [])[n];
    if (ins.kind !== 'fullscreen' || !ins.src || start >= video) return [];
    return [{ t0: start / FPS, t1: Math.min(stop, video) / FPS, src: ins.src, video: VIDEO.test(ins.src) }];
  });
  return {
    level: zoomLevels(edit.zooms ?? [], tl, marks.filter((m) => m.kind === 'zoom').map((m) => m.t)),
    face: { x: Math.min(1, Math.max(0, face?.x ?? 0.5)), y: Math.min(1, Math.max(0, face?.y ?? 0.5)) },
    looks: lookSpans(edit.looks ?? [], tl),
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
    zoom: m.level(t), face: m.face, look: m.looks.find(([a, b]) => frame >= a && frame < b)?.[2] ?? null, flash,
    blur: Math.hypot(...m.blurs.map((join) => blurSigma(join, frame))),
    cover: m.covers.find((c) => t >= c.t0 && t < c.t1) ?? null,
  };
}
