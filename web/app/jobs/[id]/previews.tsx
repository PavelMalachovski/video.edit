'use client';
// Экран «3 · Три превью» — редактор «Монтажки»: тулбар с «Монтировать» и чёрная сцена с крупным превью выбора Павла
// прилипают к верху, под ними — вкладки настроек (вариант, шрифт, цвет, место, скорость, обложка, реклама, A/B). Всё на
// превью рисует шаблон слоя; шрифт и цвета меняются сразу, хук и субтитры двигаются по крупному превью выше-ниже, вставки —
// куда угодно; размер у всех — щипком двумя пальцами или уголком ⤢. «Ещё три варианта» — шаг restyle; «Монтировать» —
// ответы, стиль и шаг render.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { abOptions, buildAnswers, previewEnd, previewHook, type Draft } from '@/lib/answers.ts';
import { storage } from '@/lib/client.ts';
import { mmss } from '@/lib/format.ts';
import { editorTabs, mountSummary, nextTab, STAGE, stageFit, type TabId } from '@/lib/editor.ts';
import { ADJUSTABLE, COVER, type AbKind, type Adjustable, type Question, type StyleChoice, type Styles } from '@/lib/jobfiles.ts';
import { MAX_NOTE } from '@/lib/jobs.ts';
import {
  allowedFonts, choiceFor, clampTo, coverOf, finalStyle, underCaption, HOOK_SIZE, HOOK_Y, INSERT_W, insertKey, loadAb, loadAd, loadChoice, loadCover, loadInsertBoxes, loadSpeed, moveBox,
  resizeBox, resolveInserts, sampleState, saveAb, saveAd, saveChoice, saveCover, saveInsertBoxes, saveSpeed, type CoverPick, type InsertBox,
  SPEEDS, SUB_SHADE, SUB_SIZE, SUB_Y, SWATCHES,
} from '@/lib/style.ts';
import {
  FrameIcon, GaugeIcon, LayersIcon, MoveIcon, PaletteIcon, RefreshIcon, ScissorsIcon, SplitIcon, TypeIcon,
} from '../../icons';
import PreviewFrame from '../../preview-frame';
import { TopBar } from '../../top-bar';
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

// крупное превью — до 270 px экрана, на невысоком экране — уже (lib/editor.ts, stageFit); scale — px экрана на px кадра
const RESTICK_MS = 400; // поле под сценой потеряло фокус — столько ждать, прежде чем сцена снова прилипнет (тап успеет дойти)
const STEP = 20; // px кадра на нажатие «Выше» / «Ниже» и стрелку
const SIZE_STEP = 4; // px размера на нажатие «Меньше» / «Больше»
const GROW = 540; // уголок ⤢: на столько px кадра (половина его ширины) потянуть вправо, чтобы размер вырос вдвое
const INSERT_STEP = 20; // px ширины вставки на нажатие «A−» / «A+»

type Box = { x: number; y: number; w: number; h: number };
type LayoutBoxes = { inserts?: Box[]; sub?: Box };
const HOOK_DEFAULT = 400; // центр хука, если в стиле не задан (template/overlay.js, HOOK_Y)
const CARD_T = 10 / 13; // с от начала карточки: уже появилась, призыв — в обычном размере (дышит с частотой 1,3 Гц)

