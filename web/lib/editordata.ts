// Данные редактора (бета): черновик монтажа (edit.json), файлы редактора от vm prepare (editor.json), ссылки на прокси
// (ассет черновика релиза — через /media) и ленту кадров (картинка ветки — через /file), стили и выбор Павла. Правки
// руками — timeline.json: сохранение с ревизией (без force, гонка вкладок — конфликт) и «Монтировать» из редактора.
import { commitFiles } from './branch.ts';
import { parseTimeline, type HandEdits, type TimelineFile } from './edits.ts';
import { sameJson } from './equal.ts';
import type { GH } from './github.ts';
import { appendFix, parseStyle, type AnswersFile, type FixFile, type Released, type Styles } from './jobfiles.ts';
import { jobBranch, jobDir } from './jobs.ts';
import { loadJob, readJobText, type Screen } from './jobview.ts';
import { parseDraft, parseMedia, type Draft, type EditorMedia } from './tracks.ts';

/** Что редактор отдаёт плееру из релиза: только прокси (готовый ролик — через download). */
export const MEDIA_NAMES = ['proxy.mp4'] as const;
export type MediaName = (typeof MEDIA_NAMES)[number];
export const isMediaName = (x: string): x is MediaName => (MEDIA_NAMES as readonly string[]).includes(x);

export type EditorData = {
  id: string;
  title: string;
  screen: Screen;
  head: string | null;
  draft: Draft | null;
  media: EditorMedia | null;
  proxyUrl: string | null; // прокси уже в релизе (Action перенёс)
  filmUrl: string | null;
  styles: Styles | null;
  answers: AnswersFile | null;
  timeline: TimelineFile | null; // правки руками (нет или кривой файл — null)
  rev: number; // ревизия timeline.json в ветке (нет — 0): от неё сохраняется следующая
};

/** Ассет `name` из out/released.json ветки; не файл редактора или его нет — null. */
export function mediaAsset(files: { released: Released | null } | null, name: string): { id: number; name: string } | null {
  if (!isMediaName(name)) return null;
  return files?.released?.assets.find((a) => a.name === name) ?? null;
}

const json = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export async function loadEditor(gh: GH, id: string): Promise<EditorData | null> {
  const loaded = await loadJob(gh, id, 'all');
  if (!loaded) return null;
  const f = loaded.files;
  const head = f?.head ?? null;
  const [edit, editor, timeline] = head
    ? await Promise.all(['edit.json', 'editor.json', TIMELINE].map((name) => readJobText(gh, id, head, name)))
    : [null, null, null];
  const media = parseMedia(json(editor));
  return {
    id,
    title: loaded.view.title,
    screen: loaded.view.screen,
    head,
    draft: parseDraft(json(edit)),
    media,
    proxyUrl: media?.proxy && mediaAsset(f, 'proxy.mp4') ? `/api/jobs/${id}/media?name=proxy.mp4` : null,
    filmUrl: media && head ? `/api/jobs/${id}/file?path=${encodeURIComponent(media.film.file)}&v=${head}` : null,
    styles: f?.styles ?? null,
    answers: f?.answers ?? null,
    ...timelineOf(timeline),
  };
}

// ---------- правки руками: timeline.json ----------

export const TIMELINE = 'timeline.json';

/** Текст timeline.json → ревизия и правки. Кривой файл — правок нет (null), но его ревизия (если есть) остаётся: от неё
 *  страница сохранит новый и так его заменит. Файла нет — ревизия 0. */
export function timelineOf(text: string | null): { rev: number; timeline: TimelineFile | null } {
  const raw = json(text);
  const rev = typeof raw === 'object' && raw !== null && Number.isInteger((raw as { rev?: unknown }).rev) ? Math.max(0, (raw as { rev: number }).rev) : 0;
  return { rev, timeline: parseTimeline(raw) };
}

export type SaveResult =
  | { ok: true; timeline: TimelineFile }
  | { ok: false; status: 400 | 404 | 409; error: string; rev?: number; timeline?: TimelineFile | null };

/** Где правки руками можно сохранять: вопросы (до монтажа), готовый ролик и ошибка — сессия не работает. */
const EDITABLE: readonly Screen[] = ['questions', 'result', 'error'];

class Stale extends Error {
  readonly current: { rev: number; timeline: TimelineFile | null };
  constructor(current: { rev: number; timeline: TimelineFile | null }) {
    super('stale');
    this.current = current;
  }
}

