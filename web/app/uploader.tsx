'use client';
// Экран «1 · Загрузка»: видео, ТЗ и вставки → черновик job-<id> кусками → manifest.json → запуск анализа.
// Незаконченная загрузка помнится в localStorage: после перезагрузки тот же файл продолжает с недостающих кусков.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { errorText, message, post, storage } from '@/lib/client.ts';
import { bytes, mmss } from '@/lib/format.ts';
import { checkInsert, checkSource, checkTotal, INSERT_TYPES, LONG_VIDEO_SEC, MAX_BRIEF, MAX_INSERTS, uploadAssetName } from '@/lib/jobs.ts';
import {
  clearPending, loadPending, matchPending, planChunks, resumeDone, runUpload, savePending, type Pending, type PendingInsert,
} from '@/lib/uploader.ts';
import { CloseIcon, PlayIcon, PlusIcon, UploadIcon } from './icons';
import { JOBS_CHANGED } from './jobs-list';

const BRIEF_HINT = 'ХУК: Как я учу чешский\nКОДОВОЕ СЛОВО: чешский\nМУЗЫКА: lofi\nКогда говорю «приложение» — покажи логотип\nНа «вот так это выглядит» — фуллскрин демо';

type Phase = 'idle' | 'uploading' | 'completing' | 'launching' | 'failed' | 'launch_failed';
type Active = { p: Pending; files: Map<string, File> }; // files: 'source' и ассеты вставок → файлы

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

