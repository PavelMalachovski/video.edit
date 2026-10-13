"""Субтитры: события для кадров слоя и SRT. Чистая арифметика над словами и `Timeline` — быстро, без ffmpeg и моделей.

Почти везде ролик целый и без ускорения (`whole`): время финала равно времени исходника, и ожидаемое считается в уме.
Слова идут с паузой 0,1 с — короче порога фразы (0,35 с), а знаков препинания в них нет, если тест не про них.
Времена событий округлены до микросекунды, поэтому с литералами они сравниваются как есть.
"""
import math
import random
import re
from itertools import pairwise

import pytest

from vm.asr import Word
from vm.cuts import plan_keep
from vm.subs import build_sub_events, to_srt
from vm.timeline import Timeline

EPS = 1e-6  # допуск сравнения времён в тестах, с
MODES = ("karaoke", "plate", "word", "accumulate")


def speech(*items: tuple[float, float, str]) -> list[Word]:
    """Слова `(начало, конец, текст)` в порядке записи."""
    return [Word(t0, t1, text) for t0, t1, text in items]


def row(count: int) -> list[Word]:
    """`count` слов w0, w1, ... подряд, без знаков: слово 0,2 с, пауза 0,1 с — одна фраза."""
    return [Word(round(0.3 * i, 3), round(0.3 * i + 0.2, 3), f"w{i}") for i in range(count)]


def whole(duration: float) -> Timeline:
    """Ролик целиком, без ускорения: время финала равно времени исходника."""
    return Timeline([(0, duration)], 1.0)


def drawn(events: list[dict]) -> list[tuple]:
    """Что нарисуется, без времени: слова блока, говоримое слово, сколько слов видно."""
    return [(e["words"], e["active"], e["visible"]) for e in events]


# ---------- группы слов ----------


def test_karaoke_groups_of_three_one_event_per_word():
    words = speech(
        (0.0, 0.2, "раз"), (0.3, 0.5, "два"), (0.6, 0.8, "три"),
        (0.9, 1.1, "четыре"), (1.2, 1.4, "пять"), (1.5, 1.7, "шесть"),
    )
    first, second = ["раз", "два", "три"], ["четыре", "пять", "шесть"]
    assert build_sub_events(words, whole(10), "karaoke", 3) == [
        {"t0": 0.0, "t1": 0.3, "words": first, "active": 0, "visible": 3},
        {"t0": 0.3, "t1": 0.6, "words": first, "active": 1, "visible": 3},
        {"t0": 0.6, "t1": 0.9, "words": first, "active": 2, "visible": 3},
        {"t0": 0.9, "t1": 1.2, "words": second, "active": 0, "visible": 3},
        {"t0": 1.2, "t1": 1.5, "words": second, "active": 1, "visible": 3},
        {"t0": 1.5, "t1": 2.0, "words": second, "active": 2, "visible": 3},  # последнее: конец слова + 0,3 с
    ]


def test_plate_groups_like_karaoke():
    words = row(5)
    assert build_sub_events(words, whole(10), "plate", 2) == build_sub_events(words, whole(10), "karaoke", 2)


def test_groups_are_balanced_within_a_phrase():
    # 5 слов одной фразы по 3 в группе: 2 + 3, а не 3 + 2 и не 3 + 1 + 1
    events = build_sub_events(row(5), whole(10), "karaoke", 3)
    assert drawn(events) == [
        (["w0", "w1"], 0, 2), (["w0", "w1"], 1, 2),
        (["w2", "w3", "w4"], 0, 3), (["w2", "w3", "w4"], 1, 3), (["w2", "w3", "w4"], 2, 3),
    ]


@pytest.mark.parametrize(
    "count, n_words, visible",
    [
        (1, 3, [1]),
        (3, 3, [3, 3, 3]),
        (4, 3, [2, 2, 2, 2]),
        (7, 3, [2, 2, 2, 2, 3, 3, 3]),
        (3, 1, [1, 1, 1]),
        (5, 2, [1, 2, 2, 2, 2]),
        (8, 6, [4, 4, 4, 4, 4, 4, 4, 4]),
    ],
)
def test_phrase_splits_into_ceil_of_len_over_n_even_groups(count, n_words, visible):
    # n = ceil(L / N) кусков phrase[k·L//n : (k+1)·L//n]; на каждое слово событие, visible — длина его куска
    events = build_sub_events(row(count), whole(10), "karaoke", n_words)
    assert [e["visible"] for e in events] == visible


