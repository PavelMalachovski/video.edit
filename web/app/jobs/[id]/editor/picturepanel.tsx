'use client';
// Картинка ролика руками (timeline.json → zoom, looks, transitions): сила зума — ползунок; кусок с фильтром и переход,
// выбранные на дорожке «Картинка», — убрать или вернуть, у куска — другой фильтр, у перехода — другой вид; свой кусок ч/б
// — на фразу под бегунком. Монтаж кладёт это поверх edit.json сессии (edits.apply_picture), кадр редактора показывает сразу.
import {
  LOOK_KINDS, removeLook, setDim, setLook, setLookKind, setSpeed, setTeaser, setTransition, setZoom, TRANSITION_KINDS, LIMITS,
  type At, type HandEdits, type LookKind, type LookRef, type TransitionKind,
} from '@/lib/edits.ts';
import { tenths } from '@/lib/format.ts';
import type { Key } from '@/lib/i18n.ts';
import type { Tracks } from '@/lib/tracks.ts';

type TFn = (k: Key, v?: Record<string, string | number>) => string;

/** Выбранное на дорожке «Картинка»: кусок с фильтром (кусок сессии — по месту в edit.looks, свой — по номеру), переход
 *  по своему t. */
export type PictureSel = { kind: 'look'; ref: LookRef } | { kind: 'transition'; at: number };

export const KIND_NAMES: Record<TransitionKind, Key> = { flash: 'trFlash', zoom: 'trZoom', blur: 'trBlur' };
export const LOOK_NAMES: Record<LookKind, Key> = { bw: 'bw', sepia: 'lookSepia', warm: 'lookWarm', cold: 'lookCold', film: 'lookFilm' };
const sameAt = (a: At, b: At) => a[0] === b[0] && a[1] === b[1];
/** Тот же кусок: кусок сессии — по месту, свой — по номеру. */
export const sameLook = (a: LookRef, b: LookRef): boolean => ('own' in a ? 'own' in b && a.own === b.own : 'at' in b && sameAt(a.at, b.at));
const refKey = (r: LookRef) => ('own' in r ? `own${r.own}` : `${r.at[0]}|${r.at[1]}`);
const percent = (z: number) => `${Math.round(z * 100)} %`;

/** Раздел «Картинка» справа: сила зума, затемнение фона (`dim` монтажа — из edit.json), свой кусок ч/б на фразу под
 *  бегунком (`onAddLook`; нельзя — его нет) и сколько кусков с фильтром и переходов в ролике. `note` — почему править
 *  нельзя. */
