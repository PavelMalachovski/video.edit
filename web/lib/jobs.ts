// Имена задач и кусков загрузки.
// Видео идёт в браузере кусками по CHUNK_SIZE через функции Vercel (лимит тела ~4,5 МБ),
// каждый кусок — отдельный ассет черновика релиза job-<id>: source.part-00000, -00001…
export const CHUNK_SIZE = 4 * 1024 * 1024;

export function newJobId(now: Date = new Date(), rand: () => number = Math.random): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = `${p(now.getUTCFullYear() % 100)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const t = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  const r = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0');
  return `${d}-${t}-${r}`;
}

export const jobTag = (id: string): string => `job-${id}`;

export const partName = (index: number): string => `source.part-${String(index).padStart(5, '0')}`;

export const chunkCount = (size: number, chunk: number = CHUNK_SIZE): number => Math.ceil(size / chunk);

export const isJobId = (s: string): boolean => /^\d{6}-\d{6}-[0-9a-z]{4}$/.test(s);
