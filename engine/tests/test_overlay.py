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


# ---------- тизер ----------


def test_with_a_teaser_the_hook_stays_over_the_whole_teaser_and_inserts_keep_their_phrase():
    edit = make_edit(teaser={"t0": 6.0, "t1": 8.0, "sfx": None}, hook={"text": "Главное правило", "until": 1.0},
                     inserts=[picture(0.5, 4.0)])
    tl = Timeline(edit["keep"], edit["speed"], teaser=(6.0, 8.0))
    events = build_overlay_events(edit, tl)
    assert "hook" in at(events, 1.9) and "hook" not in at(events, 2.05), "хук — весь тизер, до 2 с"
    assert at(events, 2.6).get("inserts") and not at(events, 2.4).get("inserts"), "вставка — на своей фразе после тизера"
    assert events[-1]["t1"] == pytest.approx(12.0)


# ---------- стиль эталона: субтитры soft, хук accent, акцентные фразы ----------

SOFT_STYLE = {
    **STYLE,
    "font": "forum",
    "subtitles": {"mode": "soft", "words": 3, "size": 64, "y": 1440},
    "hook": {"mode": "accent", "size": 100, "y": 420},
}

SIX = words((1.0, 1.2, "Я"), (1.3, 1.5, "покупаю"), (1.6, 1.8, "вещи,"), (1.9, 2.1, "чтобы"), (2.2, 2.4, "выглядеть"),
            (2.5, 2.7, "плохо."))


def frame_states(events, t0, t1):
    """Состояния кадров с t0 по t1 (секунды финала) — по одному на кадр."""
    return [at(events, (f + 0.5) / FPS) for f in range(round(t0 * FPS), round(t1 * FPS))]


def test_soft_subtitles_carry_their_lines_and_the_newest_line_slides_in():
    edit = make_edit(words=SIX, style=SOFT_STYLE)
    events = build_overlay_events(edit, timeline(edit))
    texts = [w["text"] for w in SIX]
    first = frame_states(events, 1.0, 1.2)
    assert first[0]["sub"] == {"words": texts, "active": 0, "visible": 3, "lines": [3, 3], "t": pytest.approx(FRAME)}
    assert [s["sub"].get("t") for s in first[:5]] == pytest.approx([FRAME, 2 * FRAME, 3 * FRAME, 4 * FRAME, None])
    second = at(events, 1.9 + FRAME / 2)["sub"]
    assert second["visible"] == 6 and second["t"] == pytest.approx(FRAME)
    assert "t" not in at(events, 2.5)["sub"], "строка появилась — дальше кадры одинаковые и склеиваются"


def test_hook_in_accent_mode_comes_out_of_blur_frame_by_frame():
    edit = make_edit(words=SIX, style=SOFT_STYLE, hook={"text": "я покупаю вещи", "until": 2.0})
    events = build_overlay_events(edit, timeline(edit))
    hooks = [s["hook"] for s in frame_states(events, 0.0, 0.5)]
    assert hooks[0] == {"text": "я покупаю вещи", "t": pytest.approx(FRAME)}
    assert hooks[7]["t"] == pytest.approx(8 * FRAME)
    assert "t" not in hooks[8] and hooks[8] == {"text": "я покупаю вещи"}


def test_plate_hook_has_no_animation_time():
    edit = make_edit(hook={"text": "Как я монтирую", "until": 2.5})
    assert at(build_overlay_events(edit, timeline(edit)), 0.01)["hook"] == {"text": "Как я монтирую"}


def accent(t0, t1, *lines, **extra):
    return {"t0": t0, "t1": t1, "lines": [{"text": text} for text in lines], "x": 480, "y": 900, **extra}


def test_accent_shows_its_words_instead_of_subtitles():
    edit = make_edit(words=SIX, style=SOFT_STYLE, accents=[accent(1.9, 2.4, "чтобы", "выглядеть")])
    events = build_overlay_events(edit, timeline(edit))
    during = at(events, 2.2)
    assert "sub" not in during, "пока акцент на экране, мелких субтитров нет"
    assert during["accent"]["lines"] == [{"text": "чтобы"}, {"text": "выглядеть"}]
    assert (during["accent"]["x"], during["accent"]["y"]) == (480, 900)
    shown = {w for e in events for w in e["state"].get("sub", {}).get("words", [])}
    assert "чтобы" not in shown and "выглядеть" not in shown, "слова акцента в субтитры не идут"
    assert at(events, 2.55)["sub"]["words"] == ["плохо."]
    assert at(events, 1.7)["sub"]["words"] == ["Я", "покупаю", "вещи,"]


