'use client';
// Редактор (бета): светлый экран как у veed — кадр с прокси-видео, под ним таймлайн с дорожками черновика монтажа.
// Кадр — как в ролике: текст и вставки рисует тот же шаблон по тем же событиям, что финал (перенос
// build_overlay_events), картинка — зум к лицу, ч/б, вспышка, смаз, перебивки по формулам движка (frame.tsx); куски
// играются подряд (вырезанное пропускается, скорость — как у монтажа), после них — стоп-кадр и финальная карточка.
// Правки руками: разрезать, удалить, вернуть и переставить куски, тянуть их края (липнут к словам); тянуть и растягивать
// хук, титр, акценты и вставки, убирать и возвращать их, править их текст и слова субтитров — в панели и прямо на кадре
// (касание кадра — выбор; хук и субтитры тянутся выше-ниже и крупнее, вставки и акценты — по кадру); громкость и «без звука»
// голоса, музыки и звуков, где звучит музыка; отмена и повтор. Правки сохраняются сами в timeline.json — движок кладёт
// их поверх черновика при монтаже; прослушивание сводит звук как ролик (mixer.ts). «Монтировать» у готового ролика —
// новая версия (правка с правками и стилем); до монтажа — старый экран с вопросами.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { musicBeats } from '@/lib/beats.ts';
import { applyFields, blockTarget, textFields, type BlockField, type TextTarget } from '@/lib/blocktext.ts';
import { blockRoom, finalEdges, hookUntil, sourceSpan, stackRows } from '@/lib/blocks.ts';
import { statusText, storage } from '@/lib/client.ts';
import { createClock } from '@/lib/clock.ts';
import { coverUrl, editorGates, layerUrl, type EditorData } from '@/lib/editordata.ts';
import { sameJson } from '@/lib/equal.ts';
import {
  addLook, addPlace, addTransition, commit, cutSpan, EMPTY, initHistory, moveSpan, moveTransition, placeBlock, redo, removeLook, removePlace, removeTransition,
  restoreSpan, setBlock, setCta, setHook, setLook, setLookEdges, setMusic, setOwnPlace, setOwnTransition, setPlace, setPlaceOff, setTransition, setVoice, splitAt,
  trimEnd, trimStart, undo, type HandEdits, type History, type Place, type TransitionKind,
} from '@/lib/edits.ts';
import { tenths } from '@/lib/format.ts';
import { loadLang, saveLang, tr, type Key, type Lang } from '@/lib/i18n.ts';
import type { StyleChoice, StyleSpec } from '@/lib/jobfiles.ts';
import { buildOverlayEvents, eventIndexAt, hookEnd, type LayerEvent } from '@/lib/overlay.ts';
import { pictureModel, type Cover } from '@/lib/picture.ts';
import { missingLetters, typedText } from '@/lib/fontchars.ts';
import { advance, afterEnded, locate, stillSource, tailAt } from '@/lib/player.ts';
import {
  allowedFonts, finalStyle, loadChoice, loadInsertBoxes, mergeStyle, placedInserts, placeText, sampleState, saveChoice, textPlace, type TextPart,
} from '@/lib/style.ts';
import { clickGuard, dragTo, type Drag, type DragView, type EffectRef } from '@/lib/drag.ts';
import { phraseAt } from '@/lib/subs.ts';
import { Saver, type PutResult } from '@/lib/saver.ts';
import { audioUrl, levelsOf, musicMix } from '@/lib/sound.ts';
import {
  clipAt, decodePeaks, draftTracks, findBlock, moveTarget, peakAt, splitTarget, timelineOf, videoKey, withHandEdits, wordEdges, type Clip, type LayerStyle,
  type Tracks,
} from '@/lib/tracks.ts';
import type { Box } from '../../../handles';
import { BackIcon, PauseIcon, PlayIcon, PlusIcon, RedoIcon, ScissorsIcon, SpeakerIcon, TrashIcon, UndoIcon } from '../../../icons';
import PreviewFrame from '../../../preview-frame';
import { useFontChars, useTemplateFonts } from '../../../use-fonts';
import { BlockPanel, EndPanel, fieldError, fieldLabel, isPicked, removeBlock, sameRef, WordsPanel, type Letters } from './blockpanel';
import { Bar, Layer, Picture, pickKey, type FramePick, type FrameTarget, type HandleText, type PickedBox, type StyleMove } from './frame';
import { InlineText } from './inline';
import { Mixer, type MixPlan } from './mixer';
import { Inspector, StylePanel, type Selection } from './panels';
import { EffectsSection, PlacePick, RAISED_Y, samePlace } from './effectspanel';
import { KIND_NAMES, LOOK_NAMES, PicturePick, PictureSection, sameLook, sameTransition, VideoSection } from './picturepanel';

const HEAD = 112; // px — колонка с именами дорожек
const MAX_WIDTH = 30_000; // px — ширина дорожек
const MAX_CANVAS = 32_767; // px холста — больше браузеры не рисуют (с учётом плотности экрана)
const ZOOM = 1.5;
const THUMB_H = 56;
const TICKS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
const RELOAD_MS = 20_000; // пока нет черновика или прокси или Claude монтирует — спрашиваем снова
const UI_HZ = 15; // столько раз в секунду во время пуска обновляется остальной экран (кадр и плейхед — каждый кадр)
const SAVE_MS = 1200; // правки сохраняются, когда Павел остановился на столько
const SNAP_PX = 8; // край куска или блока липнет к границе слова ближе стольких px
const ROW_H = 26; // px — строка дорожки субтитров, текста и вставок (блоки одновременно — друг под другом)
const EDITABLE = ['questions', 'result', 'error']; // сессия не работает — правки можно сохранять
const NOTE_MS = 4000; // подпись на кадре (почему текст не правится, что не сохранилось) — столько держится

