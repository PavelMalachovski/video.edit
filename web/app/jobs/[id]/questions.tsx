'use client';
// Экран «2 · Вопросы»: карточка на вопрос из questions.json — варианты кнопками, свой текст, своя картинка.
// Черновик ответов живёт у страницы задачи (его же читают превью); «Показать превью» — без запроса к серверу.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildAnswers, DIM, dimPercent, pick, pictureAsset, setDimPercent, type Draft, type LocalUpload } from '@/lib/answers.ts';
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
        {review.items.map((it, i) => (
          <li key={i} data-status={it.status}>
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
      <div className="q-head"><span className="q-num">{String(n).padStart(2, '0')}</span><span className="q-title">{q.title}</span></div>
      <div className={q.image ? 'q-row' : undefined}>
        {q.image ? <img className="q-image" src={fileUrl(q.image)} alt="" /> : null}
        {q.body ? <div className="q-body">{q.body}</div> : null}
      </div>
      {q.type === 'text' ? (
        <input type="text" aria-label={q.title} value={draft.texts[q.id] ?? ''} onChange={(e) => setText(e.target.value, false)} />
      ) : q.layout === 'frames' ? (
        <div className="frame-picks">
          {pills.map((o) => (
            <button key={o.id} type="button" className="frame-pick" aria-pressed={picked.includes(o.id)} onClick={() => onDraft((d) => pick(d, q, o.id))}>
              {o.image ? <img src={fileUrl(o.image)} alt="" /> : <span className="frame-blank" />}
              <span className="frame-label">{o.label}</span>
            </button>
          ))}
          {q.id === DIM.id ? <DimSlider q={q} draft={draft} onDraft={onDraft} fileUrl={fileUrl} /> : null}
        </div>
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

/** «Фон» ползунком: любое затемнение 0–80 % через 5, кадр показывает его сразу. Кадр считается из картинок вариантов
 *  «Как есть» и «на 50 %»: затемнение по маске линейно (фон темнеет пропорционально), так что любое — между ними или
 *  дальше по той же прямой. Картинок нет — только ползунок. */
function DimSlider({ q, draft, onDraft, fileUrl }: { q: Question; draft: Draft; onDraft: ChangeDraft; fileUrl: (path: string) => string }) {
  const percent = dimPercent(q, draft);
  const image = (id: string) => q.options?.find((o) => o.id === id)?.image;
  const plain = image('none');
  const half = image('50');
  return (
    <div className="dim-slider">
      {plain && half ? <DimFrame plain={fileUrl(plain)} half={fileUrl(half)} percent={percent} /> : null}
      <label className="dim-range">
        <span className="dim-head">Насколько темнее фон <b>{percent ? `${percent} %` : 'как есть'}</b></span>
        <input type="range" min={DIM.min} max={DIM.max} step={DIM.step} value={percent} aria-label="Насколько темнее фон"
          onChange={(e) => onDraft((d) => setDimPercent(d, q, Number(e.target.value)))} />
      </label>
    </div>
  );
}

type Pixels = { w: number; h: number; plain: Uint8ClampedArray; half: Uint8ClampedArray };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(src));
    img.src = src;
  });
}

/** Кадр с затемнением `percent`: каждая точка — «как есть» + percent/50 × (на 50 % − как есть). */
function DimFrame({ plain, half, percent }: { plain: string; half: string; percent: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pixels, setPixels] = useState<Pixels | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all([loadImage(plain), loadImage(half)]).then(([a, b]) => {
      const w = Math.min(360, a.naturalWidth);
      const h = Math.round((w * a.naturalHeight) / a.naturalWidth);
      const read = (img: HTMLImageElement) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h).data;
      };
      if (alive && w > 0 && h > 0) setPixels({ w, h, plain: read(a), half: read(b) });
    }).catch(() => undefined); // картинки не открылись — остаётся ползунок
    return () => { alive = false; };
  }, [plain, half]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !pixels) return;
    c.width = pixels.w;
    c.height = pixels.h;
    const ctx = c.getContext('2d')!;
    const out = ctx.createImageData(pixels.w, pixels.h);
    const k = percent / 50;
    for (let i = 0; i < out.data.length; i++) out.data[i] = pixels.plain[i] + k * (pixels.half[i] - pixels.plain[i]);
    for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
    ctx.putImageData(out, 0, 0);
  }, [pixels, percent]);
  return pixels ? <canvas ref={canvas} className="dim-frame" data-percent={percent} aria-label={`Кадр: фон темнее на ${percent} %`} role="img" /> : null;
}
