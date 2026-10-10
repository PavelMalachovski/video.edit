'use client';
// Кадр превью: картинка кадра, поверх — прозрачный шаблон слоя (public/template/overlay.html — копия template/) в
// натуральную величину 1080×1920, уменьшенный до ширины `width`. Рисует его window.renderState шаблона — тот же,
// которым движок рисует кадры финала, поэтому превью совпадает с роликом по шрифту, размеру, цвету и месту.
import { useEffect, useRef, useState } from 'react';
import type { StyleSpec } from '@/lib/jobfiles.ts';
import type { OverlayState } from '@/lib/style.ts';

type OverlayWindow = Window & { renderState?: (spec: StyleSpec, state: OverlayState, opts: { bar: { progress: number } }) => Promise<void> };
type Props = { frameUrl: string; spec: StyleSpec; state: OverlayState; progress: number; width: number; big?: boolean };

export default function PreviewFrame({ frameUrl, spec, state, progress, width, big = false }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {  // шаблон мог загрузиться раньше, чем React повесил onLoad
    const win = ref.current?.contentWindow as OverlayWindow | null;
    if (ref.current?.contentDocument?.readyState === 'complete' && win?.renderState) setReady(true);
  }, []);

  useEffect(() => {
    const win = ref.current?.contentWindow as OverlayWindow | null;
    if (!ready || !win?.renderState) return;
    let live = true;
    win.renderState(spec, state, { bar: { progress } }).then(
      () => live && setError(''),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [ready, spec, state, progress]);

  return (
    <div className={`preview${big ? ' big' : ''}`} style={{ width, height: Math.round((width * 1920) / 1080) }}>
      <img src={frameUrl} alt="" />
      <iframe ref={ref} src="/template/overlay.html" title="Слой ролика" tabIndex={-1} aria-hidden="true" onLoad={() => setReady(true)}
        data-spec={JSON.stringify(spec)} data-state={JSON.stringify(state)} data-progress={String(progress)} data-big={big ? '' : undefined}
        style={{ transform: `scale(${width / 1080})` }} />
      {error ? <div className="preview-error">{error}</div> : null}
    </div>
  );
}
