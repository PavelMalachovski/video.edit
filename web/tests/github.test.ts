import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftRelease, findReleaseByTag, uploadAsset, type GH } from '../lib/github.ts';

type Call = { method: string; url: string; body?: unknown };

function fakeGH(handler: (c: Call) => { status: number; json?: unknown }): { gh: GH; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c = { method: init?.method ?? 'GET', url: String(url), body: init?.body };
    calls.push(c);
    const r = handler(c);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status });
  }) as typeof fetch;
  return { gh: { token: 't', repo: 'o/r', fetch: f }, calls };
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
