// Маленький статический сервер для шаблона: Chromium не грузит fonts.json и шрифты через file://.
// Отдаёт файлы из корней по порядку (первый найденный), только GET/HEAD, наружу из корней не выпускает.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

async function find(roots, urlPath) {
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  for (const root of roots) {
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) continue;
    try {
      const st = await stat(file);
      if (st.isFile()) return { file, size: st.size };
    } catch {
      // нет в этом корне — ищем в следующем
    }
  }
  return null;
}

/** Поднимает сервер на 127.0.0.1 (порт 0 — любой свободный). → `{url, close()}`. */
export async function serve(roots, port = 0) {
  const dirs = (Array.isArray(roots) ? roots : [roots]).map((r) => path.resolve(r));
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let found = null;
    try {
      found = await find(dirs, req.url);
    } catch {
      found = null;
    }
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const type = TYPES[path.extname(found.file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': found.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(found.file).on('error', () => res.destroy()).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const { port: actual } = server.address();
  return {
    url: `http://127.0.0.1:${actual}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