def test_accumulate_visible_grows_and_breaks_on_pause():
    words = speech(
        (0.0, 0.2, "раз"), (0.3, 0.5, "два"), (0.6, 0.8, "три"), (0.9, 1.1, "четыре"), (1.2, 1.4, "пять"),
        (1.9, 2.1, "шесть"), (2.2, 2.4, "семь"),  # пауза 0,5 с перед «шесть» — новая фраза, счёт видимых с единицы
    )
    five, two = ["раз", "два", "три", "четыре", "пять"], ["шесть", "семь"]
    # n_words = 2 для accumulate ничего не значит: блок до 6 слов, поэтому все пять слов — один блок
    assert build_sub_events(words, whole(10), "accumulate", 2) == [
        {"t0": 0.0, "t1": 0.3, "words": five, "active": 0, "visible": 1},
        {"t0": 0.3, "t1": 0.6, "words": five, "active": 1, "visible": 2},
        {"t0": 0.6, "t1": 0.9, "words": five, "active": 2, "visible": 3},
        {"t0": 0.9, "t1": 1.2, "words": five, "active": 3, "visible": 4},
        {"t0": 1.2, "t1": 1.9, "words": five, "active": 4, "visible": 5},
        {"t0": 1.9, "t1": 2.2, "words": two, "active": 0, "visible": 1},
        {"t0": 2.2, "t1": 2.7, "words": two, "active": 1, "visible": 2},
    ]


def test_accumulate_block_holds_six_words():
    six = [f"w{i}" for i in range(6)]
    events = build_sub_events(row(6), whole(10), "accumulate", 3)
    assert drawn(events) == [(six, i, i + 1) for i in range(6)]


def test_accumulate_cuts_a_longer_phrase_evenly():
    # 7 слов одной фразы: 3 + 4 (а не 6 + 1)
    events = build_sub_events(row(7), whole(10), "accumulate", 3)
    first, second = ["w0", "w1", "w2"], ["w3", "w4", "w5", "w6"]
    assert drawn(events) == [
        (first, 0, 1), (first, 1, 2), (first, 2, 3),
        (second, 0, 1), (second, 1, 2), (second, 2, 3), (second, 3, 4),
    ]


def test_word_mode_shows_one_word_at_a_time_whatever_n_words_is():
    words = speech((0.0, 0.2, "раз"), (0.3, 0.5, "два."), (0.6, 0.8, "три"))
    assert build_sub_events(words, whole(10), "word", 99) == [
        {"t0": 0.0, "t1": 0.3, "words": ["раз"], "active": 0, "visible": 1},
        {"t0": 0.3, "t1": 0.6, "words": ["два."], "active": 0, "visible": 1},
        {"t0": 0.6, "t1": 1.1, "words": ["три"], "active": 0, "visible": 1},
    ]


def test_accumulate_ignores_n_words_even_when_it_is_nonsense():
    assert build_sub_events(row(2), whole(10), "accumulate", 0) == build_sub_events(row(2), whole(10), "accumulate", 3)


def test_unknown_mode_is_refused_even_without_words():
    with pytest.raises(ValueError, match="typewriter"):
        build_sub_events([], whole(10), "typewriter", 3)


@pytest.mark.parametrize("mode", ["karaoke", "plate"])
@pytest.mark.parametrize("n_words", [0, 7, -1, math.nan], ids=["zero", "seven", "negative", "nan"])
def test_group_size_outside_1_to_6_is_refused(mode, n_words):
    with pytest.raises(ValueError, match="n_words"):
        build_sub_events(row(2), whole(10), mode, n_words)


@pytest.mark.parametrize("n_words", [1, 6])
def test_group_size_1_and_6_are_allowed(n_words):
    assert len(build_sub_events(row(2), whole(10), "karaoke", n_words)) == 2


# ---------- фразы ----------


@pytest.mark.parametrize(
    "ending",
    ["end.", "end?", "end!", "end…", "end...", "end.»", 'end."', "end?)", "end!»)", "end.']"],
    ids=["dot", "question", "exclamation", "ellipsis", "three dots", "dot guillemet", "dot quote", "question paren",
         "exclamation guillemet paren", "dot quote bracket"],
)
def test_phrase_ends_after_a_word_ending_with_a_mark(ending):
    # закрывающие кавычки и скобки после знака конца фразы не мешают
    words = speech((0.0, 0.2, ending), (0.3, 0.5, "next"))
    assert drawn(build_sub_events(words, whole(10), "karaoke", 3)) == [([ending], 0, 1), (["next"], 0, 1)]


@pytest.mark.parametrize(
    "ending",
    ["end", "end,", "end;", "end:", "end-", "end—", "end»", 'end"', "end)", 'end,"', "e.g", "3.5"],
    ids=["bare", "comma", "semicolon", "colon", "hyphen", "dash", "guillemet", "quote", "paren", "comma quote",
         "dot inside", "decimal"],
)
def test_phrase_goes_on_after_a_word_without_a_closing_mark(ending):
    # закрывающая кавычка или скобка сама фразу не кончает, а точка внутри слова — тем более
    words = speech((0.0, 0.2, ending), (0.3, 0.5, "next"))
    both = [ending, "next"]
    assert drawn(build_sub_events(words, whole(10), "karaoke", 3)) == [(both, 0, 2), (both, 1, 2)]


