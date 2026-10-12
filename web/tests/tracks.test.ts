import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePeaks, draftTracks, parseDraft, parseMedia, peakAt, type Draft } from '../lib/tracks.ts';
import { overlayAt, subGroupSize } from '../lib/style.ts';
import type { StyleSpec } from '../lib/jobfiles.ts';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

const DRAFT: Draft = {
  speed: 1.25,
  keep: [[0.5, 2], [3, 5]],
  words: [
    { t0: 0.6, t1: 0.9, text: 'Сегодня' }, { t0: 1.0, t1: 1.3, text: 'покажу,' }, { t0: 1.4, t1: 1.8, text: 'как' },
    { t0: 2.2, t1: 2.6, text: 'эээ' }, // вырезано
    { t0: 3.1, t1: 3.4, text: 'снимаю' }, { t0: 3.5, t1: 3.9, text: 'на' }, { t0: 4.0, t1: 4.4, text: 'айфон' },
  ],
  hook: { text: 'Как я снимаю', until: 3.2 },
  cta: null,
  inserts: [{ kind: 'image', question: 'insert-1', t0: 3.0, t1: 4.0, x: 70, y: 500, w: 250 }, { kind: 'text', id: 's1', text: '3 ошибки', t0: 1.0, t1: 1.5 }],
  accents: [{ t0: 3.45, t1: 3.95, lines: [{ text: 'на' }] }],
  looks: [{ t0: 0.5, t1: 1.0, look: 'bw' }],
  zooms: [],
  music: { file: 'assets/music/Calm Morning.mp3', gainDb: -14 },
  transitions: [{ t: 3.0, kind: 'flash' }],
};

test('video track: kept pieces in final time with their source spans; the cut parts sit at the joins', () => {
  const t = draftTracks(DRAFT, { sourceDuration: 6 });
  assert.ok(near(t.duration, 3.5 / 1.25));
  assert.deepEqual(t.video.map((c) => [c.src0, c.src1]), [[0.5, 2], [3, 5]]);
  assert.ok(near(t.video[0].t0, 0) && near(t.video[0].t1, 1.2) && near(t.video[1].t0, 1.2) && near(t.video[1].t1, 2.8));
  assert.deepEqual(t.cuts.map((c) => [c.src0, c.src1]), [[0, 0.5], [2, 3], [5, 6]], 'before, between and after');
  assert.ok(near(t.cuts[1].at, 1.2) && near(t.cuts[2].at, 2.8));
});

test('subtitles: the words that stay, in groups, without the cut ones and the accent words', () => {
  const t = draftTracks(DRAFT);
  assert.deepEqual(t.subtitles.map((c) => c.label), ['Сегодня покажу, как', 'снимаю айфон']);
  assert.ok(near(t.subtitles[0].t0, (0.6 - 0.5) / 1.25));
  assert.ok(near(t.subtitles[1].t1, (1.5 + 1.4) / 1.25), 'конец — конец последнего слова группы');
  assert.deepEqual(draftTracks(DRAFT, { perGroup: 2 }).subtitles.map((c) => c.label), ['Сегодня покажу,', 'как', 'снимаю айфон'], 'группа не переходит через склейку');
});

test('text, inserts, looks, music and transitions are placed in final time', () => {
  const t = draftTracks(DRAFT);
  assert.deepEqual(t.text.map((c) => [c.kind, c.label]), [['hook', 'Как я снимаю'], ['accent', 'на']]);
  assert.ok(near(t.text[0].t0, 0) && near(t.text[0].t1, (1.5 + 0.2) / 1.25));
  assert.deepEqual(t.inserts.map((c) => [c.kind, c.label]), [['image', 'insert-1'], ['text', '3 ошибки']]);
  assert.ok(near(t.inserts[0].t0, 1.2) && near(t.inserts[0].t1, 2.0));
  assert.deepEqual(t.looks.map((c) => [c.t0, c.t1]), [[0, 0.5 / 1.25]]);
  assert.deepEqual(t.music, { label: 'Calm Morning', gainDb: -14 });
  assert.ok(t.transitions.length === 1 && near(t.transitions[0].t, 1.2));
});

