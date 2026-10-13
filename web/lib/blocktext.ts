// Текст блока руками — поля и правка, общие для панели блока (blockpanel.tsx) и поля на кадре (inline.tsx): какие поля у
// хука, титра, акцента, текстовой вставки, финальной карточки и слов группы субтитров, их проверки (те же, что у
// проверки шрифтов движка, fonts.check), и как набранное становится одной правкой timeline.json (setHook, setCta,
// setBlock, setEnd, setWord) — панель и кадр не расходятся.
import { badSymbols, blockFix, hasEmoji, LIMITS, setBlock, setCta, setEnd, setHook, setWord, type At, type EndFix, type HandEdits } from './edits.ts';
import { handWord } from './fontchars.ts';
import type { Key } from './i18n.ts';
import type { BlockRef, Draft } from './tracks.ts';

/** Чей текст правят: хук; титр по месту в речи; акцент или вставка (номер в edit.json, место и какой по счёту с тем же
 *  местом); финальная карточка; слова субтитров в промежутке исходника [from, to] (группа на кадре). */
export type TextTarget = { kind: 'hook' } | { kind: 'cta'; at: At } | { kind: 'accent'; n: number; at: At; occurrence: number }
  | { kind: 'insert'; n: number; at: At; occurrence: number } | { kind: 'end' } | { kind: 'words'; from: number; to: number };
/** Проверка поля: строка (не пустая, основным шрифтом), хук (основным, последнее слово — рукописным), рукописное (кодовое
 *  слово), слово субтитров (пусто можно, эмодзи — нет), ник (пусто можно). */
export type FieldCheck = 'line' | 'hook' | 'hand' | 'word' | 'handle';
/** Поле текста: `value` — что сейчас (правка Павла или как у сессии), `session` — как у сессии; подпись — ключ (и номер
 *  строки) или слово субтитров; `span` — у слова его время в edit.json. */
export type BlockField = {
  id: string; label: { key: Key; line?: number } | { word: string; removed: boolean };
  value: string; session: string; check: FieldCheck; max: number; span?: [number, number];
};
export const TEXTUAL = ['text', 'sticker', 'badge']; // вставки, у которых на кадре есть текст

/** Блок дорожки → чей текст; у группы субтитров — null: её слова берут по группе на кадре (`words`). */
export function blockTarget(ref: BlockRef): TextTarget | null {
  if (ref.kind === 'hook') return { kind: 'hook' };
  if (ref.kind === 'cta') return { kind: 'cta', at: ref.at };
  if (ref.kind === 'accent' || ref.kind === 'insert') return { kind: ref.kind, n: ref.n, at: ref.at, occurrence: ref.occurrence };
  return null;
}

/** Строки — по полю на строку (у нескольких — с номером). */
const lineFields = (key: Key, now: readonly string[], was: readonly string[]): BlockField[] => now.map((value, i) => ({
  id: `line${i}`, label: now.length > 1 ? { key, line: i + 1 } : { key }, value, session: was[i] ?? value, check: 'line', max: LIMITS.line,
}));

/** Поля текста блока `target` в черновике `draft` с правками `hand` — как в его панели; убранный блок, картинка и блок,
 *  которого нет, — без полей. */
export function textFields(target: TextTarget, draft: Draft, hand: HandEdits): BlockField[] {
  if (target.kind === 'words') {
    const fixed = new Map((hand.words ?? []).map((w) => [`${w.t0}|${w.t1}`, w.text]));
    return draft.words.filter((w) => w.t0 >= target.from - 1e-6 && w.t1 <= target.to + 1e-6).map((w) => {
      const id = `${w.t0}|${w.t1}`;
      const value = fixed.get(id) ?? w.text;
      return { id, label: { word: w.text, removed: value === '' }, value, session: w.text, check: 'word', max: LIMITS.word, span: [w.t0, w.t1] };
    });
  }
  if (target.kind === 'end') {
    const card = draft.end;
    const fix = hand.text?.end;
    if (!card || fix?.off) return [];
    const handle = card.handle ?? '';
    return [...lineFields('endLine', fix?.lines ?? card.lines, card.lines),
      { id: 'handle', label: { key: 'endHandle' }, value: fix?.handle ?? handle, session: handle, check: 'handle', max: LIMITS.handle }];
  }
  const fix = blockFix(hand, target.kind, target.kind === 'hook' ? undefined : target.at, 'occurrence' in target ? target.occurrence : 0) as
    { text?: string; lines?: string[]; word?: string; off?: true } | null;
  if (fix?.off) return [];
  if (target.kind === 'hook') {
    const hook = draft.hook;
    return hook ? [{ id: 'text', label: { key: 'hookText' }, value: fix?.text ?? hook.text, session: hook.text, check: 'hook', max: LIMITS.line }] : [];
  }
  if (target.kind === 'cta') {
    const cta = draft.cta;
    if (!cta) return [];
    return [...lineFields('ctaLines', fix?.lines ?? cta.lines, cta.lines),
      { id: 'word', label: { key: 'ctaWord' }, value: fix?.word ?? cta.word, session: cta.word, check: 'hand', max: LIMITS.line }];
  }
  if (target.kind === 'accent') { // строк — как у сессии: у каждой свой размер и цвет
    const was = draft.accents?.[target.n]?.lines.map((l) => l.text);
    return was ? lineFields('accentLines', fix?.lines ?? was, was) : [];
  }
  const ins = draft.inserts[target.n];
  if (!ins || !TEXTUAL.includes(ins.kind) || ins.text === undefined) return [];
  return [{ id: 'text', label: { key: 'insertText' }, value: fix?.text ?? ins.text, session: ins.text, check: 'line', max: LIMITS.line }];
}

