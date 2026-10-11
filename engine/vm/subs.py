"""Субтитры: события для кадров слоя (`build_sub_events`) и файл SRT (`to_srt`).

Времена слов — по исходнику, в время финала их переводит только `Timeline`. Слово остаётся в финале, если не вырезана
его середина; начало и конец слова ставятся через `to_final_snap`: край слова мог попасть в вырезку или лечь за конец
ролика. Слова идут по началу в исходнике: Claude правит words.json вручную, и `t1` слова может налезать на `t0`
следующего.

Слова делятся на фразы. Новая фраза начинается после слова на `.`, `?`, `!` или `…` (закрывающие кавычки и скобки после
знака не в счёт) и после паузы между словами длиннее 0,35 с. Паузу меряем по исходнику: резка ужимает длинные паузы
до 0,18 с, и по финалу уже не видно, где говорящий остановился. Фраза из L слов делится на `n = ceil(L / N)` ровных
кусков `phrase[k·L//n : (k+1)·L//n]`, как в finish.py старого навыка: куски не длиннее N и отличаются друг от друга не
больше чем на слово. Это правило повторяет превью в web/ (`sampleState`, План 3) — менять их только вместе.

Событие — на каждое слово. Оно живёт до начала следующего, если оно наступит раньше чем через 0,6 с после конца слова,
иначе гаснет через 0,3 с после конца слова; дальше конца финала не живёт. Реплика SRT — такой же кусок фразы, её время
считается по тому же правилу.

Тизер (`tl.teaser`): слова его фразы звучат в начале ролика и ещё раз на своём месте — субтитры тоже. Слова тизера —
отдельная фраза в самом начале, их показ не заходит за конец тизера.

Режим `soft` (стиль эталона): блок — кусок фразы до 2 × N слов, разложенный на 1–2 ровные строки не длиннее N слов
(`lines` — сколько слов в каждой); событие — на каждую строку, с начала её первого слова: `visible` — слова блока по
конец этой строки, `active` — её первое слово. Это правило повторяет превью в web/ (`sampleState`).

`hidden` — промежутки исходника, слова которых показывает акцентная фраза (`edit.accents`): на своём месте они в
субтитры не идут, и фраза на них рвётся; в тизере их копии остаются.
"""
import math
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import zip_longest

from .asr import Word
from .timeline import Timeline

EPS = 1e-9  # с: разницу меньше этой считаем нулевой — это шум float (1.9 − 1.3 = 0.5999999999999999), а не время
PHRASE_PAUSE = 0.35  # пауза между словами (по исходнику), после которой начинается новая фраза, с
PHRASE_ENDS = (".", "?", "!", "…")  # слово, кончающееся так, заканчивает фразу
CLOSING = "»\"')]"  # закрывающие кавычки и скобки: после знака конца фразы они не мешают
HOLD_WITHIN = 0.6  # следующий показ начнётся раньше, чем через столько после конца слова, — текущий держится до него, с
LINGER = 0.3  # иначе показ гаснет через столько после конца слова, с
MAX_GROUP = 6  # самая большая группа в karaoke и plate (`n_words`), слов; в soft — слов в строке
ACCUMULATE_BLOCK = 6  # самый большой блок в accumulate, слов
SOFT_LINES = 2  # строк в блоке soft


@dataclass(frozen=True)
class _Spoken:
    """Слово, оставшееся в финале: само слово (его время — по исходнику) и его время в финале; `lead` — копия слова
    в тизере."""

    word: Word
    t0: float
    t1: float
    lead: bool = False
    fresh: bool = False  # перед словом — скрытые слова акцента: с него начинается новая фраза


