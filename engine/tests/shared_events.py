"""Общая фикстура движка и страницы — превью в редакторе рисует то же, что финал: события субтитров и слоя
(engine/vm/subs.py, engine/vm/overlay.py ↔ web/lib/subs.ts, web/lib/overlay.ts), картинка — зум, переходы, ч/б, вспышка и
смаз по кадрам (engine/vm/zoom.py, transitions.py, render.py ↔ web/lib/zoom.ts, web/lib/picture.ts), доли музыки
(beats.py ↔ web/lib/beats.ts), текст руками (edits.py ↔ web/lib/edits.ts).

Здесь — входы случаев; ожидаемое считает движок. Записать фикстуру заново (после правки движка — и переноса на TS):
    cd engine && python3 -m tests.shared_events
Тесты обеих сторон сверяют с ней (test_overlay.py, web/tests/overlay.test.ts).
"""
import json
import math
import sys
from pathlib import Path

from vm import beats, edits, transitions
from vm.asr import Word
from vm.overlay import FPS, build_overlay_events, insert_spans
from vm.render import BW_CSS_BRIGHTNESS, BW_CSS_CONTRAST, look_windows
from vm.render import timeline as render_timeline
from vm.subs import build_sub_events
from vm.timeline import Timeline
from vm.zoom import TRANS, zoom_at

PATH = Path(__file__).parent / "fixtures" / "overlay-events.json"
NOTE = (
    "Для одних и тех же входов — что считает движок; страница повторяет число в число. subs — события субтитров "
    "(build_sub_events ↔ web/lib/subs.ts); overlay — события слоя и кадры показа вставок (build_overlay_events, "
    "insert_spans ↔ web/lib/overlay.ts); render — шкала, на которой монтаж строит слой (render.timeline ↔ "
    "renderTimeline): края keep и тизера на целых кадрах, не дальше последнего кадра исходника (limit); look — картинка "
    "(web/lib/zoom.ts): зум (zoom_at), переходы на стыках (transitions.marks), ч/б-куски — кадры (look_windows), "
    "вспышка и смаз у каждого стыка по кадрам финала [n, значение] (transitions.flash_alpha — белизна 0..1, blur_sigma — "
    "sigma смаза по x, px кадра 1080); bwFilter — CSS-фильтр ч/б-кадра в превью: grayscale(1) brightness contrast "
    "(render.BW_CSS_BRIGHTNESS, BW_CSS_CONTRAST ↔ BW_FILTER в web/lib/picture.ts); beats — доли музыки в ролике и "
    "что на них встаёт (web/lib/beats.ts); text — текст и вставки руками (edits.apply_text ↔ web/lib/edits.ts). "
    "Времена слов и edit — по исходнику, событий — секунды финала; keep — в порядке финала. Пишет "
    "engine/tests/shared_events.py (python3 -m tests.shared_events из engine/)."
)


def say(text: str, start: float = 0.0, step: float = 0.32, gap: float = 0.04, pause: float = 0.5) -> list[dict]:
    """Слова фразы с временем: каждое `step` с, между словами `gap`; «|» — пауза `pause`."""
    out, t = [], start
    for token in text.split():
        if token == "|":
            t += pause
            continue
        out.append({"t0": round(t, 3), "t1": round(t + step, 3), "text": token})
        t += step + gap
    return out


SPEECH = say("Привет, это мой новый ролик. | Сегодня расскажу, как я снимаю видео на телефон | и монтирую его за пять минут!", 0.4)
# слова с подвохом: время на половине кадра (0.35 · 30 = 10.5 — округление к чётному), 1/128 с, конец слова за началом
# следующего, два слова с одним началом, кавычка после точки, многоточие, слово в самом конце
TRICKY = [
    {"t0": 0.0078125, "t1": 0.35, "text": "Ну"},
    {"t0": 0.35, "t1": 0.7, "text": "что,"},
    {"t0": 0.7, "t1": 1.05, "text": "поехали…"},
    {"t0": 1.2, "t1": 1.6, "text": "Он"},
    {"t0": 1.5, "t1": 1.9, "text": "сказал:"},
    {"t0": 1.9, "t1": 2.2, "text": "«стоп.»"},
    {"t0": 2.2, "t1": 2.2, "text": "Я"},
    {"t0": 2.2, "t1": 2.45, "text": "не"},
    {"t0": 2.45, "t1": 2.8, "text": "стал"},
    {"t0": 2.85, "t1": 3.4, "text": "спорить."},
    {"t0": 3.45, "t1": 3.9, "text": "Конец"},
]

