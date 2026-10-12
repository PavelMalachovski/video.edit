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

// ---------- ветка и папка задачи ----------

export const jobBranch = (id: string): string => `claude/job-${id}`;
export const jobDir = (id: string): string => `jobs/${id}`;

/** Кусок загрузки: `<file>.part-NNNNN` (исходник — `source.part-NNNNN`). */
export const chunkName = (file: string, index: number): string => `${file}.part-${String(index).padStart(5, '0')}`;

// ---------- имена загрузок ----------

const TYPE_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
};

/** FNV-1a 32 бит по UTF-8: короткий ASCII-ключ для id вопроса с кириллицей (одинаков в браузере и на сервере). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Имя ассета загрузки, только ASCII (иные GitHub переименовывает): `upload-i2.mov` (вставка к ролику),
 * `upload-q-hook.png` (картинка к ответу). Расширение — из имени файла, иначе из типа, иначе `bin`.
 */
export function uploadAssetName(kind: 'i' | 'q', key: string | number, fileName: string, type: string): string {
  const fromName = /\.([a-z0-9]{1,5})$/.exec(fileName.toLowerCase())?.[1];
  const ext = fromName ?? TYPE_EXT[type] ?? 'bin';
  if (kind === 'i') return `upload-i${key}.${ext}`;
  const qid = String(key).toLowerCase();
  return `upload-q-${/^[a-z0-9_-]{1,40}$/.test(qid) ? qid : `x${fnv1a(String(key))}`}.${ext}`;
}

// ---------- озвучка ----------

/** Озвучка — своя запись голоса Павла (диктофон): `vm prepare` ставит её вместо звука видео. */
export const VOICE_EXT = ['m4a', 'mp3', 'wav', 'aac'] as const;
const VOICE_TYPES: Record<string, (typeof VOICE_EXT)[number]> = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav', 'audio/aac': 'aac', 'audio/x-aac': 'aac',
};
const extOf = (fileName: string): string => /\.([a-z0-9]{1,5})$/.exec(fileName.toLowerCase())?.[1] ?? '';
const isVoiceExt = (ext: string): ext is (typeof VOICE_EXT)[number] => (VOICE_EXT as readonly string[]).includes(ext);

/**
 * Ассет озвучки: `upload-voice.m4a`. Другая запись при продолжении загрузки — `upload-voice-2.m4a`: куски прежней
 * остались в черновике, и под тем же именем их приняли бы за готовые. Расширение — из имени, иначе из типа.
 */
export function voiceAssetName(fileName: string, type: string, n = 1): string {
  const ext = extOf(fileName);
  return `upload-voice${n > 1 ? `-${n}` : ''}.${isVoiceExt(ext) ? ext : Object.hasOwn(VOICE_TYPES, type) ? VOICE_TYPES[type] : 'm4a'}`;
}

export const isVoiceFile = (name: string): boolean => /^upload-voice(-\d{1,2})?\.(m4a|mp3|wav|aac)$/.test(name);

export const isUploadFile = (name: string): boolean => /^upload-(i\d{1,2}|q-[a-z0-9_-]{1,40})\.[a-z0-9]{1,5}$/.test(name) || isVoiceFile(name);

// ---------- видео задачи ----------

/** Видео в задаче — не больше: несколько видео `vm prepare` склеивает в один исходник по порядку. */
export const MAX_VIDEOS = 10;
/** Ассет `k`-го видео задачи (с 0): `source`, `source-2` … `source-10` (куски — `<ассет>.part-NNNNN`). */
export const videoAsset = (k: number): string => (k === 0 ? 'source' : `source-${k + 1}`);
export const isSourceFile = (name: string): boolean => /^source(-([2-9]|10))?$/.test(name);

/** Куда `vm fetch` кладёт видео задачи (от папки задачи): `in/<ассет><расширение имени>`, без расширения — `.mp4`
 *  (как `Path(name).suffix.lower()` в engine/vm/fetch.py). */
export function videoFile(asset: string, name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return `in/${asset}${/^.+(\.[^.]+)$/.exec(base)?.[1]?.toLowerCase() ?? '.mp4'}`;
}

