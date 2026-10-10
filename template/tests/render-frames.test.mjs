// render-frames.mjs целиком: отдельный процесс, настоящий Chromium, файлы во временной папке.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { customFonts, mergeFonts } from '../fonts.mjs';

const run = promisify(execFile);

/** Однотонный PNG `w×h` (RGBA) — без библиотек: сигнатура, IHDR, IDAT, IEND. */
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 бит, RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgba).flat())]);
  const raw = Buffer.concat(Array(h).fill(row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'render-frames.mjs');

const SPEC = {
  font: 'montserrat',
  hand: 'caveat',
  colors: { text: '#FFFFFF', accent: '#FFD23F', bar: '#FFD23F', plate: '#111111', outline: '#000000' },
  subtitles: { mode: 'karaoke', words: 3, size: 64, y: 1300 },
  hook: { mode: 'plate', size: 72 },
  bar: { pos: 'bottom', height: 14 },
};

const SUB_A = { sub: { words: ['раз', 'два'], active: 0, visible: 2 } };
const SUB_B = { sub: { words: ['раз', 'два'], active: 1, visible: 2 } };

let dir;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vm-render-frames-'));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function job(name, events, spec = SPEC) {
  const home = path.join(dir, name);
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'events.json'), JSON.stringify(events));
  await writeFile(path.join(home, 'spec.json'), JSON.stringify(spec));
  return home;
}

async function render(home, ...extra) {
  const { stdout } = await run(process.execPath, [SCRIPT, path.join(home, 'events.json'), path.join(home, 'spec.json'), path.join(home, 'frames'), ...extra]);
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

/** ffconcat → [{file, duration}] (последний повтор файла без длительности — отдельно). */
async function concat(home) {
  const text = await readFile(path.join(home, 'frames', 'frames.ffconcat'), 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines[0], 'ffconcat version 1.0');
  const items = [];
  for (const line of lines.slice(1)) {
    const file = line.match(/^file '(.+)'$/);
    const duration = line.match(/^duration ([\d.]+)$/);
    const option = line.match(/^option (\w+) (\S+)$/);
    if (file) items.push({ file: file[1], duration: null, options: {} });
    else if (duration) items.at(-1).duration = Number(duration[1]);
    else if (option) items.at(-1).options[option[1]] = option[2];
    else assert.fail(`unexpected line: ${line}`);
  }
  for (const i of items) assert.equal(i.options.framerate, '30', `every file keeps the 30 fps grid: ${i.file}`);
  return items;
}

test('render-frames writes ffconcat whose durations sum to total', async () => {
  const home = await job('sum', [
    { t0: 0, t1: 0.5, state: {} },
    { t0: 0.5, t1: 1.2, state: SUB_A },
    { t0: 1.2, t1: 2.0, state: { hook: { text: 'Как я монтирую' } } },
  ]);
  const summary = await render(home);
  assert.deepEqual(summary, { frames: 3, intervals: 3, duration: 2 });
  const items = await concat(home);
  const timed = items.filter((i) => i.duration !== null);
  assert.equal(timed.length, 3);
  assert.ok(Math.abs(timed.reduce((s, i) => s + i.duration, 0) - 2.0) <= 1 / 30);
  assert.equal(items.length, timed.length + 1, 'the last file is repeated once more, without a duration');
  assert.equal(items.at(-1).duration, null);
  assert.equal(items.at(-1).file, timed.at(-1).file, 'the last file is repeated for ffmpeg');
  for (const i of items) assert.ok((await stat(path.join(home, 'frames', i.file))).size > 0);
  const empty = await decode(path.join(home, 'frames', timed[0].file), '54x96');
  assert.ok(empty.every((v, k) => k % 4 !== 3 || v === 0), 'an empty state is a fully transparent PNG');
});

/** Кадры файла (или ffconcat) как RGBA `size`, через ffmpeg; ffconcat — с fps=30, как в финале. */
async function decode(file, size, concat = false) {
  const [w, h] = size.split('x').map(Number);
  const input = concat ? ['-f', 'concat', '-safe', '0', '-i', file] : ['-i', file];
  const vf = `${concat ? 'fps=30,' : ''}scale=${w}:${h}:flags=area`;
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...input, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  return stdout;
}

test('ffmpeg shows every interval on its own frames (30 fps grid)', async () => {
  // три однокадровых состояния подряд (как появление вставки) на разных сдвигах от начала, между ними — пусто
  const F = 1 / 30;
  const plan = [];
  for (let k = 1; k <= 6; k++) plan.push(['Z', k], ['A', 1], ['B', 1], ['C', 1]);
  plan.push(['Z', 3]);
  const events = [];
  let at = 0;
  for (const [name, frames] of plan) {
    const state = name === 'Z' ? {} : { sub: { words: [name.repeat(4)], active: 0, visible: 1 } };
    events.push({ t0: at * F, t1: (at + frames) * F, state, name });
    at += frames;
  }
  const home = await job('grid', events.map(({ t0, t1, state }) => ({ t0, t1, state })), { ...SPEC, subtitles: { ...SPEC.subtitles, size: 200 } });
  await render(home);
  const refs = {};
  const timed = (await concat(home)).filter((i) => i.duration !== null);
  for (const [i, e] of events.entries()) refs[e.name] ??= await decode(path.join(home, 'frames', timed[i].file), '54x96');
  const video = await decode(path.join(home, 'frames', 'frames.ffconcat'), '54x96', true);
  const size = 54 * 96 * 4;
  const expected = plan.flatMap(([name, frames]) => Array(frames).fill(name));
  const seen = [];
  for (let f = 0; f < expected.length; f++) {
    const frame = video.subarray(f * size, (f + 1) * size);
    let best = null;
    let bestDiff = Infinity;
    for (const [name, ref] of Object.entries(refs)) {
      let diff = 0;
      for (let k = 0; k < size; k++) diff += Math.abs(frame[k] - ref[k]);
      if (diff < bestDiff) [best, bestDiff] = [name, diff];
    }
    seen.push(best);
  }
  assert.equal(seen.join(''), expected.join(''));
});

test('identical states reuse one png', async () => {
  const home = await job('reuse', [
    { t0: 0, t1: 1, state: SUB_A },
    { t0: 1, t1: 2, state: SUB_B },
    { t0: 2, t1: 3, state: { sub: { visible: 2, active: 0, words: ['раз', 'два'] } } }, // как первое, поля в другом порядке
  ]);
  assert.equal((await render(home)).frames, 2);
  const timed = (await concat(home)).filter((i) => i.duration !== null);
  assert.equal(timed[0].file, timed[2].file);
  assert.notEqual(timed[0].file, timed[1].file);
  const pngs = (await readdir(path.join(home, 'frames'))).filter((f) => f.endsWith('.png'));
  assert.equal(pngs.length, 2);
});

test('boxes.json lists the layout of every interval', async () => {
  const home = await job('boxes', [
    { t0: 0, t1: 1, state: {} },
    { t0: 1, t1: 2, state: SUB_A },
  ]);
  await render(home);
  const boxes = JSON.parse(await readFile(path.join(home, 'frames', 'boxes.json'), 'utf8'));
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { t0: 0, t1: 1, boxes: { inserts: [] } });
  assert.ok(boxes[1].boxes.sub && boxes[1].boxes.sub.w > 0);
});

