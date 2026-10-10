import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'video.edit' };
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#0F1012' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
