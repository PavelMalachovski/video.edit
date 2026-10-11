"""Зумы по смыслу: уровень приближения во времени финала и фильтр ffmpeg с тем же уровнем, якорь — лицо."""
import shutil
import subprocess

import numpy as np
import pytest

from vm.timeline import Timeline
from vm.zoom import zoom_at, zoom_filter

WHOLE = Timeline([(0.0, 10.0)], 1.0)  # финал = исходник

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")


def test_zoom_smoothstep_midpoint():
    zooms = [{"t": 2.0, "level": 1.05}]
    assert zoom_at(zooms, WHOLE, 1.99) == 1.0
    assert zoom_at(zooms, WHOLE, 2.225) == pytest.approx(1.025, abs=0.001)
    assert zoom_at(zooms, WHOLE, 2.1) == pytest.approx(1.0 + 0.05 * (3 * (0.1 / 0.45) ** 2 - 2 * (0.1 / 0.45) ** 3))
    assert zoom_at(zooms, WHOLE, 2.45) == pytest.approx(1.05)
    assert zoom_at(zooms, WHOLE, 9.0) == pytest.approx(1.05)


def test_zoom_before_the_first_step_and_without_steps_is_1():
    assert zoom_at([], WHOLE, 3.0) == 1.0
    assert zoom_at([{"t": 5.0, "level": 1.06}], WHOLE, 0.0) == 1.0


def test_zoom_clamped_to_1_3():
    assert zoom_at([{"t": 1.0, "level": 1.2}], WHOLE, 5.0) == pytest.approx(1.2)
    assert zoom_at([{"t": 1.0, "level": 1.5}], WHOLE, 5.0) == pytest.approx(1.3)
    assert zoom_at([{"t": 1.0, "level": 0.9}], WHOLE, 5.0) == 1.0


def test_a_cut_step_changes_the_shot_at_once():
    zooms = [{"t": 2.0, "level": 1.25, "over": 0}, {"t": 5.0, "level": 1.0, "over": 0}]
    assert zoom_at(zooms, WHOLE, 1.999) == 1.0
    assert zoom_at(zooms, WHOLE, 2.0) == pytest.approx(1.25)
    assert zoom_at(zooms, WHOLE, 4.999) == pytest.approx(1.25)
    assert zoom_at(zooms, WHOLE, 5.0) == 1.0


def test_a_slow_push_in_takes_its_time():
    zooms = [{"t": 2.0, "level": 1.2, "over": 4.0}]
    assert zoom_at(zooms, WHOLE, 2.0) == pytest.approx(1.0)
    assert zoom_at(zooms, WHOLE, 4.0) == pytest.approx(1.1)
    assert 1.0 < zoom_at(zooms, WHOLE, 3.0) < 1.1
    assert zoom_at(zooms, WHOLE, 6.0) == pytest.approx(1.2)
    assert zoom_at(zooms, WHOLE, 9.0) == pytest.approx(1.2)


def test_a_cut_step_close_after_a_jump_cut_lands_on_it():
    tl = Timeline([(0.0, 2.0), (2.5, 6.0)], 1.0)  # стык: 2,0 с финала
    zooms = [{"t": 2.6, "level": 1.2, "over": 0}]  # фраза после стыка: 0,1 с исходника после начала отрезка
    assert zoom_at(zooms, tl, 1.999) == 1.0
    assert zoom_at(zooms, tl, 2.0) == pytest.approx(1.2), "смена крупности — на стыке, кадр не прыгает дважды"
    far = [{"t": 3.0, "level": 1.2, "over": 0}]  # 0,5 с после стыка — уже не про стык
    assert zoom_at(far, tl, 2.4) == 1.0 and zoom_at(far, tl, 2.5) == pytest.approx(1.2)
    slow = [{"t": 2.6, "level": 1.2}]  # плавный переход на стык не встаёт
    assert zoom_at(slow, tl, 2.05) == 1.0


