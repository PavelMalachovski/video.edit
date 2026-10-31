// «Найти ещё кадры» из редактора: запрос Павла → stills.json в ветке задачи и короткий запуск рутины `stills` (vm tmdb
// --more). Его нет в job.json.runs и статус задачи он не трогает: по found/tmdb.json.request редактор видит, что поиск
// сделан. Движок задачи знает этот шаг, если в её ветке есть схема stills.json.
import { commitFiles, readText } from './branch.ts';
import type { GH } from './github.ts';
import { jobBranch, jobDir } from './jobs.ts';
import { fireRoutine, type Routine } from './routine.ts';

export const STILLS_SCHEMA = 'engine/vm/schemas/stills.json';
export const STILLS_MAX = 80; // знаков в поле запроса (схема stills.json)
// мс — столько ждём ответа сессии; дольше — она не ответила (рутина отказала, сорвалась): поиск можно попросить снова
export const STILLS_WAIT = 20 * 60_000;
export type StillsAsk = { film: string; name?: string; actor?: string };
export type StillsRequest = StillsAsk & { at: string };
/** Поиск в редакторе: можно ли (`can` — движок задачи знает шаг), идёт ли (`pending`), почему не нашлось (`error`) и что
 *  спрашивать (`ask` — прошлый запрос или разбор из job.json). */
export type StillsState = { can: boolean; pending: boolean; error: string | null; ask: StillsAsk };

const FIELDS = ['film', 'name', 'actor'] as const;
// управляющие знаки и переводы строк — не в запросе (его читает сессия)
const BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** Тело запроса страницы → запрос (поля обрезаны; фильм — обязательно, пустые — без них) или текст ошибки. */
export function parseStillsBody(body: unknown): StillsAsk | { error: string } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of FIELDS) {
    const v = b[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || BAD.test(v)) return { error: 'Запрос — строки без переводов строки' };
    const t = v.trim();
    if ([...t].length > STILLS_MAX) return { error: `Не длиннее ${STILLS_MAX} знаков` };
    if (t) out[k] = t;
  }
  if (!out.film) return { error: 'Напиши фильм или сериал' };
  return out as StillsAsk;
}

/** Что показать в редакторе: идёт ли поиск — по stills.json и отметке в found/tmdb.json; без отметки дольше STILLS_WAIT —
 *  сессия не ответила (поиск можно попросить снова). */
export function stillsState(can: boolean, request: unknown, found: unknown, character: { film?: string; name?: string; actor?: string } | null | undefined,
  now: Date = new Date()): StillsState {
  const r = request && typeof request === 'object' ? request as Partial<StillsRequest> : null;
  const f = found && typeof found === 'object' ? found as { request?: unknown; error?: unknown } : null;
  const asked = typeof r?.at === 'string' ? r.at : null;
  const waiting = asked !== null && f?.request !== asked;
  const stale = waiting && !(now.getTime() - Date.parse(asked as string) < STILLS_WAIT);
  const pending = waiting && !stale;
  const error = stale ? 'Claude не ответил — попробуй ещё раз' : asked !== null && f?.request === asked && typeof f.error === 'string' ? f.error : null;
  const from = r && typeof r.film === 'string' ? r : character ?? {};
  const ask = Object.fromEntries(FIELDS.flatMap((k) => (typeof from[k] === 'string' && from[k] ? [[k, from[k]]] : []))) as StillsAsk;
  return { can, pending, error, ask: { ...ask, film: ask.film ?? '' } };
}

/** Запрос в ветку задачи и запуск рутины `stills` (попытка 1: шагом задачи он не считается). Не запустилась — запрос
 *  убирается (редактор не ждёт сессию, которой нет) и ошибка — дальше. */
export async function askStills(d: { gh: GH; routine: Routine }, id: string, ask: StillsAsk, now: Date): Promise<{ sessionUrl: string }> {
  const request: StillsRequest = { ...ask, at: now.toISOString().replace(/\.\d{3}Z$/, 'Z') };
  const path = `${jobDir(id)}/stills.json`;
  await commitFiles(d.gh, jobBranch(id), { [path]: `${JSON.stringify(request, null, 2)}\n` }, `web(${id}): ещё кадры`);
  try {
    const { sessionUrl } = await fireRoutine(d.routine, id, 'stills', 1);
    return { sessionUrl };
  } catch (e) {
    await commitFiles(d.gh, jobBranch(id), { [path]: null }, `web(${id}): ещё кадры — не запустилось`).catch(() => undefined);
    throw e;
  }
}

/** Знает ли движок задачи «Найти ещё кадры» (схема stills.json в её ветке). */
export async function stillsKnown(gh: GH, head: string): Promise<boolean> {
  return (await readText(gh, head, STILLS_SCHEMA)) !== null;
}
