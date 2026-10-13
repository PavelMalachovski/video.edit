import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fontChars, handWord, missingLetters, typedText } from '../lib/fontchars.ts';

// Общая с движком фикстура (раздел letters): fonts.missing по тем же файлам шрифтов — каталог шаблона и свои шрифты Павла.
const LETTERS = (JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/overlay-events.json', import.meta.url), 'utf8')) as {
  letters: { fonts: { id: string; file: string }[]; texts: string[]; missing: Record<string, string[]>; hand: [string, string][] };
}).letters;

const chars = (file: string) => {
  const b = fs.readFileSync(new URL(`../../${file}`, import.meta.url));
  return fontChars(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
};

test('the letters a font lacks are the engine\'s: the same cmap and the same rule, for every font of the catalogue', () => {
  assert.ok(LETTERS.fonts.length >= 10, 'и встроенные, и свои');
  for (const f of LETTERS.fonts) {
    const have = chars(f.file);
    assert.ok(have.size > 100, `${f.id}: таблица символов прочитана (${have.size})`);
    LETTERS.texts.forEach((text, i) => assert.equal(missingLetters(have, text), LETTERS.missing[f.id][i], `${f.id}: «${text}»`));
  }
});

test('not a font, or a font without a character table — no letters', () => {
  assert.equal(fontChars(new ArrayBuffer(4)).size, 0);
  assert.equal(fontChars(new TextEncoder().encode('не шрифт, а текст подлиннее двенадцати байт').buffer as ArrayBuffer).size, 0);
});

test('the hand-written part of the hook is its last word with the emoji after it, as the engine takes it (fonts._hand_word)', () => {
  for (const [hook, hand] of LETTERS.hand) assert.equal(handWord(hook), hand, JSON.stringify(hook));
});

test('what Pavel typed goes to the font that draws it: the hook\'s last word and the code word — hand-written, the rest — main', () => {
  const h = {
    edits: [], words: [{ t0: 1, t1: 2, text: 'ёж' }],
    text: { hook: { text: 'Цена 500 ₽' }, cta: { at: [5, 6] as [number, number], lines: ['Пиши «план»'], word: 'ПЛАН→' },
      accents: [{ at: [3, 4] as [number, number], lines: ['½ цены'] }], inserts: [{ at: [2, 3] as [number, number], text: '×2' }],
      end: { lines: ['Жми ♥'], handle: '@pavel→' } },
  };
  const plain = typedText(h, false);
  for (const part of ['ёж', 'Цена 500 ₽', 'Пиши «план»', '½ цены', '×2', 'Жми ♥', '@pavel→']) assert.ok(plain.main.includes(part), part);
  assert.equal(plain.hand, '₽ ПЛАН→', 'последнее слово хука и кодовое слово');
  const accent = typedText(h, true);
  assert.equal(accent.hand, '', 'режим accent — рукописного нет');
  assert.ok(accent.main.includes('ПЛАН→'));
  assert.deepEqual(typedText({ edits: [] }, false), { main: '', hand: '' }, 'ничего не набрано');
});

test('a browser without the RegExp v flag (Safari before 17) still loads the letter check, emoji still need no glyph', async () => {
  // \p{RGI_Emoji} — только с флагом v: в браузере постарше `new RegExp(…, 'v')` бросает SyntaxError, а модуль грузят
  // экраны задачи и редактор — страница не должна падать
  const Native = RegExp;
  globalThis.RegExp = new Proxy(Native, {
    construct(target, args: [string | RegExp, string?]) {
      if ((args[1] ?? '').includes('v')) throw new SyntaxError('Invalid flags supplied to RegExp constructor');
      return Reflect.construct(target, args);
    },
  });
  try {
    const fresh = '../lib/fontchars.ts?without-v-flag'; // другой адрес — модуль грузится заново, уже без флага v
    const old = (await import(fresh)) as typeof import('../lib/fontchars.ts');
    const have = new Set([...'Привет ПРИВЕТ'].map((c) => c.codePointAt(0) as number));
    assert.equal(old.missingLetters(have, 'Привет 🔥 👍🏽 ❤️'), '', 'эмодзи — картинки, буквы есть');
    assert.equal(old.missingLetters(have, 'Привет ж'), 'Жж');
    assert.equal(old.handWord('Привет мир 🔥'), 'мир 🔥');
  } finally {
    globalThis.RegExp = Native;
  }
});