test('a teaser plays first: its piece leads the video track and the rest moves on', () => {
  const t = draftTracks({ ...DRAFT, teaser: { t0: 3.5, t1: 4.5 } });
  assert.equal(t.video[0].kind, 'teaser');
  assert.deepEqual([t.video[0].src0, t.video[0].src1], [3.5, 4.5]);
  assert.ok(near(t.video[1].t0, 1 / 1.25));
  assert.ok(near(t.duration, 4.5 / 1.25));
});

test('parseDraft takes edit.json as the session writes it and refuses junk', () => {
  assert.ok(parseDraft({ ...DRAFT, style: {}, face: { x: 0.5, y: 0.4 }, hold: 0 }));
  assert.equal(parseDraft(null), null);
  assert.equal(parseDraft({ ...DRAFT, speed: 0 }), null);
  assert.equal(parseDraft({ ...DRAFT, keep: [[2, 1]] }), null);
  assert.equal(parseDraft({ ...DRAFT, words: 'нет' }), null);
  const bare = parseDraft({ speed: 1.1, keep: [[0, 1]], words: [], hook: null, cta: null, inserts: [], zooms: [], music: null });
  assert.ok(bare && draftTracks(bare).text.length === 0 && draftTracks(bare).music === null);
});

test('editor.json: peaks decode to bytes and are read by source time', () => {
  const media = parseMedia({
    duration: 2, proxy: { file: 'out/proxy.mp4', width: 540, height: 960, key: 0.5 },
    film: { file: 'film.jpg', step: 0.5, w: 54, h: 96, n: 4 }, peaks: { perS: 2, data: Buffer.from([0, 128, 255, 64]).toString('base64') },
  });
  assert.ok(media);
  const peaks = decodePeaks(media.peaks.data);
  assert.deepEqual([...peaks], [0, 128, 255, 64]);
  assert.equal(peakAt(peaks, media.peaks.perS, 1.0), 255 / 255);
  assert.equal(peakAt(peaks, media.peaks.perS, 99), 64 / 255, 'после конца — последний');
  assert.equal(parseMedia({ duration: 2 }), null);
});

test('the frame layer at a moment: the subtitle group with the word being said, and the hook at the start', () => {
  const spec = { subtitles: { mode: 'karaoke', words: 3, size: 64, y: 1300 } } as unknown as StyleSpec;
  const t = draftTracks(DRAFT, { perGroup: subGroupSize(spec) });
  const at = (x: number) => overlayAt(spec, t, x);
  const second = (1.0 - 0.5 + 0.1) / 1.25; // внутри «покажу,»
  assert.deepEqual(at(second).sub, { words: ['Сегодня', 'покажу,', 'как'], active: 1, visible: 3 });
  assert.deepEqual(at(second).hook, { text: 'Как я снимаю' });
  assert.equal(at(2.5).hook, undefined, 'хук ушёл');
  assert.equal(at(2.75).sub, undefined, 'после последнего слова — пусто');
  const acc = { subtitles: { mode: 'accumulate', words: 3, size: 64, y: 1300 } } as unknown as StyleSpec;
  assert.deepEqual(overlayAt(acc, draftTracks(DRAFT, { perGroup: subGroupSize(acc) }), second).sub, { words: ['Сегодня', 'покажу,', 'как'], active: 1, visible: 2 });
  const soft = { subtitles: { mode: 'soft', words: 2, size: 64, y: 1300 } } as unknown as StyleSpec;
  assert.equal(subGroupSize(soft), 4);
  const s = overlayAt(soft, draftTracks(DRAFT, { perGroup: subGroupSize(soft) }), second).sub;
  assert.deepEqual(s, { words: ['Сегодня', 'покажу,', 'как'], active: 0, visible: 2, lines: [1, 2], opens: true, t: second - 0.5 / 1.25 }, 'новая строка «покажу, как» появилась с «покажу,»');
});
