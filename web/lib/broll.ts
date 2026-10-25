// Перебивки (B-roll) в плеере редактора — как их собирает движок (engine/vm/broll.py, render._picture): клип с `from`
// (не дальше, чем позволяет его длина), окошко лица `pip` — кусок кадра вокруг точки лица (faceBox) в правом верхнем углу
// (PIP), со скруглёнными углами; общая фикстура engine/tests/fixtures/overlay-events.json, раздел broll. Видео клипа плеер
// берёт из прокси `broll-<b>.mp4` (его пишет vm broll, Action кладёт в черновик релиза).

/** Окошко лица на кадре 1080×1920: левый верхний угол, размер, радиус углов (broll.PIP). */
export const PIP = { x: 672, y: 300, w: 360, h: 480, r: 36 } as const;
const FACE = { w: 540, h: 720 }; // кусок кадра с лицом — 3:4, как окошко
const FACE_AT = 0.4; // точка лица — на этой доле высоты окошка
const W = 1080;
const H = 1920;
export type Rect = { x: number; y: number; w: number; h: number };

const unit = (v: unknown) => Math.min(1, Math.max(0, typeof v === 'number' && Number.isFinite(v) ? v : 0.5));
/** Python round: половина — к чётному (как round() движка). */
const pyRound = (v: number) => {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/** Кусок кадра для окошка по точке лица (доли кадра), внутри кадра — broll.face_box. */
export function faceBox(face: { x?: number; y?: number } | null | undefined): Rect {
  const fx = unit(face?.x);
  const fy = unit(face?.y);
  const x = Math.min(Math.max(0, pyRound(fx * W - FACE.w / 2)), W - FACE.w);
  const y = Math.min(Math.max(0, pyRound(fy * H - FACE.h * FACE_AT)), H - FACE.h);
  return { x, y, w: FACE.w, h: FACE.h };
}

/** Тот же кусок на кадре без зума (px кадра 1080×1920): плеер зумит видео стилем (scale к точке лица), а окошко движок
 *  вырезает уже из зумленного кадра — значит, из исходного берём кусок в `zoom` раз меньше, сжатый к точке лица. */
export function pipSource(face: { x?: number; y?: number } | null | undefined, zoom: number): Rect {
  const b = faceBox(face);
  if (!(zoom > 1)) return b;
  const ox = unit(face?.x) * W;
  const oy = unit(face?.y) * H;
  return { x: ox + (b.x - ox) / zoom, y: oy + (b.y - oy) / zoom, w: b.w / zoom, h: b.h / zoom };
}

/** С какой секунды клипа длиной `length` идёт перебивка на `seconds` с: `from`, но не дальше, чем позволяет длина
 *  (render._picture); длина ещё неизвестна — как задано. */
export function clipStart(from: number | undefined, length: number, seconds: number): number {
  const want = Math.max(0, from ?? 0);
  return Number.isFinite(length) ? Math.max(0, Math.min(want, length - seconds)) : want;
}

/** Ассет прокси перебивки в черновике релиза (broll.PROXY_NAME): `in/uploads/upload-b3.mov` → `broll-b3.mp4`; не
 *  перебивка — null. */
export function brollProxy(src: string): string | null {
  const key = /^in\/uploads\/upload-(b\d{1,2})\.[a-z0-9]{1,5}$/.exec(src)?.[1];
  return key ? `broll-${key}.mp4` : null;
}
