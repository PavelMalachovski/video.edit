'use client';
// Ручки текста и вставок поверх кадра (px кадра 1080×1920 → px экрана через `scale`): на «Превью» — хук, субтитры и
// вставки; в редакторе — вставка и акцент, выбранные на дорожке. Один палец или мышь — тащит, щипок двумя пальцами или
// уголок ⤢ — размер, стрелки клавиатуры — сдвиг по STEP.
import { useRef } from 'react';

export const STEP = 20; // px кадра на нажатие «Выше» / «Ниже» и стрелку
const GROW = 540; // уголок ⤢: на столько px кадра (половина его ширины) потянуть вправо, чтобы размер вырос вдвое

/** Рамка нарисованного на кадре (от шаблона: window.layoutBoxes), px кадра. */
export type Box = { x: number; y: number; w: number; h: number };

type HandleProps = {
  label: string; y: number; range: { min: number; max: number }; scale: number; onMove: (y: number) => void; size: number; onSize: (size: number) => void;
};
type Gesture =
  | { kind: 'move'; from: number; y: number }
  | { kind: 'drag'; fromX: number; fromY: number; x: number; y: number }
  | { kind: 'grow'; from: number; size: number }
  | { kind: 'pinch'; span: number; size: number };

/** Жесты ручки: один палец или мышь — `move` (только выше-ниже) или `drag` (куда угодно); два пальца — щипок, `onSize`;
 *  уголок `[data-grip]` мышкой вправо-влево — тоже `onSize`. Палец убран — жест закончен: оставшийся палец ручку не дёргает. */
function useGestures(scale: number, size: number, onSize: (size: number) => void, move?: { y: number; onMove: (y: number) => void },
  drag?: { x: number; y: number; onDrag: (x: number, y: number) => void }) {
  const points = useRef(new Map<number, number>()); // пальцы на ручке: id → x
  const gesture = useRef<Gesture | null>(null);
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
      // себе — странице не приходят ни движения, ни отпускание (жест обрывался после первого шага). Фокус — ручке (стрелки)
      e.preventDefault();
      e.currentTarget.focus({ preventScroll: true });
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // указатель уже ушёл — жест всё равно ловим
      }
      points.current.set(e.pointerId, e.clientX);
      const g = gesture.current;
      if (points.current.size >= 2) {
        if (g?.kind === 'move') move?.onMove(g.y); // первый палец уже сдвинул ручку — щипок только про размер
        if (g?.kind === 'drag') drag?.onDrag(g.x, g.y);
        gesture.current = { kind: 'pinch', span: Math.max(1, span()), size };
      } else if ((e.target as HTMLElement).closest('[data-grip]')) {
        gesture.current = { kind: 'grow', from: e.clientX, size };
      } else if (move) {
        gesture.current = { kind: 'move', from: e.clientY, y: move.y };
      } else if (drag) {
        gesture.current = { kind: 'drag', fromX: e.clientX, fromY: e.clientY, x: drag.x, y: drag.y };
      }
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (points.current.has(e.pointerId)) points.current.set(e.pointerId, e.clientX);
      const g = gesture.current;
      if (g?.kind === 'move') move?.onMove(g.y + (e.clientY - g.from) / scale);
      else if (g?.kind === 'drag') drag?.onDrag(g.x + (e.clientX - g.fromX) / scale, g.y + (e.clientY - g.fromY) / scale);
      else if (g?.kind === 'grow') onSize(g.size * (1 + (e.clientX - g.from) / (GROW * scale)));
      else if (g?.kind === 'pinch' && points.current.size >= 2) onSize((g.size * span()) / g.span);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => end(e.pointerId),
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => end(e.pointerId),
  };
}

/** Ручка текста на крупном превью — полоса на высоте `y` (px кадра): двигает выше-ниже и меняет размер; стрелки — по STEP. */
export function DragHandle({ label, y, range, scale, onMove, size, onSize }: HandleProps) {
  const gestures = useGestures(scale, size, onSize, { y, onMove });
  return (
    <div className="sub-handle" role="slider" tabIndex={0} aria-label={label} aria-orientation="vertical"
      aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={y} title={`${label}: потяни выше или ниже; размер — щипком или уголком`}
      style={{ top: y * scale }} {...gestures}
      onKeyDown={(e) => {
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
};

/** Ручка блока на кадре — рамка по его месту: один палец или мышь — тащит куда угодно, щипок или уголок ⤢ — ширина (у
 *  блока, у которого она есть); стрелки — сдвиг по STEP. */
export function BoxHandle({ label, title, valueText, box, x, y, scale, onDrag, size }: BoxHandleProps) {
  const gestures = useGestures(scale, size?.value ?? box.w, size?.onSize ?? (() => undefined), undefined, { x, y, onDrag });
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
  return (
    <div className="insert-handle" role="slider" tabIndex={0} aria-label={label} aria-valuemin={size?.min ?? 0} aria-valuemax={size?.max ?? 1920}
      aria-valuenow={size?.value ?? Math.round(y)} aria-valuetext={valueText} title={title}
      style={{ left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale }} {...gestures}
      onKeyDown={(e) => {
        const step = arrows[e.key];
        if (!step) return;
        e.preventDefault();
        onDrag(x + step[0], y + step[1]);
      }}>
      {size ? <span className="size-grip" data-grip aria-hidden="true">⤢</span> : null}
    </div>
  );
}
