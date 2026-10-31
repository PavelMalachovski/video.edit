import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseStillsBody, stillsState, STILLS_MAX } from '../lib/stills.ts';

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../../engine/vm/schemas/stills.json', import.meta.url), 'utf8'));

test('a request for more stills: the film is needed, fields are trimmed, empty ones dropped, as the schema takes it', () => {
  assert.deepEqual(parseStillsBody({ film: '  Локи ', name: '', actor: ' Том Хиддлстоун' }), { film: 'Локи', actor: 'Том Хиддлстоун' });
  for (const bad of [{}, { film: '  ' }, { film: 'Л'.repeat(STILLS_MAX + 1) }, { film: 'Локи\nи ещё' }, { film: 5 }, null]) {
    assert.ok('error' in parseStillsBody(bad), JSON.stringify(bad));
  }
  assert.equal(SCHEMA.properties.film.maxLength, STILLS_MAX);
  assert.deepEqual(SCHEMA.required, ['film', 'at']);
});

test('the editor waits for stills until found/tmdb.json carries the request mark; a failed search says why', () => {
  const asked = { film: 'Локи', at: '2026-10-31T08:00:00Z' };
  assert.deepEqual(stillsState(true, null, null, { film: 'Локи', name: 'Локи' }),
    { can: true, pending: false, error: null, ask: { film: 'Локи', name: 'Локи' } }, 'запроса не было — из разбора задачи');
  assert.equal(stillsState(true, asked, { files: [] }, null).pending, true);
  assert.equal(stillsState(true, asked, { request: '2026-10-30T08:00:00Z' }, null).pending, true, 'отметка прошлого запроса');
  assert.deepEqual(stillsState(true, asked, { request: asked.at }, null), { can: true, pending: false, error: null, ask: { film: 'Локи' } });
  assert.equal(stillsState(true, asked, { request: asked.at, error: 'нет TMDB_TOKEN' }, null).error, 'нет TMDB_TOKEN');
  assert.deepEqual(stillsState(false, null, null, null).ask, { film: '' }, 'обычный ролик — поля пустые');
});
