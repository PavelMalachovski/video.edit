// Минимальный клиент GitHub REST для черновиков релизов (токен — только на сервере).
export type GH = { token: string; repo: string; fetch?: typeof fetch; api?: string; uploads?: string };
export type Asset = { id: number; name: string; size: number };
export type Release = { id: number; tag_name: string; name: string | null; draft: boolean; created_at?: string; assets: Asset[] };

const apiBase = (gh: GH): string => gh.api ?? 'https://api.github.com';
const uploadsBase = (gh: GH): string => gh.uploads ?? 'https://uploads.github.com';

function headers(gh: GH, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
}

async function call<T>(gh: GH, method: string, url: string, body?: BodyInit, extra?: Record<string, string>): Promise<{ status: number; data: T }> {
  const r = await (gh.fetch ?? fetch)(url, { method, headers: headers(gh, extra), body });
  const text = r.status === 204 ? '' : await r.text();
  return { status: r.status, data: (text ? JSON.parse(text) : null) as T };
}

function ok<T>(r: { status: number; data: T }, what: string): T {
  if (r.status >= 300) throw new Error(`${what}: GitHub ${r.status} ${JSON.stringify(r.data)}`);
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

export async function listAllAssets(gh: GH, releaseId: number): Promise<Asset[]> {
  const all: Asset[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = ok(await call<Asset[]>(gh, 'GET', `${apiBase(gh)}/repos/${gh.repo}/releases/${releaseId}/assets?per_page=100&page=${page}`), 'list assets');
    all.push(...batch.map((a) => ({ id: a.id, name: a.name, size: a.size })));
    if (batch.length < 100) break;
  }
  return all;
}
