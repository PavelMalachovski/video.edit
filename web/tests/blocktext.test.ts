import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFields, blockTarget, fieldFonts, fieldKey, fieldProblem, textFields, type TextTarget } from '../lib/blocktext.ts';
import { applyText, EMPTY, parseTimeline, setBlock, setCta, setEnd, setHook, setWord, type At } from '../lib/edits.ts';
import type { Draft } from '../lib/tracks.ts';

// Текст блока руками — одни поля и одна правка у панели блока и у поля на кадре: хук, титр (две строки и кодовое слово),
// акцент (две строки), стикер и картинка, финальная карточка с ником, слова субтитров.
const CTA: At = [2.1, 2.6];
const ACCENT: At = [1.0, 1.15];
const STICKER: At = [0.9, 1.3];
const DRAFT: Draft = {
  speed: 1, keep: [[0, 3]],
  words: [{ t0: 0.3, t1: 0.6, text: 'Привет,' }, { t0: 0.7, t1: 0.9, text: 'это' }, { t0: 1.0, t1: 1.15, text: 'мой' }],
  hook: { text: 'Как я снимаю', until: 0.7 },
  cta: { t0: 2.1, t1: 2.6, lines: ['Пиши в комментариях', 'слово'], word: 'ВИДЕО' },
  accents: [{ t0: 1.0, t1: 1.15, x: 540, y: 900, lines: [{ text: 'мой' }, { text: 'ролик', size: 'big' }] }],
  inserts: [
    { kind: 'sticker', text: '3 ошибки', t0: 0.9, t1: 1.3, x: 120, y: 1100, w: 400 },
    { kind: 'image', src: 'in/a.png', t0: 1.7, t1: 2.2, x: 600, y: 300, w: 300 },
  ],
  zooms: [], music: null, end: { seconds: 1, lines: ['Подпишись'], handle: '@pavel' },
};
const HAND = setWord(setHook(EMPTY, { until: 0.9 }), 0.3, 0.6, ''); // хук до 0,9 с, «Привет,» убрано из субтитров
const HOOK: TextTarget = { kind: 'hook' };
const CTA_T: TextTarget = { kind: 'cta', at: CTA };
const ACCENT_T: TextTarget = { kind: 'accent', n: 0, at: ACCENT, occurrence: 0 };
const STICKER_T: TextTarget = { kind: 'insert', n: 0, at: STICKER, occurrence: 0 };
const IMAGE_T: TextTarget = { kind: 'insert', n: 1, at: [1.7, 2.2], occurrence: 0 };
const END: TextTarget = { kind: 'end' };
const WORDS: TextTarget = { kind: 'words', from: 0.3, to: 1.15 };

test('a block on the frame is the block of its panel: the target of a track block, subtitles by their words', () => {
  assert.deepEqual(blockTarget({ kind: 'hook' }), HOOK);
  assert.deepEqual(blockTarget({ kind: 'cta', at: CTA }), CTA_T);
  assert.deepEqual(blockTarget({ kind: 'accent', n: 0, at: ACCENT, occurrence: 0 }), ACCENT_T);
  assert.deepEqual(blockTarget({ kind: 'insert', n: 0, at: STICKER, occurrence: 0 }), STICKER_T);
  assert.equal(blockTarget({ kind: 'sub', words: [] }), null, 'группа субтитров — по словам на кадре (words)');
});

