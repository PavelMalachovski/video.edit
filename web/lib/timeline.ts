// Шкала времени: как время исходника становится временем финала — перенос `Timeline` из engine/vm/timeline.py
// (общая фикстура engine/tests/fixtures/timeline-map.json; меняются только вместе).
//
// Финал — оставленные отрезки исходника (`keep`), склеенные встык и ускоренные в `speed` раз. Тизер (`teaser`) —
// фраза из середины, которая звучит в самом начале, а потом ещё раз на своём месте: финал — тизер, затем `keep`.

/** С исходника: момент так близко к краю отрезка встаёт ровно на край (как TO_CUT движка). */
export const TO_CUT = 0.25;

/** Индекс первого элемента `a` (по возрастанию) больше `t` — как bisect_right. */
function bisectRight(a: number[], t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t < a[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export class Timeline {
  readonly #speed: number;
  readonly #teaser: [number, number] | null;
  readonly #lead: number; // секунд исходника в тизере
  readonly #starts: number[] = [];
  readonly #ends: number[] = [];
  readonly #played: number[] = []; // сколько секунд исходника лежит в финале до отрезка
  readonly #duration: number;

  /** `keep` — отрезки исходника по возрастанию, без пересечений; `speed` — во сколько раз финал быстрее; `teaser` —
   *  `[начало, конец]` фразы, которая идёт первой. Не так — Error, как ValueError движка. */
  constructor(keep: readonly (readonly number[])[], speed: number, teaser: readonly number[] | null = null) {
    if (!(finite(speed) && speed > 0)) throw new Error(`speed must be a positive number, got ${speed}`);
    this.#speed = speed;
    if (teaser !== null) {
      const [a, b] = teaser;
      if (!(finite(a) && finite(b) && b > a)) throw new Error(`teaser: ${JSON.stringify(teaser)} must be two finite times with the end after the start`);
      this.#teaser = [a, b];
    } else this.#teaser = null;
    this.#lead = this.#teaser ? this.#teaser[1] - this.#teaser[0] : 0;
    let total = 0;
    keep.forEach((segment, i) => {
      const [start, end] = segment;
      if (!(finite(start) && finite(end) && end > start)) throw new Error(`keep[${i}]: ${JSON.stringify(segment)} must be two finite times with the end after the start`);
      const last = this.#ends.at(-1);
      if (last !== undefined && start < last) throw new Error(`keep[${i}]: ${JSON.stringify(segment)} starts before the previous segment ends (${last} s)`);
      this.#starts.push(start);
      this.#ends.push(end);
      this.#played.push(total);
      total += end - start;
    });
    this.#duration = (this.#lead + total) / this.#speed;
  }

  /** Длина финала, с. */
  get duration(): number {
    return this.#duration;
  }

  /** Длина тизера в финале, с (нет тизера — 0). */
  get teaserDuration(): number {
    return this.#lead / this.#speed;
  }

  /** Отрезки финала по порядку: [начало в исходнике, конец в исходнике, начало в финале]; тизер — первый. */
  get segments(): [number, number, number][] {
    const lead: [number, number, number][] = this.#teaser ? [[this.#teaser[0], this.#teaser[1], 0]] : [];
    return [...lead, ...this.#starts.map((s, i): [number, number, number] => [s, this.#ends[i], (this.#lead + this.#played[i]) / this.#speed])];
  }

  /** Время финала для времени исходника на его месте в ролике (после тизера); null — вырезано. Края — отрезку. */
  toFinal(t: number): number | null {
    const i = bisectRight(this.#starts, t) - 1;
    if (i < 0 || t > this.#ends[i]) return null;
    return (this.#lead + this.#played[i] + (t - this.#starts[i])) / this.#speed;
  }

  /** Время финала внутри тизера; вне тизера (или его нет) — null. */
  teaserFinal(t: number): number | null {
    if (this.#teaser === null || !(this.#teaser[0] <= t && t <= this.#teaser[1])) return null;
    return (t - this.#teaser[0]) / this.#speed;
  }

  /** Как toFinal, но вырезанное время — в начало следующего отрезка (после последнего — конец финала). */
  toFinalSnap(t: number): number {
    const final = this.toFinal(t);
    if (final !== null) return final;
    const i = bisectRight(this.#starts, t);
    return i < this.#starts.length ? (this.#lead + this.#played[i]) / this.#speed : this.#duration;
  }

  /** Как toFinalSnap, но момент не дальше `within` с исходника от края отрезка — ровно на этом краю (ближнем). */
  toCut(t: number, within = TO_CUT): number {
    const i = bisectRight(this.#starts, t) - 1;
    if (i >= 0 && t <= this.#ends[i]) {
      const head = t - this.#starts[i];
      const tail = this.#ends[i] - t;
      if (Math.min(head, tail) <= within) t = head <= tail ? this.#starts[i] : this.#ends[i];
    }
    return this.toFinalSnap(t);
  }

  /** Время исходника для времени финала (внутри тизера — по тизеру; стык — начало следующего; после конца — конец
   *  последнего отрезка). */
  toSource(t: number): number {
    let played = Math.max(0, t) * this.#speed;
    if (this.#teaser && played < this.#lead) return this.#teaser[0] + played;
    played -= this.#lead;
    const i = Math.max(0, bisectRight(this.#played, played) - 1);
    return Math.min(this.#starts[i] + (played - this.#played[i]), this.#ends[i]);
  }
}
