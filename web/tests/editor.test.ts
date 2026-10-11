import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorTabs, mountSummary, nextTab, stageWidth } from '../lib/editor.ts';

test('editor tabs: style, font, color, place, speed, then cover and A/B only when there is something to show', () => {
  const ids = (o: { cover: boolean; ab: boolean }) => editorTabs(o).map((t) => t.id);
  assert.deepEqual(ids({ cover: false, ab: false }), ['style', 'font', 'color', 'place', 'speed', 'ad']);
  assert.deepEqual(ids({ cover: true, ab: true }), ['style', 'font', 'color', 'place', 'speed', 'cover', 'ad', 'ab']);
  assert.deepEqual(editorTabs({ cover: true, ab: true }).map((t) => t.label),
    ['Стиль', 'Шрифт', 'Цвет', 'Место', 'Скорость', 'Обложка', 'Реклама', 'A/B']);
});

test('arrow keys move along the tabs and wrap, Home and End jump to the ends, other keys do nothing', () => {
  const tabs = editorTabs({ cover: false, ab: false });
  assert.equal(nextTab(tabs, 'font', 'ArrowRight'), 'color');
  assert.equal(nextTab(tabs, 'font', 'ArrowLeft'), 'style');
  assert.equal(nextTab(tabs, 'ad', 'ArrowRight'), 'style');
  assert.equal(nextTab(tabs, 'style', 'ArrowLeft'), 'ad');
  assert.equal(nextTab(tabs, 'color', 'Home'), 'style');
  assert.equal(nextTab(tabs, 'color', 'End'), 'ad');
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

test('mount summary names the variant, font and speed, then A/B and the ads version when chosen', () => {
  assert.equal(mountSummary({ variant: 'A', font: 'Montserrat', speed: 1 }), 'A · Montserrat · ×1.0');
  assert.equal(mountSummary({ variant: 'B', font: 'Rubik', speed: 1.3, ab: true, ad: true }), 'B · Rubik · ×1.3 · A/B · реклама');
});