test('the fields of a block on the frame are its panel\'s: label, value (Pavel\'s fix or the session\'s), check and limit', () => {
  const fields = (t: TextTarget, h = HAND) => textFields(t, DRAFT, h);
  assert.deepEqual(fields(HOOK), [{ id: 'text', label: { key: 'hookText' }, value: 'Как я снимаю', session: 'Как я снимаю', check: 'hook', max: 120 }]);
  assert.deepEqual(fields(CTA_T), [
    { id: 'line0', label: { key: 'ctaLines', line: 1 }, value: 'Пиши в комментариях', session: 'Пиши в комментариях', check: 'line', max: 120 },
    { id: 'line1', label: { key: 'ctaLines', line: 2 }, value: 'слово', session: 'слово', check: 'line', max: 120 },
    { id: 'word', label: { key: 'ctaWord' }, value: 'ВИДЕО', session: 'ВИДЕО', check: 'hand', max: 120 },
  ]);
  assert.deepEqual(fields(CTA_T, setCta(HAND, CTA, { word: 'ПЛАН', lines: ['Пиши', 'мне'] })).map((f) => f.value), ['Пиши', 'мне', 'ПЛАН'], 'правка Павла');
  assert.deepEqual(textFields(CTA_T, { ...DRAFT, cta: { ...DRAFT.cta!, lines: ['Пиши'] } }, HAND)[0].label, { key: 'ctaLines' }, 'одна строка — без номера');
  assert.deepEqual(fields(ACCENT_T).map((f) => [f.id, f.label, f.value, f.check]),
    [['line0', { key: 'accentLines', line: 1 }, 'мой', 'line'], ['line1', { key: 'accentLines', line: 2 }, 'ролик', 'line']]);
  assert.deepEqual(fields(ACCENT_T, setBlock(HAND, 'accents', ACCENT, 0, { lines: ['мой', 'клип'] })).map((f) => [f.value, f.session]), [['мой', 'мой'], ['клип', 'ролик']]);
  assert.deepEqual(fields(STICKER_T), [{ id: 'text', label: { key: 'insertText' }, value: '3 ошибки', session: '3 ошибки', check: 'line', max: 120 }]);
  assert.deepEqual(fields(END), [
    { id: 'line0', label: { key: 'endLine' }, value: 'Подпишись', session: 'Подпишись', check: 'line', max: 120 },
    { id: 'handle', label: { key: 'endHandle' }, value: '@pavel', session: '@pavel', check: 'handle', max: 60 },
  ]);
  assert.equal(textFields(END, { ...DRAFT, end: { seconds: 1, lines: ['Подпишись'] } }, HAND)[1].value, '', 'ника нет — пустое поле');
  assert.deepEqual(fields(WORDS), [
    { id: '0.3|0.6', label: { word: 'Привет,', removed: true }, value: '', session: 'Привет,', check: 'word', max: 60, span: [0.3, 0.6] },
    { id: '0.7|0.9', label: { word: 'это', removed: false }, value: 'это', session: 'это', check: 'word', max: 60, span: [0.7, 0.9] },
    { id: '1|1.15', label: { word: 'мой', removed: false }, value: 'мой', session: 'мой', check: 'word', max: 60, span: [1.0, 1.15] },
  ]);
  assert.deepEqual(textFields({ kind: 'words', from: 0.7, to: 0.9 }, DRAFT, HAND).map((f) => f.session), ['это'], 'только слова группы');
});

test('undo keys of the fields are the panel\'s: the keystrokes of one field are one edit', () => {
  const key = (t: TextTarget, i = 0) => fieldKey(t, textFields(t, DRAFT, HAND)[i]);
  assert.deepEqual([key(HOOK), key(CTA_T, 1), key(CTA_T, 2), key(ACCENT_T, 1), key(STICKER_T), key(END, 0), key(END, 1), key(WORDS, 1)],
    ['hook:text', 'cta:line1', 'cta:word', 'accent0:line1', 'insert0:text', 'end:line0', 'end:handle', 'word:0.7|0.9']);
});

test('removed blocks and pictures have no text', () => {
  assert.deepEqual(textFields(HOOK, DRAFT, setHook(HAND, { off: true })), []);
  assert.deepEqual(textFields(HOOK, { ...DRAFT, hook: null }, HAND), []);
  assert.deepEqual(textFields(CTA_T, DRAFT, setCta(HAND, CTA, { off: true })), []);
  assert.deepEqual(textFields(ACCENT_T, DRAFT, setBlock(HAND, 'accents', ACCENT, 0, { off: true })), []);
  assert.deepEqual(textFields(STICKER_T, DRAFT, setBlock(HAND, 'inserts', STICKER, 0, { off: true })), []);
  assert.deepEqual(textFields(IMAGE_T, DRAFT, HAND), [], 'у картинки текста нет');
  assert.deepEqual(textFields(END, DRAFT, setEnd(HAND, { off: true })), []);
  assert.deepEqual(textFields(END, { ...DRAFT, end: null }, HAND), []);
});

test('typed text is one edit, as the panel writes it; trimmed; nothing changed — no edit', () => {
  const put = (t: TextTarget, values: string[], h = HAND) => applyFields(h, t, textFields(t, DRAFT, h), values);
  assert.deepEqual(put(HOOK, ['Как я снимаю ролик']), setHook(HAND, { text: 'Как я снимаю ролик' }));
  assert.deepEqual(put(HOOK, ['  Как я снимаю ролик ']), setHook(HAND, { text: 'Как я снимаю ролик' }), 'без пробелов по краям');
  assert.equal(put(HOOK, [' Как я снимаю ']), null, 'то же — правки нет');
  assert.deepEqual(put(CTA_T, ['Пиши в комментариях', 'слово', 'ПЛАН'])?.text?.cta, { at: CTA, word: 'ПЛАН' }, 'только слово');
  assert.deepEqual(put(CTA_T, ['Пиши здесь', 'слово', 'ВИДЕО'])?.text?.cta, { at: CTA, lines: ['Пиши здесь', 'слово'] }, 'строка — все строки');
  const worded = setCta(HAND, CTA, { word: 'ПЛАН' });
  assert.deepEqual(put(CTA_T, ['Пиши', 'слово', 'ПЛАН'], worded)?.text?.cta, { at: CTA, word: 'ПЛАН', lines: ['Пиши', 'слово'] }, 'поверх прежней правки');
  assert.deepEqual(put(ACCENT_T, ['мой', 'клип']), setBlock(HAND, 'accents', ACCENT, 0, { lines: ['мой', 'клип'] }));
  assert.deepEqual(put(STICKER_T, [' 5 ошибок ']), setBlock(HAND, 'inserts', STICKER, 0, { text: '5 ошибок' }));
  assert.deepEqual(put(END, ['Подпишись', ''])?.text?.end, { handle: '' }, 'ник стёрт — без ника');
  assert.deepEqual(put(END, ['Подпишись на канал', '@pavel'])?.text?.end, { lines: ['Подпишись на канал'] });
  assert.equal(put(END, ['Подпишись', '@pavel']), null);
});

