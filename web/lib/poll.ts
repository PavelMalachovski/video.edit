// Пауза между опросами страницы задачи: обычный опрос — 5 с; GitHub просит подождать (429) — сколько просит, но не
// меньше 30 с (без подсказки — минута); другой сбой — 15 с.
export type PollResult = { ok: true } | { ok: false; status: number; retryAfter?: number };

export function nextDelay(r: PollResult): number {
  if (r.ok) return 5000;
  if (r.status === 429) return Math.max(r.retryAfter ?? 60, 30) * 1000;
  return 15_000;
}
