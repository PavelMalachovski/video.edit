'use client';
// Кадр редактора поверх прокси — как его соберёт монтаж: картинка (зум к лицу, ч/б, смаз, перебивка на весь кадр,
// вспышка — по формулам движка, lib/picture.ts), слой шаблона (те же события, что рисуют финал: перерисовывается,
// только когда событие сменилось) и шкала времени (в финале её рисует ffmpeg, здесь — страница). Всё — по часам плеера,
// без перерисовки всего редактора. Нарисованное выбирают касанием кадра; выбранное — рамкой (хук и субтитры тянутся
// выше-ниже и крупнее, вставки и акценты — по кадру), ✎ — текст блока прямо на кадре.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import type { Clock } from '@/lib/clock.ts';
import type { Place } from '@/lib/edits.ts';
import type { StyleSpec } from '@/lib/jobfiles.ts';
import { eventIndexAt, FPS, type LayerEvent } from '@/lib/overlay.ts';
import { lookFilter, pictureAt, type Cover, type PictureModel } from '@/lib/picture.ts';
import { INSERT_W, moveBox, moveCentre, resizeBox, underCaption, type BoxExt } from '@/lib/style.ts';
import { BoxHandle, DragHandle, type Box } from '../../../handles';
import { PencilIcon } from '../../../icons';
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
        v.style.filter = lookFilter(p.look);
        v.dataset.zoom = p.zoom.toFixed(4); // для проверок e2e: что видно на кадре
        v.dataset.bw = p.look === 'bw' ? '1' : '';
        v.dataset.look = p.look ?? '';
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