def build_sub_events(words: list[Word], tl: Timeline, mode: str, n_words: int,
                     hidden: Iterable[tuple[float, float]] = ()) -> list[dict]:
    """События субтитров во времени финала: `{t0, t1, words, active, visible}` — по порядку, без наложений.

    По событию на каждое слово: `words` — слова его группы, `active` — номер говоримого слова в ней, `visible` — сколько
    слов группы видно. `karaoke` и `plate`: группа до `n_words` слов (1–6), видна вся (`visible = len(words)`).
    `accumulate`: группа до 6 слов, видно столько, сколько уже сказано (`visible = active + 1`); `n_words` не нужен.
    `word`: одно слово. `soft`: событие на строку блока, `lines` — слов в строках (раздел о soft вверху). Группы не
    выходят за фразу. Слово с вырезанной серединой пропускается; слово в промежутке `hidden` — тоже (и рвёт фразу);
    событие, которому не досталось времени (два слова с одним началом, слово на последнем мгновении), отбрасывается.
    Время — секунды финала, с точностью до микросекунды и не за его концом.
    Неизвестный режим и `n_words` вне 1–6 для karaoke, plate и soft — `ValueError`. Нет слов — `[]`."""
    size = _group_size(mode, n_words)
    events, spans, limits = [], [], []  # событие без времени, время слова и предел показа — в одном порядке
    for phrase in _phrases(_spoken(words, tl, list(hidden))):
        for block in _balanced(phrase, size):
            texts = [item.word.text for item in block]
            if mode == "soft":
                lines, start = _line_counts(len(block), n_words), 0
                for n in lines:
                    line = block[start : start + n]
                    events.append({"words": texts, "active": start, "visible": start + n, "lines": lines})
                    spans.append((line[0].t0, line[-1].t1))
                    limits.append(tl.teaser_duration if line[0].lead else tl.duration)
                    start += n
                continue
            for i, item in enumerate(block):
                visible = i + 1 if mode == "accumulate" else len(block)
                events.append({"words": texts, "active": i, "visible": visible})
                spans.append((item.t0, item.t1))
                limits.append(tl.teaser_duration if item.lead else tl.duration)
    shown = _shown(spans, limits)
    return [{"t0": span[0], "t1": span[1], **event} for event, span in zip(events, shown, strict=True) if span]


def to_srt(words: list[Word], tl: Timeline, max_words: int = 7) -> str:
    """SRT-файл для финала: реплика — кусок фразы не длиннее `max_words` слов (куски ровные), текст — слова через
    пробел. Начало реплики — начало её первого слова, конец — по тому же правилу, что у события. Реплики с нулевым
    показом отбрасываются, остальные нумеруются с 1. Нет слов — пустая строка. `max_words` меньше 1 или бесконечный —
    `ValueError`."""
    if not 1 <= max_words < math.inf:  # так отсеиваются и NaN, и бесконечность
        raise ValueError(f"max_words must be a finite number, 1 or more, got {max_words!r}")
    cues = [cue for phrase in _phrases(_spoken(words, tl)) for cue in _balanced(phrase, max_words)]
    limits = [tl.teaser_duration if cue[0].lead else tl.duration for cue in cues]
    shown = _shown([(cue[0].t0, cue[-1].t1) for cue in cues], limits)
    blocks: list[str] = []
    for cue, span in zip(cues, shown, strict=True):
        if span:
            text = " ".join(item.word.text for item in cue)
            blocks.append(f"{len(blocks) + 1}\n{_stamp(span[0])} --> {_stamp(span[1])}\n{text}\n\n")
    return "".join(blocks)


def _group_size(mode: str, n_words: int) -> int:
    """Наибольшее число слов в группе режима. Неизвестный режим и негодный `n_words` — `ValueError`."""
    if mode in ("karaoke", "plate", "soft"):
        if not 1 <= n_words <= MAX_GROUP:  # так отсеивается и NaN
            raise ValueError(f"n_words must be from 1 to {MAX_GROUP}, got {n_words!r}")
        return SOFT_LINES * n_words if mode == "soft" else n_words
    if mode == "accumulate":
        return ACCUMULATE_BLOCK
    if mode == "word":
        return 1
    raise ValueError(f"unknown subtitle mode {mode!r}: expected karaoke, plate, word, accumulate or soft")


