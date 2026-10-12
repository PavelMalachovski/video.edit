'use client';
// Картинка ролика руками (timeline.json → zoom, looks, transitions): сила зума — ползунок; ч/б-кусок и переход, выбранные
// на дорожке «Картинка», — убрать или вернуть, у перехода — другой вид. Монтаж кладёт это поверх edit.json сессии
// (edits.apply_picture), кадр редактора показывает сразу.
import { setDim, setLook, setSpeed, setTeaser, setTransition, setZoom, TRANSITION_KINDS, LIMITS, type At, type HandEdits, type TransitionKind } from '@/lib/edits.ts';
import { tenths } from '@/lib/format.ts';
import type { Key } from '@/lib/i18n.ts';
import type { Tracks } from '@/lib/tracks.ts';

type TFn = (k: Key, v?: Record<string, string | number>) => string;

/** Выбранное на дорожке «Картинка»: ч/б-кусок по месту в edit.looks, переход по своему t. */
export type PictureSel = { kind: 'look'; at: At } | { kind: 'transition'; at: number };

export const KIND_NAMES: Record<TransitionKind, Key> = { flash: 'trFlash', zoom: 'trZoom', blur: 'trBlur' };
const sameAt = (a: At, b: At) => a[0] === b[0] && a[1] === b[1];
const percent = (z: number) => `${Math.round(z * 100)} %`;

/** Раздел «Картинка» справа: сила зума, затемнение фона (`dim` монтажа — из edit.json) и сколько ч/б-кусков и переходов в
 *  ролике. `note` — почему править нельзя. */
export function PictureSection({ T, tracks, hand, dim, canZoom, note, onEdit }: {
  T: TFn; tracks: Tracks; hand: HandEdits; dim: number; canZoom: boolean; note: string | null; onEdit: (next: HandEdits, key?: string) => void;
}) {
  const zoom = hand.zoom ?? 1;
  const shade = hand.dim ?? dim;
  const looks = new Map(tracks.looks.map((l) => [`${l.at[0]}|${l.at[1]}`, l.off])); // копия в тизере — тот же кусок
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
        <input type="range" aria-label={T('dimStrength')} min={LIMITS.dim.min} max={LIMITS.dim.max} step={0.05} value={shade} disabled={!canZoom}
          onChange={(e) => onEdit(setDim(hand, Number(e.target.value)), 'dim')} />
        <span className="mono">{percent(shade)}</span>
      </div>
      <p className="ed-note faint">{shade > 0 ? T('dimNote') : T('dimNone')}</p>
      {hand.dim !== undefined ? (
        <button type="button" className="ed-btn" disabled={!canZoom} onClick={() => onEdit(setDim(hand, null))}>{T('dimReset')}</button>
      ) : null}
      <dl className="ed-facts">
        <dt>{T('bw')}</dt><dd className="mono">{T('ofTotal', { n: bw.filter((off) => !off).length, m: bw.length })}</dd>
        <dt>{T('transitions')}</dt><dd className="mono">{T('ofTotal', { n: tr.filter((x) => !x.off).length, m: tr.length })}</dd>
      </dl>
      <p className="ed-note faint">{note ?? T('pictureHint')}</p>
    </section>
  );
}

/** Выбранный ч/б-кусок или переход: убрать, вернуть, другой вид перехода, «как у монтажа». */
export function PicturePick({ T, sel, tracks, hand, editable, note, onEdit, sec }: {
  T: TFn; sel: PictureSel; tracks: Tracks; hand: HandEdits; editable: boolean; note: string | null;
  onEdit: (next: HandEdits, key?: string) => void; sec: (s: number) => string;
}) {
  if (sel.kind === 'look') {
    const marks = tracks.looks.filter((l) => sameAt(l.at, sel.at));
    if (!marks.length) return <p className="ed-note faint">{T('selectHint')}</p>;
    const off = marks[0].off;
    return (
      <section className="ed-insp" aria-label={T('look')}>
        <h2>{T('look')}{off ? ` · ${T('removed')}` : ''}</h2>
        <p className="ed-note mono">{T('sourceSpan', { a: tenths(sel.at[0]), b: tenths(sel.at[1]), s: sec(sel.at[1] - sel.at[0]) })}</p>
        <div className="ed-btns">
          <button type="button" className={`ed-btn${off ? '' : ' bad'}`} disabled={!editable} onClick={() => onEdit(setLook(hand, sel.at, !off))}>
            {off ? T('lookOn') : T('lookOff')}
          </button>
        </div>
        <p className="ed-note faint">{note ?? T('lookHint')}</p>
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
