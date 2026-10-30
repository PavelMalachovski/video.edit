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

from vm import beats, edits, fonts, transitions
from vm.asr import Word
from vm.broll import PIP, face_box
from vm.looks import LOOKS, css_filter
from vm.overlay import FPS, build_overlay_events, insert_spans
from vm.render import (
    BW_CSS_BRIGHTNESS,
    BW_CSS_CONTRAST,
    look_spans,
    look_windows,
    music_beats,
)
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
    "(web/lib/zoom.ts): зум (zoom_at), переходы на стыках (transitions.marks), куски с фильтром — кадры каждого (look_windows) "
    "и какой фильтр на каких кадрах (spans: render.look_spans, поздний кусок сильнее), "
    "вспышка и смаз у каждого стыка по кадрам финала [n, значение] (transitions.flash_alpha — белизна 0..1, blur_sigma — "
    "sigma смаза по x, px кадра 1080); bwFilter — CSS-фильтр ч/б-кадра в превью: grayscale(1) brightness contrast "
    "(render.BW_CSS_BRIGHTNESS, BW_CSS_CONTRAST ↔ BW_FILTER в web/lib/picture.ts); lookFilters — CSS-фильтры сепии, "
    "тёплого, холодного и плёнки (looks.css_filter ↔ LOOK_CSS в web/lib/picture.ts); beats — доли музыки в ролике и "
    "что на них встаёт (web/lib/beats.ts); text — текст и вставки руками (edits.apply_text ↔ web/lib/edits.ts); "
    "pipeline — весь путь правок Павла до слоя, как у монтажа (edits.apply → render.timeline → render.music_beats и "
    "beats.snap_edit → build_overlay_events ↔ withHandEdits, musicBeats, draftTracks, buildOverlayEvents); picture — "
    "картинка руками (edits.apply_picture: сила зума, куски с фильтром — убранные, с другими краями или фильтром, свои "
    "куски Павла со сменой крупности на краях, вид и «убрать» переходов, затемнение фона ↔ applyPicture) и что "
    "выходит в ролике: зум, переходы, кадры кусков и их фильтры; letters — каких букв текста (и его капса) нет в каждом шрифте каталога "
    "(fonts.missing: таблица символов — getBestCmap fontTools, эмодзи — картинки ↔ web/lib/fontchars.ts); broll — окошко "
    "лица перебивки (broll.PIP) и кусок кадра в нём по точке лица [лицо, [x, y, w, h]] (broll.face_box ↔ web/lib/broll.ts). "
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
    {"name": "a cut left a remnant of an accent phrase: no accent there; a short phrase kept whole stays",
     "keep": [[0.3, 5.1], [6.3, 9.5]], "speed": 1.1, "teaser": None,
     "edit": {"words": SPEECH, "style": _style("soft", 3),
              "accents": [ACCENT, {"t0": 2.6, "t1": 2.9, "x": 540, "y": 800, "lines": [{"text": "Сегодня"}]}]}},
    {"name": "tricky times: half-frame rounding, overlapping words",
     "keep": [[0.0, 3.0], [3.2, 3.9]], "speed": 1.0, "teaser": None,
     "edit": {"words": TRICKY, "style": _style("soft", 2), "hook": {"text": "Ну что", "until": 0.35},
              "end": {"seconds": 1.0, "lines": ["Пока"]}}},
    {"name": "a series of b-roll on a list of names: each cuts the previous off, captions instead of subtitles",
     "keep": [[0.3, 4.6], [5.1, 9.5]], "speed": 1.1, "teaser": None,
     "edit": {"words": SPEECH, "style": _style("soft", 3),
              "inserts": [{"kind": "fullscreen", "src": "in/uploads/upload-b1.jpg", "t0": 2.6, "t1": 3.0, "caption": "Эдриан Броуди"},
                          {"kind": "fullscreen", "src": "in/uploads/upload-b2.jpg", "t0": 3.1, "t1": 3.4, "caption": "Том Хиддлстоун"},
                          {"kind": "image", "src": "a.png", "t0": 3.2, "t1": 3.6, "x": 100, "y": 100, "w": 300},
                          {"kind": "fullscreen", "src": "in/uploads/upload-b3.mp4", "t0": 3.5, "t1": 4.0, "caption": "Питер Капальди", "off": True},
                          {"kind": "fullscreen", "src": "in/uploads/upload-b4.mp4", "t0": 3.6, "t1": 4.2},
                          {"kind": "fullscreen", "src": "in/uploads/upload-b5.jpg", "t0": 7.0, "t1": 7.5, "caption": "Лыков"}]}},
    {"name": "subtitles in their own places: a block takes the place of its first word, all its lines stay there",
     "keep": [[0.3, 4.6], [5.1, 9.5]], "speed": 1.1, "teaser": None,
     "edit": {"words": SPEECH, "style": _style("soft", 3), "subPlaces": [{"t0": 2.6, "t1": 4.0, "y": 380}, {"t0": 7.0, "t1": 9.5, "y": 1100}]}},
    {"name": "subtitles in their own places in karaoke, an accent among them",
     "keep": [[0.3, 9.5]], "speed": 1.0, "teaser": None,
     "edit": {"words": SPEECH, "style": _style("karaoke", 3, "plate"), "accents": [ACCENT],
              "subPlaces": [{"t0": 0.3, "t1": 3.0, "y": 300}, {"t0": 6.0, "t1": 6.5, "y": 1600}]}},
    {"name": "subtitles in their own places: a block whose first word got no time (two words start together)",
     "keep": [[0.0, 9.5]], "speed": 1.0, "teaser": None,
     "edit": {"words": [{"t0": 0.5, "t1": 0.7, "text": "Это"}, {"t0": 0.8, "t1": 1.0, "text": "такой"},
                        {"t0": 1.1, "t1": 1.4, "text": "типаж."}, {"t0": 2.6, "t1": 2.6, "text": "И"},
                        {"t0": 2.6, "t1": 3.0, "text": "вот"}, {"t0": 3.1, "t1": 3.4, "text": "он."}],
              "style": _style("karaoke", 3, "plate"), "subPlaces": [{"t0": 0.4, "t1": 2.0, "y": 380}]}},
    {"name": "b-roll starting on one frame (pushed to the end of the hook): only the top one is shown, with its caption",
     "keep": [[0.3, 9.5]], "speed": 1.0, "teaser": None,
     "edit": {"words": SPEECH, "style": _style("karaoke", 3, "plate"), "hook": {"text": "Кто такой Локи", "until": 2.5},
              "inserts": [{"kind": "fullscreen", "src": "in/uploads/upload-b1.jpg", "t0": 1.0, "t1": 3.0, "caption": "Локи"},
                          {"kind": "fullscreen", "src": "in/uploads/upload-b2.jpg", "t0": 2.0, "t1": 3.5, "caption": "Тор"}]}},
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
    {"name": "a tear onto a b-roll a beat moved, a tear with no b-roll near, glitches; a tear needs room before its seam",
     "keep": [[0.0, 4.0], [4.3, 10.0]], "speed": 1.0, "teaser": None,
     "edit": {"zooms": [], "looks": [],
              "transitions": [{"t": 2.0, "kind": "tear"}, {"t": 5.0, "kind": "tear"}, {"t": 7.0, "kind": "glitch"},
                              {"t": 0.02, "kind": "glitch"}, {"t": 0.2, "kind": "tear"}, {"t": 8.5, "kind": "tear", "off": True}],
              "inserts": [{"kind": "fullscreen", "src": "a.jpg", "t0": 2.2, "t1": 3.0},
                          {"kind": "fullscreen", "src": "b.jpg", "t0": 5.9, "t1": 6.5},
                          {"kind": "fullscreen", "src": "c.jpg", "t0": 8.5, "t1": 9.0}]}},
    {"name": "filters set by hand: one look per frame, the later piece wins; neighbours of one look merge; off is in colour",
     "keep": [[0.0, 4.0], [4.5, 9.0]], "speed": 1.1, "teaser": [6.0, 7.5],
     "edit": {"zooms": [], "transitions": [],
              "looks": [{"t0": 0.5, "t1": 2.5, "look": "bw"}, {"t0": 2.0, "t1": 3.5, "look": "sepia"}, {"t0": 3.5, "t1": 4.4, "look": "sepia"},
                        {"t0": 5.0, "t1": 7.0, "look": "cold"}, {"t0": 6.5, "t1": 7.2, "look": "film"}, {"t0": 8.0, "t1": 8.6, "look": "warm", "off": True}]}},
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


