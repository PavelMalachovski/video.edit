// Поддельный GitHub REST (и API рутины) для тестов страницы: релизы с ассетами и git — коммиты, деревья (плоский
// словарь путь → байты), ветки — в памяти.
//
//   import { startFake } from './fake-github.mjs';
//   const fake = await startFake();   // fake.url — http://127.0.0.1:<порт>
//   … REST под fake.url + '/api/repos/o/r/…', загрузки под '/up/…', рутина — '/v1/claude_code/routines/:id/fire'
//   await fake.close();
//
//   node tests/e2e/fake-github.mjs <port>   — то же отдельным процессом (e2e).
//
// Первый PUT куска source.part-00003 отвечает 502 (проверка повтора в загрузчике). Служебные адреса для e2e:
// POST /__commit {branch, files}, GET /__file?ref=&path=, GET /__fires, POST /__fail-fire {status},
// POST /__asset {tag, name, base64}, GET /__state, а также /__dump и /__joined (проверка загрузки).
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// 1×1 PNG — «логотип» в master
const LOGO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ROUTINE_HEADERS = { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'experimental-cc-routine-2026-04-01' };

/**
 * @typedef {{ sha: string, tree: string, parents: string[], message: string }} Commit
 * @typedef {{ id: string, text: string, job: string, step: string, attempt: number, head: string | null }} Fire
 * @typedef {{
 *   url: string, close(): Promise<void>,
 *   commit(branch: string, files: Record<string, string | Buffer | null>, message?: string): string,
 *   read(ref: string, path: string): string | null,
 *   history(ref: string): Commit[], parents(sha: string): string[],
 *   fires: Fire[], failNextFire(status: number): void,
 *   addAsset(tag: string, name: string, bytes: Buffer | Uint8Array | string): { id: number, name: string, size: number },
 *   onBeforePatch: ((branch: string) => void) | null,
 *   patches: { branch: string, sha: string, force?: boolean }[],
 * }} Fake
 */

