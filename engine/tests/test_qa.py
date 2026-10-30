"""Проверка качества: геометрия слоя по boxes.json, контрольные кадры и проверки «не отдавать»."""
import shutil
import subprocess
from itertools import pairwise

import pytest

from vm.qa import (
    check_layout,
    check_render,
    checklist,
    control_frames,
    face_box,
)

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
    low = {"x": 200, "y": 1800, "w": 500, "h": 60}  # низ на 1860: ниже, чем субтитрам можно (1820)
    wide = {"x": 40, "y": 600, "w": 300, "h": 200, "n": 0}  # левее 60
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
    low = {"x": 200, "y": 1800, "w": 500, "h": 60}
    events = [event(i, i + 1, sub=low) for i in range(10)]
    assert check_layout(events, None) == ["субтитры вне безопасной зоны (0,0–10,0 с ролика)"]


ACCENT = {"x": 150, "y": 1000, "w": 600, "h": 220}


def test_accent_is_checked_like_the_hook():
    face = face_box({"x": 0.5, "y": 0.55})  # лицо низко — на акценте
    problems = check_layout([event(3, 5, accent=ACCENT)], face)
    assert problems == ["акцент на лице или ближе 40 px к нему (3,0–5,0 с ролика)"]
    assert check_layout([event(3, 5, accent=ACCENT)], face_box({"x": 0.5, "y": 0.25})) == []
    out = check_layout([event(3, 5, accent={**ACCENT, "y": 1400})], None)
    assert out == ["акцент вне безопасной зоны (3,0–5,0 с ролика)"]


def test_accent_during_the_hook_is_reported():
    problems = check_layout([event(0, 1, hook=HOOK, accent=ACCENT)], None)
    assert problems == ["акцент во время хука (0,0–1,0 с ролика)"]


def test_the_face_grows_with_the_zoom():
    face = face_box({"x": 0.5, "y": 0.3})  # 378..702 × 365..787
    beside = {"x": face["x"] + face["w"] + 60, "y": 500, "w": 120, "h": 120}  # 60 px справа от лица
    assert check_layout([event(1, 2, accent=beside)], face) == []
    zoomed = check_layout([event(1, 2, accent=beside)], face, zoom=lambda t: 1.3)
    assert zoomed == ["акцент на лице или ближе 40 px к нему (1,0–2,0 с ролика)"], "при ×1,3 лицо шире на ~50 px с каждой стороны"
    growing = check_layout([event(1, 2, accent=beside)], face, zoom=lambda t: 1.0 if t < 1.9 else 1.3)
    assert growing, "наезд внутри промежутка: берётся самый крупный план"


def test_face_box_defaults_to_a_face_sized_box():
    assert face_box({"x": 0.5, "y": 0.3}) == {"x": 378, "y": 365, "w": 324, "h": 422}
    assert face_box({"x": 0.5, "y": 0.3, "w": 0.2, "h": 0.1}) == {"x": 432, "y": 480, "w": 216, "h": 192}
    assert face_box(None) is None


def make_clip(path, seconds: float, audio_filter: str | None = None, final: bool = False):
    """Ролик 1080×1920, 30 к/с, H.264 + AAC; `final` — как у финала: стерео, без B-кадров и edit lists."""
    audio = f"sine=f=440:r=48000:d={seconds}" + (f",{audio_filter}" if audio_filter else "")
    like_final = ["-ac", "2", "-bf", "0", "-use_editlist", "0"] if final else []
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=s=1080x1920:r=30:d={seconds}",
         "-f", "lavfi", "-i", audio, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", *like_final, "-shortest", str(path)],
        check=True,
    )
    return path


def edit_for(seconds: float, **fields):
    return {"speed": 1.0, "keep": [[0.0, seconds]], "hold": 0.0, "hook": None, "cta": None, "music": None, **fields}


