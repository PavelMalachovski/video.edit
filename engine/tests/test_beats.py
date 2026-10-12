"""Доли трека для монтажа в такт: огибающая всплесков, темп, сетка долей; и сдвиг событий к ближайшей доле.

Сигналы — синтетические: щелчки (затухающий синус 1 кГц, 30 мс) на известном темпе, с шумом и без, — где доли,
известно заранее."""
import shutil

import numpy as np
import pytest
import soundfile

from vm import beats
from vm.job import Job
from vm.render import on_beats
from vm.timeline import Timeline

SR = 22050


def clicks(bpm: float, seconds: float, offset: float = 0.0, noise: float = 0.0, seed: int = 0) -> tuple[np.ndarray, list[float]]:
    y = np.zeros(int(seconds * SR), dtype=np.float32)
    period = 60 / bpm
    times = []
    n = int(0.03 * SR)
    burst = np.exp(-np.arange(n) / (0.005 * SR)) * np.sin(2 * np.pi * 1000 * np.arange(n) / SR)
    t = offset
    while int(t * SR) + n <= len(y):
        start = int(t * SR)
        y[start:start + n] += burst.astype(np.float32)
        times.append(t)
        t += period
    rng = np.random.default_rng(seed)
    return y + noise * rng.standard_normal(len(y)).astype(np.float32), times


def matched(found: list[float], true: list[float], tol: float = 0.03) -> float:
    """Доля настоящих долей, рядом с которыми (±tol) есть найденная."""
    found_arr = np.asarray(found)
    return float(np.mean([np.min(np.abs(found_arr - t)) <= tol for t in true])) if len(found_arr) else 0.0


def test_beats_of_a_click_track_are_on_the_clicks():
    y, true = clicks(120, 20, offset=0.13)
    grid = beats.track(y, SR)
    assert 117 <= grid.bpm <= 123, grid.bpm
    assert matched(grid.times, true) >= 0.9
    assert all(np.min(np.abs(np.asarray(true) - t)) <= 0.03 for t in grid.times), "лишних долей нет"


@pytest.mark.parametrize("bpm", [85, 128, 160])
def test_tempo_is_found_across_the_usual_range(bpm):
    y, true = clicks(bpm, 24, offset=0.31, noise=0.05)
    grid = beats.track(y, SR)
    assert abs(grid.bpm - bpm) <= 0.03 * bpm, (bpm, grid.bpm)
    assert matched(grid.times, true) >= 0.85


def test_silence_has_no_beats():
    grid = beats.track(np.zeros(5 * SR, dtype=np.float32), SR)
    assert grid.times == [] and grid.bpm == 0


def test_snap_moves_a_moment_to_the_nearest_beat_not_further_than_a_quarter_second():
    grid = [0.5, 1.0, 1.5, 2.0]
    assert beats.snap(1.10, grid) == 1.0
    assert beats.snap(1.30, grid) == 1.5
    assert beats.snap(3.0, grid) == 3.0, "доли нет ближе 0,25 с — момент остаётся"
    assert beats.snap(1.0, [0.5, 1.5]) == 1.0, "доли по 0,5 с с обеих сторон — дальше 0,25 с, момент остаётся"
    assert beats.snap(1.0, []) == 1.0


# ---------- события на доли ----------

GRID = [0.25 + 0.5 * k for k in range(40)]  # доли через 0,5 с с 0,25 с


def edit_with(**fields):
    return {"zooms": [], "inserts": [], **fields}


def test_zoom_changes_and_insert_appearances_move_onto_beats():
    tl = Timeline([(0.0, 3.0), (5.0, 12.0)], 1.0)
    edit = edit_with(zooms=[{"t": 1.1, "level": 1.05}, {"t": 5.6, "level": 1.0}],
                     inserts=[{"kind": "image", "src": "a.png", "t0": 2.4, "t1": 4.0, "x": 1, "y": 1, "w": 10}])
    moved, count = beats.snap_edit(edit, tl, GRID)
    assert [z["t"] for z in moved["zooms"]] == pytest.approx([1.25, 5.75]), "5,6 с исходника — 3,6 с ролика → доля 3,75"
    assert moved["inserts"][0]["t0"] == pytest.approx(2.25) and moved["inserts"][0]["t1"] == 4.0
    assert count == 3
    assert edit["zooms"][0]["t"] == 1.1, "edit.json не меняется — меняется копия"


