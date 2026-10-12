// Общие помощники тестов шаблона: пиксели кадра со скриншота и рамка того, что реально нарисовано.

/** Скриншот страницы кадра (без фона) → разбирает соседняя вкладка `scratch`, отдаёт результат `pick`. */
async function shot(page, scratch, clip, pick) {
  const png = await page.screenshot({ clip, omitBackground: true });
  return scratch.evaluate(
    async ([b64, code]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return new Function('d', 'w', 'h', code)(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    },
    [png.toString('base64'), pick],
  );
}

/** RGBA всех пикселей прямоугольника кадра. */
export function pixels(page, scratch, clip) {
  return shot(page, scratch, clip, 'return Array.from(d);');
}

/** Рамка всех пикселей кадра с прозрачностью ≥ `alpha` (что реально нарисовано); null — пусто. */
export function drawnBox(page, scratch, alpha = 4) {
  return shot(
    page,
    scratch,
    undefined,
    `let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
     for (let k = 3, i = 0; k < d.length; k += 4, i++) {
       if (d[k] < ${alpha}) continue;
       const x = i % w, y = (i / w) | 0;
       if (x < x0) x0 = x; if (y < y0) y0 = y; if (x + 1 > x1) x1 = x + 1; if (y + 1 > y1) y1 = y + 1;
     }
     return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };`,
  );
}

/** Номера пикселей кадра с чисто белыми непрозрачными буквами. */
export function whitePixels(page, scratch) {
  return shot(
    page,
    scratch,
    undefined,
    `const o = [];
     for (let k = 0, i = 0; k < d.length; k += 4, i++) if (d[k + 3] === 255 && d[k] >= 250 && d[k + 1] >= 250 && d[k + 2] >= 250) o.push(i);
     return o;`,
  );
}

/** Сколько из пикселей `keys` (номера, как у whitePixels) теперь заметно темнее белого (зелёный < 200). */
export function darkenedAmong(page, scratch, keys) {
  return shot(page, scratch, undefined, `let n = 0; for (const i of ${JSON.stringify(keys)}) if (d[4 * i + 1] < 200) n++; return n;`);
}

/** `inner` внутри `outer`; `slack` px — на сглаживание краёв: на другой машине (процессор, библиотеки шрифтов) Chromium
той же версии сглаживает край буквы на пиксель шире. */
export function contains(outer, inner, slack = 1) {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack
    && inner.y + inner.h <= outer.y + outer.h + slack;
}

/** Кодовые точки, которые есть в cmap шрифта TrueType/OpenType (форматы 4 и 12). */
export function cmapCovers(buf, codepoints) {
  const n = buf.readUInt16BE(4);
  let cmap = null;
  for (let i = 0; i < n; i++) {
    const at = 12 + 16 * i;
    if (buf.toString('latin1', at, at + 4) === 'cmap') cmap = buf.readUInt32BE(at + 8);
  }
  if (cmap === null) return new Set();
  const have = new Set();
  const tables = buf.readUInt16BE(cmap + 2);
  for (let i = 0; i < tables; i++) {
    const sub = cmap + buf.readUInt32BE(cmap + 4 + 8 * i + 4);
    const format = buf.readUInt16BE(sub);
    if (format === 4) {
      const segs = buf.readUInt16BE(sub + 6) / 2;
      for (let s = 0; s < segs; s++) {
        const end = buf.readUInt16BE(sub + 14 + 2 * s);
        const start = buf.readUInt16BE(sub + 16 + 2 * segs + 2 * s);
        for (const cp of codepoints) if (cp >= start && cp <= end) have.add(cp);
      }
    } else if (format === 12) {
      const groups = buf.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const start = buf.readUInt32BE(sub + 16 + 12 * g);
        const end = buf.readUInt32BE(sub + 20 + 12 * g);
        for (const cp of codepoints) if (cp >= start && cp <= end) have.add(cp);
      }
    }
  }
  return have;
}
