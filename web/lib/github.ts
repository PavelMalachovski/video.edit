// Минимальный клиент GitHub REST для черновиков релизов (токен — только на сервере).
export type GH = { token: string; repo: string; fetch?: typeof fetch; api?: string; uploads?: string };
// state: uploaded, или starter — загрузка оборвалась; created_at — когда загружен (замок переноса — lib/outputs.ts)
export type Asset = { id: number; name: string; size: number; state?: string; created_at?: string };
export type Release = { id: number; tag_name: string; name: string | null; draft: boolean; created_at?: string; assets: Asset[] };

export const apiBase = (gh: GH): string => gh.api ?? 'https://api.github.com';
const uploadsBase = (gh: GH): string => gh.uploads ?? 'https://uploads.github.com';

export function headers(gh: GH, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
}

/** Ответ GitHub не 2xx. `retryAfter` — сколько секунд ждать, если это лимит запросов (иначе null). */
export class GitHubError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function isRateLimited(e: unknown): e is GitHubError {
  return e instanceof GitHubError && e.retryAfter !== null;
}

// Лимиты по документации GitHub: retry-after — ждать столько; x-ratelimit-remaining: 0 — до x-ratelimit-reset;
// вторичный лимит без этих заголовков (403 или 429 с «rate limit» в тексте) — минуту.
export function retryAfter(status: number, h: Headers, data: unknown): number | null {
  if (status !== 403 && status !== 429) return null;
  const after = Number(h.get('retry-after'));
  if (h.get('retry-after') !== null && Number.isFinite(after)) return Math.max(1, Math.round(after));
  const reset = Number(h.get('x-ratelimit-reset'));
  if (h.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) return Math.max(1, Math.round(reset - Date.now() / 1000));
  if (status === 429 || /rate limit/i.test(JSON.stringify(data ?? ''))) return 60;
  return null;
}

// Условные GET: ETag по адресу; 304 не тратит лимит GitHub, данные берутся из памяти. Старые записи вытесняются.
const ETAGS = new Map<string, { etag: string; data: unknown }>();
const ETAG_LIMIT = 300;

export function clearGitHubCache(): void {
  ETAGS.clear();
}

type Answer<T> = { status: number; data: T; headers: Headers };

/** Запрос к API GitHub с токеном; GET с JSON — условный (ETag). Ответ не проверяется — это делает `ok`. */
export async function call<T>(gh: GH, method: string, url: string, body?: BodyInit, extra?: Record<string, string>): Promise<Answer<T>> {
  const cached = method === 'GET' ? ETAGS.get(url) : undefined;
  const r = await (gh.fetch ?? fetch)(url, { method, headers: headers(gh, cached ? { ...extra, 'If-None-Match': cached.etag } : extra), body });
  if (r.status === 304 && cached) {
    ETAGS.delete(url);  // в конец очереди: недавно нужный
    ETAGS.set(url, cached);
    return { status: 200, data: cached.data as T, headers: r.headers };
  }
  const text = r.status === 204 || r.status === 304 ? '' : await r.text();
  let data: T;
  try {
    data = (text ? JSON.parse(text) : null) as T;
  } catch {
    data = text as T;
  }
  const etag = r.headers.get('etag');
  if (method === 'GET' && r.status === 200 && etag) {
    ETAGS.delete(url);
    ETAGS.set(url, { etag, data });
    if (ETAGS.size > ETAG_LIMIT) ETAGS.delete(ETAGS.keys().next().value as string);
  }
  return { status: r.status, data, headers: r.headers };
}

/** Данные ответа или GitHubError (с retryAfter, если это лимит). */
export function ok<T>(r: Answer<T>, what: string): T {
  if (r.status >= 300) throw new GitHubError(`${what}: GitHub ${r.status} ${JSON.stringify(r.data)}`, r.status, retryAfter(r.status, r.headers, r.data));
  return r.data;
}

export async function createDraftRelease(gh: GH, tag: string, title: string, body = ''): Promise<Release> {
  return ok(await call<Release>(gh, 'POST', `${apiBase(gh)}/repos/${gh.repo}/releases`,
    JSON.stringify({ tag_name: tag, name: title, draft: true, body }), { 'Content-Type': 'application/json' }), 'create release');
}

