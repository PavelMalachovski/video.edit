// Данные редактора (бета): черновик монтажа (edit.json), файлы редактора от vm prepare (editor.json), ссылки на прокси
// (ассет черновика релиза — через /media) и ленту кадров (картинка ветки — через /file), стили и выбор Павла.
import type { GH } from './github.ts';
import type { AnswersFile, Released, Styles } from './jobfiles.ts';
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
  const [edit, editor] = head ? await Promise.all([readJobText(gh, id, head, 'edit.json'), readJobText(gh, id, head, 'editor.json')]) : [null, null];
  const media = parseMedia(json(editor));
  return {
    id,
    title: loaded.view.title,
    screen: loaded.view.screen,
    head,
    draft: parseDraft(json(edit)),
    media,
    proxyUrl: mediaAsset(f, 'proxy.mp4') ? `/api/jobs/${id}/media?name=proxy.mp4` : null,
    filmUrl: media && head ? `/api/jobs/${id}/file?path=${encodeURIComponent(media.film.file)}&v=${head}` : null,
    styles: f?.styles ?? null,
    answers: f?.answers ?? null,
  };
}
