// Монтаж в такт в редакторе — перенос из engine/vm/beats.py: доли музыки (их пишет vm render в beats.json — по всему
// треку) во времени ролика (beat_times: где и с какого места звучит трек, повтор по кругу) и сдвиг смен зума и появлений
// вставок на ближайшую долю не дальше 0,25 с (snap_edit). Общая фикстура engine/tests/fixtures/overlay-events.json (beats).
import { pyRound } from './pyround.ts';
import type { Timeline } from './timeline.ts';

export const SNAP = 0.25; // с — дальше этого событие к доле не двигается
const MIN_SHOWN = 0.3; // с — вставка, сдвинутая позже, остаётся на экране не меньше этого
const MIN_MUSIC = 0.5; // с — короче трек не звучит (MIN_MUSIC движка, audio.py)

/** beats.json: трек (как music.file в edit.json), его длина, темп и доли — секунды от начала трека. */
export type BeatsFile = { file: string; length: number; bpm: number; times: number[] };

/** Сколько трека нужно ролику: с места `skip`, звучит с `at` до конца ролика и ещё 2 с (beats.played). */
export const played = (length: number, at: number, skip: number, duration: number): number =>
  Math.min(length, skip + Math.max(0, duration - at) + 2.0);

/** Доли во времени ролика: трек звучит с `at`, с места `skip`; короче ролика — дальше по кругу целиком (beat_times). */
export function beatTimes(times: readonly number[], length: number, at: number, skip: number, duration: number): number[] {
  const want = skip + Math.max(0, duration - at) + 2.0;
  const period = played(length, at, skip, duration);
  const out = times.filter((t) => t >= skip).map((t) => at + t - skip);
  let start = at + period - skip;
  while (period < want - 0.05 && start < duration + 2.0) {
    for (const t of times) out.push(start + t);
    start += period;
  }
  return out;
}

/** Ближайшая к `t` доля, если она не дальше `limit`; иначе `t` (первая из равных, как argmin numpy). */
export function snap(t: number, times: readonly number[], limit = SNAP): number {
  if (!times.length) return t;
  let k = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[k] - t)) k = i;
  return Math.abs(times[k] - t) <= limit + 1e-9 ? times[k] : t;
}

type Snappable = { zooms?: readonly { t: number; over?: number }[] | null; inserts?: readonly { t0: number; t1: number; off?: boolean }[] | null };

/** Копия edit, где смены зума (кроме резких — over: 0) и появления вставок стоят на долях `times` (секунды ролика) —
 *  snap_edit движка: доля в тизере, в вырезке, за стыком с другой серией кусков или так поздно, что вставке останется
 *  меньше 0,3 с, — событие на месте; выключенная Павлом вставка (`off`) — тоже. → копия и сколько событий подвинуто. */
export function snapEdit<T extends Snappable>(edit: T, tl: Timeline, times: readonly number[], limit = SNAP): { edit: T; moved: number } {
  let moved = 0;
  const place = (t: number, until?: number): number => {
    const at = tl.toFinalSnap(t);
    const beat = snap(at, times, limit);
    if (beat === at) return t;
    const back = tl.toSource(beat);
    if (beat < tl.teaserDuration || Math.abs(tl.toFinalSnap(back) - beat) > 1e-6) return t;
    if (tl.runOf(back) !== tl.runOf(t)) return t; // доля — за стыком с куском из другого места записи
    if (until !== undefined && back > t && until - back < MIN_SHOWN) return t;
    moved += 1;
    return pyRound(back, 4);
  };
  const zooms = (edit.zooms ?? []).map((z) => (Number(z.over ?? 1) === 0 ? z : { ...z, t: place(Number(z.t)) }));
  const inserts = (edit.inserts ?? []).map((i) => (i.off ? i : { ...i, t0: place(Number(i.t0), Number(i.t1)) }));
  return { edit: { ...edit, zooms, inserts }, moved };
}

/** Доли музыки ролика во времени ролика — если монтаж их возьмёт: beats.json того же трека, музыка есть и не выключена
 *  (`beats: false`), её хватает (beats.played ≥ 0,5 с после места `from`). Иначе — null: монтаж не двигает ничего. */
export function musicBeats(beats: BeatsFile | null, music: { file: string; at?: number; from?: number; beats?: boolean } | null,
  duration: number): number[] | null {
  if (!beats || !music || music.beats === false || beats.file !== music.file) return null;
  const at = Number(music.at ?? 0);
  const skip = Number(music.from ?? 0);
  const period = played(beats.length, at, skip, duration);
  if (period < MIN_MUSIC || skip > period - MIN_MUSIC) return null;
  return beatTimes(beats.times, beats.length, at, skip, duration);
}
