'use client';
// Страница задачи: опрос GET /api/jobs/<id> (5 с; GitHub просит подождать — дольше), пока вкладка видна; шапка,
// полоса шагов и экран по view.screen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildAnswers, loadDraft, saveDraft, type Draft } from '@/lib/answers.ts';
import { errorText, message, post, storage } from '@/lib/client.ts';
import { mmss } from '@/lib/format.ts';
import { stepIndex, type Action, type JobData } from '@/lib/jobview.ts';
import { nextDelay } from '@/lib/poll.ts';
import { Steps } from '../../steps';
import { TopBar } from '../../top-bar';
import Phases from './phases';
import Previews from './previews';
import Questions, { type ChangeDraft } from './questions';
import Result from './result';
import ScriptView from './script';

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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [localUrls, setLocalUrls] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<'auto' | 'questions' | 'previews'>('auto');

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

  // вопросы и стили — тот же объект, пока не поменялось содержимое (опрос раз в 5 с не перерисовывает превью)
  const questionsJson = data?.view.screen === 'questions' && data.questions ? JSON.stringify(data.questions) : null;
  const stylesJson = data?.view.screen === 'questions' && data.styles ? JSON.stringify(data.styles) : null;
  const questions = useMemo(() => (questionsJson ? (JSON.parse(questionsJson) as JobData['questions']) : null), [questionsJson]);
  const styles = useMemo(() => (stylesJson ? (JSON.parse(stylesJson) as NonNullable<JobData['styles']>) : null), [stylesJson]);
  useEffect(() => {  // черновик ответов — когда вопросы впервые пришли
    if (questions && !draft) setDraft(loadDraft(storage(), id, questions));
  }, [questions, draft, id]);

  const changeDraft: ChangeDraft = useCallback((update) => {
    setDraft((d) => {
      if (!d) return d;
      const next = update(d);
      saveDraft(storage(), id, next);
      return next;
    });
  }, [id]);
  const onLocalUrl = useCallback((qid: string, url: string) => setLocalUrls((all) => ({ ...all, [qid]: url })), []);
  const localUrl = useCallback((qid: string) => localUrls[qid] ?? null, [localUrls]);
  const head = data?.head ?? null;
  const fileUrl = useCallback((path: string) => `/api/jobs/${id}/file?path=${encodeURIComponent(path)}${head ? `&v=${head}` : ''}`, [id, head]);

  const act: Act = useCallback(async (action, extra = {}) => {
    try {
      const r = await post(`/api/jobs/${id}/run`, { action, ...extra });
      if (!r.ok) return await errorText(r, 'Не получилось');
      if (action === 'back') setStage('auto'); // после restyle — к превью, после render — к вопросам
      void poll();
      return null;
    } catch (e) {
      return message(e);
    }
  }, [id, poll]);

  if (missing) {
    return (
      <>
        <TopBar back={{ href: '/', label: 'Мои видео' }} title="Задача не найдена" />
        <div className="card">Задача не найдена — её удалили или ссылка неверная.</div>
      </>
    );
  }
  const view = data?.view;
  const notices = (
    <>
      {wait !== null ? <div className="muted small">GitHub просит подождать, обновлю через {wait} с</div> : null}
      {trouble ? <div className="muted small">{trouble}</div> : null}
    </>
  );
  // после «Ещё три варианта» вопросы уже отвечены — сразу превью; «← Вопросы» и «Показать превью» решают сами
  const answered = questions && draft ? buildAnswers(questions, draft).missing.length === 0 : false;
  const previews = stage === 'previews' || (stage === 'auto' && view?.step === 'restyle' && answered);
  if (data && view?.screen === 'questions' && draft && questions && styles && previews) {
    return (
      <Previews jobId={id} styles={styles} questions={questions} draft={draft} brief={data.brief} duration={view.duration} fileUrl={fileUrl} localUrl={localUrl}
        onBack={() => setStage('questions')} onAct={act} />
    );
  }
  if (data && view?.screen === 'script' && data.script) {
    return <ScriptView title={view.title} script={data.script} request={data.scriptRequest} />;
  }
  if (data && view?.screen === 'result') {
    return <Result view={view} result={data.result} answers={data.answers} fixes={data.fixes} onAct={act} notice={notices} />;
  }
  return (
    <>
      <TopBar back={{ href: '/', label: 'Мои видео' }} title={view?.title ?? 'Загружаю…'} meta={view?.duration ? mmss(view.duration) : null} />
      {notices}
      {view && view.kind === 'video' ? <Steps current={stepIndex(view)} /> : null}
      {!data || !view ? null : view.screen === 'questions' ? (
        questions && draft ? (
          <Questions jobId={id} releaseId={data.releaseId} questions={questions} review={data.review} draft={draft} onDraft={changeDraft} fileUrl={fileUrl}
            localUrls={localUrls} onLocalUrl={onLocalUrl} onPreview={() => { setStage('previews'); window.scrollTo(0, 0); }} />
        ) : (
          <div className="card">Claude ждёт ответов, но вопросов в задаче нет — откройте сессию или перезапустите анализ.</div>
        )
      ) : (
        <Phases view={view} repo={data.repo} onAction={act} />
      )}
    </>
  );
}