def test_zoom_steps_go_back_out_and_keep_their_order():
    zooms = [{"t": 6.0, "level": 1.0}, {"t": 2.0, "level": 1.06}]  # не по порядку
    assert zoom_at(zooms, WHOLE, 4.0) == pytest.approx(1.06)
    assert zoom_at(zooms, WHOLE, 6.225) == pytest.approx(1.03, abs=0.001)
    assert zoom_at(zooms, WHOLE, 7.0) == pytest.approx(1.0)


def test_change_during_a_transition_starts_from_the_current_level():
    zooms = [{"t": 2.0, "level": 1.08}, {"t": 2.2, "level": 1.0}]
    before = zoom_at(zooms, WHOLE, 2.2 - 1e-6)
    after = zoom_at(zooms, WHOLE, 2.2 + 1e-6)
    assert 1.0 < before < 1.08
    assert after == pytest.approx(before, abs=1e-4), "no jump when a step interrupts a transition"
    assert zoom_at(zooms, WHOLE, 2.65) == pytest.approx(1.0)


def test_zoom_times_are_source_times():
    tl = Timeline([(0.0, 2.0), (3.0, 5.0)], 1.1)
    zooms = [{"t": 3.5, "level": 1.05}]  # 3,5 с исходника = 2 + 0,5 с оставленного → 2,5 / 1,1 с финала
    change = 2.5 / 1.1
    assert zoom_at(zooms, tl, change - 0.01) == 1.0
    assert zoom_at(zooms, tl, change + 0.45) == pytest.approx(1.05)


def test_no_zoom_is_a_pass_through_filter():
    assert zoom_filter([], WHOLE, {"x": 0.5, "y": 0.3}) == "null"
    assert zoom_filter([{"t": 1.0, "level": 1.0}], WHOLE, {"x": 0.5, "y": 0.3}) == "null"


def run_filter(source: list[str], vf: str, out, seconds: float):
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *source, "-vf", vf, "-t", str(seconds)]
    cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p", str(out)]
    subprocess.run(cmd, check=True)


def probe(path) -> tuple[int, int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v", "-count_frames", "-show_entries",
         "stream=width,height,nb_read_frames", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    w, h, n = (int(v) for v in out.split(","))
    return w, h, n


def frame_at(path, t: float) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.uint8).reshape(1920, 1080)


def centroid(gray: np.ndarray, near: tuple[float, float], radius: int = 80) -> tuple[float, float]:
    x0, y0 = int(near[0]), int(near[1])
    win = gray[y0 - radius : y0 + radius, x0 - radius : x0 + radius]
    ys, xs = np.nonzero(win > 128)
    assert len(xs), f"no bright dot near {near}"
    return x0 - radius + xs.mean(), y0 - radius + ys.mean()


def z_expression(vf: str) -> str:
    """Выражение уровня из фильтра zoompan (z='…')."""
    return vf.split("z='", 1)[1].split("'", 1)[0]


@needs_ffmpeg
def test_ffmpeg_expression_is_zoom_at(tmp_path):
    # то же выражение, что получит zoompan, считает сам ffmpeg (aevalsrc: отсчёт = уровень в момент t)
    tl = Timeline([(0.0, 3.0), (4.0, 9.0)], 1.1)
    zooms = [{"t": 1.0, "level": 1.06}, {"t": 1.2, "level": 1.02}, {"t": 5.0, "level": 1.25, "over": 0},
             {"t": 5.6, "level": 1.1, "over": 1.5}, {"t": 7.0, "level": 1.0}]
    expr = z_expression(zoom_filter(zooms, tl, {"x": 0.5, "y": 0.3})).replace("it", "t")
    rate = 100
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", f"aevalsrc='{expr}':s={rate}:d=8",
         "-f", "f32le", "-acodec", "pcm_f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    values = np.frombuffer(raw, np.float32)
    cut = tl.to_final_snap(5.0)
    worst = max(abs(float(v) - zoom_at(zooms, tl, k / rate)) for k, v in enumerate(values) if abs(k / rate - cut) > 1e-6)
    assert worst < 1e-4, worst


