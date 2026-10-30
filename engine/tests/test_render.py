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


def test_render_end_to_end(tmp_path, sources, render_shot):
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
    render_shot("end-to-end", final)
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


def test_version_b_is_rendered_without_the_teaser_beside_version_a(tmp_path, sources, render_shot):
    """A/B-тест: версия B — тот же монтаж без тизера, со своим слоем (work/render-b); слой и ролик A остаются."""
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 4.0]], teaser={"t0": 2.0, "t1": 3.0, "sfx": None}, ab="teaser")
    a = render(job, job.path("out"), preset="ultrafast")
    b = render(job, job.path("out"), name="final-b", preset="ultrafast", edit=variant_b(job.read("edit.json")), work="work/render-b")
    render_shot("ab-teaser-a", job.path("out/final.mp4"))
    render_shot("ab-teaser-b", job.path("out/final-b.mp4"))
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


def test_render_landscape_source_gets_blurred_background(tmp_path, sources, render_shot):
    job = make_job(tmp_path, sources["landscape"], keep=[[0.0, 3.0]])
    result = render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"
    render_shot("landscape", final)
    video = next(s for s in probe(final)["streams"] if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == (1080, 1920)
    top = frame(final, 1.0)[200:400]
    assert top.mean() > 20, "the area above the landscape picture is a blurred copy, not black"
    assert any("размыт" in w for w in result["warnings"])


def test_render_fullscreen_insert_covers_the_frame(tmp_path, sources, render_shot):
    job = make_job(
        tmp_path,
        sources["short"],
        keep=[[0.0, 6.0]],
        inserts=[{"kind": "fullscreen", "src": "in/uploads/upload-i2.png", "t0": 2.0, "t1": 4.0, "sfx": None, "params": {}}],
        words=[{"t0": 2.5, "t1": 3.0, "text": "поверх"}],
    )
    render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"
    render_shot("fullscreen-insert", final)
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


def test_a_late_teaser_does_not_pile_up_frames_in_memory(tmp_path):
    """Тизер звучит первым, а лежит в конце исходника: кадры до него не копятся в памяти, пока склейка ждёт тизер
    (задача 261012-091256-w7eu: тизер на 2:39 — ffmpeg занял 14 ГБ и упал)."""
    source = make_source(tmp_path / "long.mp4", 40)
    keep = [[i * 3.3, i * 3.3 + 2.5] for i in range(12)]
    job = make_job(tmp_path, source, keep=keep, teaser={"t0": 36.4, "t1": 38.2, "sfx": None})
    code = (
        f"import resource, sys; sys.path.insert(0, {str(Path(__file__).parents[1])!r});"
        "from vm.job import Job; from vm.render import render;"
        f"job = Job({str(job.root)!r}); render(job, job.path('out'), preset='ultrafast');"
        "print(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)"
    )
    peak_kb = int(subprocess.run([sys.executable, "-c", code], check=True, capture_output=True, text=True).stdout.split()[-1])
    assert peak_kb < 1_500_000, f"peak child memory {peak_kb / 1024:.0f} MB"


def test_a_piece_moved_to_the_front_does_not_pile_up_frames_in_memory(tmp_path):
    """Кусок из конца исходника поставлен в начало (редактор, «Раньше»): кадры кусков до него не копятся в памяти, пока
    склейка ждёт его (ревью фазы 4: 16 с исходника — 1,1 ГБ, двухминутный ролик — 10–17 ГБ)."""
    source = make_source(tmp_path / "long.mp4", 40)
    keep = [[36.3, 38.8]] + [[i * 3.3, i * 3.3 + 2.5] for i in range(11)]
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


# ---------- стиль эталона ----------

REFERENCE = {
    "font": "forum",
    "hand": "caveat",
    "colors": {"text": "#FFFFFF", "accent": "#EDE4C1", "bar": "#EDE4C1", "plate": "#111111", "outline": "#000000"},
    "subtitles": {"mode": "soft", "words": 3, "size": 64, "y": 1440},
    "hook": {"mode": "accent", "size": 108, "y": 420},
    "bar": {"pos": "bottom", "height": 6},
}


def saturation(rgb: np.ndarray) -> float:
    return float((rgb.max(2).astype(int) - rgb.min(2).astype(int)).mean())


def test_reference_style_end_to_end(tmp_path, sources):
    """Стиль эталона целиком: тонкие субтитры, хук лесенкой, акцент вместо субтитров, ч/б-кусок, резкая смена
    крупности и медленный наезд — в настоящем ролике."""
    said = [(0.5, 0.8, "Я"), (0.9, 1.3, "покупаю"), (1.4, 1.8, "вещи,"), (2.0, 2.4, "чтобы"), (2.5, 2.9, "выглядеть"),
            (3.0, 3.4, "плохо."), (4.0, 4.4, "Это"), (4.5, 4.9, "важно.")]
    job = make_job(
        tmp_path, sources["short"], keep=[[0.0, 6.0]], style=REFERENCE,
        words=[{"t0": a, "t1": b, "text": t} for a, b, t in said],
        hook={"text": "я покупаю вещи", "until": 1.8},
        accents=[{"t0": 2.0, "t1": 3.4, "lines": [{"text": "чтобы выглядеть"}, {"text": "плохо", "size": "big", "color": "accent"}],
                  "x": 480, "y": 900, "anim": "type", "out": "zoom"}],
        looks=[{"t0": 4.0, "t1": 5.0, "look": "bw"}],
        zooms=[{"t": 2.0, "level": 1.25, "over": 0}, {"t": 3.6, "level": 1.0, "over": 0}, {"t": 4.0, "level": 1.2, "over": 1.5}],
    )
    render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"
    corner = (slice(150, 450), slice(80, 380))  # угол без текста
    assert saturation(frame(final, 3.5)[corner]) > 40, "до ч/б-куска — цвет"
    assert saturation(frame(final, 4.5)[corner]) < 8, "ч/б-кусок"
    assert saturation(frame(final, 5.5)[corner]) > 40, "после — снова цвет"
    boxes = json.loads((job.path("work/render/frames/boxes.json")).read_text(encoding="utf-8"))
    def at(t):
        return next(e["boxes"] for e in boxes if e["t0"] <= t < e["t1"])

    during = at(2.8)
    assert during.get("accent") and not during.get("sub"), "акцент вместо субтитров"
    after = at(4.2)
    assert after.get("sub") and not after.get("accent")
    assert at(0.1).get("hook"), "хук с первого кадра"
    # резкая смена крупности: на 2,0 с картинка сразу крупнее (×1,25), без перехода
    before, cut = frame(final, 1.95).astype(int), frame(final, 2.04).astype(int)
    assert abs(before[1500:1800, 100:300] - cut[1500:1800, 100:300]).mean() > 15, "план сменился"


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


# ---------- затемнение фона ----------


def left_person(rgb, state):
    """Подмена модели маски: «человек» — левая половина кадра."""
    mask = np.zeros(rgb.shape[:2], np.uint8)
    mask[:, : rgb.shape[1] // 2] = 255
    return mask, state


@pytest.fixture
def fake_matte(monkeypatch):
    monkeypatch.setattr("vm.matte.unavailable", lambda: None)
    monkeypatch.setattr("vm.matte._rvm", lambda threads=None: left_person)


def halves(picture: np.ndarray) -> tuple[float, float]:
    """Средняя яркость слева и справа, вдали от границы маски и без шкалы внизу."""
    rows = slice(200, 1700)
    return picture[rows, :400].astype(float).mean(), picture[rows, 700:].astype(float).mean()


def test_dim_darkens_the_background_and_keeps_the_person(tmp_path, sources, fake_matte):
    keep = [[0.0, 2.0], [3.0, 5.0]]
    plain = make_job(tmp_path / "a", sources["vertical"], keep=keep)
    dimmed = make_job(tmp_path / "b", sources["vertical"], keep=keep, dim=0.3)
    render(plain, plain.path("out"), preset="ultrafast")
    report = render(dimmed, dimmed.path("out"), preset="ultrafast")
    assert not any("затемнение" in m for m in report["missing"])
    for t in (0.5, 2.5):  # до и после склейки
        (pl, pr), (dl, dr) = halves(frame(plain.path("out/final.mp4"), t)), halves(frame(dimmed.path("out/final.mp4"), t))
        assert abs(dl - pl) < 3, ("человек как был", t, pl, dl)
        assert 0.6 < dr / pr < 0.8, ("фон темнее примерно на 30 %", t, pr, dr)


def frames_in(path) -> int:
    return int(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames",
         "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout)


# границы не на целых секундах (как у настоящей резки): время кадров после склейки «дрожит» на тысячные кадра
ODD = [[19 / 30, 176 / 30], [237 / 30, 401 / 30], [430 / 30, 470 / 30]]


@pytest.mark.parametrize(("keep", "speed", "hold", "teaser"), [
    ([[0.0, 2.0], [3.0, 4.0]], 1.0, 0.0, None), ([[0.0, 2.0], [3.0, 4.0]], 1.1, 0.5, None), (ODD, 1.2, 0.0, None),
    (ODD, 1.2, 0.5, {"t0": 14.4, "t1": 15.6, "sfx": None}),  # как в задаче: тизер из конца и затемнение вместе
])
def test_dim_keeps_every_frame_of_the_video(tmp_path, sources, fake_matte, keep, speed, hold, teaser):
    """С затемнением столько же кадров, сколько без него: последний кадр склейки не теряется, и картинка не
    обрывается раньше звука (задача 261012-091256-w7eu: с затемнением видео кончалось на 1:22 из 2:00)."""
    plain = make_job(tmp_path / "a", sources["vertical"], keep=keep, speed=speed, hold=hold, teaser=teaser)
    dimmed = make_job(tmp_path / "b", sources["vertical"], keep=keep, speed=speed, hold=hold, teaser=teaser, dim=0.3)
    render(plain, plain.path("out"), preset="ultrafast")
    render(dimmed, dimmed.path("out"), preset="ultrafast")
    assert frames_in(dimmed.path("out/final.mp4")) == frames_in(plain.path("out/final.mp4"))


def test_without_the_matting_model_the_video_goes_without_dimming_and_says_so(tmp_path, sources, monkeypatch):
    monkeypatch.setattr("vm.matte.unavailable", lambda: "нет модели rvm_mobilenetv3_fp32.onnx (setup/cloud-setup.sh)")
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 2.0]], dim=0.3)
    report = render(job, job.path("out"), preset="ultrafast")
    assert job.path("out/final.mp4").is_file()
    assert any(m.startswith("затемнение фона: нет модели") for m in report["missing"]), report["missing"]


