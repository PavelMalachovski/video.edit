import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICT, LANGS, loadLang, saveLang, tr } from '../lib/i18n.ts';
import { blockedStorage, memoryStorage } from './helpers.ts';

test('ru and en have the same keys, none empty', () => {
  const ru = Object.keys(DICT.ru).sort();
  assert.deepEqual(Object.keys(DICT.en).sort(), ru);
  for (const lang of LANGS) for (const [k, v] of Object.entries(DICT[lang])) assert.ok(v.trim() !== '', `${lang}.${k}`);
});

test('tr fills the {holes} and the language is remembered', () => {
  assert.equal(tr('ru', 'cutPart', { s: '1,5 с' }), 'Вырезано 1,5 с');
  assert.equal(tr('en', 'cutPart', { s: '1.5 s' }), 'Cut 1.5 s');
  const store = memoryStorage();
  assert.equal(loadLang(store), 'ru', 'по умолчанию — русский');
  saveLang(store, 'en');
  assert.equal(loadLang(store), 'en');
  store.setItem('vm:lang', 'de');
  assert.equal(loadLang(store), 'ru');
  assert.equal(loadLang(blockedStorage), 'ru');
  saveLang(blockedStorage, 'en'); // без хранилища — без ошибки
});