test('custom fonts and insert pictures come from the given folders', async () => {
  const fonts = path.join(dir, 'my-fonts');
  await mkdir(fonts, { recursive: true });
  await copyFile(path.join(ROOT, 'fonts', 'caveat', 'caveat.ttf'), path.join(fonts, 'pavel-hand.ttf'));
  await copyFile(path.join(ROOT, 'fonts', 'rubik', 'rubik.ttf'), path.join(fonts, 'Мой шрифт #1.ttf')); // имя с пробелом, # и кириллицей
  const home = await job(
    'custom',
    [{ t0: 0, t1: 1, state: { hook: { text: 'Свой шрифт' }, inserts: [{ kind: 'image', src: 'in/pic.png', x: 100, y: 600, w: 200, anim: 1, t: 0 }] } }],
    { ...SPEC, hand: 'pavel-hand', font: 'Мой шрифт #1' },
  );
  await mkdir(path.join(home, 'in'));
  await writeFile(path.join(home, 'in', 'pic.png'), png(4, 4, [255, 0, 0, 255]));
  assert.equal((await render(home, '--root', home, '--fonts', fonts)).frames, 1);
  const boxes = JSON.parse(await readFile(path.join(home, 'frames', 'boxes.json'), 'utf8'));
  assert.equal(boxes[0].boxes.inserts.length, 1);
  assert.ok(boxes[0].boxes.hook);
});

test('a bad state stops with a readable error', async () => {
  const home = await job('bad', [{ t0: 0, t1: 1, state: SUB_A }], { ...SPEC, font: 'comic-sans' });
  await assert.rejects(render(home), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /comic-sans/);
    assert.match(err.stderr, /промежуток 0/);
    return true;
  });
});

test('custom font files become fonts.json entries; built-in ids win', () => {
  const custom = customFonts(['Title.otf', 'pavel-hand.TTF', 'readme.txt', 'caveat.ttf'], 'custom-fonts');
  assert.deepEqual(custom, [
    { id: 'Title', family: 'Title', file: 'custom-fonts/Title.otf', weight: 400, kind: 'main' },
    { id: 'caveat', family: 'caveat', file: 'custom-fonts/caveat.ttf', weight: 400, kind: 'main' },
    { id: 'pavel-hand', family: 'pavel-hand', file: 'custom-fonts/pavel-hand.TTF', weight: 400, kind: 'hand' },
  ]);
  const merged = mergeFonts([{ id: 'caveat', family: 'Caveat', file: 'fonts/caveat/caveat.ttf', weight: 700, kind: 'hand' }], custom);
  assert.deepEqual(merged.map((f) => f.id), ['caveat', 'Title', 'pavel-hand']);
  assert.equal(merged[0].file, 'fonts/caveat/caveat.ttf');
});
