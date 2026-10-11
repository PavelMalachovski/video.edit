"""События слоя: что рисует шаблон (template/overlay.html) в каждый промежуток финала.

Субтитры, хук, титр с кодовым словом и вставки сводятся в непересекающиеся промежутки `{t0, t1, state}`,
которые покрывают весь финал вместе со стоп-кадром в конце (`edit.hold`). `state` — то, что получает
`window.renderState`: `{sub?, hook?, cta?, inserts?}`. Внутренние границы стоят на сетке кадров (30 к/с),
поэтому каждый промежуток, кроме последнего, — целое число кадров; одинаковые соседние состояния склеены.

Времена в edit.json — по исходнику; в время финала их переводит `Timeline` (момент, попавший в вырезку,
переходит на начало следующего отрезка). Правила вставок: пока виден хук, вставок нет (начало сдвигается на
конец хука); показ не короче 1,5 с; появление — три кадра (`anim` = 1/3, 2/3, 1); у анимации (`kind: anim`)
каждый кадр свой (`t` — секунды от начала показа). Полноэкранные вставки (`fullscreen`) монтирует ffmpeg,
в слой они не попадают. Что видно в последний кадр ролика, остаётся и на стоп-кадре.
"""
import math
from dataclasses import dataclass
from itertools import pairwise

from .asr import Word
from .subs import build_sub_events
from .timeline import Timeline

FPS = 30
APPEAR = 3  # кадров появления вставки
MIN_SHOW = 1.5  # с — вставка показывается не короче
DRAWN = ("image", "badge", "sticker", "text", "anim")  # что рисует шаблон; fullscreen — ffmpeg
INSERT_FIELDS = ("kind", "src", "text", "title", "x", "y", "w", "params")


@dataclass
class _Piece:
    """Что-то видимое на кадрах `[start, stop)`: субтитр, хук, титр или вставка."""

    start: int
    stop: int
    key: str
    value: dict
    insert: bool = False
    every_frame: bool = False


def build_overlay_events(edit: dict, tl: Timeline) -> list[dict]:
    """Промежутки финала `{t0, t1, state}` по возрастанию, встык, от 0 до `tl.duration + edit.hold`."""
    hold = float(edit.get("hold") or 0.0)
    end = tl.duration + hold
    last = _frame(end)  # кадров во всём ролике со стоп-кадром
    video = _frame(tl.duration)  # последний кадр ролика без стоп-кадра
    # что начинается не раньше конца ролика, в ролике не видно — на стоп-кадре тоже не появляется
    pieces = [p for p in _subtitles(edit, tl) + _titles(edit, tl) + _inserts(edit, tl) if p.start < video]
    for piece in pieces:
        if piece.stop >= video:  # видно в последний кадр — остаётся на стоп-кадре
            piece.stop = last

    borders = {0, last}
    for piece in pieces:
        if piece.stop <= piece.start:
            continue
        borders.update((piece.start, piece.stop))
        if piece.insert:
            borders.update(f for f in range(piece.start + 1, piece.start + APPEAR) if f < piece.stop)
        if piece.every_frame:
            borders.update(range(piece.start, piece.stop))
    marks = sorted(b for b in borders if 0 <= b <= last)

    events: list[dict] = []
    for a, b in pairwise(marks):
        state = _state(pieces, a)
        if events and events[-1]["state"] == state:
            events[-1]["t1"] = b
        else:
            events.append({"t0": a, "t1": b, "state": state})
    for e in events:
        e["t0"] = e["t0"] / FPS
        e["t1"] = end if e["t1"] == last else e["t1"] / FPS
    return events or [{"t0": 0, "t1": end, "state": {}}]


def _frame(t: float) -> int:
    return round(t * FPS)


def _subtitles(edit: dict, tl: Timeline) -> list[_Piece]:
    spoken = [Word(w["t0"], w["t1"], w["text"]) for w in edit.get("words") or []]
    style = edit["style"]["subtitles"]
    pieces = []
    for e in build_sub_events(spoken, tl, style["mode"], style["words"]):
        sub = {"words": list(e["words"]), "active": e["active"], "visible": e["visible"]}
        pieces.append(_Piece(_frame(e["t0"]), _frame(e["t1"]), "sub", sub))
    return pieces


def _titles(edit: dict, tl: Timeline) -> list[_Piece]:
    pieces = []
    hook = edit.get("hook")
    if hook:
        pieces.append(_Piece(0, _hook_end(edit, tl), "hook", {"text": hook["text"]}))
    cta = edit.get("cta")
    if cta:
        span = (_frame(tl.to_final_snap(cta["t0"])), _frame(tl.to_final_snap(cta["t1"])))
        pieces.append(_Piece(*span, "cta", {"lines": list(cta["lines"]), "word": cta["word"]}))
    return pieces


def _hook_end(edit: dict, tl: Timeline) -> int:
    hook = edit.get("hook")
    return _frame(tl.to_final_snap(hook["until"])) if hook else 0


def insert_spans(edit: dict, tl: Timeline) -> list[tuple[int, int, int]]:
    """Кадры показа вставок `(номер в edit.inserts, первый кадр, кадр после последнего)` по правилам: не раньше
    конца хука, не короче 1,5 с. Все виды, в том числе fullscreen (её монтирует ffmpeg, а звук — в нужный кадр)."""
    after_hook = _hook_end(edit, tl)
    min_show = math.ceil(MIN_SHOW * FPS - 1e-9)
    spans = []
    for i, ins in enumerate(edit.get("inserts") or []):
        start = max(_frame(tl.to_final_snap(ins["t0"])), after_hook)
        stop = max(_frame(tl.to_final_snap(ins["t1"])), start + min_show)
        spans.append((i, start, stop))
    return spans


def _inserts(edit: dict, tl: Timeline) -> list[_Piece]:
    inserts = edit.get("inserts") or []
    pieces = []
    for i, start, stop in insert_spans(edit, tl):
        ins = inserts[i]
        if ins["kind"] not in DRAWN:
            continue
        missing = [k for k in ("x", "y", "w") if ins.get(k) is None]
        if missing:
            raise ValueError(f"inserts[{i}]: вставке «{ins['kind']}» нужно место на кадре — нет {', '.join(missing)}")
        value = {**{k: ins[k] for k in INSERT_FIELDS if k in ins}, "n": i}  # номер — для рамок в boxes.json и QA
        pieces.append(_Piece(start, stop, f"insert{i}", value, insert=True, every_frame=ins["kind"] == "anim"))
    return pieces


def _state(pieces: list[_Piece], frame: int) -> dict:
    """Что видно на кадре `frame`."""
    state: dict = {}
    inserts = []
    for piece in pieces:
        if not piece.start <= frame < piece.stop:
            continue
        if piece.insert:
            shown = frame - piece.start
            moving = shown / FPS if piece.every_frame else 0  # время нужно только анимации
            inserts.append({**piece.value, "anim": min(1, (shown + 1) / APPEAR), "t": moving})
        else:
            state[piece.key] = piece.value
    if inserts:
        state["inserts"] = inserts
    return state
