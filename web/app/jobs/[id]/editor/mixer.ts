// Музыка и звуки появления на прослушивании в редакторе — Web Audio поверх голоса прокси (его громкость — у элемента
// видео). Что и когда звучит — web/lib/sound.ts (как сводит движок); здесь только запуск: трек и звуки грузятся через
// страницу (тот же источник), музыка повторяется с огибающей затуханий, всё ставится по часам AudioContext от момента
// ролика и перезапускается, если видео ушло от них (подгрузка, перемотка) или поменялось, что и когда звучит.
// Громкость и «без звука» меняются на ходу, без перезапуска: «без звука» тоже звучит — с нулевой громкостью.
import type { Level } from '@/lib/edits.ts';
import {
  envelopeCurve, levelsOf, loudnessDb, MIN_MUSIC, musicGainDb, musicOffset, scheduleKey, soundPlan, type MusicMix, type SoundAt,
} from '@/lib/sound.ts';

export type MixPlan = {
  duration: number; // длина ролика со стоп-кадром и карточкой, с
  voice: Level;
  music: (MusicMix & { url: string }) | null;
  sounds: (SoundAt & { url: string })[];
  soundLevels: Record<string, Level>;
};

const LEAD = 0.03; // с — запас на запуск узлов
const DRIFT = 0.2; // с — видео ушло от часов звука дальше — перезапуск
const CURVE_HZ = 20; // точек огибающей музыки в секунду
const SMOOTH = 0.02; // с — громкость меняется плавно, без щелчка

export class Mixer {
  #ctx: AudioContext | null = null;
  #buffers = new Map<string, Promise<AudioBuffer | null>>();
  #levels = new Map<string, number | null>(); // `${url}|${с места}|${секунды}` → громкость трека
  #nodes: AudioScheduledSourceNode[] = [];
  #run: { clock: () => number; plan: MixPlan } | null = null; // играет (или грузится к пуску)
  #live: { ctx0: number; t0: number; schedule: string; musicLevel: number | null } | null = null; // запущено
  #musicGain: GainNode | null = null;
  #soundGains = new Map<string, GainNode>();
  #gen = 0;

  #context(): AudioContext | null {
    if (!this.#ctx && typeof AudioContext !== 'undefined') this.#ctx = new AudioContext();
    return this.#ctx;
  }