SUBS = [
    {"name": "karaoke, three words, a cut and speed", "words": SPEECH, "keep": [[0.3, 2.5], [2.9, 9.5]], "speed": 1.1,
     "teaser": None, "mode": "karaoke", "n": 3},
    {"name": "plate, four words", "words": SPEECH, "keep": [[0.3, 9.5]], "speed": 1.0, "teaser": None, "mode": "plate", "n": 4},
    {"name": "word by word", "words": SPEECH, "keep": [[0.3, 9.5]], "speed": 1.2, "teaser": None, "mode": "word", "n": 1},
    {"name": "accumulate", "words": SPEECH, "keep": [[0.3, 4.0], [4.6, 9.5]], "speed": 1.1, "teaser": None, "mode": "accumulate", "n": 3},
    {"name": "soft, two lines of three, accent words hidden", "words": SPEECH, "keep": [[0.3, 9.5]], "speed": 1.1, "teaser": None,
     "mode": "soft", "n": 3, "hidden": [[5.0, 6.2]]},
    {"name": "soft with a teaser", "words": SPEECH, "keep": [[0.3, 9.5]], "speed": 1.1, "teaser": [3.3, 4.8], "mode": "soft", "n": 2},
    {"name": "karaoke with a teaser", "words": SPEECH, "keep": [[0.3, 3.0], [3.3, 9.5]], "speed": 1.1, "teaser": [3.3, 4.8],
     "mode": "karaoke", "n": 3},
    {"name": "pieces reordered by hand: a new phrase at each run", "words": SPEECH, "keep": [[4.6, 7.0], [0.3, 2.5], [7.0, 9.5]],
     "speed": 1.1, "teaser": None, "mode": "karaoke", "n": 3},
    {"name": "reordered, accent words hidden only in their run", "words": SPEECH, "keep": [[4.6, 7.0], [0.3, 4.6], [7.0, 9.5]],
     "speed": 1.0, "teaser": None, "mode": "soft", "n": 3, "hidden": [[5.0, 6.2]]},
    {"name": "tricky times and sentence ends", "words": TRICKY, "keep": [[0.0, 3.0], [3.2, 3.9]], "speed": 1.0, "teaser": None,
     "mode": "soft", "n": 2},
    {"name": "tricky times, karaoke at speed", "words": TRICKY, "keep": [[0.0, 3.9]], "speed": 1.15, "teaser": None, "mode": "karaoke", "n": 2},
    {"name": "a word with its middle cut is left out", "words": SPEECH, "keep": [[0.3, 1.2], [1.6, 9.5]], "speed": 1.0, "teaser": None,
     "mode": "plate", "n": 3},
    {"name": "no words", "words": [], "keep": [[0.0, 2.0]], "speed": 1.0, "teaser": None, "mode": "soft", "n": 3},
]
SUBS_REFUSED = [
    {"mode": "fancy", "n": 3},
    {"mode": "karaoke", "n": 0},
    {"mode": "plate", "n": 7},
    {"mode": "soft", "n": 0},
]


def _style(mode: str, n: int, hook: str = "accent") -> dict:
    return {"subtitles": {"mode": mode, "words": n}, "hook": {"mode": hook}}


ACCENT = {"t0": 5.0, "t1": 6.2, "x": 540, "y": 860,
          "lines": [{"text": "как я"}, {"text": "снимаю", "size": "big", "color": "accent"}, {"text": "видео"}]}

