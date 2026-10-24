"""План нарезки: какие части исходника остаются.

Срезаем тишину по краям и ужимаем паузы, а слова не трогаем — внутри слова не режем никогда. По умолчанию резка
плотная, как в эталоне abramova.mp4 (решение Павла 11.10.2026): пауза длиннее 0,26 с вырезается целиком — склейка
вплотную к словам (решение Павла 24.10.2026: прежние 0,16 с паузы на склейке он срезал руками); поля по краям ролика —
0,10 и 0,06 с. Паузу короче не трогаем: склейка ради пары кадров экономии только дёргает кадр. `SOFT` — прежняя мягкая
резка (ответ «мягко» на вопрос `cut`): её числа — ниже.

* Тишина до первого слова и после последнего срезается до полей `pad_before` перед словом и `pad_after` после него
  (плотно — 0,10 и 0,06 с, мягко — 0,12 и 0,08 с). Перед словом поле больше, потому что GigaAM ставит начало слова
  позже, чем оно звучит: в среднем на 35 мс, ошибка до 85 мс (замеры задачи 3 плана; сводка —
  docs/spikes/2026-10-results.md), а конец у него с запасом (`asr.WORD_TAIL`).
* Пауза между словами не длиннее `max_pause` (плотно — 0,26 с, мягко — 0,45 с) остаётся целой. Длиннее — ужимается
  до `keep_pause` (плотно — 0: склейка вплотную; мягко — 0,18 с: `pad_before` остаются перед следующим словом и
  остальное, 0,06 с, — после предыдущего).
* Налезающие друг на друга и стыкующиеся слова — одна непрерывная речь, паузы между ними нет (Claude правит
  words.json вручную, и `t1` слова может оказаться за `t0` следующего).
* Вырезка из `extra_cuts` расширяется до границ задетых слов (задето — значит, у слова с вырезкой есть общий кусок
  времени), и эти слова уходят целиком. Паузы считаются между оставшимися словами.
* `speech` — где речь по VAD. Внутри неё не режем (кроме `extra_cuts`): GigaAM бывает не разбирает слово или фразу
  (на синтетической речи — целые фразы), и без VAD резка приняла бы их за паузу. Паузы между фразами VAD
  (от 0,3 с) ужимаются как обычно. Хвост фразы VAD после её последнего слова не длиннее `VAD_TAIL` — не речь:
  Silero держит речь до секунды после фразы, а там выдох или начало вырезанного дубля (задачи 23.10: 13 таких хвостов
  по 0,3–0,8 с Павел срезал руками). Хвост длиннее — недослышанные слова, его не режем.

Результат — отрезки исходника по возрастанию, без пересечений и стыков; каждый длиннее `EPS`.
Время в секундах от начала исходника, как в words.json.
"""
from collections.abc import Iterable

from .asr import Word

EPS = 1e-9  # с: разницу меньше этой считаем нулевой — это ошибка округления float, а не настоящее время
MIN_VOICED = 0.15  # с — кусок речи по VAD короче этого (после вырезок) не защищается от резки
VAD_TAIL = 1.0  # с — хвост фразы VAD после её последнего слова не длиннее этого — не речь (в задачах 23.10 — до 0,95 с)
SOFT = {"max_pause": 0.45, "keep_pause": 0.18, "pad_before": 0.12, "pad_after": 0.08}  # мягкая резка — `plan_keep(…, **SOFT)`


