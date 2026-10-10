import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes, mmss } from '../lib/format.ts';

test('mmss shows minutes and zero-padded seconds', () => {
  assert.equal(mmss(0), '0:00');
  assert.equal(mmss(61.4), '1:01');
  assert.equal(mmss(59.6), '1:00');
  assert.equal(mmss(3725), '62:05');
});

test('bytes reads like the mockups', () => {
  assert.equal(bytes(70), '1 КБ');
  assert.equal(bytes(300 * 1024), '300 КБ');
  assert.equal(bytes(184 * 1024 ** 2), '184 МБ');
  assert.equal(bytes(2.08 * 1024 ** 3), '2,08 ГБ');
});