OVERLAY = [
    {"name": "style of the reference: soft, hook accent, accent phrase, title, inserts, still frame and end card",
     "keep": [[0.3, 2.5], [2.9, 9.5]], "speed": 1.1, "teaser": None,
     "edit": {"words": SPEECH, "style": _style("soft", 3),
              "hook": {"text": "Как я снимаю", "until": 2.0},
              "accents": [ACCENT],
              "cta": {"t0": 7.2, "t1": 8.6, "lines": ["Пиши в комментариях"], "word": "ВИДЕО"},
              "inserts": [{"kind": "image", "src": "assets/logos/tg.png", "t0": 1.0, "t1": 2.2, "x": 600, "y": 300, "w": 300},
                          {"kind": "image", "src": "c.png", "t0": 3.0, "t1": 4.0, "x": 100, "y": 100, "w": 300, "off": True},
                          {"kind": "sticker", "text": "5 минут", "t0": 8.8, "t1": 9.3, "x": 120, "y": 1100, "w": 400}],
              "hold": 0.4, "end": {"seconds": 1.5, "lines": ["Подпишись 🔥"], "handle": "@pavel", "logo": "brand/logo.png"}}},
    {"name": "karaoke with a teaser, plate hook, badge and animation inserts, version for ads",
     "keep": [[0.3, 3.0], [3.3, 9.5]], "speed": 1.1, "teaser": [3.3, 4.8],
     "edit": {"words": SPEECH, "style": _style("karaoke", 3, "plate"),
              "hook": {"text": "Снимаю на телефон", "until": 5.0},
              "inserts": [{"kind": "badge", "text": "iPhone", "title": "Камера", "t0": 2.0, "t1": 3.0, "x": 100, "y": 500, "w": 380},
                          {"kind": "anim", "src": "anims/arrow.json", "params": {"color": "#FFD23F"}, "t0": 6.0, "t1": 6.6,
                           "x": 300, "y": 700, "w": 480},
                          {"kind": "fullscreen", "src": "jobs/x/in/demo.mp4", "t0": 7.0, "t1": 8.0}],
              "zone": "ads"}},
    {"name": "pieces reordered by hand: accent typed in a moved piece, insert across a run, title in a moved piece",
     "keep": [[4.6, 7.0], [0.3, 4.6], [7.0, 9.5]], "speed": 1.0, "teaser": None,
     "edit": {"words": SPEECH, "style": _style("accumulate", 3, "outline"),
              "hook": {"text": "Как я снимаю", "until": 1.5},
              "accents": [{**ACCENT, "anim": "type", "out": "cut"}],
              "cta": {"t0": 5.2, "t1": 6.8, "lines": ["Сохрани"], "word": "ПОТОМ"},
              "inserts": [{"kind": "text", "text": "Шаг 1", "t0": 6.5, "t1": 8.0, "x": 200, "y": 400, "w": 500}]}},
    {"name": "two accents close together: letters and track, lines whose words are not found, zoom out",
     "keep": [[0.3, 9.5]], "speed": 1.0, "teaser": None,
     "edit": {"words": SPEECH, "style": _style("soft", 2),
              "accents": [{"t0": 2.6, "t1": 3.4, "x": 540, "y": 800, "anim": "letters", "out": "zoom",
                           "lines": [{"text": "Сегодня"}, {"text": "расскажу"}]},
                          {"t0": 3.5, "t1": 4.9, "x": 540, "y": 900, "anim": "track",
                           "lines": [{"text": "как я"}, {"text": "ловлю рыбу"}, {"text": "видео"}]}]}},
    {"name": "things at the very end stay on the still frame; an accent there does not leave",
     "keep": [[0.3, 9.5]], "speed": 1.25, "teaser": None,
     "edit": {"words": SPEECH, "style": _style("word", 1, "shadow"),
              "accents": [{"t0": 8.2, "t1": 9.5, "x": 540, "y": 900, "lines": [{"text": "пять"}, {"text": "минут!"}]}],
              "inserts": [{"kind": "image", "src": "a.png", "t0": 9.0, "t1": 9.6, "x": 100, "y": 100, "w": 300},
                          {"kind": "image", "src": "b.png", "t0": 9.7, "t1": 10.0, "x": 100, "y": 100, "w": 300}],
              "hold": 0.6}},
    {"name": "tricky times: half-frame rounding, overlapping words",
     "keep": [[0.0, 3.0], [3.2, 3.9]], "speed": 1.0, "teaser": None,
     "edit": {"words": TRICKY, "style": _style("soft", 2), "hook": {"text": "Ну что", "until": 0.35},
              "end": {"seconds": 1.0, "lines": ["Пока"]}}},
    {"name": "nothing to draw", "keep": [[0.0, 2.0]], "speed": 1.0, "teaser": None,
     "edit": {"words": [], "style": _style("karaoke", 3)}},
]
OVERLAY_REFUSED = [
    {"name": "an insert drawn by the layer needs a place on the frame",
     "keep": [[0.0, 3.0]], "speed": 1.0, "teaser": None,
     "edit": {"words": [], "style": _style("karaoke", 3), "inserts": [{"kind": "image", "src": "a.png", "t0": 0.5, "t1": 1.5, "x": 10, "y": 10}]}},
]