@pytest.mark.parametrize(
    "second_start, one_phrase",
    [(1.8, True), (1.85, True), (1.86, False), (2.5, False)],
    ids=["pause 0.30", "pause exactly 0.35", "pause 0.36", "pause 1.0"],
)
def test_phrase_breaks_on_a_pause_longer_than_035_s(second_start, one_phrase):
    # ровно 0,35 с — ещё не пауза, хотя 1.85 − 1.5 в float чуть больше 0.35
    words = speech((1.0, 1.5, "раз"), (second_start, second_start + 0.4, "два"))
    visible = [e["visible"] for e in build_sub_events(words, whole(10), "karaoke", 3)]
    assert visible == ([2, 2] if one_phrase else [1, 1])


def test_phrase_breaks_on_a_pause_the_cut_plan_shrank():
    # в исходнике между словами 1,0 с; резка ужала паузу до 0,18 с, но говорящий остановился, и фраза кончилась
    words = speech((1.0, 1.5, "раз"), (2.5, 3.0, "два"))
    tl = Timeline([(0.88, 1.56), (2.38, 3.08)], 1.0)
    assert build_sub_events(words, tl, "karaoke", 3) == [
        {"t0": 0.12, "t1": 0.8, "words": ["раз"], "active": 0, "visible": 1},
        {"t0": 0.8, "t1": 1.38, "words": ["два"], "active": 0, "visible": 1},
    ]


def test_phrase_breaks_where_plan_keep_shrank_the_pause():
    # план резки настоящий: пауза 1,0 с в нём ужимается, в финале слова почти встык, а фраза всё равно кончается
    words = speech((1.0, 1.5, "раз"), (2.5, 3.0, "два"))
    tl = Timeline(plan_keep(words, 4.0), 1.1)
    assert tl.to_final(2.5) - tl.to_final(1.5) < 0.35
    assert [e["visible"] for e in build_sub_events(words, tl, "karaoke", 3)] == [1, 1]


def test_phrase_does_not_break_between_overlapping_words():
    # «раз» кончается позже, чем начинается «два»: пауза отрицательная (−1,0 с) — это не разрыв, а наложение
    words = speech((0.0, 1.5, "раз"), (0.5, 0.9, "два"), (1.2, 1.4, "три"))
    assert [e["visible"] for e in build_sub_events(words, whole(10), "karaoke", 3)] == [3, 3, 3]


# ---------- какие слова остаются ----------


def test_cut_words_are_skipped():
    words = speech((0.5, 1.0, "до"), (2.2, 2.7, "вырезанное"), (3.5, 4.0, "после"))
    tl = Timeline([(0, 2), (3, 5)], 1.0)  # секунда 2–3 вырезана вместе со словом
    assert build_sub_events(words, tl, "karaoke", 3) == [
        {"t0": 0.5, "t1": 1.3, "words": ["до"], "active": 0, "visible": 1},
        {"t0": 2.5, "t1": 3.3, "words": ["после"], "active": 0, "visible": 1},
    ]


@pytest.mark.parametrize(
    "t0, t1, kept",
    [
        (1.2, 1.8, True),  # внутри отрезка
        (0.5, 1.5, True),  # середина 1,0 — ровно на краю отрезка, а край принадлежит отрезку
        (0.5, 1.4, False),  # середина 0,95 вырезана, хотя конец слова внутри отрезка
        (1.6, 2.5, False),  # середина 2,05 вырезана, хотя начало слова внутри отрезка
        (0.8, 2.2, True),  # слово шире отрезка, но середина в нём
        (1.0, 0.5, True),  # конец раньше начала: слово нулевой длины в начале, оно на краю отрезка
        (3.0, 3.5, False),  # целиком за концом ролика
    ],
)
def test_word_stays_when_the_middle_of_it_is_in_a_kept_part(t0, t1, kept):
    events = build_sub_events(speech((t0, t1, "слово")), Timeline([(1, 2)], 1.0), "word", 3)
    assert bool(events) is kept


def test_word_wider_than_the_kept_part_is_pinned_to_its_edges():
    # слово 0,8–2,2 при отрезке 1–2: начало вырезано — встаёт на начало отрезка, конец — на конец финала
    events = build_sub_events(speech((0.8, 2.2, "слово")), Timeline([(1, 2)], 1.0), "word", 3)
    assert events == [{"t0": 0.0, "t1": 1.0, "words": ["слово"], "active": 0, "visible": 1}]


def test_no_kept_words_gives_no_events():
    tl = Timeline([(0, 2)], 1.0)
    assert build_sub_events([], tl, "karaoke", 3) == []
    assert build_sub_events(speech((5.0, 5.5, "вырезано")), tl, "karaoke", 3) == []
    assert build_sub_events(speech((0.5, 1.0, "слово")), Timeline([], 1.0), "karaoke", 3) == []


def test_words_may_come_unsorted_and_overlapping():
    # words.json правят вручную: слова идут не по порядку и налезают друг на друга
    words = speech((1.0, 1.6, "три"), (0.0, 0.5, "раз"), (0.4, 1.1, "два"))
    events = build_sub_events(words, whole(10), "karaoke", 3)
    assert [(e["t0"], e["t1"], e["words"][e["active"]]) for e in events] == [
        (0.0, 0.4, "раз"),  # заканчивается там, где начинается следующее
        (0.4, 1.0, "два"),
        (1.0, 1.9, "три"),
    ]


# ---------- время события ----------


