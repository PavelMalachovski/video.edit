'use client';
// Редактор (бета): светлый экран как у veed — кадр с прокси-видео и слоем шаблона (тот же, что рисует финал), под ним
// таймлайн с дорожками черновика монтажа. Куски играются подряд, как в ролике (вырезанное пропускается, скорость — как у
// монтажа). Правки руками: разрезать, удалить, вернуть и переставить куски, тянуть их края (липнут к словам), громкость
// и «без звука» голоса, музыки и звуков, где звучит музыка; отмена и повтор. Правки сохраняются сами в timeline.json — движок
// кладёт их поверх черновика при монтаже; прослушивание сводит звук как ролик (mixer.ts). «Монтировать» у готового
// ролика — новая версия (правка с правками и стилем); до монтажа — старый экран с вопросами.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { storage } from '@/lib/client.ts';
import type { EditorData } from '@/lib/editordata.ts';
import { sameJson } from '@/lib/equal.ts';
import {
  commit, cutSpan, EMPTY, initHistory, moveSpan, redo, restoreSpan, setMusic, setSound, setVoice, snapTo, splitAt, trimEnd, trimStart, undo,
  type HandEdits, type History,
} from '@/lib/edits.ts';
import { tenths } from '@/lib/format.ts';
import { loadLang, saveLang, tr, type Key, type Lang } from '@/lib/i18n.ts';
import type { StyleChoice } from '@/lib/jobfiles.ts';
import { allowedFonts, finalStyle, loadChoice, overlayAt, sampleState, saveChoice, subGroupSize } from '@/lib/style.ts';
import { advance, locate } from '@/lib/player.ts';
import { Saver, type PutResult } from '@/lib/saver.ts';
import { audioUrl, levelsOf, musicMix } from '@/lib/sound.ts';
import {
  decodePeaks, draftTracks, moveTarget, peakAt, slotAt, splitTarget, videoKey, withHandEdits, wordEdges, type Clip, type Tracks,
} from '@/lib/tracks.ts';
import { BackIcon, PauseIcon, PlayIcon, PlusIcon, RedoIcon, ScissorsIcon, SpeakerIcon, TrashIcon, UndoIcon } from '../../../icons';
import PreviewFrame from '../../../preview-frame';
import { useTemplateFonts } from '../../../use-fonts';
import { Mixer, type MixPlan } from './mixer';
import { Inspector, StylePanel, type Selection } from './panels';

const HEAD = 112; // px — колонка с именами дорожек
const MAX_WIDTH = 30_000; // px — ширина дорожек
const MAX_CANVAS = 32_767; // px холста — больше браузеры не рисуют (с учётом плотности экрана)
const ZOOM = 1.5;
const THUMB_H = 56;
const TICKS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
const RELOAD_MS = 20_000; // пока нет черновика или прокси или Claude монтирует — спрашиваем снова
const FRAME_HZ = 15; // столько раз в секунду обновляем слой кадра во время пуска
const SAVE_MS = 1200; // правки сохраняются, когда Павел остановился на столько
const SNAP_PX = 8; // край куска липнет к границе слова ближе стольких px
const CLICK_PX = 3; // сдвиг мыши меньше — это щелчок, а не перетаскивание
const EDITABLE = ['questions', 'result', 'error']; // сессия не работает — правки можно сохранять

type SaveState = { state: 'idle' | 'saving' | 'saved' | 'error' | 'conflict'; error?: string };
type Drag =
  | { kind: 'trim'; index: number; side: 'start' | 'end'; x0: number; to: number }
  // кусок целиком — на другое место: tf0 — момент ролика под пальцем в начале, slot — перед каким куском встанет
  | { kind: 'piece'; index: number; x0: number; tf0: number; dx: number; slot: number | null; moved: boolean }
  | { kind: 'music'; mode: 'move' | 'trim'; x0: number; at0: number; from0: number; at: number; from: number; moved: boolean };

/** Правки из timeline.json — без ревизии и времени. */
const handOf = (data: EditorData | null): HandEdits => {
  if (!data?.timeline) return EMPTY;
  const { rev: _rev, at: _at, ...hand } = data.timeline;
  return hand;
};

