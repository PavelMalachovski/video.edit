// Поддельный GitHub REST для локальной проверки загрузки: релизы и ассеты в памяти.
// node tests/e2e/fake-github.mjs <port>  — первый PUT куска №3 отвечает 502 (проверка повтора).
import http from 'node:http';
const port = Number(process.argv[2] || 4010);
const releases = []; let nextId = 1; let failed3 = false;
export const state = { releases };
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  let m;
  if (req.method === 'POST' && u.pathname === '/api/repos/o/r/releases') {
    const b = JSON.parse(body.toString()); const r = { id: nextId++, tag_name: b.tag_name, name: b.name, draft: true, created_at: new Date().toISOString(), assets: [], data: {} };
    releases.push(r); return send(res, 201, { ...r, data: undefined });
  }
  if (req.method === 'GET' && u.pathname === '/api/repos/o/r/releases') {
    const page = Number(u.searchParams.get('page') || 1); return send(res, 200, page > 1 ? [] : releases.map((r) => ({ ...r, data: undefined })));
  }
  if (req.method === 'GET' && (m = u.pathname.match(/^\/api\/repos\/o\/r\/releases\/(\d+)\/assets$/))) {
    const r = releases.find((x) => x.id === Number(m[1])); const page = Number(u.searchParams.get('page') || 1);
    return send(res, 200, page > 1 ? [] : r.assets);
  }
  if (req.method === 'DELETE' && (m = u.pathname.match(/^\/api\/repos\/o\/r\/releases\/assets\/(\d+)$/))) {
    for (const r of releases) { const i = r.assets.findIndex((a) => a.id === Number(m[1])); if (i >= 0) { delete r.data[r.assets[i].name]; r.assets.splice(i, 1); } }
    return send(res, 204);
  }
  if (req.method === 'POST' && (m = u.pathname.match(/^\/up\/repos\/o\/r\/releases\/(\d+)\/assets$/))) {
    const r = releases.find((x) => x.id === Number(m[1])); const name = u.searchParams.get('name');
    if (name === 'source.part-00003' && !failed3) { failed3 = true; return send(res, 502, { message: 'boom' }); }
    if (r.assets.some((a) => a.name === name)) return send(res, 422, { errors: [{ code: 'already_exists' }] });
    const a = { id: nextId++, name, size: body.length }; r.assets.push(a); r.data[name] = body; return send(res, 201, a);
  }
  if (req.method === 'GET' && u.pathname === '/__dump') {
    return send(res, 200, releases.map((r) => ({ tag: r.tag_name, assets: r.assets, sha: r.data['manifest.json'] ? JSON.parse(r.data['manifest.json']) : null,
      joined: Buffer.concat(Object.keys(r.data).filter((k) => k.startsWith('source.part-')).sort().map((k) => r.data[k])).toString('base64').length })));
  }
  if (req.method === 'GET' && u.pathname === '/__joined') {
    const r = releases[releases.length - 1];
    res.writeHead(200); return res.end(Buffer.concat(Object.keys(r.data).filter((k) => k.startsWith('source.part-')).sort().map((k) => r.data[k])));
  }
  send(res, 404, { message: `fake: ${req.method} ${u.pathname}` });
}).listen(port, '127.0.0.1', () => console.log(`fake github on ${port}`));
