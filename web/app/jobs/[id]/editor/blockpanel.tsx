'use client';
// Панель выбранного блока: хук, титр, акцентная фраза, вставка — их текст, «Убрать из ролика» и «Вернуть», «Как было»;
// группа субтитров — её слова (правится только текст: время и звук те же; пусто — слова нет в субтитрах). Правки — в
// timeline.json (text, words), их кладёт движок поверх черновика (edits.apply_text); строка поля — одна правка для отмены.
import { useEffect, useId, useState } from 'react';
import { badSymbols, blockFix, hasEmoji, LIMITS, setBlock, setCta, setHook, setWord, type HandEdits } from '@/lib/edits.ts';
import { handWord } from '@/lib/fontchars.ts';
import { tenths } from '@/lib/format.ts';
import type { Key } from '@/lib/i18n.ts';
import { findBlock, type BlockRef, type Clip, type Draft, type Tracks } from '@/lib/tracks.ts';

type TFn = (k: Key, v?: Record<string, string | number>) => string;
type Kind = 'hook' | 'cta' | 'accent' | 'insert';
/** Выбранный блок: вид и номер в edit.json (у хука и титра — 0). */
export type BlockSel = { kind: 'block'; block: Kind; n: number };
/** Выбранная группа субтитров — промежуток исходника её слов: панель держит их, даже когда группы перестроились. */
export type SubSel = { kind: 'sub'; from: number; to: number };

const TEXTUAL = ['text', 'sticker', 'badge']; // вставки, у которых на кадре есть текст
const DRAWN = ['image', 'badge', 'sticker', 'text', 'anim'];
const NAMES: Record<Kind, Key> = { hook: 'hook', cta: 'cta', accent: 'accent', insert: 'insert' };
/** Каких букв набранного нет в шрифте стиля, что это нарисует (основной или рукописный), — текст ошибки; все есть (или
 *  шрифт ещё не прочитан) — null. Таких букв монтаж не пропустит (fonts.check). */
export type Letters = (role: 'main' | 'hand', text: string) => string | null;
const NO_LETTERS: Letters = () => null;

