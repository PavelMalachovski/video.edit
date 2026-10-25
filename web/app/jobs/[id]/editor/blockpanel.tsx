'use client';
// Панель выбранного блока: хук, титр, акцентная фраза, вставка — их текст, «Убрать из ролика» и «Вернуть», «Как было»;
// группа субтитров — её слова (правится только текст: время и звук те же; пусто — слова нет в субтитрах). Правки — в
// timeline.json (text, words), их кладёт движок поверх черновика (edits.apply_text); строка поля — одна правка для отмены.
import { useEffect, useId, useState } from 'react';
import { applyFields, blockTarget, fieldFonts, fieldKey, fieldProblem, TEXTUAL, textFields, type BlockField, type FieldCheck, type TextTarget } from '@/lib/blocktext.ts';
import type { BrollClip } from '@/lib/editordata.ts';
import { blockFix, blockPlace, LIMITS, setBlock, setCta, setEnd, setHook, setWord, type BrollLayout, type HandEdits, type InsertFix, type Place } from '@/lib/edits.ts';
import { tenths } from '@/lib/format.ts';
import type { Key } from '@/lib/i18n.ts';
import { INSERT_W, moveBox, moveCentre, resizeBox, type BoxExt } from '@/lib/style.ts';
import { findBlock, type BlockRef, type Clip, type Draft, type Tracks } from '@/lib/tracks.ts';
import { STEP } from '../../../handles';

type TFn = (k: Key, v?: Record<string, string | number>) => string;
type Kind = 'hook' | 'cta' | 'accent' | 'insert';
/** Выбранный блок: вид и номер в edit.json (у хука и титра — 0). */
export type BlockSel = { kind: 'block'; block: Kind; n: number };
/** Выбранная группа субтитров — промежуток исходника её слов: панель держит их, даже когда группы перестроились. */
export type SubSel = { kind: 'sub'; from: number; to: number };

const DRAWN = ['image', 'badge', 'sticker', 'text', 'anim'];
const NAMES: Record<Kind, Key> = { hook: 'hook', cta: 'cta', accent: 'accent', insert: 'insert' };
/** Каких букв набранного нет в шрифте стиля, что это нарисует (основной или рукописный), — текст ошибки; все есть (или
 *  шрифт ещё не прочитан) — null. Таких букв монтаж не пропустит (fonts.check). */
export type Letters = (role: 'main' | 'hand', text: string) => string | null;
const NO_LETTERS: Letters = () => null;

/** Что не так с набранным `v` в поле с проверкой `check` — текстом (одно и то же у панели и у поля на кадре): пусто, знаки,
 *  которых шрифт ролика не нарисует, эмодзи в субтитрах, буквы, которых нет в шрифте стиля (монтаж на них встал бы); всё
 *  можно — null. */
export function fieldError(T: TFn, letters: Letters, check: FieldCheck, v: string): string | null {
  const p = fieldProblem(check, v);
  if (p) return T(p.key, p.s === undefined ? undefined : { s: p.s });
  for (const f of fieldFonts(check, v)) {
    const lack = letters(f.role, f.text);
    if (lack) return lack;
  }
  return null;
}
/** Подпись поля: имя (у строки из нескольких — с номером) или слово субтитров (убранное — с пометкой). */
export const fieldLabel = (T: TFn, f: BlockField): string => ('word' in f.label
  ? (f.label.removed ? `${f.label.word} · ${T('wordRemoved')}` : f.label.word)
  : f.label.line ? `${T(f.label.key)} · ${T('line', { n: f.label.line })}` : T(f.label.key));

/** Поля текста блока `target` — по TextField на поле (те же, что у поля на кадре): строка поля — одна правка для отмены;
 *  `wrap` — обёртка поля (у слова — «Как было»). */
function textInputs(T: TFn, target: TextTarget, fields: BlockField[], hand: HandEdits, editable: boolean, letters: Letters,
  onEdit: (next: HandEdits, key?: string) => void, wrap?: (f: BlockField, input: React.ReactNode) => React.ReactNode): React.ReactNode[] {
  return fields.map((f, i) => {
    const input = (
      <TextField key={fieldKey(target, f)} label={fieldLabel(T, f)} value={f.value} disabled={!editable} max={f.max} struck={f.check === 'word' && f.value === ''}
        check={(v) => fieldError(T, letters, f.check, v)}
        onCommit={(v) => {
          const next = applyFields(hand, target, fields, fields.map((x, k) => (k === i ? v : x.value)));
          if (next) onEdit(next, fieldKey(target, f));
        }} />
    );
    return wrap ? wrap(f, input) : input;
  });
}

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

