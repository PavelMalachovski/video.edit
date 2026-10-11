// Редактор превью («Монтажка»): вкладки настроек под сценой, ход по ним с клавиатуры, ширина крупного превью по
// высоте сцены и строка выбора, которую называет «Монтировать».

export type TabId = 'style' | 'font' | 'color' | 'place' | 'speed' | 'cover' | 'ad' | 'ab';
export type Tab = { id: TabId; label: string };

/** Вкладки по порядку: «Обложка» — если Claude дал кадры обложки, «A/B» — если есть что сравнить. */
export function editorTabs(o: { cover: boolean; ab: boolean }): Tab[] {
  const tabs: Tab[] = [
    { id: 'style', label: 'Стиль' },
    { id: 'font', label: 'Шрифт' },
    { id: 'color', label: 'Цвет' },
    { id: 'place', label: 'Место' },
    { id: 'speed', label: 'Скорость' },
  ];
  if (o.cover) tabs.push({ id: 'cover', label: 'Обложка' });
  tabs.push({ id: 'ad', label: 'Реклама' });
  if (o.ab) tabs.push({ id: 'ab', label: 'A/B' });
  return tabs;
}

/** Клавиша на вкладке → какую открыть: стрелки — по кругу, Home и End — к краям; другая клавиша — null.
 *  Вкладки, с которой ушли, уже нет (например, пропала обложка) — стрелки ведут к первой. */
export function nextTab(tabs: Tab[], current: TabId, key: string): TabId | null {
  const n = tabs.length;
  const i = tabs.findIndex((t) => t.id === current);
  if (key === 'Home') return tabs[0].id;
  if (key === 'End') return tabs[n - 1].id;
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return null;
  if (i < 0) return tabs[0].id;
  return tabs[(i + (key === 'ArrowRight' ? 1 : n - 1)) % n].id;
}

/** Ширина крупного превью в px экрана: кадр 9:16 по высоте сцены, от 160 до 270 (270 — как было до редактора). */
export const STAGE_W = { min: 160, max: 270 } as const;

export function stageWidth(height: number): number {
  if (!Number.isFinite(height)) return STAGE_W.max;
  return Math.min(STAGE_W.max, Math.max(STAGE_W.min, Math.floor((height * 9) / 16)));
}

/** Строка выбора под сценой: вариант, шрифт, скорость; A/B и версия для рекламы — если выбраны. */
export function mountSummary(o: { variant: string; font: string; speed: number; ab?: boolean; ad?: boolean }): string {
  return [o.variant, o.font, `×${o.speed.toFixed(1)}`, ...(o.ab ? ['A/B'] : []), ...(o.ad ? ['реклама'] : [])].join(' · ');
}
