import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorText, statusText } from '../lib/client.ts';

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
