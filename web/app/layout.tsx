import type { Viewport } from 'next';
import type { ReactNode } from 'react';
import { Geologica, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Шрифты «Монтажки»: Geologica — интерфейс, JetBrains Mono — цифры и ТЗ. Next кладёт их рядом со страницей при
// сборке — в браузере запросов к Google нет.
const ui = Geologica({ subsets: ['latin', 'cyrillic'], weight: ['400', '500', '600', '700'], variable: '--font-ui', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin', 'cyrillic'], weight: ['500', '600'], variable: '--font-mono', display: 'swap' });

export const metadata = { title: 'video.edit' };
// полоса браузера и схема — как фон страницы (светлая тема, --bg в globals.css)
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#F3F4F1', colorScheme: 'light' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${ui.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
