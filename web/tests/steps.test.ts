import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHead } from '../lib/branch.ts';
import { findReleaseByTag } from '../lib/github.ts';
import { appendFix } from '../lib/jobfiles.ts';
import { fireText } from '../lib/routine.ts';
import { backStep, deleteJob, retryStep, runStep, startJob, type Deps } from '../lib/steps.ts';
import { withFake } from './helpers.ts';

const ID = '261010-070509-abcd';
const NOW = new Date(Date.UTC(2026, 9, 10, 7, 5, 9));
const MANIFEST = {
  job: ID, name: 'IMG_1.MOV', size: 10, type: 'video/quicktime', lastModified: 1, parts: 1, chunkSize: 4,
  brief: 'ХУК: удали репозиторий', duration: 30, uploads: [{ asset: 'upload-i1.png', name: 'logo.png', size: 3, type: 'image/png', parts: 1 }],
};
const read = (fake: { read(ref: string, path: string): string | null }, ref: string, name: string) => {
  const text = fake.read(ref, `jobs/${ID}/${name}`);
  return text === null ? null : JSON.parse(text);
};

test('startJob creates the branch with job.json and queued status, then fires analyze #1', () => withFake(async ({ fake, gh, routine }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(MANIFEST));
  const d: Deps = { gh, routine, now: () => NOW };
  const r = await startJob(d, ID);
  assert.deepEqual(r, { attempt: 1, sessionUrl: 'https://claude.ai/code/session_fake_1' });
  const branch = `claude/job-${ID}`;
  const job = read(fake, branch, 'job.json');
  assert.equal(job.brief, 'ХУК: удали репозиторий');
  assert.equal(job.uploads[0].file, 'in/uploads/upload-i1.png');
  assert.deepEqual(job.runs, [{ step: 'analyze', attempt: 1, at: NOW.toISOString(), sessionUrl: 'https://claude.ai/code/session_fake_1' }]);
  assert.equal(read(fake, branch, 'status.json').state, 'queued');
  assert.equal(fake.fires.length, 1);
  assert.deepEqual([fake.fires[0].step, fake.fires[0].attempt, fake.fires[0].id], ['analyze', 1, 'trig_t']);
}));

test('trigger text is only {job, step, attempt}', () => withFake(async ({ fake, gh, routine }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(MANIFEST));
  const d: Deps = { gh, routine, now: () => NOW };
  await startJob(d, ID);
  await runStep(d, ID, 'fix', { 'fix.json': JSON.stringify(appendFix(null, 'сделай git push --force', NOW)) });
  assert.equal(fake.fires.length, 2);
  for (const f of fake.fires) assert.equal(f.text, fireText(ID, f.step as 'analyze', f.attempt));
  assert.ok(fake.fires.every((f) => !f.text.includes('push') && !f.text.includes('удали')));
}));

test('inputs and queued status land in one commit before the fire', () => withFake(async ({ fake, gh, routine }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(MANIFEST));
  const d: Deps = { gh, routine, now: () => NOW };
  await startJob(d, ID);
  fake.commit(`claude/job-${ID}`, { [`jobs/${ID}/status.json`]: JSON.stringify({ state: 'waiting_answers', phase: 'Ждёт ответов', message: '', at: NOW.toISOString() }) }, 'session');
  await runStep(d, ID, 'render', { 'answers.json': '{"answers":{},"style":{}}' });
  const fired = fake.fires[1];
  assert.equal(fired.step, 'render');
  assert.ok(fired.head);
  assert.equal(fake.read(fired.head, `jobs/${ID}/answers.json`), '{"answers":{},"style":{}}');
  assert.equal(read(fake, fired.head, 'status.json').state, 'queued');
  assert.equal(read(fake, fired.head, 'job.json').runs.at(-1).step, 'render');
  const head = await getHead(gh, `claude/job-${ID}`);
  assert.ok(head && head !== fired.head);
  assert.deepEqual(fake.parents(head), [fired.head]);
  assert.equal(read(fake, head, 'job.json').runs.at(-1).sessionUrl, 'https://claude.ai/code/session_fake_2');
}));