/** @param {{ port?: number }} [options] @returns {Promise<Fake>} */
export async function startFake({ port = 0 } = {}) {
  const salt = crypto.randomBytes(8).toString('hex');
  let counter = 0;
  const newSha = () => crypto.createHash('sha1').update(`${salt}:${++counter}`).digest('hex');
  /** @type {Map<string, Commit>} */ const commits = new Map();
  /** @type {Map<string, Map<string, Buffer>>} */ const trees = new Map();
  /** @type {Map<string, string>} */ const refs = new Map();
  const releases = [];
  const blobs = new Map(); // id ассета → байты
  let nextId = 1;
  let failed3 = false;
  /** @type {number | null} */ let failFire = null;

  function makeTree(baseSha, entries) {
    const tree = new Map(baseSha ? trees.get(baseSha) : []);
    for (const [path, content] of entries) {
      if (content === null) tree.delete(path);
      else tree.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
    }
    const sha = newSha();
    trees.set(sha, tree);
    return sha;
  }

  function makeCommit(tree, parents, message) {
    const c = { sha: newSha(), tree, parents, message };
    commits.set(c.sha, c);
    return c;
  }

  const commitOf = (ref) => commits.get(refs.get(ref) ?? ref) ?? null;
  const treeOf = (ref) => {
    const c = commitOf(ref);
    return c ? trees.get(c.tree) : null;
  };
  const isAncestor = (older, newer) => {
    const seen = new Set();
    const todo = [newer];
    while (todo.length) {
      const sha = todo.pop();
      if (sha === older) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      todo.push(...(commits.get(sha)?.parents ?? []));
    }
    return false;
  };

  refs.set('master', makeCommit(makeTree(null, [['README.md', '# video.edit\n'], ['assets/logos/logo.png', LOGO]]), [], 'init').sha);

  /** @type {Fake} */
  const fake = {
    url: '',
    close: async () => {},
    commit(branch, files, message = 'fake commit') {
      const head = refs.get(branch) ?? refs.get('master');
      const c = makeCommit(makeTree(commits.get(head).tree, Object.entries(files)), [head], message);
      refs.set(branch, c.sha);
      return c.sha;
    },
    read(ref, path) {
      const b = treeOf(ref)?.get(path);
      return b ? b.toString('utf8') : null;
    },
    history(ref) {
      const out = [];
      for (let c = commitOf(ref); c; c = commits.get(c.parents[0]) ?? null) out.push(c);
      return out;
    },
    parents: (sha) => commits.get(sha)?.parents ?? [],
    fires: [],
    failNextFire(status) {
      failFire = status;
    },
    addAsset(tag, name, bytes) {
      let r = releases.find((x) => x.tag_name === tag);
      if (!r) {
        r = { id: nextId++, tag_name: tag, name: tag, draft: true, created_at: new Date().toISOString(), assets: [] };
        releases.push(r);
      }
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const a = { id: nextId++, name, size: body.length };
      r.assets.push(a);
      blobs.set(a.id, body);
      return a;
    },
    onBeforePatch: null,
    patches: [],
  };

  const send = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(obj === undefined ? '' : JSON.stringify(obj));
  };
  const notFound = (res) => send(res, 404, { message: 'Not Found' });
  const releaseJSON = (r) => ({ ...r, assets: r.assets.map((a) => ({ ...a })) });
  const fileJSON = (path, b) => ({
    type: 'file', name: path.split('/').pop(), path, size: b.length, encoding: 'base64', content: b.toString('base64'),
    sha: crypto.createHash('sha1').update(b).digest('hex'),
  });
  const listing = (tree, dir) => {
    const prefix = dir ? `${dir}/` : '';
    const seen = new Map();
    for (const [path, b] of tree) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split('/');
      if (!seen.has(name)) {
        seen.set(name, rest.length
          ? { type: 'dir', name, path: prefix + name, sha: crypto.createHash('sha1').update(prefix + name).digest('hex'), size: 0 }
          : { ...fileJSON(path, b), content: undefined, encoding: undefined });
      }
    }
    return [...seen.values()];
  };

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const json = () => JSON.parse(raw.toString() || '{}');
    const p = u.pathname;
    let m;

    // ---------- рутина ----------
    if (req.method === 'POST' && (m = p.match(/^\/v1\/claude_code\/routines\/([^/]+)\/fire$/))) {
      const bad = Object.entries(ROUTINE_HEADERS).find(([k, v]) => req.headers[k] !== v);
      if (!/^Bearer \S+$/.test(req.headers.authorization ?? '') || bad) {
        return send(res, 400, { error: { message: `fake routine: bad headers ${bad ? bad[0] : 'authorization'}` } });
      }
      if (failFire !== null) {
        const status = failFire;
        failFire = null;
        return send(res, status, { error: { message: 'fake routine failure' } });
      }
      const { text } = json();
      const { job, step, attempt } = JSON.parse(text);
      fake.fires.push({ id: m[1], text, job, step, attempt, head: refs.get(`claude/job-${job}`) ?? null });
      const n = fake.fires.length;
      return send(res, 200, { type: 'routine_fire', claude_code_session_id: `session_fake_${n}`, claude_code_session_url: `https://claude.ai/code/session_fake_${n}` });
    }

    // ---------- git ----------
    if (req.method === 'GET' && (m = p.match(/^\/api\/repos\/o\/r\/git\/ref\/heads\/(.+)$/))) {
      const sha = refs.get(m[1]);
      return sha ? send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } }) : notFound(res);
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/repos\/o\/r\/git\/matching-refs\/heads\/(.*)$/))) {
      return send(res, 200, [...refs].filter(([b]) => b.startsWith(m[1])).map(([b, sha]) => ({ ref: `refs/heads/${b}`, object: { sha, type: 'commit' } })));
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/repos\/o\/r\/git\/commits\/([0-9a-f]+)$/))) {
      const c = commits.get(m[1]);
      return c ? send(res, 200, { sha: c.sha, message: c.message, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : notFound(res);
    }
    if (req.method === 'POST' && p === '/api/repos/o/r/git/trees') {
      const b = json();
      if (b.base_tree && !trees.has(b.base_tree)) return send(res, 422, { message: 'base_tree not found' });
      const sha = makeTree(b.base_tree, (b.tree ?? []).map((e) => [e.path, e.sha === null ? null : String(e.content ?? '')]));
      return send(res, 201, { sha });
    }
    if (req.method === 'POST' && p === '/api/repos/o/r/git/commits') {
      const b = json();
      if (!trees.has(b.tree) || (b.parents ?? []).some((sha) => !commits.has(sha))) return send(res, 422, { message: 'bad tree or parent' });
      const c = makeCommit(b.tree, b.parents ?? [], b.message ?? '');
      return send(res, 201, { sha: c.sha, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) });
    }
    if (req.method === 'PATCH' && (m = p.match(/^\/api\/repos\/o\/r\/git\/refs\/heads\/(.+)$/))) {
      const b = json();
      fake.patches.push({ branch: m[1], sha: b.sha, force: b.force });
      if (fake.onBeforePatch) fake.onBeforePatch(m[1]);
      const current = refs.get(m[1]);
      if (!current) return send(res, 422, { message: 'Reference does not exist' });
      if (!commits.has(b.sha)) return send(res, 422, { message: 'Object does not exist' });
      if (!b.force && !isAncestor(current, b.sha)) return send(res, 422, { message: 'Update is not a fast forward' });
      refs.set(m[1], b.sha);
      return send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha: b.sha, type: 'commit' } });
    }
    if (req.method === 'POST' && p === '/api/repos/o/r/git/refs') {
      const b = json();
      const branch = String(b.ref ?? '').replace(/^refs\/heads\//, '');
      if (refs.has(branch)) return send(res, 422, { message: 'Reference already exists' });
      if (!commits.has(b.sha)) return send(res, 422, { message: 'Object does not exist' });
      refs.set(branch, b.sha);
      return send(res, 201, { ref: `refs/heads/${branch}`, object: { sha: b.sha, type: 'commit' } });
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/repos\/o\/r\/git\/refs\/heads\/(.+)$/))) {
      if (!refs.has(m[1])) return send(res, 422, { message: 'Reference does not exist' });
      refs.delete(m[1]);
      return send(res, 204);
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/repos\/o\/r\/contents\/?(.*)$/))) {
      const tree = treeOf(u.searchParams.get('ref') ?? 'master');
      if (!tree) return send(res, 404, { message: 'No commit found for the ref' });
      const path = decodeURIComponent(m[1]).replace(/\/$/, '');
      const file = tree.get(path);
      if (file) {
        if ((req.headers.accept ?? '').includes('application/vnd.github.raw')) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          return res.end(file);
        }
        return send(res, 200, fileJSON(path, file));
      }
      const entries = listing(tree, path);
      return entries.length ? send(res, 200, entries) : notFound(res);
    }

    // ---------- релизы ----------
    if (req.method === 'POST' && p === '/api/repos/o/r/releases') {
      const b = json();
      const r = { id: nextId++, tag_name: b.tag_name, name: b.name, draft: true, created_at: new Date().toISOString(), assets: [] };
      releases.push(r);
      return send(res, 201, releaseJSON(r));
    }
    if (req.method === 'GET' && p === '/api/repos/o/r/releases') {
      const page = Number(u.searchParams.get('page') || 1);
      return send(res, 200, page > 1 ? [] : releases.map(releaseJSON));
    }
    if ((m = p.match(/^\/api\/repos\/o\/r\/releases\/(\d+)$/))) {
      const i = releases.findIndex((x) => x.id === Number(m[1]));
      if (i < 0) return notFound(res);
      if (req.method === 'DELETE') {
        for (const a of releases[i].assets) blobs.delete(a.id);
        releases.splice(i, 1);
        return send(res, 204);
      }
      return send(res, 200, releaseJSON(releases[i]));
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/repos\/o\/r\/releases\/(\d+)\/assets$/))) {
      const r = releases.find((x) => x.id === Number(m[1]));
      if (!r) return notFound(res);
      const page = Number(u.searchParams.get('page') || 1);
      return send(res, 200, page > 1 ? [] : r.assets);
    }
    if ((m = p.match(/^\/api\/repos\/o\/r\/releases\/assets\/(\d+)$/))) {
      const id = Number(m[1]);
      const owner = releases.find((r) => r.assets.some((a) => a.id === id));
      if (req.method === 'DELETE') {
        if (owner) owner.assets = owner.assets.filter((a) => a.id !== id);
        blobs.delete(id);
        return send(res, 204);
      }
      if (!owner) return notFound(res);
      if ((req.headers.accept ?? '').includes('application/octet-stream')) {
        res.writeHead(302, { location: `${fake.url}/__blob/${id}` });
        return res.end();
      }
      return send(res, 200, owner.assets.find((a) => a.id === id));
    }
    if (req.method === 'GET' && (m = p.match(/^\/__blob\/(\d+)$/))) {
      const b = blobs.get(Number(m[1]));
      if (!b) return notFound(res);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(b);
    }
    if (req.method === 'POST' && (m = p.match(/^\/up\/repos\/o\/r\/releases\/(\d+)\/assets$/))) {
      const r = releases.find((x) => x.id === Number(m[1]));
      if (!r) return notFound(res);
      const name = u.searchParams.get('name');
      if (name === 'source.part-00003' && !failed3) {
        failed3 = true;
        return send(res, 502, { message: 'boom' });
      }
      if (r.assets.some((a) => a.name === name)) return send(res, 422, { errors: [{ code: 'already_exists' }] });
      const a = { id: nextId++, name, size: raw.length };
      r.assets.push(a);
      blobs.set(a.id, raw);
      return send(res, 201, a);
    }

    // ---------- служебное (e2e) ----------
    if (req.method === 'POST' && p === '/__commit') {
      const b = json();
      return send(res, 200, { sha: fake.commit(b.branch, b.files, b.message) });
    }
    if (req.method === 'GET' && p === '/__file') {
      const text = fake.read(u.searchParams.get('ref') ?? 'master', u.searchParams.get('path') ?? '');
      if (text === null) return notFound(res);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }
    if (req.method === 'GET' && p === '/__fires') return send(res, 200, fake.fires);
    if (req.method === 'POST' && p === '/__fail-fire') {
      fake.failNextFire(Number(json().status ?? 500));
      return send(res, 200, {});
    }
    if (req.method === 'POST' && p === '/__asset') {
      const b = json();
      return send(res, 200, fake.addAsset(b.tag, b.name, Buffer.from(b.base64 ?? '', 'base64')));
    }
    if (req.method === 'GET' && p === '/__state') {
      return send(res, 200, { branches: Object.fromEntries(refs), drafts: releases.map((r) => ({ id: r.id, tag: r.tag_name, assets: r.assets.map((a) => a.name) })) });
    }
    if (req.method === 'GET' && p === '/__dump') {
      return send(res, 200, releases.map((r) => {
        const data = Object.fromEntries(r.assets.map((a) => [a.name, blobs.get(a.id)]));
        const parts = Object.keys(data).filter((k) => k.startsWith('source.part-')).sort();
        return { tag: r.tag_name, assets: r.assets, sha: data['manifest.json'] ? JSON.parse(data['manifest.json'].toString()) : null,
          joined: Buffer.concat(parts.map((k) => data[k])).toString('base64').length };
      }));
    }
    if (req.method === 'GET' && p === '/__joined') {
      const r = releases[releases.length - 1];
      const parts = r.assets.filter((a) => a.name.startsWith('source.part-')).sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200);
      return res.end(Buffer.concat(parts.map((a) => blobs.get(a.id))));
    }
    return send(res, 404, { message: `fake: ${req.method} ${p}` });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { message: `fake: ${e instanceof Error ? e.message : String(e)}` }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  fake.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`;
  fake.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve(undefined));
  });
  return fake;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fake = await startFake({ port: Number(process.argv[2] || 4010) });
  console.log(`fake github on ${fake.url}`);
}