type SaveState = { state: 'idle' | 'saving' | 'saved' | 'error' | 'conflict'; error?: string };
type BlockDrag = Extract<Drag, { kind: 'block' }>;
type LookDrag = Extract<Drag, { kind: 'look' }>;
type EffectDrag = Extract<Drag, { kind: 'effect' }>;
const FX = ['tear', 'glitch']; // разрыв и глитч — на дорожке «Эффекты»
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

  // данные: сразу и снова, пока черновика или прокси ещё нет (сессия пишет, страница переносит прокси в релиз) или Claude монтирует
  const last = useRef<{ etag: string; data: EditorData } | null>(null); // то же содержимое — 304 без тела (трафик Vercel)
  const load = useCallback(async (): Promise<EditorData | null> => {
    try {
      const was = last.current;
      const r = await fetch(`/api/jobs/${id}/editor`, { cache: 'no-store', headers: was ? { 'If-None-Match': was.etag } : {} });
      if (r.status === 304 && was) {
        setError('');
        return was.data;
      }
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(r.status !== 402 && typeof body?.error === 'string' ? body.error : statusText(r.status, 'HTTP'));
      const etag = r.headers.get('ETag');
      last.current = etag ? { etag, data: body as EditorData } : null;
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
      const error = r.status !== 402 && typeof body?.error === 'string' ? body.error : statusText(r.status, 'HTTP');
      return { ok: false, conflict: r.status === 409 && typeof body?.rev === 'number', error };
    }, EMPTY, 0);
  }
  const adopted = useRef(false);
  const [save, setSave] = useState<SaveState>({ state: 'idle' });
  const hand = hist.present;
  const dirty = hand !== saved;
  // задача до редактора (в её ветке нет схемы timeline.json): её движок правок руками не знает — только смотреть
  const editable = Boolean(data?.draft) && EDITABLE.includes(data?.screen ?? '') && (data?.abilities.edits ?? true);
  const mounted = Boolean(data?.answers);
  // что примет движок задачи (старая задача — старый движок) и что правится до монтажа: только то, чего не выбирают
  // «Превью» и вопросы (куски, сила зума, громкости) — остальное после него (editorGates)
  const gates = editorGates(editable, mounted, data?.abilities);
  const canMove = gates.move;
  const canText = gates.text;
  const textNote = !data?.draft ? null : !mounted ? T('textAfterMount') : !data.abilities.text ? T('textOld') : null;
  const canZoom = gates.zoom;
  const canMarks = gates.marks; // переходы и затемнение фона
  const canLook = gates.looks; // убрать и вернуть кусок с фильтром (и до монтажа)
  const canShape = gates.lookHand; // свои куски, края и фильтр кусков (старый движок их не знает)
  const canFx = gates.effects; // эффекты разбора руками: сдвиг и свои переходы, поднятые субтитры (старый движок их не знает)
  const fxNote = !data?.draft || !editable ? null : !mounted ? T('pictureAfterMount') : !data.abilities.effects ? T('pictureOld') : null;
  const pictureNote = !data?.draft ? null : !data.abilities.picture ? T('pictureOld') : !mounted ? T('pictureAfterMount') : null;
  const canTrack = gates.track;
  const trackNote = !editable || !data?.draft ? null : !data.abilities.track ? T('trackOld') : !mounted ? T('trackAfterMount') : null;
  const canCard = gates.card;
  const cardNote = !data?.draft ? null : !mounted ? T('textAfterMount') : !data.abilities.card ? T('cardOld') : null;
  const canPlace = gates.place;
  const placeNote = data?.draft && mounted && data.abilities.text && !data.abilities.place ? T('placeOld') : null;
  const canSpeed = gates.speed;
  const canTeaser = gates.teaser;
  const videoNote = !editable ? null : !data?.abilities.video ? T('videoOld') : !mounted ? T('speedAfterMount') : null;

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
  // текст на кадре: открытое поле (блок, его поля, где он нарисован, от каких правок начат) и набранное — пока Павел
  // набирает, кадр рисует его (правки ещё нет); подпись на кадре — почему касание ничего не открыло или что не сохранилось
  const [editing, setEditing] = useState<{ target: TextTarget; fields: BlockField[]; box: Box; base: HandEdits; seq: number } | null>(null);
  const [typing, setTyping] = useState<HandEdits | null>(null);
  const [inlineBox, setInlineBox] = useState<Box | null>(null); // рамка блока, пока в поле набирают (текст длиннее — блок больше)
  const opened = useRef(0);
  const [frameNote, setFrameNote] = useState('');
  useEffect(() => {
    if (!frameNote) return;
    const timer = setTimeout(() => setFrameNote(''), NOTE_MS);
    return () => clearTimeout(timer);
  }, [frameNote]);

  // ---------- стиль: какой увидит ролик ----------
  const styles = data?.styles ?? null;
  const [choice, setChoiceState] = useState<StyleChoice | null>(null);
  const shown = useRef<unknown>(undefined); // стиль ролика, от которого начат выбор: новые данные с тем же — выбор не трогают
  useEffect(() => {
    // смонтирован — от стиля ролика (новый, ещё не смонтированный, живёт до перезагрузки); иначе — выбор с «Превью»
    // (выбора ещё нет — «Мой стиль» бренда, как там)
    if (!styles) return;
    const rendered = data?.answers?.style ?? null;
    if (shown.current !== undefined && sameJson(shown.current, rendered)) return;
    shown.current = rendered;
    setChoiceState(rendered ?? loadChoice(storage(), id, styles, data?.brandLook?.style ?? null));
  }, [styles, data?.answers, data?.brandLook, id]);
  const [mount, setMount] = useState<{ state: 'idle' | 'busy' | 'started' | 'error'; error?: string }>({ state: 'idle' });
  // стиль закрыт, пока Claude монтирует (и пока «Монтировать» уходит: выбор перечитается из ветки); после монтажа — у
  // задачи, чей движок правок не знает: «Монтировать» его не отправит
  const styleLocked = data?.screen === 'working' || mount.state === 'busy';
  const styleOpen = !styleLocked && (!mounted || editable);
  const pick = (c: StyleChoice) => {
    if (!styles || !styleOpen) return;
    setChoiceState(c);
    if (!mounted) saveChoice(storage(), id, styles, c); // до монтажа — общий с «Превью»
  };
  const answered = data?.answers?.style ?? null;
  const styleChanged = mounted && choice !== null && !sameJson(choice, answered);
  const videoStyle = data?.draft?.style ?? null;
  // пока Claude монтирует новый стиль из редактора, ролик (edit.json) — ещё в прошлом: новый — поверх него от прошлого выбора
  const styleBase = data?.styleFrom ?? answered;
  // стиль слоя: смонтированный ролик — стиль из edit.json (выбор Павла и правки текстом); Павел выбрал другой — новый
  // поверх него, как сложит монтаж (vm style --onto); до монтажа — по выбору
  const spec = useMemo((): StyleSpec | null => {
    if (!styles || !choice) return null;
    const picked = finalStyle(styles, choice);
    if (!videoStyle || !styleBase) return picked;
    if (sameJson(choice, styleBase)) return videoStyle;
    return mergeStyle(finalStyle(styles, styleBase), videoStyle, picked);
  }, [styles, choice, videoStyle, styleBase]);
  const fonts = useTemplateFonts();
  // буквы шрифтов (таблицы символов тех же файлов, что рисуют ролик): набранного Павлом, чего нет в шрифте стиля, монтаж не
  // пропустит (fonts.check) — поле говорит сразу, а шрифты без его букв стиль не предлагает (выбранный — остаётся)
  const allowed = useMemo(() => (styles ? allowedFonts(fonts, styles) : []), [fonts, styles]); // со всеми буквами ролика
  const chars = useFontChars(allowed);
  const typed = useMemo(() => typedText(hand, spec?.hook.mode === 'accent'), [hand, spec?.hook.mode]);
  const offered = useMemo(() => allowed.filter((f) => { // и набранного Павлом
    const have = chars.get(f.id);
    return !have || f.id === (f.kind === 'main' ? spec?.font : spec?.hand) || !missingLetters(have, f.kind === 'main' ? typed.main : typed.hand);
  }), [allowed, chars, typed, spec?.font, spec?.hand]);
  const letters = useCallback<Letters>((role, text) => {
    if (!spec) return null;
    const id = role === 'hand' && spec.hook.mode !== 'accent' ? spec.hand : spec.font;
    const have = chars.get(id);
    const lack = have ? missingLetters(have, text) : '';
    return lack ? T('noLetters', { font: fonts.find((f) => f.id === id)?.family ?? id, s: [...lack].join(' ') }) : null;
  }, [spec, chars, fonts, T]);

  // ---------- черновик с правками ----------
  const sourceDuration = data?.media?.duration;
  // до монтажа вставки стоят там, куда Павел их поставил на «Превью» (их рамки положит монтаж — placed_inserts)
  const draft = useMemo(() => {
    const d = data?.draft ?? null;
    if (!d || mounted) return d;
    const boxes = loadInsertBoxes(storage(), id);
    return Object.keys(boxes).length ? { ...d, inserts: placedInserts(d.inserts, boxes) } : d;
  }, [data?.draft, mounted, id]);
  // куски и музыка: громкость голоса и звуков их не пересчитывает (и плеер не перематывает)
  const edited = useMemo(() => (draft ? withHandEdits(draft, { edits: hand.edits, music: hand.music, teaser: hand.teaser, speed: hand.speed }, sourceDuration) : null),
    [draft, hand.edits, hand.music, hand.teaser, hand.speed, sourceDuration]);
  // доли музыки ролика (beats.json): вставки и зум встают на них, как в render.on_beats; выключенная музыка — без долей
  const beats = useMemo(() => {
    if (!edited || !data?.beats) return null;
    try {
      return musicBeats(data.beats, hand.music?.muted ? null : edited.draft.music, timelineOf(edited.draft, sourceDuration).duration);
    } catch {
      return null;
    }
  }, [edited, data?.beats, hand.music?.muted, sourceDuration]);
  // слою из стиля нужны только вид и слов субтитров и вид хука: место, размер и цвета (ползунки, ручки на кадре) дорожки
  // и события не пересчитывают — их перерисовывает шаблон
  const layerStyle = useMemo((): LayerStyle | null => (spec
    ? { subtitles: { mode: spec.subtitles.mode, words: spec.subtitles.words }, hook: { mode: spec.hook.mode } } : null),
  [spec?.subtitles.mode, spec?.subtitles.words, spec?.hook.mode]);
  const view = typing ?? hand; // пока Павел набирает текст на кадре — кадр с набранным (правки ещё нет)
  // дорожки и слой — с правками текста; не сложились (так монтаж правку не примет) — без них, чтобы экран не пропал
  const tracks: Tracks | null = useMemo(() => {
    if (!edited) return null;
    const base = { ...(layerStyle ? { style: layerStyle } : {}), sourceDuration, splits: edited.splits, videos: data?.media?.videos, beats };
    try {
      const fixes = { text: view.text, words: view.words, zoom: hand.zoom, looks: hand.looks, transitions: hand.transitions, subPlaces: hand.subPlaces };
      return draftTracks(edited.draft, { ...base, fixes });
    } catch {
      try {
        return draftTracks(edited.draft, base);
      } catch {
        return null;
      }
    }
  }, [edited, layerStyle, sourceDuration, data?.media?.videos, view.text, view.words, hand.zoom, hand.looks, hand.transitions, hand.subPlaces, beats]);
  const videos = (data?.media?.videos?.length ?? 0) > 1 ? data?.media?.videos ?? null : null; // несколько видео задачи — где какое
  // дорожка «Эффекты» — у любого ролика, чей движок знает эффекты руками (и у старого, где они уже есть): разрывы,
  // глитчи, поднятые субтитры
  const fxRow = Boolean(data?.abilities.effects) || Boolean(tracks && (tracks.places.length || tracks.transitions.some((x) => FX.includes(x.kind))));
  const mix = useMemo(() => musicMix(data?.draft?.music ?? null, hand.music), [data, hand.music]);
  const edges = useMemo(() => (data?.draft ? wordEdges(data.draft) : []), [data]);
  const peaks = useMemo(() => (data?.media ? decodePeaks(data.media.peaks.data) : null), [data]);
  const duration = tracks?.duration ?? 0;
  const tail = tracks?.tail ?? 0;
  const full = duration + tail; // с хвостом: стоп-кадр и карточка после кусков
  const speed = edited?.draft.speed ?? 1; // с правкой Павла: ролик быстрее или медленнее
  const tl = tracks?.layer.tl ?? null;
  const blockEdges = useMemo(() => (tl && data?.draft ? finalEdges(tl, data.draft.words) : []), [tl, data?.draft]);
  const room = useMemo(() => (tracks ? blockRoom(tracks.layer.tl, hookEnd(tracks.layer.edit, tracks.layer.tl)) : { floor: 0, max: 0 }), [tracks]);

  // слой кадра: события, которые нарисует финал; картинки вставок и логотип — по адресам страницы
  const head = data?.head ?? null;
  const urlOf = useCallback((path: string) => layerUrl(id, head, path), [id, head]);
  const brolls = data?.brolls;
  const clipOf = useCallback((c: Cover) => {
    const b = brolls?.find((x) => x.src === c.src); // перебивка: видео ли — по загрузке, а не по расширению
    return { url: coverUrl(id, head, brolls ?? [], c.src), video: b ? b.video : c.video };
  }, [id, head, brolls]);
  const events = useMemo((): LayerEvent[] | null => {
    if (!tracks) return null;
    const { edit, tl: line } = tracks.layer;
    const drawn = {
      ...edit,
      inserts: (edit.inserts ?? []).map((i) => (i.src ? { ...i, src: urlOf(i.src) } : i)),
      end: edit.end?.logo ? { ...edit.end, logo: urlOf(edit.end.logo) } : edit.end,
    };
    try {
      return buildOverlayEvents(drawn, line);
    } catch {
      return null;
    }
  }, [tracks, urlOf]);
  const picture = useMemo(() => (tracks && edited
    ? pictureModel(tracks.layer, { face: edited.draft.face }) : null), [tracks, edited]);

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

  // ---------- плеер: куски подряд, потом стоп-кадр и карточка ----------
  const video = useRef<HTMLVideoElement>(null);
  const piece = useRef(0);
  const playhead = useRef<HTMLDivElement>(null);
  const clockText = useRef<HTMLSpanElement>(null);
  const clock = useMemo(() => createClock(0), []);
  const now = useRef(0);
  const scale = useRef(40);
  const playingRef = useRef(false);
  const tailFrom = useRef<number | null>(null); // хвост играет: когда (мс performance.now) он начался бы с начала
  const mixer = useRef<Mixer | null>(null);
  useEffect(() => {
    const m = new Mixer();
    mixer.current = m;
    return () => m.close();
  }, []);
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

  const show = useCallback((tf: number) => { // часы (кадр и шкала подписаны на них), плейхед и время — без React, каждый кадр
    now.current = tf;
    clock.set(tf);
    if (playhead.current) playhead.current.style.transform = `translateX(${HEAD + tf * scale.current}px)`;
    if (clockText.current) clockText.current.textContent = tenths(tf);
  }, [clock]);

  const seek = useCallback((tf: number) => {
    if (!tracks?.video.length) return;
    const x = Math.min(Math.max(0, tf), full);
    const v = video.current;
    if (x >= duration && tail > 0) { // стоп-кадр и карточка: видео стоит на последнем кадре, часы идут сами
      piece.current = tracks.video.length - 1;
      if (v && v.readyState > 0) v.currentTime = stillSource(tracks.video);
      if (playingRef.current) {
        v?.pause();
        tailFrom.current = performance.now() - (x - duration) * 1000;
      }
    } else {
      const { index, src } = locate(tracks.video, speed, x);
      piece.current = index;
      if (v && v.readyState > 0) v.currentTime = src;
      if (tailFrom.current !== null) { // из хвоста — обратно в куски: видео снова играет
        tailFrom.current = null;
        if (playingRef.current) void v?.play().catch(() => undefined);
      }
    }
    show(x);
    setT(x);
  }, [tracks, full, duration, tail, speed, show]);
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const vkey = tracks ? videoKey(tracks) : '';
  useEffect(() => seekRef.current(now.current), [vkey]); // куски поменялись — тот же момент ролика на новых кусках

  const pause = useCallback(() => {
    video.current?.pause();
    mixer.current?.stop();
    playingRef.current = false;
    tailFrom.current = null;
    setPlaying(false);
  }, []);
  /** Куски кончились: дальше — стоп-кадр и карточка (их нет — false: ролик кончился). */
  const toTail = useCallback((ms: number): boolean => {
    const v = video.current;
    if (!tracks?.video.length || tail <= 0) return false;
    v?.pause();
    if (v) v.currentTime = stillSource(tracks.video);
    piece.current = tracks.video.length - 1;
    tailFrom.current = ms;
    show(duration);
    return true;
  }, [tracks, tail, duration, show]);
  useEffect(() => { // скорость поменяли, пока играет (ползунок, отмена): видео сразу идёт с ней — часы считают по ней
    if (video.current) video.current.playbackRate = speed;
  }, [speed]);
  const play = useCallback(async () => {
    const v = video.current;
    if (!v || !tracks?.video.length) return;
    if (now.current >= full - 0.05) seek(0); // доиграл — сначала
    v.playbackRate = speed;
    playingRef.current = true;
    if (tail > 0 && now.current >= duration) { // в хвосте: часы сами, видео стоит
      tailFrom.current = performance.now() - (now.current - duration) * 1000;
      setPlaying(true);
      if (plan) void mixer.current?.start(() => now.current, plan);
      return;
    }
    try {
      await v.play();
      setPlaying(true);
      if (plan) void mixer.current?.start(() => now.current, plan);
    } catch {
      playingRef.current = false;
      setPlaying(false);
    }
  }, [tracks, full, duration, tail, speed, seek, plan]);

  useEffect(() => {
    if (!playing || !tracks) return;
    let raf = 0;
    let last = 0;
    const tick = (ms: number) => {
      const v = video.current;
      if (!v) return;
      let tf: number;
      if (tailFrom.current !== null) {
        const r = tailAt(duration, full, tailFrom.current, ms);
        if (r.end) {
          pause();
          show(full);
          setT(full);
          return;
        }
        tf = r.t;
      } else {
        const step = advance(tracks.video, speed, piece.current, v.currentTime); // конец куска — следующий, вырезанное мимо
        piece.current = step.index;
        if (step.end) {
          if (!toTail(ms)) {
            pause();
            show(duration);
            setT(duration);
            return;
          }
          tf = duration;
        } else {
          if (step.seek !== undefined) v.currentTime = step.seek;
          tf = step.t;
        }
      }
      show(tf);
      mixer.current?.sync(tf);
      if (ms - last > 1000 / UI_HZ) {
        last = ms;
        setT(tf);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, tracks, speed, duration, full, pause, show, toTail]);

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
  // видео кончилось раньше, чем это заметил кадр плеера: файл кончился не на последнем куске (конец записи переставлен
  // раньше) — дальше следующий кусок; на последнем — хвост; его нет — плейхед в конце кусков
  const onEnded = () => {
    const v = video.current;
    if (tailFrom.current !== null || !v?.ended) return; // кадр плеера уже перемотал дальше — видео играет
    const next = playingRef.current && tracks ? afterEnded(tracks.video, piece.current) : null;
    if (next) {
      piece.current = next.index;
      v.currentTime = next.src;
      show(next.t);
      void v.play().catch(() => pause());
      return;
    }
    if (playingRef.current && toTail(performance.now())) return;
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
  const selBlock = sel?.kind === 'block' && tracks ? findBlock(tracks, sel.block, sel.n) : null;
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
  const doRemoveBlock = useCallback(() => {
    if (!selBlock?.ref || selBlock.ghost || !canText) return;
    edit(removeBlock(hand, selBlock.ref));
  }, [selBlock, canText, edit, hand]);
  // место выбранной вставки или акцента на кадре: ручкой поверх кадра (пока блок на нём) и кнопками в панели блока
  const placeRef = selBlock && !selBlock.ghost && (selBlock.ref?.kind === 'insert' || selBlock.ref?.kind === 'accent') ? selBlock.ref : null;
  // выбранное — на кадре (рамкой, когда шаблон его нарисовал): блок, группа субтитров на кадре, карточка (если она в ролике)
  const cardHere = Boolean(draft?.end && !hand.text?.end?.off);
  const framePick: FramePick | null = !sel ? null
    : sel.kind === 'sub' ? { kind: 'sub' }
      : sel.kind === 'end' ? (cardHere ? { kind: 'end' } : null)
        : sel.kind !== 'block' || !selBlock?.ref || selBlock.ghost ? null
          : selBlock.ref.kind === 'insert' ? (selBlock.drawn === false ? null : { kind: 'insert', n: selBlock.ref.n })
            : selBlock.ref.kind === 'accent' ? { kind: 'accent', t0: selBlock.t0, t1: selBlock.t1 }
              : selBlock.ref.kind === 'hook' || selBlock.ref.kind === 'cta' ? { kind: selBlock.ref.kind } : null;
  const picked = useRef<PickedBox | null>(null);
  const doPlace = useCallback((place: Place | null) => {
    if (placeRef?.kind !== 'insert' && placeRef?.kind !== 'accent') return;
    const kind = placeRef.kind === 'accent' ? 'accents' : 'inserts';
    // шаги одного блока подряд (тащат, жмут стрелки, ползунок) — одна правка для отмены; «как у монтажа» — своя
    edit(placeBlock(hand, kind, placeRef.at, placeRef.occurrence, place), place ? `place:${placeRef.kind}${placeRef.n}` : undefined);
  }, [placeRef, edit, hand]);
  const handleText: HandleText = useCallback((place: Place) => ({
    label: T(placeRef?.kind === 'accent' ? 'accent' : 'insert'),
    title: T(placeRef?.kind === 'accent' ? 'placeAccentT' : 'placeInsertT'),
    valueText: place.w === undefined ? T('placeAt', { x: place.x, y: place.y }) : T('placeBox', { x: place.x, y: place.y, w: place.w }),
  }), [T, placeRef]);
  const placing = useMemo(() => ({
    editable: canPlace, note: editable ? placeNote : null, onPlace: doPlace,
    size: () => { // рамка блока, когда шаблон его рисовал, — только этого блока
      const p = picked.current;
      return p && framePick && p.key === pickKey(framePick) ? { w: p.box.w, h: p.box.h, ext: p.ext } : null;
    },
  }), [canPlace, editable, placeNote, doPlace, framePick]);
  // хук и субтитры на кадре: ручка тянет их место и размер в стиле (как ползунки «Стиля» и ручки «Превью»: до монтажа —
  // общий с «Превью» выбор, после — новый стиль к «Монтировать»); титр стоит, где хук, — его место не тянется
  const movePart: TextPart | null = framePick?.kind === 'hook' || framePick?.kind === 'sub' ? framePick.kind : null;
  const styleMove: StyleMove | null = movePart && styleOpen && spec && choice ? (() => {
    const p = textPlace(spec, movePart);
    return {
      label: T(movePart === 'hook' ? 'onFrameHook' : 'onFrameSub'), title: T('onFrameT'), y: p.y, size: p.size, range: p.range,
      onMove: (y: number) => pick(placeText(choice, movePart, { y })), onSize: (size: number) => pick(placeText(choice, movePart, { size })),
    };
  })() : null;
  // текст выбранного на кадре: у какого он есть (у картинки — нет), открыт ли (после монтажа, движок его примет; карточка — свой
  // допуск) и почему нет
  const selTarget: TextTarget | null = sel?.kind === 'end' ? { kind: 'end' } : sel?.kind === 'sub' ? { kind: 'words', from: sel.from, to: sel.to }
    : selBlock?.ref && !selBlock.ghost ? blockTarget(selBlock.ref) : null;
  const selHasText = Boolean(selTarget && draft && textFields(selTarget, draft, hand).length);
  const textGate = sel?.kind === 'end' ? canCard : canText;
  const textWhy = styleLocked ? T('working') : sel?.kind === 'end' ? cardNote : textNote;
  /** Поле текста выбранного блока на кадре — рядом с `box` (где его нарисовал шаблон); у субтитров — слова группы, что на
   *  кадре сейчас (её и выбирает). Текст не правится — подпись на кадре, почему. */
  const openText = (box: Box) => {
    if (!tracks || !draft || !sel) return;
    if (!textGate) {
      if (textWhy) setFrameNote(textWhy);
      return;
    }
    let target = selTarget;
    if (sel.kind === 'sub') {
      const i = events ? eventIndexAt(events, now.current) : -1;
      const c = events && i >= 0 ? clipAt(tracks.subtitles, events[i].t0, events[i].t1) : null;
      const words = c?.ref?.kind === 'sub' ? c.ref.words : [];
      if (!words.length) return;
      target = { kind: 'words', from: words[0].t0, to: words[words.length - 1].t1 };
      setSel({ kind: 'sub', from: target.from, to: target.to });
    }
    const fields = target ? textFields(target, draft, hand) : [];
    if (!target || !fields.length) return;
    pause();
    opened.current += 1;
    const open = { target, fields, box, base: hand, seq: opened.current };
    // сразу, в том же касании: фокус полю из обработчика касания — и iPhone покажет клавиатуру
    flushSync(() => {
      setEditing(open);
      setTyping(null);
      setInlineBox(null);
      setFrameNote('');
    });
  };
  const closeText = () => {
    setEditing(null);
    setTyping(null);
    setInlineBox(null);
  };
  /** Набранное — на кадр (правки ещё нет); не поменялось — кадр как был. */
  const draftText = (values: string[]) => {
    if (editing) setTyping(applyFields(editing.base, editing.target, editing.fields, values));
  };
  /** Готово: набранное — одной правкой (без ключа — с нажатиями в полях панели не сливается, отмена — весь текст). */
  const commitText = (values: string[]) => {
    if (!editing) return;
    const next = applyFields(editing.base, editing.target, editing.fields, values);
    closeText();
    if (next) edit(next);
  };
  const cancelText = (why: string | null) => {
    closeText();
    if (why) setFrameNote(why);
  };
  useEffect(() => { // правки поменялись не с поля (другая вкладка) или текст больше не правится — поле закрыто без правки
    if (!editing || (hand === editing.base && textGate)) return;
    setEditing(null);
    setTyping(null);
    setInlineBox(null);
  }, [editing, hand, textGate]);
  const onInlineBox = useCallback((b: Box | null) => setInlineBox((was) => (b && was && sameJson(b, was) ? was : b)), []);
  /** Касание нарисованного на кадре: пауза и выбор — как щелчок по дорожке, только без перемотки (группа субтитров и акцент
   *  — что на кадре в этом событии слоя); касание уже выбранного (без ручки) — его текст. */
  const pickOnFrame = (target: FrameTarget, box: Box, ev: { t0: number; t1: number }) => {
    if (!tracks) return;
    if (playingRef.current) pause();
    let next: Selection | null = null;
    if (target.kind === 'hook' || target.kind === 'cta') next = { kind: 'block', block: target.kind, n: 0 };
    else if (target.kind === 'insert') next = { kind: 'block', block: 'insert', n: target.n };
    else if (target.kind === 'end') next = { kind: 'end' };
    else if (target.kind === 'accent') {
      const c = clipAt(tracks.text.filter((x) => x.kind === 'accent' && !x.ghost), ev.t0, ev.t1);
      if (c?.ref?.kind === 'accent') next = { kind: 'block', block: 'accent', n: c.ref.n };
    } else {
      const c = clipAt(tracks.subtitles, ev.t0, ev.t1);
      const words = c?.ref?.kind === 'sub' ? c.ref.words : [];
      if (words.length) next = { kind: 'sub', from: words[0].t0, to: words[words.length - 1].t1 };
    }
    if (!next) return;
    if (sameJson(sel, next)) openText(box);
    else setSel(next);
  };
  const frameNames = useMemo(() => ({ hook: T('hook'), cta: T('cta'), accent: T('accent'), insert: T('insert'), sub: T('subtitles'), end: T('endCard') }), [T]);
  // кусок с фильтром или переход, выбранный на дорожке «Картинка»: Delete — убрать (свой кусок — удалить; вид перехода,
  // если Павел его менял, остаётся)
  const selLook = sel?.kind === 'look' ? tracks?.looks.find((l) => sameLook(l.ref, sel.ref)) ?? null : null;
  const selTransition = sel?.kind === 'transition' ? tracks?.transitions.find((x) => sameTransition(x.ref, sel.ref)) ?? null : null;
  const selPlace = sel?.kind === 'place' ? tracks?.places.find((p) => samePlace(p.ref, sel.ref)) ?? null : null;
  const doRemovePicture = useCallback(() => {
    if (selLook && !selLook.off) {
      if ('own' in selLook.ref) {
        if (canShape) {
          edit(removeLook(hand, selLook.ref.own));
          setSel(null);
        }
      } else if (canLook) edit(setLook(hand, selLook.ref.at, true));
    }
    if (!canMarks) return;
    if (selTransition && !selTransition.off) {
      const r = selTransition.ref;
      if ('own' in r) {
        if (canFx) {
          edit(removeTransition(hand, r.own));
          setSel(null);
        }
      } else edit(setTransition(hand, r.at, { kind: selTransition.kind !== selTransition.was ? selTransition.kind as TransitionKind : undefined, off: true }));
    }
    if (selPlace && !selPlace.off && canFx) {
      const r = selPlace.ref;
      if ('own' in r) {
        edit(removePlace(hand, r.own));
        setSel(null);
      } else edit(setPlaceOff(hand, r.at, true));
    }
  }, [canMarks, canLook, canShape, canFx, selLook, selTransition, selPlace, edit, hand]);
  const doRestore = (c: { src0: number; src1: number }) => edit(restoreSpan(hand, c.src0, c.src1));
  // переставить кусок перед куском `slot`; выбранным остаётся он — на новом месте, плейхед — в его начало
  const follow = useRef<number | null>(null); // момент исходника внутри переставленного куска
  const doMove = useCallback((index: number, slot: number) => {
    if (!tracks) return;
    const m = moveTarget(tracks, index, slot);
    if (!m || !canMove) return; // правка не пройдёт — выбор не должен потом прыгнуть
    follow.current = (m.t0 + m.t1) / 2;
    edit(moveSpan(hand, m.t0, m.t1, m.before));
  }, [tracks, edit, hand, canMove]);
  useEffect(() => {
    const src = follow.current;
    if (src === null || !tracks) return;
    follow.current = null;
    const k = tracks.video.findIndex((c) => c.kind === 'piece' && src > (c.src0 as number) && src < (c.src1 as number));
    if (k < 0) return;
    setSel({ kind: 'piece', index: k });
    seekRef.current(tracks.video[k].t0);
  }, [tracks]);

  useEffect(() => { // клавиши: пробел — пуск, S — разрезать, Delete — удалить кусок или убрать блок, Ctrl+Z / Ctrl+Shift+Z — отмена и повтор
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.closest('input, textarea, select, .ed-inline') || el.isContentEditable)) return; // поле на кадре — и его ✓ и ✕
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
      if (e.code === 'Space' && !el?.closest('button:not(.ed-hit), a')) { // кнопка кадра после щелчка — фокус у неё, пробел — пуск
        e.preventDefault();
        if (playing) pause();
        else void play();
      } else if (e.code === 'KeyS' && editable) {
        e.preventDefault();
        doSplit();
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && editable && (selPiece || selBlock || selLook || selTransition || selPlace)) {
        e.preventDefault();
        if (selPiece) doDelete();
        else if (selBlock) doRemoveBlock();
        else doRemovePicture();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, play, pause, editable, doSplit, doDelete, doRemoveBlock, doRemovePicture, doUndo, doRedo, selPiece, selBlock, selLook, selTransition, selPlace]);

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
  // шкала дорожек — до конца ролика, а если Павел убрал финальную карточку — и под её тенью (её можно вернуть)
  const cardShown = Boolean(draft?.end && !hand.text?.end?.off);
  const span = full + (draft?.end && !cardShown ? draft.end.seconds : 0);
  const fitPps = span > 0 ? laneW / span : 40;
  const maxPps = span > 0 ? Math.min(400, MAX_WIDTH / span) : 400;
  const px = Math.min(maxPps, Math.max(Math.min(fitPps, 4), pps ?? fitPps));
  scale.current = px;
  useEffect(() => show(now.current), [px, show]);
  const X = (s: number) => s * px;
  const width = Math.ceil(X(span));
  const videoW = Math.ceil(X(duration)); // куски — волна голоса только под ними
  const tick = TICKS.find((s) => s * px >= 64) ?? 120;

  const onLanes = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    if (x < 0) return;
    seek(x / px);
  };

  // края кусков, куски, музыка, блоки текста и вставок — мышью или пальцем: тянем, отпустили — правка
  const [drag, setDrag] = useState<Drag | null>(null);
  const [clicks] = useState(clickGuard); // щелчок после перетаскивания — не выбор; новое нажатие — новый жест
  const grab = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    // нажатие отменено — фокус сам из поля текста на кадре не уйдёт: уводим его, и поле сохраняет набранное (или говорит,
    // почему нет) до того, как жест сменит выбор или правки
    const field = document.activeElement;
    if (field instanceof HTMLElement && field.closest('.ed-inline')) field.blur();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(d);
  };
  const dragView = (on: Tracks): DragView => ({ tracks: on, px, speed, edges, snapPx: SNAP_PX, duration, finalEdges: blockEdges });
  const onDragMove = (e: React.PointerEvent) => {
    if (!drag || !tracks) return;
    e.stopPropagation(); // ручка — внутри клипа: тот же жест не обрабатываем дважды
    setDrag(dragTo(drag, e.clientX, dragView(tracks)));
  };
  /** Блок перетащили или растянули: где он теперь в исходнике (как его прочтёт движок) — в правку. */
  const commitBlock = (d: BlockDrag) => {
    if (!tracks) return;
    const line = tracks.layer.tl;
    const ref = d.ref;
    if (ref.kind === 'hook') {
      edit(setHook(hand, { until: hookUntil(line, d.b) }));
      return;
    }
    const span = sourceSpan(line, d.a, d.b);
    if (!span) {
      setHint(T('inTeaser'));
      return;
    }
    if (span.t1 <= span.t0) { // в самом конце своей серии кусков места нет — такую правку движок не примет
      setHint(T('noRoom'));
      return;
    }
    if (ref.kind === 'cta') edit(setCta(hand, ref.at, span));
    else if (ref.kind === 'accent') edit(setBlock(hand, 'accents', ref.at, ref.occurrence, span));
    else if (ref.kind === 'insert') edit(setBlock(hand, 'inserts', ref.at, ref.occurrence, span));
  };
  /** Кусок с фильтром растянули или передвинули: где он теперь в исходнике (как его прочтёт движок) — в правку. */
  const commitLook = (d: LookDrag) => {
    if (!tracks) return;
    const span = sourceSpan(tracks.layer.tl, d.a, d.b);
    if (!span) {
      setHint(T('inTeaser'));
      return;
    }
    if (span.t1 <= span.t0) {
      setHint(T('noRoom'));
      return;
    }
    edit(setLookEdges(hand, d.ref, span.t0, span.t1));
  };
  /** Эффект разбора передвинули (поднятые субтитры — и растянули): где он теперь в исходнике — в правку. */
  const commitEffect = (d: EffectDrag) => {
    if (!tracks) return;
    const line = tracks.layer.tl;
    if (d.ref.kind === 'transition') {
      const at = sourceSpan(line, d.a, d.a);
      if (!at) {
        setHint(T('inTeaser'));
        return;
      }
      const r = d.ref.ref;
      edit('own' in r ? setOwnTransition(hand, r.own, { t: at.t0 }) : moveTransition(hand, r.at, at.t0));
      return;
    }
    const span = sourceSpan(line, d.a, d.b);
    if (!span) {
      setHint(T('inTeaser'));
      return;
    }
    if (span.t1 <= span.t0) {
      setHint(T('noRoom'));
      return;
    }
    const r = d.ref.ref;
    const p = tracks.places.find((x) => samePlace(x.ref, r));
    if (!p) return;
    edit('own' in r ? setOwnPlace(hand, r.own, { ...span, y: p.y }) : p.was ? setPlace(hand, p.was, { ...span, y: p.y }) : hand);
  };
  const onDragEnd = (e: React.PointerEvent) => {
    if (!drag || !tracks) return;
    e.stopPropagation();
    setDrag(null);
    // где отпустили — а не последний нарисованный шаг: он мог ещё не попасть на экран (lib/drag.ts)
    const released = dragTo(drag, e.clientX, dragView(tracks));
    if (released.kind === 'trim') {
      const c = tracks.video[released.index];
      if (c.piece === undefined) return;
      edit(released.side === 'start' ? trimStart(hand, keep, c.piece, released.to) : trimEnd(hand, keep, c.piece, released.to, sourceDuration));
    } else if (released.kind === 'piece') {
      if (!released.moved) { // щелчок — выбрать кусок и встать туда
        setSel({ kind: 'piece', index: released.index });
        seek(released.tf0);
        return;
      }
      clicks.dragged(); // щелчок после перетаскивания — не выбор (номер куска уже другой)
      if (released.slot !== null) doMove(released.index, released.slot);
    } else if (released.kind === 'block') {
      if (!released.moved) return; // щелчок — выбор (onClick блока)
      clicks.dragged();
      commitBlock(released);
    } else if (released.kind === 'look') {
      if (!released.moved) return; // щелчок — выбор (onClick куска)
      clicks.dragged();
      commitLook(released);
    } else if (released.kind === 'effect') {
      if (!released.moved) return; // щелчок — выбор (onClick эффекта)
      clicks.dragged();
      commitEffect(released);
    } else if (!released.moved) { // щелчок по музыке — выбрать и встать туда
      setSel({ kind: 'music' });
      const box = lanes.current?.querySelector('.ed-row.music .ed-lane')?.getBoundingClientRect();
      if (box) seek((e.clientX - box.left) / px);
    } else {
      edit(setMusic(hand, released.mode === 'move' ? { at: released.at } : { at: released.at, from: released.from }));
    }
  };
  const dragProps = { onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: () => setDrag(null) };
  // кусок тянут целиком: мышью — сразу, пальцем — выбранный (иначе палец листает дорожки)
  const grabPiece = (e: React.PointerEvent<HTMLDivElement>, index: number, picked: boolean) => {
    if (!canMove || e.button !== 0 || (e.pointerType === 'touch' && !picked)) return;
    const lane = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!lane) return;
    grab(e, { kind: 'piece', index, x0: e.clientX, tf0: (e.clientX - lane.left) / px, dx: 0, slot: null, moved: false });
  };
  // блок тянут так же: целиком (хук — только за конец), за край — растянуть; не раньше конца хука и тизера. Тянут его
  // место в речи — хвост (акцент держится после слов, вставка — не меньше 1,5 с) движок добавит сам
  const grabBlock = (e: React.PointerEvent<HTMLElement>, c: Clip, mode: BlockDrag['mode'], picked: boolean) => {
    if (!c.ref || c.ref.kind === 'sub' || e.button !== 0 || (mode === 'move' && e.pointerType === 'touch' && !picked)) return;
    const [t0, t1] = c.core ?? [c.t0, c.t1];
    grab(e, {
      kind: 'block', ref: c.ref, mode, x0: e.clientX, t0, t1, a: t0, b: t1, moved: false,
      floor: c.ref.kind === 'hook' ? 0 : room.floor, max: room.max,
    });
  };
  // кусок с фильтром тянут так же: выбранный — за край (растянуть) или целиком; копия в тизере не тянется (она — копия
  // фразы с её места), начало — не раньше конца тизера
  const lookFloor = tracks?.layer.tl.teaser ? (tracks.layer.tl.teaser[1] - tracks.layer.tl.teaser[0]) / tracks.layer.tl.speed : 0;
  const grabLook = (e: React.PointerEvent<HTMLElement>, l: Tracks['looks'][number], mode: LookDrag['mode'], picked: boolean) => {
    if (!canShape || l.off || l.teaser || e.button !== 0 || !picked) return;
    grab(e, { kind: 'look', ref: l.ref, mode, x0: e.clientX, t0: l.t0, t1: l.t1, a: l.t0, b: l.t1, moved: false, floor: lookFloor, max: duration });
  };
  // переход на дорожке «Картинка» или «Эффекты»: щелчок — выбрать и встать на его начало; выбранный разрыв или глитч на
  // дорожке «Эффекты» тянут целиком (за его стык)
  const trBlock = (x: Tracks['transitions'][number], i: number) => {
    const picked = sel?.kind === 'transition' && sameTransition(sel.ref, x.ref);
    const name = T(KIND_NAMES[x.kind as TransitionKind] ?? 'transition');
    const ref: EffectRef = { kind: 'transition', ref: x.ref };
    const dragging = drag?.kind === 'effect' && drag.ref.kind === 'transition' && sameTransition(drag.ref.ref, x.ref) && drag.moved ? drag : null;
    const shift = dragging ? dragging.a - x.t : 0;
    const movable = fxRow && FX.includes(x.kind) && !x.off;
    return (
      <div key={`t${i}`} data-kind="transition" data-at={'at' in x.ref ? x.ref.at : undefined} data-own={'own' in x.ref ? x.ref.own : undefined}
        className={`ed-clip tr ${x.kind}${x.off ? ' ghost' : ''}${picked ? ' sel' : ''}${picked && movable && canFx ? ' grab' : ''}`}
        style={{ left: X(x.t0 + shift), width: Math.max(18, X(x.t1 - x.t0)) }}
        title={`${'own' in x.ref ? T('trOwn') : T('transition')} · ${name} · ${tenths(x.t)}${x.off ? ` · ${T('removed')}` : ''}`}
        {...(movable ? { onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => grabEffect(e, ref, x.t, x.t, 'move', picked), ...dragProps } : {})}
        onClick={() => { if (clicks.click()) { setSel({ kind: 'transition', ref: x.ref }); seek(Math.max(0, x.t0)); } }}>
        <span>{name.slice(0, 1)}</span>
      </div>
    );
  };
  // эффект разбора тянут так же, выбранный: переход — целиком (его стык), поднятые субтитры — и за край; не в тизере
  const grabEffect = (e: React.PointerEvent<HTMLElement>, ref: EffectRef, t0: number, t1: number, mode: EffectDrag['mode'], picked: boolean) => {
    if (!canFx || e.button !== 0 || !picked) return;
    grab(e, { kind: 'effect', ref, mode, x0: e.clientX, t0, t1, a: t0, b: t1, moved: false, floor: lookFloor, max: duration });
  };
  // свой разрыв или глитч — на бегунке, свои поднятые субтитры — на фразу под бегунком; выбран сразу
  const doAddEffect = useCallback((what: 'tear' | 'glitch' | 'place') => {
    if (!tracks || !canFx) return;
    const line = tracks.layer.tl;
    if (what === 'place') {
      const p = phraseAt(tracks.layer.edit.words ?? [], line, now.current);
      if (!p) {
        setHint(T('noPhrase'));
        return;
      }
      const own = (hand.subPlaces ?? []).filter((f) => f.at === undefined).length;
      edit(addPlace(hand, p.t0, p.t1, tracks.places.find((x) => !x.off)?.y ?? RAISED_Y));
      setSel({ kind: 'place', ref: { own } });
      return;
    }
    const at = sourceSpan(line, now.current, now.current);
    if (!at) {
      setHint(T('inTeaser'));
      return;
    }
    const own = (hand.transitions ?? []).filter((f) => f.at === undefined).length;
    edit(addTransition(hand, at.t0, what));
    setSel({ kind: 'transition', ref: { own } });
  }, [tracks, canFx, hand, edit, T]);
  // свой кусок ч/б на фразу под бегунком (как её делят субтитры): выбран сразу — фильтр и края правятся тут же
  const doAddLook = useCallback(() => {
    if (!tracks || !canShape) return;
    const p = phraseAt(tracks.layer.edit.words ?? [], tracks.layer.tl, now.current);
    if (!p) {
      setHint(T('noPhrase'));
      return;
    }
    const own = (hand.looks ?? []).filter((f) => f.at === undefined).length;
    edit(addLook(hand, p.t0, p.t1));
    setSel({ kind: 'look', ref: { own } });
  }, [tracks, canShape, hand, edit, T]);
  // щелчок по блоку или группе субтитров — выбрать и встать на её начало (кадр её покажет)
  const pickClip = (c: Clip) => {
    if (!clicks.click()) return;
    const ref = c.ref;
    if (!ref) return;
    if (ref.kind === 'sub') setSel({ kind: 'sub', from: ref.words[0]?.t0 ?? 0, to: ref.words.at(-1)?.t1 ?? 0 });
    else setSel({ kind: 'block', block: ref.kind, n: 'n' in ref ? ref.n : 0 });
    seek(c.t0);
  };
  // куда встанет перетаскиваемый кусок (время ролика) — только если место другое
  const dropAt = drag?.kind === 'piece' && drag.slot !== null && tracks && moveTarget(tracks, drag.index, drag.slot)
    ? (drag.slot < tracks.video.length ? tracks.video[drag.slot].t0 : duration) : null;

  // крупность кадра по времени ролика (зум монтажа с силой Павла и толчки переходов) — линией на дорожке «Картинка»
  const zoomLine = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = zoomLine.current;
    if (!c || !picture) return;
    const h = 30;
    const dpr = Math.min(2, window.devicePixelRatio || 1, MAX_CANVAS / Math.max(1, videoW));
    c.width = Math.max(1, Math.round(videoW * dpr));
    c.height = h * dpr;
    c.style.width = `${videoW}px`;
    c.style.height = `${h}px`;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.strokeStyle = getComputedStyle(c).color;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = 0; x < videoW; x++) {
      const y = h - 4 - Math.min(1, Math.max(0, (picture.level(x / px) - 1) / 0.6)) * (h - 8); // 1 — низ, 1,6 — верх
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }, [picture, videoW, px]);

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
      const src = (clip.play0 ?? clip.src0 as number) + (tf - clip.t0) * speed; // с края, откуда кусок играет
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
      const src = (c.play0 ?? c.src0 as number) + (tf - c.t0) * speed;
      const fi = Math.min(film.n - 1, Math.max(0, Math.round(src / film.step)));
      const style: CSSProperties = {
        width: thumbW, backgroundImage: `url(${data.filmUrl})`, backgroundSize: `${film.n * thumbW}px ${THUMB_H}px`, backgroundPosition: `${-fi * thumbW}px 0`,
      };
      return <span key={k} className="ed-thumb" style={style} />;
    });
  };
  const sec = (s: number) => T('seconds', { n: lang === 'en' ? s.toFixed(1) : s.toFixed(1).replace('.', ',') });
  const kindName: Record<string, Key> = { hook: 'hook', accent: 'accent', cta: 'cta' };
  /** Блоки дорожки (группы субтитров, текст, вставки): идущие одновременно — друг под другом; выбранный, тени убранных,
   *  бледные — вставки, которых на кадре нет (ждут ответа, без места; перебивку на весь кадр рисует картинка); ручки
   *  краёв у тех, что можно тянуть (хук — только за конец, с тизером — никак: он стоит на всём тизере). */
  const blockRow = (clips: Clip[], cls: string, label: (c: Clip) => string) => {
    const { row, count } = stackRows(clips);
    const els = clips.map((c, i) => {
      const ref = c.ref;
      const picked = isPicked(sel, c);
      const block = ref && ref.kind !== 'sub' ? ref : null;
      const dragging = drag?.kind === 'block' && block && sameRef(drag.ref, block) && drag.moved ? drag : null;
      // место в речи и хвост после него; пока тянут — место там, куда тянут, хвост — той же длины
      const core = c.core ?? [c.t0, c.t1];
      const tailS = Math.max(0, c.t1 - core[1]);
      const a = dragging ? dragging.a : Math.min(c.t0, core[0]);
      const end = dragging ? dragging.b : core[1];
      const b = dragging ? dragging.b + tailS : Math.max(c.t1, core[1]);
      const tailW = X(b - end);
      const can = Boolean(block && canText && !c.ghost && !(block.kind === 'hook' && tl?.teaser));
      const movable = can && block?.kind !== 'hook';
      return (
        <div key={`${cls}${i}${c.ghost ? 'g' : ''}`} data-kind={ref?.kind} data-n={block && 'n' in block ? block.n : undefined}
          className={`ed-clip ${cls}${c.drawn === false && c.kind !== 'fullscreen' ? ' faint' : ''}${c.ghost ? ' ghost' : ''}${picked ? ' sel' : ''}${movable ? ' movable' : ''}${dragging ? ' dragging' : ''}`}
          style={{ left: X(a), width: Math.max(4, X(b - a)), top: 3 + row[i] * ROW_H, height: ROW_H - 4, bottom: 'auto' }}
          title={`${label(c)} · ${tenths(dragging ? a : c.t0)}–${tenths(dragging ? b : c.t1)}`}
          onClick={() => pickClip(c)}
          {...(movable ? { onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => grabBlock(e, c, 'move', picked), ...dragProps } : {})}>
          {tailW >= 1 ? <span className="ed-hold" style={{ left: X(end - a), width: tailW }} aria-hidden="true" /> : null}
          {movable ? <span className="ed-handle start" aria-hidden="true" onPointerDown={(e) => grabBlock(e, c, 'start', picked)} {...dragProps} /> : null}
          {can ? (
            <span className="ed-handle end" aria-hidden="true" style={tailW >= 1 ? { left: X(end - a) - 6, right: 'auto' } : undefined}
              onPointerDown={(e) => grabBlock(e, c, 'end', picked)} {...dragProps} />
          ) : null}
          <span>{label(c)}</span>
        </div>
      );
    });
    return { els, height: 6 + count * ROW_H };
  };
  // где стоит край куска, пока его тянут (время финала)
  const ghost = drag?.kind === 'trim' && tracks ? (() => {
    const c = tracks.video[drag.index];
    return drag.side === 'start' ? c.t0 + (drag.to - (c.src0 as number)) / speed : c.t1 + (drag.to - (c.src1 as number)) / speed;
  })() : null;
  const musicAt = drag?.kind === 'music' ? drag.at : mix?.at ?? 0;
  const voiceMuted = Boolean(hand.voice?.muted);

  // ---------- «Монтировать» ----------
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
      if (!r.ok) throw new Error(r.status !== 402 && typeof body?.error === 'string' ? body.error : statusText(r.status, 'HTTP'));
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
  const styleNote = styleLocked ? T('styleLocked') : !styleOpen && data?.draft && !data.abilities.edits ? T('styleOld')
    : mounted ? T('styleMounted') : T('styleShared');
  const frameH = Math.round((frameW * 16) / 9);
  const subRow = tracks ? blockRow(tracks.subtitles, 'sub', (c) => c.label) : null;
  const textRow = tracks ? blockRow(tracks.text, 'text', (c) => `${T(kindName[c.kind] ?? 'text')}: ${c.label}`) : null;
  // перебивка — именем клипа у Павла, а не именем ассета (upload-b1)
  const clipName = (label: string) => data?.brolls.find((b) => b.src.replace(/^.*\/|\.[^.]*$/g, '') === label)?.name ?? label;
  const insRow = tracks ? blockRow(tracks.inserts, 'ins', (c) => clipName(c.label)) : null;

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
          <div className="ed-frame-wrap">{/* поле текста на кадре — шире маленького кадра: его обрезка ему не мешает */}
            <div className="ed-frame" style={{ width: frameW, height: frameH }}>
              {tracks ? (
                <Picture clock={clock} model={picture} video={video} src={data?.proxyUrl ?? null} duration={duration} width={frameW} playing={playing}
                  clipOf={clipOf} note={T('coverUpload')}>
                  {data?.proxyUrl ? (
                    <video ref={video} src={data.proxyUrl} playsInline preload="auto" onError={onVideoError}
                      onLoadedMetadata={() => seek(now.current)} onEnded={onEnded} data-editor-video="" />
                  ) : null}
                </Picture>
              ) : null}
              {tracks ? (
                <Layer clock={clock} events={events} spec={spec} width={frameW} pick={framePick} onPlace={canPlace && placeRef ? doPlace : undefined}
                  handleText={handleText} picked={picked} styleMove={styleMove} onText={selHasText ? openText : null} canText={textGate && selHasText} textOpen={Boolean(editing)}
                  textLabel={T('editText')} names={frameNames} onTarget={pickOnFrame} lowNote={frameNote ? null : T('subLow')}
                  onBox={editing ? onInlineBox : undefined} />
              ) : null}
              {tracks ? <Bar clock={clock} spec={spec} duration={duration} width={frameW} /> : null}
              {spec && sample && frameUrl ? (
                <div className="ed-layer">
                  <PreviewFrame frameUrl={frameUrl} spec={spec} state={sample} progress={0.3} width={frameW} big />
                  <div className="ed-caption">{T('sample')}</div>
                </div>
              ) : notice ? <div className="ed-notice">{notice}</div> : null}
              {frameNote ? <div className="ed-caption at-top" role="status">{frameNote}</div> : null}
            </div>
            {editing ? (
              <InlineText key={editing.seq} T={T} fields={editing.fields} label={(f) => fieldLabel(T, f)} box={inlineBox ?? editing.box} scale={frameW / 1080}
                frameH={frameH} check={(f, v) => fieldError(T, letters, f.check, v)} onDraft={draftText} onCommit={commitText} onCancel={cancelText} />
            ) : null}
          </div>
        </section>

        <aside className="ed-side">
          {data?.screen === 'working' ? <p className="ed-note ed-flag">{mount.state === 'started' ? T('mountStarted') : T('working')}</p> : null}
          {mount.state === 'error' ? <p className="ed-note ed-flag bad" role="alert">{T('mountFailed', { e: mount.error ?? '' })}</p> : null}
          {tracks && draft && sel?.kind === 'block' ? (
            <BlockPanel T={T} sel={sel} tracks={tracks} draft={draft} hand={hand} editable={canText} note={editable ? textNote : null} onEdit={edit} sec={sec}
              letters={letters} placing={placing} brolls={gates.broll ? data?.brolls ?? [] : undefined}
              windowed={data?.abilities.tear ?? true} effects={canFx} />
          ) : null}
          {tracks && draft && sel?.kind === 'sub' ? (
            <WordsPanel T={T} sel={sel} tracks={tracks} draft={draft} hand={hand} editable={canText} note={editable ? textNote : null} onEdit={edit} sec={sec}
              letters={letters} />
          ) : null}
          {tracks && draft && sel?.kind === 'end' ? (
            <EndPanel T={T} draft={draft} hand={hand} editable={canCard} note={editable ? cardNote : null} onEdit={edit} letters={letters} />
          ) : null}
          {tracks && sel?.kind === 'place' ? (
            <PlacePick T={T} sel={sel} tracks={tracks} hand={hand} editable={canFx} note={fxNote} onEdit={edit} sec={sec} />
          ) : null}
          {tracks && (sel?.kind === 'look' || sel?.kind === 'transition') ? (
            <PicturePick T={T} sel={sel} tracks={tracks} hand={hand}
              editable={sel.kind === 'look' ? canLook : 'own' in sel.ref ? canFx : canMarks} shape={canShape}
              tear={data?.abilities.tear ?? true} effects={fxRow}
              note={editable ? (sel.kind === 'look' && canLook ? null : pictureNote) : null} onEdit={edit} sec={sec} />
          ) : null}
          {tracks ? (
            <Inspector T={T} sel={sel} tracks={tracks} hand={hand} mix={mix} editable={editable} canMove={canMove} splitHere={splitHere} videos={videos}
              onSplit={doSplit} onDelete={doDelete} onMove={doMove} onEdit={edit} sec={sec}
              music={{ library: data?.library ?? [], session: data?.draft?.music?.file ?? null, beats: data?.beats?.file ?? null, canTrack,
                note: trackNote }} />
          ) : null}
          {hint ? <p className="ed-note ed-flag bad" role="status">{hint}</p> : null}
          {data?.draft && editable && !data.abilities.move ? <p className="ed-note faint">{T('moveOld')}</p> : null}
          {data?.draft && !data.abilities.edits ? <p className="ed-note ed-flag">{T('editsOld')}</p> : null}
          {styles && choice ? (
            <StylePanel T={T} styles={styles} choice={choice} spec={spec} offered={offered} locked={!styleOpen} note={styleNote} onPick={pick} />
          ) : null}
          {tracks && fxRow ? <EffectsSection T={T} tracks={tracks} onAdd={canFx ? doAddEffect : null} note={fxNote} /> : null}
          {tracks ? (
            <PictureSection T={T} tracks={tracks} hand={hand} dim={draft?.dim ?? 0} canZoom={canZoom} canDim={canMarks} note={editable ? pictureNote : null}
              onEdit={edit} onAddLook={canShape ? doAddLook : null} />
          ) : null}
          {tracks && draft ? (
            <VideoSection T={T} hand={hand} speed={draft.speed} teaser={Boolean(draft.teaser)} canSpeed={canSpeed} canTeaser={canTeaser}
              note={videoNote} teaserNote={editable && !mounted ? T('teaserAfterMount') : null} onEdit={edit}
              num={(x) => (lang === 'en' ? x.toFixed(2) : x.toFixed(2).replace('.', ','))} />
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
          <span className="mono ed-clock"><span ref={clockText}>{tenths(t)}</span> / {tenths(full)}</span>
          <span className="ed-sep" />
          <button type="button" className="ed-icon" aria-label={T('undo')} title={T('undoT')} onClick={doUndo} disabled={!editable || !hist.past.length}><UndoIcon /></button>
          <button type="button" className="ed-icon" aria-label={T('redo')} title={T('redoT')} onClick={doRedo} disabled={!editable || !hist.future.length}><RedoIcon /></button>
          <button type="button" className="ed-tool" aria-label={T('split')} title={T('splitT')} onClick={doSplit} disabled={!editable || splitSrc === null}>
            <ScissorsIcon /><span>{T('split')}</span>
          </button>
          <button type="button" className="ed-tool" aria-label={T('delete')} title={T('deleteT')} onClick={() => (selPiece ? doDelete() : doRemoveBlock())}
            disabled={!editable || !((selPiece && selPiece.kind === 'piece') || (selBlock && !selBlock.ghost && canText))}>
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
        <div className="ed-scroll" ref={lanes} onPointerDownCapture={clicks.down}>
          {tracks && subRow && textRow && insRow ? (
            <div className="ed-inner" style={{ width: HEAD + width + 24 }}>
              <div className="ed-ruler" style={{ marginLeft: HEAD, width }} onPointerDown={onLanes}>
                {Array.from({ length: Math.floor(span / tick) + 1 }, (_, k) => (
                  <span key={k} style={{ left: X(k * tick) }}>{tenths(k * tick).replace(/\.0$/, '')}</span>
                ))}
              </div>
              <Row name={T('video')} cls="video" width={width} onSeek={onLanes}>
                {tracks.video.map((c, i) => {
                  const picked = sel?.kind === 'piece' && sel.index === i;
                  const movable = canMove && c.kind === 'piece';
                  const dragging = drag?.kind === 'piece' && drag.index === i && drag.moved;
                  return (
                    <div key={`${c.src0}-${c.src1}`}
                      className={`ed-clip ed-piece${c.kind === 'teaser' ? ' teaser' : ''}${picked ? ' sel' : ''}${movable ? ' movable' : ''}${dragging ? ' dragging' : ''}`}
                      style={{ left: X(c.t0), width: Math.max(2, X(c.t1 - c.t0)), ...(dragging ? { transform: `translateX(${drag.dx}px)` } : {}) }}
                      onClick={() => clicks.click() && setSel({ kind: 'piece', index: i })}
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
                {tracks.looks.filter((c) => !c.off).map((c, i) => <div key={`l${i}`} className={`ed-look ${c.look}`} style={{ left: X(c.t0), width: Math.max(2, X(c.t1 - c.t0)) }} title={T(LOOK_NAMES[c.look as keyof typeof LOOK_NAMES] ?? 'bw')} />)}
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
                {tracks.tail > 0 ? ( // стоп-кадр и карточка: щелчок — панель карточки (убранная — тенью дальше)
                  <div className={`ed-tail${cardShown ? ' endcard' : ''}${cardShown && sel?.kind === 'end' ? ' sel' : ''}`}
                    style={{ left: X(duration), width: Math.max(2, X(tracks.tail)) }} title={`${T(cardShown ? 'tail' : 'still')} · ${sec(tracks.tail)}`}
                    onClick={() => { if (cardShown && clicks.click()) setSel({ kind: 'end' }); }}>
                    <span>{T(cardShown ? 'tail' : 'still')}</span>
                  </div>
                ) : null}
                {draft?.end && hand.text?.end?.off ? ( // убранная карточка — тенью после стоп-кадра: её можно вернуть
                  <div className={`ed-tail endcard ghost${sel?.kind === 'end' ? ' sel' : ''}`} data-kind="end"
                    style={{ left: X(duration + tracks.tail), width: Math.max(8, X(draft.end.seconds)) }} title={`${T('endCard')} · ${T('removed')}`}
                    onClick={() => { if (clicks.click()) setSel({ kind: 'end' }); }}>
                    <span>{T('endCard')}</span>
                  </div>
                ) : null}
              </Row>
              <Row name={T('picture')} cls="pic" width={width} onSeek={onLanes}>
                <canvas ref={zoomLine} className="ed-zoomline" aria-hidden="true" />
                {tracks.looks.map((l, i) => {
                  const picked = sel?.kind === 'look' && sameLook(sel.ref, l.ref);
                  const dragging = drag?.kind === 'look' && sameLook(drag.ref, l.ref) && drag.moved && !l.teaser ? drag : null;
                  const [a, b] = dragging ? [dragging.a, dragging.b] : [l.t0, l.t1];
                  const handles = picked && canShape && !l.off && !l.teaser;
                  const name = T(LOOK_NAMES[l.look as keyof typeof LOOK_NAMES] ?? 'bw');
                  return (
                    <div key={`l${i}`} data-kind="look" data-look={l.look} data-own={'own' in l.ref ? l.ref.own : undefined}
                      data-at={'at' in l.ref ? `${l.ref.at[0]}-${l.ref.at[1]}` : undefined}
                      className={`ed-clip look ${l.look}${l.off ? ' ghost' : ''}${picked ? ' sel' : ''}${handles ? ' grab' : ''}`}
                      style={{ left: X(a), width: Math.max(8, X(b - a)) }}
                      title={`${'own' in l.ref ? T('lookOwn') : T('look')} · ${name} · ${tenths(a)}–${tenths(b)}${l.off ? ` · ${T('removed')}` : ''}`}
                      onPointerDown={(e) => grabLook(e, l, 'move', picked)} {...dragProps}
                      onClick={() => { if (clicks.click()) { setSel({ kind: 'look', ref: l.ref }); seek(l.t0); } }}>
                      {handles ? <span className="ed-handle start" aria-hidden="true" onPointerDown={(e) => grabLook(e, l, 'start', picked)} {...dragProps} /> : null}
                      <span>{name}</span>
                      {handles ? <span className="ed-handle end" aria-hidden="true" onPointerDown={(e) => grabLook(e, l, 'end', picked)} {...dragProps} /> : null}
                    </div>
                  );
                })}
                {tracks.transitions.filter((x) => !fxRow || !FX.includes(x.kind)).map(trBlock)}
                {!tracks.looks.length && !tracks.transitions.some((x) => !fxRow || !FX.includes(x.kind)) ? <span className="ed-empty">{T('noPicture')}</span> : null}
              </Row>
              {fxRow ? (
                <Row name={T('effects')} cls="fx" width={width} onSeek={onLanes}>
                  {tracks.places.map((p, i) => {
                    const picked = sel?.kind === 'place' && samePlace(sel.ref, p.ref);
                    const dragging = drag?.kind === 'effect' && drag.ref.kind === 'place' && samePlace(drag.ref.ref, p.ref) && drag.moved ? drag : null;
                    const [a, b] = dragging ? [dragging.a, dragging.b] : [p.t0, p.t1];
                    const handles = picked && canFx && !p.off;
                    const ref: EffectRef = { kind: 'place', ref: p.ref };
                    return (
                      <div key={`p${i}`} data-kind="place" data-own={'own' in p.ref ? p.ref.own : undefined}
                        data-at={'at' in p.ref ? `${p.ref.at[0]}-${p.ref.at[1]}` : undefined}
                        className={`ed-clip place${p.off ? ' ghost' : ''}${picked ? ' sel' : ''}${handles ? ' grab' : ''}`}
                        style={{ left: X(a), width: Math.max(8, X(b - a)) }}
                        title={`${'own' in p.ref ? T('fxPlaceOwn') : T('fxPlaceName')} · ${tenths(p.src[0])}–${tenths(p.src[1])} · y ${p.y}${p.off ? ` · ${T('removed')}` : ''}`}
                        onPointerDown={(e) => grabEffect(e, ref, p.t0, p.t1, 'move', picked)} {...dragProps}
                        onClick={() => { if (clicks.click()) { setSel({ kind: 'place', ref: p.ref }); seek(p.t0); } }}>
                        {handles ? <span className="ed-handle start" aria-hidden="true" onPointerDown={(e) => grabEffect(e, ref, p.t0, p.t1, 'start', picked)} {...dragProps} /> : null}
                        <span>↑ {p.y}</span>
                        {handles ? <span className="ed-handle end" aria-hidden="true" onPointerDown={(e) => grabEffect(e, ref, p.t0, p.t1, 'end', picked)} {...dragProps} /> : null}
                      </div>
                    );
                  })}
                  {tracks.transitions.filter((x) => FX.includes(x.kind)).map(trBlock)}
                  {!tracks.places.length && !tracks.transitions.some((x) => FX.includes(x.kind)) ? <span className="ed-empty">{T('fxNone')}</span> : null}
                </Row>
              ) : null}
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
                ) : canTrack && data?.library.length ? (
                  <button type="button" className="ed-add" onPointerDown={(e) => e.stopPropagation()} onClick={() => setSel({ kind: 'music' })}>{T('addMusic')}</button>
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
              <Row name={T('subtitles')} cls="sub" width={width} height={subRow.height} onSeek={onLanes}>{subRow.els}</Row>
              <Row name={T('text')} cls="text" width={width} height={textRow.height} onSeek={onLanes}>{textRow.els}</Row>
              <Row name={T('inserts')} cls="ins" width={width} height={insRow.height} onSeek={onLanes}>{insRow.els}</Row>
              <div className="ed-playhead" ref={playhead} aria-hidden="true" />
            </div>
          ) : <div className="ed-empty pad">{notice}</div>}
        </div>
      </section>
    </div>
  );
}

function Row({ name, cls, width, height, onSeek, tool, children }: {
  name: string; cls: string; width: number; height?: number; onSeek: (e: React.PointerEvent<HTMLDivElement>) => void; tool?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`ed-row ${cls}`}>
      <div className="ed-head"><span>{name}</span>{tool}</div>
      <div className="ed-lane" style={{ width, ...(height ? { height } : {}) }} onPointerDown={onSeek}>{children}</div>
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
