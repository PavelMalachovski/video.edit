// Пауза между опросами страницы задачи: идёт шаг — 5 с; ничего не идёт (ждём ответов, ролик готов, ошибка) — 30 с:
// задача меняется только от действия Павла (после него страница спрашивает сразу) или когда запускается шаг; GitHub
// просит подождать (429) — сколько просит, но не меньше 30 с (без подсказки — минута); другой сбой — 15 с.
export type PollResult = { ok: true; idle?: boolean } | { ok: false; status: number; retryAfter?: number };

export function nextDelay(r: PollResult): number {
  if (r.ok) return r.idle ? 30_000 : 5000;
  if (r.status === 429) return Math.max(r.retryAfter ?? 60, 30) * 1000;
  return 15_000;
}
