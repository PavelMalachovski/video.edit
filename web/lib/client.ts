// Мелочи для страниц в браузере: JSON-запросы к своему API и текст ошибки из ответа.

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** Vercel поставил сайт на паузу (бесплатный лимит трафика исчерпан): на любой запрос — 402 и своя HTML-страница. */
export const PAUSED = 'Vercel поставил сайт на паузу: закончился бесплатный лимит трафика. Пока его не включат (тариф Pro или новый месяц), ничего не сохранится — правки останутся в этой вкладке';

/** Код ответа словами: 402 — пауза Vercel, остальное — `fallback` и код. */
export const statusText = (status: number, fallback: string): string => (status === 402 ? PAUSED : `${fallback} (${status})`);

/** Текст ошибки из ответа API (`{error}`), иначе `fallback` и код ответа (402 — пауза Vercel). */
export async function errorText(r: Response, fallback: string): Promise<string> {
  if (r.status === 402) return PAUSED;
  const data = (await r.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === 'string' && data.error ? data.error : statusText(r.status, fallback);
}

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** localStorage, если браузер его даёт (в приватном режиме Safari доступ может бросить). */
export function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
