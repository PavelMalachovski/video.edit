// Тулбар экранов «Монтажки»: квадратная «назад» (ссылка или кнопка), заголовок со строкой моноширинным, справа —
// главное действие экрана. На экране у «назад» только стрелка — подпись для читалок и голосового управления.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BackIcon } from './icons';

type Back = { href: string; label: string } | { onClick: () => void; label: string };
type Props = { back?: Back; title: ReactNode; meta?: ReactNode; done?: boolean; action?: ReactNode };

export function TopBar({ back, title, meta, done = false, action }: Props) {
  return (
    <header className="toolbar">
      {back ? ('href' in back
        ? <Link href={back.href} className="tb-back" aria-label={back.label}><BackIcon /></Link>
        : <button type="button" className="tb-back" aria-label={back.label} onClick={back.onClick}><BackIcon /></button>) : null}
      <div className="tb-title">
        <h1>{title}{done ? <span className="live-dot" aria-hidden="true" /> : null}</h1>
        {meta ? <div className="tb-meta">{meta}</div> : null}
      </div>
      {action}
    </header>
  );
}
