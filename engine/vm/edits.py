"""Правки Павла руками в редакторе на странице (`timeline.json`) поверх монтажа сессии (`edit.json`).

Страница пишет `timeline.json`, движок кладёт правки поверх `edit.json` при каждом чтении (`edit_of`: `vm render`,
`vm check`): сессия пишет `edit.json` как обычно (по ответам и правкам текстом), правки руками остаются поверх него.
- `edits` — по порядку: `cut` вырезает отрезок исходника, `restore` возвращает (не дальше конца исходника) — к куску,
  что перед ним в исходнике (`next` — к куску после него), `move` ставит то, что оставлено в `[t0, t1]`, перед моментом
  `before` (null — в конец), `split` — граница куска в редакторе, на ролик не влияет. Куски — в порядке финала; куски
  короче SLIVER (кадр) после правок пропадают, соседние в финале и вплотную в исходнике — сливаются.
- `voice` — громкость голоса и «без звука» → `edit.voice`; `music` — громкость, «без звука» (музыки нет), где
  начинается в ролике и с какого места трека, нарастание и затухание → поля `edit.music`; `sounds` — громкость и «без
  звука» отдельных звуков → `edit.sounds`. Музыки в монтаже нет — её правки не действуют: добавлять музыку — не здесь.
- `text` (фаза 5) — текст и вставки: `hook` — конец и текст хука (хук один: правка сильнее пересчёта сессии); `cta`,
  `accents`, `inserts` — по месту блока в речи (`at` — его [t0, t1], как их записала сессия; сессия передвинула или
  убрала блок — правка не применяется): время, строки и слово титра, текст строк акцента (вид строки — как был), текст
  текстовой вставки; `off` — блока нет (вставка остаётся в списке с `off`: номера звуков `insert:<n>` те же).
  `words` — слово субтитров с ровно этими t0, t1 получает текст Павла; пустой — слова нет в субтитрах.
Порядок: куски, звук, текст. То же правило — у страницы (web/lib/edits.ts: applyKeep, applyText), общие фикстуры
tests/fixtures/edits.json (куски) и overlay-events.json (текст: пишет tests/shared_events.py).
"""
from .job import Job, validate

SLIVER = 0.04  # с — кусок короче (около кадра) после вырезки не остаётся
MUSIC_FIELDS = ("gainDb", "at", "from", "fadeIn", "fadeOut")


EPS = 1e-9
Span = tuple[float, float]


def _join(spans: list[Span]) -> list[Span]:
    """Соседние в финале куски, что в исходнике идут вплотную, — один кусок."""
    out: list[Span] = []
    for a, b in spans:
        if out and abs(a - out[-1][1]) <= EPS:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def _cut(spans: list[Span], a: float, b: float) -> list[Span]:
    out = []
    for s, e in spans:
        if e <= a or s >= b:
            out.append((s, e))
            continue
        if s < a:
            out.append((s, a))
        if e > b:
            out.append((b, e))
    return out


def _restore(spans: list[Span], a: float, b: float, to_next: bool) -> list[Span]:
    """Вернуть `[a, b]`: каждая непокрытая часть — к куску, что кончается там, где она начинается (с `to_next` — сначала
    к куску, что начинается там, где она кончается); соседей нет — сразу за куском, что перед ней в исходнике (такого
    нет — перед тем, что после неё)."""
    spans = list(spans)
    gaps, at = [], a
    for s, e in sorted(spans):
        if e <= at or s >= b:
            continue
        if s > at:
            gaps.append((at, s))
        at = max(at, e)
    if at < b:
        gaps.append((at, b))
    for ga, gb in gaps:
        left = next((i for i, (_, e) in enumerate(spans) if abs(e - ga) <= EPS), None)
        right = next((i for i, (s, _) in enumerate(spans) if abs(s - gb) <= EPS), None)
        if to_next and right is not None or left is None and right is not None:
            spans[right] = (ga, spans[right][1])
        elif left is not None:
            spans[left] = (spans[left][0], gb)
        else:
            before = [i for i, (_, e) in enumerate(spans) if e <= ga]
            after = [i for i, (s, _) in enumerate(spans) if s >= gb]
            if before:
                k = max(before, key=lambda i: spans[i][1]) + 1
            elif after:
                k = min(after, key=lambda i: spans[i][0])
            else:
                k = len(spans)
            spans.insert(k, (ga, gb))
    return spans


