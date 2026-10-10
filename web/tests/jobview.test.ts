import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRun, deriveView, readJobFiles, stepIndex, STUCK_MS, type Action, type JobFiles, type Screen } from '../lib/jobview.ts';
import type { Release } from '../lib/github.ts';
import type { JobFile, Status } from '../lib/jobfiles.ts';
import { withFake } from './helpers.ts';

const ID = '261010-070509-abcd';
const T0 = Date.UTC(2026, 9, 10, 7, 0, 0);
const MIN = 60_000;

const release = (names: string[] = ['source.part-00000', 'manifest.json']): Release => ({
  id: 7, tag_name: `job-${ID}`, name: 'IMG_1.MOV', draft: true, created_at: new Date(T0).toISOString(),
  assets: names.map((name, i) => ({ id: 100 + i, name, size: 1 })),
});
const job = (runs: JobFile['runs'] = [{ step: 'analyze', attempt: 1, at: new Date(T0).toISOString(), sessionUrl: 'https://claude.ai/code/s1' }]): JobFile => ({
  id: ID, name: 'IMG_1.MOV', size: 1, type: 'video/quicktime', duration: 75, createdAt: new Date(T0).toISOString(), brief: '', uploads: [], runs,
});
const status = (state: Status['state'], at = T0): Status => ({ state, phase: 'Фаза', message: 'Текст', at: new Date(at).toISOString() });
const files = (over: Partial<JobFiles> = {}): JobFiles => ({
  head: 'h1', job: job(), status: status('analyzing'), statusBroken: false, questions: null, styles: null, answers: null, result: null,
  fix: null, restyle: null, released: null, ...over,
});
const delivered = (...names: string[]) => ({ release_id: 7, assets: names.map((name, i) => ({ name, id: 200 + i, size: 1 })), at: new Date(T0).toISOString() });

test('uploading until manifest.json is in the release', () => {
  assert.equal(deriveView(release(['source.part-00000']), null, T0).screen, 'uploading');
  assert.equal(deriveView(release(), null, T0).screen, 'not_started');
});

test('no branch is not_started; runs without status is error', () => {
  assert.equal(deriveView(release(), files({ job: job([]) }), T0).screen, 'not_started');
  const v = deriveView(release(), files({ status: null }), T0);
  assert.equal(v.screen, 'error');
  assert.equal(v.status?.message, 'Сессия не оставила статус');
  assert.equal(v.step, 'analyze');
  assert.equal(v.sessionUrl, 'https://claude.ai/code/s1');
});

test('session states map to screens', () => {
  assert.equal(deriveView(release(), files({ status: status('waiting_answers') }), T0).screen, 'questions');
  for (const s of ['queued', 'analyzing', 'rendering', 'rendered'] as const) {
    assert.equal(deriveView(release(), files({ status: status(s) }), T0).screen, 'working', s);
  }
  assert.equal(deriveView(release(), files({ status: status('error') }), T0).screen, 'error');
});

test('stuck uses server time: 10 min queued, 25 min analyzing', () => {
  assert.equal(STUCK_MS.queued, 10 * MIN);
  assert.equal(deriveView(release(), files({ status: status('queued') }), T0 + 9 * MIN).stuck, null);
  assert.equal(deriveView(release(), files({ status: status('queued') }), T0 + 11 * MIN).stuck, 'session');
  assert.equal(deriveView(release(), files({ status: status('analyzing') }), T0 + 24 * MIN).stuck, null);
  assert.equal(deriveView(release(), files({ status: status('analyzing') }), T0 + 26 * MIN).stuck, 'session');
  assert.equal(deriveView(release(), files({ status: status('waiting_answers') }), T0 + 600 * MIN).stuck, null);
});

test('rendered without released.json for 10 min is stuck delivery', () => {
  assert.equal(deriveView(release(), files({ status: status('rendered') }), T0 + 9 * MIN).stuck, null);
  assert.equal(deriveView(release(), files({ status: status('rendered') }), T0 + 11 * MIN).stuck, 'delivery');
});

test('after a fix the old final is not the result', () => {
  const fix = { fixes: [{ text: 'убери логотип', at: new Date(T0).toISOString(), version: 2 }] };
  const v = deriveView(release(), files({ fix, status: status('rendering'), released: delivered('final.mp4', 'final.srt') }), T0);
  assert.equal(v.screen, 'working');
  assert.equal(v.version, 2);
  assert.equal(v.previous, 'final.mp4');
  const done = deriveView(release(), files({ fix, status: status('rendered'), released: delivered('final.mp4', 'final.srt', 'final-v2.mp4', 'final-v2.srt') }), T0);
  assert.equal(done.screen, 'result');
  assert.deepEqual(done.final, { mp4: 'final-v2.mp4', srt: 'final-v2.srt' });
  assert.equal(done.previous, 'final.mp4');
});