@needs_ffmpeg
def test_control_sheet_is_3x2(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 4)
    frames = control_frames(final, {"hook": 0.5, "subs": 1.5, "accent": 2.0, "insert": 2.5}, tmp_path / "qa")
    assert set(frames) == {"hook", "subs", "accent", "insert", "sheet"}
    for name in ("hook", "subs", "accent", "insert"):
        assert frames[name].is_file()
    sheet = frames["sheet"]
    assert sheet.name == "qa.png"
    size = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(sheet)],
                          check=True, capture_output=True, text=True).stdout.strip()
    assert size == "1620,1920"


@needs_ffmpeg
def test_check_render_passes_a_good_final(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 3)
    edit = edit_for(3.0, hook={"text": "Хук", "until": 1.0})
    assert check_render(final, edit, [event(0, 1, hook=HOOK), event(1, 3)], report(3.0)) == []


@needs_ffmpeg
def test_check_render_flags_wrong_duration_and_lost_titles(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 3)
    edit = edit_for(5.0, hook={"text": "Хук", "until": 1.0}, cta={"lines": ["Пиши"], "word": "слово", "t0": 2.0, "t1": 3.0})
    problems = check_render(final, edit, [event(0, 3)], report(5.0))
    assert any("длительност" in p for p in problems)
    assert any("хук" in p.lower() for p in problems)
    assert any("титр" in p.lower() for p in problems)


# ---------- исправления после ревью ----------

INSERTS = [
    {"kind": "badge", "text": "Лайфхак", "t0": 2.0, "t1": 4.0, "x": 60, "y": 600, "w": 300},
    {"kind": "image", "src": "in/uploads/upload-i1.png", "t0": 4.0, "t1": 6.0, "x": 60, "y": 600, "w": 300},
    {"kind": "sticker", "title": "Второй", "t0": 2.0, "t1": 4.0, "x": 60, "y": 900, "w": 300},
    {"kind": "badge", "text": "Третий", "t0": 2.0, "t1": 4.0, "x": 60, "y": 1200, "w": 300},
]


def test_insert_problems_name_the_insert_from_edit():
    wide = {"x": 40, "y": 600, "w": 300, "h": 200}  # левее 60
    events = [event(2, 3, inserts=[{**wide, "n": 3}, {**wide, "y": 900, "n": 2}])]
    problems = check_layout(events, None, INSERTS)
    assert len(problems) == 2
    assert any(p.startswith("вставка 4 «Третий» вне безопасной зоны") for p in problems), problems
    assert any(p.startswith("вставка 3 «Второй» вне безопасной зоны") for p in problems), problems
    image = check_layout([event(4, 5, inserts=[{**wide, "n": 1}])], None, INSERTS)
    assert image[0].startswith("вставка 2 «upload-i1.png»"), image


def test_problem_time_is_the_whole_run_and_runs_are_counted():
    low = {"x": 200, "y": 1500, "w": 500, "h": 60}
    cuts = [0.0, 0.3, 0.8, 1.2, 1.7, 2.3]  # хук один, промежутки режут слова субтитров
    events = [event(a, b, hook=low) for a, b in pairwise(cuts)]
    assert check_layout(events, None) == ["хук вне безопасной зоны (0,0–2,3 с ролика)"]
    twice = [*events, event(2.3, 4.0), event(4.0, 5.1, hook=low)]
    assert check_layout(twice, None) == ["хук вне безопасной зоны (0,0–2,3 с ролика; таких мест: 2)"]


def test_insert_over_the_code_word_reported():
    cta = {"x": 150, "y": 1000, "w": 600, "h": 200}
    over = {"x": 300, "y": 1050, "w": 200, "h": 200, "n": 0}
    problems = check_layout([event(5, 6, cta=cta, inserts=[over])], None, INSERTS)
    assert problems == ["вставка 1 «Лайфхак» закрывает титр (5,0–6,0 с ролика)"]


def report(final_seconds, missing=(), music=None):
    return {"durations": {"source": 10.0, "final": final_seconds}, "missing": list(missing), "warnings": [], "music": music}