# Весь путь правок Павла, как у монтажа: edits.apply (куски → звук → текст) → render.timeline → доли музыки
# (render.music_beats → beats.snap_edit, как render.on_beats) → слой. Страница — withHandEdits, musicBeats, draftTracks
# (web/tests/overlay.test.ts): тот же путь, что у кадра редактора.
_LAYER_EDIT = {
    "speed": 1.1, "keep": [[0.3, 2.5], [2.9, 9.5]], "teaser": None, "words": SPEECH, "style": _style("soft", 3),
    "hook": {"text": "Как я снимаю", "until": 2.0}, "accents": [ACCENT],
    "cta": {"t0": 7.2, "t1": 8.6, "lines": ["Пиши в комментариях"], "word": "ВИДЕО"},
    "inserts": [{"kind": "image", "src": "assets/logos/tg.png", "t0": 1.0, "t1": 2.2, "x": 600, "y": 300, "w": 300},
                {"kind": "image", "src": "c.png", "t0": 3.0, "t1": 4.0, "x": 100, "y": 100, "w": 300},
                {"kind": "sticker", "text": "5 минут", "t0": 8.8, "t1": 9.3, "x": 120, "y": 1100, "w": 400}],
    "zooms": [{"t": 3.3, "level": 1.08}, {"t": 6.5, "level": 1.0}], "looks": [], "transitions": [],
    "music": {"file": "assets/music/a.mp3", "gainDb": -14}, "hold": 0.4,
    "end": {"seconds": 1.5, "lines": ["Подпишись 🔥"], "handle": "@pavel", "logo": "brand/logo.png"},
}
PIPELINE = [
    {"name": "pieces split, moved and cut; hook, title, accent and inserts fixed; words typed and removed; an insert off",
     "duration": 9.6, "edit": _LAYER_EDIT, "grid": None,
     "timeline": {"edits": [{"op": "split", "t": 5.0}, {"op": "move", "t0": 5.0, "t1": 9.5, "before": 2.9},
                            {"op": "cut", "t0": 3.0, "t1": 3.4}],
                  "text": {"hook": {"until": 1.5, "text": "Снимаю на телефон"}, "cta": {"at": [7.2, 8.6], "word": "ПЛАН"},
                           "accents": [{"at": [5.0, 6.2], "t0": 5.22, "t1": 6.0}],
                           "inserts": [{"at": [1.0, 2.2], "t1": 2.4}, {"at": [3.0, 4.0], "off": True}]},
                  "words": [{"t0": 0.76, "t1": 1.08, "text": "вот"}, {"t0": 6.08, "t1": 6.4, "text": ""}]}},
    {"name": "on the music's beats: inserts and zooms land on them; the music moved by hand moves the beats",
     "duration": 9.6, "edit": _LAYER_EDIT, "grid": {"length": 12.0, "times": CLICKS},
     "timeline": {"edits": [], "music": {"at": 0.3, "from": 0.2},
                  "text": {"inserts": [{"at": [8.8, 9.3], "t0": 7.0, "t1": 8.0}]}}},
    {"name": "the music switched off by hand: no beats, nothing moves",
     "duration": 9.6, "edit": _LAYER_EDIT, "grid": {"length": 12.0, "times": CLICKS}, "timeline": {"edits": [], "music": {"muted": True}}},
    {"name": "a teaser, the hook on the whole teaser; a track too short for beats",
     "duration": 9.6, "edit": {**_LAYER_EDIT, "keep": [[0.3, 3.0], [3.3, 9.5]], "teaser": {"t0": 3.3, "t1": 4.8}, "style": _style("karaoke", 3, "plate")},
     "grid": {"length": 0.4, "times": [0.1]},
     "timeline": {"edits": [{"op": "cut", "t0": 0.3, "t1": 0.7}], "words": [{"t0": 3.42, "t1": 3.74, "text": "как,"}]}},
    {"name": "the end card's lines and handle by hand",
     "duration": 9.6, "edit": _LAYER_EDIT, "grid": None,
     "timeline": {"edits": [], "text": {"end": {"lines": ["Пиши «план»", "в комментариях"], "handle": "@pavel.edit"}}}},
    {"name": "the end card removed by hand",
     "duration": 9.6, "edit": _LAYER_EDIT, "grid": None, "timeline": {"edits": [], "text": {"end": {"off": True}}}},
    {"name": "an empty handle is no handle",
     "duration": 9.6, "edit": _LAYER_EDIT, "grid": None, "timeline": {"edits": [], "text": {"end": {"handle": ""}}}},
    {"name": "the teaser removed and the speed changed by hand: the hook is back on its own words, everything moves",
     "duration": 9.6, "edit": {**_LAYER_EDIT, "keep": [[0.3, 3.0], [3.3, 9.5]], "teaser": {"t0": 3.3, "t1": 4.8}},
     "grid": {"length": 12.0, "times": CLICKS}, "timeline": {"edits": [], "teaser": False, "speed": 1.25}},
]


