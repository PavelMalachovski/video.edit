'use client';
// Редактор (бета): светлый экран как у veed — кадр с прокси-видео и слоем шаблона (тот же, что рисует финал), под ним
// таймлайн с дорожками черновика монтажа. Пока только показ и прослушивание: куски играются подряд, как в ролике
// (вырезанное пропускается, скорость — как у монтажа). Монтаж запускается со старого экрана (вопросы и «Превью»).
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { storage } from '@/lib/client.ts';
import type { EditorData } from '@/lib/editordata.ts';
import { tenths } from '@/lib/format.ts';
import { loadLang, saveLang, tr, type Key, type Lang } from '@/lib/i18n.ts';
import { ADJUSTABLE, type StyleChoice } from '@/lib/jobfiles.ts';
import {
  allowedFonts, choiceFor, clampTo, finalStyle, loadChoice, overlayAt, sampleState, saveChoice, SUB_SHADE, subGroupSize, SWATCHES,
} from '@/lib/style.ts';
import { advance, locate } from '@/lib/player.ts';
import { decodePeaks, draftTracks, peakAt, type Clip, type Tracks } from '@/lib/tracks.ts';
import { BackIcon, PauseIcon, PlayIcon } from '../../../icons';
import PreviewFrame from '../../../preview-frame';
import { useTemplateFonts } from '../../../use-fonts';

const HEAD = 112; // px — колонка с именами дорожек
const MAX_WIDTH = 30_000; // px — ширина дорожек
const MAX_CANVAS = 32_767; // px холста — больше браузеры не рисуют (с учётом плотности экрана)
const ZOOM = 1.5;
const THUMB_H = 56;
const TICKS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
const RELOAD_MS = 20_000; // пока нет черновика или прокси — спрашиваем снова
const FRAME_HZ = 15; // столько раз в секунду обновляем слой кадра во время пуска

