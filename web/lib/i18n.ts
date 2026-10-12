// Тексты редактора (бета) на русском и английском; язык — выбор Павла, помнится в localStorage['vm:lang'].
// Старый поток (вопросы, «Превью») — по-русски, как был.

export const LANGS = ['ru', 'en'] as const;
export type Lang = (typeof LANGS)[number];

const ru = {
  beta: 'бета',
  back: 'К задаче',
  editor: 'Редактор',
  mount: 'Монтировать',
  mountHint: 'Монтаж пока запускается со старого экрана: вопросы и «Превью»',
  toFlow: 'К вопросам и превью',
  play: 'Пуск',
  pause: 'Пауза',
  zoomIn: 'Крупнее',
  zoomOut: 'Мельче',
  language: 'Язык',
  video: 'Видео',
  voice: 'Голос',
  music: 'Музыка',
  subtitles: 'Субтитры',
  text: 'Текст',
  inserts: 'Вставки',
  hook: 'Хук',
  accent: 'Акцент',
  cta: 'Титр',
  teaser: 'Тизер',
  piece: 'Кусок',
  bw: 'Ч/б',
  cutPart: 'Вырезано {s}',
  noMusic: 'Без музыки — её выберет монтаж по ответам',
  readOnly: 'Черновик монтажа — только просмотр. Резать и двигать на дорожках — в следующей версии.',
  noDraft: 'Черновика монтажа ещё нет: он появится, когда Claude разберёт видео',
  noProxy: 'Видео для редактора ещё готовится — появится через пару минут после анализа',
  oldJob: 'У этой задачи нет видео для редактора: она разобрана до него',
  longSource: 'Исходник длиннее двух часов — видео для редактора не делалось; дорожки — без него',
  loading: 'Загружаю…',
  error: 'Не загрузилось: {e}',
  duration: 'Ролик {s}',
  source: 'Исходник {s}',
  seconds: '{n} с',
  previewNote: 'Текст на кадре — примерно; точно его нарисует монтаж',
  style: 'Стиль',
  font: 'Шрифт',
  hand: 'Рукописный',
  colors: 'Цвета',
  accentColor: 'Подсветка слова',
  textColor: 'Текст',
  barColor: 'Шкала времени',
  own: 'Свой',
  shade: 'Затемнение под субтитрами',
  shadeOff: 'нет',
  styleShared: 'Выбор общий с экраном «Превью»: «Монтировать» возьмёт его.',
  styleLocked: 'Ролик уже смонтирован в этом стиле. Поменять стиль — при следующем монтаже из редактора.',
  draft: 'Черновик',
  sample: 'Кадр-образец: черновика монтажа ещё нет',
};

const en: Record<keyof typeof ru, string> = {
  beta: 'beta',
  back: 'Back to the job',
  editor: 'Editor',
  mount: 'Render',
  mountHint: 'For now, rendering starts from the old screen: questions and “Preview”',
  toFlow: 'To questions and preview',
  play: 'Play',
  pause: 'Pause',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  language: 'Language',
  video: 'Video',
  voice: 'Voice',
  music: 'Music',
  subtitles: 'Subtitles',
  text: 'Text',
  inserts: 'Inserts',
  hook: 'Hook',
  accent: 'Accent',
  cta: 'Call to action',
  teaser: 'Teaser',
  piece: 'Piece',
  bw: 'B/W',
  cutPart: 'Cut {s}',
  noMusic: 'No music yet — the render picks it from the answers',
  readOnly: 'Draft edit — view only. Cutting and moving on the tracks comes in the next version.',
  noDraft: 'No draft edit yet: it appears once Claude has gone through the video',
  noProxy: 'The editor video is still being made — it appears a couple of minutes after the analysis',
  oldJob: 'This job has no editor video: it was analysed before the editor existed',
  longSource: 'The source is longer than two hours, so there is no editor video; the tracks are shown without it',
  loading: 'Loading…',
  error: 'Failed to load: {e}',
  duration: 'Video {s}',
  source: 'Source {s}',
  seconds: '{n} s',
  previewNote: 'Text on the frame is approximate; the render draws it exactly',
  style: 'Style',
  font: 'Font',
  hand: 'Handwriting',
  colors: 'Colours',
  accentColor: 'Word highlight',
  textColor: 'Text',
  barColor: 'Progress bar',
  own: 'Custom',
  shade: 'Shade under the subtitles',
  shadeOff: 'off',
  styleShared: 'Shared with the “Preview” screen: “Render” takes it.',
  styleLocked: 'The video is already rendered in this style. Changing it comes with the next render from the editor.',
  draft: 'Draft',
  sample: 'Sample frame: no draft edit yet',
};

export type Key = keyof typeof ru;
export const DICT: Record<Lang, Record<Key, string>> = { ru, en };

/** Текст `key` на языке `lang`; `{дырки}` — из `vars`. */
export function tr(lang: Lang, key: Key, vars: Record<string, string | number> = {}): string {
  return DICT[lang][key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const LANG_KEY = 'vm:lang';
export const isLang = (x: unknown): x is Lang => (LANGS as readonly unknown[]).includes(x);

export function loadLang(storage: Storage | null): Lang {
  try {
    const v = storage?.getItem(LANG_KEY);
    return isLang(v) ? v : 'ru';
  } catch {
    return 'ru';
  }
}

export function saveLang(storage: Storage | null, lang: Lang): void {
  try {
    storage?.setItem(LANG_KEY, lang);
  } catch {
    // нет хранилища — язык живёт до перезагрузки
  }
}
