import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyKeep, applyText, commit, cutSpan, EMPTY, initHistory, LIMITS, moveSpan, parseTimeline, pieces, redo, restoreSpan, setBlock, setCta, setHook,
  setMusic, setSound, setVoice, setWord, snapTo, splitAt, trimEnd, trimStart, undo, type Edit, type TextEdits, type WordFix, badSymbols, blockFix, hasEmoji,
  setLook, setTransition, setZoom, TRANSITION_KINDS, setDim, setTrack, setEnd, MUSIC_FILE, setTeaser, setSpeed,
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
  const moved = { ...ok, edits: [{ op: 'move', t0: 1, t1: 2, before: null }, { op: 'move', t0: 3, t1: 4, before: 0.5 }, { op: 'restore', t0: 1, t1: 2, next: true }] };
  assert.deepEqual(parseTimeline(moved), moved, 'перестановка и возврат к следующему куску');
  for (const bad of [
    { ...ok, rev: 0 }, { ...ok, edits: [{ op: 'cut', t0: -1, t1: 1 }] }, { ...ok, edits: [{ op: 'jump', t: 1 }] }, { ...ok, voice: { gainDb: 40 } },
    { ...ok, music: { fadeIn: 20 } }, { ...ok, sounds: { 'insert:x': { gainDb: 1 } } }, { ...ok, sounds: { teaser: { gainDb: 'громче' } } }, { ...ok, extra: true },
    { ...ok, edits: Array(LIMITS.edits + 1).fill({ op: 'split', t: 1 }) }, null,
    { ...ok, edits: [{ op: 'cut', t0: 2, t1: 2 }] }, { ...ok, edits: [{ op: 'restore', t0: 3, t1: 1 }] }, // конец не позже начала: applyKeep упал бы
    { ...ok, edits: [{ op: 'move', t0: 1, t1: 2 }] }, { ...ok, edits: [{ op: 'move', t0: 1, t1: 2, before: -1 }] },
    { ...ok, edits: [{ op: 'restore', t0: 1, t1: 2, next: 'да' }] }, { ...ok, edits: [{ op: 'cut', t0: 1, t1: 2, next: true }] },
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
  assert.deepEqual(trimStart(EMPTY, keep, 1, 1.0).edits, [{ op: 'restore', t0: 2, t1: 3, next: true }], 'к этому куску — его начало тянули');
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

test('history: a slider\'s steps under one key are one edit to undo; another control or an undo starts a new one', () => {
  let h = initHistory(EMPTY);
  h = commit(h, setVoice(h.present, { gainDb: -1 }), 'voice');
  h = commit(h, setVoice(h.present, { gainDb: -2 }), 'voice');
  h = commit(h, setVoice(h.present, { gainDb: -3 }), 'voice');
  assert.equal(h.past.length, 1);
  h = commit(h, setMusic(h.present, { gainDb: -20 }), 'music');
  assert.equal(h.past.length, 2);
  h = undo(h);
  assert.deepEqual(h.present.voice, { gainDb: -3 });
  h = commit(h, setVoice(h.present, { gainDb: -4 }), 'voice');
  assert.equal(h.past.length, 2, 'после отмены — новая правка, а не продолжение старой');
  h = undo(undo(h));
  assert.equal(h.present, EMPTY);
});

test('moving a piece is an edit too; trims of a moved piece stop at its neighbours in the recording', () => {
  assert.deepEqual(moveSpan(EMPTY, 6, 8, 0).edits, [{ op: 'move', t0: 6, t1: 8, before: 0 }]);
  assert.deepEqual(moveSpan(EMPTY, 6, 8, null).edits, [{ op: 'move', t0: 6, t1: 8, before: null }]);
  const keep: [number, number][] = [[6, 8], [0, 2], [3, 5]]; // 6–8 переставлен в начало
  // начало 6–8 — левее: вернуть 5–6, не дальше конца 3–5 (сосед по исходнику), и именно к этому куску (next)
  assert.deepEqual(trimStart(EMPTY, keep, 0, 4).edits, [{ op: 'restore', t0: 5, t1: 6, next: true }]);
  assert.deepEqual(applyKeep(keep, trimStart(EMPTY, keep, 0, 4).edits, 9), [[5, 8], [0, 2], [3, 5]]);
  // конец 0–2 — правее: не дальше начала 3–5 (сосед по исходнику), хоть в финале за ним и стоит 3–5
  assert.deepEqual(trimEnd(EMPTY, keep, 1, 9, 9).edits, [{ op: 'restore', t0: 2, t1: 3 }]);
  // конец 3–5 — правее: до начала 6–8 (он в начале ролика, но в исходнике — следующий)
  assert.deepEqual(trimEnd(EMPTY, keep, 2, 9, 9).edits, [{ op: 'restore', t0: 5, t1: 6 }]);
});

// ---------- текст и вставки (фаза 5) ----------

type TextCase = { name: string; edit: Parameters<typeof applyText>[0]; text: TextEdits; words: WordFix[]; expected?: Record<string, unknown> };
const EVENTS = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/overlay-events.json', import.meta.url), 'utf8')) as {
  text: TextCase[]; textRefused: TextCase[];
};

test('text and insert edits land on the session\'s edit as the engine lays them (shared fixture written by the engine)', () => {
  assert.ok(EVENTS.text.length >= 4);
  for (const c of EVENTS.text) {
    const out = applyText(c.edit, c.text, c.words);
    const got = Object.fromEntries(['hook', 'cta', 'accents', 'inserts', 'words'].map((k) => [k, (out as Record<string, unknown>)[k] ?? null]));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(got)), c.expected, c.name);
  }
  for (const c of EVENTS.textRefused) assert.throws(() => applyText(c.edit, c.text, c.words), /timeline\.json: text/, c.name);
  const edit = EVENTS.text[0].edit;
  assert.equal(applyText(edit, undefined, []), edit, 'правок нет — тот же edit');
});

