'use client';
// Эффекты разбора персонажа руками (дорожка «Эффекты»): рваная бумага и глитч — свой на бегунке, сдвинуть, другой вид,
// убрать; поднятые субтитры (edit.subPlaces) — своё место на фразу под бегунком, края, высота, убрать. Правки — в
// timeline.json (transitions, subPlaces), монтаж кладёт их поверх edit.json сессии (edits.apply), кадр редактора — сразу.
import { LIMITS, removePlace, setOwnPlace, setPlace, setPlaceOff, type At, type HandEdits, type PlaceRef } from '@/lib/edits.ts';
import { tenths } from '@/lib/format.ts';
import type { Key } from '@/lib/i18n.ts';
import type { Tracks } from '@/lib/tracks.ts';

type TFn = (k: Key, v?: Record<string, string | number>) => string;

/** Выбранные поднятые субтитры: место сессии — по месту в edit.subPlaces, своё — по номеру среди своих. */
export type PlaceSel = { kind: 'place'; ref: PlaceRef };
const sameAt = (a: At, b: At) => a[0] === b[0] && a[1] === b[1];
/** То же место: сессии — по месту, своё — по номеру. */
export const samePlace = (a: PlaceRef, b: PlaceRef): boolean => ('own' in a ? 'own' in b && a.own === b.own : 'at' in b && sameAt(a.at, b.at));
/** Высота своих поднятых субтитров, пока у ролика их нет: над головой, как у хука (SKILL.md, часть 1, раздел 10). */
export const RAISED_Y = 380;

/** Раздел «Эффекты» справа: свой разрыв или глитч на бегунке, поднять субтитры фразы под бегунком; сколько их в ролике.
 *  `onAdd` — нельзя править — null; `note` — почему. */
export function EffectsSection({ T, tracks, onAdd, note }: {
  T: TFn; tracks: Tracks; onAdd: ((what: 'tear' | 'glitch' | 'place') => void) | null; note: string | null;
}) {
  const fx = tracks.transitions.filter((x) => x.kind === 'tear' || x.kind === 'glitch');
  return (
    <section className="ed-fx-panel" aria-label={T('effects')}>
      <h2>{T('effects')}</h2>
      <div className="ed-btns">
        <button type="button" className="ed-btn" data-act="add-tear" disabled={!onAdd} title={T('fxTearT')} onClick={() => onAdd?.('tear')}>{T('fxTear')}</button>
        <button type="button" className="ed-btn" data-act="add-glitch" disabled={!onAdd} title={T('fxGlitchT')} onClick={() => onAdd?.('glitch')}>{T('fxGlitch')}</button>
        <button type="button" className="ed-btn" data-act="add-place" disabled={!onAdd} title={T('fxPlaceT')} onClick={() => onAdd?.('place')}>{T('fxPlace')}</button>
      </div>
      <dl className="ed-facts">
        <dt>{T('fxTransitions')}</dt><dd className="mono">{T('ofTotal', { n: fx.filter((x) => !x.off).length, m: fx.length })}</dd>
        <dt>{T('fxPlaces')}</dt><dd className="mono">{T('ofTotal', { n: tracks.places.filter((p) => !p.off).length, m: tracks.places.length })}</dd>
      </dl>
      <p className="ed-note faint">{note ?? T('fxHint')}</p>
    </section>
  );
}

/** Выбранные поднятые субтитры: высота на кадре, убрать или вернуть, «как у монтажа»; своё место — удалить. Края — тянут
 *  на дорожке. */
export function PlacePick({ T, sel, tracks, hand, editable, note, onEdit, sec, onRemoved }: {
  T: TFn; sel: PlaceSel; tracks: Tracks; hand: HandEdits; editable: boolean; note: string | null;
  onEdit: (next: HandEdits, key?: string) => void; sec: (s: number) => string;
  onRemoved?: () => void; // своё место удалено: номера своих сдвинулись — выбор снять
}) {
  const ref = sel.ref;
  const p = tracks.places.find((x) => samePlace(x.ref, ref));
  if (!p) return <p className="ed-note faint">{T('selectHint')}</p>;
  const fixed = 'at' in ref && (hand.subPlaces ?? []).some((f) => f.at !== undefined && sameAt(f.at, ref.at));
  const setY = (y: number) => onEdit('own' in ref ? setOwnPlace(hand, ref.own, { t0: p.src[0], t1: p.src[1], y })
    : p.was ? setPlace(hand, p.was, { t0: p.src[0], t1: p.src[1], y }) : hand, 'place-y');
  return (
    <section className="ed-insp" aria-label={T('fxPlaceName')} data-place-item={'own' in ref ? `own${ref.own}` : `${ref.at[0]}-${ref.at[1]}`}>
      <h2>{'own' in ref ? T('fxPlaceOwn') : T('fxPlaceName')}{p.off ? ` · ${T('removed')}` : ''}</h2>
      <p className="ed-note mono">{T('sourceSpan', { a: tenths(p.src[0]), b: tenths(p.src[1]), s: sec(p.src[1] - p.src[0]) })}</p>
      <div className="ed-shade">
        <span className="ed-range-name">{T('fxHeight')}</span>
        <input type="range" aria-label={T('fxHeight')} min={LIMITS.subY.min} max={LIMITS.subY.max} step={10} value={p.y} disabled={!editable || p.off}
          onChange={(e) => setY(Number(e.target.value))} />
        <span className="mono">{p.y}</span>
      </div>
      <div className="ed-btns">
        {'own' in ref ? (
          <button type="button" className="ed-btn bad" disabled={!editable} onClick={() => { onEdit(removePlace(hand, ref.own)); onRemoved?.(); }}>{T('fxPlaceDelete')}</button>
        ) : (
          <button type="button" className={`ed-btn${p.off ? '' : ' bad'}`} disabled={!editable} onClick={() => onEdit(setPlaceOff(hand, ref.at, !p.off))}>
            {p.off ? T('fxPlaceOn') : T('fxPlaceOff')}
          </button>
        )}
        {fixed && !p.off && 'at' in ref ? (
          <button type="button" className="ed-btn" disabled={!editable} title={T('asSessionT')} onClick={() => onEdit(setPlaceOff(hand, ref.at, false))}>{T('asSession')}</button>
        ) : null}
      </div>
      <p className="ed-note faint">{note ?? T('fxPlaceHint')}</p>
    </section>
  );
}
