"""События слоя: что рисует шаблон (template/overlay.html) в каждый промежуток финала.

Субтитры, хук, титр с кодовым словом и вставки сводятся в непересекающиеся промежутки `{t0, t1, state}`,
которые покрывают весь финал вместе со стоп-кадром в конце (`edit.hold`). `state` — то, что получает
`window.renderState`: `{sub?, hook?, cta?, inserts?}`. Внутренние границы стоят на сетке кадров (30 к/с),
поэтому каждый промежуток, кроме последнего, — целое число кадров; одинаковые соседние состояния склеены.

Времена в edit.json — по исходнику; в время финала их переводит `Timeline` (момент, попавший в вырезку,
переходит на начало следующего отрезка). Правила вставок: пока виден хук, вставок нет (начало сдвигается на
конец хука); показ не короче 1,5 с; появление — три кадра (`anim` = 1/3, 2/3, 1); у анимации (`kind: anim`)
каждый кадр свой (`t` — секунды от начала показа). Полноэкранные вставки (`fullscreen`) монтирует ffmpeg,
в слой попадает только их подпись (`caption` → `state.caption`; пока она видна, субтитров нет); следующая перебивка
обрывает предыдущую (серия). Что видно в последний кадр ролика, остаётся и на стоп-кадре.

Финальная карточка (`edit.end`) идёт после стоп-кадра ещё `seconds`: на ней ничего другого нет, и каждый её кадр
свой (`state.end.t` — секунды от начала карточки: призыв «дышит»).

Стиль эталона. Субтитры `soft` — событие на строку блока; первые кадры новой строки получают `t` (секунды с её
появления: шаблон «съезжает» буквы), дальше кадры одинаковые и склеиваются. Хук в режиме `accent` первые кадры тоже
получает `t` (появление из размытия). Акцентная фраза (`edit.accents`) — `state.accent`: строки, место, анимация и
`ages` — секунды с появления каждой строки (`None` — её первое слово ещё не звучит; строка появляется со своим словом
из `edit.words`, не нашлось — со строкой перед ней). Пока строка появляется, каждый кадр свой; потом возраст —
`DONE`. Акцент держится до начала следующих субтитров, но не дольше 0,3 с после конца фразы и не дальше следующего
акцента; последние 4 кадра — уход (`leave` 0..1), кроме `out: cut`. Слова акцента в субтитры не идут, и пока акцент
на экране, субтитров нет.
"""
import math
import re
from dataclasses import dataclass, field
from itertools import pairwise

from .asr import Word
from .subs import build_sub_events
from .timeline import Timeline

FPS = 30
APPEAR = 3  # кадров появления вставки
MIN_SHOW = 1.5  # с — вставка показывается не короче
DRAWN = ("image", "badge", "sticker", "text", "anim")  # что рисует шаблон; fullscreen — ffmpeg
INSERT_FIELDS = ("kind", "src", "text", "title", "x", "y", "w", "params")
# Анимации стиля эталона рисует шаблон (overlay.js: SOFT, ACC); здесь — сколько кадров давать им время, с запасом в кадр.
SUB_APPEAR = 4  # кадров появления строки soft (0,12 с)
HOOK_APPEAR = 8  # кадров появления хука accent из размытия (0,22 с)
ACCENT_ANIM = {"blur": 0.25, "track": 0.17, "letters": 0.33}  # с — появление строки акцента
MIN_ACCENT = 0.4  # с финала — меньше от фразы акцента вырезка оставить может, а показать нечего: акцента нет
TYPE_CPS, TYPE_CURSOR = 30, 0.28  # печать: букв в секунду; сколько курсор держится после печати, с
ACCENT_LINGER = 0.3  # с — акцент держится после конца фразы, если субтитры не начались раньше
ACCENT_LEAVE = 4  # кадров ухода акцента
DONE = 99.0  # возраст строки, анимация которой кончилась: кадры одинаковые и склеиваются
WORD_SLACK = 0.05  # с — слово акцента ищется в его фразе с таким запасом по краям


