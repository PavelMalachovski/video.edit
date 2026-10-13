import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, env } from '../lib/env.ts';
import { commitCache, errorResponse, jsonWithEtag } from '../lib/http.ts';
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

test('missing env var is reported as a configuration error (500) Pavel can act on', async () => {
  delete process.env.VM_TEST_MISSING;
  let thrown: unknown;
  try {
    env('VM_TEST_MISSING');
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof ConfigError);
  const r = errorResponse(thrown);
  assert.equal(r.status, 500);
  const { error } = await r.json();
  assert.match(error, /VM_TEST_MISSING/);
  assert.match(error, /Vercel/);
  assert.match(error, /Redeploy/);
  assert.doesNotMatch(error, /is not set/, 'по-русски, а не технической строкой');
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


test('a poll with the same JSON gets 304 and no body — the page keeps what it has (Vercel traffic)', async () => {
  const data = { view: { screen: 'result' }, head: 'abc' };
  const first = jsonWithEtag(data, new Request('http://x/api/jobs/1'));
  assert.equal(first.status, 200);
  const etag = first.headers.get('ETag');
  assert.ok(etag && /^"[0-9a-f]{16,}"$/.test(etag), String(etag));
  assert.deepEqual(await first.json(), data);
  const again = jsonWithEtag(data, new Request('http://x/api/jobs/1', { headers: { 'If-None-Match': etag } }));
  assert.equal(again.status, 304);
  assert.equal(await again.text(), '');
  assert.equal(again.headers.get('ETag'), etag);
  const changed = jsonWithEtag({ ...data, head: 'def' }, new Request('http://x/api/jobs/1', { headers: { 'If-None-Match': etag } }));
  assert.equal(changed.status, 200, 'другое содержимое — другой ETag');
  assert.notEqual(changed.headers.get('ETag'), etag);
});

test('a file of a commit (v = its sha) is cached by the browser and by Vercel\'s CDN — the function is not run again', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(commitCache(sha), { 'Cache-Control': 'private, max-age=86400', 'Vercel-CDN-Cache-Control': 'max-age=31536000' });
  for (const v of [null, '', 'main', 'a'.repeat(39), `${sha}x`]) assert.deepEqual(commitCache(v), { 'Cache-Control': 'no-store' }, String(v));
});
