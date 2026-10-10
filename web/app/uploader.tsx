'use client';
import { useEffect, useRef, useState } from 'react';
import { runUpload } from '@/lib/uploader.ts';

type Job = { jobId: string; releaseId: number; parts: number; chunkSize: number };
type Listed = { jobId: string; title: string; parts: number; bytes: number; uploaded: boolean; outputs: string[] };

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} МБ`;

export default function Uploader() {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<'idle' | 'creating' | 'uploading' | 'completing' | 'done' | 'error'>('idle');
  const [job, setJob] = useState<Job | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');
  const [report, setReport] = useState('');
  const [jobs, setJobs] = useState<Listed[]>([]);
  const done = useRef(new Set<number>());
  const hidden = useRef<{ at: number; back?: number }[]>([]);
  const started = useRef(0);

  async function refresh() {
    const r = await fetch('/api/jobs');
    if (r.ok) setJobs(await r.json());
  }
  useEffect(() => {
    void refresh();
    const onVis = () => {
      const h = hidden.current;
      if (document.visibilityState === 'hidden') h.push({ at: Date.now() });
      else if (h.length && !h[h.length - 1].back) h[h.length - 1].back = Date.now();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  async function start() {
    if (!file) return;
    setError('');
    try {
      let j = job;
      if (!j) {
        setPhase('creating');
        const r = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, size: file.size, type: file.type }) });
        if (!r.ok) throw new Error(`создание задачи: ${r.status} ${await r.text()}`);
        j = (await r.json()) as Job;
        setJob(j);
        started.current = Date.now();
        done.current = new Set();
      }
      const jj = j;
      setPhase('uploading');
      const { retries } = await runUpload({
        parts: jj.parts,
        done: done.current,
        concurrency: 2,
        minGapMs: 700,
        onProgress: (n) => setCount(n),
        put: async (i) => {
          const blob = file.slice(i * jj.chunkSize, Math.min(file.size, (i + 1) * jj.chunkSize));
          const r = await fetch(`/api/jobs/${jj.jobId}/parts/${i}?release=${jj.releaseId}`, { method: 'PUT', body: blob,
            headers: { 'Content-Type': 'application/octet-stream' } });
          if (r.ok) { done.current.add(i); return { ok: true }; }
          return { ok: false, status: r.status };
        },
      });
      setPhase('completing');
      const finishedAt = Date.now();
      const c = await fetch(`/api/jobs/${jj.jobId}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseId: jj.releaseId, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified,
          parts: jj.parts, userAgent: navigator.userAgent, startedAt: started.current, finishedAt, retries }) });
      if (!c.ok) throw new Error(`проверка: ${c.status} ${await c.text()}`);
      const sec = (finishedAt - started.current) / 1000;
      const gaps = hidden.current.map((h) => `${Math.round(((h.back ?? Date.now()) - h.at) / 1000)} с`).join(', ');
      setReport(`Загружено ${mb(file.size)} за ${sec.toFixed(0)} с (${(file.size / 1024 / 1024 / sec).toFixed(2)} МБ/с), повторов: ${retries}` +
        (gaps ? `, страница была скрыта: ${gaps}` : ''));
      setPhase('done');
      void refresh();
    } catch (e) {
      setError(String(e));
      setPhase('error');
    }
  }

  const parts = job?.parts ?? 0;
  const pct = parts ? Math.round((100 * count) / parts) : 0;
  return (
    <>
      <div className="card">
        <label className="btn secondary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          Выбрать видео
          <input type="file" accept="video/*,.mov,.mp4" style={{ display: 'none' }}
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setJob(null); setCount(0); setPhase('idle'); setReport(''); setError(''); }} />
        </label>
        {file ? (
          <div className="muted">
            <div><b style={{ color: 'var(--text)' }}>{file.name}</b></div>
            <div>{mb(file.size)} · {file.type || 'тип не указан'} · изменён {new Date(file.lastModified).toLocaleString('ru-RU')}</div>
          </div>
        ) : <div className="muted">Из галереи телефона. Пока идёт загрузка, лучше не блокировать экран.</div>}
        {file && (phase === 'idle' || phase === 'error') ? (
          <button onClick={start}>{job ? 'Продолжить загрузку' : 'Загрузить'}</button>
        ) : null}
        {phase === 'creating' || phase === 'uploading' || phase === 'completing' ? (
          <>
            <div className="bar"><div style={{ width: `${pct}%` }} /></div>
            <div className="row muted"><span>{phase === 'completing' ? 'Проверяю…' : `Загружаю в GitHub… ${count}/${parts}`}</span><span>{pct}%</span></div>
          </>
        ) : null}
        {report ? <div className="okc">{report}</div> : null}
        {error ? <div className="err">{error}</div> : null}
      </div>
      <div className="card">
        <div className="muted">Мои видео</div>
        {jobs.length === 0 ? <div className="muted">Пока пусто</div> : jobs.map((j) => (
          <div key={j.jobId} className="row">
            <span>{j.title}<br /><code>{j.jobId}</code></span>
            <span className="muted">{mb(j.bytes)} · {j.uploaded ? 'загружено' : `${j.parts} кусков`}{j.outputs.length ? ' · готово' : ''}</span>
          </div>
        ))}
      </div>
    </>
  );
}
