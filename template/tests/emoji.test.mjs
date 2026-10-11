// Эмодзи картинками: деление текста на куски — то же правило, что в движке (общая фикстура
// engine/tests/fixtures/emoji-runs.json), и быстрая проверка «может ли тут быть эмодзи» без списка.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { emojiRuns, emojiTable, mayHaveEmoji } from '../emoji.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = JSON.parse(await readFile(path.join(ROOT, 'emoji', 'index.json'), 'utf8'));
const cases = JSON.parse(await readFile(path.join(ROOT, '..', 'engine', 'tests', 'fixtures', 'emoji-runs.json'), 'utf8'));
const table = emojiTable(index);

for (const c of cases) {
  test(`runs like the engine: ${c.why}`, () => {
    assert.deepEqual(emojiRuns(c.text, table).map(([kind, value]) => [kind, value]), c.runs);
  });
}

test('an emoji run keeps its source text', () => {
  assert.deepEqual(emojiRuns('a❤️b', table), [['text', 'a'], ['emoji', '2764', '❤️'], ['text', 'b']]);
});

test('the quick check sees every emoji of the list and skips plain text', () => {
  const missed = index.emoji.filter((name) => {
    const cps = name.split('-').map((h) => parseInt(h, 16));
    const text = String.fromCodePoint(...cps) + (index.text.includes(name) ? '\uFE0F' : '');
    return !mayHaveEmoji(text);
  });
  assert.deepEqual(missed, []);
  assert.equal(mayHaveEmoji('Привет, мир! Ahoj, světe — 100% №1 «да» за 5 € → 7 ₽ © ™ ❤ #1'), false);
  assert.equal(mayHaveEmoji('🏳\u200D⚧'), true);
});

test('without a table every text is one text run', () => {
  assert.deepEqual(emojiRuns('Огонь 🔥', null), [['text', 'Огонь 🔥']]);
});
