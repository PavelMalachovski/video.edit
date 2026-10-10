import type { ReactNode } from 'react';
import { Manrope, Montserrat } from 'next/font/google';
import './globals.css';

// Шрифты макетов; Next кладёт их рядом со страницей при сборке — в браузере запросов к Google нет.
const ui = Manrope({ subsets: ['latin', 'cyrillic'], weight: ['400', '500', '600', '700', '800'], variable: '--font-ui', display: 'swap' });
const logo = Montserrat({ subsets: ['latin'], weight: ['900'], variable: '--font-logo', display: 'swap' });

export const metadata = { title: 'video.edit' };
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#0F1012' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${ui.variable} ${logo.variable}`}>
      <body>{children}</body>
    </html>
  );
}