export async function listReleases(gh: GH): Promise<Release[]> {
  const all: Release[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = ok(await call<Release[]>(gh, 'GET', `${apiBase(gh)}/repos/${gh.repo}/releases?per_page=100&page=${page}`), 'list releases');
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// Черновики не находятся по /releases/tags/<tag> — ищем по списку.
export async function findReleaseByTag(gh: GH, tag: string): Promise<Release | null> {
  return (await listReleases(gh)).find((r) => r.tag_name === tag) ?? null;
}

export async function listAssets(gh: GH, releaseId: number): Promise<Asset[]> {
  return ok(await call<Asset[]>(gh, 'GET', `${apiBase(gh)}/repos/${gh.repo}/releases/${releaseId}/assets?per_page=100`), 'list assets');
}

export async function deleteAsset(gh: GH, assetId: number): Promise<void> {
  const r = await call<unknown>(gh, 'DELETE', `${apiBase(gh)}/repos/${gh.repo}/releases/assets/${assetId}`);
  if (r.status !== 204 && r.status !== 404) ok(r, 'delete asset');
}

export async function uploadAsset(gh: GH, releaseId: number, name: string, data: Uint8Array | ArrayBuffer,
  contentType = 'application/octet-stream'): Promise<Asset> {
  const url = `${uploadsBase(gh)}/repos/${gh.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  const body = data instanceof Uint8Array ? data : new Uint8Array(data);
  let r = await call<Asset>(gh, 'POST', url, body as BodyInit, { 'Content-Type': contentType });
  if (r.status === 422) {  // уже есть (повтор куска) — заменить
    const old = (await listAllAssets(gh, releaseId)).find((a) => a.name === name);
    if (old) await deleteAsset(gh, old.id);
    r = await call<Asset>(gh, 'POST', url, body as BodyInit, { 'Content-Type': contentType });
  }
  const a = ok(r, `upload ${name}`);
  return { id: a.id, name: a.name, size: a.size };
}

/** Новый ассет; такой уже есть — GitHubError 422 (не заменяет, в отличие от uploadAsset). */
export async function createAsset(gh: GH, releaseId: number, name: string, data: Uint8Array): Promise<Asset> {
  const url = `${uploadsBase(gh)}/repos/${gh.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  const a = ok(await call<Asset>(gh, 'POST', url, data as BodyInit, { 'Content-Type': 'application/octet-stream' }), `upload ${name}`);
  return { id: a.id, name: a.name, size: a.size };
}

export async function listAllAssets(gh: GH, releaseId: number): Promise<Asset[]> {
  const all: Asset[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = ok(await call<Asset[]>(gh, 'GET', `${apiBase(gh)}/repos/${gh.repo}/releases/${releaseId}/assets?per_page=100&page=${page}`), 'list assets');
    all.push(...batch.map((a) => ({ id: a.id, name: a.name, size: a.size, ...(a.state ? { state: a.state } : {}), ...(a.created_at ? { created_at: a.created_at } : {}) })));
    if (batch.length < 100) break;
  }
  return all;
}

/** Релиз по id; нет (удалён) — null. */
export async function getRelease(gh: GH, releaseId: number): Promise<Release | null> {
  const r = await call<Release>(gh, 'GET', `${apiBase(gh)}/repos/${gh.repo}/releases/${releaseId}`);
  return r.status === 404 ? null : ok(r, 'get release');
}

/** Удалить релиз (черновик задачи); его уже нет — не ошибка. */
export async function deleteRelease(gh: GH, releaseId: number): Promise<void> {
  const r = await call<unknown>(gh, 'DELETE', `${apiBase(gh)}/repos/${gh.repo}/releases/${releaseId}`);
  if (r.status !== 204 && r.status !== 404) ok(r, 'delete release');
}

/** Скачивание ассета без перехода: 302 → короткоживущая подписанная ссылка (её отдаём браузеру), 200 → сам ответ. */
export async function assetDownload(gh: GH, assetId: number): Promise<{ location: string } | { response: Response }> {
  const r = await (gh.fetch ?? fetch)(`${apiBase(gh)}/repos/${gh.repo}/releases/assets/${assetId}`, {
    headers: headers(gh, { Accept: 'application/octet-stream' }),
    redirect: 'manual',
  });
  const location = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && location) return { location };
  if (r.ok) return { response: r };
  const text = await r.text();
  throw new GitHubError(`download asset ${assetId}: GitHub ${r.status} ${text.slice(0, 300)}`, r.status, retryAfter(r.status, r.headers, text));
}

/** Текст ассета (manifest.json) — с переходом по подписанной ссылке. */
export async function readAssetText(gh: GH, assetId: number): Promise<string> {
  const r = await (gh.fetch ?? fetch)(`${apiBase(gh)}/repos/${gh.repo}/releases/assets/${assetId}`, {
    headers: headers(gh, { Accept: 'application/octet-stream' }),
  });
  const text = await r.text();
  if (!r.ok) throw new GitHubError(`read asset ${assetId}: GitHub ${r.status} ${text.slice(0, 300)}`, r.status, retryAfter(r.status, r.headers, text));
  return text;
}

