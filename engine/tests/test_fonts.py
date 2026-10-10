"""Буквы в шрифтах: каталог как у шаблона, чего не хватает, какие шрифты подходят тексту ролика."""
import json
import shutil

import pytest

from vm import fonts
from vm.__main__ import main
from vm.job import Job

STYLE = {
    "font": "montserrat",
    "hand": "caveat",
    "colors": {"text": "#FFFFFF", "accent": "#FFD23F", "bar": "#FFD23F", "plate": "#111111", "outline": "#000000"},
    "subtitles": {"mode": "karaoke", "words": 3, "size": 64, "y": 1300},
    "hook": {"mode": "plate", "size": 72},
    "bar": {"pos": "bottom", "height": 14},
}


def edit(words, hook=None, cta=None, inserts=(), font="montserrat", hand="caveat"):
    return {
        "speed": 1.0, "keep": [[0.0, 4.0]],
        "words": [{"t0": 0.5 + i, "t1": 0.9 + i, "text": w} for i, w in enumerate(words)],
        "hook": hook, "cta": cta, "inserts": list(inserts), "zooms": [], "face": {"x": 0.5, "y": 0.3}, "music": None, "hold": 0.0,
        "style": {**STYLE, "font": font, "hand": hand},
    }  # fmt: skip


def by_id(font_id, custom=None):
    return next(f for f in fonts.catalog(custom) if f.id == font_id)


def test_catalog_has_the_built_in_fonts_with_their_files():
    built = {f.id: f for f in fonts.catalog()}
    assert {"montserrat", "unbounded", "rubik", "oswald", "russo-one", "comfortaa"} <= {i for i, f in built.items() if f.kind == "main"}
    assert {"caveat", "marck-script", "bad-script"} <= {i for i, f in built.items() if f.kind == "hand"}
    assert all(f.path.is_file() for f in built.values())


def test_catalog_adds_pavels_fonts_like_the_template_does(tmp_path):
    source = by_id("montserrat").path
    shutil.copy(source, tmp_path / "Brand.ttf")
    shutil.copy(source, tmp_path / "Note-hand.otf")
    shutil.copy(source, tmp_path / "caveat.ttf")  # встроенный с тем же id важнее
    (tmp_path / "readme.txt").write_text("не шрифт")
    custom = {f.id: f for f in fonts.catalog(tmp_path) if f.path.parent == tmp_path}
    assert {i: f.kind for i, f in custom.items()} == {"Brand": "main", "Note-hand": "hand"}


def test_a_font_with_every_letter_misses_nothing():
    assert fonts.missing(by_id("montserrat"), "Příliš žluťoučký kůň úpěl ďábelské ódy. Їжак, ґанок — «так»!") == ""


def test_missing_letters_count_the_capitals_too():
    # хук — капсом: строчной «ơ» мало, нужна и «Ơ»
    assert fonts.missing(by_id("rubik"), "Cơm ngon") == "Ơơ"


def test_spaces_and_line_breaks_are_not_letters():
    assert fonts.missing(by_id("rubik"), "раз два\nтри\tчетыре пять") == ""


def test_texts_of_the_video_split_into_main_and_handwritten():
    e = edit(
        ["Ahoj", "světe."],
        hook={"text": "Jak stříhám videa", "until": 2.0},
        cta={"lines": ["PIŠTE DO KOMENTÁŘŮ"], "word": "Kůň", "t0": 1.0, "t1": 2.0},
        inserts=[{"kind": "sticker", "title": "Cena", "text": "zdarma", "t0": 1, "t1": 3, "x": 60, "y": 200, "w": 300}],
    )
    main_text, hand_text = fonts.texts(e)
    for piece in ("Ahoj", "světe.", "Jak stříhám videa", "PIŠTE DO KOMENTÁŘŮ", "Cena", "zdarma"):
        assert piece in main_text
    assert hand_text.split() == ["videa", "Kůň"]  # последнее слово хука и кодовое слово — рукописные


def test_a_font_without_the_letters_of_the_video_is_a_problem_with_the_way_out():
    problems = fonts.check(edit(["Bună", "ziua,", "mulțumesc"], font="russo-one"))
    assert len(problems) == 1
    assert "russo-one" in problems[0] and "Țț" in problems[0] and "montserrat" in problems[0]


def test_the_handwritten_font_is_checked_on_its_own_words():
    e = edit(["Cảm", "ơn"], hook={"text": "Xin chào bạn ơi", "until": 2.0}, font="montserrat", hand="caveat")
    (problem,) = fonts.check(e)
    assert "caveat" in problem and "Ơơ" in problem and "bad-script" in problem


def test_fonts_with_every_letter_are_fine():
    assert fonts.check(edit(["Grüß", "Gott,", "Zürich"], hook={"text": "Größe zählt", "until": 2.0})) == []


def test_an_unknown_font_is_left_to_the_renderer():
    assert fonts.check(edit(["ahoj"], font="no-such-font")) == []


def test_coverage_lists_the_fonts_that_have_every_letter():
    kazakh = "Сәлем, қалың қалай? Жақсы, рахмет!"
    covering = fonts.coverage(kazakh, kazakh)
    assert "montserrat" in covering["main"] and "unbounded" not in covering["main"] and "russo-one" not in covering["main"]
    assert "bad-script" in covering["hand"] and "marck-script" not in covering["hand"]


def test_cli_fonts_prints_the_fonts_for_the_text_of_the_video(tmp_path, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.path("words.json").write_text(json.dumps([{"t0": 0.5, "t1": 0.9, "text": "mulțumesc"}]), encoding="utf-8")
    job.path("reference.txt").write_text("Mulțumesc.\n", encoding="utf-8")
    assert main(["fonts", str(job.root)]) == 0
    out = capsys.readouterr().out
    covering = json.loads(out.splitlines()[0])
    assert "montserrat" in covering["main"] and "russo-one" not in covering["main"]
    assert "marck-script" not in covering["hand"]
    assert "russo-one" in out.split("\n", 1)[1] and "Țț" in out  # и чего каким шрифтам не хватает


def test_cli_check_stops_before_drawing_when_a_font_lacks_letters(tmp_path, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("edit.json", edit(["mulțumesc"], font="russo-one"))
    assert main(["check", str(job.root)]) == 1
    assert "russo-one" in capsys.readouterr().err
    assert not job.path("work").exists()


@pytest.mark.parametrize("command", [["render"], ["render", "--version", "2"]])
def test_cli_render_stops_before_rendering_when_a_font_lacks_letters(tmp_path, capsys, command):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("edit.json", edit(["mulțumesc"], font="russo-one"))
    assert main([command[0], str(job.root), *command[1:]]) == 1
    assert "russo-one" in capsys.readouterr().err
