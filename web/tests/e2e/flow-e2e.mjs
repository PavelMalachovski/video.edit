// Сквозная проверка страницы по сегментам: вход → загрузка (с продолжением после перезагрузки) → список → ….
// Нужны запущенные next start (порт 3000) и fake-github.mjs (порт 4010) — их поднимает run.sh.
// Каждый сегмент печатает `ok <имя>`; первый сбой — `FAIL <имя>` и код 1.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

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

/** Ждать, пока `fn` не вернёт истину (или не истечёт `ms`). */
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

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
] };
const FIXTURE = JSON.parse(fs.readFileSync(path.resolve('../engine/tests/fixtures/style-merge.json'), 'utf8'));
const STYLES = { ...FIXTURE.styles, sample: { ...FIXTURE.styles.sample, inserts: [{ kind: 'image', x: 70, y: 500, w: 250, question: 'logo' }] } };

/** Снимок экрана в папку E2E_SHOTS (если задана) — посмотреть вёрстку глазами. */
async function shot(page, name) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}.png`), fullPage: true });
}

// ---------- сегменты ----------

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

  ['upload', async (ctx) => {
    const { page, tmp } = ctx;
    const source = path.join(tmp, 'clip.mov');
    fs.writeFileSync(source, crypto.randomBytes(30 * 1024 * 1024));
    const insert = path.join(tmp, 'logo.png');
    fs.writeFileSync(insert, PNG);

    await page.setInputFiles('#source', source);
    await page.fill('#brief', 'ХУК: Как я учу чешский');
    await page.setInputFiles('#inserts', insert);
    await page.getByText('logo.png').waitFor();
    await shot(page, 'upload-form');
    await page.getByRole('button', { name: 'Загрузить', exact: true }).click();
    await page.getByText('Загружаю в GitHub…').waitFor();
    await shot(page, 'upload-progress');

    // ≥ 2 кусков в черновике — перезагрузить посреди загрузки
    await until(async () => ((await state()).drafts[0]?.assets.length ?? 0) >= 2, 60_000, 'два куска в черновике');
    await page.reload();
    await page.getByText('Загрузка clip.mov не закончена').waitFor();
    check(await page.inputValue('#brief') === 'ХУК: Как я учу чешский', 'ТЗ не восстановилось после перезагрузки');
    await page.setInputFiles('#source', source);
    await page.setInputFiles('#inserts', insert);
    await page.getByRole('button', { name: 'Продолжить загрузку' }).waitFor();
    await shot(page, 'upload-resume');
    await page.getByRole('button', { name: 'Продолжить загрузку' }).click();

    await page.waitForURL(/\/jobs\/\d{6}-\d{6}-[0-9a-z]{4}$/, { timeout: 120_000 });
    ctx.jobId = page.url().split('/').pop();
    const joined = Buffer.from(await (await fetch(`${FAKE}/__joined`)).arrayBuffer());
    check(sha256(joined) === sha256(fs.readFileSync(source)), 'склеенный исходник не совпал байт в байт');
    const [draft] = await fakeJson('/__dump');
    const manifest = draft.sha;
    check(manifest?.brief === 'ХУК: Как я учу чешский', `ТЗ в manifest.json: ${manifest?.brief}`);
    check(manifest?.uploads?.[0]?.asset === 'upload-i1.png', `вставка в manifest.json: ${JSON.stringify(manifest?.uploads)}`);
    const f = await fires();
    check(f.length === 1 && f[0].step === 'analyze' && f[0].attempt === 1 && f[0].job === ctx.jobId, `запуски: ${JSON.stringify(f)}`);
    const left = await page.evaluate(() => localStorage.getItem('vm:pending'));
    check(left === null, 'vm:pending не удалён');
  }],

  ['list', async (ctx) => {
    const { page } = ctx;
    await page.goto(`${APP}/`);
    const row = page.locator(`[data-job="${ctx.jobId}"]`);
    await row.getByText('Запускаю сессию…').waitFor();

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
    const waiting = { state: 'waiting_answers', phase: 'Ждёт ответов', message: 'Ответь на вопросы и выбери стиль', at: new Date().toISOString(), needs: 'answers' };
    engineValidate('status.json', waiting);
    await session(ctx, { 'questions.json': QUESTIONS, 'styles.json': STYLES, 'frame.png': PNG, 'q-logo.png': PNG, 'status.json': waiting });
    const cards = page.locator('[data-question]');
    await until(async () => (await cards.count()) === 5, 10_000, 'пять карточек вопросов');
    const go = page.getByRole('button', { name: 'Показать превью' });
    check(await go.isDisabled(), '«Показать превью» включена, хотя brand и logo без ответа');
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
    await until(async () => (await cards.count()) === 5, 10_000, 'карточки после перезагрузки');
    check(await card('hook').getByLabel('Или напиши свой').inputValue() === 'Как я снимаю reels', 'свой хук пропал');
    check(await card('stars').getByRole('button', { name: 'беспл*тно' }).getAttribute('aria-pressed') === 'false', 'снятая звёздочка вернулась');
    check(await card('brand').getByRole('button', { name: 'Copilot' }).getAttribute('aria-pressed') === 'true', 'выбор написания пропал');
    check(await card('logo').getByText('Загружено').count() > 0, 'загруженная картинка пропала');
    await shot(page, 'questions-answered');
    await page.getByRole('button', { name: 'Показать превью' }).click();
    await page.getByText('Выбери стиль').waitFor();
  }],
];

// ---------- прогон ----------

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const ctx = { page, browser, tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'vm-e2e-')), jobId: null, fires, state, branchFile, session, until, check };
let code = 0;
for (const [name, run] of segments) {
  try {
    await run(ctx);
    console.log(`ok ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e instanceof Error ? e.stack : e}`);
    code = 1;
    break;
  }
}
await browser.close();
fs.rmSync(ctx.tmp, { recursive: true, force: true });
process.exit(code);