test('parseTimeline takes text and word edits as the schema does', () => {
  const ok = {
    rev: 3, edits: [],
    text: {
      hook: { until: 2, text: 'Как я снимаю 🎬' }, cta: { at: [7, 8], t0: 6.8, lines: ['Напиши'], word: 'КАДР' },
      accents: [{ at: [3, 4], t1: 4.3, lines: ['совсем', 'важно'] }, { at: [5, 5.5], off: true }],
      inserts: [{ at: [4, 5], text: '10 минут' }, { at: [6, 6.5], off: true }],
    },
    words: [{ t0: 0.9, t1: 1.2, text: 'это' }, { t0: 1.3, t1: 1.6, text: '' }],
  };
  assert.deepEqual(parseTimeline(ok), ok);
  for (const bad of [
    { ...ok, text: { hook: { off: false } } }, { ...ok, text: { hook: { until: 0 } } }, { ...ok, text: { cta: { t0: 1 } } },
    { ...ok, text: { accents: [{ at: [1] }] } }, { ...ok, text: { accents: [{ at: [1, 2], lines: [] }] } },
    { ...ok, text: { inserts: [{ at: [1, 2], kind: 'image' }] } }, { ...ok, text: { other: {} } },
    { ...ok, text: { hook: { text: 'я'.repeat(LIMITS.line + 1) } } }, { ...ok, words: [{ t0: 1, text: 'без конца' }] },
    { ...ok, words: [{ t0: 1, t1: 2, text: 'с'.repeat(LIMITS.word + 1) }] }, { ...ok, text: { cta: { at: [1, 2], lines: ['a', 'b', 'c', 'd'] } } },
  ]) assert.equal(parseTimeline(bad), null, JSON.stringify(bad).slice(0, 120));
  assert.ok(parseTimeline({ ...ok, text: { hook: { text: '🔥'.repeat(LIMITS.line) } } }), 'длина — в знаках, как maxLength схемы');
  const text = SCHEMA.properties.text.properties;
  assert.deepEqual([SCHEMA.$defs.Line.maxLength, text.cta.properties.lines.maxItems, text.accents.maxItems, SCHEMA.properties.words.maxItems,
    SCHEMA.properties.words.items.properties.text.maxLength], [LIMITS.line, LIMITS.lines, LIMITS.blocks, LIMITS.words, LIMITS.word]);
});

