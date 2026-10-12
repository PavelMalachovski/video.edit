// Шкала времени: как время исходника становится временем финала — перенос `Timeline` из engine/vm/timeline.py
// (общая фикстура engine/tests/fixtures/timeline-map.json; меняются только вместе).
//
// Финал — оставленные отрезки исходника (`keep`), склеенные встык и ускоренные в `speed` раз. Тизер (`teaser`) —
// фраза из середины, которая звучит в самом начале, а потом ещё раз на своём месте: финал — тизер, затем `keep`.
// Отрезки — в порядке финала: по возрастанию (сессия) или переставленные руками (`move`). Соседние в финале отрезки,
// что и в исходнике идут друг за другом, — серия: события тянутся только по своей серии.

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
  readonly #order: number[]; // номера отрезков по порядку исходника
  readonly #sortedStarts: number[];
  readonly #run: number[] = []; // серия каждого отрезка
  readonly #runEnd = new Map<number, number>(); // серия → её последний отрезок (по финалу)

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
      this.#starts.push(start);
      this.#ends.push(end);
      this.#played.push(total);
      total += end - start;
    });
    this.#duration = (this.#lead + total) / this.#speed;
    this.#order = this.#starts.map((_, k) => k).sort((a, b) => this.#starts[a] - this.#starts[b]);
    this.#sortedStarts = this.#order.map((k) => this.#starts[k]);
    this.#order.slice(1).forEach((b, r) => {
      const a = this.#order[r];
      if (this.#starts[b] < this.#ends[a]) {
        const [i, j] = [Math.max(a, b), Math.min(a, b)];
        throw new Error(`keep[${i}]: ${JSON.stringify([this.#starts[i], this.#ends[i]])} overlaps keep[${j}]; segments must not overlap`);
      }
    });
    const rank = new Map(this.#order.map((k, r) => [k, r]));
    this.#starts.forEach((_, k) => {
      this.#run.push(k === 0 ? 0 : this.#run[k - 1] + ((rank.get(k) as number) !== (rank.get(k - 1) as number) + 1 ? 1 : 0));
      this.#runEnd.set(this.#run[k], k);
    });
  }

  /** Отрезок (номер по финалу), где лежит момент исходника `t`; края — отрезку (на стыке — следующему). */
  #at(t: number): number | null {
    const r = bisectRight(this.#sortedStarts, t) - 1;
    if (r < 0) return null;
    const k = this.#order[r];
    return t <= this.#ends[k] ? k : null;
  }

  /** Первый по исходнику отрезок, который начнётся позже `t`; нет — null. */
  #next(t: number): number | null {
    const r = bisectRight(this.#sortedStarts, t);
    return r < this.#order.length ? this.#order[r] : null;
  }

  #final(k: number, t: number): number {
    return (this.#lead + this.#played[k] + (t - this.#starts[k])) / this.#speed;
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
    const k = this.#at(t);
    return k === null ? null : this.#final(k, t);
  }

  /** Время финала внутри тизера; вне тизера (или его нет) — null. */
  teaserFinal(t: number): number | null {
    if (this.#teaser === null || !(this.#teaser[0] <= t && t <= this.#teaser[1])) return null;
    return (t - this.#teaser[0]) / this.#speed;
  }

  /** Как toFinal, но вырезанное время — в начало отрезка, что идёт за ним в исходнике (после последнего — конец
   *  финала). */
  toFinalSnap(t: number): number {
    const final = this.toFinal(t);
    if (final !== null) return final;
    const k = this.#next(t);
    return k === null ? this.#duration : this.#final(k, this.#starts[k]);
  }

  /** Как toFinalSnap, но момент не дальше `within` с исходника от края отрезка — ровно на этом краю (ближнем) там,
   *  где отрезок стоит в финале. */
  toCut(t: number, within = TO_CUT): number {
    const k = this.#at(t);
    if (k !== null) {
      const head = t - this.#starts[k];
      const tail = this.#ends[k] - t;
      if (Math.min(head, tail) <= within) return this.#final(k, head <= tail ? this.#starts[k] : this.#ends[k]);
    }
    return this.toFinalSnap(t);
  }

  /** Серия отрезка, где момент `t` (вырезанный — отрезка, что идёт за ним в исходнике); после всего — null. */
  runOf(t: number): number | null {
    const k = this.#at(t) ?? this.#next(t);
    return k === null ? null : this.#run[k];
  }

  /** Промежуток финала для промежутка исходника [t0, t1] (вставка, акцент, титр, ч/б): с места t0 и не дальше конца
   *  его серии; по порядку исходника — [toFinalSnap(t0), toFinalSnap(t1)], как всегда. `cut` — края по toCut. */
  span(t0: number, t1: number, cut = false): [number, number] {
    const place = (t: number) => (cut ? this.toCut(t) : this.toFinalSnap(t));
    const a = place(t0);
    const k = this.#at(t0) ?? this.#next(t0);
    if (k === null) return [a, a];
    const last = this.#runEnd.get(this.#run[k]) as number;
    if (t1 >= this.#ends[last]) return [a, Math.max(a, this.#final(last, this.#ends[last]))];
    return [a, Math.max(a, place(t1))];
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
