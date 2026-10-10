'use client';
// «Мои видео»: задачи со значком состояния, ссылка на страницу задачи, «Удалить». Пока кто-то в работе и вкладка
// видна — обновление раз в 15 с.
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { errorText, message } from '@/lib/client.ts';
import { mmss } from '@/lib/format.ts';
import type { JobView, Screen } from '@/lib/jobview.ts';
import { TrashIcon } from './icons';

/** Событие окна: список задач изменился (загрузка создала новую) — перечитать. */
export const JOBS_CHANGED = 'vm:jobs-changed';

type Row = { jobId: string; title: string; createdAt: string; duration: number | null; screen: Screen; phase: string | null; stuck: JobView['stuck'] };
type Tone = 'grey' | 'yellow' | 'green' | 'red';

function badge(r: Row): { text: string; tone: Tone } {
  switch (r.screen) {
    case 'uploading': return { text: 'Загрузка не закончена', tone: 'grey' };
    case 'not_started': return { text: 'Не запущено', tone: 'grey' };
    case 'working': return r.stuck ? { text: `${r.phase ?? 'Работаю'}… завис?`, tone: 'yellow' } : { text: `${r.phase ?? 'Работаю'}…`, tone: 'grey' };
    case 'questions': return { text: 'Ждёт ответов', tone: 'yellow' };
    case 'result': return { text: 'Готово', tone: 'green' };
    case 'error': return { text: 'Ошибка', tone: 'red' };
  }
}

export default function JobsList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/jobs', { cache: 'no-store' });
      if (!r.ok) throw new Error(await errorText(r, 'Список не загрузился'));
      setRows((await r.json()) as Row[]);
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(JOBS_CHANGED, onChange);
    return () => window.removeEventListener(JOBS_CHANGED, onChange);
  }, [refresh]);

  const working = rows?.some((r) => r.screen === 'working') ?? false;
  useEffect(() => {
    if (!working) return;
    const visible = () => document.visibilityState === 'visible';
    const timer = setInterval(() => { if (visible()) void refresh(); }, 15_000);
    const onVisible = () => { if (visible()) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [working, refresh]);

  async function remove(row: Row) {
    if (!confirm(`Удалить «${row.title}»? Видео и всё, что сделал Claude, пропадут.`)) return;
    setDeleting(row.jobId);
    setRowError(({ [row.jobId]: _, ...rest }) => rest);
    try {
      const r = await fetch(`/api/jobs/${row.jobId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(await errorText(r, 'Не удалилось'));
      setRows((all) => all?.filter((x) => x.jobId !== row.jobId) ?? null);
    } catch (e) {
      setRowError((all) => ({ ...all, [row.jobId]: message(e) }));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="list">
      <h2 className="caps">Мои видео</h2>
      {error ? <div className="muted small">{error}</div> : null}
      {rows === null ? (error ? null : <div className="muted">Загружаю список…</div>) : rows.length === 0 ? <div className="muted">Пока пусто — загрузите первое видео.</div> : rows.map((r) => {
        const b = badge(r);
        return (
          <div key={r.jobId} className="job" data-job={r.jobId}>
            <div className="job-row">
              <Link href={`/jobs/${r.jobId}`} className="job-link">
                <span className="job-name">
                  <b>{r.title}</b>
                  {r.duration ? <span className="muted small">{mmss(r.duration)}</span> : null}
                </span>
                <span className={`badge ${b.tone}`}>{b.text}</span>
              </Link>
              <button type="button" className="icon" aria-label={`Удалить ${r.title}`} disabled={deleting === r.jobId} onClick={() => void remove(r)}>
                <TrashIcon />
              </button>
            </div>
            {rowError[r.jobId] ? <div className="err small">{rowError[r.jobId]}</div> : null}
          </div>
        );
      })}
    </section>
  );
}
