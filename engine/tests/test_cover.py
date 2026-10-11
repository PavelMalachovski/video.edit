"""Обложка: кадр исходника с цветом финала под слоем шаблона — PNG 1080×1920 при любом кадре исходника. Слой здесь
рисует не Chromium, а ffmpeg (прозрачный кадр с красной линией в 1 px) — так видно и размер, и точность цвета."""
import json
import shutil
import subprocess

import numpy as np
import pytest

from vm import render
from vm.job import Job

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")


def ff(*args) -> bytes:
    return subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *map(str, args)],
                          check=True, capture_output=True).stdout


def fake_layer(monkeypatch):
    def draw(job, events, style, work):
        frames = work / "frames"
        frames.mkdir(parents=True)
        ff("-f", "lavfi", "-i", "color=c=black@0.0:s=1080x1920,format=rgba", "-vf",
           "drawbox=x=100:y=960:w=880:h=1:color=red@1:t=fill:replace=1", "-frames:v", "1", frames / "f0.png")
        box = {"x": 100, "y": 900, "w": 880, "h": 120}
        (frames / "boxes.json").write_text(json.dumps([{"t0": 0, "t1": 1 / 30, "frame": "f0.png", "boxes": {"cover": box}}]))

    monkeypatch.setattr(render, "_draw", draw)


@pytest.mark.parametrize("size", ["1080x1920", "1080x608", "1080x1350"])
def test_the_cover_is_9_by_16_whatever_the_frame_of_the_source(tmp_path, monkeypatch, size):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    ff("-f", "lavfi", "-i", f"testsrc2=s={size}:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", job.path("source.mp4"))
    fake_layer(monkeypatch)
    out = job.path("out/final-cover.png")
    report = render.render_cover(job, {"cover": {"t": 0.5, "text": "Как я учу"}, "style": {}}, out)
    png = np.frombuffer(ff("-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"), np.uint8)
    assert png.size == 1080 * 1920 * 3 and report["size"] == [1080, 1920], "обложка — 1080×1920"
    png = png.reshape(1920, 1080, 3).astype(int)
    assert np.abs(png[960, 300:800] - [255, 0, 0]).max() <= 3, "тонкая линия слоя — того же цвета: без 4:2:0"
    assert png[100, 540].max() > 20, "сверху — кадр или его размытая копия, а не пустота"