def test_a_failing_matte_leaves_the_cover_undimmed(tmp_path, sources, monkeypatch):
    def fail(*args, **kwargs):
        raise ValueError("модель сломалась")

    monkeypatch.setattr("vm.matte.unavailable", lambda: None)
    monkeypatch.setattr("vm.matte.frame_matte", fail)
    job = make_job(tmp_path, sources["short"], cover={"t": 1.2, "text": "Как я учу"}, dim=0.3)
    render_cover(job, job.read("edit.json"), job.path("out/c.png"))
    assert job.path("out/c.png").is_file()


def test_the_cover_is_dimmed_like_the_video(tmp_path, sources, fake_matte):
    job = make_job(tmp_path, sources["short"], cover={"t": 1.2, "text": "Как я учу"}, dim=0.3)
    plain = make_job(tmp_path / "plain", sources["short"], cover={"t": 1.2, "text": "Как я учу"})
    render_cover(job, job.read("edit.json"), job.path("out/c.png"))
    render_cover(plain, plain.read("edit.json"), plain.path("out/c.png"))
    below = slice(1750, 1900)  # ниже текста обложки — кадр исходника
    a, b = frame(plain.path("out/c.png"), 0)[below].astype(float), frame(job.path("out/c.png"), 0)[below].astype(float)
    assert abs(a[:, :400].mean() - b[:, :400].mean()) < 3
    assert 0.6 < b[:, 700:].mean() / a[:, 700:].mean() < 0.8


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


