'use client';
// Ручки текста и вставок поверх кадра (px кадра 1080×1920 → px экрана через `scale`): на «Превью» — хук, субтитры и
// вставки; в редакторе — выбранные хук и субтитры (рамкой по нарисованному), вставка и акцент. Один палец или мышь —
// тащит, щипок двумя пальцами или уголок ⤢ — размер, стрелки клавиатуры — сдвиг по STEP; в редакторе касание без сдвига,
// Enter или F2 — текст блока прямо на кадре (`onTap`).
import { useRef } from 'react';

export const STEP = 20; // px кадра на нажатие «Выше» / «Ниже» и стрелку
const GROW = 540; // уголок ⤢: на столько px кадра (половина его ширины) потянуть вправо, чтобы размер вырос вдвое
const SLOP = 4; // px экрана: палец дрожит и при касании — пока он не ушёл дальше, это не перетаскивание (место не трогаем)

/** Рамка нарисованного на кадре (от шаблона: window.layoutBoxes), px кадра. */
export type Box = { x: number; y: number; w: number; h: number };

type HandleProps = {
  label: string; y: number; range: { min: number; max: number }; scale: number; onMove: (y: number) => void; size: number; onSize: (size: number) => void;
};
// x0, y0 — где палец или мышь нажали; live — ушли дальше SLOP: жест начался
type Gesture =
  | { kind: 'move'; x0: number; y0: number; live: boolean; y: number }
  | { kind: 'drag'; x0: number; y0: number; live: boolean; x: number; y: number }
  | { kind: 'grow'; x0: number; y0: number; live: boolean; size: number }
  | { kind: 'pinch'; span: number; size: number };

/** Жесты ручки: один палец или мышь — `move` (только выше-ниже) или `drag` (куда угодно); два пальца — щипок, `onSize`;
 *  уголок `[data-grip]` мышкой вправо-влево — тоже `onSize`. Палец убран — жест закончен: оставшийся палец ручку не дёргает.
 *  Нажатие без сдвига (не дальше SLOP, не уголок) — `onTap`: мышью — сразу при отпускании (щелчка после отменённого
 *  нажатия браузер может и не прислать), пальцем — в щелчке, которым браузер заканчивает касание: фокус полю оттуда даёт
 *  и клавиатуру iPhone. */
function useGestures(scale: number, size: number, onSize: (size: number) => void, move?: { y: number; onMove: (y: number) => void },
  drag?: { x: number; y: number; onDrag: (x: number, y: number) => void }, onTap?: () => void) {
  const points = useRef(new Map<number, number>()); // пальцы на ручке: id → x
  const gesture = useRef<Gesture | null>(null);
  const tap = useRef(false); // последнее нажатие — касание без сдвига: щелчок после него — onTap
  const span = () => {
    const [a, b] = [...points.current.values()];
    return Math.abs(a - b);
  };
  const end = (id: number) => {
    points.current.delete(id);
    gesture.current = null;
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      // без выделения текста и своего перетаскивания браузера: Safari, начав тащить выделенный значок ⤢, забирает мышь
      // себе — странице не приходят ни движения, ни отпускание (жест обрывался после первого шага). Фокус — ручке (стрелки).
      // Палец по ручке с текстом — без отмены: касание браузер закончит щелчком (onTap), а прокрутку и масштаб и так держит
      // touch-action
      tap.current = false;
      if (!onTap || e.pointerType === 'mouse') e.preventDefault();
      e.currentTarget.focus({ preventScroll: true });
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // указатель уже ушёл — жест всё равно ловим
      }
      points.current.set(e.pointerId, e.clientX);
      const g = gesture.current;
      const at = { x0: e.clientX, y0: e.clientY, live: false };
      if (points.current.size >= 2) {
        // первый палец уже сдвинул ручку — щипок только про размер: место — как до жеста
        if (g?.kind === 'move' && g.live) move?.onMove(g.y);
        if (g?.kind === 'drag' && g.live) drag?.onDrag(g.x, g.y);
        gesture.current = { kind: 'pinch', span: Math.max(1, span()), size };
      } else if ((e.target as HTMLElement).closest('[data-grip]')) {
        gesture.current = { kind: 'grow', ...at, size };
      } else if (move) {
        gesture.current = { kind: 'move', ...at, y: move.y };
      } else if (drag) {
        gesture.current = { kind: 'drag', ...at, x: drag.x, y: drag.y };
      }
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (points.current.has(e.pointerId)) points.current.set(e.pointerId, e.clientX);
      const g = gesture.current;
      if (g && g.kind !== 'pinch' && !g.live) {
        if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < SLOP) return; // касание, а не перетаскивание
        g.live = true;
      }
      if (g?.kind === 'move') move?.onMove(g.y + (e.clientY - g.y0) / scale);
      else if (g?.kind === 'drag') drag?.onDrag(g.x + (e.clientX - g.x0) / scale, g.y + (e.clientY - g.y0) / scale);
      else if (g?.kind === 'grow') onSize(g.size * (1 + (e.clientX - g.x0) / (GROW * scale)));
      else if (g?.kind === 'pinch' && points.current.size >= 2) onSize((g.size * span()) / g.span);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      const tapped = g !== null && g.kind !== 'pinch' && g.kind !== 'grow' && !g.live && points.current.size === 1 && e.button <= 0;
      end(e.pointerId);
      tap.current = tapped && e.pointerType !== 'mouse';
      if (tapped && e.pointerType === 'mouse') onTap?.();
    },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
      tap.current = false;
      end(e.pointerId);
    },
    onClick: () => {
      if (!tap.current) return;
      tap.current = false;
      onTap?.();
    },
  };
}