/** Поле текста: пока набранное нельзя сохранить (пусто, эмодзи), оно остаётся в поле с ошибкой, а правка — прежней. */
function TextField({ label, value, disabled, check, onCommit, struck, max = LIMITS.line }: {
  label: string; value: string; disabled: boolean; check: (v: string) => string | null; onCommit: (v: string) => void; struck?: boolean; max?: number;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { // правка пришла снаружи (отмена, другая вкладка) — в поле она
    setText(value);
    setError(null);
  }, [value]);
  // ошибка — рядом с полем, а не в его подписи: имя поля остаётся тем же (и для экранного чтеца)
  return (
    <div className={`ed-text${struck ? ' struck' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" value={text} maxLength={max} disabled={disabled} aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined} spellCheck
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          const err = check(v);
          setError(err);
          if (!err && v.trim() !== value) onCommit(v.trim());
        }} />
      {error ? <span id={`${id}-err`} className="ed-err" role="alert">{error}</span> : null}
    </div>
  );
}

const sameRef = (a: BlockRef, b: BlockRef) => JSON.stringify(a) === JSON.stringify(b);

/** Правки блока: убрать из ролика, вернуть (как у сессии), поле текста. */
function setFix(h: HandEdits, ref: BlockRef, fix: Record<string, unknown> | null): HandEdits {
  if (ref.kind === 'hook') return setHook(h, fix);
  if (ref.kind === 'cta') return setCta(h, ref.at, fix);
  if (ref.kind === 'accent') return setBlock(h, 'accents', ref.at, ref.occurrence, fix);
  if (ref.kind === 'insert') return setBlock(h, 'inserts', ref.at, ref.occurrence, fix);
  return h;
}
export const removeBlock = (h: HandEdits, ref: BlockRef): HandEdits => setFix(h, ref, { off: true });
export const restoreBlock = (h: HandEdits, ref: BlockRef): HandEdits => setFix(h, ref, null);

export function BlockPanel({ T, sel, tracks, draft, hand, editable, note, onEdit, sec, letters = NO_LETTERS }: {
  T: TFn; sel: BlockSel; tracks: Tracks; draft: Draft; hand: HandEdits; editable: boolean;
  note: string | null; // почему править нельзя (старый движок, ещё не смонтирован)
  onEdit: (next: HandEdits, key?: string) => void; sec: (s: number) => string; letters?: Letters;
}) {
  const c = findBlock(tracks, sel.block, sel.n);
  const ref = c?.ref;
  if (!c || !ref || ref.kind === 'sub') return <p className="ed-note faint">{T('selectHint')}</p>;
  const at = ref.kind === 'hook' ? undefined : ref.at;
  const fix = blockFix(hand, ref.kind, at, 'occurrence' in ref ? ref.occurrence : 0) as Record<string, unknown> | null;
  // пусто нельзя; знаки, которых шрифт ролика не нарисует, и буквы, которых нет в шрифте стиля, — тоже (монтаж на них
  // встал бы): хук целиком рисует основной, его последнее слово — рукописный; кодовое слово — рукописный
  const nonEmpty = (v: string) => (!v.trim() ? T('emptyLine') : badSymbols(v) ? T('noSymbol', { s: badSymbols(v) }) : null);
  const main = (v: string) => nonEmpty(v) ?? letters('main', v);
  const hookText = (v: string) => main(v) ?? letters('hand', handWord(v));
  const handText = (v: string) => nonEmpty(v) ?? letters('hand', v);
  const keyOf = (field: string) => `${ref.kind}${'n' in ref ? ref.n : ''}:${field}`;
  const commit = (patch: Record<string, unknown>, field: string) => onEdit(setFix(hand, ref, patch), keyOf(field));
  const fields: React.ReactNode[] = [];
  if (!c.ghost) {
    if (ref.kind === 'hook' && draft.hook) {
      fields.push(<TextField key="hook" label={T('hookText')} value={String(fix?.text ?? draft.hook.text)} disabled={!editable} check={hookText}
        onCommit={(v) => commit({ text: v }, 'text')} />);
      if (tracks.layer.tl.teaser) fields.push(<p key="teaser" className="ed-note faint">{T('hookTeaser')}</p>);
    }
    if (ref.kind === 'cta' && draft.cta) {
      const lines = (fix?.lines as string[] | undefined) ?? draft.cta.lines;
      lines.forEach((line, i) => fields.push(
        <TextField key={`l${i}`} label={lines.length > 1 ? `${T('ctaLines')} · ${T('line', { n: i + 1 })}` : T('ctaLines')} value={line} disabled={!editable}
          check={main} onCommit={(v) => commit({ lines: lines.map((x, k) => (k === i ? v : x)) }, `line${i}`)} />,
      ));
      fields.push(<TextField key="word" label={T('ctaWord')} value={String(fix?.word ?? draft.cta.word)} disabled={!editable} check={handText}
        onCommit={(v) => commit({ word: v }, 'word')} />);
    }
    if (ref.kind === 'accent') {
      const a = draft.accents?.[ref.n];
      const lines = (fix?.lines as string[] | undefined) ?? a?.lines.map((l) => l.text) ?? [];
      lines.forEach((line, i) => fields.push( // число строк — как у сессии (у строки свой размер и цвет)
        <TextField key={`l${i}`} label={lines.length > 1 ? `${T('accentLines')} · ${T('line', { n: i + 1 })}` : T('accentLines')} value={line}
          disabled={!editable} check={main} onCommit={(v) => commit({ lines: lines.map((x, k) => (k === i ? v : x)) }, `line${i}`)} />,
      ));
    }
    if (ref.kind === 'insert') {
      const ins = draft.inserts[ref.n];
      if (ins && TEXTUAL.includes(ins.kind) && ins.text !== undefined) {
        fields.push(<TextField key="text" label={T('insertText')} value={String(fix?.text ?? ins.text)} disabled={!editable} check={main}
          onCommit={(v) => commit({ text: v }, 'text')} />);
      }
      if (ins?.kind === 'fullscreen') fields.push(<p key="fs" className="ed-note faint">{T('fullscreenInsert')}</p>);
      else if (ins?.question && !ins.src && !TEXTUAL.includes(ins.kind)) fields.push(<p key="wait" className="ed-note faint">{T('waitingInsert')}</p>);
      else if (ins && DRAWN.includes(ins.kind) && c.drawn === false) fields.push(<p key="np" className="ed-note faint">{T('unplacedInsert')}</p>);
    }
  }
  return (
    <section className="ed-insp" aria-label={T(NAMES[ref.kind])} data-block={ref.kind}>
      <h2>{T(NAMES[ref.kind])}{c.ghost ? ` · ${T('removed')}` : ''}</h2>
      <p className="ed-note mono">{T('blockSpan', { a: tenths(c.t0), b: tenths(c.t1), s: sec(c.t1 - c.t0) })}</p>
      {note ? <p className="ed-note ed-flag">{note}</p> : null}
      {fields}
      <div className="ed-btns">
        {c.ghost ? (
          <button type="button" className="ed-btn" disabled={!editable} onClick={() => onEdit(restoreBlock(hand, ref))}>{T('restoreBlock')}</button>
        ) : (
          <button type="button" className="ed-btn bad" disabled={!editable} onClick={() => onEdit(removeBlock(hand, ref))}>{T('removeBlock')}</button>
        )}
        {fix && !c.ghost ? (
          <button type="button" className="ed-btn" disabled={!editable} title={T('asSessionT')} onClick={() => onEdit(restoreBlock(hand, ref))}>{T('asSession')}</button>
        ) : null}
      </div>
      {editable && !c.ghost ? <p className="ed-note faint">{T('blockHint')}</p> : null}
    </section>
  );
}

/** Слова группы субтитров: правка — текст слова (время и звук те же), пусто — слова нет в субтитрах, ↺ — как было. */
export function WordsPanel({ T, sel, tracks, draft, hand, editable, note, onEdit, sec, letters = NO_LETTERS }: {
  T: TFn; sel: SubSel; tracks: Tracks; draft: Draft; hand: HandEdits; editable: boolean; note: string | null;
  onEdit: (next: HandEdits, key?: string) => void; sec: (s: number) => string; letters?: Letters;
}) {
  const inside = (w: { t0: number; t1: number }) => w.t0 >= sel.from - 1e-6 && w.t1 <= sel.to + 1e-6;
  const words = draft.words.filter(inside);
  const fixed = new Map((hand.words ?? []).map((w) => [`${w.t0}|${w.t1}`, w.text]));
  const shown = tracks.subtitles.filter((c) => c.ref?.kind === 'sub' && c.ref.words.some(inside));
  const t0 = shown.length ? Math.min(...shown.map((c) => c.t0)) : null;
  const t1 = shown.length ? Math.max(...shown.map((c) => c.t1)) : null;
  return (
    <section className="ed-insp" aria-label={T('words')} data-block="sub">
      <h2>{T('subtitles')}</h2>
      {t0 !== null && t1 !== null ? <p className="ed-note mono">{T('blockSpan', { a: tenths(t0), b: tenths(t1), s: sec(t1 - t0) })}</p> : null}
      {note ? <p className="ed-note ed-flag">{note}</p> : null}
      <div className="ed-words">
        {words.map((w) => {
          const key = `${w.t0}|${w.t1}`;
          const now = fixed.get(key);
          const value = now ?? w.text;
          return (
            <div key={key} className="ed-word">
              <TextField label={value === '' ? `${w.text} · ${T('wordRemoved')}` : w.text} value={value} disabled={!editable} struck={value === ''}
                max={LIMITS.word} check={(v) => (hasEmoji(v) ? T('noEmoji') : badSymbols(v) ? T('noSymbol', { s: badSymbols(v) }) : letters('main', v))}
                onCommit={(v) => onEdit(setWord(hand, w.t0, w.t1, v === w.text ? null : v), `word:${key}`)} />
              {now !== undefined ? (
                <button type="button" className="ed-btn" disabled={!editable} title={T('asSessionT')} onClick={() => onEdit(setWord(hand, w.t0, w.t1, null))}>
                  {T('asSession')}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="ed-note faint">{T('wordHint')}</p>
    </section>
  );
}

/** Выбран ли блок `ref` на дорожке (у групп субтитров — по словам). */
export function isPicked(sel: BlockSel | SubSel | { kind: string } | null, c: Clip): boolean {
  const ref = c.ref;
  if (!sel || !ref) return false;
  if (sel.kind === 'sub' && ref.kind === 'sub') {
    const s = sel as SubSel;
    return ref.words.some((w) => w.t0 >= s.from - 1e-6 && w.t1 <= s.to + 1e-6);
  }
  if (sel.kind !== 'block' || ref.kind === 'sub') return false;
  const b = sel as BlockSel;
  return b.block === ref.kind && (ref.kind === 'hook' || ref.kind === 'cta' || ('n' in ref && ref.n === b.n));
}

export { sameRef };