def _move(spans: list[Span], a: float, b: float, before: float | None) -> list[Span]:
    """Оставленное в `[a, b]` (по порядку финала) — перед моментом `before`: внутри куска — кусок делится, в
    вырезанном — перед куском, что за ним в исходнике; `None` или дальше всего — в конец. Ничего не оставлено — как было."""
    rest: list[Span] = []
    parts: list[Span] = []
    for s, e in spans:
        if e <= a or s >= b:
            rest.append((s, e))
            continue
        if s < a:
            rest.append((s, a))
        parts.append((max(s, a), min(e, b)))
        if e > b:
            rest.append((b, e))
    if not parts:
        return spans
    if before is None:
        return rest + parts
    for i, (s, e) in enumerate(rest):
        if s <= before < e:
            return rest[:i] + ([(s, before)] if before > s else []) + parts + [(before, e)] + rest[i + 1:]
    later = [i for i, (s, _) in enumerate(rest) if s >= before]
    if later:
        i = min(later, key=lambda k: rest[k][0])
        return rest[:i] + parts + rest[i:]
    return rest + parts


def apply_keep(keep, edits: list[dict], duration: float | None = None) -> list[list[float]]:
    """`keep` сессии и правки по порядку → новый `keep` в порядке финала, без пересечений. Кривая правка — ValueError с
    её номером."""
    spans: list[Span] = [(float(a), float(b)) for a, b in keep]
    for i, e in enumerate(edits):
        op = e.get("op") if isinstance(e, dict) else None
        if op == "split":
            continue
        if op not in ("cut", "restore", "move"):
            raise ValueError(f"timeline.json: edits[{i}] — op {op!r}: cut, restore, move или split")
        a, b = float(e["t0"]), float(e["t1"])
        if not b > a:
            raise ValueError(f"timeline.json: edits[{i}] — конец {b} не позже начала {a}")
        if op == "cut":
            spans = _cut(spans, a, b)
        elif op == "move":
            if "before" not in e:
                raise ValueError(f"timeline.json: edits[{i}] — move без before (куда: момент исходника или null — в конец)")
            spans = _move(spans, a, b, None if e["before"] is None else float(e["before"]))
        else:
            a = max(0.0, a)
            if duration is not None:
                b = min(float(duration), b)
            if b > a:
                spans = _restore(spans, a, b, bool(e.get("next")))
    return [[round(a, 3), round(b, 3)] for a, b in _join(spans) if b - a >= SLIVER]


def apply(edit: dict, timeline: dict | None, duration: float | None = None) -> dict:
    """edit.json и правки timeline.json → edit для монтажа (edit.json сессии не меняется). Правок нет — тот же edit."""
    if not timeline or not isinstance(edit.get("keep"), list):  # кривой edit.json назовёт его схема, а не KeyError тут
        return edit
    ops = timeline.get("edits") or []
    keep = apply_keep(edit["keep"], ops, duration) if ops else edit["keep"]  # только звук — куски сессии как есть
    if not keep:
        raise ValueError("timeline.json: правки вырезают весь ролик — верните в редакторе хоть один кусок")
    out = {**edit, "keep": keep}
    if timeline.get("voice"):
        out["voice"] = dict(timeline["voice"])
    music = timeline.get("music")
    if music and edit.get("music"):
        out["music"] = None if music.get("muted") else {**edit["music"], **{k: music[k] for k in MUSIC_FIELDS if k in music}}
        if out["music"] is None and edit.get("ab") == "music":  # версия B «без музыки» вышла бы такой же — её нет
            out["ab"] = None
    if timeline.get("sounds"):
        out["sounds"] = {k: dict(v) for k, v in timeline["sounds"].items()}
    return apply_text(out, timeline.get("text"), timeline.get("words"))


