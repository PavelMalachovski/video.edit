import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorText, layerError, PAUSED, statusText } from '../lib/client.ts';

test('HTTP 402 means Vercel paused the site — the page says so in words, not a bare code', async () => {
  // на паузе Vercel отвечает своей HTML-страницей, а не нашим JSON
  const paused = new Response('<html><body>402: PAYMENT_REQUIRED</body></html>', { status: 402, headers: { 'Content-Type': 'text/html' } });
  const text = await errorText(paused, 'Не сохранилось');
  assert.match(text, /Vercel/);
  assert.match(text, /лимит/);
  assert.equal(statusText(402, 'HTTP'), text);
  assert.equal(statusText(500, 'Сервер ответил'), 'Сервер ответил (500)', 'другие коды — как раньше');
  assert.equal(await errorText(Response.json({ error: 'GitHub просит подождать' }, { status: 429 }), 'Не сохранилось'), 'GitHub просит подождать');
});

test('a paused site does not promise a date: a Hobby pause can stay after the limit resets', () => {
  assert.match(PAUSED, /Vercel/);
  assert.match(PAUSED, /Pro/);
  assert.doesNotMatch(PAUSED, /новый месяц/);
});

test('the layer and the sound say the same: a file the paused site did not give is the pause, in words', () => {
  // текст ошибки шаблона из iframe — Error другого окна: String(e) даёт «Error: …»
  assert.equal(layerError('Error: emoji/index.json: HTTP 402'), PAUSED);
  assert.equal(layerError('fonts.json: HTTP 402'), PAUSED);
  assert.equal(layerError('emoji/index.json: HTTP 404'), 'emoji/index.json: HTTP 404', 'другие ошибки — как были');
  assert.equal(layerError('HTTP 4020'), 'HTTP 4020');
});