export default function Editor({ id }: { id: string }) {
  const router = useRouter();
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

  // данные: сразу и снова, пока черновика или прокси ещё нет (сессия пишет, Action переносит прокси в релиз) или Claude монтирует
  const load = useCallback(async (): Promise<EditorData | null> => {
    try {
      const r = await fetch(`/api/jobs/${id}/editor`, { cache: 'no-store' });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${r.status}`);
      setData(body as EditorData);
      setError('');
      return body as EditorData;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const waiting = !data || !data.draft || (data.media?.proxy != null && data.proxyUrl === null) || data.screen === 'working';
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), RELOAD_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);

  // ---------- правки руками: история, сохранение ----------
  const [hist, setHist] = useState<History>(() => initHistory(EMPTY));
  const [saved, setSaved] = useState<HandEdits>(EMPTY); // что лежит в ветке
  // сохранения — по одному (lib/saver.ts): «Монтировать» во время автосохранения ждёт его, а не шлёт то же ещё раз
  const saver = useRef<Saver<HandEdits> | null>(null);
  if (!saver.current) {
    saver.current = new Saver<HandEdits>(async (base, value): Promise<PutResult> => {
      const r = await fetch(`/api/jobs/${id}/timeline`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ base, ...value }),
      });
      const body = await r.json().catch(() => null);
      if (r.ok) return { ok: true, rev: body.timeline.rev };
      const error = typeof body?.error === 'string' ? body.error : `HTTP ${r.status}`;
      return { ok: false, conflict: r.status === 409 && typeof body?.rev === 'number', error };
    }, EMPTY, 0);
  }
  const adopted = useRef(false);
  const [save, setSave] = useState<SaveState>({ state: 'idle' });
  const hand = hist.present;
  const dirty = hand !== saved;
  const editable = Boolean(data?.draft) && EDITABLE.includes(data?.screen ?? '');

  // правки из ветки: при первой загрузке, после «Загрузить их» и когда пришла чужая ревизия (вторая вкладка), а своих
  // несохранённых нет. Своя сохранённая ревизия — уже в rev: данные с ней ничего не сбрасывают.
  const seen = useRef<number | null>(null); // ревизия в последних данных
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const adopt = useCallback((d: EditorData) => {
    const h = handOf(d);
    saver.current?.reset(h, d.rev);
    seen.current = d.rev;
    adopted.current = true;
    setHist(initHistory(h));
    setSaved(h);
  }, []);
  useEffect(() => {
    if (!data) return;
    if (!adopted.current) adopt(data);
    else if (data.rev !== seen.current) {
      seen.current = data.rev;
      if (data.rev !== saver.current?.rev && !dirtyRef.current) adopt(data);
    }
  }, [data, adopt]);

  const histRef = useRef(hist);
  histRef.current = hist;
  /** Сохранить то, что сейчас на дорожках (идущее сохранение — дождаться); true — в ветке. */
  const flush = useCallback(async (): Promise<boolean> => {
    const s = saver.current;
    if (!s) return false;
    setSave({ state: 'saving' });
    const r = await s.save(histRef.current.present);
    if (r.ok) {
      setSaved(s.saved);
      setSave({ state: 'saved' });
      return true;
    }
    setSave(r.conflict ? { state: 'conflict' } : { state: 'error', error: r.error });
    return false;
  }, []);
  useEffect(() => { // остановился — сохраняем; ошибка и конфликт ждут Павла
    if (!dirty || !editable || save.state === 'saving' || save.state === 'conflict' || save.state === 'error') return;
    const timer = setTimeout(() => void flush(), SAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, editable, hand, save.state, flush]);
  useEffect(() => { // не сохранилось, а Павел правит дальше — пробуем снова с новой правкой
    setSave((x) => (x.state === 'error' ? { state: 'idle' } : x));
  }, [hand]);
  useEffect(() => { // несохранённое — спросить перед уходом
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // Safari и старые браузеры спрашивают только так
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const reloadEdits = async () => {
    const d = await load();
    if (d) adopt(d);
    setSave({ state: 'idle' });
  };

  const [hint, setHint] = useState('');
  const [sel, setSel] = useState<Selection | null>(null);

  // ---------- черновик с правками ----------
  const styles = data?.styles ?? null;
  const mounted = Boolean(data?.answers);
  const [choice, setChoiceState] = useState<StyleChoice | null>(null);
  const shown = useRef<unknown>(undefined); // стиль ролика, от которого начат выбор: новые данные с тем же — выбор не трогают
  useEffect(() => {
    // смонтирован — от стиля ролика (новый, ещё не смонтированный, живёт до перезагрузки); иначе — выбор с «Превью»
    if (!styles) return;
    const rendered = data?.answers?.style ?? null;
    if (shown.current !== undefined && sameJson(shown.current, rendered)) return;
    shown.current = rendered;
    setChoiceState(rendered ?? loadChoice(storage(), id, styles));
  }, [styles, data?.answers, id]);
  const styleLocked = data?.screen === 'working';
  const pick = (c: StyleChoice) => {
    if (!styles || styleLocked) return;
    setChoiceState(c);
    if (!mounted) saveChoice(storage(), id, styles, c); // до монтажа — общий с «Превью»
  };
  const styleChanged = mounted && choice !== null && !sameJson(choice, data?.answers?.style);
  const spec = useMemo(() => (styles && choice ? finalStyle(styles, choice) : null), [styles, choice]);
  const fonts = useTemplateFonts();
  const offered = useMemo(() => (styles ? allowedFonts(fonts, styles) : []), [fonts, styles]); // со всеми буквами ролика

  const sourceDuration = data?.media?.duration;
  // дорожки — по кускам и музыке: громкость голоса и звуков их не пересчитывает (и плеер не перематывает)
  const edited = useMemo(() => (data?.draft ? withHandEdits(data.draft, { edits: hand.edits, music: hand.music }, sourceDuration) : null),
    [data, hand.edits, hand.music, sourceDuration]);
  const tracks: Tracks | null = useMemo(() => (edited
    ? draftTracks(edited.draft, { perGroup: spec ? subGroupSize(spec) : 3, sourceDuration, splits: edited.splits, videos: data?.media?.videos })
    : null), [edited, spec, sourceDuration, data?.media?.videos]);
  const videos = (data?.media?.videos?.length ?? 0) > 1 ? data?.media?.videos ?? null : null; // несколько видео задачи — где какое
  const mix = useMemo(() => musicMix(data?.draft?.music ?? null, hand.music), [data, hand.music]);
  const edges = useMemo(() => (data?.draft ? wordEdges(data.draft) : []), [data]);
  const peaks = useMemo(() => (data?.media ? decodePeaks(data.media.peaks.data) : null), [data]);
  const duration = tracks?.duration ?? 0;
  const speed = data?.draft?.speed ?? 1;

  /** Правка в историю: куски не должны пропасть совсем (движку нечего монтировать). */
  const edit = useCallback((next: HandEdits, key?: string) => {
    if (!data?.draft || !editable) return;
    if (next.edits !== hand.edits && !withHandEdits(data.draft, next, sourceDuration).draft.keep.length) {
      setHint(T('lastPiece'));
      return;
    }
    setHint('');
    setHist((h) => commit(h, next, key));
  }, [data, editable, hand.edits, sourceDuration, T]);
  const doUndo = useCallback(() => setHist(undo), []);
  const doRedo = useCallback(() => setHist(redo), []);

  // ---------- плеер: куски подряд ----------
  const video = useRef<HTMLVideoElement>(null);
  const piece = useRef(0);
  const playhead = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const now = useRef(0);
  const scale = useRef(40);
  const mixer = useRef<Mixer | null>(null);
  useEffect(() => {
    const m = new Mixer();
    mixer.current = m;
    return () => m.close();
  }, []);
  const head = data?.head ?? null;
  const plan: MixPlan | null = useMemo(() => (tracks && head ? {
    duration: tracks.duration + tracks.tail, // музыка затухает к концу ролика — после стоп-кадра и карточки
    voice: hand.voice ?? {},
    music: mix ? { ...mix, url: audioUrl(id, head, mix.file) } : null,
    sounds: tracks.sounds.flatMap((c) => (c.key && c.file ? [{ key: c.key, t0: c.t0, file: c.file, url: audioUrl(id, head, c.file) }] : [])),
    soundLevels: hand.sounds ?? {},
  } : null), [tracks, head, hand.voice, hand.sounds, mix, id]);
  useEffect(() => {
    if (!plan) return;
    mixer.current?.preload(plan);
    mixer.current?.update(plan);
  }, [plan]);
  useEffect(() => { // голос — громкость элемента (громче 0 дБ — тише музыка и звуки, levelsOf); iPhone громкость
    const v = video.current; // элемента не слушает — «без звука» ещё и muted
    if (!v) return;
    v.volume = levelsOf({ voice: hand.voice, musicDb: null }).voice;
    v.muted = Boolean(hand.voice?.muted);
  }, [hand.voice, data?.proxyUrl]);

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
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const vkey = tracks ? videoKey(tracks) : '';
  useEffect(() => seekRef.current(now.current), [vkey]); // куски поменялись — тот же момент ролика на новых кусках

  const pause = useCallback(() => {
    video.current?.pause();
    mixer.current?.stop();
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
      if (plan) void mixer.current?.start(() => now.current, plan);
    } catch {
      setPlaying(false);
    }
  }, [tracks, duration, speed, seek, plan]);

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
      mixer.current?.sync(tf);
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
    pause(); // пока грузится заново, время не идёт
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

  // ---------- правки на дорожках ----------
  const keep = edited?.draft.keep ?? [];
  const selPiece = sel?.kind === 'piece' ? tracks?.video[sel.index] ?? null : null;
  const splitSrc = tracks ? splitTarget(tracks, t) : null;
  const splitHere = Boolean(selPiece && splitSrc !== null && splitSrc > (selPiece.src0 as number) && splitSrc < (selPiece.src1 as number));
  const doSplit = useCallback(() => {
    if (splitSrc === null) return;
    edit(splitAt(hand, splitSrc));
    setSel(null);
  }, [splitSrc, edit, hand]);
  const doDelete = useCallback(() => {
    if (!selPiece || selPiece.kind !== 'piece' || selPiece.src0 === undefined || selPiece.src1 === undefined) return;
    edit(cutSpan(hand, selPiece.src0, selPiece.src1));
    setSel(null);
  }, [selPiece, edit, hand]);
  const doRestore = (c: { src0: number; src1: number }) => edit(restoreSpan(hand, c.src0, c.src1));
  // переставить кусок перед куском `slot`; выбранным остаётся он — на новом месте, плейхед — в его начало
  const follow = useRef<number | null>(null); // момент исходника внутри переставленного куска
  const doMove = useCallback((index: number, slot: number) => {
    if (!tracks) return;
    const m = moveTarget(tracks, index, slot);
    if (!m) return;
    follow.current = (m.t0 + m.t1) / 2;
    edit(moveSpan(hand, m.t0, m.t1, m.before));
  }, [tracks, edit, hand]);
  useEffect(() => {
    const src = follow.current;
    if (src === null || !tracks) return;
    follow.current = null;
    const k = tracks.video.findIndex((c) => c.kind === 'piece' && src > (c.src0 as number) && src < (c.src1 as number));
    if (k < 0) return;
    setSel({ kind: 'piece', index: k });
    seekRef.current(tracks.video[k].t0);
  }, [tracks]);

  useEffect(() => { // клавиши: пробел — пуск, S — разрезать, Delete — удалить кусок, Ctrl+Z / Ctrl+Shift+Z — отмена и повтор
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.closest('input, textarea, select') || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.code === 'KeyZ' || e.code === 'KeyY') && !editable) return;
      if (mod && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (mod && e.code === 'KeyY') {
        e.preventDefault();
        doRedo();
        return;
      }
      if (mod || e.altKey || e.repeat) return;
      if (e.code === 'Space' && !el?.closest('button, a')) {
        e.preventDefault();
        if (playing) pause();
        else void play();
      } else if (e.code === 'KeyS' && editable) {
        e.preventDefault();
        doSplit();
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && editable && selPiece) {
        e.preventDefault();
        doDelete();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, play, pause, editable, doSplit, doDelete, doUndo, doRedo, selPiece]);

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
  const full = duration + (tracks?.tail ?? 0); // с хвостом: стоп-кадр и карточка после кусков
  const fitPps = full > 0 ? laneW / full : 40;
  const maxPps = full > 0 ? Math.min(400, MAX_WIDTH / full) : 400;
  const px = Math.min(maxPps, Math.max(Math.min(fitPps, 4), pps ?? fitPps));
  scale.current = px;
  useEffect(() => show(now.current), [px, show]);
  const X = (s: number) => s * px;
  const width = Math.ceil(X(full));
  const videoW = Math.ceil(X(duration)); // куски — волна голоса только под ними
  const tick = TICKS.find((s) => s * px >= 64) ?? 120;

  const onLanes = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    if (x < 0) return;
    seek(x / px);
  };

  // края кусков и музыка — мышью или пальцем: тянем, отпустили — правка
  const [drag, setDrag] = useState<Drag | null>(null);
  const grab = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(d);
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!drag || !tracks) return;
    e.stopPropagation(); // ручка — внутри клипа музыки: тот же жест не обрабатываем дважды
    const dx = e.clientX - drag.x0;
    if (drag.kind === 'trim') {
      const c = tracks.video[drag.index];
      const edge = (drag.side === 'start' ? c.src0 : c.src1) as number;
      setDrag({ ...drag, to: snapTo(edge + (dx / px) * speed, edges, (SNAP_PX / px) * speed) });
    } else if (drag.kind === 'piece') {
      const moved = drag.moved || Math.abs(dx) >= CLICK_PX;
      setDrag({ ...drag, dx, moved, slot: moved ? slotAt(tracks, drag.tf0 + dx / px) : null });
    } else {
      const d = dx / px;
      const room = Math.max(0, duration - 0.5);
      if (drag.mode === 'move') setDrag({ ...drag, at: Math.min(room, Math.max(0, drag.at0 + d)), moved: drag.moved || Math.abs(dx) >= CLICK_PX });
      else {
        const k = Math.min(room - drag.at0, Math.max(-Math.min(drag.at0, drag.from0), d));
        setDrag({ ...drag, at: drag.at0 + k, from: drag.from0 + k, moved: drag.moved || Math.abs(dx) >= CLICK_PX });
      }
    }
  };
  const onDragEnd = (e: React.PointerEvent) => {
    if (!drag || !tracks) return;
    e.stopPropagation();
    setDrag(null);
    if (drag.kind === 'trim') {
      const c = tracks.video[drag.index];
      if (c.piece === undefined) return;
      edit(drag.side === 'start' ? trimStart(hand, keep, c.piece, drag.to) : trimEnd(hand, keep, c.piece, drag.to, sourceDuration));
    } else if (drag.kind === 'piece') {
      if (!drag.moved) { // щелчок — выбрать кусок и встать туда
        setSel({ kind: 'piece', index: drag.index });
        seek(drag.tf0);
        return;
      }
      noClick.current = true; // щелчок после перетаскивания — не выбор (номер куска уже другой)
      if (drag.slot !== null) doMove(drag.index, drag.slot);
    } else if (!drag.moved) { // щелчок по музыке — выбрать и встать туда
      setSel({ kind: 'music' });
      const box = lanes.current?.querySelector('.ed-row.music .ed-lane')?.getBoundingClientRect();
      if (box) seek((e.clientX - box.left) / px);
    } else {
      edit(setMusic(hand, drag.mode === 'move' ? { at: drag.at } : { at: drag.at, from: drag.from }));
    }
  };
  const dragProps = { onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: () => setDrag(null) };
  const noClick = useRef(false);
  // кусок тянут целиком: мышью — сразу, пальцем — выбранный (иначе палец листает дорожки)
  const grabPiece = (e: React.PointerEvent<HTMLDivElement>, index: number, picked: boolean) => {
    noClick.current = false;
    if (!editable || e.button !== 0 || (e.pointerType === 'touch' && !picked)) return;
    const lane = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!lane) return;
    grab(e, { kind: 'piece', index, x0: e.clientX, tf0: (e.clientX - lane.left) / px, dx: 0, slot: null, moved: false });
  };
  // куда встанет перетаскиваемый кусок (время ролика) — только если место другое
  const dropAt = drag?.kind === 'piece' && drag.slot !== null && tracks && moveTarget(tracks, drag.index, drag.slot)
    ? (drag.slot < tracks.video.length ? tracks.video[drag.slot].t0 : duration) : null;

  // волна голоса: громкость исходника в каждом px финала
  const wave = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = wave.current;
    if (!c || !tracks || !peaks || !data?.media) return;
    const h = 40;
    const dpr = Math.min(2, window.devicePixelRatio || 1, MAX_CANVAS / Math.max(1, videoW));
    c.width = Math.max(1, Math.round(videoW * dpr));
    c.height = h * dpr;
    c.style.width = `${videoW}px`;
    c.style.height = `${h}px`;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.fillStyle = getComputedStyle(c).color;
    const perS = data.media.peaks.perS;
    let k = 0;
    for (let x = 0; x < videoW; x++) {
      const tf = x / px;
      while (k + 1 < tracks.video.length && tf >= tracks.video[k].t1) k++;
      const clip = tracks.video[k];
      if (!clip) break;
      const src = (clip.src0 as number) + (tf - clip.t0) * speed;
      const a = peakAt(peaks, perS, src);
      const bar = Math.max(1, a * (h - 6));
      g.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [tracks, peaks, data, videoW, px, speed]);

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
  // где стоит край куска, пока его тянут (время финала)
  const ghost = drag?.kind === 'trim' && tracks ? (() => {
    const c = tracks.video[drag.index];
    return drag.side === 'start' ? c.t0 + (drag.to - (c.src0 as number)) / speed : c.t1 + (drag.to - (c.src1 as number)) / speed;
  })() : null;
  const musicAt = drag?.kind === 'music' ? drag.at : mix?.at ?? 0;
  const voiceMuted = Boolean(hand.voice?.muted);

  // ---------- «Монтировать» ----------
  const [mount, setMount] = useState<{ state: 'idle' | 'busy' | 'started' | 'error'; error?: string }>({ state: 'idle' });
  const rev = saver.current?.rev ?? 0;
  const canMount = data?.screen === 'result' && editable && (dirty || rev > 0 || styleChanged);
  const doMount = async () => {
    if (!canMount) return;
    setMount({ state: 'busy' });
    if (dirty && !(await flush())) {
      setMount({ state: 'idle' });
      return;
    }
    try {
      const savedRev = saver.current?.rev ?? 0;
      const editor = { ...(savedRev > 0 ? { timeline: savedRev } : {}), ...(styleChanged && choice ? { style: choice } : {}) };
      const r = await fetch(`/api/jobs/${id}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'fix', editor }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${r.status}`);
      setMount({ state: 'started' });
      pause();
      void load();
    } catch (e) {
      setMount({ state: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  };
  // на старый экран (вопросы, задача): несохранённое — сначала сохранить
  const toFlow = async (e: React.MouseEvent) => {
    if (!dirty) return;
    e.preventDefault();
    if (await flush()) router.push(`/jobs/${id}`);
  };

  // ---------- экран ----------
  const notice = !data ? (error ? T('error', { e: error }) : T('loading'))
    : !data.draft ? T('noDraft')
      : !data.media ? T('oldJob')
        : !data.media.proxy ? T('longSource')
          : !data.proxyUrl ? T('noProxy') : null;
  const cutTotal = tracks?.cuts.reduce((s, c) => s + c.src1 - c.src0, 0) ?? 0;
  const saveText = save.state === 'saving' ? T('saving') : save.state === 'error' ? T('saveFailed', { e: save.error ?? '' })
    : save.state === 'conflict' ? T('conflict') : dirty ? '' : save.state === 'saved' ? T('saved') : '';
  const styleNote = styleLocked ? T('styleLocked') : mounted ? T('styleMounted') : T('styleShared');

  return (
    <div className="ed">
      <header className="ed-top">
        <Link href={`/jobs/${id}`} className="ed-back" aria-label={T('back')} onClick={(e) => void toFlow(e)}><BackIcon /></Link>
        <div className="ed-title">
          <h1>{data?.title ?? T('editor')}</h1>
          <span className="ed-beta">{T('beta')}</span>
        </div>
        <div className="ed-seg" role="group" aria-label={T('language')}>
          {(['ru', 'en'] as const).map((l) => (
            <button key={l} type="button" aria-pressed={lang === l} onClick={() => pickLang(l)}>{l.toUpperCase()}</button>
          ))}
        </div>
        {data?.screen === 'result' || data?.screen === 'working' ? (
          <button type="button" className="ed-primary" onClick={() => void doMount()} disabled={!canMount || mount.state === 'busy'}
            title={data.screen === 'working' ? T('working') : canMount ? T('mountResult') : T('nothingToMount')}>
            {mount.state === 'busy' ? T('mounting') : T('mount')}
          </button>
        ) : (
          <Link href={`/jobs/${id}`} className="ed-primary" title={T('mountHint')} onClick={(e) => void toFlow(e)}>{T('toFlow')}</Link>
        )}
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
          {data?.screen === 'working' ? <p className="ed-note ed-flag">{mount.state === 'started' ? T('mountStarted') : T('working')}</p> : null}
          {mount.state === 'error' ? <p className="ed-note ed-flag bad" role="alert">{T('mountFailed', { e: mount.error ?? '' })}</p> : null}
          {tracks ? (
            <Inspector T={T} sel={sel} tracks={tracks} hand={hand} mix={mix} editable={editable} splitHere={splitHere} videos={videos}
              onSplit={doSplit} onDelete={doDelete} onMove={doMove} onEdit={edit} sec={sec} />
          ) : null}
          {hint ? <p className="ed-note ed-flag bad" role="status">{hint}</p> : null}
          {styles && choice ? (
            <StylePanel T={T} styles={styles} choice={choice} spec={spec} offered={offered} locked={styleLocked} note={styleNote} onPick={pick} />
          ) : null}
          {videos && tracks ? (
            <section className="ed-media" aria-label={T('videos')}>
              <h2>{T('videos')}</h2>
              <ol className="ed-videos">
                {videos.map((v, k) => {
                  const first = tracks.video.find((c) => c.kind === 'piece' && c.videoNo === k);
                  return (
                    <li key={k}>
                      <button type="button" disabled={!first} title={first ? T('toVideo') : T('videoCut')}
                        onClick={() => { if (first) { seek(first.t0); setSel({ kind: 'piece', index: tracks.video.indexOf(first) }); } }}>
                        <span className="ed-vno">{k + 1}</span>
                        <span className="grow">{v.name}</span>
                        <span className="mono">{first ? tenths(v.t1 - v.t0) : T('videoCut')}</span>
                      </button>
                      {!first && editable ? ( // вырезано целиком — вернуть всё видео (как «＋», только сразу всё)
                        <button type="button" className="ed-btn" title={T('restoreVideoT')} onClick={() => edit(restoreSpan(hand, v.t0, v.t1))}>
                          {T('restoreVideo')}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
          <h2>{T('draft')}</h2>
          {tracks && editable ? <p className="ed-note">{T('editHint')}</p> : null}
          {tracks ? (
            <dl className="ed-facts">
              <dt>{T('duration', { s: '' }).trim()}</dt><dd className="mono">{tenths(duration)}</dd>
              {data?.media ? (<><dt>{T('source', { s: '' }).trim()}</dt><dd className="mono">{tenths(data.media.duration)}</dd></>) : null}
              <dt>{T('piece')}</dt><dd className="mono">{tracks.video.filter((c) => c.kind === 'piece').length}</dd>
              <dt>{T('cutPart', { s: '' }).trim()}</dt><dd className="mono">{sec(cutTotal)}</dd>
              <dt>{T('subtitles')}</dt><dd className="mono">{tracks.subtitles.length}</dd>
            </dl>
          ) : null}
          {data?.screen !== 'result' && data?.screen !== 'working' ? <p className="ed-note">{T('mountHint')}</p> : null}
          {spec ? <p className="ed-note faint">{T('previewNote')}</p> : null}
        </aside>
      </div>

      <section className="ed-tl" aria-label="Timeline">
        <div className="ed-bar">
          <button type="button" className="ed-play" onClick={() => (playing ? pause() : void play())} disabled={!data?.proxyUrl || !tracks}
            aria-label={playing ? T('pause') : T('play')}>{playing ? <PauseIcon /> : <PlayIcon />}</button>
          <span className="mono ed-clock"><span ref={clock}>{tenths(t)}</span> / {tenths(duration)}</span>
          <span className="ed-sep" />
          <button type="button" className="ed-icon" aria-label={T('undo')} title={T('undoT')} onClick={doUndo} disabled={!editable || !hist.past.length}><UndoIcon /></button>
          <button type="button" className="ed-icon" aria-label={T('redo')} title={T('redoT')} onClick={doRedo} disabled={!editable || !hist.future.length}><RedoIcon /></button>
          <button type="button" className="ed-tool" aria-label={T('split')} title={T('splitT')} onClick={doSplit} disabled={!editable || splitSrc === null}>
            <ScissorsIcon /><span>{T('split')}</span>
          </button>
          <button type="button" className="ed-tool" aria-label={T('delete')} title={T('deleteT')} onClick={doDelete}
            disabled={!editable || !selPiece || selPiece.kind !== 'piece'}>
            <TrashIcon /><span>{T('delete')}</span>
          </button>
          <span className="ed-save" data-state={save.state} role="status">
            {saveText}
            {save.state === 'error' ? <button type="button" onClick={() => void flush()}>{T('retry')}</button> : null}
            {save.state === 'conflict' ? <button type="button" onClick={() => void reloadEdits()}>{T('reloadEdits')}</button> : null}
          </span>
          <span className="ed-grow" />
          <button type="button" className="ed-icon" aria-label={T('zoomOut')} onClick={() => setPps(px / ZOOM)} disabled={px <= Math.min(fitPps, 4) + 1e-6}>−</button>
          <button type="button" className="ed-icon" aria-label={T('zoomIn')} onClick={() => setPps(px * ZOOM)} disabled={px >= maxPps - 1e-6}>+</button>
        </div>
        <div className="ed-scroll" ref={lanes}>
          {tracks ? (
            <div className="ed-inner" style={{ width: HEAD + width + 24 }}>
              <div className="ed-ruler" style={{ marginLeft: HEAD, width }} onPointerDown={onLanes}>
                {Array.from({ length: Math.floor(full / tick) + 1 }, (_, k) => (
                  <span key={k} style={{ left: X(k * tick) }}>{tenths(k * tick).replace(/\.0$/, '')}</span>
                ))}
              </div>
              <Row name={T('video')} cls="video" width={width} onSeek={onLanes}>
                {tracks.video.map((c, i) => {
                  const picked = sel?.kind === 'piece' && sel.index === i;
                  const movable = editable && c.kind === 'piece';
                  const dragging = drag?.kind === 'piece' && drag.index === i && drag.moved;
                  return (
                    <div key={`${c.src0}-${c.src1}`}
                      className={`ed-clip ed-piece${c.kind === 'teaser' ? ' teaser' : ''}${picked ? ' sel' : ''}${movable ? ' movable' : ''}${dragging ? ' dragging' : ''}`}
                      style={{ left: X(c.t0), width: Math.max(2, X(c.t1 - c.t0)), ...(dragging ? { transform: `translateX(${drag.dx}px)` } : {}) }}
                      onClick={() => {
                        if (noClick.current) noClick.current = false;
                        else setSel({ kind: 'piece', index: i });
                      }}
                      {...(movable ? { onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => grabPiece(e, i, picked), ...dragProps } : {})}
                      title={`${c.kind === 'teaser' ? T('teaser') : T('piece')} · ${tenths(c.src0 as number)}–${tenths(c.src1 as number)}`}>
                      <div className="ed-thumbs">{thumbs(c)}</div>
                      {c.kind === 'teaser' ? <span className="ed-tag">{T('teaser')}</span> : null}
                      {videos && c.videoNo !== undefined && c.kind === 'piece' ? <span className="ed-vno on-piece">{c.videoNo + 1}</span> : null}
                      {editable && c.kind === 'piece' && c.edgeStart ? (
                        <span className="ed-handle start" aria-hidden="true" onPointerDown={(e) => grab(e, { kind: 'trim', index: i, side: 'start', x0: e.clientX, to: c.src0 as number })} {...dragProps} />
                      ) : null}
                      {editable && c.kind === 'piece' && c.edgeEnd ? (
                        <span className="ed-handle end" aria-hidden="true" onPointerDown={(e) => grab(e, { kind: 'trim', index: i, side: 'end', x0: e.clientX, to: c.src1 as number })} {...dragProps} />
                      ) : null}
                    </div>
                  );
                })}
                {tracks.looks.map((c, i) => <div key={`l${i}`} className="ed-look" style={{ left: X(c.t0), width: Math.max(2, X(c.t1 - c.t0)) }} title={T('bw')} />)}
                {tracks.cuts.map((c, i) => (
                  // две метки на одном стыке (куски переставлены) — «＋» каждой в том куске, к которому вернётся вырезанное
                  <span key={`c${i}`} style={{ left: X(c.at) }} title={T('cutPart', { s: sec(c.src1 - c.src0) })}
                    className={`ed-cut${tracks.cuts.some((o) => o !== c && Math.abs(o.at - c.at) < 1e-6) ? ` ${c.side}` : ''}`}>
                    {editable ? (
                      <button type="button" className="ed-restore" aria-label={T('restoreT', { s: sec(c.src1 - c.src0) })} title={T('restoreT', { s: sec(c.src1 - c.src0) })}
                        onPointerDown={(e) => e.stopPropagation()} onClick={() => doRestore(c)}><PlusIcon size={12} /></button>
                    ) : null}
                  </span>
                ))}
                {ghost !== null ? <span className="ed-ghost" style={{ left: X(ghost) }} /> : null}
                {dropAt !== null ? <span className="ed-drop" style={{ left: X(dropAt) }} aria-hidden="true" /> : null}
                {tracks.tail > 0 ? (
                  <div className="ed-tail" style={{ left: X(duration), width: Math.max(2, X(tracks.tail)) }} title={`${T('tail')} · ${sec(tracks.tail)}`}>
                    <span>{T('tail')}</span>
                  </div>
                ) : null}
              </Row>
              <Row name={T('voice')} cls={`voice${voiceMuted ? ' muted' : ''}${sel?.kind === 'voice' ? ' sel' : ''}`} width={width}
                onSeek={(e) => { setSel({ kind: 'voice' }); onLanes(e); }}
                tool={<MuteButton T={T} what={T('voice')} on={voiceMuted} disabled={!editable} onToggle={() => edit(setVoice(hand, { muted: !voiceMuted }))} />}>
                <canvas ref={wave} className="ed-wave" aria-hidden="true" />
              </Row>
              <Row name={T('music')} cls={`music${mix?.muted ? ' muted' : ''}`} width={width} onSeek={onLanes}
                tool={mix ? <MuteButton T={T} what={T('music')} on={mix.muted} disabled={!editable} onToggle={() => edit(setMusic(hand, { muted: !mix.muted }))} /> : null}>
                {tracks.music && mix ? (
                  <div className={`ed-clip music${sel?.kind === 'music' ? ' sel' : ''}${drag?.kind === 'music' ? ' dragging' : ''}`}
                    style={{ left: X(musicAt), width: Math.max(2, X(duration - musicAt)) }}
                    title={`${tracks.music.label} · ${mix.gainDb} dB`}
                    onPointerDown={(e) => (editable ? grab(e, { kind: 'music', mode: 'move', x0: e.clientX, at0: mix.at, from0: mix.from, at: mix.at, from: mix.from, moved: false })
                      : setSel({ kind: 'music' }))} {...dragProps}>
                    {editable ? (
                      <span className="ed-handle start" aria-hidden="true" {...dragProps}
                        onPointerDown={(e) => grab(e, { kind: 'music', mode: 'trim', x0: e.clientX, at0: mix.at, from0: mix.from, at: mix.at, from: mix.from, moved: false })} />
                    ) : null}
                    <span>{`${tracks.music.label} · ${mix.gainDb} dB`}</span>
                  </div>
                ) : <span className="ed-empty">{T('noMusic')}</span>}
              </Row>
              {tracks.sounds.length ? (
                <Row name={T('sounds')} cls="snd" width={width} onSeek={onLanes}>
                  {tracks.sounds.map((c) => {
                    const muted = Boolean(c.key && hand.sounds?.[c.key]?.muted);
                    return (
                      <div key={c.key} className={`ed-clip snd${muted ? ' muted' : ''}${sel?.kind === 'sound' && sel.key === c.key ? ' sel' : ''}`}
                        style={{ left: X(c.t0), width: Math.max(14, X(c.t1 - c.t0)) }} title={`${c.label} · ${tenths(c.t0)}`}
                        onClick={() => c.key && setSel({ kind: 'sound', key: c.key })}>
                        <span>{c.label}</span>
                      </div>
                    );
                  })}
                </Row>
              ) : null}
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

function Row({ name, cls, width, onSeek, tool, children }: {
  name: string; cls: string; width: number; onSeek: (e: React.PointerEvent<HTMLDivElement>) => void; tool?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className={`ed-row ${cls}`}>
      <div className="ed-head"><span>{name}</span>{tool}</div>
      <div className="ed-lane" style={{ width }} onPointerDown={onSeek}>{children}</div>
    </div>
  );
}

function MuteButton({ T, what, on, disabled, onToggle }: {
  T: (k: Key, v?: Record<string, string | number>) => string; what: string; on: boolean; disabled: boolean; onToggle: () => void;
}) {
  return (
    <button type="button" className="ed-mute" aria-pressed={on} aria-label={T('muteT', { what })} title={T('muteT', { what })} disabled={disabled} onClick={onToggle}>
      <SpeakerIcon off={on} />
    </button>
  );
}