/** Ключ правки поля для отмены — как у панели: нажатия в одном поле подряд — одна правка. */
export const fieldKey = (target: TextTarget, f: BlockField): string => (target.kind === 'words' ? `word:${f.id}`
  : target.kind === 'end' ? `end:${f.id}` : `${target.kind}${'n' in target ? target.n : ''}:${f.id}`);

/** Набранное в полях `fields` блока `target` (значения — по порядку полей) — одна правка поверх `hand`, как её пишет панель:
 *  без пробелов по краям; у титра и карточки — только то, что поменялось; у слов — каждое поменявшееся слово (как у сессии —
 *  без правки). Ничего не поменялось — null. */
export function applyFields(hand: HandEdits, target: TextTarget, fields: readonly BlockField[], values: readonly string[]): HandEdits | null {
  const next = fields.map((f, i) => (values[i] ?? f.value).trim());
  const changed = fields.map((f, i) => next[i] !== f.value);
  if (!changed.some(Boolean)) return null;
  const lines = () => fields.flatMap((f, i) => (f.id.startsWith('line') ? [next[i]] : []));
  const lineChanged = fields.some((f, i) => f.id.startsWith('line') && changed[i]);
  const own = (id: string) => { // поменялось ли поле `id` — и на что
    const i = fields.findIndex((f) => f.id === id);
    return i >= 0 && changed[i] ? next[i] : undefined;
  };
  switch (target.kind) {
    case 'hook': return setHook(hand, { text: next[0] });
    case 'cta': {
      const word = own('word');
      return setCta(hand, target.at, { ...(lineChanged ? { lines: lines() } : {}), ...(word !== undefined ? { word } : {}) });
    }
    case 'accent': return setBlock(hand, 'accents', target.at, target.occurrence, { lines: lines() });
    case 'insert': return setBlock(hand, 'inserts', target.at, target.occurrence, { text: next[0] });
    case 'end': {
      const handle = own('handle');
      const fix: EndFix = { ...(lineChanged ? { lines: lines() } : {}), ...(handle !== undefined ? { handle } : {}) };
      return setEnd(hand, fix);
    }
    case 'words': return fields.reduce((h, f, i) => (changed[i] && f.span
      ? setWord(h, f.span[0], f.span[1], next[i] === f.session ? null : next[i]) : h), hand);
  }
}

/** Что не так с набранным `v` в поле с проверкой `check` (ключ текста и знаки); всё можно — null. Буквы шрифта — отдельно
 *  (fieldFonts): их знает только страница, прочитав шрифт. */
export function fieldProblem(check: FieldCheck, v: string): { key: Key; s?: string } | null {
  const odd = badSymbols(v);
  if (check === 'word') return hasEmoji(v) ? { key: 'noEmoji' } : odd ? { key: 'noSymbol', s: odd } : null;
  if (check === 'handle') return v.trim() && odd ? { key: 'noSymbol', s: odd } : null;
  return !v.trim() ? { key: 'emptyLine' } : odd ? { key: 'noSymbol', s: odd } : null;
}

/** Какой шрифт стиля что из набранного нарисует (fonts.texts движка): хук целиком — основной, его последнее слово —
 *  рукописный; кодовое слово титра — рукописный; ник — основной, если он есть; остальное — основной. */
export function fieldFonts(check: FieldCheck, v: string): { role: 'main' | 'hand'; text: string }[] {
  if (check === 'hook') return [{ role: 'main', text: v }, { role: 'hand', text: handWord(v) }];
  if (check === 'hand') return [{ role: 'hand', text: v }];
  if (check === 'handle') return v.trim() ? [{ role: 'main', text: v }] : [];
  return [{ role: 'main', text: v }];
}
