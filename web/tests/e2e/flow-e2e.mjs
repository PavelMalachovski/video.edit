// Сквозная проверка страницы по сегментам: вход → загрузка (с продолжением после перезагрузки) → список → ….
// Нужны запущенные next start (порт 3000) и fake-github.mjs (порт 4010) — их поднимает run.sh.
// Каждый сегмент печатает `ok <имя>`; первый сбой — `FAIL <имя>` и код 1.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { stateAt } from '../../lib/overlay.ts';
import { finalStyle } from '../../lib/style.ts';
import { draftTracks, parseDraft } from '../../lib/tracks.ts';

const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
// браузер прогона: chromium (как рендер движка) или webkit — Safari, как у Павла на iPhone (E2E_BROWSER)
const BROWSER = process.env.E2E_BROWSER || 'chromium';
const WEBKIT = BROWSER === 'webkit';

const APP = 'http://127.0.0.1:3000';
const FAKE = 'http://127.0.0.1:4010';
// 1×1 PNG — вставка к ролику
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// ---------- помощники ----------

function check(ok, message) {
  if (!ok) throw new Error(message);
}

async function fakeJson(p, init) {
  const r = await fetch(`${FAKE}${p}`, init);
  check(r.ok, `fake ${p}: ${r.status} ${await r.clone().text()}`);
  return r.json();
}

/** Запуски рутины, как их увидел поддельный API. */
const fires = () => fakeJson('/__fires');
/** Ветки и черновики поддельного GitHub. */
const state = () => fakeJson('/__state');

/** Файл задачи в её ветке (путь от папки задачи); нет — null. */
async function branchFile(ctx, rel) {
  const r = await fetch(`${FAKE}/__file?ref=${encodeURIComponent(`claude/job-${ctx.jobId}`)}&path=${encodeURIComponent(`jobs/${ctx.jobId}/${rel}`)}`);
  return r.status === 404 ? null : r.text();
}

