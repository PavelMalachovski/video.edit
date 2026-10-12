"""Общая фикстура событий субтитров и слоя: engine/vm/subs.py (build_sub_events) и engine/vm/overlay.py
(build_overlay_events, insert_spans) ↔ web/lib/subs.ts и web/lib/overlay.ts — превью в редакторе рисует то же, что финал.

Здесь — входы случаев; ожидаемое считает движок. Записать фикстуру заново (после правки движка — и переноса на TS):
    cd engine && python3 -m tests.shared_events
Тесты обеих сторон сверяют с ней (test_overlay.py, web/tests/overlay.test.ts).
"""
import json
import sys
from pathlib import Path

from vm.asr import Word
from vm.overlay import build_overlay_events, insert_spans
from vm.subs import build_sub_events
from vm.timeline import Timeline

PATH = Path(__file__).parent / "fixtures" / "overlay-events.json"
NOTE = (
    "События субтитров (subs: build_sub_events) и слоя (overlay: build_overlay_events и insertSpans — кадры показа "
    "вставок) для одних и тех же входов: engine/vm/subs.py и engine/vm/overlay.py ↔ web/lib/subs.ts и "
    "web/lib/overlay.ts. Времена слов и edit — по исходнику, событий — секунды финала; keep — в порядке финала. "
    "Пишет engine/tests/shared_events.py (python3 -m tests.shared_events из engine/)."
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
        out.append(f'  {json.dumps(refused)}: {_rows(data[refused], "  ")}' + ("," if key == "subs" else ""))
    out.append("}")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    text = dump(build())
    assert json.loads(text) == json.loads(json.dumps(build())), "запись фикстуры исказила данные"
    PATH.write_text(text, encoding="utf-8")
    print(f"{PATH}: subs {len(SUBS)}, overlay {len(OVERLAY)}", file=sys.stderr)
