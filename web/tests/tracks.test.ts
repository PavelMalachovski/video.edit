import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePeaks, draftTracks, moveTarget, parseDraft, parseMedia, peakAt, slotAt, splitTarget, videoKey, withHandEdits, wordEdges, type Draft,
} from '../lib/tracks.ts';
import { setSound, setVoice } from '../lib/edits.ts';
import { cutSpan, EMPTY, moveSpan, setMusic, splitAt } from '../lib/edits.ts';
import { buildOverlayEvents, stateAt } from '../lib/overlay.ts';

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
  accents: [{ t0: 3.45, t1: 3.95, lines: [{ text: 'на' }], x: 540, y: 900 }],
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
  assert.deepEqual(t.cuts.map((c) => [c.src0, c.src1, c.side]), [[0, 0.5, 'start'], [2, 3, 'end'], [5, 6, 'end']], 'before, between and after');
  assert.ok(near(t.cuts[1].at, 1.2) && near(t.cuts[2].at, 2.8));
});

test('subtitles: groups as the engine shows them — by phrase, without the cut words and the accent words', () => {
  const t = draftTracks(DRAFT);
  // «на» — слова акцента: в субтитры не идёт и рвёт фразу (build_sub_events: hidden)
  assert.deepEqual(t.subtitles.map((c) => c.label), ['Сегодня покажу, как', 'снимаю', 'айфон']);
  assert.ok(near(t.subtitles[0].t0, (0.6 - 0.5) / 1.25));
  assert.ok(near(t.subtitles[2].t1, (1.5 + 1.4) / 1.25 + 0.3), 'после слова — ещё 0,3 с (дальше никто не говорит)');
  const two = { subtitles: { mode: 'karaoke', words: 2 }, hook: { mode: 'plate' } };
  assert.deepEqual(draftTracks(DRAFT, { style: two }).subtitles.map((c) => c.label), ['Сегодня', 'покажу, как', 'снимаю', 'айфон'],
    'фраза из трёх слов — на ровные группы до двух слов');
  const sub = t.subtitles[0];
  assert.deepEqual(sub.ref, { kind: 'sub', words: DRAFT.words.slice(0, 3).map(({ t0, t1, text }) => ({ t0, t1, text })) }, 'слова группы — как в edit.json');
});

