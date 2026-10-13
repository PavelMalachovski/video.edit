// Бренд-кит Павла («Мой бренд»): ник, цвета, шрифты, логотип, подпись к постам и хэштеги. Хранится в своей ветке
// claude/brand (brand/brand.json и brand/logo.<ext>) — пишет её страница тем же токеном, без force. Задача при старте
// получает копию: job.json.brand и логотип в in/brand/ (тот же blob git) — сессия монтажа читает только свою ветку.
import { commitFiles, listDir, readText, type FileMap } from './branch.ts';
import type { GH } from './github.ts';
import { parseStyle, type StyleChoice } from './jobfiles.ts';
import { DEFAULT_MUSIC_DB } from './sound.ts';
import { SPEEDS } from './style.ts';

export const BRAND_BRANCH = 'claude/brand';
export const BRAND_DIR = 'brand';
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_SIGNATURE = 300;
export const MAX_HASHTAGS = 10;
const LOGO_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export type BrandColors = { text: string; accent: string; bar: string };
/**
 * «Мой стиль» — как смонтирован ролик, который Павел сохранил в бренд: стиль (вариант, шрифты, цвета, места, размеры, вид
 * субтитров, хука и шкалы — как `answers.json.style`), скорость, затемнение фона (%, как ползунок вопроса «Фон») и
 * трек из `assets/music` с громкостью (null — без музыки). Новые задачи начинают с него: превью — этим стилем и
 * скоростью, вопросы «Фон» и «Музыка» — этими ответами. `from` — из какого ролика.
 */
export type BrandLook = {
  style: StyleChoice; speed?: number; dim: number; music: { file: string; gainDb?: number } | null;
  from: { job: string; title: string; at: string };
};
/** `logo` — имя файла в brand/ (в копии задачи — путь от папки задачи: in/brand/logo.png). `look` — «Мой стиль» (нет —
 *  поля нет): форма «Мой бренд» его не трогает, его сохраняет и убирает `saveLook`. */
export type Brand = {
  handle: string | null; colors: BrandColors | null; font: string | null; hand: string | null; logo: string | null;
  signature: string | null; hashtags: string[]; look?: BrandLook;
};
export const EMPTY_BRAND: Brand = { handle: null, colors: null, font: null, hand: null, logo: null, signature: null, hashtags: [] };
export type LogoUpload = { type: string; base64: string };

