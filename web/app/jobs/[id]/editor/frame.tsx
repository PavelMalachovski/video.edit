'use client';
// Кадр редактора поверх прокси — как его соберёт монтаж: картинка (зум к лицу, ч/б, смаз, перебивка на весь кадр,
// вспышка — по формулам движка, lib/picture.ts; перебивка с момента клипа и окошко лица — lib/broll.ts), слой шаблона (те же события, что рисуют финал: перерисовывается,
// только когда событие сменилось) и шкала времени (в финале её рисует ffmpeg, здесь — страница). Всё — по часам плеера,
// без перерисовки всего редактора. Нарисованное выбирают касанием кадра; выбранное — рамкой (хук и субтитры тянутся
// выше-ниже и крупнее, вставки и акценты — по кадру), ✎ — текст блока прямо на кадре.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import type { Clock } from '@/lib/clock.ts';
import type { Place } from '@/lib/edits.ts';
import type { StyleSpec } from '@/lib/jobfiles.ts';
import { eventIndexAt, FPS, type LayerEvent } from '@/lib/overlay.ts';
import { clipStart, PIP, pipSource, WINDOW } from '@/lib/broll.ts';
import { lookFilter, pictureAt, type Cover, type PictureModel } from '@/lib/picture.ts';
import { TEAR } from '@/lib/zoom.ts';
import { INSERT_W, moveBox, moveCentre, resizeBox, underCaption, type BoxExt } from '@/lib/style.ts';
import { BoxHandle, DragHandle, type Box } from '../../../handles';
import { PencilIcon } from '../../../icons';
import PreviewFrame from '../../../preview-frame';

const TEAR_DIR = '/template/tear'; // кадры рваной бумаги — те же картинки, что накладывает рендер (vm/tear.py)
const GLITCH_DRAW = { w: 540, h: 960 }; // холст глитча, px: как прокси
const PIP_DRAW = { w: 270, h: 360 }; // окошко лица в плеере, px холста: как кусок прокси 540×960 (faceBox — половина ширины)
// клип в окошке поверх говорящего (layout window) — как WINDOW движка; иначе перебивка на весь кадр
const WINDOW_STYLE = {
  left: `${(WINDOW.x / 1080) * 100}%`, top: `${(WINDOW.y / 1920) * 100}%`, width: `${(WINDOW.w / 1080) * 100}%`, height: `${(WINDOW.h / 1920) * 100}%`,
  borderRadius: `${(WINDOW.r / WINDOW.w) * 100}% / ${(WINDOW.r / WINDOW.h) * 100}%`,
};
const FULL_STYLE = { left: '', top: '', width: '', height: '', borderRadius: '' };
const PIP_STYLE: CSSProperties = { // окошко на кадре — как PIP движка (доли кадра 1080×1920), углы — r PIP
  left: `${(PIP.x / 1080) * 100}%`, top: `${(PIP.y / 1920) * 100}%`, width: `${(PIP.w / 1080) * 100}%`, height: `${(PIP.h / 1920) * 100}%`,
  borderRadius: `${(PIP.r / PIP.w) * 100}% / ${(PIP.r / PIP.h) * 100}%`,
};

/** Кусок картинки или кадра клипа, который виден в рамке `box` при object-fit: cover (по центру), — [sx, sy, sw, sh]. */
function coverCrop(el: HTMLImageElement | HTMLVideoElement, box: { w: number; h: number }): [number, number, number, number] {
  const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
  const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  const k = Math.min(w / box.w, h / box.h);
  return [(w - box.w * k) / 2, (h - box.h * k) / 2, box.w * k, box.h * k];
}

/**
 * Картинка ролика на прокси `video`: зум и ч/б — стилем самого <video>, смаз — у картинки вместе с перебивкой, белый
 * кадр вспышки — поверх них, под текстом (как в ffmpeg: переходы — после перебивок, слой — после переходов). Пока
 * видео перематывается, картинка не меняется раньше кадра: резкая смена крупности и края ч/б стоят ровно на склейках.
 * После кусков (стоп-кадр и карточка) — картинка последнего кадра.
 */