RENDER = [
    {"name": "edges on whole frames", "keep": [[0.012, 1.005], [2.016, 3.333]], "speed": 1.1, "teaser": None, "limit": None},
    {"name": "a half frame rounds to even", "keep": [[0.05, 0.35], [0.85, 2.15]], "speed": 1.0, "teaser": None, "limit": None},
    {"name": "nothing past the last frame of the source", "keep": [[0.0, 2.0], [3.0, 5.0]], "speed": 1.25, "teaser": None, "limit": 4.99},
    {"name": "a piece shorter than a frame disappears", "keep": [[0.0, 1.0], [1.5, 1.51], [2.0, 3.0]], "speed": 1.0, "teaser": None,
     "limit": None},
    {"name": "pieces reordered by hand", "keep": [[4.613, 7.0], [0.3, 2.512], [7.0, 9.5]], "speed": 1.1, "teaser": None, "limit": 9.48},
    {"name": "teaser on whole frames", "keep": [[0.3, 9.5]], "speed": 1.1, "teaser": {"t0": 3.31, "t1": 4.795}, "limit": 10.0},
]
RENDER_REFUSED = [
    {"name": "teaser end before its start", "keep": [[0.0, 9.0]], "speed": 1.0, "teaser": {"t0": 3.0, "t1": 2.0}, "limit": None},
    {"name": "teaser too short", "keep": [[0.0, 9.0]], "speed": 1.0, "teaser": {"t0": 3.0, "t1": 3.6}, "limit": None},
    {"name": "teaser too long", "keep": [[0.0, 9.0]], "speed": 1.0, "teaser": {"t0": 1.0, "t1": 6.5}, "limit": None},
    {"name": "teaser past the end of the source", "keep": [[0.0, 3.0]], "speed": 1.0, "teaser": {"t0": 4.0, "t1": 6.0}, "limit": 3.0},
]


def render_case(case: dict) -> dict:
    """Шкала монтажа по keep, скорости и тизеру edit.json и длине исходника."""
    tl = render_timeline({"keep": case["keep"], "speed": case["speed"], "teaser": case["teaser"]}, case["limit"])
    return {"segments": [list(s) for s in tl.segments], "teaserSpan": list(tl.teaser) if tl.teaser else None, "duration": tl.duration}