export default function Editor({ id }: { id: string }) {
  const [lang, setLang] = useState<Lang>('ru');
  const T = useCallback((k: Key, v?: Record<string, string | number>) => tr(lang, k, v), [lang]);
  const [data, setData] = useState<EditorData | null>(null);
  const [error, setError] = useState('');
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pps, setPps] = useState<number | null>(null); // px на секунду финала; null — уместить весь ролик
  const [frameW, setFrameW] = useState(270);

  useEffect(() => setLang(loadLang(storage())), []);
  useEffect(() => {
    document.documentElement.lang = lang;
    return () => {
      document.documentElement.lang = 'ru'; // старый поток — по-русски
    };
  }, [lang]);
  const pickLang = (l: Lang) => {
    setLang(l);
    saveLang(storage(), l);
  };

  // данные: сразу и снова, пока черновика или прокси ещё нет (сессия пишет, Action переносит прокси в релиз)
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/jobs/${id}/editor`, { cache: 'no-store' });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${r.status}`);
      setData(body as EditorData);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const waiting = !data || !data.draft || (data.media?.proxy != null && data.proxyUrl === null);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), RELOAD_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);

  // стиль: смонтирован — стиль ролика (панель только показывает); иначе выбор, общий с экраном «Превью»
  const styles = data?.styles ?? null;
  const mounted = Boolean(data?.answers);
  const [choice, setChoiceState] = useState<StyleChoice | null>(null);
  useEffect(() => {
    if (styles) setChoiceState(data?.answers?.style ?? loadChoice(storage(), id, styles));
  }, [styles, data?.answers, id]);
  const pick = (c: StyleChoice) => {
    if (!styles || mounted) return;
    setChoiceState(c);
    saveChoice(storage(), id, styles, c);
  };
  const spec = useMemo(() => (styles && choice ? finalStyle(styles, choice) : null), [styles, choice]);
  const fonts = useTemplateFonts();
  const offered = useMemo(() => (styles ? allowedFonts(fonts, styles) : []), [fonts, styles]); // со всеми буквами ролика
  const tracks: Tracks | null = useMemo(() => (data?.draft
    ? draftTracks(data.draft, { perGroup: spec ? subGroupSize(spec) : 3, sourceDuration: data.media?.duration })
    : null), [data, spec]);
  const peaks = useMemo(() => (data?.media ? decodePeaks(data.media.peaks.data) : null), [data]);
  const duration = tracks?.duration ?? 0;
  const speed = data?.draft?.speed ?? 1;

  // ---------- плеер: куски подряд ----------
  const video = useRef<HTMLVideoElement>(null);
  const piece = useRef(0);
  const playhead = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const now = useRef(0);
  const scale = useRef(40);

  const show = useCallback((tf: number) => { // плейхед и часы — без React, каждый кадр
    now.current = tf;
    if (playhead.current) playhead.current.style.transform = `translateX(${HEAD + tf * scale.current}px)`;
    if (clock.current) clock.current.textContent = tenths(tf);
  }, []);

  const seek = useCallback((tf: number) => {
    if (!tracks?.video.length) return;
    const x = Math.min(Math.max(0, tf), duration);
    const { index, src } = locate(tracks.video, speed, x);
    piece.current = index;
    const v = video.current;
    if (v && v.readyState > 0) v.currentTime = src;
    show(x);
    setT(x);
  }, [tracks, duration, speed, show]);

  const pause = useCallback(() => {
    video.current?.pause();
    setPlaying(false);
  }, []);
  const play = useCallback(async () => {
    const v = video.current;
    if (!v || !tracks?.video.length) return;
    if (v.ended || now.current >= duration - 0.05) seek(0); // доиграл — сначала
    v.playbackRate = speed;
    try {
      await v.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  }, [tracks, duration, speed, seek]);

  useEffect(() => {
    if (!playing || !tracks) return;
    let raf = 0;
    let last = 0;
    const tick = (ms: number) => {
      const v = video.current;
      if (!v) return;
      const step = advance(tracks.video, speed, piece.current, v.currentTime); // конец куска — следующий, вырезанное мимо
      piece.current = step.index;
      if (step.end) {
        pause();
        show(duration);
        setT(duration);
        return;
      }
      if (step.seek !== undefined) v.currentTime = step.seek;
      const tf = step.t;
      show(tf);
      if (ms - last > 1000 / FRAME_HZ) {
        last = ms;
        setT(tf);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, tracks, speed, duration, pause, show]);

  // ссылка на ассет короткоживущая: видео перестало грузиться — берём адрес снова, встаём туда же и, если играло, играем
  const retried = useRef(0);
  const onVideoError = () => {
    const v = video.current;
    if (!v || !data?.proxyUrl || Date.now() - retried.current < 5000) return;
    retried.current = Date.now();
    const at = now.current;
    const was = playing;
    setPlaying(false); // пока грузится заново, время не идёт
    v.src = `${data.proxyUrl}&r=${retried.current}`;
    v.load();
    v.addEventListener('loadedmetadata', () => {
      seek(at);
      if (was) void play();
    }, { once: true });
  };
  // доиграл — плейхед в конце ролика (видео могло кончиться раньше последнего куска)
  const onEnded = () => {
    pause();
    if (tracks?.video.length) piece.current = tracks.video.length - 1;
    show(duration);
    setT(duration);
  };
  useEffect(() => { // вкладку спрятали — пауза: без кадров браузера куски не переключаются, звучало бы вырезанное
    const hide = () => document.visibilityState === 'hidden' && pause();
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, [pause]);

  useEffect(() => { // пробел — пуск и пауза (не в полях и не на кнопках)
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.closest('input, textarea, select, button, a') || el.isContentEditable)) return;
      e.preventDefault();
      if (playing) pause();
      else void play();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, play, pause]);

  // ---------- кадр ----------
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => { // кадр 9:16 целиком внутри сцены, за вычетом её полей
      const cs = getComputedStyle(el);
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setFrameW(Math.max(160, Math.floor(Math.min(w, (h * 9) / 16))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);
  const overlay = useMemo(() => (spec && tracks ? overlayAt(spec, tracks, t) : null), [spec, tracks, t]);
  // черновика ещё нет — кадр-образец сессии с текстом-образцом: стиль видно и так
  const sample = useMemo(() => (spec && styles && !tracks ? sampleState(spec, styles.sample, styles.sample.hook ?? null, []) : null),
    [spec, styles, tracks]);
  const frameUrl = styles && data?.head ? `/api/jobs/${id}/file?path=${encodeURIComponent(styles.frame)}&v=${data.head}` : null;

  // ---------- таймлайн ----------
  const lanes = useRef<HTMLDivElement>(null);
  const [laneW, setLaneW] = useState(800);
  useEffect(() => {
    const el = lanes.current;
    if (!el) return;
    const fit = () => setLaneW(Math.max(200, el.clientWidth - HEAD - 24));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);
  const fitPps = duration > 0 ? laneW / duration : 40;
  const maxPps = duration > 0 ? Math.min(400, MAX_WIDTH / duration) : 400;
  const px = Math.min(maxPps, Math.max(Math.min(fitPps, 4), pps ?? fitPps));
  scale.current = px;
  useEffect(() => show(now.current), [px, show]);
  const X = (s: number) => s * px;
  const width = Math.ceil(X(duration));
  const tick = TICKS.find((s) => s * px >= 64) ?? 120;

  const onLanes = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    if (x < 0) return;
    seek(x / px);
  };

  // волна голоса: громкость исходника в каждом px финала
  const wave = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = wave.current;
    if (!c || !tracks || !peaks || !data?.media) return;
    const h = 40;
    const dpr = Math.min(2, window.devicePixelRatio || 1, MAX_CANVAS / Math.max(1, width));
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = h * dpr;
    c.style.width = `${width}px`;
    c.style.height = `${h}px`;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.fillStyle = getComputedStyle(c).color;
    const perS = data.media.peaks.perS;
    let k = 0;
    for (let x = 0; x < width; x++) {
      const tf = x / px;
      while (k + 1 < tracks.video.length && tf >= tracks.video[k].t1) k++;
      const clip = tracks.video[k];
      const src = (clip.src0 as number) + (tf - clip.t0) * speed;
      const a = peakAt(peaks, perS, src);
      const bar = Math.max(1, a * (h - 6));
      g.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [tracks, peaks, data, width, px, speed]);

  const film = data?.media?.film;
  const thumbW = film ? (THUMB_H * film.w) / film.h : 32;
  const thumbs = (c: Clip) => {
    if (!film || !data?.filmUrl) return null;
    const w = X(c.t1 - c.t0);
    const n = Math.max(1, Math.ceil(w / thumbW));
    return Array.from({ length: n }, (_, k) => {
      const tf = c.t0 + ((k + 0.5) * thumbW) / px;
      const src = (c.src0 as number) + (tf - c.t0) * speed;
      const fi = Math.min(film.n - 1, Math.max(0, Math.round(src / film.step)));
      const style: CSSProperties = {
        width: thumbW, backgroundImage: `url(${data.filmUrl})`, backgroundSize: `${film.n * thumbW}px ${THUMB_H}px`, backgroundPosition: `${-fi * thumbW}px 0`,
      };
      return <span key={k} className="ed-thumb" style={style} />;
    });
  };
  const sec = (s: number) => T('seconds', { n: lang === 'en' ? s.toFixed(1) : s.toFixed(1).replace('.', ',') });
  const clip = (c: Clip, cls: string, label: string, key: string | number) => (
    <div key={key} className={`ed-clip ${cls}`} style={{ left: X(c.t0), width: Math.max(2, X(c.t1 - c.t0)) }} title={`${label} · ${tenths(c.t0)}–${tenths(c.t1)}`}>
      <span>{label}</span>
    </div>
  );
  const kindName: Record<string, Key> = { hook: 'hook', accent: 'accent', cta: 'cta' };

  // ---------- экран ----------
  const notice = !data ? (error ? T('error', { e: error }) : T('loading'))
    : !data.draft ? T('noDraft')
      : !data.media ? T('oldJob')
        : !data.media.proxy ? T('longSource')
          : !data.proxyUrl ? T('noProxy') : null;
  const cutTotal = tracks?.cuts.reduce((s, c) => s + c.src1 - c.src0, 0) ?? 0;

  return (
    <div className="ed">
      <header className="ed-top">
        <Link href={`/jobs/${id}`} className="ed-back" aria-label={T('back')}><BackIcon /></Link>
        <div className="ed-title">
          <h1>{data?.title ?? T('editor')}</h1>
          <span className="ed-beta">{T('beta')}</span>
        </div>
        <div className="ed-seg" role="group" aria-label={T('language')}>
          {(['ru', 'en'] as const).map((l) => (
            <button key={l} type="button" aria-pressed={lang === l} onClick={() => pickLang(l)}>{l.toUpperCase()}</button>
          ))}
        </div>
        <Link href={`/jobs/${id}`} className="ed-primary" title={T('mountHint')}>{T('toFlow')}</Link>
      </header>

      <div className="ed-main">
        <section className="ed-stage" ref={stage} aria-label={T('video')}>
          <div className="ed-frame" style={{ width: frameW, height: Math.round((frameW * 16) / 9) }}>
            {data?.proxyUrl ? (
              <video ref={video} src={data.proxyUrl} playsInline preload="auto" onError={onVideoError}
                onLoadedMetadata={() => seek(now.current)} onEnded={onEnded} data-editor-video="" />
            ) : null}
            {spec && overlay ? (
              <div className="ed-layer">
                <PreviewFrame frameUrl={null} spec={spec} state={overlay} progress={duration ? t / duration : 0} width={frameW} big />
              </div>
            ) : null}
            {spec && sample && frameUrl ? (
              <div className="ed-layer">
                <PreviewFrame frameUrl={frameUrl} spec={spec} state={sample} progress={0.3} width={frameW} big />
                <div className="ed-caption">{T('sample')}</div>
              </div>
            ) : notice ? <div className="ed-notice">{notice}</div> : null}
          </div>
        </section>

        <aside className="ed-side">
          {styles && choice ? (
            <StylePanel T={T} styles={styles} choice={choice} spec={spec} offered={offered} locked={mounted} onPick={pick} />
          ) : null}
          <h2>{T('draft')}</h2>
          <p className="ed-note">{T('readOnly')}</p>
          {tracks ? (
            <dl className="ed-facts">
              <dt>{T('duration', { s: '' }).trim()}</dt><dd className="mono">{tenths(duration)}</dd>
              {data?.media ? (<><dt>{T('source', { s: '' }).trim()}</dt><dd className="mono">{tenths(data.media.duration)}</dd></>) : null}
              <dt>{T('piece')}</dt><dd className="mono">{tracks.video.filter((c) => c.kind === 'piece').length}</dd>
              <dt>{T('cutPart', { s: '' }).trim()}</dt><dd className="mono">{sec(cutTotal)}</dd>
              <dt>{T('subtitles')}</dt><dd className="mono">{tracks.subtitles.length}</dd>
            </dl>
          ) : null}
          <p className="ed-note">{T('mountHint')}</p>
          {spec ? <p className="ed-note faint">{T('previewNote')}</p> : null}
        </aside>
      </div>

      <section className="ed-tl" aria-label="Timeline">
        <div className="ed-bar">
          <button type="button" className="ed-play" onClick={() => (playing ? pause() : void play())} disabled={!data?.proxyUrl || !tracks}
            aria-label={playing ? T('pause') : T('play')}>{playing ? <PauseIcon /> : <PlayIcon />}</button>
          <span className="mono ed-clock"><span ref={clock}>{tenths(t)}</span> / {tenths(duration)}</span>
          <span className="ed-grow" />
          <button type="button" className="ed-icon" aria-label={T('zoomOut')} onClick={() => setPps(px / ZOOM)} disabled={px <= Math.min(fitPps, 4) + 1e-6}>−</button>
          <button type="button" className="ed-icon" aria-label={T('zoomIn')} onClick={() => setPps(px * ZOOM)} disabled={px >= maxPps - 1e-6}>+</button>
        </div>
        <div className="ed-scroll" ref={lanes}>
          {tracks ? (
            <div className="ed-inner" style={{ width: HEAD + width + 24 }}>
              <div className="ed-ruler" style={{ marginLeft: HEAD, width }} onPointerDown={onLanes}>
                {Array.from({ length: Math.floor(duration / tick) + 1 }, (_, k) => (
                  <span key={k} style={{ left: X(k * tick) }}>{tenths(k * tick).replace(/\.0$/, '')}</span>
                ))}
              </div>
              <Row name={T('video')} cls="video" width={width} onSeek={onLanes}>
                {tracks.video.map((c, i) => (
                  <div key={i} className={`ed-clip ed-piece${c.kind === 'teaser' ? ' teaser' : ''}`} style={{ left: X(c.t0), width: Math.max(2, X(c.t1 - c.t0)) }}
                    title={`${c.kind === 'teaser' ? T('teaser') : T('piece')} · ${tenths(c.src0 as number)}–${tenths(c.src1 as number)}`}>
                    <div className="ed-thumbs">{thumbs(c)}</div>
                    {c.kind === 'teaser' ? <span className="ed-tag">{T('teaser')}</span> : null}
                  </div>
                ))}
                {tracks.looks.map((c, i) => <div key={`l${i}`} className="ed-look" style={{ left: X(c.t0), width: Math.max(2, X(c.t1 - c.t0)) }} title={T('bw')} />)}
                {tracks.cuts.map((c, i) => (
                  <span key={`c${i}`} className="ed-cut" style={{ left: X(c.at) }} title={T('cutPart', { s: sec(c.src1 - c.src0) })} />
                ))}
              </Row>
              <Row name={T('voice')} cls="voice" width={width} onSeek={onLanes}>
                <canvas ref={wave} className="ed-wave" aria-hidden="true" />
              </Row>
              <Row name={T('music')} cls="music" width={width} onSeek={onLanes}>
                {tracks.music ? clip({ t0: 0, t1: duration, kind: 'music', label: '' }, 'music', `${tracks.music.label} · ${tracks.music.gainDb} dB`, 'm')
                  : <span className="ed-empty">{T('noMusic')}</span>}
              </Row>
              <Row name={T('subtitles')} cls="sub" width={width} onSeek={onLanes}>
                {tracks.subtitles.map((c, i) => clip(c, 'sub', c.label, i))}
              </Row>
              <Row name={T('text')} cls="text" width={width} onSeek={onLanes}>
                {tracks.text.map((c, i) => clip(c, 'text', `${T(kindName[c.kind] ?? 'text')}: ${c.label}`, i))}
              </Row>
              <Row name={T('inserts')} cls="ins" width={width} onSeek={onLanes}>
                {tracks.inserts.map((c, i) => clip(c, 'ins', c.label, i))}
              </Row>
              <div className="ed-playhead" ref={playhead} aria-hidden="true" />
            </div>
          ) : <div className="ed-empty pad">{notice}</div>}
        </div>
      </section>
    </div>
  );
}

function Row({ name, cls, width, onSeek, children }: { name: string; cls: string; width: number; onSeek: (e: React.PointerEvent<HTMLDivElement>) => void; children: React.ReactNode }) {
  return (
    <div className={`ed-row ${cls}`}>
      <div className="ed-head">{name}</div>
      <div className="ed-lane" style={{ width }} onPointerDown={onSeek}>{children}</div>
    </div>
  );
}

type Styles = NonNullable<EditorData['styles']>;
type Spec = ReturnType<typeof finalStyle>;
type ColorKey = keyof StyleChoice['colors'];
const COLOR_ROWS: [ColorKey, Key][] = [['accent', 'accentColor'], ['text', 'textColor'], ['bar', 'barColor']];

/** Стиль ролика: вариант, шрифты, три цвета и затемнение под субтитрами — как на экране «Превью», в светлой теме. */
function StylePanel({ T, styles, choice, spec, offered, locked, onPick }: {
  T: (k: Key, v?: Record<string, string | number>) => string; styles: Styles; choice: StyleChoice; spec: Spec | null;
  offered: { id: string; family: string; kind: 'main' | 'hand' }[]; locked: boolean; onPick: (c: StyleChoice) => void;
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
      <p className="ed-note faint">{locked ? T('styleLocked') : T('styleShared')}</p>
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
