'use client';
// Кадр редактора поверх прокси — как его соберёт монтаж: картинка (зум к лицу, ч/б, смаз, перебивка на весь кадр,
// вспышка — по формулам движка, lib/picture.ts), слой шаблона (те же события, что рисуют финал: перерисовывается,
// только когда событие сменилось) и шкала времени (в финале её рисует ffmpeg, здесь — страница). Всё — по часам плеера,
// без перерисовки всего редактора.
import { useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import type { Clock } from '@/lib/clock.ts';
import type { StyleSpec } from '@/lib/jobfiles.ts';
import { eventIndexAt, FPS, type LayerEvent } from '@/lib/overlay.ts';
import { BW_FILTER, pictureAt, type Cover, type PictureModel } from '@/lib/picture.ts';
import PreviewFrame from '../../../preview-frame';

/** Перебивка-видео из загрузок Павла — в ветке её нет, а целиком её не отдаёт /upload: на кадре — метка. */
const isUploadVideo = (c: Cover) => c.video && c.src.startsWith('in/uploads/');

/**
 * Картинка ролика на прокси `video`: зум и ч/б — стилем самого <video>, смаз — у картинки вместе с перебивкой, белый
 * кадр вспышки — поверх них, под текстом (как в ffmpeg: переходы — после перебивок, слой — после переходов). Пока
 * видео перематывается, картинка не меняется раньше кадра: резкая смена крупности и края ч/б стоят ровно на склейках.
 * После кусков (стоп-кадр и карточка) — картинка последнего кадра.
 */
export function Picture({ clock, model, video, src, duration, width, playing, urlOf, note, children }: {
  clock: Clock; model: PictureModel | null; video: RefObject<HTMLVideoElement | null>; src: string | null; duration: number; width: number;
  playing: boolean; urlOf: (path: string) => string; note: string;
  children: ReactNode; // сам <video> плеера: смаз — у него вместе с перебивкой
}) {
  const pic = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const clip = useRef<HTMLVideoElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const live = useRef({ playing, cover: '' });
  live.current.playing = playing;

  useEffect(() => {
    const v = video.current;
    const last = Math.max(0, (Math.round(duration * FPS) - 1) / FPS);
    const show = (c: Cover | null, t: number) => {
      const key = c ? `${c.src}|${c.t0}` : '';
      if (key !== live.current.cover) {
        live.current.cover = key;
        const still = c && !c.video ? urlOf(c.src) : null;
        const moving = c && c.video && !isUploadVideo(c) ? urlOf(c.src) : null;
        if (img.current) {
          img.current.hidden = !still;
          if (still && img.current.getAttribute('src') !== still) img.current.src = still;
        }
        if (clip.current) {
          clip.current.hidden = !moving;
          if (moving && clip.current.getAttribute('src') !== moving) clip.current.src = moving;
          if (!moving) clip.current.pause();
        }
        if (label.current) label.current.hidden = !(c && isUploadVideo(c));
      }
      const m = clip.current;
      if (c && c.video && m && !m.hidden && m.readyState > 0) { // перебивка-видео идёт с начала, вместе с роликом
        const want = Math.max(0, t - c.t0);
        if (!live.current.playing || Math.abs(m.currentTime - want) > 0.3) m.currentTime = want;
        if (live.current.playing && m.paused) void m.play().catch(() => undefined);
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
        return;
      }
      if (v?.seeking) return; // кадр ещё старый — дорисуем по seeked
      const t = clock.get();
      const p = pictureAt(model, Math.min(t, last));
      if (v) {
        v.style.transformOrigin = `${(p.face.x * 100).toFixed(2)}% ${(p.face.y * 100).toFixed(2)}%`;
        v.style.transform = p.zoom > 1 + 1e-6 ? `scale(${p.zoom.toFixed(5)})` : '';
        v.style.filter = p.bw ? BW_FILTER : '';
        v.dataset.zoom = p.zoom.toFixed(4); // для проверок e2e: что видно на кадре
        v.dataset.bw = p.bw ? '1' : '';
      }
      if (pic.current) pic.current.style.filter = p.blur > 0 ? `blur(${((p.blur * width) / 1080).toFixed(2)}px)` : '';
      if (flash.current) flash.current.style.opacity = p.flash > 0 ? p.flash.toFixed(3) : '0';
      show(p.cover, t);
    };
    apply();
    const off = clock.subscribe(apply);
    v?.addEventListener('seeked', apply);
    return () => {
      off();
      v?.removeEventListener('seeked', apply);
    };
  }, [clock, model, video, src, duration, width, urlOf]);

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
      </div>
      <div className="ed-flash" ref={flash} aria-hidden="true" />
    </>
  );
}

/** Слой шаблона в момент часов: событие слоя — то, в котором лежит момент; перерисовка — только при смене события. */
export function Layer({ clock, events, spec, width }: { clock: Clock; events: LayerEvent[] | null; spec: StyleSpec | null; width: number }) {
  const index = useSyncExternalStore(clock.subscribe, () => (events ? eventIndexAt(events, clock.get()) : -1), () => -1);
  const ev = events && index >= 0 ? events[index] : null;
  if (!spec || !ev) return null;
  return (
    <div className="ed-layer" data-event={index} data-t0={ev.t0}>
      <PreviewFrame frameUrl={null} spec={spec} state={ev.state} width={width} big />
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
