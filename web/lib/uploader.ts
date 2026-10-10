// Очередь загрузки кусков: несколько параллельных запросов, пауза между стартами
// (вторичные лимиты GitHub на создание ассетов), повторы с нарастающей паузой,
// минута ожидания после ответа «лимит», продолжение с уже загруженных кусков.
export type PutResult = { ok: true } | { ok: false; status: number };

export type UploadOptions = {
  parts: number;
  put: (index: number) => Promise<PutResult>;
  done?: Set<number>;
  concurrency?: number;
  minGapMs?: number;
  maxRetries?: number;
  rateLimitWaitMs?: number;
  onProgress?: (doneCount: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export async function runUpload(o: UploadOptions): Promise<{ retries: number }> {
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const done = new Set(o.done ?? []);
  const queue = Array.from({ length: o.parts }, (_, i) => i).filter((i) => !done.has(i));
  const maxRetries = o.maxRetries ?? 6;
  const gap = o.minGapMs ?? 700;
  let nextStart = now();
  let retries = 0;
  const failed: number[] = [];

  async function slot(): Promise<void> {  // занять ближайшее окно старта
    const wait = Math.max(0, nextStart - now());
    nextStart = Math.max(nextStart, now()) + gap;
    if (wait > 0) await sleep(wait);
  }

  async function worker(): Promise<void> {
    for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
      for (let attempt = 0; ; attempt++) {
        await slot();
        let r: PutResult;
        try { r = await o.put(i); } catch { r = { ok: false, status: 0 }; }
        if (r.ok) { done.add(i); o.onProgress?.(done.size); break; }
        if (attempt >= maxRetries - 1) { failed.push(i); break; }
        retries += 1;
        await sleep(r.status === 429 ? (o.rateLimitWaitMs ?? 60_000) : 1000 * 2 ** attempt);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 2) }, worker));
  if (failed.length) throw new Error(`upload failed for part ${failed.sort((a, b) => a - b).join(', ')}`);
  return { retries };
}
