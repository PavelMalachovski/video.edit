// Готовые файлы задачи (ролик, субтитры, обложка, прокси редактора) — из ветки в черновик релиза. Сессия Claude пушит
// их в jobs/<id>/out/ (прав на релизы у неё нет); раньше их переносил Action job-outputs, теперь — сама страница, когда
// её открыли: Action стоит минут, а кончились минуты — ролик не доходил (26.10). То же, что делал
// .github/scripts/move-job-outputs.sh: куски `<имя>.part-aa…` склеиваются по порядку (сверка с `<имя>.sha256`, если он
// есть), файл с тем же именем в черновике заменяется, из ветки файлы уходят, `out/released.json` — список ассетов.
import crypto from 'node:crypto';
import { commitFiles, getHead, listDir, readRaw, type DirEntry, type FileMap } from './branch.ts';
import { findReleaseByTag, listAllAssets, uploadAsset, type Asset, type GH } from './github.ts';
import { jobBranch, jobDir, jobTag } from './jobs.ts';

const PART = /^(.+)\.part-[a-z]{2,}$/;
const SHA = /^(.+)\.sha256$/;
const RELEASED = 'released.json';

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
const whole = (a: Asset): boolean => a.state === undefined || a.state === 'uploaded';
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
export async function deliverOutputs(gh: GH, id: string, opts: { budgetMs?: number } = {}): Promise<boolean> {
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
  let moved = false;
  const broken: string[] = [];
  for (const [k, o] of outputs.entries()) {
    if (k > 0 && Date.now() - started > (opts.budgetMs ?? BUDGET_MS)) break;
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
    await uploadAsset(gh, release.id, o.name, data, typeOf(o.name)); // тот же файл в черновике — заменяется
    const files = [...o.parts, ...(o.sha256 ? [o.sha256] : [])];
    await commitFiles(gh, branch, async (now): Promise<FileMap> => {
      const assets = (await listAllAssets(gh, release.id)).filter(whole);
      const released = { release_id: release.id, assets: assets.map((a) => ({ name: a.name, id: a.id, size: a.size })),
        at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
      const map: FileMap = { [`${out}/${RELEASED}`]: `${JSON.stringify(released, null, 1)}\n` };
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
