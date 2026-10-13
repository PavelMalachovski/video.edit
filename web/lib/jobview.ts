// Состояние задачи для страницы: файлы ветки claude/job-<id> на коммите (содержимое коммита неизменно — ответы
// запоминаются по `head:path`), из них — экран задачи, «завис» и какие действия сейчас можно.
import type { BrandLook } from './brand.ts';
import { getHead, listDir, readText } from './branch.ts';
import { findReleaseByTag, getRelease, listAllAssets, type GH, type Release } from './github.ts';
import {
  coverName, finalNames, parseQuestions, parseResult, parseReview, parseStatus, parseStyles, wantedVersion,
  type AnswersFile, type FixFile, type JobFile, type Question, type Released, type RestyleFile, type ResultFile, type Review, type Status, type Styles,
  type UploadRef,
} from './jobfiles.ts';
import { jobBranch, jobDir, jobTag } from './jobs.ts';
import type { Step } from './routine.ts';
import { parseScript, type Script, type ScriptRequest } from './script.ts';

export type JobFiles = {
  head: string;
  full: boolean; // прочитаны все файлы (страница задачи), а не только нужные списку
  job: JobFile | null;
  status: Status | null;
  statusBroken: boolean;
  questions: Question[] | null;
  styles: Styles | null;
  review: Review | null;
  script: Script | null; // сценарий задачи-сценария (script.json)
  answers: AnswersFile | null;
  result: ResultFile | null;
  fix: FixFile | null;
  restyle: RestyleFile | null;
  released: Released | null;
};

export type Screen = 'uploading' | 'not_started' | 'working' | 'questions' | 'result' | 'script' | 'error';
export type JobView = {
  id: string;
  /** `script` — задача-сценарий: видео нет, итог — script.json. */
  kind: 'video' | 'script';
  title: string;
  createdAt: string;
  duration: number | null;
  screen: Screen;
  status: Status | null;
  stuck: null | 'session' | 'delivery';
  step: Step | null;
  attempt: number;
  sessionUrl: string | null;
  version: number;
  /** Готовый ролик; `b` — вторая версия A/B-теста, если она тоже доставлена. */
  final: { mp4: string; srt: string | null; b?: { mp4: string; srt: string | null }; ad?: { mp4: string; srt: string | null }; cover?: string } | null;
  previous: string | null;
  /** В задаче есть озвучка (`kind: audio`): сорвался анализ — можно повторить его без неё, не загружая видео заново. */
  voice: boolean;
};
export type Action = 'start' | 'answers' | 'restyle' | 'fix' | 'retry' | 'unvoice' | 'back' | 'delete';

/** Ответ `GET /api/jobs/<id>`: экран и файлы ветки, которые нужны странице задачи. */
export type JobData = {
  view: JobView;
  releaseId: number;
  questions: Question[] | null;
  styles: Styles | null;
  review: Review | null;
  script: Script | null;
  scriptRequest: ScriptRequest | null;
  brief: string; // ТЗ задачи (job.json)
  answers: AnswersFile | null;
  result: ResultFile | null;
  fixes: FixFile['fixes'];
  restyles: RestyleFile['requests'];
  uploads: UploadRef[];
  repo: string;
  head: string | null;
  /** «Мой стиль» бренда, скопированный в задачу при старте (job.json.brand.look): с него — превью и ответы по умолчанию. */
  brandLook: BrandLook | null;
};

/** Сколько состояние может не меняться, пока страница не скажет «завис». */
export const STUCK_MS = { queued: 600_000, analyzing: 1_500_000, rendering: 1_500_000, delivery: 600_000 } as const;

// ---------- файлы на коммите ----------

const CACHE = new Map<string, string | null>(); // `${head}:${path}` → текст файла или null (нет файла)
const CACHE_LIMIT = 2000;

function remember(key: string, value: string | null): void {
  CACHE.set(key, value);
  if (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value as string);
}

// Помним только найденное: «нет файла» сразу после пуша бывает мимолётным — следующий опрос спросит снова.
async function cachedText(gh: GH, head: string, path: string): Promise<string | null> {
  const key = `${head}:${path}`;
  if (CACHE.has(key)) return CACHE.get(key) ?? null;
  const text = await readText(gh, head, path);
  if (text !== null) remember(key, text);
  return text;
}

async function cachedNames(gh: GH, head: string, dir: string): Promise<Set<string> | null> {
  const key = `${head}:${dir}/`;
  if (!CACHE.has(key)) {
    const entries = await listDir(gh, head, dir);
    if (!entries) return null;
    remember(key, JSON.stringify(entries.map((e) => e.name)));
  }
  return new Set(JSON.parse(CACHE.get(key) as string) as string[]);
}

