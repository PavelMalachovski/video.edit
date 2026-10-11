// Подпись к посту (result.json.caption — пишет Claude на шаге render): текст на языке ролика и хэштеги без «#».
// Instagram до «ещё» показывает 72 знака первой строки — экран «Готово» выделяет их.

export type Caption = { text: string; hashtags: string[] };

export const FOLD = 72; // знаков подписи видно до «ещё» (гайд Meta «Всё о Reels», стр. 63)

/** caption из result.json → подпись; нет или не та форма — null (экран её не покажет). */
export function parseCaption(raw: unknown): Caption | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { text, hashtags } = raw as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim() || !Array.isArray(hashtags) || !hashtags.every((t) => typeof t === 'string')) return null;
  return { text, hashtags };
}

/** Что копирует кнопка: текст, пустая строка и хэштеги через пробел (хэштегов нет — только текст). */
export function captionCopy(c: Caption): string {
  const tags = c.hashtags.map((t) => `#${t.replace(/^#+/, '')}`).join(' ');
  return tags ? `${c.text}\n\n${tags}` : c.text;
}

/** Что видно до «ещё»: первые 72 знака (по символам, эмодзи — один) первой строки; остальное — `hidden`. */
export function captionFold(text: string): { shown: string; hidden: string } {
  const first = text.split('\n')[0];
  const shown = [...first].slice(0, FOLD).join('');
  return { shown, hidden: text.slice(shown.length) };
}
