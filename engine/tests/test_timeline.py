"""Шкала времени: как время исходника становится временем финала (вырезки + ускорение). Чистая арифметика."""
import json
import math
from pathlib import Path

import pytest

from vm.timeline import Timeline

EPS = 1e-6  # допуск сравнения времён в тестах, с
SPEED = 1.1


def approx(value: float):
    return pytest.approx(value, abs=EPS)


@pytest.fixture
def tl() -> Timeline:
    """Исходник 0–2 и 3–5 с, секунда между ними вырезана; финал: 4 с исходника за 4/1,1 с."""
    return Timeline([(0, 2), (3, 5)], SPEED)


def test_timeline_speed_and_gaps(tl):
    assert tl.duration == approx(4 / SPEED)
    assert tl.to_final(3.0) == approx(2 / SPEED)
    assert tl.to_final(2.5) is None
    assert tl.to_final_snap(2.5) == approx(2 / SPEED)


def test_to_source_goes_back_from_the_final(tl):
    for t in (0.0, 1.0, 1.99, 3.0, 4.2, 5.0):
        assert tl.to_source(tl.to_final(t)) == approx(t)
    assert tl.to_source(tl.duration + 1.0) == approx(5.0)  # стоп-кадр — последний кадр исходника


def test_segments_are_source_start_source_end_and_final_start(tl):
    assert tl.segments == [(0, 2, 0), (3, 5, approx(2 / SPEED))]


def test_inside_a_segment_time_is_counted_from_its_start_and_sped_up(tl):
    assert tl.to_final(1.0) == approx(1 / SPEED)
    assert tl.to_final(4.0) == approx(3 / SPEED)  # 2 с первого отрезка + 1 с второго


def test_segment_edges_belong_to_the_segment(tl):
    # слово может кончаться ровно на краю отрезка — его конец не должен считаться вырезанным
    assert tl.to_final(0.0) == approx(0.0)
    assert tl.to_final(2.0) == approx(2 / SPEED)
    assert tl.to_final(5.0) == approx(tl.duration)


def test_outside_the_kept_parts_time_is_cut(tl):
    assert tl.to_final(-0.1) is None
    assert tl.to_final(2.01) is None
    assert tl.to_final(2.99) is None
    assert tl.to_final(5.01) is None


def test_snap_moves_cut_time_to_the_start_of_the_next_segment():
    tl = Timeline([(1, 2), (3, 5), (8, 9)], SPEED)
    assert tl.to_final_snap(0.0) == approx(0.0)  # до первого отрезка
    assert tl.to_final_snap(2.5) == approx(1 / SPEED)
    assert tl.to_final_snap(6.0) == approx(3 / SPEED)
    assert tl.to_final_snap(9.5) == approx(tl.duration)  # после последнего — конец финала


def test_snap_inside_a_segment_is_the_same_as_to_final(tl):
    for t in (0.0, 1.3, 2.0, 3.0, 4.2, 5.0):
        assert tl.to_final_snap(t) == approx(tl.to_final(t))


def test_speed_one_only_removes_the_cuts():
    tl = Timeline([(0, 2), (3, 5)], 1.0)
    assert tl.duration == approx(4.0)
    assert tl.to_final(4.0) == approx(3.0)


def test_final_time_grows_with_source_time_across_many_segments():
    keep = [(0.5 * i, 0.5 * i + 0.3) for i in range(40)]
    tl = Timeline(keep, SPEED)
    times = [t for a, b in keep for t in (a, (a + b) / 2, b)]  # начало, середина и конец каждого отрезка
    final = [tl.to_final(t) for t in times]
    assert final == sorted(final)
    assert final[-1] == approx(tl.duration)


def test_keep_as_json_lists_works_the_same():
    # edit.json отдаёт отрезки списками, а времена — и целыми числами
    assert Timeline([[0, 2], [3, 5]], SPEED).segments == Timeline([(0.0, 2.0), (3.0, 5.0)], SPEED).segments


def test_segments_cannot_be_changed_from_outside(tl):
    tl.segments.clear()
    assert len(tl.segments) == 2
    assert tl.to_final(4.0) == approx(3 / SPEED)


def test_touching_segments_are_fine():
    tl = Timeline([(0, 2), (2, 4)], SPEED)
    assert tl.to_final(2.0) == approx(2 / SPEED)
    assert tl.duration == approx(4 / SPEED)


def test_nothing_kept_gives_an_empty_timeline():
    tl = Timeline([], SPEED)
    assert tl.duration == 0
    assert tl.segments == []
    assert tl.to_final(1.0) is None
    assert tl.to_final_snap(1.0) == 0


@pytest.mark.parametrize(
    "keep, problem",
    [
        ([(3, 5), (0, 2)], r"keep\[1\].*in order"),
        ([(0, 3), (2, 5)], r"keep\[1\].*overlap"),
        ([(1, 1)], r"keep\[0\].*end after"),
        ([(2, 1)], r"keep\[0\].*end after"),
        ([(0, 2), (3, math.inf)], r"keep\[1\].*finite"),
        ([(0, 2), (3, math.nan)], r"keep\[1\].*finite"),
        ([(0, 2), (3,)], r"keep\[1\].*\[start, end\]"),
        ([(0, 2), "ab"], r"keep\[1\]"),
    ],
    ids=["unsorted", "overlapping", "empty", "backwards", "infinite", "nan", "one number", "not a pair"],
)
def test_keep_that_is_not_ordered_segments_is_refused_with_the_segment_number(keep, problem):
    with pytest.raises(ValueError, match=problem):
        Timeline(keep, SPEED)