export function Picture({ clock, model, video, src, duration, width, playing, clipOf, note, children }: {
  clock: Clock; model: PictureModel | null; video: RefObject<HTMLVideoElement | null>; src: string | null; duration: number; width: number;
  playing: boolean;
  // что показать за перебивку: адрес (видео — прокси клипа; нечего — на кадре метка `note`) и видео ли это
  clipOf: (c: Cover) => { url: string | null; video: boolean };
  note: string;
  children: ReactNode; // сам <video> плеера: смаз — у него вместе с перебивкой
}) {
  const pic = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const clip = useRef<HTMLVideoElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const pip = useRef<HTMLCanvasElement>(null);
  const tearBox = useRef<HTMLDivElement>(null);
  const tearImg = useRef<HTMLImageElement>(null);
  const tearClip = useRef<HTMLVideoElement>(null);
  const tearEdge = useRef<HTMLImageElement>(null);
  const glitch = useRef<HTMLCanvasElement>(null);
  const composed = useRef<HTMLCanvasElement | null>(null); // кадр с окошком лица — источник полос глитча
  const live = useRef({ playing, cover: '' });
  live.current.playing = playing;

  useEffect(() => {
    const v = video.current;
    const last = Math.max(0, (Math.round(duration * FPS) - 1) / FPS);
    const show = (c: Cover | null, t: number) => {
      const shown = c ? clipOf(c) : null;
      const url = shown?.url ?? null;
      // вид и звук — тоже (их правят на месте), и адрес: прокси клипа появляется в релизе позже
      const key = c ? `${c.src}|${c.t0}|${c.layout}|${c.audio}|${url}` : '';
      if (key !== live.current.cover) {
        live.current.cover = key;
        const still = shown && !shown.video ? url : null;
        const moving = shown?.video ? url : null;
        if (img.current) {
          img.current.hidden = !still;
          if (still && img.current.getAttribute('src') !== still) img.current.src = still;
        }
        if (clip.current) {
          clip.current.hidden = !moving;
          if (moving && clip.current.getAttribute('src') !== moving) clip.current.src = moving;
          if (!moving) clip.current.pause();
          clip.current.muted = !(c && c.audio); // звук клипа — тихим фоном (прокси клипа уже на громкости фона)
        }
        if (label.current) label.current.hidden = !(c && !url);
        if (pip.current) pip.current.hidden = !(c && c.layout === 'pip');
        const place = c?.layout === 'window' ? WINDOW_STYLE : FULL_STYLE;
        for (const el of [img.current, clip.current, label.current]) if (el) Object.assign(el.style, place);
      }
      const m = clip.current;
      if (shown?.video && c && m && !m.hidden && m.readyState > 0) { // перебивка-видео идёт с момента клипа, вместе с роликом
        const want = clipStart(c.from, m.duration, c.t1 - c.t0) + Math.max(0, t - c.t0);
        if (!live.current.playing || Math.abs(m.currentTime - want) > 0.3) m.currentTime = want;
        if (live.current.playing && m.paused) {
          // со звуком вне касания (iPhone) пуск отвергнут — тогда клип идёт без звука, а не стоит
          void m.play().catch(() => {
            m.muted = true;
            return m.play().catch(() => undefined);
          });
        }
        if (!live.current.playing && !m.paused) m.pause();
      }
    };
    const apply = () => {
      if (!model) {
        if (v) {
          v.style.transform = '';
          v.style.filter = '';
        }
        if (pic.current) pic.current.style.filter = '';
        if (flash.current) flash.current.style.opacity = '0';
        show(null, 0);
        drawTear(null);
        drawGlitch(null);
        return;
      }
      if (v?.seeking) return; // кадр ещё старый — дорисуем по seeked
      const t = clock.get();
      const p = pictureAt(model, Math.min(t, last));
      if (v) {
        v.style.transformOrigin = `${(p.face.x * 100).toFixed(2)}% ${(p.face.y * 100).toFixed(2)}%`;
        v.style.transform = p.zoom > 1 + 1e-6 ? `scale(${p.zoom.toFixed(5)})` : '';
        v.style.filter = lookFilter(p.look);
        v.dataset.zoom = p.zoom.toFixed(4); // для проверок e2e: что видно на кадре
        v.dataset.bw = p.look === 'bw' ? '1' : '';
        v.dataset.look = p.look ?? '';
      }
      if (pic.current) pic.current.style.filter = p.blur > 0 ? `blur(${((p.blur * width) / 1080).toFixed(2)}px)` : '';
      if (flash.current) flash.current.style.opacity = p.flash > 0 ? p.flash.toFixed(3) : '0';
      show(p.cover, t);
      if (p.cover?.layout === 'pip') drawPip(p.zoom, p.face, p.look);
      drawTear(p.tear ?? upcoming(t));
      drawGlitch(p.glitch.length ? p : null);
    };
    // разрыв в ближайшие 2 с: перебивку в щель — заранее (картинка загрузится, видео встанет на кадр), но не показывать
    const upcoming = (t: number): { k: number; cover: Cover; early: true } | null => {
      const next = (model?.tears ?? []).find((x) => (x.join - TEAR) / FPS - t > 0 && (x.join - TEAR) / FPS - t <= 2);
      return next ? { k: 0, cover: next.cover, early: true } : null;
    };
    // рваная бумага (render._tears): в щели (маска slit-NN) — первый кадр перебивки в ч/б с растром, поверх — края бумаги
    const drawTear = (tear: { k: number; cover: Cover; early?: true } | null) => {
      const box = tearBox.current;
      const edge = tearEdge.current;
      if (!box || !edge) return;
      const shown = tear ? clipOf(tear.cover) : null;
      if (!tear || !shown?.url) {
        box.hidden = true;
        edge.hidden = true;
        return;
      }
      if (tear.early) { // только подготовить: ниже — src и кадр клипа, а слой разрыва остаётся скрытым
        box.hidden = true;
        edge.hidden = true;
      }
      const nn = String(tear.k).padStart(2, '0');
      const mask = `url(${TEAR_DIR}/slit-${nn}.png)`;
      if (box.style.maskImage !== mask) {
        box.style.maskImage = mask;
        box.style.setProperty('-webkit-mask-image', mask);
      }
      if (edge.getAttribute('src') !== `${TEAR_DIR}/edge-${nn}.png`) edge.src = `${TEAR_DIR}/edge-${nn}.png`;
      box.dataset.k = String(tear.k); // для проверок e2e
      box.hidden = Boolean(tear.early);
      edge.hidden = Boolean(tear.early);
      const still = tearImg.current;
      const moving = tearClip.current;
      if (still) {
        still.hidden = shown.video;
        if (!shown.video && still.getAttribute('src') !== shown.url) still.src = shown.url;
      }
      if (moving) {
        moving.hidden = !shown.video;
        if (shown.video) {
          if (moving.getAttribute('src') !== shown.url) moving.src = shown.url;
          // кадр клипа, с которого пойдёт перебивка (render._tear_still)
          const want = clipStart(tear.cover.from, moving.duration, tear.cover.t1 - tear.cover.t0);
          if (moving.readyState > 0 && Math.abs(moving.currentTime - want) > 0.02) moving.currentTime = want;
        }
      }
    };
    // глитч (transitions.picture_chains): полосы видимой картинки — копией со сдвигом; холст только копирует кадр
    // (drawImage), пикселей не читает — клип перебивки с другого адреса его не портит
    const drawGlitch = (p: { glitch: [number, number, number][]; zoom: number; face: { x: number; y: number }; look: string | null; cover: Cover | null } | null) => {
      const canvas = glitch.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      if (!p) {
        canvas.hidden = true;
        return;
      }
      ctx.clearRect(0, 0, GLITCH_DRAW.w, GLITCH_DRAW.h);
      const kx = GLITCH_DRAW.w / 1080;
      const ky = GLITCH_DRAW.h / 1920;
      // откуда копировать: перебивка — её картинка (object-fit: cover), иначе — прокси с зумом к лицу и фильтром куска
      const shownCover = p.cover ? (img.current && !img.current.hidden ? img.current : clip.current && !clip.current.hidden ? clip.current : null) : null;
      const windowed = p.cover?.layout === 'window' ? shownCover : null; // клип в окошке — поверх говорящего
      const coverEl = windowed ? null : shownCover;
      let source: CanvasImageSource | null = null;
      let sx = 0, sy = 0, scale = 1; // кадр 1080×1920 → источник: x = sx + X · scale
      if (coverEl) {
        const w = coverEl instanceof HTMLVideoElement ? coverEl.videoWidth : coverEl.naturalWidth;
        const h = coverEl instanceof HTMLVideoElement ? coverEl.videoHeight : coverEl.naturalHeight;
        if (!w || !h) return;
        scale = Math.min(w / 1080, h / 1920);
        sx = (w - 1080 * scale) / 2;
        sy = (h - 1920 * scale) / 2;
        source = coverEl;
        canvas.style.filter = '';
      } else if (v && v.readyState >= 2 && v.videoWidth) {
        const k = v.videoWidth / 1080;
        scale = k / p.zoom;
        sx = p.face.x * v.videoWidth * (1 - 1 / p.zoom);
        sy = p.face.y * v.videoHeight * (1 - 1 / p.zoom);
        source = v;
        canvas.style.filter = lookFilter(p.look);
      }
      if (!source) return;
      // окошко лица (pip) — часть картинки, которую режут полосы: собрать кадр с ним на запасном холсте
      const face = p.cover?.layout === 'pip' && pip.current && !pip.current.hidden ? pip.current : null;
      const inset = face ? { el: face as CanvasImageSource, box: PIP, crop: null } : windowed ? { el: windowed as CanvasImageSource, box: WINDOW, crop: coverCrop(windowed, WINDOW) } : null;
      if (inset) {
        const whole = (composed.current ??= document.createElement('canvas'));
        whole.width = GLITCH_DRAW.w;
        whole.height = GLITCH_DRAW.h;
        const w = whole.getContext('2d');
        if (!w) return;
        // фильтр куска — только у говорящего (в ролике он до перебивок); где ctx.filter нет (Safari) — у всего холста
        const looked = !coverEl && p.look !== null;
        if (looked && 'filter' in w) w.filter = lookFilter(p.look) || 'none';
        w.drawImage(source, sx, sy, 1080 * scale, 1920 * scale, 0, 0, GLITCH_DRAW.w, GLITCH_DRAW.h);
        if ('filter' in w) w.filter = 'none';
        canvas.style.filter = looked && !('filter' in w) ? lookFilter(p.look) : '';
        const r = inset.box;
        w.save();
        w.beginPath(); // углы окошка скруглены, как маска ролика
        w.roundRect(r.x * kx, r.y * ky, r.w * kx, r.h * ky, r.r * kx);
        w.clip();
        if (inset.crop) w.drawImage(inset.el, ...inset.crop, r.x * kx, r.y * ky, r.w * kx, r.h * ky);
        else w.drawImage(inset.el, r.x * kx, r.y * ky, r.w * kx, r.h * ky);
        w.restore();
        source = whole;
        sx = 0;
        sy = 0;
        scale = GLITCH_DRAW.w / 1080;
      }
      for (const [y0, y1, dx] of p.glitch) {
        ctx.drawImage(source, sx, sy + y0 * scale, 1080 * scale, (y1 - y0) * scale, dx * kx, y0 * ky, GLITCH_DRAW.w, (y1 - y0) * ky);
      }
      canvas.hidden = false;
    };
    // окошко лица: тот же кадр говорящего, что под перебивкой, — с зумом (движок вырезает окошко из зумленного кадра),
    // с фильтром куска; смаз и вспышка — у всей картинки
    const drawPip = (zoom: number, face: { x: number; y: number }, look: string | null) => {
      const ctx = pip.current?.getContext('2d');
      if (!ctx || !v || v.readyState < 2 || !v.videoWidth) return;
      const r = pipSource(face, zoom);
      const k = v.videoWidth / 1080;
      pip.current!.style.filter = lookFilter(look); // фильтр куска — CSS у холста: ctx.filter Safari не умеет
      ctx.drawImage(v, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, PIP_DRAW.w, PIP_DRAW.h);
      if (pip.current) pip.current.dataset.zoom = zoom.toFixed(4); // для проверок e2e
    };
    apply();
    const off = clock.subscribe(apply);
    v?.addEventListener('seeked', apply);
    return () => {
      off();
      v?.removeEventListener('seeked', apply);
    };
  }, [clock, model, video, src, duration, width, clipOf]);

  useEffect(() => { // кадры рваной бумаги — заранее: при игре они сменяются каждый кадр, и пустой кадр мигнул бы
    if (!model?.tears?.length) return;
    for (let k = 0; k < TEAR; k++) {
      for (const kind of ['slit', 'edge']) new Image().src = `${TEAR_DIR}/${kind}-${String(k).padStart(2, '0')}.png`;
    }
  }, [model]);

  useEffect(() => { // пуск и пауза — и у перебивки-видео
    const m = clip.current;
    if (!m || m.hidden) return;
    if (playing) void m.play().catch(() => undefined);
    else m.pause();
  }, [playing]);

  return (
    <>
      <div className="ed-pic" ref={pic}>
        {children}
        <img ref={img} className="ed-cover" alt="" hidden />
        <video ref={clip} className="ed-cover" muted playsInline preload="auto" hidden />
        <div ref={label} className="ed-cover ed-cover-note" hidden>{note}</div>
        <canvas ref={pip} className="ed-pip" width={PIP_DRAW.w} height={PIP_DRAW.h} style={PIP_STYLE} hidden aria-hidden="true" />
        <div ref={tearBox} className="ed-tear" hidden aria-hidden="true">
          <img ref={tearImg} className="ed-fill ed-gray" alt="" hidden />
          <video ref={tearClip} className="ed-fill ed-gray" muted playsInline preload="auto" hidden />
          <img className="ed-fill" src={`${TEAR_DIR}/dots.png`} alt="" />
        </div>
        <img ref={tearEdge} className="ed-fill ed-tear-edge" alt="" hidden aria-hidden="true" />
        <canvas ref={glitch} className="ed-fill ed-glitch" width={GLITCH_DRAW.w} height={GLITCH_DRAW.h} hidden aria-hidden="true" />
      </div>
      <div className="ed-flash" ref={flash} aria-hidden="true" />
    </>
  );
}