const TAB_ICONS: Record<TabId, ReactNode> = {
  style: <LayersIcon />, font: <TypeIcon />, color: <PaletteIcon />, place: <MoveIcon />, speed: <GaugeIcon />, cover: <FrameIcon />,
  versions: <SplitIcon />,
};

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

  // сцена по высоте экрана: липнет, если под ней остаётся место на инструменты; превью экран рисует только в браузере,
  // поэтому высота известна сразу (без мигания). Пересчёт — при повороте: высота сама скачет, когда Safari прячет панель
  const [fit, setFit] = useState(() => stageFit(typeof window === 'undefined' ? Number.NaN : window.innerHeight));
  useEffect(() => {
    let width = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      setFit(stageFit(window.innerHeight));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const bigW = fit.width;
  const scale = bigW / 1080;
  // пока печатают в поле под сценой, она не липнет (клавиатура телефона спрятала бы поле под ней); потерял поле фокус —
  // липнет не сразу, а через RESTICK_MS: иначе тап, который увёл фокус, отпускается уже на сцене и до цели не доходит
  const [typing, setTyping] = useState(false);
  const restick = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (restick.current) clearTimeout(restick.current);
  }, []);
  const isField = (t: EventTarget | null) => (t instanceof HTMLInputElement && t.type === 'text') || t instanceof HTMLTextAreaElement;
  const onFieldFocus = (e: React.FocusEvent) => {
    if (!isField(e.target)) return;
    if (restick.current) clearTimeout(restick.current);
    setTyping(true);
  };
  const onFieldBlur = (e: React.FocusEvent) => {
    if (!isField(e.target)) return;
    if (restick.current) clearTimeout(restick.current);
    restick.current = setTimeout(() => setTyping(false), RESTICK_MS);
  };
  const stuck = fit.sticky && !typing;
  useEffect(() => {  // Tab и прокрутка к полю не прячут цель под прилипшей сценой
    if (!stuck) return;
    const root = document.documentElement;
    root.style.scrollPaddingTop = `${STAGE.toolbar + fit.height + 8}px`;
    return () => {
      root.style.scrollPaddingTop = '';
    };
  }, [stuck, fit.height]);
  const [tab, setTab] = useState<TabId>('style');
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());

  const [speed, setSpeedState] = useState<number>(() => loadSpeed(storage(), jobId));
  const setSpeed = (s: number) => {
    setSpeedState(s);
    saveSpeed(storage(), jobId, s);
  };

  // вторая версия для A/B-теста: без тизера или без музыки — что из этого есть в ответах
  const [abPick, setAbPick] = useState<AbKind | null>(() => loadAb(storage(), jobId));
  const abChoices = useMemo(() => abOptions(questions, draft, brief), [questions, draft, brief]);
  const ab = abPick && abChoices.includes(abPick) ? abPick : null;
  // обложка: кадр из трёх, что предложил Claude, и текст — за хуком, пока Павел не впишет свой; выбор — в браузере
  const [coverPick, setCoverPick] = useState<CoverPick | null>(() => loadCover(storage(), jobId));
  const coverFrames = styles.cover?.frames ?? [];
  const setCover = (p: CoverPick) => {
    setCoverPick(p);
    saveCover(storage(), jobId, p);
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
  const cover = coverOf(coverPick, styles, hook);
  const coverText = cover?.text;
  const coverState = useMemo(() => ({ inserts: [], cover: { text: coverText ?? '' } }), [coverText]); // не перерисовывать на каждом движении
  const card = useMemo(() => previewEnd(questions, draft, styles.sample.end), [questions, draft, styles]);
  const [showCard, setShowCard] = useState(false); // крупное превью — финальная карточка вместо кадра с текстом
  const [adOn, setAdOn] = useState(() => loadAd(storage(), jobId)); // ещё версия для рекламы Reels
  const [adsView, setAdsView] = useState(false); // крупное превью — как в версии для рекламы
  const setAd = (on: boolean) => {
    setAdOn(on);
    saveAd(storage(), jobId, on);
    if (!on) setAdsView(false);
  };
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
  const shown = useMemo(() => (ending && card
    ? { inserts: [], end: { lines: card.lines, ...(card.handle ? { handle: card.handle } : {}), ...(card.logo ? { logo: fileUrl(card.logo) } : {}), t: CARD_T } }
    : framed), [ending, card, framed, fileUrl]);
  const zoned = adOn && adsView; // на крупном превью — зона рекламы: ручки прячутся, двигается то, что в основном ролике
  const state = useMemo(() => (zoned ? { ...shown, zone: 'ads' as const } : shown), [zoned, shown]);
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
    void run('answers', { answers, uploads: claims, style: choice, speed, ...(Object.keys(placed).length ? { insertBoxes: placed } : {}), ...(ab ? { ab } : {}), ...(adOn ? { ad: true } : {}), ...(cover ? { cover } : {}) });
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
  // мягкое пятно под субтитрами — в процентах на ползунке; 0 — выключено (поле выбора убирается)
  const shade = Math.round((spec.subtitles.shade ?? 0) * 100);
  const setShade = (pct: number) => (pct > 0 ? set('subShade')(pct / 100) : reset('subShade')());
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

  const summary = mountSummary({ variant: choice.variant, font: family(choice.font), speed, ab: ab !== null, ad: adOn });
  const tabs = editorTabs({ cover: cover !== null });
  const current: TabId = tabs.some((t) => t.id === tab) ? tab : 'style'; // вкладки уже нет (пропала обложка) — первая
  // на вкладке «Обложка» крупное превью — сама обложка: её видно целиком, пока правят кадр и текст
  const coverView = current === 'cover' && cover !== null;
  const stage = coverView && cover
    ? { frameUrl: fileUrl(coverFrames[cover.frame].image), state: coverState, progress: 0 }
    : { frameUrl, state, progress };
  const keyTab = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const next = nextTab(tabs, current, e.key);
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };
  const own = (label: string, value: string, pick: (color: string) => void) => (
    <label className="own-color">
      <input type="color" aria-label={label} value={value.toLowerCase()} onChange={(e) => pick(e.target.value)} />
      Свой
    </label>
  );

  return (
    <div className={`editor${stuck ? ' stuck' : ''}`}>
      <div className="editor-top">
        <TopBar back={{ onClick: onBack, label: 'Вопросы' }} title="Выбери стиль" meta="шаг 4 из 5"
          action={(
            <button type="button" className="btn tb-action" aria-label={`Монтировать: ${summary}`} disabled={busy !== null} onClick={mount}>
              <ScissorsIcon />
              Монтировать
            </button>
          )} />
        {error?.at === 'answers' ? <div className="editor-alert" role="alert">{error.text}</div> : null}
        <div className="stage" style={{ height: fit.height }}>
          <div className="big-host">
            <PreviewFrame frameUrl={stage.frameUrl} spec={spec} state={stage.state} progress={stage.progress} width={bigW} big onBoxes={(b) => setBoxes(b as LayoutBoxes)} />
            {ending || zoned || coverView ? null : sized.map((m) => m.box ? <InsertHandle key={m.key} label={m.name} box={m.box} at={m.at} scale={scale} onSize={m.resize} onDrag={m.drag} /> : null)}
            {zoned || coverView ? null : movable.map((m) => <DragHandle key={m.name} label={m.label} y={m.y} range={m.range} scale={scale} onMove={m.move} size={m.size} onSize={m.resize} />)}
          </div>
        </div>
      </div>

      <div className="editor-body" onFocus={onFieldFocus} onBlur={onFieldBlur}>
        <div className="summary">{summary}</div>
        {underCaption(boxes?.sub) && !ending && !zoned && !coverView ? <div className="warn small">Субтитры низко: в Reels их может закрыть подпись к ролику</div> : null}

        <div role="tablist" aria-label="Настройки" className="tabs">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="tab" id={`tab-${t.id}`} aria-selected={current === t.id} aria-controls="tab-panel"
              tabIndex={current === t.id ? 0 : -1} onClick={() => setTab(t.id)} onKeyDown={keyTab}
              ref={(el) => { if (el) tabRefs.current.set(t.id, el); else tabRefs.current.delete(t.id); }}>
              {TAB_ICONS[t.id]}
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id="tab-panel" aria-labelledby={`tab-${current}`} className="tab-panel">
          {current === 'style' ? (
            <>
              <div className="muted small">Один кадр с {mmss(styles.frameTime)} в трёх вариантах. Шрифт и цвета меняются сразу, без ожидания.</div>
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
              {card ? (
                <div className="seg" role="group" aria-label="Что на крупном превью">
                  <button type="button" aria-pressed={!ending} onClick={() => setShowCard(false)}>Кадр с текстом</button>
                  <button type="button" aria-pressed={ending} onClick={() => setShowCard(true)}>Финальная карточка</button>
                </div>
              ) : null}
            </>
          ) : null}

          {current === 'font' ? (
            <>
              <div className="font-grid">
                {offered.filter((f) => f.kind !== 'hand').map((f) => (
                  <button key={f.id} type="button" className="font" aria-pressed={choice.font === f.id} style={{ fontFamily: `"pv-${f.id}", var(--font-ui)` }}
                    onClick={() => pickFont('font', f.id)}>{f.family}</button>
                ))}
              </div>
              <div className="caps">Рукописный — для хука и кодового слова</div>
              <div className="font-grid">
                {offered.filter((f) => f.kind === 'hand').map((f) => (
                  <button key={f.id} type="button" className="font hand" aria-pressed={choice.hand === f.id} style={{ fontFamily: `"pv-${f.id}", var(--font-ui)` }}
                    onClick={() => pickFont('hand', f.id)}>{f.family}</button>
                ))}
              </div>
            </>
          ) : null}

          {current === 'color' ? ROWS.map((row) => (
            <div key={row.key} className="swatch-row">
              <div className="caps">{row.title}</div>
              <div className="swatches">
                {SWATCHES[row.key].map((sw) => (
                  <button key={sw.color} type="button" className="swatch" aria-label={sw.name} aria-pressed={choice.colors[row.key] === sw.color}
                    onClick={() => pickColor(row.key, sw.color)}>
                    <span style={{ background: sw.color }} />
                  </button>
                ))}
                {own(row.own, choice.colors[row.key], (c) => pickColor(row.key, c))}
              </div>
            </div>
          )) : null}

          {current === 'place' ? (
            <div className="sub-move">
              {ending || zoned ? (
                <div className="muted small">{ending ? 'На финальной карточке двигать нечего — вернись к кадру с текстом на вкладке «Стиль».'
                  : 'В зоне рекламы место не меняется: двигается основной ролик — включи «Органика» на вкладке «Реклама».'}</div>
              ) : (
                <>
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
                  <div className="sub-move-row">
                    <span className="small">Затемнение</span>
                    <input type="range" className="shade-range" aria-label="Затемнение под субтитрами" min={0} max={Math.round(SUB_SHADE.max * 100)} step={5}
                      value={shade} aria-valuetext={shade ? `фон под субтитрами темнее на ${shade} %` : 'нет'} onChange={(e) => setShade(Number(e.target.value))} />
                    <span className="small mono shade-value">{shade ? `${shade} %` : 'нет'}</span>
                  </div>
                  <span className="muted small">Мягкое тёмное пятно под субтитрами — их видно и на светлом фоне.</span>
                  {sized.map((m) => (
                    <div key={m.key} className="sub-move-row">
                      <span className="small">{m.name}</span>
                      <button type="button" className="pill" aria-label={`${m.name} меньше`} disabled={m.w <= INSERT_W.min} onClick={() => m.resize(m.w - INSERT_STEP)}>A−</button>
                      <button type="button" className="pill" aria-label={`${m.name} больше`} disabled={m.w >= INSERT_W.max} onClick={() => m.resize(m.w + INSERT_STEP)}>A+</button>
                      {m.changed ? <button type="button" className="link" aria-label={`${m.name}: как было`} onClick={m.reset}>Как было</button> : null}
                    </div>
                  ))}
                </>
              )}
            </div>
          ) : null}

          {current === 'speed' ? (
            <>
              <div className="pills">
                {SPEEDS.map((sp) => (
                  <button key={sp} type="button" className="pill mono" aria-pressed={speed === sp} onClick={() => setSpeed(sp)}>×{sp.toFixed(1)}</button>
                ))}
              </div>
              <div className="muted small">Голос не меняет тон; музыка не ускоряется.</div>
            </>
          ) : null}

          {coverView && cover ? (
            <div className="tab-panel" data-cover>
              <div className="cover-frames">
                {coverFrames.map((f, i) => (
                  <button key={f.image} type="button" className="cover-pick" aria-pressed={cover.frame === i} aria-label={`Кадр ${i + 1}`}
                    onClick={() => setCover({ ...coverPick, frame: i })}>
                    <img src={fileUrl(f.image)} alt="" />
                  </button>
                ))}
              </div>
              <input type="text" aria-label="Текст обложки" maxLength={COVER.text} value={coverPick?.text ?? cover.text} placeholder={hook ?? styles.cover?.text}
                onChange={(e) => setCover({ frame: cover.frame, text: e.target.value })} />
              <div className="muted small">Обложка — на крупном превью. В сетке профиля видна середина кадра 3:4 — текст стоит в ней. PNG — на экране «Готово».</div>
            </div>
          ) : null}

          {current === 'versions' ? (
            <>
              <div className="tab-panel" data-ad>
                <div className="caps">Версия для рекламы</div>
                <div className="pills">
                  <button type="button" className="pill" aria-pressed={!adOn} onClick={() => setAd(false)}>Не нужна</button>
                  <button type="button" className="pill" aria-pressed={adOn} onClick={() => setAd(true)}>Нужна</button>
                </div>
                <div className="muted small">
                  {adOn ? 'Соберу ещё ролик для рекламы Reels: текст и вставки — выше кнопки и подписи рекламы. Как он выглядит — «Реклама» ниже, на крупном превью.'
                    : 'В рекламе Reels низ кадра занят кнопкой и подписью — можно собрать отдельную версию, где текст стоит выше.'}
                </div>
                {adOn ? (
                  <div className="seg" role="group" aria-label="Какой ролик на крупном превью">
                    <button type="button" aria-pressed={!zoned} onClick={() => setAdsView(false)}>Органика</button>
                    <button type="button" aria-pressed={zoned} onClick={() => setAdsView(true)}>Реклама</button>
                  </div>
                ) : null}
              </div>
              {abChoices.length ? (
                <div className="tab-panel">
                  <div className="caps">Вторая версия для теста</div>
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
            </>
          ) : null}
        </div>

        <form className="card" onSubmit={(e) => {
          e.preventDefault();
          if (tweak.trim() && busy === null) void run('restyle', { text: tweak.trim() });
        }}>
          <label htmlFor="tweak" className="label">Ни один не подходит? Скажи, что поменять</label>
          <input id="tweak" type="text" maxLength={MAX_NOTE} placeholder="Например: заголовок без плашки" enterKeyHint="send" value={tweak} onChange={(e) => setTweak(e.target.value)} />
          <button type="submit" className="btn outline" disabled={!tweak.trim() || busy !== null}>
            <RefreshIcon />
            Ещё три варианта
          </button>
          {error?.at === 'restyle' ? <div className="err small">{error.text}</div> : null}
        </form>
      </div>
    </div>
  );
}

type HandleProps = {
  label: string; y: number; range: { min: number; max: number }; scale: number; onMove: (y: number) => void; size: number; onSize: (size: number) => void;
};
type Gesture =
  | { kind: 'move'; from: number; y: number }
  | { kind: 'drag'; fromX: number; fromY: number; x: number; y: number }
  | { kind: 'grow'; from: number; size: number }
  | { kind: 'pinch'; span: number; size: number };

/** Жесты ручки: один палец или мышь — `move` (только выше-ниже) или `drag` (куда угодно); два пальца — щипок, `onSize`;
 *  уголок `[data-grip]` мышкой вправо-влево — тоже `onSize`. Палец убран — жест закончен: оставшийся палец ручку не дёргает. */
function useGestures(scale: number, size: number, onSize: (size: number) => void, move?: { y: number; onMove: (y: number) => void },
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
      if (g?.kind === 'move') move?.onMove(g.y + (e.clientY - g.from) / scale);
      else if (g?.kind === 'drag') drag?.onDrag(g.x + (e.clientX - g.fromX) / scale, g.y + (e.clientY - g.fromY) / scale);
      else if (g?.kind === 'grow') onSize(g.size * (1 + (e.clientX - g.from) / (GROW * scale)));
      else if (g?.kind === 'pinch' && points.current.size >= 2) onSize((g.size * span()) / g.span);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => end(e.pointerId),
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => end(e.pointerId),
  };
}

