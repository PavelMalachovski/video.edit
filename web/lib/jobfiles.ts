// Файлы задачи jobs/<id>/ в ветке claude/job-<id> — контракт страницы и сессии монтажа. Типы повторяют схемы движка
// (engine/vm/schemas/*.json; тесты сверяют перечни с ними). Страница пишет job.json, answers.json, restyle.json,
// fix.json; сессия — status.json, questions.json, styles.json, result.json; Action — out/released.json.
import { isUploadFile, MAX_NOTE } from './jobs.ts';
import type { Step } from './routine.ts';

// ---------- status.json ----------

export const STATES = ['uploading', 'queued', 'analyzing', 'waiting_answers', 'rendering', 'rendered', 'error'] as const;
export type State = (typeof STATES)[number];
export type Status = {
  state: State;
  phase: string;
  message: string;
  at: string;
  needs?: 'answers' | null;
  progress?: number | null;
  error?: string | null;
};

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function parseStatus(raw: unknown): Status | null {
  if (!isObject(raw)) return null;
  const { state, phase, message, at } = raw;
  if (!STATES.includes(state as State) || typeof phase !== 'string' || typeof message !== 'string') return null;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  return raw as Status;
}

const QUEUED: Record<Step, string> = {
  analyze: 'Claude скачает видео, расшифрует речь и подготовит вопросы',
  restyle: 'Claude подготовит ещё три варианта',
  render: 'Claude смонтирует ролик по ответам',
  fix: 'Claude переделает ролик по правке',
};

export function queuedStatus(step: Step, now: Date): Status {
  return { state: 'queued', phase: 'Запускаю сессию', message: QUEUED[step], at: now.toISOString(), needs: null, progress: null, error: null };
}

export function errorStatus(message: string, error: string, now: Date): Status {
  return { state: 'error', phase: 'Не запустилось', message, at: now.toISOString(), needs: null, progress: null, error };
}

// ---------- questions.json ----------

