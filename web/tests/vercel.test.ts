import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Ветки задач и бренда (claude/*) коммитят страница, сессия монтажа и Action — десятки пушей на ролик. Сборки страницы
// из них не нужны и съедают лимит Hobby (100 сборок в сутки): Vercel их пропускает.
test('Vercel does not build the job and brand branches', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.git?.deploymentEnabled, { 'claude/*': false });
});
