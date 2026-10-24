// Уменьшение видео в браузере перед загрузкой (решение Павла 24.10.2026): 4K с телефона → 1080 по ширине, 30 к/с,
// H.264 20 Мбит/с (нет кодировщика H.264 — VP9), звук — как был (без пережатия). Движок всё равно первым делом приводит видео к 1080×1920 30 к/с
// (`media.normalize`), так что в ролике ничего не теряется, а грузить в 4–5 раз меньше — и сессии быстрее качать.
// Оригинал идёт как есть: по галочке, HDR (перевод в SDR — дело движка, zscale), браузер не читает или не кодирует,
// и если уменьшение медленнее загрузки оригинала. Здесь — решения; само уменьшение — app/shrink.ts.

export const SHRINK_WIDTH = 1080;
export const SHRINK_FPS = 30;
export const SHRINK_BITRATE = 20_000_000; // бит/с: ~150 МБ на минуту видео; 4K с iPhone — ~650 МБ
const AUDIO_BITRATE = 192_000; // бит/с — звук копируется как был; у iPhone AAC ~192 кбит/с
export const ORIGINAL_SPEED = 3 * 1024 * 1024; // байт/с — загрузка оригинала (4 куска параллельно, задачи 23.10 — 2 МБ/с при 2)
export const JUDGE_AFTER = 10; // с — раньше скорость уменьшения не судим: первые секунды — запуск кодеков

export type Size = { width: number; height: number };

/** Размер уменьшенного видео по видимому размеру (с поворотом); уже не шире 1080 — null: уменьшать нечего. */
export function shrinkSize(width: number, height: number): Size | null {
  if (!(width > SHRINK_WIDTH) || !(height > 0)) return null;
  return { width: SHRINK_WIDTH, height: Math.max(2, Math.round((SHRINK_WIDTH * height) / width / 2) * 2) };
}

/** Почему грузим оригинал; null — уменьшаем. */
export function whyOriginal(o: { asked: boolean; hdr: boolean; decodable: boolean; encodable: boolean; size: Size | null }): string | null {
  if (o.asked) return 'выбран оригинал';
  if (!o.size) return 'видео не больше 1080 по ширине';
  if (o.hdr) return 'видео в HDR — цвета переведёт монтаж';
  if (!o.decodable) return 'браузер не читает это видео';
  if (!o.encodable) return 'браузер не умеет сжимать видео';
  return null;
}

/** Примерный размер уменьшенного видео длиной `seconds`, байт. */
export function shrunkBytes(seconds: number): number {
  return ((SHRINK_BITRATE + AUDIO_BITRATE) * seconds) / 8;
}

/** Уменьшение медленное: за `elapsed` с сделана доля `progress`; если всё уменьшение и загрузка результата дольше
 *  загрузки оригинала (`originalBytes`), выгоднее грузить оригинал. Раньше `JUDGE_AFTER` с — не судим. */
export function tooSlow(o: { elapsed: number; progress: number; originalBytes: number; seconds: number }): boolean {
  if (o.elapsed < JUDGE_AFTER || !(o.progress > 0)) return false;
  const shrinking = o.elapsed / Math.min(1, o.progress);
  return shrinking + shrunkBytes(o.seconds) / ORIGINAL_SPEED > o.originalBytes / ORIGINAL_SPEED;
}

/** Имя уменьшенной копии в хранилище браузера (OPFS): по выбранному файлу — имени и размеру, как узнаётся тот же
 *  файл при «Продолжить загрузку». */
export function shrinkKey(f: { name: string; size: number }): string {
  let h = 5381;
  for (const ch of f.name) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return `shrink-${h.toString(36)}-${f.size}.mp4`;
}

export const MAX_IN_MEMORY = 200 * 1024 * 1024; // байт — копия в памяти (нет записи в хранилище браузера): больше — iPhone выгрузит вкладку
export const STALL = 30; // с без прогресса — сжатие зависло (декодер WebCodecs встал): грузим оригинал

/** Копия видео длиной `seconds` поместится в памяти вкладки (когда браузер не даёт писать её в своё хранилище). */
export function fitsMemory(seconds: number): boolean {
  return shrunkBytes(seconds) <= MAX_IN_MEMORY;
}

/** Сжатие зависло: прогресса нет `quiet` секунд. */
export function stuck(quiet: number): boolean {
  return quiet >= STALL;
}

// Кодек копии: H.264, а нет его кодировщика (Firefox, открытая сборка Chromium) — VP9; ffmpeg движка читает оба
export const SHRINK_CODECS = ['avc', 'vp9'] as const;
export type ShrinkCodec = (typeof SHRINK_CODECS)[number];

/** Первый кодек из `SHRINK_CODECS`, который браузер умеет кодировать (`able` — какие умеет); никакой — null. */
export function pickCodec(able: readonly string[]): ShrinkCodec | null {
  return SHRINK_CODECS.find((c) => able.includes(c)) ?? null;
}