test('delivered version wins over a later error status', () => {
  const v = deriveView(release(), files({ status: status('error', T0 + MIN), released: delivered('final.mp4') }), T0 + 2 * MIN);
  assert.equal(v.screen, 'result');
  assert.deepEqual(v.final, { mp4: 'final.mp4', srt: null });
});

test('canRun allows each action only from its screen', () => {
  const allowed: Record<Screen, Action[]> = {
    uploading: ['delete'],
    not_started: ['start', 'delete'],
    working: [],
    questions: ['answers', 'restyle', 'delete'],
    result: ['fix', 'delete'],
    error: ['retry', 'delete'],
  };
  const actions: Action[] = ['start', 'answers', 'restyle', 'fix', 'retry', 'delete'];
  for (const [screen, ok] of Object.entries(allowed) as [Screen, Action[]][]) {
    const v = { ...deriveView(release(), null, T0), screen, stuck: null };
    for (const a of actions) {
      const why = canRun(v, a);
      assert.equal(why === null, ok.includes(a), `${screen} × ${a}: ${why}`);
      if (why !== null) assert.ok(why.length > 5, why);
    }
  }
  const stuck = { ...deriveView(release(), null, T0), screen: 'working' as Screen, stuck: 'session' as const };
  assert.equal(canRun(stuck, 'retry'), null);
  assert.equal(canRun(stuck, 'delete'), null);
  assert.match(canRun({ ...stuck, stuck: null }, 'delete') ?? '', /Claude ещё работает/);
});

test('readJobFiles reads each file once per commit', () => withFake(async ({ fake, gh }) => {
  const head = fake.commit(`claude/job-${ID}`, {
    [`jobs/${ID}/job.json`]: JSON.stringify(job()),
    [`jobs/${ID}/status.json`]: JSON.stringify(status('waiting_answers')),
    [`jobs/${ID}/questions.json`]: JSON.stringify({ questions: [{ id: 'hook', type: 'choice', title: 'Хук' }] }),
    [`jobs/${ID}/out/released.json`]: JSON.stringify(delivered('final.mp4')),
  });
  let requests = 0;
  const counting = { ...gh, fetch: (async (url: string | URL, init?: RequestInit) => { requests++; return fetch(url, init); }) as typeof fetch };
  const first = await readJobFiles(counting, ID, head);
  assert.ok(first && requests > 0);
  assert.equal(first.questions?.[0].id, 'hook');
  assert.equal(first.status?.state, 'waiting_answers');
  assert.equal(first.released?.assets[0].name, 'final.mp4');
  assert.equal(first.styles, null);
  requests = 0;
  const second = await readJobFiles(counting, ID, head);
  assert.equal(requests, 0);
  assert.deepEqual(second, first);
  assert.equal(await readJobFiles(counting, '261010-070509-none', head), null);
}));

test('broken status.json does not crash the view', () => withFake(async ({ fake, gh }) => {
  const head = fake.commit(`claude/job-${ID}`, { [`jobs/${ID}/job.json`]: JSON.stringify(job()), [`jobs/${ID}/status.json`]: '{' });
  const f = await readJobFiles(gh, ID, head);
  assert.ok(f);
  assert.equal(f.status, null);
  assert.equal(f.statusBroken, true);
  const v = deriveView(release(), f, T0);
  assert.equal(v.screen, 'error');
  assert.match(v.status?.message ?? '', /Сессия не оставила статус/);
}));

test('stepIndex follows the screen and the running step', () => {
  const at = (step: 'analyze' | 'restyle' | 'render' | 'fix', state: Status['state']) =>
    stepIndex(deriveView(release(), files({ job: job([{ step, attempt: 1, at: new Date(T0).toISOString() }]), status: status(state) }), T0));
  assert.equal(stepIndex(deriveView(release(['source.part-00000']), null, T0)), 0); // загрузка
  assert.equal(stepIndex(deriveView(release(), null, T0)), 1); // анализ не запущен — дальше текст
  assert.equal(at('analyze', 'analyzing'), 1);
  assert.equal(at('analyze', 'waiting_answers'), 2);
  assert.equal(at('restyle', 'analyzing'), 3);
  assert.equal(at('render', 'rendering'), 4);
  assert.equal(at('fix', 'error'), 4);
  assert.equal(stepIndex(deriveView(release(), files({ released: delivered('final.mp4') }), T0)), 5); // всё готово
});
