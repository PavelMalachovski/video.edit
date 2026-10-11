'use client';
// Экран «3 · Три превью»: три варианта стиля на настоящем кадре и крупное превью выбора Павла — всё рисует шаблон слоя;
// шрифт и цвета меняются сразу, хук и субтитры двигаются по крупному превью выше-ниже, вставки — куда угодно; размер
// у всех — щипком двумя пальцами или уголком ⤢. «Ещё три варианта» — шаг restyle; «Монтировать» — ответы, стиль и шаг render.
import { useEffect, useMemo, useRef, useState } from 'react';
import { abOptions, buildAnswers, previewEnd, previewHook, type Draft } from '@/lib/answers.ts';
import { storage } from '@/lib/client.ts';
import { mmss } from '@/lib/format.ts';
import { ADJUSTABLE, COVER, type AbKind, type Adjustable, type CoverChoice, type Question, type StyleChoice, type Styles } from '@/lib/jobfiles.ts';
import { MAX_NOTE } from '@/lib/jobs.ts';
import {
  allowedFonts, choiceFor, clampTo, finalStyle, HOOK_SIZE, HOOK_Y, INSERT_W, insertKey, loadAb, loadChoice, loadCover, loadInsertBoxes, loadSpeed, moveBox,
  resizeBox, resolveInserts, sampleState, saveAb, saveChoice, saveCover, saveInsertBoxes, saveSpeed, type InsertBox,
  SPEEDS, SUB_SIZE, SUB_Y, SWATCHES,
} from '@/lib/style.ts';
import PreviewFrame from '../../preview-frame';
import type { Act } from './job';

type FontEntry = { id: string; family: string; file: string; kind: 'main' | 'hand' };
type ColorKey = keyof StyleChoice['colors'];

type Props = {
  jobId: string;
  styles: Styles;
  questions: Question[];
  brief: string; // ТЗ задачи: «МУЗЫКА:» в нём — можно и версию без музыки
  draft: Draft;
  duration: number | null;
  fileUrl: (path: string) => string;
  localUrl: (qid: string) => string | null;
  onBack: () => void;
  onAct: Act;
};

const BIG = 270; // ширина крупного превью, px экрана
const SCALE = BIG / 1080;
const STEP = 20; // px кадра на нажатие «Выше» / «Ниже» и стрелку
const SIZE_STEP = 4; // px размера на нажатие «Меньше» / «Больше»
const GROW = BIG / 2; // уголок ⤢: на сколько px экрана потянуть вправо, чтобы размер вырос вдвое
const INSERT_STEP = 20; // px ширины вставки на нажатие «A−» / «A+»

type Box = { x: number; y: number; w: number; h: number };
type LayoutBoxes = { inserts?: Box[] };
const HOOK_DEFAULT = 400; // центр хука, если в стиле не задан (template/overlay.js, HOOK_Y)
const CARD_T = 10 / 13; // с от начала карточки: уже появилась, призыв — в обычном размере (дышит с частотой 1,3 Гц)

const ROWS: { key: ColorKey; title: string; own: string }[] = [
  { key: 'accent', title: 'Подсветка слова', own: 'Своя подсветка' },
  { key: 'text', title: 'Текст', own: 'Свой цвет текста' },
  { key: 'bar', title: 'Шкала времени', own: 'Свой цвет шкалы' },
];

