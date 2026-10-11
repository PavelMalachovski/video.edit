'use client';
// Состояние шага на странице задачи: идёт (фаза, текст, полоса), «завис», ошибка, не запущен, ещё загружается.
import { useState } from 'react';
import type { Action, JobView } from '@/lib/jobview.ts';
import type { Step } from '@/lib/routine.ts';
import type { Act } from './job';

const minutes = (at: string, now: number): number => Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));

/** Куда вернуться, если шаг сорвался из-за входных данных: повтор с теми же данными сорвётся снова. */
const BACK: Partial<Record<Step, string>> = { restyle: 'Вернуться к превью', render: 'Изменить ответы', fix: 'Вернуть готовый ролик' };

function ago(at: string, now: number): string {
  const n = minutes(at, now);
  return n < 1 ? 'только что' : `${n} мин назад`;
}

/** Кнопка действия: пока запрос идёт — выключена; отказ сервера (409, 502…) — текстом под ней. */
export function ActionButton({ label, action, onAction, primary = false }: { label: string; action: Action; onAction: Act; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="action">
      <button type="button" className={primary ? 'btn' : 'btn ghost'} disabled={busy} onClick={async () => {
        setBusy(true);
        setError('');
        const why = await onAction(action);
        setBusy(false);
        if (why) setError(why);
      }}>
        {label}
      </button>
      {error ? <div className="err small">{error}</div> : null}
    </div>
  );
}

export default function Phases({ view, repo, onAction }: { view: JobView; repo: string; onAction: Act }) {
  const status = view.status;
  const now = Date.now();
  const session = view.sessionUrl ? <a className="btn ghost" href={view.sessionUrl} target="_blank" rel="noreferrer">Открыть сессию</a> : null;
  const previous = view.previous ? (
    <a className="small" href={`/api/jobs/${view.id}/download?name=${encodeURIComponent(view.previous)}`}>Предыдущая версия</a>
  ) : null;

  if (view.screen === 'uploading') {
    return (
      <div className="card">
        <b>Видео ещё загружается</b>
        <div className="muted">Если загрузка прервалась — на главной выберите тот же файл, она продолжится.</div>
      </div>
    );
  }
  if (view.screen === 'not_started') {
    return (
      <div className="card">
        <b>Анализ не запущен</b>
        <div className="muted">Видео загружено. Claude расшифрует речь и задаст вопросы.</div>
        <ActionButton label="Запустить анализ" action="start" onAction={onAction} primary />
      </div>
    );
  }
  if (view.screen === 'error') {
    return (
      <div className="card bad">
        <b>{status?.message ?? 'Шаг не получился'}</b>
        {status?.error ? <div className="mono muted small pre">{status.error}</div> : null}
        <ActionButton label="Повторить" action="retry" onAction={onAction} primary />
        {view.step && BACK[view.step] ? <ActionButton label={BACK[view.step]!} action="back" onAction={onAction} /> : null}
        {session}
        {previous}
      </div>
    );
  }
  if (view.stuck === 'session' && status) {
    return (
      <div className="card alert">
        <b>Похоже, Claude застрял: статус не менялся {minutes(status.at, now)} мин</b>
        <div className="muted">Последняя фаза — «{status.phase}». Можно перезапустить шаг: Claude продолжит с того, что уже сделал.</div>
        <ActionButton label="Перезапустить шаг" action="retry" onAction={onAction} primary />
        {session}
      </div>
    );
  }
  if (view.stuck === 'delivery') {
    return (
      <div className="card alert">
        <b>Ролик собран, но не перенесён в релиз — посмотрите Actions</b>
        <a href={`https://github.com/${repo}/actions`} target="_blank" rel="noreferrer">GitHub Actions</a>
        <ActionButton label="Повторить" action="retry" onAction={onAction} />
        {previous}
      </div>
    );
  }
  const pct = typeof status?.progress === 'number' ? Math.round(Math.min(1, Math.max(0, status.progress)) * 100) : null;
  return (
    <div className="card">
      <div className="phase">{status?.phase ?? 'Работаю'}</div>
      {status?.message ? <div className="dim">{status.message}</div> : null}
      {pct !== null ? <div className="bar"><div style={{ width: `${pct}%` }} /></div> : null}
      {status ? (
        <div className="row updated">
          <span>обновлено {ago(status.at, now)}</span>
          {pct !== null ? <span>{pct}%</span> : null}
        </div>
      ) : null}
      {previous}
    </div>
  );
}
