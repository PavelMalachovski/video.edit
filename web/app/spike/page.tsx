'use client';
import { useState } from 'react';

export default function Spike() {
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  async function fire() {
    setBusy(true);
    const r = await fetch('/api/spike/fire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setOut(JSON.stringify(await r.json(), null, 1));
    setBusy(false);
  }
  return (
    <main>
      <h1>Проверка рутины</h1>
      <div className="card">
        <div className="muted">Запускает рутину video-edit с шагом spike: она создаёт ветку claude/job-… и трижды пишет статус.</div>
        <button onClick={fire} disabled={busy}>{busy ? 'Запускаю…' : 'Запустить тест рутины'}</button>
        {out ? <pre style={{ whiteSpace: 'pre-wrap' }}><code>{out}</code></pre> : null}
      </div>
    </main>
  );
}