# Зум (zoom.zoom_at: ступени по смыслу, смены крупности, наезды, толчки переходов zoom), переходы на стыках
# (transitions.marks), ч/б-куски (render.look_windows), вспышка и смаз по кадрам (transitions.flash_alpha, blur_sigma) —
# для превью картинки в редакторе (web/lib/zoom.ts)
LOOK = [
    {"name": "steps by meaning, a sharp change of shot at a cut, a slow push-in; zoom and flash transitions",
     "keep": [[0.0, 3.0], [3.4, 8.0]], "speed": 1.1, "teaser": None,
     "edit": {"zooms": [{"t": 0.8, "level": 1.08}, {"t": 3.45, "level": 1.25, "over": 0}, {"t": 5.0, "level": 1.3, "over": 2.5},
                        {"t": 6.9, "level": 1.0}],
              "transitions": [{"t": 3.2, "kind": "zoom"}, {"t": 6.0, "kind": "flash"}, {"t": 0.05, "kind": "blur"}],
              "looks": [{"t0": 1.0, "t1": 2.9, "look": "bw"}, {"t0": 6.5, "t1": 6.4, "look": "bw"}]}},
    {"name": "pieces reordered by hand: each run starts at the level of its first moment in source order",
     "keep": [[4.0, 6.0], [0.0, 4.0], [6.0, 8.0]], "speed": 1.0, "teaser": None,
     "edit": {"zooms": [{"t": 1.0, "level": 1.16}, {"t": 4.5, "level": 1.2, "over": 0}],
              "transitions": [{"t": 4.0, "kind": "zoom"}], "looks": [{"t0": 4.2, "t1": 5.0, "look": "bw"}]}},
    {"name": "with a teaser: a look in the teaser phrase shows in the teaser too; levels clamp to their range",
     "keep": [[0.0, 9.0]], "speed": 1.25, "teaser": [5.0, 7.0],
     "edit": {"zooms": [{"t": 2.0, "level": 2.0}, {"t": 6.0, "level": 0.5, "over": 1.0}], "transitions": [{"t": 3.0, "kind": "blur"}],
              "looks": [{"t0": 5.5, "t1": 6.5, "look": "bw"}]}},
    # окно с 0,9 — ровно кадр 27; с 3,7 — а время кадра 111 в double чуть меньше, он вне окна; 4,1 / (1/30) =
    # 122,99… — белый кадр с кадра 122, и метка его кадра 6 сбивается на 129; ступень смаза с 7,4 — кадр 222 без неё
    {"name": "flash and blur by whole frames: window edges on a frame and next to one, white frame stamps cut to a frame",
     "keep": [[0.0, 10.0]], "speed": 1.0, "teaser": None,
     "edit": {"zooms": [{"t": 2.0, "level": 1.1}],
              "transitions": [{"t": 1.02, "kind": "flash"}, {"t": 2.5, "kind": "zoom"}, {"t": 3.82, "kind": "blur"},
                              {"t": 4.22, "kind": "flash"}, {"t": 7.48, "kind": "blur"}, {"t": 8.32, "kind": "flash"}],
              "looks": []}},
]


