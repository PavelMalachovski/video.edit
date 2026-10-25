'use client';
// Экран «1 · Загрузка»: видео (одно или несколько — склеятся по порядку), ТЗ, вставки и озвучка → черновик job-<id>
// кусками → manifest.json → запуск анализа. Незаконченная загрузка помнится в localStorage: после перезагрузки те же
// файлы продолжают с недостающих кусков.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { errorText, message, post, storage } from '@/lib/client.ts';
import { bytes, mmss } from '@/lib/format.ts';
import {
  checkBroll, checkInsert, checkSources, checkTotal, checkVoice, INSERT_TYPES, isBrollFile, LONG_VIDEO_SEC, MAX_BRIEF, MAX_BROLL, MAX_INSERTS,
  MAX_VIDEOS, uploadAssetName, VOICE_EXT,
  videoAsset, voiceAssetName,
} from '@/lib/jobs.ts';
import {
  clearPending, loadPending, matchPending, planChunks, resumeDone, runUpload, sameSelection, savePending, sentVideos, type Pending,
  type PendingInsert,
} from '@/lib/uploader.ts';
import { keepScreenOn } from '@/lib/wakelock.ts';
import { takeNextBrief } from '@/lib/script.ts';
import { CloseIcon, FilmIcon, ImageIcon, MicIcon, PlayIcon, PlusIcon, RefreshIcon, UploadIcon, UpIcon } from './icons';
import { JOBS_CHANGED } from './jobs-list';
import { dropShrunk, shrinkVideo } from './shrink';

const BRIEF_HINT = 'ХУК: Как я учу чешский\nКОДОВОЕ СЛОВО: чешский\nМУЗЫКА: lofi\nКогда говорю «приложение» — покажи логотип\nНа «вот так это выглядит» — фуллскрин демо';

type Phase = 'idle' | 'shrinking' | 'uploading' | 'completing' | 'launching' | 'failed' | 'launch_failed';
// files: ассеты видео (source, source-2…), вставок и озвучки → выбранные файлы; send — видео, уменьшенные в браузере
// (что уходит в черновик вместо выбранного файла)
type Active = { p: Pending; files: Map<string, File>; send: Map<string, File> };
type Video = { asset: string; file: File; expect?: number }; // expect — размер копии из незаконченной загрузки

/** Длительность по метаданным `<video>`; не узнал за 5 с (или файл не читается) — null. */
function videoDuration(file: File, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let settled = false;
    const finish = (d: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(d);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => finish(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    v.onerror = () => finish(null);
    v.src = url;
  });
}


// тот же файл — имя и размер: iPhone при повторном выборе отдаёт свежую копию с новым временем изменения
const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size;

function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <span className="thumb">
      {url ? <img src={url} alt="" /> : <PlayIcon />}
    </span>
  );
}

