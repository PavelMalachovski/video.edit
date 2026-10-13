// Playwright для тестов шаблона и рендера кадров. ES-модули не видят NODE_PATH, поэтому сначала
// ищем пакет рядом (template/node_modules), потом — в глобальных пакетах npm. Браузер не скачиваем:
// он уже лежит в PLAYWRIGHT_BROWSERS_PATH (в облаке — /opt/pw-browsers).
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ??= '1';

const require = createRequire(import.meta.url);

function playwright() {
  try {
    return require('playwright');
  } catch {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(root, 'playwright'));
  }
}

/** Chromium без окна. Закрывает вызвавший: `await browser.close()`. */
export function launch() {
  return playwright().chromium.launch();
}

/** WebKit без окна — движок Safari: так превью рисуется на iPhone Павла (тест «Safari ≈ Chromium»). */
export function launchWebkit() {
  return playwright().webkit.launch();
}

/** Страница размером с кадр ролика, 1 px страницы = 1 px кадра. */
export function framePage(browser) {
  return browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
}
