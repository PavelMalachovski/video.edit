// Сохранение правок руками по одному: пока идёт одно, следующее ждёт его и уходит уже от новой ревизии, а то, что уже
// лежит в ветке, второй раз не шлётся. Так «Монтировать» или «назад» во время автосохранения не ловят ложный конфликт
// (второй PUT от той же ревизии сервер отверг бы как правку из другой вкладки).

export type PutResult = { ok: true; rev: number } | { ok: false; conflict: boolean; error: string };
/** PUT правок от ревизии `base`; ответ — новая ревизия, конфликт (в ветке другая) или ошибка. */
export type Put<T> = (base: number, value: T) => Promise<PutResult>;

export class Saver<T> {
  #put: Put<T>;
  #saved: T;
  #rev: number;
  #gen = 0; // «Загрузить их» — новое начало: поздний ответ старого сохранения ничего не меняет
  #inflight: Promise<PutResult> | null = null;

  constructor(put: Put<T>, saved: T, rev: number) {
    this.#put = put;
    this.#saved = saved;
    this.#rev = rev;
  }

  /** Ревизия в ветке и то, что в ней лежит (по последнему удачному сохранению или загрузке). */
  get rev(): number {
    return this.#rev;
  }

  get saved(): T {
    return this.#saved;
  }

  /** Начать с того, что лежит в ветке (загрузка, «Загрузить их»). */
  reset(saved: T, rev: number): void {
    this.#gen++;
    this.#saved = saved;
    this.#rev = rev;
  }

  /** Сохранить `value`: дождаться идущего сохранения; уже лежит в ветке — сразу ok. Ошибка — ответом, не исключением. */
  async save(value: T): Promise<PutResult> {
    while (this.#inflight) await this.#inflight;
    if (value === this.#saved) return { ok: true, rev: this.#rev };
    const gen = this.#gen;
    const run = this.#put(this.#rev, value)
      .catch((e: unknown): PutResult => ({ ok: false, conflict: false, error: e instanceof Error ? e.message : String(e) }))
      .then((r) => {
        if (r.ok && gen === this.#gen) {
          this.#saved = value;
          this.#rev = r.rev;
        }
        return r;
      });
    this.#inflight = run;
    try {
      return await run;
    } finally {
      if (this.#inflight === run) this.#inflight = null;
    }
  }
}