/** Блок, выбранный на дорожке, — на кадре: вставка — по номеру в edit.json (он есть у неё в состоянии слоя), акцент — по
 *  своему времени на дорожке (на кадре акцент один); хук, титр, субтитры (группа, что на кадре) и финальная карточка. */
export type FramePick = { kind: 'insert'; n: number } | { kind: 'accent'; t0: number; t1: number } | { kind: 'hook' | 'cta' | 'sub' | 'end' };
/** Какой это блок — чтобы рамка одного не досталась другому. */
export const pickKey = (p: FramePick): string => (p.kind === 'insert' ? `insert:${p.n}` : p.kind === 'accent' ? `accent:${p.t0}` : p.kind);
/** Нарисованное на кадре, что выбирают касанием: вставка — с номером в edit.json, остальное — по виду (на кадре — одно). */
export type FrameTarget = { kind: 'insert'; n: number } | { kind: 'hook' | 'cta' | 'accent' | 'sub' | 'end' };
const targetKey = (t: FrameTarget | FramePick): string => (t.kind === 'insert' ? `insert:${t.n}` : t.kind);
/** Рамка выбранного блока, когда шаблон его нарисовал (по ней кнопки панели держат блок в зоне), поля тени вставки и
 *  какой это блок. */
export type PickedBox = { key: string; box: Box; ext?: BoxExt };
/** Подписи ручки: имя, подсказка и место словами — для экранного чтеца. */
export type HandleText = (place: Place) => { label: string; title: string; valueText: string };
/** Хук или субтитры выбраны и стиль можно менять: ручка тянет место (`y`, px кадра — как его ставит шаблон) и размер. */
export type StyleMove = {
  label: string; title: string; y: number; size: number; range: { min: number; max: number }; onMove: (y: number) => void; onSize: (s: number) => void;
};
type Boxes = { inserts?: (Box & { n?: number })[]; sub?: Box; hook?: Box; cta?: Box; accent?: Box; end?: Box };
type Drawn = { boxes: Boxes; state: Record<string, unknown> }; // рамки — и что нарисовано
type Placed = { n?: number; x?: number; y?: number; w?: number };

