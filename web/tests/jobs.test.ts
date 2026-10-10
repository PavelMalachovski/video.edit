import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newJobId, partName, chunkCount, CHUNK_SIZE, jobTag } from '../lib/jobs.ts';

test('job id is UTC date-time plus 4 base36 chars', () => {
  const id = newJobId(new Date(Date.UTC(2026, 9, 10, 7, 5, 9)), () => 0.5);
  assert.match(id, /^261010-070509-[0-9a-z]{4}$/);
  assert.equal(jobTag(id), `job-${id}`);
});

test('part names are zero-padded and sort in order', () => {
  assert.equal(partName(0), 'source.part-00000');
  assert.equal(partName(123), 'source.part-00123');
  const names = [10, 2, 1].map(partName).sort();
  assert.deepEqual(names, ['source.part-00001', 'source.part-00002', 'source.part-00010']);
});

test('chunk size fits under the Vercel 4.5 MB body limit', () => {
  assert.ok(CHUNK_SIZE <= 4 * 1024 * 1024);
  assert.equal(chunkCount(0), 0);
  assert.equal(chunkCount(1), 1);
  assert.equal(chunkCount(CHUNK_SIZE), 1);
  assert.equal(chunkCount(CHUNK_SIZE + 1), 2);
});
