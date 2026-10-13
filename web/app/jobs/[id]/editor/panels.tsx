'use client';
// Панели редактора справа от кадра: выбранное на дорожках (кусок, голос, музыка, звук) и стиль ролика; блоки текста и
// вставок, слова субтитров — blockpanel.tsx.
import type { EditorData } from '@/lib/editordata.ts';
import type { EditorMedia } from '@/lib/tracks.ts';
import { LIMITS, setMusic, setSound, setTrack, setVoice, type HandEdits, type Level } from '@/lib/edits.ts';
import { tenths } from '@/lib/format.ts';
import type { Key } from '@/lib/i18n.ts';
import { ADJUST, BAR_POSITIONS, HOOK_MODES, SHADE_KINDS, SUBTITLE_MODES, type Adjustable, type BarPos, type HookMode, type ShadeKind, type StyleChoice, type SubtitleMode } from '@/lib/jobfiles.ts';
import type { MusicMix } from '@/lib/sound.ts';
import { choiceFor, clampTo, finalStyle, HOOK_Y_DEFAULT, ownAdjustments, shadeKindOf, shadeKindOk, SUB_SHADE, SWATCHES, withShadeKind } from '@/lib/style.ts';
import { moveTarget, type Tracks } from '@/lib/tracks.ts';
import type { BlockSel, SubSel } from './blockpanel';
import type { PictureSel } from './picturepanel';

type TFn = (k: Key, v?: Record<string, string | number>) => string;

/** Что выбрано на дорожках: кусок (номер в дорожке «Видео»), голос, музыка, звук (ключ правки громкости), блок текста или
 *  вставки, группа субтитров, ч/б-кусок или переход, финальная карточка. */
export type Selection = { kind: 'piece'; index: number } | { kind: 'voice' } | { kind: 'music' } | { kind: 'sound'; key: string } | BlockSel | SubSel
  | PictureSel | { kind: 'end' };

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

