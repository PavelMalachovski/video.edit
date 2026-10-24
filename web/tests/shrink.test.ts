import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitsMemory, MAX_IN_MEMORY, ORIGINAL_SPEED, SHRINK_BITRATE, shrinkKey, shrinkSize, shrunkBytes, STALL, stuck, tooSlow, whyOriginal,
} from '../lib/shrink.ts';

test('a 4K vertical video shrinks to 1080×1920, a landscape one to width 1080 with an even height', () => {
  assert.deepEqual(shrinkSize(2160, 3840), { width: 1080, height: 1920 });
  assert.deepEqual(shrinkSize(3840, 2160), { width: 1080, height: 608 }); // 607,5 → чётная
  assert.deepEqual(shrinkSize(1440, 1920), { width: 1080, height: 1440 });
});

test('a video no wider than 1080 is not shrunk — there is nothing to gain', () => {
  assert.equal(shrinkSize(1080, 1920), null);
  assert.equal(shrinkSize(720, 1280), null);
  assert.equal(shrinkSize(0, 0), null);
});

test('the original goes as it is when asked, when HDR, when the browser cannot decode or encode it', () => {
  const fine = { asked: false, hdr: false, decodable: true, encodable: true, size: { width: 1080, height: 1920 } };
  assert.equal(whyOriginal(fine), null);
  assert.match(whyOriginal({ ...fine, asked: true }) ?? '', /оригинал/);
  assert.match(whyOriginal({ ...fine, hdr: true }) ?? '', /HDR/);
  assert.match(whyOriginal({ ...fine, decodable: false }) ?? '', /не читает/);
  assert.match(whyOriginal({ ...fine, encodable: false }) ?? '', /не умеет/);
  assert.match(whyOriginal({ ...fine, size: null }) ?? '', /1080/);
});

test('the shrunk file is about the bitrate times the length', () => {
  assert.equal(shrunkBytes(60), (SHRINK_BITRATE * 60) / 8 + 192_000 * 60 / 8);
});

test('shrinking is too slow when it plus the upload of the result would take longer than the original upload', () => {
  const original = 1_200_000_000; // 1,2 ГБ ≈ 2 минуты 4K
  const seconds = 120;
  const plain = original / ORIGINAL_SPEED; // ~380 с
  // через 10 с готово 10 %: всё уменьшение ~100 с, плюс загрузка ~300 МБ ~95 с — быстрее оригинала
  assert.equal(tooSlow({ elapsed: 10, progress: 0.1, originalBytes: original, seconds }), false);
  // через 10 с готово 3 %: ~333 с одного уменьшения — дольше оригинала
  assert.equal(tooSlow({ elapsed: 10, progress: 0.03, originalBytes: original, seconds }), true);
  assert.ok(plain > 300 && plain < 400, String(plain));
});

test('too early to judge the speed: under 10 seconds or no progress yet', () => {
  assert.equal(tooSlow({ elapsed: 5, progress: 0.001, originalBytes: 1e9, seconds: 120 }), false);
  assert.equal(tooSlow({ elapsed: 12, progress: 0, originalBytes: 1e9, seconds: 120 }), false);
});

test('the shrunk copy is found again by the same picked file — name and size', () => {
  assert.equal(shrinkKey({ name: 'IMG_0001.MOV', size: 123 }), shrinkKey({ name: 'IMG_0001.MOV', size: 123 }));
  assert.notEqual(shrinkKey({ name: 'IMG_0001.MOV', size: 123 }), shrinkKey({ name: 'IMG_0001.MOV', size: 124 }));
  assert.match(shrinkKey({ name: 'видео/../1.MOV', size: 5 }), /^shrink-[0-9a-z]+-5\.mp4$/);
});

test('without a file in the browser storage the copy lives in memory: only up to about 200 MB, else the original', () => {
  assert.equal(fitsMemory(60), true); // минута ≈ 150 МБ
  assert.equal(fitsMemory(4 * 60), false); // 4 минуты ≈ 600 МБ — iPhone выгрузил бы вкладку
  assert.ok(shrunkBytes(80) <= MAX_IN_MEMORY && shrunkBytes(90) > MAX_IN_MEMORY);
});

test('shrinking is stuck when no progress came for STALL seconds', () => {
  assert.equal(stuck(STALL - 1), false);
  assert.equal(stuck(STALL), true);
});