@pytest.mark.parametrize(
    "next_start, first_end",
    [(1.89, 1.89), (1.9, 1.6), (2.4, 1.6)],
    ids=["gap 0.59", "gap exactly 0.6", "gap 1.1"],
)
def test_event_lasts_until_the_next_one_when_it_comes_within_06_s(next_start, first_end):
    # слово кончается в 1,3 с: разрыв короче 0,6 с — держим до следующего, иначе гасим через 0,3 с.
    # ровно 0,6 с — ещё не «короче», хотя 1.9 − 1.3 в float чуть меньше 0.6
    words = speech((1.0, 1.3, "раз"), (next_start, next_start + 0.2, "два"))
    assert build_sub_events(words, whole(10), "word", 3)[0]["t1"] == first_end


def test_last_event_lingers_03_s_but_not_past_the_end_of_the_final():
    words = speech((1.0, 1.2, "раз"), (2.5, 2.9, "два"))
    events = build_sub_events(words, whole(3.0), "word", 3)
    assert [(e["t0"], e["t1"]) for e in events] == [(1.0, 1.5), (2.5, 3.0)]  # 1,2 + 0,3 и min(2,9 + 0,3; 3,0)


def test_times_are_rounded_to_microseconds():
    # 3.3 / 1.1 в float — 2.9999999999999996, а 6.6 / 1.1 + 0.3 — 6.299999999999999: шум в событие не попадает
    events = build_sub_events(speech((3.3, 6.6, "слово")), Timeline([(0, 10)], 1.1), "word", 3)
    assert events == [{"t0": 3.0, "t1": 6.3, "words": ["слово"], "active": 0, "visible": 1}]


def test_a_word_that_starts_with_the_next_one_gets_no_event():
    # одинаковое начало: событие первого слова вышло бы пустым, его отбрасываем. Слова с одним началом идут как в
    # words.json (а не по концу): «раз» кончается позже «два», но стоит раньше
    words = speech((1.0, 1.4, "раз"), (1.0, 1.2, "два"))
    assert build_sub_events(words, whole(10), "karaoke", 3) == [
        {"t0": 1.0, "t1": 1.5, "words": ["раз", "два"], "active": 1, "visible": 2},
    ]


def test_word_that_ends_before_it_starts_counts_as_a_zero_length_word():
    # в words.json такого нет (load_words откажет), но слово можно собрать и в коде: конец раньше начала = начало
    events = build_sub_events(speech((1.0, 0.8, "слово")), whole(10), "word", 3)
    assert events == [{"t0": 1.0, "t1": 1.3, "words": ["слово"], "active": 0, "visible": 1}]


def test_end_of_the_final_is_not_shaved_by_float_noise():
    # 0,7 + (0,9 − 0,8) в float — 0,7999999999999999; событие, дотянувшееся до конца финала, кончается на чистых 0,8
    tl = Timeline([(0, 0.7), (0.8, 0.9)], 1.0)
    assert build_sub_events(speech((0.85, 0.9, "слово")), tl, "word", 3) == [
        {"t0": 0.75, "t1": 0.8, "words": ["слово"], "active": 0, "visible": 1},
    ]


def test_a_word_on_the_last_instant_of_the_final_gets_no_event():
    words = speech((1.0, 1.2, "раз"), (2.0, 2.0, "два"))  # «два» нулевой длины в самом конце ролика
    assert build_sub_events(words, whole(2.0), "karaoke", 3) == [
        {"t0": 1.0, "t1": 1.5, "words": ["раз"], "active": 0, "visible": 1},
    ]


def test_word_beyond_the_clip_end_stays_inside_the_final():
    # отрезки 0–2 и 3–5, ×1,1: финал 3,636… с. «два» начинается в ролике, а кончается за его концом (5,3 с),
    # «три» лежит целиком за концом — его нет
    tl = Timeline([(0, 2), (3, 5)], 1.1)
    words = speech((4.0, 4.3, "раз"), (4.5, 5.3, "два"), (6.0, 6.5, "три"))
    events = build_sub_events(words, tl, "karaoke", 3)
    assert [(e["t0"], e["words"][e["active"]]) for e in events] == [(2.727273, "раз"), (3.181818, "два")]
    assert all(0 <= e["t0"] < e["t1"] <= tl.duration for e in events)
    assert events[-1]["t1"] == pytest.approx(tl.duration, abs=EPS)


# ---------- SRT ----------


def test_srt_timestamps_use_final_timeline():
    # слово в 3,3 с исходника; отрезки 0–2 и 3–5 с, ×1,1: (2 + 0,3) / 1,1 = 2,0909… с; конец: (2 + 0,6) / 1,1 + 0,3
    tl = Timeline([(0, 2), (3, 5)], 1.1)
    assert to_srt(speech((3.3, 3.6, "слово")), tl) == "1\n00:00:02,091 --> 00:00:02,664\nслово\n\n"