@needs_ffmpeg
def test_check_render_takes_the_duration_render_built(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 3)
    edit = edit_for(5.0)  # keep за концом исходника: render обрезал до 3 с и предупредил
    assert check_render(final, edit, [event(0, 3)], report(3.0)) == []
    assert any("длительност" in p for p in check_render(final, edit, [event(0, 3)], report(5.0)))


@needs_ffmpeg
def test_check_render_flags_music_that_did_not_make_it(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 3)  # голос есть
    edit = edit_for(3.0, music={"file": "assets/music/track.mp3", "gainDb": -18})
    note = "нет музыки assets/music/track.mp3 — ролик без неё"
    problems = check_render(final, edit, [event(0, 3)], report(3.0, missing=[note]))
    assert any("музык" in p and "track.mp3" in p for p in problems), problems


@needs_ffmpeg
def test_check_render_flags_music_that_starts_with_silence(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 3)  # голос с первого кадра заглушил бы проверку по миксу
    late = tmp_path / "late.wav"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    "sine=f=220:d=3,volume='if(lt(t,1),0,1)':eval=frame", str(late)], check=True)
    edit = edit_for(3.0, music={"file": "assets/music/late.wav", "gainDb": -18})
    problems = check_render(final, edit, [event(0, 3)], report(3.0, music=str(late)))
    assert any("музык" in p and "тишин" in p for p in problems), problems
    good = tmp_path / "good.wav"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:d=3", str(good)],
                   check=True)
    assert check_render(final, edit, [event(0, 3)], report(3.0, music=str(good))) == []


@needs_ffmpeg
def test_control_frames_do_not_keep_frames_from_an_earlier_call(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 4)
    control_frames(final, {"hook": 0.5, "insert": 2.5}, tmp_path / "qa")
    frames = control_frames(final, {"hook": 0.5}, tmp_path / "qa")
    assert sorted(p.name for p in (tmp_path / "qa").iterdir()) == ["qa-hook.png", "qa.png"]
    assert set(frames) == {"hook", "sheet"}


def test_slot_times_skip_intervals_shorter_than_a_tenth():
    from vm.qa import slot_times

    events = [
        event(0.0, 2.0, hook=HOOK, sub=SUB),
        event(2.0, 2.033, sub=SUB, cta={"x": 150, "y": 900, "w": 600, "h": 200}),  # старый субтитр ещё на кадр
        event(2.033, 3.0, sub={**SUB, "y": 1260}, cta={"x": 150, "y": 900, "w": 600, "h": 200}),
    ]
    times = slot_times(events)
    assert times["cta"] == pytest.approx((2.033 + 3.0) / 2)
    assert times["hook"] == pytest.approx(1.0) and times["subs"] == pytest.approx(1.0)



# ---------- финальная карточка ----------


def test_end_card_must_stay_in_the_safe_zone_but_may_cover_the_face():
    face = face_box({"x": 0.5, "y": 0.4})
    inside = {"x": 200, "y": 600, "w": 550, "h": 500}
    assert check_layout([event(5, 7, end=inside)], face) == [], "карточка на затемнённом кадре — лицо закрывать можно"
    problems = check_layout([event(5, 7, end={**inside, "y": 1200, "h": 400})], face)
    assert problems == ["финальная карточка вне безопасной зоны (5,0–7,0 с ролика)"]


@needs_ffmpeg
def test_check_render_flags_a_lost_end_card(tmp_path):
    final = make_clip(tmp_path / "final.mp4", 3)
    edit = edit_for(3.0, end={"seconds": 1.0, "lines": ["Подпишись"]})
    assert any("финальная карточка" in p for p in check_render(final, edit, [event(0, 3)], report(3.0)))
    assert check_render(final, edit, [event(0, 2), event(2, 3, end={"x": 200, "y": 600, "w": 550, "h": 500})], report(3.0)) == []


# ---------- чек-лист по гайду (экран «Готово») ----------

END = {"x": 140, "y": 500, "w": 660, "h": 600}