export function Inspector({ T, sel, tracks, hand, mix, editable, canMove, splitHere, videos, onSplit, onDelete, onMove, onEdit, sec, music }: {
  T: TFn; sel: Selection | null; tracks: Tracks; hand: HandEdits; mix: MusicMix | null; editable: boolean;
  canMove: boolean; // движок задачи примет перестановку кусков
  // треки библиотеки, трек сессии, чьи доли знает страница (beats.json), можно ли менять трек и почему нельзя
  music: { library: string[]; session: string | null; beats: string | null; canTrack: boolean; note: string | null };
  videos: EditorMedia['videos'] | null; // несколько видео задачи — кусок показывает, из какого он и где в файле
  splitHere: boolean; // плейхед внутри выбранного куска
  onSplit: () => void; onDelete: () => void; onMove: (index: number, slot: number) => void;
  onEdit: (next: HandEdits, key?: string) => void; sec: (s: number) => string;
}) {
  if (!sel) return <p className="ed-note faint">{T('selectHint')}</p>;
  if (sel.kind === 'block' || sel.kind === 'sub' || sel.kind === 'look' || sel.kind === 'transition' || sel.kind === 'end') return null; // blockpanel.tsx, picturepanel.tsx
  if (sel.kind === 'piece') {
    const c = tracks.video[sel.index];
    if (!c || c.src0 === undefined || c.src1 === undefined) return <p className="ed-note faint">{T('selectHint')}</p>;
    const all = tracks.video.filter((x) => x.kind === 'piece');
    const last = all.length <= 1;
    const i = sel.index;
    return (
      <section className="ed-insp" aria-label={T('piece')}>
        <h2>{c.kind === 'teaser' ? T('teaser') : T('pieceOf', { n: all.indexOf(c) + 1, m: all.length })}</h2>
        {videos && c.videoNo !== undefined && videos[c.videoNo] ? (
          <p className="ed-note mono">{T('fromVideo', {
            n: c.videoNo + 1, name: videos[c.videoNo].name, a: tenths(c.src0 - videos[c.videoNo].t0), b: tenths(c.src1 - videos[c.videoNo].t0), s: sec(c.src1 - c.src0),
          })}</p>
        ) : <p className="ed-note mono">{T('sourceSpan', { a: tenths(c.src0), b: tenths(c.src1), s: sec((c.src1 - c.src0)) })}</p>}
        {c.kind === 'piece' ? (
          <div className="ed-btns">
            <button type="button" className="ed-btn" disabled={!editable || !splitHere} onClick={onSplit} title={T('splitT')}>{T('split')}</button>
            <button type="button" className="ed-btn bad" disabled={!editable || last} onClick={onDelete} title={last ? T('lastPiece') : T('deleteT')}>
              {T('delete')}
            </button>
            {/* переставить: перед предыдущим — или за следующий (перед тем, что за ним) */}
            <button type="button" className="ed-btn" disabled={!canMove || !moveTarget(tracks, i, i - 1)} onClick={() => onMove(i, i - 1)} title={T('earlierT')}>
              {T('earlier')}
            </button>
            <button type="button" className="ed-btn" disabled={!canMove || !moveTarget(tracks, i, i + 2)} onClick={() => onMove(i, i + 2)} title={T('laterT')}>
              {T('later')}
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
    // трек — из библиотеки ветки задачи (и трек сессии, даже если его там уже нет); тот же, что у сессии, — без правки
    const options = [...new Set([...(music.session ? [music.session] : []), ...music.library])];
    const name = (f: string) => f.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? f;
    const pick = (
      <label className="ed-field">
        <span>{T('track')}</span>
        <select aria-label={T('track')} value={mix?.file ?? ''} disabled={!music.canTrack || !options.length}
          onChange={(e) => e.target.value && onEdit(setTrack(hand, e.target.value === music.session ? null : e.target.value))}>
          {!mix ? <option value="">{options.length ? T('addMusic') : T('noLibrary')}</option> : null}
          {options.map((f) => <option key={f} value={f}>{f === music.session ? T('trackSession', { name: name(f) }) : name(f)}</option>)}
        </select>
      </label>
    );
    const changed = hand.music?.file !== undefined && mix !== null && mix.file !== music.beats;
    if (!mix) {
      return (
        <section className="ed-insp" aria-label={T('music')}>
          <h2>{T('music')}</h2>
          <p className="ed-note faint">{T('noMusic')}</p>
          {pick}
          {music.note ? <p className="ed-note faint">{music.note}</p> : null}
        </section>
      );
    }
    const set = (m: Parameters<typeof setMusic>[1], key?: string) => onEdit(setMusic(hand, m), key);
    const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
    return (
      <section className="ed-insp" aria-label={T('music')}>
        <h2>{T('music')} · {tracks.music?.label}</h2>
        {pick}
        {changed ? <p className="ed-note faint">{T('trackBeats')}</p> : null}
        {music.note ? <p className="ed-note faint">{music.note}</p> : null}
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
const MODE_NAMES: Record<SubtitleMode, Key> = { karaoke: 'modeKaraoke', plate: 'modePlate', word: 'modeWord', accumulate: 'modeAccumulate', soft: 'modeSoft' };
const HOOK_NAMES: Record<HookMode, Key> = { plate: 'hookPlate', outline: 'hookOutline', shadow: 'hookShadow', accent: 'hookAccent' };
const BAR_NAMES: Record<BarPos, Key> = { bottom: 'barBottom', top: 'barTop' };
const SHADE_NAMES: Record<ShadeKind, Key> = { spot: 'shadeSpot', shadow: 'shadeShadow', plate: 'shadePlate' };
const COLOR_ROWS: [ColorKey, Key][] = [['accent', 'accentColor'], ['text', 'textColor'], ['bar', 'barColor']];

/** Стиль ролика: вариант, шрифты, три цвета и затемнение под субтитрами с его видом — как на экране «Превью», в светлой
 *  теме. `note` — чей это выбор: общий с «Превью», ролика (новый — при «Монтировать») или закрыт, пока Claude монтирует. */
export function StylePanel({ T, styles, choice, spec, offered, locked, note, onPick }: {
  T: TFn; styles: Styles; choice: StyleChoice; spec: Spec | null;
  offered: { id: string; family: string; kind: 'main' | 'hand' }[]; locked: boolean; note: string; onPick: (c: StyleChoice) => void;
}) {
  // другой вариант — его шрифты и цвета; места, размеры, затемнение и его вид, что Павел выбрал сам, остаются (как на «Превью»)
  const pickVariant = (variant: StyleChoice['variant']) => onPick({
    ...choiceFor(styles, variant),
    ...ownAdjustments(choice),
  });
  const pickColor = (key: ColorKey, color: string) => onPick({ ...choice, colors: { ...choice.colors, [key]: color.toUpperCase() } });
  // затемнение и его вид — как на кадре (у смонтированного ролика — и с правками текстом); у субтитров на плашке — только пятно
  const drawn = spec ?? finalStyle(styles, choice);
  const shade = Math.round((drawn.subtitles.shade ?? 0) * 100);
  const shadeKind = shadeKindOf(drawn);
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
      {/* вид затемнения — как на «Превью»: вид при выключенном затемнении включает его на 60 %, сила остаётся */}
      <div className="ed-modes" role="group" aria-label={T('shadeKind')}>
        {SHADE_KINDS.map((k) => (
          <button key={k} type="button" aria-pressed={shade > 0 && shadeKind === k && shadeKindOk(drawn, k)} disabled={locked || !shadeKindOk(drawn, k)}
            onClick={() => onPick(withShadeKind(choice, k, drawn))}>{T(SHADE_NAMES[k])}</button>
        ))}
      </div>
      {shadeKindOk(drawn, 'plate') ? null : <p className="ed-note faint">{T('shadeOwnPlate')}</p>}
      {/* вид субтитров и слов в группе; размер и место — как ручки на «Превью»: px кадра 1080×1920 */}
      <h3>{T('subtitles')}</h3>
      <div className="ed-modes" role="group" aria-label={T('subMode')}>
        {SUBTITLE_MODES.map((m) => (
          <button key={m} type="button" aria-pressed={spec?.subtitles.mode === m} disabled={locked}
            onClick={() => onPick({ ...choice, subMode: m })}>{T(MODE_NAMES[m])}</button>
        ))}
      </div>
      {spec?.subtitles.mode !== 'word' ? (
        <Range T={T} label={T('subWords')} name={T('subtitles')} k="subWords" value={spec?.subtitles.words} locked={locked}
          onPick={(v) => onPick({ ...choice, subWords: v })} />
      ) : null}
      <Range T={T} label={T('size')} name={T('subtitles')} k="subSize" value={spec?.subtitles.size} locked={locked}
        onPick={(v) => onPick({ ...choice, subSize: v })} />
      <Range T={T} label={T('place')} name={T('subtitles')} k="subY" value={spec?.subtitles.y} locked={locked}
        onPick={(v) => onPick({ ...choice, subY: v })} />
      <h3>{T('hook')}</h3>
      <div className="ed-modes" role="group" aria-label={T('hookMode')}>
        {HOOK_MODES.map((m) => (
          <button key={m} type="button" aria-pressed={spec?.hook.mode === m} disabled={locked} onClick={() => onPick({ ...choice, hookMode: m })}>
            {T(HOOK_NAMES[m])}
          </button>
        ))}
      </div>
      <Range T={T} label={T('size')} name={T('hook')} k="hookSize" value={spec?.hook.size} locked={locked}
        onPick={(v) => onPick({ ...choice, hookSize: v })} />
      <Range T={T} label={T('place')} name={T('hook')} k="hookY" value={spec ? spec.hook.y ?? HOOK_Y_DEFAULT : undefined} locked={locked}
        onPick={(v) => onPick({ ...choice, hookY: v })} />
      {/* шкала времени: снизу или сверху и её толщина (px кадра, чётная — так её ставит монтаж) */}
      <h3>{T('barColor')}</h3>
      <div className="ed-modes" role="group" aria-label={T('barPlace')}>
        {BAR_POSITIONS.map((p) => (
          <button key={p} type="button" aria-pressed={spec?.bar.pos === p} disabled={locked} onClick={() => onPick({ ...choice, barPos: p })}>
            {T(BAR_NAMES[p])}
          </button>
        ))}
      </div>
      <Range T={T} label={T('thickness')} name={T('barColor')} k="barHeight" value={spec?.bar.height} locked={locked}
        onPick={(v) => onPick({ ...choice, barHeight: v })} />
    </section>
  );
}

/** Ползунок стиля: в пределах и с шагом ADJUST (как ручки на «Превью»). */
function Range({ T, label, name, k, value, locked, onPick }: {
  T: TFn; label: string; name: string; k: Adjustable; value: number | undefined; locked: boolean; onPick: (v: number) => void;
}) {
  const { range, step } = ADJUST[k];
  if (value === undefined) return null;
  return (
    <div className="ed-shade">
      <span className="ed-range-name">{label}</span>
      <input type="range" aria-label={`${name}: ${label}`} min={range.min} max={range.max} step={step} value={value} disabled={locked}
        onChange={(e) => onPick(clampTo(k, Number(e.target.value)))} />
      <span className="mono">{Math.round(value)}</span>
    </div>
  );
}
