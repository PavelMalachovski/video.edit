// Готовые файлы задачи (ролик, субтитры, обложка, прокси редактора) — из ветки в черновик релиза. Сессия Claude пушит
// их в jobs/<id>/out/ (прав на релизы у неё нет); раньше их переносил Action job-outputs, теперь — сама страница, когда
// её открыли: Action стоит минут, а кончились минуты — ролик не доходил (26.10). То же, что делал
// .github/scripts/move-job-outputs.sh: куски `<имя>.part-aa…` склеиваются по порядку (сверка с `<имя>.sha256`, если он
// есть), файл с тем же именем в черновике заменяется, из ветки файлы уходят, `out/released.json` — список ассетов.
import crypto from 'node:crypto';
import { commitFiles, getHead, listDir, readRaw, type DirEntry, type FileMap } from './branch.ts';
import { createDraftRelease, deleteAsset, findReleaseByTag, listAllAssets, uploadAsset, type GH } from './github.ts';
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

/**
 * Перенести готовые файлы задачи `id` в её черновик. Нечего — false. Повтор безопасен: файл, уже лежащий в черновике
 * того же размера, не грузится заново (прошлый перенос мог оборваться по времени функции); коммит в ветку — без force,
 * поверх новой головы. Битый ролик (сумма не сошлась) не переносится — ошибка, файлы остаются в ветке.
 */
export async function deliverOutputs(gh: GH, id: string): Promise<boolean> {
  const branch = jobBranch(id);
  const out = `${jobDir(id)}/out`;
  const head = await getHead(gh, branch);
  if (!head) return false;
  const { outputs } = planOutputs((await listDir(gh, head, out)) ?? []);
  if (!outputs.length) return false;
  const release = (await findReleaseByTag(gh, jobTag(id))) ?? (await createDraftRelease(gh, jobTag(id), jobTag(id), `Готовые файлы задачи ${id}`));
  let assets = await listAllAssets(gh, release.id);
  for (const o of outputs) {
    const old = assets.find((a) => a.name === o.name);
    if (old && old.size === o.size && !o.sha256) continue; // уже перенесён прошлым разом
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
      if (want !== got) throw new Error(`${o.name}: sha256 не сходится (${got} вместо ${want}) — ролик не перенесён`);
      if (old && old.size === o.size) continue;
    }
    if (old) await deleteAsset(gh, old.id);
    await uploadAsset(gh, release.id, o.name, data, o.name.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream');
  }
  assets = await listAllAssets(gh, release.id);
  const released = { release_id: release.id, assets: assets.map((a) => ({ name: a.name, id: a.id, size: a.size })), at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
  await commitFiles(gh, branch, async (now): Promise<FileMap> => {
    // убираем только то, что ещё есть на новой голове (сессия или второй перенос могли успеть раньше)
    const left = new Set(planOutputs((await listDir(gh, now, out)) ?? []).remove);
    const files: FileMap = { [`${out}/${RELEASED}`]: `${JSON.stringify(released, null, 1)}\n` };
    for (const o of outputs) for (const p of [...o.parts, ...(o.sha256 ? [o.sha256] : [])]) if (left.has(p)) files[`${out}/${p}`] = null;
    return files;
  }, `outputs(${id}): готовые файлы — в черновик релиза`);
  return true;
}
