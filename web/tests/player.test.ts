import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, locate } from '../lib/player.ts';
import { draftTracks, type Draft } from '../lib/tracks.ts';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const DRAFT: Draft = {
  speed: 1.25, keep: [[0.5, 2], [3, 5]], words: [], hook: null, cta: null, inserts: [], zooms: [], music: null, teaser: { t0: 3.5, t1: 4.5 },
};
const video = draftTracks(DRAFT).video; // тизер 3,5–4,5, потом 0,5–2 и 3–5

test('a final time is a piece and a source time; past the end — the end of the last piece', () => {
  assert.deepEqual(locate(video, 1.25, 0), { index: 0, src: 3.5 });
  const second = locate(video, 1.25, 0.8 + 0.4);
  assert.ok(second.index === 1 && near(second.src, 0.5 + 0.4 * 1.25), JSON.stringify(second));
  const end = locate(video, 1.25, 99);
  assert.ok(end.index === 2 && near(end.src, 5), JSON.stringify(end));
});

test('playing: inside a piece the final time follows the source; at the end of the teaser it jumps back to an earlier source', () => {
  const inside = advance(video, 1.25, 0, 4.0);
  assert.ok(inside.index === 0 && inside.seek === undefined && near(inside.t, 0.5 / 1.25), JSON.stringify(inside));
  const jump = advance(video, 1.25, 0, 4.5);
  assert.ok(jump.index === 1 && jump.seek === 0.5 && near(jump.t, 0.8), `после тизера — назад, к 0,5 с исходника: ${JSON.stringify(jump)}`);
  const cut = advance(video, 1.25, 1, 2.0);
  assert.ok(cut.index === 2 && cut.seek === 3, 'вырезанное 2–3 с пропускается');
});

test('playing: the end of the last piece is the end of the video', () => {
  const end = advance(video, 1.25, 2, 5.0);
  assert.ok(end.end && end.index === 2 && near(end.t, (1 + 1.5 + 2) / 1.25), JSON.stringify(end));
  const before = advance(video, 1.25, 2, 4.9);
  assert.ok(!before.end && before.seek === undefined);
});
