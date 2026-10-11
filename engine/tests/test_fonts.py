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


# ---------- после ревью ----------


def test_invisible_characters_need_no_letters():
    assert fonts.missing(by_id("rubik"), "ok\u200b\u200d\ufe0f\u00ad\u2060\U0001f3fb") == ""  # оттенок кожи у эмодзи — тоже


def test_symbols_and_emoji_are_not_letters_of_a_font():
    assert fonts.missing(by_id("montserrat"), "♪ ahoj 🔥") == ""


def test_emoji_of_the_set_are_fine_in_the_hook_the_cta_and_inserts():
    e = edit(
        ["ahoj"],
        hook={"text": "Jak vydělávám 🔥", "until": 2.0},
        cta={"lines": ["PIŠ MI 👇"], "word": "Plán ✅", "t0": 1.0, "t1": 2.0},
        inserts=[{"kind": "sticker", "title": "Cena 💡", "text": "❤️ zdarma 1️⃣", "t0": 1, "t1": 3, "x": 60, "y": 200, "w": 300}],
    )
    assert fonts.check(e) == []


def test_a_symbol_without_a_picture_is_a_problem_with_the_way_out():
    (problem,) = fonts.check(edit(["ahoj"], hook={"text": "Zpívám ♪ a srdce ❤", "until": 2.0}))
    assert "♪" in problem and "❤" in problem and "убери" in problem
    assert "U+FE0F" in problem  # ❤ без селектора — буква, а не эмодзи: подсказка, как сделать эмодзи


def test_emoji_in_subtitles_is_a_problem():
    (problem,) = fonts.check(edit(["ahoj", "🔥"], hook={"text": "Jak 🔥", "until": 2.0}))
    assert "субтитр" in problem and "🔥" in problem


def test_trailing_emoji_of_the_hook_go_with_the_handwritten_word():
    main_text, hand_text = fonts.texts(edit(["ahoj"], hook={"text": "Tři chyby 🔥 👇", "until": 2.0}))
    assert hand_text == "chyby 🔥 👇"
    assert "Tři" in main_text


def test_emoji_need_no_letters_of_a_font():
    assert fonts.missing(by_id("russo-one"), "Огонь 🔥 1️⃣ #️⃣ ©️") == ""


def test_cli_fonts_reads_the_draft_once_it_is_there(tmp_path, capsys):
    # сырые слова бывают с мусором (лишняя греческая буква от Parakeet, ♪ от Whisper); рисуется только черновик
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.path("words.json").write_text(json.dumps([{"t0": 0.5, "t1": 0.9, "text": "τ"}]), encoding="utf-8")
    job.path("reference.txt").write_text("♪ Ahoj.\n", encoding="utf-8")
    assert main(["fonts", str(job.root)]) == 0
    raw = json.loads(capsys.readouterr().out.splitlines()[0])["main"]
    assert "comfortaa" in raw and "montserrat" not in raw  # греческая «τ» из сырых слов сужает список
    job.write("edit.json", edit(["Ahoj."], hook={"text": "Jak stříhám", "until": 2.0}))
    job.write("questions.json", {"questions": [{"id": "hook", "type": "choice", "title": "Хук",
                                                "options": [{"id": "a", "label": "Kůň úpěl"}]}]})  # fmt: skip
    assert main(["fonts", str(job.root)]) == 0
    covering = json.loads(capsys.readouterr().out.splitlines()[0])
    assert "montserrat" in covering["main"] and "caveat" in covering["hand"]


def test_cli_fonts_never_leaves_a_list_empty(tmp_path, capsys):
    # узбекской «ʻ» нет ни в одном рукописном: пустой список оставил бы Павла без кнопок — все шрифты и предупреждение
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("edit.json", edit(["oʻzbek"], hook={"text": "Salom oʻzbek", "until": 2.0}))
    assert main(["fonts", str(job.root)]) == 0
    out = capsys.readouterr().out
    covering = json.loads(out.splitlines()[0])
    assert set(covering["hand"]) == {f.id for f in fonts.catalog() if f.kind == "hand"}
    assert "ВНИМАНИЕ" in out and "ʻ" in out


# ---------- свои шрифты Павла (assets/fonts) ----------

PAVEL = ["Arial Narrow", "Cormorant", "Druk Wide", "Gilroy", "Helvetica", "Mohave", "Neutral Face", "Playfair Display"]


