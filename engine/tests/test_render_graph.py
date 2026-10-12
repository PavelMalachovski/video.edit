"""Граф склейки рендера без ffmpeg: каждый вход исходника читает свои отрезки строго по возрастанию — иначе кадры до
отрезка, которого склейка ещё не ждёт, копились бы в памяти (≈3 МБ на кадр 1080×1920)."""
import re

from vm.render import _cut, decoders, segment_frames
from vm.timeline import Timeline


def reads(chains: list[str]) -> dict[int, list[int]]:
    """Вход → номера отрезков, которые он раздаёт (split), в порядке склейки."""
    out = {}
    for c in chains:
        if m := re.match(r"\[(\d+):v\]split=\d+((?:\[sv\d+\])+)$", c):
            out[int(m[1])] = [int(x) for x in re.findall(r"\[sv(\d+)\]", m[2])]
    return out


def test_in_order_pieces_are_read_by_one_input_as_before():
    tl = Timeline([[0, 2], [3, 5], [6, 8]], 1.1)
    assert decoders(segment_frames(tl)) == [0, 0, 0]
    assert reads(_cut(tl, True, [0])) == {0: [0, 1, 2]}


def test_a_piece_moved_to_the_front_is_read_by_its_own_input():
    tl = Timeline([[10.5, 16], [0, 5], [5.5, 10]], 1.0)
    which = decoders(segment_frames(tl))
    assert which == [0, 1, 1], "кусок из конца — первый вход, остальные по порядку — второй"
    chains = _cut(tl, True, [0, 2])
    assert reads(chains) == {0: [0], 2: [1, 2]}
    starts = {i: f0 for i, (f0, _) in enumerate(segment_frames(tl))}
    for segments in reads(chains).values():
        assert [starts[i] for i in segments] == sorted(starts[i] for i in segments), "вход читает свои отрезки по возрастанию"


def test_as_few_inputs_as_the_order_needs():
    # 4 3 2 1 — каждый следующий раньше прошлого: четыре входа; 1 3 2 4 — два
    assert decoders([(120, 150), (90, 120), (60, 90), (0, 30)]) == [0, 1, 2, 3]
    assert decoders([(0, 30), (60, 90), (30, 60), (90, 120)]) == [0, 0, 1, 0]


def test_a_teaser_plays_first_without_its_own_special_case():
    tl = Timeline([[0, 2.5], [3.3, 5.8], [36.3, 38.8]], 1.0, teaser=(36.4, 38.2))
    which = decoders(segment_frames(tl))
    assert which == [0, 1, 1, 1], "тизер с конца — свой вход, отрезки по порядку — другой"