# Монтаж в такт (render.on_beats без чтения файла: доли трека — как в beats.json): доли во времени ролика
# (beats.beat_times) и сдвиг смен зума и появлений вставок на них (beats.snap_edit) — web/lib/beats.ts
CLICKS = [round(0.1 + 0.5 * k, 4) for k in range(24)]  # трек 12 с, 120 уд/мин
BEATS = [
    {"name": "inserts and zooms land on beats within 0.25 s; a sharp change of shot stays at its cut",
     "keep": [[0.0, 10.0]], "speed": 1.0, "teaser": None, "grid": {"length": 12.0, "times": CLICKS}, "music": {},
     "edit": {"zooms": [{"t": 2.2, "level": 1.05}, {"t": 4.42, "level": 1.2, "over": 0}, {"t": 7.0, "level": 1.0}],
              "inserts": [{"kind": "image", "t0": 3.45, "t1": 5.0}, {"kind": "image", "t0": 3.4, "t1": 5.0, "off": True},
                          {"kind": "image", "t0": 6.2, "t1": 6.4}]}},
    {"name": "music later and from its middle; a short track repeats",
     "keep": [[0.0, 3.0], [3.5, 9.0]], "speed": 1.1, "teaser": None, "grid": {"length": 4.0, "times": CLICKS[:8]},
     "music": {"at": 1.3, "from": 0.35}, "edit": {"zooms": [{"t": 1.5, "level": 1.05}, {"t": 0.6, "level": 1.0}],
                                                 "inserts": [{"kind": "sticker", "t0": 5.0, "t1": 7.0}, {"kind": "image", "t0": 8.6, "t1": 9.0}]}},
    {"name": "pieces reordered by hand: an insert does not jump across a join into another piece",
     "keep": [[5.0, 8.0], [0.0, 3.0]], "speed": 1.0, "teaser": None, "grid": {"length": 12.0, "times": [1.0, 3.05]}, "music": {},
     "edit": {"zooms": [], "inserts": [{"kind": "image", "t0": 7.9, "t1": 8.0}, {"kind": "image", "t0": 5.9, "t1": 7.0}]}},
    {"name": "with a teaser: no beat inside the teaser; the music starts after its end",
     "keep": [[0.0, 9.0]], "speed": 1.25, "teaser": [5.0, 7.0], "grid": {"length": 12.0, "times": CLICKS},
     "music": {"at": 2.0}, "edit": {"zooms": [{"t": 1.0, "level": 1.1}], "inserts": [{"kind": "image", "t0": 3.0, "t1": 4.0}]}},
]


def beats_case(case: dict) -> dict:
    tl = _timeline(case)
    music = case["music"]
    at, skip = float(music.get("at") or 0.0), float(music.get("from") or 0.0)
    times = beats.beat_times(case["grid"]["times"], case["grid"]["length"], at, skip, tl.duration)
    snapped, moved = beats.snap_edit(case["edit"], tl, times)
    return {"times": times, "zoomsAt": [z["t"] for z in snapped["zooms"]], "insertsAt": [i["t0"] for i in snapped["inserts"]],
            "moved": moved, "played": beats.played(case["grid"]["length"], at, skip, tl.duration)}


