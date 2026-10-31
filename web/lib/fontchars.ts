import type { HandEdits } from './edits.ts';

// Буквы шрифтов — как fonts.missing движка (engine/vm/fonts.py): каких букв текста (и его капса) нет в шрифте. Таблица
// символов шрифта — cmap из того же файла TTF/OTF, что рисует ролик (выбор подтаблицы — как getBestCmap fontTools);
// глиф нужен буквам, цифрам, знакам препинания, валют и математики; пробелам, невидимым и эмодзи (их шаблон рисует
// картинками) — нет; знаки-символы (★, №) проверяет badSymbols. Общая фикстура — раздел letters в
// engine/tests/fixtures/overlay-events.json: страница по тем же файлам шрифтов считает то же.

/** Подтаблицы cmap по порядку предпочтения (платформа, кодировка) — как getBestCmap fontTools и HarfBuzz. */
const PREFS: readonly [number, number][] = [[3, 10], [0, 6], [0, 4], [3, 1], [0, 3], [0, 2], [0, 1], [0, 0]];

/** Коды символов, для которых в шрифте есть глиф (файл TTF/OTF целиком); не шрифт или нет таблицы — пусто. */
export function fontChars(buf: ArrayBuffer): Set<number> {
  const v = new DataView(buf);
  if (v.byteLength < 12) return new Set();
  const tables = v.getUint16(4);
  let cmap = -1;
  for (let i = 0; i < tables && 12 + i * 16 + 16 <= v.byteLength; i++) {
    const at = 12 + i * 16;
    if (v.getUint32(at) === 0x636d6170) cmap = v.getUint32(at + 8); // 'cmap'
  }
  if (cmap < 0 || cmap + 4 > v.byteLength) return new Set();
  const subs = Array.from({ length: v.getUint16(cmap + 2) }, (_, i) => {
    const at = cmap + 4 + i * 8;
    return { platform: v.getUint16(at), encoding: v.getUint16(at + 2), offset: cmap + v.getUint32(at + 4) };
  });
  for (const [platform, encoding] of PREFS) {
    const sub = subs.find((s) => s.platform === platform && s.encoding === encoding); // первая такая — как getcmap
    if (sub) return decode(v, sub.offset);
  }
  return new Set();
}

/** Подтаблица cmap → коды с глифом (глиф 0 — «нет глифа»), как её читает fontTools. */
function decode(v: DataView, at: number): Set<number> {
  const out = new Map<number, number>();
  const format = v.getUint16(at);
  if (format === 0) {
    for (let c = 0; c < 256; c++) out.set(c, v.getUint8(at + 6 + c));
  } else if (format === 4) {
    const seg = v.getUint16(at + 6) / 2;
    const ends = at + 14;
    const starts = ends + seg * 2 + 2;
    const deltas = starts + seg * 2;
    const ranges = deltas + seg * 2;
    for (let i = 0; i < seg - 1; i++) { // последний отрезок (0xFFFF) fontTools не читает
      const start = v.getUint16(starts + i * 2);
      const end = v.getUint16(ends + i * 2);
      const delta = v.getUint16(deltas + i * 2);
      const offset = v.getUint16(ranges + i * 2);
      for (let c = start; c <= end; c++) {
        let gid: number;
        if (offset === 0) gid = (c + delta) & 0xffff;
        else {
          const g = v.getUint16(ranges + i * 2 + offset + (c - start) * 2);
          gid = g === 0 ? 0 : (g + delta) & 0xffff;
        }
        if (gid) out.set(c, gid); // нет глифа — прежнее не стирает
      }
    }
  } else if (format === 6) {
    const first = v.getUint16(at + 6);
    const count = v.getUint16(at + 8);
    for (let k = 0; k < count; k++) out.set(first + k, v.getUint16(at + 10 + k * 2));
  } else if (format === 12 || format === 13) {
    const groups = v.getUint32(at + 12);
    let lastEnd = 0;
    for (let k = 0; k < groups; k++) {
      const g = at + 16 + k * 12;
      let start = v.getUint32(g);
      const end = Math.min(v.getUint32(g + 4), 0x10ffff);
      let gid = v.getUint32(g + 8);
      if (start > end || start < lastEnd) continue; // как collect_mapping HarfBuzz: кривые и налезающие группы — мимо
      lastEnd = end;
      if (gid === 0) {
        if (format === 13) continue;
        start += 1;
        gid += 1;
      }
      for (let c = start; c <= end; c++) out.set(c, format === 12 ? gid + (c - start) : gid);
    }
  }
  return new Set([...out].filter(([, gid]) => gid !== 0).map(([c]) => c));
}