/** Тело PUT от редактора: `base` — ревизия, от которой правил, и правки. Не так — что не так. */
function parseSave(body: unknown): { base: number; hand: HandEdits } | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'нужен объект';
  const { base, ...hand } = body as Record<string, unknown>;
  if (!Number.isInteger(base) || (base as number) < 0) return 'base: ревизия, от которой правки';
  const parsed = parseTimeline({ rev: 1, ...hand });
  if (!parsed || 'rev' in hand || 'at' in hand) return 'правки не той формы';
  const { rev: _rev, ...edits } = parsed;
  return { base: base as number, hand: edits };
}

/**
 * Сохранить правки руками: новая ревизия = `base` + 1, коммит без force. В ветке уже другая ревизия (правили в другой
 * вкладке) — конфликт с тем, что там лежит; проверка — на той голове, поверх которой коммит, на каждой попытке.
 */
export async function saveTimeline(gh: GH, id: string, body: unknown, now: Date): Promise<SaveResult> {
  const parsed = parseSave(body);
  if (typeof parsed === 'string') return { ok: false, status: 400, error: `Правки не сохранились: ${parsed}` };
  const loaded = await loadJob(gh, id, 'list');
  if (!loaded?.files) return { ok: false, status: 404, error: 'Задача не найдена' };
  const screen = loaded.view.screen;
  if (!EDITABLE.includes(screen)) {
    return { ok: false, status: 409, error: screen === 'working' ? 'Claude сейчас монтирует — править можно, когда он закончит' : 'Черновика монтажа ещё нет' };
  }
  const file: TimelineFile = { rev: parsed.base + 1, at: now.toISOString(), ...parsed.hand };
  try {
    await commitFiles(gh, jobBranch(id), async (head) => {
      const current = timelineOf(await readJobText(gh, id, head, TIMELINE));
      if (current.rev !== parsed.base) throw new Stale(current);
      return { [`${jobDir(id)}/${TIMELINE}`]: `${JSON.stringify(file, null, 2)}\n` };
    }, `web(${id}): правки в редакторе, ревизия ${file.rev}`);
  } catch (e) {
    if (e instanceof Stale) return { ok: false, status: 409, error: 'Правки поменялись в другой вкладке', ...e.current };
    throw e;
  }
  return { ok: true, timeline: file };
}

export const EDITOR_FIX = 'Правки в редакторе';

/**
 * «Монтировать» из редактора у готового ролика: правка (fix.json) с ревизией правок руками и, если Павел поменял стиль,
 * новым стилем (answers.json). Тело — `{editor: {timeline?, style?}}`; `rev` — ревизия timeline.json в ветке.
 */
export function editorFix(body: unknown, ctx: { rev: number; answers: AnswersFile | null; fix: FixFile | null }, now: Date):
  { files: Record<string, string> } | { error: string; status: 400 | 409 } {
  const editor = typeof body === 'object' && body !== null ? (body as { editor?: unknown }).editor : undefined;
  if (typeof editor !== 'object' || editor === null) return { error: 'нужен editor', status: 400 };
  const { timeline, style } = editor as { timeline?: unknown; style?: unknown };
  if (timeline !== undefined && !(Number.isInteger(timeline) && (timeline as number) >= 1)) return { error: 'editor.timeline: ревизия правок', status: 400 };
  if (timeline !== undefined && timeline !== ctx.rev) return { error: 'Правки ещё сохраняются — подождите секунду и нажмите снова', status: 409 };
  let next = null;
  if (style !== undefined) {
    const parsed = parseStyle(style);
    if (typeof parsed === 'string') return { error: parsed, status: 400 };
    if (!ctx.answers) return { error: 'Стиль меняется у смонтированного ролика — сначала «Монтировать» на старом экране', status: 409 };
    if (!sameJson(parsed, ctx.answers.style)) next = parsed;
  }
  if (timeline === undefined && !next) return { error: 'Монтировать нечего: правок в редакторе нет', status: 400 };
  const pretty = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
  return {
    files: {
      'fix.json': pretty(appendFix(ctx.fix, EDITOR_FIX, now, { timeline: timeline as number | undefined, ...(next ? { styleFrom: ctx.answers?.style } : {}) })),
      ...(next && ctx.answers ? { 'answers.json': pretty({ ...ctx.answers, style: next }) } : {}),
    },
  };
}
