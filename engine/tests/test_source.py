"""Готовый исходник задачи в черновике (`vm.source`): ключ входов, имя ассета, нормализация из in/ с озвучкой."""
import json
import subprocess
import sys

import pytest

from vm import source
from vm.job import Job

ENGINE = __import__("pathlib").Path(__file__).resolve().parents[1]


def make_job(tmp_path, **extra) -> Job:
    job = Job(tmp_path / "jobs" / "261013-101010-abcd")
    job.write("job.json", {"id": job.id, "name": "IMG_1.MOV", "size": 1000, "type": "video/quicktime", "duration": 30,
                           "createdAt": "2026-10-13T10:10:10Z", "brief": "", "uploads": [], "runs": [], **extra})
    return job


VOICE = {"file": "in/uploads/upload-voice.m4a", "asset": "upload-voice.m4a", "name": "Голос.m4a", "size": 77,
         "type": "audio/x-m4a", "kind": "audio"}
PIC = {"file": "in/uploads/upload-i1.png", "asset": "upload-i1.png", "name": "logo.png", "size": 5, "type": "image/png",
       "kind": "image"}


def test_the_key_follows_the_videos_and_the_voice_only(tmp_path, monkeypatch):
    plain = source.key(make_job(tmp_path / "a"))
    assert plain == source.key(make_job(tmp_path / "b", uploads=[PIC])), "картинки к ролику исходник не меняют"
    assert plain != source.key(make_job(tmp_path / "c", uploads=[VOICE])), "озвучка — другой звук исходника"
    assert plain != source.key(make_job(tmp_path / "d", size=1001)), "другое видео"
    two = [{"file": "in/source.mov", "asset": "source", "name": "IMG_1.MOV", "size": 1000, "type": "video/quicktime"},
           {"file": "in/source-2.mp4", "asset": "source-2", "name": "IMG_2.mp4", "size": 400, "type": "video/mp4"}]
    assert plain != source.key(make_job(tmp_path / "e", videos=two)), "несколько видео склеиваются — другой исходник"
    monkeypatch.setattr(source, "NORMALIZE", source.NORMALIZE + 1)
    assert plain != source.key(make_job(tmp_path / "a")), "другая нормализация — старый кэш не годится"


def test_the_asset_name_carries_the_key(tmp_path):
    job = make_job(tmp_path)
    assert source.asset(job) == f"source-{source.key(job)}.mp4"
    assert source.key(job) == source.key(job) and len(source.key(job)) == 12


def test_a_script_job_has_no_source(tmp_path):
    assert source.asset(make_job(tmp_path, kind="script")) is None


def test_the_name_from_the_command_line(tmp_path):
    job = make_job(tmp_path)
    out = subprocess.run([sys.executable, "-m", "vm.source", str(job.root), "--name"], cwd=ENGINE, capture_output=True,
                         text=True, check=True).stdout.strip()
    assert out == source.asset(job)


def test_make_normalizes_the_videos_with_the_voice(tmp_path, monkeypatch):
    job = make_job(tmp_path, uploads=[VOICE, PIC])
    for name in ("in/source.mov", "in/uploads/upload-voice.m4a"):
        job.path(name).parent.mkdir(parents=True, exist_ok=True)
        job.path(name).write_bytes(b"x")
    calls = []
    monkeypatch.setattr(source, "normalize", lambda parts, out, voice=None: calls.append((parts, out, voice)) or "probe")
    assert source.make(job) == "probe"
    assert calls == [([job.path("in/source.mov")], job.path("source.mp4"), job.path("in/uploads/upload-voice.m4a"))]


def test_make_without_the_videos_says_to_fetch_the_originals(tmp_path):
    with pytest.raises(ValueError, match="fetch .*--originals"):
        source.make(make_job(tmp_path))


def test_the_voice_named_in_job_json_must_be_fetched(tmp_path):
    job = make_job(tmp_path, uploads=[VOICE])
    job.path("in").mkdir(parents=True)
    job.path("in/source.mov").write_bytes(b"x")
    with pytest.raises(ValueError, match="озвучки Голос.m4a нет"):
        source.make(job)


def test_the_ready_source_json_is_what_fetch_checks(tmp_path):
    body = b"0123456789" * 100
    path = tmp_path / "source.mp4"
    path.write_bytes(body)
    info = source.describe(path, parts=3)
    assert info == {"size": len(body), "sha256": __import__("hashlib").sha256(body).hexdigest(), "parts": 3,
                    "normalize": source.NORMALIZE}
    json.dumps(info)