# Текст и вставки руками (edits.apply_text: timeline.json → text, words поверх edit.json) — web/lib/edits.ts (applyText)
_BASE = {
    "words": [{"t0": 0.5, "t1": 0.8, "text": "Привет,"}, {"t0": 0.9, "t1": 1.2, "text": "эта"}, {"t0": 1.3, "t1": 1.6, "text": "эээ"},
              {"t0": 1.7, "t1": 2.0, "text": "ролик."}, {"t0": 2.1, "t1": 2.1, "text": "Я"}],
    "hook": {"text": "Как я снимаю", "until": 1.5},
    "cta": {"t0": 7.0, "t1": 8.0, "lines": ["Пиши в комментариях"], "word": "ВИДЕО"},
    "accents": [{"t0": 3.0, "t1": 4.0, "x": 540, "y": 900, "lines": [{"text": "очень"}, {"text": "важно", "size": "big", "color": "accent"}]},
                {"t0": 5.0, "t1": 5.5, "x": 540, "y": 900, "anim": "type", "lines": [{"text": "второй"}]}],
    "inserts": [{"kind": "image", "src": "a.png", "t0": 2.0, "t1": 3.0, "x": 1, "y": 1, "w": 10, "sfx": "pop.mp3"},
                {"kind": "sticker", "text": "5 минут", "t0": 4.0, "t1": 5.0, "x": 1, "y": 1, "w": 10},
                {"kind": "image", "src": "a.png", "t0": 4.0, "t1": 5.0, "x": 1, "y": 1, "w": 10},
                {"kind": "image", "src": "b.png", "t0": 6.0, "t1": 6.5, "x": 1, "y": 1, "w": 10}],
}
TEXT = [
    {"name": "every kind of block: hook, title, accents, inserts and words",
     "edit": _BASE, "text": {
         "hook": {"until": 2.0, "text": "Как я снимаю на телефон"},
         "cta": {"at": [7.0, 8.0], "t0": 6.8, "t1": 8.4, "lines": ["Напиши"], "word": "КАДР"},
         "accents": [{"at": [3.0, 4.0], "t0": 2.9, "t1": 4.3, "lines": ["совсем", "важно!"]}, {"at": [5.0, 5.5], "off": True}],
         "inserts": [{"at": [4.0, 5.0], "t0": 4.2, "t1": 6.0, "text": "10 минут"}, {"at": [4.0, 5.0], "t0": 4.5},
                     {"at": [6.0, 6.5], "off": True}]},
     "words": [{"t0": 0.9, "t1": 1.2, "text": "это"}, {"t0": 1.3, "t1": 1.6, "text": ""}, {"t0": 2.1, "t1": 2.1, "text": "Мы"}]},
    {"name": "edits of blocks the session moved or removed no longer apply; lines of another count stay",
     "edit": {**_BASE, "cta": {**_BASE["cta"], "t0": 7.5}, "inserts": _BASE["inserts"][1:]}, "text": {
         "cta": {"at": [7.0, 8.0], "t0": 6.0}, "inserts": [{"at": [2.0, 3.0], "off": True}],
         "accents": [{"at": [3.0, 4.0], "lines": ["одна строка"]}, {"at": [9.0, 9.5], "off": True}]},
     "words": [{"t0": 0.9, "t1": 1.25, "text": "это"}]},
    {"name": "hook and title switched off; a hook edit without a hook changes nothing",
     "edit": _BASE, "text": {"hook": {"off": True}, "cta": {"at": [7.0, 8.0], "off": True}}, "words": []},
    {"name": "nothing to change", "edit": {**_BASE, "hook": None, "cta": None, "accents": [], "inserts": []},
     "text": {"hook": {"until": 3.0}, "cta": {"at": [7.0, 8.0], "t0": 6.0}}, "words": []},
]
TEXT_REFUSED = [
    {"name": "title ends before it starts", "edit": _BASE, "text": {"cta": {"at": [7.0, 8.0], "t0": 8.5}}, "words": []},
    {"name": "accent ends before it starts", "edit": _BASE, "text": {"accents": [{"at": [3.0, 4.0], "t1": 2.0}]}, "words": []},
    {"name": "insert of no length", "edit": _BASE, "text": {"inserts": [{"at": [4.0, 5.0], "t0": 5.0, "t1": 5.0}]}, "words": []},
]
TEXT_FIELDS = ("hook", "cta", "accents", "inserts", "words")


def text_case(case: dict) -> dict:
    out = edits.apply_text(case["edit"], case["text"], case["words"])
    return {k: out.get(k) for k in TEXT_FIELDS}


def _around(t: float) -> range:
    """Кадры финала у стыка `t`: окно перехода (± 0,12 с) и пара кадров за каждым его краем."""
    return range(math.floor((t - 0.2) * FPS), math.ceil((t + 0.2) * FPS) + 1)


def look_case(case: dict) -> dict:
    tl = _timeline(case)
    edit = case["edit"]
    marks = transitions.marks(edit, tl)
    punches = [m.t for m in marks if m.kind == "zoom"]
    times = [round(k * 0.05, 2) for k in range(int(tl.duration / 0.05) + 2)]
    return {
        "zoom": [[t, zoom_at(edit["zooms"], tl, t, TRANS, punches)] for t in times],
        "marks": [{"t": m.t, "kind": m.kind, "source": m.source} for m in marks],
        "looks": [list(w) for w in look_windows(edit, tl)],
        "flash": [{"t": m.t, "frames": [[n, transitions.flash_alpha(m.t, n)] for n in _around(m.t)]}
                  for m in marks if m.kind == "flash"],
        "blur": [{"t": m.t, "frames": [[n, transitions.blur_sigma(m.t, n)] for n in _around(m.t)]}
                 for m in marks if m.kind == "blur"],
    }