  #buffer(url: string): Promise<AudioBuffer | null> {
    let p = this.#buffers.get(url);
    if (!p) {
      const ctx = this.#context();
      p = ctx
        ? fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((b) => ctx.decodeAudioData(b))
          .catch(() => {
            this.#buffers.delete(url); // в другой раз — снова (ссылка могла протухнуть)
            return null;
          })
        : Promise.resolve(null);
      this.#buffers.set(url, p);
    }
    return p;
  }

  /** Загрузить звуки плана заранее, чтобы пуск не ждал сети. */
  preload(plan: MixPlan): void {
    if (plan.music) void this.#buffer(plan.music.url);
    for (const s of plan.sounds) void this.#buffer(s.url);
  }

  /** Играть с текущего момента ролика (`clock()` — время финала, его же видит плеер). Прошлое — остановить. */
  async start(clock: () => number, plan: MixPlan): Promise<void> {
    this.#halt();
    this.#run = { clock, plan };
    const gen = this.#gen;
    const ctx = this.#context();
    if (!ctx) return;
    await ctx.resume().catch(() => undefined);
    const urls = [...new Set([...(plan.music ? [plan.music.url] : []), ...plan.sounds.map((s) => s.url)])];
    const loaded = new Map(await Promise.all(urls.map(async (u) => [u, await this.#buffer(u)] as const)));
    if (gen !== this.#gen) return; // пока грузилось — пауза или новый пуск
    const t = clock();
    const now = ctx.currentTime + LEAD;
    const m = plan.music;
    const track = m ? loaded.get(m.url) ?? null : null;
    // с места `from` трека почти ничего не остаётся — движок ставит ролик без музыки, и тут её нет
    const music = m && track && m.from <= track.duration - MIN_MUSIC ? track : null;
    const musicLevel = m && music ? this.#loudness(m.url, music, m.from, Math.min(plan.duration - m.at, music.duration - m.from)) : null;
    const levels = this.#levelsOf(plan, musicLevel, Boolean(music));
    if (m && music) this.#music(ctx, now, t, m, music, levels.music, plan.duration);
    const urlOf = new Map(plan.sounds.map((s) => [s.file, s.url]));
    const lengthOf = (file: string) => loaded.get(urlOf.get(file) ?? '')?.duration ?? 0;
    for (const s of soundPlan(plan.sounds, {}, t, lengthOf)) { // и «без звука» — с нулевой громкостью: включат на ходу
      const buffer = loaded.get(s.url);
      if (!buffer || s.t0 > plan.duration) continue;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const g = ctx.createGain();
      g.gain.value = levels.sound(plan.soundLevels[s.key]);
      src.connect(g).connect(ctx.destination);
      src.start(now + s.when, s.offset);
      this.#nodes.push(src);
      this.#soundGains.set(s.key, g);
    }
    this.#live = { ctx0: now, t0: t, schedule: scheduleKey(plan), musicLevel };
  }

  #levelsOf(plan: MixPlan, musicLevel: number | null, hasMusic: boolean) {
    const m = plan.music;
    return levelsOf({ voice: plan.voice, musicDb: m && hasMusic && !m.muted ? musicGainDb(m.gainDb, musicLevel) : null });
  }

  #music(ctx: AudioContext, now: number, t: number, m: MusicMix, buffer: AudioBuffer, gain: number, duration: number): void {
    const begin = Math.max(t, m.at); // момент ролика, с которого звучит
    if (begin >= duration) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true; // первый проход — с `from`, дальше — весь трек (offset ниже — уже внутри него)
    src.loopStart = 0;
    src.loopEnd = buffer.duration;
    const env = ctx.createGain();
    const curve = envelopeCurve(m, begin, duration, CURVE_HZ);
    env.gain.value = curve[0];
    const when = now + (begin - t);
    env.gain.setValueCurveAtTime(curve, when, Math.max(1 / CURVE_HZ, duration - begin));
    const level = ctx.createGain();
    level.gain.value = gain;
    src.connect(env).connect(level).connect(ctx.destination);
    src.start(when, musicOffset(m, buffer.duration, begin) ?? m.from);
    src.stop(now + (duration - t));
    this.#nodes.push(src);
    this.#musicGain = level;
  }

  #loudness(url: string, buffer: AudioBuffer, from: number, seconds: number): number | null {
    const key = `${url}|${from.toFixed(1)}|${seconds.toFixed(1)}`;
    if (!this.#levels.has(key)) {
      const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, i) => buffer.getChannelData(i));
      this.#levels.set(key, loudnessDb(channels, buffer.sampleRate, seconds, from));
    }
    return this.#levels.get(key) ?? null;
  }

  /** Тишина: всё запущенное — стоп (пауза, перемотка, уход со страницы). */
  stop(): void {
    this.#halt();
    this.#run = null;
  }

  #halt(): void {
    this.#gen++;
    for (const n of this.#nodes) {
      try {
        n.stop();
      } catch {
        // ещё не начинался или уже кончился
      }
      n.disconnect();
    }
    this.#nodes = [];
    this.#live = null;
    this.#musicGain = null;
    this.#soundGains.clear();
  }

  /** Плеер на моменте `t`: часы звука ушли дальше DRIFT (видео подгружалось) — перезапуск с того же плана. */
  sync(t: number): void {
    const live = this.#live;
    const run = this.#run;
    const ctx = this.#ctx;
    if (!live || !run || !ctx) return;
    const expected = live.t0 + (ctx.currentTime - live.ctx0);
    if (Math.abs(expected - t) > DRIFT) void this.start(run.clock, run.plan);
  }

  /** Поменялся план. Играет: то же расписание — громкость на ходу, другое (место музыки, звуки, длина) — перезапуск. */
  update(plan: MixPlan): void {
    const run = this.#run;
    if (!run || run.plan === plan) return;
    const live = this.#live;
    const ctx = this.#ctx;
    if (!live || !ctx || live.schedule !== scheduleKey(plan)) {
      void this.start(run.clock, plan);
      return;
    }
    this.#run = { ...run, plan };
    const levels = this.#levelsOf(plan, live.musicLevel, this.#musicGain !== null);
    this.#musicGain?.gain.setTargetAtTime(levels.music, ctx.currentTime, SMOOTH);
    for (const [key, g] of this.#soundGains) g.gain.setTargetAtTime(levels.sound(plan.soundLevels[key]), ctx.currentTime, SMOOTH);
  }

  close(): void {
    this.stop();
    void this.#ctx?.close().catch(() => undefined);
    this.#ctx = null;
    this.#buffers.clear();
  }
}
