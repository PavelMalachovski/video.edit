// Ветка задачи claude/job-<id>: голова, файлы страницы одним коммитом (Git Data API), чтение файлов сессии, удаление.
// Коммит никогда не форсится: если ветку сдвинула сессия или Action, всё собирается заново от новой головы.
import { apiBase, call, GitHubError, headers, ok, retryAfter, type GH } from './github.ts';

/** Путь от корня репозитория → текст UTF-8. */
export type FileMap = Record<string, string>;
export type DirEntry = { name: string; type: 'file' | 'dir'; sha: string; size: number };

const JSON_BODY = { 'Content-Type': 'application/json' };
const PAUSES = [500, 1000, 2000]; // мс между попытками коммита, всего 4 попытки
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const repo = (gh: GH) => `${apiBase(gh)}/repos/${gh.repo}`;
const pathUrl = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export async function getHead(gh: GH, branch: string): Promise<string | null> {
  const r = await call<{ object: { sha: string } }>(gh, 'GET', `${repo(gh)}/git/ref/heads/${branch}`);
  return r.status === 404 ? null : ok(r, `head of ${branch}`).object.sha;
}

/** Ветки, чьё имя начинается с `prefix`: имя → sha головы. */
export async function listHeads(gh: GH, prefix: string): Promise<Map<string, string>> {
  const r = await call<{ ref: string; object: { sha: string } }[]>(gh, 'GET', `${repo(gh)}/git/matching-refs/heads/${prefix}`);
  return new Map(ok(r, `branches ${prefix}*`).map((x) => [x.ref.replace(/^refs\/heads\//, ''), x.object.sha]));
}

/**
 * Один коммит с файлами `files` в ветку `branch`. Ветки нет: с `opts.base` — коммит поверх головы `base` и новая
 * ветка, без него — GitHubError 404. Ответ 422 (ветку сдвинули или её уже создали) — всё заново от новой головы.
 */
export async function commitFiles(gh: GH, branch: string, files: FileMap, message: string, opts: { base?: string } = {}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let head = await getHead(gh, branch);
    const create = head === null;
    if (create) {
      if (!opts.base) throw new GitHubError(`commit to ${branch}: no such branch`, 404);
      head = await getHead(gh, opts.base);
      if (!head) throw new GitHubError(`commit to ${branch}: no base branch ${opts.base}`, 404);
    }
    const parent = ok(await call<{ tree: { sha: string } }>(gh, 'GET', `${repo(gh)}/git/commits/${head}`), 'get commit');
    const entries = Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content }));
    const tree = ok(await call<{ sha: string }>(gh, 'POST', `${repo(gh)}/git/trees`,
      JSON.stringify({ base_tree: parent.tree.sha, tree: entries }), JSON_BODY), 'create tree');
    const commit = ok(await call<{ sha: string }>(gh, 'POST', `${repo(gh)}/git/commits`,
      JSON.stringify({ message, tree: tree.sha, parents: [head] }), JSON_BODY), 'create commit');
    const moved = create
      ? await call<unknown>(gh, 'POST', `${repo(gh)}/git/refs`, JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }), JSON_BODY)
      : await call<unknown>(gh, 'PATCH', `${repo(gh)}/git/refs/heads/${branch}`, JSON.stringify({ sha: commit.sha, force: false }), JSON_BODY);
    if (moved.status !== 422 || attempt >= PAUSES.length) {
      ok(moved, `update ${branch}`);
      return commit.sha;
    }
    await sleep(PAUSES[attempt]);
  }
}

/** Удалить ветку; её уже нет — не ошибка. */
export async function deleteBranch(gh: GH, branch: string): Promise<void> {
  const r = await call<unknown>(gh, 'DELETE', `${repo(gh)}/git/refs/heads/${branch}`);
  if (r.status !== 204 && r.status !== 404 && r.status !== 422) ok(r, `delete ${branch}`);
}

/** Содержимое папки `path` на `ref`; null — нет ветки или папки. */
export async function listDir(gh: GH, ref: string, path: string): Promise<DirEntry[] | null> {
  const r = await call<{ name: string; type: string; sha: string; size: number }[] | { type: string }>(gh, 'GET',
    `${repo(gh)}/contents/${pathUrl(path)}?ref=${encodeURIComponent(ref)}`);
  if (r.status === 404) return null;
  const data = ok(r, `list ${path}`);
  if (!Array.isArray(data)) return null;  // это файл, а не папка
  return data.map((e) => ({ name: e.name, type: e.type === 'dir' ? 'dir' : 'file', sha: e.sha, size: e.size }));
}

/** Файл как есть (без кэша — его кэширует браузер по v=<голова>); null — нет ветки или файла. */
export async function readRaw(gh: GH, ref: string, path: string): Promise<Response | null> {
  const r = await (gh.fetch ?? fetch)(`${repo(gh)}/contents/${pathUrl(path)}?ref=${encodeURIComponent(ref)}`, {
    headers: headers(gh, { Accept: 'application/vnd.github.raw' }),
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    const text = await r.text();
    throw new GitHubError(`read ${path}: GitHub ${r.status} ${text.slice(0, 300)}`, r.status, retryAfter(r.status, r.headers, text));
  }
  return r;
}

export async function readText(gh: GH, ref: string, path: string): Promise<string | null> {
  const r = await readRaw(gh, ref, path);
  return r ? r.text() : null;
}
