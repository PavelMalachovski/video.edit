// Значки из макетов (24×24, обводка) — только украшение, подписи у кнопок свои.
type P = { size?: number; color?: string };

export function UploadIcon({ size = 28, color = '#141414' }: P) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4" /><path d="M6 10l6-6 6 6" /><path d="M4 20h16" />
    </svg>
  );
}

export function PlusIcon({ size = 18, color = 'currentColor' }: P) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
      <path d="M12 5v14" /><path d="M5 12h14" />
    </svg>
  );
}

export function CloseIcon({ size = 16, color = '#A3A6AD' }: P) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12" /><path d="M18 6L6 18" />
    </svg>
  );
}

export function PlayIcon({ size = 16, color = '#F3F3F1' }: P) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function TrashIcon({ size = 18, color = '#A3A6AD' }: P) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" />
    </svg>
  );
}