test('setters: a block edit keeps to its place in the speech, merges, and goes away when it is the session\'s again', () => {
  let h = setHook(EMPTY, { until: 2.04567 });
  h = setHook(h, { text: 'Новый хук' });
  assert.deepEqual(h.text?.hook, { until: 2.046, text: 'Новый хук' }, 'правка хука — поверх прежней, время — до мс');
  assert.deepEqual(setHook(h, { off: true }).text?.hook, { off: true }, 'убрать хук — только off');
  assert.equal(setHook(h, null).text, undefined, 'как у сессии — правки нет');
  const cta = setCta(EMPTY, [7, 8], { t0: 6.5 });
  assert.deepEqual(setCta(cta, [7, 8], { lines: ['Пиши'] }).text?.cta, { at: [7, 8], t0: 6.5, lines: ['Пиши'] });
  // две вставки на одном месте: вторую правят — перед ней правка «как есть» для первой
  const second = setBlock(EMPTY, 'inserts', [4, 5], 1, { t0: 4.2 });
  assert.deepEqual(second.text?.inserts, [{ at: [4, 5] }, { at: [4, 5], t0: 4.2 }]);
  const back = setBlock(second, 'inserts', [4, 5], 1, null);
  assert.equal(back.text, undefined, 'вернули как было — пустые правки уходят');
  const off = setBlock(setBlock(EMPTY, 'accents', [3, 4], 0, { t1: 4.5 }), 'accents', [3, 4], 0, { off: true });
  assert.deepEqual(off.text?.accents, [{ at: [3, 4], off: true }]);
  const w = setWord(setWord(EMPTY, 0.9, 1.2, 'это'), 1.3, 1.6, '');
  assert.deepEqual(w.words, [{ t0: 0.9, t1: 1.2, text: 'это' }, { t0: 1.3, t1: 1.6, text: '' }]);
  assert.deepEqual(setWord(w, 0.9, 1.2, 'Это').words?.at(-1), { t0: 0.9, t1: 1.2, text: 'Это' }, 'слово правят снова — одна правка');
  assert.equal(setWord(setWord(w, 0.9, 1.2, null), 1.3, 1.6, null).words, undefined);
  assert.ok(parseTimeline({ rev: 1, ...second }) && parseTimeline({ rev: 1, ...off }) && parseTimeline({ rev: 1, ...w }), 'сеттеры пишут то, что примет схема');
});

test('emoji in a subtitle word are refused before saving, as the engine font check refuses them (shared emoji fixture)', () => {
  type Case = { why: string; text: string; runs: [string, ...string[]][] };
  const cases = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/emoji-runs.json', import.meta.url), 'utf8')) as Case[];
  for (const c of cases) {
    const emoji = c.runs.some((r) => r[0] === 'emoji');
    // невидимый селектор FE0F после буквы движок считает текстом, а страница не пропустит — в слове он не нужен
    if (emoji || c.text.includes('\uFE0F')) assert.equal(hasEmoji(c.text), true, c.why);
    else assert.equal(hasEmoji(c.text), false, c.why);
  }
  assert.equal(hasEmoji('Привет — №1, €5 → ♪'), false, 'тире, номер, евро, стрелка, нота — буквы шрифта');
});

test('the hand fix of a block: the hook, the title by its place, the k-th accent or insert with the same place', () => {
  let h = setHook(EMPTY, { text: 'Новый хук' });
  h = setCta(h, [7, 8], { word: 'ВИДЕО' });
  h = setBlock(h, 'accents', [3, 4], 1, { t0: 3.5 });
  h = setBlock(h, 'inserts', [2, 3], 0, { off: true });
  assert.deepEqual(blockFix(h, 'hook'), { text: 'Новый хук' });
  assert.deepEqual(blockFix(h, 'cta', [7, 8]), { at: [7, 8], word: 'ВИДЕО' });
  assert.equal(blockFix(h, 'cta', [7, 9]), null, 'другое место — не его правка');
  assert.equal(blockFix(h, 'accent', [3, 4], 0), null, 'первый акцент с этим местом — как у сессии (пустая правка)');
  assert.deepEqual(blockFix(h, 'accent', [3, 4], 1), { at: [3, 4], t0: 3.5 });
  assert.deepEqual(blockFix(h, 'insert', [2, 3], 0), { at: [2, 3], off: true });
  assert.equal(blockFix(EMPTY, 'hook'), null);
});

test('symbols the video\'s font will not draw are refused as the engine font check refuses them; №, °, ©, ®, ™ and emoji are fine', () => {
  assert.equal(badSymbols('№5 и +25° в тени © ® ™'), '', 'их рисует каждый шрифт шаблона (test_fonts.py)');
  assert.equal(badSymbols('Огонь 🔥 ✅ ❤️ 👍🏽 #️⃣'), '', 'эмодзи — картинки');
  assert.equal(badSymbols('★ без штатива ✓ и ♪ ★'), '★✓♪', 'нет ни в одном шрифте — проверка шрифтов их не пропустит');
  assert.equal(badSymbols('сердце ❤'), '❤', '❤ без U+FE0F — буква, которой нет в шрифтах');
});