/** Место вставки или акцента на кадре руками: что умеет и куда пишет (`onPlace`; null — место как у монтажа), `size` — рамка
 *  блока, как его нарисовал шаблон (нет — блок ещё не был на кадре), `note` — почему двигать нельзя. */
export type Placing = {
  editable: boolean; note: string | null; size: () => { w: number; h: number; ext?: BoxExt } | null; onPlace: (place: Place | null) => void;
};
const ARROWS: [Key, string, number, number][] = [['moveLeft', '←', -STEP, 0], ['moveUp', '↑', 0, -STEP], ['moveDown', '↓', 0, STEP], ['moveRight', '→', STEP, 0]];

/** Где блок на кадре и как его подвинуть кнопками: ←↑↓→ — на STEP px кадра, у вставки — ползунок ширины; «Место как у
 *  монтажа». Рамка — в безопасной зоне, как у ручки на кадре (moveBox и resizeBox; у акцента — moveCentre). */
function PlaceControls({ T, kind, now, moved, placing }: { T: TFn; kind: 'insert' | 'accent'; now: Place; moved: boolean; placing: Placing }) {
  const { editable, note, size, onPlace } = placing;
  const w = now.w ?? 0;
  const moveBy = (dx: number, dy: number): Place => {
    const s = size();
    return kind === 'insert' ? moveBox({ x: now.x, y: now.y, w }, now.x + dx, now.y + dy, s?.h ?? w, s?.ext) : moveCentre(s ?? { w: 0, h: 0 }, now.x + dx, now.y + dy);
  };
  return (
    <div className="ed-place" role="group" aria-label={T('framePlace')} data-place={kind}>
      <span className="ed-place-name">{T('framePlace')}</span>
      <div className="ed-btns">
        {ARROWS.map(([k, sign, dx, dy]) => (
          <button key={k} type="button" className="ed-btn ed-arrow" aria-label={T(k)} title={T(k)} disabled={!editable} onClick={() => onPlace(moveBy(dx, dy))}>
            {sign}
          </button>
        ))}
      </div>
      {kind === 'insert' ? (
        <div className="ed-shade">
          <span className="ed-range-name">{T('width')}</span>
          <input type="range" aria-label={T('insertWidth')} min={INSERT_W.min} max={INSERT_W.max} step={10} value={w} disabled={!editable}
            onChange={(e) => {
              const s = size();
              onPlace(resizeBox({ x: now.x, y: now.y, w }, Number(e.target.value), s?.h ?? w, s?.ext));
            }} />
          <span className="mono">{w}</span>
        </div>
      ) : null}
      <p className="ed-note mono">{kind === 'insert' ? T('placeBox', { x: now.x, y: now.y, w }) : T('placeAt', { x: now.x, y: now.y })}</p>
      {moved ? <button type="button" className="ed-btn" disabled={!editable} onClick={() => onPlace(null)}>{T('placeAsSession')}</button> : null}
      <p className="ed-note faint">{note ?? T(kind === 'insert' ? 'placeInsertHint' : 'placeAccentHint')}</p>
    </div>
  );
}

/** Перебивка (вставка fullscreen): какой клип из перебивок Павла, с какой секунды клипа, вид (на весь кадр или лицо
 *  окошком), звук клипа тихим фоном. Правка — timeline.json → text.inserts (edits.apply_text: src, from, layout, audio). */
