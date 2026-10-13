import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameJson } from '../lib/equal.ts';

test('sameJson: the same JSON value whatever the key order; arrays in order; missing and undefined keys alike', () => {
  assert.ok(sameJson({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 }));
  assert.ok(!sameJson({ c: [1, 2] }, { c: [2, 1] }));
  assert.ok(!sameJson({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(sameJson({ a: 1, b: undefined }, { a: 1 }), 'как в JSON: поля без значения нет');
  assert.ok(!sameJson(null, {}));
  assert.ok(!sameJson('1', 1));
  assert.ok(sameJson(null, null) && sameJson(undefined, undefined));
});
