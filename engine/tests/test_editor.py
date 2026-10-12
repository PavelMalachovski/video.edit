"""Файлы для редактора на странице (бета): прокси-видео, волна звука, лента кадров — по исходнику source.mp4."""
import base64
import itertools
import json
import shutil
import subprocess

import pytest

from vm import audio, editor
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


def test_the_proxy_voice_is_as_loud_as_the_voice_in_the_video(job, tmp_path):
    """Редактор сводит голос прокси с музыкой и звуками как движок, поэтому голос прокси — на громкости голоса в
    ролике (VOICE_LUFS), и у тихой записи тоже: иначе на прослушивании музыка звучала бы громче, чем в ролике."""
    quiet = tmp_path / "quiet.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(job.path("source.mp4")), "-af", "volume=-24dB", "-c:v", "copy",
                    "-c:a", "aac", str(quiet)], check=True)
    shutil.copy(quiet, job.path("source.mp4"))
    assert audio._loudness(quiet, 2, 30) < audio.VOICE_LUFS - 15
    editor.make(job)
    proxy = job.path("out/proxy.mp4")
    level = audio._loudness(proxy, 2, 30)
    assert level is not None and abs(level - audio.VOICE_LUFS) < 2.5, level
    assert abs(probe(proxy).duration - probe(job.path("source.mp4")).duration) < 0.1, "звук не длиннее картинки"


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
    assert editor.audio_rate(60) == editor.AUDIO_RATE


@pytest.mark.parametrize("seconds", [10, 60, 600, 1200, 1800, 3600, 2 * 3600])
def test_picture_and_sound_together_stay_well_under_the_git_limit(seconds):
    from vm.git import MAX_FILE_BYTES
    total = (editor.proxy_rate(seconds) + editor.audio_rate(seconds)) * seconds / 8
    assert total <= MAX_FILE_BYTES * 0.85, f"{seconds} с: {total / 2**20:.1f} МБ"
    assert editor.proxy_rate(seconds) >= editor.MIN_RATE and editor.audio_rate(seconds) >= editor.MIN_AUDIO


def test_a_source_too_long_for_a_proxy_gets_the_editor_without_video(job, monkeypatch):
    monkeypatch.setattr(editor, "MAX_PROXY_SECONDS", 1)  # исходник длиннее — прокси не делается вовсе
    data = editor.make(job)
    assert data["proxy"] is None and not job.path("out/proxy.mp4").exists()
    assert job.path("film.jpg").is_file() and data["peaks"]["data"]


def test_a_proxy_over_the_limit_is_dropped_and_the_editor_says_so(job, monkeypatch):
    monkeypatch.setattr(editor, "MAX_PROXY_BYTES", 1000)  # любой прокси «не влез»
    data = editor.make(job)
    assert data["proxy"] is None
    assert not job.path("out/proxy.mp4").exists()
    assert job.read("editor.json")["proxy"] is None, "схема принимает editor.json без прокси"
    assert job.path("film.jpg").is_file()


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


def test_video_marks_follow_the_voiceover_length(tmp_path, monkeypatch):
    from pathlib import Path

    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    monkeypatch.setattr(editor, "part_spans", lambda parts: [(0.0, 2.0), (2.0, 3.0)][: len(parts)])
    parts = [Path("in/source.mov"), Path("in/source-2.mp4")]
    assert editor.video_marks(job, parts, 4.5) == [{"name": "source.mov", "t0": 0.0, "t1": 2.0}, {"name": "source-2.mp4", "t0": 2.0, "t1": 4.5}], \
        "озвучка длиннее видео: стоп-кадр — у последнего"
    assert editor.video_marks(job, parts, 1.5) == [{"name": "source.mov", "t0": 0.0, "t1": 1.5}], "озвучка короче: второго видео в ролике нет"
    job.path("job.json").write_text('{"name": "IMG_1.MOV"}', encoding="utf-8")
    assert editor.video_marks(job, parts[:1], 2.0) == [{"name": "IMG_1.MOV", "t0": 0.0, "t1": 2.0}], "одно видео — имя задачи"