def test_cut_steps_stay_on_their_jump_cut():
    edit = {"zooms": [{"t": 1.1, "level": 1.2, "over": 0}, {"t": 2.1, "level": 1.0}], "inserts": []}
    out, moved = beats.snap_edit(edit, Timeline([(0.0, 10.0)], 1.0), [1.0, 2.0, 3.0])
    assert [z["t"] for z in out["zooms"]] == [1.1, 2.0] and moved == 1, "резкая смена крупности — на стыке, а не на доле"


def test_events_far_from_a_beat_and_on_a_beat_stay():
    tl = Timeline([(0.0, 10.0)], 1.0)
    edit = edit_with(zooms=[{"t": 0.75, "level": 1.0}], inserts=[{"kind": "image", "src": "a.png", "t0": 3.0, "t1": 5.0, "x": 1, "y": 1, "w": 10}])
    moved, count = beats.snap_edit(edit, tl, [0.75, 6.0])
    assert moved == edit and count == 0


def test_with_a_teaser_events_stay_in_the_video_part():
    tl = Timeline([(0.0, 10.0)], 1.0, teaser=(6.0, 8.0))  # тизер — первые 2 с ролика
    edit = edit_with(zooms=[{"t": 0.1, "level": 1.05}])  # 2,1 с ролика; ближайшая доля 1,75 — уже в тизере
    moved, count = beats.snap_edit(edit, tl, [1.75, 2.9])
    assert moved["zooms"][0]["t"] == 0.1 and count == 0, "в тизер событие ролика не уходит"


def test_an_insert_moves_later_only_if_it_stays_on_screen_long_enough():
    tl = Timeline([(0.0, 10.0)], 1.0)
    short = {"kind": "image", "src": "a.png", "t0": 2.4, "t1": 2.6, "x": 1, "y": 1, "w": 10}
    moved, count = beats.snap_edit(edit_with(inserts=[short]), tl, [2.6])
    assert moved["inserts"][0]["t0"] == 2.4 and count == 0, "позже — только если вставке останется не меньше 0,3 с"
    moved, count = beats.snap_edit(edit_with(inserts=[short]), tl, [2.25])
    assert moved["inserts"][0]["t0"] == pytest.approx(2.25) and count == 1, "раньше — можно: вставка только дольше"


# ---------- доли выбранной музыки (render.on_beats) ----------

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="нужен ffmpeg")


def music_job(tmp_path, seconds: float, **music) -> tuple[Job, dict]:
    """Задача с треком щелчков 120 уд/мин (доли — 0,1 с + 0,5 с × k) в in/uploads/beat.wav."""
    job = Job(tmp_path / "jobs" / "abc")
    y, _ = clicks(120, seconds, offset=0.1)
    job.path("in/uploads").mkdir(parents=True)
    soundfile.write(job.path("in/uploads/beat.wav"), y, SR)
    return job, {"file": "in/uploads/beat.wav", "gainDb": -18, **music}


@needs_ffmpeg
def test_with_music_zooms_and_inserts_land_on_its_beats(tmp_path):
    job, music = music_job(tmp_path, 12)
    tl = Timeline([(0.0, 10.0)], 1.0)
    edit = edit_with(music=music, zooms=[{"t": 2.2, "level": 1.05}],
                     inserts=[{"kind": "image", "src": "a.png", "t0": 3.45, "t1": 5.0, "x": 1, "y": 1, "w": 10}])
    snapped, report = on_beats(job, edit, tl)
    assert snapped["zooms"][0]["t"] == pytest.approx(2.1, abs=0.02) and snapped["inserts"][0]["t0"] == pytest.approx(3.6, abs=0.02)
    assert 117 <= report["bpm"] <= 123 and report["moved"] == 2
    for off in ({**edit, "music": {**music, "beats": False}}, {**edit, "music": None}, {**edit, "music": {**music, "file": "in/uploads/no.wav"}}):
        assert on_beats(job, off, tl) == (off, None), off["music"]


@needs_ffmpeg
def test_a_short_track_repeats_and_so_do_its_beats(tmp_path):
    job, music = music_job(tmp_path, 4)  # трек 4 с; в ролике он звучит по кругу: доли и с 4,1 с, и с 8,1 с
    tl = Timeline([(0.0, 10.0)], 1.0)
    snapped, report = on_beats(job, edit_with(music=music, zooms=[{"t": 6.2, "level": 1.05}, {"t": 8.05, "level": 1.0}]), tl)
    assert [z["t"] for z in snapped["zooms"]] == pytest.approx([6.1, 8.1], abs=0.02) and report["moved"] == 2


