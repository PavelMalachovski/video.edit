// Файлы задачи jobs/<id>/ в ветке claude/job-<id> — контракт страницы и сессии монтажа. Типы повторяют схемы движка
// (engine/vm/schemas/*.json; тесты сверяют перечни с ними). Страница пишет job.json, answers.json, restyle.json,
// fix.json; сессия — status.json, questions.json, styles.json, result.json; Action — out/released.json.
import { isUploadFile, isVoiceFile, MAX_NOTE } from './jobs.ts';
import type { Step } from './routine.ts';
import type { Brand } from './brand.ts';
import type { ScriptRequest } from './script.ts';

// ---------- status.json ----------

export const STATES = ['uploading', 'queued', 'analyzing', 'waiting_answers', 'rendering', 'rendered', 'script_ready', 'error'] as const;
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
export const RESERVED = { hook: 'hook', end: 'end', own: 'own', upload: 'upload', none: 'none' } as const;
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
export const SAMPLE_INSERT_KINDS = ['image', 'badge', 'sticker', 'text', 'anim'] as const;
/** Вставка на кадре превью; `id` — у стикера-тезиса (kind text): ключ рамки Павла и вариант вопроса stickers. */
export type SampleInsert = {
  kind: (typeof SAMPLE_INSERT_KINDS)[number]; src?: string; text?: string; title?: string; x: number; y: number; w: number; question?: string;
  id?: string; params?: Record<string, unknown>;
};
export type Styles = {
  frame: string;
  frameTime: number;
  sample: { hook?: string; words: string[]; spoken: number; inserts?: SampleInsert[]; end?: { lines: string[]; handle?: string | null; logo?: string | null } };
  variants: { id: 'A' | 'B' | 'C'; label: string; spec: StyleSpec }[];
  /** Шрифты, в которых есть все буквы ролика (`vm fonts`); нет поля — годятся все. */
  fonts?: { main: string[]; hand: string[] };
  /** Обложка: до трёх кадров исходника (`t` — с, `image` — картинка от папки задачи) и текст — хук. */
  cover?: { frames: { t: number; image: string }[]; text: string };
};
/** Обложка: кадров на выбор и длина текста (как в схемах styles.json и answers.json). */
export const COVER = { frames: 3, text: 80 };
/** Выбор обложки на превью: какой кадр (номер в styles.cover.frames) и текст. */
export type CoverChoice = { frame: number; text: string };
export const isCoverChoice = (c: unknown): c is CoverChoice => isObject(c) && Number.isInteger(c.frame) && (c.frame as number) >= 0
  && (c.frame as number) < COVER.frames && isStr(c.text) && c.text.trim() !== '' && c.text.trim().length <= COVER.text;
/** Выбор Павла на превью; `subY` и `hookY` — куда он перетащил субтитры (центр блока) и хук (центр строки капсом),
 *  px кадра; `subSize` и `hookSize` — их размер, px; нет — как в варианте (пределы — ADJUST). */
export type StyleChoice = {
  variant: 'A' | 'B' | 'C'; font: string; hand: string; colors: { text: string; accent: string; bar: string }; subY?: number; hookY?: number; subSize?: number; hookSize?: number;
};
/** Где могут стоять субтитры (центр блока): блок не выходит из безопасной зоны 120–1530 px. */
export const SUB_Y = { min: 240, max: 1440 };
/** Где может стоять хук (центр строки капсом): его рамка — от y − 75 до y + 200 — не выходит из безопасной зоны. */
export const HOOK_Y = { min: 200, max: 1330 };
export const SUB_SIZE = { min: 40, max: 110 };
export const HOOK_SIZE = { min: 48, max: 120 };
/** Что Павел настраивает на превью: поле выбора → часть и поле StyleSpec, пределы и шаг (то же — ADJUSTED в engine/vm/style.py). */
export const ADJUST = {
  subY: { part: 'subtitles', field: 'y', range: SUB_Y, step: 10 },
  hookY: { part: 'hook', field: 'y', range: HOOK_Y, step: 10 },
  subSize: { part: 'subtitles', field: 'size', range: SUB_SIZE, step: 2 },
  hookSize: { part: 'hook', field: 'size', range: HOOK_SIZE, step: 2 },
} as const;
export type Adjustable = keyof typeof ADJUST;
export const ADJUSTABLE = Object.keys(ADJUST) as Adjustable[];
export const inRange = (key: Adjustable, x: unknown): x is number => isNum(x) && x >= ADJUST[key].range.min && x <= ADJUST[key].range.max;

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
  const insertOk = (i: unknown) => isObject(i) && (SAMPLE_INSERT_KINDS as readonly string[]).includes(i.kind as string) && isNum(i.x) && isNum(i.y) && isNum(i.w) && i.w > 0
    && (i.id === undefined || (isStr(i.id) && /^[a-z0-9_-]{1,24}$/.test(i.id))) && (i.params === undefined || isObject(i.params));
  if (sample.inserts !== undefined && !(Array.isArray(sample.inserts) && sample.inserts.every(insertOk))) return null;
  const end = sample.end;
  if (end !== undefined && !(isObject(end) && Array.isArray(end.lines) && end.lines.length >= 1 && end.lines.length <= 2 && end.lines.every((l) => isStr(l) && l !== '')
    && (end.handle == null || isStr(end.handle)) && (end.logo == null || isStr(end.logo)))) return null;  // null — поля нет в бренде
  const ids = (x: unknown) => Array.isArray(x) && x.every((i) => isStr(i) && i !== '');
  if (raw.fonts !== undefined && !(isObject(raw.fonts) && ids(raw.fonts.main) && ids(raw.fonts.hand))) return null;
  const v = raw.variants;
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x, k) => isObject(x) && x.id === 'ABC'[k] && isStr(x.label) && isSpec(x.spec))) return null;
  const { cover, ...rest } = raw;
  const coverOk = isObject(cover) && Array.isArray(cover.frames) && cover.frames.length >= 1 && cover.frames.length <= COVER.frames
    && cover.frames.every((f) => isObject(f) && isNum(f.t) && f.t >= 0 && isStr(f.image) && f.image !== '')
    && isStr(cover.text) && cover.text !== '' && cover.text.length <= COVER.text;
  return { ...rest, ...(coverOk ? { cover } : {}) } as Styles;  // кривая обложка — превью без неё, а не без стилей
}

