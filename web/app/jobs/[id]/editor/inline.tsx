'use client';
// Текст блока прямо на кадре редактора: поле рядом с блоком (над ним или под ним — набранное видно на кадре сразу, той же
// отрисовкой шаблона, что у ролика), у слов субтитров — по полю на слово. Каждое нажатие — только кадр (`onDraft`); правка
// — одна, когда Павел закончил: Enter, ✓ или ушёл из поля; Esc и ✕ — как было. Поля, проверки и правка — те же, что у
// панели блока (lib/blocktext.ts).
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { BlockField } from '@/lib/blocktext.ts';
import type { Key } from '@/lib/i18n.ts';
import type { Box } from '../../../handles';
import { CheckIcon, CloseIcon } from '../../../icons';

type TFn = (k: Key, v?: Record<string, string | number>) => string;
const GAP = 6; // px экрана между блоком и полем

/** Где встать полю высотой `h` (px экрана) у рамки блока `box` (px кадра): блок в верхней половине кадра — под ним, в
 *  нижней — над ним; там места нет — с другой стороны; нет нигде — внизу кадра. → top, px экрана. */
function topFor(box: Box, scale: number, frameH: number, h: number): number {
  const below = (box.y + box.h) * scale + GAP;
  const above = box.y * scale - GAP - h;
  const fitsBelow = below + h <= frameH;
  const fitsAbove = above >= 0;
  const upper = (box.y + box.h / 2) * scale < frameH / 2;
  if (upper ? fitsBelow : fitsBelow && !fitsAbove) return below;
  if (fitsAbove) return above;
  return Math.max(0, frameH - h - 4);
}

/** Поле текста на кадре. `fields` — поля блока (как у его панели), `label` — их подписи, `check` — ошибка набранного (как у
 *  панели), `box` — где блок нарисован (px кадра), `scale` и `frameH` — кадр на экране. `onDraft` — набранное, когда его
 *  можно сохранить (кадр — с ним); `onCommit` — правка (Enter, ✓, ушёл из поля); `onCancel` — как было (Esc, ✕; ушёл из
 *  поля с ошибкой — `why`). */
export function InlineText({ T, fields, label, box, scale, frameH, check, onDraft, onCommit, onCancel }: {
  T: TFn; fields: BlockField[]; label: (f: BlockField) => string; box: Box; scale: number; frameH: number;
  check: (f: BlockField, v: string) => string | null; onDraft: (values: string[]) => void; onCommit: (values: string[]) => void;
  onCancel: (why: string | null) => void;
}) {
  const id = useId();
  const [values, setValues] = useState(() => fields.map((f) => f.value));
  const errors = values.map((v, i) => check(fields[i], v));
  const bad = errors.find((e) => e !== null) ?? null;
  const words = fields.every((f) => f.check === 'word');
  const closed = useRef(false); // Enter, blur и blur от удаления поля — правка одна
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(null); // где был фокус до поля: закрыли кнопкой или клавишей — туда же
  const [top, setTop] = useState(() => topFor(box, scale, frameH, 0));

  useLayoutEffect(() => { // фокус — сразу (в том же касании: так iPhone покажет клавиатуру), курсор — в конце
    if (!root.current?.contains(document.activeElement)) back.current = document.activeElement;
    const el = first.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => { // место — по высоте поля (выросла ошибкой — пересчёт)
    const h = root.current?.offsetHeight ?? 0;
    const next = topFor(box, scale, frameH, h);
    if (Math.abs(next - top) > 0.5) setTop(next);
  });

  const restore = () => {
    const el = back.current;
    if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
  };
  /** Сохранить: только если всё набранное можно; `keys` — закрыли клавишей или кнопкой (фокус — обратно). */
  const commit = (keys: boolean) => {
    if (closed.current || bad) return;
    closed.current = true;
    if (keys) restore();
    onCommit(values);
  };
  const cancel = (keys: boolean, why: string | null = null) => {
    if (closed.current) return;
    closed.current = true;
    if (keys) restore();
    onCancel(why);
  };
  const change = (i: number, v: string) => {
    const next = values.map((x, k) => (k === i ? v : x));
    setValues(next);
    if (next.every((x, k) => check(fields[k], x) === null)) onDraft(next); // с ошибкой кадр держит последнее, что можно
  };

  return (
    <div ref={root} className={`ed-inline${words ? ' words' : ''}`} role="group" aria-label={T('editOnFrame')} style={{ top }}
      onMouseDown={(e) => { // ✓, ✕ и пустое место — фокус остаётся в поле (щелчок дойдёт: отменяется только смена фокуса)
        if (!(e.target as HTMLElement).closest('input')) e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel(true);
        } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault(); // Enter, пока идёт набор иероглифов или подсказка, — не правка
          commit(true);
        }
      }}
      onBlur={(e) => { // ушёл из поля (не на его кнопки): можно — правка, с ошибкой — как было, и почему
        if (closed.current || e.currentTarget.contains(e.relatedTarget as Node | null) || !document.hasFocus()) return;
        if (bad) cancel(false, T('inlineNotSaved', { e: bad }));
        else commit(false);
      }}>
      <div className="ed-inline-fields">
        {fields.map((f, i) => (
          <input key={f.id} ref={i === 0 ? first : undefined} type="text" value={values[i]} maxLength={f.max} aria-label={label(f)} title={label(f)}
            aria-invalid={errors[i] ? true : undefined} aria-describedby={errors[i] ? `${id}-${i}` : undefined} enterKeyHint="done" autoComplete="off"
            spellCheck={!words} autoCapitalize={words ? 'none' : undefined} placeholder={words ? f.session : undefined}
            size={words ? Math.max(3, [...(values[i] || f.session)].length + 1) : undefined} className={words && values[i] === '' ? 'struck' : undefined}
            onChange={(e) => change(i, e.target.value)} />
        ))}
      </div>
      {errors.map((err, i) => (err ? (
        <span key={fields[i].id} id={`${id}-${i}`} className="ed-err" role="alert">{fields.length > 1 ? `${label(fields[i])}: ${err}` : err}</span>
      ) : null))}
      <div className="ed-inline-btns">
        <button type="button" className="ed-icon" aria-label={T('inlineCancel')} title={T('inlineCancel')} onClick={() => cancel(true)}>
          <CloseIcon />
        </button>
        <button type="button" className="ed-icon ok" aria-label={T('inlineDone')} title={T('inlineDone')} aria-disabled={bad ? true : undefined}
          onClick={() => commit(true)}>
          <CheckIcon />
        </button>
      </div>
    </div>
  );
}
