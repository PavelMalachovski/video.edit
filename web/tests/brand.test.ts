import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND_BRANCH, checkLogo, EMPTY_BRAND, MAX_LOGO_BYTES, parseBrand, readBrand, saveBrand } from '../lib/brand.ts';
import { readRaw } from '../lib/branch.ts';
import { startJob } from '../lib/steps.ts';
import { withFake } from './helpers.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const manifest = (job: string) => ({ job, name: 'v.mov', size: 10, type: 'video/quicktime', lastModified: 0, parts: 1, chunkSize: 4194304, brief: '' });

test('parseBrand cleans what Pavel typed', () => {
  const r = parseBrand({
    handle: ' pavel.malakhouski ', colors: { text: '#ffffff', accent: '#ffd23f', bar: '#FFD23F' }, font: 'Druk Wide', hand: 'caveat',
    signature: '  Пишите в директ  ', hashtags: '#монтаж reels, #видео #монтаж',
  });
  assert.ok('brand' in r, JSON.stringify(r));
  assert.deepEqual(r.brand, {
    handle: '@pavel.malakhouski', colors: { text: '#FFFFFF', accent: '#FFD23F', bar: '#FFD23F' }, font: 'Druk Wide', hand: 'caveat',
    logo: null, signature: 'Пишите в директ', hashtags: ['монтаж', 'reels', 'видео'],
  });
});

test('parseBrand keeps empty fields empty and takes a list of hashtags too', () => {
  const r = parseBrand({ handle: '', colors: null, font: '', hand: null, signature: '', hashtags: ['#a_b', 'c'] });
  assert.ok('brand' in r);
  assert.deepEqual(r.brand, { ...EMPTY_BRAND, hashtags: ['a_b', 'c'] });
});

test('parseBrand says in Russian what is wrong', () => {
  const bad = (input: Record<string, unknown>) => {
    const r = parseBrand(input);
    assert.ok('error' in r, JSON.stringify(input));
    return r.error;
  };
  assert.match(bad({ handle: 'pavel m' }), /ник/i);
  assert.match(bad({ handle: '@' + 'a'.repeat(31) }), /ник/i);
  assert.match(bad({ colors: { text: 'white', accent: '#FFD23F', bar: '#FFD23F' } }), /цвет/i);
  assert.match(bad({ font: '../x' }), /шрифт/i);
  for (const font of ['Inter Tight 2.0', 'Black & White', 'Gilroy (Bold)']) {  // свои шрифты Павла называются по файлу
    const r = parseBrand({ handle: null, colors: null, font, hand: null, signature: null, hashtags: [] });
    assert.ok(!('error' in r) && r.brand.font === font, font);
  }
  assert.match(bad({ signature: 'я'.repeat(301) }), /подпись/i);
  assert.match(bad({ hashtags: 'один два-три' }), /хэштег/i);
  assert.match(bad({ hashtags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), /хэштег/i);
});

test('checkLogo takes PNG, JPEG and WebP up to 2 MB and checks the bytes, not the name', () => {
  assert.equal(checkLogo({ type: 'image/png', base64: PNG.toString('base64') }), null);
  assert.equal(checkLogo({ type: 'image/jpeg', base64: JPG.toString('base64') }), null);
  assert.match(checkLogo({ type: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') }) ?? '', /PNG, JPEG или WebP/);
  assert.match(checkLogo({ type: 'image/png', base64: Buffer.from('<html>').toString('base64') }) ?? '', /не картинка/);
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]);
  assert.match(checkLogo({ type: 'image/png', base64: big.toString('base64') }) ?? '', /2 МБ/);
});

test('saveBrand and readBrand keep the brand and its logo in their own branch', () => withFake(async ({ fake, gh }) => {
  assert.equal(await readBrand(gh), null);
  const brand = { ...EMPTY_BRAND, handle: '@pavel' };
  const saved = await saveBrand(gh, brand, { type: 'image/png', base64: PNG.toString('base64') });
  assert.equal(saved.logo, 'logo.png');
  const read = await readBrand(gh);
  assert.deepEqual(read?.brand, { ...brand, logo: 'logo.png' });
  assert.ok(read?.logoSha);
  assert.deepEqual(Buffer.from(await (await readRaw(gh, BRAND_BRANCH, 'brand/logo.png'))!.arrayBuffer()), PNG);
  // новый логотип другого типа заменяет старый, без логотипа в запросе — остаётся прежний, null — убирает
  await saveBrand(gh, { ...brand, signature: 'привет' }, { type: 'image/jpeg', base64: JPG.toString('base64') });
  assert.equal(fake.read(BRAND_BRANCH, 'brand/logo.png'), null);
  assert.equal((await readBrand(gh))?.brand.logo, 'logo.jpg');
  await saveBrand(gh, { ...brand, signature: 'ещё' }, undefined);
  assert.equal((await readBrand(gh))?.brand.logo, 'logo.jpg');
  await saveBrand(gh, brand, null);
  assert.equal((await readBrand(gh))?.brand.logo, null);
  assert.equal(fake.read(BRAND_BRANCH, 'brand/logo.jpg'), null);
}));

test('a new job takes a copy of the brand: job.json.brand and the logo in its own folder', () => withFake(async ({ fake, gh, routine }) => {
  const ID = '261011-100000-abcd';
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(manifest(ID)));
  await saveBrand(gh, { ...EMPTY_BRAND, handle: '@pavel', hashtags: ['монтаж'] }, { type: 'image/png', base64: PNG.toString('base64') });
  await startJob({ gh, routine }, ID);
  const job = JSON.parse(fake.read(`claude/job-${ID}`, `jobs/${ID}/job.json`) ?? '{}');
  assert.deepEqual(job.brand, { ...EMPTY_BRAND, handle: '@pavel', hashtags: ['монтаж'], logo: 'in/brand/logo.png' });
  const logo = await readRaw(gh, `claude/job-${ID}`, `jobs/${ID}/in/brand/logo.png`);
  assert.deepEqual(Buffer.from(await logo!.arrayBuffer()), PNG);
}));

test('a job without a saved brand has no brand field', () => withFake(async ({ fake, gh, routine }) => {
  const ID = '261011-100001-abcd';
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(manifest(ID)));
  await startJob({ gh, routine }, ID);
  const job = JSON.parse(fake.read(`claude/job-${ID}`, `jobs/${ID}/job.json`) ?? '{}');
  assert.equal('brand' in job, false);
}));
