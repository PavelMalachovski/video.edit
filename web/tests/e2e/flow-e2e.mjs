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

import { finalStyle } from '../../lib/style.ts';

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
    await page.getByRole('link', { name: '← Мои видео' }).click();
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
    // задача взяла копию бренда: job.json.brand и логотип в своей папке
    const job = JSON.parse((await branchFile(ctx, 'job.json')) ?? '{}');
    check(job.brand?.handle === '@pavel.malakhouski' && job.brand?.logo === 'in/brand/logo.png', `job.json.brand: ${JSON.stringify(job.brand)}`);
    check((await branchFile(ctx, 'in/brand/logo.png')) !== null, 'логотип бренда не скопирован в задачу');
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

  ['previews', async (ctx) => {
    const { page } = ctx;
    await until(async () => (await page.locator('iframe[data-spec]').count()) === 4, 10_000, 'три миниатюры и крупное превью');
    const big = page.locator('iframe[data-big]');
    const bigSpec = async () => JSON.parse(await big.getAttribute('data-spec'));
    await page.getByRole('button', { name: /^B · / }).click();
    await page.getByRole('button', { name: 'Rubik', exact: true }).click();
    await page.getByRole('button', { name: 'Marck Script', exact: true }).click();
    await page.getByLabel('Своя подсветка').fill('#00aaff');
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
        inserts: [...STYLES.sample.inserts, { kind: 'image', src: 'q-logo.png', x: 600, y: 900, w: 250 }], // вставка из ТЗ: её размер меняет Павел
      },
      variants: STYLES.variants.map((v) => ({ ...v, label: `${v.label} — без плашки` })),
      fonts: { main: ['montserrat', 'unbounded', 'rubik', 'oswald', 'comfortaa'], hand: ['caveat', 'bad-script'] },
    };
    engineValidate('styles.json', restyled);
    await session(ctx, { 'styles.json': restyled, 'status.json': { state: 'waiting_answers', phase: 'Ждёт ответов', message: 'Три новых стиля', at: new Date().toISOString(), needs: 'answers' } });
    await page.getByRole('button', { name: /^A · .*без плашки/ }).waitFor({ timeout: 10_000 });
    check(await page.getByRole('button', { name: /^A · / }).getAttribute('aria-pressed') === 'true', 'после restyle выбор не сброшен к A');
    await page.getByRole('button', { name: 'Montserrat', exact: true }).waitFor();
    for (const lacking of ['Russo One', 'Marck Script']) {
      check(await page.getByRole('button', { name: lacking, exact: true }).count() === 0, `${lacking} без «ț» предложен Павлу`);
    }
    await shot(page, 'previews-romanian');

    await page.getByRole('button', { name: /^B · / }).click();
    await page.getByRole('button', { name: 'Rubik', exact: true }).click();
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
    await shot(page, 'previews-insert-moved');
    await shot(page, 'previews-resized');
    await shot(page, 'previews-subtitles-moved');
    check(await page.getByRole('button', { name: '×1.1', exact: true }).getAttribute('aria-pressed') === 'true', 'скорость по умолчанию не ×1.1');
    await page.getByRole('button', { name: '×1.3', exact: true }).click();
    const go = page.getByRole('button', { name: /^Монтировать: B · Rubik · ×1\.3/ });
    await go.waitFor();
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
    check(answers.style?.subSize === grown - 4 && answers.style?.hookSize === pinched, `размеры: ${answers.style?.subSize}, ${answers.style?.hookSize}`);
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
    };
    engineValidate('result.json', result);
    const v1 = crypto.randomBytes(48 * 1024);
    await asset('final.mp4', v1);
    await asset('final.srt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nпривет\n\n'));
    await session(ctx, { 'result.json': result, 'status.json': { state: 'rendered', phase: 'Загружаю', message: 'Ролик собран, загружаю', at: iso() },
      'out/released.json': await released(['final.mp4', 'final.srt']) });
    await page.getByText('Что я сделал').waitFor({ timeout: 7000 });
    check(await page.getByRole('heading', { name: 'Готово' }).count() === 1, 'нет заголовка «Готово»');
    check((await page.textContent('body')).includes('было 1:42 → стало 1:16 · стиль B'), 'нет строки «было → стало · стиль»');
    await shot(page, 'result');

    const got = await page.request.get(`${APP}/api/jobs/${ctx.jobId}/download?name=final.mp4`, { maxRedirects: 0 });
    check(got.status() === 302 && /\/__blob\/\d+$/.test(got.headers().location ?? ''), `скачивание: ${got.status()} ${got.headers().location}`);
    const bytes = Buffer.from(await (await fetch(got.headers().location)).arrayBuffer());
    check(bytes.equals(v1), 'скачанный ролик не совпал байт в байт');

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
];

// ---------- прогон ----------

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage(); // контекст — чтобы открыть вторую вкладку с тем же входом
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
