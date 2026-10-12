'use client';
// Панели редактора справа от кадра: выбранное на дорожках (кусок, голос, музыка, звук) и стиль ролика.
import type { EditorData } from '@/lib/editordata.ts';
import { LIMITS, setMusic, setSound, setVoice, type HandEdits, type Level } from '@/lib/edits.ts';
import { tenths } from '@/lib/format.ts';
import type { Key } from '@/lib/i18n.ts';
import { ADJUSTABLE, type StyleChoice } from '@/lib/jobfiles.ts';
import type { MusicMix } from '@/lib/sound.ts';
import { choiceFor, clampTo, finalStyle, SUB_SHADE, SWATCHES } from '@/lib/style.ts';
import type { Tracks } from '@/lib/tracks.ts';

type TFn = (k: Key, v?: Record<string, string | number>) => string;

/** Что выбрано на дорожках: кусок (номер в дорожке «Видео»), голос, музыка или звук (ключ правки громкости). */
export type Selection = { kind: 'piece'; index: number } | { kind: 'voice' } | { kind: 'music' } | { kind: 'sound'; key: string };

const db = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x))} dB`;

/** Громкость и «без звука» — ползунок (шаги одного ползунка — одна правка для отмены) и кнопка. */
function LevelControls({ T, label, level, base, range, disabled, onLevel }: {
  T: TFn; label: string; level: Level; base: number; range: { min: number; max: number }; disabled: boolean;
  onLevel: (l: Level, key?: string) => void;
}) {
  const value = level.gainDb ?? base;
  return (
    <>
      <div className="ed-row2">
        <span>{T('volume')}</span>
        <span className="mono">{level.muted ? T('mute').toLowerCase() : db(value)}</span>
      </div>
      <input type="range" aria-label={`${label}: ${T('volume')}`} min={range.min} max={range.max} step={1} value={value} disabled={disabled}
        onChange={(e) => onLevel({ gainDb: Number(e.target.value) }, `${label}:gain`)} />
      <button type="button" className="ed-toggle" aria-pressed={Boolean(level.muted)} disabled={disabled} onClick={() => onLevel({ muted: !level.muted })}>
        {T('mute')}
      </button>
    </>
  );
}

export function Inspector({ T, sel, tracks, hand, mix, editable, splitHere, onSplit, onDelete, onEdit, sec }: {
  T: TFn; sel: Selection | null; tracks: Tracks; hand: HandEdits; mix: MusicMix | null; editable: boolean;
  splitHere: boolean; // плейхед внутри выбранного куска
  onSplit: () => void; onDelete: () => void; onEdit: (next: HandEdits, key?: string) => void; sec: (s: number) => string;
}) {
  if (!sel) return <p className="ed-note faint">{T('selectHint')}</p>;
  if (sel.kind === 'piece') {
    const c = tracks.video[sel.index];
    if (!c || c.src0 === undefined || c.src1 === undefined) return <p className="ed-note faint">{T('selectHint')}</p>;
    const last = tracks.video.filter((x) => x.kind === 'piece').length <= 1;
    return (
      <section className="ed-insp" aria-label={T('piece')}>
        <h2>{c.kind === 'teaser' ? T('teaser') : T('piece')}</h2>
        <p className="ed-note mono">{T('sourceSpan', { a: tenths(c.src0), b: tenths(c.src1), s: sec((c.src1 - c.src0)) })}</p>
        {c.kind === 'piece' ? (
          <div className="ed-btns">
            <button type="button" className="ed-btn" disabled={!editable || !splitHere} onClick={onSplit} title={T('splitT')}>{T('split')}</button>
            <button type="button" className="ed-btn bad" disabled={!editable || last} onClick={onDelete} title={last ? T('lastPiece') : T('deleteT')}>
              {T('delete')}
            </button>
          </div>
        ) : null}
      </section>
    );
  }
  if (sel.kind === 'voice') {
    return (
      <section className="ed-insp" aria-label={T('voice')}>
        <h2>{T('voice')}</h2>
        <LevelControls T={T} label={T('voice')} level={hand.voice ?? {}} base={0} range={LIMITS.gain} disabled={!editable}
          onLevel={(l, key) => onEdit(setVoice(hand, l), key)} />
        <p className="ed-note faint">{T('voiceHint')}</p>
      </section>
    );
  }
  if (sel.kind === 'music') {
    if (!mix) return <p className="ed-note faint">{T('noMusic')}</p>;
    const set = (m: Parameters<typeof setMusic>[1], key?: string) => onEdit(setMusic(hand, m), key);
    const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
    return (
      <section className="ed-insp" aria-label={T('music')}>
        <h2>{T('music')} · {tracks.music?.label}</h2>
        <LevelControls T={T} label={T('music')} level={{ gainDb: mix.gainDb, muted: mix.muted }} base={mix.gainDb} range={LIMITS.musicGain}
          disabled={!editable} onLevel={(l, key) => set(l, key)} />
        <p className="ed-note faint">{T('musicHint', { db: db(mix.gainDb) })}</p>
        <label className="ed-field">
          <span>{T('musicStart')}</span>
          <input type="number" inputMode="decimal" min={0} max={Math.floor(tracks.duration * 10) / 10} step={0.1} value={mix.at} disabled={!editable}
            onChange={(e) => { const v = num(e.target.value); if (v !== null && Number.isFinite(v)) set({ at: Math.min(v, tracks.duration) }, 'music:at'); }} />
        </label>
        <label className="ed-field">
          <span>{T('musicFrom')}</span>
          <input type="number" inputMode="decimal" min={0} step={0.1} value={mix.from} disabled={!editable}
            onChange={(e) => { const v = num(e.target.value); if (v !== null && Number.isFinite(v)) set({ from: v }, 'music:from'); }} />
        </label>
        {(['fadeIn', 'fadeOut'] as const).map((k) => (
          <div key={k} className="ed-fade">
            <div className="ed-row2"><span>{T(k)}</span><span className="mono">{sec(mix[k])}</span></div>
            <input type="range" aria-label={T(k)} min={LIMITS.fade.min} max={LIMITS.fade.max} step={0.1} value={mix[k]} disabled={!editable}
              onChange={(e) => set({ [k]: Number(e.target.value) }, `music:${k}`)} />
          </div>
        ))}
        <p className="ed-note faint">{T('listenHint')}</p>
      </section>
    );
  }
  const sound = tracks.sounds.find((c) => c.key === sel.key);
  if (!sound?.key) return <p className="ed-note faint">{T('selectHint')}</p>;
  const key = sound.key;
  return (
    <section className="ed-insp" aria-label={T('sounds')}>
      <h2>{T('sounds')} · {sound.label}</h2>
      <p className="ed-note mono">{tenths(sound.t0)}</p>
      <LevelControls T={T} label={sound.label} level={hand.sounds?.[key] ?? {}} base={0} range={LIMITS.gain} disabled={!editable}
        onLevel={(l, k) => onEdit(setSound(hand, key, l), k && `${key}:${k}`)} />
    </section>
  );
}

type Styles = NonNullable<EditorData['styles']>;
type Spec = ReturnType<typeof finalStyle>;
type ColorKey = keyof StyleChoice['colors'];
const COLOR_ROWS: [ColorKey, Key][] = [['accent', 'accentColor'], ['text', 'textColor'], ['bar', 'barColor']];

/** Стиль ролика: вариант, шрифты, три цвета и затемнение под субтитрами — как на экране «Превью», в светлой теме.
 *  `note` — чей это выбор: общий с «Превью», ролика (новый — при «Монтировать») или закрыт, пока Claude монтирует. */
export function StylePanel({ T, styles, choice, spec, offered, locked, note, onPick }: {
  T: TFn; styles: Styles; choice: StyleChoice; spec: Spec | null;
  offered: { id: string; family: string; kind: 'main' | 'hand' }[]; locked: boolean; note: string; onPick: (c: StyleChoice) => void;
}) {
  // другой вариант — его шрифты и цвета; места, размеры и затемнение, что Павел выбрал сам, остаются (как на «Превью»)
  const pickVariant = (variant: StyleChoice['variant']) => onPick({
    ...choiceFor(styles, variant),
    ...Object.fromEntries(ADJUSTABLE.filter((k) => choice[k] !== undefined).map((k) => [k, choice[k]])),
  });
  const pickColor = (key: ColorKey, color: string) => onPick({ ...choice, colors: { ...choice.colors, [key]: color.toUpperCase() } });
  const shade = Math.round((spec?.subtitles.shade ?? 0) * 100);
  const fontButtons = (kind: 'main' | 'hand') => offered.filter((f) => f.kind === kind).map((f) => (
    <button key={f.id} type="button" className={`ed-font${kind === 'hand' ? ' hand' : ''}`} aria-pressed={(kind === 'hand' ? choice.hand : choice.font) === f.id}
      disabled={locked} style={{ fontFamily: `"pv-${f.id}", var(--font-ui)` }} onClick={() => onPick({ ...choice, [kind === 'hand' ? 'hand' : 'font']: f.id })}>
      {f.family}
    </button>
  ));
  return (
    <section className="ed-style" aria-label={T('style')}>
      <h2>{T('style')}</h2>
      <p className="ed-note faint">{note}</p>
      <div className="ed-variants" role="group" aria-label={T('style')}>
        {styles.variants.map((v) => (
          <button key={v.id} type="button" aria-pressed={choice.variant === v.id} disabled={locked} onClick={() => pickVariant(v.id)}>
            <b>{v.id}</b> {v.label}
          </button>
        ))}
      </div>
      <h3>{T('font')}</h3>
      <div className="ed-fonts">{fontButtons('main')}</div>
      <h3>{T('hand')}</h3>
      <div className="ed-fonts">{fontButtons('hand')}</div>
      <h3>{T('colors')}</h3>
      {COLOR_ROWS.map(([key, label]) => (
        <div key={key} className="ed-colors" role="group" aria-label={T(label)}>
          <span className="ed-colors-name">{T(label)}</span>
          {SWATCHES[key].map((sw) => (
            <button key={sw.color} type="button" className="ed-swatch" aria-label={sw.name} aria-pressed={choice.colors[key] === sw.color} disabled={locked}
              onClick={() => pickColor(key, sw.color)}>
              <span style={{ background: sw.color }} />
            </button>
          ))}
          <label className="ed-own">
            <input type="color" aria-label={`${T(label)}: ${T('own')}`} value={choice.colors[key].toLowerCase()} disabled={locked}
              onChange={(e) => pickColor(key, e.target.value)} />
          </label>
        </div>
      ))}
      <h3>{T('shade')}</h3>
      <div className="ed-shade">
        <input type="range" aria-label={T('shade')} min={0} max={Math.round(SUB_SHADE.max * 100)} step={5} value={shade} disabled={locked}
          onChange={(e) => onPick({ ...choice, subShade: clampTo('subShade', Number(e.target.value) / 100) })} />
        <span className="mono">{shade ? `${shade} %` : T('shadeOff')}</span>
      </div>
    </section>
  );
}