def test_transitions_flash_punch_and_smear_the_picture_only_at_their_seams(tmp_path, sources):
    """Вспышка на 1,5 с, толчок зума на 3,0 с, смаз на 4,5 с (финал = исходник): на стыке — белый кадр, тот же кадр
    крупнее в 1,25 раза (якорь — лицо) и смазанный; вне окон ролик как без переходов."""
    cuts = [{"t": 1.5, "kind": "flash", "sfx": None}, {"t": 3.0, "kind": "zoom", "sfx": None}, {"t": 4.5, "kind": "blur", "sfx": None}]
    job = make_job(tmp_path / "a", sources["short"], transitions=cuts)
    plain = make_job(tmp_path / "b", sources["short"])
    result = render(job, job.path("out"), preset="ultrafast")
    render(plain, plain.path("out"), preset="ultrafast")
    assert sum("ближе 3 с" in line for line in result["warnings"]) == 2, result["warnings"]
    a = lambda t: frame(job.path("out/final.mp4"), t).astype(int)[:1800]  # без шкалы внизу
    b = lambda t: frame(plain.path("out/final.mp4"), t).astype(int)[:1800]
    for t in (0.9, 2.4, 3.6, 5.4):
        assert np.abs(a(t) - b(t)).mean() < 3, f"{t} с — вне перехода кадр не тронут"
    assert a(1.5).min() > 225, "вспышка: на стыке белый кадр"
    zoomed, flat = a(3.0), frame(plain.path("out/final.mp4"), 3.0).astype(int)
    x0, y0 = round(0.5 * (1080 - 1080 / 1.25)), round(0.3 * (1920 - 1920 / 1.25))  # окно зума: лицо (0,5; 0,3) на месте
    ys, xs = (y0 + np.arange(1800) / 1.25).astype(int), (x0 + np.arange(1080) / 1.25).astype(int)
    expected = flat[ys][:, xs]
    assert np.abs(zoomed - expected).mean() < 0.5 * np.abs(zoomed - flat[:1800]).mean(), "толчок: кадр ×1,25 у лица"
    sharp = lambda f: float((np.diff(f[300:1200].mean(axis=2), axis=1) ** 2).mean())  # размытие гасит перепады по x
    assert sharp(a(4.5)) < 0.5 * sharp(b(4.5)), "смаз на стыке"