const HANDLE = /^@?[A-Za-z0-9._]{1,30}$/; // как у Instagram: латиница, цифры, точка, подчёркивание, до 30
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const FONT = /^[\p{L}\p{N} _.&()-]{1,40}$/u; // id шрифта: встроенный (montserrat) или свой (имя файла: Druk Wide)
const TAG = /^[\p{L}\p{N}_]{1,40}$/u;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** То, что ввёл Павел, → бренд; что-то не так — `error` по-русски. Пустые поля — null (хэштегов — пустой список). */
export function parseBrand(input: Record<string, unknown>): { brand: Brand } | { error: string } {
  const handle = text(input.handle);
  if (handle && !HANDLE.test(handle)) return { error: 'Ник — как в Instagram: латиница, цифры, точка и «_», до 30 знаков' };
  let colors: BrandColors | null = null;
  if (input.colors) {
    const c = input.colors as Record<string, unknown>;
    const keys = ['text', 'accent', 'bar'] as const;
    if (keys.some((k) => !COLOR.test(text(c[k])))) return { error: 'Цвета — в виде #RRGGBB' };
    colors = { text: text(c.text).toUpperCase(), accent: text(c.accent).toUpperCase(), bar: text(c.bar).toUpperCase() };
  }
  const font = text(input.font);
  const hand = text(input.hand);
  if ((font && !FONT.test(font)) || (hand && !FONT.test(hand))) return { error: 'Такого шрифта нет' };
  const signature = text(input.signature);
  if (signature.length > MAX_SIGNATURE) return { error: `Подпись к постам — до ${MAX_SIGNATURE} знаков` };
  const raw = Array.isArray(input.hashtags) ? input.hashtags.map(text) : text(input.hashtags).split(/[\s,]+/);
  const tags = [...new Set(raw.map((t) => t.replace(/^#+/, '')).filter(Boolean))];
  if (tags.some((t) => !TAG.test(t))) return { error: 'Хэштег — одно слово из букв, цифр и «_»' };
  if (tags.length > MAX_HASHTAGS) return { error: `Хэштегов — не больше ${MAX_HASHTAGS}` };
  return {
    brand: {
      handle: handle ? `@${handle.replace(/^@/, '')}` : null, colors, font: font || null, hand: hand || null, logo: null,
      signature: signature || null, hashtags: tags,
    },
  };
}

/** Логотип годится: PNG, JPEG или WebP до 2 МБ, и байты — правда такая картинка. Иначе — текст ошибки. */
export function checkLogo(logo: LogoUpload): string | null {
  if (!LOGO_EXT[logo.type]) return 'Логотип — PNG, JPEG или WebP';
  const bytes = Buffer.from(logo.base64, 'base64');
  if (bytes.length > MAX_LOGO_BYTES) return 'Логотип больше 2 МБ — уменьшите его';
  const head = bytes.subarray(0, 12);
  const real = logo.type === 'image/png' ? head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : logo.type === 'image/jpeg' ? head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
      : head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
  return real ? null : 'Файл логотипа — не картинка (или повреждён)';
}

const TRACK = /^[^/\\]+\.(mp3|wav|m4a|aac|ogg|flac)$/i; // трек библиотеки assets/music — только имя файла
const DIM_STEP = 5; // %, как ползунок вопроса «Фон» (answers.ts, DIM)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** «Мой стиль» из brand.json — только такой, какой пишет сама страница; иначе null. */
export function parseLook(raw: unknown): BrandLook | null {
  if (!isObj(raw) || !isObj(raw.from)) return null;
  const style = parseStyle(raw.style);
  if (typeof style === 'string') return null;
  const { speed, dim, music, from } = raw;
  if (speed !== undefined && !(isNum(speed) && SPEEDS.includes(speed))) return null;
  if (!(isNum(dim) && dim >= 0 && dim <= 80 && dim % DIM_STEP === 0)) return null;
  if (music !== null && !(isObj(music) && typeof music.file === 'string' && TRACK.test(music.file)
    && (music.gainDb === undefined || (isNum(music.gainDb) && music.gainDb >= -40 && music.gainDb <= 0)))) return null;
  if (![from.job, from.title, from.at].every((x) => typeof x === 'string' && x.length <= 200)) return null;
  const track = music === null ? null : { file: music.file as string, ...(isNum(music.gainDb) ? { gainDb: music.gainDb } : {}) };
  return { style, ...(speed !== undefined ? { speed } : {}), dim, music: track, from: { job: from.job as string, title: from.title as string, at: from.at as string } };
}

/**
 * «Мой стиль» смонтированного ролика: стиль — из answers.json; скорость, затемнение и музыка — какими их собрал движок
 * (edits.apply: edit.json, поверх — правки руками из timeline.json; нет поля dim — без затемнения, `music: null` — без
 * музыки, заглушённый трек — тоже). edit.json ещё нет — по ответам («Фон», «Музыка», скорость превью). Стиля нет — null.
 */
export function lookFromJob(files: { answers: Record<string, unknown> | null; edit: Record<string, unknown> | null;
  timeline: Record<string, unknown> | null }, from: BrandLook['from']): BrandLook | null {
  const style = parseStyle(files.answers?.style);
  if (typeof style === 'string') return null;
  const { edit } = files;
  const hand = files.timeline ?? {};
  const said = isObj(files.answers?.answers) ? files.answers.answers : {}; // ответы на вопросы — пока монтажа не было
  const rawSpeed = isNum(hand.speed) ? hand.speed : edit ? edit.speed : files.answers?.speed;
  const speed = isNum(rawSpeed) ? SPEEDS.reduce((a, b) => (Math.abs(b - rawSpeed) < Math.abs(a - rawSpeed) ? b : a)) : undefined;
  const rawDim = isNum(hand.dim) ? hand.dim
    : edit ? (isNum(edit.dim) ? edit.dim : 0) : typeof said.dim === 'string' && /^\d+$/.test(said.dim) ? Number(said.dim) / 100 : 0;
  const dim = Math.min(80, Math.max(0, Math.round((rawDim * 100) / DIM_STEP) * DIM_STEP));
  const rawMusic = edit ? montagedMusic(isObj(edit.music) ? edit.music : null, hand.music)
    : typeof said.music === 'string' && said.music !== 'none' ? { file: said.music } : null;
  const file = rawMusic && typeof rawMusic.file === 'string' ? rawMusic.file.replace(/^assets\/music\//, '') : null;
  const music = file && TRACK.test(file)
    ? { file, ...(rawMusic && isNum(rawMusic.gainDb) ? { gainDb: Math.min(0, Math.max(-40, rawMusic.gainDb)) } : {}) } : null;
  return parseLook({ style, ...(speed !== undefined ? { speed } : {}), dim, music, from });
}

/** Музыка ролика, как её собирает движок (edits.apply): правка руками (timeline.json → music) поверх музыки монтажа;
 *  трек руками к ролику без музыки — с громкостью по умолчанию; заглушённая — без музыки. */
function montagedMusic(base: Record<string, unknown> | null, hand: unknown): Record<string, unknown> | null {
  if (!isObj(hand)) return base;
  if (hand.muted === true) return null;
  const from = base ?? (typeof hand.file === 'string' ? { file: hand.file, gainDb: DEFAULT_MUSIC_DB } : null);
  if (!from) return null;
  return { ...from, ...(typeof hand.file === 'string' ? { file: hand.file } : {}), ...(isNum(hand.gainDb) ? { gainDb: hand.gainDb } : {}) };
}

const SUB_MODES: Record<string, string> = { karaoke: 'караоке', plate: 'на плашке', word: 'по слову', accumulate: 'копятся', soft: 'мягкие' };
const HOOK_MODES: Record<string, string> = { plate: 'на плашке', outline: 'контуром', shadow: 'с тенью', accent: 'лесенкой' };

/** «Мой стиль» словами — для «Мой бренд»: что в нём сохранено (поле не задано — как в варианте); `font` — имя шрифта
 *  по его id (на странице — из fonts.json шаблона). */
export function lookLines(look: BrandLook, font: (id: string) => string = (id) => id): string[] {
  const st = look.style;
  const at = (size?: number, y?: number) => [size ? `${size} px` : '', y ? `на высоте ${y}` : ''].filter(Boolean).join(' ');
  const sub = [at(st.subSize, st.subY), st.subMode ? SUB_MODES[st.subMode] : '', st.subWords ? `по ${st.subWords} слова` : ''].filter(Boolean).join(', ');
  const hook = [at(st.hookSize, st.hookY), st.hookMode ? HOOK_MODES[st.hookMode] : ''].filter(Boolean).join(', ');
  return [
    `Вариант ${st.variant}: шрифт ${font(st.font)}, рукописный ${font(st.hand)}`,
    `Цвета: текст ${st.colors.text}, подсветка ${st.colors.accent}, шкала ${st.colors.bar}`,
    ...(sub ? [`Субтитры: ${sub}`] : []),
    ...(hook ? [`Хук: ${hook}`] : []),
    ...(st.barPos || st.barHeight ? [`Шкала: ${st.barPos === 'top' ? 'сверху' : 'снизу'}${st.barHeight ? `, ${st.barHeight} px` : ''}`] : []),
    ...(look.speed ? [`Скорость ×${String(look.speed).replace('.', ',')}`] : []),
    look.dim ? `Фон темнее на ${look.dim} %` : 'Фон — как есть',
    look.music ? `Музыка: ${look.music.file}${look.music.gainDb !== undefined ? ` (${look.music.gainDb} дБ)` : ''}` : 'Без музыки',
  ];
}

/** Сохранить «Мой стиль» (null — убрать) одним коммитом; остальной бренд и логотип — как были. */
export async function saveLook(gh: GH, look: BrandLook | null): Promise<void> {
  await commitFiles(gh, BRAND_BRANCH, async (head) => {
    const raw = await readText(gh, head, `${BRAND_DIR}/brand.json`); // на голове, поверх которой коммит
    const { look: _old, ...brand } = { ...EMPTY_BRAND, ...(raw ? (JSON.parse(raw) as Partial<Brand>) : {}) };
    return { [`${BRAND_DIR}/brand.json`]: `${JSON.stringify(look ? { ...brand, look } : brand, null, 2)}\n` };
  }, look ? 'web: мой стиль' : 'web: мой стиль убран', { base: 'master' });
}

/** Бренд из его ветки и sha логотипа; ветки или файла нет — null. */
export async function readBrand(gh: GH): Promise<{ brand: Brand; logoSha: string | null } | null> {
  const raw = await readText(gh, BRAND_BRANCH, `${BRAND_DIR}/brand.json`);
  if (raw === null) return null;
  const { look: rawLook, ...rest } = { ...EMPTY_BRAND, ...(JSON.parse(raw) as Partial<Brand>) };
  const look = parseLook(rawLook);
  const brand: Brand = look ? { ...rest, look } : rest;
  const entry = brand.logo ? (await listDir(gh, BRAND_BRANCH, BRAND_DIR))?.find((e) => e.name === brand.logo) : undefined;
  return { brand: entry ? brand : { ...brand, logo: null }, logoSha: entry?.sha ?? null };
}

/** Сохранить бренд одним коммитом. `logo`: новый файл; `undefined` — оставить прежний; `null` — убрать. */
export async function saveBrand(gh: GH, brand: Brand, logo: LogoUpload | null | undefined): Promise<Brand> {
  const before = await readBrand(gh);
  const old = before?.brand.logo ?? null;
  const files: FileMap = {};
  let name = logo === undefined ? old : null;
  if (logo) {
    const why = checkLogo(logo);
    if (why) throw new Error(why);
    name = `logo.${LOGO_EXT[logo.type]}`;
    files[`${BRAND_DIR}/${name}`] = { base64: logo.base64 };
  }
  if (old && old !== name) files[`${BRAND_DIR}/${old}`] = null;
  const look = brand.look ?? before?.brand.look; // форма бренда «Мой стиль» не присылает — он остаётся
  const saved = { ...brand, logo: name, ...(look ? { look } : {}) };
  files[`${BRAND_DIR}/brand.json`] = `${JSON.stringify(saved, null, 2)}\n`;
  await commitFiles(gh, BRAND_BRANCH, files, 'web: бренд', { base: 'master' });
  return saved;
}

/** Копия бренда для новой задачи: бренд с путём логотипа от папки задачи и файлы для её коммита; бренда нет — null. */
export async function brandForJob(gh: GH): Promise<{ brand: Brand; files: FileMap } | null> {
  const found = await readBrand(gh);
  if (!found) return null;
  const { brand, logoSha } = found;
  if (!brand.logo || !logoSha) return { brand: { ...brand, logo: null }, files: {} };
  const path = `in/brand/${brand.logo}`;
  return { brand: { ...brand, logo: path }, files: { [path]: { sha: logoSha } } };
}
