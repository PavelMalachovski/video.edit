// Бренд-кит Павла («Мой бренд»): ник, цвета, шрифты, логотип, подпись к постам и хэштеги. Хранится в своей ветке
// claude/brand (brand/brand.json и brand/logo.<ext>) — пишет её страница тем же токеном, без force. Задача при старте
// получает копию: job.json.brand и логотип в in/brand/ (тот же blob git) — сессия монтажа читает только свою ветку.
import { commitFiles, listDir, readText, type FileMap } from './branch.ts';
import type { GH } from './github.ts';

export const BRAND_BRANCH = 'claude/brand';
export const BRAND_DIR = 'brand';
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_SIGNATURE = 300;
export const MAX_HASHTAGS = 10;
const LOGO_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export type BrandColors = { text: string; accent: string; bar: string };
/** `logo` — имя файла в brand/ (в копии задачи — путь от папки задачи: in/brand/logo.png). */
export type Brand = {
  handle: string | null; colors: BrandColors | null; font: string | null; hand: string | null; logo: string | null;
  signature: string | null; hashtags: string[];
};
export const EMPTY_BRAND: Brand = { handle: null, colors: null, font: null, hand: null, logo: null, signature: null, hashtags: [] };
export type LogoUpload = { type: string; base64: string };

const HANDLE = /^@?[A-Za-z0-9._]{1,30}$/; // как у Instagram: латиница, цифры, точка, подчёркивание, до 30
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const FONT = /^[\p{L}\p{N} _-]{1,40}$/u; // id шрифта: встроенный (montserrat) или свой (имя файла: Druk Wide)
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

/** Бренд из его ветки и sha логотипа; ветки или файла нет — null. */
export async function readBrand(gh: GH): Promise<{ brand: Brand; logoSha: string | null } | null> {
  const raw = await readText(gh, BRAND_BRANCH, `${BRAND_DIR}/brand.json`);
  if (raw === null) return null;
  const brand = { ...EMPTY_BRAND, ...(JSON.parse(raw) as Partial<Brand>) };
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
  const saved = { ...brand, logo: name };
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
