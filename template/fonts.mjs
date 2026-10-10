// Свои шрифты Павла (assets/fonts/*.ttf|otf) рядом со встроенными (fonts.json).
// id — имя файла без расширения; файл с окончанием «-hand» — рукописный, остальные — основные.
// Встроенный шрифт с тем же id важнее: свой файл с таким именем не подменяет его.
import path from 'node:path';

const FONT_FILE = /\.(ttf|otf)$/i;

/** Записи fonts.json для файлов шрифтов `names`, лежащих в папке `dir` (путь от шаблона). */
export function customFonts(names, dir) {
  return names
    .filter((name) => FONT_FILE.test(name))
    .sort()
    .map((name) => {
      const id = path.parse(name).name;
      return { id, family: id, file: `${dir}/${name}`, weight: 400, kind: id.toLowerCase().endsWith('-hand') ? 'hand' : 'main' };
    });
}

/** Встроенные шрифты и свои — одним списком, без повторов id. */
export function mergeFonts(builtIn, custom) {
  const known = new Set(builtIn.map((f) => f.id));
  return [...builtIn, ...custom.filter((f) => !known.has(f.id))];
}
