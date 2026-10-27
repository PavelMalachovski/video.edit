// Готовые файлы задачи (ролик, субтитры, обложка, прокси редактора) — из ветки в черновик релиза. Сессия Claude пушит
// их в jobs/<id>/out/ (прав на релизы у неё нет); раньше их переносил Action job-outputs, теперь — сама страница, когда
// её открыли: Action стоит минут, а кончились минуты — ролик не доходил (26.10). То же, что делал
// .github/scripts/move-job-outputs.sh: куски `<имя>.part-aa…` склеиваются по порядку (сверка с `<имя>.sha256`, если он
// есть), файл с тем же именем в черновике заменяется, из ветки файлы уходят, `out/released.json` — список ассетов.
import crypto from 'node:crypto';
import { commitFiles, getHead, listDir, readRaw, type DirEntry, type FileMap } from './branch.ts';
import { assetDownload, createAsset, deleteAsset, findReleaseByTag, GitHubError, listAllAssets, uploadAsset, type Asset, type GH } from './github.ts';
import type { Released } from './jobfiles.ts';
import { jobBranch, jobDir, jobTag } from './jobs.ts';

const PART = /^(.+)\.part-[a-z]{2,}$/;
const SHA = /^(.+)\.sha256$/;
const RELEASED = 'released.json';
/** Замок переноса в черновике: имя ассета у GitHub уникально, второй такой не создать — так два экземпляра страницы
 *  (опрос задачи и редактора, второе устройство) не переносят одни и те же файлы разом (26.10: гонка оставила в
 *  released.json ассет, который другой перенос уже заменил, — плеер редактора не грузил прокси). */
export const LOCK = 'delivering.lock';
const STALE_MS = 3 * 60_000; // замок старше — его экземпляр оборвался (у функции 60 с)

/** Один файл черновика: имя, из каких файлов out/ он склеивается (по порядку), его размер и файл с суммой. */
export type Output = { name: string; parts: string[]; size: number; sha256: string | null };

/** Что перенести из out/ (`outputs`, по имени) и что потом убрать из ветки (`remove`); released.json остаётся. */
export function planOutputs(entries: readonly DirEntry[]): { outputs: Output[]; remove: string[] } {
  const files = entries.filter((e) => e.type === 'file' && e.name !== RELEASED);
  const names = new Set(files.map((e) => e.name));
  const byName = new Map<string, Output>();
  for (const e of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SHA.test(e.name)) continue;
    const name = PART.exec(e.name)?.[1] ?? e.name;
    const o = byName.get(name) ?? { name, parts: [], size: 0, sha256: names.has(`${name}.sha256`) ? `${name}.sha256` : null };
    o.parts.push(e.name);
    o.size += e.size;
    byName.set(name, o);
  }
  return { outputs: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), remove: files.map((e) => e.name) };
}

async function bytesOf(gh: GH, ref: string, path: string): Promise<Uint8Array> {
  const r = await readRaw(gh, ref, path);
  if (!r) throw new Error(`${path}: нет в ветке`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Порядок переноса: сначала ролик (final.mp4, final-vN.mp4), потом его версии и субтитры, остальное — после. */
const rank = (name: string): number => (/^final(-v\d+)?\.mp4$/.test(name) ? 0 : name.startsWith('final') ? 1 : 2);
const TYPES: Record<string, string> = {
  mp4: 'video/mp4', srt: 'application/x-subrip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', json: 'application/json',
  mkv: 'video/x-matroska', webm: 'video/webm',
};
const typeOf = (name: string): string => TYPES[/\.([a-z0-9]+)$/.exec(name)?.[1] ?? ''] ?? 'application/octet-stream';
/** Ассет догружен до конца (оборванная загрузка остаётся в состоянии starter — её как будто нет). */
const whole = (a: Asset): boolean => (a.state === undefined || a.state === 'uploaded') && a.name !== LOCK;

/** released.json по живому списку черновика. */
async function releasedOf(gh: GH, releaseId: number): Promise<Released> {
  const assets = (await listAllAssets(gh, releaseId)).filter(whole);
  return { release_id: releaseId, assets: assets.map((a) => ({ name: a.name, id: a.id, size: a.size })), at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
}
const releasedText = (r: Released): string => `${JSON.stringify(r, null, 1)}\n`;

/** Взять замок переноса; занят (и не брошен) — false. */
async function lock(gh: GH, releaseId: number, staleMs: number): Promise<boolean> {
  const held = (await listAllAssets(gh, releaseId)).find((a) => a.name === LOCK);
  if (held) {
    const age = held.created_at ? Date.now() - Date.parse(held.created_at) : null;
    if (age === null ? staleMs > 0 : age <= staleMs) return false;
    await deleteAsset(gh, held.id);
  }
  try {
    // не пустой: пустой файл GitHub в релиз не примет (27.10 из-за этого не переносился ни один ролик)
    await createAsset(gh, releaseId, LOCK, new TextEncoder().encode(`${new Date().toISOString()}\n`));
    return true;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 422) return false; // другой экземпляр успел первым
    throw e;
  }
}
const BUDGET_MS = 30_000; // новый файл начинаем, только пока прошло меньше: у функции 60 с, перенос файла — до ~20 с

/**
 * Перенести готовые файлы задачи `id` из ветки в её черновик (как move-job-outputs.sh: склеить части, сверить с
 * .sha256, заменить файл того же имени). По файлу за раз, сначала ролик; после каждого — коммит: released.json по
 * свежему списку черновика (только догруженные ассеты) и файл из ветки — только если он там тот же (сессия не
 * перезалила его за это время) и в черновике лежит целиком. Так оборванный по времени или параллельный перенос ничего
 * не теряет: что не убрано из ветки, перенесётся на следующем опросе. Что не успели за `budgetMs` — тоже. Перенесён
 * хоть один файл — true. Черновика нет (задачу удаляют) — ничего. Сумма не сошлась — этот файл остаётся в ветке, остальные
 * переносятся, потом — ошибка.
 */
export async function deliverOutputs(gh: GH, id: string, opts: { budgetMs?: number; staleMs?: number } = {}): Promise<boolean> {
  const started = Date.now();
  const branch = jobBranch(id);
  const out = `${jobDir(id)}/out`;
  const head = await getHead(gh, branch);
  if (!head) return false;
  const entries = (await listDir(gh, head, out)) ?? [];
  const sha = new Map(entries.map((e) => [e.name, e.sha]));
  const outputs = planOutputs(entries).outputs.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : 1));
  if (!outputs.length) return false;
  const release = await findReleaseByTag(gh, jobTag(id));
  if (!release) return false;
  if (!(await lock(gh, release.id, opts.staleMs ?? STALE_MS))) return false; // переносит другой экземпляр
  try {
    return await deliverLocked(gh, id, release.id, head, outputs, sha, started, opts.budgetMs ?? BUDGET_MS);
  } finally {
    const held = (await listAllAssets(gh, release.id)).find((a) => a.name === LOCK);
    if (held) await deleteAsset(gh, held.id);
  }
}

