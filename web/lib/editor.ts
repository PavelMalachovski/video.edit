// Редактор превью («Монтажка»): вкладки настроек под сценой, ход по ним с клавиатуры, высота сцены и ширина крупного
// превью по высоте экрана и строка выбора, которую называет «Монтировать».

export type TabId = 'style' | 'font' | 'color' | 'place' | 'speed' | 'cover' | 'versions';
export type Tab = { id: TabId; label: string };

/** Вкладки по порядку: «Обложка» — если Claude дал кадры обложки; «Версии» — версия для рекламы и A/B-тест. */
export function editorTabs(o: { cover: boolean }): Tab[] {
  const tabs: Tab[] = [
    { id: 'style', label: 'Стиль' },
    { id: 'font', label: 'Шрифт' },
    { id: 'color', label: 'Цвет' },
    { id: 'place', label: 'Место' },
    { id: 'speed', label: 'Скорость' },
  ];
  if (o.cover) tabs.push({ id: 'cover', label: 'Обложка' });
  tabs.push({ id: 'versions', label: 'Версии' });
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

/** Ширина крупного превью в px экрана: кадр 9:16 по высоте, от 160 до 270 (270 — как было до редактора). */
export const STAGE_W = { min: 160, max: 270 } as const;

export function stageWidth(height: number): number {
  if (!Number.isFinite(height)) return STAGE_W.max;
  return Math.min(STAGE_W.max, Math.max(STAGE_W.min, Math.floor((height * 9) / 16)));
}

/** Сцена: тулбар над ней, полоса инструментов под ней, высота сцены (превью — на `pad` ниже), не ниже `min`. */
export const STAGE = { toolbar: 56, tools: 220, min: 340, max: 500, pad: 20 } as const;

/**
 * Сцена по высоте экрана: если под тулбаром и сценой не ниже 340 px остаётся 220 px на инструменты — сцена липнет
 * к верху (превью на виду, пока листают настройки); экран ниже (iPhone SE, телефон лёжа) — сцена во всю высоту и не липнет:
 * листаем, как раньше. Непонятная высота — как на низком экране.
 */
export function stageFit(viewport: number): { height: number; sticky: boolean; width: number } {
  const room = Number.isFinite(viewport) ? Math.floor(viewport) - STAGE.toolbar - STAGE.tools : -1;
  const height = room >= STAGE.min ? Math.min(STAGE.max, room) : STAGE.max;
  return { height, sticky: room >= STAGE.min, width: stageWidth(height - STAGE.pad) };
}

/** Строка выбора под сценой: вариант, шрифт, скорость; A/B и версия для рекламы — если выбраны. */
export function mountSummary(o: { variant: string; font: string; speed: number; ab?: boolean; ad?: boolean }): string {
  return [o.variant, o.font, `×${o.speed.toFixed(1)}`, ...(o.ab ? ['A/B'] : []), ...(o.ad ? ['реклама'] : [])].join(' · ');
}
