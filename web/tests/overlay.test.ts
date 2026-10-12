import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildOverlayEvents, eventIndexAt, frameOf, insertSpans, layerBlocks, pyRound, renderTimeline, stateAt, type OverlayEdit } from '../lib/overlay.ts';
import { buildSubEvents, subBlocks, type Word } from '../lib/subs.ts';
import { Timeline } from '../lib/timeline.ts';
import { beatTimes, musicBeats, played, snapEdit } from '../lib/beats.ts';
import { BW_FILTER } from '../lib/picture.ts';
import { draftTracks, parseDraft, timelineOf, withHandEdits, type LayerStyle } from '../lib/tracks.ts';
import { applyPicture, type Edit, type LookFix, type MusicAdjust, type TextEdits, type TransitionFix, type WordFix } from '../lib/edits.ts';
import { blurSigma, flashAlpha, lookWindows, transitionMarks, zoomAt, zoomLevels, type TransitionSpec, type Zoom } from '../lib/zoom.ts';

// Общая с движком фикстура (engine/tests/shared_events.py): события субтитров и слоя — ровно как у движка, число в число.
type Base = { name: string; keep: [number, number][]; speed: number; teaser: [number, number] | null };
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/overlay-events.json', import.meta.url), 'utf8')) as {
  subs: (Base & { words: Word[]; mode: string; n: number; hidden?: [number, number][]; events: unknown[] })[];
  subsRefused: { mode: string; n: number }[];
  overlay: (Base & { edit: OverlayEdit; events: { t0: number; t1: number; state: unknown }[]; insertSpans: [number, number, number][] })[];
  overlayRefused: (Base & { edit: OverlayEdit })[];
  render: RenderCase[];
  renderRefused: RenderCase[];
  look: (Base & {
    edit: { zooms: Zoom[]; transitions: TransitionSpec[]; looks: { t0: number; t1: number }[] };
    zoom: [number, number][]; marks: { t: number; kind: string; source: number }[]; looks: [number, number][];
    flash: ByFrame[]; blur: ByFrame[];
  })[];
  bwFilter: { brightness: number; contrast: number };
  beats: (Base & {
    grid: { length: number; times: number[] }; music: { at?: number; from?: number };
    edit: { zooms: Zoom[]; inserts: { kind: string; t0: number; t1: number }[] };
    times: number[]; zoomsAt: number[]; insertsAt: number[]; moved: number; played: number;
  })[];
  pipeline: {
    name: string; duration: number; edit: unknown; grid: { length: number; times: number[] } | null;
    timeline: { edits: Edit[]; music?: MusicAdjust; text?: TextEdits; words?: WordFix[] };
    beatsUsed: boolean; events: unknown[]; insertSpans: [number, number, number][];
  }[];
  picture: (Base & {
    edit: { zooms: Zoom[]; looks: { t0: number; t1: number; look: string; off?: boolean }[]; transitions: (TransitionSpec & { off?: boolean })[]; dim?: number | null };
    timeline: { zoom?: number; looks?: LookFix[]; transitions?: TransitionFix[]; dim?: number };
    expected: unknown; marks: { t: number; kind: string; source: number }[]; lookWindows: [number, number][]; zoom: [number, number][];
  })[];
};
type RenderCase = {
  name: string; keep: [number, number][]; speed: number; teaser: { t0: number; t1: number } | null; limit: number | null;
  segments?: [number, number, number][]; teaserSpan?: [number, number] | null; duration?: number;
};
type ByFrame = { t: number; frames: [number, number][] }; // переход со стыком t: [кадр финала, значение]
const tlOf = (c: Base) => new Timeline(c.keep, c.speed, c.teaser);
const plain = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown; // как его запишет JSON: без undefined

test('subtitle events match the engine number for number', () => {
  for (const c of FIXTURE.subs) assert.deepStrictEqual(plain(buildSubEvents(c.words, tlOf(c), c.mode, c.n, c.hidden ?? [])), c.events, c.name);
  assert.ok(FIXTURE.subs.some((c) => c.events.length > 0 && c.mode === 'soft') && FIXTURE.subs.some((c) => c.teaser));
});

