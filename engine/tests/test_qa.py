"""Проверка качества: геометрия слоя по boxes.json, контрольные кадры и проверки «не отдавать»."""
import shutil
import subprocess

import pytest

from vm.qa import check_layout, check_render, control_frames, face_box

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")

SUB = {"x": 200, "y": 1250, "w": 500, "h": 100}
HOOK = {"x": 150, "y": 330, "w": 600, "h": 160}


def event(t0, t1, **boxes):
    return {"t0": t0, "t1": t1, "boxes": {"inserts": [], **boxes}}


def test_clean_layout_has_no_problems():
    events = [
        event(0, 2, hook=HOOK, sub=SUB),
        event(2, 4, sub=SUB, inserts=[{"x": 60, "y": 900, "w": 200, "h": 200}]),
        event(4, 6),
    ]
    assert check_layout(events, face_box({"x": 0.5, "y": 0.45})) == []


def test_hook_over_face_reported():
    face = face_box({"x": 0.5, "y": 0.2})
    problems = check_layout([event(0, 2, hook=HOOK)], face)
    assert len(problems) == 1 and "хук" in problems[0] and "лиц" in problems[0]


def test_box_outside_safe_zone_reported():
    low = {"x": 200, "y": 1500, "w": 500, "h": 60}  # низ на 1560 > 1530
    wide = {"x": 40, "y": 600, "w": 300, "h": 200}  # левее 60
    problems = check_layout([event(0, 1.5, sub=low), event(1.5, 3, inserts=[wide])], None)
    assert len(problems) == 2
    assert "субтитры" in problems[0] and "безопасн" in problems[0] and "0,0" in problems[0]
    assert "вставка 1" in problems[1] and "безопасн" in problems[1]


def test_insert_over_face_reported():
    face = face_box({"x": 0.5, "y": 0.3})
    near = {"x": face["x"] + face["w"] + 20, "y": face["y"], "w": 150, "h": 200}  # ближе 40 px
    problems = check_layout([event(2, 4, inserts=[near])], face)
    assert len(problems) == 1 and "лиц" in problems[0]
    far = {"x": face["x"] + face["w"] + 45, "y": face["y"], "w": 100, "h": 200}
    assert check_layout([event(2, 4, inserts=[far])], face) == []


def test_insert_too_close_to_subtitles_reported():
    above = {"x": 250, "y": SUB["y"] - 210, "w": 200, "h": 200}  # 10 px над субтитрами
    problems = check_layout([event(1, 2, sub=SUB, inserts=[above])], None)
    assert len(problems) == 1 and "субтитр" in problems[0]
    assert check_layout([event(1, 2, sub=SUB, inserts=[{**above, "y": SUB["y"] - 230}])], None) == []


def test_texts_overlapping_reported():
    problems = check_layout([event(0, 2, hook={**HOOK, "y": 1200}, sub=SUB)], None)
    assert len(problems) == 1 and "пересека" in problems[0]


def test_a_problem_is_reported_once_with_the_first_time():
    low = {"x": 200, "y": 1500, "w": 500, "h": 60}
    events = [event(i, i + 1, sub=low) for i in range(10)]
    problems = check_layout(events, None)
    assert len(problems) == 1 and "0,0" in problems[0] and "10 промежутк" in problems[0]


def test_face_box_defaults_to_a_face_sized_box():
    assert face_box({"x": 0.5, "y": 0.3}) == {"x": 378, "y": 365, "w": 324, "h": 422}
    assert face_box({"x": 0.5, "y": 0.3, "w": 0.2, "h": 0.1}) == {"x": 432, "y": 480, "w": 216, "h": 192}
    assert face_box(None) is None


def make_clip(path, seconds: float, audio_filter: str | None = None):
    audio = f"sine=f=440:r=48000:d={seconds}" + (f",{audio_filter}" if audio_filter else "")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=s=1080x1920:r=30:d={seconds}",
         "-f", "lavfi", "-i", audio, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-shortest", str(path)],
        check=True,
    )
    return path


def edit_for(seconds: float, **fields):
    return {"speed": 1.0, "keep": [[0.0, seconds]], "hold": 0.0, "hook": None, "cta": None, "music": None, **fields}


@needs_ffmpeg
def test_control_sheet_is_2x2(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 4)
    frames = control_frames(final, {"hook": 0.5, "subs": 1.5, "insert": 2.5}, tmp_path / "qa")
    assert set(frames) == {"hook", "subs", "insert", "sheet"}
    for name in ("hook", "subs", "insert"):
        assert frames[name].is_file()
    sheet = frames["sheet"]
    assert sheet.name == "qa.png"
    size = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(sheet)],
                          check=True, capture_output=True, text=True).stdout.strip()
    assert size == "1080,1920"


@needs_ffmpeg
def test_check_render_passes_a_good_final(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 3)
    edit = edit_for(3.0, hook={"text": "Хук", "until": 1.0})
    assert check_render(final, edit, [event(0, 1, hook=HOOK), event(1, 3)]) == []


@needs_ffmpeg
def test_check_render_flags_wrong_duration_and_lost_titles(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 3)
    edit = edit_for(5.0, hook={"text": "Хук", "until": 1.0}, cta={"lines": ["Пиши"], "word": "слово", "t0": 2.0, "t1": 3.0})
    problems = check_render(final, edit, [event(0, 3)])
    assert any("длительност" in p for p in problems)
    assert any("хук" in p.lower() for p in problems)
    assert any("титр" in p.lower() for p in problems)


@needs_ffmpeg
def test_check_render_music_must_start_at_the_first_frame(tmp_path):
    silent_start = make_clip(tmp_path / "late.mp4", 3, "volume='if(lt(t,1),0,1)':eval=frame")
    edit = edit_for(3.0, music={"file": "assets/music/track.mp3", "gainDb": -18})
    assert any("музык" in p for p in check_render(silent_start, edit, [event(0, 3)]))
    from_start = make_clip(tmp_path / "ok.mp4", 3)
    assert check_render(from_start, edit, [event(0, 3)]) == []