@needs_ffmpeg
def test_music_placed_later_and_from_its_middle_moves_its_beats(tmp_path):
    # доли трека — 0,1 с + 0,5 с × k; музыка с 1,3 с ролика и с 0,35 с трека: доля трека 0,6 с — на 1,55 с ролика
    job, music = music_job(tmp_path, 12, at=1.3, **{"from": 0.35})
    tl = Timeline([(0.0, 10.0)], 1.0)
    snapped, report = on_beats(job, edit_with(music=music, zooms=[{"t": 1.5, "level": 1.05}, {"t": 0.6, "level": 1.0}]), tl)
    assert [z["t"] for z in snapped["zooms"]] == pytest.approx([1.55, 0.6], abs=0.02), "до начала музыки долей нет"
    assert report["moved"] == 1


@needs_ffmpeg
def test_a_short_track_from_its_middle_loops_from_its_start(tmp_path):
    # 2,8 с трека с 1,2-й секунды (доли 1,6…3,6 → 0,4…2,4 с ролика), дальше трек сначала с 2,8 с: доли 2,9 с, 3,4 с…
    job, music = music_job(tmp_path, 4, **{"from": 1.2})
    tl = Timeline([(0.0, 10.0)], 1.0)
    snapped, _ = on_beats(job, edit_with(music=music, zooms=[{"t": 3.3, "level": 1.05}]), tl)
    assert snapped["zooms"][0]["t"] == pytest.approx(3.4, abs=0.02)


@needs_ffmpeg
def test_render_writes_the_beats_of_the_whole_track_for_the_editor(tmp_path):
    """Доли всего трека — в beats.json (редактор ставит вставки на те же доли), а не только той части, что звучит в
    ролике: от длины ролика и правок они не зависят."""
    job, music = music_job(tmp_path, 12)
    on_beats(job, edit_with(music=music, zooms=[{"t": 1.0, "level": 1.05}]), Timeline([(0.0, 3.0)], 1.0))
    saved = job.read("beats.json")
    assert saved["file"] == music["file"] and saved["length"] == pytest.approx(12.0, abs=0.01) and 117 <= saved["bpm"] <= 123
    assert saved["times"][0] == pytest.approx(0.1, abs=0.02) and saved["times"][-1] > 11, "доли до конца трека, а не ролика"
    assert saved["times"] == sorted(saved["times"])


def test_beats_in_the_video_follow_where_the_track_plays_and_repeat_with_it():
    times = [0.1, 0.6, 1.1, 1.6]  # трек 2 с
    assert beats.beat_times(times, 4.0, 0.0, 0.0, 1.0) == [0.1, 0.6, 1.1, 1.6], "трек длиннее нужного (ролик и 2 с) — без повтора"
    looped = beats.beat_times(times, 2.0, 0.0, 0.0, 3.0)
    assert looped[:8] == pytest.approx([0.1, 0.6, 1.1, 1.6, 2.1, 2.6, 3.1, 3.6]), "короче ролика — по кругу"
    late = beats.beat_times(times, 2.0, 1.3, 0.35, 1.0)
    assert late[:3] == pytest.approx([1.55, 2.05, 2.55]), "с 1,3 с ролика и с 0,35 с трека; доли до from — нет"
    assert beats.played(10.0, 1.0, 2.0, 5.0) == pytest.approx(8.0) and beats.played(3.0, 0.0, 0.0, 9.0) == 3.0


def test_an_insert_does_not_jump_to_a_beat_across_a_join_into_another_piece():
    """Кусок 5–8 Павел поставил перед 0–3: доля на 3,05 с ролика — уже в куске 0–3. Вставка с 7,9 (2,9 с ролика) к ней
    не прыгает: на 0,05 с исходника она оказалась бы в другом месте записи (ревью фазы 4)."""
    edit = {"zooms": [], "inserts": [{"kind": "image", "t0": 7.9, "t1": 8.0}, {"kind": "image", "t0": 5.9, "t1": 7.0}]}
    out, moved = beats.snap_edit(edit, Timeline([(5.0, 8.0), (0.0, 3.0)], 1.0), [1.0, 3.05])
    assert [i["t0"] for i in out["inserts"]] == [7.9, 6.0] and moved == 1, out["inserts"]


def test_an_insert_pavel_switched_off_is_not_moved_to_a_beat_and_not_counted():
    # в ролике её нет (insert_spans): к доле не двигаем — «подвинуто» считает только видимое
    edit = {"zooms": [], "inserts": [{"kind": "image", "t0": 2.9, "t1": 4.0, "off": True}, {"kind": "image", "t0": 5.9, "t1": 7.0}]}
    out, moved = beats.snap_edit(edit, Timeline([(0.0, 9.0)], 1.0), [3.0, 6.0])
    assert [i["t0"] for i in out["inserts"]] == [2.9, 6.0]
    assert moved == 1