function BrollControls({ T, now, brolls, onFix }: {
  T: TFn; now: { src: string; from: number; layout: BrollLayout; audio: boolean }; brolls: readonly BrollClip[];
  onFix: (fix: { src?: string; from?: number; layout?: BrollLayout; audio?: boolean }) => void;
}) {
  const id = useId();
  const own = brolls.some((b) => b.src === now.src);
  const video = brolls.find((b) => b.src === now.src)?.video ?? !/\.(png|jpe?g|webp|gif)$/i.test(now.src); // у картинки нет момента
  return (
    <div className="ed-broll" role="group" aria-label={T('fullscreenInsert')} data-broll="">
      {brolls.length && own ? (
        <label className="ed-field" htmlFor={`${id}-clip`}>
          <span className="ed-range-name">{T('brollClip')}</span>
          <select id={`${id}-clip`} value={now.src} onChange={(e) => onFix({ src: e.target.value })}>
            {brolls.map((b) => <option key={b.src} value={b.src}>{b.name}</option>)}
          </select>
        </label>
      ) : null}
      {video ? <label className="ed-field" htmlFor={`${id}-from`}>
        <span className="ed-range-name">{T('brollFrom')}</span>
        <input id={`${id}-from`} type="number" inputMode="decimal" min={LIMITS.brollFrom.min} max={LIMITS.brollFrom.max} step={0.1} value={now.from}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onFix({ from: Math.round(Math.min(LIMITS.brollFrom.max, Math.max(0, v)) * 10) / 10 });
          }} />
      </label> : null}
      <div className="ed-btns" role="group" aria-label={T('brollLayout')}>
        {(['full', 'pip'] as const).map((k) => (
          <button key={k} type="button" className="ed-toggle" aria-pressed={now.layout === k} onClick={() => onFix({ layout: k })}>
            {T(k === 'full' ? 'brollFull' : 'brollPip')}
          </button>
        ))}
        {video ? <button type="button" className="ed-toggle" aria-pressed={now.audio} onClick={() => onFix({ audio: !now.audio })}>{T('brollAudio')}</button> : null}
      </div>
      <p className="ed-note faint">{T('brollHint')}</p>
    </div>
  );
}