@dataclass
class _Piece:
    """Что-то видимое на кадрах `[start, stop)`: субтитр, хук, титр или вставка."""

    start: int
    stop: int
    key: str
    value: dict
    insert: bool = False
    every_frame: bool = False
    timed: bool = False  # не вставка, но каждый кадр свой: в состояние идёт t — секунды от начала
    appear: int = 0  # первые столько кадров в состояние идёт t — секунды с начала (появление), потом — нет
    accent: dict = field(default_factory=dict)  # акцент: кадры строк, анимация и уход (`_accents`)


def build_overlay_events(edit: dict, tl: Timeline) -> list[dict]:
    """Промежутки финала `{t0, t1, state}` по возрастанию, встык, от 0 до конца ролика: `tl.duration + edit.hold`
    и финальная карточка (`edit.end.seconds`), если она есть."""
    hold = float(edit.get("hold") or 0.0)
    card = edit.get("end") or None
    end = tl.duration + hold + (float(card["seconds"]) if card else 0.0)
    last = _frame(end)  # кадров во всём ролике со стоп-кадром и карточкой
    still = _frame(tl.duration + hold)  # кадр, после которого стоп-кадр кончается (с него — карточка)
    video = _frame(tl.duration)  # последний кадр ролика без стоп-кадра
    # что начинается не раньше конца ролика, в ролике не видно — на стоп-кадре тоже не появляется
    subtitles = _subtitles(edit, tl)
    accents = _accents(edit, tl, [p.start for p in subtitles])
    pieces = [p for p in subtitles + _titles(edit, tl) + accents + _inserts(edit, tl) if p.start < video]
    for piece in pieces:
        if piece.stop >= video:  # видно в последний кадр — остаётся на стоп-кадре, но не на карточке
            piece.stop = still
            if piece.accent:  # акцент не уходит: на стоп-кадре он такой, каким был в последний кадр
                piece.accent["leave"] = piece.stop
                piece.accent["moving"] = piece.accent["moving"][: len(piece.accent["frames"])]
    if card:
        shown = {k: card[k] for k in ("handle", "logo") if card.get(k)}
        pieces.append(_Piece(still, last, "end", {"lines": list(card["lines"]), **shown}, timed=True))

    borders = {0, last}
    for piece in pieces:
        if piece.stop <= piece.start:
            continue
        borders.update((piece.start, piece.stop))
        if piece.insert:
            borders.update(f for f in range(piece.start + 1, piece.start + APPEAR) if f < piece.stop)
        if piece.every_frame or piece.timed:
            borders.update(range(piece.start, piece.stop))
        borders.update(range(piece.start, min(piece.stop, piece.start + piece.appear + 1)))
        for a, b in piece.accent.get("moving", []):
            borders.update(range(max(a, piece.start), min(b, piece.stop) + 1))
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
    events = events or [{"t0": 0, "t1": end, "state": {}}]
    if edit.get("zone") == "ads":  # версия для рекламы: шаблон держит всё выше кнопки и подписи рекламы
        for e in events:
            e["state"]["zone"] = "ads"
    return events


def _frame(t: float) -> int:
    return round(t * FPS)


def _subtitles(edit: dict, tl: Timeline) -> list[_Piece]:
    """Субтитры без слов акцентных фраз (их показывает акцент); у soft — строки блока и появление новой строки."""
    spoken = [Word(w["t0"], w["t1"], w["text"]) for w in edit.get("words") or []]
    style = edit["style"]["subtitles"]
    hidden = [(float(a["t0"]), float(a["t1"])) for a in edit.get("accents") or []]
    soft = style["mode"] == "soft"
    pieces = []
    for e in build_sub_events(spoken, tl, style["mode"], style["words"], hidden=hidden):
        sub = {"words": list(e["words"]), "active": e["active"], "visible": e["visible"]}
        if soft:  # opens — блок начинает предложение: иначе шаблон сделал бы строчным и имя посреди фразы
            sub["lines"] = list(e["lines"])
            sub["opens"] = e["opens"]
        pieces.append(_Piece(_frame(e["t0"]), _frame(e["t1"]), "sub", sub, appear=SUB_APPEAR if soft else 0))
    return pieces


def _norm(text: str) -> str:
    """Слово для сравнения: строчные, ё → е, без знаков препинания."""
    return re.sub(r"[^\w-]", "", text.lower().replace("ё", "е")).strip("-")