def pipeline_case(case: dict) -> dict:
    edit = edits.apply(case["edit"], case["timeline"], case["duration"])
    tl = render_timeline(edit, case["duration"])
    grid = case["grid"]
    times = music_beats(edit.get("music"), grid["times"], grid["length"], tl.duration) if grid else None
    if times is not None:
        edit, _ = beats.snap_edit(edit, tl, times)
    return {"beatsUsed": times is not None, "events": build_overlay_events(edit, tl),
            "insertSpans": [list(s) for s in insert_spans(edit, tl)]}


# Картинка руками (edits.apply_picture: timeline.json → zoom, looks, transitions поверх edit.json) и что из неё выходит в
# ролике: уровни зума, кадры ч/б, переходы на стыках — web/lib/edits.ts (applyPicture), zoom.ts
_PICTURE = {
    "zooms": [{"t": 1.0, "level": 1.12}, {"t": 3.0, "level": 1.0}, {"t": 4.0, "level": 1.2, "over": 0}, {"t": 6.2, "level": 1.07}],
    "looks": [{"t0": 2.0, "t1": 3.0, "look": "bw"}, {"t0": 5.0, "t1": 6.0, "look": "bw"}, {"t0": 5.0, "t1": 6.0, "look": "bw"}],
    "transitions": [{"t": 2.5, "kind": "flash", "sfx": "assets/sfx/swoosh.mp3"}, {"t": 4.5, "kind": "zoom"}, {"t": 7.0, "kind": "blur"}],
}
PICTURE = [
    {"name": "zoom weaker, a b/w piece off (the second of two at one place), a transition of another kind and one off",
     "keep": [[0.0, 8.5]], "speed": 1.0, "teaser": None, "edit": _PICTURE,
     "timeline": {"zoom": 0.5, "looks": [{"at": [5.0, 6.0], "off": True}, {"at": [5.0, 6.0], "off": True}],
                  "transitions": [{"at": 2.5, "kind": "blur"}, {"at": 4.5, "off": True}], "dim": 0.45}},
    {"name": "zoom stronger is capped by the rules; no zoom at all; an edit for a moment that is not there",
     "keep": [[0.0, 4.0], [4.6, 8.5]], "speed": 1.1, "teaser": None, "edit": _PICTURE,
     "timeline": {"zoom": 1.5, "transitions": [{"at": 3.3, "off": True}, {"at": 7.0, "kind": "flash"}], "dim": 0}},
    {"name": "zoom off",
     "keep": [[0.0, 8.5]], "speed": 1.0, "teaser": [5.2, 6.5], "edit": _PICTURE, "timeline": {"zoom": 0, "looks": [{"at": [2.0, 3.0], "off": True}]}},
    {"name": "own pieces by hand: after the session's, a shot of their own on the edges, other shots inside and near the edges gone",
     "keep": [[0.0, 8.5]], "speed": 1.0, "teaser": None, "edit": _PICTURE,
     "timeline": {"looks": [{"t0": 6.0, "t1": 7.2, "look": "sepia"}, {"t0": 0.3, "t1": 1.2, "look": "bw"}]}},
    {"name": "a session piece with other edges moves its shot changes; another filter only; zoom strength scales the new shots",
     "keep": [[0.0, 3.6], [4.1, 8.5]], "speed": 1.2, "teaser": None,
     "edit": {**_PICTURE, "zooms": [{"t": 1.0, "level": 1.0, "over": 0}, {"t": 2.0, "level": 1.25, "over": 0}, {"t": 3.0, "level": 1.0, "over": 0},
                                    {"t": 4.0, "level": 1.2, "over": 0}, {"t": 6.2, "level": 1.07}]},
     "timeline": {"zoom": 0.7, "looks": [{"at": [2.0, 3.0], "t0": 1.7, "t1": 3.3}, {"at": [5.0, 6.0], "look": "film"}]}},
    {"name": "plans before and after differ from every shot by less than 0.1: the farthest shot",
     "keep": [[0.0, 8.5]], "speed": 1.0, "teaser": None,
     "edit": {**_PICTURE, "zooms": [{"t": 1.0, "level": 1.08}, {"t": 4.1, "level": 1.18, "over": 0}], "looks": []},
     "timeline": {"looks": [{"t0": 3.0, "t1": 4.0, "look": "warm"}]}},
]