export function BlockPanel({ T, sel, tracks, draft, hand, editable, note, onEdit, sec, letters = NO_LETTERS, placing, brolls }: {
  T: TFn; sel: BlockSel; tracks: Tracks; draft: Draft; hand: HandEdits; editable: boolean;
  note: string | null; // почему править нельзя (старый движок, ещё не смонтирован)
  onEdit: (next: HandEdits, key?: string) => void; sec: (s: number) => string; letters?: Letters;
  placing?: Placing; // место вставки и акцента на кадре (нет — не двигаются)
  brolls?: readonly BrollClip[]; // перебивки задачи: клип и вид перебивки правятся (нет — движок задачи этого не примет)
}) {
  const c = findBlock(tracks, sel.block, sel.n);
  const ref = c?.ref;
  if (!c || !ref || ref.kind === 'sub') return <p className="ed-note faint">{T('selectHint')}</p>;
  const fix = blockFix(hand, ref.kind, ref.kind === 'hook' ? undefined : ref.at, 'occurrence' in ref ? ref.occurrence : 0);
  const target = blockTarget(ref);
  const fields: React.ReactNode[] = [];
  if (!c.ghost) {
    // текст — те же поля и проверки, что у поля на кадре (lib/blocktext.ts): у акцента строк — как у сессии (у строки свой
    // размер и цвет); хук целиком рисует основной шрифт, его последнее слово — рукописный, кодовое слово — рукописный
    if (target) fields.push(...textInputs(T, target, textFields(target, draft, hand), hand, editable, letters, onEdit));
    if (ref.kind === 'hook' && draft.hook && tracks.layer.tl.teaser) fields.push(<p key="teaser" className="ed-note faint">{T('hookTeaser')}</p>);
    // место и размер титра на кадре — у хука (шаблон ставит титр туда же): тянут хук
    if (ref.kind === 'cta') fields.push(<p key="cta-place" className="ed-note faint">{T('ctaPlace')}</p>);
    if (ref.kind === 'insert') {
      const ins = draft.inserts[ref.n];
      if (ins?.kind === 'fullscreen') {
        fields.push(<p key="fs" className="ed-note faint">{T('fullscreenInsert')}</p>);
        if (brolls && editable && ins.src) {
          const f = (fix ?? {}) as InsertFix;
          const now = { src: f.src ?? ins.src, from: f.from ?? ins.from ?? 0, layout: f.layout ?? ins.layout ?? 'full', audio: f.audio ?? ins.audio ?? false };
          fields.push(<BrollControls key="broll" T={T} now={now} brolls={brolls}
            onFix={(next) => onEdit(setBlock(hand, 'inserts', ref.at, ref.occurrence, next))} />);
        }
      }
      else if (ins?.question && !ins.src && !TEXTUAL.includes(ins.kind)) fields.push(<p key="wait" className="ed-note faint">{T('waitingInsert')}</p>);
      else if (ins && DRAWN.includes(ins.kind) && c.drawn === false) fields.push(<p key="np" className="ed-note faint">{T('unplacedInsert')}</p>);
      else if (ins && placing && typeof ins.x === 'number' && typeof ins.y === 'number' && typeof ins.w === 'number') { // вставка с рамкой на кадре
        const own = blockPlace(hand, 'insert', ref.at, ref.occurrence);
        fields.push(<PlaceControls key="place" T={T} kind="insert" now={own ?? { x: ins.x, y: ins.y, w: ins.w }} moved={own !== null} placing={placing} />);
      }
    }
    if (ref.kind === 'accent' && placing) {
      const a = draft.accents?.[ref.n];
      const own = blockPlace(hand, 'accent', ref.at, ref.occurrence);
      if (a && typeof a.x === 'number' && typeof a.y === 'number') {
        fields.push(<PlaceControls key="place" T={T} kind="accent" now={own ?? { x: a.x, y: a.y }} moved={own !== null} placing={placing} />);
      }
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

/** Финальная карточка (после стоп-кадра): её строки и ник — основным шрифтом; «Убрать» — карточки нет (хвост короче),
 *  «Вернуть», «Как было». Правка — timeline.json → text.end (edits.apply_text). */
export function EndPanel({ T, draft, hand, editable, note, onEdit, letters = NO_LETTERS }: {
  T: TFn; draft: Draft; hand: HandEdits; editable: boolean; note: string | null; onEdit: (next: HandEdits, key?: string) => void; letters?: Letters;
}) {
  const card = draft.end;
  if (!card) return <p className="ed-note faint">{T('selectHint')}</p>;
  const fix = hand.text?.end;
  const off = Boolean(fix?.off);
  const end: TextTarget = { kind: 'end' };
  return (
    <section className="ed-insp" aria-label={T('endCard')} data-block="end">
      <h2>{T('endCard')}{off ? ` · ${T('removed')}` : ''}</h2>
      {note ? <p className="ed-note ed-flag">{note}</p> : null}
      {off ? null : textInputs(T, end, textFields(end, draft, hand), hand, editable, letters, onEdit)}
      <div className="ed-btns">
        {off ? (
          <button type="button" className="ed-btn" disabled={!editable} onClick={() => onEdit(setEnd(hand, null))}>{T('endOn')}</button>
        ) : (
          <button type="button" className="ed-btn bad" disabled={!editable} onClick={() => onEdit(setEnd(hand, { off: true }))}>{T('endOff')}</button>
        )}
        {fix && !off ? (
          <button type="button" className="ed-btn" disabled={!editable} title={T('asSessionT')} onClick={() => onEdit(setEnd(hand, null))}>{T('asSession')}</button>
        ) : null}
      </div>
      <p className="ed-note faint">{T('endHint')}</p>
    </section>
  );
}

/** Слова группы субтитров: правка — текст слова (время и звук те же), пусто — слова нет в субтитрах, ↺ — как было. */
export function WordsPanel({ T, sel, tracks, draft, hand, editable, note, onEdit, sec, letters = NO_LETTERS }: {
  T: TFn; sel: SubSel; tracks: Tracks; draft: Draft; hand: HandEdits; editable: boolean; note: string | null;
  onEdit: (next: HandEdits, key?: string) => void; sec: (s: number) => string; letters?: Letters;
}) {
  const inside = (w: { t0: number; t1: number }) => w.t0 >= sel.from - 1e-6 && w.t1 <= sel.to + 1e-6;
  const target: TextTarget = { kind: 'words', from: sel.from, to: sel.to };
  const fixed = new Set((hand.words ?? []).map((w) => `${w.t0}|${w.t1}`)); // у слова есть правка Павла — «Как было»
  const shown = tracks.subtitles.filter((c) => c.ref?.kind === 'sub' && c.ref.words.some(inside));
  const t0 = shown.length ? Math.min(...shown.map((c) => c.t0)) : null;
  const t1 = shown.length ? Math.max(...shown.map((c) => c.t1)) : null;
  return (
    <section className="ed-insp" aria-label={T('words')} data-block="sub">
      <h2>{T('subtitles')}</h2>
      {t0 !== null && t1 !== null ? <p className="ed-note mono">{T('blockSpan', { a: tenths(t0), b: tenths(t1), s: sec(t1 - t0) })}</p> : null}
      {note ? <p className="ed-note ed-flag">{note}</p> : null}
      <div className="ed-words">
        {textInputs(T, target, textFields(target, draft, hand), hand, editable, letters, onEdit, (f, input) => (
          <div key={f.id} className="ed-word">
            {input}
            {fixed.has(f.id) && f.span ? (
              <button type="button" className="ed-btn" disabled={!editable} title={T('asSessionT')}
                onClick={() => f.span && onEdit(setWord(hand, f.span[0], f.span[1], null))}>
                {T('asSession')}
              </button>
            ) : null}
          </div>
        ))}
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