// ---------- manifest.json и job.json ----------

export type ManifestUpload = { asset: string; name: string; size: number; type: string; parts: number };
export type Manifest = {
  job: string; name: string; size: number; type: string; lastModified: number; parts: number; chunkSize: number;
  userAgent?: string; startedAt?: number; finishedAt?: number; retries?: number; completedAt?: string;
  brief?: string; duration?: number | null; uploads?: ManifestUpload[];
};
/** Вставка Павла к ролику или его озвучка (`audio`): `file` — куда её кладёт `vm fetch` (от папки задачи). */
export type UploadRef = { file: string; asset: string; name: string; size: number; type: string; kind: 'image' | 'video' | 'audio' };
export type Run = { step: Step; attempt: number; at: string; sessionUrl?: string };
export type JobFile = {
  id: string; name: string; size: number; type: string; duration: number | null; createdAt: string;
  brief: string; uploads: UploadRef[]; runs: Run[];
  brand?: Brand; // копия «Моего бренда» на момент старта; логотип — путь от папки задачи (in/brand/logo.png)
  kind?: 'script'; // задача-сценарий: видео нет, сессия пишет script.json (нет поля — видео)
  script?: ScriptRequest; // запрос сценария с экрана «Новый сценарий»
};

export function buildJobFile(m: Manifest, now: Date): JobFile {
  return {
    id: m.job, name: m.name, size: m.size, type: m.type, duration: m.duration ?? null, createdAt: now.toISOString(),
    brief: m.brief ?? '',
    uploads: (m.uploads ?? []).map((u) => ({
      file: `in/uploads/${u.asset}`, asset: u.asset, name: u.name, size: u.size, type: u.type,
      kind: isVoiceFile(u.asset) ? 'audio' : u.type.startsWith('video/') ? 'video' : 'image',
    })),
    runs: [],
  };
}

// ---------- answers.json ----------

/** Вторая версия для A/B-теста: чем она отличается от первой — без тизера или без музыки. */
export const AB_KINDS = ['teaser', 'music'] as const;
export type AbKind = (typeof AB_KINDS)[number];
export type AnswersFile = {
  answers: Record<string, string | string[]>; style: StyleChoice; speed?: number; insertBoxes?: Record<string, InsertBox>; uploads?: Record<string, string>; brief?: string;
  ab?: AbKind;
  cover?: CoverChoice;
  ad?: true; // ещё версия для рекламы Reels
};
export type UploadClaim = { asset: string; name: string; size: number; type: string; parts: number };
export type ParsedAnswers = {
  answers: Record<string, string | string[]>; style: StyleChoice; speed?: number; insertBoxes?: Record<string, InsertBox>; uploads: Record<string, UploadClaim>;
  ab?: AbKind;
  cover?: CoverChoice;
  ad?: true; // ещё версия для рекламы Reels
};
/** Ширина вставки, которую Павел может выбрать на превью, px кадра (ширина безопасной зоны — 830). */
export const INSERT_W = { min: 80, max: 830 };
/** Безопасная зона для вставок, px кадра (как в движке и шаблоне). */
export const INSERT_ZONE = { x0: 60, x1: 890, y0: 120, y1: 1530 };
/** Рамка вставки, которую Павел выбрал на превью: левый верхний угол и ширина, px кадра. */
export type InsertBox = { x: number; y: number; w: number };
export const isInsertBox = (b: unknown): b is InsertBox => isObject(b) && Object.keys(b).length === 3
  && isNum(b.x) && b.x >= INSERT_ZONE.x0 && b.x <= INSERT_ZONE.x1 - INSERT_W.min
  && isNum(b.y) && b.y >= INSERT_ZONE.y0 && b.y <= INSERT_ZONE.y1 - 40
  && isNum(b.w) && b.w >= INSERT_W.min && b.w <= INSERT_W.max;
