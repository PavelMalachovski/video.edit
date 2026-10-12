'use client';
// Кадр превью: картинка кадра (нет — только слой: в редакторе под ним видео), поверх — прозрачный шаблон слоя (public/template/overlay.html — копия template/) в
// натуральную величину 1080×1920, уменьшенный до ширины `width`. Рисует его window.renderState шаблона — тот же,
// которым движок рисует кадры финала, поэтому превью совпадает с роликом по шрифту, размеру, цвету и месту.
// Рисуется только последнее: пока шаблон занят, новые состояния не копятся в очередь — после текущего он нарисует самое
// свежее (в редакторе слой меняется до 30 раз в секунду).
import { useEffect, useRef, useState } from 'react';
import type { StyleSpec } from '@/lib/jobfiles.ts';
import type { OverlayState } from '@/lib/style.ts';

type OverlayWindow = Window & {
  renderState?: (spec: StyleSpec, state: OverlayState | Record<string, unknown>, opts: { bar?: { progress: number } }) => Promise<void>;
  layoutBoxes?: () => unknown;
};
/** `onBoxes` — рамки нарисованного (window.layoutBoxes шаблона, px кадра) после каждой отрисовки: по ним ручки на превью.
 *  `progress` — шкала времени (0..1) рисует шаблон; нет — шкалы в слое нет (редактор рисует её сам: она бежит каждый кадр). */
type Props = {
  frameUrl: string | null; spec: StyleSpec; state: OverlayState | Record<string, unknown>; progress?: number | null; width: number; big?: boolean;
  onBoxes?: (boxes: unknown) => void;
};
type Draw = { spec: StyleSpec; state: Props['state']; progress: number | null };

export default function PreviewFrame({ frameUrl, spec, state, progress = null, width, big = false, onBoxes }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true);
  const boxes = useRef(onBoxes);
  boxes.current = onBoxes;
  const job = useRef<{ busy: boolean; next: Draw | null }>({ busy: false, next: null });

  useEffect(() => {  // шаблон мог загрузиться раньше, чем React повесил onLoad
    const win = ref.current?.contentWindow as OverlayWindow | null;
    if (ref.current?.contentDocument?.readyState === 'complete' && win?.renderState) setReady(true);
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    const win = ref.current?.contentWindow as OverlayWindow | null;
    if (!ready || !win?.renderState) return;
    const run = (d: Draw) => {
      job.current.busy = true;
      (win.renderState as NonNullable<OverlayWindow['renderState']>)(d.spec, d.state, d.progress === null ? {} : { bar: { progress: d.progress } }).then(
        () => {
          if (!live.current) return;
          setError('');
          boxes.current?.(win.layoutBoxes?.());
        },
        (e: unknown) => live.current && setError(e instanceof Error ? e.message : String(e)),
      ).finally(() => {
        job.current.busy = false;
        const next = job.current.next;
        job.current.next = null;
        if (next && live.current) run(next);
      });
    };
    const d = { spec, state, progress };
    if (job.current.busy) job.current.next = d; // нарисуется, когда шаблон освободится, — только самое свежее
    else run(d);
  }, [ready, spec, state, progress]);

  return (
    <div className={`preview${big ? ' big' : ''}`} style={{ width, height: Math.round((width * 1920) / 1080) }}>
      {frameUrl ? <img src={frameUrl} alt="" /> : null}
      <iframe ref={ref} src="/template/overlay.html" title="Слой ролика" tabIndex={-1} aria-hidden="true" onLoad={() => setReady(true)}
        data-spec={JSON.stringify(spec)} data-state={JSON.stringify(state)} data-progress={progress === null ? undefined : String(progress)}
        data-big={big ? '' : undefined} style={{ transform: `scale(${width / 1080})` }} />
      {error ? <div className="preview-error">{error}</div> : null}
    </div>
  );
}
