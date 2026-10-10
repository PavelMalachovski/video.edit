"""План нарезки: что остаётся от исходника. Чистая арифметика над словами — быстро, без ffmpeg и моделей.

Поля: 0,12 с перед словом и 0,08 с после слова. Длинная пауза ужимается до 0,18 с: 0,12 с остаются перед следующим
словом и 0,06 с — после предыдущего. Времена подобраны так, чтобы ожидаемое считалось в уме.
"""
import math
import random
from itertools import pairwise

import pytest

from vm.asr import Word
from vm.cuts import plan_keep

EPS = 1e-6  # допуск сравнения времён в тестах, с


def speech(*spans: tuple[float, float]) -> list[Word]:
    """Слова с заданным временем; текст не важен — резка его не читает."""
    return [Word(t0, t1, "слово") for t0, t1 in spans]


def assert_keeps(actual, *expected):
    assert len(actual) == len(expected), f"{actual} != {list(expected)}"
    for got, want in zip(actual, expected, strict=True):
        assert got == pytest.approx(want, abs=EPS), f"{actual} != {list(expected)}"


# ---------- края и паузы ----------


def test_trims_leading_and_trailing_silence():
    assert_keeps(plan_keep(speech((2.0, 5.0)), 8.0), (1.88, 5.08))


def test_long_pause_shrinks_to_keep_pause():
    # пауза 1,0 с → 0,18 с: 0,06 с остаются после первого слова и 0,12 с — перед вторым
    words = speech((1.0, 2.0), (3.0, 4.0))
    assert_keeps(plan_keep(words, 6.0), (0.88, 2.06), (2.88, 4.08))


def test_short_pause_kept_whole():
    words = speech((1.0, 2.0), (2.3, 3.0))  # пауза 0,3 с
    assert_keeps(plan_keep(words, 5.0), (0.88, 3.08))


def test_pause_of_exactly_max_pause_is_kept_whole():
    # в float 2.45 − 2.0 чуть больше 0.45: ровно 0,45 с длинной паузой считаться не должно
    assert_keeps(plan_keep(speech((1.0, 2.0), (2.45, 3.0)), 5.0), (0.88, 3.08))
    # а на 10 мс длиннее — уже длинная: 0,46 с → 0,18 с
    assert_keeps(plan_keep(speech((1.0, 2.0), (2.46, 3.0)), 5.0), (0.88, 2.06), (2.34, 3.08))


def test_padding_stops_at_the_ends_of_the_clip():
    # слово начинается через 0,05 с после старта и кончается за 0,03 с до конца: полей не хватает — берём всё
    assert_keeps(plan_keep(speech((0.05, 0.97)), 1.0), (0.0, 1.0))


def test_no_words_keeps_everything():
    assert plan_keep([], 12.5) == [(0, 12.5)]


def test_words_may_come_unsorted():
    words = speech((3.0, 4.0), (1.0, 2.0))
    assert_keeps(plan_keep(words, 6.0), (0.88, 2.06), (2.88, 4.08))


def test_pad_before_and_pad_after_are_independent():
    assert_keeps(plan_keep(speech((2.0, 5.0)), 8.0, pad_before=0.3, pad_after=0.1), (1.7, 5.1))


def test_a_shrunk_pause_never_exceeds_keep_pause():
    # keep_pause меньше поля перед словом: от паузы остаётся только keep_pause, и всё это — перед следующим словом
    words = speech((1.0, 2.0), (3.0, 4.0))
    assert_keeps(plan_keep(words, 6.0, keep_pause=0.1), (0.88, 2.0), (2.9, 4.08))


@pytest.mark.parametrize("gap", [0.2, 0.3], ids=["shorter than keep_pause", "exactly keep_pause"])
def test_segments_that_touch_after_padding_are_merged(gap):
    # необычные настройки: keep_pause длиннее max_pause, и пауза «ужимается» до того, что в ней уже нечего резать
    words = speech((1.0, 2.0), (2.0 + gap, 3.0))
    assert_keeps(plan_keep(words, 5.0, max_pause=0.1, keep_pause=0.3), (0.88, 3.08))


@pytest.mark.parametrize("name", ["max_pause", "keep_pause", "pad_before", "pad_after"])
def test_negative_settings_are_refused(name):
    # отрицательное поле срезало бы край самого слова
    with pytest.raises(ValueError, match=name):
        plan_keep(speech((1.0, 2.0)), 5.0, **{name: -0.01})


# ---------- слова, налезающие друг на друга ----------


def test_overlapping_and_touching_words_are_one_stretch_of_speech():
    # Claude правит words.json вручную: слова могут налезать друг на друга и стыковаться — паузы между ними нет
    words = speech((1.0, 2.5), (2.0, 3.0), (3.0, 4.0), (6.0, 7.0))
    assert_keeps(plan_keep(words, 9.0), (0.88, 4.06), (5.88, 7.08))