def test_srt_cues_are_phrases_cut_into_even_chunks():
    words = speech(
        (0.0, 0.2, "раз"), (0.3, 0.5, "два"), (0.6, 0.8, "три"), (0.9, 1.1, "четыре"), (1.2, 1.4, "пять"),
        (1.5, 1.7, "шесть"), (1.8, 2.0, "семь"), (2.1, 2.3, "восемь."), (2.4, 2.6, "девять"), (2.7, 2.9, "десять"),
    )
    # первая фраза — 8 слов, max_words = 7 по умолчанию: n = 2, значит 4 + 4, а не 7 + 1
    assert to_srt(words, whole(10)) == (
        "1\n00:00:00,000 --> 00:00:01,200\nраз два три четыре\n\n"
        "2\n00:00:01,200 --> 00:00:02,400\nпять шесть семь восемь.\n\n"
        "3\n00:00:02,400 --> 00:00:03,200\nдевять десять\n\n"
    )


def test_srt_cue_holds_up_to_seven_words_by_default():
    assert to_srt(row(7), whole(10)) == "1\n00:00:00,000 --> 00:00:02,300\nw0 w1 w2 w3 w4 w5 w6\n\n"


def test_srt_max_words_sets_the_chunk_size():
    words = speech(
        (0.0, 0.2, "раз"), (0.3, 0.5, "два"), (0.6, 0.8, "три"), (0.9, 1.1, "четыре"), (1.2, 1.4, "пять"),
        (1.5, 1.7, "шесть"), (1.8, 2.0, "семь"), (2.1, 2.3, "восемь."), (2.4, 2.6, "девять"), (2.7, 2.9, "десять"),
    )
    texts = [block.split("\n")[2] for block in to_srt(words, whole(10), max_words=3).split("\n\n")[:-1]]
    assert texts == ["раз два", "три четыре пять", "шесть семь восемь.", "девять десять"]


def test_srt_cue_ends_where_the_next_begins_or_a_beat_after_its_last_word():
    words = speech((0.0, 0.4, "раз."), (0.8, 1.2, "два."), (2.5, 2.9, "три."))
    assert to_srt(words, whole(3.0)) == (
        "1\n00:00:00,000 --> 00:00:00,800\nраз.\n\n"  # до следующей реплики 0,4 с — тянем до неё
        "2\n00:00:00,800 --> 00:00:01,500\nдва.\n\n"  # до следующей 1,3 с — гасим через 0,3 с
        "3\n00:00:02,500 --> 00:00:03,000\nтри.\n\n"  # 2,9 + 0,3 вышло бы за конец финала (3,0 с)
    )


def test_srt_breaks_on_a_pause_the_cut_plan_shrank():
    words = speech((1.0, 1.5, "раз"), (2.5, 3.0, "два"))
    tl = Timeline([(0.88, 1.56), (2.38, 3.08)], 1.0)
    assert to_srt(words, tl) == (
        "1\n00:00:00,120 --> 00:00:00,800\nраз\n\n"
        "2\n00:00:00,800 --> 00:00:01,380\nдва\n\n"
    )


def test_srt_skips_cut_words():
    words = speech((0.5, 1.0, "до"), (2.2, 2.7, "вырезанное"), (3.5, 4.0, "после"))
    tl = Timeline([(0, 2), (3, 5)], 1.0)
    assert to_srt(words, tl) == (
        "1\n00:00:00,500 --> 00:00:01,300\nдо\n\n"
        "2\n00:00:02,500 --> 00:00:03,300\nпосле\n\n"
    )


def test_srt_drops_empty_cues_and_numbers_the_rest_from_one():
    # у «раз.» и «два» одно начало: у первой реплики длины нет, её отбрасываем, а вторая получает номер 1
    words = speech((1.0, 1.4, "раз."), (1.0, 1.2, "два"))
    assert to_srt(words, whole(10)) == "1\n00:00:01,000 --> 00:00:01,500\nдва\n\n"


@pytest.mark.parametrize(
    "start, end, times",
    [
        (0.0625, 0.5, "00:00:00,063 --> 00:00:00,800"),  # 62,5 мс — вверх, а не к чётному
        (59.9996, 60.2, "00:01:00,000 --> 00:01:00,500"),  # 59999,6 мс — ровно минута
        (3300.0, 3300.5, "00:55:00,000 --> 00:55:00,800"),  # минуты есть, часов ещё нет
        (3725.5, 3726.0, "01:02:05,500 --> 01:02:06,300"),
    ],
)
def test_srt_timestamp_is_hh_mm_ss_comma_ms_rounded_half_up(start, end, times):
    assert to_srt(speech((start, end, "слово")), whole(4000)) == f"1\n{times}\nслово\n\n"


def test_srt_without_kept_words_is_empty():
    tl = Timeline([(0, 2)], 1.0)
    assert to_srt([], tl) == ""
    assert to_srt(speech((5.0, 5.5, "вырезано")), tl) == ""


@pytest.mark.parametrize("max_words", [0, -3, math.nan, math.inf], ids=["zero", "negative", "nan", "infinity"])
def test_srt_max_words_must_be_at_least_one(max_words):
    with pytest.raises(ValueError, match="max_words"):
        to_srt(row(2), whole(10), max_words=max_words)


