"""Переходы на смене сцены: место во времени финала, фильтры вспышки и смаза, толчок зума и звук свуша."""
import shutil
import subprocess

import numpy as np
import pytest

from vm.job import Job
from vm.render import _sounds, timeline
from vm.timeline import Timeline
from vm.transitions import HALF, PUNCH, marks, picture_chains, warnings
from vm.zoom import zoom_at, zoom_filter

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")


def edit_with(*items, keep=((0.0, 10.0),), speed=1.0, teaser=None):
    return {"keep": [list(k) for k in keep], "speed": speed, "teaser": teaser, "transitions": list(items)}


def tl_of(edit):
    return Timeline(edit["keep"], edit["speed"], teaser=(edit["teaser"]["t0"], edit["teaser"]["t1"]) if edit["teaser"] else None)


def test_a_transition_stands_where_the_new_scene_starts_in_the_final():
    edit = edit_with({"t": 6.0, "kind": "flash", "sfx": None}, keep=((0.0, 2.0), (5.0, 9.0)), speed=1.25)
    (m,) = marks(edit, tl_of(edit))
    assert m.t == pytest.approx((2.0 + 1.0) / 1.25) and m.kind == "flash" and m.source == 6.0


def test_a_cut_out_moment_moves_to_the_start_of_the_next_scene():
    edit = edit_with({"t": 3.0, "kind": "blur"}, keep=((0.0, 2.0), (5.0, 9.0)))
    assert [m.t for m in marks(edit, tl_of(edit))] == [pytest.approx(2.0)]


def test_transitions_come_in_order_and_after_the_teaser():
    edit = edit_with({"t": 7.0, "kind": "zoom"}, {"t": 4.0, "kind": "flash"}, teaser={"t0": 6.0, "t1": 7.5})
    assert [(round(m.t, 3), m.kind) for m in marks(edit, tl_of(edit))] == [(5.5, "flash"), (8.5, "zoom")]


def test_no_transition_at_the_very_start_or_end_of_the_video():
    edit = edit_with({"t": 0.0, "kind": "flash"}, {"t": 5.0, "kind": "zoom"}, {"t": 9.95, "kind": "blur"})
    assert [m.source for m in marks(edit, tl_of(edit))] == [5.0]
    said = warnings(edit, tl_of(edit))
    assert len(said) == 2 and all("сцены до или после нет" in line for line in said), said


def test_transitions_closer_than_three_seconds_are_flagged():
    edit = edit_with({"t": 2.0, "kind": "flash"}, {"t": 4.5, "kind": "blur"}, {"t": 8.0, "kind": "zoom"})
    said = warnings(edit, tl_of(edit))
    assert said == ["переходы на 2,0 с и 4,5 с — ближе 3 с друг к другу: оставь один (правило — не чаще раза в 3 с)"]
    assert warnings(edit_with({"t": 2.0, "kind": "flash"}, {"t": 5.0, "kind": "zoom"}), Timeline([(0.0, 10.0)], 1.0)) == []


def chains_for(edit, src="[in]", out="[out]"):
    return picture_chains(marks(edit, tl_of(edit)), src, out, (216, 384), 30)


def test_without_transitions_there_is_nothing_to_do():
    edit = {"keep": [[0.0, 10.0]], "speed": 1.0}
    assert marks(edit, tl_of({**edit, "teaser": None})) == [] and picture_chains([], "[in]", "[out]", (1080, 1920), 30) == []


def test_flash_and_blur_work_only_in_their_window_and_zoom_is_left_to_the_zoom_filter():
    chains = chains_for(edit_with({"t": 3.0, "kind": "flash"}, {"t": 7.0, "kind": "blur"}, {"t": 5.0, "kind": "zoom"}))
    flash, over, blur = chains
    assert flash.startswith("color=c=white:s=216x384:r=30") and "alpha=1" in flash and "+2.880000/TB" in flash
    assert over.startswith("[in][fl0]overlay") and "between(t,2.880000,3.120000)" in over and over.endswith("[tr0]")
    assert blur.startswith("[tr0]gblur") and "between(t,6.880000,7.120000)" in blur and blur.endswith("[out]")
    assert chains_for(edit_with({"t": 5.0, "kind": "zoom"})) == [], "толчок зума рисует zoom_filter"


