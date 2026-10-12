import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Timeline } from '../lib/timeline.ts';

// Общая с движком фикстура: Timeline в engine/vm/timeline.py обязан давать то же самое.
type Pair = [number, number | null];
type Case = {
  keep: [number, number][]; speed: number; teaser: [number, number] | null; duration: number; teaserDuration: number;
  segments: [number, number, number][]; toFinal: Pair[]; teaserFinal: Pair[]; toFinalSnap: Pair[]; toCut: Pair[];
  toCutWithin: [number, number, number][]; toSource: Pair[];
  runOf?: [number, number | null][]; span?: [number, number, boolean, [number, number]][];
};
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../engine/tests/fixtures/timeline-map.json', import.meta.url), 'utf8')) as {
  cases: Case[]; refused: { keep: unknown; speed: unknown; teaser?: unknown }[];
};
const same = (got: number | null, want: number | null) => (got === null ? want === null : want !== null && Math.abs(got - want) <= 1e-9);

test('Timeline matches the shared engine fixture', () => {
  for (const c of FIXTURE.cases) {
    const tl = new Timeline(c.keep, c.speed, c.teaser);
    const at = `keep ${JSON.stringify(c.keep)} ×${c.speed} teaser ${JSON.stringify(c.teaser)}`;
    assert.ok(same(tl.duration, c.duration) && same(tl.teaserDuration, c.teaserDuration), at);
    assert.equal(tl.segments.length, c.segments.length, at);
    tl.segments.forEach((s, i) => assert.ok(s.every((x, k) => same(x, c.segments[i][k])), `${at}: segment ${i}`));
    const fns: [keyof Case, (t: number) => number | null][] = [
      ['toFinal', (t) => tl.toFinal(t)], ['teaserFinal', (t) => tl.teaserFinal(t)], ['toFinalSnap', (t) => tl.toFinalSnap(t)],
      ['toCut', (t) => tl.toCut(t)], ['toSource', (t) => tl.toSource(t)],
    ];
    for (const [name, fn] of fns) {
      for (const [t, want] of c[name] as Pair[]) assert.ok(same(fn(t), want), `${at}: ${name}(${t}) = ${fn(t)}, want ${want}`);
    }
    for (const [t, within, want] of c.toCutWithin) assert.ok(same(tl.toCut(t, within), want), `${at}: toCut(${t}, ${within})`);
    for (const [t, want] of c.runOf ?? []) assert.equal(tl.runOf(t), want, `${at}: runOf(${t})`);
    for (const [t0, t1, cut, want] of c.span ?? []) {
      const got = tl.span(t0, t1, cut);
      assert.ok(same(got[0], want[0]) && same(got[1], want[1]), `${at}: span(${t0}, ${t1}, ${cut}) = ${got}, want ${want}`);
    }
  }
  assert.ok(FIXTURE.cases.some((c) => c.keep.some((k, i) => i > 0 && k[0] < c.keep[i - 1][0])), 'в фикстуре есть и переставленные куски');
});

test('Timeline refuses what the engine refuses', () => {
  for (const b of FIXTURE.refused) {
    assert.throws(() => new Timeline(b.keep as [number, number][], b.speed as number, (b.teaser ?? null) as [number, number] | null), JSON.stringify(b));
  }
});