def test_pavels_fonts_are_in_the_catalog_as_main_fonts():
    own = {f.id: f for f in fonts.catalog() if f.path.parent == fonts.CUSTOM}
    assert sorted(own) == PAVEL
    assert all(f.kind == "main" for f in own.values())


def test_pavels_fonts_are_offered_only_where_they_have_the_letters():
    russian = fonts.coverage("Привет, как дела? Съешь ещё этих мягких булок.", "")["main"]
    czech = fonts.coverage("Příliš žluťoučký kůň úpěl ďábelské ódy.", "")["main"]
    assert {"Gilroy", "Helvetica", "Arial Narrow", "Cormorant", "Playfair Display", "Neutral Face"} <= set(russian)
    assert "Druk Wide" not in russian and "Mohave" not in russian  # кириллицы в них нет
    assert {"Druk Wide", "Mohave", "Gilroy"} <= set(czech)
    assert "Neutral Face" not in czech  # нет ř, ů


def test_mohave_is_bold_not_the_light_default_of_the_variable_font():
    from fontTools.ttLib import TTFont

    font = next(f for f in fonts.catalog() if f.id == "Mohave")
    with TTFont(font.path) as ttf:
        assert "fvar" not in ttf and ttf["OS/2"].usWeightClass == 700


def test_the_end_card_is_drawn_by_the_main_font():
    e = edit(["ahoj"], font="russo-one")
    e["end"] = {"seconds": 2, "lines": ["Mulțumesc 👇"], "handle": "@pavel"}
    (problem,) = fonts.check(e)
    assert "russo-one" in problem and "Țț" in problem
    main_text, _ = fonts.texts(e)
    assert "Mulțumesc" in main_text and "@pavel" in main_text


def test_cli_fonts_counts_the_end_card_options_too(tmp_path, capsys):
    # призыв финальной карточки рисуется основным шрифтом: шрифт без его букв Павлу не предлагается
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("edit.json", edit(["Ahoj."], hook={"text": "Jak stříhám", "until": 2.0}))
    job.write("questions.json", {"questions": [{"id": "end", "type": "choice", "title": "Карточка",
                                                "options": [{"id": "e1", "label": "«Sleduj τ»"}]}]})  # fmt: skip
    assert main(["fonts", str(job.root)]) == 0
    covering = json.loads(capsys.readouterr().out.splitlines()[0])
    assert "montserrat" not in covering["main"] and "comfortaa" in covering["main"], covering["main"]


def test_cli_fonts_skips_the_service_options_of_questions(tmp_path, capsys):
    # «Свой», «Не надо», «Без заголовка» — подписи кнопок страницы, а не текст ролика: чешскому ролику они не закрывают
    # шрифты без кириллицы
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("edit.json", edit(["Ahoj."], hook={"text": "Jak to dělám", "until": 2.0}))
    job.write("questions.json", {"questions": [
        {"id": "hook", "type": "choice", "title": "Хук", "options": [{"id": "h1", "label": "Jak to dělám"}, {"id": "own", "label": "Свой"},
                                                                     {"id": "none", "label": "Без заголовка"}]},
        {"id": "end", "type": "choice", "title": "Карточка", "options": [{"id": "e1", "label": "«Sleduj mě»"}, {"id": "own", "label": "Свой"},
                                                                         {"id": "none", "label": "Не надо"}]}]})  # fmt: skip
    assert main(["fonts", str(job.root)]) == 0
    assert "Mohave" in json.loads(capsys.readouterr().out.splitlines()[0])["main"]


def test_cli_fonts_counts_the_spellings_of_a_word_question(tmp_path, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("edit.json", edit(["Ahoj."], hook={"text": "Jak to dělám", "until": 2.0}))
    job.write("questions.json", {"questions": [{"id": "brand", "type": "word", "title": "Проверь слово",
                                                "options": [{"id": "a", "label": "Καλό"}]}]})  # fmt: skip
    assert main(["fonts", str(job.root)]) == 0
    assert "montserrat" not in json.loads(capsys.readouterr().out.splitlines()[0])["main"]


def test_the_cover_text_is_checked_like_the_hook():
    e = edit(["ahoj"], font="russo-one")
    e["cover"] = {"t": 1.0, "text": "Mulțumesc pentru tot"}
    main_text, hand_text = fonts.texts(e)
    assert "Mulțumesc pentru tot" in main_text and hand_text.split()[-1] == "tot", "последнее слово — рукописным, как у хука"
    (problem,) = fonts.check(e)
    assert "russo-one" in problem and "Țț" in problem
