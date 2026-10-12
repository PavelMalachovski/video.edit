// Очередь загрузки кусков: несколько параллельных запросов, пауза между стартами
// (вторичные лимиты GitHub на создание ассетов), повторы с нарастающей паузой,
// минута ожидания после ответа «лимит», продолжение с уже загруженных кусков.
import { CHUNK_SIZE, chunkName, isJobId, isSourceFile, isUploadFile, isVoiceFile, videoAsset } from './jobs.ts';

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

// ---------- куски исходника и вставок ----------

/** Кусок загрузки: `index`-й кусок файла `file` (ассет `<file>.part-NNNNN`), байты `[start, end)`; `src` — номер файла. */
export type Chunk = { file: string; index: number; start: number; end: number; src: number };

/** Куски по порядку: сначала исходник (`files[0]`), потом вставки — одна очередь загрузки. */
export function planChunks(files: { asset: string; size: number }[], chunk = CHUNK_SIZE): Chunk[] {
  return files.flatMap((f, src) => Array.from({ length: Math.ceil(f.size / chunk) }, (_, index) => ({
    file: f.asset, index, start: index * chunk, end: Math.min(f.size, (index + 1) * chunk), src,
  })));
}

/** Какие куски уже в черновике: ассет есть и его размер ровно `end − start` (обрезанный дошлём заново). */
export function resumeDone(chunks: Chunk[], existing: { name: string; size: number }[]): Set<number> {
  const sizes = new Map(existing.map((a) => [a.name, a.size]));
  return new Set(chunks.flatMap((c, i) => (sizes.get(chunkName(c.file, c.index)) === c.end - c.start ? [i] : [])));
}

// ---------- незаконченная загрузка (localStorage['vm:pending']) ----------

export type PendingInsert = { asset: string; name: string; size: number; type: string; lastModified: number };
export type Pending = {
  jobId: string; releaseId: number; source: { name: string; size: number; lastModified: number };
  brief: string; duration: number | null; inserts: PendingInsert[];
  voice?: PendingInsert; // озвучка — своя запись голоса
  more?: PendingInsert[]; // ещё видео задачи по порядку: source-2, source-3…
};
type Picked = { name: string; size: number; lastModified: number };

const PENDING_KEY = 'vm:pending';
// Имя и размер до байта: iPhone отдаёт из «Фото» свежую копию, и время изменения у неё — момент выбора.
const same = (a: Picked, b: Picked): boolean => a.name === b.name && a.size === b.size;

/**
 * Те же ли видео выбраны снова (имя и размер; все, в любом порядке, и ни одного лишнего) и какие вставки выбраны
 * заново: `videos` и `inserts` — ассет → файл; `voice` — озвучка, если выбрана та же. Невыбранные заново вставки и
 * озвучка выпадают — их имена в `dropped`.
 */
export function matchPending<F extends Picked>(p: Pending, sources: F | F[], inserts: F[], voice: F | null = null): {
  ok: boolean; videos: Map<string, F>; inserts: Map<string, F>; voice: F | null; dropped: string[];
} {
  const picked = Array.isArray(sources) ? sources : [sources];
  const videos = new Map<string, F>();
  for (const want of [{ asset: 'source', ...p.source }, ...(p.more ?? [])]) {
    const f = picked.find((x) => same(x, want) && ![...videos.values()].includes(x));
    if (f) videos.set(want.asset, f);
  }
  const all = videos.size === 1 + (p.more?.length ?? 0) && picked.length === videos.size;
  const found = new Map<string, F>();
  const dropped: string[] = [];
  for (const want of p.inserts) {
    const f = inserts.find((x) => same(x, want));
    if (f) found.set(want.asset, f);
    else dropped.push(want.name);
  }
  const again = p.voice && voice && same(voice, p.voice) ? voice : null;
  if (p.voice && !again) dropped.push(p.voice.name);
  return { ok: all, videos, inserts: found, voice: again, dropped };
}

/** Тот же ли выбор, с которым загрузка остановилась: вставки и озвучка (и видео, если дан их список, — в том же порядке:
 *  склеятся по нему) — те же файлы. Нет — Pending собирается заново (как после перезагрузки страницы), иначе ушли бы
 *  убранная запись, прежние вставки или прежний порядок видео. */
export function sameSelection(files: Map<string, File>, inserts: File[], voice: File | null, sources?: File[]): boolean {
  const picked = new Set<File>([...inserts, ...(voice ? [voice] : [])]);
  const sent = [...files].filter(([key]) => !isSourceFile(key)).map(([, f]) => f);
  const videos = [...files].filter(([key]) => isSourceFile(key)).map(([, f]) => f);
  const sameVideos = !sources || (videos.length === sources.length && sources.every((f, k) => files.get(videoAsset(k)) === f));
  return sameVideos && sent.length === picked.size && sent.every((f) => picked.has(f));
}

const isPending = (x: unknown): x is Pending => {
  const p = x as Pending;
  return typeof p === 'object' && p !== null && typeof p.jobId === 'string' && isJobId(p.jobId) && Number.isInteger(p.releaseId)
    && typeof p.source?.name === 'string' && Number.isFinite(p.source.size) && Number.isFinite(p.source.lastModified)
    && typeof p.brief === 'string' && Array.isArray(p.inserts) && p.inserts.every((i) => typeof i?.asset === 'string' && isUploadFile(i.asset))
    && (p.voice === undefined || (typeof p.voice?.asset === 'string' && isVoiceFile(p.voice.asset)))
    && (p.more === undefined || (Array.isArray(p.more) && p.more.every((v) => typeof v?.asset === 'string' && v.asset !== 'source'
      && isSourceFile(v.asset) && typeof v.name === 'string' && typeof v.type === 'string' && Number.isFinite(v.size) && v.size > 0
      && Number.isFinite(v.lastModified))));
};

/** Незаконченная загрузка этого браузера; нет, битая или хранилище недоступно — null. */
export function loadPending(storage: Storage | null): Pending | null {
  try {
    const raw = storage?.getItem(PENDING_KEY);
    const p: unknown = raw ? JSON.parse(raw) : null;
    return isPending(p) ? p : null;
  } catch {
    return null;
  }
}

export function savePending(storage: Storage | null, p: Pending): void {
  try {
    storage?.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    // нет хранилища — продолжить после перезагрузки не выйдет, загрузка идёт и так
  }
}

export function clearPending(storage: Storage | null): void {
  try {
    storage?.removeItem(PENDING_KEY);
  } catch {
    // нечего удалять
  }
}