const KINDS = ['sub', 'hook', 'cta', 'accent', 'end'] as const;
/** Рамки нарисованного — снизу вверх, как слои шаблона (overlay.html: вставки, субтитры, хук, титр, акцент, карточка):
 *  касание достаётся верхнему. */
function targets(b: Boxes): { target: FrameTarget; box: Box }[] {
  const out: { target: FrameTarget; box: Box }[] = [];
  for (const i of b.inserts ?? []) if (Number.isInteger(i.n)) out.push({ target: { kind: 'insert', n: i.n as number }, box: i });
  for (const kind of KINDS) {
    const x = b[kind];
    if (x) out.push({ target: { kind }, box: x });
  }
  return out;
}

/** Слой шаблона в момент часов: событие слоя — то, в котором лежит момент; перерисовка — только при смене события.
 *  Нарисованное — прозрачные кнопки (`onTarget` — касание: выбрать). Выбранный блок (`pick`) — рамкой: у вставки и
 *  акцента — ручка места (`onPlace`: тащить, у вставки — и ширина), у хука и субтитров — ручка стиля (`styleMove`: выше-
 *  ниже и размер), иначе — пунктир; ✎ и касание ручки — его текст (`onText`). Рамка — где шаблон нарисовал блок в
 *  последний раз: пока его тащат, ручка не пропадает между перерисовками. */