def test_a_word_inside_a_longer_word_does_not_pull_the_end_of_speech_back():
    # 1.5–2.0 лежит внутри 1.0–3.0: пауза до 3.4 — это 0,4 с от конца длинного слова (оставляем), а не 1,4 с от 2.0
    words = speech((1.0, 3.0), (1.5, 2.0), (3.4, 4.0))
    assert_keeps(plan_keep(words, 6.0), (0.88, 4.08))


# ---------- extra_cuts ----------


def test_extra_cut_snaps_to_word_bounds():
    # вырезка 1.5–3.2 задевает первые два слова (1.0–2.0 и 3.0–4.0): оба уходят целиком, внутри слова не режем
    words = speech((1.0, 2.0), (3.0, 4.0), (4.2, 5.0))
    assert_keeps(plan_keep(words, 8.0, extra_cuts=[(1.5, 3.2)]), (4.08, 5.08))


def test_cut_word_between_kept_words_with_short_pauses_keeps_those_pauses():
    # слово 2.1–2.3 вырезано целиком, а паузы вокруг него короткие (0,1 с): остаются как были, без «ужатия»
    words = speech((1.0, 2.0), (2.1, 2.3), (2.4, 3.0))
    assert_keeps(plan_keep(words, 5.0, extra_cuts=[(2.15, 2.2)]), (0.88, 2.1), (2.3, 3.08))


def test_cut_word_inside_a_long_pause_goes_with_it():
    # вырезано слово 3.0–3.5; пауза между оставшимися 3,0 с ужимается до 0,18 с, как обычная
    words = speech((1.0, 2.0), (3.0, 3.5), (5.0, 6.0))
    assert_keeps(plan_keep(words, 8.0, extra_cuts=[(3.1, 3.2)]), (0.88, 2.06), (4.88, 6.08))


def test_cut_that_removes_the_first_word_moves_the_start():
    words = speech((1.0, 2.0), (4.0, 5.0))
    assert_keeps(plan_keep(words, 8.0, extra_cuts=[(1.2, 1.4)]), (3.88, 5.08))


def test_cut_ending_exactly_where_a_word_starts_does_not_touch_it():
    # слова встык 1.0–2.0 и 2.0–3.0: вырезка до 2.0 убирает только первое; второе остаётся целым
    assert_keeps(plan_keep(speech((1.0, 2.0), (2.0, 3.0)), 5.0, extra_cuts=[(0.0, 2.0)]), (2.0, 3.08))


def test_cut_growing_over_a_word_that_overlaps_the_cut_word_takes_that_one_too():
    # 1.0–3.0 задето вырезкой; 2.5–4.0 налезает на него справа — расширенная вырезка задевает и его, оно уходит целиком
    words = speech((1.0, 3.0), (2.5, 4.0), (6.0, 7.0))
    assert_keeps(plan_keep(words, 9.0, extra_cuts=[(1.2, 1.5)]), (5.88, 7.08))


def test_cut_growing_over_an_earlier_word_that_overlaps_the_cut_word_takes_that_one_too():
    # вырезка 4–5 задевает 2.0–6.0; 1.0–3.0 налезает на это слово слева, идёт в списке раньше и сперва не задето.
    # Паузы не ужимаем (max_pause=inf), чтобы остаток слова не скрыла ужатая пауза: видны только вырезки
    words = speech((0.2, 0.8), (1.0, 3.0), (2.0, 6.0), (8.0, 9.0))
    keep = plan_keep(words, 10.0, max_pause=math.inf, extra_cuts=[(4.0, 5.0)])
    assert_keeps(keep, (0.08, 1.0), (6.0, 9.08))


def test_cut_in_silence_touches_no_word_and_is_made_as_asked():
    words = speech((1.0, 2.0), (2.3, 3.0))
    assert_keeps(plan_keep(words, 5.0, extra_cuts=[(2.05, 2.15)]), (0.88, 2.05), (2.15, 3.08))


def test_cut_inside_a_pause_that_is_shrunk_anyway_changes_nothing():
    words = speech((1.0, 2.0), (6.0, 7.0))
    assert_keeps(plan_keep(words, 9.0, extra_cuts=[(3.0, 5.0)]), (0.88, 2.06), (5.88, 7.08))


def test_overlapping_cuts_in_silence_are_one_cut():
    words = speech((1.0, 2.0), (2.3, 3.0))
    assert_keeps(plan_keep(words, 5.0, extra_cuts=[(2.1, 2.25), (2.05, 2.15)]), (0.88, 2.05), (2.25, 3.08))