def _span(item: dict) -> list[float]:
    return [float(item["t0"]), float(item["t1"])]


def _timed(name: str, item: dict) -> dict:
    """Блок после правки: конец позже начала, иначе — ValueError с именем правки."""
    if not float(item["t1"]) > float(item["t0"]):
        raise ValueError(f"timeline.json: {name} — конец {item['t1']} не позже начала {item['t0']}")
    return item


def _anchored(items: list | None, changes: list | None, name: str, change) -> list:
    """Правки блоков списка по месту в речи: каждой — первый ещё не занятый блок с [t0, t1] == `at`; нет такого — правка
    не применяется. `change(блок, правка)` → новый блок или None (блока нет)."""
    out = list(items or [])
    used: set[int] = set()
    for i, c in enumerate(changes or []):
        at = [float(x) for x in c["at"]]
        k = next((j for j, item in enumerate(out) if j not in used and item is not None and _span(item) == at), None)
        if k is None:
            continue
        used.add(k)
        out[k] = change(out[k], c, f"{name}[{i}]")
    return out


def _lines(lines: list[dict], texts: list[str] | None) -> list[dict]:
    """Текст строк акцента — Павла, вид строки (размер, цвет) — как был; строк не столько же — как было."""
    if texts is None or len(texts) != len(lines):
        return lines
    return [{**line, "text": text} for line, text in zip(lines, texts, strict=True)]


def apply_text(edit: dict, text: dict | None, words: list | None = None) -> dict:
    """Текст и вставки Павла (`timeline.json` → `text`, `words`) поверх edit; правок нет — тот же edit."""
    if not text and not words:
        return edit
    out = {**edit}
    text = text or {}
    hook = text.get("hook")
    if hook and edit.get("hook"):
        out["hook"] = None if hook.get("off") else {**edit["hook"], **{k: hook[k] for k in ("until", "text") if k in hook}}
    cta = text.get("cta")
    if cta and edit.get("cta") and _span(edit["cta"]) == [float(x) for x in cta["at"]]:
        out["cta"] = None if cta.get("off") else _timed("text.cta", {**edit["cta"], **{k: cta[k] for k in ("t0", "t1", "lines", "word") if k in cta}})

    def accent(item: dict, c: dict, name: str) -> dict | None:
        if c.get("off"):
            return None
        return _timed(name, {**item, **{k: c[k] for k in ("t0", "t1") if k in c}, "lines": _lines(item["lines"], c.get("lines"))})

    def insert(item: dict, c: dict, name: str) -> dict:
        if c.get("off"):
            return {**item, "off": True}
        changed = {**item, **{k: c[k] for k in ("t0", "t1") if k in c}}
        if "text" in c and "text" in item:  # текст — только у текстовых вставок
            changed["text"] = c["text"]
        return _timed(name, changed)

    if text.get("accents") and edit.get("accents"):
        out["accents"] = [a for a in _anchored(edit["accents"], text["accents"], "text.accents", accent) if a is not None]
    if text.get("inserts") and edit.get("inserts"):
        out["inserts"] = _anchored(edit["inserts"], text["inserts"], "text.inserts", insert)
    if words and edit.get("words"):
        fixed = {(float(w["t0"]), float(w["t1"])): w["text"] for w in words}
        kept = []
        for w in edit["words"]:
            new = fixed.get((float(w["t0"]), float(w["t1"])))
            if new is None:
                kept.append(w)
            elif new.strip():  # пустое — слова нет в субтитрах
                kept.append({**w, "text": new})
        out["words"] = kept
    return out


def load(job: Job) -> dict | None:
    """timeline.json задачи по схеме; нет файла — None."""
    if not job.path("timeline.json").is_file():
        return None
    data = job.read("timeline.json")
    validate("timeline.json", data)
    return data


def edit_of(job: Job, duration: float | None = None) -> dict:
    """edit.json задачи с правками Павла из timeline.json; `duration` — длина исходника (возвращать не дальше конца)."""
    return apply(job.read("edit.json"), load(job), duration)
