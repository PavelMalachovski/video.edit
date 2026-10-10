import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorResponse } from '../lib/http.ts';
import { GitHubError } from '../lib/github.ts';
import { RoutineError } from '../lib/routine.ts';

test('errorResponse returns JSON with the error text and status 502', async () => {
  const r = errorResponse(new Error('create release: GitHub 403 {"message":"Resource not accessible by personal access token"}'));
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.match(body.error, /GitHub 403/);
  assert.match(body.error, /Resource not accessible/);
});

test('errorResponse never echoes a bearer token', async () => {
  const r = errorResponse(new Error('fetch failed Authorization: Bearer github_pat_ABCDEF123'));
  const body = await r.json();
  assert.doesNotMatch(body.error, /github_pat_ABCDEF123/);
});

test('missing env var is reported as a configuration error (500)', async () => {
  const r = errorResponse(new Error('env GITHUB_TOKEN is not set'));
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /GITHUB_TOKEN/);
});

test('rate-limited GitHub error becomes 429 with retryAfter', async () => {
  const r = errorResponse(new GitHubError('upload: GitHub 403 {}', 403, 30));
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { error: 'GitHub просит подождать', retryAfter: 30 });
});

test('routine error keeps its message with 502', async () => {
  const r = errorResponse(new RoutineError(401, 'Рутина отклонила запуск: проверьте ROUTINE_TOKEN в Vercel'));
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, 'Рутина отклонила запуск: проверьте ROUTINE_TOKEN в Vercel');
});

