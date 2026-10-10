// Сквозная проверка загрузки: вход → выбор файла → куски → manifest. Нужен запущенный
// next start (порт 3000) с GITHUB_API_URL/GITHUB_UPLOADS_URL на fake-github.mjs (порт 4010).
import { createRequire } from 'node:module';
import crypto from 'node:crypto'; import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const file = process.argv[2]; const want = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const b = await chromium.launch(); const p = await b.newPage();
await p.goto('http://127.0.0.1:3000/');
if (!p.url().endsWith('/login')) throw new Error(`no redirect to login: ${p.url()}`);
await p.fill('#password', 'wrong'); await p.click('button[type=submit]');
if (!(await p.textContent('body')).includes('Неверный пароль')) throw new Error('wrong password accepted');
await p.fill('#password', 'pw'); await p.click('button[type=submit]'); await p.waitForURL('http://127.0.0.1:3000/');
await p.setInputFiles('input[type=file]', file);
await p.click('text=Загрузить');
await p.waitForSelector('.okc', { timeout: 120000 });
console.log('report:', await p.textContent('.okc'));
const joined = Buffer.from(await (await fetch('http://127.0.0.1:4010/__joined')).arrayBuffer());
const got = crypto.createHash('sha256').update(joined).digest('hex');
const dump = await (await fetch('http://127.0.0.1:4010/__dump')).json();
console.log('assets:', dump[0].assets.length, 'manifest parts:', dump[0].sha?.parts, 'retries:', dump[0].sha?.retries, 'sha ok:', got === want);
const api = await p.request.get('http://127.0.0.1:3000/api/jobs'); console.log('jobs api:', JSON.stringify(await api.json()));
await b.close();
if (got !== want) process.exit(1);
