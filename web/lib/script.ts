// Сценарий до съёмки (гайд Meta «Всё о Reels»): запрос с экрана «Новый сценарий» (job.json.script), сценарий от сессии
// (script.json, схема engine/vm/schemas/script.json) и ТЗ загрузки по нему («Снять по сценарию»).
import { parseCaption, type Caption } from './caption.ts';
import type { JobFile } from './jobfiles.ts';

export const GOALS = [
  { id: 'followers', label: 'Подписчики' },
  { id: 'sales', label: 'Продажи' },
  { id: 'leads', label: 'Заявки' },
  { id: 'reach', label: 'Охват' },
] as const;
/** Восемь типов историй гайда и «на выбор Claude». */
export const STORIES = [
  { id: 'any', label: 'На выбор Claude' },
  { id: 'photodump', label: 'Фотодамп' },
  { id: 'which_type', label: '«Какой вы…?»' },
  { id: 'facts', label: 'Перечень фактов' },
  { id: 'transitions', label: 'Переходы' },
  { id: 'tutorial', label: 'Обучающий' },
  { id: 'before_after', label: 'До и после' },
  { id: 'pov', label: 'POV' },
  { id: 'behind', label: 'За кадром' },
] as const;
export const LENGTHS = [15, 30, 60, 90] as const;
/** Языки кнопками; можно написать свой — сессия поймёт его как строку «ЯЗЫК:» в ТЗ. */
export const LANGUAGES = ['русский', 'английский', 'чешский', 'украинский'] as const;
/** Пять приёмов хука из гайда. */
export const TECHNIQUES = { value: 'Польза', engage: 'Вовлечение', emotion: 'Эмоция', sound: 'Звук', motion: 'Движение камеры' } as const;
/** Части ролика по гайду: зацепить → удержать → вознаградить. */
export const PARTS = { hook: 'Зацепить', hold: 'Удержать', reward: 'Вознаградить' } as const;
export const TOPIC = { min: 3, max: 300 };
export const MAX_LANGUAGE = 40;
const MAX_NAME = 80;

export type Goal = (typeof GOALS)[number]['id'];
export type StoryChoice = (typeof STORIES)[number]['id'];
export type Story = Exclude<StoryChoice, 'any'>;
export type ScriptRequest = { topic: string; goal: Goal; story: StoryChoice; length: (typeof LENGTHS)[number]; language: string };
export type Hook = { technique: keyof typeof TECHNIQUES; text: string; frame?: string };
export type Scene = { part: keyof typeof PARTS; t0: number; t1: number; say: string; screen: string; frame: string; sound?: string };
export type Script = { story: Story; hooks: Hook[]; scenes: Scene[]; cta: string; tips: string[]; caption: Caption };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const ids = (list: readonly { id: string }[]): readonly string[] => list.map((x) => x.id);

/** Тело формы «Новый сценарий» → запрос; не то — `{error}` с полем в начале, по-русски. */
export function parseScriptRequest(body: unknown): ScriptRequest | { error: string } {
  if (!isObject(body)) return { error: 'нужен JSON с темой' };
  const topic = isStr(body.topic) ? body.topic.trim() : '';
  if (topic.length < TOPIC.min || topic.length > TOPIC.max) return { error: `topic: тема — от ${TOPIC.min} до ${TOPIC.max} знаков` };
  if (!ids(GOALS).includes(body.goal as string)) return { error: `goal: цель — ${GOALS.map((g) => g.label.toLowerCase()).join(', ')}` };
  if (!ids(STORIES).includes(body.story as string)) return { error: 'story: такого типа истории нет' };
  if (!(LENGTHS as readonly unknown[]).includes(body.length)) return { error: `length: длина — ${LENGTHS.join(', ')} с` };
  const language = isStr(body.language) ? body.language.trim() : '';
  if (!language || language.length > MAX_LANGUAGE) return { error: 'language: напиши язык ролика' };
  return { topic, goal: body.goal as Goal, story: body.story as StoryChoice, length: body.length as ScriptRequest['length'], language };
}

