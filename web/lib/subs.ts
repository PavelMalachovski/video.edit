// Субтитры — перенос build_sub_events из engine/vm/subs.py (там — правило целиком): по словам и шкале времени — события
// во времени финала, как их нарисует монтаж. Общая фикстура engine/tests/fixtures/overlay-events.json (пишет
// engine/tests/shared_events.py); меняются только вместе.
import { pyRound } from './pyround.ts';
import type { Timeline } from './timeline.ts';

export type Word = { t0: number; t1: number; text: string };
/** Событие субтитров: `words` — слова группы, `active` — говоримое, `visible` — сколько видно; у soft — `lines` (слов в
 *  строках блока) и `opens` (блок начинает предложение). */
export type SubEvent = { t0: number; t1: number; words: string[]; active: number; visible: number; lines?: number[]; opens?: boolean };

const EPS = 1e-9; // с: разницу меньше этой считаем нулевой — шум float
const PHRASE_PAUSE = 0.35; // пауза между словами (по исходнику), после которой начинается новая фраза, с
const PHRASE_ENDS = ['.', '?', '!', '…'];
const CLOSING = /[»"')\]]+$/u; // закрывающие кавычки и скобки после знака конца фразы не мешают
const HOLD_WITHIN = 0.6; // следующий показ ближе — текущий держится до него, с
const LINGER = 0.3; // иначе показ гаснет через столько после конца слова, с
const MAX_GROUP = 6;
const ACCUMULATE_BLOCK = 6;
const SOFT_LINES = 2;

/** Слово, оставшееся в финале: его время в финале; `lead` — копия в тизере, `fresh` — перед ним скрытые слова акцента,
 *  `opens` — начинает предложение. */
type Spoken = { word: Word; t0: number; t1: number; lead: boolean; fresh: boolean; opens: boolean };
type Event = Omit<SubEvent, 't0' | 't1'>;

/** События субтитров во времени финала — по порядку, без наложений (build_sub_events движка). Неизвестный режим и
 *  `nWords` вне 1–6 для karaoke, plate и soft — Error. */
export function buildSubEvents(words: readonly Word[], tl: Timeline, mode: string, nWords: number,
  hidden: readonly (readonly number[])[] = []): SubEvent[] {
  const { events, shown } = layout(words, tl, mode, nWords, hidden);
  return events.flatMap((e, k) => {
    const s = shown[k];
    return s ? [{ t0: s[0], t1: s[1], ...e.event }] : [];
  });
}

/** Блок субтитров на дорожке редактора: что видно вместе (у soft — до двух строк), его время в финале (от первого показа
 *  до последнего) и слова — с номером в `words` (по нему правят слово) и временем в финале; `lead` — копия в тизере. */
export type SubBlock = { t0: number; t1: number; lead: boolean; opens: boolean; words: { i: number; text: string; t0: number; t1: number }[] };

/** Блоки субтитров по тем же правилам, что события (пустые — без показа — не идут). */
export function subBlocks(words: readonly Word[], tl: Timeline, mode: string, nWords: number,
  hidden: readonly (readonly number[])[] = []): SubBlock[] {
  const { blocks, events, shown } = layout(words, tl, mode, nWords, hidden);
  const index = new Map(words.map((w, i) => [w, i]));
  return blocks.flatMap((items, b): SubBlock[] => {
    const spans = events.flatMap((e, k) => (e.block === b && shown[k] ? [shown[k] as [number, number]] : []));
    if (!spans.length) return [];
    return [{
      t0: spans[0][0], t1: (spans.at(-1) as [number, number])[1], lead: items[0].lead, opens: items[0].opens,
      words: items.map((item) => ({ i: index.get(item.word) ?? -1, text: item.word.text, t0: item.t0, t1: item.t1 })),
    }];
  });
}

/** Блоки (куски фраз), события по порядку (с номером блока) и время показа каждого события (null — пустое). */
function layout(words: readonly Word[], tl: Timeline, mode: string, nWords: number, hidden: readonly (readonly number[])[]) {
  const size = groupSize(mode, nWords);
  const blocks: Spoken[][] = [];
  const events: { event: Event; block: number }[] = [];
  const spans: [number, number][] = [];
  const limits: number[] = [];
  for (const phrase of phrases(spoken(words, tl, hidden))) {
    for (const block of balanced(phrase, size)) {
      const b = blocks.push(block) - 1;
      const texts = block.map((item) => item.word.text);
      if (mode === 'soft') {
        const lines = lineCounts(block.length, nWords);
        let start = 0;
        for (const n of lines) {
          const line = block.slice(start, start + n);
          events.push({ event: { words: texts, active: start, visible: start + n, lines, opens: block[0].opens }, block: b });
          spans.push([line[0].t0, (line.at(-1) as Spoken).t1]);
          limits.push(line[0].lead ? tl.teaserDuration : tl.duration);
          start += n;
        }
        continue;
      }
      block.forEach((item, i) => {
        events.push({ event: { words: texts, active: i, visible: mode === 'accumulate' ? i + 1 : block.length }, block: b });
        spans.push([item.t0, item.t1]);
        limits.push(item.lead ? tl.teaserDuration : tl.duration);
      });
    }
  }
  return { blocks, events, shown: shownSpans(spans, limits) };
}

function groupSize(mode: string, nWords: number): number {
  if (mode === 'karaoke' || mode === 'plate' || mode === 'soft') {
    if (!(nWords >= 1 && nWords <= MAX_GROUP)) throw new Error(`n_words must be from 1 to ${MAX_GROUP}, got ${nWords}`);
    return mode === 'soft' ? SOFT_LINES * nWords : nWords;
  }
  if (mode === 'accumulate') return ACCUMULATE_BLOCK;
  if (mode === 'word') return 1;
  throw new Error(`unknown subtitle mode ${JSON.stringify(mode)}: expected karaoke, plate, word, accumulate or soft`);
}

/** Слов в строках блока soft: `ceil(total / per)` ровных строк. */
function lineCounts(total: number, per: number): number[] {
  const count = Math.ceil(total / per);
  return Array.from({ length: count }, (_, k) => Math.floor(((k + 1) * total) / count) - Math.floor((k * total) / count));
}

export const endsSentence = (text: string): boolean => {
  const bare = text.replace(CLOSING, '');
  return PHRASE_ENDS.some((end) => bare.endsWith(end));
};

/** Слова, оставшиеся в финале, по началу в исходнике; слова тизера — копиями впереди; слова акцентов (`hidden`) — только
 *  в серии кусков, где стоит акцент (_spoken движка). */
function spoken(words: readonly Word[], tl: Timeline, hidden: readonly (readonly number[])[]): Spoken[] {
  const kept: [number | null, Spoken][] = [];
  const lead: Spoken[] = [];
  const teaser = tl.teaser;
  let gap = false;
  let previous: string | null = null; // прошлое слово речи: конец предложения виден и по скрытым и вырезанным словам
  for (const word of [...words].sort((a, b) => a.t0 - b.t0)) {
    const afterEnd = previous === null || endsSentence(previous);
    previous = word.text;
    const end = Math.max(word.t1, word.t0);
    const middle = (word.t0 + end) / 2;
    if (teaser && teaser[0] <= middle && middle <= teaser[1]) {
      const t0 = tl.teaserFinal(Math.max(word.t0, teaser[0])) as number;
      const t1 = Math.max(t0, tl.teaserFinal(Math.min(end, teaser[1])) as number);
      lead.push({ word, t0, t1, lead: true, fresh: false, opens: !lead.length || afterEnd });
    }
    if (hidden.some(([a, b]) => a <= middle && middle <= b && tl.runOf(middle) === tl.runOf(a))) {
      gap = true;
      continue;
    }
    if (tl.toFinal(middle) === null) continue; // середина вырезана или лежит за концом ролика
    const [t0, t1] = tl.span(word.t0, end); // конец в вырезанном — конец своего куска
    kept.push([tl.runOf(middle), { word, t0, t1: Math.max(t0, t1), lead: false, fresh: gap, opens: !kept.length || afterEnd }]);
    gap = false;
  }
  // по месту в ролике: на стыке серий кусков (переставлены руками) — новая фраза
  const ordered = [...kept].sort((a, b) => a[1].t0 - b[1].t0);
  const out = ordered.map(([run, item], k) => (!k || run === ordered[k - 1][0] ? item : { ...item, fresh: true }));
  return [...lead, ...out];
}

function phrases(items: Spoken[]): Spoken[][] {
  const out: Spoken[][] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && !startsPhrase(last.at(-1) as Spoken, item)) last.push(item);
    else out.push([item]);
  }
  return out;
}

