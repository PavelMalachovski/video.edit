import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickGuard, dragTo, MIN_BLOCK, type Drag, type DragView } from '../lib/drag.ts';
import { draftTracks, wordEdges, type Draft } from '../lib/tracks.ts';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const DRAFT: Draft = {
  speed: 1, keep: [[0.5, 2], [3, 5]], hook: null, cta: null, inserts: [], zooms: [], music: null, transitions: [], looks: [], accents: [],
  words: [{ t0: 3.1, t1: 3.4, text: 'раз' }, { t0: 4.5, t1: 4.6, text: 'два' }],
};
const tracks = draftTracks(DRAFT);
const view: DragView = { tracks, px: 100, speed: 1, edges: wordEdges(DRAFT), snapPx: 8, duration: tracks.duration };

test('a trimmed edge is where the pointer is, and sticks to a word edge within 8 px', () => {
  const start: Drag = { kind: 'trim', index: 1, side: 'end', x0: 500, to: 5 };
  const d = dragTo(start, 500 - 39, view); // 0,39 с левее конца 5 — у конца слова 4,6 (4 px)
  assert.ok(d.kind === 'trim' && near(d.to, 4.6), JSON.stringify(d));
  const far = dragTo(start, 500 - 20, view);
  assert.ok(far.kind === 'trim' && near(far.to, 4.8), 'дальше 8 px от слова — как есть');
});

test('the end of a drag is where the pointer was let go, whatever the last drawn step was (Safari e2e)', () => {
  const start: Drag = { kind: 'trim', index: 1, side: 'end', x0: 500, to: 5 };
  const late = dragTo(dragTo(start, 480, view), 461, view); // последний нарисованный шаг — 480, отпустили на 461
  assert.deepEqual(late, dragTo(start, 461, view));
  const piece: Drag = { kind: 'piece', index: 1, x0: 300, tf0: 3, dx: 0, slot: null, moved: false };
  assert.deepEqual(dragTo(dragTo(piece, 250, view), 120, view), dragTo(piece, 120, view));
});

test('a piece: a small move is a click, a real one picks the join nearest the pointer', () => {
  const piece: Drag = { kind: 'piece', index: 1, x0: 300, tf0: 3, dx: 0, slot: null, moved: false };
  const click = dragTo(piece, 302, view);
  assert.ok(click.kind === 'piece' && !click.moved && click.slot === null);
  const first = dragTo(piece, 50, view); // 0,5 с ролика — до середины первого куска (0,75): перед первым
  assert.ok(first.kind === 'piece' && first.moved && first.slot === 0 && first.dx === -250, JSON.stringify(first));
  const second = dragTo(piece, 120, view); // 1,2 с — за серединой первого: перед вторым (на своём же месте)
  assert.ok(second.kind === 'piece' && second.slot === 1, JSON.stringify(second));
});

test('music: moved within the video (not past half a second before its end); its start trimmed both ways', () => {
  const music: Drag = { kind: 'music', mode: 'move', x0: 100, at0: 1, from0: 0, at: 1, from: 0, moved: false };
  const late = dragTo(music, 100 + 10_000, view);
  assert.ok(late.kind === 'music' && near(late.at, tracks.duration - 0.5) && late.moved);
  const early = dragTo(music, 0, view);
  assert.ok(early.kind === 'music' && near(early.at, 0));
  const trim: Drag = { ...music, mode: 'trim', from0: 2, from: 2 };
  const t = dragTo(trim, 150, view); // на 0,5 с позже: и в ролике, и в треке
  assert.ok(t.kind === 'music' && near(t.at, 1.5) && near(t.from, 2.5));
});

test('a text or insert block: moved whole or by an edge, its edges stick to words, never before its floor or past the end', () => {
  const v = { ...view, finalEdges: [1.0, 1.5, 2.25] };
  const block: Drag = { kind: 'block', ref: { kind: 'insert', n: 0, at: [3, 4], occurrence: 0 }, mode: 'move', x0: 100, t0: 1.0, t1: 2.0, a: 1.0, b: 2.0, floor: 0.5, max: 3.5, moved: false };
  const small = dragTo(block, 102, v);
  assert.ok(small.kind === 'block' && !small.moved, 'сдвиг на 2 px — щелчок');
  const moved = dragTo(block, 100 + 47, v); // +0,47 с → начало 1,47 — у слова на 1,5 (3 px)
  assert.ok(moved.kind === 'block' && moved.moved && near(moved.a, 1.5) && near(moved.b, 2.5), JSON.stringify(moved));
  const early = dragTo(block, 100 - 200, v);
  assert.ok(early.kind === 'block' && near(early.a, 0.5) && near(early.b, 1.5), 'раньше floor (конец хука) — нет');
  const late = dragTo(block, 100 + 500, v);
  assert.ok(late.kind === 'block' && near(late.b, 3.5), 'позже конца ролика — нет');
  const end = dragTo({ ...block, mode: 'end' }, 100 + 26, v); // конец 2,26 — у слова на 2,25
  assert.ok(end.kind === 'block' && near(end.a, 1.0) && near(end.b, 2.25), JSON.stringify(end));
  const short = dragTo({ ...block, mode: 'end' }, 100 - 300, v);
  assert.ok(short.kind === 'block' && near(short.b, 1.2), 'не короче 0,2 с');
  const start = dragTo({ ...block, mode: 'start' }, 100 - 80, v);
  assert.ok(start.kind === 'block' && near(start.a, 0.5) && near(start.b, 2.0), 'начало — не раньше floor');
});

test('a block with no room in speech yet (an insert under the hook) is moved at least the shortest block long', () => {
  const v = { ...view, finalEdges: [] };
  const flat: Drag = { kind: 'block', ref: { kind: 'insert', n: 0, at: [0.2, 0.4], occurrence: 0 }, mode: 'move', x0: 100, t0: 0.5, t1: 0.5, a: 0.5, b: 0.5, floor: 0.5, max: 3.5, moved: false };
  const moved = dragTo(flat, 100 + 100, v);
  assert.ok(moved.kind === 'block' && near(moved.a, 1.5) && near(moved.b, 1.5 + MIN_BLOCK), JSON.stringify(moved));
  const late = dragTo(flat, 100 + 10_000, v);
  assert.ok(late.kind === 'block' && near(late.b, 3.5) && near(late.a, 3.5 - MIN_BLOCK), 'и у конца ролика — не короче');
});

test('the click that ends a drag does not select; the next press is a new gesture even when no click came after the drag (a finger)', () => {
  const g = clickGuard();
  g.down();
  g.dragged();
  assert.equal(g.click(), false, 'щелчок после перетаскивания мышью — не выбор');
  assert.equal(g.click(), true, 'следующий — выбор');
  g.down();
  g.dragged(); // пальцем: после перетаскивания браузер щелчка не шлёт
  g.down(); // касание группы субтитров (её не тянут)
  assert.equal(g.click(), true, 'новое нажатие — новый жест: его щелчок — выбор');
});
