import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetDownload, clearGitHubCache, createDraftRelease, deleteRelease, findReleaseByTag, getRelease, GitHubError, isRateLimited,
  listAssets, readAssetText, uploadAsset, type GH,
} from '../lib/github.ts';
import { fakeFetch, type Call, type Reply } from './helpers.ts';

function fakeGH(handler: (c: Call) => Reply): { gh: GH; calls: Call[] } {
  const { fetch, calls } = fakeFetch(handler);
  return { gh: { token: 't', repo: 'o/r', fetch }, calls };
}

test('createDraftRelease posts a draft release', async () => {
  const { gh, calls } = fakeGH(() => ({ status: 201, json: { id: 7, tag_name: 'job-x', draft: true, assets: [] } }));
  const r = await createDraftRelease(gh, 'job-x', 'IMG_1.MOV');
  assert.equal(r.id, 7);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/releases');
  assert.deepEqual(JSON.parse(String(calls[0].body)), { tag_name: 'job-x', name: 'IMG_1.MOV', draft: true, body: '' });
});

test('findReleaseByTag finds drafts by listing releases', async () => {
  const { gh } = fakeGH(() => ({ status: 200, json: [{ id: 1, tag_name: 'job-a', draft: true, assets: [] }, { id: 2, tag_name: 'job-b', draft: true, assets: [] }] }));
  assert.equal((await findReleaseByTag(gh, 'job-b'))?.id, 2);
  assert.equal(await findReleaseByTag(gh, 'job-z'), null);
});

test('uploadAsset replaces an existing asset with the same name', async () => {
  let posts = 0;
  const { gh, calls } = fakeGH((c) => {
    if (c.method === 'POST' && c.url.startsWith('https://uploads.github.com/')) {
      posts += 1;
      return posts === 1 ? { status: 422, json: { errors: [{ code: 'already_exists' }] } } : { status: 201, json: { id: 99, name: 'source.part-00000', size: 3 } };
    }
    if (c.method === 'GET') return { status: 200, json: [{ id: 5, name: 'source.part-00000', size: 2 }] };
    if (c.method === 'DELETE') return { status: 204 };
    return { status: 500 };
  });
  const a = await uploadAsset(gh, 7, 'source.part-00000', new Uint8Array([1, 2, 3]));
  assert.equal(a.id, 99);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/releases/assets/5')));
  assert.match(calls[0].url, /^https:\/\/uploads\.github\.com\/repos\/o\/r\/releases\/7\/assets\?name=source\.part-00000$/);
});

test('custom API and uploads base URLs are used when given', async () => {
  const calls: string[] = [];
  const f = (async (url: string | URL) => { calls.push(String(url)); return new Response(JSON.stringify({ id: 1, name: 'a', size: 1 }), { status: 201 }); }) as typeof fetch;
  const gh: GH = { token: 't', repo: 'o/r', fetch: f, api: 'http://127.0.0.1:9/api', uploads: 'http://127.0.0.1:9/up' };
  await createDraftRelease(gh, 'job-x', 'x');
  await uploadAsset(gh, 1, 'a', new Uint8Array([1]));
  assert.deepEqual(calls, ['http://127.0.0.1:9/api/repos/o/r/releases', 'http://127.0.0.1:9/up/repos/o/r/releases/1/assets?name=a']);
});

async function failure(p: Promise<unknown>): Promise<GitHubError> {
  const e = await p.then(() => null, (err: unknown) => err);
  assert.ok(e instanceof GitHubError, String(e));
  return e;
}

test('rate limit answers become GitHubError with retryAfter', async () => {
  clearGitHubCache();
  let e = await failure(findReleaseByTag(fakeGH(() => ({ status: 429, json: {}, headers: { 'retry-after': '30' } })).gh, 'job-x'));
  assert.equal(e.status, 429);
  assert.equal(e.retryAfter, 30);
  assert.ok(isRateLimited(e));
  const reset = String(Math.floor(Date.now() / 1000) + 120);
  e = await failure(findReleaseByTag(fakeGH(() => ({ status: 403, json: {}, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })).gh, 'job-x'));
  assert.ok(e.retryAfter !== null && e.retryAfter >= 119 && e.retryAfter <= 121, String(e.retryAfter));
  e = await failure(findReleaseByTag(fakeGH(() => ({ status: 403, json: { message: 'You have exceeded a secondary rate limit' } })).gh, 'job-x'));
  assert.equal(e.retryAfter, 60);  // вторичный лимит без заголовков — ждать минуту (так советует GitHub)
  e = await failure(findReleaseByTag(fakeGH(() => ({ status: 403, json: { message: 'Resource not accessible by personal access token' } })).gh, 'job-x'));
  assert.equal(e.retryAfter, null);
  assert.equal(isRateLimited(e), false);
  assert.match(e.message, /GitHub 403/);
});

test('second GET sends If-None-Match and 304 returns cached data', async () => {
  clearGitHubCache();
  const { gh, calls } = fakeGH((c) => c.headers.get('if-none-match') === '"v1"'
    ? { status: 304, headers: { etag: '"v1"' } }
    : { status: 200, json: [{ id: 5, name: 'a', size: 1 }], headers: { etag: '"v1"' } });
  const first = await listAssets(gh, 7);
  const second = await listAssets(gh, 7);
  assert.deepEqual(second, first);
  assert.equal(calls[0].headers.get('if-none-match'), null);
  assert.equal(calls[1].headers.get('if-none-match'), '"v1"');
});

test('getRelease returns null on 404', async () => {
  clearGitHubCache();
  const { gh, calls } = fakeGH(() => ({ status: 404, json: { message: 'Not Found' } }));
  assert.equal(await getRelease(gh, 9), null);
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/releases/9');
  const found = fakeGH(() => ({ status: 200, json: { id: 9, tag_name: 'job-a', name: null, draft: true, assets: [] } }));
  assert.equal((await getRelease(found.gh, 9))?.tag_name, 'job-a');
});

test('assetDownload returns the redirect location without following it', async () => {
  const { gh, calls } = fakeGH(() => ({ status: 302, headers: { location: 'https://objects.example/signed?x=1' } }));
  assert.deepEqual(await assetDownload(gh, 11), { location: 'https://objects.example/signed?x=1' });
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].headers.get('accept'), 'application/octet-stream');
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/releases/assets/11');
  const direct = fakeGH(() => ({ status: 200, text: 'bytes' }));
  const r = await assetDownload(direct.gh, 11);
  assert.ok('response' in r && (await r.response.text()) === 'bytes');
});

test('readAssetText follows the redirect and returns the text', async () => {
  const { gh, calls } = fakeGH(() => ({ status: 200, text: '{"name":"a.mov"}' }));
  assert.equal(await readAssetText(gh, 12), '{"name":"a.mov"}');
  assert.equal(calls[0].headers.get('accept'), 'application/octet-stream');
  assert.notEqual(calls[0].redirect, 'manual');
});

test('deleteRelease tolerates 404', async () => {
  const { gh, calls } = fakeGH(() => ({ status: 404, json: { message: 'Not Found' } }));
  await deleteRelease(gh, 9);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/releases/9');
  await failure(deleteRelease(fakeGH(() => ({ status: 500, json: {} })).gh, 9));
});

