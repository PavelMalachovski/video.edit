import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Светлая тема сайта (app/globals.css): палитра — та же, что у редактора (.ed); контраст — по WCAG AA там, где цвет
// стоит; лайм — только заливка; ничто вне редактора не возвращает тёмную схему: у iframe слоя превью появилась бы
// непрозрачная белая подложка (Chromium и WebKit), и кадр под слоем пропал бы.
const CSS = fs.readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const LAYOUT = fs.readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');

/** Свойства `--имя` и color-scheme блока `selector { … }` (с начала строки). */
function block(selector: string): Record<string, string> {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `нет блока ${selector}`);
  const body = CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const root = block(':root');
const ed = block('.ed');

/** Цвет #RRGGBB: сам цвет, токен `--x` или `var(--x)` (у .ed — его токены, потом :root). */
function hex(v: string, scope: Record<string, string> = root): string {
  const name = /^(?:var\()?(--[\w-]+)\)?$/.exec(v)?.[1];
  const value = name ? (scope[name] ?? root[name]) : v;
  assert.ok(value, `нет токена ${v}`);
  return value.startsWith('var(') ? hex(value, scope) : value.toUpperCase();
}

/** Контраст по WCAG 2.x. */
function ratio(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex(h).slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('the site is light and uses the editor palette', () => {
  assert.equal(root['color-scheme'], 'light');
  const same: [string, string][] = [['--bg', '--e-bg'], ['--panel', '--e-surface'], ['--panel-2', '--e-sunk'], ['--hover', '--e-hover'],
    ['--line', '--e-line'], ['--line-strong', '--e-line-strong'], ['--text', '--e-ink'], ['--muted', '--e-muted'], ['--accent', '--e-accent'],
    ['--ink', '--e-accent-ink'], ['--select', '--e-select'], ['--stage', '--e-stage'], ['--frame', '--e-frame']];
  for (const [site, editor] of same) assert.equal(hex(site), hex(editor, ed), `${site} ≠ ${editor}`);
});

test('text and controls meet WCAG AA where they sit', () => {
  const TEXT = 4.5;
  const UI = 3; // рамки полей, точки шагов, полоса, фокус, ручки — SC 1.4.11
  const pairs: [string, string, number, string][] = [
    ['--text', '--bg', TEXT, 'текст на странице'], ['--text', '--hover', TEXT, 'текст на наведённом'],
    ['--muted', '--bg', TEXT, 'приглушённый на странице'], ['--muted', '--panel-2', TEXT, 'приглушённый в строке видео'],
    ['--muted', '--hover', TEXT, 'счётчик «Мои видео»'], ['--muted', '--warn-soft', TEXT, 'пояснение в «застрял»'],
    ['--dim', '--panel-2', TEXT, 'второстепенный текст'], ['#6B7067', '--panel', TEXT, 'подсказка в поле'],
    ['--ink', '--accent', TEXT, 'главная кнопка'], ['--ink', '--accent-hover', TEXT, 'главная кнопка под мышью'],
    ['--accent', '--text', UI, 'значок логотипа'],
    ['--select', '--bg', TEXT, 'ссылка на странице'], ['--select', '--panel', TEXT, 'ссылка, номер вопроса, хэштеги'],
    ['--select', '--warn-soft', TEXT, 'ссылка в «застрял»'], ['--select-hover', '--bg', TEXT, 'ссылка под мышью'],
    ['#FFFFFF', '--select', TEXT, 'подпись выбранного кадра, уголок ⤢'], ['#FFFFFF', '--text', TEXT, 'нажатые чипы, шрифты, переключатели'],
    ['--bad', '--bg', TEXT, 'ошибка на странице'], ['--bad', '--panel-2', TEXT, 'ошибка в строке видео'], ['--bad', '--bad-soft', TEXT, 'чип «Ошибка»'],
    ['#FFFFFF', '--bad', TEXT, '✗ в чек-листе'],
    ['--ok', '--bg', TEXT, '«Сохранено»'], ['--ok', '--ok-soft', TEXT, 'чип «Готово»'], ['#FFFFFF', '--ok', TEXT, '✓ в чек-листе'],
    ['--warn', '--bg', TEXT, 'предупреждение на странице'], ['--warn', '--panel-2', TEXT, 'предупреждение в строке видео'],
    ['--warn', '--warn-soft', TEXT, 'чип «Ждёт ответов», заголовок «застрял»'], ['--warn', '--warn-fill', TEXT, '! в разборе'],
    ['--field', '--panel', UI, 'рамка поля'], ['--field', '--bg', UI, 'пунктир выбора видео, точка шага'],
    ['--select', '--line', UI, 'полоса загрузки'], ['--select', '--bg', UI, 'фокус, выбранное'], ['--ok', '--bg', UI, 'пройденный шаг'],
    ['--select', '--frame', UI, 'ручки на тёмном кадре'],
  ];
  const low = pairs.map(([fg, bg, min, where]) => ({ fg, bg, min, where, got: ratio(fg, bg) })).filter((p) => p.got < p.min);
  assert.deepEqual(low.map((p) => `${p.where}: ${p.fg} на ${p.bg} — ${p.got.toFixed(2)} < ${p.min}`), []);
});

test('lime is only a fill: no text, border or ring in --accent', () => {
  const uses = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) => /(?<![\w-])(color|border(-[\w-]+)?|outline(-color)?|box-shadow)\s*:[^;]*var\(--accent\)/.test(body))
    .map(([, selector]) => selector.trim().split('\n').pop()!.trim());
  assert.deepEqual(uses, ['.logo-mark']); // лайм-значок на тёмном квадрате — 14:1
});

test('no dark colour scheme outside the editor: the layer iframe would get an opaque white backdrop', () => {
  assert.ok(!/color-scheme:\s*[^;]*dark/.test(CSS), 'color-scheme: dark в globals.css');
  assert.match(CSS, /\.preview > iframe \{[^}]*color-scheme: normal;/);
});

test('no dark-theme literals are left', () => {
  for (const old of ['#0B0C0F', '#15171C', '#1E2127', '#25E2EE', '#101216', '#12151A', '#7D8390']) assert.ok(!CSS.toUpperCase().includes(old), old);
});

test('the browser bar matches the page: theme-color is --bg, colour scheme light', () => {
  assert.match(LAYOUT, new RegExp(`themeColor: '${hex('--bg')}'`, 'i'));
  assert.match(LAYOUT, /colorScheme: 'light'/);
});
