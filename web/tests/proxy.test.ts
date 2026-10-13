import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { authorized, signSession, SESSION_COOKIE } from '../lib/auth.ts';

// proxy.ts тянет next/server (в node --test не грузится), а config Next читает из него статически — matcher берём из текста
const source = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8');
const config = { matcher: new Function(`return ${/matcher:\s*(\[[\s\S]*?\]),?\s*\n\};/.exec(source)?.[1]}`)() as string[] };

// matcher собирается так же, как его собирает сам Next (иначе опечатка в регулярке молча открыла бы маршрут без входа)
const require = createRequire(import.meta.url);
const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info.js');
const { getMiddlewareRouteMatcher } = require('next/dist/shared/lib/router/utils/middleware-route-matcher.js');
const runs = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, { i18n: null, basePath: '' })) as (path: string) => boolean;
const ID = '261013-084048-pxvy';

test('the proxy (login check) runs everywhere except login, static files and the upload chunks', () => {
  for (const path of ['/', '/brand', `/jobs/${ID}`, `/jobs/${ID}/editor`, '/api/jobs', `/api/jobs/${ID}`, `/api/jobs/${ID}/parts`,
    `/api/jobs/${ID}/timeline`, `/api/jobs/${ID}/run`, '/api/brand/logo', '/template/emoji/index.json', `/api/jobs/${ID}/parts/abc`]) {
    assert.equal(runs(path), true, path);
  }
  // кусок видео (4 МБ) мимо proxy: иначе Vercel считает его трафик дважды (proxy и функция); вход проверяет сам маршрут
  for (const path of ['/login', '/api/login', '/_next/static/chunks/a.js', `/api/jobs/${ID}/parts/0`, `/api/jobs/${ID}/parts/123`]) {
    assert.equal(runs(path), false, path);
  }
});

test('a route outside the proxy checks the login cookie itself', async () => {
  process.env.SESSION_SECRET = 'test-secret';
  const cookie = `${SESSION_COOKIE}=${await signSession('test-secret')}`;
  assert.equal(await authorized(new Request('http://x/api/jobs/1/parts/0', { headers: { cookie: `a=1; ${cookie}; b=2` } })), true);
  assert.equal(await authorized(new Request('http://x/api/jobs/1/parts/0')), false);
  assert.equal(await authorized(new Request('http://x/api/jobs/1/parts/0', { headers: { cookie: `${SESSION_COOKIE}=1.forged` } })), false);
});
