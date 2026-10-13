"""Переходы на смене сцены: место во времени финала, фильтры вспышки и смаза, толчок зума и звук свуша."""
import math
import shutil
import subprocess

import numpy as np
import pytest

from vm.job import Job
from vm.render import _sounds, timeline
from vm.timeline import Timeline
from vm.transitions import (
    HALF,
    PUNCH,
    Mark,
    blur_sigma,
    flash_alpha,
    marks,
    picture_chains,
    warnings,
)
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


# ---------- вспышка и смаз по кадрам: что ffmpeg рисует на кадре n финала (превью редактора повторяет) ----------

def test_the_flash_is_a_white_frame_a_quarter_whiter_each_frame_and_only_in_its_window():
    """Белый кадр вспышки — 9 кадров с альфой 0, 64, 127, 191, 255, 191, 128, 64, 0 из 255 (fade ffmpeg считает в целых
    кадрах: 0,12 с → 4 кадра); первый стоит на кадре int(30 · (стык − 0,12)), виден — только в окне стык ± 0,12 с."""
    assert [round(flash_alpha(1.0, n) * 255) for n in range(25, 36)] == [0, 0, 64, 127, 191, 255, 191, 128, 64, 0, 0]
    assert [round(flash_alpha(1.02, n) * 255) for n in range(26, 37)] == [0, 0, 64, 127, 191, 255, 191, 128, 64, 0, 0], \
        "начало окна 0,9 — ровно кадр 27: белый кадр с него, и его первый кадр прозрачный"
    assert flash_alpha(1.0, 0) == flash_alpha(1.0, 200) == 0.0


def test_white_frame_stamps_are_cut_to_whole_frames_as_setpts_does():
    """setpts отбрасывает дробь метки: 4,1 / (1/30) = 122,99999999999999 — белый кадр стартует с кадра 122, а у его
    кадра 6 метка уже 129 (122,99… + 6 в double округлилось вверх): кадр 128 показывает кадр 5 белого ещё раз."""
    assert [round(flash_alpha(4.22, n) * 255) for n in range(122, 132)] == [0, 64, 127, 191, 255, 191, 191, 128, 64, 0]


def test_blur_steps_add_up_as_blurs_in_a_row():
    """Смаз на кадре — ступени gblur, чьё окно захватывает время кадра n · (1/30): размытия подряд складываются, sigma —
    корень из суммы квадратов."""
    assert [blur_sigma(1.0, n) for n in range(26, 35)] == pytest.approx(
        [0, 8, math.hypot(8, 14), math.hypot(8, 14, 24), math.hypot(8, 14, 24), math.hypot(8, 14, 24), math.hypot(8, 14), 8, 0])


def test_blur_window_edges_are_inclusive_and_read_as_ffmpeg_reads_them():
    """Края окна enable — включительно, с шестью знаками, как их пишет picture_chains; время кадра — n · (1/30) в double."""
    assert blur_sigma(1.12, 30) == 8, "край окна 1,0 — ровно время кадра 30: кадр размыт"
    assert blur_sigma(3.58, 111) == 8, "верхний край 3,7: кадр 111 (3,6999999999999997) — внутри"
    assert blur_sigma(3.82, 111) == 0, "нижний край 3,7, а время кадра 111 чуть меньше: кадр не размыт"


def luma(chains: list[str], size: tuple[int, int], seconds: float, draw: str = "") -> np.ndarray:
    """Яркость Y (yuv420p, как в финале) кадров чёрного lavfi-клипа (и что на нём нарисует `draw`) после цепочек `chains`
    от `[in]` к `[out]`; на входе цепочек — 30 к/с и метки кадров n/30, как после fps=30 рендера."""
    w, h = size
    graph = ";".join(["[0:v]fps=30,format=yuv420p[in]", *(chains or ["[in]null[out]"])])
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c=black:s={w}x{h}:r=30:d={seconds}{draw}",
         "-filter_complex", graph, "-map", "[out]", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, w * h * 3 // 2)[:, : w * h].reshape(-1, h, w).astype(int)


