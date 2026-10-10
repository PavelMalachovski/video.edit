// Шаги задачи: запуск анализа, ответы («Монтировать»), «Ещё три варианта», «Поправить», повтор и удаление.
// Входные файлы шага, новая запись в job.json и статус «queued» ложатся одним коммитом ДО запуска рутины: сессия,
// стартовав, уже видит всё в ветке. Текст запуска — только {job, step, attempt}.
import { commitFiles, deleteBranch, readText } from './branch.ts';
import { deleteRelease, findReleaseByTag, listAllAssets, readAssetText, type GH } from './github.ts';
import { backStatus, buildJobFile, errorStatus, queuedStatus, type FixFile, type JobFile, type Manifest, type Run } from './jobfiles.ts';
import { jobBranch, jobDir, jobTag } from './jobs.ts';
import { fireRoutine, RoutineError, type Routine, type Step } from './routine.ts';

export type Deps = { gh: GH; routine: Routine; now?: () => Date };

const json = (data: unknown): string => `${JSON.stringify(data, null, 2)}\n`;

async function readJob(gh: GH, id: string): Promise<JobFile | null> {
  const text = await readText(gh, jobBranch(id), `${jobDir(id)}/job.json`);
  return text === null ? null : (JSON.parse(text) as JobFile);
}

/**
 * Запуск шага: `files` (имена от папки задачи), job.json с новой записью `runs` и статус «queued» — одним коммитом,
 * затем запуск рутины. Сбой запуска — статус ошибки с её текстом и та же ошибка дальше. `opts.job` — старт: job.json
 * ещё нет, ветка создаётся от master (удалённую задачу другие шаги не воскрешают).
 */
export async function runStep(d: Deps, id: string, step: Step, files: Record<string, string>, opts: { retry?: boolean; job?: JobFile } = {}): Promise<{ attempt: number; sessionUrl: string }> {
  const now = () => (d.now ?? (() => new Date()))();
  const dir = jobDir(id);
  const branch = jobBranch(id);
  const job = opts.job ?? (await readJob(d.gh, id));
  if (!job) throw new Error('Задача не найдена: в ветке нет job.json');
  const last = job.runs.at(-1);
  if (opts.retry && last?.step !== step) throw new Error(`Повторить можно только последний шаг (${last?.step ?? 'шагов не было'})`);
  const attempt = opts.retry && last ? last.attempt + 1 : 1;
  const run: Run = { step, attempt, at: now().toISOString() };
  const queued = { ...job, runs: [...job.runs, run] };
  await commitFiles(d.gh, branch, {
    ...Object.fromEntries(Object.entries(files).map(([name, text]) => [`${dir}/${name}`, text])),
    [`${dir}/job.json`]: json(queued),
    [`${dir}/status.json`]: json(queuedStatus(step, now())),
  }, `web(${id}): ${step} #${attempt}`, opts.job ? { base: 'master' } : {});

  let sessionUrl: string;
  try {
    ({ sessionUrl } = await fireRoutine(d.routine, id, step, attempt));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const why = e instanceof RoutineError ? `RoutineError ${e.status}` : message;
    await commitFiles(d.gh, branch, { [`${dir}/status.json`]: json(errorStatus(message, why, now())) }, `web(${id}): ${step} #${attempt} не запустился`)
      .catch(() => undefined);  // статус не записался — ошибку всё равно увидит тот, кто запускал
    throw e;
  }
  const started = { ...queued, runs: [...job.runs, { ...run, sessionUrl }] };
  await commitFiles(d.gh, branch, { [`${dir}/job.json`]: json(started) }, `web(${id}): ${step} #${attempt} — сессия`)
    .catch(() => undefined);  // ссылка на сессию — удобство, шаг уже идёт
  return { attempt, sessionUrl };
}

/** Первый шаг: job.json из manifest.json черновика и запуск анализа. */
export async function startJob(d: Deps, id: string): Promise<{ attempt: number; sessionUrl: string }> {
  const existing = await readJob(d.gh, id);
  if (existing?.runs.length) throw new Error('Анализ уже запущен');
  const release = await findReleaseByTag(d.gh, jobTag(id));
  if (!release) throw new Error('Черновик задачи не найден');
  const manifest = (await listAllAssets(d.gh, release.id)).find((a) => a.name === 'manifest.json');
  if (!manifest) throw new Error('Видео ещё не загружено до конца');
  const job = buildJobFile(JSON.parse(await readAssetText(d.gh, manifest.id)) as Manifest, (d.now ?? (() => new Date()))());
  return runStep(d, id, 'analyze', {}, { job });
}

/** Повтор: шаг последнего запуска с попыткой + 1 (запусков не было — первый запуск). */
export async function retryStep(d: Deps, id: string): Promise<{ attempt: number; sessionUrl: string }> {
  const job = await readJob(d.gh, id);
  const last = job?.runs.at(-1);
  if (!last) return startJob(d, id);
  return runStep(d, id, last.step, {}, { retry: true });
}

/**
 * Шаг сорвался из-за входных данных — вернуться к последнему хорошему: после restyle и render снова ждём ответов (файлы
 * шага остаются: прежние стили, ответы), после fix снимается последняя, не доставленная правка — экран «Готово» с
 * прежним роликом. Ничего не запускает.
 */
export async function backStep(d: Deps, id: string): Promise<{ screen: 'questions' | 'result' }> {
  const now = (d.now ?? (() => new Date()))();
  const dir = jobDir(id);
  const branch = jobBranch(id);
  const last = (await readJob(d.gh, id))?.runs.at(-1);
  if (!last || last.step === 'analyze') throw new Error('Вернуться некуда: шаг можно только повторить');
  if (last.step === 'fix') {
    const text = await readText(d.gh, branch, `${dir}/fix.json`);
    const fixes = text ? (JSON.parse(text) as FixFile).fixes ?? [] : [];
    const dropped = fixes.at(-1);
    if (!dropped) throw new Error('Правок нет — возвращать нечего');
    await commitFiles(d.gh, branch, { [`${dir}/fix.json`]: json({ fixes: fixes.slice(0, -1) }), [`${dir}/status.json`]: json(backStatus('fix', now)) },
      `web(${id}): правка ${dropped.version} отменена`);
    return { screen: 'result' };
  }
  await commitFiles(d.gh, branch, { [`${dir}/status.json`]: json(backStatus(last.step, now)) }, `web(${id}): назад к ответам после ${last.step}`);
  return { screen: 'questions' };
}

/** Удалить задачу: сначала ветку, потом черновик с видео; чего уже нет — пропускается. */
export async function deleteJob(gh: GH, id: string): Promise<void> {
  await deleteBranch(gh, jobBranch(id));
  const release = await findReleaseByTag(gh, jobTag(id));
  if (release) await deleteRelease(gh, release.id);
}