def test_sounds_take_pavels_gains_mutes_and_the_music_place(tmp_path):
    from vm.render import _sounds, timeline

    job = Job(tmp_path / "jobs" / "abc")
    job.path("in/uploads").mkdir(parents=True)
    for name in ("swoosh.wav", "pop.wav", "music.wav"):
        ffmpeg("-f", "lavfi", "-i", "sine=f=900:d=0.3", job.path(f"in/uploads/{name}"))
    edit = {"speed": 1.0, "keep": [[0.0, 6.0]], "hook": None, "hold": 0.0,
            "music": {"file": "in/uploads/music.wav", "gainDb": -18, "at": 1.0, "from": 2.0, "fadeOut": 2.0},
            "inserts": [{"kind": "image", "src": "in/uploads/a.png", "t0": 1.0, "t1": 2.5, "sfx": "in/uploads/swoosh.wav"},
                        {"kind": "image", "src": "in/uploads/a.png", "t0": 3.0, "t1": 4.5, "sfx": "in/uploads/swoosh.wav"}],
            "end": {"seconds": 1.0, "lines": ["Подпишись"], "sfx": "in/uploads/pop.wav"},
            "sounds": {"insert:0": {"gainDb": 5}, "insert:1": {"muted": True}, "end": {"gainDb": -4, "muted": False}}}
    sfx, music, notes = _sounds(job, edit, timeline(edit), skip=set())
    swoosh, pop = job.path("in/uploads/swoosh.wav").resolve(), job.path("in/uploads/pop.wav").resolve()
    assert sfx == [(1.0, swoosh, 5.0), (6.0, pop, -4.0)], "вторая вставка — без звука, у остальных — своя громкость"
    assert music == {"file": str(job.path("in/uploads/music.wav").resolve()), "gainDb": -18, "at": 1.0, "from": 2.0, "fadeOut": 2.0}
    assert notes == []


def test_a_piece_moved_in_the_editor_plays_where_pavel_put_it(tmp_path, sources, render_shot):
    """timeline.json: секунда 4–5 исходника поставлена в начало — ролик той же длины начинается с её кадров, а за ней —
    0–4 и 5–6 по порядку."""
    job = make_job(tmp_path, sources["short"])
    job.write("timeline.json", {"rev": 1, "edits": [{"op": "move", "t0": 4.0, "t1": 5.0, "before": 0.0}]})
    result = render(job, job.path("out"), preset="ultrafast")
    final = job.path("out/final.mp4")
    render_shot("moved-piece", final)
    assert result["durations"]["final"] == pytest.approx(6.0, abs=0.04)

    def source_at(t):
        raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(t), "-i", str(sources["short"]), "-frames:v", "1",
                              "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
        return np.frombuffer(raw, np.uint8).reshape(1920, 1080, 3).astype(int)

    near = lambda a, b: np.abs(a[300:1200] - b[300:1200]).mean() < 12
    assert near(frame(final, 0.1).astype(int), source_at(4.1)), "первый кадр — из куска 4–5"
    assert near(frame(final, 1.1).astype(int), source_at(0.1)), "дальше — начало исходника"
    assert near(frame(final, 5.1).astype(int), source_at(5.1)), "а последним — 5–6"