/** Ускорение, которое Павел может выбрать (по правилам — 1.1). */
export const SPEED_RANGE = { min: 1, max: 1.5 };

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** id шрифта: встроенный (`montserrat`) или свой — имя файла из assets/fonts без расширения (кириллица и пробелы можно). */
const isFontId = (x: unknown): x is string => isStr(x) && x.trim() !== '' && x.length <= 200 && !/[\u0000-\u001f\u007f/\\]/.test(x);

function parseStyle(raw: unknown): StyleChoice | string {
  if (!isObject(raw)) return 'style: нужен объект';
  const { variant, font, hand, colors } = raw;
  if (variant !== 'A' && variant !== 'B' && variant !== 'C') return 'style.variant: A, B или C';
  if (!isFontId(font) || !isFontId(hand)) return 'style: шрифт не такой';
  if (!isObject(colors) || !['text', 'accent', 'bar'].every((k) => typeof colors[k] === 'string' && COLOR.test(colors[k] as string))) {
    return 'style.colors: нужны #RRGGBB для text, accent, bar';
  }
  const adjusted: Partial<Record<Adjustable, number>> = {};
  for (const key of ADJUSTABLE) {
    const x = raw[key];
    if (x === undefined) continue;
    if (!inRange(key, x)) return `style.${key}: от ${ADJUST[key].range.min} до ${ADJUST[key].range.max}`;
    adjusted[key] = x;
  }
  return {
    variant, font, hand, colors: { text: colors.text as string, accent: colors.accent as string, bar: colors.bar as string },
    ...adjusted,
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
  const boxes = body.insertBoxes;
  if (boxes !== undefined && !(isObject(boxes) && !Array.isArray(boxes)
    && Object.entries(boxes).every(([k, b]) => k !== '' && k.length <= 500 && isInsertBox(b)))) {
    return { error: 'insertBoxes: рамка вставки {x, y, w} внутри безопасной зоны' };
  }
  const speed = body.speed;
  if (speed !== undefined && !(isNum(speed) && speed >= SPEED_RANGE.min && speed <= SPEED_RANGE.max)) {
    return { error: `speed: нужно число от ${SPEED_RANGE.min} до ${SPEED_RANGE.max}` };
  }
  const ab = body.ab;
  if (ab !== undefined && !(AB_KINDS as readonly unknown[]).includes(ab)) return { error: `ab: ${AB_KINDS.join(' или ')}` };
  const ad = body.ad;
  if (ad !== undefined && typeof ad !== 'boolean') return { error: 'ad: true или false' };
  const cover = body.cover;
  if (cover !== undefined && !isCoverChoice(cover)) return { error: `cover: кадр 1–${COVER.frames} и текст до ${COVER.text} знаков` };
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
  return {
    answers, style, uploads,
    ...(speed === undefined ? {} : { speed: Math.round(speed * 100) / 100 }),
    ...(boxes === undefined ? {} : { insertBoxes: boxes as Record<string, InsertBox> }),
    ...(ab === undefined ? {} : { ab: ab as AbKind }),
    ...(cover === undefined ? {} : { cover: { frame: cover.frame, text: cover.text.trim() } }),
    ...(ad === true ? { ad: true as const } : {}),
  };
}

export function answersFile(p: ParsedAnswers, job: JobFile): AnswersFile {
  return {
    answers: p.answers,
    style: p.style,
    ...(p.speed === undefined ? {} : { speed: p.speed }),
    ...(p.insertBoxes === undefined ? {} : { insertBoxes: p.insertBoxes }),
    ...(p.ab === undefined ? {} : { ab: p.ab }),
    ...(p.cover === undefined ? {} : { cover: p.cover }),
    ...(p.ad ? { ad: true as const } : {}),
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

/** Имена ролика версии `v` (правка 2 → final-v2); `variant` 'b' — вторая версия A/B-теста (final-b, final-v2-b), 'ad' —
 *  версия для рекламы (final-ad, final-v2-ad). */
export function finalNames(v: number, variant?: 'b' | 'ad'): { mp4: string; srt: string } {
  const base = `${v <= 1 ? 'final' : `final-v${v}`}${variant ? `-${variant}` : ''}`;
  return { mp4: `${base}.mp4`, srt: `${base}.srt` };
}

/** Обложка версии `v`: final-cover.png, final-v2-cover.png. */
export const coverName = (v: number): string => `${v <= 1 ? 'final' : `final-v${v}`}-cover.png`;

/** Имя, которое можно скачать со страницы: всё, что дают finalNames и coverName, и ничего больше. */
export const isFinalName = (name: string): boolean => /^final(-v\d{1,3})?((-b|-ad)?\.(mp4|srt)|-cover\.png)$/.test(name);

// ---------- out/released.json и result.json ----------

export type Released = { release_id: number; assets: { name: string; id: number; size: number }[]; at: string };
type Durations = { source: number; final: number };
type Qa = { ok: boolean; problems: string[] };
/** Чек-лист по гайду (пишет `vm render`, vm.qa.CHECKS): что видно по готовому ролику; подпись к посту — строка страницы. */
export const CHECK_IDS = ['format', 'container', 'audio', 'hook', 'safe', 'subtitles', 'end', 'length'] as const;
export type Check = { id: (typeof CHECK_IDS)[number]; title: string; ok: boolean };
/** Вторая версия A/B-теста: её собирает и проверяет `vm render` (чем отличается, длительности, проверка). */
export type AbResult = { differs: AbKind; durations: Durations; qa: Qa };
export type ResultFile = {
  durations: Durations;
  done: string[];
  unsure: string[];
  missing: string[];
  qa: Qa;
  caption?: unknown; // подпись к посту — проверяет parseCaption (lib/caption.ts)
  ab?: AbResult;
  ad?: { durations: Durations; qa: Qa }; // версия для рекламы: длительности и проверка по зоне рекламы
  checklist?: Check[];
};

const isDurations = (d: unknown): d is Durations => isObject(d) && isNum(d.source) && isNum(d.final);
const isQa = (qa: unknown): qa is Qa => isObject(qa) && typeof qa.ok === 'boolean' && Array.isArray(qa.problems) && qa.problems.every(isStr);

const isCheck = (c: unknown): c is Check =>
  isObject(c) && (CHECK_IDS as readonly unknown[]).includes(c.id) && isStr(c.title) && typeof c.ok === 'boolean';

/** result.json (его дописывает и сессия) → итоги; не та форма — null: экран «Готово» покажет ролик без итогов.
 *  Не та форма у `ab` или `checklist` — его нет, остальное остаётся. */
export function parseResult(raw: unknown): ResultFile | null {
  if (!isObject(raw) || !isDurations(raw.durations)) return null;
  const lists = ['done', 'unsure', 'missing'].every((k) => Array.isArray(raw[k]) && (raw[k] as unknown[]).every(isStr));
  if (!lists || !isQa(raw.qa)) return null;
  const { ab, ad, checklist, ...rest } = raw;
  const abOk = isObject(ab) && (AB_KINDS as readonly unknown[]).includes(ab.differs) && isDurations(ab.durations) && isQa(ab.qa);
  const checksOk = Array.isArray(checklist) && checklist.every(isCheck);
  return {
    ...(rest as Omit<ResultFile, 'ab' | 'ad' | 'checklist'>),
    ...(abOk ? { ab: ab as AbResult } : {}),
    ...(checksOk ? { checklist: checklist as Check[] } : {}),
    ...(isObject(ad) && isDurations(ad.durations) && isQa(ad.qa) ? { ad: { durations: ad.durations, qa: ad.qa } } : {}),
  };
}

// ---------- review.json (разбор по гайду: пишет сессия на шаге analyze, страница показывает над вопросами) ----------

export const REVIEW_IDS = ['hook', 'face', 'value', 'cta', 'text', 'length', 'sound', 'story'] as const;
export type ReviewItem = { id: (typeof REVIEW_IDS)[number]; title: string; status: 'ok' | 'warn'; note: string };
export type Review = { items: ReviewItem[] };

/** review.json → разбор; не та форма — null: экран вопросов покажет вопросы без разбора. */
export function parseReview(raw: unknown): Review | null {
  if (!isObject(raw) || !Array.isArray(raw.items) || raw.items.length === 0) return null;
  const good = raw.items.every((it) => isObject(it) && (REVIEW_IDS as readonly unknown[]).includes(it.id) && isStr(it.title) && it.title !== ''
    && (it.status === 'ok' || it.status === 'warn') && isStr(it.note));
  return good ? { items: raw.items as ReviewItem[] } : null;
}

/** Подписи двух роликов на экране «Готово»: без чего собрана версия B. */
export function abLabels(differs: AbKind | null): [string, string] {
  if (!differs) return ['A', 'B'];
  return differs === 'music' ? ['A — с музыкой', 'B — без музыки'] : ['A — с тизером', 'B — без тизера'];
}

