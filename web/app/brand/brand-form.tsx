'use client';
// «Мой бренд»: ник, цвета, шрифты, логотип, подпись к постам и хэштеги. Новая задача берёт копию бренда: стиль A —
// его шрифты и цвета, финальная карточка — ник и логотип, подпись к посту — подпись и хэштеги. Превью рисует тот же
// шаблон слоя, что ролик.
import { useEffect, useMemo, useState } from 'react';
import { lookLines, type BrandLook } from '@/lib/brand.ts';
import { errorText, JSON_HEADERS, message } from '@/lib/client.ts';
import type { StyleSpec } from '@/lib/jobfiles.ts';
import { SWATCHES, type OverlayState } from '@/lib/style.ts';
import PreviewFrame from '../preview-frame';

type FontEntry = { id: string; family: string; file: string; kind: 'main' | 'hand' };
type Colors = { text: string; accent: string; bar: string };
type Saved = {
  handle: string | null; colors: Colors | null; font: string | null; hand: string | null; logo: string | null;
  signature: string | null; hashtags: string[]; look?: BrandLook;
};
type Logo = { kind: 'saved'; url: string } | { kind: 'new'; url: string; type: string; base64: string } | { kind: 'none' };

const MAX_LOGO = 2 * 1024 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
// стиль A из правил монтажа (SKILL.md, раздел 2 — стиль эталона): бренд меняет в нём шрифты и цвета
const STYLE_A: StyleSpec = {
  font: 'forum', hand: 'caveat',
  colors: { text: '#FFFFFF', accent: '#EDE4C1', bar: '#EDE4C1', plate: '#111111', outline: '#000000' },
  subtitles: { mode: 'soft', words: 3, size: 64, y: 1440 },
  hook: { mode: 'accent', size: 108, y: 420 },
  bar: { pos: 'bottom', height: 6 },
};
const SAMPLE: OverlayState = {
  hook: { text: 'так выглядит мой бренд' }, sub: { words: ['это', 'мои', 'субтитры'], active: 0, visible: 3, lines: [3] }, inserts: [],
};
const BACKDROP = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
  + '<stop offset="0" stop-color="#4B5563"/><stop offset="1" stop-color="#1F2937"/></linearGradient></defs>'
  + '<rect width="1080" height="1920" fill="url(#g)"/></svg>',
)}`;
const ROWS: { key: keyof Colors; title: string; own: string }[] = [
  { key: 'accent', title: 'Подсветка', own: 'Своя подсветка' },
  { key: 'text', title: 'Текст', own: 'Свой цвет текста' },
  { key: 'bar', title: 'Шкала времени', own: 'Свой цвет шкалы' },
];

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error('файл не читается'));
    r.readAsDataURL(file);
  });
}

export default function BrandForm() {
  const [loaded, setLoaded] = useState(false);
  const [handle, setHandle] = useState('');
  const [colors, setColors] = useState<Colors>({ text: STYLE_A.colors.text, accent: STYLE_A.colors.accent, bar: STYLE_A.colors.bar });
  const [font, setFont] = useState(STYLE_A.font);
  const [hand, setHand] = useState(STYLE_A.hand);
  const [logo, setLogo] = useState<Logo>({ kind: 'none' });
  const [logoTouched, setLogoTouched] = useState(false);
  const [signature, setSignature] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [look, setLook] = useState<BrandLook | null>(null);

  const apply = (b: Saved | null, version: string | null) => {
    setHandle(b?.handle ?? '');
    if (b?.colors) setColors(b.colors);
    if (b?.font) setFont(b.font);
    if (b?.hand) setHand(b.hand);
    setLogo(b?.logo && version ? { kind: 'saved', url: `/api/brand/logo?v=${version}` } : { kind: 'none' });
    setLogoTouched(false);
    setSignature(b?.signature ?? '');
    setHashtags((b?.hashtags ?? []).map((t) => `#${t}`).join(' '));
    setLook(b?.look ?? null);
  };

  async function removeLook() {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch('/api/brand/look', { method: 'DELETE' });
      if (!r.ok) throw new Error(await errorText(r, 'Не получилось убрать'));
      setLook(null);
      setNote({ ok: true, text: '«Мой стиль» убран — новые ролики начнутся с вариантов Claude' });
    } catch (e) {
      setNote({ ok: false, text: message(e) });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let live = true;
    fetch('/api/brand')
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorText(r, 'Бренд не загрузился'));
        return r.json() as Promise<{ brand: Saved | null; logoVersion: string | null }>;
      })
      .then((d) => live && apply(d.brand, d.logoVersion))
      .catch((e: unknown) => live && setNote({ ok: false, text: message(e) }))
      .finally(() => live && setLoaded(true));
    fetch('/template/fonts.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: FontEntry[]) => {
        if (!live) return;
        setFonts(list);
        for (const f of list) {
          const face = new FontFace(`pv-${f.id}`, `url("/template/${f.file}")`, { weight: '1 1000' });
          document.fonts.add(face);
          void face.load().catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => () => {
    if (logo.kind === 'new') URL.revokeObjectURL(logo.url);
  }, [logo]);

  const spec = useMemo<StyleSpec>(() => ({ ...STYLE_A, font, hand, colors: { ...STYLE_A.colors, ...colors } }), [font, hand, colors]);

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) return setNote({ ok: false, text: 'Логотип — PNG, JPEG или WebP' });
    if (file.size > MAX_LOGO) return setNote({ ok: false, text: 'Логотип больше 2 МБ — уменьшите его' });
    try {
      setLogo({ kind: 'new', url: URL.createObjectURL(file), type: file.type, base64: await readFile(file) });
      setLogoTouched(true);
      setNote(null);
    } catch (e) {
      setNote({ ok: false, text: message(e) });
    }
  }

  async function save() {
    setBusy(true);
    setNote(null);
    const body: Record<string, unknown> = { handle, colors, font, hand, signature, hashtags };
    if (logoTouched) body.logo = logo.kind === 'new' ? { type: logo.type, base64: logo.base64 } : null;
    try {
      const r = await fetch('/api/brand', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(await errorText(r, 'Не сохранилось'));
      const d = (await r.json()) as { brand: Saved; logoVersion: string | null };
      apply(d.brand, d.logoVersion);
      setNote({ ok: true, text: 'Сохранено — новые ролики возьмут этот бренд' });
    } catch (e) {
      setNote({ ok: false, text: message(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="muted">Загружаю…</div>;
  return (
    <>
      <div className="screen-stage">
        <PreviewFrame frameUrl={BACKDROP} spec={spec} state={SAMPLE} progress={0.4} width={234} />
      </div>

      <div className="card">
        <label htmlFor="handle" className="label">Ник в Instagram</label>
        <input id="handle" type="text" inputMode="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="@your.name"
          maxLength={31} value={handle} onChange={(e) => setHandle(e.target.value)} />
        <div className="muted small">Будет в финальной карточке ролика.</div>
      </div>

      <div className="card">
        <div className="label">Логотип</div>
        <div className="upload-row">
          {logo.kind !== 'none' ? <img className="brand-logo" src={logo.url} alt="Логотип" /> : <span className="muted small">Логотипа нет</span>}
        </div>
        <div className="two">
          <label className="btn ghost">
            {logo.kind === 'none' ? 'Выбрать' : 'Заменить'}
            <input type="file" accept={LOGO_TYPES.join(',')} hidden onChange={(e) => void pickLogo(e.target.files?.[0])} />
          </label>
          <button type="button" className="btn ghost" disabled={logo.kind === 'none'} onClick={() => {
            setLogo({ kind: 'none' });
            setLogoTouched(true);
          }}>Убрать</button>
        </div>
        <div className="muted small">PNG, JPEG или WebP до 2 МБ. Только в финальной карточке.</div>
      </div>

      <div className="card">
        <div className="caps small">Шрифт — субтитры и хук</div>
        <div className="font-grid">
          {fonts.filter((f) => f.kind === 'main').map((f) => (
            <button key={f.id} type="button" className="font" aria-pressed={font === f.id} style={{ fontFamily: `"pv-${f.id}", var(--font-ui)` }}
              onClick={() => setFont(f.id)}>{f.family}</button>
          ))}
        </div>
        <div className="caps small">Рукописный — для хука и кодового слова</div>
        <div className="font-grid">
          {fonts.filter((f) => f.kind === 'hand').map((f) => (
            <button key={f.id} type="button" className="font hand" aria-pressed={hand === f.id} style={{ fontFamily: `"pv-${f.id}", var(--font-ui)` }}
              onClick={() => setHand(f.id)}>{f.family}</button>
          ))}
        </div>
        <div className="muted small">Если в шрифте нет букв ролика (другой язык), монтаж возьмёт ближайший.</div>
      </div>

      <div className="card">
        {ROWS.map((row) => (
          <div key={row.key} className="swatch-row">
            <div className="caps small">{row.title}</div>
            <div className="swatches">
              {SWATCHES[row.key].map((s) => (
                <button key={s.color} type="button" className="swatch" aria-label={s.name} aria-pressed={colors[row.key] === s.color}
                  onClick={() => setColors({ ...colors, [row.key]: s.color })}>
                  <span style={{ background: s.color }} />
                </button>
              ))}
              <label className="own-color">
                <input type="color" aria-label={row.own} value={colors[row.key].toLowerCase()}
                  onChange={(e) => setColors({ ...colors, [row.key]: e.target.value.toUpperCase() })} />
                Свой
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <label htmlFor="signature" className="label">Подпись к постам</label>
        <textarea id="signature" rows={3} maxLength={300} placeholder="Например: Пишите в директ — отвечу лично" value={signature}
          onChange={(e) => setSignature(e.target.value)} />
        <label htmlFor="hashtags" className="label">Хэштеги</label>
        <input id="hashtags" type="text" autoCapitalize="none" placeholder="#монтаж #reels" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
        <div className="muted small">Подпись и хэштеги Claude добавит к подписи к посту.</div>
      </div>

      <div className="card" data-my-look>
        <div className="caps small">Мой стиль</div>
        {look ? (
          <>
            <div className="small">Из ролика «{look.from.title}», {new Date(look.from.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}. Новые ролики начинаются с него: превью, скорость, «Фон» и «Музыка».</div>
            <ul className="plain dots small">{lookLines(look, (id) => fonts.find((x) => x.id === id)?.family ?? id).map((line) => <li key={line}>{line}</li>)}</ul>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void removeLook()}>Убрать мой стиль</button>
          </>
        ) : (
          <div className="muted small">Смонтируйте ролик как нравится и на экране «Готово» нажмите «Сохранить стиль ролика в «Мой бренд»» — следующие ролики начнутся с него.</div>
        )}
      </div>

      <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{busy ? 'Сохраняю…' : 'Сохранить'}</button>
      {note ? <div className={note.ok ? 'ok small' : 'err small'} role="status">{note.text}</div> : null}
    </>
  );
}
