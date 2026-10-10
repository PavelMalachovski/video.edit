import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitFiles, deleteBranch, getHead, listDir, listHeads, readRaw, readText } from '../lib/branch.ts';
import { GitHubError } from '../lib/github.ts';
import { withFake } from './helpers.ts';

test('commitFiles creates the branch from master with all files in one commit', () => withFake(async ({ fake, gh }) => {
  const master = await getHead(gh, 'master');
  assert.ok(master);
  const sha = await commitFiles(gh, 'claude/job-a', { 'jobs/a/job.json': '{"id":"a"}', 'jobs/a/status.json': '{"state":"queued"}' }, 'web(a): start', { base: 'master' });
  assert.equal(await getHead(gh, 'claude/job-a'), sha);
  assert.equal(fake.read('claude/job-a', 'jobs/a/job.json'), '{"id":"a"}');
  assert.equal(fake.read('claude/job-a', 'jobs/a/status.json'), '{"state":"queued"}');
  assert.match(fake.read('claude/job-a', 'README.md') ?? '', /video\.edit/);
  assert.deepEqual(fake.history('claude/job-a').map((c) => c.message), ['web(a): start', 'init']);
  assert.deepEqual(fake.parents(sha), [master]);
}));

test('commitFiles appends to an existing branch', () => withFake(async ({ fake, gh }) => {
  fake.commit('claude/job-b', { 'jobs/b/job.json': '{}' }, 'start');
  const before = await getHead(gh, 'claude/job-b');
  await commitFiles(gh, 'claude/job-b', { 'jobs/b/answers.json': '{"answers":{}}' }, 'web(b): answers');
  assert.equal(fake.read('claude/job-b', 'jobs/b/job.json'), '{}');
  assert.equal(fake.read('claude/job-b', 'jobs/b/answers.json'), '{"answers":{}}');
  assert.deepEqual(fake.parents((await getHead(gh, 'claude/job-b')) ?? ''), [before]);
}));

test('commitFiles survives a concurrent push and never forces', () => withFake(async ({ fake, gh }) => {
  fake.commit('claude/job-c', { 'jobs/c/job.json': '{}' }, 'start');
  fake.onBeforePatch = (branch: string) => {
    fake.onBeforePatch = null;
    fake.commit(branch, { 'jobs/c/status.json': '{"state":"analyzing"}' }, 'status(c): session');
  };
  await commitFiles(gh, 'claude/job-c', { 'jobs/c/answers.json': '{}' }, 'web(c): answers');
  assert.equal(fake.read('claude/job-c', 'jobs/c/status.json'), '{"state":"analyzing"}');
  assert.equal(fake.read('claude/job-c', 'jobs/c/answers.json'), '{}');
  assert.deepEqual(fake.history('claude/job-c').map((c) => c.message), ['web(c): answers', 'status(c): session', 'start', 'init']);
  assert.ok(fake.patches.length >= 2 && fake.patches.every((p: { force?: boolean }) => p.force === false), JSON.stringify(fake.patches));
}));

test('commitFiles without base fails on a missing branch', () => withFake(async ({ gh }) => {
  const err = await commitFiles(gh, 'claude/job-none', { 'x.txt': 'x' }, 'm').then(() => null, (e: unknown) => e);
  assert.ok(err instanceof GitHubError);
  assert.equal(err.status, 404);
}));

test('readText and listDir return null when missing', () => withFake(async ({ fake, gh }) => {
  fake.commit('claude/job-d', { 'jobs/d/job.json': '{"id":"d"}', 'jobs/d/out/final.srt': '1\n' }, 'start');
  assert.equal(await readText(gh, 'claude/job-d', 'jobs/d/job.json'), '{"id":"d"}');
  assert.equal(await readText(gh, 'claude/job-d', 'jobs/d/nope.json'), null);
  assert.equal(await readText(gh, 'claude/job-zzz', 'jobs/d/job.json'), null);
  const dir = await listDir(gh, 'claude/job-d', 'jobs/d');
  assert.deepEqual(dir?.map((e) => [e.name, e.type]).sort(), [['job.json', 'file'], ['out', 'dir']]);
  assert.equal(await listDir(gh, 'claude/job-d', 'jobs/nope'), null);
  const raw = await readRaw(gh, 'claude/job-d', 'jobs/d/out/final.srt');
  assert.equal(await raw?.text(), '1\n');
}));

test('deleteBranch tolerates a missing branch', () => withFake(async ({ fake, gh }) => {
  fake.commit('claude/job-e', { 'jobs/e/job.json': '{}' }, 'start');
  await deleteBranch(gh, 'claude/job-e');
  assert.equal(await getHead(gh, 'claude/job-e'), null);
  await deleteBranch(gh, 'claude/job-e');
}));

test('listHeads returns only matching branches', () => withFake(async ({ fake, gh }) => {
  const a = fake.commit('claude/job-f1', { 'jobs/f1/job.json': '{}' });
  const b = fake.commit('claude/job-f2', { 'jobs/f2/job.json': '{}' });
  fake.commit('other/branch', { 'x.txt': 'x' });
  const heads = await listHeads(gh, 'claude/job-');
  assert.deepEqual([...heads.entries()].sort(), [['claude/job-f1', a], ['claude/job-f2', b]]);
}));
