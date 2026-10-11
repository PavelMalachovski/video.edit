"""Сборка финала целиком: настоящий ffmpeg, настоящий Chromium для слоя. Медленно — помечено slow.

Исходник рисует ffmpeg (testsrc2 + синус-всплески), edit.json проходит схему движка. Кодирование в тестах —
`preset="ultrafast"`, чтобы не ждать; остальные параметры — как у настоящего финала.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from vm.job import Job
from vm.media import mp4_boxes
from vm.render import (
    COVER_ZONE,
    RenderError,
    _ffmpeg,
    _sounds,
    render,
    render_cover,
    timeline,
    variant_ad,
    variant_b,
)

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
    assert not any("music" in m or "музык" in m for m in result["missing"]), "без музыки — выбор Павла, а не нехватка"
    srt = (out / "final.srt").read_text(encoding="utf-8")
    assert "раз" in srt and "три" in srt
    assert not any(p.suffix == ".png" for p in out.iterdir()), "work files stay out of out/"


def test_final_has_no_edit_lists_and_stays_in_sync(tmp_path, sources):
    """Meta (гайд «Всё о Reels», стр. 63): в контейнере нет edit lists. Без них B-кадры сдвинули бы картинку на
    2 кадра, а приминг AAC — звук на 21 мс: оба потока начинаются с нуля, кадры ровно 30 к/с, всплеск звука
    исходника (синус с 1,0 с) — на 1,0 с ролика."""
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 4.0]])
    render(job, job.path("out"), preset="ultrafast")
    final = job.path("out/final.mp4")
    assert not [b for b in mp4_boxes(final) if b.split("/")[-1] in ("edts", "elst")]
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,start_time,avg_frame_rate", "-of", "json", str(final)],
        check=True, capture_output=True, text=True,
    ).stdout
    streams = {s["codec_type"]: s for s in json.loads(out)["streams"]}
    assert float(streams["video"]["start_time"]) == 0 and float(streams["audio"]["start_time"]) == 0
    assert streams["video"]["avg_frame_rate"] == "30/1"
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(final), "-map", "0:a", "-ac", "1", "-ar", "48000",
         "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    pcm = np.frombuffer(raw, np.float32)
    after = pcm[int(0.75 * 48000):int(1.25 * 48000)]
    onset = 0.75 + int(np.argmax(np.abs(after) > 0.05)) / 48000
    assert onset == pytest.approx(1.0, abs=0.004), f"синус вернулся на {onset:.4f} с"


def test_end_card_freezes_the_last_frame_darker_with_the_call_to_action(tmp_path, sources):
    """Финальная карточка: после стоп-кадра ещё seconds того же кадра, затемнённого; поверх — призыв на плашке цвета
    подсветки, ник и логотип; звук появления — в её начало."""
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 3.0]], hold=0.5,
                   end={"seconds": 1.5, "lines": ["Подпишись 👇"], "handle": "@pavel", "logo": "in/uploads/upload-i1.png",
                        "sfx": None})
    result = render(job, job.path("out"), preset="ultrafast")
    final = job.path("out/final.mp4")
    assert result["durations"]["final"] == pytest.approx(3.0 + 0.5 + 1.5, abs=0.01)
    assert float(probe(final)["format"]["duration"]) == pytest.approx(5.0, abs=0.05)
    held, card = frame(final, 3.3), frame(final, 4.6)
    assert card[300:1500].mean() < 0.75 * held[300:1500].mean(), "карточка затемняет кадр"
    accent = np.all(np.abs(card.astype(int) - (0xFF, 0xD2, 0x3F)) <= 16, axis=2)
    assert accent[200:1500, 60:890].sum() > 5000, "плашка призыва цвета подсветки"
    blue = np.all(np.abs(card.astype(int) - (0x33, 0x66, 0xFF)) <= 20, axis=2)
    assert blue[120:1530, 60:890].sum() > 2000, "логотип (синий квадрат из загрузки) на карточке"


def test_end_card_sound_plays_when_it_appears(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    job.path("in/uploads").mkdir(parents=True)
    ffmpeg("-f", "lavfi", "-i", "sine=f=900:d=0.3", job.path("in/uploads/pop.wav"))
    edit = {"speed": 1.0, "keep": [[0.0, 6.0]], "hook": None, "music": None, "inserts": [], "hold": 0.5,
            "end": {"seconds": 2.0, "lines": ["Подпишись"], "sfx": "in/uploads/pop.wav"}}
    sfx, _, notes = _sounds(job, edit, timeline(edit), skip=set())
    assert sfx == [(6.5, job.path("in/uploads/pop.wav").resolve())] and notes == []


def test_teaser_plays_its_phrase_first_then_the_video_from_the_start(tmp_path, sources):
    """Тизер: фраза из середины (2,0–3,0 с исходника) — в самом начале ролика, звук и картинка вместе; потом ролик с
    начала. Синус исходника звучит первые полсекунды каждой секунды."""
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 4.0]], teaser={"t0": 2.0, "t1": 3.0, "sfx": None})
    result = render(job, job.path("out"), preset="ultrafast")
    final = job.path("out/final.mp4")
    assert result["durations"]["final"] == pytest.approx(5.0, abs=0.01)
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(final), "-map", "0:a", "-ac", "1", "-ar", "48000",
                          "-f", "f32le", "-"], check=True, capture_output=True).stdout
    pcm = np.abs(np.frombuffer(raw, np.float32))
    loud = lambda t: float(pcm[int((t - 0.1) * 48000):int((t + 0.1) * 48000)].mean())
    assert loud(0.25) > 4 * loud(0.75), "тизер: звучит фраза 2,0–2,5 с исходника, потом пауза"
    assert loud(1.25) > 4 * loud(1.75), "дальше ролик с начала"
    src = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", "2.1", "-i", str(sources["short"]), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
    source = np.frombuffer(src, np.uint8).reshape(1920, 1080, 3).astype(int)
    assert np.abs(frame(final, 0.1).astype(int)[300:1200] - source[300:1200]).mean() < 12, "первый кадр — из тизера"


def test_version_b_is_rendered_without_the_teaser_beside_version_a(tmp_path, sources):
    """A/B-тест: версия B — тот же монтаж без тизера, со своим слоем (work/render-b); слой и ролик A остаются."""
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 4.0]], teaser={"t0": 2.0, "t1": 3.0, "sfx": None}, ab="teaser")
    a = render(job, job.path("out"), preset="ultrafast")
    b = render(job, job.path("out"), name="final-b", preset="ultrafast", edit=variant_b(job.read("edit.json")), work="work/render-b")
    assert a["durations"]["final"] == pytest.approx(5.0, abs=0.01) and b["durations"]["final"] == pytest.approx(4.0, abs=0.01)
    assert float(probe(job.path("out/final.mp4"))["format"]["duration"]) == pytest.approx(5.0, abs=0.05)
    assert float(probe(job.path("out/final-b.mp4"))["format"]["duration"]) == pytest.approx(4.0, abs=0.05)
    ends = [max(e["t1"] for e in json.loads(job.path(f"{work}/frames/boxes.json").read_text(encoding="utf-8")))
            for work in ("work/render", "work/render-b")]
    assert ends == pytest.approx([5.0, 4.0], abs=0.04), "у каждой версии свой слой"
    src = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", "0.1", "-i", str(sources["short"]), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
    source = np.frombuffer(src, np.uint8).reshape(1920, 1080, 3).astype(int)
    assert np.abs(frame(job.path("out/final-b.mp4"), 0.1).astype(int)[300:1200] - source[300:1200]).mean() < 12, "B — с начала"


def test_with_music_the_insert_appears_on_its_beat(tmp_path, sources):
    """Монтаж в такт: вставка с 2,45 с встаёт на долю трека 2,6 с (щелчки 120 уд/мин с 0,1 с); слой и звук — по ней."""
    import soundfile

    job = make_job(tmp_path, sources["short"], keep=[[0.0, 6.0]],
                   music={"file": "in/uploads/beat.wav", "gainDb": -18},
                   inserts=[{"kind": "image", "src": "in/uploads/upload-i1.png", "t0": 2.45, "t1": 4.5, "x": 100, "y": 600, "w": 300,
                             "sfx": None, "params": {}}])
    n = int(0.03 * 22050)
    burst = np.exp(-np.arange(n) / (0.005 * 22050)) * np.sin(2 * np.pi * 1000 * np.arange(n) / 22050)
    y = np.zeros(8 * 22050, dtype=np.float32)
    for k in range(15):
        start = int((0.1 + 0.5 * k) * 22050)
        y[start:start + n] += burst.astype(np.float32)
    soundfile.write(job.path("in/uploads/beat.wav"), y, 22050)
    result = render(job, job.path("out"), preset="ultrafast")
    assert result["beats"]["moved"] == 1 and 117 <= result["beats"]["bpm"] <= 123, result["beats"]
    boxes = json.loads(job.path("work/render/frames/boxes.json").read_text(encoding="utf-8"))
    shown = min(e["t0"] for e in boxes if (e.get("boxes") or {}).get("inserts"))
    assert shown == pytest.approx(2.6, abs=0.04), "вставка появилась на доле"
    assert job.read("edit.json")["inserts"][0]["t0"] == 2.45, "edit.json не меняется"


def test_teaser_sound_plays_at_the_seam(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    job.path("in/uploads").mkdir(parents=True)
    ffmpeg("-f", "lavfi", "-i", "sine=f=900:d=0.3", job.path("in/uploads/swoosh.wav"))
    edit = {"speed": 1.0, "keep": [[0.0, 6.0]], "hook": None, "music": None, "inserts": [], "hold": 0.0,
            "teaser": {"t0": 2.0, "t1": 3.5, "sfx": "in/uploads/swoosh.wav"}}
    sfx, _, notes = _sounds(job, edit, timeline(edit), skip=set())
    assert sfx == [(1.5, job.path("in/uploads/swoosh.wav").resolve())] and notes == []


def test_render_timeline_keeps_the_teaser_on_whole_frames():
    tl = timeline({"keep": [[0.0, 6.0]], "speed": 1.0, "teaser": {"t0": 2.01, "t1": 3.02}})
    assert tl.teaser == pytest.approx((2.0, 3.0333333)) and timeline({"keep": [[0.0, 6.0]], "speed": 1.0}).teaser is None


def test_render_without_words_has_no_subs(tmp_path, sources):
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 5.0]])
    job.path("out").mkdir()
    job.path("out/final.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nстарое\n\n", encoding="utf-8")  # от прошлого рендера
    result = render(job, job.path("out"), preset="ultrafast")
    assert (job.path("out") / "final.mp4").stat().st_size > 0
    assert not (job.path("out") / "final.srt").exists(), "GitHub не принимает пустой ассет: без речи .srt нет совсем"
    assert any("нет речи" in m for m in result["missing"])
    assert not any(m.startswith("speech:") for m in result["missing"])


def test_render_version_name(tmp_path, sources):
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 2.0]], words=[{"t0": 0.2, "t1": 0.8, "text": "раз"}])
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
    assert not any("not found" in m or m.startswith("fullscreen:") for m in result["missing"]), result["missing"]


@pytest.mark.slow
def test_a_stuck_ffmpeg_is_stopped_with_a_clear_error():
    # зависший ffmpeg не должен держать рутину вечно
    with pytest.raises(RenderError, match="не уложился"):
        _ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=600", "-f", "null", "-"], timeout=1)


# ---------- исправления после ревью ----------


def frame_n(path, n: int) -> np.ndarray:
    """Кадр номер n (точно по номеру, без поиска по времени)."""
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-vf", f"select=eq(n\\,{n})", "-frames:v", "1",
         "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.uint8).reshape(1920, 1080, 3)


def test_render_memory_stays_small_for_many_cuts(tmp_path):
    # исходник 40 с, 12 отрезков: ffmpeg не должен копить кадры для ещё не начавшихся отрезков
    source = make_source(tmp_path / "long.mp4", 40)
    keep = [[i * 3.3, i * 3.3 + 2.5] for i in range(12)]
    job = make_job(tmp_path, source, keep=keep)
    code = (
        f"import resource, sys; sys.path.insert(0, {str(Path(__file__).parents[1])!r});"
        "from vm.job import Job; from vm.render import render;"
        f"job = Job({str(job.root)!r}); render(job, job.path('out'), preset='ultrafast');"
        "print(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)"
    )
    peak_kb = int(subprocess.run([sys.executable, "-c", code], check=True, capture_output=True, text=True).stdout.split()[-1])
    assert peak_kb < 1_500_000, f"peak child memory {peak_kb / 1024:.0f} MB"


def test_render_gif_fullscreen_insert(tmp_path, sources):
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 6.0]])
    ffmpeg("-f", "lavfi", "-i", "color=c=red:s=320x240:r=10:d=1", job.path("in/uploads/meme.gif"))
    edit = job.read("edit.json")
    edit["inserts"] = [{"kind": "fullscreen", "src": "in/uploads/meme.gif", "t0": 2.0, "t1": 4.0, "sfx": None, "params": {}}]
    job.write("edit.json", edit)
    render(job, job.path("out"), preset="ultrafast")
    assert close(frame(job.path("out") / "final.mp4", 3.0)[300, 540], (255, 0, 0), tol=30)


def test_render_hdr_fullscreen_video_is_converted_like_the_source(tmp_path, sources, hlg):
    from vm.media import normalize

    job = make_job(tmp_path, sources["short"], keep=[[0.0, 6.0]])
    shutil.copy(hlg, job.path("in/uploads/hdr.mp4"))
    edit = job.read("edit.json")
    edit["inserts"] = [{"kind": "fullscreen", "src": "in/uploads/hdr.mp4", "t0": 2.0, "t1": 4.0, "sfx": None, "params": {}}]
    job.write("edit.json", edit)
    render(job, job.path("out"), preset="ultrafast")
    got = frame(job.path("out") / "final.mp4", 2.0 + 0.5)
    normalize([hlg], tmp_path / "sdr.mp4")
    want = frame(tmp_path / "sdr.mp4", 0.5)
    region = (slice(200, 400), slice(100, 300))
    assert np.abs(got[region].astype(int) - want[region].astype(int)).mean() < 12


def test_cutaway_window_is_frame_exact(tmp_path, sources):
    job = make_job(
        tmp_path, sources["short"], keep=[[0.0, 6.0]],
        inserts=[{"kind": "fullscreen", "src": "in/uploads/upload-i2.png", "t0": 62 / 30, "t1": 62 / 30 + 2.0, "sfx": None, "params": {}}],
    )
    render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"

    def red(n):
        return close(frame_n(final, n)[300, 540], (255, 0, 0), tol=40)

    assert (red(61), red(62), red(121), red(122)) == (False, True, True, False)


def test_odd_bar_height_covers_the_last_row(tmp_path, sources):
    style = {**STYLE, "bar": {"pos": "bottom", "height": 15}}
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 2.0]], style=style, hold=0.5)
    render(job, job.path("out"), preset="ultrafast")
    last = frame(job.path("out") / "final.mp4", 2.3)
    assert close(last[1919, 100], (0xFF, 0xD2, 0x3F)) and close(last[1905, 100], (0xFF, 0xD2, 0x3F))


def test_music_outside_job_and_repo_is_not_used(tmp_path, sources):
    outside = tmp_path / "elsewhere" / "track.wav"
    outside.parent.mkdir()
    ffmpeg("-f", "lavfi", "-i", "sine=f=100:d=3", outside)
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 2.0]], music={"file": str(outside), "gainDb": -18})
    result = render(job, job.path("out"), preset="ultrafast")
    assert any("track.wav" in m for m in result["missing"])


def test_keep_beyond_the_source_is_clamped(tmp_path, sources):
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 7.5]])  # исходник 6 с
    result = render(job, job.path("out"), preset="ultrafast")
    assert result["durations"]["final"] == pytest.approx(6.0, abs=0.05)
    assert any("keep" in w for w in result["warnings"])
    info = probe(job.path("out") / "final.mp4")
    assert float(info["format"]["duration"]) == pytest.approx(6.0, abs=0.05)


def test_failed_render_leaves_no_part_file(tmp_path, sources, monkeypatch):
    import vm.render as rendering

    def broken(args, timeout):  # ffmpeg успел начать файл и упал
        Path(args[-1]).write_bytes(b"half a video")
        raise RenderError("ffmpeg не собрал ролик (код 1)")

    job = make_job(tmp_path, sources["short"], keep=[[0.0, 2.0]])
    job.path("out").mkdir()
    job.path("out/.final.part.mp4").write_bytes(b"left from a killed run")
    monkeypatch.setattr(rendering, "_ffmpeg", broken)
    with pytest.raises(RenderError):
        render(job, job.path("out"), preset="ultrafast")
    assert not list(job.path("out").glob(".*part*"))
    assert not job.path("out/final.mp4").exists() and not job.path("out/final.srt").exists()


def test_unreadable_fullscreen_file_is_reported_not_fatal(tmp_path, sources):
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 2.0]])
    job.path("in/uploads/broken.mp4").write_bytes(b"not a video")
    job.path("in/uploads/broken.png").write_bytes(b"not a picture")
    ffmpeg("-f", "lavfi", "-i", "color=c=red:s=320x240:r=10:d=1", job.path("in/uploads/full.gif"))
    gif = job.path("in/uploads/full.gif").read_bytes()
    job.path("in/uploads/empty.gif").write_bytes(gif[:800])  # заголовок и палитра есть, кадров нет — ffprobe доволен
    edit = job.read("edit.json")
    edit["inserts"] = [
        {"kind": "fullscreen", "src": f"in/uploads/{name}", "t0": t0, "t1": t0 + 0.5, "sfx": None, "params": {}}
        for name, t0 in (("broken.mp4", 0.5), ("broken.png", 0.2), ("empty.gif", 0.1))
    ]
    job.write("edit.json", edit)
    result = render(job, job.path("out"), preset="ultrafast")
    for name in ("broken.mp4", "broken.png", "empty.gif"):
        assert any(name in m for m in result["missing"]), (name, result["missing"])
    assert job.path("out/final.mp4").is_file()


def test_sounds_skip_absent_cutaways_and_report_missing_files(tmp_path):
    from vm.render import _sounds, timeline

    job = Job(tmp_path / "jobs" / "abc")
    job.path("in/uploads").mkdir(parents=True)
    ffmpeg("-f", "lavfi", "-i", "sine=f=900:d=0.3", job.path("in/uploads/swoosh.wav"))
    edit = {"speed": 1.0, "keep": [[0.0, 6.0]], "hook": None, "music": {"file": "assets/music/nope.mp3", "gainDb": -18},
            "inserts": [{"kind": "fullscreen", "src": "in/uploads/nope.mp4", "t0": 1.0, "t1": 3.0, "sfx": "in/uploads/swoosh.wav"},
                        {"kind": "image", "src": "in/uploads/a.png", "t0": 3.0, "t1": 4.5, "sfx": "in/uploads/swoosh.wav"},
                        {"kind": "image", "src": "in/uploads/a.png", "t0": 4.5, "t1": 6.0, "sfx": "assets/sfx/nope.mp3"}]}
    sfx, music, notes = _sounds(job, edit, timeline(edit), skip={0})
    assert sfx == [(3.0, job.path("in/uploads/swoosh.wav").resolve())]
    assert music is None
    assert any("assets/sfx/nope.mp3" in n for n in notes) and any("assets/music/nope.mp3" in n for n in notes)
    assert not any("not found" in n or n.startswith(("sfx:", "music:")) for n in notes), notes  # Павел читает это по-русски


def test_sounds_say_when_assets_have_no_sfx(tmp_path, monkeypatch):
    import vm.render as rendering

    sfx = tmp_path / "sfx"
    monkeypatch.setattr(rendering, "SFX", sfx)
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    edit = {"speed": 1.0, "keep": [[0.0, 6.0]], "hook": None, "music": None,
            "inserts": [{"kind": "image", "src": "in/uploads/a.png", "t0": 1.0, "t1": 2.5, "sfx": None}]}
    _, _, notes = rendering._sounds(job, edit, timeline(edit), skip=set())
    assert any("assets/sfx" in n for n in notes), notes
    job.path("in/uploads").mkdir(parents=True)
    ffmpeg("-f", "lavfi", "-i", "sine=f=900:d=0.3", job.path("in/uploads/pop.wav"))
    own = {**edit, "inserts": [{**edit["inserts"][0], "sfx": "in/uploads/pop.wav"}]}
    sounds, _, notes = rendering._sounds(job, own, timeline(own), skip=set())
    assert len(sounds) == 1 and notes == [], "у вставки свой звук — о пустой assets/sfx не говорим"
    sfx.mkdir()
    (sfx / "pop.mp3").write_bytes(b"mp3")
    _, _, notes = rendering._sounds(job, edit, timeline(edit), skip=set())
    assert notes == []
    _, _, notes = rendering._sounds(job, {**edit, "inserts": []}, timeline(edit), skip=set())
    assert notes == []



def test_an_insert_still_waiting_for_its_answer_stops_the_layer(tmp_path, sources):
    from vm.render import draw_layer

    job = make_job(tmp_path, sources["short"], keep=[[0.0, 3.0]],
                   inserts=[{"kind": "image", "question": "insert-1", "t0": 1.0, "t1": 2.0, "x": 70, "y": 500, "w": 250}])
    with pytest.raises(RenderError, match="insert-1"):
        draw_layer(job)
    answered = job.read("edit.json")
    answered["inserts"][0]["src"] = "in/uploads/upload-i1.png"  # ответ пришёл: место и время те же
    job.write("edit.json", answered)
    assert draw_layer(job).boxes


def test_quiet_recording_is_denoised_and_reported(tmp_path, sources, monkeypatch):
    import vm.render as rendering

    job = make_job(tmp_path, sources["short"], keep=[[0.0, 2.0]])
    monkeypatch.setattr(rendering, "loudness", lambda path: -36.4)
    result = render(job, job.path("out"), preset="ultrafast")
    assert result["voice"] == {"lufs": -36.4, "denoise": True}
    monkeypatch.setattr(rendering, "loudness", lambda path: -21.0)
    result = render(job, job.path("out"), preset="ultrafast")
    assert result["voice"] == {"lufs": -21.0, "denoise": False}


# ---------- обложка ----------


def test_cover_is_the_source_frame_with_the_hook_in_big_letters(tmp_path, sources):
    job = make_job(tmp_path, sources["short"], cover={"t": 1.2, "text": "Как я учу чешский"})
    out = job.path("out/final-cover.png")
    report = render_cover(job, job.read("edit.json"), out)
    picture = frame(out, 0)  # PNG читается как один кадр
    assert picture.shape == (1920, 1080, 3)
    b = report["box"]
    assert COVER_ZONE["x0"] <= b["x"] and b["x"] + b["w"] <= COVER_ZONE["x1"] and COVER_ZONE["y0"] <= b["y"] <= b["y"] + b["h"] <= COVER_ZONE["y1"]
    source = frame(job.path("source.mp4"), 1.2).astype(int)
    text = (slice(b["y"], b["y"] + b["h"]), slice(b["x"], b["x"] + b["w"]))
    assert np.abs(picture.astype(int)[text] - source[text]).mean() > 20, "на кадре — текст обложки"
    assert np.abs(picture.astype(int)[1750:1900, 100:1000] - source[1750:1900, 100:1000]).mean() < 12, "ниже — кадр исходника"


# ---------- версия для рекламы ----------


def test_the_ads_version_keeps_every_box_above_the_ad_button(tmp_path, sources):
    from vm.qa import ADS_SAFE, check_layout

    words = [{"t0": 0.5 + 0.4 * i, "t1": 0.8 + 0.4 * i, "text": w} for i, w in enumerate(["это", "мои", "субтитры", "внизу", "кадра"])]
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 4.0]], words=words, ad=True,
                   inserts=[{"kind": "text", "id": "s1", "text": "3 ошибки", "t0": 1.0, "t1": 3.0, "x": 120, "y": 1300, "w": 420,
                             "sfx": None, "params": {}}])
    render(job, job.path("out"), name="final-ad", preset="ultrafast", edit=variant_ad(job.read("edit.json")), work="work/render-ad")
    boxes = json.loads(job.path("work/render-ad/frames/boxes.json").read_text(encoding="utf-8"))
    drawn = [b for e in boxes for k, v in (e.get("boxes") or {}).items() for b in (v if k == "inserts" else [v]) if b]
    assert drawn and all(b["y"] >= ADS_SAFE["y0"] and b["y"] + b["h"] <= ADS_SAFE["y1"] for b in drawn), drawn
    assert not [p for p in check_layout(boxes, None, safe=ADS_SAFE) if "безопасной зоны" in p]