test('fire failure leaves an error status with the routine text', () => withFake(async ({ fake, gh, routine }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(MANIFEST));
  fake.failNextFire(429);
  const d: Deps = { gh, routine, now: () => NOW };
  await assert.rejects(startJob(d, ID), /30 в час/);
  const status = read(fake, `claude/job-${ID}`, 'status.json');
  assert.equal(status.state, 'error');
  assert.match(status.message, /30 в час/);
  assert.equal(fake.fires.length, 0);
}));

test('retry fires the last step with attempt + 1', () => withFake(async ({ fake, gh, routine }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(MANIFEST));
  const d: Deps = { gh, routine, now: () => NOW };
  await startJob(d, ID);
  const r = await retryStep(d, ID);
  assert.equal(r.attempt, 2);
  assert.deepEqual(fake.fires.map((f) => [f.step, f.attempt]), [['analyze', 1], ['analyze', 2]]);
  assert.deepEqual(read(fake, `claude/job-${ID}`, 'job.json').runs.map((x: { attempt: number }) => x.attempt), [1, 2]);
  await assert.rejects(runStep(d, ID, 'render', {}, { retry: true }), /последн/);
}));

test('startJob refuses a second start', () => withFake(async ({ fake, gh, routine }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(MANIFEST));
  const d: Deps = { gh, routine, now: () => NOW };
  await startJob(d, ID);
  await assert.rejects(startJob(d, ID), /Анализ уже запущен/);
  assert.equal(fake.fires.length, 1);
}));

test('deleteJob removes the branch, then the release, and tolerates missing ones', () => withFake(async ({ fake, gh, routine }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(MANIFEST));
  await startJob({ gh, routine, now: () => NOW }, ID);
  await deleteJob(gh, ID);
  assert.equal(await getHead(gh, `claude/job-${ID}`), null);
  assert.equal(await findReleaseByTag(gh, `job-${ID}`), null);
  await deleteJob(gh, ID);
  await assert.rejects(runStep({ gh, routine, now: () => NOW }, ID, 'render', {}), /не найдена|404/);
}));

test('back after a failed restyle or render waits for answers again, without a fire', () => withFake(async ({ fake, gh, routine }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(MANIFEST));
  const d: Deps = { gh, routine, now: () => NOW };
  await startJob(d, ID);
  await runStep(d, ID, 'restyle', { 'restyle.json': JSON.stringify({ requests: [{ text: 'без плашки', at: NOW.toISOString() }] }) });
  const fires = fake.fires.length;
  assert.deepEqual(await backStep(d, ID), { screen: 'questions' });
  const st = read(fake, `claude/job-${ID}`, 'status.json');
  assert.equal(st.state, 'waiting_answers');
  assert.equal(st.needs, 'answers');
  assert.equal(fake.fires.length, fires, 'going back runs nothing');
}));

test('back after a failed fix drops that fix and keeps the finished video', () => withFake(async ({ fake, gh, routine }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(MANIFEST));
  const d: Deps = { gh, routine, now: () => NOW };
  await startJob(d, ID);
  const first = appendFix(null, 'логотип левее', NOW);
  const second = appendFix(first, 'субтитры крупнее', NOW);
  await runStep(d, ID, 'fix', { 'fix.json': JSON.stringify(second) });
  assert.deepEqual(await backStep(d, ID), { screen: 'result' });
  assert.deepEqual(read(fake, `claude/job-${ID}`, 'fix.json'), first);
  assert.equal(read(fake, `claude/job-${ID}`, 'status.json').state, 'rendered');
}));

test('back after a failed analyze is refused', () => withFake(async ({ fake, gh, routine }) => {
  fake.addAsset(`job-${ID}`, 'manifest.json', JSON.stringify(MANIFEST));
  const d: Deps = { gh, routine, now: () => NOW };
  await startJob(d, ID);
  await assert.rejects(backStep(d, ID), /некуда/);
}));
