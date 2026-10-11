"""Ч/б-куски стиля эталона (`edit.looks`): фильтр ffmpeg с окнами во времени финала, по целым кадрам."""
import shutil
import subprocess

import numpy as np
import pytest

from vm.media import cut_frame
from vm.render import FPS, _cut, look_windows, looks_filter
from vm.timeline import Timeline

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")
WHOLE = Timeline([(0.0, 10.0)], 1.0)


def test_no_looks_no_filter():
    assert looks_filter({}, WHOLE) == ""
    assert looks_filter({"looks": []}, WHOLE) == ""


def test_windows_are_frames_of_the_final():
    assert look_windows({"looks": [{"t0": 0.5, "t1": 1.0, "look": "bw"}]}, WHOLE) == [(15, 30)]
    tl = Timeline([(0.0, 2.0), (3.0, 6.0)], 1.25)
    windows = look_windows({"looks": [{"t0": 3.5, "t1": 5.0, "look": "bw"}]}, tl)
    assert windows == [(round(2.5 / 1.25 * FPS), round(4.0 / 1.25 * FPS))]


def test_a_look_inside_the_teaser_phrase_greys_its_copy_at_the_start_too():
    tl = Timeline([(0.0, 10.0)], 1.0, teaser=(6.0, 8.0))
    windows = look_windows({"looks": [{"t0": 5.5, "t1": 7.0, "look": "bw"}]}, tl)
    assert windows == [(round(7.5 * FPS), round(9.0 * FPS)), (0, 30)]


def test_a_look_next_to_a_jump_cut_starts_and_ends_on_the_cut_frame():
    """Фраза начинается чуть позже склейки (запас резки до слова) и кончается чуть раньше следующей — ч/б всё равно
    с кадра склейки и до кадра склейки, как смена камеры, а не через 3 кадра цвета."""
    tl = Timeline([(0.0, 2.0), (3.0, 6.0), (7.0, 9.0)], 1.0)  # стыки: 2,0 и 5,0 с финала
    assert look_windows({"looks": [{"t0": 3.1, "t1": 5.94, "look": "bw"}]}, tl) == [(60, 150)]
    assert look_windows({"looks": [{"t0": 1.9, "t1": 7.1, "look": "bw"}]}, tl) == [(60, 150)], "и с той стороны склейки"


def test_window_edges_are_the_frames_where_ffmpeg_puts_the_cut():
    """При ×1,2 стык бывает ровно посередине кадра финала (33 кадра исходника → 27,5): склейку ffmpeg ставит на кадр
    27 (замер) — туда же и ч/б, а не на 28 по `round`."""
    tl = Timeline([(0.0, 1.1), (1.5, 2.0)], 1.2)
    assert look_windows({"looks": [{"t0": 1.5, "t1": 2.0, "look": "bw"}]}, tl) == [(27, 40)]


def test_the_teaser_copy_of_a_look_also_sticks_to_the_teaser_edges():
    tl = Timeline([(0.0, 10.0)], 1.0, teaser=(6.0, 8.0))  # тизер — первые 2 с финала
    windows = look_windows({"looks": [{"t0": 6.1, "t1": 7.9, "look": "bw"}]}, tl)
    assert windows == [(round(8.1 * FPS), round(9.9 * FPS)), (0, 60)], "посреди отрезка — на месте, в тизере — по краям"


def test_an_empty_or_cut_out_look_is_dropped():
    tl = Timeline([(0.0, 2.0), (3.0, 6.0)], 1.0)
    assert look_windows({"looks": [{"t0": 2.2, "t1": 2.8, "look": "bw"}, {"t0": 4.0, "t1": 4.0, "look": "bw"}]}, tl) == []


def test_filter_switches_on_only_inside_its_windows():
    vf = looks_filter({"looks": [{"t0": 0.5, "t1": 1.0, "look": "bw"}]}, WHOLE)
    assert vf.startswith("hue=s=0:enable='")
    assert "gte(t,0.483333)*lt(t,0.983333)" in vf, "границы окна — посередине между кадрами"


def luma(path, n: int) -> float:
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-vf", f"select=eq(n\\,{n})", "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        check=True, capture_output=True,
    ).stdout
    return float(np.frombuffer(raw, np.uint8).mean())


@needs_ffmpeg
def test_the_grade_is_the_reference_one_grey_and_a_little_darker_without_extra_contrast(tmp_path):
    """Тон эталона (кадр 1:56 в цвете и 1:57 в ч/б — один план): средняя и света темнее на ~20 уровней, контраст тот
    же. Серое поле 128 → ~108 в окне; тёмное и светлое сдвигаются одинаково."""
    vf = looks_filter({"looks": [{"t0": 0.5, "t1": 1.0, "look": "bw"}]}, WHOLE)
    for level, expect in ((128, 108), (200, 180), (60, 40)):
        out = tmp_path / f"grey{level}.mp4"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
             f"color=c=0x{level:02x}{level:02x}{level:02x}:s=64x64:r=30:d=1.5", "-vf", f"format=yuv420p,{vf}",
             "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", str(out)],
            check=True,
        )
        assert abs(luma(out, 20) - expect) <= 4, (level, luma(out, 20))
        assert abs(luma(out, 40) - luma(out, 5)) <= 2, "вне окна — как было"


def saturation(path, n: int) -> float:
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-vf", f"select=eq(n\\,{n})", "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    ).stdout
    rgb = np.frombuffer(raw, np.uint8).reshape(-1, 3).astype(int)
    return float((rgb.max(1) - rgb.min(1)).mean())


@needs_ffmpeg
def test_frames_in_the_window_are_grey_and_darker_the_rest_keep_their_colour(tmp_path):
    vf = looks_filter({"looks": [{"t0": 0.5, "t1": 1.0, "look": "bw"}]}, WHOLE)
    out = tmp_path / "bw.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=270x480:r=30:d=1.5",
         "-vf", f"format=yuv420p,{vf}", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", str(out)],
        check=True,
    )
    colour = [saturation(out, n) for n in (14, 15, 29, 30)]
    assert colour[0] > 40 and colour[3] > 40, colour
    assert colour[1] < 6 and colour[2] < 6, colour


@needs_ffmpeg
def test_cut_frame_is_where_ffmpeg_puts_a_jump_cut(tmp_path):
    """`cut_frame` — кадр финала, с которого виден новый отрезок после склейки (`_cut`), ускорения и `fps=30`, как в
    рендере: на него встают ч/б и смены крупности. Ровно посередине кадра (×1,2: 27,5 и 32,5) — на раньший."""
    src = tmp_path / "count.mp4"  # кадр n исходника — серый 4n; time_base как у source.mp4
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=2",
         "-vf", "geq=lum='4*N':cb=128:cr=128", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p",
         "-video_track_timescale", "15360", str(src)],
        check=True,
    )
    for speed in (1.1, 1.2):
        for frames in (31, 33, 34, 39):
            tl = Timeline([(0.0, frames / 30), (1.5, 2.0)], speed)
            graph = ";".join(_cut(tl, False)) + f";[vc]setpts=PTS/{speed:g},fps={FPS}[v];[ac]anullsink"
            raw = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(src), "-filter_complex", graph, "-map", "[v]",
                 "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                check=True, capture_output=True,
            ).stdout
            shown = [round(v / 4) for v in np.frombuffer(raw, np.uint8).reshape(-1, 64 * 64).mean(1)]
            first = next(n for n, k in enumerate(shown) if k >= 45)  # 45 — первый кадр второго отрезка
            assert first == cut_frame(tl.segments[1][2]), (speed, frames, first)
