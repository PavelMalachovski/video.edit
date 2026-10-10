'use client';
// Экран «4 · Готово»: ролик, скачивание видео и субтитров, итоги Claude и «Поправить» (шаг fix, новая версия ролика).
import { useState } from 'react';
import { mmss } from '@/lib/format.ts';
import type { AnswersFile, FixFile, ResultFile } from '@/lib/jobfiles.ts';
import { MAX_NOTE } from '@/lib/jobs.ts';
import type { JobView } from '@/lib/jobview.ts';
import type { Act } from './job';

type Props = { view: JobView; result: ResultFile | null; answers: AnswersFile | null; fixes: FixFile['fixes']; onAct: Act };

const when = (at: string): string => new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function List({ title, items, tone }: { title: string; items: string[]; tone?: 'alert' }) {
  if (!items.length) return null;
  return (
    <div className={`card${tone ? ` ${tone}` : ''}`}>
      <div className="caps small">{title}</div>
      <ul className="plain">{items.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </div>
  );
}

export default function Result({ view, result, answers, fixes, onAct }: Props) {
  const final = view.final;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!final) return null;
  const download = (name: string) => `/api/jobs/${view.id}/download?name=${encodeURIComponent(name)}`;
  const facts = [
    view.title.replace(/\.[^.]+$/, ''),
    result ? `было ${mmss(result.durations.source)} → стало ${mmss(result.durations.final)}` : null,
    answers ? `стиль ${answers.style.variant}` : null,
    view.version > 1 ? `версия ${view.version}` : null,
  ].filter(Boolean);

  async function fix() {
    setBusy(true);
    setError('');
    const why = await onAct('fix', { text: text.trim() });
    setBusy(false);
    if (why) setError(why);
    else setText('');
  }

  return (
    <>
      <header className="job-head">
        <h1>Готово</h1>
        <div className="muted">{facts.join(' · ')}</div>
      </header>
      <div className="big-wrap">
        <video className="result-video" controls playsInline preload="metadata" src={download(final.mp4)} />
      </div>
      <div className="two">
        <a className="btn" href={download(final.mp4)} download={final.mp4}>Скачать видео</a>
        {final.srt ? <a className="btn ghost" href={download(final.srt)} download={final.srt}>Субтитры .srt</a> : null}
      </div>
      {result ? (
        <>
          {result.qa.ok ? null : <List title="Проверка нашла" items={result.qa.problems} tone="alert" />}
          <div className="card">
            <div className="caps small">Что я сделал</div>
            {result.done.length ? <ul className="plain">{result.done.map((line, i) => <li key={i}>{line}</li>)}</ul> : <div className="muted">Claude не оставил итогов.</div>}
          </div>
          <List title="Не уверен" items={result.unsure} />
          <List title="Не хватило" items={result.missing} />
        </>
      ) : null}
      <div className="card">
        <label htmlFor="fix" className="label">Поправить</label>
        <input id="fix" type="text" maxLength={MAX_NOTE} placeholder="Например: логотип чуть левее" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" className="btn ghost" disabled={!text.trim() || busy} onClick={() => void fix()}>Переделать</button>
        {error ? <div className="err small">{error}</div> : null}
      </div>
      {fixes.length ? (
        <div className="card">
          <div className="caps small">Правки</div>
          <ul className="plain">
            {fixes.map((f) => (
              <li key={f.version}>
                <b>Версия {f.version}:</b> {f.text} <span className="muted small">· {when(f.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
