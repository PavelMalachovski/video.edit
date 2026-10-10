"""Сборка финала целиком: настоящий ffmpeg, настоящий Chromium для слоя. Медленно — помечено slow.

Исходник рисует ffmpeg (testsrc2 + синус-всплески), edit.json проходит схему движка. Кодирование в тестах —
`preset="ultrafast"`, чтобы не ждать; остальные параметры — как у настоящего финала.
"""
import json
import shutil
import subprocess

import numpy as np
import pytest

from vm.job import Job
from vm.render import RenderError, _ffmpeg, render, timeline

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("node")), reason="нужны ffmpeg и node"),
]

STYLE = {
    "font": "montserrat",
    "hand": "caveat",
    "colors": {"text": "#FFFFFF", "accent": "#FFD23F", "bar": "#FFD23F", "plate": "#111111", "outline": "#000000"},
    "subtitles": {"mode": "karaoke", "words": 3, "size": 64, "y": 1300},
    "hook": {"mode": "plate", "size": 72},
    "bar": {"pos": "bottom", "height": 14},
}


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *map(str, args)], check=True)


def make_source(path, seconds: int, size: str = "1080x1920"):
    ffmpeg(
        "-f", "lavfi", "-i", f"testsrc2=s={size}:r=30:d={seconds}",
        "-f", "lavfi", "-i", f"sine=f=440:r=48000:d={seconds},volume='if(lt(mod(t,1),0.5),1,0)':eval=frame",
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", "aac", "-ac", "2", "-ar", "48000", "-shortest", path,
    )
    return path


@pytest.fixture(scope="module")
def sources(tmp_path_factory):
    d = tmp_path_factory.mktemp("render-src")
    return {
        "vertical": make_source(d / "vertical.mp4", 16),
        "short": make_source(d / "short.mp4", 6),
        "landscape": make_source(d / "landscape.mp4", 4, "1080x608"),
    }


def make_job(tmp_path, source, **fields) -> Job:
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    shutil.copy(source, job.path("source.mp4"))
    uploads = job.path("in/uploads")
    uploads.mkdir(parents=True)
    ffmpeg("-f", "lavfi", "-i", "color=c=0x3366FF:s=400x300:d=1", "-frames:v", "1", uploads / "upload-i1.png")
    ffmpeg("-f", "lavfi", "-i", "color=c=red:s=640x360:d=1", "-frames:v", "1", uploads / "upload-i2.png")
    edit = {
        "speed": 1.0,
        "keep": [[0.0, 6.0]],
        "words": [],
        "hook": None,
        "cta": None,
        "inserts": [],
        "zooms": [],
        "face": {"x": 0.5, "y": 0.3},
        "music": None,
        "hold": 0.0,
        "style": STYLE,
    }
    edit.update(fields)
    job.write("edit.json", edit)
    return job


def probe(path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_type,width,height,r_frame_rate,color_primaries,color_transfer,color_space,sample_rate:format=duration",
         "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(out)


def frame(path, t: float) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.uint8).reshape(1920, 1080, 3)


def close(pixel, rgb, tol=12) -> bool:
    return all(abs(int(a) - b) <= tol for a, b in zip(pixel, rgb, strict=True))