test('parseTimeline takes picture edits as the schema does: zoom strength, b/w pieces off, transitions of another kind or off', () => {
  const ok = { rev: 1, edits: [], zoom: 0.5, looks: [{ at: [1, 2.5], off: true }], transitions: [{ at: 3.2, kind: 'blur' }, { at: 5, off: true }] };
  assert.deepEqual(parseTimeline(ok), ok);
  for (const bad of [
    { ...ok, zoom: 2 }, { ...ok, zoom: -0.1 }, { ...ok, zoom: '1' }, { ...ok, zoom: null },
    { ...ok, looks: [{ at: [1, 2] }] }, { ...ok, looks: [{ at: [1, 2], off: false }] }, { ...ok, looks: [{ at: [1], off: true }] },
    { ...ok, looks: [{ at: [1, 2], off: true, look: 'bw' }] }, { ...ok, looks: {} },
    { ...ok, transitions: [{ at: -1 }] }, { ...ok, transitions: [{ at: 1, kind: 'wipe' }] }, { ...ok, transitions: [{ at: 1, off: false }] },
    { ...ok, transitions: [{ kind: 'flash' }] }, { ...ok, transitions: [{ at: 1, sfx: null }] },
    { ...ok, looks: Array(LIMITS.blocks + 1).fill({ at: [1, 2], off: true }) }, { ...ok, transitions: Array(LIMITS.blocks + 1).fill({ at: 1, off: true }) },
  ]) assert.equal(parseTimeline(bad), null, JSON.stringify(bad).slice(0, 120));
  const p = SCHEMA.properties;
  assert.deepEqual([p.zoom.minimum, p.zoom.maximum, p.looks.maxItems, p.transitions.maxItems], [LIMITS.zoom.min, LIMITS.zoom.max, LIMITS.blocks, LIMITS.blocks]);
  assert.deepEqual(p.transitions.items.properties.kind.enum, [...TRANSITION_KINDS]);
});

test('picture setters: zoom strength within the limits (as the session — no field), a b/w piece off and back, a transition of another kind or off', () => {
  assert.equal(setZoom(EMPTY, 0.5).zoom, 0.5);
  assert.equal(setZoom(EMPTY, 9).zoom, LIMITS.zoom.max);
  assert.equal(setZoom(EMPTY, -1).zoom, 0, 'без зума');
  assert.equal(setZoom(EMPTY, 0.333).zoom, 0.33, 'два знака: ползунок с шагом в процент');
  assert.ok(!('zoom' in setZoom(setZoom(EMPTY, 0.5), 1)), 'как у монтажа — поля нет');
  assert.ok(!('zoom' in setZoom(setZoom(EMPTY, 0.5), null)));
  const off = setLook(EMPTY, [1, 2.5], true);
  assert.deepEqual(off.looks, [{ at: [1, 2.5], off: true }]);
  assert.deepEqual(setLook(off, [1, 2.5], true).looks, [{ at: [1, 2.5], off: true }], 'дважды — одна правка');
  assert.deepEqual(setLook(off, [3, 4], true).looks, [{ at: [1, 2.5], off: true }, { at: [3, 4], off: true }]);
  assert.ok(!('looks' in setLook(off, [1, 2.5], false)), 'вернули — правки нет');
  const blur = setTransition(EMPTY, 3.2, { kind: 'blur' });
  assert.deepEqual(blur.transitions, [{ at: 3.2, kind: 'blur' }]);
  assert.deepEqual(setTransition(blur, 3.2, { kind: 'blur', off: true }).transitions, [{ at: 3.2, kind: 'blur', off: true }]);
  assert.deepEqual(setTransition(blur, 5, { off: true }).transitions, [{ at: 3.2, kind: 'blur' }, { at: 5, off: true }]);
  assert.ok(!('transitions' in setTransition(blur, 3.2, null)), 'как у монтажа — правки нет');
  assert.ok(!('transitions' in setTransition(blur, 3.2, { off: false })), 'ни вида, ни «убран» — правки нет');
  for (const h of [setZoom(off, 0.25), blur, setTransition(blur, 5, { off: true })]) assert.ok(parseTimeline({ rev: 1, ...h }), 'сеттеры пишут то, что примет схема');
});