@needs_ffmpeg
def test_checklist_ticks_what_the_guide_asks_for(tmp_path):
    good = make_clip(tmp_path / "good.mp4", 3, final=True)
    boxes = [event(0, 1, hook=HOOK, sub=SUB), event(1, 2, sub=SUB), event(2, 3, end=END)]
    items = checklist(good, boxes, report(3.0))
    assert [i["id"] for i in items] == ["format", "container", "audio", "hook", "safe", "subtitles", "end", "length"]
    assert all(i["ok"] and i["title"] for i in items), items


@needs_ffmpeg
def test_checklist_marks_what_is_missing(tmp_path):
    plain = make_clip(tmp_path / "plain.mp4", 3)  # моно, с edit lists
    late = [event(0, 1.5, sub=SUB), event(1.5, 3, hook={**HOOK, "x": 20})]  # хук поздно и за краем безопасной зоны
    marks = {i["id"]: i["ok"] for i in checklist(plain, late, report(95.0))}
    assert marks == {"format": True, "container": False, "audio": False, "hook": False, "safe": False, "subtitles": True,
                     "end": False, "length": False}


def test_the_ads_zone_is_lower_at_the_bottom_and_top():
    from vm.qa import ADS_SAFE

    low = [event(0, 1, sub={"x": 200, "y": 1180, "w": 500, "h": 100})]  # низ субтитров — 1280: под кнопкой рекламы
    assert check_layout(low, None) == []
    assert any("субтитры вне безопасной зоны" in p for p in check_layout(low, None, safe=ADS_SAFE))


def test_subtitles_may_go_down_to_just_above_the_time_bar_but_other_text_may_not():
    sub = {"x": 200, "y": 1700, "w": 500, "h": 110}  # низ на 1810: под подписью Reels, но над шкалой — выбор Павла
    assert check_layout([event(0, 2, sub=sub)], None) == []
    assert any("субтитры вне безопасной зоны" in p for p in check_layout([event(0, 2, sub={**sub, "y": 1740})], None))
    assert any("хук вне безопасной зоны" in p for p in check_layout([event(0, 2, hook={**HOOK, "y": 1500})], None))


def test_the_face_box_grows_with_the_zoom_around_the_face():
    face = {"x": 0.5, "y": 0.3}
    assert face_box(face, zoom=1.16) == {"x": 352, "y": 331, "w": 376, "h": 490}
    assert face_box(face, zoom=1.0) == face_box(face)




def test_a_b_roll_caption_is_checked_like_subtitles_but_not_against_the_face():
    face = face_box({"x": 0.5, "y": 0.75})  # лица говорящего на перебивке не видно — подпись на его месте не беда
    caption = {"x": 200, "y": 1380, "w": 600, "h": 120}
    assert check_layout([event(2, 3, caption=caption)], face) == []
    low = {**caption, "y": 1760}  # низ на 1880 — ниже, чем субтитрам можно
    picture = {"x": 300, "y": 1300, "w": 300, "h": 200, "n": 0}
    problems = check_layout([event(2, 3, caption=low), event(3, 4, caption=caption, inserts=[picture])], None)
    assert problems == ["подпись перебивки вне безопасной зоны (2,0–3,0 с ролика)",
                        "вставка 1 закрывает подпись перебивки (3,0–4,0 с ролика)"]


def test_subtitles_raised_above_the_head_are_checked_against_the_face():
    face = face_box({"x": 0.5, "y": 0.35})  # лицо ~ 461..883 по высоте
    chest = {"x": 200, "y": 1250, "w": 600, "h": 90}
    assert check_layout([event(1, 2, sub=chest)], face) == [], "на груди — как всегда, лицо не проверяется"
    above = {"x": 200, "y": 330, "w": 600, "h": 90}  # низ на 420: 41 px над лицом
    assert check_layout([event(1, 2, sub=above)], face) == []
    low = {**above, "y": 360}  # низ на 450 — ближе 40 px к лицу
    assert check_layout([event(1, 2, sub=low)], face) == ["субтитры на лице или ближе 40 px к нему (1,0–2,0 с ролика)"]
