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
  const m = pictureModel(t.layer, { face: DRAFT.face });
  assert.deepEqual(m.face, { x: 0.4, y: 0.3 });
  assert.equal(pictureAt(m, 0.5).zoom, 1, 'до первой ступени — без зума');
  assert.ok(near(pictureAt(m, 3).zoom, 1.1), 'ступень по смыслу — 1,1');
  assert.ok(pictureAt(m, 4.0).zoom > 1.1 + 0.2, `на стыке — толчок перехода zoom: ${pictureAt(m, 4.0).zoom}`);
  assert.ok(pictureAt(m, 2.5).look === 'bw' && pictureAt(m, 1.9).look === null && pictureAt(m, 3.1).look === null, 'ч/б — кадры куска 2–3');
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

test('the picture follows Pavel\'s picture edits: zoom half as strong, a b/w piece off in colour, a transition off or of another kind', () => {
  const fixes = { zoom: 0.5, looks: [{ at: [2, 3] as [number, number], off: true as const }], transitions: [{ at: 5, off: true as const }, { at: 8, kind: 'blur' as const }] };
  const m = pictureModel(draftTracks(DRAFT, { sourceDuration: 9, fixes }).layer, { face: DRAFT.face });
  assert.ok(near(pictureAt(m, 3).zoom, 1.05), 'ступень 1,1 — вполовину');
  assert.ok(near(pictureAt(m, 4.0).zoom, 1.125) && near(pictureAt(m, 3.95).zoom, 1.05), 'на стыке — сразу ступень 1,25 вполовину, толчка нет: переход убран');
  assert.equal(pictureAt(m, 2.5).look, null, 'ч/б-кусок убран — в цвете');
  assert.equal(pictureAt(m, 7.0).flash, 0, 'вместо вспышки — смаз');
  assert.ok(near(pictureAt(m, 7.0).blur, Math.sqrt(8 ** 2 + 14 ** 2 + 24 ** 2)));
});

test('pieces by hand and other filters show on their frames; the later piece wins where pieces meet', () => {
  const fixes = { looks: [{ at: [2, 3] as [number, number], look: 'sepia' as const }, { t0: 2.5, t1: 3.5, look: 'cold' as const }, { t0: 6, t1: 7, look: 'film' as const }] };
  const m = pictureModel(draftTracks(DRAFT, { sourceDuration: 9, fixes }).layer, { face: DRAFT.face });
  assert.equal(pictureAt(m, 2.2).look, 'sepia', 'кусок сессии — другим фильтром');
  assert.equal(pictureAt(m, 2.8).look, 'cold', 'свой кусок — позже в списке, на общих кадрах сильнее');
  assert.equal(pictureAt(m, 3.4).look, 'cold');
  assert.equal(pictureAt(m, 5.5).look, 'film', 'исходник 6–7 с — ролик 5–6 с');
  assert.equal(pictureAt(m, 3.9).look, null);
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

test('a B-roll clip in the picture: its moment, a face window, its sound — as the session or Pavel set them', () => {
  const draft: Draft = { ...DRAFT, inserts: [{ kind: 'fullscreen', src: 'in/uploads/upload-b1.mov', t0: 6, t1: 7.5, from: 3, layout: 'pip', audio: true },
    { kind: 'fullscreen', src: 'in/uploads/upload-b2.jpg', t0: 7.6, t1: 8.8 }] };
  const m = pictureModel(draftTracks(draft, { sourceDuration: 9 }).layer, { face: draft.face });
  const clip = pictureAt(m, 5.5).cover;
  assert.ok(clip);
  assert.deepEqual([clip.from, clip.layout, clip.audio, clip.video], [3, 'pip', true, true]);
  const still = pictureAt(m, 6.9).cover;
  assert.deepEqual([still?.src, still?.from, still?.layout, still?.audio, still?.video], ['in/uploads/upload-b2.jpg', 0, 'full', false, false], 'по умолчанию — с начала, на весь кадр, без звука');
});
