import { isRateLimited } from './github.ts';
import { RoutineError } from './routine.ts';

// Ошибка API → JSON с текстом причины, чтобы страница могла её показать.
// Лимит GitHub — 429 с тем, сколько ждать; ошибка рутины — 502 с её понятным текстом; токены в тексте вырезаются;
// ошибка конфигурации (нет переменной окружения) — 500, остальное — 502.
export function errorResponse(e: unknown): Response {
  if (isRateLimited(e)) return Response.json({ error: 'GitHub просит подождать', retryAfter: e.retryAfter }, { status: 429 });
  if (e instanceof RoutineError) return Response.json({ error: e.message }, { status: 502 });
  const raw = e instanceof Error ? e.message : String(e);
  const error = raw.replace(/(Bearer|token)\s+\S+/gi, '$1 ***').replace(/gh[pousr]_\w+|github_pat_\w+/g, '***').slice(0, 800);
  return Response.json({ error }, { status: /^env \w+ is not set/.test(raw) ? 500 : 502 });
}