test('subtitle blocks for the track: what shows together, its words with their place in edit.words', () => {
  for (const c of FIXTURE.subs) {
    const tl = tlOf(c);
    const blocks = subBlocks(c.words, tl, c.mode, c.n, c.hidden ?? []);
    const events = buildSubEvents(c.words, tl, c.mode, c.n, c.hidden ?? []);
    // каждое событие лежит в своём блоке, блоки идут по порядку и вплотную к своим событиям
    for (const e of events) assert.ok(blocks.some((b) => e.t0 >= b.t0 && e.t1 <= b.t1 && sameWords(b, e.words)), `${c.name}: ${e.words.join(' ')}`);
    for (const b of blocks) for (const w of b.words) assert.equal(c.words[w.i].text, w.text, c.name);
    blocks.slice(1).forEach((b, k) => assert.ok(b.t0 >= blocks[k].t1 - 1e-9 || b.lead !== blocks[k].lead, `${c.name}: блоки по порядку`));
  }
  const soft = FIXTURE.subs.find((c) => c.mode === 'soft' && c.teaser) as (typeof FIXTURE.subs)[number];
  const blocks = subBlocks(soft.words, tlOf(soft), soft.mode, soft.n);
  assert.ok(blocks[0].lead && blocks.some((b) => !b.lead), 'тизер — своими блоками впереди');
});
const sameWords = (b: { words: { text: string }[] }, words: string[]) => b.words.map((w) => w.text).join('\u0001') === words.join('\u0001');

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

test('blocks on the tracks are exactly where the layer draws hook, title, accents and inserts', () => {
  for (const c of FIXTURE.overlay) {
    const tl = tlOf(c);
    const events = buildOverlayEvents(c.edit, tl);
    const blocks = layerBlocks(c.edit, tl);
    // где это видно по событиям: от первого до последнего события, где оно есть
    const seen = (has: (st: Record<string, unknown>) => boolean) => {
      const hit = events.filter((e) => has(e.state));
      return hit.length ? [hit[0].t0, (hit.at(-1) as (typeof hit)[number]).t1] : null;
    };
    const near = (a: number[] | null, b: { t0: number; t1: number } | null, what: string) => {
      if (!a || !b) return assert.equal(a, b === null ? null : a, `${c.name}: ${what}`);
      assert.ok(Math.abs(a[0] - b.t0) < 1e-9 && Math.abs(a[1] - b.t1) < 1e-6, `${c.name}: ${what} ${a} vs ${b.t0}–${b.t1}`);
    };
    near(seen((st) => 'hook' in st), blocks.hook, 'хук');
    near(seen((st) => 'cta' in st), blocks.cta, 'титр');
    for (const b of blocks.inserts) {
      near(seen((st) => ((st.inserts as { n: number }[] | undefined) ?? []).some((i) => i.n === b.n)), b, `вставка ${b.n}`);
    }
    const drawn = new Set(events.flatMap((e) => ((e.state.inserts as { n: number }[] | undefined) ?? []).map((i) => i.n)));
    assert.deepStrictEqual([...drawn].sort(), blocks.inserts.map((b) => b.n).sort(), `${c.name}: те же вставки`);
    if (blocks.accents.length === 1) near(seen((st) => 'accent' in st), blocks.accents[0], 'акцент');
    assert.equal(blocks.accents.length, (c.edit.accents ?? []).length, `${c.name}: все акценты`);
  }
});

test('the layer refuses what the engine refuses', () => {
  for (const c of FIXTURE.overlayRefused) assert.throws(() => buildOverlayEvents(c.edit, tlOf(c)), /нужно место на кадре/, c.name);
});

test('the render timeline puts piece edges on whole frames, as the engine', () => {
  for (const c of FIXTURE.render) {
    const tl = renderTimeline(c, c.limit);
    assert.deepStrictEqual(tl.segments, c.segments, c.name);
    assert.deepStrictEqual(tl.teaser, c.teaserSpan, c.name);
    assert.equal(tl.duration, c.duration, c.name);
  }
  for (const c of FIXTURE.renderRefused) assert.throws(() => renderTimeline(c, c.limit), /teaser/, c.name);
});

