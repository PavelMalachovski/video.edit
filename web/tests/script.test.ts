import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildScriptJob, GOALS, LENGTHS, parseScript, parseScriptRequest, PARTS, saveNextBrief, scriptBrief, STORIES, takeNextBrief, TECHNIQUES,
  type Script,
} from '../lib/script.ts';
import { memoryStorage } from './helpers.ts';

const schema = JSON.parse(readFileSync(new URL('../../engine/vm/schemas/script.json', import.meta.url), 'utf8'));
const NOW = new Date(Date.UTC(2026, 9, 11, 9, 30, 0));
const REQUEST = { topic: 'Как я учу чешский по 15 минут в день', goal: 'followers', story: 'tutorial', length: 30, language: 'чешский' };
const SCRIPT: Script = {
  story: 'tutorial',
  hooks: [
    { technique: 'value', text: '3 ошибки, из-за которых чешский не идёт', frame: 'крупно, смотрю в камеру' },
    { technique: 'engage', text: 'Какой вы ученик: зубрила или болтун?' },
    { technique: 'emotion', text: 'POV: полгода учишь чешский и молчишь в магазине' },
  ],
  scenes: [
    { part: 'hook', t0: 0, t1: 2.5, say: '3 ошибки…', screen: '3 ошибки 🔥', frame: 'крупно, лицо' },
    { part: 'hold', t0: 2.5, t1: 10, say: 'Первая — слова списком', screen: 'Слова — списком', frame: 'средний план' },
    { part: 'hold', t0: 10, t1: 20, say: 'Вторая — молчать', screen: '', frame: 'переход рукой' },
    { part: 'hold', t0: 20, t1: 25, say: 'Третья — без повторов', screen: 'Без повторов', frame: 'крупно' },
    { part: 'reward', t0: 25, t1: 30, say: 'Пиши «чешский»', screen: 'Пиши «чешский»', frame: 'крупно', sound: 'музыка громче' },
  ],
  cta: 'Пиши «чешский» в комментариях — пришлю план',
  tips: ['Лицо в кадре с первой секунды'],
  caption: { text: '3 ошибки в чешском 🇨🇿', hashtags: ['чешский'] },
};

test('the script request takes a topic, a goal, a story type, a length and a language', () => {
  assert.deepEqual(parseScriptRequest({ ...REQUEST, topic: `  ${REQUEST.topic}  ` }), REQUEST);
  for (const [bad, field] of [
    [{ ...REQUEST, topic: 'ok' }, 'topic'], [{ ...REQUEST, topic: 'x'.repeat(301) }, 'topic'], [{ ...REQUEST, goal: 'fame' }, 'goal'],
    [{ ...REQUEST, story: 'vlog' }, 'story'], [{ ...REQUEST, length: 45 }, 'length'], [{ ...REQUEST, language: '' }, 'language'],
  ] as const) {
    const r = parseScriptRequest(bad);
    assert.ok('error' in r && r.error.startsWith(field), `${field}: ${JSON.stringify(r)}`);
  }
  assert.ok('error' in parseScriptRequest(null));
});

test('the story types, hook techniques and parts are the ones script.json allows', () => {
  const p = schema.properties;
  assert.deepEqual(STORIES.map((s) => s.id).filter((id) => id !== 'any'), p.story.enum);
  assert.deepEqual(Object.keys(TECHNIQUES).sort(), [...p.hooks.items.properties.technique.enum].sort());
  assert.deepEqual(Object.keys(PARTS), p.scenes.items.properties.part.enum);
  assert.deepEqual([...LENGTHS], [15, 30, 60, 90]);
  assert.equal(GOALS.length, 4);
});

test('a script job is a job without video: kind script, the request, no uploads, a name from the topic', () => {
  const job = buildScriptJob('261011-093000-abcd', parseScriptRequest(REQUEST) as never, NOW);
  assert.equal(job.kind, 'script');
  assert.deepEqual(job.script, REQUEST);
  assert.equal(job.name, `Сценарий: ${REQUEST.topic}`);
  assert.deepEqual([job.size, job.duration, job.brief, job.uploads, job.runs], [0, null, '', [], []]);
  assert.equal(job.createdAt, NOW.toISOString());
  const long = buildScriptJob('261011-093000-abcd', { ...REQUEST, topic: 'т'.repeat(300) } as never, NOW);
  assert.ok(long.name.length <= 80 && long.name.endsWith('…'), long.name);
});

test('script.json reads as a script; a broken one reads as none', () => {
  assert.deepEqual(parseScript(SCRIPT), SCRIPT);
  for (const bad of [{ ...SCRIPT, hooks: SCRIPT.hooks.slice(0, 2) }, { ...SCRIPT, scenes: [{ ...SCRIPT.scenes[0], part: 'intro' }] },
    { ...SCRIPT, cta: '' }, { ...SCRIPT, caption: null }, { ...SCRIPT, tips: 'снимай' }, null]) {
    assert.equal(parseScript(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('«Снять по сценарию» writes the brief: the chosen hook, the theses on screen, the call and the language', () => {
  assert.equal(scriptBrief(SCRIPT, 'чешский', 1),
    'ХУК: Какой вы ученик: зубрила или болтун?\nТЕЗИСЫ: Слова — списком; Без повторов\nПРИЗЫВ: Пиши «чешский» в комментариях — пришлю план\nЯЗЫК: чешский');
  const plain = scriptBrief({ ...SCRIPT, scenes: SCRIPT.scenes.map((c) => ({ ...c, screen: '' })) }, null, 7);
  assert.equal(plain, 'ХУК: 3 ошибки, из-за которых чешский не идёт\nПРИЗЫВ: Пиши «чешский» в комментариях — пришлю план');
});

test('the brief waits in the browser for the next upload and is taken once', () => {
  const storage = memoryStorage();
  assert.equal(takeNextBrief(storage), null);
  saveNextBrief(storage, 'ХУК: …');
  assert.equal(takeNextBrief(storage), 'ХУК: …');
  assert.equal(takeNextBrief(storage), null, 'второй раз — пусто');
  assert.equal(takeNextBrief(null), null);
});
