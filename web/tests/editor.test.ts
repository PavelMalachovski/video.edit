import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorTabs, mountSummary, nextTab, stageFit, stageWidth } from '../lib/editor.ts';

test('editor tabs: style, font, color, place, speed, the cover when there are frames, and versions (ads, A/B) last', () => {
  const ids = (cover: boolean) => editorTabs({ cover }).map((t) => t.id);
  assert.deepEqual(ids(false), ['style', 'font', 'color', 'place', 'speed', 'versions']);
  assert.deepEqual(ids(true), ['style', 'font', 'color', 'place', 'speed', 'cover', 'versions']);
  assert.deepEqual(editorTabs({ cover: true }).map((t) => t.label), ['Стиль', 'Шрифт', 'Цвет', 'Место', 'Скорость', 'Обложка', 'Версии']);
});

test('arrow keys move along the tabs and wrap, Home and End jump to the ends, other keys do nothing', () => {
  const tabs = editorTabs({ cover: false });
  assert.equal(nextTab(tabs, 'font', 'ArrowRight'), 'color');
  assert.equal(nextTab(tabs, 'font', 'ArrowLeft'), 'style');
  assert.equal(nextTab(tabs, 'versions', 'ArrowRight'), 'style');
  assert.equal(nextTab(tabs, 'style', 'ArrowLeft'), 'versions');
  assert.equal(nextTab(tabs, 'color', 'Home'), 'style');
  assert.equal(nextTab(tabs, 'color', 'End'), 'versions');
  assert.equal(nextTab(tabs, 'color', 'Enter'), null);
  assert.equal(nextTab(tabs, 'cover', 'ArrowRight'), 'style'); // вкладки уже нет — к первой
});

test('preview width follows the stage height at 9:16, from 160 to 270 px', () => {
  assert.equal(stageWidth(480), 270);
  assert.equal(stageWidth(600), 270);
  assert.equal(stageWidth(400), 225);
  assert.equal(stageWidth(357), 200);
  assert.equal(stageWidth(100), 160);
  assert.equal(stageWidth(Number.NaN), 270);
});

test('stage fits the screen: sticky with 220 px for the tools when it stays 340+ px tall, otherwise full size and not sticky', () => {
  assert.deepEqual(stageFit(844), { height: 500, sticky: true, width: 270 });
  assert.deepEqual(stageFit(1200), { height: 500, sticky: true, width: 270 });
  assert.deepEqual(stageFit(667), { height: 391, sticky: true, width: 208 });
  assert.deepEqual(stageFit(664), { height: 388, sticky: true, width: 207 });
  assert.deepEqual(stageFit(616), { height: 340, sticky: true, width: 180 });
  assert.deepEqual(stageFit(615), { height: 500, sticky: false, width: 270 }); // низкий экран: превью целиком, листаем как раньше
  assert.deepEqual(stageFit(390), { height: 500, sticky: false, width: 270 }); // телефон лёжа
  assert.deepEqual(stageFit(Number.NaN), { height: 500, sticky: false, width: 270 });
});

test('mount summary names the variant, font and speed, then A/B and the ads version when chosen', () => {
  assert.equal(mountSummary({ variant: 'A', font: 'Montserrat', speed: 1 }), 'A · Montserrat · ×1.0');
  assert.equal(mountSummary({ variant: 'B', font: 'Rubik', speed: 1.3, ab: true, ad: true }), 'B · Rubik · ×1.3 · A/B · реклама');
});
