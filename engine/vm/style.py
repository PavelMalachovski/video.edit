"""Итоговый стиль ролика: `spec` варианта, выбранного Павлом на превью, с его шрифтом, рукописным, тремя цветами
(текст, подсветка, шкала), высотой и размером субтитров и хука, если он их поменял (`subY`, `hookY`, `subSize`,
`hookSize`), пятном под субтитрами, если он его включил (`subShade` → `subtitles.shade`), видом субтитров и словами в
группе, если он их выбрал в редакторе (`subMode`, `subWords`); остальное — как у варианта. То же правило — у страницы (web/lib/style.ts): превью и финал рисуются одним `spec`. Общая фикстура —
tests/fixtures/style-merge.json.

Место и ширина вставок (`answers.insertBoxes`) — не стиль: `placed_inserts` ставит вставкам edit.json рамки, которые
Павел выбрал на превью (web/lib/style.ts, placedInserts; общая фикстура — tests/fixtures/insert-boxes.json)."""
import copy

CHOSEN_COLORS = ("text", "accent", "bar")
ADJUSTED = {
    "subY": ("subtitles", "y"),
    "hookY": ("hook", "y"),
    "subSize": ("subtitles", "size"),
    "hookSize": ("hook", "size"),
    "subShade": ("subtitles", "shade"),
    "subWords": ("subtitles", "words"),  # слов в группе субтитров (2–6) — Павел выбрал в редакторе
    "subMode": ("subtitles", "mode"),  # вид субтитров: караоке, плашка, по слову, копятся, мягкие
    "hookMode": ("hook", "mode"),  # вид хука: плашка, контур, тень, лесенка эталона
    "barPos": ("bar", "pos"),  # шкала времени — снизу или сверху
    "barHeight": ("bar", "height"),  # её толщина, px кадра (чётная: так её ставит overlay)
}


def insert_key(insert: dict) -> str | None:
    """Ключ вставки для рамки Павла: её question («добавь сюда»), иначе src, иначе id (стикер-тезис); ничего — None."""
    return insert.get("question") or insert.get("src") or insert.get("id") or None


def placed_inserts(inserts: list[dict], boxes: dict[str, dict]) -> list[dict]:
    """Вставки с местом и шириной, которые Павел выбрал на превью (`answers.insertBoxes`, рамка {x, y, w} — как есть:
    в безопасную зону её уже вписала страница). Вставки без рамки и fullscreen (без x, w) — как были."""
    out = []
    for insert in inserts:
        key = insert_key(insert)
        box = boxes.get(key) if key else None
        if box is None or "w" not in insert or "x" not in insert:
            out.append(dict(insert))
            continue
        out.append({**insert, "x": box["x"], "y": box["y"], "w": box["w"]})
    return out


def final_style(styles: dict, answers: dict) -> dict:
    """styles.json и answers.json → StyleSpec для `edit.json.style`."""
    choice = answers["style"]
    variant = next((v for v in styles["variants"] if v["id"] == choice["variant"]), None)
    if variant is None:
        raise ValueError(f"styles.json: нет варианта {choice['variant']}, который выбран в answers.json")
    spec = copy.deepcopy(variant["spec"])
    spec["font"], spec["hand"] = choice["font"], choice["hand"]
    spec["colors"] = {**spec["colors"], **{key: choice["colors"][key] for key in CHOSEN_COLORS}}
    for key, (part, field) in ADJUSTED.items():
        if key in choice:
            spec[part][field] = choice[key]
    return spec


_MISSING = object()


def merge_style(base: dict, ours: dict, theirs: dict) -> dict:
    """Новый стиль из редактора поверх стиля ролика: `base` — стиль по прошлому выбору Павла, `ours` — стиль ролика
    (`edit.json.style`: тот выбор и правки текстом), `theirs` — стиль по новому выбору. Что Павел поменял (`base` ≠
    `theirs`) — из `theirs`, остальное — как в `ours`: правки текстом (затемнение и т. п.) не теряются."""
    out = copy.deepcopy(ours)
    for key in {*base, *theirs}:
        b, o, t = base.get(key, _MISSING), ours.get(key, _MISSING), theirs.get(key, _MISSING)
        if isinstance(b, dict) and isinstance(o, dict) and isinstance(t, dict):
            out[key] = merge_style(b, o, t)
        elif b != t:
            if t is _MISSING:
                out.pop(key, None)
            else:
                out[key] = copy.deepcopy(t)
    return out
