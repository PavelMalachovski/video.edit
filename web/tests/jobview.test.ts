import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRun, deriveView, readJobFiles, stepIndex, STUCK_MS, type Action, type JobFiles, type JobView, type Screen } from '../lib/jobview.ts';
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
const QUESTIONS = [{ id: 'cut', type: 'choice' as const, title: 'Резать?', options: [{ id: 'all', label: 'Всё' }], default: 'all' }];
const SPEC = {
  font: 'montserrat', hand: 'caveat', colors: { text: '#FFFFFF', accent: '#FFD23F', bar: '#FFD23F', plate: '#111111', outline: '#000000' },
  subtitles: { mode: 'karaoke' as const, words: 3, size: 64, y: 1300 }, hook: { mode: 'plate' as const, size: 72, y: 400 }, bar: { pos: 'bottom' as const, height: 14 },
};
const STYLES = { frame: 'frame.png', frameTime: 1, sample: { words: ['раз'], spoken: 0 }, variants: (['A', 'B', 'C'] as const).map((id) => ({ id, label: id, spec: SPEC })) };
const files = (over: Partial<JobFiles> = {}): JobFiles => ({
  head: 'h1', full: true, job: job(), status: status('analyzing'), statusBroken: false, questions: QUESTIONS, styles: STYLES, review: null, script: null, answers: null, result: null,
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
  assert.equal(deriveView(release(), files({ status: status('waiting_answers') }), T0).screen, 'questions'); // вопросы и стили есть
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
    script: ['delete'],
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

test('a failed step can go back to its last good state', () => {
  const failed = (step: 'analyze' | 'restyle' | 'render' | 'fix') =>
    deriveView(release(), files({ job: job([{ step, attempt: 1, at: new Date(T0).toISOString() }]), status: status('error') }), T0);
  assert.equal(canRun(failed('restyle'), 'back'), null, 'to the previews');
  assert.equal(canRun(failed('render'), 'back'), null, 'to the answers');
  assert.equal(canRun(failed('fix'), 'back'), null, 'to the finished video');
  assert.ok(canRun(failed('analyze'), 'back'), 'nothing before analyze');
  const working: JobView = deriveView(release(), files({ status: status('rendering') }), T0);
  assert.ok(canRun(working, 'back'), 'only after an error');
});

test('long videos get more time before «завис»', () => {
  const at = (duration: number, minutes: number) => deriveView(release(),
    files({ job: { ...job(), duration }, status: status('rendering', T0 - minutes * MIN) }), T0).stuck;
  assert.equal(at(120, 30), 'session', 'a 2-minute video rendering for 30 min is stuck');
  assert.equal(at(600, 30), null, 'a 10-minute video gets twice the time');
  assert.equal(at(600, 55), 'session');
});

test('waiting for answers without questions or styles is an error with retry', () => {
  for (const missing of [{ questions: null }, { styles: null }]) {
    const v = deriveView(release(), files({ status: status('waiting_answers'), ...missing }), T0);
    assert.equal(v.screen, 'error', JSON.stringify(missing));
    assert.match(v.status?.message ?? '', /вопрос|стил/);
    assert.equal(canRun(v, 'retry'), null);
  }
  const list = deriveView(release(), files({ full: false, status: status('waiting_answers'), questions: null, styles: null }), T0);
  assert.equal(list.screen, 'questions', 'the list does not read questions — no false error there');
});

test('a missing read is not remembered for the commit', () => withFake(async ({ fake, gh }) => {
  const head = fake.commit(`claude/job-${ID}`, { [`jobs/${ID}/job.json`]: JSON.stringify(job()), [`jobs/${ID}/status.json`]: JSON.stringify(status('analyzing')) });
  let fail = true;
  const flaky = { ...gh, fetch: (async (url: string | URL, init?: RequestInit) => {
    if (fail && String(url).includes(`/contents/jobs/${ID}`)) {
      fail = false;
      return new Response('{"message":"Not Found"}', { status: 404 });
    }
    return fetch(url, init);
  }) as typeof fetch };
  assert.equal(await readJobFiles(flaky, ID, head), null, 'a transient 404 right after a push');
  assert.notEqual(await readJobFiles(flaky, ID, head), null, 'the next poll reads it again');
}));

test('malformed session files read as missing', () => withFake(async ({ fake, gh }) => {
  const head = fake.commit(`claude/job-${ID}`, {
    [`jobs/${ID}/job.json`]: JSON.stringify(job()),
    [`jobs/${ID}/status.json`]: JSON.stringify(status('waiting_answers')),
    [`jobs/${ID}/questions.json`]: JSON.stringify({ questions: [{ type: 'choice', title: 'без id' }] }),
    [`jobs/${ID}/styles.json`]: JSON.stringify({ ...STYLES, variants: STYLES.variants.map((v) => ({ ...v, spec: { ...v.spec, subtitles: { ...v.spec.subtitles, words: 0 } } })) }),
    [`jobs/${ID}/result.json`]: JSON.stringify({ durations: { source: 1 }, done: 'всё' }),
  });
  const f = await readJobFiles(gh, ID, head);
  assert.equal(f?.questions, null);
  assert.equal(f?.styles, null);
  assert.equal(f?.result, null);
  assert.equal(deriveView(release(), f, T0).screen, 'error');
}));

test('the guide review is read with the other session files', () => withFake(async ({ fake, gh }) => {
  const review = { items: ['hook', 'face', 'value', 'cta', 'text'].map((id) => ({ id, title: id, status: 'ok', note: 'по гайду' })) };
  const head = fake.commit(`claude/job-${ID}`, {
    [`jobs/${ID}/job.json`]: JSON.stringify(job()),
    [`jobs/${ID}/review.json`]: JSON.stringify(review),
  });
  assert.deepEqual((await readJobFiles(gh, ID, head))?.review, review);
  assert.equal((await readJobFiles(gh, ID, head, 'list'))?.review ?? null, null, 'списку задач разбор не нужен');
}));

test('an A/B job shows version B next to A once both are delivered', () => {
  const v = deriveView(release(), files({ status: status('rendered'), released: delivered('final.mp4', 'final.srt', 'final-b.mp4', 'final-b.srt') }), T0);
  assert.deepEqual(v.final, { mp4: 'final.mp4', srt: 'final.srt', b: { mp4: 'final-b.mp4', srt: 'final-b.srt' } });
  const fix = { fixes: [{ text: 'логотип левее', at: new Date(T0).toISOString(), version: 2 }] };
  const v2 = deriveView(release(), files({ fix, status: status('rendered'), released: delivered('final.mp4', 'final-b.mp4', 'final-v2.mp4', 'final-v2-b.mp4') }), T0);
  assert.deepEqual(v2.final, { mp4: 'final-v2.mp4', srt: null, b: { mp4: 'final-v2-b.mp4', srt: null } });
  assert.equal(v2.previous, 'final.mp4');
});

// ---------- задача-сценарий ----------

const SCRIPT = {
  story: 'tutorial' as const,
  hooks: [{ technique: 'value' as const, text: 'Три ошибки' }, { technique: 'engage' as const, text: 'Какой вы ученик?' },
    { technique: 'emotion' as const, text: 'POV: молчу в магазине' }],
  scenes: [{ part: 'hook' as const, t0: 0, t1: 2.5, say: 'Три ошибки', screen: 'Три ошибки', frame: 'крупно' }],
  cta: 'Пиши «чешский»', tips: ['Лицо с первой секунды'], caption: { text: 'Чешский', hashtags: [] },
};
const scriptJob = (): JobFile => ({ ...job(), name: 'Сценарий: чешский', size: 0, type: '', duration: null, kind: 'script',
  script: { topic: 'чешский', goal: 'followers', story: 'any', length: 30, language: 'русский' } });

test('a script job works on analyze, then shows the script; a missing script.json is an error', () => {
  const draft = release([]); // у сценария в черновике нет видео
  const at = (state: Status['state'], over: Partial<JobFiles> = {}) => deriveView(draft, files({ job: scriptJob(), status: status(state), ...over }), T0);
  assert.equal(at('analyzing').screen, 'working');
  const ready = at('script_ready', { script: SCRIPT });
  assert.equal(ready.screen, 'script');
  assert.equal(ready.kind, 'script');
  assert.equal(deriveView(release(), files(), T0).kind, 'video');
  const lost = at('script_ready', { script: null });
  assert.equal(lost.screen, 'error');
  assert.match(lost.status?.message ?? '', /сценари/);
  assert.equal(at('script_ready', { script: null, full: false }).screen, 'script', 'списку задач сценарий читать незачем');
  assert.equal(canRun(ready, 'delete'), null);
  for (const a of ['start', 'answers', 'restyle', 'fix', 'retry', 'back'] as Action[]) assert.notEqual(canRun(ready, a), null, a);
});

test('script.json is read with the other session files', () => withFake(async ({ fake, gh }) => {
  const head = fake.commit(`claude/job-${ID}`, {
    [`jobs/${ID}/job.json`]: JSON.stringify(scriptJob()),
    [`jobs/${ID}/script.json`]: JSON.stringify(SCRIPT),
  });
  assert.deepEqual((await readJobFiles(gh, ID, head))?.script, SCRIPT);
}));

test('the cover of the version is shown once it is delivered', () => {
  const v = deriveView(release(), files({ status: status('rendered'), released: delivered('final.mp4', 'final-cover.png') }), T0);
  assert.deepEqual(v.final, { mp4: 'final.mp4', srt: null, cover: 'final-cover.png' });
});

test('the ads version is shown once it is delivered', () => {
  const v = deriveView(release(), files({ status: status('rendered'), released: delivered('final.mp4', 'final-ad.mp4', 'final-ad.srt') }), T0);
  assert.deepEqual(v.final, { mp4: 'final.mp4', srt: null, ad: { mp4: 'final-ad.mp4', srt: 'final-ad.srt' } });
});
