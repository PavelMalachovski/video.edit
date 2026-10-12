"""Правки Павла руками в редакторе на странице (`timeline.json`) поверх монтажа сессии (`edit.json`).

Страница пишет `timeline.json`, движок кладёт правки поверх `edit.json` при каждом чтении (`edit_of`: `vm render`,
`vm check`): сессия пишет `edit.json` как обычно (по ответам и правкам текстом), правки руками остаются поверх него.
- `edits` — по порядку: `cut` вырезает отрезок исходника, `restore` возвращает (не дальше конца исходника), `split` —
  граница куска в редакторе, на ролик не влияет. Куски короче SLIVER (кадр) после вырезки пропадают.
- `voice` — громкость голоса и «без звука» → `edit.voice`; `music` — громкость, «без звука» (музыки нет), где
  начинается в ролике и с какого места трека, нарастание и затухание → поля `edit.music`; `sounds` — громкость и «без
  звука» отдельных звуков → `edit.sounds`. Музыки в монтаже нет — её правки не действуют: добавлять музыку — не здесь.
То же правило кусков — у страницы (web/lib/edits.ts, applyKeep), общая фикстура tests/fixtures/edits.json.
"""
from .job import Job, validate

SLIVER = 0.04  # с — кусок короче (около кадра) после вырезки не остаётся
MUSIC_FIELDS = ("gainDb", "at", "from", "fadeIn", "fadeOut")


def _merge(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1] + 1e-9:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _cut(spans: list[tuple[float, float]], a: float, b: float) -> list[tuple[float, float]]:
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


def apply_keep(keep, edits: list[dict], duration: float | None = None) -> list[list[float]]:
    """`keep` сессии и правки по порядку → новый `keep` (по возрастанию, без пересечений). Кривая правка — ValueError
    с её номером."""
    spans = [(float(a), float(b)) for a, b in keep]
    for i, e in enumerate(edits):
        op = e.get("op") if isinstance(e, dict) else None
        if op == "split":
            continue
        if op not in ("cut", "restore"):
            raise ValueError(f"timeline.json: edits[{i}] — op {op!r}: cut, restore или split")
        a, b = float(e["t0"]), float(e["t1"])
        if not b > a:
            raise ValueError(f"timeline.json: edits[{i}] — конец {b} не позже начала {a}")
        if op == "cut":
            spans = _cut(spans, a, b)
            continue
        a = max(0.0, a)
        if duration is not None:
            b = min(float(duration), b)
        if b > a:
            spans = _merge([*spans, (a, b)])
    return [[round(a, 3), round(b, 3)] for a, b in _merge(spans) if b - a >= SLIVER]


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