def test_render_end_to_end(tmp_path, sources):
    job = make_job(
        tmp_path,
        sources["vertical"],
        speed=1.1,
        keep=[[0.0, 6.0], [8.0, 14.0]],
        hook={"text": "Как я монтирую", "until": 2.5},
        words=[{"t0": 0.5, "t1": 0.9, "text": "раз"}, {"t0": 1.0, "t1": 1.4, "text": "два"}, {"t0": 8.5, "t1": 9.0, "text": "три"}],
        inserts=[{"kind": "image", "src": "in/uploads/upload-i1.png", "t0": 4.0, "t1": 6.0, "x": 100, "y": 600, "w": 300, "sfx": None, "params": {}}],
        zooms=[{"t": 3.0, "level": 1.05}],
        hold=0.5,
    )
    out = job.path("out")
    result = render(job, out, preset="ultrafast")
    final = out / "final.mp4"
    info = probe(final)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert (video["width"], video["height"], video["r_frame_rate"]) == (1080, 1920, "30/1")
    assert (video["color_primaries"], video["color_transfer"], video["color_space"]) == ("bt709", "bt709", "bt709")
    assert audio["sample_rate"] == "48000"
    tl = timeline(job.read("edit.json"))
    assert float(info["format"]["duration"]) == pytest.approx(tl.duration + 0.5, abs=0.05)
    assert result["durations"]["final"] == pytest.approx(tl.duration + 0.5, abs=0.01)
    assert result["durations"]["source"] == pytest.approx(16.0, abs=0.1)
    last = frame(final, tl.duration + 0.4)
    assert close(last[1912, 100], (0xFF, 0xD2, 0x3F)) and close(last[1912, 1000], (0xFF, 0xD2, 0x3F)), last[1912, [100, 1000]]
    mid = frame(final, tl.duration / 2)
    filled = int(np.sum(np.all(np.abs(mid[1912].astype(int) - (0xFF, 0xD2, 0x3F)) <= 12, axis=1)))
    assert 400 <= filled <= 680, f"bar about half way: {filled} px"
    assert "music: none chosen" in result["missing"]
    srt = (out / "final.srt").read_text(encoding="utf-8")
    assert "раз" in srt and "три" in srt
    assert not any(p.suffix == ".png" for p in out.iterdir()), "work files stay out of out/"


def test_render_without_words_has_no_subs(tmp_path, sources):
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 5.0]])
    result = render(job, job.path("out"), preset="ultrafast")
    assert (job.path("out") / "final.mp4").stat().st_size > 0
    assert (job.path("out") / "final.srt").read_text(encoding="utf-8") == ""
    assert any("нет речи" in m for m in result["missing"])


def test_render_version_name(tmp_path, sources):
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 2.0]])
    render(job, job.path("out"), name="final-v2", preset="ultrafast")
    assert (job.path("out") / "final-v2.mp4").is_file() and (job.path("out") / "final-v2.srt").is_file()


def test_render_landscape_source_gets_blurred_background(tmp_path, sources):
    job = make_job(tmp_path, sources["landscape"], keep=[[0.0, 3.0]])
    result = render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"
    video = next(s for s in probe(final)["streams"] if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == (1080, 1920)
    top = frame(final, 1.0)[200:400]
    assert top.mean() > 20, "the area above the landscape picture is a blurred copy, not black"
    assert any("размыт" in w for w in result["warnings"])


def test_render_fullscreen_insert_covers_the_frame(tmp_path, sources):
    job = make_job(
        tmp_path,
        sources["short"],
        keep=[[0.0, 6.0]],
        inserts=[{"kind": "fullscreen", "src": "in/uploads/upload-i2.png", "t0": 2.0, "t1": 4.0, "sfx": None, "params": {}}],
        words=[{"t0": 2.5, "t1": 3.0, "text": "поверх"}],
    )
    render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"
    inside, outside = frame(final, 3.5), frame(final, 5.0)
    assert close(inside[300, 540], (255, 0, 0), tol=25), inside[300, 540]
    assert not close(outside[300, 540], (255, 0, 0), tol=60)


def test_render_reports_a_missing_fullscreen_file(tmp_path, sources):
    job = make_job(
        tmp_path,
        sources["short"],
        keep=[[0.0, 3.0]],
        inserts=[{"kind": "fullscreen", "src": "in/uploads/nope.mp4", "t0": 1.0, "t1": 2.0, "sfx": None, "params": {}}],
    )
    result = render(job, job.path("out"), preset="ultrafast")
    assert any("nope.mp4" in m for m in result["missing"])


@pytest.mark.slow
def test_a_stuck_ffmpeg_is_stopped_with_a_clear_error():
    # зависший ffmpeg не должен держать рутину вечно
    with pytest.raises(RenderError, match="не уложился"):
        _ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=600", "-f", "null", "-"], timeout=1)
