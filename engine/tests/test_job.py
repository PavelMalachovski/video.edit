"""Папка задачи: чтение/запись JSON со схемами, статус, CLI `status`."""
import copy
import json
import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from vm.__main__ import main
from vm.job import Job, set_status

ENGINE_DIR = Path(__file__).resolve().parents[1]
SCHEMAS_DIR = ENGINE_DIR / "vm" / "schemas"

GOOD_STATUS = {
    "state": "analyzing",
    "phase": "Расшифровываю",
    "message": "Слушаю речь",
    "at": "2026-10-10T10:00:00Z",
    "progress": 0.4,
}


def make_style():
    """Валидная спецификация стиля (близко к стилю A)."""
    return {
        "font": "montserrat",
        "hand": "caveat",
        "colors": {
            "text": "#FFFFFF",
            "accent": "#FFD23F",
            "bar": "#FFD23F",
            "plate": "#000000",
            "outline": "#000000",
        },
        "subtitles": {"mode": "karaoke", "words": 3, "size": 64, "y": 1300},
        "hook": {"mode": "plate", "size": 72},
        "bar": {"pos": "bottom", "height": 14},
    }


def make_edit():
    return {
        "speed": 1.1,
        "keep": [[0.0, 4.5], [5.2, 9.0]],
        "words": [{"t0": 0.2, "t1": 0.6, "text": "Привет"}],
        "hook": {"text": "Как я монтирую", "until": 2.5},
        "cta": {"lines": ["Пишите мне слово"], "word": "монтаж", "t0": 6.0, "t1": 8.0},
        "inserts": [
            {
                "kind": "image",
                "src": "assets/logos/a.png",
                "t0": 3.0,
                "t1": 5.0,
                "x": 100,
                "y": 200,
                "w": 300,
                "sfx": None,
                "params": {},
            }
        ],
        "zooms": [{"t": 1.0, "level": 1.05}],
        "face": {"x": 0.5, "y": 0.3},
        "music": None,
        "hold": 0.5,
        "style": make_style(),
    }


def make_styles():
    return {
        "frame": "frame.png",
        "frameTime": 12.5,
        "sample": {"hook": "Как я монтирую", "words": ["вот", "так", "это"], "spoken": 1},
        "variants": [{"id": i, "label": f"Вариант {i}", "spec": make_style()} for i in "ABC"],
    }


@pytest.fixture
def job(tmp_path):
    return Job(tmp_path / "jobs" / "abc")


# --- Job: папка, чтение, запись ---------------------------------------------------


def test_job_id_and_path(job):
    assert job.id == "abc"
    assert job.path("out/final.mp4") == job.root / "out" / "final.mp4"


def test_write_valid_status_roundtrip(job):
    job.write("status.json", GOOD_STATUS)
    assert job.read("status.json") == GOOD_STATUS
    # русский текст лежит в файле как есть, а не как \uXXXX
    assert "Расшифровываю" in job.path("status.json").read_text(encoding="utf-8")


def test_write_invalid_raises_with_field_path(job):
    bad = {k: v for k, v in GOOD_STATUS.items() if k != "state"}
    with pytest.raises(ValueError, match="state"):
        job.write("status.json", bad)
    assert not job.path("status.json").exists()


def test_error_message_names_nested_field_path(job):
    edit = make_edit()
    edit["style"]["subtitles"]["words"] = 9
    edit["inserts"][0]["kind"] = "gif"
    with pytest.raises(ValueError) as exc:
        job.write("edit.json", edit)
    text = str(exc.value)
    assert "edit.json" in text
    assert "style.subtitles.words" in text
    assert "inserts[0].kind" in text  # все ошибки сразу, а не по одной


def test_error_message_stays_short_and_keeps_the_reason(job):
    # значение (целый вариант стиля) длинное — в сообщении оно не должно вытеснить причину
    styles = make_styles()
    styles["variants"] = styles["variants"][:2]
    with pytest.raises(ValueError) as exc:
        job.write("styles.json", styles)
    text = str(exc.value)
    assert "variants: expected at least 3 items, got 2" in text
    assert len(text) < 200

    status = {**GOOD_STATUS, "message": 5, "phase": ["x" * 500]}
    with pytest.raises(ValueError) as exc:
        job.write("status.json", status)
    assert "phase: <list of 1> is not of type 'string'" in str(exc.value)
    assert len(str(exc.value)) < 300


