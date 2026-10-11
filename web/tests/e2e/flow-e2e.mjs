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
  { id: 'stickers', type: 'multi', title: 'Стикеры-тезисы', body: 'Поставлю на ключевые мысли — сними лишние.',
    options: [{ id: 's1', label: '0:12 — «3 ошибки 🔥»' }], default: ['s1'] },
  { id: 'end', type: 'choice', title: 'Финальная карточка', body: 'Последние 2 секунды: призыв, твой ник и логотип.',
    options: [{ id: 'e1', label: '«Подпишись, чтобы не пропустить 👇»' }, { id: 'own', label: 'Свой' }, { id: 'none', label: 'Не надо' }], default: 'e1' },
  { id: 'teaser', type: 'choice', title: 'Начать с самой сильной фразы?', body: '«Учу по 15 минут в день» звучит на 0:21.',
    options: [{ id: 'yes', label: 'Да: «Учу по 15 минут в день»' }, { id: 'no', label: 'Нет' }], default: 'yes' },
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
    await page.getByRole('link', { name: 'Мои видео' }).click();
    await page.waitForURL(`${APP}/`);
  }],

  ['upload', async (ctx) => {
    const { page, tmp } = ctx;
    const source = path.join(tmp, 'clip.mov');
    fs.writeFileSync(source, crypto.randomBytes(30 * 1024 * 1024));
    const insert = path.join(tmp, 'logo.png');
    fs.writeFileSync(insert, PNG);
    // озвучка: своя запись голоса, два куска; буфером — путь с кириллицей Playwright молча не ставит в поле
    const voice = { name: 'Запись.m4a', mimeType: 'audio/x-m4a', buffer: crypto.randomBytes(5 * 1024 * 1024) };

    await page.setInputFiles('#source', source);
    await page.fill('#brief', 'ХУК: Как я учу чешский');
    await page.setInputFiles('#inserts', insert);
    await page.getByText('logo.png').waitFor();
    await page.setInputFiles('#voice', voice);
    await page.getByText('Запись.m4a').waitFor();
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
    await page.setInputFiles('#voice', voice);
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
    engineValidate('review.json', REVIEW);
    const waiting = { state: 'waiting_answers', phase: 'Ждёт ответов', message: 'Ответь на вопросы и выбери стиль', at: new Date().toISOString(), needs: 'answers' };
    engineValidate('status.json', waiting);
    await session(ctx, { 'questions.json': QUESTIONS, 'styles.json': STYLES, 'review.json': REVIEW, 'frame.png': PNG, 'q-logo.png': PNG, 'cover-1.jpg': PNG, 'cover-2.jpg': PNG, 'cover-3.jpg': PNG, 'status.json': waiting });
    const cards = page.locator('[data-question]');
    await until(async () => (await cards.count()) === 8, 10_000, 'восемь карточек вопросов');
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
    await until(async () => (await cards.count()) === 8, 10_000, 'карточки после перезагрузки');
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
    // редактор: над вкладками — крупное превью, на вкладке «Стиль» — три миниатюры; обложка — на своей вкладке
    await until(async () => (await page.locator('iframe[data-spec]').count()) === 4, 10_000, 'три миниатюры и крупное превью');
    const tab = (name) => page.getByRole('tab', { name, exact: true });
    check(await tab('Стиль').getAttribute('aria-selected') === 'true', 'первая вкладка — не «Стиль»');
    const big = page.locator('iframe[data-big]');
    const bigSpec = async () => JSON.parse(await big.getAttribute('data-spec'));
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
    await coverCard.getByRole('button', { name: 'Кадр 3' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await coverCard.getByRole('button', { name: 'Кадр 3' }).click();
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
    const copied = await page.evaluate(() => navigator.clipboard.readText());
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
];

// ---------- прогон ----------

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] })).newPage(); // контекст — чтобы открыть вторую вкладку с тем же входом
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