def plan_keep(
    words: list[Word],
    duration: float,
    *,
    max_pause: float = 0.26,
    keep_pause: float = 0.0,
    pad_before: float = 0.1,
    pad_after: float = 0.06,
    extra_cuts: Iterable[tuple[float, float]] = (),
    speech: Iterable[tuple[float, float]] = (),
) -> list[tuple[float, float]]:
    """Отрезки исходника, которые остаются: `[(начало, конец), ...]` по возрастанию, без пересечений.

    `duration` — длина исходника; поля не выходят за 0 и `duration`. `extra_cuts` — вырезки `(начало, конец)`;
    вырезка нулевой длины игнорируется, с концом раньше начала — `ValueError`. Нет слов — остаётся весь ролик
    (за вычетом `extra_cuts`); все слова вырезаны — не остаётся ничего (`[]`). Отрицательные поля и паузы —
    `ValueError`: они срезали бы край самого слова.
    """
    for name, value in (
        ("max_pause", max_pause),
        ("keep_pause", keep_pause),
        ("pad_before", pad_before),
        ("pad_after", pad_after),
    ):
        if not value >= 0:  # так отсеивается и NaN
            raise ValueError(f"{name} must be 0 or more seconds, got {value!r}")
    cuts = _snap_to_words(extra_cuts, words)
    if not words:
        return _without(0.0, duration, cuts)

    kept_words = [w for w in words if not any(_overlap(w, c0, c1) > EPS for c0, c1 in cuts)]
    # речь по VAD без вырезок и без хвоста после последнего слова; остаток короче слова (кусок фразы рядом с
    # вырезкой) не речь — щепка в ролике
    # хвост — после последнего слова фразы, вырезанного тоже (иначе хвост вырезанного дубля остался бы «речью без
    # слов»), и после последнего оставшегося слова каждого куска фразы между вырезками
    spans = [_without_tail(Word(s0, s1, ""), words) for s0, s1 in speech]
    voiced = [Word(a, b, "") for span in spans for a, b in _without(span.t0, span.t1, cuts)]
    voiced = [v for v in (_without_tail(v, kept_words) for v in voiced) if v.t1 - v.t0 >= MIN_VOICED]
    heard = sorted(kept_words + (voiced if kept_words else []), key=_by_start)
    if not heard:
        return []
    before = min(pad_before, keep_pause)  # от ужатой паузы перед следующим словом — не больше keep_pause
    after = keep_pause - before
    holes = []  # что вырезаем из паузы: всё, кроме `after` после слова и `before` перед следующим
    reach = heard[0].t1  # докуда дотянулась речь: слова налезают, поэтому это самый поздний `t1`, а не `t1` соседа
    for word in heard[1:]:
        if word.t0 - reach > max_pause + EPS:
            holes.append((reach + after, word.t0 - before))  # короче нуля (keep_pause длиннее паузы) — вырезать нечего
        reach = max(reach, word.t1)
    return _without(max(0.0, heard[0].t0 - pad_before), min(duration, reach + pad_after), holes + cuts)


def _without_tail(span: Word, words: list[Word]) -> Word:
    """Кусок речи VAD без хвоста после последнего слова в нём, если хвост не длиннее `VAD_TAIL`."""
    last = max((w.t1 for w in words if _overlap(w, span.t0, span.t1) > EPS), default=None)
    if last is not None and last < span.t1 and span.t1 - last <= VAD_TAIL + EPS:
        return Word(span.t0, last, span.text)
    return span


def _by_start(word: Word) -> tuple[float, float]:
    return word.t0, word.t1


def _overlap(word: Word, start: float, end: float) -> float:
    """Длина общего куска времени слова и промежутка start–end (меньше нуля — слово в стороне)."""
    return min(word.t1, end) - max(word.t0, start)


def _snap_to_words(cuts: Iterable[tuple[float, float]], words: list[Word]) -> list[tuple[float, float]]:
    """Вырезки, расширенные до границ задетых слов. Расширенная вырезка может задеть ещё слово (слова налезают
    друг на друга) — тогда расширяем дальше, пока не перестанет: ни одно слово не должно остаться с отрезанным краем."""
    snapped = []
    for i, (start, end) in enumerate(cuts):
        if not end >= start:  # так отсеивается и NaN
            raise ValueError(f"extra_cuts[{i}]: the cut ends ({end}) before it starts ({start})")
        if end - start <= EPS:
            continue
        grown = True
        while grown:
            grown = False
            for word in words:
                if _overlap(word, start, end) > EPS and (word.t0 < start or word.t1 > end):
                    start, end = min(start, word.t0), max(end, word.t1)
                    grown = True
        snapped.append((start, end))
    return snapped


def _without(start: float, end: float, holes: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Отрезок start–end без участков `holes`: порядок любой, пересекаться могут; короче EPS и «обратные» не в счёт."""
    kept, at = [], start
    for h0, h1 in sorted(h for h in holes if h[1] - h[0] > EPS):
        if h0 >= end - EPS:
            break
        if h0 - at > EPS:
            kept.append((at, h0))
        at = max(at, h1)
    if end - at > EPS:
        kept.append((at, end))
    return kept
