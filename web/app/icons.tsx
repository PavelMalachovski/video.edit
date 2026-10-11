// Значки «Монтажки» (24×24, обводка цветом текста — currentColor) — только украшение, подписи у кнопок свои.
import type { ReactNode } from 'react';

type P = { size?: number };

function Stroke({ size = 20, width = 2, children }: { size?: number; width?: number; children: ReactNode }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export const UploadIcon = ({ size = 26 }: P) => <Stroke size={size} width={2.4}><path d="M12 16V4" /><path d="M6 10l6-6 6 6" /><path d="M4 20h16" /></Stroke>;
export const PlusIcon = ({ size = 18 }: P) => <Stroke size={size} width={2.4}><path d="M12 5v14" /><path d="M5 12h14" /></Stroke>;
export const CloseIcon = ({ size = 16 }: P) => <Stroke size={size} width={2.2}><path d="M6 6l12 12" /><path d="M18 6L6 18" /></Stroke>;
export const BackIcon = ({ size = 20 }: P) => <Stroke size={size} width={2.2}><path d="M15 6l-6 6 6 6" /></Stroke>;
export const MicIcon = ({ size = 18 }: P) => <Stroke size={size}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></Stroke>;
export const TrashIcon = ({ size = 18 }: P) => <Stroke size={size}><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></Stroke>;
export const ImageIcon = ({ size = 20 }: P) => <Stroke size={size}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></Stroke>;
export const FilmIcon = ({ size = 20 }: P) => <Stroke size={size}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 3v18" /><path d="M16 3v18" /><path d="M4 8h4" /><path d="M4 16h4" /><path d="M16 8h4" /><path d="M16 16h4" /></Stroke>;
export const DocIcon = ({ size = 20 }: P) => <Stroke size={size}><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 13h7" /><path d="M9 17h5" /></Stroke>;
export const ScissorsIcon = ({ size = 17 }: P) => <Stroke size={size} width={2.4}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M8.5 8.5L20 20" /><path d="M8.5 15.5L20 4" /></Stroke>;
export const DownloadIcon = ({ size = 18 }: P) => <Stroke size={size} width={2.4}><path d="M12 4v12" /><path d="M6 10l6 6 6-6" /><path d="M4 20h16" /></Stroke>;
export const CopyIcon = ({ size = 16 }: P) => <Stroke size={size}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></Stroke>;
export const RefreshIcon = ({ size = 16 }: P) => <Stroke size={size} width={2.4}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></Stroke>;

export function PlayIcon({ size = 16 }: P) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

// вкладки редактора превью
export const LayersIcon = ({ size = 20 }: P) => <Stroke size={size}><rect x="3" y="4" width="6" height="16" rx="1.5" /><rect x="9" y="4" width="6" height="16" rx="1.5" /><rect x="15" y="4" width="6" height="16" rx="1.5" /></Stroke>;
export const TypeIcon = ({ size = 20 }: P) => <Stroke size={size}><path d="M5 6V4h14v2" /><path d="M12 4v16" /><path d="M9 20h6" /></Stroke>;
export const PaletteIcon = ({ size = 20 }: P) => <Stroke size={size}><path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-2s-.8-1.6-.8-2.6c0-1.2 1-2.1 2.2-2.1H17a4 4 0 0 0 4-4c0-4.1-4-7.3-9-7.3z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></Stroke>;
export const MoveIcon = ({ size = 20 }: P) => <Stroke size={size}><path d="M12 3v18" /><path d="M3 12h18" /><path d="M9 6l3-3 3 3" /><path d="M9 18l3 3 3-3" /><path d="M6 9l-3 3 3 3" /><path d="M18 9l3 3-3 3" /></Stroke>;
export const GaugeIcon = ({ size = 20 }: P) => <Stroke size={size}><path d="M4 17a8 8 0 1 1 16 0" /><path d="M12 17l4-5" /></Stroke>;
export const FrameIcon = ({ size = 20 }: P) => <Stroke size={size}><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 11h6" /><path d="M9 15h6" /></Stroke>;
export const MegaphoneIcon = ({ size = 20 }: P) => <Stroke size={size}><path d="M4 10v4h4l6 4V6l-6 4z" /><path d="M17.5 9a4 4 0 0 1 0 6" /></Stroke>;
export const SplitIcon = ({ size = 20 }: P) => <Stroke size={size}><rect x="3" y="5" width="7" height="14" rx="1.5" /><rect x="14" y="5" width="7" height="14" rx="1.5" /></Stroke>;