def test_accent_lines_appear_with_their_words():
    edit = make_edit(words=SIX, style=SOFT_STYLE, accents=[accent(1.9, 2.4, "чтобы", "Выглядеть!")])
    events = build_overlay_events(edit, timeline(edit))
    states = frame_states(events, 1.9, 2.4)
    assert states[0]["accent"]["ages"] == [pytest.approx(FRAME), None], "вторая строка ждёт своего слова"
    line2 = round((2.2 - 1.9) * FPS)
    assert states[line2 - 1]["accent"]["ages"][1] is None
    assert states[line2]["accent"]["ages"][1] == pytest.approx(FRAME), "строка появилась со словом «выглядеть»"
    assert states[0]["accent"]["anim"] == "blur" and states[0]["accent"]["out"] == "fade"


def test_accent_line_without_its_word_appears_with_the_line_before():
    edit = make_edit(words=SIX, style=SOFT_STYLE, accents=[accent(1.9, 2.4, "чтобы", "некрасиво")])
    events = build_overlay_events(edit, timeline(edit))
    assert at(events, 1.9 + FRAME / 2)["accent"]["ages"] == [pytest.approx(FRAME), pytest.approx(FRAME)]


def test_accent_animation_ends_and_frames_merge():
    edit = make_edit(words=SIX, style=SOFT_STYLE, accents=[accent(1.0, 1.8, "я покупаю вещи")])
    events = build_overlay_events(edit, timeline(edit))
    ages = [s["accent"]["ages"][0] for s in frame_states(events, 1.0, 1.6)]
    moving = [a for a in ages if a < 1]
    assert 7 <= len(moving) <= 9, f"появление из размытия — кадр за кадром ({len(moving)} кадров)"
    assert len({a for a in ages if a >= 1}) == 1, "потом строка стоит — кадры одинаковые"


def test_typewriter_accent_ticks_until_the_line_is_typed():
    edit = make_edit(words=SIX, style=SOFT_STYLE, accents=[accent(1.0, 1.8, "я покупаю вещи", anim="type")])
    events = build_overlay_events(edit, timeline(edit))
    ages = [s["accent"]["ages"][0] for s in frame_states(events, 1.0, 2.0) if "accent" in s]
    typing = [a for a in ages if a < 5]
    assert len(typing) >= round((len("я покупаю вещи") / 30 + 0.25) * FPS), "печать и курсор — кадр за кадром"


def test_accent_leaves_before_the_next_subtitle_or_a_beat_after_its_phrase():
    edit = make_edit(words=SIX, style=SOFT_STYLE, accents=[accent(1.9, 2.4, "чтобы выглядеть")])
    events = build_overlay_events(edit, timeline(edit))
    assert "accent" in at(events, 2.45) and "accent" not in at(events, 2.5 + FRAME / 2), "до субтитров «плохо»"
    leaving = [s["accent"]["leave"] for s in frame_states(events, 2.3, 2.5) if "leave" in s.get("accent", {})]
    assert leaving == pytest.approx([0.25, 0.5, 0.75, 1.0]), "уход — растворение за 4 кадра"
    alone = make_edit(words=SIX[:4], style=SOFT_STYLE, accents=[accent(1.9, 2.1, "чтобы", out="cut")])
    events = build_overlay_events(alone, timeline(alone))
    assert "accent" in at(events, 2.35) and "accent" not in at(events, 2.42), "без субтитров следом — ещё 0,3 с"
    assert not any("leave" in e["state"].get("accent", {}) for e in events), "out: cut — без ухода"


def test_accent_follows_the_cuts_and_the_speed():
    edit = make_edit(words=SIX, style=SOFT_STYLE, keep=[[0.0, 1.0], [1.5, 10.0]], speed=1.25,
                     accents=[accent(1.9, 2.4, "чтобы", "выглядеть")])
    tl = timeline(edit)
    events = build_overlay_events(edit, tl)
    start = tl.to_final_snap(1.9)
    assert "accent" in at(events, start + FRAME / 2) and "accent" not in at(events, start - FRAME)
    second = round(tl.to_final_snap(2.2) * FPS)
    assert at(events, (second + 0.5) / FPS)["accent"]["ages"][1] == pytest.approx(FRAME)


def test_accent_words_are_kept_in_the_srt():
    from vm.subs import to_srt

    edit = make_edit(words=SIX, style=SOFT_STYLE, accents=[accent(1.9, 2.4, "чтобы выглядеть")])
    srt = to_srt([Word(w["t0"], w["t1"], w["text"]) for w in edit["words"]], timeline(edit))
    assert "чтобы выглядеть" in srt


def test_the_ads_version_draws_every_frame_in_the_ads_zone():
    tl = Timeline([(0.0, 4.0)], 1.0)
    events = build_overlay_events(make_edit(zone="ads", hold=0.5, end={"seconds": 1.0, "lines": ["Сохрани"]}), tl)
    assert events and all(e["state"].get("zone") == "ads" for e in events)
    assert all("zone" not in e["state"] for e in build_overlay_events(make_edit(), tl)), "обычный ролик — без зоны"