async function deliverLocked(gh: GH, id: string, releaseId: number, head: string, outputs: Output[], sha: Map<string, string>, started: number,
  budgetMs: number): Promise<boolean> {
  const branch = jobBranch(id);
  const out = `${jobDir(id)}/out`;
  let moved = false;
  const broken: string[] = [];
  for (const [k, o] of outputs.entries()) {
    if (k > 0 && Date.now() - started > budgetMs) break;
    const chunks = await Promise.all(o.parts.map((p) => bytesOf(gh, head, `${out}/${p}`)));
    const data = new Uint8Array(o.size);
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.length;
    }
    if (o.sha256) {
      const want = new TextDecoder().decode(await bytesOf(gh, head, `${out}/${o.sha256}`)).trim().split(/\s+/)[0];
      const got = crypto.createHash('sha256').update(data).digest('hex');
      if (want !== got) {
        broken.push(`${o.name}: sha256 не сходится (${got} вместо ${want}) — не перенесён`);
        continue;
      }
    }
    await uploadAsset(gh, releaseId, o.name, data, typeOf(o.name)); // тот же файл в черновике — заменяется
    const files = [...o.parts, ...(o.sha256 ? [o.sha256] : [])];
    await commitFiles(gh, branch, async (now): Promise<FileMap> => {
      const released = await releasedOf(gh, releaseId);
      const assets = released.assets;
      const map: FileMap = { [`${out}/${RELEASED}`]: releasedText(released) };
      const there = new Map(((await listDir(gh, now, out)) ?? []).map((e) => [e.name, e.sha]));
      const same = files.every((f) => there.get(f) === sha.get(f)); // сессия не перезалила ни одной части
      const delivered = assets.some((a) => a.name === o.name && a.size === o.size);
      if (same && delivered) for (const f of files) map[`${out}/${f}`] = null;
      return map;
    }, `outputs(${id}): ${o.name} — в черновик релиза`);
    moved = true;
  }
  if (broken.length) throw new Error(broken.join('; '));
  return moved;
}

/**
 * Скачать файл задачи `name` по released.json: 302-ссылка или ответ (как assetDownload); в released.json его нет — null.
 * Ассета с этим id в черновике уже нет (его заменил другой перенос или Action) — файл берётся по имени из живого списка
 * черновика, а released.json в ветке переписывается по нему: плеер и «Скачать» не ломаются от устаревшего списка.
 */
export async function releasedDownload(gh: GH, id: string, released: Released | null, name: string): Promise<{ location: string } | { response: Response } | null> {
  const listed = released?.assets.find((a) => a.name === name);
  if (!listed) return null;
  try {
    return await assetDownload(gh, listed.id);
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 404)) throw e;
  }
  const release = await findReleaseByTag(gh, jobTag(id));
  if (!release) return null;
  const fresh = await releasedOf(gh, release.id);
  const live = fresh.assets.find((a) => a.name === name);
  try { // починить список в ветке; не вышло — не страшно, следующий запрос найдёт файл так же
    await commitFiles(gh, jobBranch(id), { [`${jobDir(id)}/out/${RELEASED}`]: releasedText(fresh) }, `outputs(${id}): released.json — по черновику`);
  } catch (e) {
    console.error(`released.json ${id}:`, e);
  }
  return live ? assetDownload(gh, live.id) : null;
}
