import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, afterEnded, locate, stillSource, tailAt } from '../lib/player.ts';
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

test('playing: from a piece to the next one right after it in the source (Pavel\'s split) — no seek, the video plays on', () => {
  const split = draftTracks({ ...DRAFT, teaser: null }, { splits: [1.2] }).video; // 0,5–1,2 и 1,2–2 — подряд в исходнике
  const on = advance(split, 1.25, 0, 1.195);
  assert.ok(on.index === 1 && on.seek === undefined && near(on.t, split[1].t0), JSON.stringify(on));
  const gap = advance(split, 1.25, 1, 2.0);
  assert.ok(gap.index === 2 && gap.seek === 3, 'через вырезанное — как раньше, с перемоткой');
});

test('the tail plays after the pieces: the clock runs by itself to the end of the card, the picture holds the last frame', () => {
  assert.deepEqual(tailAt(4, 6.5, 1000, 1000), { t: 4, end: false });
  const mid = tailAt(4, 6.5, 1000, 2200);
  assert.ok(near(mid.t, 5.2) && !mid.end);
  assert.deepEqual(tailAt(4, 6.5, 1000, 9000), { t: 6.5, end: true });
  assert.ok(near(stillSource(video), 5 - 1 / 60), 'последний кадр — чуть раньше конца куска');
  assert.equal(stillSource([]), 0);
});

test('the player plays the pieces from their edges on whole frames, as the render cuts them, not from keep as written', () => {
  // keep 0,325 — кадр 9,75 → 10 (половина — к чётному): ролик начинается с кадра 10 исходника (0,3333 с)
  const t = draftTracks({ speed: 1, keep: [[0.325, 2.917], [3.55, 5.0]], words: [], hook: null, cta: null, inserts: [], zooms: [], music: null }, { sourceDuration: 6 });
  const [a, b] = t.video;
  assert.equal(a.src0, 0.325, 'по краям keep — правки');
  assert.ok(Math.abs((a.play0 as number) - 10 / 30) < 1e-9 && Math.abs((a.play1 as number) - 88 / 30) < 1e-9, `${a.play0} ${a.play1}`);
  assert.ok(Math.abs(locate(t.video, 1, 0).src - 10 / 30) < 1e-9, 'начало ролика — кадр 10 исходника');
  assert.ok(Math.abs(locate(t.video, 1, 0.5).src - (10 / 30 + 0.5)) < 1e-9);
  const step = advance(t.video, 1, 0, 88 / 30 - 0.001);
  assert.equal(step.index, 1, 'кусок кончается на своём целом кадре');
  assert.ok(Math.abs((step.seek as number) - (b.play0 as number)) < 1e-9);
  assert.ok(Math.abs(stillSource(t.video) - (150 / 30 - 1 / 60)) < 1e-9, 'стоп-кадр — последний кадр по монтажу');
});

test('the file ends before the video does (the last piece of the recording moved earlier): the next piece plays on from its start', () => {
  // кусок 3–5 (конец записи) переставлен в начало: файл кончается на нём, а дальше — 0,5–2
  const moved = draftTracks({ ...DRAFT, teaser: null, keep: [[3, 5], [0.5, 2]] }, { sourceDuration: 5 }).video;
  const next = afterEnded(moved, 0);
  assert.ok(next && next.index === 1 && near(next.src, 0.5) && near(next.t, moved[1].t0), JSON.stringify(next));
  assert.equal(afterEnded(moved, 1), null, 'на последнем куске — конец ролика');
});