/** Enter или F2 на ручке — как касание (`onTap`, текст блока); true — нажатие обработано. */
function tapKey(e: React.KeyboardEvent, onTap?: () => void): boolean {
  if ((e.key !== 'Enter' && e.key !== 'F2') || !onTap) return false;
  e.preventDefault();
  onTap();
  return true;
}

/** Ручка текста — двигает выше-ниже и меняет размер; стрелки — по STEP. На крупном превью — полоса на высоте `y` (px
 *  кадра); в редакторе — рамка `box` по нарисованному блоку, касание без сдвига, Enter или F2 — `onTap` (текст блока). */
export function DragHandle({ label, y, range, scale, onMove, size, onSize, box, title, onTap }: HandleProps & {
  box?: Box; title?: string; onTap?: () => void;
}) {
  const gestures = useGestures(scale, size, onSize, { y, onMove }, undefined, onTap);
  return (
    <div className={`sub-handle${box ? ' boxed' : ''}`} role="slider" tabIndex={0} aria-label={label} aria-orientation="vertical"
      aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={y} title={title ?? `${label}: потяни выше или ниже; размер — щипком или уголком`}
      style={box ? { left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale } : { top: y * scale }} {...gestures}
      onKeyDown={(e) => {
        if (tapKey(e, onTap)) return;
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        onMove(y + (e.key === 'ArrowUp' ? -STEP : STEP));
      }}>
      <span className="size-grip" data-grip aria-hidden="true">⤢</span>
    </div>
  );
}

type BoxHandleProps = {
  label: string; title: string; valueText: string;
  box: Box; // где блок нарисован (от шаблона, вместе с тенью и плашкой)
  x: number; y: number; // его место сейчас, px кадра: у вставки — левый верхний угол, у акцента — центр
  scale: number; onDrag: (x: number, y: number) => void;
  size?: { value: number; min: number; max: number; onSize: (w: number) => void }; // ширина: щипок и уголок ⤢; нет — только тащить
  onTap?: () => void; // касание без сдвига, Enter или F2 — текст блока
};

/** Ручка блока на кадре — рамка по его месту: один палец или мышь — тащит куда угодно, щипок или уголок ⤢ — ширина (у
 *  блока, у которого она есть); стрелки — сдвиг по STEP; касание без сдвига, Enter или F2 — `onTap`. */
export function BoxHandle({ label, title, valueText, box, x, y, scale, onDrag, size, onTap }: BoxHandleProps) {
  const gestures = useGestures(scale, size?.value ?? box.w, size?.onSize ?? (() => undefined), undefined, { x, y, onDrag }, onTap);
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
  return (
    <div className="insert-handle" role="slider" tabIndex={0} aria-label={label} aria-valuemin={size?.min ?? 0} aria-valuemax={size?.max ?? 1920}
      aria-valuenow={size?.value ?? Math.round(y)} aria-valuetext={valueText} title={title}
      style={{ left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale }} {...gestures}
      onKeyDown={(e) => {
        if (tapKey(e, onTap)) return;
        const step = arrows[e.key];
        if (!step) return;
        e.preventDefault();
        onDrag(x + step[0], y + step[1]);
      }}>
      {size ? <span className="size-grip" data-grip aria-hidden="true">⤢</span> : null}
    </div>
  );
}
