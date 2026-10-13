import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes, mmss, tenths } from '../lib/format.ts';

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

test('tenths: minutes, seconds and a tenth for the timeline; never negative', () => {
  assert.equal(tenths(0), '0:00.0');
  assert.equal(tenths(12.34), '0:12.3');
  assert.equal(tenths(59.96), '1:00.0', 'округление не даёт 0:60.0');
  assert.equal(tenths(75.5), '1:15.5');
  assert.equal(tenths(-3), '0:00.0');
});