def test_extra_cuts_without_words_are_cut_out_of_the_whole_clip():
    assert_keeps(plan_keep([], 10.0, extra_cuts=[(2.0, 3.0), (8.0, 12.0)]), (0.0, 2.0), (3.0, 8.0))


def test_cutting_every_word_keeps_nothing():
    assert plan_keep(speech((1.0, 2.0), (3.0, 4.0)), 6.0, extra_cuts=[(0.0, 5.0)]) == []


def test_empty_cut_is_ignored():
    assert_keeps(plan_keep(speech((1.0, 2.0)), 4.0, extra_cuts=[(1.5, 1.5)]), (0.88, 2.08))


@pytest.mark.parametrize("cut", [(3.0, 2.0), (0.5, math.nan)], ids=["backwards", "nan"])
def test_cut_that_is_not_a_span_of_time_is_refused_with_its_number(cut):
    with pytest.raises(ValueError, match=r"extra_cuts\[1\]"):
        plan_keep(speech((1.0, 2.0)), 4.0, extra_cuts=[(0.1, 0.2), cut])


# ---------- что бы ни пришло, слова целы, а отрезки по порядку ----------


def random_speech(rng: random.Random) -> tuple[list[Word], float]:
    """Речь с чем попало: стыки, наложения, слова нулевой длины, паузы вокруг порога 0,45 с."""
    words, t0 = [], rng.choice([0.0, 0.05, 0.7])
    for _ in range(rng.randint(1, 25)):
        t1 = round(t0 + rng.choice([0.0, 0.05, 0.2, 0.4, 1.3]), 3)
        words.append(Word(round(t0, 3), t1, "слово"))
        t0 = max(t0, t1 + rng.choice([-0.6, -0.1, 0.0, 0.1, 0.3, 0.45, 0.46, 0.9, 2.5]))
    end = max(w.t1 for w in words) + rng.choice([0.0, 0.03, 1.0])  # ролик кончается с речью, чуть позже или позже
    return words, round(max(end, 0.1), 3)


def random_cuts(rng: random.Random, duration: float) -> list[tuple[float, float]]:
    starts = [rng.uniform(0, duration) for _ in range(rng.randint(0, 3))]
    return [(start, start + rng.uniform(0.01, 2.0)) for start in starts]


def overlap(word: Word, a: float, b: float) -> float:
    return min(b, word.t1) - max(a, word.t0)


def whole(word: Word, keep) -> bool:
    return any(a - EPS <= word.t0 and word.t1 <= b + EPS for a, b in keep)


def gone(word: Word, keep) -> bool:
    return all(overlap(word, a, b) <= EPS for a, b in keep)


def assert_ordered_and_whole(keep, words, duration, cuts, where):
    assert all(0 <= a < b <= duration for a, b in keep), where
    assert all(a1 < b0 for (_, a1), (b0, _) in pairwise(keep)), where  # по порядку, без пересечений и стыков
    for word in words:  # слово остаётся целиком или уходит целиком — внутри слова не режем
        assert whole(word, keep) or gone(word, keep), f"{word}, {where}"
        if any(overlap(word, a, b) > EPS for a, b in cuts):
            assert gone(word, keep), f"{word} is touched by a cut but stays; {where}"


def assert_pauses_are_gentle(keep, words, where):
    assert all(whole(word, keep) for word in words), where
    inside = [[word for word in words if whole(word, [segment])] for segment in keep]
    for (a, b), spoken in zip(keep, inside, strict=True):  # внутри отрезка мёртвого воздуха дольше 0,45 с нет
        reach = a
        for word in sorted(spoken, key=lambda w: w.t0):
            assert word.t0 - reach <= 0.45 + EPS, where
            reach = max(reach, word.t1)
        assert b - reach <= 0.45 + EPS, where
    for ((_, end), (start, _)), (left, right) in zip(pairwise(keep), pairwise(inside), strict=True):
        # каждая ужатая пауза — ровно 0,18 с: 0,06 после слова и 0,12 перед следующим
        kept = (end - max(w.t1 for w in left)) + (min(w.t0 for w in right) - start)
        assert kept == pytest.approx(0.18, abs=EPS), where


def test_random_speech_gives_ordered_segments_and_whole_words():
    for seed in range(400):
        rng = random.Random(seed)
        words, duration = random_speech(rng)
        keep = plan_keep(words, duration)
        where = f"seed {seed}, no cuts: {keep}"
        assert_ordered_and_whole(keep, words, duration, [], where)
        assert_pauses_are_gentle(keep, words, where)
        cuts = random_cuts(rng, duration)
        keep = plan_keep(words, duration, extra_cuts=cuts)
        assert_ordered_and_whole(keep, words, duration, cuts, f"seed {seed}, cuts {cuts}: {keep}")