/** Экран не гаснет, пока идёт загрузка (iOS 16.4+): заблокированный телефон останавливает страницу. */
async function keepAwake(): Promise<() => void> {
  try {
    const lock = await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen');
    return () => void lock?.release().catch(() => undefined);
  } catch {
    return () => undefined;
  }
}

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

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
  const [source, setSource] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null | undefined>(undefined); // undefined — ещё смотрю
  const [brief, setBrief] = useState('');
  const [inserts, setInserts] = useState<File[]>([]);
  const [insertError, setInsertError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [sent, setSent] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const briefRef = useRef('');
  const active = useRef<Active | null>(null);
  const picked = useRef(0);
  const launched = useRef<string | null>(null);

  useEffect(() => {
    const p = loadPending(storage());
    if (!p) return;
    setPending(p);
    setBrief(p.brief);
    briefRef.current = p.brief;
  }, []);

  const busy = phase === 'uploading' || phase === 'completing' || phase === 'launching';
  const match = useMemo(() => (pending && source && !busy ? matchPending(pending, source, inserts) : null), [pending, source, inserts, busy]);
  const sourceError = source ? checkSource(source.size) : null;
  const totalError = source ? checkTotal(source.size, inserts.map((f) => f.size)) : null;
  const measuring = !!source && duration === undefined;
  const canStart = !!source && !sourceError && !totalError && !busy && !measuring;

  async function pickSource(f: File | null) {
    const n = ++picked.current;
    setSource(f);
    setError('');
    setPhase('idle');
    setDuration(f ? undefined : null);
    if (!f) return;
    const d = await videoDuration(f);
    if (picked.current === n) setDuration(d);
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
    setPhase('uploading');
    try {
      const r = await post('/api/jobs', { name: source.name, size: source.size, type: source.type });
      if (!r.ok) throw new Error(await errorText(r, 'Задача не создалась'));
      const { jobId, releaseId } = (await r.json()) as { jobId: string; releaseId: number };
      window.dispatchEvent(new Event(JOBS_CHANGED));
      const list: PendingInsert[] = inserts.map((f, k) => ({ asset: uploadAssetName('i', k + 1, f.name, f.type), name: f.name, size: f.size, type: f.type, lastModified: f.lastModified }));
      const p: Pending = { jobId, releaseId, source: { name: source.name, size: source.size, lastModified: source.lastModified }, brief: briefRef.current, duration: duration ?? null, inserts: list };
      await upload({ p, files: new Map<string, File>([['source', source], ...list.map((i, k) => [i.asset, inserts[k]] as [string, File])]) }, new Set());
    } catch (e) {
      setError(message(e));
      setPhase('failed');
    }
  }

  /** Тот же файл после перезагрузки: заново выбранные вставки — те же ассеты, новые — следующие номера. */
  async function resume() {
    if (!pending || !source || !match?.ok) return;
    const kept = pending.inserts.filter((i) => match.inserts.has(i.asset));
    const reused = new Set(match.inserts.values());
    const extras = inserts.filter((f) => !reused.has(f));
    let n = Math.max(0, ...pending.inserts.map((i) => Number(/^upload-i(\d+)/.exec(i.asset)?.[1] ?? 0)));
    const added: PendingInsert[] = extras.map((f) => ({ asset: uploadAssetName('i', ++n, f.name, f.type), name: f.name, size: f.size, type: f.type, lastModified: f.lastModified }));
    const p: Pending = { ...pending, brief: briefRef.current, duration: duration ?? pending.duration, inserts: [...kept, ...added] };
    await upload({ p, files: new Map<string, File>([['source', source], ...match.inserts, ...added.map((a, k) => [a.asset, extras[k]] as [string, File])]) }, null);
  }

  /** Куски (`known` — уже готовые; null — спросить черновик), проверка → manifest.json, запуск анализа. */
  async function upload(a: Active, known: Set<number> | null) {
    active.current = a;
    savePending(storage(), a.p);
    setPending(a.p);
    setError('');
    setPhase('uploading');
    const release = await keepAwake();
    const { p, files } = a;
    try {
      const chunks = planChunks([{ asset: 'source', size: p.source.size }, ...p.inserts.map((i) => ({ asset: i.asset, size: i.size }))]);
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
        concurrency: 2,
        minGapMs: 700,
        put: async (i) => {
          const c = chunks[i];
          const file = c.file === 'source' ? '' : `&file=${encodeURIComponent(c.file)}`;
          const r = await fetch(`/api/jobs/${p.jobId}/parts/${c.index}?release=${p.releaseId}${file}`, {
            method: 'PUT', body: files.get(c.file)!.slice(c.start, c.end), headers: { 'Content-Type': 'application/octet-stream' },
          });
          if (!r.ok) return { ok: false, status: r.status };
          got += c.end - c.start;
          setSent(got);
          return { ok: true };
        },
      });
      setPhase('completing');
      const partsOf = (asset: string) => chunks.filter((c) => c.file === asset).length;
      const c = await post(`/api/jobs/${p.jobId}/complete`, {
        releaseId: p.releaseId, name: p.source.name, size: p.source.size, type: files.get('source')!.type, lastModified: p.source.lastModified,
        parts: partsOf('source'), userAgent: navigator.userAgent, brief: briefRef.current.trim(), duration: p.duration,
        uploads: p.inserts.map((i) => ({ asset: i.asset, name: i.name, size: i.size, type: i.type, parts: partsOf(i.asset) })),
      });
      if (!c.ok) throw new Error(await errorText(c, 'Проверка загрузки не прошла'));
      clearPending(storage()); // всё в черновике — продолжать больше нечего, запуск повторяется и со страницы задачи
      setPending(null);
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
    clearPending(storage());
    setPending(null);
  }

  const pct = total ? Math.floor((100 * sent) / total) : 0;
  const resumable = phase === 'failed' && active.current !== null;
  const long = typeof duration === 'number' && duration > LONG_VIDEO_SEC;

  return (
    <>
      {pending && !busy && phase !== 'failed' ? (
        <div className="card note">
          <div>{match?.ok ? <>Продолжаю загрузку <b>{pending.source.name}</b>: недостающие куски дошлю.</> : <>Загрузка <b>{pending.source.name}</b> не закончена: выберите тот же файл.</>}</div>
          {match?.ok && match.dropped.length ? <div className="muted">Не выбраны заново и не войдут: {match.dropped.join(', ')}</div> : null}
          <button type="button" className="btn ghost" onClick={forget}>Забыть</button>
        </div>
      ) : null}

      <label className={`pick${busy ? ' off' : ''}`}>
        <span className="pick-icon"><UploadIcon /></span>
        <span className="pick-title">{source ? 'Выбрать другое видео' : 'Выбрать видео'}</span>
        <span className="pick-hint">Из галереи телефона, до 3 ГБ.</span>
        <input id="source" type="file" accept="video/*,.mov,.mp4" disabled={busy} hidden
          onChange={(e) => { void pickSource(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      </label>

      {source ? (
        <div className="card">
          <div className="row baseline">
            <b className="name">{source.name}</b>
            <span className="muted small">{bytes(source.size)}{typeof duration === 'number' ? ` · ${mmss(duration)}` : ''}</span>
          </div>
          {measuring ? <div className="muted small">Смотрю видео…</div> : null}
          {long ? <div className="warn">Ролик длиннее 5 минут — монтаж может не уложиться.</div> : null}
          {sourceError ? <div className="err">{sourceError}</div> : null}
          {totalError ? <div className="err">{totalError}</div> : null}
          {busy || phase === 'failed' ? (
            <>
              <div className="bar"><div style={{ width: `${pct}%` }} /></div>
              <div className="row muted small">
                <span>{phase === 'completing' ? 'Проверяю…' : phase === 'launching' ? 'Запускаю Claude…' : phase === 'failed' ? 'Загрузка остановилась' : 'Загружаю в GitHub…'}</span>
                <span>{pct}%</span>
              </div>
              {phase === 'uploading' ? <div className="muted small">Не закрывайте страницу до конца загрузки.</div> : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <label htmlFor="brief" className="label">ТЗ <span className="muted">— необязательно</span></label>
        <textarea id="brief" rows={5} maxLength={MAX_BRIEF} placeholder={BRIEF_HINT} value={brief} onChange={(e) => changeBrief(e.target.value)} />
        <label className={`btn ghost${busy ? ' off' : ''}`}>
          <PlusIcon />
          Вставки для этого ролика
          <input id="inserts" type="file" multiple accept={INSERT_TYPES.join(',')} disabled={busy} hidden
            onChange={(e) => { addInserts(e.target.files); e.target.value = ''; }} />
        </label>
        {inserts.length ? (
          <ul className="files">
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
          </ul>
        ) : null}
        {insertError ? <div className="err pre">{insertError}</div> : null}
      </div>

      {error ? <div className="err">{error}</div> : null}
      {phase === 'launch_failed' && launched.current ? (
        <button type="button" className="btn" onClick={() => void launch(launched.current!)}>Повторить запуск</button>
      ) : resumable ? (
        <button type="button" className="btn" onClick={() => void upload(active.current!, null)}>Продолжить загрузку</button>
      ) : match?.ok ? (
        <button type="button" className="btn" disabled={!canStart} onClick={() => void resume()}>Продолжить загрузку</button>
      ) : (
        <button type="button" className="btn" disabled={!canStart} onClick={() => void startNew()}>
          {busy ? 'Загружаю…' : 'Загрузить'}
        </button>
      )}
    </>
  );
}
