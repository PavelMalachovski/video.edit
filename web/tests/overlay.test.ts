import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildOverlayEvents, frameOf, insertSpans, pyRound, stateAt, type OverlayEdit } from '../lib/overlay.ts';
import { buildSubEvents, type Word } from '../lib/subs.ts';
import { Timeline } from '../lib/timeline.ts';

// Общая с движком фикстура (engine/tests/shared_events.py): события субтитров и слоя — ровно как у движка, число в число.
type Base = { name: string; keep: [number, number][]; speed: number; teaser: [number, number] | null };
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/overlay-events.json', import.meta.url), 'utf8')) as {
  subs: (Base & { words: Word[]; mode: string; n: number; hidden?: [number, number][]; events: unknown[] })[];
  subsRefused: { mode: string; n: number }[];
  overlay: (Base & { edit: OverlayEdit; events: { t0: number; t1: number; state: unknown }[]; insertSpans: [number, number, number][] })[];
  overlayRefused: (Base & { edit: OverlayEdit })[];
};
const tlOf = (c: Base) => new Timeline(c.keep, c.speed, c.teaser);
const plain = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown; // как его запишет JSON: без undefined

test('subtitle events match the engine number for number', () => {
  for (const c of FIXTURE.subs) assert.deepStrictEqual(plain(buildSubEvents(c.words, tlOf(c), c.mode, c.n, c.hidden ?? [])), c.events, c.name);
  assert.ok(FIXTURE.subs.some((c) => c.events.length > 0 && c.mode === 'soft') && FIXTURE.subs.some((c) => c.teaser));
});

test('subtitles refuse what the engine refuses', () => {
  for (const b of FIXTURE.subsRefused) {
    assert.throws(() => buildSubEvents([{ t0: 0, t1: 0.5, text: 'слово' }], new Timeline([[0, 1]], 1), b.mode, b.n), `${b.mode} ${b.n}`);
  }
});

test('layer events and insert frames match the engine number for number', () => {
  for (const c of FIXTURE.overlay) {
    assert.deepStrictEqual(plain(buildOverlayEvents(c.edit, tlOf(c))), c.events, c.name);
    assert.deepStrictEqual(insertSpans(c.edit, tlOf(c)), c.insertSpans, c.name);
  }
});

test('the layer refuses what the engine refuses', () => {
  for (const c of FIXTURE.overlayRefused) assert.throws(() => buildOverlayEvents(c.edit, tlOf(c)), /нужно место на кадре/, c.name);
});

test('rounding is Python’s: a frame on a half rounds to even, decimals by the exact value', () => {
  assert.equal(frameOf(0.35), 10, '0.35 · 30 = 10.5 → 10, как round() движка');
  assert.equal(frameOf(0.05), 2, '1.5 → 2');
  assert.equal(frameOf(1 / 3), 10);
  assert.equal(pyRound(0.0078125, 6), 0.007812, '1/128: ровно половина — к чётной');
  assert.equal(pyRound(2.3000000000000003, 6), 2.3);
  assert.equal(pyRound(1.0000005, 6), 1.000001, 'точное значение чуть больше половины');
  assert.equal(pyRound(0, 6), 0);
});

test('the state at a moment of the video is the event that covers it', () => {
  const events = [{ t0: 0, t1: 1, state: { a: 1 } }, { t0: 1, t1: 2.5, state: { b: 2 } }];
  assert.deepStrictEqual(stateAt(events, 0), { a: 1 });
  assert.deepStrictEqual(stateAt(events, 0.999), { a: 1 });
  assert.deepStrictEqual(stateAt(events, 1), { b: 2 }, 'граница — следующему');
  assert.deepStrictEqual(stateAt(events, 2.5), { b: 2 }, 'конец ролика — последнему');
  assert.deepStrictEqual(stateAt(events, 9), { b: 2 });
  assert.deepStrictEqual(stateAt([], 1), {});
});
