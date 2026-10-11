'use client';
// Экран «2 · Вопросы»: карточка на вопрос из questions.json — варианты кнопками, свой текст, своя картинка.
// Черновик ответов живёт у страницы задачи (его же читают превью); «Показать превью» — без запроса к серверу.
import { useMemo, useState } from 'react';
import { buildAnswers, pick, pictureAsset, type Draft, type LocalUpload } from '@/lib/answers.ts';
import { RESERVED, type Question, type Review } from '@/lib/jobfiles.ts';
import { MAX_ANSWER_IMAGE_BYTES } from '@/lib/jobs.ts';
import { planChunks, runUpload } from '@/lib/uploader.ts';

const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export type ChangeDraft = (update: (d: Draft) => Draft) => void;

type Props = {
  jobId: string;
  releaseId: number;
  questions: Question[];
  review: Review | null;
  draft: Draft;
  onDraft: ChangeDraft;
  fileUrl: (path: string) => string;
  localUrls: Record<string, string>;
  onLocalUrl: (qid: string, url: string) => void;
  onPreview: () => void;
};

export default function Questions({ jobId, releaseId, questions, review, draft, onDraft, fileUrl, localUrls, onLocalUrl, onPreview }: Props) {
  const { missing } = useMemo(() => buildAnswers(questions, draft), [questions, draft]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, number>>({}); // доля загруженного по вопросам

  /** Своя картинка к ответу: проверка, затем куски ассетом `upload-q-<id>[-n].<ext>` черновика задачи. */
  async function uploadPicture(q: Question, file: File) {
    setErrors(({ [q.id]: _, ...rest }) => rest);
    if (!PICTURE_TYPES.includes(file.type)) return setErrors((e) => ({ ...e, [q.id]: `${file.name}: нужна картинка PNG, JPEG, WebP или GIF` }));
    if (file.size > MAX_ANSWER_IMAGE_BYTES) return setErrors((e) => ({ ...e, [q.id]: `${file.name}: больше 20 МБ` }));
    if (file.size === 0) return setErrors((e) => ({ ...e, [q.id]: `${file.name}: пустой файл` }));
    const before = draft.uploads[q.id];
    let taken = new Set<string>(); // ассеты, у которых уже есть куски в черновике (прошлые выборы, даже из другой вкладки)
    try {
      const r = await fetch(`/api/jobs/${jobId}/parts?release=${releaseId}`, { cache: 'no-store' });
      if (r.ok) taken = new Set(((await r.json()) as { name: string }[]).map((a) => a.name.replace(/\.part-\d{5}$/, '')));
    } catch {
      // не узнали — хватит номера из черновика
    }
    const { asset, n } = pictureAsset(q.id, file.name, file.type, taken, before ? (before.n ?? 1) + 1 : 1);
    const chunks = planChunks([{ asset, size: file.size }]);
    const local: LocalUpload = { asset, name: file.name, size: file.size, type: file.type, parts: chunks.length, done: false, n };
    onLocalUrl(q.id, URL.createObjectURL(file));
    onDraft((d) => pick({ ...d, uploads: { ...d.uploads, [q.id]: local } }, q, RESERVED.upload));
    setLoading((l) => ({ ...l, [q.id]: 0 }));
    try {
      await runUpload({
        parts: chunks.length,
        concurrency: 2,
        minGapMs: 700,
        onProgress: (count) => setLoading((l) => ({ ...l, [q.id]: count / chunks.length })),
        put: async (i) => {
          const c = chunks[i];
          const r = await fetch(`/api/jobs/${jobId}/parts/${c.index}?release=${releaseId}&file=${encodeURIComponent(asset)}`, {
            method: 'PUT', body: file.slice(c.start, c.end), headers: { 'Content-Type': 'application/octet-stream' },
          });
          return r.ok ? { ok: true } : { ok: false, status: r.status };
        },
      });
      onDraft((d) => (d.uploads[q.id]?.asset === asset ? { ...d, uploads: { ...d.uploads, [q.id]: { ...local, done: true } } } : d));
    } catch {
      setErrors((e) => ({ ...e, [q.id]: `${file.name}: не загрузилась — выберите её ещё раз` }));
    } finally {
      setLoading(({ [q.id]: _, ...rest }) => rest);
    }
  }

  return (
    <>
      <p className="lead">Посмотрел видео. Ответь на вопросы — и я покажу три варианта кадра.</p>
      {review ? <ReviewCard review={review} /> : null}
      {questions.map((q, i) => (
        <QuestionCard key={q.id} q={q} n={i + 1} draft={draft} onDraft={onDraft} need={missing.includes(q.id)} fileUrl={fileUrl}
          localUrl={localUrls[q.id] ?? null} loading={loading[q.id]} error={errors[q.id] ?? ''} onPicture={(f) => void uploadPicture(q, f)} />
      ))}
      <button type="button" className="btn" disabled={missing.length > 0} onClick={onPreview}>Показать превью</button>
      {missing.length ? <div className="muted small">Нужен ответ: {missing.length === 1 ? 'один вопрос' : `вопросов — ${missing.length}`} (подсвечены)</div> : null}
    </>
  );
}

/** «Разбор по гайду» (review.json): что по гайду Meta уже хорошо и что стоит поправить. */
function ReviewCard({ review }: { review: Review }) {
  return (
    <div className="card" data-review>
      <div className="caps small">Разбор по гайду</div>
      <ul className="plain marks">
        {review.items.map((it) => (
          <li key={it.id} data-status={it.status}>
            <span className="mark" aria-label={it.status === 'ok' ? 'по гайду' : 'стоит поправить'}>{it.status === 'ok' ? '✓' : '!'}</span>
            <div><b>{it.title}</b><div className="muted small">{it.note}</div></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

type CardProps = {
  q: Question;
  n: number;
  draft: Draft;
  onDraft: ChangeDraft;
  need: boolean;
  fileUrl: (path: string) => string;
  localUrl: string | null;
  loading: number | undefined;
  error: string;
  onPicture: (file: File) => void;
};

function QuestionCard({ q, n, draft, onDraft, need, fileUrl, localUrl, loading, error, onPicture }: CardProps) {
  const picked = draft.picks[q.id] ?? [];
  const options = q.options ?? [];
  const own = options.find((o) => o.id === RESERVED.own);
  const upload = options.find((o) => o.id === RESERVED.upload);
  const pills = options.filter((o) => o !== own && o !== upload);
  const up = draft.uploads[q.id];
  const setText = (text: string, chooseOwn: boolean) =>
    onDraft((d) => {
      const next = { ...d, texts: { ...d.texts, [q.id]: text } };
      return chooseOwn && text.trim() ? pick(next, q, RESERVED.own) : next;
    });

  return (
    <section className={`card question${need ? ' need' : ''}`} data-question={q.id}>
      <div className="caps">{n} · {q.title}</div>
      <div className={q.image ? 'q-row' : undefined}>
        {q.image ? <img className="q-image" src={fileUrl(q.image)} alt="" /> : null}
        {q.body ? <div className="q-body">{q.body}</div> : null}
      </div>
      {q.type === 'text' ? (
        <input type="text" aria-label={q.title} value={draft.texts[q.id] ?? ''} onChange={(e) => setText(e.target.value, false)} />
      ) : (
        <div className="pills">
          {pills.map((o) => (
            <button key={o.id} type="button" className="pill" aria-pressed={picked.includes(o.id)} onClick={() => onDraft((d) => pick(d, q, o.id))}>
              {o.image ? <img src={fileUrl(o.image)} alt="" /> : null}
              {o.label}
            </button>
          ))}
          {upload ? (
            <label className={`pill${picked.includes(RESERVED.upload) ? ' on' : ''}`}>
              {upload.label}
              <input type="file" accept={PICTURE_TYPES.join(',')} hidden
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPicture(f); }} />
            </label>
          ) : null}
        </div>
      )}
      {up && picked.includes(RESERVED.upload) ? (
        <div className="upload-row">
          <span className="thumb">{localUrl ? <img src={localUrl} alt="" /> : null}</span>
          <span className="grow">{up.name}</span>
          <span className="muted small">{up.done ? 'Загружено' : loading !== undefined ? `Загружаю… ${Math.round(loading * 100)}%` : 'Не догрузилась — выберите ещё раз'}</span>
        </div>
      ) : null}
      {own ? (
        <label className="own">
          Или напиши свой
          <input type="text" className={picked.includes(RESERVED.own) ? 'on' : undefined} placeholder={own.label} value={draft.texts[q.id] ?? ''}
            onChange={(e) => setText(e.target.value, true)} />
        </label>
      ) : null}
      {error ? <div className="err small">{error}</div> : null}
    </section>
  );
}