test('text, inserts, looks, music and transitions are placed in final time', () => {
  const t = draftTracks(DRAFT);
  assert.deepEqual(t.text.map((c) => [c.kind, c.label]), [['hook', 'Как я снимаю'], ['accent', 'на']]);
  const hookEnd = 41 / 30; // (1,5 + 0,2) / 1,25 = 1,36 с — на кадре 40,8 → 41: слой меняется на целых кадрах
  assert.ok(near(t.text[0].t0, 0) && near(t.text[0].t1, hookEnd));
  assert.deepEqual(t.inserts.map((c) => [c.kind, c.label, c.drawn]), [['image', 'insert-1', false], ['text', '3 ошибки', false]],
    'вставка ждёт ответа, у стикера нет места на кадре — на дорожке есть, на кадре их не рисует слой');
  assert.ok(near(t.inserts[0].t0, hookEnd) && near(t.inserts[0].t1, t.duration), 'после хука; видна в последний кадр — до конца ролика');
  assert.deepEqual(t.looks.map((c) => [c.t0, c.t1]), [[0, 12 / 30]], 'ч/б — на кадрах склейки');
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

test('the frame at a moment is what the engine draws there: the subtitle group being said, the hook, the accent', () => {
  const t = draftTracks(DRAFT);
  const events = buildOverlayEvents(t.layer.edit, t.layer.tl);
  const at = (x: number) => stateAt(events, x);
  const second = (1.0 - 0.5 + 0.1) / 1.25; // внутри «покажу,»
  assert.deepEqual(at(second).sub, { words: ['Сегодня', 'покажу,', 'как'], active: 1, visible: 3 });
  assert.deepEqual(at(second).hook, { text: 'Как я снимаю' });
  assert.equal(at(1.5).hook, undefined, 'хук ушёл');
  assert.ok(at(1.7).accent && at(1.7).sub === undefined, 'акцент — вместо субтитров');
  assert.equal(at(t.duration - 0.05).sub, undefined, 'после последнего слова — пусто');
});

test('with a teaser the hook stands on the whole teaser, as the engine has it', () => {
  const t = draftTracks({ ...DRAFT, teaser: { t0: 3.5, t1: 4.5 } });
  const hook = t.text.find((c) => c.kind === 'hook');
  assert.ok(hook && near(hook.t0, 0) && near(hook.t1, 1 / 1.25), `хук — весь тизер: ${JSON.stringify(hook)}`);
});

test('inserts show after the hook and at least 1.5 s, as insert_spans of the engine', () => {
  const t = draftTracks({ ...DRAFT, hook: { text: 'Хук', until: 1.0 }, inserts: [{ kind: 'image', src: 'in/a.png', t0: 0.6, t1: 0.8, x: 70, y: 500, w: 250 }] });
  const hookEnd = 12 / 30; // 1,0 с исходника — 0,4 с ролика, кадр 12
  assert.ok(near(t.inserts[0].t0, hookEnd), `не раньше конца хука: ${t.inserts[0].t0}`);
  assert.ok(near(t.inserts[0].t1, hookEnd + 1.5), `не короче 1,5 с: ${t.inserts[0].t1}`);
  assert.equal(t.inserts[0].drawn, true);
});

test('editor.json without a proxy (a very long source) is read; junk film or peaks are refused', () => {
  const base = {
    duration: 2, proxy: null, film: { file: 'film.jpg', step: 0.5, w: 54, h: 96, n: 4 }, peaks: { perS: 2, data: 'AAAA' },
  };
  assert.ok(parseMedia(base) && parseMedia(base)?.proxy === null);
  assert.equal(parseMedia({ ...base, film: { ...base.film, n: 1001 } }), null);
  assert.equal(parseMedia({ ...base, film: { ...base.film, n: 2.5 } }), null);
  assert.equal(parseMedia({ ...base, peaks: { perS: 2.5, data: 'AAAA' } }), null);
});

test('Pavel\'s splits divide the video pieces on screen; each part knows its piece and which edges can be dragged', () => {
  const t = draftTracks(DRAFT, { splits: [1.0, 4.0, 2.5] }); // 2,5 — в вырезанном: не виден
  assert.deepEqual(t.video.map((c) => [c.src0, c.src1, c.piece, c.edgeStart, c.edgeEnd]), [
    [0.5, 1.0, 0, true, false], [1.0, 2, 0, false, true], [3, 4.0, 1, true, false], [4.0, 5, 1, false, true],
  ]);
  assert.ok(near(t.video[1].t0, 0.5 / 1.25));
});

test('the sounds track: each sound where the engine plays it, with its key', () => {
  const d: Draft = {
    ...DRAFT, hold: 0.5, end: { seconds: 1.5, sfx: 'assets/sfx/pop.mp3', lines: ['Подпишись'] }, teaser: { t0: 3.5, t1: 4.5, sfx: 'assets/sfx/whoosh.mp3' },
    inserts: [{ kind: 'image', src: 'in/a.png', t0: 3.0, t1: 4.0, sfx: 'assets/sfx/pop.mp3' }, { kind: 'image', src: 'in/b.png', t0: 4.2, t1: 4.8 }],
    transitions: [{ t: 3.0, kind: 'flash', sfx: 'assets/sfx/swoosh.mp3' }, { t: 5.0, kind: 'flash', sfx: 'assets/sfx/swoosh.mp3' }],
  };
  const t = draftTracks(d);
  const by = Object.fromEntries(t.sounds.map((c) => [c.key, c]));
  assert.deepEqual(Object.keys(by).sort(), ['end', 'insert:0', 'teaser', 'transition:0'], 'переход в самом конце — без звука, как у движка');
  assert.ok(near(by.teaser.t0, 1 / 1.25), 'на стыке тизера');
  assert.ok(near(by['transition:0'].t0, (1 + 1.5) / 1.25 - 0.12), 'с началом перехода');
  assert.equal(by['insert:0'].label, 'pop');
  assert.ok(near(by.end.t0, t.duration + 0.5), 'звук карточки — после стоп-кадра (hold), как у движка');
  assert.ok(near(t.tail, 0.5 + 1.5), 'после кусков — стоп-кадр и карточка');
  assert.equal(draftTracks(DRAFT).tail, 0, 'нет ни стоп-кадра, ни карточки — хвоста нет');
});

test('music on its track: from where it starts, with its place in the track', () => {
  const t = draftTracks({ ...DRAFT, music: { file: 'assets/music/Calm.mp3', gainDb: -14, at: 1.0, from: 12 } });
  assert.deepEqual(t.music, { label: 'Calm', gainDb: -14, at: 1.0, from: 12 });
});

// ---------- правки руками (фаза 3) ----------

test('the draft with Pavel\'s hand edits: the pieces as the engine will cut them, his splits, the music where he put it', () => {
  const h = setMusic(splitAt(cutSpan(EMPTY, 3.5, 4.2), 1.2), { at: 0.5, gainDb: -20, muted: true });
  const { draft, splits } = withHandEdits(DRAFT, h, 6);
  assert.deepEqual(draft.keep, [[0.5, 2], [3, 3.5], [4.2, 5]]);
  assert.deepEqual(splits, [1.2]);
  assert.deepEqual(draft.music, { file: 'assets/music/Calm Morning.mp3', gainDb: -20, at: 0.5 }, 'без звука — не место: дорожка его показывает отдельно');
  const t = draftTracks(draft, { splits, sourceDuration: 6 });
  assert.deepEqual(t.video.map((c) => [c.src0, c.src1]), [[0.5, 1.2], [1.2, 2], [3, 3.5], [4.2, 5]]);
  assert.equal(withHandEdits(DRAFT, EMPTY).draft.keep, DRAFT.keep, 'правок нет — черновик как был');
  assert.equal(withHandEdits({ ...DRAFT, music: null }, setMusic(EMPTY, { at: 2 })).draft.music, null);
});

test('split at the playhead: inside a piece (not at its very edge, not in the teaser) — the source moment, else null', () => {
  const t = draftTracks({ ...DRAFT, teaser: { t0: 3.5, t1: 4.5 } });
  const tl = 1 / 1.25;
  assert.equal(splitTarget(t, 0.1), null, 'в тизере не режем');
  const inPiece = splitTarget(t, tl + 0.4); // 0,4 с финала в первом куске → 0,5 с исходника от его начала
  assert.ok(inPiece !== null && near(inPiece, 0.5 + 0.4 * 1.25), String(inPiece));
  assert.equal(splitTarget(t, tl + 0.01), null, 'у самого края куска — нечего резать');
  assert.equal(splitTarget(t, t.duration + 1), null);
});

test('word edges for snapping: every start and end, in order, once', () => {
  assert.deepEqual(wordEdges({ ...DRAFT, words: [{ t0: 1, t1: 1.5, text: 'a' }, { t0: 0.2, t1: 0.6, text: 'b' }, { t0: 1.5, t1: 2, text: 'c' }] }),
    [0.2, 0.6, 1, 1.5, 2]);
});

test('the video key changes only when the pieces do: sound, voice and music edits keep the player where it is', () => {
  const key = (h: Parameters<typeof withHandEdits>[1]) => {
    const { draft, splits } = withHandEdits(DRAFT, h, 6);
    return videoKey(draftTracks(draft, { splits }));
  };
  const base = key(EMPTY);
  assert.equal(key(setVoice(setSound(EMPTY, 'insert:0', { muted: true }), { gainDb: -6 })), base);
  assert.equal(key(setMusic(EMPTY, { at: 1, gainDb: -20, muted: true })), base);
  assert.notEqual(key(cutSpan(EMPTY, 1, 1.5)), base);
  assert.notEqual(key(splitAt(EMPTY, 1.2)), base);
});

test('a moved piece: the tracks follow the new order — words where they are heard, events within their run, cuts by the recording', () => {
  // кусок 3–5 исходника Павел поставил перед 0,5–2: в ролике сначала «снимаю на айфон», потом «Сегодня покажу, как»
  const { draft, splits } = withHandEdits(DRAFT, moveSpan(EMPTY, 3, 5, 0.5), 6);
  assert.deepEqual(draft.keep, [[3, 5], [0.5, 2]]);
  const t = draftTracks(draft, { splits, sourceDuration: 6 });
  assert.deepEqual(t.video.map((c) => [c.src0, c.src1]), [[3, 5], [0.5, 2]]);
  assert.ok(near(t.video[1].t0, 2 / 1.25));
  const words = t.subtitles.flatMap((c) => c.words?.map((w) => w.text) ?? []);
  assert.deepEqual(words, ['снимаю', 'айфон', 'Сегодня', 'покажу,', 'как'], 'по месту в ролике (слово «на» — в акценте)');
  assert.ok(t.subtitles.every((c, i) => i === 0 || c.t0 >= t.subtitles[i - 1].t0));
  // вырезанное: «＋» — в конце куска, что перед ним в исходнике (2–3 — за 0,5–2, то есть в конце ролика), 0–0,5 — перед
  // первым по исходнику куском, хвост 5–6 — за 3–5
  // вырезанное вернётся к куску, что перед ним в исходнике (в его конец), а до первого куска — в начало первого: метки
  // начала и хвоста встали на один стык — у каждой своя сторона
  const cuts = t.cuts.map((c) => [c.src0, c.src1, Math.round(c.at * 1000) / 1000, c.side]);
  assert.deepEqual(cuts, [[0, 0.5, 1.6, 'start'], [2, 3, 2.8, 'end'], [5, 6, 1.6, 'end']]);
  // вставка 3–4 с исходника — в куске 3–5 (первом): после хука, до 4 с исходника (0,8 с ролика), но не короче 1,5 с
  const ins = t.inserts.find((c) => c.label === 'insert-1');
  const hookEnd = t.text.find((c) => c.kind === 'hook')?.t1 ?? 0;
  assert.ok(ins && near(ins.t0, hookEnd) && near(ins.t1, Math.min(hookEnd + 1.5, t.duration)), JSON.stringify(ins));
});

test('reorder: a piece goes before the piece at the slot (past the last — to the end); its own place, the teaser and the teaser slot — no edit', () => {
  // разрез Павла на 1,2: куски дорожки — [0,5–1,2], [1,2–2], [3–5]
  const { draft, splits } = withHandEdits(DRAFT, splitAt(EMPTY, 1.2), 6);
  const t = draftTracks(draft, { splits, sourceDuration: 6 });
  assert.deepEqual(t.video.map((c) => [c.src0, c.src1]), [[0.5, 1.2], [1.2, 2], [3, 5]]);
  assert.deepEqual(moveTarget(t, 2, 0), { t0: 3, t1: 5, before: 0.5 }, 'последний — в начало');
  assert.deepEqual(moveTarget(t, 0, 3), { t0: 0.5, t1: 1.2, before: null }, 'первый — в конец');
  assert.deepEqual(moveTarget(t, 0, 2), { t0: 0.5, t1: 1.2, before: 3 }, 'первый — за второй (часть того же куска)');
  assert.equal(moveTarget(t, 1, 1), null, 'перед собой — то же место');
  assert.equal(moveTarget(t, 1, 2), null, 'за собой — то же место');
  // правка переставляет так, как сказано: движок и редактор режут одинаково (applyKeep)
  const moved = withHandEdits(DRAFT, moveSpan(splitAt(EMPTY, 1.2), 0.5, 1.2, 3), 6);
  assert.deepEqual(moved.draft.keep, [[1.2, 2], [0.5, 1.2], [3, 5]]);

  const teased = draftTracks({ ...DRAFT, teaser: { t0: 3.5, t1: 4.5 } }, { sourceDuration: 6 });
  assert.equal(teased.video[0].kind, 'teaser');
  assert.equal(moveTarget(teased, 0, 3), null, 'тизер не переставляется');
  assert.deepEqual(moveTarget(teased, 2, 0), { t0: 3, t1: 5, before: 0.5 }, 'перед тизером — значит, первым после него');
  assert.equal(moveTarget(teased, 1, 0), null, 'первый кусок перед тизером — он и так первый');
});

test('reorder by dragging: the slot is the join nearest to the pointer, never before the teaser', () => {
  const t = draftTracks(DRAFT, { sourceDuration: 6 }); // куски 0–1,2 и 1,2–2,8 с ролика
  assert.equal(slotAt(t, 0.2), 0);
  assert.equal(slotAt(t, 0.7), 1, 'за серединой первого — перед вторым');
  assert.equal(slotAt(t, 1.9), 1);
  assert.equal(slotAt(t, 2.1), 2, 'за серединой последнего — в конец');
  assert.equal(slotAt(t, 99), 2);
  assert.equal(slotAt(t, -5), 0);
  const teased = draftTracks({ ...DRAFT, teaser: { t0: 3.5, t1: 4.5 } }, { sourceDuration: 6 });
  assert.equal(slotAt(teased, 0), 1, 'на тизере — первым после него');
});

test('several videos: editor.json says where each is; pieces split at the joins of the files and know their video', () => {
  const media = { duration: 6, proxy: null, film: { file: 'film.jpg', step: 0.5, w: 54, h: 96, n: 12 }, peaks: { perS: 50, data: '' },
    videos: [{ name: 'IMG_1.MOV', t0: 0, t1: 4 }, { name: 'IMG_2.mp4', t0: 4, t1: 6 }] };
  assert.deepEqual(parseMedia(media)?.videos, media.videos);
  for (const videos of [[], [{ name: '', t0: 0, t1: 1 }], [{ name: 'a', t0: 1, t1: 1 }], [{ name: 'a', t0: -1, t1: 1 }], 'x', [{ name: 'a', t0: 0, t1: 1, x: 1 }]]) {
    assert.equal(parseMedia({ ...media, videos }), null, JSON.stringify(videos));
  }
  // куски 0,5–2 и 3–5; стык файлов на 4 — внутри второго куска: на экране две части, у каждой — своё видео
  const t = draftTracks(DRAFT, { sourceDuration: 6, videos: media.videos });
  assert.deepEqual(t.video.map((c) => [c.src0, c.src1, c.videoNo]), [[0.5, 2, 0], [3, 4, 0], [4, 5, 1]]);
  assert.deepEqual(t.video.map((c) => [c.edgeStart, c.edgeEnd]), [[true, true], [true, false], [false, true]], 'стык файлов — не край куска');
  assert.ok(draftTracks(DRAFT, { sourceDuration: 6 }).video.every((c) => c.videoNo === undefined), 'без списка видео — как раньше');
});

test('a piece moved to the front does not stretch the hook, and its insert comes right after the hook', () => {
  const d: Draft = { ...DRAFT, speed: 1, keep: [[5, 10], [0, 4]], hook: { text: 'Хук', until: 2.5 }, accents: [], looks: [], transitions: [],
    inserts: [{ kind: 'image', question: 'i', t0: 6, t1: 8, x: 70, y: 500, w: 250 }] };
  const t = draftTracks(d, { sourceDuration: 10 });
  const hook = t.text.find((c) => c.kind === 'hook');
  assert.ok(hook && near(hook.t1, 2.5), `хук — столько же, сколько по порядку исходника: ${JSON.stringify(hook)}`);
  assert.ok(near(t.inserts[0].t0, 2.5) && near(t.inserts[0].t1, 4), JSON.stringify(t.inserts[0]));
});

test('a word whose end is cut ends with its piece, and accent words said in a moved piece are subtitles there', () => {
  const cut: Draft = { ...DRAFT, speed: 1, keep: [[0, 2], [5, 8], [2.5, 4]], accents: [], looks: [], transitions: [], inserts: [],
    words: [{ t0: 0.2, t1: 0.6, text: 'ну' }, { t0: 1.8, t1: 2.2, text: 'привет' }, { t0: 5.2, t1: 5.6, text: 'пять' }] };
  const words = draftTracks(cut).subtitles.flatMap((c) => c.words ?? []);
  const hello = words.find((w) => w.text === 'привет');
  assert.ok(hello && near(hello.t1, 2), `конец — с куском, а не у далёкого 2,5–4: ${JSON.stringify(hello)}`);

  const accent: Draft = { ...DRAFT, speed: 1, keep: [[0, 2], [5.5, 7], [2, 5]], looks: [], transitions: [], inserts: [],
    accents: [{ t0: 1, t1: 3.2, lines: [{ text: 'это очень важное' }], x: 540, y: 900 }],
    words: [{ t0: 1.2, t1: 1.6, text: 'это' }, { t0: 2.2, t1: 2.6, text: 'очень' }, { t0: 2.7, t1: 3.1, text: 'важное.' }, { t0: 6, t1: 6.4, text: 'дальше' }] };
  const shown = draftTracks(accent).subtitles.flatMap((c) => c.words?.map((w) => w.text) ?? []);
  assert.ok(shown.includes('очень') && shown.includes('важное.') && !shown.includes('это'), JSON.stringify(shown));
});
