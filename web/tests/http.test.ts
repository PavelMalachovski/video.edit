import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorResponse } from '../lib/http.ts';

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