def _line_counts(total: int, per: int) -> list[int]:
    """Слов в строках блока soft: `ceil(total / per)` ровных строк."""
    count = math.ceil(total / per)
    return [(k + 1) * total // count - k * total // count for k in range(count)]


def _spoken(words: list[Word], tl: Timeline, hidden: list[tuple[float, float]] = ()) -> list[_Spoken]:
    """Слова, оставшиеся в финале, по началу в исходнике (при равном — как в `words`); слова тизера — копиями впереди.
    Слова в промежутках `hidden` на своём месте пропускаются, следующее за ними начинает фразу."""
    spoken, lead = [], []
    teaser = tl.teaser
    gap = False
    for word in sorted(words, key=lambda w: w.t0):
        middle = (word.t0 + max(word.t1, word.t0)) / 2
        if teaser and teaser[0] <= middle <= teaser[1]:
            t0 = tl.teaser_final(max(word.t0, teaser[0]))
            lead.append(_Spoken(word, t0, max(t0, tl.teaser_final(min(max(word.t1, word.t0), teaser[1]))), lead=True))
        if any(a <= middle <= b for a, b in hidden):
            gap = True
            continue
        if tl.to_final(middle) is None:
            continue  # середина вырезана или лежит за концом ролика
        t0 = tl.to_final_snap(word.t0)
        spoken.append(_Spoken(word, t0, max(t0, tl.to_final_snap(word.t1)), fresh=gap))
        gap = False
    return lead + spoken


def _phrases(spoken: list[_Spoken]) -> list[list[_Spoken]]:
    """Слова по порядку → фразы."""
    phrases: list[list[_Spoken]] = []
    for item in spoken:
        if phrases and not _starts_phrase(phrases[-1][-1], item):
            phrases[-1].append(item)
        else:
            phrases.append([item])
    return phrases


def _starts_phrase(previous: _Spoken, item: _Spoken) -> bool:
    """Начинается ли с `item` новая фраза: `previous` кончился знаком конца фразы, до `item` пауза длиннее 0,35 с,
    между ними — слова акцента (`hidden`) или кончился тизер."""
    ended = previous.word.text.rstrip(CLOSING).endswith(PHRASE_ENDS)
    return ended or item.fresh or previous.lead != item.lead or item.word.t0 - previous.word.t1 > PHRASE_PAUSE + EPS


def _balanced(items: list[_Spoken], size: int) -> list[list[_Spoken]]:
    """`items` в `n = ceil(L / size)` ровных кусков `items[k·L//n : (k+1)·L//n]`, где L — их число."""
    total = len(items)
    count = math.ceil(total / size)
    return [items[k * total // count : (k + 1) * total // count] for k in range(count)]


def _shown(spans: list[tuple[float, float]], limits: list[float]) -> list[tuple[float, float] | None]:
    """Время показа каждого из `spans` — `(начало, конец)` слова или реплики в финале, по порядку; `None` — показ пуст.

    Показ тянется до начала следующего, если оно наступит раньше чем через 0,6 с после конца, иначе гаснет через 0,3 с
    после конца. Дальше начала следующего он не заходит (во втором случае конец + 0,3 с и так раньше него) и дальше
    своего предела из `limits` (конец финала, у тизера — его конец) — тоже."""
    shown = []
    for (start, end), following, duration in zip_longest(spans, spans[1:], limits):
        if following and following[0] - end < HOLD_WITHIN - EPS:
            stop = following[0]
        else:
            stop = end + LINGER
        t0, t1 = _at(start, duration), _at(stop, duration)
        shown.append((t0, t1) if t1 > t0 else None)
    return shown


def _at(t: float, duration: float) -> float:
    """Время для выдачи: не за концом финала и с точностью до микросекунды (шум float, 2.3000000000000003, уходит)."""
    t = round(min(t, duration), 6)
    return t if t <= duration + EPS else round(t - 1e-6, 6)  # округление вверх не должно выйти за конец финала


def _stamp(t: float) -> str:
    """Время SRT `HH:MM:SS,mmm`; миллисекунды — до ближайшей, половина вверх."""
    ms = int(t * 1000 + 0.5)
    return f"{ms // 3_600_000:02d}:{ms // 60_000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