export default function Uploader() {
  const router = useRouter();
  const [sources, setSources] = useState<File[]>([]); // видео по порядку: склеятся в один исходник
  const [durations, setDurations] = useState<Map<File, number | null>>(new Map()); // нет файла — ещё смотрю
  const [brief, setBrief] = useState('');
  const [inserts, setInserts] = useState<File[]>([]);
  const [brolls, setBrolls] = useState<File[]>([]); // перебивки — свои клипы поверх говорящей головы (ставит Claude)
  const [brollError, setBrollError] = useState('');
  const [insertError, setInsertError] = useState('');
  const [voice, setVoice] = useState<File | null>(null); // озвучка — своя запись голоса вместо звука видео
  const [voiceError, setVoiceError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [sent, setSent] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [original, setOriginal] = useState(false); // галочка «загрузить оригинал»: без уменьшения в браузере
  const [shrinkNote, setShrinkNote] = useState('');
  const briefRef = useRef('');
  const active = useRef<Active | null>(null);
  const launched = useRef<string | null>(null);

  useEffect(() => {
    const p = loadPending(storage());
    const next = p ? null : takeNextBrief(storage()); // ТЗ от «Снять по сценарию» — если не продолжаем загрузку
    const text = p?.brief ?? next;
    if (p) setPending(p);
    if (text === null || text === undefined) return;
    setBrief(text);
    briefRef.current = text;
  }, []);

  const busy = phase === 'shrinking' || phase === 'uploading' || phase === 'completing' || phase === 'launching';
  const source = sources[0] ?? null;
  // вставки и перебивки в незаконченной загрузке — одним списком (различает имя ассета: upload-i… / upload-b…)
  const extras = useMemo(() => [...inserts, ...brolls], [inserts, brolls]);
  const match = useMemo(() => (pending && sources.length && !busy ? matchPending(pending, sources, extras, voice) : null), [pending, sources, extras, voice, busy]);
  const sourceError = sources.length ? checkSources(sources.map((f) => f.size)) : null;
  // перебивки здесь не в счёт: 4K-клипы браузер уменьшит — их размер проверяется после уменьшения (startNew)
  const totalError = source ? checkTotal(source.size, [...sources.slice(1), ...inserts, ...(voice ? [voice] : [])].map((f) => f.size)) : null;
  const measuring = sources.some((f) => !durations.has(f));
  // длина всех видео вместе; хоть одно не узнал — неизвестна
  const duration = measuring ? undefined : sources.every((f) => typeof durations.get(f) === 'number')
    ? sources.reduce((sum, f) => sum + (durations.get(f) as number), 0) : null;
  const canStart = !!source && !sourceError && !totalError && !busy && !measuring;
  const label = sources.length > 1 ? `${sources[0].name} + ${sources.length - 1}` : source?.name ?? '';

  /** Ещё видео — в конец списка (то же второй раз не берётся); длительность каждого смотрим сразу. */
  function addSources(list: FileList | null) {
    const picked = (list ? [...list] : []).filter((f) => !sources.some((x) => sameFile(x, f)));
    if (!picked.length) return;
    setSources([...sources, ...picked]);
    setError('');
    setShrinkNote('');
    setPhase('idle');
    for (const f of picked) void videoDuration(f).then((d) => setDurations((m) => new Map(m).set(f, d)));
  }

  function moveUp(k: number) {
    setSources(sources.map((f, i) => (i === k - 1 ? sources[k] : i === k ? sources[k - 1] : f)));
  }

  function addInserts(list: FileList | null) {
    const next = [...inserts];
    const problems: string[] = [];
    for (const f of list ? [...list] : []) {
      const why = checkInsert(f);
      if (why) problems.push(why);
      else if (next.some((x) => sameFile(x, f))) continue;
      else if (next.length >= MAX_INSERTS) {
        problems.push(`Не больше ${MAX_INSERTS} вставок`);
        break;
      } else next.push(f);
    }
    setInserts(next);
    setInsertError(problems.join('\n'));
  }

  function addBrolls(list: FileList | null) {
    const next = [...brolls];
    const problems: string[] = [];
    for (const f of list ? [...list] : []) {
      const why = checkBroll(f);
      if (why) problems.push(why);
      else if (next.some((x) => sameFile(x, f))) continue;
      else if (next.length >= MAX_BROLL) {
        problems.push(`Не больше ${MAX_BROLL} перебивок`);
        break;
      } else next.push(f);
    }
    setBrolls(next);
    setBrollError(problems.join('\n'));
  }

  function pickVoice(f: File | null) {
    if (!f) return; // выбор отменили — прежняя запись остаётся
    const why = checkVoice(f);
    setVoiceError(why ?? '');
    if (!why) setVoice(f);
  }

  function changeBrief(text: string) {
    setBrief(text);
    briefRef.current = text;
    if (active.current) {  // ТЗ можно дописывать, пока идёт загрузка: уходит в manifest.json в конце
      active.current = { ...active.current, p: { ...active.current.p, brief: text } };
      savePending(storage(), active.current.p);
    }
  }

  /** Новая задача: черновик, затем все куски. */
  async function startNew() {
    if (!source || !canStart) return;
    setError('');
    try {
      // новая загрузка заменит незаконченную; дождаться: тот же файл ужмётся в то же место
      if (pending) await dropShrunk([pending.source, ...(pending.more ?? []), ...pending.inserts]);
      const clips: PendingInsert[] = brolls.map((f, k) => ({ asset: uploadAssetName('b', k + 1, f.name, f.type), name: f.name, size: f.size, type: f.type, lastModified: f.lastModified }));
      // видео задачи и видео-перебивки — уменьшаются одной очередью; картинки-перебивки — как есть
      const send = await shrink([...sources.map((f, k) => ({ asset: videoAsset(k), file: f })),
        ...clips.flatMap((c, k) => (brolls[k].type.startsWith('video/') ? [{ asset: c.asset, file: brolls[k] }] : []))], original);
      setPhase('uploading');
      const sent = sources.map((f, k) => send.get(videoAsset(k)) ?? f);
      const size = sent.reduce((sum, f) => sum + f.size, 0);
      const clipSizes = clips.map((c, k) => send.get(c.asset)?.size ?? brolls[k].size);
      const tooMuch = checkTotal(sent[0].size, [...sent.slice(1), ...inserts, ...(voice ? [voice] : [])].map((f) => f.size).concat(clipSizes));
      if (tooMuch) throw new Error(brolls.length ? `${tooMuch} Перебивки тоже в счёт — уберите часть.` : tooMuch);
      const r = await post('/api/jobs', { name: label, size, type: sent[0].type });
      if (!r.ok) throw new Error(await errorText(r, 'Задача не создалась'));
      const { jobId, releaseId } = (await r.json()) as { jobId: string; releaseId: number };
      window.dispatchEvent(new Event(JOBS_CHANGED));
      const list: PendingInsert[] = [
        ...inserts.map((f, k) => ({ asset: uploadAssetName('i', k + 1, f.name, f.type), name: f.name, size: f.size, type: f.type, lastModified: f.lastModified })),
        ...clips.map((c) => ({ ...c, ...(send.has(c.asset) ? { shrunk: send.get(c.asset)!.size } : {}) })),
      ];
      const said = voice ? { asset: voiceAssetName(voice.name, voice.type), name: voice.name, size: voice.size, type: voice.type, lastModified: voice.lastModified } : undefined;
      const shrunk = (asset: string) => (send.has(asset) ? { shrunk: send.get(asset)!.size } : {});
      const more: PendingInsert[] = sources.slice(1).map((f, k) => ({
        asset: videoAsset(k + 1), name: f.name, size: f.size, type: f.type, lastModified: f.lastModified, ...shrunk(videoAsset(k + 1)),
      }));
      const p: Pending = {
        jobId, releaseId, source: { name: source.name, size: source.size, lastModified: source.lastModified, ...shrunk('source') },
        brief: briefRef.current, duration: duration ?? null,
        inserts: list, voice: said, ...(more.length ? { more } : {}),
      };
      const files = new Map<string, File>([...sources.map((f, k) => [videoAsset(k), f] as [string, File]), ...list.map((i, k) => [i.asset, extras[k]] as [string, File])]);
      if (said && voice) files.set(said.asset, voice);
      await upload({ p, files, send }, new Set());
    } catch (e) {
      setError(message(e));
      setPhase('failed');
    }
  }

  /** Те же видео после перезагрузки: заново выбранные вставки — те же ассеты, новые — следующие номера; та же
   *  озвучка — тот же ассет, другая — следующий номер (куски прежней остались в черновике). */
  async function resume() {
    if (!pending || !sources.length || !match?.ok) return;
    const kept = pending.inserts.filter((i) => match.inserts.has(i.asset));
    const reused = new Set(match.inserts.values());
    // новые вставки и перебивки — следующими номерами своего вида (у вставок i, у перебивок b)
    const number = (kind: 'i' | 'b', files: File[]) => {
      let n = Math.max(0, ...pending.inserts.map((i) => Number(new RegExp(`^upload-${kind}(\\d+)`).exec(i.asset)?.[1] ?? 0)));
      return files.filter((f) => !reused.has(f)).map((f) => ({ f, a: { asset: uploadAssetName(kind, ++n, f.name, f.type), name: f.name, size: f.size, type: f.type, lastModified: f.lastModified } }));
    };
    const fresh = [...number('i', inserts), ...number('b', brolls)];
    const added: PendingInsert[] = fresh.map((x) => x.a);
    const last = pending.voice ? Number(/^upload-voice-(\d+)/.exec(pending.voice.asset)?.[1] ?? 1) : 0;
    const said = match.voice ? pending.voice : voice
      ? { asset: voiceAssetName(voice.name, voice.type, last + 1), name: voice.name, size: voice.size, type: voice.type, lastModified: voice.lastModified } : undefined;
    const p: Pending = { ...pending, brief: briefRef.current, duration: duration ?? pending.duration, inserts: [...kept, ...added], voice: said };
    const files = new Map<string, File>([...match.videos, ...match.inserts, ...fresh.map((x) => [x.a.asset, x.f] as [string, File])]);
    setSources([...match.videos.values()]); // видео — в порядке задачи, даже если выбраны заново в другом
    if (said && voice) files.set(said.asset, voice);
    setError('');
    try {
      // уменьшенные в прошлый раз — та же копия (из хранилища браузера или сжатая заново); ушёл оригинал — оригинал
      const was = new Map([['source', pending.source.shrunk], ...[...(pending.more ?? []), ...kept].map((v) => [v.asset, v.shrunk] as const)]);
      const again = [...match.videos, ...match.inserts].flatMap(([asset, file]) => (was.get(asset) ? [{ asset, file, expect: was.get(asset) }] : []));
      // новые перебивки-видео — уменьшаются, как при новой загрузке
      const clips = fresh.filter((x) => isBrollFile(x.a.asset) && x.f.type.startsWith('video/')).map((x) => ({ asset: x.a.asset, file: x.f }));
      const send = await shrink([...again, ...clips], false);
      const lost = again.find((v) => send.get(v.asset)?.size !== v.expect);
      if (lost) throw new Error(`Уменьшенная копия ${lost.file.name} не сохранилась в браузере — нажмите «Забыть» и загрузите заново`);
      p.inserts = p.inserts.map((i) => (send.has(i.asset) && !i.shrunk ? { ...i, shrunk: send.get(i.asset)!.size } : i));
      await upload({ p, files, send }, null);
    } catch (e) {
      setError(message(e));
      setPhase('failed');
    }
  }

  /** Уменьшить видео по очереди (прогресс — общей полосой); какие ушли оригиналом и почему — заметкой под списком.
   *  `asked` — галочка «загрузить оригинал». → ассет → уменьшенный файл. */
  async function shrink(videos: Video[], asked: boolean): Promise<Map<string, File>> {
    const send = new Map<string, File>();
    if (!videos.length) return send;
    setPhase('shrinking');
    setShrinkNote('');
    setTotal(videos.length);
    setSent(0);
    const notes: string[] = [];
    const release = keepScreenOn(navigator as Parameters<typeof keepScreenOn>[0], document); // телефон не уснёт посреди сжатия
    try {
      for (const [k, v] of videos.entries()) {
        const r = await shrinkVideo(v.file, { asked, expect: v.expect, onProgress: (done) => setSent(k + done) });
        if ('file' in r) send.set(v.asset, r.file);
        else if (!r.quiet) notes.push(`${v.file.name} — оригинал: ${r.original}`);
        setSent(k + 1);
      }
    } finally {
      release();
    }
    setShrinkNote(notes.join('\n'));
    return send;
  }

  /** Куски (`known` — уже готовые; null — спросить черновик), проверка → manifest.json, запуск анализа. */
  async function upload(a: Active, known: Set<number> | null) {
    active.current = a;
    savePending(storage(), a.p);
    setPending(a.p);
    setError('');
    setPhase('uploading');
    const release = keepScreenOn(navigator as Parameters<typeof keepScreenOn>[0], document); // экран не гаснет до конца загрузки
    const { p, files, send } = a;
    const out = (asset: string) => send.get(asset) ?? files.get(asset)!; // что уходит в черновик: уменьшенное или выбранное
    try {
      const videos = sentVideos(p); // видео по порядку (уменьшенные — своим размером), потом вставки и озвучка
      const extra = [...p.inserts, ...(p.voice ? [p.voice] : [])];
      const chunks = planChunks([...videos, ...extra.map((i) => ({ asset: i.asset, size: i.shrunk ?? i.size }))]);
      let done = known;
      if (!done) {
        const r = await fetch(`/api/jobs/${p.jobId}/parts?release=${p.releaseId}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(await errorText(r, 'Не узнал, что уже загружено'));
        done = resumeDone(chunks, (await r.json()) as { name: string; size: number }[]);
      }
      let got = [...done].reduce((s, i) => s + chunks[i].end - chunks[i].start, 0);
      setTotal(chunks.reduce((s, c) => s + c.end - c.start, 0));
      setSent(got);
      await runUpload({
        parts: chunks.length,
        done,
        concurrency: 4, // кусок идёт ~4 с туда и обратно: при 2 запросах — 2 МБ/с (задачи 23.10)
        minGapMs: 750, // не чаще 80 стартов в минуту — вторичный лимит GitHub на создание ассетов
        put: async (i) => {
          const c = chunks[i];
          const file = c.file === 'source' ? '' : `&file=${encodeURIComponent(c.file)}`; // source — как раньше, без file
          const r = await fetch(`/api/jobs/${p.jobId}/parts/${c.index}?release=${p.releaseId}${file}`, {
            method: 'PUT', body: out(c.file).slice(c.start, c.end), headers: { 'Content-Type': 'application/octet-stream' },
          });
          if (!r.ok) return { ok: false, status: r.status };
          got += c.end - c.start;
          setSent(got);
          return { ok: true };
        },
      });
      setPhase('completing');
      const partsOf = (asset: string) => chunks.filter((c) => c.file === asset).length;
      const first = { asset: 'source', name: p.source.name, size: p.source.shrunk ?? p.source.size, type: out('source').type, lastModified: p.source.lastModified };
      const all = [first, ...(p.more ?? [])].map(({ asset, name, size, lastModified, ...v }) => {
        const d = durations.get(files.get(asset)!);
        return { asset, name, size: 'shrunk' in v ? v.shrunk ?? size : size, type: out(asset).type, lastModified, parts: partsOf(asset),
          duration: typeof d === 'number' ? d : null };
      });
      const c = await post(`/api/jobs/${p.jobId}/complete`, {
        releaseId: p.releaseId, name: first.name, size: first.size, type: first.type, lastModified: first.lastModified,
        parts: partsOf('source'), userAgent: navigator.userAgent, brief: briefRef.current.trim(), duration: p.duration,
        uploads: extra.map((i) => ({ asset: i.asset, name: i.name, size: i.shrunk ?? i.size, type: out(i.asset).type, parts: partsOf(i.asset) })),
        ...(all.length > 1 ? { videos: all } : {}),
      });
      if (!c.ok) throw new Error(await errorText(c, 'Проверка загрузки не прошла'));
      clearPending(storage()); // всё в черновике — продолжать больше нечего, запуск повторяется и со страницы задачи
      setPending(null);
      void dropShrunk([...send.keys()].map((asset) => files.get(asset)!)); // копии в хранилище браузера больше не нужны
    } catch (e) {
      setError(message(e));
      setPhase('failed');
      return;
    } finally {
      release();
    }
    await launch(p.jobId);
  }

  /** Запуск анализа. 409 — анализ уже запускали: сорвался — повтор шага, идёт — дальше страница задачи. */
  async function launch(id: string) {
    launched.current = id;
    setError('');
    setPhase('launching');
    try {
      let r = await post(`/api/jobs/${id}/run`, { action: 'start' });
      if (r.status === 409) {
        const got = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
        const view = got.ok ? ((await got.json()) as { view: { screen: string; stuck: string | null } }).view : null;
        if (view && (view.screen === 'error' || view.stuck)) r = await post(`/api/jobs/${id}/run`, { action: 'retry' });
        else if (view && view.screen !== 'not_started' && view.screen !== 'uploading') r = new Response('{}');
      }
      if (!r.ok) throw new Error(await errorText(r, 'Claude не запустился'));
      active.current = null;
      router.push(`/jobs/${id}`);
    } catch (e) {
      setError(message(e));
      setPhase('launch_failed');
    }
  }

  function forget() {
    if (pending) void dropShrunk([pending.source, ...(pending.more ?? [])]);
    clearPending(storage());
    setPending(null);
  }

  const pct = total ? Math.floor((100 * sent) / total) : 0;
  // после сбоя — как была, если вставки и озвучка те же; поменяли — заново собранной загрузкой (resume)
  // в заметке о незаконченной загрузке — как в списке задач: первое видео и сколько ещё
  const pendingName = (p: Pending) => (p.more?.length ? `${p.source.name} + ${p.more.length}` : p.source.name);
  const resumable = phase === 'failed' && active.current !== null && sameSelection(active.current.files, extras, voice, sources);
  const long = typeof duration === 'number' && duration > LONG_VIDEO_SEC;

  return (
    <>
      {pending && !busy && phase !== 'failed' ? (
        <div className="card note">
          <div>{match?.ok ? <>Продолжаю загрузку <b>{pendingName(pending)}</b>: недостающие куски дошлю.</>
            : <>Загрузка <b>{pendingName(pending)}</b> не закончена: {pending.more?.length ? 'выберите те же видео' : 'выберите тот же файл'}.</>}</div>
          {match?.ok && match.dropped.length ? <div className="muted">Не выбраны заново и не войдут: {match.dropped.join(', ')}</div> : null}
          <button type="button" className="btn ghost" onClick={forget}>Забыть</button>
        </div>
      ) : null}

      <section className="card" aria-labelledby="new-project">
        <div className="panel-head">
          <h2 id="new-project">Новый проект</h2>
          <span className="mono muted small">до 3 ГБ</span>
        </div>
        <label className={`pick${busy || sources.length >= MAX_VIDEOS ? ' off' : ''}`}>
          <span className="pick-icon"><PlusIcon size={26} /></span>
          <span className="pick-title">{source ? 'Добавить видео' : 'Выбрать видео'}</span>
          <span className="pick-hint">{source ? 'склею по порядку списка' : 'из галереи телефона — можно несколько'}</span>
          <input id="source" type="file" multiple accept="video/*,.mov,.mp4" disabled={busy || sources.length >= MAX_VIDEOS} hidden
            onChange={(e) => { addSources(e.target.files); e.target.value = ''; }} />
        </label>
        {source ? (
          <div className="media">
            {sources.map((f, k) => {
              const d = durations.get(f);
              return (
                <div className="media-row" key={`${f.name}:${f.size}:${f.lastModified}`}>
                  <span className="media-icon"><FilmIcon /></span>
                  <div className="grow media-name">
                    <b className="name">{sources.length > 1 ? `${k + 1}. ` : ''}{f.name}</b>
                    <span className="mono muted small">{bytes(f.size)}{typeof d === 'number' ? ` · ${mmss(d)}` : ''}</span>
                  </div>
                  {sources.length > 1 && k > 0 ? (
                    <button type="button" className="icon" aria-label={`${f.name} — раньше`} disabled={busy} onClick={() => moveUp(k)}><UpIcon /></button>
                  ) : null}
                  <button type="button" className="icon" aria-label={`Убрать ${f.name}`} disabled={busy}
                    onClick={() => setSources(sources.filter((_, i) => i !== k))}>
                    <CloseIcon />
                  </button>
                </div>
              );
            })}
            {sources.length > 1 && typeof duration === 'number' ? <div className="muted small mono">Вместе {mmss(duration)}</div> : null}
            {measuring ? <div className="muted small">Смотрю видео…</div> : null}
            {long ? <div className="warn small">Ролик длиннее 5 минут — монтаж может не уложиться.</div> : null}
            {sourceError ? <div className="err small">{sourceError}</div> : null}
            {totalError ? <div className="err small">{totalError}</div> : null}
            {!match?.ok ? (
              <label className="keep-original small">
                <input type="checkbox" checked={original} disabled={busy} onChange={(e) => setOriginal(e.target.checked)} />
                <span>Загрузить оригинал <span className="muted">— без уменьшения до 1080×1920: дольше, а в ролике разницы не видно</span></span>
              </label>
            ) : null}
            {shrinkNote ? <div className="muted small pre">{shrinkNote}</div> : null}
            {busy || phase === 'failed' ? (
              <>
                <div className="bar"><div style={{ width: `${pct}%` }} /></div>
                <div className="row muted small">
                  <span>{phase === 'shrinking' ? 'Уменьшаю видео до 1080×1920…' : phase === 'completing' ? 'Проверяю…' : phase === 'launching' ? 'Запускаю Claude…'
                    : phase === 'failed' ? 'Загрузка остановилась' : 'Загружаю в GitHub…'}</span>
                  <span className="mono">{pct}%</span>
                </div>
                {phase === 'uploading' || phase === 'shrinking' ? <div className="muted small">Не закрывайте страницу до конца загрузки.</div> : null}
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="card">
        <label htmlFor="brief" className="label">ТЗ <span className="muted">· необязательно</span></label>
        <textarea id="brief" className="mono" rows={5} maxLength={MAX_BRIEF} placeholder={BRIEF_HINT} value={brief} onChange={(e) => changeBrief(e.target.value)} />
      </section>

      <div className="tools">
        <label className={`tool wide${busy ? ' off' : ''}`}>
          <span className="tool-icon"><FilmIcon /></span>
          <span className="grow">Перебивки <span className="muted small">— свои клипы, Claude поставит по смыслу</span></span>
          <span className="tool-plus"><PlusIcon size={16} /></span>
          <input id="broll" type="file" multiple accept={INSERT_TYPES.join(',')} disabled={busy} hidden
            onChange={(e) => { addBrolls(e.target.files); e.target.value = ''; }} />
        </label>
        <label className={`tool${busy ? ' off' : ''}`}>
          <span className="tool-icon"><ImageIcon /></span>
          <span className="grow">Вставки</span>
          <span className="tool-plus"><PlusIcon size={16} /></span>
          <input id="inserts" type="file" multiple accept={INSERT_TYPES.join(',')} disabled={busy} hidden
            onChange={(e) => { addInserts(e.target.files); e.target.value = ''; }} />
        </label>
        <label className={`tool${busy ? ' off' : ''}`}>
          <span className="tool-icon"><MicIcon size={20} /></span>
          <span className="grow">Озвучка</span>
          <span className="tool-plus">{voice ? <RefreshIcon size={16} /> : <PlusIcon size={16} />}</span>
          <input id="voice" type="file" accept={['audio/*', ...VOICE_EXT.map((e) => `.${e}`)].join(',')} disabled={busy} hidden
            onChange={(e) => { pickVoice(e.target.files?.[0] ?? null); e.target.value = ''; }} />
        </label>
      </div>
      {inserts.length || brolls.length || voice ? (
        <ul className="files">
          {brolls.map((f, k) => (
            <li key={`b:${f.name}:${f.size}:${f.lastModified}`}>
              <span className="thumb"><FilmIcon /></span>
              <span className="grow">{f.name} <span className="muted small">· перебивка</span></span>
              <span className="mono muted small">{bytes(f.size)}</span>
              <button type="button" className="icon" aria-label={`Убрать ${f.name}`} disabled={busy}
                onClick={() => setBrolls(brolls.filter((_, i) => i !== k))}>
                <CloseIcon />
              </button>
            </li>
          ))}
          {inserts.map((f, k) => (
            <li key={`${f.name}:${f.size}:${f.lastModified}`}>
              <Thumb file={f} />
              <span className="grow">{f.name}</span>
              <button type="button" className="icon" aria-label={`Убрать ${f.name}`} disabled={busy}
                onClick={() => setInserts(inserts.filter((_, i) => i !== k))}>
                <CloseIcon />
              </button>
            </li>
          ))}
          {voice ? (
            <li>
              <span className="thumb"><MicIcon /></span>
              <span className="grow">{voice.name}</span>
              <span className="mono muted small">{bytes(voice.size)}</span>
              <button type="button" className="icon" aria-label={`Убрать ${voice.name}`} disabled={busy} onClick={() => setVoice(null)}>
                <CloseIcon />
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {brollError ? <div className="err small pre">{brollError}</div> : null}
      {insertError ? <div className="err small pre">{insertError}</div> : null}
      {voiceError ? <div className="err small">{voiceError}</div> : null}
      <div className="muted small">Перебивки — до {MAX_BROLL} своих клипов или фото (зал, улица, руки, экран): Claude поставит их поверх
        говорящей головы там, где речь о них. Вставки — логотипы, скрины и демо для этого ролика. Озвучка — своя запись голоса вместо звука видео: M4A, MP3, WAV или AAC до 200 МБ.</div>

      {error ? <div className="err">{error}</div> : null}
      {phase === 'launch_failed' && launched.current ? (
        <button type="button" className="btn" onClick={() => void launch(launched.current!)}>Повторить запуск</button>
      ) : resumable ? (
        <button type="button" className="btn" onClick={() => void upload(active.current!, null)}>Продолжить загрузку</button>
      ) : match?.ok ? (
        <button type="button" className="btn" disabled={!canStart} onClick={() => void resume()}>Продолжить загрузку</button>
      ) : (
        <button type="button" className="btn" disabled={!canStart} onClick={() => void startNew()}>
          <UploadIcon size={20} />
          {busy ? 'Загружаю…' : 'Загрузить'}
        </button>
      )}
    </>
  );
}
