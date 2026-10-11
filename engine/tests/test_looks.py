"""Ч/б-куски стиля эталона (`edit.looks`): фильтр ffmpeg с окнами во времени финала, по целым кадрам."""
import shutil
import subprocess

import numpy as np
import pytest

from vm.render import FPS, look_windows, looks_filter
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


def test_an_empty_or_cut_out_look_is_dropped():
    tl = Timeline([(0.0, 2.0), (3.0, 6.0)], 1.0)
    assert look_windows({"looks": [{"t0": 2.2, "t1": 2.8, "look": "bw"}, {"t0": 4.0, "t1": 4.0, "look": "bw"}]}, tl) == []


def test_filter_switches_on_only_inside_its_windows():
    vf = looks_filter({"looks": [{"t0": 0.5, "t1": 1.0, "look": "bw"}]}, WHOLE)
    assert vf.startswith("hue=s=0:enable='") and "vignette" in vf
    assert "gte(t,0.483333)*lt(t,0.983333)" in vf, "границы окна — посередине между кадрами"


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
