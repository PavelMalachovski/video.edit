// Часы плеера редактора — момент ролика вне React: плейхед, шкала и слой кадра подписываются на них и обновляются каждый
// кадр браузера, а не перерисовывают весь редактор (useSyncExternalStore).

export type Clock = { get: () => number; set: (t: number) => void; subscribe: (listener: () => void) => () => void };

export function createClock(initial = 0): Clock {
  let now = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => now,
    set: (t) => {
      if (t === now) return;
      now = t;
      for (const f of listeners) f();
    },
    subscribe: (f) => {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
  };
}