def test_invalid_write_keeps_previous_file(job):
    job.write("status.json", GOOD_STATUS)
    before = job.path("status.json").read_bytes()
    with pytest.raises(ValueError):
        job.write("status.json", {**GOOD_STATUS, "state": "bogus"})
    assert job.path("status.json").read_bytes() == before


def test_write_is_atomic(job, monkeypatch):
    calls = []
    real_replace = os.replace

    def spy(src, dst):
        calls.append((Path(src), Path(dst)))
        real_replace(src, dst)

    monkeypatch.setattr(os, "replace", spy)
    job.write("status.json", GOOD_STATUS)

    assert len(calls) == 1  # tmp -> rename
    tmp, final = calls[0]
    assert tmp.suffix == ".tmp" and final == job.path("status.json")
    # после записи нет ни *.tmp, ни других лишних файлов (включая скрытые)
    assert sorted(p.name for p in job.root.iterdir()) == ["status.json"]


def test_failed_rename_keeps_old_file_and_cleans_tmp(job, monkeypatch):
    job.write("status.json", GOOD_STATUS)
    before = job.path("status.json").read_bytes()

    def boom(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        job.write("status.json", {**GOOD_STATUS, "phase": "Другая фаза"})

    assert job.path("status.json").read_bytes() == before
    assert sorted(p.name for p in job.root.iterdir()) == ["status.json"]


def test_files_without_schema_are_written_unchecked(job):
    job.write("words.json", [{"t0": 0, "t1": 1, "text": "а"}])
    job.write("cuts.json", {"keep": [[0, 1]]})
    job.write("job.json", {"anything": "goes", "n": 1})
    assert job.read("words.json") == [{"t0": 0, "t1": 1, "text": "а"}]
    assert job.read("cuts.json") == {"keep": [[0, 1]]}
    assert job.read("job.json") == {"anything": "goes", "n": 1}


def test_write_validates_what_lands_in_the_file(job):
    # кортежи (их отдаёт plan_keep) в файле — списки; проверяется именно записанное
    edit = make_edit()
    edit["keep"] = [(0.0, 4.5), (5.2, 9.0)]
    job.write("edit.json", edit)
    assert job.read("edit.json")["keep"] == [[0.0, 4.5], [5.2, 9.0]]
    with pytest.raises(ValueError):  # NaN в JSON не бывает
        job.write("edit.json", {**make_edit(), "speed": float("nan")})


def test_schema_files_are_valid_draft_2020_12():
    files = {p.stem: p for p in SCHEMAS_DIR.glob("*.json")}
    assert {"status", "questions", "answers", "styles", "edit", "result"} <= set(files)
    for path in files.values():
        Draft202012Validator.check_schema(json.loads(path.read_text(encoding="utf-8")))


# --- status -----------------------------------------------------------------------


def test_set_status_adds_iso_at(job):
    before = datetime.now(UTC).replace(microsecond=0)
    status = set_status(job, state="analyzing", phase="Расшифровываю", message="Слушаю речь")
    after = datetime.now(UTC)

    at = datetime.fromisoformat(status["at"])
    assert at.utcoffset() == timedelta(0)  # UTC, с часовым поясом
    assert before <= at <= after
    assert job.read("status.json") == status


def test_set_status_optional_fields(job):
    status = set_status(
        job,
        state="waiting_answers",
        phase="Жду ответов",
        message="Ответьте на вопросы",
        needs="answers",
        progress=0,
    )
    assert status["needs"] == "answers"
    assert status["progress"] == 0  # ноль не теряется как «пусто»
    assert "error" not in status

    status = set_status(job, state="error", phase="Монтирую", message="Сбой", error="ffmpeg упал")
    assert status["error"] == "ffmpeg упал"
    assert "needs" not in status and "progress" not in status


def test_set_status_rejects_unknown_state_and_needs(job):
    with pytest.raises(ValueError, match="state"):
        set_status(job, state="done", phase="p", message="m")  # в схеме «rendered»
    with pytest.raises(ValueError, match="needs"):
        set_status(job, state="analyzing", phase="p", message="m", needs="coffee")
    with pytest.raises(ValueError, match="progress"):
        set_status(job, state="analyzing", phase="p", message="m", progress=40)
    assert not job.path("status.json").exists()


def test_status_states_from_the_brief(job):
    for state in ("uploading", "queued", "analyzing", "waiting_answers", "rendering", "rendered", "error"):
        set_status(job, state=state, phase="p", message="m")


# --- схемы: styles ----------------------------------------------------------------


def test_styles_requires_three_variants(job):
    styles = make_styles()
    job.write("styles.json", styles)
    assert job.read("styles.json") == styles

    two = make_styles()
    two["variants"] = two["variants"][:2]
    with pytest.raises(ValueError, match="variants"):
        job.write("styles.json", two)

    four = make_styles()
    four["variants"].append({"id": "A", "label": "ещё", "spec": make_style()})
    with pytest.raises(ValueError, match="variants"):
        job.write("styles.json", four)


def test_styles_accepts_empty_sample_words_for_a_silent_clip(job):
    # у ролика без речи слов для превью нет, но styles.json писать всё равно надо
    styles = make_styles()
    styles["sample"] = {"words": [], "spoken": 0}
    job.write("styles.json", styles)
    assert job.read("styles.json") == styles


def test_styles_take_the_fonts_that_have_every_letter(job):
    styles = make_styles()
    styles["fonts"] = {"main": ["montserrat", "comfortaa"], "hand": ["bad-script"]}  # вывод vm fonts
    job.write("styles.json", styles)
    assert job.read("styles.json") == styles
    for bad in ({"main": ["montserrat"]}, {"main": "montserrat", "hand": []}, {"main": ["montserrat"], "hand": [""]}):
        with pytest.raises(ValueError, match="fonts"):
            job.write("styles.json", {**styles, "fonts": bad})


def test_style_hook_y_is_optional_and_stays_in_the_frame(job):
    # высота хука (центр строки капсом) — часть стиля: хук не должен лечь на лицо
    styles = make_styles()
    styles["variants"][0]["spec"]["hook"]["y"] = 420
    job.write("styles.json", styles)
    assert job.read("styles.json")["variants"][0]["spec"]["hook"]["y"] == 420

    styles["variants"][0]["spec"]["hook"]["y"] = 2000
    with pytest.raises(ValueError, match=r"variants\[0\]\.spec\.hook\.y"):
        job.write("styles.json", styles)


def test_styles_variant_ids_are_a_b_c(job):
    styles = make_styles()
    styles["variants"][1]["id"] = "D"
    with pytest.raises(ValueError, match=r"variants\[1\]\.id"):
        job.write("styles.json", styles)

    dup = make_styles()
    dup["variants"][2]["id"] = "A"
    with pytest.raises(ValueError, match=r"variants\[2\]\.id"):
        job.write("styles.json", dup)


def test_styles_requires_frame_sample_and_specs(job):
    for field in ("frame", "frameTime", "sample", "variants"):
        styles = make_styles()
        del styles[field]
        with pytest.raises(ValueError, match=field):
            job.write("styles.json", styles)

    styles = make_styles()
    del styles["sample"]["spoken"]
    with pytest.raises(ValueError, match=r"sample\.spoken"):
        job.write("styles.json", styles)

    styles = make_styles()
    styles["variants"][0]["spec"]["subtitles"]["mode"] = "typewriter"
    with pytest.raises(ValueError, match=r"variants\[0\]\.spec\.subtitles\.mode"):
        job.write("styles.json", styles)


# --- схемы: edit и StyleSpec ------------------------------------------------------


def test_edit_valid_roundtrip(job):
    edit = make_edit()
    job.write("edit.json", edit)
    assert job.read("edit.json") == edit


def test_edit_rejects_unknown_subtitle_mode(job):
    edit = make_edit()
    edit["style"]["subtitles"]["mode"] = "typewriter"
    with pytest.raises(ValueError, match=r"style\.subtitles\.mode"):
        job.write("edit.json", edit)

    for mode in ("karaoke", "plate", "word", "accumulate"):
        edit["style"]["subtitles"]["mode"] = mode
        job.write("edit.json", edit)


def test_edit_accepts_insert_title_and_face_box(job):
    # решения контроллера: у вставки есть необязательный title; face может быть рамкой
    edit = make_edit()
    edit["inserts"] += [
        {"kind": "sticker", "title": "Важно", "text": "Не забудь", "t0": 5.0, "t1": 7.0},
        {"kind": "badge", "text": "Новое", "t0": 7.0, "t1": 9.0, "sfx": "assets/sfx/pop.mp3"},
        {"kind": "anim", "t0": 1.0, "t1": 3.0, "params": {"name": "bachata"}},
        {"kind": "fullscreen", "src": "assets/library/demo.mp4", "t0": 4.0, "t1": 6.0},
    ]
    edit["face"] = {"x": 0.5, "y": 0.3, "w": 0.3, "h": 0.22}
    edit["hook"] = None
    edit["cta"] = None
    edit["music"] = {"file": "assets/music/lofi.mp3", "gainDb": -18}
    job.write("edit.json", edit)
    assert job.read("edit.json") == edit

    edit["inserts"][1]["title"] = 5
    with pytest.raises(ValueError, match=r"inserts\[1\]\.title"):
        job.write("edit.json", edit)


def test_edit_keeps_a_planned_insert_waiting_for_its_answer(job):
    # шаг analyze решает место и время вставки «добавь сюда», картинку даст ответ Павла на шаге render
    edit = make_edit()
    edit["inserts"] = [{"kind": "image", "question": "insert-1", "t0": 12.0, "t1": 15.5, "x": 70, "y": 500, "w": 250}]
    job.write("edit.json", edit)
    assert job.read("edit.json")["inserts"][0]["question"] == "insert-1"
    edit["inserts"][0]["question"] = ""
    with pytest.raises(ValueError, match=r"inserts\[0\]\.question"):
        job.write("edit.json", edit)


def test_styles_sample_inserts_optional(job):
    styles = json.loads((Path(__file__).parent / "fixtures" / "style-merge.json").read_text(encoding="utf-8"))["styles"]
    plain = {**styles, "sample": {k: v for k, v in styles["sample"].items() if k != "inserts"}}
    job.write("styles.json", plain)
    job.write("styles.json", styles)
    bad = json.loads(json.dumps(styles))
    bad["sample"]["inserts"][0]["x"] = "a"
    with pytest.raises(ValueError, match=r"sample\.inserts\[0\]\.x"):
        job.write("styles.json", bad)


def test_result_takes_a_post_caption(job):
    result = {"durations": {"source": 80.2, "final": 71.0}, "done": [], "unsure": [], "missing": [], "qa": {"ok": True, "problems": []},
              "caption": {"text": "Три ошибки новичка 🔥", "hashtags": ["монтаж", "reels"]}}
    job.write("result.json", result)
    for bad, field in (({"text": "", "hashtags": []}, "text"), ({"text": "x", "hashtags": ["#a b"]}, "hashtags"),
                       ({"text": "x", "hashtags": [str(i) for i in range(31)]}, "hashtags")):
        with pytest.raises(ValueError, match=rf"caption\.{field}"):
            job.write("result.json", {**result, "caption": bad})


def test_edit_face_is_fractions_of_the_frame(job):
    edit = make_edit()
    edit["face"] = {"x": 1.5, "y": 0.3}
    with pytest.raises(ValueError, match=r"face\.x"):
        job.write("edit.json", edit)

    edit["face"] = {"x": 0.5}
    with pytest.raises(ValueError, match=r"face\.y"):
        job.write("edit.json", edit)

    edit["face"] = {"x": 0.5, "y": 0.3, "w": -0.1}
    with pytest.raises(ValueError, match=r"face\.w"):
        job.write("edit.json", edit)


def test_edit_takes_thesis_stickers_with_an_id(job):
    edit = make_edit()
    edit["inserts"] = [{"kind": "text", "id": "s1", "text": "3 ошибки новичка 🔥", "t0": 4.0, "t1": 6.0, "x": 120, "y": 700, "w": 420,
                        "sfx": None, "params": {"tone": "accent"}}]
    job.write("edit.json", edit)
    edit["inserts"][0]["id"] = "S 1"
    with pytest.raises(ValueError, match=r"inserts\[0\]\.id"):
        job.write("edit.json", edit)


def test_styles_sample_shows_thesis_stickers(job):
    styles = json.loads((Path(__file__).parent / "fixtures" / "style-merge.json").read_text(encoding="utf-8"))["styles"]
    styles["sample"]["inserts"] = [{"kind": "text", "id": "s1", "text": "Свет 💡", "x": 120, "y": 700, "w": 420, "params": {"tone": "light"}}]
    job.write("styles.json", styles)


def test_edit_takes_an_end_card(job):
    edit = make_edit()
    edit["end"] = {"seconds": 2.0, "lines": ["Подпишись 👇"], "handle": "@pavel", "logo": "in/brand/logo.png", "sfx": None}
    job.write("edit.json", edit)
    edit["end"] = None
    job.write("edit.json", edit)
    for bad, field in (({"seconds": 0.5, "lines": ["x"]}, "seconds"), ({"seconds": 2, "lines": []}, "lines"),
                       ({"seconds": 2, "lines": ["a", "b", "c"]}, "lines")):
        edit["end"] = bad
        with pytest.raises(ValueError, match=rf"end\.{field}"):
            job.write("edit.json", edit)


def test_edit_takes_a_teaser(job):
    edit = make_edit()
    edit["teaser"] = {"t0": 30.2, "t1": 32.8, "sfx": "assets/sfx/swoosh.mp3"}
    job.write("edit.json", edit)
    edit["teaser"] = None
    job.write("edit.json", edit)
    edit["teaser"] = {"t0": 30.2}
    with pytest.raises(ValueError, match=r"teaser"):
        job.write("edit.json", edit)


def test_a_b_test_is_without_the_teaser_or_without_the_music(job):
    edit = make_edit()
    for ab in ("teaser", "music", None):
        job.write("edit.json", {**edit, "ab": ab})
    with pytest.raises(ValueError, match=r"  ab: "):
        job.write("edit.json", {**edit, "ab": "colors"})
    answers = {"answers": {}, "style": {"variant": "A", "font": "Gilroy", "hand": "caveat",
                                         "colors": {"text": "#FFFFFF", "accent": "#FFD23F", "bar": "#FFD23F"}}}  # fmt: skip
    job.write("answers.json", {**answers, "ab": "music"})
    with pytest.raises(ValueError, match=r"  ab: "):
        job.write("answers.json", {**answers, "ab": "hook"})
    result = {"durations": {"source": 80.2, "final": 71.0}, "done": [], "unsure": [], "missing": [], "qa": {"ok": True, "problems": []}}
    second = {"differs": "teaser", "durations": {"source": 80.2, "final": 68.5}, "qa": {"ok": False, "problems": ["тихо"]}}
    job.write("result.json", {**result, "ab": second})
    with pytest.raises(ValueError, match=r"  ab\.differs: "):
        job.write("result.json", {**result, "ab": {**second, "differs": "hook"}})
    with pytest.raises(ValueError, match=r"  ab\.qa\.ok: "):
        job.write("result.json", {**result, "ab": {**second, "qa": {"ok": "yes", "problems": []}}})


def test_edit_rejects_unknown_insert_kind(job):
    edit = make_edit()
    edit["inserts"][0]["kind"] = "gif"
    with pytest.raises(ValueError, match=r"inserts\[0\]\.kind"):
        job.write("edit.json", edit)


@pytest.mark.parametrize(
    "field", ["speed", "keep", "words", "hook", "cta", "inserts", "zooms", "face", "music", "hold", "style"]
)
def test_edit_requires_every_top_level_field(job, field):
    edit = make_edit()
    del edit[field]
    with pytest.raises(ValueError, match=field):
        job.write("edit.json", edit)


@pytest.mark.parametrize("words, ok", [(1, False), (2, True), (6, True), (7, False), (2.5, False)])
def test_subtitle_words_range_is_2_to_6(job, words, ok):
    edit = make_edit()
    edit["style"]["subtitles"]["words"] = words
    if ok:
        job.write("edit.json", edit)
    else:
        with pytest.raises(ValueError, match=r"style\.subtitles\.words"):
            job.write("edit.json", edit)


@pytest.mark.parametrize("color", ["red", "#FFF", "#GGGGGG", "FFD23F", "#FFD23F00", 16763455])
def test_style_colors_must_be_rrggbb(job, color):
    edit = make_edit()
    edit["style"]["colors"]["accent"] = color
    with pytest.raises(ValueError, match=r"style\.colors\.accent"):
        job.write("edit.json", edit)


def test_style_colors_accept_any_case(job):
    edit = make_edit()
    edit["style"]["colors"]["accent"] = "#ffd23f"
    edit["style"]["colors"]["plate"] = "#0a0B0c"
    job.write("edit.json", edit)


def test_style_spec_enums_and_required_parts(job):
    for path, value in [
        (("hook", "mode"), "neon"),
        (("bar", "pos"), "left"),
    ]:
        edit = make_edit()
        edit["style"][path[0]][path[1]] = value
        with pytest.raises(ValueError, match=rf"style\.{path[0]}\.{path[1]}"):
            job.write("edit.json", edit)

    for part in ("font", "hand", "colors", "subtitles", "hook", "bar"):
        edit = make_edit()
        del edit["style"][part]
        with pytest.raises(ValueError, match=rf"style\.{part}"):
            job.write("edit.json", edit)

    for color in ("text", "accent", "bar", "plate", "outline"):
        edit = make_edit()
        del edit["style"]["colors"][color]
        with pytest.raises(ValueError, match=rf"style\.colors\.{color}"):
            job.write("edit.json", edit)


# --- схемы: questions, answers, result --------------------------------------------


def test_questions_roundtrip_and_type_enum(job):
    questions = {
        "questions": [
            {
                "id": "cut",
                "type": "choice",
                "title": "Резать паузы?",
                "body": "14 пауз, 2 повтора, будет ~1:16",
                "options": [{"id": "yes", "label": "Да"}, {"id": "no", "label": "Нет", "image": "q/no.png"}],
                "default": "yes",
            },
            {
                "id": "stars",
                "type": "multi",
                "title": "Звёздочки",
                "options": [{"id": "a", "label": "рублей"}],
                "default": ["a"],
            },
            {"id": "ins1", "type": "insert", "title": "Что поставить?", "image": "q/ins1.png"},
            {"id": "w1", "type": "word", "title": "Как пишется?", "default": "Mluv"},
            {"id": "hook", "type": "text", "title": "Хук"},
        ]
    }
    job.write("questions.json", questions)
    assert job.read("questions.json") == questions

    questions["questions"][0]["type"] = "radio"
    with pytest.raises(ValueError, match=r"questions\[0\]\.type"):
        job.write("questions.json", questions)

    questions = {"questions": [{"id": "x", "type": "text"}]}
    with pytest.raises(ValueError, match=r"questions\[0\]\.title"):
        job.write("questions.json", questions)

    with pytest.raises(ValueError, match="questions"):
        job.write("questions.json", {})


def test_answers_roundtrip_and_variant_enum(job):
    answers = {
        "answers": {"cut": "yes", "stars": ["рублей", "бесплатно"]},
        "style": {
            "variant": "B",
            "font": "unbounded",
            "hand": "caveat",
            "colors": {"text": "#FFFFFF", "accent": "#00FFAA", "bar": "#00FFAA"},
        },
        "uploads": {"ins1": "in/uploads/logo.png"},
        "brief": "ХУК: Как я монтирую",
    }
    job.write("answers.json", answers)
    assert job.read("answers.json") == answers

    bad = copy.deepcopy(answers)
    bad["style"]["variant"] = "D"
    with pytest.raises(ValueError, match=r"style\.variant"):
        job.write("answers.json", bad)

    bad = copy.deepcopy(answers)
    bad["answers"]["cut"] = 5
    with pytest.raises(ValueError, match=r"answers\.cut"):
        job.write("answers.json", bad)

    bad = copy.deepcopy(answers)
    bad["style"]["colors"]["accent"] = "yellow"
    with pytest.raises(ValueError, match=r"style\.colors\.accent"):
        job.write("answers.json", bad)

    bad = copy.deepcopy(answers)
    del bad["style"]
    with pytest.raises(ValueError, match="style"):
        job.write("answers.json", bad)

    minimal = {k: v for k, v in answers.items() if k not in ("uploads", "brief")}
    job.write("answers.json", minimal)  # uploads и brief необязательны


def test_answers_take_a_speed_from_1_to_1_5(job):
    answers = {"answers": {}, "style": {"variant": "A", "font": "Gilroy", "hand": "caveat",
                                         "colors": {"text": "#FFFFFF", "accent": "#FFD23F", "bar": "#FFD23F"}}}  # fmt: skip
    for speed in (1, 1.3, 1.5):
        job.write("answers.json", {**answers, "speed": speed})
    for speed in (0.9, 1.6, "1.2"):
        with pytest.raises(ValueError, match="speed"):
            job.write("answers.json", {**answers, "speed": speed})


def test_result_roundtrip_and_required_fields(job):
    result = {
        "durations": {"source": 80.2, "final": 71.0},
        "done": ["Вырезано 14 пауз"],
        "unsure": ["«Mluv» — не уверен в написании"],
        "missing": ["music: none chosen"],
        "qa": {"ok": True, "problems": []},
    }
    job.write("result.json", result)
    assert job.read("result.json") == result

    bad = copy.deepcopy(result)
    del bad["qa"]
    with pytest.raises(ValueError, match="qa"):
        job.write("result.json", bad)

    bad = copy.deepcopy(result)
    bad["qa"]["ok"] = "yes"
    with pytest.raises(ValueError, match=r"qa\.ok"):
        job.write("result.json", bad)

    bad = copy.deepcopy(result)
    del bad["durations"]["final"]
    with pytest.raises(ValueError, match=r"durations\.final"):
        job.write("result.json", bad)


# --- CLI --------------------------------------------------------------------------


def test_cli_status_writes_status_json(tmp_path, capsys):
    jobdir = tmp_path / "jobs" / "abc"
    rc = main(
        [
            "status", str(jobdir),
            "--state", "waiting_answers",
            "--phase", "Жду ответов",
            "--message", "Ответьте на вопросы",
            "--needs", "answers",
            "--progress", "0.4",
        ]
    )
    assert rc == 0
    status = Job(jobdir).read("status.json")
    assert (status["state"], status["phase"], status["needs"], status["progress"]) == (
        "waiting_answers", "Жду ответов", "answers", 0.4,
    )
    assert "abc" in capsys.readouterr().out  # короткая сводка для Claude


def test_cli_status_error_option(tmp_path):
    jobdir = tmp_path / "abc"
    rc = main(
        ["status", str(jobdir), "--state", "error", "--phase", "Монтирую"]
        + ["--message", "Сбой", "--error", "ffmpeg упал"]
    )
    assert rc == 0
    assert Job(jobdir).read("status.json")["error"] == "ffmpeg упал"


def test_cli_status_invalid_value_exits_with_error(tmp_path, capsys):
    jobdir = tmp_path / "abc"
    rc = main(["status", str(jobdir), "--state", "analyzing", "--phase", "p", "--message", "m", "--progress", "7"])
    assert rc == 1
    assert "progress" in capsys.readouterr().err
    assert not (jobdir / "status.json").exists()


def test_python_dash_m_vm_status(tmp_path):
    jobdir = tmp_path / "abc"
    done = subprocess.run(
        [sys.executable, "-m", "vm", "status", str(jobdir)]
        + ["--state", "queued", "--phase", "Очередь", "--message", "Жду запуска"],
        cwd=ENGINE_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    assert Job(jobdir).read("status.json")["state"] == "queued"