# ---------- что бы ни пришло, события и реплики в порядке ----------


def random_case(rng: random.Random) -> tuple[list[Word], Timeline]:
    """Что попало: слова вперемешку, налезающие друг на друга, нулевой и «отрицательной» длины, в вырезках и за концом
    отрезков."""
    words, t = [], rng.choice([0.0, 0.4])
    for _ in range(rng.randint(0, 20)):
        t0 = round(t, 3)
        t1 = round(t0 + rng.choice([-0.1, 0.0, 0.1, 0.3, 0.8]), 3)
        words.append(Word(t0, t1, rng.choice(["слово", "конец.", "да?", "«ну»!", "и"])))
        t = max(t0, t1 + rng.choice([-0.5, 0.0, 0.1, 0.3, 0.4, 0.7, 2.0]))
    rng.shuffle(words)
    keep, at = [], 0.0
    for _ in range(rng.randint(0, 4)):
        start = at + rng.choice([0.0, 0.3, 1.5])
        keep.append((start, start + rng.choice([0.5, 2.0, 6.0])))
        at = keep[-1][1]
    return words, Timeline(keep, rng.choice([1.0, 1.1, 1.25]))


CUE = r"(\d+)\n(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)\n(\S+(?: \S+)*)\n\n"


def srt_cues(srt: str) -> list[tuple[int, int, int, str]]:
    """SRT → `[(номер, начало в мс, конец в мс, текст)]`; не по формату — ошибка теста."""
    assert re.fullmatch(f"(?:{CUE})*", srt), srt
    cues = []
    for number, h0, m0, s0, ms0, h1, m1, s1, ms1, text in re.findall(CUE, srt):
        start = ((int(h0) * 60 + int(m0)) * 60 + int(s0)) * 1000 + int(ms0)
        end = ((int(h1) * 60 + int(m1)) * 60 + int(s1)) * 1000 + int(ms1)
        cues.append((int(number), start, end, text))
    return cues


def test_events_do_not_overlap_and_are_sorted():
    words = speech((2.0, 2.5, "потом"), (0.0, 0.6, "сначала"), (0.5, 1.0, "налезает."), (1.0, 1.2, "да"))
    tl = Timeline([(0, 1.1), (1.9, 3.0)], 1.1)
    for mode in MODES:
        events = build_sub_events(words, tl, mode, 2)
        assert [e["words"][e["active"]] for e in events] == ["сначала", "налезает.", "да", "потом"], mode
        for before, after in pairwise(events):
            assert before["t0"] < before["t1"] <= after["t0"] < after["t1"], mode


def test_random_input_gives_ordered_events_inside_the_final():
    for seed in range(300):
        rng = random.Random(seed)
        words, tl = random_case(rng)
        for mode in MODES:
            n_words = rng.randint(1, 6)
            where = f"seed {seed}, {mode}, n_words {n_words}"
            events = build_sub_events(words, tl, mode, n_words)
            for e in events:
                assert 0 <= e["t0"] < e["t1"] <= tl.duration + EPS, where
                assert 0 <= e["active"] < e["visible"] <= len(e["words"]), where
            for before, after in pairwise(events):
                assert before["t1"] <= after["t0"], where


def test_random_input_gives_ordered_numbered_srt_inside_the_final():
    for seed in range(300):
        rng = random.Random(seed)
        words, tl = random_case(rng)
        max_words = rng.randint(1, 7)
        where = f"seed {seed}, max_words {max_words}"
        cues = srt_cues(to_srt(words, tl, max_words))
        assert [number for number, *_ in cues] == list(range(1, len(cues) + 1)), where
        for _, start, end, text in cues:
            assert 0 <= start <= end <= tl.duration * 1000 + 1, where
            assert len(text.split(" ")) <= max_words, where
        for (_, _, before_end, _), (_, after_start, _, _) in pairwise(cues):
            assert before_end <= after_start, where


# ---------- тизер ----------


def test_teaser_words_show_at_the_start_and_again_in_their_place():
    words = speech((0.5, 0.9, "Привет,"), (1.0, 1.4, "друзья."), (6.0, 6.5, "Главное"), (6.6, 7.2, "правило."), (8.0, 8.4, "Конец."))
    tl = Timeline([(0.0, 10.0)], 1.0, teaser=(5.9, 7.3))
    events = build_sub_events(words, tl, "karaoke", 3)
    texts = [(round(e["t0"], 3), e["words"][e["active"]]) for e in events]
    assert texts[:2] == [(0.1, "Главное"), (0.7, "правило.")], "тизер — первые слова ролика"
    assert texts[2] == (1.9, "Привет,")
    assert (7.4, "Главное") in texts and (8.0, "правило.") in texts, "и ещё раз на своём месте"
    assert events[1]["words"] == ["Главное", "правило."], "тизер — своя фраза, без начала ролика"
    assert events[1]["t1"] <= 1.4 + 1e-6, "показ тизера не заходит за его конец"


