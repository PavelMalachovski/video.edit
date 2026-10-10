// Мелочи для страниц в браузере: JSON-запросы к своему API и текст ошибки из ответа.

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** Текст ошибки из ответа API (`{error}`), иначе `fallback` и код ответа. */
export async function errorText(r: Response, fallback: string): Promise<string> {
  const data = (await r.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === 'string' && data.error ? data.error : `${fallback} (${r.status})`;
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
