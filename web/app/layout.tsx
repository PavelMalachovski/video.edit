import type { ReactNode } from 'react';
import { Geologica, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Шрифты «Монтажки»: Geologica — интерфейс, JetBrains Mono — цифры и ТЗ. Next кладёт их рядом со страницей при
// сборке — в браузере запросов к Google нет.
const ui = Geologica({ subsets: ['latin', 'cyrillic'], weight: ['400', '500', '600', '700'], variable: '--font-ui', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin', 'cyrillic'], weight: ['500', '600'], variable: '--font-mono', display: 'swap' });

export const metadata = { title: 'video.edit' };
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#0B0C0F' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${ui.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