def picture_case(case: dict) -> dict:
    t = case["timeline"]
    out = edits.apply_picture(case["edit"], t.get("zoom"), t.get("looks"), t.get("transitions"), t.get("dim"))
    tl = _timeline(case)
    marks = transitions.marks(out, tl)
    zoom = [[round(k * 0.1, 4), round(zoom_at(out["zooms"], tl, k * 0.1, TRANS, [m.t for m in marks if m.kind == "zoom"]), 6)]
            for k in range(math.ceil(tl.duration * 10) + 1)]
    return {"expected": {k: out.get(k) for k in ("zooms", "looks", "transitions", "dim")},
            "marks": [{"t": m.t, "kind": m.kind, "source": m.source} for m in marks], "lookWindows": [list(w) for w in look_windows(out, tl)],
            "lookSpans": [list(w) for w in look_spans(out, tl)], "zoom": zoom}


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
    {"name": "blocks placed on the frame by hand: an insert moved and widened, an accent moved; a fullscreen insert has no place",
     "edit": {**_BASE, "inserts": [*_BASE["inserts"], {"kind": "fullscreen", "src": "c.mp4", "t0": 7.0, "t1": 7.5}]}, "text": {
         "accents": [{"at": [3.0, 4.0], "x": 300, "y": 1200}, {"at": [5.0, 5.5], "t0": 5.1, "x": 700, "y": 400}],
         "inserts": [{"at": [2.0, 3.0], "x": 200, "y": 600, "w": 400}, {"at": [4.0, 5.0], "t0": 4.2, "x": 120.5, "y": 1100, "w": 300},
                     {"at": [7.0, 7.5], "x": 100, "y": 300, "w": 500}]},
     "words": []},
    {"name": "B-roll by hand: another clip, moment, face window and clip sound — only on a fullscreen insert",
     "edit": {**_BASE, "inserts": [*_BASE["inserts"], {"kind": "fullscreen", "src": "in/uploads/upload-b1.mp4", "t0": 7.0, "t1": 8.5,
                                                       "from": 2.0, "layout": "pip", "audio": True}]}, "text": {
         "inserts": [{"at": [7.0, 8.5], "src": "in/uploads/upload-b3.mov", "from": 0.5, "layout": "full", "audio": False, "t1": 8.0},
                     {"at": [2.0, 3.0], "src": "in/uploads/upload-b2.mp4", "from": 4.0, "layout": "pip", "audio": True}]},
     "words": []},
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
        "spans": [list(w) for w in look_spans(edit, tl)],
        "flash": [{"t": m.t, "frames": [[n, transitions.flash_alpha(m.t, n)] for n in _around(m.t)]}
                  for m in marks if m.kind == "flash"],
        "blur": [{"t": m.t, "frames": [[n, transitions.blur_sigma(m.t, n)] for n in _around(m.t)]}
                 for m in marks if m.kind == "blur"],
        "tears": [{"t": x.mark.t, "insert": x.insert, "join": x.join,
                   "frames": [[n, transitions.tear_frame(x.join, n)] for n in range(x.join - 12, x.join + 3)]}
                  for x in transitions.tears(edit, tl)],
        "glitch": [{"t": m.t, "frames": [[n, transitions.glitch_bands(round(m.t * 30), n)] for n in _around(m.t)]}
                   for m in marks if m.kind == "glitch"],
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