export function PictureSection({ T, tracks, hand, dim, canZoom, canDim, note, onEdit, onAddLook }: {
  T: TFn; tracks: Tracks; hand: HandEdits; dim: number; canZoom: boolean; canDim: boolean; note: string | null; onEdit: (next: HandEdits, key?: string) => void;
  onAddLook: (() => void) | null;
}) {
  const zoom = hand.zoom ?? 1;
  const shade = hand.dim ?? dim;
  const looks = new Map(tracks.looks.map((l) => [refKey(l.ref), l.off])); // копия в тизере — тот же кусок
  const bw = [...looks.values()];
  const tr = tracks.transitions;
  return (
    <section className="ed-pic-panel" aria-label={T('picture')}>
      <h2>{T('picture')}</h2>
      <div className="ed-shade">
        <span className="ed-range-name">{T('zoomStrength')}</span>
        <input type="range" aria-label={T('zoomStrength')} min={LIMITS.zoom.min} max={LIMITS.zoom.max} step={0.05} value={zoom} disabled={!canZoom}
          onChange={(e) => onEdit(setZoom(hand, Number(e.target.value)), 'zoom')} />
        <span className="mono">{percent(zoom)}</span>
      </div>
      <p className="ed-note faint">{zoom === 0 ? T('zoomNone') : zoom === 1 ? T('zoomAsMontage') : T('zoomShare', { p: percent(zoom) })}</p>
      {hand.zoom !== undefined ? (
        <button type="button" className="ed-btn" disabled={!canZoom} onClick={() => onEdit(setZoom(hand, null))}>{T('zoomReset')}</button>
      ) : null}
      <div className="ed-shade">
        <span className="ed-range-name">{T('dimStrength')}</span>
        <input type="range" aria-label={T('dimStrength')} min={LIMITS.dim.min} max={LIMITS.dim.max} step={0.05} value={shade} disabled={!canDim}
          onChange={(e) => onEdit(setDim(hand, Number(e.target.value)), 'dim')} />
        <span className="mono">{percent(shade)}</span>
      </div>
      <p className="ed-note faint">{shade > 0 ? T('dimNote') : T('dimNone')}</p>
      {hand.dim !== undefined ? (
        <button type="button" className="ed-btn" disabled={!canDim} onClick={() => onEdit(setDim(hand, null))}>{T('dimReset')}</button>
      ) : null}
      {onAddLook ? <button type="button" className="ed-btn" data-act="add-look" title={T('lookAddT')} onClick={onAddLook}>{T('lookAdd')}</button> : null}
      <dl className="ed-facts">
        <dt>{T('bw')}</dt><dd className="mono">{T('ofTotal', { n: bw.filter((off) => !off).length, m: bw.length })}</dd>
        <dt>{T('transitions')}</dt><dd className="mono">{T('ofTotal', { n: tr.filter((x) => !x.off).length, m: tr.length })}</dd>
      </dl>
      <p className="ed-note faint">{note ?? T('pictureHint')}</p>
    </section>
  );
}

/** Выбранный кусок с фильтром или переход: убрать, вернуть, другой фильтр или вид перехода, «как у монтажа»; свой кусок —
 *  удалить. `editable` — убрать и вернуть кусок, переход; `shape` — фильтр куска и свои куски (старый движок их не знает). */
export function PicturePick({ T, sel, tracks, hand, editable, shape, note, onEdit, sec }: {
  T: TFn; sel: PictureSel; tracks: Tracks; hand: HandEdits; editable: boolean; shape: boolean; note: string | null;
  onEdit: (next: HandEdits, key?: string) => void; sec: (s: number) => string;
}) {
  if (sel.kind === 'look') {
    const ref = sel.ref;
    const marks = tracks.looks.filter((l) => sameLook(l.ref, ref));
    if (!marks.length) return <p className="ed-note faint">{T('selectHint')}</p>;
    const m = marks.find((l) => !l.teaser) ?? marks[0];
    const fixed = 'at' in ref && (hand.looks ?? []).some((f) => f.at !== undefined && sameAt(f.at, ref.at) && !f.off);
    return (
      <section className="ed-insp" aria-label={T('look')}>
        <h2>{'own' in ref ? T('lookOwn') : T('look')}{m.off ? ` · ${T('removed')}` : ''}</h2>
        <p className="ed-note mono">{T('sourceSpan', { a: tenths(m.src[0]), b: tenths(m.src[1]), s: sec(m.src[1] - m.src[0]) })}</p>
        <div className="ed-modes" role="group" aria-label={T('lookKind')}>
          {LOOK_KINDS.map((k) => (
            <button key={k} type="button" className={`ed-mode look-${k}`} aria-pressed={!m.off && m.look === k} disabled={!shape || m.off}
              onClick={() => onEdit(setLookKind(hand, ref, k, m.was))}>{T(LOOK_NAMES[k])}</button>
          ))}
        </div>
        <div className="ed-btns">
          {'own' in ref ? (
            <button type="button" className="ed-btn bad" disabled={!shape} onClick={() => onEdit(removeLook(hand, ref.own))}>{T('lookDelete')}</button>
          ) : (
            <button type="button" className={`ed-btn${m.off ? '' : ' bad'}`} disabled={!editable} onClick={() => onEdit(setLook(hand, ref.at, !m.off))}>
              {m.off ? T('lookOn') : T('lookOff')}
            </button>
          )}
          {fixed && 'at' in ref ? (
            <button type="button" className="ed-btn" disabled={!editable} title={T('asSessionT')} onClick={() => onEdit(setLook(hand, ref.at, false))}>{T('asSession')}</button>
          ) : null}
        </div>
        <p className="ed-note faint">{note ?? (shape ? T('lookHint') : T('lookHintOld'))}</p>
      </section>
    );
  }
  const x = tracks.transitions.find((m) => m.at === sel.at);
  if (!x) return <p className="ed-note faint">{T('selectHint')}</p>;
  const was = x.was as TransitionKind;
  const fix = (hand.transitions ?? []).find((f) => f.at === sel.at);
  const set = (kind: TransitionKind, off: boolean) => onEdit(setTransition(hand, sel.at, { ...(kind !== was ? { kind } : {}), off }));
  const kind = (fix?.kind ?? was) as TransitionKind;
  return (
    <section className="ed-insp" aria-label={T('transition')}>
      <h2>{T('transition')}{x.off ? ` · ${T('removed')}` : ''}</h2>
      <p className="ed-note mono">{tenths(x.t)}</p>
      <div className="ed-modes" role="group" aria-label={T('trKind')}>
        {TRANSITION_KINDS.map((k) => (
          <button key={k} type="button" className="ed-mode" aria-pressed={!x.off && kind === k} disabled={!editable} onClick={() => set(k, false)}>
            {T(KIND_NAMES[k])}
          </button>
        ))}
      </div>
      <div className="ed-btns">
        <button type="button" className={`ed-btn${x.off ? '' : ' bad'}`} disabled={!editable} onClick={() => set(kind, !x.off)}>
          {x.off ? T('trOn') : T('trOff')}
        </button>
        {fix ? (
          <button type="button" className="ed-btn" disabled={!editable} title={T('trAsMontageT', { k: T(KIND_NAMES[was]) })}
            onClick={() => onEdit(setTransition(hand, sel.at, null))}>{T('asSession')}</button>
        ) : null}
      </div>
      <p className="ed-note faint">{note ?? T('trHint')}</p>
    </section>
  );
}

