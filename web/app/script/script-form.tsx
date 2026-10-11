'use client';
// «Новый сценарий»: тема, цель, тип истории, длина и язык → POST /api/scripts → страница задачи-сценария.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { errorText, message, post } from '@/lib/client.ts';
import { GOALS, LANGUAGES, LENGTHS, MAX_LANGUAGE, STORIES, TOPIC, type Goal, type ScriptRequest, type StoryChoice } from '@/lib/script.ts';

export default function ScriptForm() {
  const router = useRouter();
  const [topic, setTopic] = useState('');
  const [goal, setGoal] = useState<Goal>('followers');
  const [story, setStory] = useState<StoryChoice>('any');
  const [length, setLength] = useState<ScriptRequest['length']>(30);
  const [language, setLanguage] = useState<string>(LANGUAGES[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = topic.trim().length >= TOPIC.min && language.trim() !== '' && !busy;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const r = await post('/api/scripts', { topic, goal, story, length, language });
      if (!r.ok) throw new Error(await errorText(r, 'Сценарий не запустился'));
      const { jobId } = (await r.json()) as { jobId: string };
      router.push(`/jobs/${jobId}`);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <label htmlFor="topic" className="label">О чём ролик</label>
        <textarea id="topic" rows={3} maxLength={TOPIC.max} placeholder="Например: как я учу чешский по 15 минут в день" value={topic}
          onChange={(e) => setTopic(e.target.value)} />
      </div>
      <div className="card">
        <div className="caps small">Цель</div>
        <div className="pills">
          {GOALS.map((g) => <button key={g.id} type="button" className="pill" aria-pressed={goal === g.id} onClick={() => setGoal(g.id)}>{g.label}</button>)}
        </div>
      </div>
      <div className="card">
        <div className="caps small">Тип истории</div>
        <div className="pills">
          {STORIES.map((s) => <button key={s.id} type="button" className="pill" aria-pressed={story === s.id} onClick={() => setStory(s.id)}>{s.label}</button>)}
        </div>
      </div>
      <div className="card">
        <div className="caps small">Длина</div>
        <div className="pills">
          {LENGTHS.map((n) => <button key={n} type="button" className="pill" aria-pressed={length === n} onClick={() => setLength(n)}>{n} с</button>)}
        </div>
      </div>
      <div className="card">
        <div className="caps small">Язык ролика</div>
        <div className="pills">
          {LANGUAGES.map((l) => <button key={l} type="button" className="pill" aria-pressed={language === l} onClick={() => setLanguage(l)}>{l}</button>)}
        </div>
        <input type="text" aria-label="Другой язык" placeholder="Другой язык" maxLength={MAX_LANGUAGE}
          value={(LANGUAGES as readonly string[]).includes(language) ? '' : language} onChange={(e) => setLanguage(e.target.value || LANGUAGES[0])} />
      </div>
      <button type="button" className="btn" disabled={!ready} onClick={() => void submit()}>{busy ? 'Запускаю…' : 'Написать сценарий'}</button>
      {error ? <div className="err small">{error}</div> : null}
    </>
  );
}