def test_teaser_words_are_in_the_srt_too():
    words = speech((0.5, 0.9, "Привет."), (6.0, 6.5, "Главное"), (6.6, 7.2, "правило."))
    srt = to_srt(words, Timeline([(0.0, 10.0)], 1.0, teaser=(5.9, 7.3)))
    blocks = srt.strip().split("\n\n")
    assert blocks[0].endswith("Главное правило.") and blocks[0].split("\n")[1].startswith("00:00:00,100")
    assert "Привет." in blocks[1] and "Главное правило." in blocks[2]


# ---------- soft: стиль эталона ----------


def test_soft_block_is_two_lines_one_event_per_line():
    words = row(6)
    texts = [w.text for w in words]
    assert build_sub_events(words, whole(10), "soft", 3) == [
        {"t0": 0.0, "t1": 0.9, "words": texts, "active": 0, "visible": 3, "lines": [3, 3], "opens": True},
        {"t0": 0.9, "t1": 2.0, "words": texts, "active": 3, "visible": 6, "lines": [3, 3], "opens": True},  # конец + 0,3 с
    ]


def test_a_soft_block_says_whether_it_opens_a_sentence():
    """Шаблон пишет первое слово блока со строчной, только если с него начинается предложение: имя посреди
    предложения на краю блока (и после паузы без точки) остаётся с заглавной."""
    words = speech((0.0, 0.2, "Вчера"), (0.3, 0.5, "я"), (0.6, 0.8, "встретил"), (0.9, 1.1, "Павла"), (1.2, 1.4, "и"),
                   (1.5, 1.7, "его"), (1.8, 2.0, "друга."), (2.1, 2.3, "Они"), (2.4, 2.6, "сказали"),
                   (3.2, 3.4, "Олеся"), (3.5, 3.7, "здесь."))
    events = build_sub_events(words, whole(10), "soft", 3)
    heads = [(e["words"][0], e["opens"]) for e in events if e["active"] == 0]
    assert heads == [("Вчера", True), ("Павла", False), ("Они", True), ("Олеся", False)]


def test_after_accent_words_the_sentence_is_read_through_them():
    """Слова акцента не в субтитрах, но предложение по ним видно: кончились точкой — следующий блок начинает новое."""
    words = speech((0.0, 0.2, "Это"), (0.3, 0.5, "важно."), (0.6, 0.8, "Сегодня"), (0.9, 1.1, "расскажу"))
    assert build_sub_events(words, whole(10), "soft", 3, hidden=[(0.0, 0.55)])[0]["opens"] is True
    words = speech((0.0, 0.2, "Привет"), (0.3, 0.5, "тебе"), (0.6, 0.8, "Павел"))
    events = build_sub_events(words, whole(10), "soft", 3, hidden=[(0.25, 0.55)])
    assert [(e["words"][0], e["opens"]) for e in events] == [("Привет", True), ("Павел", False)]


def test_the_teaser_and_the_video_after_it_open_with_a_sentence():
    words = speech((0.5, 0.9, "Привет"), (1.0, 1.4, "всем"), (6.0, 6.5, "Главное"), (6.6, 7.2, "правило."))
    tl = Timeline([(0.0, 10.0)], 1.0, teaser=(5.9, 7.3))
    events = build_sub_events(words, tl, "soft", 3)
    assert [(e["words"][0], e["opens"]) for e in events][:2] == [("Главное", True), ("Привет", True)]


@pytest.mark.parametrize(("count", "blocks"), [
    (1, [[1]]), (3, [[3]]), (4, [[2, 2]]), (5, [[2, 3]]), (6, [[3, 3]]), (7, [[3], [2, 2]]), (12, [[3, 3], [3, 3]]),
])
def test_soft_blocks_hold_two_lines_of_up_to_n_words(count, blocks):
    events = build_sub_events(row(count), whole(10), "soft", 3)
    seen = []
    for e in events:
        if not seen or e["active"] == 0:
            seen.append(e["lines"])
        assert sum(e["lines"]) == len(e["words"])
        assert e["visible"] in [sum(e["lines"][: k + 1]) for k in range(len(e["lines"]))]
    assert seen == blocks


def test_soft_lines_do_not_cross_a_phrase():
    words = speech((0.0, 0.2, "раз"), (0.3, 0.5, "два."), (0.6, 0.8, "три"), (0.9, 1.1, "четыре"))
    events = build_sub_events(words, whole(10), "soft", 3)
    assert [(e["words"], e["lines"], e["visible"]) for e in events] == [
        (["раз", "два."], [2], 2),
        (["три", "четыре"], [2], 2),
    ]


def test_soft_takes_one_to_six_words_per_line():
    with pytest.raises(ValueError, match="n_words"):
        build_sub_events(row(2), whole(10), "soft", 7)
    assert build_sub_events(row(2), whole(10), "soft", 1)[1]["lines"] == [1, 1]


