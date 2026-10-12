import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pictureAt, pictureModel, type PictureModel } from '../lib/picture.ts';
import { draftTracks, type Draft } from '../lib/tracks.ts';
import { blurSigma, flashAlpha } from '../lib/zoom.ts';

const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) < e;
const DRAFT: Draft = {
  speed: 1, keep: [[0, 4], [5, 9]], words: [], hook: null, cta: null, zooms: [{ t: 1, level: 1.1 }, { t: 5.2, level: 1.25, over: 0 }],
  inserts: [{ kind: 'fullscreen', src: 'in/uploads/upload-i1.mp4', t0: 6, t1: 7 }, { kind: 'fullscreen', src: 'assets/library/a.png', t0: 7.5, t1: 7.6 }],
  looks: [{ t0: 2, t1: 3, look: 'bw' }], music: null, face: { x: 0.4, y: 0.3 },
  transitions: [{ t: 5, kind: 'zoom' }, { t: 8, kind: 'flash' }, { t: 2.5, kind: 'blur' }],
};

test('the picture at a moment: zoom to the face, b/w frames, flash, blur, a full-frame cut-in — by the engine\'s formulas', () => {
  const t = draftTracks(DRAFT, { sourceDuration: 9 });
  const m = pictureModel(t.layer, { face: DRAFT.face, transitions: DRAFT.transitions, looks: DRAFT.looks });
  assert.deepEqual(m.face, { x: 0.4, y: 0.3 });
  assert.equal(pictureAt(m, 0.5).zoom, 1, 'до первой ступени — без зума');
  assert.ok(near(pictureAt(m, 3).zoom, 1.1), 'ступень по смыслу — 1,1');
  assert.ok(pictureAt(m, 4.0).zoom > 1.1 + 0.2, `на стыке — толчок перехода zoom: ${pictureAt(m, 4.0).zoom}`);
  assert.ok(pictureAt(m, 2.5).bw && !pictureAt(m, 1.9).bw && !pictureAt(m, 3.1).bw, 'ч/б — кадры куска 2–3');
  assert.equal(pictureAt(m, 7.0).flash, 1, 'вспышка — белый кадр на стыке');
  assert.equal(pictureAt(m, 6.9).flash, 64 / 255, 'кадр 207 — первый кадр белого после прозрачного, как fade альфы ffmpeg');
  assert.equal(pictureAt(m, 7.06).flash, 191 / 255, 'кадр 211 — на четверть прозрачнее');
  assert.equal(pictureAt(m, 7.2).flash, 0);
  assert.ok(near(pictureAt(m, 2.5).blur, Math.sqrt(8 ** 2 + 14 ** 2 + 24 ** 2)), 'смаз сильнее всего на стыке');
  assert.ok(near(pictureAt(m, 2.5 + 0.1).blur, 8), 'у края окна — только первая ступень');
  const cut = pictureAt(m, 5.5).cover;
  assert.ok(cut && cut.video && cut.src === 'in/uploads/upload-i1.mp4', 'перебивка-видео на весь кадр');
  assert.equal(pictureAt(m, 6.6).cover?.src, 'assets/library/a.png', 'перебивка-картинка (не короче 1,5 с, как вставка)');
  assert.equal(pictureAt(m, 8.5).cover, null);
});

const model = (flashes: number[], blurs: number[]): PictureModel => ({ level: () => 1, face: { x: 0.5, y: 0.5 }, looks: [], flashes, blurs, covers: [] });

test('flash and blur go by the frame on screen, as ffmpeg draws each frame of the video', () => {
  const flash = model([1.0], []);
  // на экране в момент t — кадр floor(t · 30): у 1,13 с это кадр 33, ещё в окне вспышки
  const shown = [0.85, 0.9, 0.93, 0.96, 1.0, 1.034, 1.11, 1.13, 1.14].map((t) => Math.round(pictureAt(flash, t).flash * 255));
  assert.deepEqual(shown, [0, 64, 64, 127, 255, 191, 64, 64, 0]);
  for (let n = 20; n < 40; n++) assert.equal(pictureAt(flash, n / 30).flash, flashAlpha(1.0, n), `кадр ${n}`);
  const blur = model([], [1.0]);
  for (let n = 20; n < 40; n++) assert.equal(pictureAt(blur, n / 30).blur, blurSigma(1.0, n), `кадр ${n}`);
  assert.equal(pictureAt(blur, 0.89).blur, 0, 'кадр 26 — до окна смаза');
});

test('flashes and blurs close together add up as the filters run one after another', () => {
  const both = model([6.0, 6.1], [1.0, 1.1]);
  for (let n = 175; n < 190; n++) {
    const [a, b] = [flashAlpha(6.0, n), flashAlpha(6.1, n)];
    assert.ok(near(pictureAt(both, n / 30).flash, 1 - (1 - a) * (1 - b), 1e-12), `белое поверх белого, кадр ${n}`);
  }
  assert.ok(pictureAt(both, 181 / 30).flash > Math.max(flashAlpha(6.0, 181), flashAlpha(6.1, 181)));
  for (let n = 25; n < 40; n++) {
    assert.ok(near(pictureAt(both, n / 30).blur, Math.hypot(blurSigma(1.0, n), blurSigma(1.1, n)), 1e-12), `смаз подряд, кадр ${n}`);
  }
});