@needs_ffmpeg
@pytest.mark.parametrize("source", ["testsrc2=s=1080x1920:r=25:d=3", "testsrc2=s=1080x1920:r=30:d=3,setpts=PTS/1.1"])
def test_zoom_filter_keeps_the_timing_of_any_input(tmp_path, source):
    # zoompan считает кадры сам: без приведения к 30 к/с он растягивал бы ролик (25 к/с) или отменял ускорение
    vf = zoom_filter([{"t": 1.0, "level": 1.08}], WHOLE, {"x": 0.5, "y": 0.3})
    out = tmp_path / "timing.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", source, "-vf", vf,
         "-c:v", "libx264", "-preset", "ultrafast", str(out)],
        check=True,
    )
    seconds = 3.0 if "setpts" not in source else 3.0 / 1.1
    duration = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
        check=True, capture_output=True, text=True,
    ).stdout)
    assert duration == pytest.approx(seconds, abs=0.05)


def test_too_many_steps_is_a_clear_error():
    zooms = [{"t": i * 0.5, "level": 1.0 + 0.01 * (i % 5)} for i in range(200)]
    with pytest.raises(ValueError, match="зум"):
        zoom_filter(zooms, Timeline([(0.0, 200.0)], 1.0), {"x": 0.5, "y": 0.3})


def test_steps_at_the_same_final_moment_follow_source_order():
    # 2.5 с в вырезке и 3.0 с на краю отрезка встают на один момент финала; позже в исходнике — то и действует
    tl = Timeline([(0.0, 2.0), (3.0, 6.0)], 1.0)
    a, b = {"t": 2.5, "level": 1.02}, {"t": 3.0, "level": 1.06}
    assert zoom_at([a, b], tl, 4.0) == zoom_at([b, a], tl, 4.0) == pytest.approx(1.06)


def test_transition_must_take_time():
    with pytest.raises(ValueError, match="trans"):
        zoom_at([{"t": 1.0, "level": 1.05}], WHOLE, 2.0, trans=0)


@needs_ffmpeg
def test_zoom_filter_runs_in_ffmpeg(tmp_path):
    vf = zoom_filter([{"t": 1.0, "level": 1.08}], WHOLE, {"x": 0.5, "y": 0.3})
    assert vf.startswith("fps=30,zoompan=") and ":d=1:s=1080x1920:fps=30" in vf
    out = tmp_path / "zoom.mp4"
    run_filter(["-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=3"], vf, out, 3)
    assert probe(out) == (1080, 1920, 90)


@needs_ffmpeg
def test_zoom_keeps_face_point_fixed(tmp_path):
    face = {"x": 0.3, "y": 0.25}
    fx, fy = 1080 * face["x"], 1920 * face["y"]
    far = (900.0, 1700.0)
    dots = (
        f"drawbox=x={fx - 4:.0f}:y={fy - 4:.0f}:w=8:h=8:color=white:t=fill,"
        f"drawbox=x={far[0] - 4:.0f}:y={far[1] - 4:.0f}:w=8:h=8:color=white:t=fill"
    )
    vf = f"{dots},{zoom_filter([{'t': 0.5, 'level': 1.08}], WHOLE, face)}"
    out = tmp_path / "face.mp4"
    run_filter(["-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=2"], vf, out, 2)
    before, after = frame_at(out, 0.1), frame_at(out, 1.5)
    start, end = centroid(before, (fx, fy)), centroid(after, (fx, fy))
    assert abs(end[0] - start[0]) <= 3 and abs(end[1] - start[1]) <= 3, (start, end)
    # точка вдали от лица уезжает от него на ~8 % расстояния — зум правда есть
    moved = centroid(after, (far[0] + (far[0] - fx) * 0.08, far[1] + (far[1] - fy) * 0.08))
    assert moved[0] - far[0] > 30 and moved[1] - far[1] > 80, moved
