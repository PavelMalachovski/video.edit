import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { deliverOutputs, planOutputs } from '../lib/outputs.ts';
import { getHead } from '../lib/branch.ts';
import { readJobFiles } from '../lib/jobview.ts';
import { withFake } from './helpers.ts';

const ID = '261026-104538-jwup';
const DIR = `jobs/${ID}`;
const entry = (name: string, size = 1) => ({ name, type: 'file' as const, sha: name, size });

test('what the session left in out/: plain files as they are, parts joined in order with their sum; released.json stays', () => {
  const plan = planOutputs([entry('final.srt'), entry('released.json'), entry('final.mp4.part-ab', 5), entry('final.mp4.sha256'),
    entry('final.mp4.part-aa', 10), entry('cover-v1.jpg'), { name: 'tmp', type: 'dir', sha: 'x', size: 0 }]);
  assert.deepEqual(plan.outputs, [
    { name: 'cover-v1.jpg', parts: ['cover-v1.jpg'], size: 1, sha256: null },
    { name: 'final.mp4', parts: ['final.mp4.part-aa', 'final.mp4.part-ab'], size: 15, sha256: 'final.mp4.sha256' },
    { name: 'final.srt', parts: ['final.srt'], size: 1, sha256: null },
  ]);
  assert.deepEqual(plan.remove.sort(), ['cover-v1.jpg', 'final.mp4.part-aa', 'final.mp4.part-ab', 'final.mp4.sha256', 'final.srt']);
  assert.deepEqual(planOutputs([entry('released.json')]).outputs, [], 'нечего переносить');
});

test('the page moves the finished video from the job branch into its draft release, as the Action did', () => withFake(async ({ fake, gh }) => {
  const video = crypto.randomBytes(3000);
  const big = crypto.randomBytes(5000);
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  fake.commit(`claude/job-${ID}`, {
    [`${DIR}/status.json`]: '{}', [`${DIR}/out/final.mp4`]: video, [`${DIR}/out/final.srt`]: '1\n00:00:00,000 --> 00:00:01,000\nПривет\n',
    [`${DIR}/out/proxy.mp4.part-aa`]: big.subarray(0, 4000), [`${DIR}/out/proxy.mp4.part-ab`]: big.subarray(4000),
    [`${DIR}/out/proxy.mp4.sha256`]: `${crypto.createHash('sha256').update(big).digest('hex')}  proxy.mp4\n`,
  });
  const head = fake.read(`claude/job-${ID}`, `${DIR}/status.json`);
  assert.equal(head, '{}');
  assert.equal(await deliverOutputs(gh, ID), true);
  const released = JSON.parse(fake.read(`claude/job-${ID}`, `${DIR}/out/released.json`) ?? '{}');
  const names = released.assets.map((a: { name: string }) => a.name).sort();
  assert.deepEqual(names, ['final.mp4', 'final.srt', 'manifest.json', 'proxy.mp4']);
  for (const name of ['final.mp4', 'final.srt', 'proxy.mp4.part-aa', 'proxy.mp4.part-ab', 'proxy.mp4.sha256']) {
    assert.equal(fake.read(`claude/job-${ID}`, `${DIR}/out/${name}`), null, `${name} убран из ветки`);
  }
  const download = async (name: string) => {
    const a = released.assets.find((x: { name: string }) => x.name === name);
    const r = await fetch(`${gh.api}/repos/o/r/releases/assets/${a.id}`, { headers: { Accept: 'application/octet-stream' } });
    return Buffer.from(await r.arrayBuffer());
  };
  assert.ok((await download('final.mp4')).equals(video));
  assert.ok((await download('proxy.mp4')).equals(big), 'куски — склеены по порядку');
  assert.equal(await deliverOutputs(gh, ID), false, 'второй раз — нечего');
  const files = await readJobFiles(gh, ID, (await getHead(gh, `claude/job-${ID}`))!);
  assert.equal(files?.outputs, false);
}));

test('a part that does not match its sha256 is not delivered and stays in the branch', () => withFake(async ({ fake, gh }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  fake.commit(`claude/job-${ID}`, {
    [`${DIR}/out/final.mp4.part-aa`]: 'abc', [`${DIR}/out/final.mp4.part-ab`]: 'def', [`${DIR}/out/final.mp4.sha256`]: `${'0'.repeat(64)}  final.mp4\n`,
  });
  await assert.rejects(deliverOutputs(gh, ID), /sha256/);
  assert.equal(fake.read(`claude/job-${ID}`, `${DIR}/out/final.mp4.part-aa`), 'abc');
  const release = (await (await fetch(`${gh.api}/repos/o/r/releases`)).json())[0];
  assert.deepEqual(release.assets.map((a: { name: string }) => a.name), ['manifest.json'], 'битый ролик в черновик не попал');
}));

test('the job files say when out/ has files to deliver', () => withFake(async ({ fake, gh }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', '{}');
  const head = fake.commit(`claude/job-${ID}`, { [`${DIR}/status.json`]: '{}', [`${DIR}/out/final.mp4`]: 'x' });
  assert.equal((await readJobFiles(gh, ID, head))?.outputs, true);
  const none = fake.commit(`claude/job-${ID}`, { [`${DIR}/out/final.mp4`]: null, [`${DIR}/out/released.json`]: '{}' });
  assert.equal((await readJobFiles(gh, ID, none))?.outputs, false);
}));
