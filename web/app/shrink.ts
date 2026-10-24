// Уменьшение видео в браузере перед загрузкой (решения — lib/shrink.ts): mediabunny читает MOV/MP4, WebCodecs
// декодируют (HEVC с iPhone — видеокартой) и кодируют H.264 (нет его кодировщика — VP9), звук копируется как был. Результат пишется в хранилище
// браузера (OPFS): большой файл не держим в памяти, и после перезагрузки страницы «Продолжить загрузку» берёт ту же
// копию. Нет записи в OPFS (Safari до 26, приватный режим) — копия в памяти, но не больше MAX_IN_MEMORY. Библиотека грузится только здесь (динамический import), не на каждой странице.
import {
  fitsMemory, pickCodec, SHRINK_BITRATE, SHRINK_CODECS, SHRINK_FPS, shrinkKey, shrinkSize, stuck, tooSlow, whyOriginal,
} from '@/lib/shrink.ts';

// original — почему ушёл оригинал; quiet — так и задумано (выбран оригинал, видео и так не больше 1080): не о чем говорить
export type Shrunk = { file: File } | { original: string; quiet?: boolean };

type Options = {
  asked: boolean; // галочка «загрузить оригинал»
  onProgress?: (done: number) => void; // доля 0…1
  expect?: number; // размер копии из незаконченной загрузки: есть такая в OPFS — берём её, не уменьшая заново
};

async function opfs(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await navigator.storage?.getDirectory?.()) ?? null;
  } catch {
    return null; // приватный режим, запрет сайта
  }
}

/** Готовая копия из прошлой попытки: есть и ровно `expect` байт. */
async function kept(key: string, expect: number | undefined): Promise<File | null> {
  if (!expect) return null;
  try {
    const file = await (await (await opfs())?.getFileHandle(key))?.getFile();
    return file && file.size === expect ? file : null;
  } catch {
    return null;
  }
}

/** Уменьшить видео `f` для загрузки — или сказать, почему уходит оригинал. Не бросает: любой сбой — оригинал. */
export async function shrinkVideo(f: File, o: Options): Promise<Shrunk> {
  const key = shrinkKey(f);
  const ready = await kept(key, o.expect);
  if (ready) return { file: new File([ready], f.name, { type: 'video/mp4', lastModified: f.lastModified }) };
  if (o.asked) return { original: 'выбран оригинал', quiet: true };
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return { original: 'браузер не умеет сжимать видео' };
  let mb: typeof import('mediabunny');
  try {
    mb = await import('mediabunny');
  } catch {
    return { original: 'не загрузился модуль сжатия' };
  }
  const input = new mb.Input({ source: new mb.BlobSource(f), formats: mb.ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) return { original: 'браузер не читает это видео' };
    const size = shrinkSize(video.displayWidth, video.displayHeight);
    const able = size ? await Promise.all(SHRINK_CODECS.map(async (c) =>
      ((await mb.canEncodeVideo(c, { width: size.width, height: size.height, bitrate: SHRINK_BITRATE })) ? [c] : []))) : [];
    const codec = pickCodec(able.flat());
    const why = whyOriginal({
      asked: false, size, encodable: !!codec,
      hdr: await video.hasHighDynamicRange(),
      decodable: await video.canDecode(),
    });
    if (why || !size || !codec) return { original: why ?? 'видео не больше 1080 по ширине', quiet: !size };
    const seconds = await input.computeDuration();

    const dir = await opfs();
    const handle = dir ? await dir.getFileHandle(key, { create: true }).catch(() => null) : null;
    const writable = handle && 'createWritable' in handle ? await handle.createWritable().catch(() => null) : null;
    // любой отказ ниже — недоделанная копия не остаётся в хранилище браузера (оно не бесконечно)
    const give = async (original: string): Promise<Shrunk> => {
      await writable?.abort().catch(() => undefined);
      await dir?.removeEntry(key).catch(() => undefined);
      return { original };
    };
    if (!writable && !fitsMemory(seconds)) return give('длинное видео, а браузер не даёт сохранить копию — в памяти не поместится');
    try {
      const target = writable ? new mb.StreamTarget(writable, { chunked: true }) : new mb.BufferTarget();
      const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
      const conversion = await mb.Conversion.init({
        input, output, showWarnings: false,
        video: { ...size, fit: 'contain', frameRate: SHRINK_FPS, codec, bitrate: SHRINK_BITRATE, allowTransformationMetadata: false },
      });
      // звук не потерять: дорожку, которую нельзя скопировать или пережать, библиотека выбросила бы молча
      if (!conversion.isValid || conversion.discardedTracks.some((d) => d.track.type === 'audio' || d.track.type === 'video')) {
        return give('браузер не может пересобрать это видео');
      }
      // скорость и зависание судим по часам, а не только по событиям прогресса: встал декодер — событий нет вовсе
      const started = performance.now();
      let done = 0;
      let moved = started;
      let stop: 'slow' | 'stuck' | null = null;
      conversion.onProgress = (x) => {
        if (x > done) moved = performance.now();
        done = x;
        o.onProgress?.(x);
      };
      // решили бросить — не ждём, пока кодировщик доведёт очередь кадров (программный VP9 может довольно долго)
      let quit = () => {};
      const quitting = new Promise<never>((_, reject) => { quit = () => reject(new Error('остановлено')); });
      const watch = setInterval(() => {
        const now = performance.now();
        stop ??= stuck((now - moved) / 1000) ? 'stuck'
          : tooSlow({ elapsed: (now - started) / 1000, progress: done, originalBytes: f.size, seconds }) ? 'slow' : null;
        if (stop) {
          void conversion.cancel().catch(() => undefined);
          quit();
        }
      }, 1000);
      try {
        const running = conversion.execute();
        running.catch(() => undefined); // брошенное сжатие кончится отменой — её ошибку не ждём
        await Promise.race([running, quitting]);
      } catch (e) {
        return give(stop === 'slow' ? 'сжатие медленнее загрузки оригинала' : stop === 'stuck' ? 'сжатие зависло'
          : `сжать не вышло (${e instanceof Error ? e.message : String(e)})`);
      } finally {
        clearInterval(watch);
      }
      const data = writable ? await handle!.getFile() : new Blob([(target as InstanceType<typeof mb.BufferTarget>).buffer!]);
      if (!writable) await dir?.removeEntry(key).catch(() => undefined); // пустой файл, созданный зря
      return { file: new File([data], f.name, { type: 'video/mp4', lastModified: f.lastModified }) };
    } catch (e) {
      return give(`сжать не вышло (${e instanceof Error ? e.message : String(e)})`);
    }
  } catch (e) {
    return { original: `сжать не вышло (${e instanceof Error ? e.message : String(e)})` };
  } finally {
    input.dispose?.();
  }
}

/** Убрать уменьшенные копии из хранилища браузера: загрузка кончилась или её забыли. */
export async function dropShrunk(files: { name: string; size: number }[]): Promise<void> {
  const dir = await opfs();
  await Promise.all(files.map((f) => dir?.removeEntry(shrinkKey(f)).catch(() => undefined)));
}