/** Видео задачи, как его шлёт страница в конце загрузки (`videos` в /complete, потом в manifest.json). */
export type VideoClaim = { asset: string; name: string; size: number; type: string; lastModified: number; parts: number; duration: number | null };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => Number.isInteger(x);

/** Список видео от страницы: нет — одно видео, как раньше; есть — от двух до MAX_VIDEOS по порядку source, source-2…,
 *  первое — то же, что в запросе сверху (`top`), у каждого — размер (checkSource) и кусков по размеру. Не так — `error`. */
export function checkVideos(videos: unknown, top: { name: string; size: number; parts: number }): { videos: VideoClaim[] | null } | { error: string } {
  if (videos === undefined) return { videos: null };
  if (!Array.isArray(videos) || videos.length < 2 || videos.length > MAX_VIDEOS) return { error: `Видео — списком от 2 до ${MAX_VIDEOS}` };
  const out: VideoClaim[] = [];
  for (const [k, v] of videos.entries()) {
    const duration = isRecord(v) ? v.duration ?? null : null;
    if (!isRecord(v) || v.asset !== videoAsset(k) || typeof v.name !== 'string' || !v.name || typeof v.type !== 'string'
      || !isInt(v.size) || !Number.isFinite(v.lastModified) || !isInt(v.parts) || v.parts !== partsOf(v.size)
      || !(duration === null || (typeof duration === 'number' && Number.isFinite(duration) && duration > 0))) {
      return { error: `Видео ${k + 1}: не такое, как шлёт страница` };
    }
    const why = checkSource(v.size);
    if (why) return { error: `${v.name}: ${why}` };
    out.push({ asset: v.asset, name: v.name, size: v.size, type: v.type, lastModified: v.lastModified as number, parts: v.parts, duration });
  }
  if (out[0].name !== top.name || out[0].size !== top.size || out[0].parts !== top.parts) return { error: 'Первое видео — не то, что в запросе' };
  return { videos: out };
}

// ---------- пределы ----------

export const MAX_SOURCE_BYTES = 3 * 1024 ** 3;
export const MAX_INSERT_BYTES = 200 * 1024 ** 2;
export const MAX_VOICE_BYTES = 200 * 1024 ** 2;
export const MAX_INSERTS = 10;
export const MAX_UPLOAD_PARTS = 900; // у GitHub не больше 1000 ассетов в релизе; остаток — манифест, ответы, ролики
export const MAX_ANSWER_IMAGE_BYTES = 20 * 1024 ** 2;
export const MAX_BRIEF = 4000;
export const MAX_NOTE = 2000;
export const LONG_VIDEO_SEC = 300;
export const INSERT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime'] as const;

export const partsOf = (size: number): number => Math.max(1, Math.ceil(size / CHUNK_SIZE));

export function checkTotal(sourceSize: number, insertSizes: number[]): string | null {
  const parts = partsOf(sourceSize) + insertSizes.reduce((sum, size) => sum + partsOf(size), 0);
  return parts > MAX_UPLOAD_PARTS
    ? 'Видео и вставки вместе больше 3,5 ГБ — в одну задачу столько не войдёт. Уберите часть вставок или обрежьте видео.'
    : null;
}

export function checkSource(size: number): string | null {
  if (size <= 0) return 'Файл пустой — выберите другое видео.';
  return size > MAX_SOURCE_BYTES ? 'Файл больше 3 ГБ — столько GitHub не примет. Обрежьте видео.' : null;
}

