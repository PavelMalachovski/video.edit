// Перетаскивание на дорожках редактора: край куска, кусок целиком, музыка. Где окажется перетаскиваемое, считается от
// точки, где сейчас мышь или палец, — и в конце от точки, где отпустили: последний шаг движения мог ещё не попасть на
// экран (React рисует его чуть позже), и край встал бы на шаг раньше, не прилипнув к слову (ловил e2e в Safari).
import { snapTo } from './edits.ts';
import { slotAt, type Tracks } from './tracks.ts';

/** Сдвиг мыши меньше — это щелчок, а не перетаскивание, px. */
export const CLICK_PX = 3;

export type Drag =
  | { kind: 'trim'; index: number; side: 'start' | 'end'; x0: number; to: number }
  // кусок целиком — на другое место: tf0 — момент ролика под пальцем в начале, slot — перед каким куском встанет
  | { kind: 'piece'; index: number; x0: number; tf0: number; dx: number; slot: number | null; moved: boolean }
  | { kind: 'music'; mode: 'move' | 'trim'; x0: number; at0: number; from0: number; at: number; from: number; moved: boolean };

/** Что нужно, чтобы перевести пиксели в секунды: дорожки, px на секунду ролика, скорость монтажа, границы слов (к ним
 *  липнет край куска ближе `snapPx`), длина ролика. */
export type DragView = { tracks: Tracks; px: number; speed: number; edges: number[]; snapPx: number; duration: number };

/** Перетаскивание `d`, когда указатель — на `clientX`: всё считается от точки начала (`x0`), а не от прошлого шага. */
export function dragTo(d: Drag, clientX: number, v: DragView): Drag {
  const dx = clientX - d.x0;
  if (d.kind === 'trim') {
    const c = v.tracks.video[d.index];
    const edge = (d.side === 'start' ? c.src0 : c.src1) as number;
    return { ...d, to: snapTo(edge + (dx / v.px) * v.speed, v.edges, (v.snapPx / v.px) * v.speed) };
  }
  const moved = d.moved || Math.abs(dx) >= CLICK_PX;
  if (d.kind === 'piece') return { ...d, dx, moved, slot: moved ? slotAt(v.tracks, d.tf0 + dx / v.px) : null };
  const t = dx / v.px;
  const room = Math.max(0, v.duration - 0.5); // музыка начинается не позже, чем за полсекунды до конца ролика
  if (d.mode === 'move') return { ...d, at: Math.min(room, Math.max(0, d.at0 + t)), moved };
  const k = Math.min(room - d.at0, Math.max(-Math.min(d.at0, d.from0), t));
  return { ...d, at: d.at0 + k, from: d.from0 + k, moved };
}
