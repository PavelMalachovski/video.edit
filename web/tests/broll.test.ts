import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { brollProxy, clipStart, faceBox, PIP, WINDOW, pipSource } from '../lib/broll.ts';

const SHARED = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/overlay-events.json', import.meta.url), 'utf8')) as {
  broll: { pip: typeof PIP; window: typeof WINDOW; faces: [{ x?: number; y?: number }, [number, number, number, number]][] };
};

test('the face window and the piece of the frame in it are the engine\'s (shared fixture written by the engine)', () => {
  assert.deepEqual(PIP, SHARED.broll.pip);
  assert.deepEqual(WINDOW, SHARED.broll.window, 'клип в окошке — там же, где его ставит рендер');
  for (const [face, box] of SHARED.broll.faces) assert.deepEqual(faceBox(face), { x: box[0], y: box[1], w: box[2], h: box[3] }, JSON.stringify(face));
});

test('the face window takes the zoomed picture: the piece of the frame shrinks toward the face as the player zooms', () => {
  const face = { x: 0.5, y: 0.5 };
  assert.deepEqual(pipSource(face, 1), faceBox(face), 'без зума — тот же кусок');
  const z = pipSource(face, 1.2);
  const box = faceBox(face);
  assert.ok(Math.abs(z.w - box.w / 1.2) < 1e-9 && Math.abs(z.h - box.h / 1.2) < 1e-9);
  assert.ok(Math.abs(z.x - (540 + (box.x - 540) / 1.2)) < 1e-9 && Math.abs(z.y - (960 + (box.y - 960) / 1.2)) < 1e-9, 'к точке лица');
});

test('a B-roll clip starts at its moment, but no later than the clip allows (render._picture)', () => {
  assert.equal(clipStart(2, 10, 3), 2);
  assert.equal(clipStart(9, 10, 3), 7, 'окно не выходит за конец клипа');
  assert.equal(clipStart(undefined, 10, 3), 0);
  assert.equal(clipStart(4, 2, 3), 0, 'клип короче окна — с начала');
  assert.equal(clipStart(4, NaN, 3), 4, 'длина ещё неизвестна — как задано');
});

test('the editor proxy of a B-roll clip is named as vm broll writes it', () => {
  assert.equal(brollProxy('in/uploads/upload-b3.mov'), 'broll-b3.mp4');
  assert.equal(brollProxy('in/uploads/upload-i1.mp4'), null, 'вставка, не перебивка');
  assert.equal(brollProxy('assets/library/a.mp4'), null);
});
