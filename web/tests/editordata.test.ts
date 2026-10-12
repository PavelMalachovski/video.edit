import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEditor, MEDIA_NAMES, mediaAsset } from '../lib/editordata.ts';
import { withFake } from './helpers.ts';

const ID = '261010-070509-abcd';
const DIR = `jobs/${ID}`;
const EDIT = {
  speed: 1.1, keep: [[0.5, 3]], words: [{ t0: 0.6, t1: 0.9, text: 'Привет' }], hook: { text: 'Хук', until: 1.5 }, cta: null, inserts: [],
  zooms: [], face: { x: 0.5, y: 0.4 }, music: null, hold: 0, style: {},
};
const MEDIA = {
  duration: 3, proxy: { file: 'out/proxy.mp4', width: 540, height: 960, key: 0.5 }, film: { file: 'film.jpg', step: 0.5, w: 54, h: 96, n: 6 },
  peaks: { perS: 50, data: 'AAAA' },
};
const JOB = { id: ID, name: 'IMG_1.MOV', size: 1, type: 'video/quicktime', duration: 3, createdAt: '2026-10-10T07:05:09Z', brief: '', uploads: [], runs: [{ step: 'analyze', attempt: 1, at: '2026-10-10T07:06:00Z' }] };
const STATUS = { state: 'waiting_answers', phase: 'Ждёт ответов', message: '…', at: '2026-10-10T07:20:00Z', needs: 'answers' };
const released = (...names: string[]) => JSON.stringify({ release_id: 1, assets: names.map((name, i) => ({ name, id: 500 + i, size: 1 })), at: '2026-10-10T07:21:00Z' });

test('the editor gets the draft, the editor files and links to the proxy and the film strip', () => withFake(async ({ fake, gh }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  const head = fake.commit(`claude/job-${ID}`, {
    [`${DIR}/job.json`]: JSON.stringify(JOB), [`${DIR}/status.json`]: JSON.stringify(STATUS), [`${DIR}/edit.json`]: JSON.stringify(EDIT),
    [`${DIR}/editor.json`]: JSON.stringify(MEDIA), [`${DIR}/out/released.json`]: released('proxy.mp4'),
  });
  const e = await loadEditor(gh, ID);
  assert.ok(e);
  assert.equal(e.title, 'IMG_1.MOV');
  assert.equal(e.draft?.hook?.text, 'Хук');
  assert.equal(e.media?.film.n, 6);
  assert.equal(e.proxyUrl, `/api/jobs/${ID}/media?name=proxy.mp4`);
  assert.equal(e.filmUrl, `/api/jobs/${ID}/file?path=film.jpg&v=${head}`);
  assert.equal(e.head, head);
}));

test('no proxy in the release yet, no editor files, no draft — each is null, the rest still comes', () => withFake(async ({ fake, gh }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  fake.commit(`claude/job-${ID}`, { [`${DIR}/job.json`]: JSON.stringify(JOB), [`${DIR}/status.json`]: JSON.stringify(STATUS), [`${DIR}/editor.json`]: JSON.stringify(MEDIA) });
  const e = await loadEditor(gh, ID);
  assert.ok(e && e.media && e.proxyUrl === null && e.draft === null);
  fake.commit(`claude/job-${ID}`, { [`${DIR}/editor.json`]: '{"duration": "x"}', [`${DIR}/edit.json`]: JSON.stringify({ ...EDIT, keep: [[3, 1]] }) });
  const broken = await loadEditor(gh, ID);
  assert.ok(broken && broken.media === null && broken.draft === null && broken.filmUrl === null);
  assert.equal(await loadEditor(gh, '261010-070509-none'), null);
}));

test('only the proxy is served as editor media', () => {
  const files = { released: JSON.parse(released('final.mp4', 'proxy.mp4')) };
  assert.equal(mediaAsset(files, 'proxy.mp4')?.id, 501);
  assert.equal(mediaAsset(files, 'final.mp4'), null, 'ролик — через download');
  assert.equal(mediaAsset({ released: null }, 'proxy.mp4'), null);
});

test('the proxy the player takes from the release is the one the engine writes', () => {
  const schema = JSON.parse(readFileSync(new URL('../../engine/vm/schemas/editor.json', import.meta.url), 'utf8'));
  const file = schema.properties.proxy.properties.file.const as string;
  assert.equal(file, 'out/proxy.mp4');
  assert.deepEqual([...MEDIA_NAMES], [file.replace(/^out\//, '')], 'в релиз Action кладёт файл out/ под его именем');
});