test('words: the changed words of the group in one edit; back to the session\'s word — the fix goes', () => {
  const next = applyFields(HAND, WORDS, textFields(WORDS, DRAFT, HAND), ['Привет,', 'вот', 'мой ']);
  assert.deepEqual(next?.words, [{ t0: 0.7, t1: 0.9, text: 'вот' }], '«Привет,» вернулось — правки нет; «мой» — то же');
  assert.equal(next?.text?.hook?.until, 0.9, 'прочие правки остаются');
  assert.deepEqual(applyFields(HAND, WORDS, textFields(WORDS, DRAFT, HAND), ['', 'это', ''])?.words,
    [{ t0: 0.3, t1: 0.6, text: '' }, { t0: 1.0, t1: 1.15, text: '' }], 'пусто — слова нет в субтитрах');
  assert.equal(applyFields(HAND, WORDS, textFields(WORDS, DRAFT, HAND), ['', 'это', 'мой']), null);
});

test('the frame refuses what the panels refuse: empty lines, symbols the font cannot draw, emoji in subtitles', () => {
  assert.deepEqual(fieldProblem('line', ' '), { key: 'emptyLine' });
  assert.deepEqual(fieldProblem('hook', ''), { key: 'emptyLine' });
  assert.deepEqual(fieldProblem('hand', ''), { key: 'emptyLine' });
  assert.equal(fieldProblem('word', ''), null, 'пустое слово — слова нет в субтитрах');
  assert.deepEqual(fieldProblem('word', 'мой🔥'), { key: 'noEmoji' });
  assert.deepEqual(fieldProblem('word', '✓'), { key: 'noSymbol', s: '✓' });
  assert.deepEqual(fieldProblem('line', 'Лучший ★ кофе ★'), { key: 'noSymbol', s: '★' });
  assert.equal(fieldProblem('hook', 'Как я снимаю 🎬'), null, 'в хуке эмодзи можно — картинкой');
  assert.equal(fieldProblem('handle', ''), null, 'без ника можно');
  assert.deepEqual(fieldProblem('handle', '@pavel ♪'), { key: 'noSymbol', s: '♪' });
  // какой шрифт спросить о буквах: хук целиком — основной, его последнее слово — рукописный; кодовое слово — рукописный
  assert.deepEqual(fieldFonts('hook', 'Как я снимаю 🎬'), [{ role: 'main', text: 'Как я снимаю 🎬' }, { role: 'hand', text: 'снимаю 🎬' }]);
  assert.deepEqual(fieldFonts('hand', 'ПЛАН'), [{ role: 'hand', text: 'ПЛАН' }]);
  assert.deepEqual(fieldFonts('line', 'мой'), [{ role: 'main', text: 'мой' }]);
  assert.deepEqual(fieldFonts('word', 'мой'), [{ role: 'main', text: 'мой' }]);
  assert.deepEqual(fieldFonts('handle', ' '), []);
  assert.deepEqual(fieldFonts('handle', '@pavel'), [{ role: 'main', text: '@pavel' }]);
});

test('the result is a timeline.json the schema takes and the layer shows', () => {
  const step = (h: typeof HAND, t: TextTarget, values: string[]) => applyFields(h, t, textFields(t, DRAFT, h), values) ?? h;
  let h = step(HAND, HOOK, ['Как я снимаю ролик']);
  h = step(h, CTA_T, ['Пиши в комментариях', 'слово', 'ПЛАН']);
  h = step(h, ACCENT_T, ['мой', 'клип']);
  h = step(h, STICKER_T, ['5 ошибок']);
  h = step(h, END, ['Подпишись!', '']);
  h = step(h, WORDS, ['Привет,', 'вот', 'мой']);
  assert.ok(parseTimeline({ rev: 1, ...h }), JSON.stringify(h));
  const shown = applyText(DRAFT, h.text, h.words);
  assert.equal(shown.hook?.text, 'Как я снимаю ролик');
  assert.equal(shown.cta?.word, 'ПЛАН');
  assert.deepEqual(shown.accents?.[0].lines, [{ text: 'мой' }, { text: 'клип', size: 'big' }], 'у строки — её размер');
  assert.equal(shown.inserts[0].text, '5 ошибок');
  assert.deepEqual([shown.end?.lines, shown.end?.handle], [['Подпишись!'], null]);
  assert.deepEqual(shown.words.map((w) => w.text), ['Привет,', 'вот', 'мой']);
});
