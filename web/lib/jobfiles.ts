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

/** Статус после «назад» со сорвавшегося шага: снова ждём ответов (restyle, render) или остаётся готовый ролик (fix). */
export function backStatus(step: Step, now: Date): Status {
  const at = now.toISOString();
  if (step === 'fix') return { state: 'rendered', phase: 'Готово', message: 'Правка не получилась — остался прежний ролик', at, needs: null, progress: null, error: null };
  const message = step === 'restyle' ? 'Новые варианты не получились — выбери из прежних или попроси иначе' : 'Монтаж не получился — поправь ответы или стиль и запусти снова';
  return { state: 'waiting_answers', phase: 'Ждёт ответов', message, at, needs: 'answers', progress: null, error: null };
}

// ---------- questions.json ----------

export const QUESTION_TYPES = ['choice', 'text', 'word', 'insert', 'multi'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export type Option = { id: string; label: string; image?: string };
export type Question = { id: string; type: QuestionType; title: string; body?: string; options?: Option[]; default?: string | string[]; image?: string };

/** Зарезервированные id: вопрос `hook` (его ответ — хук превью); варианты «свой текст», «своя картинка», «не надо». */
export const RESERVED = { hook: 'hook', own: 'own', upload: 'upload', none: 'none' } as const;
export const ownKey = (qid: string): string => `${qid}.own`;

/** questions.json сессии → вопросы; не та форма — null (страница скажет, что вопросов нет, и даст повторить шаг). */
export function parseQuestions(raw: unknown): Question[] | null {
  const list = isObject(raw) ? raw.questions : null;
  if (!Array.isArray(list)) return null;
  const optionOk = (o: unknown) => isObject(o) && isStr(o.id) && o.id !== '' && isStr(o.label) && (o.image === undefined || isStr(o.image));
  for (const q of list) {
    if (!isObject(q) || !isStr(q.id) || q.id === '' || !QUESTION_TYPES.includes(q.type as QuestionType) || !isStr(q.title)) return null;
    if ((q.body !== undefined && !isStr(q.body)) || (q.image !== undefined && !isStr(q.image))) return null;
    if (q.options !== undefined && !(Array.isArray(q.options) && q.options.every(optionOk))) return null;
    if (q.default !== undefined && !isStr(q.default) && !(Array.isArray(q.default) && q.default.every(isStr))) return null;
  }
  return list as Question[];
}

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
  /** Шрифты, в которых есть все буквы ролика (`vm fonts`); нет поля — годятся все. */
  fonts?: { main: string[]; hand: string[] };
};
/** Выбор Павла на превью; `subY` — куда он перетащил субтитры (центр блока, px кадра), нет — как в варианте. */
export type StyleChoice = { variant: 'A' | 'B' | 'C'; font: string; hand: string; colors: { text: string; accent: string; bar: string }; subY?: number };
/** Где могут стоять субтитры (центр блока): блок не выходит из безопасной зоны 120–1530 px. */
export const SUB_Y = { min: 240, max: 1440 };

function isSpec(s: unknown): s is StyleSpec {
  if (!isObject(s) || !isFontId(s.font) || !isFontId(s.hand) || !isObject(s.colors)) return false;
  const colors = s.colors;
  if (!['text', 'accent', 'bar', 'plate', 'outline'].every((k) => isStr(colors[k]) && COLOR.test(colors[k] as string))) return false;
  const { subtitles: sub, hook, bar } = s;
  return isObject(sub) && ['karaoke', 'plate', 'word', 'accumulate'].includes(sub.mode as string) && Number.isInteger(sub.words)
    && (sub.words as number) >= 2 && (sub.words as number) <= 6 && isNum(sub.size) && sub.size > 0 && isNum(sub.y)
    && isObject(hook) && ['plate', 'outline', 'shadow'].includes(hook.mode as string) && isNum(hook.size) && hook.size > 0
    && (hook.y === undefined || isNum(hook.y))
    && isObject(bar) && (bar.pos === 'bottom' || bar.pos === 'top') && isNum(bar.height) && bar.height > 0;
}

