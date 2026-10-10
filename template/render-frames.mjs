#!/usr/bin/env node
// Кадры слоя для финала: по одному PNG на промежуток (одинаковые состояния — один файл),
// frames.ffconcat с длительностью каждого промежутка (вход для ffmpeg) и boxes.json с рамками
// элементов по промежуткам (для проверки геометрии).
//
//   node template/render-frames.mjs <events.json> <spec.json> <out_dir> [--root DIR]... [--fonts DIR]
//
// events.json — [{t0, t1, state}] из vm.overlay.build_overlay_events; spec.json — спецификация стиля.
// --root — откуда брать картинки вставок (src — путь от корня: in/uploads/…, assets/…), можно несколько.
// --fonts — папка своих шрифтов (assets/fonts): они добавляются к fonts.json шаблона.
// Печатает {"frames": N, "intervals": M, "duration": D}; ошибка — текст в stderr и код 1.
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { framePage, launch } from './browser.mjs';
import { customFonts, mergeFonts } from './fonts.mjs';
import { serve } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const positional = [];
  const roots = [];
  let fonts = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') roots.push(path.resolve(argv[++i] ?? ''));
    else if (argv[i] === '--fonts') fonts = path.resolve(argv[++i] ?? '');
    else positional.push(argv[i]);
  }
  if (positional.length !== 3) {
    throw new Error('usage: render-frames.mjs <events.json> <spec.json> <out_dir> [--root DIR]... [--fonts DIR]');
  }
  const [events, spec, out] = positional.map((p) => path.resolve(p));
  return { events, spec, out, roots, fonts };
}

/** Ключ состояния: тот же JSON при любом порядке полей. */
function stateKey(value) {
  if (Array.isArray(value)) return `[${value.map(stateKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stateKey(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Папка с fonts.json шаблона и своими шрифтами — её сервер отдаёт первой. */
async function fontsOverlay(fontsDir) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vm-fonts-'));
  const builtIn = JSON.parse(await readFile(path.join(HERE, 'fonts.json'), 'utf8'));
  let custom = [];
  if (fontsDir) {
    const names = await readdir(fontsDir);
    custom = customFonts(names, 'custom-fonts');
    await mkdir(path.join(dir, 'custom-fonts'));
    for (const f of custom) await copyFile(path.join(fontsDir, path.basename(f.file)), path.join(dir, f.file));
  }
  await writeFile(path.join(dir, 'fonts.json'), JSON.stringify(mergeFonts(builtIn, custom)));
  return dir;
}

function frameName(i) {
  return `f${String(i).padStart(5, '0')}.png`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const events = JSON.parse(await readFile(args.events, 'utf8'));
  const spec = JSON.parse(await readFile(args.spec, 'utf8'));
  if (!Array.isArray(events) || events.length === 0) throw new Error(`${args.events}: нужен непустой список промежутков`);
  await mkdir(args.out, { recursive: true });

  const fontsDir = await fontsOverlay(args.fonts);
  const server = await serve([fontsDir, HERE, ...args.roots]);
  const browser = await launch();
  try {
    const page = await framePage(browser);
    await page.goto(`${server.url}/overlay.html`);
    const files = new Map(); // ключ состояния → {name, boxes}
    const used = [];
    for (const [i, e] of events.entries()) {
      if (!(e.t1 > e.t0)) throw new Error(`промежуток ${i}: t1 (${e.t1}) должен быть больше t0 (${e.t0})`);
      const key = stateKey(e.state ?? {});
      let made = files.get(key);
      if (!made) {
        try {
          await page.evaluate(([s, st]) => window.renderState(s, st), [spec, e.state ?? {}]);
        } catch (err) {
          throw new Error(`промежуток ${i} (${e.t0}–${e.t1} с): ${String(err.message ?? err).replace(/^.*?Error: /s, '')}`);
        }
        const name = frameName(files.size);
        await page.screenshot({ path: path.join(args.out, name), omitBackground: true });
        made = { name, boxes: await page.evaluate(() => window.layoutBoxes()) };
        files.set(key, made);
      }
      used.push({ ...made, t0: e.t0, t1: e.t1 });
    }
    const lines = ['ffconcat version 1.0'];
    for (const u of used) lines.push(`file '${u.name}'`, `duration ${(u.t1 - u.t0).toFixed(6)}`);
    lines.push(`file '${used.at(-1).name}'`); // у последнего файла ffmpeg учитывает длительность, только если он повторён
    await writeFile(path.join(args.out, 'frames.ffconcat'), `${lines.join('\n')}\n`);
    await writeFile(path.join(args.out, 'boxes.json'), JSON.stringify(used.map((u) => ({ t0: u.t0, t1: u.t1, boxes: u.boxes }))));
    const duration = used.at(-1).t1 - used[0].t0;
    process.stdout.write(`${JSON.stringify({ frames: files.size, intervals: used.length, duration })}\n`);
  } finally {
    await browser.close();
    await server.close();
    await rm(fontsDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`render-frames: ${err.message ?? err}\n`);
  process.exit(1);
});