def test_pavels_hand_edits_from_the_editor_reach_the_video(tmp_path, sources):
    """timeline.json страницы: вырезан кусок 2–3 с исходника, голос без звука — ролик короче на секунду и без голоса."""
    job = make_job(tmp_path, sources["short"])
    job.write("timeline.json", {"rev": 1, "edits": [{"op": "split", "t": 1.0}, {"op": "cut", "t0": 2.0, "t1": 3.0}],
                                "voice": {"muted": True}})
    result = render(job, job.path("out"), preset="ultrafast")
    assert result["durations"]["final"] == pytest.approx(5.0, abs=0.04)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(job.path("out/final.mp4")), "-ac", "1", "-f", "f32le", "-"],
                         check=True, capture_output=True).stdout
    assert float(np.sqrt(np.mean(np.square(np.frombuffer(raw, np.float32))))) < 1e-3, "голос без звука"
    assert job.read("edit.json")["keep"] == [[0.0, 6.0]], "edit.json сессии остался как был"


def test_text_and_inserts_edited_in_the_editor_reach_the_video(tmp_path, sources, render_shot):
    """Фаза 5, timeline.json страницы: хук до 2,0 с и с новым текстом, акцент на секунду позже, стикер дольше и с новым
    текстом, картинка выключена, опечатка исправлена, «эээ» убрано — так и в кадрах слоя (рамки шаблона, события
    движка), и в final.srt. Тот же ролик до правок — как в edit.json сессии, а сам он не меняется."""
    said = [(0.3, 0.7, "Сегодня"), (0.8, 1.2, "эээ"), (1.3, 1.7, "покажу"), (1.8, 2.2, "как"), (2.3, 2.7, "я"),
            (2.8, 3.2, "монтирую"), (3.3, 3.7, "ролики"), (3.8, 4.2, "прямо"), (4.3, 4.7, "на"), (4.8, 5.2, "телефне.")]
    job = make_job(
        tmp_path, sources["short"], style=REFERENCE,
        words=[{"t0": a, "t1": b, "text": t} for a, b, t in said],
        hook={"text": "Как я монтирую", "until": 1.0},
        accents=[{"t0": 2.3, "t1": 3.2, "x": 480, "y": 1000,
                  "lines": [{"text": "я"}, {"text": "монтирую", "size": "big", "color": "accent"}]}],
        inserts=[{"kind": "sticker", "text": "5 минут", "t0": 2.0, "t1": 2.5, "x": 120, "y": 560, "w": 560, "sfx": None, "params": {}},
                 {"kind": "image", "src": "in/uploads/upload-i1.png", "t0": 4.5, "t1": 5.5, "x": 560, "y": 560, "w": 300,
                  "sfx": None, "params": {}}],
    )
    session = job.read("edit.json")

    def drawn() -> tuple[list[dict], list[dict], set[str]]:
        """Что вышло: события слоя (движок), рамки на кадрах (шаблон) и слова final.srt."""
        work = job.path("work/render")
        cues = job.path("out/final.srt").read_text(encoding="utf-8").strip().split("\n\n")
        return (json.loads((work / "events.json").read_text(encoding="utf-8")),
                json.loads((work / "frames/boxes.json").read_text(encoding="utf-8")),
                {w for cue in cues for line in cue.splitlines()[2:] for w in line.split()})

    render(job, job.path("out"), preset="ultrafast")
    render_shot("text-before", job.path("out/final.mp4"))
    events_before, boxes_before, srt_before = drawn()
    hook, sticker = "Монтаж на телефоне", "Весь монтаж — 5 минут на телефоне"
    job.write("timeline.json", {"rev": 1, "edits": [], "text": {
        "hook": {"until": 2.0, "text": hook},
        "accents": [{"at": [2.3, 3.2], "t0": 3.3, "t1": 4.2}],
        "inserts": [{"at": [2.0, 2.5], "t1": 4.2, "text": sticker}, {"at": [4.5, 5.5], "off": True}],
    }, "words": [{"t0": 4.8, "t1": 5.2, "text": "телефоне."}, {"t0": 0.8, "t1": 1.2, "text": ""}]})
    render(job, job.path("out"), preset="ultrafast")
    render_shot("text-after", job.path("out/final.mp4"))
    events_after, boxes_after, srt_after = drawn()

    def shown(boxes, seen) -> list[tuple[float, float]]:
        """Промежутки ролика, где на кадре есть рамка, которую отбирает `seen`."""
        return [(e["t0"], e["t1"]) for e in boxes if seen(e.get("boxes") or {})]

    def first_last(boxes, seen) -> tuple[float, float] | None:
        times = shown(boxes, seen)
        return (min(a for a, _ in times), max(b for _, b in times)) if times else None

    def insert(n):
        return lambda b: any(box.get("n") == n for box in b.get("inserts") or [])

    def texts(events, key) -> set[str]:
        return {e["state"][key]["text"] for e in events if key in e["state"]}

    def inserted(events, n) -> list[dict]:
        return [i for e in events for i in e["state"].get("inserts", []) if i["n"] == n]

    def subtitled(events) -> set[str]:
        return {w for e in events if "sub" in e["state"] for w in e["state"]["sub"]["words"]}

    assert first_last(boxes_before, lambda b: b.get("hook")) == pytest.approx((0.0, 1.0))
    assert first_last(boxes_after, lambda b: b.get("hook")) == pytest.approx((0.0, 2.0)), "хук — до 2,0 с и не дольше"
    assert texts(events_before, "hook") == {"Как я монтирую"} and texts(events_after, "hook") == {hook}

    assert first_last(boxes_before, lambda b: b.get("accent"))[0] == pytest.approx(2.3)
    assert first_last(boxes_after, lambda b: b.get("accent"))[0] == pytest.approx(3.3), "акцент — на секунду позже"
    assert not [s for s in shown(boxes_after, lambda b: b.get("accent")) if s[0] < 3.2 and s[1] > 2.3], "на старом месте его нет"

    assert first_last(boxes_before, insert(0)) == pytest.approx((2.0, 3.5)), "стикер: показ не короче 1,5 с"
    assert first_last(boxes_after, insert(0)) == pytest.approx((2.0, 4.2)), "стикер растянут до 4,2 с"
    assert {i["text"] for i in inserted(events_before, 0)} == {"5 минут"}
    assert {i["text"] for i in inserted(events_after, 0)} == {sticker}
    tall = lambda boxes: max(box["h"] for e in boxes for box in (e.get("boxes") or {}).get("inserts") or [] if box.get("n") == 0)
    assert tall(boxes_after) > tall(boxes_before), "шаблон нарисовал новый текст: длиннее — в две строки"

    assert first_last(boxes_before, insert(1)) == pytest.approx((4.5, 6.0))
    assert not shown(boxes_after, insert(1)) and not inserted(events_after, 1), "выключенной картинки нет"

    for words in (subtitled(events_before), srt_before):
        assert {"телефне.", "эээ"} <= words, "до правок — слова сессии"
    for words in (subtitled(events_after), srt_after):
        assert "телефоне." in words and not {"телефне.", "эээ"} & words, "опечатка исправлена, «эээ» в субтитрах нет"
    assert job.read("edit.json") == session, "edit.json сессии не меняется"


