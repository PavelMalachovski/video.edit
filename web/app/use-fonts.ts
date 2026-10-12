'use client';
// Шрифты шаблона (public/template/fonts.json) — и в самой странице: кнопки выбора пишут название шрифта им самим
// (семейство `pv-<id>`). Один раз на документ: экраны «Превью» и редактора берут один и тот же список.
import { useEffect, useState } from 'react';

export type FontEntry = { id: string; family: string; file: string; kind: 'main' | 'hand' };

let loaded: Promise<FontEntry[]> | null = null;

function loadFonts(): Promise<FontEntry[]> {
  loaded ??= fetch('/template/fonts.json')
    .then((r) => (r.ok ? r.json() : []))
    .then((list: FontEntry[]) => {
      for (const f of list) {
        const face = new FontFace(`pv-${f.id}`, `url("/template/${f.file}")`, { weight: '1 1000' });
        document.fonts.add(face);
        void face.load().catch(() => undefined);
      }
      return list;
    })
    .catch(() => {
      loaded = null; // не загрузилось — в следующий раз спросим снова
      return [];
    });
  return loaded;
}

export function useTemplateFonts(): FontEntry[] {
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  useEffect(() => {
    let live = true;
    void loadFonts().then((list) => live && setFonts(list));
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}