function parse<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Файл папки задачи на коммите `head` текстом (с тем же запоминанием, что у readJobFiles); нет — null. */
export function readJobText(gh: GH, id: string, head: string, name: string): Promise<string | null> {
  return cachedText(gh, head, `${jobDir(id)}/${name}`);
}

const LIST_FILES = ['job.json', 'status.json', 'fix.json'];
const ALL_FILES = [...LIST_FILES, 'questions.json', 'styles.json', 'review.json', 'script.json', 'answers.json', 'result.json', 'restyle.json'];

/**
 * Файлы задачи на коммите `head` (`list` — только нужные списку задач). Папки задачи нет — null; файла нет или
 * в нём не JSON — null (у статуса ещё `statusBroken`).
 */
export async function readJobFiles(gh: GH, id: string, head: string, parts: 'list' | 'all' = 'all'): Promise<JobFiles | null> {
  const dir = jobDir(id);
  const names = await cachedNames(gh, head, dir);
  if (!names) return null;
  const wanted = (parts === 'list' ? LIST_FILES : ALL_FILES).filter((name) => names.has(name));
  const texts = new Map(await Promise.all(wanted.map(async (name) => [name, await cachedText(gh, head, `${dir}/${name}`)] as const)));
  const json = <T>(name: string) => parse<T>(texts.get(name) ?? null);
  const statusText = texts.get('status.json') ?? null;
  const status = parseStatus(parse(statusText));
  return {
    head,
    full: parts === 'all',
    job: json<JobFile>('job.json'),
    status,
    statusBroken: statusText !== null && status === null,
    questions: parseQuestions(json<unknown>('questions.json')),  // файлы сессии — по форме: кривой файл как нет файла
    styles: parseStyles(json<unknown>('styles.json')),
    review: parseReview(json<unknown>('review.json')),
    script: parseScript(json<unknown>('script.json')),
    answers: json<AnswersFile>('answers.json'),
    result: parseResult(json<unknown>('result.json')),
    fix: json<FixFile>('fix.json'),
    restyle: json<RestyleFile>('restyle.json'),
    released: names.has('out') ? parse<Released>(await cachedText(gh, head, `${dir}/out/released.json`)) : null,
  };
}

// ---------- экран ----------

const versionOf = (name: string): number | null => {
  if (name === 'final.mp4') return 1;
  const m = /^final-v(\d{1,3})\.mp4$/.exec(name);
  return m ? Number(m[1]) : null;
};

export function deriveView(release: Release, files: JobFiles | null, now: number): JobView {
  const id = release.tag_name.replace(/^job-/, '');
  const job = files?.job ?? null;
  const runs = job?.runs ?? [];
  const last = runs.at(-1);
  const version = wantedVersion(files?.fix ?? null);
  const delivered = files?.released?.assets.map((a) => a.name) ?? [];
  const older = delivered.map((name) => [name, versionOf(name)] as const).filter(([, v]) => v !== null && v < version);
  const view: JobView = {
    id,
    kind: job?.kind === 'script' ? 'script' : 'video',
    title: job ? (job.videos && job.videos.length > 1 ? `${job.name} + ${job.videos.length - 1}` : job.name) : release.name ?? id,
    createdAt: job?.createdAt ?? release.created_at ?? '',
    duration: job?.duration ?? null,
    screen: 'working',
    status: files?.status ?? null,
    stuck: null,
    step: last?.step ?? null,
    attempt: last?.attempt ?? 0,
    sessionUrl: last?.sessionUrl ?? null,
    version,
    final: null,
    previous: older.length ? older.reduce((a, b) => ((b[1] ?? 0) > (a[1] ?? 0) ? b : a))[0] : null,
    voice: (job?.uploads ?? []).some((u) => u.kind === 'audio'),
  };
  if (!files || runs.length === 0) {
    return { ...view, screen: release.assets.some((a) => a.name === 'manifest.json') ? 'not_started' : 'uploading' };
  }
  const names = finalNames(version);
  if (delivered.includes(names.mp4)) {
    const b = finalNames(version, 'b');
    const second = delivered.includes(b.mp4) ? { b: { mp4: b.mp4, srt: delivered.includes(b.srt) ? b.srt : null } } : {};
    const cover = delivered.includes(coverName(version)) ? { cover: coverName(version) } : {};
    const a = finalNames(version, 'ad');
    const ad = delivered.includes(a.mp4) ? { ad: { mp4: a.mp4, srt: delivered.includes(a.srt) ? a.srt : null } } : {};
    return { ...view, screen: 'result', final: { mp4: names.mp4, srt: delivered.includes(names.srt) ? names.srt : null, ...second, ...ad, ...cover } };
  }
  const status = files.status;
  if (!status) {
    const at = last?.at ?? new Date(now).toISOString();
    return { ...view, screen: 'error', status: { state: 'error', phase: 'Ошибка', message: 'Сессия не оставила статус', at, error: files.statusBroken ? 'status.json не читается' : null } };
  }
  const age = now - Date.parse(status.at);
  if (status.state === 'error') return { ...view, screen: 'error' };
  if (status.state === 'script_ready') {
    if (!files.full || files.script) return { ...view, screen: 'script' };
    const error = { state: 'error' as const, phase: 'Ошибка', message: 'Claude не оставил сценарий — повторите шаг', at: status.at,
      error: 'script.json нет или не по схеме' };
    return { ...view, screen: 'error', status: error };
  }
  if (status.state === 'waiting_answers') {
    if (!files.full || (files.questions && files.styles)) return { ...view, screen: 'questions' };
    const error = { state: 'error' as const, phase: 'Ошибка', message: 'Claude не оставил вопросы или стили — повторите шаг', at: status.at,
      error: 'questions.json или styles.json нет или не по схеме' };
    return { ...view, screen: 'error', status: error };
  }
  const state = status.state;
  // длинный ролик дольше расшифровывается и монтируется: на каждые 5 минут видео сверх первых — ещё столько же
  const scale = Math.max(1, (view.duration ?? 0) / 300);
  const limit = state === 'queued' ? STUCK_MS.queued : state === 'analyzing' || state === 'rendering' ? STUCK_MS[state] * scale : null;
  const stuck = limit !== null && age > limit ? 'session' : state === 'rendered' && age > STUCK_MS.delivery ? 'delivery' : null;
  return { ...view, screen: 'working', stuck };
}

