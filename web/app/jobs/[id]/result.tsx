'use client';
// Экран «4 · Готово»: ролик на светлой сцене, скачивание видео и субтитров, итоги Claude и «Поправить» (шаг fix, новая
// версия ролика).
import { useState, type ReactNode } from 'react';
import { captionCopy, captionFold, parseCaption, type Caption } from '@/lib/caption.ts';
import { errorText } from '@/lib/client.ts';
import { mmss } from '@/lib/format.ts';
import { abLabels, type AnswersFile, type Check, type FixFile, type ResultFile } from '@/lib/jobfiles.ts';
import { MAX_NOTE } from '@/lib/jobs.ts';
import type { JobView } from '@/lib/jobview.ts';
import { CopyIcon, DownloadIcon } from '../../icons';
import { TopBar } from '../../top-bar';
import type { Act } from './job';

/** `notice` — строки под тулбаром (GitHub просит подождать, нет связи). */
type Props = { view: JobView; result: ResultFile | null; answers: AnswersFile | null; fixes: FixFile['fixes']; onAct: Act; notice?: ReactNode };

const when = (at: string): string => new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function List({ title, items, tone }: { title: string; items: string[]; tone?: 'alert' }) {
  if (!items.length) return null;
  return (
    <div className={`card${tone ? ` ${tone}` : ''}`}>
      <div className="caps">{title}</div>
      <ul className="plain dots">{items.map((line, i) => <li key={i}>{line}</li>)}</ul>
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
      <div className="caps">Подпись к посту</div>
      <p className="caption pre"><b>{shown}</b>{hidden}</p>
      {caption.hashtags.length ? <div className="tags">{caption.hashtags.map((t) => `#${t}`).join(' ')}</div> : null}
      <div className="muted small">Жирное — то, что видно до «ещё».</div>
      <button type="button" className="btn ghost" onClick={() => void copy()}><CopyIcon />{copied === 'ok' ? 'Скопировано' : 'Скопировать подпись'}</button>
      {copied === 'fail' ? <div className="err small">Не получилось скопировать — выделите текст и скопируйте вручную</div> : null}
      {caption.ad ? <AdText text={caption.ad} /> : null}
    </div>
  );
}

/** «Мой стиль»: как смонтирован этот ролик (стиль, скорость, затемнение, музыка) — в «Мой бренд»; новые ролики начнут с
 *  него. Что сохранять, сервер берёт из ветки задачи, а не со страницы. */
function SaveLook({ jobId }: { jobId: string }) {
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' } | { kind: 'error'; text: string }>({ kind: 'idle' });
  async function save() {
    setState({ kind: 'busy' });
    try {
      const r = await fetch('/api/brand/look', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job: jobId }) });
      setState(r.ok ? { kind: 'done' } : { kind: 'error', text: await errorText(r, 'Не получилось сохранить') });
    } catch {
      setState({ kind: 'error', text: 'Нет связи — попробуйте ещё раз' });
    }
  }
  return (
    <div className="card" data-save-look>
      <div className="caps">Мой стиль</div>
      <div className="muted small">Шрифты, цвета, места и размеры текста, скорость, затемнение фона и музыка этого ролика — в «Мой бренд»: следующие ролики начнутся с них.</div>
      <button type="button" className="btn ghost" disabled={state.kind === 'busy'} onClick={() => void save()}>
        {state.kind === 'done' ? 'Сохранено в «Мой бренд»' : 'Сохранить стиль ролика в «Мой бренд»'}
      </button>
      <div role="status" className="sr-only">{state.kind === 'done' ? 'Стиль сохранён в «Мой бренд»' : ''}</div>
      {state.kind === 'error' ? <div className="err small" role="alert">{state.text}</div> : null}
    </div>
  );
}

/** Основной текст рекламы (до 72 знаков — столько видно до обрезки) с копированием. */
function AdText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ad-text" data-ad-text>
      <div className="caps">Текст для рекламы</div>
      <p className="caption">{text}</p>
      <button type="button" className="btn ghost" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))}>
        {copied ? 'Скопировано' : 'Скопировать текст рекламы'}
      </button>
    </div>
  );
}