def test_zoom_punch_peaks_at_the_seam_and_is_gone_outside_the_window():
    tl = Timeline([(0.0, 10.0)], 1.0)
    zooms = [{"t": 0.0, "level": 1.04}]
    assert zoom_at(zooms, tl, 5.0, punches=[5.0]) == pytest.approx(1.04 * (1 + PUNCH))
    assert zoom_at(zooms, tl, 5.0 + HALF / 2, punches=[5.0]) == pytest.approx(1.04 * (1 + PUNCH / 4))
    assert zoom_at(zooms, tl, 5.0 + HALF, punches=[5.0]) == pytest.approx(1.04)
    assert zoom_at(zooms, tl, 4.0, punches=[5.0]) == pytest.approx(1.04)


def test_a_zoom_punch_needs_zoompan_even_without_zoom_steps():
    tl = Timeline([(0.0, 10.0)], 1.0)
    assert zoom_filter([], tl, {"x": 0.5, "y": 0.3}) == "null"
    assert "zoompan" in zoom_filter([], tl, {"x": 0.5, "y": 0.3}, punches=[5.0])


def test_the_swoosh_starts_with_the_transition(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    job.path("in/uploads").mkdir(parents=True)
    job.path("in/uploads/swoosh.wav").write_bytes(b"RIFF")
    edit = {"speed": 1.0, "keep": [[0.0, 6.0]], "hook": None, "music": None, "inserts": [], "hold": 0.0,
            "transitions": [{"t": 3.0, "kind": "flash", "sfx": "in/uploads/swoosh.wav"},
                            {"t": 5.0, "kind": "blur", "sfx": "in/uploads/none.wav"}]}
    sfx, _, notes = _sounds(job, edit, timeline(edit), skip=set())
    assert sfx == [(pytest.approx(3.0 - HALF), job.path("in/uploads/swoosh.wav").resolve())]
    assert notes == ["нет звука in/uploads/none.wav — переход на 5,0 с без звука"]


def frames(chains: list[str], seconds: float = 2.0) -> np.ndarray:
    """Кадры testsrc2 216×384 (yuv420p) после цепочек `chains` от `[in]` к `[out]` — яркость, по кадру на строку."""
    graph = ";".join(["[0:v]format=yuv420p[in]", *(chains or ["[in]null[out]"])])
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc2=s=216x384:r=30:d={seconds}",
         "-filter_complex", graph, "-map", "[out]", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, 384, 216).astype(int)


def sharpness(f: np.ndarray) -> float:
    """Энергия перепадов по x: размытие разносит перепад на много точек, и сумма квадратов падает."""
    return float((np.diff(f, axis=1) ** 2).mean())


@needs_ffmpeg
def test_the_flash_turns_white_at_the_seam_and_back():
    out, plain = frames(chains_for(edit_with({"t": 1.0, "kind": "flash"}, keep=((0.0, 2.0),)))), frames([])
    assert out[30].min() > 245, "на стыке кадр белый"
    assert plain[33].mean() < out[33].mean() < 250, "после стыка картинка проявляется"
    assert np.array_equal(out[20], plain[20]) and np.array_equal(out[40], plain[40]), "вне окна кадр не тронут"


@needs_ffmpeg
def test_the_blur_smears_most_at_the_seam():
    out, plain = frames(chains_for(edit_with({"t": 1.0, "kind": "blur"}, keep=((0.0, 2.0),)))), frames([])
    assert sharpness(out[30]) < 0.5 * sharpness(plain[30])
    assert sharpness(out[30]) < sharpness(out[27]) < sharpness(plain[27])
    assert np.array_equal(out[20], plain[20]) and np.array_equal(out[40], plain[40])