// селекторы вариантов (и FE0F), селекторы-дополнения, оттенки кожи — глифа не требуют (fonts.INVISIBLE)
const invisible = (cp: number) => (cp >= 0xfe00 && cp < 0xfe10) || (cp >= 0xe0100 && cp < 0xe01f0) || (cp >= 0x1f3fb && cp < 0x1f400);
const DRAWN = /^[\p{L}\p{M}\p{N}\p{P}\p{Sc}\p{Sm}\p{Sk}]$/u; // fonts._drawn: буквы, метки, цифры, препинание, валюты…
/** Эмодзи — картинки шаблона (emoji.runs): им шрифт не нужен. `\p{RGI_Emoji}` — только с флагом v (Safari 17, Chrome
 *  112); в браузере постарше — пиктограммы с ZWJ, селекторами и оттенками кожи и флаги: модуль грузят экраны задачи и
 *  редактор, падать при загрузке он не должен. */
const RGI: RegExp = (() => {
  try {
    return new RegExp('\\p{RGI_Emoji}', 'gv');
  } catch {
    return /\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])*(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])*)*|[\u{1F1E6}-\u{1F1FF}]{2}/gu;
  }
})();
const KEYCAP = /[#*0-9]\u20e3/gu; // кейкап и без FE0F — эмодзи (в списке картинок FE0F не важен)
const code = (c: string) => c.codePointAt(0) as number;

/** Буквы текста `text` и его капса, которых нет в шрифте с символами `have`, по порядку кодов — как fonts.missing. */
export function missingLetters(have: ReadonlySet<number>, text: string): string {
  const plain = text.replace(RGI, '').replace(KEYCAP, '');
  const all = new Set([...plain, ...plain.toUpperCase()]);
  return [...all].filter((c) => !invisible(code(c)) && DRAWN.test(c) && !have.has(code(c))).sort((a, b) => code(a) - code(b)).join('');
}

/** Рукописная часть хука: последнее слово вместе с эмодзи после него — как fonts._hand_word (hookTitle шаблона). */
export function handWord(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  const emojiOnly = (w: string) => { // есть эмодзи и ничего, кроме них (emoji.emoji_only)
    const rest = w.replace(RGI, '').replace(KEYCAP, '');
    return rest.length < w.length && rest === '';
  };
  let last = words.length - 1;
  while (last > 0 && emojiOnly(words[last])) last -= 1;
  return words.slice(Math.max(last, 0)).join(' ');
}

/** Что Павел набрал в редакторе — каким шрифтом это нарисует ролик (fonts.texts): основной — слова субтитров, хук целиком,
 *  строки титра, акцентов, текст и подпись вставок, строки и ник финальной карточки; рукописный — последнее слово хука и кодовое
 *  слово титра (в режиме хука `accent` рукописного нет — всё основным). */
export function typedText(h: HandEdits, accentMode: boolean): { main: string; hand: string } {
  const t = h.text ?? {};
  const hook = t.hook?.text ?? '';
  const main = [...(h.words ?? []).map((w) => w.text), hook, ...(t.cta?.lines ?? []), ...(t.accents ?? []).flatMap((a) => a.lines ?? []),
    ...(t.inserts ?? []).flatMap((i) => [i.text ?? '', i.caption ?? '']), ...(t.end?.lines ?? []), t.end?.handle ?? ''];
  const hand = [handWord(hook), t.cta?.word ?? ''];
  const join = (parts: string[], by: string) => parts.filter(Boolean).join(by);
  return accentMode ? { main: join([...main, ...hand], '\n'), hand: '' } : { main: join(main, '\n'), hand: join(hand, ' ') };
}
