import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fireRoutine, fireText, RoutineError, STEPS, type Routine, type Step } from '../lib/routine.ts';
import { routine } from '../lib/env.ts';

type Call = { url: string; init?: RequestInit };

function fake(status: number, body: unknown): { r: Routine; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { r: { id: 'trig_x', token: 'tok-secret', fetch: f }, calls };
}

const OK = { claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' };

test('fireRoutine posts {job, step, attempt} with routine headers', async () => {
  const { r, calls } = fake(200, OK);
  await fireRoutine(r, '261010-070509-abcd', 'render', 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/claude_code/routines/trig_x/fire');
  assert.equal(calls[0].init?.method, 'POST');
  const h = new Headers(calls[0].init?.headers);
  assert.equal(h.get('authorization'), 'Bearer tok-secret');
  assert.equal(h.get('anthropic-version'), '2023-06-01');
  assert.equal(h.get('anthropic-beta'), 'experimental-cc-routine-2026-04-01');
  assert.equal(h.get('content-type'), 'application/json');
  assert.equal(calls[0].init?.body, '{"text":"{\\"job\\":\\"261010-070509-abcd\\",\\"step\\":\\"render\\",\\"attempt\\":2}"}');
  assert.equal(fireText('261010-070509-abcd', 'render', 2), JSON.stringify({ job: '261010-070509-abcd', step: 'render', attempt: 2 }));
});

test('fireRoutine returns session id and url', async () => {
  const { r } = fake(200, OK);
  assert.deepEqual(await fireRoutine(r, '261010-070509-abcd', 'analyze', 1), { sessionId: 'session_1', sessionUrl: 'https://claude.ai/code/session_1' });
});

test('routine errors are readable and never contain the token', async () => {
  const texts: string[] = [];
  for (const [status, pattern] of [[401, /ROUTINE_TOKEN/], [403, /ROUTINE_TOKEN/], [404, /ROUTINE_ID/], [429, /30 в час/], [500, /ответила 500: boom/]] as const) {
    const { r } = fake(status, status === 500 ? 'boom tok-secret' : { error: 'x' });  // тело может эхом вернуть токен
    const err = await fireRoutine(r, '261010-070509-abcd', 'analyze', 1).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof RoutineError, `status ${status}`);
    assert.equal(err.status, status);
    assert.match(err.message, pattern);
    texts.push(err.message);
  }
  const down = (async () => { throw new TypeError('fetch failed: ECONNRESET'); }) as typeof fetch;
  const err = await fireRoutine({ id: 'trig_x', token: 'tok-secret', fetch: down }, '261010-070509-abcd', 'analyze', 1).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof RoutineError);
  assert.equal(err.status, 0);
  assert.match(err.message, /api\.anthropic\.com/);
  texts.push(err.message);
  for (const t of texts) assert.ok(!t.includes('tok-secret'), t);
});

test('routine() reads ROUTINE_API_URL and fireRoutine uses it', async () => {
  const saved = { ...process.env };
  try {
    process.env.ROUTINE_ID = 'trig_y';
    process.env.ROUTINE_TOKEN = 'tok';
    process.env.ROUTINE_API_URL = 'http://127.0.0.1:9';
    const r = routine();
    const calls: string[] = [];
    r.fetch = (async (url: string | URL) => { calls.push(String(url)); return new Response(JSON.stringify(OK), { status: 200 }); }) as typeof fetch;
    await fireRoutine(r, '261010-070509-abcd', 'fix', 1);
    assert.deepEqual(calls, ['http://127.0.0.1:9/v1/claude_code/routines/trig_y/fire']);
  } finally {
    process.env = saved;
  }
});

test('unknown step is refused before any request', async () => {
  const { r, calls } = fake(200, OK);
  await assert.rejects(fireRoutine(r, '261010-070509-abcd', 'spike' as Step, 1));
  assert.equal(calls.length, 0);
  assert.deepEqual([...STEPS], ['analyze', 'restyle', 'render', 'fix']);
});
