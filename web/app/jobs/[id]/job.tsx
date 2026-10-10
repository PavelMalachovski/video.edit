'use client';
// Страница задачи: опрос GET /api/jobs/<id> (5 с; GitHub просит подождать — дольше), пока вкладка видна; шапка,
// полоса шагов и экран по view.screen.
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, message, post } from '@/lib/client.ts';
import { mmss } from '@/lib/format.ts';
import { stepIndex, type Action, type JobData } from '@/lib/jobview.ts';
import { nextDelay } from '@/lib/poll.ts';
import { Steps } from '../../steps';
import Phases from './phases';

/** Действие на странице → `POST run`; null — запущено, иначе текст ошибки для кнопки. */
export type Act = (action: Action, extra?: Record<string, unknown>) => Promise<string | null>;

export default function Job({ id }: { id: string }) {
  const [data, setData] = useState<JobData | null>(null);
  const [missing, setMissing] = useState(false);
  const [wait, setWait] = useState<number | null>(null);
  const [trouble, setTrouble] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);

  const poll = useCallback(async () => {
    if (busy.current) {  // запрос уже идёт — повторить сразу после него
      again.current = true;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (document.visibilityState !== 'visible') return; // спрятана — снова спросим, когда покажут
    busy.current = true;
    let delay: number;
    try {
      const r = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
      if (r.status === 404) {
        setMissing(true);
        return;
      }
      if (r.ok) {
        setData((await r.json()) as JobData);
        setWait(null);
        setTrouble('');
        delay = nextDelay({ ok: true });
      } else {
        const body = (await r.json().catch(() => null)) as { error?: unknown; retryAfter?: unknown } | null;
        delay = nextDelay({ ok: false, status: r.status, retryAfter: typeof body?.retryAfter === 'number' ? body.retryAfter : undefined });
        if (r.status === 429) setWait(Math.round(delay / 1000));
        else setTrouble(typeof body?.error === 'string' ? body.error : `Сервер ответил ${r.status}`);
      }
    } catch {
      delay = nextDelay({ ok: false, status: 0 });
      setTrouble('Нет связи — попробую ещё раз');
    } finally {
      busy.current = false;
    }
    if (again.current) {
      again.current = false;
      void poll();
    } else if (alive.current && document.visibilityState === 'visible') {
      timer.current = setTimeout(() => void poll(), delay);
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    void poll();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
      else if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  const act: Act = useCallback(async (action, extra = {}) => {
    try {
      const r = await post(`/api/jobs/${id}/run`, { action, ...extra });
      if (!r.ok) return await errorText(r, 'Не получилось');
      void poll();
      return null;
    } catch (e) {
      return message(e);
    }
  }, [id, poll]);

  if (missing) {
    return (
      <>
        <Link href="/" className="back">← Мои видео</Link>
        <div className="card">Задача не найдена — её удалили или ссылка неверная.</div>
      </>
    );
  }
  const view = data?.view;
  return (
    <>
      <Link href="/" className="back">← Мои видео</Link>
      <header className="job-head">
        <h1>{view?.title ?? 'Загружаю…'}</h1>
        {view?.duration ? <div className="muted">{mmss(view.duration)}</div> : null}
      </header>
      {wait !== null ? <div className="muted small">GitHub просит подождать, обновлю через {wait} с</div> : null}
      {trouble ? <div className="muted small">{trouble}</div> : null}
      {view ? <Steps current={stepIndex(view)} /> : null}
      {!data || !view ? null : view.screen === 'questions' ? (
        <div className="card">Claude ждёт ответов — вопросы появятся здесь.</div>
      ) : view.screen === 'result' ? (
        <div className="card">Ролик готов.</div>
      ) : (
        <Phases view={view} repo={data.repo} onAction={act} />
      )}
    </>
  );
}