/** Видео задачи по размерам: каждое — как одно видео (checkSource), вместе — до 3 ГБ, не больше MAX_VIDEOS. */
export function checkSources(sizes: number[]): string | null {
  if (sizes.length > MAX_VIDEOS) return `Не больше ${MAX_VIDEOS} видео в одной задаче — уберите лишние.`;
  for (const size of sizes) {
    const why = checkSource(size);
    if (why) return why;
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return sizes.length > 1 && total > MAX_SOURCE_BYTES ? 'Видео вместе больше 3 ГБ — в одну задачу столько не войдёт. Уберите часть видео.' : null;
}

export function checkInsert(f: { name: string; size: number; type: string }): string | null {
  if (/\.(heic|heif)$/i.test(f.name) || /^image\/hei[cf]/.test(f.type)) return `${f.name}: HEIC не подходит — сохраните как JPEG или PNG.`;
  if (f.size <= 0) return `${f.name}: пустой файл`;
  if (f.size > MAX_INSERT_BYTES) return `${f.name}: больше 200 МБ`;
  if (!(INSERT_TYPES as readonly string[]).includes(f.type)) return `${f.name}: такой тип не подходит (нужны PNG, JPEG, WebP, GIF, MP4 или MOV)`;
  return null;
}

/** Озвучка: запись голоса M4A, MP3, WAV или AAC (по расширению или типу — браузер знает его не всегда), до 200 МБ. */
export function checkVoice(f: { name: string; size: number; type: string }): string | null {
  if (f.size <= 0) return `${f.name}: пустой файл`;
  if (f.size > MAX_VOICE_BYTES) return `${f.name}: больше 200 МБ`;
  if (!isVoiceExt(extOf(f.name)) && !Object.hasOwn(VOICE_TYPES, f.type)) return `${f.name}: нужна запись голоса — M4A, MP3, WAV или AAC`;
  return null;
}

/**
 * Каких кусков `<file>.part-NNNNN` из `parts` нет среди ассетов и сколько байт в тех, что есть. Файл цел, когда
 * `missing` пуст и `total === size`.
 */
export function verifyParts(assets: { name: string; size: number }[], file: string, parts: number, size: number): { missing: number[]; total: number } {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const missing: number[] = [];
  let total = 0;
  for (let i = 0; i < parts; i++) {
    const a = byName.get(chunkName(file, i));
    if (!a) missing.push(i);
    else total += a.size;
  }
  return { missing, total };
}

// ---------- пути и картинки ----------

/**
 * Путь от папки задачи (как его пишет сессия: `frame.png`, `../../assets/logos/a.png`) → путь в репозитории.
 * Только внутри `jobs/<id>/` или `assets/`; `\`, абсолютный путь или выход наружу — null.
 */
export function resolveJobPath(id: string, rel: string): string | null {
  if (!rel || rel.includes('\\') || rel.startsWith('/') || /^[a-z]+:/i.test(rel)) return null;
  const stack = ['jobs', id];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!stack.length) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  const inJob = stack[0] === 'jobs' && stack[1] === id && stack.length > 2;
  const inAssets = stack[0] === 'assets' && stack.length > 1;
  return inJob || inAssets ? stack.join('/') : null;
}

/** Путь без `.` и `..` от корня; выход выше корня, `\\`, абсолютный путь или адрес — null. */
function normalized(rel: string): string[] | null {
  if (!rel || rel.includes('\\') || rel.startsWith('/') || /^[a-z]+:/i.test(rel)) return null;
  const stack: string[] = [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') stack.push(part);
    else if (!stack.pop()) return null;
  }
  return stack.length ? stack : null;
}

/**
 * Где искать звук из edit.json (музыка, звуки появления) — как `_resolve` движка: от папки задачи, не выходя из неё,
 * потом от корня репозитория — но страница отдаёт оттуда только `assets/`. Нечего искать — [].
 */
export function audioPaths(id: string, rel: string): string[] {
  const parts = normalized(rel);
  if (!parts) return [];
  const root = parts[0] === 'assets' && parts.length > 1 ? [parts.join('/')] : [];
  return [`jobs/${id}/${parts.join('/')}`, ...root];
}

const AUDIO: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
};

/** Тип звука, который можно отдать редактору: те же расширения, что SOUNDS движка (render.py). */
export function audioType(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext ? AUDIO[ext] ?? null : null;
}

/** Тип картинки, которую можно отдать странице (только растровые: SVG и HTML — нет). */
export function imageType(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/.exec(path.toLowerCase())?.[1];
  return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : null;
}