# Буквы шрифтов (fonts.missing ↔ web/lib/fontchars.ts): страница читает те же файлы шрифтов и считает так же
LETTERS = [
    "Привет, как дела? Ёлка — «ёж» … ЭЮЯ",
    "Беларуская мова: ў, і; українська: ї, є, ґ",
    "Straße, naïve café, Ångström, Øre, Œuvre, ça, Ğ ş ı İ",
    "500 ₽, 20 €, £5, ¥, $9.99, 15 %, 3‰, +20 °C, №1, ½ и ¼, 2×3 ÷ 4 ± 1, a ≤ b ≥ c ≈ d ≠ e",
    "Стрелки → ← ↔ ↑ ↓; кавычки „ “ ” ‘ ’ ‹ ›; тире ‐ – —; точки · • ‥",
    "e\u0301 (комбинируемый), мягкий\u00adперенос, ноль\u200bширины, ʼапостроф",
    "Эмодзи 🔥 ❤️ ❤ 👍🏽 👨\u200d👩\u200d👧 🇺🇸 #️⃣ 1️⃣ #\u20e3 ‼️ ‼ ↔️ ℹ️ ℹ ™️ ™ ©️ ©",
    "Ελληνικά αβγ, 中文, العربية, עברית",
    "ПЛАН! КОД: ВИДЕО-2026, ok/okay; [скобки] {фигурные} (круглые) _ ~ ^ ` @ & * |",
]


