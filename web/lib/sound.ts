// Прослушивание в редакторе: громкость голоса, музыки и звуков — как их сводит движок (engine/vm/audio.py; числа ниже —
// его, тест сверяет), во времени финала. Только расчёты; звучит — плеер редактора через Web Audio.
//
// Голос прокси vm prepare выравнивает к громкости голоса в ролике (VOICE_LUFS), музыку движок подгоняет к ней же и
// ставит на gainDb ниже, звуки — SFX_GAIN_DB к громкости файла. Так прослушивание держит баланс ролика; не повторяет
// только приглушение музыки под речью (в ролике она под голосом чуть тише) и точную громкость трека (тут — по
// средней мощности, движок меряет LUFS).
import type { Level, MusicAdjust } from './edits.ts';

export const VOICE_LUFS = -14; // громкость голоса в ролике и в прокси редактора
export const MUSIC_BOOST = 12; // дБ — тихий трек поднимается к голосу не больше
export const SFX_GAIN_DB = -13; // дБ к громкости файла звука
export const FADE_IN = 0.1; // с — нарастание музыки, если Павел не задал своё
export const FADE_OUT = 1.0; // с — затухание к концу ролика
export const DEFAULT_MUSIC_DB = -14; // music.gainDb, если его нет

export const dbToGain = (db: number): number => 10 ** (db / 20);

/** Звук (музыка, звуки появления) — через страницу: тот же источник, Web Audio его читает; с головой — кэшируется. */
export const audioUrl = (id: string, head: string, file: string): string => `/api/jobs/${id}/audio?path=${encodeURIComponent(file)}&v=${head}`;

// ---------- музыка ----------

export type MusicMix = { file: string; gainDb: number; muted: boolean; at: number; from: number; fadeIn: number; fadeOut: number };
type DraftMusic = { file: string; gainDb?: number; at?: number; from?: number; fadeIn?: number; fadeOut?: number };

/** Музыка черновика с правками Павла поверх (как edits.apply движка): где, с какого места трека, громкость, затухания.
 *  Музыки в черновике нет — null (правка её не добавляет). */
export function musicMix(draft: DraftMusic | null, adjust: MusicAdjust = {}): MusicMix | null {
  if (!draft) return null;
  const m = { ...draft, ...adjust };
  return {
    file: draft.file, gainDb: m.gainDb ?? DEFAULT_MUSIC_DB, muted: m.muted ?? false, at: m.at ?? 0, from: m.from ?? 0,
    fadeIn: m.fadeIn ?? FADE_IN, fadeOut: m.fadeOut ?? FADE_OUT,
  };
}

/** Место в треке длиной `length` (с) в момент ролика `t`: до начала музыки — null. Трек повторяется: первый проход —
 *  с `from`, дальше — целиком (как -stream_loop с -ss у движка). */
export function musicOffset(m: { at: number; from: number }, length: number, t: number): number | null {
  if (t < m.at || !(length > 0)) return null;
  const played = t - m.at;
  const first = length - m.from;
  return played < first ? m.from + played : (played - first) % length;
}

/** Огибающая 0..1 в момент `t`: нарастание за `fadeIn` от начала музыки, затухание за `fadeOut` к концу ролика
 *  `duration`; затухания не длиннее музыки, оба — по прямой и множатся (afade за afade). */
export function musicEnvelope(m: { at: number; fadeIn: number; fadeOut: number }, t: number, duration: number): number {
  const plays = duration - m.at;
  if (t < m.at || t >= duration || plays <= 0) return 0;
  const x = t - m.at;
  const fadeIn = Math.min(m.fadeIn, plays);
  const fadeOut = Math.min(m.fadeOut, plays);
  const rise = fadeIn > 0 && x < fadeIn ? x / fadeIn : 1;
  const fall = fadeOut > 0 && plays - x < fadeOut ? (plays - x) / fadeOut : 1;
  return rise * fall;
}

/** Огибающая с момента `t` до конца ролика, `hz` точек в секунду (последняя — конец) — для setValueCurveAtTime. */
export function envelopeCurve(m: { at: number; fadeIn: number; fadeOut: number }, t: number, duration: number, hz = 20): Float32Array {
  const n = Math.max(2, Math.round((duration - t) * hz) + 1);
  return Float32Array.from({ length: n }, (_, k) => musicEnvelope(m, Math.min(duration, t + k / hz), duration));
}

/** Сколько дБ дать треку громкостью `level` (≈ LUFS; null — не измерилась), чтобы он встал на `gainDb` к голосу. */
export const musicGainDb = (gainDb: number, level: number | null): number =>
  gainDb + (level === null ? 0 : Math.min(MUSIC_BOOST, VOICE_LUFS - level));

/** Громкость трека по первым `seconds` с его отсчётов, как её меряет движок (стерео; моно — в оба канала): мощность
 *  каналов сложена, −0,691 дБ — примерно LUFS, только без частотного взвешивания. Тишина — null. */
export function loudnessDb(channels: Float32Array[], rate: number, seconds: number): number | null {
  const n = Math.min(channels[0]?.length ?? 0, Math.round(seconds * rate));
  if (!n) return null;
  const power = (x: Float32Array) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += x[i] * x[i];
    return sum / n;
  };
  const total = channels.length === 1 ? 2 * power(channels[0]) : power(channels[0]) + power(channels[1]);
  const level = -0.691 + 10 * Math.log10(total || 1e-30);
  return level > -70 ? level : null;
}

// ---------- громкости ----------

export type Levels = { voice: number; music: number; sound: (l?: Level) => number };

/**
 * Громкости прослушивания: голос — громкость элемента видео (0..1), музыка и звуки — множители Web Audio. `musicDb` —
 * сколько дБ дать треку (musicGainDb; null — музыка без звука). Громче 0 дБ элемент голос не даст — тогда на столько
 * же тише всё остальное: баланс тот же.
 */
export function levelsOf({ voice = {}, musicDb }: { voice?: Level; musicDb: number | null }): Levels {
  const voiceDb = voice.gainDb ?? 0;
  const head = Math.max(0, voiceDb);
  return {
    voice: voice.muted ? 0 : Math.min(1, dbToGain(voiceDb - head)),
    music: musicDb === null ? 0 : dbToGain(musicDb - head),
    sound: (l = {}) => (l.muted ? 0 : dbToGain(SFX_GAIN_DB + (l.gainDb ?? 0) - head)),
  };
}

// ---------- звуки появления ----------

export type SoundAt = { key: string; t0: number; file: string };

/** Что запустить с момента ролика `t`: звуки впереди — через `when` с, тот, что ещё звучит, — с середины (`offset`),
 *  «без звука» — никогда. `lengthOf(file)` — длина файла, с. */
export function soundPlan<S extends SoundAt>(sounds: readonly S[], levels: Record<string, Level>, t: number, lengthOf: (file: string) => number):
  (S & { when: number; offset: number })[] {
  return sounds.flatMap((s) => {
    if (levels[s.key]?.muted) return [];
    if (s.t0 >= t) return [{ ...s, when: s.t0 - t, offset: 0 }];
    return t - s.t0 < lengthOf(s.file) ? [{ ...s, when: 0, offset: t - s.t0 }] : [];
  });
}