# ---------- перебивки: с места в клипе, окошко лица, звук клипа тихим фоном ----------


def b_roll_clip(path, *, tone: bool = False):
    """Клип перебивки 640×360: 2 с красный, потом 4 с зелёный; `tone` — со звуком 1000 Гц."""
    audio = ["-f", "lavfi", "-i", "sine=f=1000:r=48000:d=6", "-c:a", "aac"] if tone else []
    ffmpeg("-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=2", "-f", "lavfi", "-i", "color=c=lime:s=640x360:r=30:d=4",
           *audio[:4], "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
           *(["-map", "2:a", *audio[4:], "-shortest"] if tone else []), "-c:v", "libx264", "-pix_fmt", "yuv420p", path)
    return path


def test_b_roll_starts_from_its_place_in_the_clip(tmp_path, sources):
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 6.0]])
    b_roll_clip(job.path("in/uploads/upload-b1.mp4"))
    edit = job.read("edit.json")
    edit["inserts"] = [{"kind": "fullscreen", "src": "in/uploads/upload-b1.mp4", "t0": 1.0, "t1": 3.0, "from": 2.5, "sfx": None}]
    job.write("edit.json", edit)
    render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"
    assert close(frame(final, 1.5)[300, 540], (0, 255, 0), tol=40), "с 2,5 с клипа — зелёная часть, а не красное начало"