/** styles.json сессии → стили для превью; не та форма — null. */
export function parseStyles(raw: unknown): Styles | null {
  if (!isObject(raw) || !isStr(raw.frame) || raw.frame === '' || !isNum(raw.frameTime) || raw.frameTime < 0) return null;
  const sample = raw.sample;
  if (!isObject(sample) || !Array.isArray(sample.words) || !sample.words.every(isStr) || !Number.isInteger(sample.spoken) || (sample.spoken as number) < 0) return null;
  if (sample.hook !== undefined && !isStr(sample.hook)) return null;
  const insertOk = (i: unknown) => isObject(i) && ['image', 'badge', 'sticker', 'anim'].includes(i.kind as string) && isNum(i.x) && isNum(i.y) && isNum(i.w) && i.w > 0;
  if (sample.inserts !== undefined && !(Array.isArray(sample.inserts) && sample.inserts.every(insertOk))) return null;
  const ids = (x: unknown) => Array.isArray(x) && x.every((i) => isStr(i) && i !== '');
  if (raw.fonts !== undefined && !(isObject(raw.fonts) && ids(raw.fonts.main) && ids(raw.fonts.hand))) return null;
  const v = raw.variants;
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x, k) => isObject(x) && x.id === 'ABC'[k] && isStr(x.label) && isSpec(x.spec))) return null;
  return raw as Styles;
}

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

export type AnswersFile = { answers: Record<string, string | string[]>; style: StyleChoice; speed?: number; uploads?: Record<string, string>; brief?: string };
export type UploadClaim = { asset: string; name: string; size: number; type: string; parts: number };
export type ParsedAnswers = { answers: Record<string, string | string[]>; style: StyleChoice; speed?: number; uploads: Record<string, UploadClaim> };
/** Ускорение, которое Павел может выбрать (по правилам — 1.1). */
export const SPEED_RANGE = { min: 1, max: 1.5 };

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** id шрифта: встроенный (`montserrat`) или свой — имя файла из assets/fonts без расширения (кириллица и пробелы можно). */
const isFontId = (x: unknown): x is string => isStr(x) && x.trim() !== '' && x.length <= 200 && !/[\u0000-\u001f\u007f/\\]/.test(x);

function parseStyle(raw: unknown): StyleChoice | string {
  if (!isObject(raw)) return 'style: нужен объект';
  const { variant, font, hand, colors, subY } = raw;
  if (variant !== 'A' && variant !== 'B' && variant !== 'C') return 'style.variant: A, B или C';
  if (!isFontId(font) || !isFontId(hand)) return 'style: шрифт не такой';
  if (!isObject(colors) || !['text', 'accent', 'bar'].every((k) => typeof colors[k] === 'string' && COLOR.test(colors[k] as string))) {
    return 'style.colors: нужны #RRGGBB для text, accent, bar';
  }
  if (subY !== undefined && !(isNum(subY) && subY >= SUB_Y.min && subY <= SUB_Y.max)) return `style.subY: от ${SUB_Y.min} до ${SUB_Y.max}`;
  return {
    variant, font, hand, colors: { text: colors.text as string, accent: colors.accent as string, bar: colors.bar as string },
    ...(subY === undefined ? {} : { subY }),
  };
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
  const speed = body.speed;
  if (speed !== undefined && !(isNum(speed) && speed >= SPEED_RANGE.min && speed <= SPEED_RANGE.max)) {
    return { error: `speed: нужно число от ${SPEED_RANGE.min} до ${SPEED_RANGE.max}` };
  }
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
  return { answers, style, uploads, ...(speed === undefined ? {} : { speed: Math.round(speed * 100) / 100 }) };
}

export function answersFile(p: ParsedAnswers, job: JobFile): AnswersFile {
  return {
    answers: p.answers,
    style: p.style,
    ...(p.speed === undefined ? {} : { speed: p.speed }),
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

/** result.json (его дописывает и сессия) → итоги; не та форма — null: экран «Готово» покажет ролик без итогов. */
export function parseResult(raw: unknown): ResultFile | null {
  if (!isObject(raw) || !isObject(raw.durations) || !isNum(raw.durations.source) || !isNum(raw.durations.final)) return null;
  const lists = ['done', 'unsure', 'missing'].every((k) => Array.isArray(raw[k]) && (raw[k] as unknown[]).every(isStr));
  const qa = raw.qa;
  if (!lists || !isObject(qa) || typeof qa.ok !== 'boolean' || !Array.isArray(qa.problems) || !qa.problems.every(isStr)) return null;
  return raw as ResultFile;
}

