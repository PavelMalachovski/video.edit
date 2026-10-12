import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyKeep, commit, cutSpan, EMPTY, initHistory, LIMITS, parseTimeline, pieces, redo, restoreSpan, setMusic, setSound, setVoice, snapTo,
  splitAt, trimEnd, trimStart, undo, type Edit,
} from '../lib/edits.ts';

// Общая с движком фикстура: apply_keep в engine/vm/edits.py обязан давать то же самое.
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/edits.json', import.meta.url), 'utf8')) as {
  cases: { name: string; keep: [number, number][]; duration: number; edits: Edit[]; expected: [number, number][] }[];
  refused: unknown[]; sliver: number;
};
const SCHEMA = JSON.parse(fs.readFileSync(new URL('../../engine/vm/schemas/timeline.json', import.meta.url), 'utf8'));

test('applyKeep matches the shared engine fixture', () => {
  for (const c of FIXTURE.cases) assert.deepEqual(applyKeep(c.keep, c.edits, c.duration), c.expected, c.name);
  for (const bad of FIXTURE.refused) {
    assert.throws(() => applyKeep([[0, 3]], [{ op: 'cut', t0: 0, t1: 0.5 }, bad as Edit], 4), /edits\[1\]/, JSON.stringify(bad));
  }
});

test('parseTimeline takes what the schema takes and refuses the rest; the limits are the schema\'s', () => {
  const ok = {
    rev: 2, at: '2026-10-12T15:00:00Z', edits: [{ op: 'cut', t0: 1, t1: 2 }, { op: 'split', t: 3 }], voice: { gainDb: -3, muted: false },
    music: { gainDb: -20, muted: false, at: 1.5, from: 12, fadeIn: 0.5, fadeOut: 2 }, sounds: { 'insert:0': { gainDb: 4 }, teaser: { muted: true } },
  };
  assert.deepEqual(parseTimeline(ok), ok);
  for (const bad of [
    { ...ok, rev: 0 }, { ...ok, edits: [{ op: 'cut', t0: -1, t1: 1 }] }, { ...ok, edits: [{ op: 'jump', t: 1 }] }, { ...ok, voice: { gainDb: 40 } },
    { ...ok, music: { fadeIn: 20 } }, { ...ok, sounds: { 'insert:x': { gainDb: 1 } } }, { ...ok, sounds: { teaser: { gainDb: 'громче' } } }, { ...ok, extra: true },
    { ...ok, edits: Array(LIMITS.edits + 1).fill({ op: 'split', t: 1 }) }, null,
  ]) assert.equal(parseTimeline(bad), null, JSON.stringify(bad).slice(0, 80));
  const level = SCHEMA.$defs.Level.properties.gainDb;
  const music = SCHEMA.$defs.Music.properties;
  assert.deepEqual([level.minimum, level.maximum], [LIMITS.gain.min, LIMITS.gain.max]);
  assert.deepEqual([music.gainDb.minimum, music.gainDb.maximum, music.fadeIn.maximum], [LIMITS.musicGain.min, LIMITS.musicGain.max, LIMITS.fade.max]);
  assert.equal(SCHEMA.properties.edits.maxItems, LIMITS.edits);
});

test('pieces: the cut with Pavel\'s splits; a split in a cut part shows nothing', () => {
  const keep: [number, number][] = [[0.5, 4], [5, 7]];
  const h = splitAt(splitAt(EMPTY, 2), 4.5);
  assert.deepEqual(pieces(applyKeep(keep, h.edits), h.edits), [[0.5, 2], [2, 4], [5, 7]]);
});

test('cut, restore and trims are edits in source time; trims stop at the neighbour', () => {
  const keep: [number, number][] = [[0.5, 2], [3, 5]];
  assert.deepEqual(cutSpan(EMPTY, 1, 1.5).edits, [{ op: 'cut', t0: 1, t1: 1.5 }]);
  assert.deepEqual(restoreSpan(EMPTY, 2, 3).edits, [{ op: 'restore', t0: 2, t1: 3 }]);
  // начало второго куска: правее — вырезать, левее — вернуть, но не дальше конца первого
  assert.deepEqual(trimStart(EMPTY, keep, 1, 3.4).edits, [{ op: 'cut', t0: 3, t1: 3.4 }]);
  assert.deepEqual(trimStart(EMPTY, keep, 1, 1.0).edits, [{ op: 'restore', t0: 2, t1: 3 }]);
  // конец первого куска: левее — вырезать, правее — вернуть, но не дальше начала второго
  assert.deepEqual(trimEnd(EMPTY, keep, 0, 1.6).edits, [{ op: 'cut', t0: 1.6, t1: 2 }]);
  assert.deepEqual(trimEnd(EMPTY, keep, 0, 9).edits, [{ op: 'restore', t0: 2, t1: 3 }]);
  assert.equal(trimEnd(EMPTY, keep, 0, 2), EMPTY, 'на месте — правки нет');
  assert.equal(trimStart(EMPTY, keep, 1, 4.99).edits.length, 1, 'кусок короче кадра не оставляется — вырезается целиком');
  assert.deepEqual(trimStart(EMPTY, keep, 1, 4.99).edits[0], { op: 'cut', t0: 3, t1: 5 });
});

test('sound edits: voice, music and a sound, within the limits', () => {
  assert.deepEqual(setVoice(EMPTY, { gainDb: -50 }).voice, { gainDb: LIMITS.gain.min });
  assert.deepEqual(setMusic(EMPTY, { at: 2, fadeOut: 99 }).music, { at: 2, fadeOut: LIMITS.fade.max });
  assert.deepEqual(setSound(EMPTY, 'insert:0', { muted: true }).sounds, { 'insert:0': { muted: true } });
  assert.deepEqual(setMusic(setMusic(EMPTY, { gainDb: -10 }), { muted: true }).music, { gainDb: -10, muted: true }, 'поля складываются');
});

test('snap: a moment goes to the nearest word edge within reach, else stays', () => {
  const edges = [1.0, 1.4, 2.2];
  assert.equal(snapTo(1.33, edges, 0.15), 1.4);
  assert.equal(snapTo(1.8, edges, 0.15), 1.8);
  assert.equal(snapTo(0.9, edges, 0.15), 1.0);
});

test('history: undo and redo step through the edits; a new edit drops the redo', () => {
  let h = initHistory(EMPTY);
  h = commit(h, cutSpan(h.present, 1, 2));
  h = commit(h, restoreSpan(h.present, 1, 1.5));
  assert.equal(h.present.edits.length, 2);
  h = undo(h);
  assert.equal(h.present.edits.length, 1);
  h = redo(h);
  assert.equal(h.present.edits.length, 2);
  h = undo(undo(h));
  assert.equal(h.present, EMPTY);
  assert.equal(undo(h), h, 'отменять нечего');
  h = commit(h, splitAt(h.present, 3));
  assert.equal(redo(h), h, 'новая правка — повторять нечего');
});
