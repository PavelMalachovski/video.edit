import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTemplate } from '../scripts/copy-template.mjs';

const TEMPLATE = fileURLToPath(new URL('../../template', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/copy-template.mjs', import.meta.url));

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vm-copy-'));
}

/** Шаблон в миниатюре: страница, скрипт, шрифт, fonts.json — и то, что странице не нужно. */
function miniTemplate(root: string): string {
  const dir = path.join(root, 'template');
  const files: Record<string, string | Buffer> = {
    'overlay.html': '<!doctype html>', 'overlay.js': 'export {}', 'inserts.js': 'export {}', 'overlay.css': 'body{}',
    'fonts.json': JSON.stringify([{ id: 'montserrat', family: 'Montserrat', file: 'fonts/montserrat/montserrat.ttf', weight: 800, kind: 'main' }]),
    'fonts/montserrat/montserrat.ttf': Buffer.from([0, 1, 2, 255]),
    'fonts.mjs': fs.readFileSync(path.join(TEMPLATE, 'fonts.mjs')), // правило своих шрифтов — то же, что у рендера
    'render-frames.mjs': '', 'package.json': '{}', 'package-lock.json': '{}', 'tests/overlay.test.mjs': '', 'node_modules/x/index.js': '',
  };
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test('copies the template byte for byte and leaves out tests and node scripts', async () => {
  const root = tmp();
  const templateDir = miniTemplate(root);
  const outDir = path.join(root, 'out');
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'stale.js'), 'old'); // от прошлой сборки
  const { files, fonts } = await copyTemplate({ templateDir, fontsDir: path.join(root, 'no-fonts'), outDir });
  for (const name of ['overlay.html', 'overlay.js', 'inserts.js', 'overlay.css', 'fonts/montserrat/montserrat.ttf']) {
    assert.deepEqual(fs.readFileSync(path.join(outDir, name)), fs.readFileSync(path.join(templateDir, name)), name);
  }
  for (const name of ['fonts.mjs', 'render-frames.mjs', 'package.json', 'package-lock.json', 'tests', 'node_modules', 'stale.js']) {
    assert.equal(fs.existsSync(path.join(outDir, name)), false, name);
  }
  assert.equal(files, 6);
  assert.deepEqual(fonts, []);
});

test('custom fonts join fonts.json; -hand files are handwritten', async () => {
  const root = tmp();
  const templateDir = miniTemplate(root);
  const fontsDir = path.join(root, 'fonts');
  fs.mkdirSync(fontsDir);
  fs.writeFileSync(path.join(fontsDir, 'Moj Shrift.ttf'), Buffer.from([7, 7]));
  fs.writeFileSync(path.join(fontsDir, 'pocherk-hand.otf'), Buffer.from([8]));
  fs.writeFileSync(path.join(fontsDir, 'montserrat.ttf'), Buffer.from([9])); // встроенный с тем же id важнее
  fs.writeFileSync(path.join(fontsDir, 'README.md'), 'не шрифт');
  const outDir = path.join(root, 'out');
  const { fonts } = await copyTemplate({ templateDir, fontsDir, outDir });
  assert.deepEqual(fonts, ['Moj Shrift', 'pocherk-hand']);
  const list = JSON.parse(fs.readFileSync(path.join(outDir, 'fonts.json'), 'utf8')) as { id: string; file: string; kind: string; weight: number }[];
  assert.deepEqual(list.map((f) => [f.id, f.kind]), [['montserrat', 'main'], ['Moj Shrift', 'main'], ['pocherk-hand', 'hand']]);
  const mine = list.find((f) => f.id === 'Moj Shrift')!;
  assert.equal(mine.weight, 400);
  assert.deepEqual(fs.readFileSync(path.join(outDir, decodeURIComponent(mine.file))), Buffer.from([7, 7]));
  assert.equal(list.find((f) => f.id === 'montserrat')!.file, 'fonts/montserrat/montserrat.ttf');
});

test('missing template fails with the Vercel hint', async () => {
  const root = tmp();
  await assert.rejects(copyTemplate({ templateDir: path.join(root, 'template'), fontsDir: path.join(root, 'f'), outDir: path.join(root, 'out') }),
    /Include files outside the root directory/);
  const web = path.join(root, 'web');
  fs.mkdirSync(web);
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: web, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /template\/ не найден рядом с web\/: в Vercel включите Include files outside the root directory in the Build Step/);
});
