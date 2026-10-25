"""Перебивки: окошко лица (pip) — где оно на кадре и какой кусок кадра в нём; маска скруглённых углов."""
import pytest
from PIL import Image

from vm.broll import FACE, PIP, face_box, pip_mask


def test_the_face_window_sits_top_right_inside_the_frame_above_the_subtitles():
    x, y, w, h = PIP["x"], PIP["y"], PIP["w"], PIP["h"]
    assert x + w <= 1080 - 40 and y >= 250, "в стороне от кромки и от шапки Reels"
    assert y + h <= 1920 * 0.5, "верхняя половина кадра: внизу субтитры и шкала"
    assert w * 4 == h * 3, "окошко 3:4, как кусок кадра с лицом"


def test_the_face_crop_is_centred_on_the_face_and_stays_inside_the_frame():
    assert face_box({"x": 0.5, "y": 0.4}) == (270, 480, FACE["w"], FACE["h"])  # лицо — на 40 % высоты окошка
    assert face_box({"x": 0.0, "y": 0.0})[:2] == (0, 0)
    assert face_box({"x": 1.0, "y": 1.0})[:2] == (1080 - FACE["w"], 1920 - FACE["h"])
    w, h = FACE["w"], FACE["h"]
    assert w * 4 == h * 3 and w <= 1080 and h <= 1920


def test_the_mask_is_opaque_inside_and_clear_in_the_rounded_corners(tmp_path):
    path = pip_mask(tmp_path / "mask.png")
    with Image.open(path) as m:
        assert m.size == (PIP["w"], PIP["h"]) and m.mode == "L"
        assert m.getpixel((PIP["w"] // 2, PIP["h"] // 2)) == 255
        assert m.getpixel((0, 0)) == 0 and m.getpixel((PIP["w"] - 1, PIP["h"] - 1)) == 0
        assert m.getpixel((PIP["r"], 0)) > 0, "прямая кромка за скруглением — видна"


@pytest.mark.parametrize("face", [{"x": 0.5}, {}])
def test_a_face_without_coordinates_is_the_middle(face):
    x, _, w, _ = face_box(face)
    assert x == round(540 - w / 2)


# ---------- vm broll: что за клипы у перебивок — для Claude ----------

import json
import subprocess

from vm import broll
from vm.job import Job


def _ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def b_roll_job(tmp_path) -> Job:
    job = Job(tmp_path / "jobs" / "abc")
    (job.path("in/uploads")).mkdir(parents=True)
    _ff("-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=4", "-f", "lavfi", "-i", "sine=f=300:d=4",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", job.path("in/uploads/upload-b1.mov"))
    _ff("-f", "lavfi", "-i", "testsrc2=s=720x1280:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", job.path("in/uploads/upload-b2.mp4"))
    _ff("-f", "lavfi", "-i", "color=c=red:s=800x600:d=1", "-frames:v", "1", job.path("in/uploads/upload-b3.jpg"))
    up = lambda n, ext, name, kind="broll": {"file": f"in/uploads/upload-b{n}.{ext}", "asset": f"upload-b{n}.{ext}", "name": name,
                                             "size": 1, "type": "video/mp4", "kind": kind}
    job.write("job.json", {"id": "abc", "brief": "", "runs": [], "uploads": [
        up(1, "mov", "зал.MOV"), up(2, "mp4", "руки.mp4"), up(3, "jpg", "кадр.jpg"),
        {"file": "in/uploads/upload-i1.png", "asset": "upload-i1.png", "name": "logo.png", "size": 1, "type": "image/png", "kind": "image"},
    ]})
    return job


def test_vm_broll_describes_each_clip_with_a_contact_sheet_and_speech(tmp_path, monkeypatch):
    job = b_roll_job(tmp_path)
    monkeypatch.setattr(broll, "_speech", lambda wav: [(0.5, 2.5)])  # «в клипе говорят 2 с»
    clips = broll.describe(job)
    assert [c["src"] for c in clips] == ["in/uploads/upload-b1.mov", "in/uploads/upload-b2.mp4", "in/uploads/upload-b3.jpg"]
    film, hands, still = clips
    assert film["kind"] == "video" and film["seconds"] == 4.0 and (film["width"], film["height"]) == (1920, 1080)
    assert film["sound"] is True and film["speech"] == 2.0, "звук есть, речи 2 с — фон лучше выключить"
    assert hands["sound"] is False and hands["speech"] is None, "без звука — речи не бывает"
    assert job.path(film["sheet"]).is_file() and job.path(hands["sheet"]).is_file()
    assert still["kind"] == "image" and still["sheet"] is None and (still["width"], still["height"]) == (800, 600)
    text = broll.summary(clips)
    assert "upload-b1.mov" in text and "зал.MOV" in text and "речь 2.0 с" in text and "look/broll-b1.png" in text


def test_vm_broll_says_when_speech_could_not_be_checked(tmp_path, monkeypatch):
    job = b_roll_job(tmp_path)
    monkeypatch.setattr(broll, "_speech", lambda wav: None)  # модели VAD нет
    film = broll.describe(job)[0]
    assert film["speech"] is None and "речь не проверена" in broll.summary([film])


def test_vm_broll_without_clips_says_so(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("job.json", {"id": "abc", "brief": "", "runs": [], "uploads": []})
    assert broll.describe(job) == [] and "перебивок нет" in broll.summary([]).lower()
    assert json.loads(json.dumps(broll.describe(job))) == []


def test_vm_broll_is_a_command(tmp_path, monkeypatch, capsys):
    from vm.__main__ import main

    job = b_roll_job(tmp_path)
    monkeypatch.setattr(broll, "_speech", lambda wav: [])
    assert main(["broll", str(job.root)]) == 0
    out = capsys.readouterr().out
    assert "Перебивок: 3" in out and "звук без речи" in out