def _timeline(case: dict) -> Timeline:
    return Timeline(case["keep"], case["speed"], case["teaser"])


def subs_events(case: dict) -> list[dict]:
    words = [Word(w["t0"], w["t1"], w["text"]) for w in case["words"]]
    hidden = [tuple(h) for h in case.get("hidden", [])]
    return build_sub_events(words, _timeline(case), case["mode"], case["n"], hidden=hidden)


def overlay_events(case: dict) -> list[dict]:
    return build_overlay_events(case["edit"], _timeline(case))


def spans(case: dict) -> list[list[int]]:
    return [list(s) for s in insert_spans(case["edit"], _timeline(case))]


def build() -> dict:
    return {
        "_": NOTE,
        "subs": [{**case, "events": subs_events(case)} for case in SUBS],
        "subsRefused": SUBS_REFUSED,
        "overlay": [{**case, "events": overlay_events(case), "insertSpans": spans(case)} for case in OVERLAY],
        "overlayRefused": OVERLAY_REFUSED,
        "render": [{**case, **render_case(case)} for case in RENDER],
        "renderRefused": RENDER_REFUSED,
        "look": [{**case, **look_case(case)} for case in LOOK],
        "bwFilter": {"brightness": BW_CSS_BRIGHTNESS, "contrast": BW_CSS_CONTRAST},
        "beats": [{**case, **beats_case(case)} for case in BEATS],
        "text": [{**case, "expected": text_case(case)} for case in TEXT],
        "textRefused": TEXT_REFUSED,
    }


def _rows(items: list, indent: str) -> str:
    """Список — по элементу в строке (события длинные, так фикстуру можно читать и сравнивать)."""
    if not items:
        return "[]"
    inner = f",\n{indent}  ".join(json.dumps(x, ensure_ascii=False) for x in items)
    return f"[\n{indent}  {inner}\n{indent}]"


def dump(data: dict) -> str:
    out = ["{", f'  "_": {json.dumps(data["_"], ensure_ascii=False)},']
    for key in ("subs", "overlay"):
        cases = []
        for case in data[key]:
            fields = []
            for k, v in case.items():
                long = k in ("events", "words") or (k == "edit" and isinstance(v, dict))
                if k == "edit":
                    edit = ",\n        ".join(
                        f'{json.dumps(ek, ensure_ascii=False)}: {_rows(ev, "        ") if isinstance(ev, list) else json.dumps(ev, ensure_ascii=False)}'
                        for ek, ev in v.items())
                    fields.append(f'"edit": {{\n        {edit}\n      }}')
                elif long:
                    fields.append(f'{json.dumps(k)}: {_rows(v, "      ")}')
                else:
                    fields.append(f"{json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}")
            cases.append("    {\n      " + ",\n      ".join(fields) + "\n    }")
        out.append(f'  {json.dumps(key)}: [\n' + ",\n".join(cases) + "\n  ],")
        refused = f"{key}Refused"
        out.append(f'  {json.dumps(refused)}: {_rows(data[refused], "  ")},')
    out.append(f'  "render": {_rows(data["render"], "  ")},')
    out.append(f'  "renderRefused": {_rows(data["renderRefused"], "  ")},')
    out.append(f'  "look": {_rows(data["look"], "  ")},')
    out.append(f'  "bwFilter": {json.dumps(data["bwFilter"])},')
    out.append(f'  "beats": {_rows(data["beats"], "  ")},')
    out.append(f'  "text": {_rows(data["text"], "  ")},')
    out.append(f'  "textRefused": {_rows(data["textRefused"], "  ")}')
    out.append("}")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    text = dump(build())
    assert json.loads(text) == json.loads(json.dumps(build())), "запись фикстуры исказила данные"
    PATH.write_text(text, encoding="utf-8")
    print(f"{PATH}: subs {len(SUBS)}, overlay {len(OVERLAY)}", file=sys.stderr)