@pytest.mark.parametrize("speed", [0, -1.1, math.nan, math.inf])
def test_speed_must_be_a_positive_number(speed):
    with pytest.raises(ValueError, match="speed"):
        Timeline([(0, 2)], speed)


# ---------- тизер: фраза из середины звучит первой, потом ролик с начала ----------


def test_teaser_plays_first_then_the_whole_video():
    tl = Timeline([(0.0, 10.0)], 1.0, teaser=(6.0, 8.0))
    assert tl.teaser == (6.0, 8.0) and tl.teaser_duration == pytest.approx(2.0)
    assert tl.duration == pytest.approx(12.0)
    assert tl.segments == [(6.0, 8.0, 0.0), (0.0, 10.0, 2.0)]
    assert tl.to_final(7.0) == pytest.approx(9.0), "своё место фразы — после тизера"
    assert tl.teaser_final(7.0) == pytest.approx(1.0) and tl.teaser_final(9.0) is None
    assert tl.to_final_snap(0.0) == pytest.approx(2.0)
    assert tl.to_source(1.0) == pytest.approx(7.0) and tl.to_source(2.0) == pytest.approx(0.0)


def test_teaser_is_sped_up_with_the_video():
    tl = Timeline([(0.0, 10.0), (12.0, 20.0)], 1.25, teaser=(14.0, 16.0))
    assert tl.teaser_duration == pytest.approx(1.6)
    assert tl.duration == pytest.approx((2.0 + 18.0) / 1.25)
    assert tl.to_final(13.0) == pytest.approx(1.6 + (10.0 + 1.0) / 1.25)
    assert tl.teaser_final(15.0) == pytest.approx(0.8)
    assert tl.to_source(0.8) == pytest.approx(15.0)
    assert tl.to_source(1.6 + 11.0 / 1.25) == pytest.approx(13.0)
    assert [s[2] for s in tl.segments] == pytest.approx([0.0, 1.6, 1.6 + 8.0])


def test_without_a_teaser_nothing_changes():
    tl = Timeline([(0.0, 10.0)], 1.0)
    assert tl.teaser is None and tl.teaser_duration == 0 and tl.teaser_final(5.0) is None


@pytest.mark.parametrize("teaser", [(5.0, 5.0), (6.0, 5.0), (math.nan, 5.0), ("a", 1)])
def test_a_teaser_must_be_a_real_span(teaser):
    with pytest.raises(ValueError, match="teaser"):
        Timeline([(0.0, 10.0)], 1.0, teaser=teaser)


def test_a_moment_next_to_a_jump_cut_lands_on_the_cut():
    tl = Timeline([(0.0, 2.0), (2.5, 6.0)], 1.0)  # стык: 2,0 с финала
    assert tl.to_cut(2.6) == 2.0, "0,1 с после начала отрезка — на стыке"
    assert tl.to_cut(1.9) == 2.0, "0,1 с до конца отрезка — тоже на стыке"
    assert tl.to_cut(3.0) == tl.to_final(3.0) and tl.to_cut(1.5) == 1.5, "дальше 0,25 с — на своём месте"
    assert tl.to_cut(2.2) == 2.0, "в вырезке — на начале следующего отрезка, как to_final_snap"
    assert tl.to_cut(0.1) == 0.0 and tl.to_cut(5.9) == tl.duration, "начало и конец ролика — тоже края"
    with_teaser = Timeline([(0.0, 2.0), (2.5, 6.0)], 1.0, teaser=(3.0, 4.0))
    assert with_teaser.to_cut(0.1) == 1.0, "первый отрезок после тизера — стык с тизером"


def test_in_a_short_piece_a_moment_lands_on_the_nearer_cut():
    tl = Timeline([(0.0, 2.0), (2.5, 2.8), (3.0, 6.0)], 1.0)  # кусок 0,3 с: стыки на 2,0 и 2,3 с финала
    assert tl.to_cut(2.6) == 2.0
    assert tl.to_cut(2.75) == pytest.approx(2.3)


# ---------- общая фикстура со страницей (web/lib/timeline.ts) ----------

SHARED = json.loads((Path(__file__).parent / "fixtures" / "timeline-map.json").read_text(encoding="utf-8"))


def _same(got, want):
    return got is None and want is None or (got is not None and want is not None and abs(got - want) <= 1e-9)


@pytest.mark.parametrize("case", SHARED["cases"], ids=lambda c: f"{len(c['keep'])}seg-x{c['speed']}-teaser{bool(c['teaser'])}")
def test_timeline_matches_the_shared_fixture(case):
    tl = Timeline(case["keep"], case["speed"], case["teaser"])
    assert _same(tl.duration, case["duration"]) and _same(tl.teaser_duration, case["teaserDuration"])
    assert len(tl.segments) == len(case["segments"])
    assert all(_same(x, y) for got, want in zip(tl.segments, case["segments"], strict=True) for x, y in zip(got, want, strict=True))
    for name, fn in (("toFinal", tl.to_final), ("teaserFinal", tl.teaser_final), ("toFinalSnap", tl.to_final_snap),
                     ("toCut", tl.to_cut), ("toSource", tl.to_source)):
        for t, want in case[name]:
            assert _same(fn(t), want), f"{name}({t}) = {fn(t)}, want {want}"
    for t, within, want in case["toCutWithin"]:
        assert _same(tl.to_cut(t, within), want)


@pytest.mark.parametrize("bad", SHARED["refused"])
def test_timeline_refuses_what_the_shared_fixture_refuses(bad):
    with pytest.raises(ValueError):
        Timeline(bad["keep"], bad["speed"], bad.get("teaser"))
