"""Правки Павла руками в редакторе (timeline.json) поверх монтажа сессии (edit.json): куски, голос, музыка, звуки."""
import json
from pathlib import Path

import pytest

from vm import edits
from vm.job import Job, validate
from vm.overlay import build_overlay_events, insert_spans
from vm.timeline import Timeline

SHARED = json.loads((Path(__file__).parent / "fixtures" / "edits.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", SHARED["cases"], ids=lambda c: c["name"])
def test_keep_matches_the_shared_fixture(case):
    assert edits.apply_keep(case["keep"], case["edits"], case["duration"]) == case["expected"]
    assert edits.SLIVER == SHARED["sliver"]


@pytest.mark.parametrize("bad", SHARED["refused"])
def test_a_broken_edit_is_refused_with_its_number(bad):
    with pytest.raises(ValueError, match="edits\\[1\\]"):
        edits.apply_keep([[0, 3]], [{"op": "cut", "t0": 0, "t1": 0.5}, bad], 4)


EDIT = {
    "speed": 1.1, "keep": [[0.5, 4.0]], "words": [], "hook": None, "cta": None, "inserts": [], "zooms": [],
    "face": {"x": 0.5, "y": 0.4}, "music": {"file": "assets/music/a.mp3", "gainDb": -14}, "hold": 0, "style": {},
}


def test_sound_edits_reach_the_edit():
    timeline = {
        "rev": 3, "edits": [{"op": "cut", "t0": 1, "t1": 2}],
        "voice": {"gainDb": -3, "muted": False},
        "music": {"gainDb": -20, "at": 1.5, "from": 12, "fadeIn": 0.5, "fadeOut": 2},
        "sounds": {"insert:0": {"gainDb": 4, "muted": False}, "teaser": {"gainDb": 0, "muted": True}},
    }
    out = edits.apply(EDIT, timeline, 5)
    assert out["keep"] == [[0.5, 1], [2, 4.0]]
    assert out["voice"] == {"gainDb": -3, "muted": False}
    assert out["music"] == {"file": "assets/music/a.mp3", "gainDb": -20, "at": 1.5, "from": 12, "fadeIn": 0.5, "fadeOut": 2}
    assert out["sounds"] == timeline["sounds"]
    assert EDIT["keep"] == [[0.5, 4.0]], "edit.json сессии не меняется"


def test_muted_music_is_no_music_and_without_music_there_is_nothing_to_adjust():
    assert edits.apply(EDIT, {"rev": 1, "edits": [], "music": {"muted": True}}, 5)["music"] is None
    assert edits.apply({**EDIT, "music": None}, {"rev": 1, "edits": [], "music": {"gainDb": -8}}, 5)["music"] is None


def test_music_muted_by_hand_drops_the_ab_test_without_music():
    """A/B «без музыки», а Павел выключил музыку в редакторе: версия B вышла бы такой же — второй версии нет (а не сбой
    рендера, который просил бы сессию править edit.json, куда она для правок из редактора не лезет)."""
    out = edits.apply({**EDIT, "ab": "music"}, {"rev": 1, "edits": [], "music": {"muted": True}}, 5)
    assert out["music"] is None and out.get("ab") is None
    teaser = {**EDIT, "ab": "teaser", "teaser": {"t0": 1, "t1": 2}}
    assert edits.apply(teaser, {"rev": 1, "edits": [], "music": {"muted": True}}, 5)["ab"] == "teaser", "другой A/B — как был"


def test_without_cuts_and_restores_the_session_pieces_stay_as_they_are():
    """Только звук (edits пустой) — куски сессии как есть: не склеиваются и не округляются (как показывает редактор)."""
    edit = {**EDIT, "keep": [[0, 1], [1, 2], [3, 3.02]]}
    assert edits.apply(edit, {"rev": 1, "edits": [], "voice": {"gainDb": -3}}, 5)["keep"] == [[0, 1], [1, 2], [3, 3.02]]
    assert edits.apply(edit, {"rev": 1, "edits": [{"op": "split", "t": 0.5}]}, 5)["keep"] == [[0, 2]], "правки есть — по общему правилу"


def test_edits_that_cut_the_whole_video_are_named_not_rendered_empty():
    """Страница не даёт вырезать последний кусок, но timeline.json мог прийти и не от неё: пустой ролик — понятная
    ошибка про правки, а не сбой рендера."""
    edit = {"speed": 1.0, "keep": [[0.0, 2.0], [3.0, 4.0]], "music": None}
    with pytest.raises(ValueError, match="вырезают весь ролик"):
        edits.apply(edit, {"rev": 1, "edits": [{"op": "cut", "t0": 0, "t1": 5}]}, 5.0)


def test_no_timeline_is_the_session_edit_as_is():
    assert edits.apply(EDIT, None, 5) is EDIT


def test_edit_of_reads_timeline_json_from_the_job(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.path("edit.json").write_text(json.dumps(EDIT), encoding="utf-8")
    assert edits.edit_of(job, 5)["keep"] == [[0.5, 4.0]]
    job.write("timeline.json", {"rev": 2, "at": "2026-10-12T15:00:00Z", "edits": [{"op": "cut", "t0": 3, "t1": 4.5}]})
    assert edits.edit_of(job, 5)["keep"] == [[0.5, 3]]


@pytest.mark.parametrize("bad", [
    {"rev": 0, "edits": []},
    {"rev": 1, "edits": [{"op": "cut", "t0": -1, "t1": 1}]},
    {"rev": 1, "edits": [{"op": "jump", "t": 1}]},
    {"rev": 1, "edits": [], "voice": {"gainDb": 40}},
    {"rev": 1, "edits": [], "music": {"fadeIn": 20}},
    {"rev": 1, "edits": [], "sounds": {"insert:0": {"gainDb": "громче"}}},
    {"rev": 1, "edits": [], "extra": True},
])
def test_the_schema_refuses_a_broken_timeline(tmp_path, bad):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    with pytest.raises(ValueError):
        job.write("timeline.json", bad)


# ---------- текст и вставки руками (фаза 5): поверх edit.json по месту блока в речи ----------

STYLE = {"subtitles": {"mode": "karaoke", "words": 3}, "hook": {"mode": "plate"}}
TEXT_EDIT = {
    **EDIT, "keep": [[0.0, 9.0]],
    "words": [{"t0": 0.5, "t1": 0.8, "text": "Привет,"}, {"t0": 0.9, "t1": 1.2, "text": "эта"}, {"t0": 1.3, "t1": 1.6, "text": "эээ"},
              {"t0": 1.7, "t1": 2.0, "text": "ролик."}],
    "hook": {"text": "Как я снимаю", "until": 1.5},
    "cta": {"t0": 7.0, "t1": 8.0, "lines": ["Пиши в комментариях"], "word": "ВИДЕО"},
    "accents": [{"t0": 3.0, "t1": 4.0, "x": 540, "y": 900, "lines": [{"text": "очень"}, {"text": "важно", "size": "big"}]},
                {"t0": 5.0, "t1": 5.5, "x": 540, "y": 900, "lines": [{"text": "второй"}]}],
    "inserts": [{"kind": "image", "src": "a.png", "t0": 2.0, "t1": 3.0, "x": 1, "y": 1, "w": 10, "sfx": "pop.mp3"},
                {"kind": "sticker", "text": "5 минут", "t0": 4.0, "t1": 5.0, "x": 1, "y": 1, "w": 10},
                {"kind": "image", "src": "b.png", "t0": 6.0, "t1": 6.5, "x": 1, "y": 1, "w": 10, "sfx": "pop.mp3"}],
}


def test_text_and_insert_edits_reach_the_edit_by_the_place_of_each_block():
    timeline = {"rev": 2, "edits": [], "text": {
        "hook": {"until": 2.0, "text": "Как я снимаю на телефон"},
        "cta": {"at": [7.0, 8.0], "t0": 6.8, "t1": 8.4, "lines": ["Напиши"], "word": "КАДР"},
        "accents": [{"at": [3.0, 4.0], "t0": 2.9, "t1": 4.3, "lines": ["совсем", "важно!"]}, {"at": [5.0, 5.5], "off": True}],
        "inserts": [{"at": [4.0, 5.0], "t0": 4.2, "t1": 6.0, "text": "10 минут"}, {"at": [6.0, 6.5], "off": True}],
    }, "words": [{"t0": 0.9, "t1": 1.2, "text": "это"}, {"t0": 1.3, "t1": 1.6, "text": ""}]}
    out = edits.apply(TEXT_EDIT, timeline, 9)
    assert out["hook"] == {"text": "Как я снимаю на телефон", "until": 2.0}
    assert out["cta"] == {"t0": 6.8, "t1": 8.4, "lines": ["Напиши"], "word": "КАДР"}
    assert out["accents"] == [{**TEXT_EDIT["accents"][0], "t0": 2.9, "t1": 4.3,
                               "lines": [{"text": "совсем"}, {"text": "важно!", "size": "big"}]}], "строки — текст, вид — как был; второй убран"
    assert out["inserts"][0] == TEXT_EDIT["inserts"][0], "без правки — как у сессии"
    assert out["inserts"][1] == {**TEXT_EDIT["inserts"][1], "t0": 4.2, "t1": 6.0, "text": "10 минут"}
    assert out["inserts"][2] == {**TEXT_EDIT["inserts"][2], "off": True}, "выключенная вставка остаётся в списке: номера звуков те же"
    assert [w["text"] for w in out["words"]] == ["Привет,", "это", "ролик."], "слово — по времени; пустое — из субтитров"
    assert out["keep"] == TEXT_EDIT["keep"] and TEXT_EDIT["words"][1]["text"] == "эта", "edit.json сессии не меняется"


def test_a_switched_off_insert_is_not_in_the_video_but_keeps_the_numbers():
    tl = Timeline([(0.0, 9.0)], 1.0)
    out = edits.apply(TEXT_EDIT, {"rev": 1, "edits": [], "text": {"inserts": [{"at": [2.0, 3.0], "off": True}]}}, 9)
    assert [i for i, _, _ in insert_spans(out, tl)] == [1, 2], "первой вставки нет — у остальных номера прежние"
    assert all(not s.get("insert0") for s in (e["state"] for e in build_overlay_events({**out, "style": STYLE}, tl)))


def test_hook_and_title_switched_off_are_gone():
    timeline = {"rev": 1, "edits": [], "text": {"hook": {"off": True}, "cta": {"at": [7.0, 8.0], "off": True}}}
    out = edits.apply(TEXT_EDIT, timeline, 9)
    assert out["hook"] is None and out["cta"] is None


def test_an_edit_of_a_block_the_session_moved_no_longer_applies():
    """Сессия переписала edit.json (правка текстом сдвинула титр, убрала вставку): правка Павла держится за блок по месту
    в речи — его там больше нет, и правка молча не применяется (а не достаётся соседу по номеру)."""
    moved = {**TEXT_EDIT, "cta": {**TEXT_EDIT["cta"], "t0": 7.5}, "inserts": TEXT_EDIT["inserts"][1:]}
    timeline = {"rev": 1, "edits": [], "text": {"cta": {"at": [7.0, 8.0], "t0": 6.0}, "inserts": [{"at": [2.0, 3.0], "t0": 2.5}]},
                "words": [{"t0": 0.9, "t1": 1.25, "text": "это"}]}
    out = edits.apply(moved, timeline, 9)
    assert out["cta"] == moved["cta"] and out["inserts"] == moved["inserts"] and out["words"] == moved["words"]
    assert edits.apply(TEXT_EDIT, {"rev": 1, "edits": [], "text": {"hook": {"until": 3.0}}}, 9)["hook"]["until"] == 3.0
    assert edits.apply({**TEXT_EDIT, "hook": None}, {"rev": 1, "edits": [], "text": {"hook": {"until": 3.0}}}, 9)["hook"] is None, \
        "хука нет — правке нечего менять"


def test_two_blocks_at_the_same_place_take_one_edit_each():
    twin = {**TEXT_EDIT, "inserts": [TEXT_EDIT["inserts"][0], {**TEXT_EDIT["inserts"][0], "src": "c.png"}]}
    timeline = {"rev": 1, "edits": [], "text": {"inserts": [{"at": [2.0, 3.0], "t0": 2.1}, {"at": [2.0, 3.0], "t0": 2.2}]}}
    assert [i["t0"] for i in edits.apply(twin, timeline, 9)["inserts"]] == [2.1, 2.2]


@pytest.mark.parametrize("text", [
    {"cta": {"at": [7.0, 8.0], "t0": 8.5}},
    {"accents": [{"at": [3.0, 4.0], "t1": 2.0}]},
    {"inserts": [{"at": [4.0, 5.0], "t0": 5.0, "t1": 5.0}]},
])
def test_a_block_ending_before_it_starts_is_refused_by_name(text):
    with pytest.raises(ValueError, match="timeline.json: text"):
        edits.apply(TEXT_EDIT, {"rev": 1, "edits": [], "text": text}, 9)


def test_text_edits_go_through_the_schema(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.path("edit.json").write_text(json.dumps(TEXT_EDIT), encoding="utf-8")
    job.write("timeline.json", {"rev": 1, "edits": [], "text": {"hook": {"until": 2.0}, "inserts": [{"at": [2.0, 3.0], "off": True}]},
                                "words": [{"t0": 0.9, "t1": 1.2, "text": "это"}]})
    out = edits.edit_of(job, 9)
    assert out["hook"]["until"] == 2.0 and out["inserts"][0]["off"] and out["words"][1]["text"] == "это"
    real = json.loads((Path(__file__).parent / "fixtures" / "style-merge.json").read_text(encoding="utf-8"))["expected"]
    validate("edit.json", {**out, "style": real})  # служебное off у вставки схема edit.json принимает
    for bad in ({"text": {"hook": {"off": False}}}, {"text": {"cta": {"t0": 1}}}, {"text": {"accents": [{"at": [1]}]}},
                {"words": [{"t0": 1, "text": "без конца"}]}, {"text": {"inserts": [{"at": [1, 2], "kind": "image"}]}}):
        with pytest.raises(ValueError):
            job.write("timeline.json", {"rev": 2, "edits": [], **bad})


PICTURE_EDIT = {
    "speed": 1.0, "keep": [[0.0, 8.0]], "words": [],
    "zooms": [{"t": 1.0, "level": 1.12}, {"t": 3.0, "level": 1.0}, {"t": 4.0, "level": 1.2, "over": 0}],
    "looks": [{"t0": 2.0, "t1": 3.0, "look": "bw"}, {"t0": 5.0, "t1": 6.0, "look": "bw"}],
    "transitions": [{"t": 2.5, "kind": "flash", "sfx": "assets/sfx/swoosh.mp3"}, {"t": 4.5, "kind": "zoom"}],
}


def test_zoom_strength_bw_pieces_and_transitions_set_by_hand():
    """Редактор: зум слабее или сильнее (доля от зума монтажа), ч/б-кусок убран, у перехода — другой вид или его нет.
    Убранное остаётся в списке (`off`): номера звуков `transition:<n>` не сдвигаются."""
    timeline = {"rev": 1, "edits": [], "zoom": 0.5, "looks": [{"at": [5.0, 6.0], "off": True}],
                "transitions": [{"at": 2.5, "kind": "blur"}, {"at": 4.5, "off": True}]}
    out = edits.apply(PICTURE_EDIT, timeline)
    assert [z["level"] for z in out["zooms"]] == [1.06, 1.0, 1.1]
    assert out["looks"] == [{"t0": 2.0, "t1": 3.0, "look": "bw"}, {"t0": 5.0, "t1": 6.0, "look": "bw", "off": True}]
    assert out["transitions"] == [{"t": 2.5, "kind": "blur", "sfx": "assets/sfx/swoosh.mp3"}, {"t": 4.5, "kind": "zoom", "off": True}]
    assert edits.apply(PICTURE_EDIT, {**timeline, "zoom": 0})["zooms"] == [{**z, "level": 1.0} for z in PICTURE_EDIT["zooms"]], "0 — без зума"
    assert PICTURE_EDIT["looks"][1] == {"t0": 5.0, "t1": 6.0, "look": "bw"}, "edit.json сессии не меняется"


def test_switched_off_bw_pieces_and_transitions_are_not_in_the_video():
    from vm import transitions
    from vm.render import look_windows
    from vm.timeline import Timeline

    out = edits.apply(PICTURE_EDIT, {"rev": 1, "edits": [], "looks": [{"at": [2.0, 3.0], "off": True}], "transitions": [{"at": 2.5, "off": True}]})
    tl = Timeline([(0.0, 8.0)], 1.0)
    assert look_windows(out, tl) == look_windows({"looks": [PICTURE_EDIT["looks"][1]]}, tl)
    assert [m.source for m in transitions.marks(out, tl)] == [4.5]


@pytest.mark.parametrize("bad", [{"zoom": 1.6}, {"zoom": -0.1}, {"looks": [{"at": [1.0, 2.0]}]}, {"transitions": [{"at": 1.0, "kind": "spin"}]},
                                 {"transitions": [{"at": 1.0, "off": False}]}])
def test_picture_edits_go_through_the_schema(tmp_path, bad):
    job = Job(tmp_path / "j")
    job.root.mkdir()
    job.write("timeline.json", {"rev": 1, "edits": [], "zoom": 1.5, "looks": [{"at": [1.0, 2.0], "off": True}],
                                "transitions": [{"at": 1.0, "kind": "flash"}, {"at": 2.0, "off": True}]})
    with pytest.raises(ValueError):
        job.write("timeline.json", {"rev": 1, "edits": [], **bad})