export function Layer({ clock, events, spec, width, pick = null, onPlace, handleText, picked, styleMove = null, onText = null, canText = false, textLabel,
  textOpen = false, names, onTarget, lowNote = null, onBox }: {
  clock: Clock; events: LayerEvent[] | null; spec: StyleSpec | null; width: number;
  pick?: FramePick | null; onPlace?: (place: Place) => void; handleText?: HandleText; picked?: MutableRefObject<PickedBox | null>;
  styleMove?: StyleMove | null; // хук или субтитры: ручка тянет стиль (нет — только рамка)
  onText?: ((box: Box) => void) | null; // текст выбранного блока на кадре: касание ручки, Enter или F2 на ней, ✎
  canText?: boolean; textLabel?: string; // ✎ — текст можно править; его подпись
  textOpen?: boolean; // поле текста открыто: ✎ не видно, но он на месте — поле закрыли клавишей или кнопкой, фокус вернётся к нему
  names?: Record<FrameTarget['kind'], string>; // имена нарисованного — для экранного чтеца
  onTarget?: (target: FrameTarget, box: Box, ev: { t0: number; t1: number }) => void;
  lowNote?: string | null; // выбраны субтитры, а они ниже безопасной зоны Reels — подпись на кадре
  onBox?: (box: Box | null) => void; // рамка выбранного, как её нарисовал шаблон: поле текста на кадре стоит рядом с ней
}) {
  const index = useSyncExternalStore(clock.subscribe, () => (events ? eventIndexAt(events, clock.get()) : -1), () => -1);
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const ev = events && index >= 0 ? events[index] : null;
  const scale = width / 1080;
  let handle: ReactNode = null;
  let box: Box | null = null;
  let ext: BoxExt | undefined;
  if (spec && ev && pick) {
    if (pick.kind === 'insert') {
      const ins = ((ev.state.inserts ?? []) as Placed[]).find((i) => i.n === pick.n);
      const at = drawn?.boxes.inserts?.find((b) => b.n === pick.n);
      // поля тени — по нарисованному состоянию и его рамке (вместе, не вперемешку со свежей правкой)
      const was = ((drawn?.state.inserts ?? []) as Placed[]).find((i) => i.n === pick.n);
      if (at && typeof was?.x === 'number' && typeof was.y === 'number' && typeof was.w === 'number') {
        ext = { left: Math.max(0, was.x - at.x), top: Math.max(0, was.y - at.y), right: Math.max(0, at.x + at.w - was.x - was.w) };
      }
      if (ins && at) box = at;
      if (onPlace && handleText && ins && at && typeof ins.x === 'number' && typeof ins.y === 'number' && typeof ins.w === 'number') {
        const now = { x: ins.x, y: ins.y, w: ins.w };
        const shadow = ext;
        handle = (
          <BoxHandle key={`insert${pick.n}`} {...handleText(now)} box={at} x={now.x} y={now.y} scale={scale}
            onDrag={(x, y) => onPlace(moveBox(now, x, y, at.h, shadow))} onTap={onText ? () => onText(at) : undefined}
            size={{ value: now.w, min: INSERT_W.min, max: INSERT_W.max, onSize: (w) => onPlace(resizeBox(now, w, at.h, shadow)) }} />
        );
      }
    } else if (pick.kind === 'accent') {
      const acc = ev.state.accent as { x?: number; y?: number } | undefined;
      const at = drawn?.boxes.accent;
      const mine = ev.t0 >= pick.t0 - 1e-6 && ev.t0 < pick.t1 - 1e-6; // событие — во время выбранного акцента
      if (mine && acc && at) box = at;
      if (onPlace && handleText && mine && acc && at && typeof acc.x === 'number' && typeof acc.y === 'number') {
        const now = { x: acc.x, y: acc.y };
        handle = (
          <BoxHandle key="accent" {...handleText(now)} box={at} x={now.x} y={now.y} scale={scale} onDrag={(x, y) => onPlace(moveCentre(at, x, y))}
            onTap={onText ? () => onText(at) : undefined} />
        );
      }
    } else if (ev.state[pick.kind] !== undefined) { // хук, титр, субтитры, карточка — на кадре сейчас
      const at = drawn?.boxes[pick.kind];
      if (at) {
        box = at;
        if (styleMove && (pick.kind === 'hook' || pick.kind === 'sub')) {
          handle = <DragHandle key={pick.kind} box={at} {...styleMove} scale={scale} onTap={onText ? () => onText(at) : undefined} />;
        }
      }
    }
  }
  const key = pick ? pickKey(pick) : null;
  useEffect(() => { // рамку выбранного блока — кнопкам панели (они двигают его и тогда, когда он не на кадре)
    if (picked && key && box) picked.current = { key, box, ext };
  });
  const shown = useRef(box);
  shown.current = box;
  const boxSig = box ? `${box.x},${box.y},${box.w},${box.h}` : '';
  useEffect(() => onBox?.(shown.current), [boxSig, onBox]); // поле текста на кадре — рядом с рамкой, как её нарисовали сейчас
  if (!spec || !ev) return null;
  const place = (b: Box): CSSProperties => ({ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale });
  const under = handle && pick ? targetKey(pick) : null; // ручка выбранного — вместо его кнопки
  const hits = onTarget && drawn ? targets(drawn.boxes).filter((x) => targetKey(x.target) !== under) : [];
  return (
    <div className="ed-layer" data-event={index} data-t0={ev.t0}>
      <PreviewFrame frameUrl={null} spec={spec} state={ev.state} width={width} big
        onBoxes={(b, state) => setDrawn({ boxes: (b ?? {}) as Boxes, state: state as Record<string, unknown> })} />
      {hits.map(({ target, box: b }) => (
        <button key={targetKey(target)} type="button" className="ed-hit" tabIndex={-1} data-target={targetKey(target)} aria-label={names?.[target.kind]}
          style={place(b)} onClick={() => onTarget?.(target, b, { t0: ev.t0, t1: ev.t1 })} />
      ))}
      {box && !handle ? <div className="ed-outline" style={place(box)} aria-hidden="true" /> : null}
      {handle}
      {box && onText && canText ? (
        <button type="button" className={`ed-pencil${textOpen ? ' open' : ''}`} aria-label={textLabel} title={textLabel} onClick={() => onText(box)}
          style={{ left: box.x * scale, top: Math.max(0, box.y * scale - 24) }}>
          <PencilIcon size={13} />
        </button>
      ) : null}
      {lowNote && pick?.kind === 'sub' && underCaption(drawn?.boxes.sub) ? <div className="ed-caption at-top">{lowNote}</div> : null}
    </div>
  );
}

/** Шкала времени ролика — как её рисует ffmpeg (render._layers): полоса цвета шкалы, высота — чётная, ширина —
 *  min(1, t/длина) кадра; на стоп-кадре и карточке — полная. */
export function Bar({ clock, spec, duration, width }: { clock: Clock; spec: StyleSpec | null; duration: number; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const draw = () => {
      const el = ref.current;
      if (!el || !spec || duration <= 0) return;
      const k = Math.min(1, Math.max(0, clock.get() / duration));
      el.style.width = `${(k * 100).toFixed(3)}%`;
      el.dataset.progress = k.toFixed(4);
    };
    draw();
    return clock.subscribe(draw);
  }, [clock, spec, duration]);
  if (!spec || duration <= 0) return null;
  const h = Math.max(1, Math.round(spec.bar.height));
  const height = ((h + (h % 2)) * width) / 1080;
  return (
    <div className="ed-pbar" ref={ref} aria-hidden="true"
      style={{ height, background: spec.colors.bar, ...(spec.bar.pos === 'top' ? { top: 0 } : { bottom: 0 }) }} />
  );
}