const startsPhrase = (previous: Spoken, item: Spoken): boolean => endsSentence(previous.word.text) || item.fresh
  || previous.lead !== item.lead || item.word.t0 - previous.word.t1 > PHRASE_PAUSE + EPS;

/** `items` в `ceil(L / size)` ровных кусков `items[k·L//n : (k+1)·L//n]`. */
function balanced<T>(items: T[], size: number): T[][] {
  const total = items.length;
  const count = Math.ceil(total / size);
  return Array.from({ length: count }, (_, k) => items.slice(Math.floor((k * total) / count), Math.floor(((k + 1) * total) / count)));
}

/** Время показа каждого промежутка: до начала следующего, если он ближе 0,6 с, иначе ещё 0,3 с; не за пределом. */
function shownSpans(spans: [number, number][], limits: number[]): ([number, number] | null)[] {
  return spans.map(([start, end], k) => {
    const following = spans[k + 1];
    const stop = following && following[0] - end < HOLD_WITHIN - EPS ? following[0] : end + LINGER;
    const t0 = at(start, limits[k]);
    const t1 = at(stop, limits[k]);
    return t1 > t0 ? [t0, t1] : null;
  });
}

/** Время для выдачи: не за концом финала и с точностью до микросекунды (_at движка). */
function at(t: number, duration: number): number {
  const x = pyRound(Math.min(t, duration), 6);
  return x <= duration + EPS ? x : pyRound(x - 1e-6, 6);
}