def test_b_roll_pip_keeps_the_face_in_a_rounded_corner_window(tmp_path, sources, render_shot):
    from vm.broll import PIP

    job = make_job(tmp_path, sources["short"], keep=[[0.0, 6.0]])
    b_roll_clip(job.path("in/uploads/upload-b1.mp4"))
    edit = job.read("edit.json")
    edit["inserts"] = [{"kind": "fullscreen", "src": "in/uploads/upload-b1.mp4", "t0": 1.0, "t1": 4.0, "from": 2.0, "layout": "pip", "sfx": None}]
    job.write("edit.json", edit)
    render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"
    render_shot("b-roll-pip", final)
    shot = frame(final, 2.5)
    lime = (0, 255, 0)
    assert close(shot[1200, 540], lime, tol=40), "клип — на весь кадр"
    inside = shot[PIP["y"] + PIP["h"] // 2, PIP["x"] + PIP["w"] // 2]
    assert not close(inside, lime, tol=60), f"в окошке — кадр говорящего, а не клип: {inside}"
    assert close(shot[PIP["y"] + 2, PIP["x"] + 2], lime, tol=60), "скруглённый угол окошка — прозрачный"
    assert close(frame(final, 5.0)[1200, 540], lime, tol=60) is False, "после окна — снова говорящий"


def test_b_roll_pip_shorter_clip_keeps_the_face_moving_to_the_end_of_its_window(tmp_path, sources):
    """Клип короче окна: клип стоит на последнем кадре, а лицо в окошке идёт до конца окна (как в редакторе) — не замирает."""
    from vm.broll import PIP

    job = make_job(tmp_path, sources["short"], keep=[[0.0, 6.0]])
    ffmpeg("-f", "lavfi", "-i", "color=c=lime:s=640x360:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", job.path("in/uploads/upload-b1.mp4"))
    edit = job.read("edit.json")
    edit["inserts"] = [{"kind": "fullscreen", "src": "in/uploads/upload-b1.mp4", "t0": 1.0, "t1": 4.0, "layout": "pip", "sfx": None}]
    job.write("edit.json", edit)
    render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"
    box = lambda t: frame(final, t)[PIP["y"] + 40:PIP["y"] + PIP["h"] - 40, PIP["x"] + 40:PIP["x"] + PIP["w"] - 40].astype(float)
    talk = lambda t: frame(job.path("source.mp4"), t).astype(float)
    assert np.abs(talk(2.6) - talk(3.6)).mean() > 2, "исходник в эти моменты разный — иначе тест ничего не проверит"
    assert np.abs(box(2.6) - box(3.6)).mean() > 2, "лицо в окошке после конца клипа идёт дальше"
    assert close(frame(final, 3.6)[1200, 540], (0, 255, 0), tol=40), "клип — на последнем кадре до конца окна"


def test_b_roll_sound_plays_quietly_only_in_its_window(tmp_path, sources):
    job = make_job(tmp_path, sources["short"], keep=[[0.0, 6.0]])
    b_roll_clip(job.path("in/uploads/upload-b1.mp4"), tone=True)
    edit = job.read("edit.json")
    edit["inserts"] = [{"kind": "fullscreen", "src": "in/uploads/upload-b1.mp4", "t0": 2.0, "t1": 4.0, "audio": True, "sfx": None}]
    job.write("edit.json", edit)
    render(job, job.path("out"), preset="ultrafast")
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(job.path("out") / "final.mp4"),
                          "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], check=True, capture_output=True).stdout
    audio = np.frombuffer(raw, np.float32)

    def tone(a, b):  # доля 1000 Гц в спектре куска
        x = audio[int(a * 48000):int(b * 48000)]
        spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x))))
        freqs = np.fft.rfftfreq(len(x), 1 / 48000)
        return spectrum[(freqs > 950) & (freqs < 1050)].max() / (spectrum.max() + 1e-12)

    assert tone(2.3, 3.7) > 0.05, "в окне перебивки слышен её фон"
    assert tone(4.5, 5.8) < 0.01, "после окна — нет"


# ---------- рваная бумага и глитч (формат «Разбор персонажа») ----------


