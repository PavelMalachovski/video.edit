// Шаблон слоя (template/) → web/public/template: страница рисует превью тем же overlay.html, которым движок рисует
// кадры финала. Тесты и скрипты Node браузеру не нужны; свои шрифты Павла (assets/fonts) дописываются в fonts.json
// по правилу template/fonts.mjs — тому же, что у render-frames.mjs.
//
//   node scripts/copy-template.mjs      — из web/: ../template и ../assets/fonts → public/template
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['tests', 'node_modules']);
const HINT = 'template/ не найден рядом с web/: в Vercel включите Include files outside the root directory in the Build Step';

const skipFile = (name) => name === 'package.json' || name === 'package-lock.json' || name.endsWith('.mjs');

/**
 * Скопировать шаблон в `outDir` (прежнее содержимое удаляется) и дописать свои шрифты из `fontsDir`.
 * @param {{ templateDir: string, fontsDir: string, outDir: string }} dirs
 * @returns {Promise<{ files: number, fonts: string[] }>} сколько файлов шаблона и id добавленных своих шрифтов
 */
export async function copyTemplate({ templateDir, fontsDir, outDir }) {
  if (!fs.existsSync(path.join(templateDir, 'overlay.html'))) throw new Error(HINT);
  fs.rmSync(outDir, { recursive: true, force: true });
  let files = 0;
  const walk = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(src, path.join(to, entry.name));
      } else if (entry.isFile() && !skipFile(entry.name)) {
        fs.mkdirSync(to, { recursive: true });
        fs.copyFileSync(src, path.join(to, entry.name));
        files += 1;
      }
    }
  };
  walk(templateDir, outDir);

  const { customFonts, mergeFonts } = await import(pathToFileURL(path.join(templateDir, 'fonts.mjs')).href);
  const builtIn = JSON.parse(fs.readFileSync(path.join(outDir, 'fonts.json'), 'utf8'));
  const names = fs.existsSync(fontsDir) ? fs.readdirSync(fontsDir) : [];
  const merged = mergeFonts(builtIn, customFonts(names, 'fonts'));
  const added = merged.slice(builtIn.length);
  for (const f of added) {
    const file = decodeURIComponent(f.file);
    fs.mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
    fs.copyFileSync(path.join(fontsDir, path.basename(file)), path.join(outDir, file));
  }
  fs.writeFileSync(path.join(outDir, 'fonts.json'), `${JSON.stringify(merged, null, 2)}\n`);
  return { files, fonts: added.map((f) => f.id) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const web = process.cwd();
  try {
    const { files, fonts } = await copyTemplate({
      templateDir: path.resolve(web, '../template'),
      fontsDir: path.resolve(web, '../assets/fonts'),
      outDir: path.resolve(web, 'public/template'),
    });
    console.log(`template → public/template: ${files} файлов${fonts.length ? `; свои шрифты: ${fonts.join(', ')}` : ''}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
