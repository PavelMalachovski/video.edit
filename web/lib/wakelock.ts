// Экран не гаснет, пока идёт загрузка (Screen Wake Lock, iOS 16.4+): заблокированный телефон останавливает страницу.
// Браузер снимает блокировку, когда страница скрыта (другое приложение, пункт управления), — вернулась на экран —
// просим снова. Нет такой возможности — ничего не делаем.
type Lock = { release(): Promise<void> };
type Nav = { wakeLock?: { request(type: 'screen'): Promise<Lock> } };
type Doc = { visibilityState: DocumentVisibilityState; addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void };

/** Держать экран включённым до вызова возвращённой функции. */
export function keepScreenOn(nav: Nav, doc: Doc): () => void {
  let lock: Lock | null = null;
  let on = true;
  const take = async () => {
    if (!on || doc.visibilityState !== 'visible' || !nav.wakeLock) return;
    try {
      const got = await nav.wakeLock.request('screen');
      if (on) lock = got;
      else void got.release().catch(() => undefined);
    } catch {
      // отказ (энергосбережение) — грузим и так
    }
  };
  const onVisible = () => {
    if (doc.visibilityState === 'visible') void take();
  };
  doc.addEventListener('visibilitychange', onVisible);
  void take();
  return () => {
    on = false;
    doc.removeEventListener('visibilitychange', onVisible);
    void lock?.release().catch(() => undefined);
    lock = null;
  };
}
