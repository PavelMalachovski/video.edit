'use client';
// Шрифты шаблона (public/template/fonts.json) — и в самой странице: кнопки выбора пишут название шрифта им самим
// (семейство `pv-<id>`). Один раз на документ: экраны «Превью» и редактора берут один и тот же список.
import { useEffect, useState } from 'react';
import { fontChars } from '@/lib/fontchars.ts';

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

const charsOf = new Map<string, Promise<Set<number>>>(); // таблицы символов шрифтов — одна загрузка на документ

/** Таблицы символов шрифтов `list` (cmap того же файла, что рисует ролик): id → коды с глифом; ещё не загружен — нет в
 *  карте (проверка букв тогда молчит). */
export function useFontChars(list: FontEntry[]): Map<string, Set<number>> {
  const [map, setMap] = useState<Map<string, Set<number>>>(() => new Map());
  useEffect(() => {
    let live = true;
    for (const f of list) {
      let p = charsOf.get(f.id);
      if (!p) {
        p = fetch(`/template/${f.file}`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))).then(fontChars);
        p.catch(() => charsOf.delete(f.id)); // не загрузился — в следующий раз снова
        charsOf.set(f.id, p);
      }
      void p.then((have) => live && setMap((m) => (m.get(f.id) === have ? m : new Map(m).set(f.id, have)))).catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [list]);
  return map;
}
