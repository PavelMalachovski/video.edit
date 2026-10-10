// Ответы на вопросы Claude в браузере: черновик (выбранные варианты, тексты, картинки к ответам) живёт в
// localStorage['vm:draft:<id>'] и переживает перезагрузку; из него — ответы для «Монтировать» и хук для превью.
import { isUploadFile } from './jobs.ts';
import { ownKey, RESERVED, type Question } from './jobfiles.ts';

/** Картинка к ответу «загрузить свою»: ассет черновика, его куски и готова ли; `n` — какой это выбор по счёту. */
export type LocalUpload = { asset: string; name: string; size: number; type: string; parts: number; done: boolean; n?: number };
export type Draft = { picks: Record<string, string[]>; texts: Record<string, string>; uploads: Record<string, LocalUpload> };

const defaults = (q: Question): string[] => (q.default === undefined ? [] : Array.isArray(q.default) ? q.default : [q.default]);
const known = (q: Question, id: string): boolean => (q.options ?? []).some((o) => o.id === id);

/** Черновик по умолчанию: `default` выбран заранее, у вопроса-текста он — в поле. */
export function initialDraft(qs: Question[]): Draft {
  const picks: Record<string, string[]> = {};
  const texts: Record<string, string> = {};
  for (const q of qs) {
    if (q.type === 'text') texts[q.id] = typeof q.default === 'string' ? q.default : '';
    else picks[q.id] = defaults(q).filter((id) => known(q, id)).slice(0, q.type === 'multi' ? undefined : 1);
  }
  return { picks, texts, uploads: {} };
}

/** Нажатие варианта: у `multi` — переключение, у остальных — выбран только он. */
export function pick(d: Draft, q: Question, optionId: string): Draft {
  const current = d.picks[q.id] ?? [];
  const next = q.type !== 'multi' ? [optionId] : current.includes(optionId) ? current.filter((x) => x !== optionId) : [...current, optionId];
  return { ...d, picks: { ...d.picks, [q.id]: next } };
}

/** Выбранный вариант вопроса с одним ответом (нет выбора — `default`). */
function chosen(q: Question, d: Draft): string | undefined {
  return (d.picks[q.id] ?? []).find((id) => known(q, id)) ?? defaults(q).find((id) => known(q, id));
}

/**
 * Ответы для answers.json: `own` → `answers[q] = 'own'` и текст в `answers['<q>.own']`; `upload` → `'upload'` и
 * готовая загрузка в `uploads`; `multi` — список в порядке вариантов (пустой можно). Без ответа — id в `missing`.
 */
export function buildAnswers(qs: Question[], d: Draft): { answers: Record<string, string | string[]>; uploads: Record<string, LocalUpload>; missing: string[] } {
  const answers: Record<string, string | string[]> = {};
  const uploads: Record<string, LocalUpload> = {};
  const missing: string[] = [];
  for (const q of qs) {
    if (q.type === 'text') {
      const text = (d.texts[q.id] ?? '').trim() || (typeof q.default === 'string' ? q.default.trim() : '');
      if (text) answers[q.id] = text;
      else missing.push(q.id);
      continue;
    }
    if (q.type === 'multi') {
      const list = d.picks[q.id] ?? defaults(q);
      answers[q.id] = (q.options ?? []).map((o) => o.id).filter((id) => list.includes(id));
      continue;
    }
    const id = chosen(q, d);
    if (id === RESERVED.own) {
      const text = (d.texts[q.id] ?? '').trim();
      if (!text) missing.push(q.id);
      else Object.assign(answers, { [q.id]: RESERVED.own, [ownKey(q.id)]: text });
    } else if (id === RESERVED.upload) {
      const up = d.uploads[q.id];
      if (!up?.done) missing.push(q.id);
      else {
        answers[q.id] = RESERVED.upload;
        uploads[q.id] = up;
      }
    } else if (id) answers[q.id] = id;
    else missing.push(q.id);
  }
  return { answers, uploads, missing };
}

const unquote = (s: string): string => s.trim().replace(/^[«"“„']+|[»"”']+$/g, '').trim();

/** Хук на превью: по вопросу `hook` (`none` — без хука, `own` — свой текст, иначе подпись варианта без кавычек); вопроса нет — хук образца. */
export function previewHook(qs: Question[], d: Draft, sampleHook?: string): string | null {
  const q = qs.find((x) => x.id === RESERVED.hook);
  if (!q) return sampleHook ?? null;
  if (q.type === 'text') return (d.texts[q.id] ?? '').trim() || (typeof q.default === 'string' && q.default.trim()) || null;
  const id = chosen(q, d);
  if (!id || id === RESERVED.none || id === RESERVED.upload) return null;
  if (id === RESERVED.own) return (d.texts[q.id] ?? '').trim() || null;
  const label = q.options?.find((o) => o.id === id)?.label;
  return label ? unquote(label) || null : null;
}

// ---------- localStorage ----------

const key = (jobId: string): string => `vm:draft:${jobId}`;
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function isLocalUpload(x: unknown): x is LocalUpload {
  if (!isObject(x)) return false;
  const { asset, name, size, type, parts, done, n } = x;
  return typeof asset === 'string' && isUploadFile(asset) && typeof name === 'string' && typeof size === 'number' && typeof type === 'string'
    && Number.isInteger(parts) && typeof done === 'boolean' && (n === undefined || Number.isInteger(n));
}

export function saveDraft(storage: Storage | null, jobId: string, d: Draft): void {
  try {
    storage?.setItem(key(jobId), JSON.stringify(d));
  } catch {
    // нет хранилища — ответы живут до перезагрузки
  }
}

/** Черновик этой задачи под нынешние вопросы: чужие вопросы и устаревшие варианты отброшены; нет или битый — по умолчанию. */
export function loadDraft(storage: Storage | null, jobId: string, qs: Question[]): Draft {
  const base = initialDraft(qs);
  let raw: unknown;
  try {
    const text = storage?.getItem(key(jobId));
    raw = text ? JSON.parse(text) : null;
  } catch {
    return base;
  }
  if (!isObject(raw)) return base;
  const byId = new Map(qs.map((q) => [q.id, q]));
  const picks = { ...base.picks };
  const texts = { ...base.texts };
  const uploads: Record<string, LocalUpload> = {};
  if (isObject(raw.picks)) {
    for (const [id, list] of Object.entries(raw.picks)) {
      const q = byId.get(id);
      if (!q || q.type === 'text' || !Array.isArray(list)) continue;
      const valid = list.filter((x): x is string => typeof x === 'string' && known(q, x));
      if (list.length && !valid.length) continue; // все варианты устарели — остаётся «по умолчанию»
      picks[id] = q.type === 'multi' ? valid : valid.slice(0, 1);
    }
  }
  if (isObject(raw.texts)) {
    for (const [id, text] of Object.entries(raw.texts)) if (byId.has(id) && typeof text === 'string') texts[id] = text;
  }
  if (isObject(raw.uploads)) {
    for (const [id, up] of Object.entries(raw.uploads)) if (byId.has(id) && isLocalUpload(up)) uploads[id] = up;
  }
  return { picks, texts, uploads };
}
