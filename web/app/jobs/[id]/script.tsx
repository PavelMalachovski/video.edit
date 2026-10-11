'use client';
// Экран «Сценарий готов» (script.json): хуки — Павел выбирает один, раскадровка по частям гайда, призыв, советы к
// съёмке и подпись к посту. «Снять по сценарию» кладёт ТЗ в браузер и открывает загрузку — она его подставит.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { captionCopy } from '@/lib/caption.ts';
import { storage } from '@/lib/client.ts';
import { mmss } from '@/lib/format.ts';
import { PARTS, saveNextBrief, scriptBrief, STORIES, TECHNIQUES, type Script, type ScriptRequest } from '@/lib/script.ts';
import { TopBar } from '../../top-bar';

export default function ScriptView({ title, script, request }: { title: string; script: Script; request: ScriptRequest | null }) {
  const router = useRouter();
  const [hook, setHook] = useState(0);
  const story = STORIES.find((s) => s.id === script.story)?.label ?? script.story;

  function shoot() {
    saveNextBrief(storage(), scriptBrief(script, request?.language ?? null, hook));
    router.push('/');
  }

  return (
    <div className="script" data-script>
      <TopBar back={{ href: '/', label: 'Мои видео' }} title={title}
        meta={[story, request ? `${request.length} с` : null, request?.language].filter(Boolean).join(' · ')} />
      <div className="card">
        <div className="caps small">Хук на первые 2 секунды — выбери один</div>
        {script.hooks.map((h, i) => (
          <button key={i} type="button" className="hook-pick" aria-pressed={hook === i} data-hook onClick={() => setHook(i)}>
            <span className="caps small">{TECHNIQUES[h.technique]}</span>
            <b>{h.text}</b>
            {h.frame ? <span className="muted small">{h.frame}</span> : null}
          </button>
        ))}
      </div>
      <div className="card">
        <div className="caps small">Раскадровка</div>
        {(Object.keys(PARTS) as (keyof typeof PARTS)[]).map((part) => {
          const scenes = script.scenes.filter((c) => c.part === part);
          return scenes.length ? (
            <div key={part} className="scene-part">
              <div className="label">{PARTS[part]}</div>
              {scenes.map((c, i) => (
                <div key={i} className="scene" data-scene>
                  <div className="mono">{mmss(c.t0)}–{mmss(c.t1)}</div>
                  <div>{c.say}</div>
                  {c.screen ? <div className="small">На экране: <b>{c.screen}</b></div> : null}
                  <div className="muted small">В кадре: {c.frame}</div>
                  {c.sound ? <div className="muted small">Звук: {c.sound}</div> : null}
                </div>
              ))}
            </div>
          ) : null;
        })}
      </div>
      <div className="card">
        <div className="caps small">Призыв в конце</div>
        <div>{script.cta}</div>
      </div>
      <div className="card">
        <div className="caps small">Как снимать</div>
        <ul className="plain">{script.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
      </div>
      <div className="card">
        <div className="caps small">Подпись к посту</div>
        <div className="pre">{captionCopy(script.caption)}</div>
      </div>
      <button type="button" className="btn" onClick={shoot}>Снять по сценарию</button>
      <div className="muted small">Откроется загрузка с ТЗ по сценарию — хук, тезисы, призыв. Сними видео и загрузи его.</div>
    </div>
  );
}
