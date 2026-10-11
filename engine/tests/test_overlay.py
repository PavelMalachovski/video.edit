"""События слоя: что рисует шаблон в каждый промежуток финала. Чистая арифметика — без браузера и ffmpeg.

Почти везде ролик целый и без ускорения (`keep = [(0, 10)]`, speed 1): время финала равно времени исходника.
Границы промежутков стоят на сетке кадров 30 к/с, поэтому сравнения — с допуском в долю кадра.
"""
import math
from itertools import pairwise

import pytest

from vm.asr import Word
from vm.overlay import FPS, build_overlay_events
from vm.subs import build_sub_events
from vm.timeline import Timeline

FRAME = 1 / FPS
EPS = 1e-6

STYLE = {
    "font": "montserrat",
    "hand": "caveat",
    "colors": {"text": "#FFFFFF", "accent": "#FFD23F", "bar": "#FFD23F", "plate": "#000000", "outline": "#000000"},
    "subtitles": {"mode": "karaoke", "words": 3, "size": 64, "y": 1300},
    "hook": {"mode": "plate", "size": 72},
    "bar": {"pos": "bottom", "height": 14},
}


def make_edit(**fields):
    edit = {
        "speed": 1.0,
        "keep": [[0.0, 10.0]],
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
    return edit


def timeline(edit):
    return Timeline(edit["keep"], edit["speed"])


def picture(t0, t1, **extra):
    return {"kind": "image", "src": "in/uploads/upload-i1.png", "t0": t0, "t1": t1, "x": 100, "y": 300, "w": 400, **extra}


def at(events, t):
    """Состояние в момент `t` финала."""
    for e in events:
        if e["t0"] - EPS <= t < e["t1"] - EPS:
            return e["state"]
    raise AssertionError(f"no event at {t}")


def words(*items):
    return [{"t0": t0, "t1": t1, "text": text} for t0, t1, text in items]


def test_events_cover_whole_duration_without_overlap():
    edit = make_edit(
        words=words((0.2, 0.6, "Привет"), (0.7, 1.1, "это"), (1.2, 1.6, "монтаж."), (5.0, 5.4, "Пиши"), (5.5, 6.0, "слово")),
        hook={"text": "Как я монтирую", "until": 2.5},
        cta={"lines": ["Пиши в директ"], "word": "монтаж", "t0": 5.0, "t1": 6.5},
        inserts=[picture(3.0, 4.5)],
        hold=0.5,
    )
    tl = timeline(edit)
    events = build_overlay_events(edit, tl)
    assert events[0]["t0"] == 0
    assert events[-1]["t1"] == pytest.approx(tl.duration + 0.5, abs=1e-9)
    for e in events:
        assert e["t1"] > e["t0"]
    for a, b in pairwise(events):
        assert a["t1"] == b["t0"]
        assert a["state"] != b["state"], "equal neighbours are merged"
        assert b["t0"] * FPS == pytest.approx(round(b["t0"] * FPS), abs=1e-6), "inner borders sit on frames"


def test_empty_edit_is_one_empty_event():
    edit = make_edit(hold=0.25)
    tl = timeline(edit)
    assert build_overlay_events(edit, tl) == [{"t0": 0, "t1": pytest.approx(10.25), "state": {}}]


def test_subtitles_hook_and_cta_show_together_where_they_meet():
    edit = make_edit(
        words=words((0.2, 0.6, "раз"), (0.7, 1.1, "два")),
        hook={"text": "Как я монтирую", "until": 2.5},
        cta={"lines": ["Пиши в директ", "слово"], "word": "монтаж", "t0": 6.0, "t1": 8.0},
    )
    events = build_overlay_events(edit, timeline(edit))
    early = at(events, 0.3)
    assert early["hook"] == {"text": "Как я монтирую"}
    assert early["sub"] == {"words": ["раз", "два"], "active": 0, "visible": 2}
    assert "hook" not in at(events, 2.6)
    assert at(events, 7.0)["cta"] == {"lines": ["Пиши в директ", "слово"], "word": "монтаж"}
    assert "cta" not in at(events, 8.1)


def test_subtitles_are_the_engine_events_on_the_frame_grid():
    edit = make_edit(words=words((0.2, 0.6, "раз"), (0.7, 1.1, "два"), (1.2, 1.6, "три."), (3.0, 3.4, "четыре")))
    tl = timeline(edit)
    events = build_overlay_events(edit, tl)
    subs = build_sub_events([Word(w["t0"], w["t1"], w["text"]) for w in edit["words"]], tl, "karaoke", 3)
    for s in subs:
        middle = (round(s["t0"] * FPS) + round(s["t1"] * FPS)) / 2 / FPS
        assert at(events, middle)["sub"] == {k: s[k] for k in ("words", "active", "visible")}


def test_insert_appearance_has_three_anim_steps():
    edit = make_edit(inserts=[picture(4.0, 7.0)])
    events = build_overlay_events(edit, timeline(edit))
    start = next(i for i, e in enumerate(events) if e["state"].get("inserts"))
    first, second, third = events[start : start + 3]
    assert first["t0"] == pytest.approx(4.0)
    assert [e["state"]["inserts"][0]["anim"] for e in (first, second, third)] == pytest.approx([1 / 3, 2 / 3, 1])
    assert first["t1"] - first["t0"] == pytest.approx(FRAME)
    assert second["t1"] - second["t0"] == pytest.approx(FRAME)
    assert third["t0"] == pytest.approx(4.0 + 2 * FRAME)
    assert third["t1"] == pytest.approx(7.0)
    assert at(events, 7.0 + FRAME) == {}


def test_insert_state_carries_what_the_template_needs():
    edit = make_edit(inserts=[picture(4.0, 7.0, title="Скрин", params={"cutout": True}, sfx="swoosh")])
    state = at(build_overlay_events(edit, timeline(edit)), 5.0)
    assert state["inserts"] == [
        {
            "kind": "image",
            "src": "in/uploads/upload-i1.png",
            "title": "Скрин",
            "x": 100,
            "y": 300,
            "w": 400,
            "params": {"cutout": True},
            "n": 0,
            "anim": 1,
            "t": 0,
        }
    ]


def test_insert_pushed_after_hook():
    edit = make_edit(hook={"text": "Хук", "until": 2.5}, inserts=[picture(1.0, 5.0)])
    events = build_overlay_events(edit, timeline(edit))
    shown = [e for e in events if e["state"].get("inserts")]
    assert shown[0]["t0"] == pytest.approx(2.5)
    assert all("hook" not in e["state"] for e in shown)
    assert shown[-1]["t1"] == pytest.approx(5.0)


def test_insert_min_show_1_5s():
    edit = make_edit(inserts=[picture(4.0, 4.5)])
    events = build_overlay_events(edit, timeline(edit))
    shown = [e for e in events if e["state"].get("inserts")]
    assert shown[0]["t0"] == pytest.approx(4.0)
    assert shown[-1]["t1"] == pytest.approx(5.5)


def test_insert_pushed_after_hook_still_shows_1_5s():
    edit = make_edit(hook={"text": "Хук", "until": 2.5}, inserts=[picture(1.0, 2.0)])
    events = build_overlay_events(edit, timeline(edit))
    shown = [e for e in events if e["state"].get("inserts")]
    assert (shown[0]["t0"], shown[-1]["t1"]) == pytest.approx((2.5, 4.0))


def test_thesis_sticker_is_drawn_by_the_template():
    sticker = {"kind": "text", "id": "s1", "text": "3 ошибки 🔥", "t0": 4.0, "t1": 7.0, "x": 120, "y": 700, "w": 420, "sfx": None,
               "params": {"tone": "dark"}}
    edit = make_edit(inserts=[sticker])
    state = at(build_overlay_events(edit, timeline(edit)), 5.0)
    assert state["inserts"] == [{"kind": "text", "text": "3 ошибки 🔥", "x": 120, "y": 700, "w": 420, "params": {"tone": "dark"},
                                 "n": 0, "anim": 1, "t": 0}]


def test_fullscreen_inserts_are_left_to_ffmpeg():
    edit = make_edit(inserts=[{"kind": "fullscreen", "src": "in/uploads/upload-i1.mov", "t0": 3.0, "t1": 5.0}])
    assert build_overlay_events(edit, timeline(edit)) == [{"t0": 0, "t1": pytest.approx(10.0), "state": {}}]


def test_anim_insert_changes_every_frame():
    edit = make_edit(inserts=[{"kind": "anim", "t0": 4.0, "t1": 5.5, "x": 100, "y": 300, "w": 384, "params": {"name": "bachata"}}])
    events = build_overlay_events(edit, timeline(edit))
    shown = [e for e in events if e["state"].get("inserts")]
    assert len(shown) == 45
    for i, e in enumerate(shown):
        assert e["t1"] - e["t0"] == pytest.approx(FRAME)
        assert e["state"]["inserts"][0]["t"] == pytest.approx(i * FRAME)


def test_hold_keeps_the_last_state():
    edit = make_edit(cta={"lines": ["Пиши"], "word": "слово", "t0": 8.0, "t1": 10.0}, hold=1.0)
    events = build_overlay_events(edit, timeline(edit))
    assert events[-1]["t1"] == pytest.approx(11.0)
    assert events[-1]["state"]["cta"] == {"lines": ["Пиши"], "word": "слово"}
    assert events[-1]["t0"] == pytest.approx(8.0)


def test_times_are_source_times_moved_by_the_timeline():
    # исходник: [0, 2] и [3, 5], ускорение 1.1 — финал 4/1.1 с
    edit = make_edit(
        keep=[[0.0, 2.0], [3.0, 5.0]],
        speed=1.1,
        hook={"text": "Хук", "until": 1.1},
        cta={"lines": ["Пиши"], "word": "слово", "t0": 3.3, "t1": 4.4},
        inserts=[picture(2.5, 5.0)],  # начало вырезано — встаёт на начало второго отрезка
    )
    tl = timeline(edit)
    events = build_overlay_events(edit, tl)
    def on_grid(t):
        return round(t * FPS) / FPS

    assert at(events, 0.0)["hook"] == {"text": "Хук"}
    assert "hook" not in at(events, on_grid(1.1 / 1.1))
    shown = [e for e in events if e["state"].get("inserts")]
    assert shown[0]["t0"] == pytest.approx(on_grid(2.0 / 1.1))
    assert shown[-1]["t1"] == pytest.approx(tl.duration)
    cta = [e for e in events if "cta" in e["state"]]
    assert (cta[0]["t0"], cta[-1]["t1"]) == pytest.approx((on_grid(2.3 / 1.1), on_grid(3.4 / 1.1)))


def test_nothing_new_appears_on_the_freeze_frame():
    # титр и вставка целиком в вырезанном хвосте: в ролике их не видно — не появляются и на стоп-кадре
    edit = make_edit(
        keep=[[0.0, 8.0]],
        cta={"lines": ["Пиши"], "word": "слово", "t0": 8.5, "t1": 9.5},
        inserts=[picture(8.6, 9.0)],
        hold=1.0,
    )
    events = build_overlay_events(edit, timeline(edit))
    assert all(e["state"] == {} for e in events), events


def test_hook_and_cta_inside_cuts_move_to_the_next_kept_moment():
    # keep [0,2] и [3,5]: конец хука в вырезке → начало второго отрезка; титр 2.2–4.0 → 2.0–3.0 финала
    edit = make_edit(
        keep=[[0.0, 2.0], [3.0, 5.0]],
        hook={"text": "Хук", "until": 2.5},
        cta={"lines": ["Пиши"], "word": "слово", "t0": 2.2, "t1": 4.0},
    )
    events = build_overlay_events(edit, timeline(edit))
    hook = [e for e in events if "hook" in e["state"]]
    cta = [e for e in events if "cta" in e["state"]]
    assert (hook[0]["t0"], hook[-1]["t1"]) == pytest.approx((0.0, 2.0))
    assert (cta[0]["t0"], cta[-1]["t1"]) == pytest.approx((2.0, 3.0))


def test_insert_inside_a_cut_shows_at_the_next_kept_moment():
    # вставку поставили на момент, который вырезали: она появляется там, где ролик продолжается, на 1,5 с
    edit = make_edit(keep=[[0.0, 5.0], [8.0, 15.0]], inserts=[picture(6.0, 7.0)])
    shown = [e for e in build_overlay_events(edit, timeline(edit)) if e["state"].get("inserts")]
    assert (shown[0]["t0"], shown[-1]["t1"]) == pytest.approx((5.0, 6.5))


def test_insert_needs_a_place():
    edit = make_edit(inserts=[picture(1.0, 2.0), {"kind": "badge", "text": "Чешский", "t0": 3.0, "t1": 5.0, "y": 100, "w": 300}])
    with pytest.raises(ValueError, match=r"inserts\[1\].*x"):
        build_overlay_events(edit, timeline(edit))


def test_short_subtitle_between_frames_does_not_break_the_grid():
    # слово короче кадра: событие либо занимает целый кадр, либо пропадает, но сетка не рвётся
    edit = make_edit(words=words((1.0, 1.01, "а"), (1.012, 1.4, "вот")))
    events = build_overlay_events(edit, timeline(edit))
    for e in events[1:]:
        assert math.isclose(e["t0"] * FPS, round(e["t0"] * FPS), abs_tol=1e-6)


# ---------- финальная карточка ----------

END = {"seconds": 2.0, "lines": ["Подпишись 👇"], "handle": "@pavel", "logo": "in/brand/logo.png", "sfx": None}


def test_end_card_comes_after_the_hold_frame_by_frame():
    words = [{"t0": 9.0, "t1": 9.8, "text": "конец"}]
    edit = make_edit(hold=0.5, end=END, words=words, cta={"lines": ["ПИШИ"], "word": "план", "t0": 9.0, "t1": 10.0})
    tl = timeline(edit)
    events = build_overlay_events(edit, tl)
    assert events[-1]["t1"] == pytest.approx(tl.duration + 0.5 + 2.0)
    assert "cta" in at(events, 10.2) and "sub" in at(events, 10.2), "на стоп-кадре — то, что было в последний кадр"
    card = [e for e in events if "end" in e["state"]]
    assert card[0]["t0"] == pytest.approx(10.5)
    assert len(card) == 60, "каждый кадр карточки свой: она дышит"
    assert card[0]["state"] == {"end": {"lines": ["Подпишись 👇"], "handle": "@pavel", "logo": "in/brand/logo.png", "t": 0}}
    assert card[1]["state"]["end"]["t"] == pytest.approx(FRAME)
    assert all(set(e["state"]) == {"end"} for e in card), "на карточке нет ни субтитров, ни титра, ни вставок"


def test_end_card_without_hold_starts_right_after_the_video():
    edit = make_edit(end={**END, "seconds": 1.5, "handle": None, "logo": None})
    events = build_overlay_events(edit, timeline(edit))
    card = [e for e in events if "end" in e["state"]]
    assert card[0]["t0"] == pytest.approx(10.0) and card[-1]["t1"] == pytest.approx(11.5)
    assert card[0]["state"]["end"] == {"lines": ["Подпишись 👇"], "t": 0}