def _line_times(accent: dict, words: list[dict]) -> list[float]:
    """Время исходника, когда звучит первое слово каждой строки акцента: ищется по порядку среди слов фразы; первая
    строка — с началом фразы; не нашлось — со строкой перед ней."""
    t0, t1 = float(accent["t0"]), float(accent["t1"])
    phrase = sorted((w for w in words if t0 - WORD_SLACK <= w["t0"] <= t1 + WORD_SLACK), key=lambda w: w["t0"])
    times, at = [t0], 0
    for line in accent["lines"][1:]:
        first = _norm((str(line.get("text", "")).split() or [""])[0])
        found = next((i for i in range(at, len(phrase)) if first and _norm(phrase[i]["text"]) == first), None)
        if found is None:
            times.append(times[-1])
            continue
        times.append(max(times[-1], phrase[found]["t0"]))
        at = found + 1
    return times


def _appear_frames(line: dict, anim: str) -> int:
    """Сколько кадров строка акцента появляется (шаблон рисует их по возрасту строки)."""
    seconds = len(str(line.get("text", ""))) / TYPE_CPS + TYPE_CURSOR if anim == "type" else ACCENT_ANIM.get(anim, ACCENT_ANIM["blur"])
    return math.ceil(seconds * FPS - 1e-9)


def _accents(edit: dict, tl: Timeline, sub_starts: list[int]) -> list[_Piece]:
    """Акцентные фразы: показ — с начала фразы до начала следующих субтитров (не дольше 0,3 с после её конца и не
    дальше следующего акцента); строки — со своими словами; последние кадры — уход."""
    # по месту в ролике (куски могут стоять не по порядку исходника); фраза — с начала и до конца своей серии (Timeline.span)
    accents = sorted(edit.get("accents") or [], key=lambda a: (tl.to_final_snap(float(a["t0"])), float(a["t0"])))
    words = edit.get("words") or []
    pieces = []
    placed = [(a, tl.span(float(a["t0"]), float(a["t1"]))) for a in accents]
    # от фразы, разрезанной вырезкой (правка в редакторе), осталось меньше MIN_ACCENT — акцент вспыхнул бы на кадр-другой
    placed = [(a, span) for a, span in placed if not _remnant(a, span, tl)]
    accents, spans = [a for a, _ in placed], [span for _, span in placed]
    starts = [_frame(a) for a, _ in spans]
    for k, accent in enumerate(accents):
        start = starts[k]
        said = _frame(spans[k][1])
        stop = _frame(spans[k][1] + ACCENT_LINGER)
        stop = min([stop, *(s for s in sub_starts if s >= said), *(s for s in starts[k + 1 :] if s > start)])
        lines = [dict(line) for line in accent["lines"]]
        frames = [min(max(_frame(tl.to_final_snap(t)), start), max(start, stop - 1)) for t in _line_times(accent, words)]
        stop = max(stop, frames[-1] + 1, start + 1)
        anim = accent.get("anim") or "blur"
        out = accent.get("out") or "fade"
        moving = [(f, f + _appear_frames(line, anim)) for f, line in zip(frames, lines, strict=True)]
        leave = max(stop - ACCENT_LEAVE, start + 1) if out != "cut" else stop
        if leave < stop:
            moving.append((leave, stop))
        value = {"lines": lines, "x": accent["x"], "y": accent["y"], "anim": anim, "out": out}
        info = {"frames": frames, "ends": [b for _, b in moving[: len(lines)]], "leave": leave, "moving": moving}
        pieces.append(_Piece(start, stop, "accent", value, accent=info))
    return pieces


def _remnant(accent: dict, span: tuple[float, float], tl: Timeline) -> bool:
    """Вырезка оставила от фразы акцента меньше MIN_ACCENT финала (короткая фраза целиком — не остаток)."""
    shown = span[1] - span[0]
    return shown < MIN_ACCENT and shown < (float(accent["t1"]) - float(accent["t0"])) / tl.speed - 1 / FPS


