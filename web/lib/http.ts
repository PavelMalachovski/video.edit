import { createHash } from 'node:crypto';
import { ConfigError } from './env.ts';
import { isRateLimited } from './github.ts';
import { RoutineError } from './routine.ts';

// Ошибка API → JSON с текстом причины, чтобы страница могла её показать.
// Лимит GitHub — 429 с тем, сколько ждать; ошибка рутины — 502 с её понятным текстом; токены в тексте вырезаются;
// ошибка конфигурации (нет переменной окружения) — 500, остальное — 502.
export function errorResponse(e: unknown): Response {
  if (isRateLimited(e)) return Response.json({ error: 'GitHub просит подождать', retryAfter: e.retryAfter }, { status: 429 });
  if (e instanceof RoutineError) return Response.json({ error: e.message }, { status: 502 });
  if (e instanceof ConfigError) return Response.json({ error: e.message }, { status: 500 });
  const raw = e instanceof Error ? e.message : String(e);
  const error = raw.replace(/(Bearer|token)\s+\S+/gi, '$1 ***').replace(/gh[pousr]_\w+|github_pat_\w+/g, '***').slice(0, 800);
  return Response.json({ error }, { status: 502 });
}

/** JSON с ETag по содержимому: опрос с тем же `If-None-Match` получает 304 без тела — страница оставляет то, что у неё
 *  есть, а трафик Vercel (Fast Origin Transfer) — сотни байт вместо десятков килобайт на каждый опрос. */
export function jsonWithEtag(data: unknown, request: Request): Response {
  const body = JSON.stringify(data);
  const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
  const headers = { ETag: etag, 'Cache-Control': 'no-store' };
  // сравнение слабое (RFC 9110): CDN, сжимая ответ, может вернуть его как W/"…", браузер — списком
  const sent = (request.headers.get('If-None-Match') ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''));
  if (sent.includes(etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, 'Content-Type': 'application/json' } });
}

/** Заголовки кэша для файла коммита: `v` — sha головы ветки (40 hex), его содержимое не меняется — браузер держит день,
 *  CDN Vercel — год (Vercel-CDN-Cache-Control видит только он; proxy.ts со входом стоит до его кэша); без sha — не
 *  кэшировать. Повторный запрос из кэша CDN функцию не запускает — трафика Fast Origin Transfer нет. Без `private`:
 *  ответ с private, no-cache или no-store CDN Vercel не кэширует (по его правилам), а чужие кэши HTTPS не видят. */
export function commitCache(v: string | null): Record<string, string> {
  return v && /^[0-9a-f]{40}$/.test(v) ? { 'Cache-Control': 'max-age=86400', 'Vercel-CDN-Cache-Control': 'max-age=31536000' } : { 'Cache-Control': 'no-store' };
}
