import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionCopy, captionFold, parseCaption } from '../lib/caption.ts';

test('the copied caption is the text, an empty line and the hashtags', () => {
  assert.equal(captionCopy({ text: 'Три ошибки новичка 🔥\nСохрани, чтобы не потерять', hashtags: ['монтаж', 'reels'] }),
    'Три ошибки новичка 🔥\nСохрани, чтобы не потерять\n\n#монтаж #reels');
  assert.equal(captionCopy({ text: 'Просто текст', hashtags: [] }), 'Просто текст');
});

test('the fold shows what Instagram shows before «ещё»: 72 characters of the first line', () => {
  const long = 'Как я монтирую ролики на телефоне за десять минут и не трачу на это вечер целиком';
  const { shown, hidden } = captionFold(`${long}\nВторая строка`);
  assert.equal([...shown].length, 72);
  assert.equal(shown + hidden, `${long}\nВторая строка`);
  assert.deepEqual(captionFold('Коротко 🔥\nдальше'), { shown: 'Коротко 🔥', hidden: '\nдальше' }, 'первая строка короче — до неё');
});

test('parseCaption takes a sane caption and drops a broken one', () => {
  assert.deepEqual(parseCaption({ text: 'Текст', hashtags: ['a', 'b'] }), { text: 'Текст', hashtags: ['a', 'b'] });
  assert.equal(parseCaption({ text: '', hashtags: [] }), null);
  assert.equal(parseCaption({ text: 'Текст', hashtags: 'a b' }), null);
  assert.equal(parseCaption(undefined), null);
});

test('the ad text rides with the caption: up to 72 characters, otherwise it is dropped and the caption stays', () => {
  assert.deepEqual(parseCaption({ text: 'Подпись', hashtags: [], ad: 'Учу чешский по 15 минут' }), { text: 'Подпись', hashtags: [], ad: 'Учу чешский по 15 минут' });
  assert.deepEqual(parseCaption({ text: 'Подпись', hashtags: [], ad: 'x'.repeat(73) }), { text: 'Подпись', hashtags: [] });
});