export const QUESTION_TYPES = ['choice', 'text', 'word', 'insert', 'multi'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export type Option = { id: string; label: string; image?: string };
export type Question = { id: string; type: QuestionType; title: string; body?: string; options?: Option[]; default?: string | string[]; image?: string };

/** Зарезервированные id: вопрос `hook` (его ответ — хук превью); варианты «свой текст», «своя картинка», «не надо». */
export const RESERVED = { hook: 'hook', own: 'own', upload: 'upload', none: 'none' } as const;
export const ownKey = (qid: string): string => `${qid}.own`;

// ---------- styles.json ----------

export type StyleSpec = {
  font: string;
  hand: string;
  colors: { text: string; accent: string; bar: string; plate: string; outline: string };
  subtitles: { mode: 'karaoke' | 'plate' | 'word' | 'accumulate'; words: number; size: number; y: number };
  hook: { mode: 'plate' | 'outline' | 'shadow'; size: number; y?: number };
  bar: { pos: 'bottom' | 'top'; height: number };
};
export type SampleInsert = { kind: 'image' | 'badge' | 'sticker' | 'anim'; src?: string; text?: string; title?: string; x: number; y: number; w: number; question?: string };
export type Styles = {
  frame: string;
  frameTime: number;
  sample: { hook?: string; words: string[]; spoken: number; inserts?: SampleInsert[] };
  variants: { id: 'A' | 'B' | 'C'; label: string; spec: StyleSpec }[];
};
export type StyleChoice = { variant: 'A' | 'B' | 'C'; font: string; hand: string; colors: { text: string; accent: string; bar: string } };

// ---------- manifest.json и job.json ----------

export type ManifestUpload = { asset: string; name: string; size: number; type: string; parts: number };
export type Manifest = {
  job: string; name: string; size: number; type: string; lastModified: number; parts: number; chunkSize: number;
  userAgent?: string; startedAt?: number; finishedAt?: number; retries?: number; completedAt?: string;
  brief?: string; duration?: number | null; uploads?: ManifestUpload[];
};
/** Вставка Павла к ролику: `file` — куда её кладёт `vm fetch` (от папки задачи). */
export type UploadRef = { file: string; asset: string; name: string; size: number; type: string; kind: 'image' | 'video' };
export type Run = { step: Step; attempt: number; at: string; sessionUrl?: string };
export type JobFile = {
  id: string; name: string; size: number; type: string; duration: number | null; createdAt: string;
  brief: string; uploads: UploadRef[]; runs: Run[];
};

export function buildJobFile(m: Manifest, now: Date): JobFile {
  return {
    id: m.job, name: m.name, size: m.size, type: m.type, duration: m.duration ?? null, createdAt: now.toISOString(),
    brief: m.brief ?? '',
    uploads: (m.uploads ?? []).map((u) => ({
      file: `in/uploads/${u.asset}`, asset: u.asset, name: u.name, size: u.size, type: u.type,
      kind: u.type.startsWith('video/') ? 'video' : 'image',
    })),
    runs: [],
  };
}

// ---------- answers.json ----------

export type AnswersFile = { answers: Record<string, string | string[]>; style: StyleChoice; uploads?: Record<string, string>; brief?: string };
export type UploadClaim = { asset: string; name: string; size: number; type: string; parts: number };
export type ParsedAnswers = { answers: Record<string, string | string[]>; style: StyleChoice; uploads: Record<string, UploadClaim> };

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const FONT = /^[A-Za-z0-9._-]{1,64}$/;

function parseStyle(raw: unknown): StyleChoice | string {
  if (!isObject(raw)) return 'style: нужен объект';
  const { variant, font, hand, colors } = raw;
  if (variant !== 'A' && variant !== 'B' && variant !== 'C') return 'style.variant: A, B или C';
  if (typeof font !== 'string' || !FONT.test(font) || typeof hand !== 'string' || !FONT.test(hand)) return 'style: шрифт не такой';
  if (!isObject(colors) || !['text', 'accent', 'bar'].every((k) => typeof colors[k] === 'string' && COLOR.test(colors[k] as string))) {
    return 'style.colors: нужны #RRGGBB для text, accent, bar';
  }
  return { variant, font, hand, colors: { text: colors.text as string, accent: colors.accent as string, bar: colors.bar as string } };
}

function parseClaim(raw: unknown): UploadClaim | null {
  if (!isObject(raw)) return null;
  const { asset, name, size, type, parts } = raw;
  if (typeof asset !== 'string' || !isUploadFile(asset) || typeof name !== 'string' || typeof type !== 'string') return null;
  if (typeof size !== 'number' || !(size >= 0) || !Number.isInteger(parts) || (parts as number) < 1) return null;
  return { asset, name, size, type, parts: parts as number };
}

/** Тело «Монтировать» → ответы, стиль и загрузки к ответам; что-то не так — `{error}` с тем, что именно. */
export function parseAnswersBody(body: unknown, qs: Question[]): ParsedAnswers | { error: string } {
  if (!isObject(body) || !isObject(body.answers)) return { error: 'нет ответов' };
  const ids = new Set(qs.map((q) => q.id));
  const answers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(body.answers)) {
    const qid = key.endsWith('.own') ? key.slice(0, -4) : key;
    if (!ids.has(qid)) return { error: `answers.${key}: нет такого вопроса` };
    if (typeof value !== 'string' && !(Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
      return { error: `answers.${key}: нужна строка или список строк` };
    }
    answers[key] = value;
  }
  const style = parseStyle(body.style);
  if (typeof style === 'string') return { error: style };
  const uploads: Record<string, UploadClaim> = {};
  const claims = body.uploads === undefined ? {} : body.uploads;
  if (!isObject(claims)) return { error: 'uploads: нужен объект' };
  for (const [qid, raw] of Object.entries(claims)) {
    if (answers[qid] !== RESERVED.upload) return { error: `uploads.${qid}: картинка без ответа «загрузить свою»` };
    const claim = parseClaim(raw);
    if (!claim) return { error: `uploads.${qid}: загрузка не такая` };
    uploads[qid] = claim;
  }
  for (const [qid, value] of Object.entries(answers)) {
    if (value === RESERVED.upload && !uploads[qid]) return { error: `${qid}: выбрано «загрузить свою», а картинки нет` };
  }
  return { answers, style, uploads };
}

export function answersFile(p: ParsedAnswers, job: JobFile): AnswersFile {
  return {
    answers: p.answers,
    style: p.style,
    uploads: Object.fromEntries(Object.entries(p.uploads).map(([qid, c]) => [qid, `in/uploads/${c.asset}`])),
    brief: job.brief,
  };
}

// ---------- restyle.json и fix.json ----------

export type Note = { text: string; at: string };
export type RestyleFile = { requests: Note[] };
export type FixFile = { fixes: (Note & { version: number })[] };

export function parseNote(body: unknown): string | { error: string } {
  const text = isObject(body) && typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { error: 'Напишите, что поменять' };
  if (text.length > MAX_NOTE) return { error: `Слишком длинно: не больше ${MAX_NOTE} знаков` };
  return text;
}

export function appendRestyle(prev: RestyleFile | null, text: string, now: Date): RestyleFile {
  return { requests: [...(prev?.requests ?? []), { text, at: now.toISOString() }] };
}

/** Правка k получает версию k + 1: первый ролик — final.mp4, после первой правки — final-v2.mp4. */
export function appendFix(prev: FixFile | null, text: string, now: Date): FixFile {
  const fixes = prev?.fixes ?? [];
  return { fixes: [...fixes, { text, at: now.toISOString(), version: 2 + fixes.length }] };
}

export const wantedVersion = (fix: FixFile | null): number => 1 + (fix?.fixes.length ?? 0);

export function finalNames(v: number): { mp4: string; srt: string } {
  const base = v <= 1 ? 'final' : `final-v${v}`;
  return { mp4: `${base}.mp4`, srt: `${base}.srt` };
}

// ---------- out/released.json и result.json ----------

export type Released = { release_id: number; assets: { name: string; id: number; size: number }[]; at: string };
export type ResultFile = {
  durations: { source: number; final: number };
  done: string[];
  unsure: string[];
  missing: string[];
  qa: { ok: boolean; problems: string[] };
};