export default function Previews({ jobId, styles, questions, draft, brief, duration, fileUrl, localUrl, onBack, onAct }: Props) {
  const [choice, setChoiceState] = useState<StyleChoice>(() => loadChoice(storage(), jobId, styles));
  useEffect(() => setChoiceState(loadChoice(storage(), jobId, styles)), [jobId, styles]); // новые варианты — выбор заново
  const setChoice = (c: StyleChoice) => {
    setChoiceState(c);
    saveChoice(storage(), jobId, styles, c);
  };

  const [speed, setSpeedState] = useState<number>(() => loadSpeed(storage(), jobId));
  const setSpeed = (s: number) => {
    setSpeedState(s);
    saveSpeed(storage(), jobId, s);
  };

  // вторая версия для A/B-теста: без тизера или без музыки — что из этого есть в ответах
  const [abPick, setAbPick] = useState<AbKind | null>(() => loadAb(storage(), jobId));
  const abChoices = useMemo(() => abOptions(questions, draft, brief), [questions, draft, brief]);
  const ab = abPick && abChoices.includes(abPick) ? abPick : null;
  // обложка: кадр из трёх, что предложил Claude, и текст (хук); выбор живёт в браузере, как скорость
  const [coverPick, setCoverPick] = useState<CoverChoice | null>(() => loadCover(storage(), jobId));
  const coverFrames = styles.cover?.frames ?? [];
  const cover: CoverChoice | null = styles.cover
    ? (coverPick && coverPick.frame < coverFrames.length ? coverPick : { frame: 0, text: styles.cover.text })
    : null;
  const setCover = (c: CoverChoice) => {
    setCoverPick(c);
    saveCover(storage(), jobId, c);
  };
  const setAb = (x: AbKind | null) => {
    setAbPick(x);
    saveAb(storage(), jobId, x);
  };

  const [fonts, setFonts] = useState<FontEntry[]>([]);
  useEffect(() => {  // шрифты шаблона — и для кнопок выбора: название написано самим шрифтом
    let live = true;
    fetch('/template/fonts.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: FontEntry[]) => {
        if (!live) return;
        setFonts(list);
        for (const f of list) {
          const face = new FontFace(`pv-${f.id}`, `url("/template/${f.file}")`, { weight: '1 1000' });
          document.fonts.add(face);
          void face.load().catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const hook = useMemo(() => previewHook(questions, draft, styles.sample.hook), [questions, draft, styles]);
  const card = useMemo(() => previewEnd(questions, draft, styles.sample.end), [questions, draft, styles]);
  const [showCard, setShowCard] = useState(false); // крупное превью — финальная карточка вместо кадра с текстом
  const [insertBoxes, setInsertBoxesState] = useState<Record<string, InsertBox>>(() => loadInsertBoxes(storage(), jobId));
  const setInsertBoxes = (next: Record<string, InsertBox>) => {
    setInsertBoxesState(next);
    saveInsertBoxes(storage(), jobId, next);
  };
  const inserts = useMemo(() => resolveInserts(styles.sample, questions, draft, fileUrl, localUrl, insertBoxes),
    [styles, questions, draft, fileUrl, localUrl, insertBoxes]);
  const [boxes, setBoxes] = useState<LayoutBoxes | null>(null); // рамки крупного превью от шаблона: по ним ручки вставок
  const thumbs = useMemo(() => styles.variants.map((v) => ({ v, state: sampleState(v.spec, styles.sample, hook, inserts) })), [styles, hook, inserts]);
  const spec = useMemo(() => finalStyle(styles, choice), [styles, choice]);
  const framed = useMemo(() => sampleState(spec, styles.sample, hook, inserts), [spec, styles, hook, inserts]);
  const ending = Boolean(showCard && card);
  const state = useMemo(() => (ending && card
    ? { inserts: [], end: { lines: card.lines, ...(card.handle ? { handle: card.handle } : {}), ...(card.logo ? { logo: fileUrl(card.logo) } : {}), t: CARD_T } }
    : framed), [ending, card, framed, fileUrl]);
  const progress = duration ? Math.min(1, styles.frameTime / duration) : 0.3;
  const frameUrl = fileUrl(styles.frame);
  const family = (id: string) => fonts.find((f) => f.id === id)?.family ?? id;
  const offered = useMemo(() => allowedFonts(fonts, styles), [fonts, styles]); // только шрифты со всеми буквами ролика

  const [tweak, setTweak] = useState('');
  const [busy, setBusy] = useState<'restyle' | 'answers' | null>(null);
  const [error, setError] = useState<{ at: 'restyle' | 'answers'; text: string } | null>(null);

  async function run(at: 'restyle' | 'answers', extra: Record<string, unknown>) {
    setBusy(at);
    setError(null);
    const why = await onAct(at, extra);
    setBusy(null);
    if (why) setError({ at, text: why });
  }

  function mount() {
    const { answers, uploads, missing } = buildAnswers(questions, draft);
    if (missing.length) return setError({ at: 'answers', text: 'Не на все вопросы есть ответ — вернитесь к вопросам' });
    const claims = Object.fromEntries(Object.entries(uploads).map(([qid, u]) => [qid, { asset: u.asset, name: u.name, size: u.size, type: u.type, parts: u.parts }]));
    const keys = new Set((styles.sample.inserts ?? []).map(insertKey));
    const placed = Object.fromEntries(Object.entries(insertBoxes).filter(([k]) => keys.has(k))); // только вставки этого превью
    void run('answers', { answers, uploads: claims, style: choice, speed, ...(Object.keys(placed).length ? { insertBoxes: placed } : {}), ...(ab ? { ab } : {}), ...(cover && cover.text.trim() ? { cover: { frame: cover.frame, text: cover.text.trim() } } : {}) });
  }

  const pickFont = (kind: 'font' | 'hand', id: string) => setChoice({ ...choice, [kind]: id });
  // смена варианта сбрасывает шрифты и цвета к нему, а места хука и субтитров, которые Павел выбрал сам, остаются
  const pickVariant = (id: StyleChoice['variant']) => setChoice({
    ...choiceFor(styles, id),
    ...Object.fromEntries(ADJUSTABLE.filter((k) => choice[k] !== undefined).map((k) => [k, choice[k]])),
  });
  const set = (key: Adjustable) => (x: number) => setChoice({ ...choice, [key]: clampTo(key, x) });
  const reset = (...keys: Adjustable[]) => () =>
    setChoice(Object.fromEntries(Object.entries(choice).filter(([k]) => !keys.includes(k as Adjustable))) as StyleChoice);
  const subs = {
    name: 'Субтитры', label: 'Высота субтитров', y: spec.subtitles.y, range: SUB_Y, move: set('subY'),
    size: spec.subtitles.size, sizes: SUB_SIZE, resize: set('subSize'),
    changed: choice.subY !== undefined || choice.subSize !== undefined, reset: reset('subY', 'subSize'),
  };
  const hookPart = {
    name: 'Хук', label: 'Высота хука', y: spec.hook.y ?? HOOK_DEFAULT, range: HOOK_Y, move: set('hookY'),
    size: spec.hook.size, sizes: HOOK_SIZE, resize: set('hookSize'),
    changed: choice.hookY !== undefined || choice.hookSize !== undefined, reset: reset('hookY', 'hookSize'),
  };
  const movable = ending ? [] : state.hook ? [hookPart, subs] : [subs]; // хук настраивается, когда он есть на превью
  // вставки на крупном превью, у которых есть ключ (question, src или id стикера-тезиса): перетаскиваются куда угодно;
  // размер — щипком, уголком и кнопками. Рамка — от шаблона (вместе с тенью), высота — по ней
  const sized = state.inserts.flatMap((ins, i) => {
    if (!ins.key) return [];
    const key = ins.key;
    const sticker = ins.kind === 'text';
    const n = state.inserts.slice(0, i + 1).filter((x) => x.key && (x.kind === 'text') === sticker).length;
    const drawn = boxes?.inserts?.[i] ?? null;
    const now: InsertBox = { x: ins.x, y: ins.y, w: ins.w };
    const h = drawn?.h ?? ins.w;
    const place = (b: InsertBox) => setInsertBoxes({ ...insertBoxes, [key]: b });
    return [{
      key, name: `${sticker ? 'Стикер' : 'Вставка'} ${n}`, w: ins.w, at: now, box: drawn, changed: key in insertBoxes,
      resize: (w: number) => place(resizeBox(now, w, h)),
      drag: (x: number, y: number) => place(moveBox(now, x, y, h)),
      reset: () => setInsertBoxes(Object.fromEntries(Object.entries(insertBoxes).filter(([k]) => k !== key))),
    }];
  });
  const pickColor = (key: ColorKey, color: string) => setChoice({ ...choice, colors: { ...choice.colors, [key]: color.toUpperCase() } });

  return (
    <>
      <button type="button" className="back link" onClick={onBack}>← Вопросы</button>
      <header className="job-head">
        <h1 className="screen-title">Выбери стиль</h1>
        <div className="muted">Один кадр с {mmss(styles.frameTime)} в трёх вариантах. Шрифт и цвета меняются сразу, без ожидания.</div>
      </header>

      <div className="variants">
        {thumbs.map(({ v, state: s }) => (
          <div key={v.id} className="variant">
            <div className={`variant-frame${choice.variant === v.id ? ' on' : ''}`}>
              <PreviewFrame frameUrl={frameUrl} spec={v.spec} state={s} progress={progress} width={102} />
              <button type="button" className="variant-hit" aria-pressed={choice.variant === v.id} aria-label={`${v.id} · ${v.label}`}
                onClick={() => pickVariant(v.id)} />
            </div>
            <div className="variant-label">{v.id} · {v.label}</div>
          </div>
        ))}
      </div>

      <div className="big-wrap">
        <div className="big-host">
          <PreviewFrame frameUrl={frameUrl} spec={spec} state={state} progress={progress} width={BIG} big onBoxes={(b) => setBoxes(b as LayoutBoxes)} />
          {ending ? null : sized.map((m) => m.box ? <InsertHandle key={m.key} label={m.name} box={m.box} at={m.at} onSize={m.resize} onDrag={m.drag} /> : null)}
          {movable.map((m) => <DragHandle key={m.name} label={m.label} y={m.y} range={m.range} onMove={m.move} size={m.size} onSize={m.resize} />)}
        </div>
      </div>
      {card ? (
        <div className="pills center">
          <button type="button" className="pill" aria-pressed={!ending} onClick={() => setShowCard(false)}>Кадр с текстом</button>
          <button type="button" className="pill" aria-pressed={ending} onClick={() => setShowCard(true)}>Финальная карточка</button>
        </div>
      ) : null}
      <div className="sub-move" hidden={ending}>
        <span className="muted small">Хук и субтитры тянутся на превью выше или ниже, вставки — куда угодно; размер — щипком двумя пальцами или уголком ⤢</span>
        {movable.map((m) => (
          <div key={m.name} className="sub-move-row">
            <span className="small">{m.name}</span>
            <button type="button" className="pill" aria-label={`${m.name} выше`} disabled={m.y <= m.range.min} onClick={() => m.move(m.y - STEP)}>↑</button>
            <button type="button" className="pill" aria-label={`${m.name} ниже`} disabled={m.y >= m.range.max} onClick={() => m.move(m.y + STEP)}>↓</button>
            <button type="button" className="pill" aria-label={`${m.name} меньше`} disabled={m.size <= m.sizes.min} onClick={() => m.resize(m.size - SIZE_STEP)}>A−</button>
            <button type="button" className="pill" aria-label={`${m.name} больше`} disabled={m.size >= m.sizes.max} onClick={() => m.resize(m.size + SIZE_STEP)}>A+</button>
            {m.changed ? <button type="button" className="link" aria-label={`${m.name}: как в варианте`} onClick={m.reset}>Как было</button> : null}
          </div>
        ))}
        {sized.map((m) => (
          <div key={m.key} className="sub-move-row">
            <span className="small">{m.name}</span>
            <button type="button" className="pill" aria-label={`${m.name} меньше`} disabled={m.w <= INSERT_W.min} onClick={() => m.resize(m.w - INSERT_STEP)}>A−</button>
            <button type="button" className="pill" aria-label={`${m.name} больше`} disabled={m.w >= INSERT_W.max} onClick={() => m.resize(m.w + INSERT_STEP)}>A+</button>
            {m.changed ? <button type="button" className="link" aria-label={`${m.name}: как было`} onClick={m.reset}>Как было</button> : null}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="caps small">Шрифт</div>
        <div className="font-grid">
          {offered.filter((f) => f.kind !== 'hand').map((f) => (
            <button key={f.id} type="button" className="font" aria-pressed={choice.font === f.id} style={{ fontFamily: `"pv-${f.id}", var(--font-ui)` }}
              onClick={() => pickFont('font', f.id)}>{f.family}</button>
          ))}
        </div>
        <div className="caps small">Рукописный — для хука и кодового слова</div>
        <div className="font-grid">
          {offered.filter((f) => f.kind === 'hand').map((f) => (
            <button key={f.id} type="button" className="font hand" aria-pressed={choice.hand === f.id} style={{ fontFamily: `"pv-${f.id}", var(--font-ui)` }}
              onClick={() => pickFont('hand', f.id)}>{f.family}</button>
          ))}
        </div>
      </div>

      <div className="card">
        {ROWS.map((row) => (
          <div key={row.key} className="swatch-row">
            <div className="caps small">{row.title}</div>
            <div className="swatches">
              {SWATCHES[row.key].map((s) => (
                <button key={s.color} type="button" className="swatch" aria-label={s.name} aria-pressed={choice.colors[row.key] === s.color}
                  onClick={() => pickColor(row.key, s.color)}>
                  <span style={{ background: s.color }} />
                </button>
              ))}
              <label className="own-color">
                <input type="color" aria-label={row.own} value={choice.colors[row.key].toLowerCase()} onChange={(e) => pickColor(row.key, e.target.value)} />
                Свой
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="caps small">Скорость ролика</div>
        <div className="pills">
          {SPEEDS.map((s) => (
            <button key={s} type="button" className="pill" aria-pressed={speed === s} onClick={() => setSpeed(s)}>×{s.toFixed(1)}</button>
          ))}
        </div>
        <div className="muted small">Голос не меняет тон; музыка не ускоряется.</div>
      </div>

      {cover ? (
        <div className="card" data-cover>
          <div className="caps small">Обложка</div>
          <div className="cover-frames">
            {coverFrames.map((f, i) => (
              <button key={f.image} type="button" className="cover-pick" aria-pressed={cover.frame === i} aria-label={`Кадр ${i + 1}`}
                onClick={() => setCover({ ...cover, frame: i })}>
                <img src={fileUrl(f.image)} alt="" />
              </button>
            ))}
          </div>
          <input type="text" aria-label="Текст обложки" maxLength={COVER.text} value={cover.text} onChange={(e) => setCover({ ...cover, text: e.target.value })} />
          <div className="cover-preview">
            <PreviewFrame frameUrl={fileUrl(coverFrames[cover.frame].image)} spec={spec} state={{ inserts: [], cover: { text: cover.text.trim() || styles.cover?.text || '' } }}
              progress={0} width={BIG} />
          </div>
          <div className="muted small">В сетке профиля видна середина кадра 3:4 — текст стоит в ней. PNG — на экране «Готово».</div>
        </div>
      ) : null}

      {abChoices.length ? (
        <div className="card">
          <div className="caps small">Вторая версия для теста</div>
          <div className="pills">
            <button type="button" className="pill" aria-pressed={!ab} onClick={() => setAb(null)}>Не нужна</button>
            {abChoices.includes('teaser') ? <button type="button" className="pill" aria-pressed={ab === 'teaser'} onClick={() => setAb('teaser')}>Без тизера</button> : null}
            {abChoices.includes('music') ? <button type="button" className="pill" aria-pressed={ab === 'music'} onClick={() => setAb('music')}>Без музыки</button> : null}
          </div>
          <div className="muted small">
            {ab ? `Соберу два ролика: A — как выбрано, B — ${ab === 'teaser' ? 'без тизера' : 'без музыки'}. Выложи оба и сравни, какой смотрят дольше.`
              : 'Можно собрать второй ролик, который отличается одним, — и проверить, какой работает лучше.'}
          </div>
        </div>
      ) : null}

      <div className="card">
        <label htmlFor="tweak" className="label">Ни один не подходит? Скажи, что поменять</label>
        <input id="tweak" type="text" maxLength={MAX_NOTE} placeholder="Например: заголовок без плашки" value={tweak} onChange={(e) => setTweak(e.target.value)} />
        <button type="button" className="btn ghost" disabled={!tweak.trim() || busy !== null} onClick={() => void run('restyle', { text: tweak.trim() })}>
          Ещё три варианта
        </button>
        {error?.at === 'restyle' ? <div className="err small">{error.text}</div> : null}
      </div>

      <button type="button" className="btn" disabled={busy !== null} onClick={mount}>
        Монтировать: {choice.variant} · {family(choice.font)} · ×{speed.toFixed(1)}{ab ? ' · A/B' : ''}
      </button>
      {error?.at === 'answers' ? <div className="err small">{error.text}</div> : null}
    </>
  );
}

type HandleProps = {
  label: string; y: number; range: { min: number; max: number }; onMove: (y: number) => void; size: number; onSize: (size: number) => void;
};
type Gesture =
  | { kind: 'move'; from: number; y: number }
  | { kind: 'drag'; fromX: number; fromY: number; x: number; y: number }
  | { kind: 'grow'; from: number; size: number }
  | { kind: 'pinch'; span: number; size: number };

/** Жесты ручки: один палец или мышь — `move` (только выше-ниже) или `drag` (куда угодно); два пальца — щипок, `onSize`;
 *  уголок `[data-grip]` мышкой вправо-влево — тоже `onSize`. Палец убран — жест закончен: оставшийся палец ручку не дёргает. */
function useGestures(size: number, onSize: (size: number) => void, move?: { y: number; onMove: (y: number) => void },
  drag?: { x: number; y: number; onDrag: (x: number, y: number) => void }) {
  const points = useRef(new Map<number, number>()); // пальцы на ручке: id → x
  const gesture = useRef<Gesture | null>(null);
  const span = () => {
    const [a, b] = [...points.current.values()];
    return Math.abs(a - b);
  };
  const end = (id: number) => {
    points.current.delete(id);
    gesture.current = null;
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // указатель уже ушёл — жест всё равно ловим
      }
      points.current.set(e.pointerId, e.clientX);
      const g = gesture.current;
      if (points.current.size >= 2) {
        if (g?.kind === 'move') move?.onMove(g.y); // первый палец уже сдвинул ручку — щипок только про размер
        if (g?.kind === 'drag') drag?.onDrag(g.x, g.y);
        gesture.current = { kind: 'pinch', span: Math.max(1, span()), size };
      } else if ((e.target as HTMLElement).closest('[data-grip]')) {
        gesture.current = { kind: 'grow', from: e.clientX, size };
      } else if (move) {
        gesture.current = { kind: 'move', from: e.clientY, y: move.y };
      } else if (drag) {
        gesture.current = { kind: 'drag', fromX: e.clientX, fromY: e.clientY, x: drag.x, y: drag.y };
      }
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (points.current.has(e.pointerId)) points.current.set(e.pointerId, e.clientX);
      const g = gesture.current;
      if (g?.kind === 'move') move?.onMove(g.y + (e.clientY - g.from) / SCALE);
      else if (g?.kind === 'drag') drag?.onDrag(g.x + (e.clientX - g.fromX) / SCALE, g.y + (e.clientY - g.fromY) / SCALE);
      else if (g?.kind === 'grow') onSize(g.size * (1 + (e.clientX - g.from) / GROW));
      else if (g?.kind === 'pinch' && points.current.size >= 2) onSize((g.size * span()) / g.span);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => end(e.pointerId),
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => end(e.pointerId),
  };
}

/** Ручка текста на крупном превью — полоса на высоте `y` (px кадра): двигает выше-ниже и меняет размер; стрелки — по STEP. */
function DragHandle({ label, y, range, onMove, size, onSize }: HandleProps) {
  const gestures = useGestures(size, onSize, { y, onMove });
  return (
    <div className="sub-handle" role="slider" tabIndex={0} aria-label={label} aria-orientation="vertical"
      aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={y} title={`${label}: потяни выше или ниже; размер — щипком или уголком`}
      style={{ top: y * SCALE }} {...gestures}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        onMove(y + (e.key === 'ArrowUp' ? -STEP : STEP));
      }}>
      <span className="size-grip" data-grip aria-hidden="true">⤢</span>
    </div>
  );
}

type InsertHandleProps = {
  label: string; box: Box; at: InsertBox; onSize: (w: number) => void; onDrag: (x: number, y: number) => void;
};

/** Ручка вставки — рамка по её месту на крупном превью (от шаблона): один палец или мышь — тащит куда угодно, щипок или
 *  уголок ⤢ — ширина; стрелки — сдвиг по STEP. */
function InsertHandle({ label, box, at, onSize, onDrag }: InsertHandleProps) {
  const gestures = useGestures(at.w, onSize, undefined, { x: at.x, y: at.y, onDrag });
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
  return (
    <div className="insert-handle" role="slider" tabIndex={0} aria-label={label} aria-valuemin={INSERT_W.min} aria-valuemax={INSERT_W.max}
      aria-valuenow={at.w} aria-valuetext={`x ${at.x}, y ${at.y}, ширина ${at.w}`} title={`${label}: перетащи; размер — щипком или уголком`}
      style={{ left: box.x * SCALE, top: box.y * SCALE, width: box.w * SCALE, height: box.h * SCALE }} {...gestures}
      onKeyDown={(e) => {
        const step = arrows[e.key];
        if (!step) return;
        e.preventDefault();
        onDrag(at.x + step[0], at.y + step[1]);
      }}>
      <span className="size-grip" data-grip aria-hidden="true">⤢</span>
    </div>
  );
}
