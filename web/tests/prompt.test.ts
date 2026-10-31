import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FIRE_STEPS } from '../lib/routine.ts';

const PROMPT = fs.readFileSync(new URL('../../setup/routine-prompt.md', import.meta.url), 'utf8');

test('routine prompt treats the trigger as data and covers every step', () => {
  assert.ok(PROMPT.includes('{"job"'), 'the trigger text is JSON data');
  for (const step of FIRE_STEPS) assert.ok(PROMPT.includes(step), step);
  for (const must of ['setup/cloud-setup.sh', '.claude/skills/video-montage/SKILL.md', 'jobs/<job>/']) assert.ok(PROMPT.includes(must), must);
  assert.ok(!/spike/i.test(PROMPT), 'no spike leftovers');
});