test('zoom, transitions at the joins and black-and-white pieces match the engine', () => {
  for (const c of FIXTURE.look) {
    const tl = tlOf(c);
    const marks = transitionMarks(c.edit.transitions, tl);
    assert.deepStrictEqual(marks, c.marks, c.name);
    const punches = marks.filter((m) => m.kind === 'zoom').map((m) => m.t);
    const level = zoomLevels(c.edit.zooms, tl, punches);
    for (const [t, want] of c.zoom) {
      assert.equal(zoomAt(c.edit.zooms, tl, t, undefined, punches), want, `${c.name}: zoom(${t})`);
      assert.equal(level(t), want, `${c.name}: zoomLevels(${t})`);
    }
    assert.deepStrictEqual(lookWindows(c.edit.looks, tl), c.looks, c.name);
  }
  assert.ok(FIXTURE.look.some((c) => c.zoom.some(([, z]) => z > 1.2)), 'в фикстуре есть смена крупности');
});

test('flash and blur on every frame at the joins match the engine number for number', () => {
  for (const c of FIXTURE.look) {
    const marks = transitionMarks(c.edit.transitions, tlOf(c));
    const joins = (kind: string) => marks.filter((m) => m.kind === kind).map((m) => m.t);
    assert.deepStrictEqual(c.flash.map((f) => f.t), joins('flash'), `${c.name}: каждая вспышка`);
    assert.deepStrictEqual(c.blur.map((b) => b.t), joins('blur'), `${c.name}: каждый смаз`);
    for (const f of c.flash) for (const [n, want] of f.frames) assert.equal(flashAlpha(f.t, n), want, `${c.name}: вспышка ${f.t}, кадр ${n}`);
    for (const b of c.blur) for (const [n, want] of b.frames) assert.equal(blurSigma(b.t, n), want, `${c.name}: смаз ${b.t}, кадр ${n}`);
  }
  assert.ok(FIXTURE.look.filter((c) => c.flash.length).length >= 2 && FIXTURE.look.filter((c) => c.blur.length).length >= 2);
});

test('a black-and-white frame in the preview is the engine’s CSS filter', () => {
  const { brightness, contrast } = FIXTURE.bwFilter;
  assert.equal(BW_FILTER, `grayscale(1) brightness(${brightness}) contrast(${contrast})`);
});

test('beats of the music in the video and what lands on them match the engine', () => {
  for (const c of FIXTURE.beats) {
    const tl = tlOf(c);
    const at = c.music.at ?? 0;
    const skip = c.music.from ?? 0;
    assert.equal(played(c.grid.length, at, skip, tl.duration), c.played, c.name);
    const times = beatTimes(c.grid.times, c.grid.length, at, skip, tl.duration);
    assert.deepStrictEqual(times, c.times, c.name);
    const { edit, moved } = snapEdit(c.edit, tl, times);
    assert.deepStrictEqual(edit.zooms.map((z) => z.t), c.zoomsAt, c.name);
    assert.deepStrictEqual(edit.inserts.map((i) => i.t0), c.insertsAt, c.name);
    assert.equal(moved, c.moved, c.name);
  }
  const grid = { file: 'assets/music/a.mp3', length: 12, bpm: 120, times: [0.1, 0.6] };
  assert.ok(musicBeats(grid, { file: 'assets/music/a.mp3' }, 5), 'та же музыка — её доли');
  assert.equal(musicBeats(grid, { file: 'assets/music/b.mp3' }, 5), null, 'доли другого трека не годятся');
  assert.equal(musicBeats(grid, { file: 'assets/music/a.mp3', beats: false }, 5), null, 'монтаж в такт выключен');
  assert.equal(musicBeats(grid, null, 5), null, 'музыки нет (или она без звука)');
  assert.equal(musicBeats(grid, { file: 'assets/music/a.mp3', from: 11.8 }, 5), null, 'трека после from не хватает');
});

