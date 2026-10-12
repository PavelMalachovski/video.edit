"""Файлы для редактора на странице (бета): прокси-видео, волна звука, лента кадров — по исходнику source.mp4."""
import base64
import itertools
import json
import shutil
import subprocess

import pytest

from vm import editor
from vm.job import Job
from vm.media import probe


def keyframes(path) -> list[float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time",
         "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout
    return [float(x.strip(",")) for x in out.split() if x.strip(",")]


@pytest.fixture
def job(tmp_path, colors):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    shutil.copy(colors, job.path("source.mp4"))
    return job


def test_proxy_is_small_vertical_with_sound_and_a_key_frame_every_half_second(job):
    info = editor.make(job)
    proxy = job.path("out/proxy.mp4")
    p = probe(proxy)
    assert (p.width, p.height) == (540, 960)
    assert p.has_audio
    assert abs(p.duration - probe(job.path("source.mp4")).duration) < 0.1
    keys = keyframes(proxy)
    assert len(keys) >= 6 and all(b - a <= 0.51 for a, b in itertools.pairwise(keys)), keys
    assert info["proxy"] == {"file": "out/proxy.mp4", "width": 540, "height": 960, "key": 0.5}


def test_editor_json_has_the_peaks_and_the_film_strip_and_passes_its_schema(job):
    editor.make(job)
    data = job.read("editor.json")  # схема — engine/vm/schemas/editor.json
    duration = probe(job.path("source.mp4")).duration
    assert data["duration"] == pytest.approx(duration, abs=0.05)
    peaks = base64.b64decode(data["peaks"]["data"])
    assert data["peaks"]["perS"] == editor.PEAKS_PER_S
    assert abs(len(peaks) - duration * editor.PEAKS_PER_S) <= 2
    assert max(peaks) > 200, "тон 500 Гц на всю длину — волна почти до верха"
    film = data["film"]
    assert film["file"] == "film.jpg" and (film["w"], film["h"]) == (54, 96)
    sheet = probe(job.path("film.jpg"))
    assert (sheet.width, sheet.height) == (54 * film["n"], 96)
    assert film["n"] == pytest.approx(duration / film["step"], abs=1)


def test_a_long_source_gets_a_coarser_film_step_and_a_lower_bitrate():
    assert editor.film_step(60) == 0.5
    assert editor.film_step(3600) == pytest.approx(3.6)
    assert editor.proxy_rate(60) == editor.MAX_RATE
    rate = editor.proxy_rate(3600)
    assert rate * 3600 / 8 <= editor.PROXY_BUDGET


def test_silence_gives_flat_peaks(tmp_path, silent):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    shutil.copy(silent, job.path("source.mp4"))
    data = editor.make(job)
    assert set(base64.b64decode(data["peaks"]["data"])) <= {0}


def test_the_files_are_made_only_once(job):
    first = editor.make(job)
    stamp = job.path("film.jpg").stat().st_mtime_ns
    assert editor.ensure(job) is None, "уже есть — ничего не делает"
    assert job.path("film.jpg").stat().st_mtime_ns == stamp
    job.path("editor.json").unlink()
    again = editor.ensure(job)
    assert again == first


def test_the_schema_refuses_junk(job):
    data = editor.make(job)
    with pytest.raises(ValueError, match="peaks"):
        job.write("editor.json", {**data, "peaks": {"perS": 50, "data": "не base64!"}})
    with pytest.raises(ValueError, match="duration"):
        job.write("editor.json", {**data, "duration": -1})
    json.dumps(data)
