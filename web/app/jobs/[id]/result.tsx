'use client';
// Экран «4 · Готово»: ролик, скачивание видео и субтитров, итоги Claude и «Поправить» (шаг fix, новая версия ролика).
import { useState } from 'react';
import { captionCopy, captionFold, parseCaption, type Caption } from '@/lib/caption.ts';
import { mmss } from '@/lib/format.ts';
import { abLabels, type AnswersFile, type Check, type FixFile, type ResultFile } from '@/lib/jobfiles.ts';
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

/** Подпись к посту от Claude: жирное — то, что Instagram показывает до «ещё»; кнопка копирует текст и хэштеги. */
function CaptionCard({ caption }: { caption: Caption }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const { shown, hidden } = captionFold(caption.text);
  async function copy() {
    try {
      await navigator.clipboard.writeText(captionCopy(caption));
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }
  return (
    <div className="card" data-caption>
      <div className="caps small">Подпись к посту</div>
      <p className="lead pre"><b>{shown}</b>{hidden}</p>
      {caption.hashtags.length ? <div className="muted">{caption.hashtags.map((t) => `#${t}`).join(' ')}</div> : null}
      <div className="muted small">Жирное — то, что видно до «ещё».</div>
      <button type="button" className="btn ghost" onClick={() => void copy()}>{copied === 'ok' ? 'Скопировано' : 'Скопировать подпись'}</button>
      {copied === 'fail' ? <div className="err small">Не получилось скопировать — выделите текст и скопируйте вручную</div> : null}
    </div>
  );
}

export default function Result({ view, result, answers, fixes, onAct }: Props) {
  const final = view.final;
  const caption = parseCaption(result?.caption);
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

  const b = final.b;
  const [labelA, labelB] = abLabels(result?.ab?.differs ?? answers?.ab ?? null);

  return (
    <>
      <header className="job-head">
        <h1>Готово</h1>
        <div className="muted">{facts.join(' · ')}</div>
      </header>
      {b ? (
        <>
          <div className="two" data-ab>
            {[{ name: labelA, files: final }, { name: labelB, files: b }].map((v) => (
              <div key={v.files.mp4} className="ab-video">
                <div className="caps small">{v.name}</div>
                <video className="result-video small" controls playsInline preload="metadata" src={download(v.files.mp4)} />
                <a className="btn" href={download(v.files.mp4)} download={v.files.mp4}>Скачать</a>
                {v.files.srt ? <a className="btn ghost" href={download(v.files.srt)} download={v.files.srt}>Субтитры .srt</a> : null}
              </div>
            ))}
          </div>
          <div className="muted small">Выложи оба ролика в разные дни и сравни охваты и досмотры — оставь тот, что лучше.</div>
        </>
      ) : (
        <>
          <div className="big-wrap">
            <video className="result-video" controls playsInline preload="metadata" src={download(final.mp4)} />
          </div>
          <div className="two">
            <a className="btn" href={download(final.mp4)} download={final.mp4}>Скачать видео</a>
            {final.srt ? <a className="btn ghost" href={download(final.srt)} download={final.srt}>Субтитры .srt</a> : null}
          </div>
        </>
      )}
      {caption ? <CaptionCard caption={caption} /> : null}
      {result?.checklist ? <Checklist items={result.checklist} caption={Boolean(caption)} /> : null}
      {result ? (
        <>
          {result.qa.ok ? null : <List title={b ? 'Проверка версии A нашла' : 'Проверка нашла'} items={result.qa.problems} tone="alert" />}
          {b && result.ab && !result.ab.qa.ok ? <List title="Проверка версии B нашла" items={result.ab.qa.problems} tone="alert" /> : null}
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

/** «Чек-лист по гайду»: строки vm render (result.json.checklist) и подпись к посту — её Claude пишет после рендера. */
function Checklist({ items, caption }: { items: Check[]; caption: boolean }) {
  const rows = [...items.map((c) => ({ key: c.id, title: c.title, ok: c.ok })), { key: 'caption', title: 'подпись к посту', ok: caption }];
  return (
    <div className="card" data-checklist>
      <div className="caps small">Чек-лист по гайду</div>
      <ul className="plain marks">
        {rows.map((r) => (
          <li key={r.key} data-ok={r.ok}>
            <span className="mark" aria-label={r.ok ? 'есть' : 'нет'}>{r.ok ? '✓' : '✗'}</span>
            <div>{r.title}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