test('rounding is Python’s: a frame on a half rounds to even, decimals by the exact value', () => {
  assert.equal(frameOf(0.35), 10, '0.35 · 30 = 10.5 → 10, как round() движка');
  assert.equal(frameOf(0.05), 2, '1.5 → 2');
  assert.equal(frameOf(1 / 3), 10);
  assert.equal(pyRound(0.0078125, 6), 0.007812, '1/128: ровно половина — к чётной');
  assert.equal(pyRound(2.3000000000000003, 6), 2.3);
  assert.equal(pyRound(1.0000005, 6), 1.000001, 'точное значение чуть больше половины');
  assert.equal(pyRound(0, 6), 0);
  assert.equal(pyRound(5e-7, 6), 0, 'точное значение чуть меньше половины');
  assert.equal(pyRound(1.2345675, 6), 1.234568);
});

test('the state at a moment of the video is the event that covers it', () => {
  const events = [{ t0: 0, t1: 1, state: { a: 1 } }, { t0: 1, t1: 2.5, state: { b: 2 } }];
  assert.deepStrictEqual(stateAt(events, 0), { a: 1 });
  assert.deepStrictEqual(stateAt(events, 0.999), { a: 1 });
  assert.deepStrictEqual(stateAt(events, 1), { b: 2 }, 'граница — следующему');
  assert.deepStrictEqual(stateAt(events, 2.5), { b: 2 }, 'конец ролика — последнему');
  assert.deepStrictEqual(stateAt(events, 9), { b: 2 });
  assert.deepStrictEqual(stateAt([], 1), {});
  assert.deepEqual([0, 0.999, 1, 2.5, 9, -1].map((t) => eventIndexAt(events, t)), [0, 0, 1, 1, 1, 0], 'номер события — по нему кадр перерисовывается');
  assert.equal(eventIndexAt([], 1), -1);
});

test('the whole way of Pavel\'s edits to the layer is the engine\'s: pieces, text and words, the music\'s beats (shared fixture)', () => {
  // тот же путь, что у кадра редактора: правки кусков и музыки → доли (музыка выключена — без них) → дорожки с правками
  // текста → события слоя; у движка — edits.apply → render.timeline → music_beats и snap_edit → build_overlay_events
  for (const c of FIXTURE.pipeline) {
    const draft = parseDraft(c.edit);
    assert.ok(draft, c.name);
    const edited = withHandEdits(draft, { edits: c.timeline.edits, music: c.timeline.music }, c.duration);
    const music = c.timeline.music?.muted ? null : edited.draft.music;
    const beats = c.grid && music ? musicBeats({ file: music.file, length: c.grid.length, bpm: 120, times: c.grid.times }, music,
      timelineOf(edited.draft, c.duration).duration) : null;
    assert.equal(beats !== null, c.beatsUsed, `${c.name}: доли`);
    const tracks = draftTracks(edited.draft, {
      style: (c.edit as { style: LayerStyle }).style, sourceDuration: c.duration, splits: edited.splits, beats,
      fixes: { text: c.timeline.text, words: c.timeline.words },
    });
    const { edit, tl } = tracks.layer;
    assert.deepStrictEqual(insertSpans(edit, tl), c.insertSpans, `${c.name}: кадры вставок`);
    assert.deepStrictEqual(plain(buildOverlayEvents(edit, tl)), c.events, c.name);
  }
});

test('the picture by hand is the engine\'s: zoom strength, b/w pieces off, transitions of another kind or off (shared fixture)', () => {
  for (const c of FIXTURE.picture) {
    const out = applyPicture(c.edit, c.timeline.zoom, c.timeline.looks, c.timeline.transitions, c.timeline.dim);
    assert.deepStrictEqual(plain({ zooms: out.zooms, looks: out.looks, transitions: out.transitions, dim: out.dim ?? null }), c.expected, c.name);
    const tl = new Timeline(c.keep, c.speed, c.teaser);
    const marks = transitionMarks(out.transitions, tl);
    assert.deepStrictEqual(marks, c.marks, `${c.name}: переходы`);
    assert.deepStrictEqual(lookWindows(out.looks, tl), c.lookWindows, `${c.name}: ч/б`);
    const level = zoomLevels(out.zooms, tl, marks.filter((m) => m.kind === 'zoom').map((m) => m.t));
    for (const [t, z] of c.zoom) assert.equal(pyRound(level(t), 6), z, `${c.name}: зум на ${t} с`);
  }
  assert.equal(applyPicture(FIXTURE.picture[0].edit, undefined, [], []), FIXTURE.picture[0].edit, 'правок нет — тот же edit');
});