def _accent_state(piece: _Piece, frame: int) -> dict:
    """Акцент на кадре: возраст строк (None — ещё не появилась, DONE — появилась давно) и доля ухода."""
    info = piece.accent
    ages = []
    for f, end in zip(info["frames"], info["ends"], strict=True):
        if frame < f:
            ages.append(None)
        else:
            ages.append((frame - f + 1) / FPS if frame < end else DONE)
    state = {**piece.value, "ages": ages}
    if frame >= info["leave"]:
        span = piece.stop - info["leave"]
        state["leave"] = (frame - info["leave"] + 1) / span
    return state


def _titles(edit: dict, tl: Timeline) -> list[_Piece]:
    pieces = []
    hook = edit.get("hook")
    if hook:
        moving = HOOK_APPEAR if edit["style"]["hook"]["mode"] == "accent" else 0
        pieces.append(_Piece(0, _hook_end(edit, tl), "hook", {"text": hook["text"]}, appear=moving))
    cta = edit.get("cta")
    if cta:
        a, b = tl.span(float(cta["t0"]), float(cta["t1"]))
        pieces.append(_Piece(_frame(a), _frame(b), "cta", {"lines": list(cta["lines"]), "word": cta["word"]}))
    return pieces


def _hook_end(edit: dict, tl: Timeline) -> int:
    """Кадр, на котором хук уходит: `hook.until` на его месте в ролике — по порядку исходника: кусок, переставленный
    руками в начало, хук не удлиняет (тот держится, сколько планировал монтаж); есть тизер — хук стоит на нём целиком."""
    hook = edit.get("hook")
    if not hook:
        return 0
    return _frame(tl.teaser_duration) if tl.teaser else _frame(tl.in_source_order().to_final_snap(hook["until"]))


def insert_spans(edit: dict, tl: Timeline) -> list[tuple[int, int, int]]:
    """Кадры показа вставок `(номер в edit.inserts, первый кадр, кадр после последнего)` по правилам: не раньше
    конца хука, не короче 1,5 с; вставка на весь кадр — не дальше начала следующей такой (серия). Все виды, в том числе
    fullscreen (её монтирует ffmpeg, а звук — в нужный кадр); выключенных Павлом (`off`) — нет."""
    after_hook = _hook_end(edit, tl)
    min_show = math.ceil(MIN_SHOW * FPS - 1e-9)
    spans = []
    for i, ins in enumerate(edit.get("inserts") or []):
        if ins.get("off"):  # выключил Павел в редакторе: в ролике её нет, номер остаётся
            continue
        a, b = tl.span(float(ins["t0"]), float(ins["t1"]))  # не дальше своей серии: переставленный кусок не тянет за собой
        start = max(_frame(a), after_hook)
        stop = max(_frame(b), start + min_show)
        spans.append((i, start, stop))
    # серия перебивок (перечисление — фото на каждое имя): следующая на весь кадр обрывает предыдущую; начались на одном
    # кадре — видна более поздняя по номеру (ffmpeg кладёт её сверху), нижней в ролике нет
    full = [(start, i) for i, start, _ in spans if edit["inserts"][i]["kind"] == "fullscreen"]
    cut = [(i, start, min([stop, *(s for s, j in full if s > start or (s == start and j > i))]))
           if edit["inserts"][i]["kind"] == "fullscreen" else (i, start, stop) for i, start, stop in spans]
    return [span for span in cut if span[2] > span[1]]


def _inserts(edit: dict, tl: Timeline) -> list[_Piece]:
    inserts = edit.get("inserts") or []
    pieces = []
    for i, start, stop in insert_spans(edit, tl):
        ins = inserts[i]
        if ins["kind"] == "fullscreen" and ins.get("caption"):  # подпись перебивки рисует шаблон
            pieces.append(_Piece(start, stop, "caption", {"text": ins["caption"]}))
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
        elif piece.timed:
            state[piece.key] = {**piece.value, "t": (frame - piece.start) / FPS}
        elif piece.accent:
            state[piece.key] = _accent_state(piece, frame)
        elif frame - piece.start < piece.appear:
            state[piece.key] = {**piece.value, "t": (frame - piece.start + 1) / FPS}
        else:
            state[piece.key] = piece.value
    if inserts:
        state["inserts"] = inserts
    if "accent" in state or "caption" in state:
        state.pop("sub", None)  # слова акцента и подпись перебивки — и есть субтитры
    return state
