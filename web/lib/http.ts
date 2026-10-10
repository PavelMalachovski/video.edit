// Ошибка API → JSON с текстом причины, чтобы страница могла её показать.
// Токены в тексте вырезаются; ошибка конфигурации (нет переменной окружения) — 500, остальное — 502.
export function errorResponse(e: unknown): Response {
  const raw = e instanceof Error ? e.message : String(e);
  const error = raw.replace(/(Bearer|token)\s+\S+/gi, '$1 ***').replace(/gh[pousr]_\w+|github_pat_\w+/g, '***').slice(0, 800);
  return Response.json({ error }, { status: /^env \w+ is not set/.test(raw) ? 500 : 502 });
}
