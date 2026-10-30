// Картинка ролика в плеере редактора — как её соберёт ffmpeg (render._picture), по формулам движка: зум и толчки
// переходов (zoom_at, якорь — лицо), куски с фильтром (look_spans: кадр k — в окне [a, b); ч/б — BW_FILTER, остальные —
// LOOK_CSS), вспышка и смаз —
// по кадру на экране, как ffmpeg рисует каждый кадр (transitions.flash_alpha: белизна кадра от fade альфы;
// blur_sigma: sigma ступеней gblur по x — здесь размытие во все стороны: CSS иначе не умеет), перебивка на весь кадр
// (fullscreen: с момента клипа, лицо окошком — pip). Слой с текстом — поверх, его это не трогает.
import type { DraftInsert, Layer } from './tracks.ts';
import { FPS, frameOf, insertSpans } from './overlay.ts';
import { blurSigma, flashAlpha, glitchBands, lookSpans, tearFrame, tearsOf, transitionMarks, zoomLevels } from './zoom.ts';

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

/** Перебивка на кадре: окно в ролике (с), клип, видео ли это; с какой секунды клипа (не дальше, чем позволяет его длина
 *  — clipStart), вид (`pip` — лицо окошком поверх клипа, lib/broll.ts) и звук клипа тихим фоном. */
export type Cover = { t0: number; t1: number; src: string; video: boolean; from: number; layout: 'full' | 'pip' | 'window'; audio: boolean };
/** Что нужно плееру, чтобы в любой момент знать картинку: считается один раз на черновик. */
export type PictureModel = {
  level: (t: number) => number; face: { x: number; y: number }; looks: [number, number, string][];
  flashes: number[]; blurs: number[]; covers: Cover[];
  tears?: { join: number; cover: Cover }[]; // рваная бумага: первый кадр перебивки и она сама (в щели)
  glitches?: number[]; // кадры стыков глитча
};
/** Картинка в момент: приближение (якорь — лицо, доли кадра), фильтр куска (bw, sepia, warm, cold, film; нет — null),
 *  белый кадр поверх (0..1), размытие (px кадра 1080), перебивка на весь кадр. */
export type Picture = {
  zoom: number; face: { x: number; y: number }; look: string | null; flash: number; blur: number; cover: Cover | null;
  tear: { k: number; cover: Cover } | null; // кадр рваной бумаги (template/tear/*-NN.png) и перебивка в щели
  glitch: [number, number, number][]; // полосы глитча на этом кадре: [y0, y1, сдвиг], px кадра 1080×1920
};

const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;

/** Модель картинки по слою черновика (зум и вставки — уже на долях музыки; куски с фильтром и переходы — с правками
 *  Павла: убранные он пропускает) и лицу из edit.json. */
export function pictureModel(layer: Layer, { face }: { face?: { x: number; y: number } | null }): PictureModel {
  const { edit, tl } = layer;
  const marks = transitionMarks(edit.transitions ?? [], tl);
  const video = Math.round(tl.duration * FPS);
  const numbered = insertSpans(edit, tl).flatMap(([n, start, stop]): [number, Cover][] => {
    const ins = (edit.inserts ?? [])[n] as DraftInsert;
    if (ins.kind !== 'fullscreen' || !ins.src || start >= video) return [];
    return [[n, {
      t0: start / FPS, t1: Math.min(stop, video) / FPS, src: ins.src, video: VIDEO.test(ins.src),
      from: Math.max(0, Number(ins.from) || 0), layout: ins.layout === 'pip' || ins.layout === 'window' ? ins.layout : 'full', audio: ins.audio === true,
    }]];
  });
  const covers = numbered.map(([, c]) => c);
  const tears = tearsOf(edit.transitions ?? [], edit, tl).flatMap((x) => {
    const cover = numbered.find(([n]) => n === x.insert)?.[1];
    return cover ? [{ join: x.join, cover }] : [];
  });
  return {
    level: zoomLevels(edit.zooms ?? [], tl, marks.filter((m) => m.kind === 'zoom').map((m) => m.t)),
    face: { x: Math.min(1, Math.max(0, face?.x ?? 0.5)), y: Math.min(1, Math.max(0, face?.y ?? 0.5)) },
    looks: lookSpans(edit.looks ?? [], tl),
    flashes: marks.filter((m) => m.kind === 'flash').map((m) => m.t),
    blurs: marks.filter((m) => m.kind === 'blur').map((m) => m.t),
    covers, tears, glitches: marks.filter((m) => m.kind === 'glitch').map((m) => frameOf(m.t)),
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
    tear: (m.tears ?? []).flatMap((x) => {
      const k = tearFrame(x.join, frame);
      return k === null ? [] : [{ k, cover: x.cover }];
    })[0] ?? null,
    glitch: (m.glitches ?? []).flatMap((join) => glitchBands(join, frame)),
  };
}