HOOKS = ["Как я снимаю", "Как я снимаю 🔥 ❤️", "🔥", "", "Один  два\tтри 👍🏽 #️⃣", "Слово \u200d", "Ура 1️⃣"]


def letters_case() -> dict:
    found = fonts.catalog()
    return {
        "fonts": [{"id": f.id, "file": f.path.relative_to(fonts.REPO).as_posix()} for f in found],
        "texts": LETTERS,
        "missing": {f.id: [fonts.missing(f, text) for text in LETTERS] for f in found},
        "hand": [[hook, fonts._hand_word(hook)] for hook in HOOKS],  # рукописная часть хука — последнее слово с эмодзи
    }


BROLL_FACES = [{"x": 0.5, "y": 0.5}, {"x": 0.5, "y": 0.3}, {"x": 0.1, "y": 0.05}, {"x": 0.97, "y": 0.95}, {}, {"x": 2, "y": -1}]


def broll_case() -> dict:
    """Окошко лица перебивки (broll.PIP) и кусок кадра в нём по точке лица (face_box) — так его рисует плеер редактора."""
    return {"pip": PIP, "faces": [[face, list(face_box(face))] for face in BROLL_FACES]}


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
        "lookFilters": {look: css_filter(look) for look in LOOKS},
        "beats": [{**case, **beats_case(case)} for case in BEATS],
        "text": [{**case, "expected": text_case(case)} for case in TEXT],
        "textRefused": TEXT_REFUSED,
        "pipeline": [{**case, **pipeline_case(case)} for case in PIPELINE],
        "picture": [{**case, **picture_case(case)} for case in PICTURE],
        "letters": letters_case(),
        "broll": broll_case(),
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
    out.append(f'  "lookFilters": {json.dumps(data["lookFilters"])},')
    out.append(f'  "beats": {_rows(data["beats"], "  ")},')
    out.append(f'  "text": {_rows(data["text"], "  ")},')
    out.append(f'  "textRefused": {_rows(data["textRefused"], "  ")},')
    out.append(f'  "pipeline": {_rows(data["pipeline"], "  ")},')
    out.append(f'  "picture": {_rows(data["picture"], "  ")},')
    letters = data["letters"]
    missing = ",\n    ".join(f"{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}" for k, v in letters["missing"].items())
    out.append(f'  "broll": {json.dumps(data["broll"], ensure_ascii=False)},')
    out.append(f'  "letters": {{\n    "fonts": {_rows(letters["fonts"], "    ")},\n    "texts": {_rows(letters["texts"], "    ")},\n'
               f'    "missing": {{\n    {missing}\n    }},\n    "hand": {_rows(letters["hand"], "    ")}\n  }}')
    out.append("}")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    text = dump(build())
    assert json.loads(text) == json.loads(json.dumps(build())), "запись фикстуры исказила данные"
    PATH.write_text(text, encoding="utf-8")
    print(f"{PATH}: subs {len(SUBS)}, overlay {len(OVERLAY)}", file=sys.stderr)
