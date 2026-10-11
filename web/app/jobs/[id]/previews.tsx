'use client';
// Экран «3 · Три превью»: три варианта стиля на настоящем кадре и крупное превью выбора Павла — всё рисует шаблон слоя;
// шрифт и цвета меняются сразу, субтитры перетаскиваются по крупному превью выше или ниже. «Ещё три варианта» — шаг
// restyle; «Монтировать» — ответы, стиль и шаг render.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildAnswers, previewHook, type Draft } from '@/lib/answers.ts';
import { storage } from '@/lib/client.ts';
import { mmss } from '@/lib/format.ts';
import type { Question, StyleChoice, Styles } from '@/lib/jobfiles.ts';
import { MAX_NOTE } from '@/lib/jobs.ts';
import {
  allowedFonts, choiceFor, clampSubY, finalStyle, loadChoice, loadSpeed, resolveInserts, sampleState, saveChoice, saveSpeed, SPEEDS, SUB_Y,
  SWATCHES,
} from '@/lib/style.ts';
import PreviewFrame from '../../preview-frame';
import type { Act } from './job';

type FontEntry = { id: string; family: string; file: string; kind: 'main' | 'hand' };
type ColorKey = keyof StyleChoice['colors'];

type Props = {
  jobId: string;
  styles: Styles;
  questions: Question[];
  draft: Draft;
  duration: number | null;
  fileUrl: (path: string) => string;
  localUrl: (qid: string) => string | null;
  onBack: () => void;
  onAct: Act;
};

const BIG = 270; // ширина крупного превью, px экрана
const SCALE = BIG / 1080;
const SUB_STEP = 20; // px кадра на нажатие «Выше» / «Ниже» и стрелку

const ROWS: { key: ColorKey; title: string; own: string }[] = [
  { key: 'accent', title: 'Подсветка слова', own: 'Своя подсветка' },
  { key: 'text', title: 'Текст', own: 'Свой цвет текста' },
  { key: 'bar', title: 'Шкала времени', own: 'Свой цвет шкалы' },
];

export default function Previews({ jobId, styles, questions, draft, duration, fileUrl, localUrl, onBack, onAct }: Props) {
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
  const inserts = useMemo(() => resolveInserts(styles.sample, questions, draft, fileUrl, localUrl), [styles, questions, draft, fileUrl, localUrl]);
  const thumbs = useMemo(() => styles.variants.map((v) => ({ v, state: sampleState(v.spec, styles.sample, hook, inserts) })), [styles, hook, inserts]);
  const spec = useMemo(() => finalStyle(styles, choice), [styles, choice]);
  const state = useMemo(() => sampleState(spec, styles.sample, hook, inserts), [spec, styles, hook, inserts]);
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
    void run('answers', { answers, uploads: claims, style: choice, speed });
  }

  const pickFont = (kind: 'font' | 'hand', id: string) => setChoice({ ...choice, [kind]: id });
  // смена варианта сбрасывает шрифты и цвета к нему, а место субтитров, которое Павел выбрал сам, остаётся
  const pickVariant = (id: StyleChoice['variant']) =>
    setChoice({ ...choiceFor(styles, id), ...(choice.subY === undefined ? {} : { subY: choice.subY }) });
  const subY = spec.subtitles.y;
  const moveSub = (y: number) => setChoice({ ...choice, subY: clampSubY(y) });
  const resetSub = () => {
    const { subY: _, ...rest } = choice;
    setChoice(rest);
  };
  const drag = useRef<{ from: number; y: number } | null>(null);
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
          <PreviewFrame frameUrl={frameUrl} spec={spec} state={state} progress={progress} width={BIG} big />
          <div className="sub-handle" role="slider" tabIndex={0} aria-label="Высота субтитров" aria-orientation="vertical"
            aria-valuemin={SUB_Y.min} aria-valuemax={SUB_Y.max} aria-valuenow={subY} title="Потяни субтитры выше или ниже"
            style={{ top: subY * SCALE }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { from: e.clientY, y: subY };
            }}
            onPointerMove={(e) => drag.current && moveSub(drag.current.y + (e.clientY - drag.current.from) / SCALE)}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              e.preventDefault();
              moveSub(subY + (e.key === 'ArrowUp' ? -SUB_STEP : SUB_STEP));
            }}>
            <span aria-hidden="true">⇅</span>
          </div>
        </div>
      </div>
      <div className="sub-move">
        <span className="muted small">Субтитры можно потянуть на превью выше или ниже</span>
        <button type="button" className="pill" disabled={subY <= SUB_Y.min} onClick={() => moveSub(subY - SUB_STEP)}>Выше</button>
        <button type="button" className="pill" disabled={subY >= SUB_Y.max} onClick={() => moveSub(subY + SUB_STEP)}>Ниже</button>
        {choice.subY !== undefined ? <button type="button" className="link" onClick={resetSub}>Как в варианте</button> : null}
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

      <div className="card">
        <label htmlFor="tweak" className="label">Ни один не подходит? Скажи, что поменять</label>
        <input id="tweak" type="text" maxLength={MAX_NOTE} placeholder="Например: заголовок без плашки" value={tweak} onChange={(e) => setTweak(e.target.value)} />
        <button type="button" className="btn ghost" disabled={!tweak.trim() || busy !== null} onClick={() => void run('restyle', { text: tweak.trim() })}>
          Ещё три варианта
        </button>
        {error?.at === 'restyle' ? <div className="err small">{error.text}</div> : null}
      </div>

      <button type="button" className="btn" disabled={busy !== null} onClick={mount}>
        Монтировать: {choice.variant} · {family(choice.font)} · ×{speed.toFixed(1)}
      </button>
      {error?.at === 'answers' ? <div className="err small">{error.text}</div> : null}
    </>
  );
}