FLASHES = (1.0, 2.02, 3.82, 4.22, 6.0, 6.1, 8.32)


@needs_ffmpeg
def test_flash_alpha_is_the_white_ffmpeg_lays_on_every_frame():
    """Белое поверх чёрного (yuv420p, tv-диапазон: 16 — чёрный, 235 — белый): на каждом кадре белизна (Y − 16) / 219 —
    это flash_alpha. Стыки: 1,0 (окно с 0,88 — между кадрами), 2,02 (с 1,9 — ровно кадр 57), 3,82 (с 3,7, а время кадра
    111 в double чуть меньше — он вне окна), 4,22 (метки белого кадра сбиваются на кадр), 6,0 и 6,1 (окна внахлёст: белое
    поверх белого — 1 − (1 − a)(1 − b)), 8,32."""
    items = [Mark(t, "flash", None, t) for t in FLASHES]
    y = luma(picture_chains(items, "[in]", "[out]", (32, 32), 30), (32, 32), seconds=9.0)
    assert len(y) == 270
    for n, frame in enumerate(y):
        assert frame.min() == frame.max(), n
        alphas = [flash_alpha(t, n) for t in FLASHES]
        want = 1 - math.prod(1 - a for a in alphas)
        if want == 0:
            assert frame[0, 0] == 16, f"кадр {n} не тронут"
            continue
        tolerance = (0.5 if sum(a > 0 for a in alphas) == 1 else 1.0) / 219  # полуровня на каждое наложение
        assert abs((frame[0, 0] - 16) / 219 - want) <= tolerance + 1e-9, (n, frame[0, 0], want)


def spread(frame: np.ndarray) -> float:
    """Ширина размытого перепада по x, px: СКО производной яркости (у гауссова размытия перепада — его sigma)."""
    d = np.clip(np.diff(frame.mean(axis=0)), 0, None)
    x = np.arange(len(d))
    middle = (d * x).sum() / d.sum()
    return math.sqrt((d * (x - middle) ** 2).sum() / d.sum())


BLURS = (1.12, 2.02, 3.82, 5.08, 7.48)


@needs_ffmpeg
def test_blur_sigma_is_how_wide_ffmpeg_smears_a_sharp_edge_on_every_frame():
    """Перепад чёрное → белое посередине кадра шириной 1080: размыты ровно кадры с blur_sigma > 0, и ширина перепада —
    blur_sigma (gblur — приближение гаусса, до 3 %), растёт вместе с ней. Стыки: 1,12 (край окна 1,0 — ровно кадр 30),
    2,02, 3,82 (край 3,7 — время кадра 111 чуть меньше: не размыт), 5,08, 7,48 (край ступени 7,4 — кадр 222 без неё)."""
    edge = ",drawbox=x=540:y=0:w=540:h=8:color=white:t=fill"
    out = luma(picture_chains([Mark(t, "blur", None, t) for t in BLURS], "[in]", "[out]", (1080, 8), 30), (1080, 8), 8.0, edge)
    plain = luma([], (1080, 8), 8.0, edge)
    assert len(out) == len(plain) == 240 and spread(plain[0]) == 0
    widths = {}
    for n, (frame, sharp) in enumerate(zip(out, plain, strict=True)):
        sigma = math.hypot(*(blur_sigma(t, n) for t in BLURS))
        if sigma == 0:
            assert np.array_equal(frame, sharp), f"кадр {n} не размыт"
            continue
        assert abs(spread(frame) / sigma - 1) < 0.03, (n, spread(frame), sigma)
        widths.setdefault(round(sigma, 6), []).append(spread(frame))
    levels = sorted(widths)
    assert levels == pytest.approx([8, math.hypot(8, 14), math.hypot(8, 14, 24)])
    assert max(widths[levels[0]]) < min(widths[levels[1]]) and max(widths[levels[1]]) < min(widths[levels[2]])