test('parseTimeline takes the background dim, another music track and the end card text as the schema does', () => {
  const ok = { rev: 1, edits: [], dim: 0.5, music: { file: 'assets/music/Calm Morning.mp3', gainDb: -16 }, text: { end: { lines: ['Подпишись', 'и пиши'], handle: '@pavel' } } };
  assert.deepEqual(parseTimeline(ok), ok);
  assert.ok(parseTimeline({ rev: 1, edits: [], text: { end: { off: true } } }) && parseTimeline({ rev: 1, edits: [], text: { end: { handle: '' } } }));
  for (const bad of [
    { ...ok, dim: 0.9 }, { ...ok, dim: -0.1 }, { ...ok, dim: '0.3' },
    { ...ok, music: { file: '../secret.mp3' } }, { ...ok, music: { file: 'assets/sfx/a.mp3' } }, { ...ok, music: { file: 'assets/music/a.txt' } },
    { ...ok, text: { end: { lines: [] } } }, { ...ok, text: { end: { lines: ['a', 'b', 'c'] } } }, { ...ok, text: { end: { off: false } } },
    { ...ok, text: { end: { handle: 'x'.repeat(61) } } }, { ...ok, text: { end: { logo: 'x.png' } } }, { ...ok, text: { end: { lines: [''] } } },
  ]) assert.equal(parseTimeline(bad), null, JSON.stringify(bad).slice(0, 120));
  const p = SCHEMA.properties;
  assert.deepEqual([p.dim.minimum, p.dim.maximum, p.text.properties.end.properties.lines.maxItems, p.text.properties.end.properties.handle.maxLength],
    [LIMITS.dim.min, LIMITS.dim.max, LIMITS.endLines, LIMITS.handle]);
  assert.equal(SCHEMA.$defs.Music.properties.file.pattern, MUSIC_FILE.source.replace(/\\\//g, '/'), 'тот же образец пути трека');
});

test('setters: the dim (as the session — no field), another track or back to the session\'s, the end card lines, handle or off', () => {
  assert.equal(setDim(EMPTY, 0.456).dim, 0.46);
  assert.equal(setDim(EMPTY, 2).dim, LIMITS.dim.max);
  assert.equal(setDim(EMPTY, 0).dim, 0, '0 — без затемнения (а не как у сессии)');
  assert.ok(!('dim' in setDim(setDim(EMPTY, 0.3), null)), 'как у монтажа — поля нет');
  const track = setTrack(setMusic(EMPTY, { gainDb: -10 }), 'assets/music/b.mp3');
  assert.deepEqual(track.music, { gainDb: -10, file: 'assets/music/b.mp3' });
  assert.deepEqual(setTrack(track, null).music, { gainDb: -10 }, 'трек сессии — без поля, громкость Павла остаётся');
  assert.ok(!('music' in setTrack(setTrack(EMPTY, 'assets/music/b.mp3'), null)), 'ничего не осталось — поля нет');
  const end = setEnd(EMPTY, { lines: ['Пиши «план»'] });
  assert.deepEqual(end.text, { end: { lines: ['Пиши «план»'] } });
  assert.deepEqual(setEnd(end, { handle: '@me' }).text?.end, { lines: ['Пиши «план»'], handle: '@me' }, 'правка поверх прежней');
  assert.deepEqual(setEnd(end, { off: true }).text?.end, { off: true }, 'убрать — без прочего');
  assert.ok(!setEnd(end, null).text, 'как у сессии — правки нет');
  for (const h of [setDim(EMPTY, 0.3), track, setEnd(end, { handle: '' })]) assert.ok(parseTimeline({ rev: 1, ...h }), 'сеттеры пишут то, что примет схема');
});

test('the teaser off and the speed: parsed as the schema does, set within the limits (as the session — no field)', () => {
  const ok = { rev: 1, edits: [], teaser: false, speed: 1.25 };
  assert.deepEqual(parseTimeline(ok), ok);
  for (const bad of [{ ...ok, teaser: true }, { ...ok, teaser: null }, { ...ok, speed: 0.7 }, { ...ok, speed: 1.6 }, { ...ok, speed: '1.2' }]) {
    assert.equal(parseTimeline(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual([SCHEMA.properties.speed.minimum, SCHEMA.properties.speed.maximum], [LIMITS.speed.min, LIMITS.speed.max]);
  assert.equal(setTeaser(EMPTY, false).teaser, false);
  assert.ok(!('teaser' in setTeaser(setTeaser(EMPTY, false), true)), 'вернули — как у монтажа');
  assert.equal(setSpeed(EMPTY, 1.234).speed, 1.23);
  assert.equal(setSpeed(EMPTY, 3).speed, LIMITS.speed.max);
  assert.ok(!('speed' in setSpeed(setSpeed(EMPTY, 1.2), null)));
  assert.ok(parseTimeline({ rev: 1, ...setSpeed(setTeaser(EMPTY, false), 0.9) }), 'сеттеры пишут то, что примет схема');
});