/** Ручка текста на крупном превью — полоса на высоте `y` (px кадра): двигает выше-ниже и меняет размер; стрелки — по STEP. */
function DragHandle({ label, y, range, scale, onMove, size, onSize }: HandleProps) {
  const gestures = useGestures(scale, size, onSize, { y, onMove });
  return (
    <div className="sub-handle" role="slider" tabIndex={0} aria-label={label} aria-orientation="vertical"
      aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={y} title={`${label}: потяни выше или ниже; размер — щипком или уголком`}
      style={{ top: y * scale }} {...gestures}
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
  label: string; box: Box; at: InsertBox; scale: number; onSize: (w: number) => void; onDrag: (x: number, y: number) => void;
};

/** Ручка вставки — рамка по её месту на крупном превью (от шаблона): один палец или мышь — тащит куда угодно, щипок или
 *  уголок ⤢ — ширина; стрелки — сдвиг по STEP. */
function InsertHandle({ label, box, at, scale, onSize, onDrag }: InsertHandleProps) {
  const gestures = useGestures(scale, at.w, onSize, undefined, { x: at.x, y: at.y, onDrag });
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
  return (
    <div className="insert-handle" role="slider" tabIndex={0} aria-label={label} aria-valuemin={INSERT_W.min} aria-valuemax={INSERT_W.max}
      aria-valuenow={at.w} aria-valuetext={`x ${at.x}, y ${at.y}, ширина ${at.w}`} title={`${label}: перетащи; размер — щипком или уголком`}
      style={{ left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale }} {...gestures}
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