/** job.json задачи-сценария: видео нет, запрос — в `script`; имя — «Сценарий: <тема>» (до 80 знаков). */
export function buildScriptJob(id: string, req: ScriptRequest, now: Date): JobFile {
  const full = `Сценарий: ${req.topic}`;
  const name = [...full].length > MAX_NAME ? `${[...full].slice(0, MAX_NAME - 1).join('').trimEnd()}…` : full;
  return { id, name, size: 0, type: '', duration: null, createdAt: now.toISOString(), brief: '', uploads: [], runs: [], kind: 'script', script: req };
}

const isHook = (h: unknown): h is Hook =>
  isObject(h) && Object.hasOwn(TECHNIQUES, h.technique as string) && isStr(h.text) && h.text !== '' && (h.frame === undefined || isStr(h.frame));
const isScene = (c: unknown): c is Scene =>
  isObject(c) && Object.hasOwn(PARTS, c.part as string) && isNum(c.t0) && isNum(c.t1) && isStr(c.say) && isStr(c.screen) && isStr(c.frame)
  && (c.sound === undefined || isStr(c.sound));

/** script.json → сценарий; не та форма — null (экран скажет, что сценария нет). */
export function parseScript(raw: unknown): Script | null {
  if (!isObject(raw)) return null;
  const { story, hooks, scenes, cta, tips } = raw;
  const caption = parseCaption(raw.caption);
  const ok = ids(STORIES).includes(story as string) && story !== 'any' && Array.isArray(hooks) && hooks.length === 3 && hooks.every(isHook)
    && Array.isArray(scenes) && scenes.length > 0 && scenes.every(isScene) && isStr(cta) && cta !== ''
    && Array.isArray(tips) && tips.every(isStr) && caption !== null;
  return ok ? (raw as Script) : null;
}

/** ТЗ загрузки по сценарию: хук, который выбрал Павел (`hook` — номер; нет такого — первый), тезисы — тексты на экране
 *  из «удержать», призыв и язык. Эти строки понимает сессия (SKILL.md: `ХУК:`, `ТЕЗИСЫ:`, `ПРИЗЫВ:`, `ЯЗЫК:`). */
export function scriptBrief(s: Script, language: string | null, hook = 0): string {
  const theses = s.scenes.filter((c) => c.part === 'hold' && c.screen.trim()).map((c) => c.screen.trim());
  return [
    `ХУК: ${(s.hooks[hook] ?? s.hooks[0]).text}`,
    ...(theses.length ? [`ТЕЗИСЫ: ${theses.join('; ')}`] : []),
    `ПРИЗЫВ: ${s.cta}`,
    ...(language ? [`ЯЗЫК: ${language}`] : []),
  ].join('\n');
}

// ---------- ТЗ для следующей загрузки (localStorage['vm:brief']) ----------

const BRIEF_KEY = 'vm:brief';

const BRIEF_TTL = 24 * 3600_000; // ТЗ сценария ждёт сутки: незаконченная загрузка не подставит его через неделю

export function saveNextBrief(storage: Storage | null, text: string, now = Date.now()): void {
  try {
    storage?.setItem(BRIEF_KEY, JSON.stringify({ text, at: now }));
  } catch {
    // нет хранилища — ТЗ придётся вставить руками
  }
}

/** ТЗ, которое ждёт экран загрузки; читается один раз, старше суток — нет. */
export function takeNextBrief(storage: Storage | null, now = Date.now()): string | null {
  try {
    const raw = storage?.getItem(BRIEF_KEY) ?? null;
    storage?.removeItem(BRIEF_KEY);
    const saved = raw === null ? null : (JSON.parse(raw) as { text?: unknown; at?: unknown });
    const fresh = saved && typeof saved.text === 'string' && typeof saved.at === 'number' && now - saved.at <= BRIEF_TTL;
    return fresh ? (saved.text as string) : null;
  } catch {
    return null;
  }
}