def test_the_tear_opens_onto_the_b_roll_in_grey_with_paper_edges_and_the_glitch_shifts_bands(tmp_path, sources):
    from vm import tear
    from vm.transitions import GLITCH, TEAR

    job = make_job(tmp_path, sources["short"], keep=[[0.0, 6.0]])
    ffmpeg("-f", "lavfi", "-i", "color=c=blue:s=640x360", "-frames:v", "1", job.path("in/uploads/upload-b1.png"))
    edit = job.read("edit.json")
    edit["inserts"] = [{"kind": "fullscreen", "src": "in/uploads/upload-b1.png", "t0": 2.0, "t1": 3.0, "sfx": None}]
    edit["transitions"] = [{"t": 2.0, "kind": "tear", "sfx": None}, {"t": 4.5, "kind": "glitch", "sfx": None}]
    job.write("edit.json", edit)
    render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"
    slit, edge = tear.frame(TEAR - 1)
    last = frame(final, (60 - 1) / 30)  # последний кадр разрыва: стык — кадр 60
    ys, xs = np.nonzero(slit[900:1000])
    inside = last[900 + ys[len(ys) // 2], xs[len(xs) // 2]].astype(int)
    assert inside.max() - inside.min() < 25, f"в щели — перебивка в ч/б, а не синяя: {inside}"
    # серый — как у CSS grayscale(1) в редакторе: яркость по BT.709 (синий — 0,0722 · 255 ≈ 18; по BT.601 вышло бы 29);
    # растр затемняет часть точек — берём светлую середину между ними
    gray = np.sort(last[900:1000, 520:560].astype(int).mean(axis=2).ravel())[-200:].mean()
    assert abs(gray - 0.0722 * 255) < 6, f"серый в щели — по BT.709: {gray:.1f}"
    paper = np.nonzero(edge[960, :, 3] == 255)[0]
    assert close(last[960, paper[len(paper) // 2]], tear.PAPER, tol=30), "края — белая бумага"
    talking = lambda t, y, x: tuple(int(c) for c in frame(job.path("source.mp4"), t)[y, x])
    assert close(last[960, 20], talking((60 - 1) / 30, 960, 20), tol=30), "вдали от щели — говорящий"
    assert close(frame(final, 2.5)[960, 540], (0, 0, 255), tol=40), "после разрыва — перебивка в цвете"
    at = (60 - TEAR - 1) / 30
    assert close(frame(final, at)[960, 540], talking(at, 960, 540), tol=30), "до окна — без разрыва"
    # кадр в кадр: на первом кадре окна — кадр 0 щели (у кадра 1 щель шире и закрыла бы это место бумаги)
    slit0, edge0 = tear.frame(0)
    inner = np.nonzero(slit0[960])[0].min() - 1  # бумага вплотную к трещине
    assert edge0[960, inner, 3] == 255 and tear.frame(1)[0][960, inner] == 255
    # яркость: цвет у края в 1 px размывает 4:2:0, а серая перебивка (синяя в ч/б) — тёмная
    assert frame(final, (60 - TEAR) / 30)[960, inner].astype(int).mean() > 200, "первый кадр окна — кадр 0 разрыва"
    # глитч: на стыке полоса кадра — копия со сдвигом
    join = round(4.5 * 30)
    y0, y1, dx = GLITCH[1][1]
    row = (y0 + y1) // 2
    shifted, plain = frame(final, join / 30)[row].astype(int), frame(job.path("source.mp4"), join / 30)[row].astype(int)
    assert np.abs(shifted[200 + dx : 800 + dx] - plain[200:800]).mean() < np.abs(shifted[200:800] - plain[200:800]).mean()


def test_b_roll_in_a_window_plays_over_the_talking_head_in_a_rounded_corner(tmp_path, sources):
    from vm.broll import WINDOW

    job = make_job(tmp_path, sources["short"], keep=[[0.0, 6.0]])
    b_roll_clip(job.path("in/uploads/upload-b1.mp4"))
    edit = job.read("edit.json")
    edit["inserts"] = [{"kind": "fullscreen", "src": "in/uploads/upload-b1.mp4", "t0": 1.0, "t1": 3.0, "layout": "window", "sfx": None}]
    edit["transitions"] = [{"t": 1.0, "kind": "tear", "sfx": None}]  # в окошко разрыв не ведёт
    job.write("edit.json", edit)
    render(job, job.path("out"), preset="ultrafast")
    final = job.path("out") / "final.mp4"
    shot, talk = frame(final, 1.5), frame(job.path("source.mp4"), 1.5)
    red = (255, 0, 0)
    assert close(shot[WINDOW["y"] + WINDOW["h"] // 2, WINDOW["x"] + WINDOW["w"] // 2], red, tol=40), "в окошке — клип"
    assert close(shot[1200, 700], tuple(int(c) for c in talk[1200, 700]), tol=30), "вне окошка — говорящий"
    corner = shot[WINDOW["y"] + 2, WINDOW["x"] + 2]
    assert close(corner, tuple(int(c) for c in talk[WINDOW["y"] + 2, WINDOW["x"] + 2]), tol=40), "скруглённый угол — прозрачный"
    gap = frame(final, (30 - 4) / 30)[960, 540]
    assert close(gap, tuple(int(c) for c in frame(job.path("source.mp4"), (30 - 4) / 30)[960, 540]), tol=40), "разрыва нет"