export default function Result({ view, result, answers, fixes, onAct, notice }: Props) {
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
      <TopBar back={{ href: '/', label: 'Мои видео' }} title="Готово" done meta={facts.join(' · ')} />
      {notice}
      {b ? (
        <>
          <div className="two" data-ab>
            {[{ name: labelA, files: final }, { name: labelB, files: b }].map((v) => (
              <div key={v.files.mp4} className="ab-video">
                <div className="caps">{v.name}</div>
                <video className="result-video small" controls playsInline preload="metadata" src={download(v.files.mp4)} />
                <a className="btn" href={download(v.files.mp4)} download={v.files.mp4}><DownloadIcon />Скачать</a>
                {v.files.srt ? <a className="btn ghost" href={download(v.files.srt)} download={v.files.srt}>Субтитры .srt</a> : null}
              </div>
            ))}
          </div>
          <div className="muted small">Выложи оба ролика в разные дни и сравни охваты и досмотры — оставь тот, что лучше.</div>
        </>
      ) : (
        <>
          <div className="screen-stage">
            <video className="result-video" controls playsInline preload="metadata" src={download(final.mp4)} />
          </div>
          <div className="two">
            <a className="btn" href={download(final.mp4)} download={final.mp4}><DownloadIcon />Скачать видео</a>
            {final.srt ? <a className="btn ghost" href={download(final.srt)} download={final.srt}>Субтитры .srt</a> : null}
          </div>
        </>
      )}
      {final.ad ? (
        <div className="card" data-ad-result>
          <div className="caps">Для рекламы</div>
          <video className="result-video small" controls playsInline preload="metadata" src={download(final.ad.mp4)} />
          <div className="two">
            <a className="btn" href={download(final.ad.mp4)} download={final.ad.mp4}><DownloadIcon />Скачать</a>
            {final.ad.srt ? <a className="btn ghost" href={download(final.ad.srt)} download={final.ad.srt}>Субтитры .srt</a> : null}
          </div>
        </div>
      ) : null}
      {final.cover ? (
        <div className="card" data-cover-result>
          <div className="caps">Обложка</div>
          <img className="cover-img" src={download(final.cover)} alt="Обложка ролика" />
          <a className="btn ghost" href={download(final.cover)} download={final.cover}><DownloadIcon />Скачать обложку</a>
        </div>
      ) : null}
      {caption ? <CaptionCard caption={caption} /> : null}
      <SaveLook jobId={view.id} />
      {result?.checklist ? <Checklist items={result.checklist} caption={Boolean(caption)} /> : null}
      {result ? (
        <>
          {result.qa.ok ? null : <List title={b ? 'Проверка версии A нашла' : 'Проверка нашла'} items={result.qa.problems} tone="alert" />}
          {b && result.ab && !result.ab.qa.ok ? <List title="Проверка версии B нашла" items={result.ab.qa.problems} tone="alert" /> : null}
          {final.ad && result.ad && !result.ad.qa.ok ? <List title="Проверка версии для рекламы нашла" items={result.ad.qa.problems} tone="alert" /> : null}
          <div className="card">
            <div className="caps">Что я сделал</div>
            {result.done.length ? <ul className="plain dots">{result.done.map((line, i) => <li key={i}>{line}</li>)}</ul> : <div className="muted">Claude не оставил итогов.</div>}
          </div>
          <List title="Не уверен" items={result.unsure} />
          <List title="Не хватило" items={result.missing} />
        </>
      ) : null}
      <form className="card" onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && !busy) void fix();
      }}>
        <label htmlFor="fix" className="label">Поправить</label>
        <div className="prompt">
          <input id="fix" type="text" maxLength={MAX_NOTE} placeholder="Например: логотип чуть левее" enterKeyHint="send" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn" disabled={!text.trim() || busy}>Переделать</button>
        </div>
        {error ? <div className="err small">{error}</div> : null}
        {fixes.length ? <div className="caps">Правки</div> : null}
        {fixes.length ? (
          <ul className="plain fixes">
            {fixes.map((f) => (
              <li key={f.version}>
                <span className="mono">версия {f.version}</span>
                <span>{f.text} <span className="muted small">· {when(f.at)}</span></span>
              </li>
            ))}
          </ul>
        ) : null}
      </form>
    </>
  );
}

/** «Чек-лист по гайду»: строки vm render (result.json.checklist) и подпись к посту — её Claude пишет после рендера. */
function Checklist({ items, caption }: { items: Check[]; caption: boolean }) {
  const rows = [...items.map((c) => ({ key: c.id, title: c.title, ok: c.ok })), { key: 'caption', title: 'подпись к посту', ok: caption }];
  return (
    <div className="card" data-checklist>
      <div className="caps">Чек-лист по гайду</div>
      <ul className="plain marks grid2">
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