/** Раздел «Ролик»: скорость (`speed` монтажа — из edit.json) и тизер в начале — есть ли он у монтажа (`teaser`). */
export function VideoSection({ T, hand, speed, teaser, canSpeed, canTeaser, note, teaserNote, onEdit, num }: {
  T: TFn; hand: HandEdits; speed: number; teaser: boolean; canSpeed: boolean; canTeaser: boolean; note: string | null; teaserNote: string | null;
  onEdit: (next: HandEdits, key?: string) => void; num: (x: number) => string; // число с двумя знаками — запятой или точкой, как в языке страницы
}) {
  const now = hand.speed ?? speed;
  const shown = (x: number) => `×${num(x)}`;
  const on = teaser && hand.teaser !== false;
  return (
    <section className="ed-video-panel" aria-label={T('videoSection')}>
      <h2>{T('videoSection')}</h2>
      <div className="ed-shade">
        <span className="ed-range-name">{T('speed')}</span>
        <input type="range" aria-label={T('speed')} min={LIMITS.speed.min} max={LIMITS.speed.max} step={0.05} value={now} disabled={!canSpeed}
          onChange={(e) => onEdit(setSpeed(hand, Number(e.target.value)), 'speed')} />
        <span className="mono">{shown(now)}</span>
      </div>
      {hand.speed !== undefined ? (
        <button type="button" className="ed-btn" disabled={!canSpeed} onClick={() => onEdit(setSpeed(hand, null))}>{T('speedReset')}</button>
      ) : null}
      {teaser ? (
        <>
          <button type="button" className="ed-toggle" aria-pressed={on} disabled={!canTeaser} onClick={() => onEdit(setTeaser(hand, !on))}>{T('teaserOn')}</button>
          <p className="ed-note faint">{teaserNote ?? T('teaserNote')}</p>
        </>
      ) : null}
      {note ? <p className="ed-note faint">{note}</p> : null}
    </section>
  );
}