/** Коммит от имени сессии в claude/job-<id>: пути от папки задачи, объект → JSON, Buffer → байты. */
async function session(ctx, files) {
  const out = {};
  for (const [rel, value] of Object.entries(files)) {
    out[`jobs/${ctx.jobId}/${rel}`] = Buffer.isBuffer(value) ? { base64: value.toString('base64') }
      : typeof value === 'string' || value === null ? value : `${JSON.stringify(value, null, 2)}\n`;
  }
  return fakeJson('/__commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: `claude/job-${ctx.jobId}`, files: out, message: 'session' }) });
}

/** Ждать, пока `fn` не вернёт истину (или не истечёт `ms`). `what` — что ждали; функция — с тем, что было на деле. */
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${typeof what === 'function' ? await what() : what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** WAV: синус `hz` Гц, `seconds` с, моно 16 бит — музыка для прослушивания в редакторе (без ffmpeg). */
function wav(seconds, hz, rate = 8000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2);
  return b;
}

/** Файл задачи проходит схему движка (vm.job.validate) — страница и сессия говорят на одном языке. */
function engineValidate(name, data) {
  execFileSync('python3', ['-c', 'import json, sys\nfrom vm.job import validate\nvalidate(sys.argv[1], json.load(sys.stdin))', name], {
    input: JSON.stringify(data), env: { ...process.env, PYTHONPATH: path.resolve('../engine') }, stdio: ['pipe', 'inherit', 'inherit'],
  });
}

const QUESTIONS = { questions: [
  { id: 'cut', type: 'choice', title: 'Паузы и оговорки', body: 'Нашёл 14 пауз и 2 повтора — будет около 1:16.',
    options: [{ id: 'all', label: 'Вырезать всё' }, { id: 'edges', label: 'Только края' }], default: 'all' },
  { id: 'hook', type: 'choice', title: 'Хук на первые 2–3 секунды', body: 'Последнее слово станет рукописным.',
    options: [{ id: 'h1', label: '«Как я учу чешский»' }, { id: 'own', label: 'Свой' }, { id: 'none', label: 'Без заголовка' }], default: 'h1' },
  { id: 'brand', type: 'word', title: 'Проверь слово', body: 'На 0:34 слышу «Копленький». Это…',
    options: [{ id: 'coplanly', label: 'CoPlanly' }, { id: 'copilot', label: 'Copilot' }, { id: 'own', label: 'Напишу сам' }] },
  { id: 'logo', type: 'insert', title: 'Вставка', body: 'На 0:12 ты говоришь «добавь сюда логотип». Что поставить?', image: 'q-logo.png',
    options: [{ id: 'logo-a', label: 'Логотип', image: '../../assets/logos/logo.png' }, { id: 'upload', label: 'Загрузить свою' }, { id: 'none', label: 'Не надо' }] },
  { id: 'stars', type: 'multi', title: 'Звёздочки в субтитрах', body: 'Нашёл: р*бли, беспл*тно, подп*ска.',
    options: [{ id: 'r', label: 'р*бли' }, { id: 'b', label: 'беспл*тно' }, { id: 'p', label: 'подп*ска' }], default: ['r', 'b', 'p'] },
  { id: 'stickers', type: 'multi', title: 'Стикеры-тезисы', body: 'Поставлю на ключевые мысли — сними лишние.',
    options: [{ id: 's1', label: '0:12 — «3 ошибки 🔥»' }], default: ['s1'] },
  { id: 'end', type: 'choice', title: 'Финальная карточка', body: 'Последние 2 секунды: призыв, твой ник и логотип.',
    options: [{ id: 'e1', label: '«Подпишись, чтобы не пропустить 👇»' }, { id: 'own', label: 'Свой' }, { id: 'none', label: 'Не надо' }], default: 'e1' },
  { id: 'teaser', type: 'choice', title: 'Начать с самой сильной фразы?', body: '«Учу по 15 минут в день» звучит на 0:21.',
    options: [{ id: 'yes', label: 'Да: «Учу по 15 минут в день»' }, { id: 'no', label: 'Нет' }], default: 'yes' },
  { id: 'dim', type: 'choice', title: 'Затемнить фон?', layout: 'frames', default: '30',
    options: [{ id: 'none', label: 'Как есть', image: 'q-dim-none.jpg' }, { id: '30', label: 'Темнее на 30 %', image: 'q-dim-30.jpg' },
      { id: '50', label: 'Темнее на 50 %', image: 'q-dim-50.jpg' }] },
] };
const REVIEW = { items: [
  { id: 'hook', title: 'Мысль в первые 2 с', status: 'warn', note: 'Мысль звучит на 0:21 — предлагаю начать с неё (вопрос «тизер»)' },
  { id: 'face', title: 'Лицо в первые секунды', status: 'ok', note: 'Лицо крупно с первого кадра' },
  { id: 'value', title: 'Польза в середине', status: 'ok', note: 'Три шага, каждый с примером' },
  { id: 'cta', title: 'Призыв в конце', status: 'ok', note: 'Кодовое слово в конце — титр и финальная карточка' },
  { id: 'length', title: 'Длина', status: 'ok', note: '1:16 после резки — до 90 с' },
] };
const SCRIPT = {
  story: 'tutorial',
  hooks: [
    { technique: 'value', text: '3 ошибки, из-за которых чешский не идёт', frame: 'Крупно, смотрю в камеру' },
    { technique: 'engage', text: 'Какой вы ученик: зубрила или болтун?' },
    { technique: 'emotion', text: 'POV: полгода учишь чешский и молчишь в магазине' },
  ],
  scenes: [
    { part: 'hook', t0: 0, t1: 2.5, say: 'Три ошибки, из-за которых чешский не идёт', screen: '3 ошибки 🔥', frame: 'Крупно, лицо' },
    { part: 'hold', t0: 2.5, t1: 20, say: 'Первая — учить слова списком', screen: 'Слова — списком', frame: 'Средний план, тетрадь в руке' },
    { part: 'hold', t0: 20, t1: 40, say: 'Вторая — молчать', screen: '', frame: 'Переход взмахом руки' },
    { part: 'hold', t0: 40, t1: 52, say: 'Третья — учить без повторов', screen: 'Без повторов', frame: 'Крупно' },
    { part: 'reward', t0: 52, t1: 60, say: 'Пиши «план» — пришлю', screen: 'Пиши «план»', frame: 'Крупно', sound: 'Музыка громче' },
  ],
  cta: 'Пиши «план» в комментариях',
  tips: ['Лицо в кадре с первой секунды', 'Снимай у окна: свет спереди'],
  caption: { text: 'Три ошибки в чешском 🇨🇿', hashtags: ['чешский', 'языки'] },
};
const FIXTURE = JSON.parse(fs.readFileSync(path.resolve('../engine/tests/fixtures/style-merge.json'), 'utf8'));
const STYLES = { ...FIXTURE.styles, sample: { ...FIXTURE.styles.sample, inserts: [{ kind: 'image', x: 70, y: 500, w: 250, question: 'logo' }] },
  cover: { frames: [{ t: 1.2, image: 'cover-1.jpg' }, { t: 7.5, image: 'cover-2.jpg' }, { t: 21, image: 'cover-3.jpg' }], text: 'Как я учу чешский' } };

/** Снимок экрана в папку E2E_SHOTS (если задана) — посмотреть вёрстку глазами. */
/** Экран снят: на телефоне страница не шире экрана (вбок не листается) и, если просили, скриншот. */
/** Редактор: линейка (заново на каждом шаге: дорожки меняют высоту — пропала строка «Звуки», таймлайн ниже — и она
 *  съезжает), состояние слоя кадра и «встать на момент ролика». `full` — длина ролика с хвостом. */
function editorKit(page, full) {
  const geo = async () => {
    const r = await page.locator('.ed-ruler').boundingBox();
    return { r, pps: r.width / full, X: (t) => r.x + (t * r.width) / full };
  };
  const layerState = async () => JSON.parse((await page.locator('.ed-layer iframe').getAttribute('data-state')) ?? '{}');
  /** Встать на момент ролика `t` (щелчок по линейке) и дождаться события слоя, в котором он лежит. */
  const seekTo = async (t) => {
    const { r, X } = await geo();
    await page.mouse.click(X(t), r.y + r.height / 2);
    await until(async () => {
      const t0 = Number(await page.locator('.ed-layer').getAttribute('data-t0'));
      return Number.isFinite(t0) && t0 <= t + 0.02;
    }, 3000, `слой на ${t} с`);
  };
  return { geo, layerState, seekTo };
}

async function shot(page, name) {
  const { inner, scroll } = await page.evaluate(() => ({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth }));
  if (inner <= 430) check(scroll <= inner + 1, `экран «${name}» шире телефона: ${scroll} px при ${inner} px`);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}.png`), fullPage: true });
}

// ---------- сегменты ----------

/** Видео как с телефона: настоящий MOV (картинка и звук, заголовок в начале) длиной `seconds`, дополненный до `bytes`
 *  пустым боксом `free` — браузер читает длительность (WebKit на Linux застревал на случайных байтах вместо видео), а
 *  кусков загрузки — сколько нужно. Без ffmpeg — случайные байты. */
function sampleVideo(file, seconds, bytes) {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=540x960:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', '-f', 'mov', file]);
  } catch {
    fs.writeFileSync(file, crypto.randomBytes(bytes));
    return;
  }
  const pad = bytes - fs.statSync(file).size;
  if (pad <= 8) return;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(pad);
  head.write('free', 4, 'ascii');
  fs.appendFileSync(file, Buffer.concat([head, crypto.randomBytes(pad - 8)]));
}

const segments = [
  ['login', async ({ page }) => {
    await page.goto(`${APP}/`);
    check(page.url().endsWith('/login'), `нет перехода на вход: ${page.url()}`);
    await page.fill('#password', 'wrong');
    await page.click('button[type=submit]');
    check((await page.textContent('body')).includes('Неверный пароль'), 'неверный пароль принят');
    await page.fill('#password', 'pw');
    await page.click('button[type=submit]');
    await page.waitForURL(`${APP}/`);
  }],

  ['brand', async ({ page, tmp }) => {
    await page.getByRole('link', { name: 'Мой бренд' }).click();
    await page.waitForURL(`${APP}/brand`);
    await page.locator('#handle').waitFor();
    await page.fill('#handle', 'pavel.malakhouski');
    const logo = path.join(tmp, 'brand-logo.png');
    fs.writeFileSync(logo, PNG);
    await page.setInputFiles('input[type=file]', logo);
    await page.getByRole('img', { name: 'Логотип' }).waitFor();
    await page.getByRole('button', { name: 'Розовый' }).first().click();
    await page.getByRole('button', { name: 'Rubik', exact: true }).click();
    await page.fill('#signature', 'Пишите в директ — отвечу лично');
    await page.fill('#hashtags', '#монтаж reels');
    await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.layoutBoxes?.().hook);
    await shot(page, 'brand');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.getByText('Сохранено').waitFor();
    const r = await fetch(`${FAKE}/__file?ref=claude/brand&path=brand/brand.json`);
    check(r.ok, `brand.json: ${r.status}`);
    const brand = await r.json();
    check(brand.handle === '@pavel.malakhouski' && brand.colors?.accent === '#FF5C8A' && brand.font === 'rubik' && brand.logo === 'logo.png'
      && isDeepStrictEqual(brand.hashtags, ['монтаж', 'reels']) && brand.signature === 'Пишите в директ — отвечу лично', `brand.json: ${JSON.stringify(brand)}`);
    await page.reload();
    check(await page.inputValue('#handle') === '@pavel.malakhouski', 'бренд не прочитался после перезагрузки');
    await page.getByRole('img', { name: 'Логотип' }).waitFor();
    await page.getByRole('link', { name: 'Мои видео' }).click();
    await page.waitForURL(`${APP}/`);
  }],

  ['upload', async (ctx) => {
    const { page, tmp } = ctx;
    const source = path.join(tmp, 'clip.mov');
    sampleVideo(source, 2, 30 * 1024 * 1024);
    const second = path.join(tmp, 'clip2.mov'); // второе видео задачи (фаза 4б): склеится за первым
    sampleVideo(second, 1, 3 * 1024 * 1024);
    const insert = path.join(tmp, 'logo.png');
    fs.writeFileSync(insert, PNG);
    // озвучка: своя запись голоса, два куска; буфером — путь с кириллицей Playwright молча не ставит в поле
    const voice = { name: 'Запись.m4a', mimeType: 'audio/x-m4a', buffer: crypto.randomBytes(5 * 1024 * 1024) };

    await page.setInputFiles('#source', [source, second]);
    await page.getByText('2. clip2.mov').waitFor();
    // порядок меняется: второе — выше, и обратно
    await page.getByRole('button', { name: 'clip2.mov — раньше' }).click();
    await page.getByText('1. clip2.mov').waitFor();
    await page.getByRole('button', { name: 'clip.mov — раньше' }).click();
    await page.getByText('1. clip.mov').waitFor();
    await page.fill('#brief', 'ХУК: Как я учу чешский');
    await page.setInputFiles('#inserts', insert);
    await page.getByText('logo.png').waitFor();
    await page.setInputFiles('#voice', voice);
    await page.getByText('Запись.m4a').waitFor();
    await shot(page, 'upload-form');
    await page.getByRole('button', { name: 'Загрузить', exact: true }).click();
    await page.getByText('Загружаю в GitHub…').waitFor();
    await shot(page, 'upload-progress');

    // ≥ 2 кусков в черновике — перезагрузить посреди загрузки и продолжить. В Safari (WebKit на Linux) с двумя видео,
    // вставкой и озвучкой после этого зависал следующий переход (причина не найдена: по отдельности всё проходит) —
    // там загрузка здесь идёт до конца, а продолжение после перезагрузки проверяет отдельный шаг resume в конце
    if (!WEBKIT) {
      await until(async () => ((await state()).drafts[0]?.assets.length ?? 0) >= 2, 60_000, 'два куска в черновике');
      await page.reload();
      await page.getByText('Загрузка clip.mov + 1 не закончена: выберите те же видео').waitFor();
      check(await page.inputValue('#brief') === 'ХУК: Как я учу чешский', 'ТЗ не восстановилось после перезагрузки');
      await page.setInputFiles('#source', [second, source]); // те же видео в другом порядке — загрузка та же
      await page.setInputFiles('#inserts', insert);
      await page.setInputFiles('#voice', voice);
      await page.getByRole('button', { name: 'Продолжить загрузку' }).waitFor();
      await shot(page, 'upload-resume');
      await page.getByRole('button', { name: 'Продолжить загрузку' }).click();
    }

    await page.waitForURL(/\/jobs\/\d{6}-\d{6}-[0-9a-z]{4}$/, { timeout: 120_000 });
    ctx.jobId = page.url().split('/').pop();
    const joined = Buffer.from(await (await fetch(`${FAKE}/__joined`)).arrayBuffer());
    check(sha256(joined) === sha256(fs.readFileSync(source)), 'склеенный исходник не совпал байт в байт');
    const joined2 = Buffer.from(await (await fetch(`${FAKE}/__joined?file=source-2`)).arrayBuffer());
    check(sha256(joined2) === sha256(fs.readFileSync(second)), 'второе видео не совпало байт в байт');
    const [draft] = await fakeJson('/__dump');
    const manifest = draft.sha;
    check(manifest?.brief === 'ХУК: Как я учу чешский', `ТЗ в manifest.json: ${manifest?.brief}`);
    check(isDeepStrictEqual(manifest?.videos?.map((v) => [v.asset, v.name, v.size]), [['source', 'clip.mov', 30 * 1024 * 1024], ['source-2', 'clip2.mov', 3 * 1024 * 1024]])
      && manifest.name === 'clip.mov' && manifest.size === 30 * 1024 * 1024, `видео в manifest.json: ${JSON.stringify(manifest?.videos)}`);
    check(manifest?.uploads?.[0]?.asset === 'upload-i1.png', `вставка в manifest.json: ${JSON.stringify(manifest?.uploads)}`);
    check(manifest?.uploads?.[1]?.asset === 'upload-voice.m4a' && manifest.uploads[1].size === 5 * 1024 * 1024,
      `озвучка в manifest.json: ${JSON.stringify(manifest?.uploads)}`);
    const f = await fires();
    check(f.length === 1 && f[0].step === 'analyze' && f[0].attempt === 1 && f[0].job === ctx.jobId, `запуски: ${JSON.stringify(f)}`);
    const left = await page.evaluate(() => localStorage.getItem('vm:pending'));
    check(left === null, 'vm:pending не удалён');
    // задача взяла копию бренда: job.json.brand и логотип в своей папке
    const job = JSON.parse((await branchFile(ctx, 'job.json')) ?? '{}');
    check(job.brand?.handle === '@pavel.malakhouski' && job.brand?.logo === 'in/brand/logo.png', `job.json.brand: ${JSON.stringify(job.brand)}`);
    check(job.uploads?.some((u) => u.file === 'in/uploads/upload-voice.m4a' && u.kind === 'audio'), `озвучка в job.json: ${JSON.stringify(job.uploads)}`);
    check(isDeepStrictEqual(job.videos?.map((v) => v.file), ['in/source.mov', 'in/source-2.mov']), `видео в job.json: ${JSON.stringify(job.videos)}`);
    check((await branchFile(ctx, 'in/brand/logo.png')) !== null, 'логотип бренда не скопирован в задачу');
  }],

  ['list', async (ctx) => {
    const { page } = ctx;
    if (WEBKIT) { // переход со страницы задачи на список в WebKit застревал — по шагам, с временем
      const t = Date.now();
      console.log(`  страница задачи отвечает: ${await within(page.evaluate(() => document.readyState), 10_000)} за ${Date.now() - t} мс`);
      await page.goto(`${APP}/`, { waitUntil: 'commit' });
      console.log(`  переход начался (commit) за ${Date.now() - t} мс`);
    }
    await page.goto(`${APP}/`);
    const row = page.locator(`[data-job="${ctx.jobId}"]`);
    await row.getByText('Запускаю сессию…').waitFor();
    check((await row.textContent()).includes('clip.mov + 1'), `в списке — первое видео и сколько ещё: ${await row.textContent()}`);

    const created = await page.request.post(`${APP}/api/jobs`, { data: { name: 'brosheno.mov', size: 1000, type: 'video/quicktime' } });
    check(created.ok(), `брошенная задача: ${created.status()}`);
    const { jobId: abandoned } = await created.json();
    await page.reload();
    const gone = page.locator(`[data-job="${abandoned}"]`);
    await gone.getByText('Загрузка не закончена').waitFor();
    await shot(page, 'list');
    page.once('dialog', (d) => void d.accept());
    await gone.getByRole('button', { name: /Удалить/ }).click();
    await gone.waitFor({ state: 'detached' });
    const s = await state();
    check(!s.drafts.some((d) => d.tag === `job-${abandoned}`), 'черновик брошенной задачи не удалён');
    check(s.drafts.some((d) => d.tag === `job-${ctx.jobId}`), 'удалился не тот черновик');
  }],

  ['phases', async (ctx) => {
    const { page } = ctx;
    const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
    await page.goto(`${APP}/jobs/${ctx.jobId}`);
    await session(ctx, { 'status.json': { state: 'analyzing', phase: 'Расшифровываю', message: 'Слушаю речь', at: iso() } });
    await page.getByText('Расшифровываю').waitFor({ timeout: 7000 });
    await shot(page, 'phases-working');

    await session(ctx, { 'status.json': { state: 'analyzing', phase: 'Смотрю кадры', message: 'Ищу лицо', at: iso(30 * 60_000) } });
    await page.getByText('Похоже, Claude застрял').waitFor({ timeout: 7000 });
    await shot(page, 'phases-stuck');
    await page.getByRole('button', { name: 'Перезапустить шаг' }).click();
    await until(async () => (await fires()).some((f) => f.step === 'analyze' && f.attempt === 2), 10_000, 'перезапуск шага');
    const queued = JSON.parse((await branchFile(ctx, 'status.json')) ?? '{}');
    check(queued.state === 'queued', `статус после перезапуска: ${queued.state}`);

    await session(ctx, { 'status.json': { state: 'error', phase: 'Ошибка', message: 'Не удалось расшифровать', at: iso(), error: 'GigaAM: нет памяти' } });
    await page.getByText('Не удалось расшифровать').waitFor({ timeout: 7000 });
    await shot(page, 'phases-error');
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await until(async () => (await fires()).some((f) => f.step === 'analyze' && f.attempt === 3), 10_000, 'повтор шага');
  }],

  ['questions', async (ctx) => {
    const { page, tmp } = ctx;
    engineValidate('questions.json', QUESTIONS);
    engineValidate('styles.json', STYLES);
    engineValidate('review.json', REVIEW);
    const waiting = { state: 'waiting_answers', phase: 'Ждёт ответов', message: 'Ответь на вопросы и выбери стиль', at: new Date().toISOString(), needs: 'answers' };
    engineValidate('status.json', waiting);
    await session(ctx, { 'questions.json': QUESTIONS, 'styles.json': STYLES, 'review.json': REVIEW, 'frame.png': PNG, 'q-logo.png': PNG, 'cover-1.jpg': PNG, 'cover-2.jpg': PNG, 'cover-3.jpg': PNG,
      'q-dim-none.jpg': PNG, 'q-dim-30.jpg': PNG, 'q-dim-50.jpg': PNG, 'status.json': waiting });
    const cards = page.locator('[data-question]');
    await until(async () => (await cards.count()) === 9, 10_000, 'девять карточек вопросов');
    // «Фон»: варианты — кадры видео крупно (9:16), а не значки в кнопке — иначе разницу не увидеть
    const frames = page.locator('[data-question="dim"] .frame-pick');
    check(await frames.count() === 3, 'у вопроса «Фон» три кадра-варианта');
    const tile = await frames.first().locator('img').boundingBox();
    check(tile && tile.width >= 90 && Math.abs(tile.height / tile.width - 16 / 9) < 0.05, `кадр варианта крупный и 9:16: ${JSON.stringify(tile)}`);
    check(await frames.nth(1).getAttribute('aria-pressed') === 'true', 'по умолчанию — темнее на 30 %');
    await frames.nth(2).click();
    check(await frames.nth(2).getAttribute('aria-pressed') === 'true' && await frames.nth(1).getAttribute('aria-pressed') === 'false', 'выбор кадра');
    const go = page.getByRole('button', { name: 'Показать превью' });
    check(await go.isDisabled(), '«Показать превью» включена, хотя brand и logo без ответа');
    // разбор по гайду — над вопросами: что хорошо и что поправить
    const review = page.locator('[data-review]');
    check(await review.count() === 1, 'нет карточки «Разбор по гайду»');
    const reviewText = await review.textContent();
    check(reviewText.includes('Разбор по гайду') && reviewText.includes('Мысль звучит на 0:21'), `разбор: ${reviewText}`);
    check(await review.locator('li[data-status=warn]').count() === 1 && await review.locator('li[data-status=ok]').count() === 4, 'пункты ok и warn');
    await shot(page, 'questions');

    const card = (id) => page.locator(`[data-question="${id}"]`);
    await card('hook').getByLabel('Или напиши свой').fill('Как я снимаю reels');
    const mine = path.join(tmp, 'mine.png');
    fs.writeFileSync(mine, PNG);
    await card('logo').locator('input[type=file]').setInputFiles(mine);
    await card('logo').getByText('mine.png').waitFor();
    await until(async () => (await card('logo').getByText('Загружено').count()) > 0, 30_000, 'картинка к ответу загрузилась');
    await card('stars').getByRole('button', { name: 'беспл*тно' }).click();
    await card('brand').getByRole('button', { name: 'Copilot' }).click();
    check(!(await go.isDisabled()), '«Показать превью» выключена после всех ответов');

    await page.reload();
    await until(async () => (await cards.count()) === 9, 10_000, 'карточки после перезагрузки');
    check(await card('hook').getByLabel('Или напиши свой').inputValue() === 'Как я снимаю reels', 'свой хук пропал');
    check(await card('stars').getByRole('button', { name: 'беспл*тно' }).getAttribute('aria-pressed') === 'false', 'снятая звёздочка вернулась');
    check(await card('brand').getByRole('button', { name: 'Copilot' }).getAttribute('aria-pressed') === 'true', 'выбор написания пропал');
    check(await card('logo').getByText('Загружено').count() > 0, 'загруженная картинка пропала');
    await shot(page, 'questions-answered');

    // редактор (бета) на вопросах: черновика ещё нет — кадр-образец; стиль в его панели общий с «Превью»
    await page.getByRole('link', { name: /Открыть в редакторе/ }).click();
    await page.waitForURL(/\/editor$/);
    const panel = page.locator('.ed-style');
    await panel.waitFor({ timeout: 10_000 });
    check(await panel.getByRole('button', { name: /^A / }).getAttribute('aria-pressed') === 'true', 'в редакторе — вариант A, как на «Превью»');
    await panel.getByRole('group', { name: 'Подсветка слова' }).getByRole('button', { name: 'Мятный' }).click();
    await until(async () => JSON.parse((await page.locator('.ed-layer iframe').getAttribute('data-spec')) ?? '{}').colors?.accent === '#7CF2B0', 5000,
      'подсветка — на кадре-образце редактора');
    await shot(page, 'editor-sample');
    await page.getByRole('link', { name: 'К задаче' }).click();
    await until(async () => (await cards.count()) === 9, 10_000, 'вопросы после редактора');
    await page.getByRole('button', { name: 'Показать превью' }).click();
    await page.getByText('Выбери стиль').waitFor();
  }],

  ['previews', async (ctx) => {
    const { page } = ctx;
    // редактор: над вкладками — крупное превью, на вкладке «Стиль» — три миниатюры; обложка — на своей вкладке
    await until(async () => (await page.locator('iframe[data-spec]').count()) === 4, 10_000, 'три миниатюры и крупное превью');
    const tab = (name) => page.getByRole('tab', { name, exact: true });
    check(await tab('Стиль').getAttribute('aria-selected') === 'true', 'первая вкладка — не «Стиль»');
    const big = page.locator('iframe[data-big]');
    const bigSpec = async () => JSON.parse(await big.getAttribute('data-spec'));
    await until(async () => (await bigSpec()).colors.accent === '#7CF2B0', 5000, 'подсветка, выбранная в редакторе, — на «Превью»');
    await page.getByRole('button', { name: /^B · / }).click();
    await tab('Шрифт').click();
    await page.getByRole('button', { name: 'Rubik', exact: true }).click();
    await page.getByRole('button', { name: 'Marck Script', exact: true }).click();
    await tab('Шрифт').focus();
    await page.keyboard.press('ArrowRight'); // стрелки ходят по вкладкам
    check(await tab('Цвет').getAttribute('aria-selected') === 'true', 'стрелка вправо не открыла «Цвет»');
    await page.getByLabel('Своя подсветка').fill('#00aaff');
    // превью на виду: прокрутили к низу — сцена с крупным превью осталась вверху экрана
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await until(async () => {
      const b = await big.boundingBox();
      return b !== null && b.y >= 0 && b.y + b.height <= 844 && await page.evaluate(() => window.scrollY > 0);
    }, 3000, 'крупное превью на экране после прокрутки вниз');
    await page.evaluate(() => window.scrollTo(0, 0));
    // низкий экран (375×667): превью уже 270 px, а сцена и вкладки — на одном экране
    await page.setViewportSize({ width: 375, height: 667 });
    await until(async () => {
      const b = await big.boundingBox();
      const t = await tab('Стиль').boundingBox();
      return b !== null && t !== null && b.width < 270 && b.y >= 0 && t.y + t.height <= 667;
    }, 3000, 'на экране 667 px превью уже, вкладки видны');
    await shot(page, 'previews-short');
    // ручки считают px кадра по ширине превью: субтитры на 30 px экрана вверх, уголок — вправо на десятую ширины (×1,2)
    const narrow = await big.boundingBox();
    const before0 = (await bigSpec()).subtitles;
    const subHandle = page.getByRole('slider', { name: 'Высота субтитров' });
    const sh = await subHandle.boundingBox();
    await page.mouse.move(sh.x + sh.width / 2, sh.y + sh.height / 2);
    await page.mouse.down();
    await page.mouse.move(sh.x + sh.width / 2, sh.y + sh.height / 2 - 30, { steps: 4 });
    await page.mouse.up();
    const movedY = Math.round((before0.y - (30 * 1080) / narrow.width) / 10) * 10;
    await until(async () => (await bigSpec()).subtitles.y === movedY, 5000, `субтитры на узком превью: ${movedY}`);
    const sg = await subHandle.locator('[data-grip]').boundingBox();
    await page.mouse.move(sg.x + sg.width / 2, sg.y + sg.height / 2);
    await page.mouse.down();
    await page.mouse.move(sg.x + sg.width / 2 + narrow.width / 10, sg.y + sg.height / 2, { steps: 5 });
    await page.mouse.up();
    const grownNarrow = Math.round((before0.size * 1.2) / 2) * 2;
    await until(async () => (await bigSpec()).subtitles.size === grownNarrow, 5000, `субтитры крупнее на узком превью: ${grownNarrow}`);
    await tab('Место').click();
    await page.getByRole('button', { name: 'Субтитры: как в варианте' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await until(async () => (await big.boundingBox())?.width === 270, 3000, 'на экране 844 px превью снова 270 px');
    const b = STYLES.variants[1].spec;
    const want = finalStyle(STYLES, { variant: 'B', font: 'rubik', hand: 'marck-script', colors: { text: b.colors.text, accent: '#00AAFF', bar: b.colors.bar } });
    await until(async () => isDeepStrictEqual(await bigSpec(), want), 5000, `spec крупного превью = finalStyle ${JSON.stringify(want)}`);

    // то же состояние в отдельной вкладке шаблона даёт те же рамки: превью рисует то же, что финал
    const bigFrame = await (await big.elementHandle()).contentFrame();
    const drawn = { state: JSON.parse(await big.getAttribute('data-state')), progress: Number(await big.getAttribute('data-progress')) };
    await until(async () => (await bigFrame.evaluate(() => JSON.stringify(window.layoutBoxes()))).includes('"sub"'), 5000, 'крупное превью нарисовано');
    const inPage = await bigFrame.evaluate(() => window.layoutBoxes());
    const solo = await page.context().newPage(); // тот же вход (cookie), шаблон отдаётся только после него
    await solo.setViewportSize({ width: 1080, height: 1920 });
    await solo.goto(`${APP}/template/overlay.html`);
    await solo.evaluate(([spec, state, progress]) => window.renderState(spec, state, { bar: { progress } }), [want, drawn.state, drawn.progress]);
    const alone = await solo.evaluate(() => window.layoutBoxes());
    await solo.close();
    check(isDeepStrictEqual(inPage, alone), `рамки превью ${JSON.stringify(inPage)} ≠ шаблона ${JSON.stringify(alone)}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'previews');

    await page.getByLabel('Ни один не подходит? Скажи, что поменять').fill('без плашки');
    await page.getByRole('button', { name: 'Ещё три варианта' }).click();
    await until(async () => (await fires()).some((f) => f.step === 'restyle' && f.attempt === 1), 10_000, 'запуск restyle');
    const restyle = JSON.parse((await branchFile(ctx, 'restyle.json')) ?? '{}');
    check(restyle.requests?.[0]?.text === 'без плашки', `restyle.json: ${JSON.stringify(restyle)}`);
    await page.getByText('Claude подготовит ещё три варианта').waitFor({ timeout: 7000 });

    // ролик на румынском: в «ț» нет у Russo One и Marck Script — страница их не предлагает (styles.fonts от vm fonts)
    const restyled = {
      ...STYLES,
      sample: {
        ...STYLES.sample, hook: 'Cum învăț limbi', words: ['Vă', 'mulțumesc', 'pentru', 'întrebare'], spoken: 1,
        end: { lines: ['Abonează-te 👇'], handle: '@pavel.malakhouski', logo: 'q-logo.png' },
        inserts: [...STYLES.sample.inserts, { kind: 'image', src: 'q-logo.png', x: 600, y: 900, w: 250 }, // вставка из ТЗ: её размер меняет Павел
          { kind: 'text', id: 's1', text: '3 ошибки 🔥', x: 120, y: 1100, w: 420 }], // стикер-тезис
      },
      variants: STYLES.variants.map((v) => ({ ...v, label: `${v.label} — без плашки` })),
      fonts: { main: ['montserrat', 'unbounded', 'rubik', 'oswald', 'comfortaa'], hand: ['caveat', 'bad-script'] },
    };
    engineValidate('styles.json', restyled);
    await session(ctx, { 'styles.json': restyled, 'status.json': { state: 'waiting_answers', phase: 'Ждёт ответов', message: 'Три новых стиля', at: new Date().toISOString(), needs: 'answers' } });
    await page.getByRole('button', { name: /^A · .*без плашки/ }).waitFor({ timeout: 10_000 });
    check(await page.getByRole('button', { name: /^A · / }).getAttribute('aria-pressed') === 'true', 'после restyle выбор не сброшен к A');
    await tab('Шрифт').click();
    await page.getByRole('button', { name: 'Montserrat', exact: true }).waitFor();
    for (const lacking of ['Russo One', 'Marck Script']) {
      check(await page.getByRole('button', { name: lacking, exact: true }).count() === 0, `${lacking} без «ț» предложен Павлу`);
    }
    await shot(page, 'previews-romanian');

    // финальная карточка: призыв — из ответа на вопрос end, ник и логотип — из образца (бренд Павла)
    await tab('Стиль').click();
    await page.getByRole('button', { name: 'Финальная карточка' }).click();
    await until(async () => JSON.parse(await big.getAttribute('data-state')).end?.lines?.[0] === 'Подпишись, чтобы не пропустить 👇', 5000, 'карточка на превью');
    const cardState = JSON.parse(await big.getAttribute('data-state')).end;
    check(cardState.handle === '@pavel.malakhouski' && /q-logo\.png/.test(cardState.logo ?? ''), `карточка: ${JSON.stringify(cardState)}`);
    check(await page.getByRole('slider', { name: 'Высота субтитров' }).count() === 0, 'на карточке нет ручек текста');
    await shot(page, 'previews-end-card');
    await page.getByRole('button', { name: 'Кадр с текстом' }).click();
    await page.getByRole('slider', { name: 'Высота субтитров' }).waitFor();

    await page.getByRole('button', { name: /^B · / }).click();
    await tab('Шрифт').click();
    await page.getByRole('button', { name: 'Rubik', exact: true }).click();
    await tab('Место').click(); // кнопки сдвига и размера — на вкладке «Место»
    // субтитры тянутся по крупному превью: 50 px экрана при ширине 270 — это 200 px кадра
    const variantY = restyled.variants[1].spec.subtitles.y;
    const handle = page.getByRole('slider', { name: 'Высота субтитров' });
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 25, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 50, { steps: 4 });
    await page.mouse.up();
    await until(async () => (await bigSpec()).subtitles.y === variantY - 200, 5000, `субтитры перетащены на ${variantY - 200}`);
    await page.getByRole('button', { name: 'Субтитры ниже', exact: true }).click();
    await until(async () => (await bigSpec()).subtitles.y === variantY - 180, 5000, 'кнопка «Ниже» — на 20 px');
    // хук — так же: 30 px экрана вниз — это 120 px кадра
    const hookY = restyled.variants[1].spec.hook.y ?? 400;
    const hookHandle = page.getByRole('slider', { name: 'Высота хука' });
    await hookHandle.scrollIntoViewIfNeeded(); // после кнопок страница прокручена ниже превью
    const hookBox = await hookHandle.boundingBox();
    await page.mouse.move(hookBox.x + hookBox.width / 2, hookBox.y + hookBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(hookBox.x + hookBox.width / 2, hookBox.y + hookBox.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    await until(async () => (await bigSpec()).hook.y === hookY + 120, 5000, `хук перетащен на ${hookY + 120}`);
    // размер: мышкой — уголок ⤢ субтитров вправо на 27 px (×1,2); на телефоне — щипок двумя пальцами по хуку (×1,5)
    const subSize = restyled.variants[1].spec.subtitles.size;
    const hookSize = restyled.variants[1].spec.hook.size;
    const grip = page.getByRole('slider', { name: 'Высота субтитров' }).locator('[data-grip]');
    await grip.scrollIntoViewIfNeeded();
    const g = await grip.boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + 27, g.y + g.height / 2, { steps: 5 });
    await page.mouse.up();
    const grown = Math.round((subSize * 1.2) / 2) * 2;
    await until(async () => (await bigSpec()).subtitles.size === grown, 5000, `субтитры крупнее: ${grown}`);
    await hookHandle.scrollIntoViewIfNeeded();
    await hookHandle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const fire = (type, pointerId, x) => el.dispatchEvent(new PointerEvent(type, { pointerId, clientX: x, clientY: y, bubbles: true, pointerType: 'touch' }));
      fire('pointerdown', 11, r.left + 100);
      fire('pointerdown', 12, r.left + 140);
      fire('pointermove', 12, r.left + 150);
      fire('pointermove', 12, r.left + 160);
      fire('pointerup', 12, r.left + 160);
      fire('pointerup', 11, r.left + 100);
    });
    const pinched = Math.round((hookSize * 1.5) / 2) * 2;
    await until(async () => (await bigSpec()).hook.size === pinched, 5000, `хук крупнее щипком: ${pinched}`);
    await page.getByRole('button', { name: 'Субтитры меньше', exact: true }).click();
    await until(async () => (await bigSpec()).subtitles.size === grown - 4, 5000, 'кнопка «Меньше» — на 4 px');
    // затемнение под субтитрами: ползунок на вкладке «Место», по умолчанию выключен; 12 шагов по 5 % — 60 %, на крупном
    // превью под субтитрами — пятно
    const shade = page.getByRole('slider', { name: 'Затемнение под субтитрами' });
    check((await bigSpec()).subtitles.shade === undefined, `пятно по умолчанию: ${(await bigSpec()).subtitles.shade}`);
    await shade.scrollIntoViewIfNeeded();
    await shade.focus();
    for (let k = 0; k < 12; k++) await shade.press('ArrowRight');
    await until(async () => (await bigSpec()).subtitles.shade === 0.6, 5000, 'пятно под субтитрами — 60 %');
    const spots = () => page.frameLocator('iframe[data-big]').locator('#shade .shade').count();
    await until(async () => (await spots()) === 1, 5000, 'на крупном превью — пятно');
    await shade.press('Home'); // до конца влево — выключено
    await until(async () => (await bigSpec()).subtitles.shade === 0 && (await spots()) === 0, 5000, 'пятно выключено');
    for (let k = 0; k < 12; k++) await shade.press('ArrowRight');
    await until(async () => (await bigSpec()).subtitles.shade === 0.6 && (await spots()) === 1, 5000, 'пятно снова 60 %');
    // вставка из ТЗ (картинка из ответа после перезагрузки уже не видна): уголок ⤢ вправо на 27 px — ×1,2; «больше» — +20 px
    const insertW = restyled.sample.inserts[1].w;
    const bigInsert = async () => JSON.parse(await big.getAttribute('data-state')).inserts.find((i) => i.key === 'q-logo.png');
    const insertGrip = page.getByRole('slider', { name: 'Вставка 1' }).locator('[data-grip]');
    await insertGrip.scrollIntoViewIfNeeded();
    const ig = await insertGrip.boundingBox();
    await page.mouse.move(ig.x + ig.width / 2, ig.y + ig.height / 2);
    await page.mouse.down();
    await page.mouse.move(ig.x + ig.width / 2 + 27, ig.y + ig.height / 2, { steps: 5 });
    await page.mouse.up();
    const wider = Math.round((insertW * 1.2) / 10) * 10;
    await until(async () => (await bigInsert()).w === wider, 5000, `вставка шире: ${wider}`);
    await page.getByRole('button', { name: 'Вставка 1 больше', exact: true }).click();
    await until(async () => (await bigInsert()).w === wider + 20, 5000, 'кнопка «больше» у вставки — на 20 px');
    check((await bigInsert()).x >= 60, `вставка вышла из безопасной зоны: x ${(await bigInsert()).x}`);
    // перетаскивание: за середину рамки на 40 px влево и 60 px вверх — это 160 и 240 px кадра
    const before = await bigInsert();
    const frameBox = await page.getByRole('slider', { name: 'Вставка 1' }).boundingBox();
    await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(frameBox.x + frameBox.width / 2 - 20, frameBox.y + frameBox.height / 2 - 30, { steps: 4 });
    await page.mouse.move(frameBox.x + frameBox.width / 2 - 40, frameBox.y + frameBox.height / 2 - 60, { steps: 4 });
    await page.mouse.up();
    const placed = { x: before.x - 160, y: before.y - 240, w: before.w };
    await until(async () => { const i = await bigInsert(); return i.x === placed.x && i.y === placed.y && i.w === placed.w; }, 5000,
      `вставка перетащена в ${JSON.stringify(placed)}`);
    // стикер-тезис двигается так же: 30 px вправо и 20 px вверх — 120 и 80 px кадра
    const bigSticker = async () => JSON.parse(await big.getAttribute('data-state')).inserts.find((i) => i.key === 's1');
    const st = await bigSticker();
    check(st?.kind === 'text' && st.text === '3 ошибки 🔥', `стикер на превью: ${JSON.stringify(st)}`);
    const stickerHandle = page.getByRole('slider', { name: 'Стикер 1' });
    await stickerHandle.scrollIntoViewIfNeeded();
    const sb = await stickerHandle.boundingBox();
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + sb.width / 2 + 30, sb.y + sb.height / 2 - 20, { steps: 5 });
    await page.mouse.up();
    const stickerPlaced = { x: st.x + 120, y: st.y - 80, w: st.w };
    await until(async () => { const i = await bigSticker(); return i.x === stickerPlaced.x && i.y === stickerPlaced.y; }, 5000,
      `стикер перетащен в ${JSON.stringify(stickerPlaced)}`);
    await shot(page, 'previews-insert-moved');
    await shot(page, 'previews-resized');
    await shot(page, 'previews-subtitles-moved');
    await tab('Скорость').click();
    check(await page.getByRole('button', { name: '×1.1', exact: true }).getAttribute('aria-pressed') === 'true', 'скорость по умолчанию не ×1.1');
    await page.getByRole('button', { name: '×1.3', exact: true }).click();
    // вторая версия для теста: тизер Павел взял — можно собрать ролик без него; музыки нет — без музыки нельзя
    await tab('Версии').click();
    check(await page.getByRole('button', { name: 'Без музыки' }).count() === 0, 'без музыки предложено, хотя трека нет');
    await page.getByRole('button', { name: 'Без тизера' }).click();
    // версия для рекламы: на крупном превью «Реклама» — всё выше кнопки рекламы (низ зоны — 1250)
    await page.locator('[data-ad]').getByRole('button', { name: 'Нужна', exact: true }).click();
    await page.getByRole('button', { name: 'Реклама', exact: true }).click();
    const adFrame = page.frameLocator('iframe[data-big]');
    await until(async () => {
      const b = await adFrame.locator('body').evaluate(() => window.layoutBoxes());
      return b.sub && b.sub.y + b.sub.h <= 1250 && b.inserts.every((i) => i.y + i.h <= 1250);
    }, 5000, 'крупное превью в зоне рекламы');
    await shot(page, 'previews-ads');
    await page.getByRole('button', { name: 'Органика', exact: true }).click();
    // обложка: второй кадр и свой текст; пока открыта её вкладка, крупное превью — обложка (тот же шаблон)
    await tab('Обложка').click();
    const coverCard = page.locator('[data-cover]');
    check(await coverCard.locator('.cover-pick').count() === 3, 'три кадра обложки');
    const coverText = await coverCard.getByLabel('Текст обложки').inputValue();
    check(coverText === 'Как я снимаю reels', `текст обложки — хук, который выбрал Павел: ${coverText}`);
    const bigState = async () => JSON.parse(await big.getAttribute('data-state'));
    await until(async () => (await bigState()).cover?.text === 'Как я снимаю reels', 5000, 'обложка на крупном превью');
    check(await page.getByRole('slider', { name: 'Высота субтитров' }).count() === 0, 'на обложке нет ручек текста');
    await coverCard.getByRole('button', { name: 'Кадр 2' }).click();
    await coverCard.getByLabel('Текст обложки').fill('Чешский за 15 минут');
    await until(async () => (await bigState()).cover?.text === 'Чешский за 15 минут'
      && /cover-2\.jpg/.test((await page.locator('.preview.big > img').getAttribute('src')) ?? ''), 5000, 'обложка второго кадра с новым текстом');
    // тап сразу после ввода: пока в поле печатают, сцена не липнет; когда тап уводит фокус, она прилипает не сразу — тап
    // по кадру, оказавшемуся там, где встанет сцена, доходит
    await page.setViewportSize({ width: 375, height: 667 });
    await coverCard.getByLabel('Текст обложки').focus();
    // кадр — туда, где встанет сцена (прокруткой окна: scrollIntoView учёл бы отступ под прилипшую сцену)
    await coverCard.getByRole('button', { name: 'Кадр 3' }).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 60));
    const third = await coverCard.getByRole('button', { name: 'Кадр 3' }).boundingBox();
    check(third !== null && third.y + 12 < 56 + 391, `кадр не там, где встанет сцена: ${JSON.stringify(third)}`);
    await page.touchscreen.tap(third.x + 20, third.y + 12); // тап пальцем по верху кадра — там встанет сцена
    await until(async () => (await coverCard.getByRole('button', { name: 'Кадр 3' }).getAttribute('aria-pressed')) === 'true', 3000,
      'тап по кадру сразу после ввода дошёл');
    await page.setViewportSize({ width: 390, height: 844 });
    await coverCard.getByRole('button', { name: 'Кадр 2' }).click();
    const go = page.getByRole('button', { name: /^Монтировать: B · Rubik · ×1\.3 · A\/B/ });
    await go.waitFor();
    // «Монтировать» не прошёл — ошибка видна сразу, даже когда инструменты прокручены под сцену
    await page.route('**/api/jobs/*/run', (route) => route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: 'Картинка к ответу не догрузилась' }) }), { times: 1 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await go.click();
    const alert = page.getByRole('alert').filter({ hasText: 'Картинка к ответу не догрузилась' });
    await alert.waitFor();
    const ab = await alert.boundingBox();
    check(ab !== null && ab.y >= 0 && ab.y + ab.height <= 844, `ошибка «Монтировать» не на экране: ${JSON.stringify(ab)}`);
    await shot(page, 'previews-mount-error');
    const last = await bigSpec();
    await go.click();
    await until(async () => (await fires()).some((f) => f.step === 'render' && f.attempt === 1), 10_000, 'запуск render');
    const answers = JSON.parse((await branchFile(ctx, 'answers.json')) ?? '{}');
    engineValidate('answers.json', answers);
    check(answers.uploads?.logo === 'in/uploads/upload-q-logo.png', `uploads: ${JSON.stringify(answers.uploads)}`);
    check(answers.answers?.['hook.own'] === 'Как я снимаю reels', `hook.own: ${answers.answers?.['hook.own']}`);
    check(answers.brief === 'ХУК: Как я учу чешский', `brief: ${answers.brief}`);
    check(answers.speed === 1.3, `speed: ${answers.speed}`);
    check(answers.style?.subY === variantY - 180, `style.subY: ${answers.style?.subY}`);
    check(answers.style?.hookY === hookY + 120, `style.hookY: ${answers.style?.hookY}`);
    check(isDeepStrictEqual(answers.insertBoxes?.['q-logo.png'], placed), `insertBoxes: ${JSON.stringify(answers.insertBoxes)}`);
    check(isDeepStrictEqual(answers.insertBoxes?.s1, stickerPlaced), `стикер в insertBoxes: ${JSON.stringify(answers.insertBoxes)}`);
    check(isDeepStrictEqual(answers.answers?.stickers, ['s1']), `stickers: ${JSON.stringify(answers.answers?.stickers)}`);
    check(answers.answers?.end === 'e1', `end: ${JSON.stringify(answers.answers?.end)}`);
    check(answers.ab === 'teaser', `ab: ${JSON.stringify(answers.ab)}`);
    check(isDeepStrictEqual(answers.cover, { frame: 1, text: 'Чешский за 15 минут' }), `cover: ${JSON.stringify(answers.cover)}`);
    check(answers.ad === true, `ad: ${JSON.stringify(answers.ad)}`);
    check(answers.answers?.dim === '50', `dim: ${JSON.stringify(answers.answers?.dim)}`);
    check(answers.style?.subSize === grown - 4 && answers.style?.hookSize === pinched, `размеры: ${answers.style?.subSize}, ${answers.style?.hookSize}`);
    check(answers.style?.subShade === 0.6, `пятно под субтитрами: ${answers.style?.subShade}`);
    check(isDeepStrictEqual(finalStyle(restyled, answers.style), last), `стиль ответа ${JSON.stringify(answers.style)} ≠ последнему превью`);
  }],

  ['result', async (ctx) => {
    const { page } = ctx;
    const iso = () => new Date().toISOString();
    const tag = `job-${ctx.jobId}`;
    const asset = (name, bytes) => fakeJson('/__asset', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag, name, base64: bytes.toString('base64') }) });
    const released = async (names) => {
      const draft = (await state()).drafts.find((d) => d.tag === tag);
      const list = await fakeJson('/__dump').then((all) => all.find((d) => d.tag === tag).assets);
      return { release_id: draft.id, assets: list.filter((a) => names.includes(a.name)).map(({ name, id, size }) => ({ name, id, size })), at: iso() };
    };

    await session(ctx, { 'status.json': { state: 'rendering', phase: 'Монтирую', message: 'Собираю ролик', at: iso() } });
    await page.getByText('Монтирую').waitFor({ timeout: 7000 });
    const result = {
      durations: { source: 102.4, final: 76.2 },
      done: ['Вырезал 14 пауз и 2 повтора', 'Логотип — 0:09–0:13, справа вверху'],
      unsure: ['«Мемсон» на 0:31 — не уверен в написании'],
      missing: ['нет музыки assets/music/lofi.mp3 — ролик без неё'],
      qa: { ok: false, problems: ['хук на лице или ближе 40 px к нему (0,0–1,5 с ролика)'] },
      caption: { text: 'Как я учу чешский по 15 минут в день и почему это работает лучше, чем курсы 🇨🇿\nСохрани, чтобы не потерять', hashtags: ['чешский', 'языки'],
        ad: 'Учу чешский по 15 минут в день — покажу как' },
      ad: { durations: { source: 102.4, final: 76.2 }, qa: { ok: true, problems: [] } },
      ab: { differs: 'teaser', durations: { source: 102.4, final: 73.8 }, qa: { ok: false, problems: ['субтитры и вставка друг на друге (0:40)'] } },
      checklist: [
        { id: 'format', title: '9:16, 1080×1920, 30 к/с', ok: true }, { id: 'container', title: 'H.264 в MP4 без edit lists', ok: true },
        { id: 'audio', title: 'звук стерео AAC', ok: true }, { id: 'hook', title: 'хук с первой секунды', ok: true },
        { id: 'safe', title: 'текст в безопасных зонах', ok: false }, { id: 'subtitles', title: 'субтитры', ok: true },
        { id: 'end', title: 'финальная карточка с призывом', ok: true }, { id: 'length', title: 'длина до 90 с', ok: true },
      ],
    };
    engineValidate('result.json', result);
    const v1 = crypto.randomBytes(48 * 1024);
    await asset('final.mp4', v1);
    await asset('final.srt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nпривет\n\n'));
    const vB = crypto.randomBytes(44 * 1024);
    await asset('final-b.mp4', vB);
    await asset('final-cover.png', PNG);
    await asset('final-ad.mp4', crypto.randomBytes(40 * 1024));
    await session(ctx, { 'result.json': result, 'status.json': { state: 'rendered', phase: 'Загружаю', message: 'Ролик собран, загружаю', at: iso() },
      'out/released.json': await released(['final.mp4', 'final.srt', 'final-b.mp4', 'final-ad.mp4', 'final-cover.png']) });
    await page.getByText('Что я сделал').waitFor({ timeout: 7000 });
    check(await page.getByRole('heading', { name: 'Готово' }).count() === 1, 'нет заголовка «Готово»');
    check((await page.textContent('body')).includes('было 1:42 → стало 1:16 · стиль B'), 'нет строки «было → стало · стиль»');
    // A/B: два ролика с подписями, у каждого своя кнопка
    const pair = page.locator('[data-ab]');
    check(await pair.locator('video').count() === 2, 'не два ролика');
    check((await pair.textContent()).includes('A — с тизером') && (await pair.textContent()).includes('B — без тизера'), 'подписи A и B');
    check(/name=final-b\.mp4$/.test((await pair.locator('video').nth(1).getAttribute('src')) ?? ''), 'второй ролик — final-b.mp4');
    const body = await page.textContent('body');
    check(body.includes('Проверка версии A нашла') && body.includes('Проверка версии B нашла') && body.includes('субтитры и вставка друг на друге'),
      'проверки обеих версий');
    // чек-лист по гайду: строки vm render и подпись к посту (она есть)
    const list = page.locator('[data-checklist]');
    check(await list.locator('li').count() === 9, `строк чек-листа: ${await list.locator('li').count()}`);
    check(await list.locator('li[data-ok=false]').count() === 1 && (await list.locator('li[data-ok=false]').textContent()).includes('безопасных зонах'), 'не пройдено — зоны');
    check((await list.locator('li[data-ok=true]').last().textContent()).includes('подпись к посту'), 'строка подписи к посту');
    await shot(page, 'result');
    // подпись к посту: жирное — первые 72 знака, кнопка копирует текст и хэштеги
    const card = page.locator('[data-caption]');
    check([...((await card.locator('b').textContent()) ?? '')].length === 72, 'до «ещё» — 72 знака');
    await card.getByRole('button', { name: 'Скопировать подпись' }).click();
    await card.getByRole('button', { name: 'Скопировано' }).waitFor();
    // Chromium читает буфер обмена; у WebKit без разрешений — то, что страница туда записала (см. запуск)
    const copied = await page.evaluate((webkit) => (webkit ? window.__copied?.at(-1) : navigator.clipboard.readText()), WEBKIT);
    check(copied === `${result.caption.text}\n\n#чешский #языки`, `скопировано: ${copied}`);

    const got = await page.request.get(`${APP}/api/jobs/${ctx.jobId}/download?name=final.mp4`, { maxRedirects: 0 });
    check(got.status() === 302 && /\/__blob\/\d+$/.test(got.headers().location ?? ''), `скачивание: ${got.status()} ${got.headers().location}`);
    const bytes = Buffer.from(await (await fetch(got.headers().location)).arrayBuffer());
    check(bytes.equals(v1), 'скачанный ролик не совпал байт в байт');
    check(/name=final-ad\.mp4$/.test((await page.locator('[data-ad-result] video').getAttribute('src')) ?? ''), 'версия для рекламы на «Готово»');
    check((await page.locator('[data-ad-text]').textContent()).includes('Учу чешский по 15 минут в день — покажу как'), 'текст для рекламы');
    const coverImg = page.locator('[data-cover-result] img');
    check(/name=final-cover\.png$/.test((await coverImg.getAttribute('src')) ?? ''), 'обложка на «Готово»');
    const coverGot = await page.request.get(`${APP}/api/jobs/${ctx.jobId}/download?name=final-cover.png`, { maxRedirects: 0 });
    check(coverGot.status() === 302, `скачивание обложки: ${coverGot.status()}`);
    const second = await page.request.get(`${APP}/api/jobs/${ctx.jobId}/download?name=final-b.mp4`, { maxRedirects: 0 });
    check(second.status() === 302, `скачивание версии B: ${second.status()}`);
    check(Buffer.from(await (await fetch(second.headers().location)).arrayBuffer()).equals(vB), 'версия B скачалась не та');

    await page.getByLabel('Поправить').fill('логотип левее');
    await page.getByRole('button', { name: 'Переделать' }).click();
    await until(async () => (await fires()).some((f) => f.step === 'fix' && f.attempt === 1), 10_000, 'запуск fix');
    const fix = JSON.parse((await branchFile(ctx, 'fix.json')) ?? '{}');
    check(fix.fixes?.[0]?.text === 'логотип левее' && fix.fixes[0].version === 2, `fix.json: ${JSON.stringify(fix)}`);
    await page.getByText('Предыдущая версия').waitFor({ timeout: 7000 });
    check(await page.getByText('Что я сделал').count() === 0, 'пока в релизе только final.mp4, это ещё не «Готово»');

    await asset('final-v2.mp4', crypto.randomBytes(40 * 1024));
    await session(ctx, { 'status.json': { state: 'rendered', phase: 'Загружаю', message: 'Правка 2 собрана', at: iso() },
      'out/released.json': await released(['final.mp4', 'final.srt', 'final-v2.mp4']) });
    await page.getByText('Что я сделал').waitFor({ timeout: 7000 });
    const src = await page.locator('video').getAttribute('src');
    check(/name=final-v2\.mp4$/.test(src ?? ''), `видео второй версии: ${src}`);
    check(await page.getByText('логотип левее').count() > 0, 'прошлая правка не показана');

    // правка не получилась — вернуть готовый ролик и попросить иначе
    await page.getByLabel('Поправить').fill('субтитры крупнее');
    await page.getByRole('button', { name: 'Переделать' }).click();
    await until(async () => (await fires()).filter((f) => f.step === 'fix').length === 2, 10_000, 'вторая правка запущена');
    await session(ctx, { 'status.json': { state: 'error', phase: 'Ошибка', message: 'Не получилось применить правку', at: iso(), error: 'шрифт не найден' } });
    await page.getByText('Не получилось применить правку').waitFor({ timeout: 7000 });
    await page.getByRole('button', { name: 'Вернуть готовый ролик' }).click();
    await page.getByText('Что я сделал').waitFor({ timeout: 7000 });
    check(/name=final-v2\.mp4$/.test((await page.locator('video').getAttribute('src')) ?? ''), 'вернулся не тот ролик');
    const fixes = JSON.parse((await branchFile(ctx, 'fix.json')) ?? '{}').fixes ?? [];
    check(fixes.length === 1 && fixes[0].text === 'логотип левее', `fix.json после «Вернуть»: ${JSON.stringify(fixes)}`);
    check((await fires()).filter((f) => f.step === 'fix').length === 2, '«Вернуть» ничего не запускает');
  }],

  ['editor', async (ctx) => {
    const { page } = ctx;
    const tag = `job-${ctx.jobId}`;
    const asset = (name, bytes) => fakeJson('/__asset', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag, name, base64: bytes.toString('base64') }) });
    // прокси — WebM: у Chromium из Playwright нет H.264; без ffmpeg — заглушка, тогда без пуска
    const webm = path.join(ctx.tmp, 'proxy.webm');
    let playable = true;
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-g', '15', '-c:a', 'libopus', '-shortest', webm]);
    } catch {
      playable = false;
    }
    // этот браузер WebM (VP9 и Opus) не играет — дорожки проверяем, пуск — нет
    playable &&= await page.evaluate(() => document.createElement('video').canPlayType('video/webm; codecs="vp9, opus"') !== '');
    const proxy = await asset('proxy.mp4', playable ? fs.readFileSync(webm) : crypto.randomBytes(2048));
    const edit = {
      speed: 1.1, keep: [[0.2, 1.2], [1.6, 2.9]],
      words: [{ t0: 0.3, t1: 0.6, text: 'Привет,' }, { t0: 0.7, t1: 0.9, text: 'это' }, { t0: 1.0, t1: 1.15, text: 'мой' },
        { t0: 1.7, t1: 2.0, text: 'новый' }, { t0: 2.1, t1: 2.6, text: 'ролик' }],
      hook: { text: 'Как я снимаю', until: 1.0 }, cta: null, inserts: [], zooms: [], face: { x: 0.5, y: 0.4 },
      music: { file: 'assets/music/lofi.wav', gainDb: -14 }, hold: 0, style: FIXTURE.expected,
    };
    engineValidate('edit.json', edit);
    const media = {
      duration: 3, proxy: { file: 'out/proxy.mp4', width: 540, height: 960, key: 0.5 }, film: { file: 'film.jpg', step: 0.5, w: 54, h: 96, n: 6 },
      peaks: { perS: 50, data: Buffer.from(Array.from({ length: 150 }, (_, i) => Math.round(127 + 120 * Math.sin(i / 4)))).toString('base64') },
      // стык видео — в вырезанном между кусками; третье видео (последние 0,05 с) вырезано целиком
      videos: [{ name: 'clip.mov', t0: 0, t1: 1.4 }, { name: 'clip2.mov', t0: 1.4, t1: 2.95 }, { name: 'clip3.mov', t0: 2.95, t1: 3 }],
    };
    engineValidate('editor.json', media);
    const released = JSON.parse((await branchFile(ctx, 'out/released.json')) ?? '{}');
    const WAV = wav(4, 220);
    await fakeJson('/__commit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: `claude/job-${ctx.jobId}`, files: { 'assets/music/lofi.wav': { base64: WAV.toString('base64') } }, message: 'music' }) });
    await session(ctx, { 'edit.json': edit, 'editor.json': media, 'film.jpg': PNG,
      'out/released.json': { ...released, assets: [...released.assets, { name: 'proxy.mp4', id: proxy.id, size: proxy.size }] } });

    // вход — со страницы задачи; старый поток не тронут
    await page.getByRole('link', { name: /Открыть в редакторе/ }).click();
    await page.waitForURL(/\/editor$/);
    await page.locator('.ed-piece').first().waitFor({ timeout: 10_000 });
    check(await page.locator('.ed-piece').count() === 2, 'два куска на дорожке «Видео»');
    check(isDeepStrictEqual(await page.locator('.ed-piece .ed-vno').allTextContents(), ['1', '2']), 'на кусках — номер видео задачи');
    check(isDeepStrictEqual(await page.locator('.ed-videos li .grow').allTextContents(), ['clip.mov', 'clip2.mov', 'clip3.mov']), 'список видео задачи');
    check(await page.locator('.ed-cut').count() === 3, 'вырезанное: до, между и после кусков');
    const subs = await page.locator('.ed-clip.sub').allTextContents();
    check(isDeepStrictEqual(subs, ['Привет, это мой', 'новый ролик']), `субтитры по кускам: ${JSON.stringify(subs)}`);
    check((await page.locator('.ed-clip.text').textContent()).includes('Как я снимаю'), 'хук на дорожке «Текст»');
    check((await page.locator('.ed-clip.music').textContent()).includes('lofi'), 'музыка на своей дорожке');
    const bg = await page.locator('.ed').evaluate((el) => getComputedStyle(el).backgroundColor);
    check(bg === 'rgb(243, 244, 241)', `светлая тема редактора: ${bg}`);
    // ролик смонтирован: панель стиля — от его стиля; поменять можно, новый войдёт в ролик при «Монтировать»
    const panel = page.locator('.ed-style');
    check((await panel.textContent()).includes('Ролик смонтирован в этом стиле'), 'подсказка: стиль — ролика');
    check(await panel.getByRole('button', { name: /^B / }).getAttribute('aria-pressed') === 'true', 'выбран вариант ролика (B)');
    check(!(await panel.getByRole('button', { name: /^A / }).isDisabled()), 'после монтажа стиль можно поменять');
    const mountBtn = page.getByRole('button', { name: 'Монтировать', exact: true });
    check(await mountBtn.isDisabled(), 'правок нет — монтировать нечего');
    // язык
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.locator('.ed-head', { hasText: 'Subtitles' }).waitFor();
    await page.getByRole('button', { name: 'RU', exact: true }).click();
    await page.locator('.ed-head', { hasText: 'Субтитры' }).waitFor();
    // перемотка: тап по дорожке субтитров — часы и слой кадра (слово, которое звучит)
    const clock = page.locator('.ed-clock');
    const lane = page.locator('.ed-row.sub .ed-lane');
    await lane.scrollIntoViewIfNeeded(); // на телефоне таймлайн — под кадром
    const box = await lane.boundingBox();
    const second = await page.locator('.ed-clip.sub').nth(1).boundingBox();
    await page.mouse.click(second.x + second.width / 2, box.y + box.height / 2);
    await until(async () => !(await clock.textContent()).startsWith('0:00.0'), 3000, 'часы после перемотки');
    await until(async () => {
      const st = JSON.parse((await page.locator('.ed-layer iframe').getAttribute('data-state')) ?? '{}');
      return isDeepStrictEqual(st.sub?.words, ['новый', 'ролик']);
    }, 5000, 'на кадре — группа субтитров, которую слышно');
    if (playable) {
      await page.locator('video[data-editor-video]').evaluate((v) => new Promise((ok) => (v.readyState > 0 ? ok() : v.addEventListener('loadedmetadata', ok, { once: true }))));
      await page.mouse.click(box.x + 2, box.y + box.height / 2); // в начало
      await page.getByRole('button', { name: 'Пуск' }).click();
      await until(async () => (await clock.textContent()) >= '0:00.5', 8000, 'пуск: время идёт');
      await page.getByRole('button', { name: 'Пауза' }).click();
    }
    await shot(page, 'editor-phone');

    // ---------- правки руками (фаза 3) — на компьютере ----------
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('.ed-side').waitFor();
    // музыка для прослушивания — через страницу, из assets/ ветки; выше папки задачи — нет
    const music = await page.request.get(`${APP}/api/jobs/${ctx.jobId}/audio?path=${encodeURIComponent('assets/music/lofi.wav')}`);
    check(music.status() === 200 && music.headers()['content-type'] === 'audio/wav', `звук для редактора: ${music.status()} ${music.headers()['content-type']}`);
    check(Buffer.from(await music.body()).equals(WAV), 'звук для редактора не тот');
    const outside = await page.request.get(`${APP}/api/jobs/${ctx.jobId}/audio?path=${encodeURIComponent('../../engine/vm/audio.py')}`);
    check(outside.status() === 400, `чужой файл как звук: ${outside.status()}`);

    const pieces = page.locator('.ed-piece');
    const bar = page.locator('.ed-bar');
    // видео, вырезанное целиком, — «Вернуть» из списка видео: оно встаёт куском (за куском перед ним в исходнике); отмена
    await page.locator('.ed-videos li', { hasText: 'clip3.mov' }).getByRole('button', { name: 'Вернуть' }).click();
    await until(async () => isDeepStrictEqual(await page.locator('.ed-piece .ed-vno').allTextContents(), ['1', '2', '3']), 3000, 'третье видео вернулось куском');
    await bar.getByRole('button', { name: 'Отменить' }).click();
    await until(async () => (await pieces.count()) === 2, 3000, 'отмена: третье видео снова вырезано');
    // удалить второй кусок и отменить
    await pieces.nth(1).click();
    await page.locator('.ed-insp').getByText('Видео 2 «clip2.mov» · 0:00.2–0:01.5').waitFor({ timeout: 3000 }); // время — в своём файле
    await bar.getByRole('button', { name: 'Удалить' }).click();
    await until(async () => (await pieces.count()) === 1, 3000, 'кусок удалён');
    await bar.getByRole('button', { name: 'Отменить' }).click();
    await until(async () => (await pieces.count()) === 2, 3000, 'отмена вернула кусок');
    // S — разрезать первый кусок по плейхеду
    const first = await pieces.nth(0).boundingBox();
    await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
    await page.keyboard.press('s');
    await until(async () => (await pieces.count()) === 3, 3000, 'S разрезал кусок по плейхеду');
    // «＋» на стыке — вернуть вырезанное между кусками: куски сливаются, разрез Павла остаётся
    await page.getByRole('button', { name: 'Вырезано 0,4 с — вернуть' }).click();
    await until(async () => (await page.locator('.ed-cut').count()) === 2, 3000, 'вырезанное между кусками вернулось');
    check(await pieces.count() === 3, 'кусок с разрезом и стыком видео — три части');
    check(isDeepStrictEqual(await page.locator('.ed-piece .ed-vno').allTextContents(), ['1', '1', '2']), 'части — каждая из своего видео');
    // конец последнего куска — левее, почти до конца слова «ролик» (2,6 с исходника): липнет к нему (ближе 8 px)
    const last = pieces.last();
    const span = /(\d+):(\d+\.\d)–(\d+):(\d+\.\d)/.exec((await last.getAttribute('title')) ?? '');
    const [s0, s1] = [Number(span[1]) * 60 + Number(span[2]), Number(span[3]) * 60 + Number(span[4])];
    const lb = await last.boundingBox();
    const perSrc = lb.width / (s1 - s0);
    const fromX = lb.x + lb.width - 4;
    const grabY = lb.y + lb.height / 4; // ручка края — в верхней части куска (внизу — «＋» на стыке)
    await page.mouse.move(fromX, grabY);
    await page.mouse.down();
    await page.mouse.move(fromX - 0.295 * perSrc, grabY, { steps: 6 });
    await page.mouse.up();
    await until(async () => ((await page.locator('.ed-cut').last().getAttribute('title')) ?? '').includes('0,4 с'), 3000,
      async () => `конец куска прилип к слову: ${JSON.stringify(await page.locator('.ed-cut').evaluateAll((els) => els.map((el) => el.title)))}, ролик ${await clock.textContent()}`);
    // переставить (фаза 4а): второй кусок — мышью перед первым; выбранным остаётся он, «Позже» — обратно, отмена — снова первый
    const titles = async () => Promise.all([0, 1].map((k) => pieces.nth(k).getAttribute('title')));
    const order = await titles();
    const [fb, sb] = [await pieces.nth(0).boundingBox(), await pieces.nth(1).boundingBox()];
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(fb.x + 6, sb.y + sb.height / 2, { steps: 8 });
    check(await page.locator('.ed-drop').count() === 1, 'пока тянут — линия, куда встанет кусок');
    await page.mouse.up();
    await until(async () => isDeepStrictEqual(await titles(), [order[1], order[0]]), 3000, 'кусок встал первым');
    // вырезанное до первого куска и хвост — теперь на одном стыке: «＋» рядом, а не друг на друге
    const plus = await page.locator('.ed-restore').evaluateAll((els) => els.map((el) => [el.getBoundingClientRect().left, el.getBoundingClientRect().right]));
    check(plus.length === 2 && (plus[0][1] <= plus[1][0] + 0.5 || plus[1][1] <= plus[0][0] + 0.5), `«＋» на одном стыке закрывают друг друга: ${JSON.stringify(plus)}`);
    const insp = page.locator('.ed-insp');
    await insp.getByRole('heading', { name: 'Кусок 1 из 3' }).waitFor({ timeout: 3000 });
    check((await insp.textContent()).includes('Видео 1 «clip.mov»'), 'в панели куска — из какого он видео');
    check(await insp.getByRole('button', { name: '← Раньше' }).isDisabled(), 'первый кусок раньше не поставить');
    await insp.getByRole('button', { name: 'Позже →' }).click();
    await until(async () => isDeepStrictEqual(await titles(), order), 3000, '«Позже» вернул кусок на место');
    await insp.getByRole('heading', { name: 'Кусок 2 из 3' }).waitFor({ timeout: 3000 });
    await bar.getByRole('button', { name: 'Отменить' }).click();
    await until(async () => isDeepStrictEqual(await titles(), [order[1], order[0]]), 3000, 'отмена: кусок снова первый');
    // звук: музыка без звука, голос тише, свой стиль
    await page.getByRole('button', { name: 'Музыка: без звука' }).click();
    check(await page.getByRole('button', { name: 'Музыка: без звука' }).getAttribute('aria-pressed') === 'true', 'музыка без звука');
    await page.locator('.ed-row.voice .ed-lane').click({ position: { x: 5, y: 10 } });
    await page.getByLabel('Голос: Громкость').fill('-6');
    await panel.getByRole('button', { name: /^A / }).click();
    await page.locator('.ed-save').getByText('Сохранено').waitFor({ timeout: 8000 });
    const tl = JSON.parse((await branchFile(ctx, 'timeline.json')) ?? '{}');
    engineValidate('timeline.json', tl);
    check(tl.rev >= 1 && tl.music?.muted === true && tl.voice?.gainDb === -6, `timeline.json: ${JSON.stringify(tl)}`);
    check(isDeepStrictEqual(tl.edits.map((e) => e.op), ['split', 'restore', 'cut', 'move']), `правки по порядку: ${JSON.stringify(tl.edits)}`);
    // движок вырежет и переставит так же, как показал редактор: часть после разреза — первой
    const keep = JSON.parse(execFileSync('python3', ['-c', 'import json, sys\nfrom vm.edits import apply_keep\nd = json.load(sys.stdin)\nprint(json.dumps(apply_keep(d["keep"], d["edits"], d["duration"])))'], {
      input: JSON.stringify({ keep: edit.keep, edits: tl.edits, duration: media.duration }), env: { ...process.env, PYTHONPATH: path.resolve('../engine') },
    }).toString());
    const at = tl.edits[0].t;
    check(isDeepStrictEqual(keep, [[at, 1.4], [0.2, at], [1.4, 2.6]]), `куски у движка: ${JSON.stringify(keep)}`);
    await shot(page, 'editor');

    // «Монтировать» — новая версия: правка с ревизией правок и новым стилем
    check(!(await mountBtn.isDisabled()), 'есть правки — «Монтировать» включена');
    await mountBtn.click();
    await until(async () => (await fires()).filter((f) => f.step === 'fix').length === 3, 10_000, 'монтаж из редактора запущен');
    const editorFix = JSON.parse((await branchFile(ctx, 'fix.json')) ?? '{}').fixes.at(-1);
    check(editorFix.text === 'Правки в редакторе' && editorFix.version === 3 && editorFix.timeline === tl.rev && editorFix.style === true,
      `правка из редактора: ${JSON.stringify(editorFix)}`);
    check(JSON.parse((await branchFile(ctx, 'answers.json')) ?? '{}').style?.variant === 'A', 'новый стиль — в answers.json');
    await page.getByText('Claude монтирует новую версию').waitFor({ timeout: 7000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('link', { name: 'К задаче' }).click();
    await page.getByText('Предыдущая версия').waitFor({ timeout: 7000 });
  }],

  ['editor-text', async (ctx) => {
    // фаза 5: хук, титр, акцент и вставки тянут и растягивают мышью, текст и слова субтитров правят в панели; кадр — как
    // нарисует движок (сверка с vm.edits.apply → render.timeline → build_overlay_events по сохранённому timeline.json)
    const { page } = ctx;
    const iso = () => new Date().toISOString();
    const tag = `job-${ctx.jobId}`;
    const asset = (name, bytes) => fakeJson('/__asset', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag, name, base64: bytes.toString('base64') }) });
    // сессия собрала версию 3; черновик — один кусок, хук, титр, акцент, стикер и картинка, ч/б, зум, вспышка, карточка
    const released = JSON.parse((await branchFile(ctx, 'out/released.json')) ?? '{}');
    const v3 = await asset('final-v3.mp4', crypto.randomBytes(40 * 1024));
    const edit = {
      speed: 1, keep: [[0.2, 2.9]],
      words: [{ t0: 0.3, t1: 0.6, text: 'Привет,' }, { t0: 0.7, t1: 0.9, text: 'это' }, { t0: 1.0, t1: 1.15, text: 'мой' },
        { t0: 1.7, t1: 2.0, text: 'новый' }, { t0: 2.1, t1: 2.6, text: 'ролик' }],
      hook: { text: 'Как я снимаю', until: 0.7 },
      cta: { t0: 2.1, t1: 2.6, lines: ['Пиши в комментариях'], word: 'ВИДЕО' },
      accents: [{ t0: 1.0, t1: 1.15, x: 540, y: 900, lines: [{ text: 'мой' }] }],
      inserts: [
        { kind: 'sticker', text: '3 ошибки', t0: 0.9, t1: 1.3, x: 120, y: 1100, w: 400 },
        // картинка, которую Павел загрузил с видео (сегмент upload): в релизе она кусками upload-i1.png.part-NNNNN
        { kind: 'image', src: 'in/uploads/upload-i1.png', t0: 1.7, t1: 2.2, x: 600, y: 300, w: 300, sfx: 'assets/music/lofi.wav' },
      ],
      looks: [{ t0: 1.6, t1: 2.0, look: 'bw' }], zooms: [{ t: 0.9, level: 1.12 }], face: { x: 0.5, y: 0.4 },
      transitions: [{ t: 1.6, kind: 'flash' }],
      music: { file: 'assets/music/lofi.wav', gainDb: -14 }, hold: 0.4, end: { seconds: 1.0, lines: ['Подпишись'] }, style: FIXTURE.expected,
    };
    engineValidate('edit.json', edit);
    await session(ctx, {
      'edit.json': edit, 'timeline.json': null, // правки прошлого сегмента — к другим кускам
      'status.json': { state: 'rendered', phase: 'Загружаю', message: 'Правка 3 собрана', at: iso() },
      'out/released.json': { ...released, assets: [...released.assets, { name: 'final-v3.mp4', id: v3.id, size: v3.size }], at: iso() },
    });
    const SOURCE = 3;
    const shownTracks = draftTracks(parseDraft(edit), { style: FIXTURE.expected, sourceDuration: SOURCE });
    const FULL = shownTracks.duration + shownTracks.tail;
    ctx.editorEdit = { edit, source: SOURCE, full: FULL }; // для сегмента картинки

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${APP}/jobs/${ctx.jobId}/editor`);
    const textBlocks = page.locator('.ed-row.text .ed-clip');
    const insBlocks = page.locator('.ed-row.ins .ed-clip');
    await until(async () => (await textBlocks.count()) === 3 && (await insBlocks.count()) === 2, 10_000,
      async () => `блоки: текст ${await textBlocks.count()}, вставки ${await insBlocks.count()}`);
    check(isDeepStrictEqual(await textBlocks.evaluateAll((els) => els.map((el) => el.dataset.kind)), ['hook', 'accent', 'cta']), 'хук, акцент, титр');
    const { geo, layerState, seekTo } = editorKit(page, FULL);
    // щелчок по акценту — панель блока и кадр на его начале (слова акцента — вместо субтитров)
    await textBlocks.nth(1).click();
    const insp = page.locator('.ed-insp[data-block=accent]');
    await insp.waitFor({ timeout: 3000 });
    await until(async () => Boolean((await layerState()).accent), 3000, 'на кадре — акцент');
    check(!(await layerState()).sub, 'пока акцент — субтитров нет (слова акцента и есть субтитры)');
    await shot(page, 'editor-text');
    // картинка Павла — на кадре (страница отдаёт её из кусков загрузки), слой нарисован без ошибки
    await seekTo(1.6);
    await until(async () => ((await layerState()).inserts ?? []).some((i) => i.n === 1), 3000, 'картинка Павла в слое');
    await page.waitForTimeout(1500); // шаблон грузит картинку — сбой показал бы ошибку слоя
    check(await page.locator('.preview-error').count() === 0, `слой не нарисовался: ${await page.locator('.preview-error').allTextContents()}`);
    check(await page.frameLocator('.ed-layer iframe').locator('img').evaluateAll((els) => els.some((el) => el.complete && el.naturalWidth > 0)),
      'картинка Павла загрузилась в кадр');

    /** Тянуть (мышью) точку `x` блока на `dx` px. */
    const drag = async (x, y, dx) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y, { steps: 8 });
      await page.mouse.up();
    };
    const box = async (loc) => loc.boundingBox();
    // акцент — целиком позже: его начало липнет к началу слова «новый» (1,5 с ролика)
    let b = await box(textBlocks.nth(1));
    await drag(b.x + b.width / 2, b.y + b.height / 2, (1.5 - 0.8) * (await geo()).pps);
    await until(async () => ((await textBlocks.nth(1).getAttribute('title')) ?? '').includes('0:01.5'), 3000,
      async () => `акцент переехал: ${await textBlocks.nth(1).getAttribute('title')}`);
    // хук — за правый край до конца слова «это» (0,7 с ролика)
    b = await box(textBlocks.nth(0));
    await drag(b.x + b.width - 3, b.y + b.height / 2, (await geo()).X(0.7) - (b.x + b.width - 3));
    await until(async () => ((await textBlocks.nth(0).getAttribute('title')) ?? '').includes('–0:00.7'), 3000,
      async () => `хук до 0,7 с: ${await textBlocks.nth(0).getAttribute('title')}`);
    // стикер — растянуть до конца слова «ролик» (2,4 с ролика): ручка — на конце его места в речи (на кадре он дольше —
    // не меньше 1,5 с, этот хвост — штриховкой)
    check(await insBlocks.nth(0).locator('.ed-hold').count() === 1, 'у короткого стикера — хвост до 1,5 с');
    b = await box(insBlocks.nth(0).locator('.ed-handle.end'));
    await drag(b.x + b.width / 2, b.y + b.height / 2, (await geo()).X(2.4) - (b.x + b.width / 2));
    await until(async () => ((await insBlocks.nth(0).getAttribute('title')) ?? '').includes('–0:02.4'), 3000,
      async () => `стикер до 2,4 с: ${await insBlocks.nth(0).getAttribute('title')}`);
    await shot(page, 'editor-text-moved');

    // слова субтитров: «это» → «вот», «Привет,» — убрать
    await page.locator('.ed-row.sub .ed-clip').first().click();
    const words = page.locator('.ed-insp[data-block=sub]');
    await words.waitFor({ timeout: 3000 });
    await words.getByLabel('это', { exact: true }).fill('вот');
    await words.getByLabel('Привет,', { exact: true }).fill('');
    await until(async () => (await page.locator('.ed-row.sub .ed-clip').first().textContent()) === 'вот мой', 3000,
      async () => `субтитры с правкой: ${await page.locator('.ed-row.sub .ed-clip').allTextContents()}`);
    await words.getByLabel('мой', { exact: true }).fill('мой🔥');
    await words.getByRole('alert').getByText('эмодзи нельзя').waitFor({ timeout: 3000 });
    // буквы, которых нет в шрифте стиля (греческих в Rubik нет), — сразу в поле, как их не пропустит проверка шрифтов
    // движка; таблицы символов шрифтов страница читает после загрузки — пока не прочитаны, поле молчит
    const mine = words.getByLabel('мой', { exact: true });
    await until(async () => {
      await mine.fill('мой');
      await mine.fill('мой αβ');
      return (await words.getByRole('alert').allTextContents()).some((t) => t.includes('В шрифте Rubik нет букв') && t.includes('α'));
    }, 10_000, async () => `нет букв в шрифте: ${await words.getByRole('alert').allTextContents()}`);
    await mine.fill('мой');
    await seekTo(0.85);
    await until(async () => isDeepStrictEqual((await layerState()).sub?.words, ['вот', 'мой']), 3000, async () => `на кадре: ${JSON.stringify(await layerState())}`);
    await shot(page, 'editor-word');

    // титр: кодовое слово
    await textBlocks.nth(2).click();
    await page.locator('.ed-insp[data-block=cta]').getByLabel('Кодовое слово').fill('ПЛАН');
    await until(async () => (await textBlocks.nth(2).textContent()).includes('ПЛАН'), 3000, 'титр с новым словом');
    // картинку — убрать (Delete): тень на дорожке, звука нет; отмена и повтор
    await insBlocks.nth(1).click();
    await page.locator('.ed-insp[data-block=insert]').waitFor({ timeout: 3000 });
    const sounds = page.locator('.ed-row.snd .ed-clip');
    check(await sounds.count() === 1, 'у картинки — звук появления');
    await page.keyboard.press('Delete');
    await until(async () => (await page.locator('.ed-row.ins .ed-clip.ghost').count()) === 1, 3000, 'картинка убрана — тень');
    check(await page.locator('.ed-row.snd').count() === 0, 'убранная картинка — без звука');
    await page.keyboard.press('Control+z');
    await until(async () => (await page.locator('.ed-row.ins .ed-clip.ghost').count()) === 0, 3000, 'отмена вернула картинку');
    await page.keyboard.press('Control+Shift+z');
    await until(async () => (await page.locator('.ed-row.ins .ed-clip.ghost').count()) === 1, 3000, 'повтор снова убрал');
    await shot(page, 'editor-text-off');

    // сохранено — timeline.json по схеме движка; правки держатся за места блоков у сессии
    await page.locator('.ed-save').getByText('Сохранено').waitFor({ timeout: 8000 });
    const tl = JSON.parse((await branchFile(ctx, 'timeline.json')) ?? '{}');
    engineValidate('timeline.json', tl);
    const t = tl.text ?? {};
    // акцент переехал целиком: его место в речи — той же длины (хвост после слов движок добавит сам)
    check(t.hook?.until === 0.9 && isDeepStrictEqual(t.accents, [{ at: [1.0, 1.15], t0: 1.7, t1: 1.85 }]), `хук и акцент: ${JSON.stringify(t)}`);
    check(isDeepStrictEqual(t.cta, { at: [2.1, 2.6], word: 'ПЛАН' }), `титр: ${JSON.stringify(t.cta)}`);
    check(isDeepStrictEqual(t.inserts, [{ at: [0.9, 1.3], t0: 0.9, t1: 2.6 }, { at: [1.7, 2.2], off: true }]), `вставки: ${JSON.stringify(t.inserts)}`);
    check(isDeepStrictEqual(tl.words, [{ t0: 0.7, t1: 0.9, text: 'вот' }, { t0: 0.3, t1: 0.6, text: '' }]), `слова: ${JSON.stringify(tl.words)}`);

    // движок нарисует то же, что показал кадр: события слоя по сохранённым правкам — состояние в каждом моменте
    const events = JSON.parse(execFileSync('python3', ['-c', [
      'import json, sys', 'from vm.edits import apply', 'from vm.overlay import build_overlay_events', 'from vm.render import timeline',
      'd = json.load(sys.stdin)', 'e = apply(d["edit"], d["timeline"], d["duration"])', 'print(json.dumps(build_overlay_events(e, timeline(e, d["duration"]))))',
    ].join('\n')], { input: JSON.stringify({ edit, timeline: tl, duration: SOURCE }), env: { ...process.env, PYTHONPATH: path.resolve('../engine') } }).toString());
    const plain = (state) => JSON.parse(JSON.stringify(state, (k, v) => {
      if (k !== 'src' || typeof v !== 'string' || !v.startsWith('/api/')) return v;
      const q = new URL(v, APP).searchParams; // адрес страницы → путь, как в edit.json
      return q.get('path') ?? `in/uploads/${q.get('name')}`;
    }));
    for (const at of [0.3, 0.6, 1.0, 1.55, 2.0, 2.5, 3.3]) {
      await seekTo(at);
      const shown = await layerState();
      const want = stateAt(events, Number(await page.locator('.ed-layer').getAttribute('data-t0')));
      check(isDeepStrictEqual(plain(shown), plain(want)), `на ${at} с кадр не как у движка:\n  страница ${JSON.stringify(shown)}\n  движок   ${JSON.stringify(want)}`);
    }

    // картинка как в ролике: ч/б — в окне куска, вспышка — на стыке, зум — после ступени
    const v = page.locator('video[data-editor-video]');
    await seekTo(1.6);
    await until(async () => (await v.getAttribute('data-bw')) === '1', 3000, 'ч/б на кадре');
    check((await v.evaluate((el) => getComputedStyle(el).filter)).includes('grayscale'), 'ч/б — фильтр видео');
    check(Number(await v.getAttribute('data-zoom')) > 1.1, `зум к лицу: ${await v.getAttribute('data-zoom')}`);
    await shot(page, 'editor-bw');
    await seekTo(1.4);
    await until(async () => Number(await page.locator('.ed-flash').evaluate((el) => getComputedStyle(el).opacity)) > 0.5, 3000, 'вспышка на стыке');
    await seekTo(0.3);
    await until(async () => (await v.getAttribute('data-bw')) === '' && Number(await v.getAttribute('data-zoom')) === 1, 3000,
      async () => `до ч/б и зума — как есть: bw ${await v.getAttribute('data-bw')}, зум ${await v.getAttribute('data-zoom')}`);

    // хвост: после кусков — стоп-кадр и карточка (пуск доигрывает до конца ролика)
    await seekTo(FULL - 0.5);
    await until(async () => Boolean((await layerState()).end), 3000, 'на карточке — карточка');
    check(Number(await page.locator('.ed-pbar').getAttribute('data-progress')) === 1, 'шкала на карточке — полная');

    // телефон: ничего не шире экрана
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.ed-row.text').scrollIntoViewIfNeeded();
    await shot(page, 'editor-text-phone');

    // задача старого движка (схема timeline.json без text и words): текст не правится, сервер правку не сохранит
    const schema = JSON.parse(fs.readFileSync(path.resolve('../engine/vm/schemas/timeline.json'), 'utf8'));
    const { text: _text, words: _words, ...props } = schema.properties;
    await fakeJson('/__commit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: `claude/job-${ctx.jobId}`, files: { 'engine/vm/schemas/timeline.json': JSON.stringify({ ...schema, properties: props }) }, message: 'old engine' }) });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await textBlocks.first().waitFor({ timeout: 10_000 });
    await textBlocks.nth(0).click();
    await page.locator('.ed-insp[data-block=hook]').getByText('до правок текста').waitFor({ timeout: 3000 });
    check(await page.locator('.ed-row.text .ed-handle').count() === 0, 'у старой задачи блоки не тянутся');
    const refused = await page.request.put(`${APP}/api/jobs/${ctx.jobId}/timeline`, { data: { base: tl.rev, edits: [], text: { hook: { until: 1.2 } } } });
    check(refused.status() === 409, `старый движок: правка текста не сохраняется (${refused.status()})`);
    await fakeJson('/__commit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: `claude/job-${ctx.jobId}`, files: { 'engine/vm/schemas/timeline.json': JSON.stringify(schema) }, message: 'engine back' }) });
    await page.setViewportSize({ width: 390, height: 844 });
  }],

  ['editor-picture', async (ctx) => {
    // фаза 5в: сила зума — ползунок, ч/б-кусок — убрать, переход — другой вид или убрать; кадр меняется сразу, а движок по
    // сохранённому timeline.json даст ту же картинку (ступени зума, кадры ч/б, переходы на стыках)
    const { page } = ctx;
    const { edit, source, full } = ctx.editorEdit;
    const { seekTo } = editorKit(page, full);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${APP}/jobs/${ctx.jobId}/editor`);
    const row = page.locator('.ed-row.pic');
    const look = row.locator('.ed-clip[data-kind=look]');
    const tr = row.locator('.ed-clip[data-kind=transition]');
    await until(async () => (await look.count()) === 1 && (await tr.count()) === 1, 10_000, 'на дорожке «Картинка» — ч/б-кусок и переход');
    const v = page.locator('video[data-editor-video]');
    const zoomAt = async (t) => {
      await seekTo(t);
      await page.waitForTimeout(150); // картинка — по кадру часов
      return Number(await v.getAttribute('data-zoom'));
    };
    const z0 = await zoomAt(1.6);
    check(z0 > 1.1, `зум монтажа: ${z0}`);
    // сила зума — ползунок с клавиатуры: 100 % → 50 % (шаг — 5 %)
    const slider = page.getByRole('slider', { name: 'Сила зума' });
    await slider.focus();
    for (let k = 0; k < 10; k++) await page.keyboard.press('ArrowLeft');
    await page.locator('.ed-pic-panel').getByText('50 %').first().waitFor({ timeout: 3000 });
    const z1 = await zoomAt(1.6);
    check(Math.abs(z1 - (1 + (z0 - 1) / 2)) < 0.002, `зум вполовину: было ${z0}, стало ${z1}`);

    // ч/б-кусок: выбрать на дорожке — убрать; кадр в цвете, на дорожке — тень
    await look.click();
    const lookPanel = page.locator('.ed-insp[aria-label="Ч/б-кусок"]');
    await lookPanel.getByRole('button', { name: 'Убрать ч/б' }).click();
    await until(async () => (await look.getAttribute('class')).includes('ghost'), 3000, 'ч/б-кусок — тенью');
    await seekTo(1.6);
    await until(async () => (await v.getAttribute('data-bw')) === '', 3000, 'кадр куска — в цвете');
    // переход: вместо вспышки — смаз; на стыке белого нет, кадр размыт
    await tr.click();
    const trPanel = page.locator('.ed-insp[aria-label="Переход"]');
    await trPanel.getByRole('button', { name: 'Смаз' }).click();
    await until(async () => (await trPanel.getByRole('button', { name: 'Смаз' }).getAttribute('aria-pressed')) === 'true', 3000, 'смаз выбран');
    await seekTo(1.4);
    await until(async () => (await page.locator('.ed-pic').evaluate((el) => getComputedStyle(el).filter)).includes('blur'), 3000, 'смаз на стыке');
    check(Number(await page.locator('.ed-flash').evaluate((el) => getComputedStyle(el).opacity)) === 0, 'вспышки нет');
    await shot(page, 'editor-picture');
    // Delete — убрать переход (вид Павла остаётся в правке); отмена — вернуть
    await page.keyboard.press('Delete');
    await until(async () => (await tr.getAttribute('class')).includes('ghost'), 3000, 'переход убран — тенью');
    await page.keyboard.press('Control+z');
    await until(async () => !(await tr.getAttribute('class')).includes('ghost'), 3000, 'отмена вернула переход');
    await page.keyboard.press('Control+Shift+z');
    await until(async () => (await tr.getAttribute('class')).includes('ghost'), 3000, 'повтор снова убрал');

    // затемнение фона — ползунок (в превью маски человека нет — о нём сказано под ползунком)
    const dimSlider = page.getByRole('slider', { name: 'Затемнение фона' });
    await dimSlider.focus();
    for (let k = 0; k < 10; k++) await page.keyboard.press('ArrowRight');
    await until(async () => (await dimSlider.inputValue()) === '0.5', 3000, async () => `затемнение: ${await dimSlider.inputValue()}`);
    // финальная карточка: щелчок по хвосту — её панель; убрать — хвост короче, карточка — тенью после стоп-кадра;
    // щелчок по тени — вернуть (как у монтажа)
    await page.locator('.ed-row.video .ed-tail.card').first().click();
    const endPanel = page.locator('.ed-insp[data-block=end]');
    await endPanel.getByRole('button', { name: 'Убрать карточку' }).click();
    const ghostCard = page.locator('.ed-row.video .ed-tail.ghost[data-kind=end]');
    await ghostCard.waitFor({ timeout: 3000 });
    await shot(page, 'editor-card-off');
    await ghostCard.click();
    await endPanel.getByRole('button', { name: 'Вернуть карточку' }).click();
    await until(async () => (await ghostCard.count()) === 0, 3000, 'карточка вернулась');
    // её строка и ник — на карточке новый текст
    await endPanel.getByLabel('Строка карточки').fill('Пиши «план»');
    await endPanel.getByLabel('Ник').fill('@pavel.edit');
    await seekTo(full - 0.3);
    await until(async () => (await editorKit(page, full).layerState()).end?.lines?.[0] === 'Пиши «план»', 3000,
      async () => `карточка на кадре: ${JSON.stringify((await editorKit(page, full).layerState()).end)}`);

    // сохранено — по схеме движка; движок по тем же правкам: зум, кадры ч/б и переходы — как на странице
    await page.locator('.ed-save').getByText('Сохранено').waitFor({ timeout: 8000 });
    // другой трек — из библиотеки ветки задачи (в ней появился calm.wav): звучит на прослушивании, доли — после монтажа
    await fakeJson('/__commit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: `claude/job-${ctx.jobId}`, files: { 'assets/music/calm.wav': { base64: wav(3, 330).toString('base64') } }, message: 'library' }) });
    await page.reload();
    const musicClip = page.locator('.ed-row.music .ed-clip');
    await musicClip.waitFor({ timeout: 10_000 });
    await musicClip.click();
    const musicPanel = page.locator('.ed-insp[aria-label="Музыка"]');
    await musicPanel.getByRole('combobox', { name: 'Трек', exact: true }).selectOption('assets/music/calm.wav');
    await until(async () => (await musicClip.textContent()).includes('calm'), 3000, async () => `трек на дорожке: ${await musicClip.textContent()}`);
    await musicPanel.getByText('Доли этого трека').waitFor({ timeout: 3000 });
    await shot(page, 'editor-track');
    await page.locator('.ed-save').getByText('Сохранено').waitFor({ timeout: 8000 });
    const tl = JSON.parse((await branchFile(ctx, 'timeline.json')) ?? '{}');
    engineValidate('timeline.json', tl);
    check(tl.zoom === 0.5 && isDeepStrictEqual(tl.looks, [{ at: [1.6, 2.0], off: true }]) && isDeepStrictEqual(tl.transitions, [{ at: 1.6, kind: 'blur', off: true }]),
      `картинка в timeline.json: ${JSON.stringify({ zoom: tl.zoom, looks: tl.looks, transitions: tl.transitions })}`);
    check(tl.dim === 0.5 && tl.music?.file === 'assets/music/calm.wav' && isDeepStrictEqual(tl.text?.end, { lines: ['Пиши «план»'], handle: '@pavel.edit' }),
      `фон, трек и карточка в timeline.json: ${JSON.stringify({ dim: tl.dim, music: tl.music, end: tl.text?.end })}`);
    const engine = JSON.parse(execFileSync('python3', ['-c', [
      'import json, sys', 'from vm import transitions', 'from vm.edits import apply', 'from vm.render import look_windows, timeline',
      'from vm.zoom import TRANS, zoom_at',
      'd = json.load(sys.stdin)', 'e = apply(d["edit"], d["timeline"], d["duration"])', 'tl = timeline(e, d["duration"])',
      'marks = transitions.marks(e, tl)',
      'print(json.dumps({"windows": look_windows(e, tl), "marks": [[m.t, m.kind] for m in marks],',
      '  "zoom": zoom_at(e["zooms"], tl, 1.6, TRANS, [m.t for m in marks if m.kind == "zoom"]),',
      '  "dim": e.get("dim"), "music": e["music"]["file"], "end": [e["end"]["lines"], e["end"].get("handle")]}))',
    ].join('\n')], { input: JSON.stringify({ edit, timeline: tl, duration: source }), env: { ...process.env, PYTHONPATH: path.resolve('../engine') } }).toString());
    check(isDeepStrictEqual(engine.windows, []) && isDeepStrictEqual(engine.marks, []), `движок: ч/б и переход убраны — ${JSON.stringify(engine)}`);
    check(Math.abs(engine.zoom - z1) < 1e-4, `зум движка на 1,6 с ${engine.zoom}, на странице ${z1}`);
    check(engine.dim === 0.5 && engine.music === 'assets/music/calm.wav' && isDeepStrictEqual(engine.end, [['Пиши «план»'], '@pavel.edit']),
      `движок: фон, трек и карточка — ${JSON.stringify(engine)}`);
    // задача старого движка (схема без картинки): ползунок закрыт, сервер правку не сохранит
    const schema = JSON.parse(fs.readFileSync(path.resolve('../engine/vm/schemas/timeline.json'), 'utf8'));
    const { zoom: _z, looks: _l, transitions: _t, ...props } = schema.properties;
    await fakeJson('/__commit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: `claude/job-${ctx.jobId}`, files: { 'engine/vm/schemas/timeline.json': JSON.stringify({ ...schema, properties: props }) }, message: 'old engine' }) });
    await page.reload();
    await page.locator('.ed-pic-panel').getByText('до правок картинки').waitFor({ timeout: 10_000 });
    check(await page.getByRole('slider', { name: 'Сила зума' }).isDisabled(), 'у старой задачи зум не правится');
    const refused = await page.request.put(`${APP}/api/jobs/${ctx.jobId}/timeline`, { data: { base: tl.rev, edits: [], zoom: 0.2 } });
    check(refused.status() === 409, `старый движок: правка картинки не сохраняется (${refused.status()})`);
    // задача до редактора (в её ветке схемы нет — движок timeline.json не читает): только смотреть
    await fakeJson('/__commit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: `claude/job-${ctx.jobId}`, files: { 'engine/vm/schemas/timeline.json': null }, message: 'before the editor' }) });
    await page.reload();
    await page.getByText('Эта задача создана до редактора').waitFor({ timeout: 10_000 });
    check(await page.locator('.ed-handle').count() === 0 && await page.getByRole('slider', { name: 'Сила зума' }).isDisabled(), 'у задачи до редактора ничего не правится');
    await fakeJson('/__commit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: `claude/job-${ctx.jobId}`, files: { 'engine/vm/schemas/timeline.json': JSON.stringify(schema) }, message: 'engine back' }) });
    // телефон: дорожка «Картинка» и панель — не шире экрана
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await row.scrollIntoViewIfNeeded();
    await shot(page, 'editor-picture-phone');
  }],

  ['editor-video', async (ctx) => {
    // фаза 5в: вид хука, место и толщина шкалы — кнопки и ползунок «Стиля»; скорость ролика — ползунок, тизер — убрать;
    // движок по сохранённым правкам: ролик той же длины, что на странице, без тизера
    const { page } = ctx;
    const { edit, source } = ctx.editorEdit;
    const teased = { ...edit, teaser: { t0: 1.7, t1: 2.7, sfx: null } }; // «новый ролик» — ещё и в начале
    engineValidate('edit.json', teased);
    await session(ctx, { 'edit.json': teased });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${APP}/jobs/${ctx.jobId}/editor`);
    await page.locator('.ed-piece.teaser').waitFor({ timeout: 10_000 });
    const total = async () => {
      const text = (await page.locator('.ed-clock').textContent()) ?? '';
      const [m, sec] = text.split('/')[1].trim().split(':');
      return Number(m) * 60 + Number(sec);
    };
    const before = await total();
    // скорость: ×1,00 (как у монтажа этой задачи) → ×1,25 (пять шагов по 0,05) — ролик короче
    const speedSlider = page.getByRole('slider', { name: 'Скорость', exact: true });
    check(await speedSlider.inputValue() === '1', `скорость монтажа: ${await speedSlider.inputValue()}`);
    await speedSlider.focus();
    for (let k = 0; k < 5; k++) await page.keyboard.press('ArrowRight');
    await page.locator('.ed-video-panel').getByText('×1,25').waitFor({ timeout: 3000 });
    await until(async () => (await total()) < before - 0.2, 3000, async () => `ролик короче: было ${before}, стало ${await total()}`);
    // тизер — убрать: первым на дорожке — кусок
    await page.locator('.ed-video-panel').getByRole('button', { name: 'Тизер в начале' }).click();
    await until(async () => (await page.locator('.ed-piece.teaser').count()) === 0, 3000, 'тизер убран');
    // стиль: хук — контуром, шкала — сверху и толще
    const style = page.locator('.ed-style');
    await style.getByRole('group', { name: 'Вид хука' }).getByRole('button', { name: 'Контур' }).click();
    await style.getByRole('group', { name: 'Где шкала' }).getByRole('button', { name: 'Сверху' }).click();
    const thick = page.getByRole('slider', { name: 'Шкала времени: Толщина' });
    await thick.focus();
    for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowRight');
    await until(async () => (await page.locator('.ed-pbar').evaluate((el) => el.style.top)) === '0px', 3000, 'шкала сверху');
    check(await style.getByRole('group', { name: 'Вид хука' }).getByRole('button', { name: 'Контур' }).getAttribute('aria-pressed') === 'true', 'хук — контуром');
    await shot(page, 'editor-video');
    // сохранено; движок: ролик той же длины, без тизера
    await page.locator('.ed-save').getByText('Сохранено').waitFor({ timeout: 8000 });
    const tl = JSON.parse((await branchFile(ctx, 'timeline.json')) ?? '{}');
    engineValidate('timeline.json', tl);
    check(tl.teaser === false && tl.speed === 1.25, `тизер и скорость в timeline.json: ${JSON.stringify({ teaser: tl.teaser, speed: tl.speed })}`);
    const engine = JSON.parse(execFileSync('python3', ['-c', [
      'import json, sys', 'from vm.edits import apply', 'from vm.render import timeline',
      'd = json.load(sys.stdin)', 'e = apply(d["edit"], d["timeline"], d["duration"])', 'tl = timeline(e, d["duration"])',
      'print(json.dumps({"teaser": e.get("teaser"), "speed": e["speed"], "duration": tl.duration + float(e.get("hold") or 0) + float((e.get("end") or {}).get("seconds") or 0)}))',
    ].join('\n')], { input: JSON.stringify({ edit: teased, timeline: tl, duration: source }), env: { ...process.env, PYTHONPATH: path.resolve('../engine') } }).toString());
    check(engine.teaser === null && engine.speed === 1.25 && Math.abs(engine.duration - (await total())) < 0.06,
      `движок: ${JSON.stringify(engine)}, на странице ${await total()} с`);
    await page.setViewportSize({ width: 390, height: 844 });
  }],

  ['script', async (ctx) => {
    const { page } = ctx;
    const topic = 'Как я учу чешский по 15 минут в день';
    await page.goto(`${APP}/`);
    await page.getByRole('link', { name: 'Сценарий' }).click();
    await page.waitForURL(`${APP}/script`);
    const go = page.getByRole('button', { name: 'Написать сценарий' });
    check(await go.isDisabled(), '«Написать сценарий» включена без темы');
    await page.fill('#topic', topic);
    await page.getByRole('button', { name: 'Заявки', exact: true }).click();
    await page.getByRole('button', { name: 'Обучающий', exact: true }).click();
    await page.getByRole('button', { name: '60 с', exact: true }).click();
    await page.getByRole('button', { name: 'чешский', exact: true }).click();
    await shot(page, 'script-form');
    await go.click();
    await page.waitForURL(/\/jobs\/\d{6}-\d{6}-[0-9a-z]{4}$/, { timeout: 20_000 });
    ctx.jobId = page.url().split('/').pop();
    const job = JSON.parse((await branchFile(ctx, 'job.json')) ?? '{}');
    check(job.kind === 'script' && isDeepStrictEqual(job.script, { topic, goal: 'leads', story: 'tutorial', length: 60, language: 'чешский' }),
      `job.json задачи-сценария: ${JSON.stringify({ kind: job.kind, script: job.script })}`);
    check((await fires()).some((f) => f.job === ctx.jobId && f.step === 'analyze' && f.attempt === 1), 'анализ сценария не запущен');
    await page.getByText('Пишу сценарий').or(page.getByText('Запускаю сессию')).first().waitFor({ timeout: 7000 });

    engineValidate('script.json', SCRIPT);
    await session(ctx, { 'script.json': SCRIPT,
      'status.json': { state: 'script_ready', phase: 'Сценарий готов', message: 'Три хука и раскадровка — можно снимать', at: new Date().toISOString() } });
    const view = page.locator('[data-script]');
    await view.waitFor({ timeout: 7000 });
    check(await view.locator('[data-hook]').count() === 3, 'не три хука');
    check(await view.locator('[data-scene]').count() === SCRIPT.scenes.length, 'сцены раскадровки');
    const text = await view.textContent();
    for (const part of ['Обучающий', 'Зацепить', 'Удержать', 'Вознаградить', 'Пиши «план» в комментариях', 'Лицо в кадре с первой секунды', '#чешский']) {
      check(text.includes(part), `на экране сценария нет «${part}»`);
    }
    await shot(page, 'script');
    await view.locator('[data-hook]').nth(1).click();
    await page.getByRole('button', { name: 'Снять по сценарию' }).click();
    await page.waitForURL(`${APP}/`);
    const brief = await until(async () => page.inputValue('#brief').catch(() => ''), 7000, 'ТЗ по сценарию в форме загрузки');
    check(brief === 'ХУК: Какой вы ученик: зубрила или болтун?\nТЕЗИСЫ: Слова — списком; Без повторов\nПРИЗЫВ: Пиши «план» в комментариях\nЯЗЫК: чешский',
      `ТЗ по сценарию: ${JSON.stringify(brief)}`);
    await page.locator(`[data-job="${ctx.jobId}"]`).getByText('Сценарий готов').waitFor();
    check(await page.locator(`[data-job="${ctx.jobId}"]`).getAttribute('data-kind') === 'script', 'в списке сценарий не отмечен своим видом');
    await page.reload();
    check(await page.inputValue('#brief') === '', 'ТЗ сценария подставилось второй раз');
  }],
  // Safari (только WebKit): загрузка прервана перезагрузкой страницы, тот же файл выбран снова — «Продолжить загрузку»
  // доводит её до страницы задачи, и следующий переход не зависает (в Chromium продолжение — в шаге upload)
  ...(WEBKIT ? [['resume', async (ctx) => {
    const p = await ctx.page.context().newPage();
    try {
      await p.goto(`${APP}/`);
      const big = path.join(ctx.tmp, 'reload.mov');
      sampleVideo(big, 2, 24 * 1024 * 1024);
      await p.setInputFiles('#source', big);
      await p.getByRole('button', { name: 'Загрузить', exact: true }).click();
      await p.getByText('Загружаю в GitHub…').waitFor();
      await until(async () => ((await state()).drafts.at(-1)?.assets.length ?? 0) >= 2, 60_000, 'два куска в черновике');
      await p.reload();
      await p.getByText('Загрузка reload.mov не закончена').waitFor({ timeout: 15_000 });
      await p.setInputFiles('#source', big);
      await p.getByRole('button', { name: 'Продолжить загрузку' }).click({ timeout: 15_000 });
      await p.waitForURL(/\/jobs\/\d{6}-\d{6}-[0-9a-z]{4}$/, { timeout: 120_000 });
      await p.goto(`${APP}/script`, { timeout: 20_000 });
    } finally {
      await p.close();
    }
  }]] : []),
];

// ---------- прогон ----------

// вывод самого браузера (stderr WebKit и т. п.) — в лог прогона: при зависании видно, что он говорил
const browserLog = [];
const browser = await playwright[BROWSER].launch({
  logger: { isEnabled: (name) => name === 'browser', log: (name, _severity, message) => { browserLog.push(String(message).slice(0, 300)); if (browserLog.length > 60) browserLog.shift(); } },
});
// контекст — чтобы открыть вторую вкладку с тем же входом; касания — чтобы тапать пальцем (мышь работает как раньше).
// WebKit — iPhone 13 (Safari): буфер обмена без разрешений не читается — запоминаем, что страница в него пишет.
const context = await browser.newContext(WEBKIT
  ? { ...playwright.devices['iPhone 13'], viewport: { width: 390, height: 844 } }
  : { viewport: { width: 390, height: 844 }, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
if (WEBKIT) {
  await context.addInitScript(() => {
    window.__copied = [];
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText = async (text) => { window.__copied.push(text); };
  });
}
const page = await context.newPage();
console.log(`браузер: ${BROWSER}`);
// запросы, что ещё идут: при сбое видно, чего ждала страница (например, `load` так и не наступил)
const inflight = new Map();
const answered = new Map(); // запрос → код ответа (заголовки пришли, тело ещё может идти)
const consoleTail = []; // последние сообщения консоли страницы
page.on('request', (r) => inflight.set(r, Date.now()));
page.on('response', (r) => answered.set(r.request(), r.status()));
page.on('requestfinished', (r) => inflight.delete(r));
page.on('requestfailed', (r) => inflight.delete(r));
page.on('pageerror', (e) => console.log(`ошибка на странице: ${e.message}`));
page.on('crash', () => console.log('страница упала (crash)'));
page.on('console', (m) => {
  consoleTail.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  if (consoleTail.length > 40) consoleTail.shift();
});
const within = (promise, ms) => Promise.race([promise, new Promise((ok) => setTimeout(() => ok(`не ответило за ${ms / 1000} с`), ms))]);

/** Что видно при сбое: жива ли страница, чего она ждёт, отвечает ли сервер, открывается ли та же страница в новой вкладке,
 *  сколько соединений держит браузер к серверу. */
async function diagnose(name) {
  const doc = await within(page.evaluate(() => ({ url: location.href, ready: document.readyState })).catch((e) => `ошибка: ${e.message.split('\n')[0]}`), 10_000);
  console.log(`страница: ${JSON.stringify(doc)}`);
  if (name.startsWith('editor')) { // кадр редактора: событие слоя, его состояние, ошибка шаблона, сохранение, правки в ветке
    const ed = await within(page.evaluate(() => ({
      event: document.querySelector('.ed-layer')?.getAttribute('data-t0'), state: document.querySelector('.ed-layer iframe')?.getAttribute('data-state'),
      error: document.querySelector('.preview-error')?.textContent, save: document.querySelector('.ed-save')?.textContent,
      clock: document.querySelector('.ed-clock')?.textContent,
    })).catch((e) => e.message.split('\n')[0]), 10_000);
    console.log(`редактор: ${JSON.stringify(ed)}`);
    if (ctx.jobId) console.log(`timeline.json: ${await branchFile(ctx, 'timeline.json').catch((e) => e.message)}`);
  }
  for (const [r, t] of inflight) {
    console.log(`  ещё идёт ${Math.round((Date.now() - t) / 1000)} с: ${r.method()} ${r.resourceType()} ${r.url()} — ответ: ${answered.get(r) ?? 'нет'}`);
  }
  for (const port of [3000, 4010]) {
    try {
      const out = execFileSync('ss', ['-Htn', 'state', 'established', `( sport = :${port} )`]).toString().trim();
      console.log(`соединений к :${port}: ${out ? out.split('\n').length : 0}`);
    } catch (e) {
      console.log(`ss: ${e.message.split('\n')[0]}`);
    }
  }
  const cookie = (await within(context.cookies(), 10_000).then((c) => (Array.isArray(c) ? c.map((x) => `${x.name}=${x.value}`).join('; ') : ''), () => ''));
  for (const url of [`${APP}/`, `${APP}/api/jobs`]) {
    const t = Date.now();
    const code = await fetch(url, { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(20_000) }).then((r) => r.status, (e) => e.message);
    console.log(`сервер ${url}: ${code} за ${Date.now() - t} мс`);
  }
  const fresh = await within(context.newPage(), 10_000);
  if (typeof fresh !== 'string') {
    const t = Date.now();
    const code = await fresh.goto(`${APP}/`, { timeout: 20_000 }).then((r) => r?.status(), (e) => e.message.split('\n')[0]);
    console.log(`новая вкладка ${APP}/: ${code} за ${Date.now() - t} мс`);
    if (process.env.E2E_SHOTS) await within(fresh.screenshot({ path: path.join(process.env.E2E_SHOTS, `FAIL-${name}-fresh.png`) }).catch(() => {}), 10_000);
  } else console.log(`новая вкладка: ${fresh}`);
  if (consoleTail.length) console.log(`консоль страницы (хвост):\n  ${consoleTail.join('\n  ')}`);
  if (browserLog.length) console.log(`браузер (хвост):\n  ${browserLog.join('\n  ')}`);
  // опыты на свежих вкладках: застревает ли переход после перехода внутри приложения (pushState) и после выбора видео
  const probe = async (label, setup) => {
    const p = await within(context.newPage(), 10_000);
    if (typeof p === 'string') return console.log(`опыт «${label}»: вкладка ${p}`);
    try {
      await setup(p);
      const t = Date.now();
      const r = await p.goto(`${APP}/script`, { timeout: 15_000 }).then(() => 'открылась', (e) => e.message.split('\n')[0]);
      console.log(`опыт «${label}»: переход на /script — ${r} за ${Date.now() - t} мс`);
    } catch (e) {
      console.log(`опыт «${label}»: подготовка не вышла — ${e.message.split('\n')[0]}`);
    }
  };
  await probe('после ссылки внутри приложения', async (p) => {
    await p.goto(`${APP}/brand`, { timeout: 15_000 });
    await p.getByRole('link', { name: 'Мои видео' }).click({ timeout: 10_000 });
    await p.waitForURL(`${APP}/`, { timeout: 10_000 });
  });
  await probe('после выбора видео', async (p) => {
    await p.goto(`${APP}/`, { timeout: 15_000 });
    const file = path.join(ctx.tmp, 'probe.mov');
    sampleVideo(file, 2, 1024 * 1024);
    await p.setInputFiles('#source', file, { timeout: 10_000 });
    await p.getByText('probe.mov').waitFor({ timeout: 10_000 });
    await new Promise((ok) => setTimeout(ok, 6000)); // зонд длительности успевает кончиться (5 с)
  });
  await probe('после блокировки экрана', async (p) => {
    await p.goto(`${APP}/`, { timeout: 15_000 });
    const t = Date.now();
    const got = await within(p.evaluate(async () => {
      const lock = await navigator.wakeLock?.request('screen').catch((e) => String(e));
      await new Promise((ok) => setTimeout(ok, 1000));
      if (lock && typeof lock !== 'string') await lock.release();
      return typeof lock === 'string' ? lock : lock ? 'взята и снята' : 'нет wakeLock';
    }), 40_000);
    console.log(`  блокировка экрана: ${got} за ${Date.now() - t} мс`);
  });
  await probe('после загрузки куска', async (p) => {
    await p.goto(`${APP}/`, { timeout: 15_000 });
    const got = await within(p.evaluate(async () => {
      const r = await fetch('/api/jobs/000000-000000-zzzz/parts/0?release=1', { method: 'PUT', body: new Blob([new Uint8Array(4 * 1024 * 1024)]) });
      return r.status;
    }), 20_000);
    console.log(`  кусок 4 МБ: ${got}`);
  });
  if (process.env.E2E_SHOTS) await within(page.screenshot({ path: path.join(process.env.E2E_SHOTS, `FAIL-${name}.png`), fullPage: true }).catch(() => {}), 10_000);
}
const ctx = { page, browser, tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'vm-e2e-')), jobId: null, fires, state, branchFile, session, until, check };
let code = 0;
for (const [name, run] of segments) {
  try {
    await run(ctx);
    console.log(`ok ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e instanceof Error ? e.stack : e}`);
    await diagnose(name).catch((d) => console.log(`диагностика упала: ${d instanceof Error ? d.message : d}`));
    code = 1;
    break;
  }
}
await browser.close();
fs.rmSync(ctx.tmp, { recursive: true, force: true });
process.exit(code);