def test_hidden_words_are_not_subtitled_in_place_and_break_the_phrase():
    """Слова акцентной фразы показывает акцент: в субтитрах их нет, а фраза вокруг них рвётся."""
    words = row(6)  # w0 0.0–0.2 … w5 1.5–1.7
    for mode in (*MODES, "soft"):
        events = build_sub_events(words, whole(10), mode, 3, hidden=[(0.55, 1.15)])  # w2 и w3 — в акценте
        shown = {w for e in events for w in e["words"]}
        assert shown == {"w0", "w1", "w4", "w5"}, mode
        assert not any({"w1", "w4"} <= set(e["words"]) for e in events), f"{mode}: фраза рвётся на акценте"


def test_hidden_words_stay_in_the_teaser_copy():
    words = speech((0.5, 0.9, "Привет."), (6.0, 6.5, "Главное"), (6.6, 7.2, "правило."))
    tl = Timeline([(0.0, 10.0)], 1.0, teaser=(5.9, 7.3))
    events = build_sub_events(words, tl, "karaoke", 3, hidden=[(5.9, 7.3)])
    texts = [(round(e["t0"], 3), e["words"][e["active"]]) for e in events]
    assert texts == [(0.1, "Главное"), (0.7, "правило."), (1.9, "Привет.")]


def test_random_input_gives_ordered_soft_events_inside_the_final():
    for seed in range(300):
        rng = random.Random(seed)
        words, tl = random_case(rng)
        n_words = rng.randint(1, 6)
        where = f"seed {seed}, n_words {n_words}"
        events = build_sub_events(words, tl, "soft", n_words)
        for e in events:
            assert 0 <= e["t0"] < e["t1"] <= tl.duration + EPS, where
            assert 0 <= e["active"] < e["visible"] <= len(e["words"]) <= 2 * n_words, where
            assert len(e["lines"]) <= 2 and all(0 < n <= n_words for n in e["lines"]), where
        for before, after in pairwise(events):
            assert before["t1"] <= after["t0"], where


# ---------- куски, переставленные руками (фаза 4) ----------


def test_words_of_a_moved_piece_are_shown_where_the_piece_stands_and_start_their_own_phrase():
    """Павел поставил кусок 6–8 с перед 0–2: его слова — первыми, и фраза кусков не склеивает: «пять шесть» и «раз
    два» — разные группы, хоть в исходнике между ними нет конца предложения."""
    words = speech((0.0, 0.2, "раз"), (0.3, 0.5, "два"), (6.0, 6.2, "пять"), (6.3, 6.5, "шесть"))
    events = build_sub_events(words, Timeline([(6, 8), (0, 2)], 1.0), "karaoke", 3)
    assert [e["words"] for e in events] == [["пять", "шесть"], ["пять", "шесть"], ["раз", "два"], ["раз", "два"]]
    assert [e["t0"] for e in events] == sorted(e["t0"] for e in events)
    assert events[0]["t0"] == pytest.approx(0.0) and events[2]["t0"] == pytest.approx(2.0)
    in_order = build_sub_events(words, Timeline([(0, 2), (6, 8)], 1.0), "karaoke", 3)
    assert in_order[0]["words"] == ["раз", "два"], "по порядку — как всегда"


def test_a_word_whose_end_is_cut_ends_with_its_piece_even_when_pieces_are_moved():
    """Слово 1,8–2,2, кусок 0–2 кончается на 2,0, а за ним Павел поставил 5–8: конец слова — конец его куска, а не
    начало куска 2,5–4 далеко в ролике (ревью фазы 4: слово висело на экране 1,8–5,1 с)."""
    words = speech((0.2, 0.6, "ну"), (1.8, 2.2, "привет"), (5.2, 5.6, "пять"), (5.8, 6.2, "шесть."))
    events = build_sub_events(words, Timeline([(0, 2), (5, 8), (2.5, 4)], 1.0), "karaoke", 3)
    hello = [e for e in events if "привет" in e["words"]]
    # слово кончается с куском (2,0); показ держится до следующей фразы — «пять» с 2,2 (меньше HOLD_WITHIN), как всегда
    assert hello and max(e["t1"] for e in hello) == pytest.approx(2.2, abs=1e-6), [(e["words"], e["t0"], e["t1"]) for e in hello]
    five = next(e for e in events if "пять" in e["words"])
    assert five["t0"] == pytest.approx(2.2, abs=1e-6)


def test_accent_words_said_in_a_moved_piece_stay_in_the_subtitles_there():
    """Акцент 1–3,2 с; кусок 2–5 Павел поставил в конец: «очень важное.» звучит там — и там видно субтитрами (акцент
    стоит только в своей серии, до 2 с), а не пропадает (ревью фазы 4)."""
    words = speech((1.2, 1.6, "это"), (2.2, 2.6, "очень"), (2.7, 3.1, "важное."), (6.0, 6.4, "дальше"))
    tl = Timeline([(0, 2), (5.5, 7), (2, 5)], 1.0)
    events = build_sub_events(words, tl, "karaoke", 3, hidden=[(1.0, 3.2)])
    shown = {w for e in events for w in e["words"]}
    assert {"очень", "важное."} <= shown and "это" not in shown
    late = [e for e in events if "очень" in e["words"]]
    assert min(e["t0"] for e in late) >= 3.5 - 1e-6, "там, где сказано: кусок 2–5 стоит с 3,5 с"