/** Шаг полосы «Загрузка · Текст · Вопросы · Превью · Монтаж», на котором ролик; 5 — всё пройдено. */
export function stepIndex(v: JobView): number {
  switch (v.screen) {
    case 'uploading': return 0;
    case 'not_started': return 1;
    case 'questions': return 2;
    case 'result': return 5;
    default: return v.step === 'restyle' ? 3 : v.step === 'render' || v.step === 'fix' ? 4 : 1;
  }
}

/** null — действие можно; иначе — почему нельзя, по-русски. */
export function canRun(v: JobView, a: Action): string | null {
  switch (a) {
    case 'start':
      return v.screen === 'not_started' ? null : v.screen === 'uploading' ? 'Видео ещё загружается' : 'Анализ уже запущен';
    case 'answers':
    case 'restyle':
      return v.screen === 'questions' ? null : 'Сейчас Claude не ждёт ответов';
    case 'fix':
      return v.screen === 'result' ? null : 'Поправить можно готовый ролик';
    case 'retry':
      return v.screen === 'error' || v.stuck ? null : 'Повторять нечего: шаг идёт';
    case 'unvoice':
      if (!v.voice) return 'Озвучки нет — повторите шаг';
      return v.screen === 'error' && v.step === 'analyze' ? null : 'Без озвучки повторяется только сорвавшийся анализ';
    case 'back':
      return v.screen === 'error' && (v.step === 'restyle' || v.step === 'render' || v.step === 'fix') ? null : 'Вернуться некуда: шаг можно только повторить';
    case 'delete':
      return v.screen === 'working' && !v.stuck ? 'Claude ещё работает — дождитесь или перезапустите шаг' : null;
  }
}

// ---------- задача целиком ----------

const RELEASE_IDS = new Map<string, number>(); // id задачи → id её черновика (тег ищется списком только раз)

export async function loadJob(gh: GH, id: string, parts: 'list' | 'all' = 'all'): Promise<{ release: Release; files: JobFiles | null; view: JobView } | null> {
  let release: Release | null = null;
  const known = RELEASE_IDS.get(id);
  if (known !== undefined) release = await getRelease(gh, known);
  if (!release) {
    release = await findReleaseByTag(gh, jobTag(id));
    if (!release) {
      RELEASE_IDS.delete(id);
      return null;
    }
    RELEASE_IDS.set(id, release.id);
  }
  const head = await getHead(gh, jobBranch(id));
  const files = head ? await readJobFiles(gh, id, head, parts) : null;
  if (!files?.job?.runs.length) release = { ...release, assets: await listAllAssets(gh, release.id) }; // сотни кусков — в релизе не все
  return { release, files, view: deriveView(release, files, Date.now()) };
}
